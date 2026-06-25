import express from 'express';
import { startCryptoBot, getCryptoBotState } from './cryptoBot';
import { startStockBot, getStockBotState } from './stockBot';
import logger from './logger';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

app.use(express.json());

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Trading-budfy',
    endpoints: ['/api/crypto/state', '/api/stock/state', '/api/state'],
  });
});

app.get('/api/crypto/state', (_req, res) => {
  res.json(getCryptoBotState());
});

app.get('/api/stock/state', (_req, res) => {
  res.json(getStockBotState());
});

app.get('/api/state', (_req, res) => {
  res.json({
    crypto: getCryptoBotState(),
    stock: getStockBotState(),
  });
});

app.listen(PORT, () => {
  logger.info(`[Server] Listening on port ${PORT}`);
});

// Start both bots
startCryptoBot();
startStockBot();

logger.info('[Main] Both bots started');
