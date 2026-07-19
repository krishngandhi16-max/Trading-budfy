/**
 * Stock trading bot — trend-following momentum with volatility-scaled stops.
 *
 * Strategy (each component is a standard TradingView indicator, replicated exactly):
 *   - UT Bot Alerts (ATR trailing stop, KEY_VALUE=1.5, ATR=10) — entry/exit trigger
 *   - EMA100 regime filter — longs only above, shorts only below
 *   - RSI(14) extreme filter — don't chase: no longs when RSI>70, no shorts when RSI<30
 *   - ATR-based stop loss, 1% equity risk per trade (volatility position sizing)
 *
 * Evidence base:
 *   - Time-series momentum: Moskowitz, Ooi & Pedersen (2012) — trend persists across assets
 *   - Volatility-scaled sizing: Barroso & Santa-Clara (2015) — halves momentum crashes
 *   - Long AND short (stocks are shortable on Alpaca paper, unlike crypto)
 *
 * Only trades during regular market hours (checked via Alpaca /clock).
 * Exits are flip-only (trend reversal), same as the crypto bot. Stop order on
 * Alpaca is the hard floor.
 *
 * Env vars: ALPACA_API_KEY, ALPACA_SECRET_KEY  (same as crypto bot)
 */

const logger = {
  info:  (obj: unknown, msg?: string) => console.log(`[StockBot] ${msg ?? ""}`, obj),
  warn:  (obj: unknown, msg?: string) => console.warn(`[StockBot] ${msg ?? ""}`, obj),
  error: (obj: unknown, msg?: string) => console.error(`[StockBot] ${msg ?? ""}`, obj),
};

const BROKER_BASE = "https://paper-api.alpaca.markets/v2";
const DATA_BASE   = "https://data.alpaca.markets/v2";

const ALPACA_KEY    = process.env.ALPACA_API_KEY    ?? "";
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY ?? "";

const KEY_VALUE  = 3.0; // widened from 1.5 — strategyLab grid: KV=3 +35.8%/12.3%DD vs KV=1.5 -8.8% (whipsaw)
const ATR_PERIOD = 10;
const EMA_PERIOD = 100;
const RSI_PERIOD = 14;
const RISK_PCT   = 0.01;
const MAX_ORDER_NOTIONAL = 195_000;

// Liquid, high-beta names where hourly trend-following has enough range to work.
const SYMBOLS = ["NVDA", "AMD", "TSLA", "MSFT", "META", "AMZN", "AVGO"];

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
  marketOpen:    boolean;
  lastScan:      string | null;
  openPositions: PositionState[];
  lastErrors:    string[];
  scanCount:     number;
}

const state: BotState = {
  running:       false,
  marketOpen:    false,
  lastScan:      null,
  openPositions: [],
  lastErrors:    [],
  scanCount:     0,
};

export function getStockBotState(): BotState {
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

async function getBars(symbol: string): Promise<Bar[]> {
  // ~350 hours back covers 200+ regular-session 1H bars (6.5 bars/day, weekends off)
  const end   = new Date();
  const start = new Date(end.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days
  const url   = `${DATA_BASE}/stocks/bars?symbols=${symbol}&timeframe=1Hour` +
                `&start=${start.toISOString()}&end=${end.toISOString()}` +
                `&limit=1000&adjustment=split&feed=iex&sort=asc`;
  try {
    const data = await apiFetch(url) as { bars?: Record<string, Bar[]> };
    const bars = data.bars?.[symbol] ?? [];
    logger.info({ symbol, count: bars.length }, "Bars fetched");
    return bars;
  } catch (err) {
    logger.error({ symbol, err: err instanceof Error ? err.message : String(err) }, "Bar fetch failed");
    return [];
  }
}

async function isMarketOpen(): Promise<boolean> {
  try {
    const clock = await apiFetch(`${BROKER_BASE}/clock`) as { is_open: boolean };
    return clock.is_open;
  } catch {
    return false;
  }
}

async function getEquity(): Promise<number> {
  const data = await apiFetch(`${BROKER_BASE}/account`) as { equity: string };
  return parseFloat(data.equity);
}

interface LivePosition { symbol: string; side: "long" | "short"; qty: number; entryPrice: number; }

async function getLivePositions(): Promise<LivePosition[]> {
  const data = await apiFetch(`${BROKER_BASE}/positions`) as
    { symbol: string; side: string; qty: string; avg_entry_price: string }[];
  return data.map((p) => ({
    symbol:     p.symbol,
    side:       p.side === "short" ? "short" : "long",
    qty:        Math.abs(parseFloat(p.qty)),
    entryPrice: parseFloat(p.avg_entry_price),
  }));
}

// ── Indicators (identical math to the TradingView built-ins) ─────────────────

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

// Wilder's RSI — same as TradingView's ta.rsi()
function calcRSI(bars: Bar[], period = RSI_PERIOD): number[] {
  const rsi: number[] = new Array(bars.length).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < bars.length; i++) {
    const change = bars[i].c - bars[i-1].c;
    const gain = Math.max(change, 0), loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (i >= period) rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
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

// ── Sizing — whole shares (shorts cannot be fractional) ──────────────────────

function calcQty(equity: number, price: number, stopDist: number): number {
  if (stopDist <= 0) return 0;
  const raw = Math.min(
    (equity * RISK_PCT) / stopDist,
    (equity * 0.20) / price,
    MAX_ORDER_NOTIONAL / price,
  );
  return Math.floor(raw);
}

// ── Orders — market entry + GTC stop, flip-only exit (no fixed TP) ───────────

async function hasLivePosition(symbol: string): Promise<boolean> {
  const positions = await apiFetch(`${BROKER_BASE}/positions`) as { symbol: string }[];
  return positions.some((p) => p.symbol.toUpperCase() === symbol.toUpperCase());
}

async function placeEntry(symbol: string, side: "long" | "short", qty: number, price: number, stopDist: number): Promise<void> {
  if (await hasLivePosition(symbol)) {
    logger.warn({ symbol }, "Position already exists on Alpaca — skipping order");
    return;
  }
  const sl = side === "long"
    ? Math.round((price - stopDist) * 100) / 100
    : Math.round((price + stopDist) * 100) / 100;
  logger.info({ symbol, side: side.toUpperCase(), qty, price, sl, tp: "flip-only" }, "Stock order");

  const entrySide = side === "long" ? "buy" : "sell";
  const stopSide  = side === "long" ? "sell" : "buy";

  await apiFetch(`${BROKER_BASE}/orders`, { method: "POST", body: JSON.stringify({
    symbol, qty: String(qty), side: entrySide, type: "market", time_in_force: "day",
  })});
  await apiFetch(`${BROKER_BASE}/orders`, { method: "POST", body: JSON.stringify({
    symbol, qty: String(qty), side: stopSide, type: "stop", time_in_force: "gtc", stop_price: String(sl),
  })});
}

async function closePosition(symbol: string): Promise<void> {
  logger.info({ symbol }, "Closing position");
  // Cancel resting stop orders first so shares aren't held against the close
  try {
    const orders = await apiFetch(`${BROKER_BASE}/orders?status=open&symbols=${symbol}`) as { id: string }[];
    for (const o of orders) {
      await apiFetch(`${BROKER_BASE}/orders/${o.id}`, { method: "DELETE" });
    }
  } catch (err) {
    logger.warn({ symbol, err: err instanceof Error ? err.message : String(err) }, "Order cancel failed (continuing)");
  }
  await apiFetch(`${BROKER_BASE}/positions/${encodeURIComponent(symbol)}`, { method: "DELETE" });
}

// ── Per-symbol scan ──────────────────────────────────────────────────────────

async function scanSymbol(symbol: string, equity: number, positions: LivePosition[]): Promise<void> {
  const bars = await getBars(symbol);
  if (bars.length < EMA_PERIOD + 10) {
    logger.warn({ symbol, got: bars.length, need: EMA_PERIOD + 10 }, "Not enough bars");
    return;
  }

  const atr      = calcATR(bars);
  const ema      = calcEMA(bars);
  const rsi      = calcRSI(bars);
  const utbot    = calcUTBot(bars, atr);
  const i        = bars.length - 2;              // last fully closed bar
  const price    = bars[i].c;
  const aboveEma = price > ema[i];
  const prevDir  = utbot[i-1]?.direction ?? utbot[i].direction;
  const currDir  = utbot[i].direction;
  const bullFlip = prevDir === -1 && currDir === 1;
  const bearFlip = prevDir ===  1 && currDir === -1;
  const stopDist = KEY_VALUE * atr[i];
  const qty      = calcQty(equity, price, stopDist);
  const live     = positions.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase());

  logger.info({
    symbol, price, aboveEma, utDir: currDir, bullFlip, bearFlip,
    rsi: rsi[i].toFixed(1), isOpen: !!live, side: live?.side, qty, stopDist: stopDist.toFixed(2),
  }, "Scan result");

  if (live) {
    // Side comes from Alpaca itself, so signal exits survive restarts.
    // Exit on UT flip only — EMA cross exit cut winners early (strategyLab grid).
    if (live.side === "long"  && bearFlip) { await closePosition(symbol); return; }
    if (live.side === "short" && bullFlip) { await closePosition(symbol); return; }
    return;
  }

  if (qty <= 0) return;

  // Long: fresh bull flip, above EMA100, not chasing an overbought spike
  if (bullFlip && aboveEma && rsi[i] < 70) {
    await placeEntry(symbol, "long", qty, price, stopDist);
    state.openPositions.push({ symbol, side: "long", entryPrice: price, qty,
      sl: Math.round((price - stopDist) * 100) / 100, openedAt: new Date().toISOString() });
  }
  // Short: fresh bear flip, below EMA100, not chasing an oversold flush
  else if (bearFlip && !aboveEma && rsi[i] > 30) {
    await placeEntry(symbol, "short", qty, price, stopDist);
    state.openPositions.push({ symbol, side: "short", entryPrice: price, qty,
      sl: Math.round((price + stopDist) * 100) / 100, openedAt: new Date().toISOString() });
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────

async function runScan(): Promise<void> {
  state.lastScan = new Date().toISOString();
  state.scanCount++;

  try {
    state.marketOpen = await isMarketOpen();
    if (!state.marketOpen) {
      if (state.scanCount % 12 === 1) logger.info({ scanCount: state.scanCount }, "Market closed — skipping stock scan");
      return;
    }

    const [equity, positions] = await Promise.all([getEquity(), getLivePositions()]);

    // Rebuild tracked state from Alpaca (survives restarts; stock symbols only)
    const stockSet = new Set(SYMBOLS.map((s) => s.toUpperCase()));
    state.openPositions = positions
      .filter((p) => stockSet.has(p.symbol.toUpperCase()))
      .map((p) => {
        const prev = state.openPositions.find((q) => q.symbol === p.symbol);
        return prev ?? { symbol: p.symbol, side: p.side, entryPrice: p.entryPrice,
                         qty: p.qty, sl: 0, openedAt: new Date().toISOString() };
      });

    logger.info({ scanCount: state.scanCount, equity, openStocks: state.openPositions.length }, "Stock scan");

    for (const symbol of SYMBOLS) {
      await scanSymbol(symbol, equity, positions);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "Scan error");
    state.lastErrors.push(msg);
    if (state.lastErrors.length > 20) state.lastErrors.shift();
  }
}

export function startStockBot(): void {
  if (state.running) return;
  state.running = true;
  logger.info("StockBot starting — UT Bot + EMA100 + RSI filter, long/short, market hours only");
  void runScan();
  setInterval(() => { void runScan(); }, SCAN_INTERVAL_MS);
}
