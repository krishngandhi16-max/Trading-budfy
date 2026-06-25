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

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/crypto/state', (req, res) => {
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
