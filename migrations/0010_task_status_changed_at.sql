ALTER TABLE tasks ADD COLUMN status_changed_at TEXT;

-- Recover the most recent entry into the current panel, excluding ordinary edits.
UPDATE tasks SET status_changed_at = COALESCE((
  SELECT MAX(created_at) FROM task_events
  WHERE task_id = tasks.id
    AND next_status = CASE WHEN tasks.status = 'todo' AND tasks.dispatch = 'draft' THEN 'backlog' ELSE tasks.status END
    AND previous_status IS NOT next_status
), created_at);

CREATE TRIGGER tasks_initial_status_time AFTER INSERT ON tasks
WHEN NEW.status_changed_at IS NULL
BEGIN
  UPDATE tasks SET status_changed_at = NEW.created_at WHERE id = NEW.id;
END;

-- Draft and requested both use status=todo internally, but occupy different panels.
CREATE TRIGGER tasks_panel_changed_time AFTER UPDATE OF status, dispatch ON tasks
WHEN (CASE WHEN NEW.status = 'todo' AND NEW.dispatch = 'draft' THEN 'backlog' ELSE NEW.status END)
  != (CASE WHEN OLD.status = 'todo' AND OLD.dispatch = 'draft' THEN 'backlog' ELSE OLD.status END)
BEGIN
  UPDATE tasks SET status_changed_at = NEW.updated_at WHERE id = NEW.id;
END;
