-- Rolls back 003_question_bank.sql. Run inside one transaction:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/003_question_bank.down.sql
--   psql "$DATABASE_URL" -c "DELETE FROM schema_migrations WHERE name = '003_question_bank.sql'"
--
-- WARNING: this permanently deletes the question bank, imported batches, blueprints, every generated
-- paper and every candidate response stored by the module. Export first (Question Bank page, Export).
-- Migrations 001 and 002 and all candidate, vacancy and legacy assessment data are not touched.

DROP TABLE IF EXISTS attempt_responses;
DROP TABLE IF EXISTS attempt_questions;
DROP TABLE IF EXISTS attempt_papers;
ALTER TABLE attempts
  DROP COLUMN IF EXISTS max_score,
  DROP COLUMN IF EXISTS final_score,
  DROP COLUMN IF EXISTS final_pct,
  DROP COLUMN IF EXISTS passed,
  DROP COLUMN IF EXISTS result_status,
  DROP COLUMN IF EXISTS finalized_at,
  DROP COLUMN IF EXISTS submit_ref;
DROP TABLE IF EXISTS assessment_blueprints;
-- assessments created from the bank stay as ordinary rows; only the marker column goes
ALTER TABLE assessments DROP COLUMN IF EXISTS source;
DROP TABLE IF EXISTS round_settings;
ALTER TABLE question_bank DROP CONSTRAINT IF EXISTS question_bank_batch_fk;
DROP TABLE IF EXISTS qb_import_batches;
DROP TABLE IF EXISTS question_versions;
DROP TABLE IF EXISTS question_bank;
DROP FUNCTION IF EXISTS next_question_code();
DROP SEQUENCE IF EXISTS question_code_seq;
DROP TYPE IF EXISTS bank_question_type;
DROP TYPE IF EXISTS bank_difficulty;
