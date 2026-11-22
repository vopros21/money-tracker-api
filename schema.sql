-- money_tracker schema (PostgreSQL). Matches the live database on prazo-pi.
-- Fresh install: psql postgresql://money:...@localhost/money_tracker -f schema.sql
-- There is no login: the API acts as the single row in `users` (it creates
-- one if the table is empty).

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('debit', 'credit', 'debt', 'investment', 'cash', 'restricted')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per weekly snapshot per account
-- For credit/debt accounts, balance is stored as positive number (the amount owed)
-- Net worth calculation negates credit/debt on the fly
CREATE TABLE IF NOT EXISTS account_snapshots (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance NUMERIC(12,2) NOT NULL,
  recorded_at DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, recorded_at)
);

CREATE TABLE IF NOT EXISTS incomes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  source TEXT NOT NULL,
  note TEXT,
  received_at DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_snapshots_user_date ON account_snapshots(user_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_incomes_user_date ON incomes(user_id, received_at DESC);
