-- Orders table for Stripe checkout sessions
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  status TEXT,
  email TEXT,
  currency TEXT,
  subtotal_cents INTEGER,
  discount_cents INTEGER,
  total_cents INTEGER,
  items_json TEXT
);
