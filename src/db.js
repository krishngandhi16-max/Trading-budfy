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
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    market_type VARCHAR(20) NOT NULL,
    direction VARCHAR(4) NOT NULL CHECK (direction IN ('long', 'short')),
    entry_price NUMERIC(18, 8) NOT NULL,
    exit_price NUMERIC(18, 8),
    stop_loss NUMERIC(18, 8),
    take_profit NUMERIC(18, 8),
    quantity NUMERIC(18, 8) NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    confidence NUMERIC(5, 2),
    signals JSONB,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    pnl NUMERIC(15, 2)
  );
`;

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(CREATE_PT_ACCOUNT_TABLE);
    await client.query(CREATE_TRADES_TABLE);
    console.log('Database tables initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };
