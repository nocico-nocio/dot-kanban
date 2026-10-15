ALTER TABLE tasks ADD COLUMN mcp_connection_id TEXT;
CREATE TABLE mcp_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_connection_id TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO mcp_preferences (id) VALUES (1);
