-- Base tables for SignalDesk
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT,
  body TEXT NOT NULL,
  customer_tier TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis (
  feedback_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  theme TEXT NOT NULL,
  sentiment_label TEXT NOT NULL,
  sentiment_score REAL NOT NULL,
  urgency_score REAL NOT NULL,
  severity TEXT NOT NULL,
  suggested_owner TEXT NOT NULL,
  proposed_fix TEXT NOT NULL,
  analyzed_at TEXT NOT NULL,
  model TEXT NOT NULL,
  FOREIGN KEY (feedback_id) REFERENCES feedback(id),
  UNIQUE (feedback_id)
);

-- Eval tables (from migrations/0002_eval.sql)
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
