require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const CREATE_PT_ACCOUNT_TABLE = `
  CREATE TABLE IF NOT EXISTS pt_account (
    id SERIAL PRIMARY KEY,
    balance NUMERIC(15, 2) NOT NULL DEFAULT 100000.00,
    equity NUMERIC(15, 2) NOT NULL DEFAULT 100000.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

const CREATE_TRADES_TABLE = `
  CREATE TABLE IF NOT EXISTS trades (
    id             SERIAL PRIMARY KEY,
    symbol         VARCHAR(20)    NOT NULL,
    market_type    VARCHAR(20)    NOT NULL,
    direction      VARCHAR(5)     NOT NULL CHECK (direction IN ('long', 'short')),
    entry_price    NUMERIC(18, 8) NOT NULL,
    exit_price     NUMERIC(18, 8),
    stop_loss      NUMERIC(18, 8),
    take_profit    NUMERIC(18, 8),
    trailing_sl    NUMERIC(18, 8),
    quantity       NUMERIC(18, 8) NOT NULL,
    status         VARCHAR(10)    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    confidence     NUMERIC(5, 2),
    signals        JSONB,
    risk_pct       NUMERIC(5, 4),
    r_size         NUMERIC(18, 8),
    close_reason   VARCHAR(30),
    learning_flags JSONB,
    opened_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    closed_at      TIMESTAMPTZ,
    pnl            NUMERIC(15, 2)
  );
`;

// Phase 2 migration: add new columns to existing installs that only ran Phase 1 DDL.
const PHASE2_MIGRATIONS = [
  `ALTER TABLE trades ADD COLUMN IF NOT EXISTS trailing_sl    NUMERIC(18, 8)`,
  `ALTER TABLE trades ADD COLUMN IF NOT EXISTS risk_pct       NUMERIC(5, 4)`,
  `ALTER TABLE trades ADD COLUMN IF NOT EXISTS r_size         NUMERIC(18, 8)`,
  `ALTER TABLE trades ADD COLUMN IF NOT EXISTS close_reason   VARCHAR(30)`,
  `ALTER TABLE trades ADD COLUMN IF NOT EXISTS learning_flags JSONB`,
];

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(CREATE_PT_ACCOUNT_TABLE);
    await client.query(CREATE_TRADES_TABLE);
    for (const sql of PHASE2_MIGRATIONS) {
      await client.query(sql);
    }
    console.log('Database tables initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };
