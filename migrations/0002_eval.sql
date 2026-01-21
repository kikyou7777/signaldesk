-- Eval tables for SignalDesk
CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  total_cases INTEGER NOT NULL,
  json_valid_rate REAL,
  theme_valid_rate REAL,
  recall_at_3 REAL
);

CREATE TABLE IF NOT EXISTS eval_cases (
  run_id TEXT NOT NULL,
  feedback_id TEXT NOT NULL,
  json_valid INTEGER NOT NULL,
  theme_valid INTEGER NOT NULL,
  recall_hit INTEGER,
  notes TEXT
);
