-- One indexed row lets open boards check for changes without reading every task.
CREATE TABLE board_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1
);
INSERT INTO board_revision (id) VALUES (1);

CREATE TRIGGER board_task_created AFTER INSERT ON tasks
BEGIN UPDATE board_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER board_task_changed AFTER UPDATE ON tasks
BEGIN UPDATE board_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER board_task_deleted AFTER DELETE ON tasks
BEGIN UPDATE board_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER board_order_changed AFTER UPDATE ON task_orders
BEGIN UPDATE board_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER board_settings_changed AFTER UPDATE ON routing_settings
BEGIN UPDATE board_revision SET version=version+1 WHERE id=1; END;
CREATE TRIGGER board_assignment_changed AFTER UPDATE ON mcp_preferences
BEGIN UPDATE board_revision SET version=version+1 WHERE id=1; END;
