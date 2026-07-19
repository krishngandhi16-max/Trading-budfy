/**
 * Stock trading bot — Donchian channel breakout on DAILY bars (Turtle rules).
 *
 * Strategy (validated walk-forward in labV2/dailyLab — TEST +195.8% over ~7y,
 * 14.7% maxDD, PF 2.02 on 9 liquid names):
 *   - Enter long on close above the prior 100-day high (EMA100 regime: price above)
 *   - Enter short on close below the prior 100-day low (price below EMA100)
 *   - Exit long on close below the prior 50-day low; exit short on 50-day high
 *   - Stop loss at 2x ATR(20); 1% equity risk per trade
 *
 * Evidence base: classic Donchian/Turtle trend-following; time-series momentum
 * (Moskowitz, Ooi & Pedersen 2012). Hourly variants FAILED out-of-sample —
 * daily passed across every family tested. Do not move this back to intraday
 * without re-running the walk-forward.
 *
 * Only trades during regular market hours (checked via Alpaca /clock).
 * Stop order on Alpaca is the hard floor.
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

const ENTRY_N    = 100;  // breakout: close beyond prior 100-day extreme
const EXIT_N     = 50;   // exit: close beyond prior 50-day opposite extreme
const ATR_PERIOD = 20;
const ATR_STOP   = 2;    // stop at 2x ATR(20)
const EMA_PERIOD = 100;
const RISK_PCT   = 0.01;
const MAX_ORDER_NOTIONAL = 195_000;

// Liquid, high-beta names — matches the walk-forward test universe.
const SYMBOLS = ["NVDA", "AMD", "TSLA", "MSFT", "META", "AMZN", "AVGO", "AAPL", "GOOGL"];

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
  // Daily bars — hourly failed walk-forward validation, daily passed (see labV2.js)
  const end   = new Date();
  const start = new Date(end.getTime() - 600 * 24 * 60 * 60 * 1000); // ~400 trading days
  const url   = `${DATA_BASE}/stocks/bars?symbols=${symbol}&timeframe=1Day` +
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

function rollHigh(bars: Bar[], upto: number, n: number): number {
  let m = -Infinity;
  for (let j = Math.max(0, upto - n + 1); j <= upto; j++) m = Math.max(m, bars[j].h);
  return m;
}

function rollLow(bars: Bar[], upto: number, n: number): number {
  let m = Infinity;
  for (let j = Math.max(0, upto - n + 1); j <= upto; j++) m = Math.min(m, bars[j].l);
  return m;
}

async function scanSymbol(symbol: string, equity: number, positions: LivePosition[]): Promise<void> {
  const bars = await getBars(symbol);
  if (bars.length < ENTRY_N + EMA_PERIOD / 2) {
    logger.warn({ symbol, got: bars.length, need: ENTRY_N + EMA_PERIOD / 2 }, "Not enough bars");
    return;
  }

  const atr      = calcATR(bars);
  const ema      = calcEMA(bars);
  const i        = bars.length - 2;              // last fully closed daily bar
  const price    = bars[i].c;
  const aboveEma = price > ema[i];

  // Donchian channels computed on bars strictly before bar i
  const hi100 = rollHigh(bars, i - 1, ENTRY_N);
  const lo100 = rollLow(bars, i - 1, ENTRY_N);
  const hi50  = rollHigh(bars, i - 1, EXIT_N);
  const lo50  = rollLow(bars, i - 1, EXIT_N);

  const breakUp   = price > hi100;
  const breakDown = price < lo100;
  const stopDist  = ATR_STOP * atr[i];
  const qty       = calcQty(equity, price, stopDist);
  const live      = positions.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase());

  logger.info({
    symbol, price, aboveEma, hi100: hi100.toFixed(2), lo100: lo100.toFixed(2),
    breakUp, breakDown, isOpen: !!live, side: live?.side, qty, stopDist: stopDist.toFixed(2),
  }, "Scan result");

  if (live) {
    // Side comes from Alpaca itself, so signal exits survive restarts.
    // Turtle exit: close beyond the 50-day opposite extreme.
    if (live.side === "long"  && price < lo50) { await closePosition(symbol); return; }
    if (live.side === "short" && price > hi50) { await closePosition(symbol); return; }
    return;
  }

  if (qty <= 0) return;

  // Long: close breaks above prior 100-day high in an uptrend regime
  if (breakUp && aboveEma) {
    await placeEntry(symbol, "long", qty, price, stopDist);
    state.openPositions.push({ symbol, side: "long", entryPrice: price, qty,
      sl: Math.round((price - stopDist) * 100) / 100, openedAt: new Date().toISOString() });
  }
  // Short: close breaks below prior 100-day low in a downtrend regime
  else if (breakDown && !aboveEma) {
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
