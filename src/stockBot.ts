import axios from 'axios';
import logger from './logger';

const API_KEY = process.env.ALPACA_API_KEY ?? '';
const API_SECRET = process.env.ALPACA_SECRET_KEY ?? '';
const BASE_URL = 'https://paper-api.alpaca.markets/v2';
const DATA_URL = 'https://data.alpaca.markets/v2';

const HEADERS = {
  'APCA-API-KEY-ID': API_KEY,
  'APCA-API-SECRET-KEY': API_SECRET,
  'Content-Type': 'application/json',
};

const SYMBOLS = [
  'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'META', 'AMD',
  'SPY', 'QQQ', 'BAC', 'JPM', 'XOM', 'UNH', 'JNJ', 'V', 'WMT', 'HD', 'PG',
];

const RISK_PCT = 0.015; // 1.5% per trade
const MAX_POSITIONS = 3;
const KILL_ZONE_START_H = 9;
const KILL_ZONE_START_M = 30;
const KILL_ZONE_END_H = 11;
const KILL_ZONE_END_M = 0;
const EOD_CLOSE_H = 15;
const EOD_CLOSE_M = 45;
const SWING_LOOKBACK = 10;
const ATR_PERIOD = 14;
const FIB_OTE_LOW = 0.62;
const FIB_OTE_HIGH = 0.79;
const FIB_ENTRY = 0.705;
const MIN_R = 2;

interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface TradeSetup {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  qty: number;
  oteHigh: number;
  oteLow: number;
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

interface ScanResult {
  symbol: string;
  price: number;
  dailyBias: 'bullish' | 'bearish' | 'neutral';
  displacementDetected: boolean;
  inOteZone: boolean;
  tradeEntered: boolean;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
}

interface BotState {
  running: boolean;
  lastScan: string | null;
  openPositions: PositionState[];
  lastScanResults: ScanResult[];
  lastErrors: string[];
  scanCount: number;
  killZoneActive: boolean;
}

const state: BotState = {
  running: false,
  lastScan: null,
  openPositions: [],
  lastScanResults: [],
  lastErrors: [],
  scanCount: 0,
  killZoneActive: false,
};

export function getStockBotState(): BotState {
  return {
    ...state,
    openPositions: [...state.openPositions],
    lastScanResults: [...state.lastScanResults],
    lastErrors: [...state.lastErrors],
  };
}

// Returns current ET time components
function getETTime(): { hour: number; minute: number; dayOfWeek: number } {
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  return {
    hour: et.getHours(),
    minute: et.getMinutes(),
    dayOfWeek: et.getDay(),
  };
}

function isInKillZone(): boolean {
  const { hour, minute, dayOfWeek } = getETTime();
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  const mins = hour * 60 + minute;
  const start = KILL_ZONE_START_H * 60 + KILL_ZONE_START_M;
  const end = KILL_ZONE_END_H * 60 + KILL_ZONE_END_M;
  return mins >= start && mins < end;
}

function isPastEODClose(): boolean {
  const { hour, minute } = getETTime();
  const mins = hour * 60 + minute;
  return mins >= EOD_CLOSE_H * 60 + EOD_CLOSE_M;
}

async function isMarketOpen(): Promise<boolean> {
  try {
    const res = await axios.get(`${BASE_URL}/clock`, { headers: HEADERS });
    return res.data.is_open as boolean;
  } catch {
    return false;
  }
}

async function getAccountEquity(): Promise<number> {
  const res = await axios.get(`${BASE_URL}/account`, { headers: HEADERS });
  return parseFloat(res.data.equity);
}

async function getOpenPositions(): Promise<string[]> {
  const res = await axios.get(`${BASE_URL}/positions`, { headers: HEADERS });
  return res.data.map((p: { symbol: string }) => p.symbol);
}

async function closeAllPositions(): Promise<void> {
  try {
    await axios.delete(`${BASE_URL}/positions`, { headers: HEADERS });
    logger.info('[StockBot] EOD: closed all positions');
    state.openPositions = [];
  } catch (err) {
    logger.error(`[StockBot] EOD close failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function getDailyBars(symbol: string, limit = 5): Promise<Bar[]> {
  const res = await axios.get(
    `${DATA_URL}/stocks/${symbol}/bars?timeframe=1Day&limit=${limit}&adjustment=raw`,
    { headers: HEADERS }
  );
  return (res.data.bars ?? []) as Bar[];
}

async function get5MinBars(symbol: string, limit = 100): Promise<Bar[]> {
  const res = await axios.get(
    `${DATA_URL}/stocks/${symbol}/bars?timeframe=5Min&limit=${limit}&adjustment=raw`,
    { headers: HEADERS }
  );
  return (res.data.bars ?? []) as Bar[];
}

function calcATR(bars: Bar[], period = ATR_PERIOD): number {
  if (bars.length < 2) return 0;
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

function getDailyBias(dailyBars: Bar[]): 'bullish' | 'bearish' | 'neutral' {
  if (dailyBars.length < 2) return 'neutral';
  const prevDay = dailyBars[dailyBars.length - 2];
  const midpoint = (prevDay.h + prevDay.l) / 2;
  const currentPrice = dailyBars[dailyBars.length - 1].c;
  if (currentPrice > midpoint) return 'bullish';
  if (currentPrice < midpoint) return 'bearish';
  return 'neutral';
}

interface DisplacementResult {
  detected: boolean;
  direction: 'bullish' | 'bearish' | null;
  swingOrigin: number;
  displacementClose: number;
  barIndex: number;
}

function detectDisplacement(bars: Bar[], atr: number): DisplacementResult {
  const result: DisplacementResult = {
    detected: false,
    direction: null,
    swingOrigin: 0,
    displacementClose: 0,
    barIndex: -1,
  };

  if (bars.length < SWING_LOOKBACK + 2) return result;

  // Evaluate last fully closed bar (index length-2, the forming bar is length-1)
  const lastClosedIdx = bars.length - 2;
  const bar = bars[lastClosedIdx];
  const bodySize = Math.abs(bar.c - bar.o);

  if (bodySize < 1.5 * atr) return result;

  const lookbackBars = bars.slice(Math.max(0, lastClosedIdx - SWING_LOOKBACK), lastClosedIdx);
  const swingHigh = Math.max(...lookbackBars.map(b => b.h));
  const swingLow = Math.min(...lookbackBars.map(b => b.l));

  if (bar.c > bar.o && bar.h > swingHigh) {
    result.detected = true;
    result.direction = 'bullish';
    result.swingOrigin = swingLow;
    result.displacementClose = bar.c;
    result.barIndex = lastClosedIdx;
  } else if (bar.c < bar.o && bar.l < swingLow) {
    result.detected = true;
    result.direction = 'bearish';
    result.swingOrigin = swingHigh;
    result.displacementClose = bar.c;
    result.barIndex = lastClosedIdx;
  }

  return result;
}

interface OTEZone {
  low: number;
  high: number;
  entry: number;
}

function calcOTEZone(origin: number, terminus: number, direction: 'bullish' | 'bearish'): OTEZone {
  const range = Math.abs(terminus - origin);
  if (direction === 'bullish') {
    // Price moved UP (origin=swingLow, terminus=displacementClose)
    // OTE zone is a pullback DOWN: high of range minus fib levels
    const oteHigh = terminus - range * FIB_OTE_LOW;   // less retrace = higher price
    const oteLow = terminus - range * FIB_OTE_HIGH;    // more retrace = lower price
    const entry = terminus - range * FIB_ENTRY;
    return { low: oteLow, high: oteHigh, entry };
  } else {
    // Price moved DOWN (origin=swingHigh, terminus=displacementClose)
    // OTE zone is a pullback UP
    const oteLow = terminus + range * FIB_OTE_LOW;
    const oteHigh = terminus + range * FIB_OTE_HIGH;
    const entry = terminus + range * FIB_ENTRY;
    return { low: oteLow, high: oteHigh, entry };
  }
}

function checkFVG(bars: Bar[], direction: 'bullish' | 'bearish', oteZone: OTEZone): number | null {
  if (bars.length < 3) return null;
  for (let i = bars.length - 3; i >= Math.max(0, bars.length - 15); i--) {
    const c0 = bars[i];
    const c2 = bars[i + 2];
    if (direction === 'bullish') {
      if (c0.h < c2.l) {
        const fvgMid = (c0.h + c2.l) / 2;
        if (fvgMid >= oteZone.low && fvgMid <= oteZone.high) return fvgMid;
      }
    } else {
      if (c0.l > c2.h) {
        const fvgMid = (c0.l + c2.h) / 2;
        if (fvgMid >= oteZone.low && fvgMid <= oteZone.high) return fvgMid;
      }
    }
  }
  return null;
}

async function placeLimitOrder(
  symbol: string,
  side: 'buy' | 'sell',
  qty: number,
  limitPrice: number
): Promise<string | null> {
  try {
    const res = await axios.post(
      `${BASE_URL}/orders`,
      {
        symbol,
        qty: Math.floor(qty).toString(),
        side,
        type: 'limit',
        time_in_force: 'day',
        limit_price: limitPrice.toFixed(2),
      },
      { headers: HEADERS }
    );
    logger.info(`[StockBot] Limit order: ${side} ${Math.floor(qty)} ${symbol} @ ${limitPrice.toFixed(2)} — id=${res.data.id}`);
    return res.data.id as string;
  } catch (err) {
    logger.error(`[StockBot] Limit order failed ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function placeStopOrder(
  symbol: string,
  side: 'buy' | 'sell',
  qty: number,
  stopPrice: number
): Promise<void> {
  try {
    const res = await axios.post(
      `${BASE_URL}/orders`,
      {
        symbol,
        qty: Math.floor(qty).toString(),
        side,
        type: 'stop',
        time_in_force: 'day',
        stop_price: stopPrice.toFixed(2),
      },
      { headers: HEADERS }
    );
    logger.info(`[StockBot] Stop order: ${side} ${Math.floor(qty)} ${symbol} @ stop=${stopPrice.toFixed(2)} — id=${res.data.id}`);
  } catch (err) {
    logger.error(`[StockBot] Stop order failed ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function placeTakeProfitOrder(
  symbol: string,
  side: 'buy' | 'sell',
  qty: number,
  limitPrice: number
): Promise<void> {
  try {
    const res = await axios.post(
      `${BASE_URL}/orders`,
      {
        symbol,
        qty: Math.floor(qty).toString(),
        side,
        type: 'limit',
        time_in_force: 'day',
        limit_price: limitPrice.toFixed(2),
      },
      { headers: HEADERS }
    );
    logger.info(`[StockBot] Target order: ${side} ${Math.floor(qty)} ${symbol} @ ${limitPrice.toFixed(2)} — id=${res.data.id}`);
  } catch (err) {
    logger.error(`[StockBot] Target order failed ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function buildSetup(
  symbol: string,
  bars5m: Bar[],
  dailyBars: Bar[],
  equity: number
): Promise<TradeSetup | null> {
  const atr = calcATR(bars5m);
  const dailyBias = getDailyBias(dailyBars);
  if (dailyBias === 'neutral') return null;

  const disp = detectDisplacement(bars5m, atr);
  if (!disp.detected || !disp.direction) return null;

  // Bias must match displacement direction
  if (
    (dailyBias === 'bullish' && disp.direction !== 'bullish') ||
    (dailyBias === 'bearish' && disp.direction !== 'bearish')
  ) return null;

  const oteZone = calcOTEZone(disp.swingOrigin, disp.displacementClose, disp.direction);
  const fvgLevel = checkFVG(bars5m, disp.direction, oteZone);
  const entryPrice = fvgLevel ?? oteZone.entry;

  // Stop loss: swing point, capped at 2×ATR
  const rawStop = disp.direction === 'bullish'
    ? disp.swingOrigin
    : disp.swingOrigin;
  const maxStopDist = 2 * atr;
  const stopDistance = Math.min(Math.abs(entryPrice - rawStop), maxStopDist);
  const stopPrice = disp.direction === 'bullish'
    ? entryPrice - stopDistance
    : entryPrice + stopDistance;

  // Target: previous session high/low
  const prevDay = dailyBars.length >= 2 ? dailyBars[dailyBars.length - 2] : null;
  const targetPrice = prevDay
    ? (disp.direction === 'bullish' ? prevDay.h : prevDay.l)
    : (disp.direction === 'bullish' ? entryPrice + stopDistance * 2 : entryPrice - stopDistance * 2);

  const riskDistance = Math.abs(entryPrice - stopPrice);
  const rewardDistance = Math.abs(targetPrice - entryPrice);
  const rRatio = rewardDistance / riskDistance;

  if (rRatio < MIN_R) return null;

  const riskDollars = equity * RISK_PCT;
  const qty = Math.floor(riskDollars / riskDistance);
  if (qty < 1) return null;

  return {
    symbol,
    side: disp.direction === 'bullish' ? 'long' : 'short',
    entryPrice,
    stopPrice,
    targetPrice,
    qty,
    oteHigh: oteZone.high,
    oteLow: oteZone.low,
  };
}

async function scanSymbol(
  symbol: string,
  equity: number,
  openSymbols: string[],
  openCount: number
): Promise<ScanResult> {
  const result: ScanResult = {
    symbol,
    price: 0,
    dailyBias: 'neutral',
    displacementDetected: false,
    inOteZone: false,
    tradeEntered: false,
    entryPrice: null,
    stopPrice: null,
    targetPrice: null,
  };

  try {
    const [bars5m, dailyBars] = await Promise.all([
      get5MinBars(symbol, 100),
      getDailyBars(symbol, 10),
    ]);

    if (bars5m.length < 20) return result;

    const currentPrice = bars5m[bars5m.length - 1].c;
    result.price = currentPrice;
    result.dailyBias = getDailyBias(dailyBars);

    const atr = calcATR(bars5m);
    const disp = detectDisplacement(bars5m, atr);
    result.displacementDetected = disp.detected;

    if (disp.detected && disp.direction) {
      const oteZone = calcOTEZone(disp.swingOrigin, disp.displacementClose, disp.direction);
      result.inOteZone = currentPrice >= oteZone.low && currentPrice <= oteZone.high;
    }

    logger.info(
      `[StockBot] ${symbol}: price=${currentPrice.toFixed(2)} bias=${result.dailyBias} ` +
      `disp=${result.displacementDetected} OTE=${result.inOteZone}`
    );

    // Skip if max positions reached or already in this symbol
    if (openCount >= MAX_POSITIONS || openSymbols.includes(symbol)) return result;

    const setup = await buildSetup(symbol, bars5m, dailyBars, equity);
    if (!setup) return result;

    // Only enter if current price is in OTE zone
    if (!result.inOteZone) return result;

    const side = setup.side === 'long' ? 'buy' : 'sell';
    const stopSide = setup.side === 'long' ? 'sell' : 'buy';

    const orderId = await placeLimitOrder(symbol, side, setup.qty, setup.entryPrice);
    if (!orderId) return result;

    // Place stop and target immediately after entry fill submitted
    await placeStopOrder(symbol, stopSide, setup.qty, setup.stopPrice);
    await placeTakeProfitOrder(symbol, stopSide, setup.qty, setup.targetPrice);

    result.tradeEntered = true;
    result.entryPrice = setup.entryPrice;
    result.stopPrice = setup.stopPrice;
    result.targetPrice = setup.targetPrice;

    state.openPositions.push({
      symbol,
      side: setup.side,
      entryPrice: setup.entryPrice,
      qty: setup.qty,
      stopPrice: setup.stopPrice,
      targetPrice: setup.targetPrice,
      openedAt: new Date().toISOString(),
    });

    logger.info(
      `[StockBot] TRADE: ${symbol} ${setup.side} ${setup.qty}sh @ ${setup.entryPrice.toFixed(2)} ` +
      `stop=${setup.stopPrice.toFixed(2)} target=${setup.targetPrice.toFixed(2)}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[StockBot] Error scanning ${symbol}: ${msg}`);
    state.lastErrors.push(`${symbol}: ${msg}`);
    if (state.lastErrors.length > 20) state.lastErrors.shift();
  }

  return result;
}

async function runStockScan(): Promise<void> {
  try {
    const killZone = isInKillZone();
    state.killZoneActive = killZone;

    if (!killZone) {
      logger.info('[StockBot] Outside kill zone — skipping scan');
      return;
    }

    if (isPastEODClose()) {
      await closeAllPositions();
      return;
    }

    const marketOpen = await isMarketOpen();
    if (!marketOpen) {
      logger.info('[StockBot] Market closed — skipping scan');
      return;
    }

    state.lastScan = new Date().toISOString();
    state.scanCount++;

    const [equity, openSymbols] = await Promise.all([
      getAccountEquity(),
      getOpenPositions(),
    ]);

    logger.info(
      `[StockBot] Scan #${state.scanCount} | equity=$${equity.toFixed(2)} | open=${openSymbols.length}/${MAX_POSITIONS}`
    );

    const results: ScanResult[] = [];
    for (const symbol of SYMBOLS) {
      const result = await scanSymbol(symbol, equity, openSymbols, openSymbols.length + results.filter(r => r.tradeEntered).length);
      results.push(result);
    }

    state.lastScanResults = results;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[StockBot] Scan error: ${msg}`);
    state.lastErrors.push(msg);
    if (state.lastErrors.length > 20) state.lastErrors.shift();
  }
}

export function startStockBot(): void {
  if (state.running) return;
  state.running = true;
  logger.info('[StockBot] Starting — scanning every 1 minute during kill zone (9:30–11:00 ET)');

  const INTERVAL_MS = 60 * 1000;

  void runStockScan();
  setInterval(() => {
    void runStockScan();
  }, INTERVAL_MS);
}
