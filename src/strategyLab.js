/**
 * Strategy Lab — grid-tests strategy variants on ~2y of free Yahoo 1H data.
 * No API keys needed. Run: node src/strategyLab.js
 *
 * Variants tested (all evidence-motivated):
 *   keyValue    ATR multiplier for UT Bot trailing stop (wider = fewer whipsaws)
 *   emaExit     exit when price crosses EMA100 (current live behavior) vs UT-flip-only
 *   htfFilter   higher-timeframe filter: SMA200 slope must agree with trade direction
 *                (classic "trade with the bigger trend" — Moskowitz et al. 2012)
 *
 * Includes 0.05% per-side cost so results aren't fantasy fills.
 */

const YF = require('yahoo-finance2').default;
const yf = new YF({ suppressNotices: ['yahooSurvey'] });

const ATR_PERIOD = 10;
const EMA_PERIOD = 100;
const RSI_PERIOD = 14;
const SMA_HTF    = 200;
const RISK_PCT   = 0.01;
const START_EQ   = 100_000;
const COST       = 0.0005; // 5 bps per side

const STOCKS = ['NVDA', 'AMD', 'TSLA', 'MSFT', 'META'];
const CRYPTO = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'AVAX-USD'];

async function fetchBars(sym, isStock) {
  const end = new Date(), start = new Date(end.getTime() - 700 * 24 * 3600 * 1000);
  const r = await yf.chart(sym, { period1: start, period2: end, interval: '1h', includePrePost: false });
  let quotes = r.quotes.filter(q => q.close != null && q.high != null && q.low != null);
  if (isStock) {
    // Belt and suspenders: drop anything outside 9:30–16:00 ET even if
    // includePrePost slips extended-hours bars through
    quotes = quotes.filter(q => {
      const et = new Date(q.date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const mins = et.getHours() * 60 + et.getMinutes();
      return mins >= 570 && mins < 960; // 9:30–16:00
    });
  }
  return quotes.map(q => ({ t: q.date.toISOString(), o: q.open, h: q.high, l: q.low, c: q.close }));
}

function calcATR(bars) {
  const trs = [bars[0].h - bars[0].l];
  for (let i = 1; i < bars.length; i++)
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i-1].c), Math.abs(bars[i].l - bars[i-1].c)));
  const atr = new Array(bars.length).fill(0);
  let sum = 0;
  for (let i = 0; i < ATR_PERIOD; i++) sum += trs[i];
  atr[ATR_PERIOD - 1] = sum / ATR_PERIOD;
  for (let i = ATR_PERIOD; i < bars.length; i++)
    atr[i] = (atr[i-1] * (ATR_PERIOD - 1) + trs[i]) / ATR_PERIOD;
  return atr;
}

function calcEMA(bars, period) {
  const k = 2 / (period + 1);
  const e = new Array(bars.length).fill(0);
  e[0] = bars[0].c;
  for (let i = 1; i < bars.length; i++) e[i] = bars[i].c * k + e[i-1] * (1 - k);
  return e;
}

function calcSMA(bars, period) {
  const s = new Array(bars.length).fill(0);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].c;
    if (i >= period) sum -= bars[i - period].c;
    s[i] = i >= period - 1 ? sum / period : bars[i].c;
  }
  return s;
}

function calcRSI(bars, period = RSI_PERIOD) {
  const rsi = new Array(bars.length).fill(50);
  let ag = 0, al = 0;
  for (let i = 1; i < bars.length; i++) {
    const ch = bars[i].c - bars[i-1].c;
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= period) { ag += g / period; al += l / period; }
    else { ag = (ag * (period-1) + g) / period; al = (al * (period-1) + l) / period; }
    if (i >= period) rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return rsi;
}

function calcUTBot(bars, atr, keyValue) {
  const res = [];
  let dir = 1;
  for (let i = 0; i < bars.length; i++) {
    const src = bars[i].c;
    const nLoss = keyValue * (atr[i] > 0 ? atr[i] : bars[i].h - bars[i].l);
    let nt;
    if (i === 0) nt = src - nLoss;
    else {
      const pt = res[i-1].trailStop, ps = bars[i-1].c;
      if      (src > pt && ps > pt) nt = Math.max(pt, src - nLoss);
      else if (src < pt && ps < pt) nt = Math.min(pt, src + nLoss);
      else if (src > pt)            nt = src - nLoss;
      else                          nt = src + nLoss;
    }
    const pd = i === 0 ? dir : res[i-1].direction;
    if (i > 0) {
      const ps = bars[i-1].c, pt = res[i-1].trailStop;
      if      (ps <= pt && src > nt) dir = 1;
      else if (ps >= pt && src < nt) dir = -1;
      else dir = pd;
    }
    res.push({ direction: dir, trailStop: nt });
  }
  return res;
}

function simulate(datasets, cfg, allowShorts) {
  const tsSet = new Set();
  for (const d of datasets) for (const b of d.bars) tsSet.add(b.t);
  const timeline = [...tsSet].sort();

  let equity = START_EQ, peak = START_EQ, maxDD = 0;
  const positions = {};
  const trades = [];

  const close = (sym, pos, exit) => {
    const gross = pos.side === 'long' ? (exit - pos.entry) * pos.qty : (pos.entry - exit) * pos.qty;
    const cost  = (pos.entry + exit) * pos.qty * COST;
    const pnl   = gross - cost;
    equity += pnl;
    trades.push(pnl);
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak);
    delete positions[sym];
  };

  const byTs = {};
  for (const d of datasets) {
    d.map = new Map(d.bars.map((b, i) => [b.t, i]));
  }

  for (const ts of timeline) {
    for (const d of datasets) {
      const i = d.map.get(ts);
      if (i === undefined || i < SMA_HTF + 2 || i >= d.bars.length - 1) continue;

      const price = d.bars[i].c, lo = d.bars[i].l, hi = d.bars[i].h;
      const aboveEma  = price > d.ema[i];
      const bullFlip  = d.ut[i-1].direction === -1 && d.ut[i].direction === 1;
      const bearFlip  = d.ut[i-1].direction ===  1 && d.ut[i].direction === -1;
      const stopDist  = cfg.keyValue * d.atr[i];
      const htfUp     = d.sma[i] > d.sma[i-1] && price > d.sma[i];
      const htfDown   = d.sma[i] < d.sma[i-1] && price < d.sma[i];
      const pos = positions[d.sym];

      if (pos) {
        if (pos.side === 'long') {
          const slHit = lo <= pos.sl;
          const sigEx = bearFlip || (cfg.emaExit && !aboveEma);
          if (slHit || sigEx) close(d.sym, pos, slHit ? pos.sl : price);
        } else {
          const slHit = hi >= pos.sl;
          const sigEx = bullFlip || (cfg.emaExit && aboveEma);
          if (slHit || sigEx) close(d.sym, pos, slHit ? pos.sl : price);
        }
        continue;
      }

      if (stopDist <= 0) continue;
      const qty = Math.min((equity * RISK_PCT) / stopDist, (equity * 0.25) / price);
      if (qty <= 0) continue;

      const longOk  = bullFlip && aboveEma && d.rsi[i] < 70 && (!cfg.htfFilter || htfUp);
      const shortOk = allowShorts && bearFlip && !aboveEma && d.rsi[i] > 30 && (!cfg.htfFilter || htfDown);

      if (longOk)       positions[d.sym] = { side: 'long',  entry: price, qty, sl: price - stopDist };
      else if (shortOk) positions[d.sym] = { side: 'short', entry: price, qty, sl: price + stopDist };
    }
  }

  for (const [sym, pos] of Object.entries({ ...positions })) {
    const d = datasets.find(x => x.sym === sym);
    close(sym, pos, d.bars[d.bars.length - 1].c);
  }

  const wins = trades.filter(p => p > 0);
  const gw = wins.reduce((a, b) => a + b, 0);
  const gl = trades.filter(p => p <= 0).reduce((a, b) => a - b, 0);
  return {
    ret:   (equity / START_EQ - 1) * 100,
    maxDD: maxDD * 100,
    pf:    gl > 0 ? gw / gl : Infinity,
    n:     trades.length,
    wr:    trades.length ? (wins.length / trades.length) * 100 : 0,
  };
}

(async () => {
  console.log('Fetching ~2y of 1H bars from Yahoo (free, no keys)...');
  const prep = async (syms) => {
    const out = [];
    for (const sym of syms) {
      try {
        const bars = await fetchBars(sym, !sym.includes("-USD"));
        if (bars.length < SMA_HTF + 50) { console.log(`  ${sym}: only ${bars.length} bars, skipped`); continue; }
        out.push({ sym, bars, atr: calcATR(bars), ema: calcEMA(bars, EMA_PERIOD), sma: calcSMA(bars, SMA_HTF), rsi: calcRSI(bars) });
        console.log(`  ${sym}: ${bars.length} bars`);
      } catch (e) { console.log(`  ${sym}: ERROR ${e.message}`); }
    }
    return out;
  };

  const stockData = await prep(STOCKS);
  const cryptoData = await prep(CRYPTO);

  const grid = [];
  for (const keyValue of [1.5, 2, 3]) {
    for (const emaExit of [true, false]) {
      for (const htfFilter of [false, true]) {
        grid.push({ keyValue, emaExit, htfFilter });
      }
    }
  }

  const run = (name, datasets, allowShorts) => {
    console.log(`\n════ ${name} — ${datasets.length} symbols, ~2y, 5bps/side costs ════`);
    console.log('  KV   emaExit  htfFilt │  Return   MaxDD    PF   Trades  Win%');
    console.log('  ─────────────────────┼──────────────────────────────────────');
    const results = [];
    for (const cfg of grid) {
      // UT Bot depends on keyValue — compute per config
      for (const d of datasets) d.ut = calcUTBot(d.bars, d.atr, cfg.keyValue);
      const r = simulate(datasets, cfg, allowShorts);
      results.push({ cfg, r });
      const mark = cfg.keyValue === 1.5 && cfg.emaExit && !cfg.htfFilter ? ' ← LIVE' : '';
      console.log(`  ${String(cfg.keyValue).padEnd(4)} ${String(cfg.emaExit).padEnd(8)} ${String(cfg.htfFilter).padEnd(7)}│ ${r.ret.toFixed(1).padStart(6)}%  ${r.maxDD.toFixed(1).padStart(5)}%  ${r.pf === Infinity ? '  ∞' : r.pf.toFixed(2).padStart(5)}  ${String(r.n).padStart(5)}  ${r.wr.toFixed(0).padStart(3)}%${mark}`);
    }
    const best = results.reduce((a, b) => (b.r.ret / Math.max(b.r.maxDD, 1)) > (a.r.ret / Math.max(a.r.maxDD, 1)) ? b : a);
    console.log(`  BEST (return/DD): KV=${best.cfg.keyValue} emaExit=${best.cfg.emaExit} htf=${best.cfg.htfFilter} → ${best.r.ret.toFixed(1)}% ret, ${best.r.maxDD.toFixed(1)}% DD`);
    return best;
  };

  if (stockData.length) run('STOCKS (long+short, RSI filter)', stockData, true);
  if (cryptoData.length) run('CRYPTO (long only)', cryptoData, false);
})();
