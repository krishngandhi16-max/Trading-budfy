import axios from 'axios';
import logger from './logger';

const API_KEY = process.env.ALPACA_API_KEY ?? '';
const API_SECRET = process.env.ALPACA_SECRET_KEY ?? '';
const BASE_URL = 'https://paper-api.alpaca.markets/v2';
const DATA_URL = 'https://data.alpaca.markets/v1beta3';

const HEADERS = {
  'APCA-API-KEY-ID': API_KEY,
  'APCA-API-SECRET-KEY': API_SECRET,
  'Content-Type': 'application/json',
};

// Decimal places per symbol for order quantity rounding
const SYMBOL_DECIMALS: Record<string, number> = {
  'BTC/USD': 8,
  'ETH/USD': 6,
  'SOL/USD': 2,
};

const SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD'];
const RISK_PCT = 0.01; // 1% per trade

interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface BotState {
  running: boolean;
  lastScan: string | null;
  openPositions: PositionState[];
  lastErrors: string[];
  scanCount: number;
}

interface PositionState {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  qty: number;
  stopPrice: number;
  targetPrice: number;
  openedAt: string;
}

const state: BotState = {
  running: false,
  lastScan: null,
  openPositions: [],
  lastErrors: [],
  scanCount: 0,
};

export function getCryptoBotState(): BotState {
  return { ...state, openPositions: [...state.openPositions] };
}

function roundQty(symbol: string, qty: number): number {
  const decimals = SYMBOL_DECIMALS[symbol] ?? 2;
  const factor = Math.pow(10, decimals);
  return Math.floor(qty * factor) / factor;
}

async function getAccountEquity(): Promise<number> {
  const res = await axios.get(`${BASE_URL}/account`, { headers: HEADERS });
  return parseFloat(res.data.equity);
}

async function getBars(symbol: string, limit = 50): Promise<Bar[]> {
  const encoded = encodeURIComponent(symbol);
  const res = await axios.get(
    `${DATA_URL}/crypto/us/bars?symbols=${encoded}&timeframe=1H&limit=${limit}`,
    { headers: HEADERS }
  );
  const bars: Bar[] = res.data.bars?.[symbol] ?? [];
  return bars;
}

async function getPositions(): Promise<string[]> {
  const res = await axios.get(`${BASE_URL}/positions`, { headers: HEADERS });
  return res.data.map((p: { symbol: string }) => p.symbol.replace('/', '/'));
}

function calcATR(bars: Bar[], period = 14): number {
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    trs.push(tr);
  }
  const relevant = trs.slice(-period);
  return relevant.reduce((a, b) => a + b, 0) / relevant.length;
}

function detectSignal(bars: Bar[]): 'long' | 'short' | null {
  if (bars.length < 20) return null;
  const last = bars[bars.length - 2]; // last fully closed bar
  const atr = calcATR(bars);

  const bodySize = Math.abs(last.c - last.o);
  if (bodySize < 1.5 * atr) return null;

  const recentBars = bars.slice(-20, -1);
  const ema20 = recentBars.reduce((sum, b) => sum + b.c, 0) / recentBars.length;
  const currentPrice = bars[bars.length - 1].c;

  if (last.c > last.o && currentPrice > ema20) return 'long';
  if (last.c < last.o && currentPrice < ema20) return 'short';
  return null;
}

async function placeMarketOrder(
  symbol: string,
  side: 'buy' | 'sell',
  qty: number
): Promise<string> {
  const roundedQty = roundQty(symbol, qty);
  const res = await axios.post(
    `${BASE_URL}/orders`,
    {
      symbol,
      qty: roundedQty.toString(),
      side,
      type: 'market',
      time_in_force: 'gtc',
    },
    { headers: HEADERS }
  );
  logger.info(`[CryptoBot] Market order placed: ${side} ${roundedQty} ${symbol} — orderId=${res.data.id}`);
  return res.data.id as string;
}

async function placeStopOrder(
  symbol: string,
  side: 'buy' | 'sell',
  qty: number,
  stopPrice: number
): Promise<void> {
  const roundedQty = roundQty(symbol, qty);
  const rounded = parseFloat(stopPrice.toFixed(2));
  const res = await axios.post(
    `${BASE_URL}/orders`,
    {
      symbol,
      qty: roundedQty.toString(),
      side,
      type: 'stop',
      time_in_force: 'gtc',
      stop_price: rounded.toString(),
    },
    { headers: HEADERS }
  );
  logger.info(
    `[CryptoBot] Stop order placed: ${side} ${roundedQty} ${symbol} @ stop=${rounded} — orderId=${res.data.id}`
  );
}

async function scanSymbol(symbol: string, equity: number, openSymbols: string[]): Promise<void> {
  try {
    const bars = await getBars(symbol, 60);
    if (bars.length < 20) {
      logger.info(`[CryptoBot] ${symbol}: not enough bars (${bars.length})`);
      return;
    }

    const currentPrice = bars[bars.length - 1].c;
    const atr = calcATR(bars);
    const signal = detectSignal(bars);

    logger.info(
      `[CryptoBot] ${symbol}: price=${currentPrice.toFixed(4)}, ATR=${atr.toFixed(4)}, signal=${signal ?? 'none'}`
    );

    if (!signal) return;

    // Skip if already in a position for this symbol
    const alpacaSymbol = symbol.replace('/', '');
    if (openSymbols.includes(alpacaSymbol) || openSymbols.includes(symbol)) return;

    const riskDollars = equity * RISK_PCT;
    const stopDistance = atr * 1.5;
    const qty = riskDollars / stopDistance;

    const entryPrice = currentPrice;
    const stopPrice = signal === 'long' ? entryPrice - stopDistance : entryPrice + stopDistance;
    const targetPrice = signal === 'long'
      ? entryPrice + stopDistance * 2
      : entryPrice - stopDistance * 2;

    // Step 1: market order
    await placeMarketOrder(symbol, signal === 'long' ? 'buy' : 'sell', qty);

    // Step 2: stop order (placed sequentially after market order)
    const stopSide = signal === 'long' ? 'sell' : 'buy';
    await placeStopOrder(symbol, stopSide, qty, stopPrice);

    logger.info(
      `[CryptoBot] ${symbol}: entered ${signal} | entry≈${entryPrice.toFixed(4)} stop=${stopPrice.toFixed(4)} target=${targetPrice.toFixed(4)}`
    );

    state.openPositions.push({
      symbol,
      side: signal,
      entryPrice,
      qty: roundQty(symbol, qty),
      stopPrice,
      targetPrice,
      openedAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[CryptoBot] Error scanning ${symbol}: ${msg}`);
    state.lastErrors.push(`${symbol}: ${msg}`);
    if (state.lastErrors.length > 20) state.lastErrors.shift();
  }
}

async function runCryptoScan(): Promise<void> {
  try {
    state.lastScan = new Date().toISOString();
    state.scanCount++;

    const [equity, openSymbols] = await Promise.all([
      getAccountEquity(),
      getPositions(),
    ]);

    logger.info(`[CryptoBot] Scan #${state.scanCount} | equity=$${equity.toFixed(2)} | open=${openSymbols.length}`);

    for (const symbol of SYMBOLS) {
      await scanSymbol(symbol, equity, openSymbols);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[CryptoBot] Scan error: ${msg}`);
    state.lastErrors.push(msg);
    if (state.lastErrors.length > 20) state.lastErrors.shift();
  }
}

export function startCryptoBot(): void {
  if (state.running) return;
  state.running = true;
  logger.info('[CryptoBot] Starting — scanning 24/7 every 5 minutes');

  const INTERVAL_MS = 5 * 60 * 1000;

  void runCryptoScan();
  setInterval(() => {
    void runCryptoScan();
  }, INTERVAL_MS);
}
