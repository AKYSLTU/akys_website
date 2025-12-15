CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  stripe_session_id TEXT UNIQUE NOT NULL,
  buyer_email TEXT,
  dataset_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  amount_total INTEGER,
  currency TEXT,
  status TEXT NOT NULL,
  downloads_remaining INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_purchases_session ON purchases(stripe_session_id);
