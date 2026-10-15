CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL CHECK (priority IN ('low','medium','high','urgent')),
  due_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('todo','in_progress','review','done','stopped')),
  dispatch TEXT NOT NULL CHECK (dispatch IN ('draft','requested')),
  approval_required INTEGER NOT NULL DEFAULT 0,
  claim_id TEXT,
  claim_key TEXT,
  lease_expires_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_dispatch_status ON tasks(dispatch, status, priority, created_at);
CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  result_url TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX task_events_task ON task_events(task_id, created_at);
