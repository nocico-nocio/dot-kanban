ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'general';
ALTER TABLE tasks ADD COLUMN agent_preference TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE tasks ADD COLUMN model_preference TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE tasks ADD COLUMN target_preference TEXT NOT NULL DEFAULT 'auto';
CREATE TABLE routing_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO routing_settings (id, version, config_json, updated_at)
VALUES (1, 1, '{"targets":[],"agents":[],"models":[],"rules":[]}', CURRENT_TIMESTAMP);
CREATE TABLE routing_settings_events (
  version INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  summary TEXT NOT NULL
);
