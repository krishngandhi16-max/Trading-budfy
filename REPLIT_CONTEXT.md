# Trading-Budfy — Replit Context

Paste this into Replit AI / Agent when starting a session so it has full context.

---

## What this project is

A crypto + stock trading bot running on Node.js / Express, paper trading via Alpaca.

**Entry point:** `src/server.js` (plain JS, port 5000)
**Crypto bot:** `src/cryptoBot.ts` (TypeScript, compiled separately)
**Run command:** `npm start` → runs `node src/server.js`

---

## Architecture — two parallel systems

### 1. V3 JS Engine (`src/server.js` and friends)
The main server. Uses plain CommonJS modules. Files:
- `src/server.js` — Express server, runs selfHeal on startup
- `src/engine.js` — multi-timeframe scan pipeline (5M/15M/1H/4H/1D)
- `src/signals.js` — ICT signal detection: FVG, Sweep, BOS, Order Block
- `src/gates.js` — 13-gate entry validation (session, bias, BOS, FVG, OB, confidence, drawdown)
- `src/scoring.js` — weighted signal scoring, outputs confidence % and bias
- `src/tradeEntry.js` — paper trade entry, writes to DB + `data/paper_trades.json`
- `src/tradeClose.js` — monitors open trades, fires exit logic
- `src/position.js` — position sizing (1–3% risk, forced 2:1 R:R)
- `src/ohlc.js` — OHLC data via yahoo-finance2
- `src/brokers/alpaca.js` — Alpaca paper API wrapper
- `src/brokers/oanda.js` — Oanda practice API wrapper
- `src/brokers/router.js` — routes stocks/crypto → Alpaca, forex/metals → Oanda
- `src/selfHeal.js` — startup integrity check
- `src/db.js` — PostgreSQL via `pg`

**Critical constraint already applied:** `brokers/alpaca.js` and `engine.js` both block short orders for crypto — Alpaca paper does not support shorting crypto.

### 2. Crypto Bot (`src/cryptoBot.ts`)
Standalone TypeScript module. Does NOT use the v3 engine — it has its own scan loop.
- Strategy: UT Bot (ATR trailing stop, key=1.5, period=10) + EMA100 on 1H bars
- Symbols: BTC/USD, ETH/USD, SOL/USD
- Scan interval: **every 5 minutes** (was 1 min, changed because it was too noisy)
- Entry: market order + separate stop order. **No take profit order.** No bracket.
- Exit: fires ONLY when UT Bot direction flips (bearFlip/bullFlip) OR price crosses EMA100
  - longExit:  `bearFlip || !aboveEma`
  - shortExit: `bullFlip || aboveEma`
- Position sizing: `calcQty` — 1% equity at risk, capped at 25% notional
  - BTC: 8 decimal places, ETH: 6dp, SOL: 2dp
- **Crypto is long-only** — no short entries (Alpaca paper restriction)

**Why flip-only exits:** 2yr BTC 1H backtest — fixed 2R TP gave $66,789 / PF 2.78. Flip-only gave $95,203 / PF 4.79. Best trade went 1.36R → 5.41R.

---

## Environment variables (set in Replit Secrets)

| Key | Used by |
|-----|---------|
| `ALPACA_API_KEY` | both systems |
| `ALPACA_SECRET_KEY` | `cryptoBot.ts` |
| `ALPACA_API_SECRET` | `brokers/alpaca.js` (v3 JS stack) |
| `BROKER_ENABLED` | set to `"true"` to enable live paper orders |
| `DATABASE_URL` or `PGHOST` etc. | `src/db.js` (PostgreSQL) |

Note: the JS stack uses `ALPACA_API_SECRET`; the TS crypto bot uses `ALPACA_SECRET_KEY`. Both must be set.

---

## Dependencies

```json
{
  "dependencies": {
    "dotenv": "^17",
    "express": "^5",
    "pg": "^8",
    "yahoo-finance2": "^3"
  },
  "devDependencies": {
    "typescript": "^6",
    "@types/node": "^26"
  }
}
```

---

## Known issues / constraints

1. **No crypto shorts** — enforced in two places: `engine.js` (forces `resolvedDirection = 'long'` for crypto) and `brokers/alpaca.js` (returns `{ skipped }` if a short slips through).
2. **cryptoBot.ts is TypeScript only** — compile with `npx tsc` before running. The compiled output goes to `dist/cryptoBot.js` but it's gitignored. In Replit, run `npx tsc && npm start` or add a build step.
3. **cryptoBot.ts is not yet wired into server.js** — it exports `startCryptoBot()` and `getCryptoBotState()` but server.js doesn't import it yet. To wire it: require the compiled `dist/cryptoBot.js` in server.js and call `startCryptoBot()` after the server starts.
4. **5-minute scan interval** — changed from 1 minute to reduce noise/bugginess on Replit.

---

## Branch

Active dev branch: `claude/ecstatic-lamport-6mm9r4`
