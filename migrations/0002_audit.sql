ALTER TABLE task_events ADD COLUMN attempt_id TEXT;
ALTER TABLE task_events ADD COLUMN previous_status TEXT;
ALTER TABLE task_events ADD COLUMN next_status TEXT;
