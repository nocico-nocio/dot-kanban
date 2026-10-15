CREATE TABLE event_subscriptions (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  board_id TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX event_subscriptions_active ON event_subscriptions(active, expires_at);
CREATE TABLE event_outbox (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, revision)
);
CREATE TABLE event_deliveries (
  subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id),
  event_id TEXT NOT NULL REFERENCES event_outbox(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  next_attempt_at TEXT NOT NULL,
  last_status INTEGER,
  PRIMARY KEY(subscription_id, event_id)
);
CREATE INDEX event_deliveries_ready ON event_deliveries(state, next_attempt_at);
