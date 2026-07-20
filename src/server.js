require('dotenv').config();
const express      = require('express');
const path         = require('path');
const { selfHeal } = require('./selfHeal');

const store               = require('./store');
const alpaca              = require('./brokers/alpaca');
const { isMarketOpen }    = require('./marketHours');
const { runScanOnce, startScanner } = require('./scanner');
const { startReconciler }           = require('./reconcile');
const { flattenNow }                = require('./eodFlatten');

// Compile cryptoBot.ts first (npx tsc), then this require works
let startCryptoBot, getCryptoBotState;
try {
  ({ startCryptoBot, getCryptoBotState } = require('../dist/cryptoBot'));
} catch (e) {
  console.warn('[server] cryptoBot not compiled yet — run npx tsc. Crypto bot disabled.');
  startCryptoBot    = () => {};
  getCryptoBotState = () => ({ running: false, error: 'not compiled' });
}

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Startup env check ─────────────────────────────────────────────────────────
const REQUIRED_VARS = {
  ALPACA_API_KEY:     'Both bots — Alpaca key ID',
  ALPACA_API_SECRET:  'JS engine (brokers/alpaca.js)',
  ALPACA_SECRET_KEY:  'Crypto bot (cryptoBot.ts)',
  BROKER_ENABLED:     'Set to "true" to enable real paper orders (currently: mock mode)',
};
console.log('\n[Config] Environment check:');
for (const [k, desc] of Object.entries(REQUIRED_VARS)) {
  const val = process.env[k];
  const status = val ? (k === 'BROKER_ENABLED' ? `"${val}"` : '✓ set') : '✗ MISSING';
  console.log(`  ${k}: ${status}  — ${desc}`);
}
// Strategy Lab resolves its own keys (Alpaca_strat_key / Alpaca_strat_scret
// preferred). Report what it actually sees so the log isn't misleading.
console.log(`  Strategy Lab keys: ${alpaca.hasKeys() ? '✓ detected' : '✗ NOT detected'}  — set Alpaca_strat_key & Alpaca_strat_scret`);
if (process.env.BROKER_ENABLED !== 'true') {
  console.warn('[Config] ⚠️  BROKER_ENABLED is not "true" — all orders will be mocked, no real trades will be placed');
}
console.log('');

app.use(express.json());
app.use(express.static(path.resolve(__dirname, '../public')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Strategy-lab API ──────────────────────────────────────────────────────────

// Overall mode + per-strategy stats (drives banners + tab headers).
app.get('/api/strategies', async (_req, res) => {
  let account = null;
  try { account = await alpaca.getAccount(); } catch (e) { account = { error: e.message }; }
  res.json({
    mode: {
      brokerEnabled:  alpaca.isEnabled(),
      hasKeys:        alpaca.hasKeys(),
      scannerEnabled: process.env.SCANNER_ENABLED === 'true',
      marketOpen:     isMarketOpen(),
      riskPerTrade:   store.RISK_PER_TRADE,
      startingBalance: store.STARTING_BALANCE,
    },
    account,
    overall: store.overallStats(),
    strategies: store.allStrategyStats(),
    timestamp: new Date().toISOString(),
  });
});

// Trades for one strategy (open first, then recent closed).
app.get('/api/strategy/:name/trades', (req, res) => {
  const name = req.params.name;
  if (!store.STRATEGIES.includes(name)) return res.status(404).json({ error: 'unknown strategy' });
  const all = store.getTrades().filter((t) => t.strategy === name);
  const open   = all.filter((t) => t.status === 'open' || t.status === 'pending')
                    .sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
  const closed = all.filter((t) => t.status === 'closed' || t.status === 'canceled')
                    .sort((a, b) => new Date(b.closedAt || b.openedAt) - new Date(a.closedAt || a.openedAt))
                    .slice(0, 100);
  res.json({ strategy: name, stats: store.strategyStats(name), open, closed });
});

// Activity feed (newest first).
app.get('/api/activity', (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 200);
  res.json({ activity: store.getActivity(limit) });
});

// Live broker account + positions.
app.get('/api/account', async (_req, res) => {
  try { res.json(await alpaca.getAccount()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/positions', async (_req, res) => {
  try { res.json(await alpaca.getPositions()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Force a scan pass on demand (handy for testing outside the interval).
app.post('/api/scan-now', async (_req, res) => {
  try { res.json(await runScanOnce({ force: true })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Force an immediate flatten (close all strategy-lab positions now).
app.post('/api/flatten-now', async (_req, res) => {
  try { res.json(await flattenNow('manual')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Wipe all tracked trades + activity — use after switching broker accounts,
// since old records can never reconcile against a different account's
// positions/orders. Does NOT touch the broker; it only clears our own record.
app.post('/api/reset-store', (_req, res) => {
  try { store.resetAll(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/status', (_req, res) => {
  res.json({
    brokerEnabled:     process.env.BROKER_ENABLED === 'true',
    hasAlpacaKey:      !!process.env.ALPACA_API_KEY,
    hasAlpacaSecret:   !!process.env.ALPACA_API_SECRET,
    hasSecretKey:      !!process.env.ALPACA_SECRET_KEY,
    hasDb:             !!process.env.DATABASE_URL,
    crypto:            getCryptoBotState(),
    timestamp:         new Date().toISOString(),
  });
});

app.get('/api/crypto/state', (_req, res) => {
  res.json(getCryptoBotState());
});

// Start the S&P 500 strategy lab (scanner + reconciler) when explicitly enabled.
function startStrategyLab() {
  if (process.env.SCANNER_ENABLED !== 'true') {
    console.log('[StrategyLab] SCANNER_ENABLED != "true" — scanner idle. Dashboard still available; POST /api/scan-now to test a single pass.');
    return;
  }
  if (!alpaca.hasKeys()) {
    console.warn('[StrategyLab] SCANNER_ENABLED is true but Alpaca keys are missing — cannot fetch data.');
    return;
  }
  startScanner(4 * 60 * 1000);   // scan every 4 minutes
  startReconciler(60 * 1000);    // reconcile fills every minute
}

// Run self-heal then start listening
selfHeal().then((report) => {
  app.locals.healReport = report;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startCryptoBot();
    startStrategyLab();
  });
}).catch((err) => {
  console.error('selfHeal threw unexpectedly:', err.message);
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT} (self-heal skipped)`);
    startCryptoBot();
    startStrategyLab();
  });
});

module.exports = app;
