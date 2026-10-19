-- Semil Talent Discovery: initial schema (PostgreSQL 14+)
-- Separate related entities for people, applications, assessments, attempts,
-- submissions, evaluations, interviews, offers and an append-only audit log.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE user_role AS ENUM ('super_admin','hr_admin','technical_assessor','business_assessor','candidate');
CREATE TYPE app_stage AS ENUM ('applied','round_1','round_2','round_3','round_4','round_5','selected','offer_sent','offer_accepted','joined','rejected','on_hold');
CREATE TYPE vacancy_status AS ENUM ('draft','active','closed');
CREATE TYPE assessment_status AS ENUM ('draft','active','archived');
CREATE TYPE doc_kind AS ENUM ('resume','photo','submission','presentation');
CREATE TYPE question_kind AS ENUM ('mcq','multi_select','short_text','long_text','file_upload');
CREATE TYPE eval_status AS ENUM ('draft','submitted');
CREATE TYPE interview_status AS ENUM ('scheduled','completed','cancelled');

-- ---------- identity ----------
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  role user_role NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_format CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

-- Only a hash of the session token is stored, so a database leak does not leak live sessions.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip inet,
  user_agent text
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- recruitment setup ----------
CREATE TABLE colleges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  city text
);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  start_date date,
  end_date date,
  hiring_target int CHECK (hiring_target IS NULL OR hiring_target >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','closed')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE TABLE campaign_colleges (
  campaign_id uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  college_id uuid REFERENCES colleges(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, college_id)
);

CREATE TABLE vacancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  role_code text,                       -- track key used for assessor routing, e.g. SDE, FE, BDA
  track text NOT NULL DEFAULT 'technical' CHECK (track IN ('technical','business')),
  department text,
  description text,
  required_skills text[] NOT NULL DEFAULT '{}',
  min_qualifications text,
  openings int NOT NULL DEFAULT 1 CHECK (openings > 0),
  salary_min_lpa numeric(5,2),
  salary_max_lpa numeric(5,2),
  location text NOT NULL DEFAULT 'Bengaluru, India',
  employment_type text NOT NULL DEFAULT 'full_time' CHECK (employment_type IN ('full_time','internship','contract')),
  joining_timeline text,
  application_deadline date,
  assessment_template text,
  selection_criteria text,
  hiring_manager_id uuid REFERENCES users(id),
  status vacancy_status NOT NULL DEFAULT 'draft',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (salary_max_lpa IS NULL OR salary_min_lpa IS NULL OR salary_max_lpa >= salary_min_lpa)
);

-- ---------- candidates ----------
CREATE SEQUENCE candidate_code_seq START 1;
CREATE TABLE candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_code text NOT NULL UNIQUE
    DEFAULT ('NT-' || to_char(now(),'YYYY') || '-' || lpad(nextval('candidate_code_seq')::text,4,'0')),
  user_id uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  full_name text NOT NULL CHECK (length(trim(full_name)) >= 2),
  email text NOT NULL,
  phone text NOT NULL CHECK (phone ~ '^\+?[0-9]{10,13}$'),
  city text,
  college_id uuid REFERENCES colleges(id),
  degree text,
  branch text,
  graduation_year int CHECK (graduation_year BETWEEN 2015 AND 2035),
  academic_info text,
  skills text[] NOT NULL DEFAULT '{}',
  experience text,
  portfolio_url text CHECK (portfolio_url IS NULL OR portfolio_url ~* '^https?://\S+\.\S+'),
  certifications text,
  joining_availability text,
  expected_compensation text,
  source text,
  hr_owner_id uuid REFERENCES users(id),
  assessor_id uuid REFERENCES users(id),
  internal_notes text,                  -- restricted: never returned to candidates or assessors
  deleted_at timestamptz,               -- soft delete, purged by the retention job
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX candidates_email_uq ON candidates (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX candidates_college_idx ON candidates(college_id);
CREATE INDEX candidates_skills_gin ON candidates USING gin(skills);

-- Files live in private object storage. Only the key is stored here, never a public URL.
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  kind doc_kind NOT NULL,
  storage_key text NOT NULL UNIQUE,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL,
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_candidate_idx ON documents(candidate_id, kind);

CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  vacancy_id uuid NOT NULL REFERENCES vacancies(id),
  campaign_id uuid REFERENCES campaigns(id),
  stage app_stage NOT NULL DEFAULT 'applied',
  stage_entered_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, vacancy_id)
);
CREATE INDEX applications_stage_idx ON applications(stage);

-- Every manual stage change needs a reason; automatic ones record the rule that fired.
CREATE TABLE stage_changes (
  id bigserial PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_stage app_stage,
  to_stage app_stage NOT NULL,
  manual boolean NOT NULL DEFAULT false,
  reason text,
  changed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT manual OR length(trim(coalesce(reason,''))) >= 5)
);

-- ---------- assessments ----------
CREATE TABLE assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  type text NOT NULL,
  description text,
  instructions text,
  round int NOT NULL CHECK (round BETWEEN 1 AND 5),
  difficulty text CHECK (difficulty IN ('easy','medium','hard')),
  time_limit_minutes int CHECK (time_limit_minutes IS NULL OR time_limit_minutes > 0),
  opens_at timestamptz,
  closes_at timestamptz,
  max_attempts int NOT NULL DEFAULT 1 CHECK (max_attempts >= 1),
  permitted_tools text,
  pass_mark_pct numeric(5,2) NOT NULL DEFAULT 50 CHECK (pass_mark_pct BETWEEN 0 AND 100),
  evaluation_mode text NOT NULL DEFAULT 'mixed' CHECK (evaluation_mode IN ('auto','manual','mixed')),
  rubric jsonb NOT NULL DEFAULT '[]',
  status assessment_status NOT NULL DEFAULT 'draft',
  current_version int NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at)
);
CREATE TABLE assessment_roles (
  assessment_id uuid REFERENCES assessments(id) ON DELETE CASCADE,
  role_code text NOT NULL,
  PRIMARY KEY (assessment_id, role_code)
);
CREATE TABLE assessment_reviewers (
  assessment_id uuid REFERENCES assessments(id) ON DELETE CASCADE,
  reviewer_id uuid REFERENCES users(id),
  PRIMARY KEY (assessment_id, reviewer_id)
);
-- correct_answer is server-side only. API serializers for candidates must never select it.
CREATE TABLE questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  position int NOT NULL,
  kind question_kind NOT NULL,
  prompt text NOT NULL,
  options jsonb,
  correct_answer jsonb,
  marks numeric(6,2) NOT NULL DEFAULT 1 CHECK (marks >= 0),
  UNIQUE (assessment_id, position),
  CHECK (kind NOT IN ('mcq','multi_select') OR (options IS NOT NULL AND correct_answer IS NOT NULL))
);
CREATE TABLE assessment_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  version int NOT NULL,
  snapshot jsonb NOT NULL,
  change_note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, version)
);

CREATE TABLE assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES assessments(id),
  assessment_version int NOT NULL,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES users(id),
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, application_id)
);
CREATE TABLE attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  attempt_no int NOT NULL CHECK (attempt_no >= 1),
  started_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz,               -- computed server-side from time limit; the client timer is cosmetic
  submitted_at timestamptz,
  auto_score numeric(6,2),
  UNIQUE (assignment_id, attempt_no)
);
CREATE TABLE answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id),
  response jsonb,
  saved_at timestamptz NOT NULL DEFAULT now(),
  auto_marks numeric(6,2),
  manual_marks numeric(6,2),
  UNIQUE (attempt_id, question_id)
);
CREATE TABLE submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  assignment_id uuid REFERENCES assignments(id),
  round int NOT NULL CHECK (round BETWEEN 1 AND 5),
  repo_url text CHECK (repo_url IS NULL OR repo_url ~* '^https?://\S+\.\S+'),
  document_id uuid REFERENCES documents(id),
  notes text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  CHECK (repo_url IS NOT NULL OR document_id IS NOT NULL)
);

-- ---------- group projects (round 2) ----------
CREATE TABLE project_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  track text NOT NULL CHECK (track IN ('technical','business')),
  brief text NOT NULL,
  deadline timestamptz,
  team_output_score numeric(5,2) CHECK (team_output_score BETWEEN 0 AND 100),  -- kept apart from individual scores
  assessor_observations text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE group_members (
  group_id uuid REFERENCES project_groups(id) ON DELETE CASCADE,
  candidate_id uuid REFERENCES candidates(id) ON DELETE CASCADE,
  responsibility text,
  contribution_score numeric(5,2) CHECK (contribution_score BETWEEN 0 AND 100),
  PRIMARY KEY (group_id, candidate_id)
);

-- ---------- evaluation and scoring ----------
CREATE TABLE scoring_config (
  id serial PRIMARY KEY,
  weights jsonb NOT NULL DEFAULT '{"1":20,"2":20,"3":15,"4":30,"5":15}',
  thresholds jsonb NOT NULL DEFAULT '{"1":50,"2":50,"3":50,"4":60,"5":50}',
  overall_target numeric(5,2) NOT NULL DEFAULT 65 CHECK (overall_target BETWEEN 0 AND 100),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((weights->>'1')::numeric + (weights->>'2')::numeric + (weights->>'3')::numeric
       + (weights->>'4')::numeric + (weights->>'5')::numeric = 100)
);
CREATE UNIQUE INDEX scoring_config_one_active ON scoring_config ((true)) WHERE is_active;
INSERT INTO scoring_config DEFAULT VALUES;

CREATE TABLE evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  round int NOT NULL CHECK (round BETWEEN 1 AND 5),
  evaluator_id uuid NOT NULL REFERENCES users(id),
  competency_scores jsonb NOT NULL DEFAULT '{}',
  total_score numeric(5,2) CHECK (total_score BETWEEN 0 AND 100),
  evidence text,
  comments text,
  recommendation text CHECK (recommendation IN ('advance','hold','reject')),
  status eval_status NOT NULL DEFAULT 'draft',
  submitted_at timestamptz,
  reviewed_at timestamptz,
  UNIQUE (application_id, round, evaluator_id),
  CHECK (status = 'draft' OR (total_score IS NOT NULL AND length(trim(coalesce(evidence,''))) >= 10 AND submitted_at IS NOT NULL))
);
CREATE TABLE score_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  decision text NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) >= 5),
  decided_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- interviews and offers ----------
CREATE TABLE interviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  round int NOT NULL CHECK (round BETWEEN 1 AND 5),
  interviewer_id uuid NOT NULL REFERENCES users(id),
  starts_at timestamptz NOT NULL,
  duration_minutes int NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  ends_at timestamptz NOT NULL,                 -- kept in sync by trigger below
  location text,
  instructions text,
  status interview_status NOT NULL DEFAULT 'scheduled',
  reminder_sent_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- the database itself refuses overlapping interviews for one interviewer
  EXCLUDE USING gist (interviewer_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status = 'scheduled')
);
CREATE FUNCTION interviews_set_end() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.ends_at := NEW.starts_at + make_interval(mins => NEW.duration_minutes); RETURN NEW; END $$;
CREATE TRIGGER interviews_end BEFORE INSERT OR UPDATE OF starts_at, duration_minutes ON interviews
  FOR EACH ROW EXECUTE FUNCTION interviews_set_end();
CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','declined','withdrawn')),
  joining_date date,
  sent_at timestamptz,
  responded_at timestamptz,
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message text NOT NULL,
  link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, read_at);

-- ---------- append-only audit log ----------
CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  actor_id uuid,
  actor_role user_role,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  before jsonb,
  after jsonb,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_logs(entity_type, entity_id);
CREATE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$;
CREATE TRIGGER audit_logs_no_change BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TRIGGER candidates_touch BEFORE UPDATE ON candidates FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER vacancies_touch BEFORE UPDATE ON vacancies FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
