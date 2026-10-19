-- Camera and microphone monitoring (live checks only: nothing is recorded or stored).
-- A test can require the candidate to allow camera and microphone. The browser analyses the video and sound on the
-- candidate's device and sends only short alert codes ("no face seen", "loud noise") that are kept as attempt events.
ALTER TABLE assessments ADD COLUMN monitor_mode text NOT NULL DEFAULT 'off' CHECK (monitor_mode IN ('off', 'required'));

ALTER TABLE attempt_events DROP CONSTRAINT attempt_events_kind_check;
ALTER TABLE attempt_events ADD CONSTRAINT attempt_events_kind_check
  CHECK (kind IN ('start','violation','warning','blocked','note','reinstated','submitted','auto_submitted','monitor'));
