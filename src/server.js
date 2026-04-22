require('dotenv').config();
const express      = require('express');
const { selfHeal } = require('./selfHeal');

const app  = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Run self-heal then start listening
selfHeal().then((report) => {
  app.locals.healReport = report;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch((err) => {
  // selfHeal should never reject, but guard anyway
  console.error('selfHeal threw unexpectedly:', err.message);
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT} (self-heal skipped)`);
  });
});

module.exports = app;
