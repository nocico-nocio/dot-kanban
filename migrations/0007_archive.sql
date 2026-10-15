ALTER TABLE tasks ADD COLUMN archived_at TEXT;
CREATE INDEX tasks_archive_status ON tasks(archived_at, status, updated_at);
