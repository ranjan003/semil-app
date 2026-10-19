-- Test lock (block on leaving the test window), question imports, extra document kinds.

ALTER TYPE doc_kind ADD VALUE IF NOT EXISTS 'certificate';
ALTER TYPE doc_kind ADD VALUE IF NOT EXISTS 'attachment';

ALTER TABLE assessments
  ADD COLUMN lock_mode text NOT NULL DEFAULT 'strict' CHECK (lock_mode IN ('strict','warn','off'));

-- The server owns the clock and the status. A blocked attempt cannot save or submit.
ALTER TABLE attempts
  ADD COLUMN status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','blocked','ready','submitted')),
  ADD COLUMN warnings int NOT NULL DEFAULT 0 CHECK (warnings >= 0),
  ADD COLUMN remaining_ms bigint CHECK (remaining_ms IS NULL OR remaining_ms >= 0),
  ADD COLUMN blocked_at timestamptz,
  ADD COLUMN reinstated_count int NOT NULL DEFAULT 0,
  ADD COLUMN reinstated_by uuid REFERENCES users(id),
  ADD COLUMN reinstate_reason text,
  ADD COLUMN review_requested_at timestamptz;

CREATE TABLE attempt_events (
  id bigserial PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('start','violation','warning','blocked','note','reinstated','submitted','auto_submitted')),
  detail text,
  client_time timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attempt_events_attempt_idx ON attempt_events(attempt_id, created_at);
CREATE INDEX attempts_blocked_idx ON attempts(status) WHERE status = 'blocked';

CREATE TABLE question_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  imported_by uuid NOT NULL REFERENCES users(id),
  file_name text,
  rows_total int NOT NULL CHECK (rows_total >= 0),
  rows_imported int NOT NULL CHECK (rows_imported >= 0),
  assessment_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (rows_imported <= rows_total)
);

CREATE TABLE assessment_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id uuid NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  document_storage_key text NOT NULL UNIQUE,
  original_name text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Questions can now also ask for a file upload or carry marks-only prompts.
ALTER TABLE questions ADD COLUMN difficulty text CHECK (difficulty IS NULL OR difficulty IN ('easy','medium','hard'));
