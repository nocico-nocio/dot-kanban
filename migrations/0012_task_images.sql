CREATE TABLE task_images (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  image BLOB NOT NULL,
  created_at TEXT NOT NULL
);
