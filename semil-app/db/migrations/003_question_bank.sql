-- Question Bank Management and candidate-specific randomization.
-- Additive only: no existing table is dropped or rewritten, so 001 and 002 keep working.
-- Rollback: db/rollback/003_question_bank.down.sql (export the bank first, it deletes question data).

CREATE TYPE bank_question_type AS ENUM ('mcq', 'multi_select', 'descriptive');
CREATE TYPE bank_difficulty    AS ENUM ('easy', 'medium', 'hard');

-- ---------- question codes ----------
CREATE SEQUENCE question_code_seq START 1;
-- Generates Q-00001, Q-00002 ... and skips any code an admin already used in an import.
CREATE FUNCTION next_question_code() RETURNS text LANGUAGE plpgsql AS $$
DECLARE c text;
BEGIN
  LOOP
    c := 'Q-' || lpad(nextval('question_code_seq')::text, 5, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM question_bank WHERE lower(question_code) = lower(c));
  END LOOP;
  RETURN c;
END $$;

-- ---------- the bank ----------
CREATE TABLE question_bank (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_code    text NOT NULL DEFAULT next_question_code()
                     CHECK (question_code ~ '^[A-Za-z0-9._-]{1,40}$'),
  question_text    text NOT NULL CHECK (length(btrim(question_text)) BETWEEN 5 AND 2000),
  type             bank_question_type NOT NULL,
  options          jsonb,            -- ["text A","text B",...] for mcq and multi_select
  correct_answer   jsonb,            -- mcq: 0-based index; multi_select: sorted array of indexes. NEVER sent to candidates
  reference_answer text,             -- descriptive: model answer or marking notes. Reviewer-only
  explanation      text CHECK (explanation IS NULL OR length(explanation) <= 2000),
  difficulty       bank_difficulty NOT NULL,
  role_code        text CHECK (role_code IS NULL OR role_code ~ '^[A-Z0-9_]{2,20}$'),   -- NULL = every role
  round            int  NOT NULL CHECK (round BETWEEN 1 AND 5),
  topic            text NOT NULL CHECK (length(btrim(topic)) BETWEEN 1 AND 60),
  marks            numeric(6,2) NOT NULL CHECK (marks > 0 AND marks <= 100),
  negative_marks   numeric(6,2) NOT NULL DEFAULT 0 CHECK (negative_marks >= 0),
  shuffle_options  boolean NOT NULL DEFAULT true,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  text_hash        text NOT NULL,    -- sha256 of the normalised text and type; drives duplicate detection
  version          int  NOT NULL DEFAULT 1,
  import_batch_id  uuid,
  created_by       uuid REFERENCES users(id),
  updated_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (negative_marks <= marks),
  CHECK (CASE WHEN type = 'descriptive'
              THEN options IS NULL AND correct_answer IS NULL AND negative_marks = 0
              ELSE options IS NOT NULL AND jsonb_typeof(options) = 'array'
                   AND jsonb_array_length(options) BETWEEN 2 AND 4
                   AND correct_answer IS NOT NULL END),
  CHECK (CASE WHEN type = 'mcq'
              THEN jsonb_typeof(correct_answer) = 'number'
                   AND (correct_answer #>> '{}')::numeric = floor((correct_answer #>> '{}')::numeric)
                   AND (correct_answer #>> '{}')::int BETWEEN 0 AND jsonb_array_length(options) - 1
              ELSE true END),
  CHECK (CASE WHEN type = 'multi_select'
              THEN jsonb_typeof(correct_answer) = 'array' AND jsonb_array_length(correct_answer) >= 2
                   AND jsonb_array_length(correct_answer) <= jsonb_array_length(options)
              ELSE true END)
);
CREATE UNIQUE INDEX question_bank_code_uq ON question_bank (lower(question_code));
-- Same wording, same round, still in use: refused by the database even if the application misses it.
CREATE UNIQUE INDEX question_bank_text_uq ON question_bank (round, text_hash) WHERE status <> 'archived';
CREATE INDEX question_bank_pool_idx ON question_bank (round, status, role_code, topic, difficulty);

CREATE TABLE question_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES question_bank(id) ON DELETE CASCADE,
  version     int  NOT NULL,
  snapshot    jsonb NOT NULL,
  change_note text,
  changed_by  uuid REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (question_id, version)
);

-- ---------- import batches: preview first, commit once ----------
CREATE TABLE qb_import_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by   uuid NOT NULL REFERENCES users(id),
  file_name    text NOT NULL,
  file_format  text NOT NULL CHECK (file_format IN ('csv', 'xlsx', 'docx')),
  file_sha256  text NOT NULL,
  file_size    int  NOT NULL CHECK (file_size > 0),
  on_conflict  text NOT NULL DEFAULT 'skip' CHECK (on_conflict IN ('skip', 'update')),
  rows         jsonb NOT NULL,       -- validated rows exactly as previewed; commit never trusts the browser
  summary      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'committed', 'cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  committed_at timestamptz,
  committed_by uuid REFERENCES users(id),
  result       jsonb
);
CREATE INDEX qb_import_batches_hash_idx ON qb_import_batches (file_sha256) WHERE status = 'committed';
ALTER TABLE question_bank ADD CONSTRAINT question_bank_batch_fk FOREIGN KEY (import_batch_id) REFERENCES qb_import_batches(id);

-- ---------- rounds: own duration, pass mark, eligibility and publication ----------
CREATE TABLE round_settings (
  round              int PRIMARY KEY CHECK (round BETWEEN 1 AND 5),
  name               text NOT NULL,
  description        text,
  enabled            boolean NOT NULL DEFAULT true,
  published          boolean NOT NULL DEFAULT false,      -- candidates cannot start tests of an unpublished round
  duration_minutes   int NOT NULL DEFAULT 45 CHECK (duration_minutes BETWEEN 1 AND 480),
  pass_threshold_pct numeric(5,2) NOT NULL DEFAULT 50 CHECK (pass_threshold_pct BETWEEN 0 AND 100),
  eligibility        jsonb NOT NULL DEFAULT '{"require_stage": true, "min_previous_pct": null}',
  updated_by         uuid REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO round_settings (round, name, duration_minutes, pass_threshold_pct) VALUES
  (1, 'Skills-Based Shortlisting',        45, 50),
  (2, 'Group Project Development',        60, 50),
  (3, 'Mindset and Reasoning Assessment', 45, 50),
  (4, 'Individual Practical Creation',    90, 60),
  (5, 'HR and Founder Interview',         45, 50);

-- ---------- assessments built from the bank ----------
ALTER TABLE assessments ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'bank'));

CREATE TABLE assessment_blueprints (
  assessment_id        uuid PRIMARY KEY REFERENCES assessments(id) ON DELETE CASCADE,
  rules                jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(rules) = 'array'),   -- [{topic, difficulty, count}]
  shuffle_questions    boolean NOT NULL DEFAULT true,
  shuffle_options      boolean NOT NULL DEFAULT true,
  results_policy       text NOT NULL DEFAULT 'hidden' CHECK (results_policy IN ('hidden', 'score', 'score_and_review')),
  results_published_at timestamptz,
  updated_by           uuid REFERENCES users(id),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ---------- one persisted paper per attempt ----------
ALTER TABLE attempts
  ADD COLUMN max_score     numeric(8,2),
  ADD COLUMN final_score   numeric(8,2),
  ADD COLUMN final_pct     numeric(5,2),
  ADD COLUMN passed        boolean,
  ADD COLUMN result_status text CHECK (result_status IN ('pending_review', 'final')),
  ADD COLUMN finalized_at  timestamptz,
  ADD COLUMN submit_ref    text;

CREATE TABLE attempt_papers (
  attempt_id         uuid PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,
  seed               text NOT NULL,        -- random seed for this candidate; reproduces the draw for audits
  generator_version  text NOT NULL,
  assessment_version int  NOT NULL,
  blueprint          jsonb NOT NULL,       -- rules and flags exactly as used for this draw
  total_marks        numeric(8,2) NOT NULL,
  generated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attempt_questions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id       uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  position         int  NOT NULL CHECK (position >= 1),
  bank_question_id uuid NOT NULL REFERENCES question_bank(id),
  question_code    text NOT NULL,
  question_version int  NOT NULL,
  snapshot         jsonb NOT NULL,         -- text, options in ORIGINAL order, correct_answer, explanation. Server-side only
  option_order     jsonb,                  -- original option indexes in the order shown to this candidate
  marks            numeric(6,2) NOT NULL,
  negative_marks   numeric(6,2) NOT NULL DEFAULT 0,
  UNIQUE (attempt_id, position),
  UNIQUE (attempt_id, bank_question_id)
);

CREATE TABLE attempt_responses (
  attempt_question_id uuid PRIMARY KEY REFERENCES attempt_questions(id) ON DELETE CASCADE,
  response            jsonb,               -- mcq: shown position; multi_select: shown positions; descriptive: text
  rev                 int NOT NULL DEFAULT 0,   -- browser revision counter, so a delayed retry cannot overwrite a newer answer
  saved_at            timestamptz NOT NULL DEFAULT now(),
  auto_marks          numeric(6,2),
  manual_marks        numeric(6,2),
  reviewer_id         uuid REFERENCES users(id),
  reviewed_at         timestamptz,
  review_comment      text
);
