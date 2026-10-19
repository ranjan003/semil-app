-- Removes camera/microphone monitoring. Alert events are deleted (they are only informational).
DELETE FROM attempt_events WHERE kind = 'monitor';
ALTER TABLE attempt_events DROP CONSTRAINT attempt_events_kind_check;
ALTER TABLE attempt_events ADD CONSTRAINT attempt_events_kind_check
  CHECK (kind IN ('start','violation','warning','blocked','note','reinstated','submitted','auto_submitted'));
ALTER TABLE assessments DROP COLUMN monitor_mode;
