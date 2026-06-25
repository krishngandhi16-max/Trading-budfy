require('dotenv').config();
const express      = require('express');
const { selfHeal } = require('./selfHeal');

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
if (process.env.BROKER_ENABLED !== 'true') {
  console.warn('[Config] ⚠️  BROKER_ENABLED is not "true" — all orders will be mocked, no real trades will be placed');
}
console.log('');

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

// Run self-heal then start listening
selfHeal().then((report) => {
  app.locals.healReport = report;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startCryptoBot();
  });
}).catch((err) => {
  console.error('selfHeal threw unexpectedly:', err.message);
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT} (self-heal skipped)`);
    startCryptoBot();
  });
});

module.exports = app;
