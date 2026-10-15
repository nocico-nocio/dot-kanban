CREATE TABLE task_orders (
  status TEXT PRIMARY KEY CHECK (status IN ('backlog','todo','in_progress','review','done','stopped')),
  version INTEGER NOT NULL DEFAULT 1,
  ids_json TEXT NOT NULL DEFAULT '[]'
);
INSERT INTO task_orders (status) VALUES
  ('backlog'),('todo'),('in_progress'),('review'),('done'),('stopped');
