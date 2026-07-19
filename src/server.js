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

let startStockBot, getStockBotState;
try {
  ({ startStockBot, getStockBotState } = require('../dist/stockBot'));
} catch (e) {
  console.warn('[server] stockBot not compiled yet — run npx tsc. Stock bot disabled.');
  startStockBot    = () => {};
  getStockBotState = () => ({ running: false, error: 'not compiled' });
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
    stocks:            getStockBotState(),
    timestamp:         new Date().toISOString(),
  });
});

app.get('/api/crypto/state', (_req, res) => {
  res.json(getCryptoBotState());
});

app.get('/api/stocks/state', (_req, res) => {
  res.json(getStockBotState());
});

// Live account + positions, fetched server-side so keys never reach the browser
async function alpacaGet(path) {
  const res = await fetch(`https://paper-api.alpaca.markets/v2${path}`, {
    headers: {
      'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY     || '',
      'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY  || '',
    },
  });
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

app.get('/api/account', async (_req, res) => {
  try {
    const [acct, positions] = await Promise.all([
      alpacaGet('/account'),
      alpacaGet('/positions'),
    ]);
    res.json({
      equity:        parseFloat(acct.equity),
      lastEquity:    parseFloat(acct.last_equity),
      cash:          parseFloat(acct.cash),
      buyingPower:   parseFloat(acct.buying_power),
      positions: positions.map((p) => ({
        symbol:       p.symbol,
        side:         p.side,
        qty:          parseFloat(p.qty),
        avgEntry:     parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        marketValue:  parseFloat(p.market_value),
        unrealizedPl: parseFloat(p.unrealized_pl),
        unrealizedPct: parseFloat(p.unrealized_plpc) * 100,
      })),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Dashboard (also fixes "Cannot GET /")
app.use(express.static(require('path').join(__dirname, '..', 'public')));

// Run self-heal then start listening
selfHeal().then((report) => {
  app.locals.healReport = report;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startCryptoBot();
    startStockBot();
  });
}).catch((err) => {
  console.error('selfHeal threw unexpectedly:', err.message);
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT} (self-heal skipped)`);
    startCryptoBot();
    startStockBot();
  });
});

module.exports = app;
