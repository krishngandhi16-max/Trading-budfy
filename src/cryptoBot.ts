/**
 * Crypto trading bot — UT Bot + EMA100 signals, flip-only exits (no fixed TP)
 *
 * Exit logic: positions close ONLY when the UT Bot direction flips or price
 * crosses the EMA100. No bracket orders, no fixed take-profit attached to entry.
 *
 * Env vars:
 *   ALPACA_API_KEY      Alpaca key ID
 *   ALPACA_SECRET_KEY   Alpaca secret key
 */

const logger = {
  info:  (obj: unknown, msg?: string) => console.log(`[CryptoBot] ${msg ?? ""}`, obj),
  warn:  (obj: unknown, msg?: string) => console.warn(`[CryptoBot] ${msg ?? ""}`, obj),
  error: (obj: unknown, msg?: string) => console.error(`[CryptoBot] ${msg ?? ""}`, obj),
};

const BROKER_BASE = "https://paper-api.alpaca.markets/v2";

const ALPACA_KEY    = process.env.ALPACA_API_KEY    ?? "";
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY ?? "";

const KEY_VALUE  = 1.5;
const ATR_PERIOD = 10;
const EMA_PERIOD = 100;
const RISK_PCT   = 0.01;

const SYMBOLS: { alpaca: string }[] = [
  { alpaca: "BTC/USD" },
  { alpaca: "ETH/USD" },
  { alpaca: "SOL/USD" },
];

const SCAN_INTERVAL_MS = 5 * 60_000;

interface PositionState {
  symbol:     string;
  side:       "long" | "short";
  entryPrice: number;
  qty:        number;
  sl:         number;
  openedAt:   string;
}

interface BotState {
  running:       boolean;
  lastScan:      string | null;
  openPositions: PositionState[];
  lastErrors:    string[];
  scanCount:     number;
}

const state: BotState = {
  running:       false,
  lastScan:      null,
  openPositions: [],
  lastErrors:    [],
  scanCount:     0,
};

export function getCryptoBotState(): BotState {
  return { ...state, openPositions: [...state.openPositions] };
}

async function apiFetch(url: string, opts: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, {
    ...opts,
    headers: {
      "APCA-API-KEY-ID":     ALPACA_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
      "Content-Type":        "application/json",
      ...(opts.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 300)}`);
  if (!text) return {};
  return JSON.parse(text);
}

interface Bar { t: string; o: number; h: number; l: number; c: number; v: number; }

async function getBars(alpacaSym: string): Promise<Bar[]> {
  const sym   = encodeURIComponent(alpacaSym);
  const end   = new Date();
  const start = new Date(end.getTime() - 200 * 60 * 60 * 1000);
  const url   = `https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=${sym}&timeframe=1H` +
                `&start=${start.toISOString()}&end=${end.toISOString()}&limit=200&sort=asc`;
  try {
    const data = await apiFetch(url) as { bars?: Record<string, Bar[]> };
    const bars = data.bars?.[alpacaSym] ?? [];
    logger.info({ symbol: alpacaSym, count: bars.length }, "Bars fetched");
    if (bars.length === 0) logger.warn({ symbol: alpacaSym }, "0 bars — check API key or symbol format");
    return bars;
  } catch (err) {
    logger.error({ symbol: alpacaSym, err: err instanceof Error ? err.message : String(err) }, "Bar fetch failed");
    return [];
  }
}

async function getEquity(): Promise<number> {
  const data = await apiFetch(`${BROKER_BASE}/account`) as { equity: string };
  return parseFloat(data.equity);
}

async function getOpenSymbols(): Promise<string[]> {
  const data = await apiFetch(`${BROKER_BASE}/positions`) as { symbol: string }[];
  return data.map((p) => p.symbol);
}

function calcATR(bars: Bar[], period = ATR_PERIOD): number[] {
  const trs: number[] = [bars[0].h - bars[0].l];
  for (let i = 1; i < bars.length; i++) {
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i-1].c), Math.abs(bars[i].l - bars[i-1].c)));
  }
  const atr: number[] = new Array(bars.length).fill(0);
  let sum = 0;
  for (let i = 0; i < period && i < trs.length; i++) sum += trs[i];
  atr[period - 1] = sum / period;
  for (let i = period; i < bars.length; i++) atr[i] = (atr[i-1] * (period-1) + trs[i]) / period;
  return atr;
}

function calcEMA(bars: Bar[], period = EMA_PERIOD): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = new Array(bars.length).fill(0);
  ema[0] = bars[0].c;
  for (let i = 1; i < bars.length; i++) ema[i] = bars[i].c * k + ema[i-1] * (1 - k);
  return ema;
}

interface UTBotResult { direction: 1 | -1; trailStop: number; }

function calcUTBot(bars: Bar[], atr: number[]): UTBotResult[] {
  const results: UTBotResult[] = [];
  let dir: 1 | -1 = 1;
  for (let i = 0; i < bars.length; i++) {
    const src   = bars[i].c;
    const nLoss = KEY_VALUE * (atr[i] > 0 ? atr[i] : bars[i].h - bars[i].l);
    let newTrail: number;
    if (i === 0) {
      newTrail = src - nLoss;
    } else {
      const pt = results[i-1].trailStop, ps = bars[i-1].c;
      if      (src > pt && ps > pt) newTrail = Math.max(pt, src - nLoss);
      else if (src < pt && ps < pt) newTrail = Math.min(pt, src + nLoss);
      else if (src > pt)            newTrail = src - nLoss;
      else                          newTrail = src + nLoss;
    }
    const prevDir: 1 | -1 = i === 0 ? dir : results[i-1].direction;
    if (i > 0) {
      const ps = bars[i-1].c, pt = results[i-1].trailStop;
      if      (ps <= pt && src > newTrail) dir = 1;
      else if (ps >= pt && src < newTrail) dir = -1;
      else dir = prevDir;
    }
    results.push({ direction: dir, trailStop: newTrail });
  }
  return results;
}

function calcQty(equity: number, price: number, stopDist: number, symbol: string): number {
  if (stopDist <= 0) return 0;
  const raw = Math.min((equity * RISK_PCT) / stopDist, (equity * 0.25) / price);
  if (symbol.includes("BTC")) return Math.floor(raw * 1e8) / 1e8;
  if (symbol.includes("ETH")) return Math.floor(raw * 1e6) / 1e6;
  return Math.floor(raw * 1e2) / 1e2;
}

async function placeLong(alpacaSym: string, qty: number, price: number, stopDist: number): Promise<void> {
  const sl = Math.round((price - stopDist) * 100) / 100;
  logger.info({ symbol: alpacaSym, side: "LONG", qty, price, sl, tp: "flip-only" }, "Crypto order");
  await apiFetch(`${BROKER_BASE}/orders`, { method: "POST", body: JSON.stringify({ symbol: alpacaSym, qty: String(qty), side: "buy",  type: "market", time_in_force: "gtc" }) });
  await apiFetch(`${BROKER_BASE}/orders`, { method: "POST", body: JSON.stringify({ symbol: alpacaSym, qty: String(qty), side: "sell", type: "stop",   time_in_force: "gtc", stop_price: String(sl) }) });
}

async function placeShort(alpacaSym: string, qty: number, price: number, stopDist: number): Promise<void> {
  const sl = Math.round((price + stopDist) * 100) / 100;
  logger.info({ symbol: alpacaSym, side: "SHORT", qty, price, sl, tp: "flip-only" }, "Crypto order");
  await apiFetch(`${BROKER_BASE}/orders`, { method: "POST", body: JSON.stringify({ symbol: alpacaSym, qty: String(qty), side: "sell", type: "market", time_in_force: "gtc" }) });
  await apiFetch(`${BROKER_BASE}/orders`, { method: "POST", body: JSON.stringify({ symbol: alpacaSym, qty: String(qty), side: "buy",  type: "stop",   time_in_force: "gtc", stop_price: String(sl) }) });
}

async function closePosition(alpacaSym: string): Promise<void> {
  logger.info({ symbol: alpacaSym }, "Closing position");
  await apiFetch(`${BROKER_BASE}/positions/${encodeURIComponent(alpacaSym)}`, { method: "DELETE" });
}

async function scanSymbol(sym: { alpaca: string }, equity: number, openSymbols: string[]): Promise<void> {
  const bars = await getBars(sym.alpaca);
  if (bars.length < 50) { logger.warn({ symbol: sym.alpaca, got: bars.length }, "Not enough bars"); return; }

  const atr      = calcATR(bars);
  const ema      = calcEMA(bars);
  const utbot    = calcUTBot(bars, atr);
  const i        = bars.length - 2;
  const price    = bars[i].c;
  const aboveEma = price > ema[i];
  const prevDir  = utbot[i-1]?.direction ?? utbot[i].direction;
  const currDir  = utbot[i].direction;
  const bullFlip = prevDir === -1 && currDir === 1;
  const bearFlip = prevDir ===  1 && currDir === -1;
  const stopDist = KEY_VALUE * atr[i];
  const qty      = calcQty(equity, price, stopDist, sym.alpaca);
  const isOpen   = openSymbols.some((s) => s.replace(/[\/]/g, "").toUpperCase() === sym.alpaca.replace(/[\/]/g, "").toUpperCase());

  logger.info({ symbol: sym.alpaca, price, aboveEma, utDir: currDir, bullFlip, bearFlip, isOpen, qty, stopDist: stopDist.toFixed(4) }, "Scan result");

  if (isOpen) {
    const pos = state.openPositions.find((p) => p.symbol === sym.alpaca);
    if (pos?.side === "long"  && (bearFlip || !aboveEma)) { await closePosition(sym.alpaca); return; }
    if (pos?.side === "short" && (bullFlip || aboveEma))  { await closePosition(sym.alpaca); return; }
  }

  if (isOpen || qty <= 0) return;

  if (bullFlip && aboveEma) {
    await placeLong(sym.alpaca, qty, price, stopDist);
    state.openPositions.push({ symbol: sym.alpaca, side: "long",  entryPrice: price, qty, sl: Math.round((price - stopDist) * 100) / 100, openedAt: new Date().toISOString() });
  } else if (bearFlip && !aboveEma) {
    await placeShort(sym.alpaca, qty, price, stopDist);
    state.openPositions.push({ symbol: sym.alpaca, side: "short", entryPrice: price, qty, sl: Math.round((price + stopDist) * 100) / 100, openedAt: new Date().toISOString() });
  }
}

async function runScan(): Promise<void> {
  state.lastScan = new Date().toISOString();
  state.scanCount++;
  try {
    const [equity, openSymbols] = await Promise.all([getEquity(), getOpenSymbols()]);
    state.openPositions = state.openPositions.filter((p) =>
      openSymbols.some((s) => s.replace(/[\/]/g, "").toUpperCase() === p.symbol.replace(/[\/]/g, "").toUpperCase())
    );
    logger.info({ scanCount: state.scanCount, equity, openCount: openSymbols.length }, "Crypto scan");
    for (const sym of SYMBOLS) await scanSymbol(sym, equity, openSymbols);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "Scan error");
    state.lastErrors.push(msg);
    if (state.lastErrors.length > 20) state.lastErrors.shift();
  }
}

export function startCryptoBot(): void {
  if (state.running) return;
  state.running = true;
  logger.info("CryptoBot starting — UT Bot + EMA100, flip-only exits, 5-min scan");
  void runScan();
  setInterval(() => { void runScan(); }, SCAN_INTERVAL_MS);
}
