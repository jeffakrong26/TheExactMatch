CREATE TABLE autodev_api_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  params TEXT,
  status_code INTEGER,
  result_count INTEGER,
  lead_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_autodev_api_log_created_at ON autodev_api_log(created_at);
