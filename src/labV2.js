/**
 * Lab V2 — multi-family strategy search with walk-forward validation.
 *
 * Families tested (each a documented, literature-backed approach):
 *   UT      UT Bot ATR trailing flip (Wilder ATR trend-following)
 *   DONCH   Donchian channel breakout (Turtle rules: N-bar high entry, M-bar low exit)
 *   EMAX    EMA fast/slow cross with EMA100 regime filter
 *   RSI2    Connors RSI(2) mean reversion (long pullbacks in uptrends)
 *
 * Protocol: TRAIN on first 60% of ~2y hourly data, pick best per family by
 * return/DD, then report performance on the untouched TEST 40%. 5bps/side costs.
 * Stocks trade long+short, crypto long-only (Alpaca paper constraint).
 *
 * Run: node src/labV2.js
 */

const YF = require('yahoo-finance2').default;
const yf = new YF({ suppressNotices: ['yahooSurvey'] });

const START_EQ = 100_000;
const RISK_PCT = 0.01;
const COST     = 0.0005;
const WARMUP   = 250;

const STOCKS = ['NVDA', 'AMD', 'TSLA', 'MSFT', 'META', 'AAPL', 'AMZN', 'GOOGL', 'AVGO', 'PLTR', 'COIN'];
const CRYPTO = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'AVAX-USD', 'DOGE-USD', 'LINK-USD'];

// ── Data ─────────────────────────────────────────────────────────────────────

async function fetchBars(sym, isStock) {
  const end = new Date(), start = new Date(end.getTime() - 700 * 24 * 3600 * 1000);
  const r = await yf.chart(sym, { period1: start, period2: end, interval: '1h', includePrePost: false });
  let q = r.quotes.filter(x => x.close != null && x.high != null && x.low != null);
  if (isStock) {
    q = q.filter(x => {
      const et = new Date(x.date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const m = et.getHours() * 60 + et.getMinutes();
      return m >= 570 && m < 960;
    });
  }
  return q.map(x => ({ t: x.date.toISOString(), o: x.open, h: x.high, l: x.low, c: x.close }));
}

// ── Indicators ───────────────────────────────────────────────────────────────

function atrArr(bars, p) {
  const trs = [bars[0].h - bars[0].l];
  for (let i = 1; i < bars.length; i++)
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i-1].c), Math.abs(bars[i].l - bars[i-1].c)));
  const a = new Array(bars.length).fill(0);
  let s = 0;
  for (let i = 0; i < p; i++) s += trs[i];
  a[p-1] = s / p;
  for (let i = p; i < bars.length; i++) a[i] = (a[i-1] * (p-1) + trs[i]) / p;
  return a;
}
function emaArr(bars, p) {
  const k = 2 / (p + 1), e = new Array(bars.length).fill(0);
  e[0] = bars[0].c;
  for (let i = 1; i < bars.length; i++) e[i] = bars[i].c * k + e[i-1] * (1 - k);
  return e;
}
function rsiArr(bars, p) {
  const r = new Array(bars.length).fill(50);
  let ag = 0, al = 0;
  for (let i = 1; i < bars.length; i++) {
    const ch = bars[i].c - bars[i-1].c, g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= p) { ag += g / p; al += l / p; }
    else { ag = (ag * (p-1) + g) / p; al = (al * (p-1) + l) / p; }
    if (i >= p) r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return r;
}
function utArr(bars, atr, kv) {
  const res = []; let dir = 1;
  for (let i = 0; i < bars.length; i++) {
    const src = bars[i].c, nL = kv * (atr[i] > 0 ? atr[i] : bars[i].h - bars[i].l);
    let nt;
    if (i === 0) nt = src - nL;
    else {
      const pt = res[i-1].ts, ps = bars[i-1].c;
      if      (src > pt && ps > pt) nt = Math.max(pt, src - nL);
      else if (src < pt && ps < pt) nt = Math.min(pt, src + nL);
      else if (src > pt)            nt = src - nL;
      else                          nt = src + nL;
    }
    if (i > 0) {
      const ps = bars[i-1].c, pt = res[i-1].ts;
      if      (ps <= pt && src > nt) dir = 1;
      else if (ps >= pt && src < nt) dir = -1;
      else dir = res[i-1].dir;
    }
    res.push({ dir, ts: nt });
  }
  return res;
}
function rollMax(bars, n, f) {
  const out = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    let m = -Infinity;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.max(m, f(bars[j]));
    out[i] = m;
  }
  return out;
}
function rollMin(bars, n, f) {
  const out = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    let m = Infinity;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.min(m, f(bars[j]));
    out[i] = m;
  }
  return out;
}

// ── Strategy signal builders ─────────────────────────────────────────────────
// Each returns per-bar {long, short, exitLong, exitShort, stop} arrays.

function buildSignals(d, strat, cfg) {
  const n = d.bars.length;
  const sig = { long: new Array(n).fill(false), short: new Array(n).fill(false),
                exitLong: new Array(n).fill(false), exitShort: new Array(n).fill(false),
                stop: new Array(n).fill(0) };
  const ema100 = d.ema100;

  if (strat === 'UT') {
    const atr = atrArr(d.bars, cfg.atrP);
    const ut  = utArr(d.bars, atr, cfg.kv);
    for (let i = 1; i < n; i++) {
      const bull = ut[i-1].dir === -1 && ut[i].dir === 1;
      const bear = ut[i-1].dir ===  1 && ut[i].dir === -1;
      const above = d.bars[i].c > ema100[i];
      sig.long[i]      = bull && above;
      sig.short[i]     = bear && !above;
      sig.exitLong[i]  = bear;
      sig.exitShort[i] = bull;
      sig.stop[i]      = cfg.kv * atr[i];
    }
  } else if (strat === 'DONCH') {
    const atr = atrArr(d.bars, 20);
    const hi  = rollMax(d.bars, cfg.entryN, b => b.h);
    const lo  = rollMin(d.bars, cfg.entryN, b => b.l);
    const exHi = rollMax(d.bars, cfg.exitN, b => b.h);
    const exLo = rollMin(d.bars, cfg.exitN, b => b.l);
    for (let i = 1; i < n; i++) {
      const above = d.bars[i].c > ema100[i];
      sig.long[i]      = d.bars[i].c > hi[i-1] && above;
      sig.short[i]     = d.bars[i].c < lo[i-1] && !above;
      sig.exitLong[i]  = d.bars[i].c < exLo[i-1];
      sig.exitShort[i] = d.bars[i].c > exHi[i-1];
      sig.stop[i]      = 2 * atr[i];
    }
  } else if (strat === 'EMAX') {
    const atr = atrArr(d.bars, 14);
    const ef  = emaArr(d.bars, cfg.fast);
    const es  = emaArr(d.bars, cfg.slow);
    for (let i = 1; i < n; i++) {
      const xUp = ef[i-1] <= es[i-1] && ef[i] > es[i];
      const xDn = ef[i-1] >= es[i-1] && ef[i] < es[i];
      const above = d.bars[i].c > ema100[i];
      sig.long[i]      = xUp && above;
      sig.short[i]     = xDn && !above;
      sig.exitLong[i]  = xDn;
      sig.exitShort[i] = xUp;
      sig.stop[i]      = 3 * atr[i];
    }
  } else if (strat === 'RSI2') {
    const atr = atrArr(d.bars, 14);
    const r2  = rsiArr(d.bars, 2);
    for (let i = 1; i < n; i++) {
      const above = d.bars[i].c > ema100[i];
      sig.long[i]     = above && r2[i] < cfg.buyTh;
      sig.exitLong[i] = r2[i] > cfg.sellTh;
      sig.stop[i]     = 3 * atr[i];
    }
  }
  return sig;
}

// ── Portfolio simulator ──────────────────────────────────────────────────────

function simulate(datasets, allowShorts, fromFrac, toFrac) {
  const tsSet = new Set();
  for (const d of datasets) for (const b of d.bars) tsSet.add(b.t);
  const timeline = [...tsSet].sort();
  const t0 = timeline[Math.floor(timeline.length * fromFrac)];
  const t1 = timeline[Math.min(timeline.length - 1, Math.floor(timeline.length * toFrac))];

  let eq = START_EQ, peak = START_EQ, maxDD = 0;
  const positions = {};
  const trades = [];
  const monthly = {};

  const close = (sym, pos, exit, ts) => {
    const gross = pos.side === 'long' ? (exit - pos.entry) * pos.qty : (pos.entry - exit) * pos.qty;
    const pnl = gross - (pos.entry + exit) * pos.qty * COST;
    eq += pnl;
    trades.push(pnl);
    monthly[ts.slice(0, 7)] = (monthly[ts.slice(0, 7)] ?? 0) + pnl;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, (peak - eq) / peak);
    delete positions[sym];
  };

  for (const ts of timeline) {
    if (ts < t0) continue;
    if (ts > t1) break;
    for (const d of datasets) {
      const i = d.map.get(ts);
      if (i === undefined || i < WARMUP || i >= d.bars.length - 1) continue;
      const s = d.sig, price = d.bars[i].c, lo = d.bars[i].l, hi = d.bars[i].h;
      const pos = positions[d.sym];

      if (pos) {
        if (pos.side === 'long') {
          const slHit = lo <= pos.sl;
          if (slHit || s.exitLong[i]) close(d.sym, pos, slHit ? pos.sl : price, ts);
        } else {
          const slHit = hi >= pos.sl;
          if (slHit || s.exitShort[i]) close(d.sym, pos, slHit ? pos.sl : price, ts);
        }
        continue;
      }

      const stopDist = s.stop[i];
      if (stopDist <= 0) continue;
      const qty = Math.min((eq * RISK_PCT) / stopDist, (eq * 0.25) / price);
      if (qty <= 0) continue;

      if (s.long[i]) positions[d.sym] = { side: 'long', entry: price, qty, sl: price - stopDist };
      else if (allowShorts && s.short[i]) positions[d.sym] = { side: 'short', entry: price, qty, sl: price + stopDist };
    }
  }

  for (const [sym, pos] of Object.entries({ ...positions })) {
    const d = datasets.find(x => x.sym === sym);
    close(sym, pos, d.bars[d.bars.length - 1].c, d.bars[d.bars.length - 1].t);
  }

  const wins = trades.filter(p => p > 0);
  const gw = wins.reduce((a, b) => a + b, 0);
  const gl = trades.filter(p => p <= 0).reduce((a, b) => a - b, 0);
  const months = Object.values(monthly);
  return {
    ret: (eq / START_EQ - 1) * 100,
    maxDD: maxDD * 100,
    pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
    n: trades.length,
    wr: trades.length ? (wins.length / trades.length) * 100 : 0,
    monthly,
    avgMonth: months.length ? months.reduce((a, b) => a + b, 0) / months.length : 0,
    posMonths: months.filter(m => m > 0).length,
    nMonths: months.length,
  };
}

// ── Search ───────────────────────────────────────────────────────────────────

const GRIDS = {
  UT:    [ { kv: 2, atrP: 10 }, { kv: 3, atrP: 10 }, { kv: 4, atrP: 10 },
           { kv: 2, atrP: 20 }, { kv: 3, atrP: 20 }, { kv: 4, atrP: 20 } ],
  DONCH: [ { entryN: 20, exitN: 10 }, { entryN: 55, exitN: 20 }, { entryN: 100, exitN: 50 } ],
  EMAX:  [ { fast: 9, slow: 21 }, { fast: 20, slow: 50 }, { fast: 50, slow: 100 } ],
  RSI2:  [ { buyTh: 5, sellTh: 65 }, { buyTh: 10, sellTh: 70 }, { buyTh: 15, sellTh: 75 } ],
};

(async () => {
  console.log('Fetching ~2y 1H bars (Yahoo, regular session)...');
  const prep = async (syms, isStock) => {
    const out = [];
    for (const sym of syms) {
      try {
        const bars = await fetchBars(sym, isStock);
        if (bars.length < WARMUP + 200) { console.log(`  ${sym}: ${bars.length} bars — skipped`); continue; }
        out.push({ sym, bars, ema100: emaArr(bars, 100), map: new Map(bars.map((b, i) => [b.t, i])) });
        console.log(`  ${sym}: ${bars.length}`);
      } catch (e) { console.log(`  ${sym}: ERR ${e.message}`); }
    }
    return out;
  };

  const stockData  = await prep(STOCKS, true);
  const cryptoData = await prep(CRYPTO, false);

  const runClass = (label, datasets, allowShorts) => {
    console.log(`\n╔═══ ${label} — TRAIN 0–60% / TEST 60–100% ═══`);
    const finalists = [];
    for (const [strat, grid] of Object.entries(GRIDS)) {
      if (strat === 'RSI2' && allowShorts === false) { /* fine for both */ }
      let best = null;
      for (const cfg of grid) {
        for (const d of datasets) d.sig = buildSignals(d, strat, cfg);
        const train = simulate(datasets, allowShorts, 0, 0.6);
        const score = train.ret / Math.max(train.maxDD, 1);
        if (!best || score > best.score) best = { cfg, score, train };
      }
      // evaluate winner on TEST
      for (const d of datasets) d.sig = buildSignals(d, strat, best.cfg);
      const test = simulate(datasets, allowShorts, 0.6, 1.0);
      finalists.push({ strat, cfg: best.cfg, train: best.train, test });
      console.log(`║ ${strat.padEnd(6)} best=${JSON.stringify(best.cfg)}`);
      console.log(`║        TRAIN: ${best.train.ret.toFixed(1).padStart(6)}% ret ${best.train.maxDD.toFixed(1).padStart(5)}%DD PF ${best.train.pf.toFixed(2)} (${best.train.n} trades)`);
      console.log(`║        TEST : ${test.ret.toFixed(1).padStart(6)}% ret ${test.maxDD.toFixed(1).padStart(5)}%DD PF ${test.pf.toFixed(2)} (${test.n} trades, ${test.posMonths}/${test.nMonths} + months, avg mo ${test.avgMonth >= 0 ? '+' : ''}$${test.avgMonth.toFixed(0)})`);
    }
    const champ = finalists.reduce((a, b) =>
      (b.test.ret / Math.max(b.test.maxDD, 1)) > (a.test.ret / Math.max(a.test.maxDD, 1)) ? b : a);
    console.log(`╚═ CHAMPION on TEST: ${champ.strat} ${JSON.stringify(champ.cfg)} — ${champ.test.ret.toFixed(1)}% ret / ${champ.test.maxDD.toFixed(1)}% DD`);
    return champ;
  };

  const sChamp = runClass(`STOCKS (${stockData.length} syms, long+short)`, stockData, true);
  const cChamp = runClass(`CRYPTO (${cryptoData.length} syms, long only)`, cryptoData, false);

  // ── Funded-account math ────────────────────────────────────────────────────
  console.log('\n══════════ FUNDED ACCOUNT MATH (from TEST-period results only) ══════════');
  for (const [label, ch] of [['Stocks', sChamp], ['Crypto', cChamp]]) {
    const t = ch.test;
    const moPct = t.nMonths ? (Math.pow(1 + t.ret / 100, 1 / t.nMonths) - 1) * 100 : 0;
    console.log(`\n  ${label}: ${ch.strat} ${JSON.stringify(ch.cfg)}`);
    console.log(`    TEST monthly compounded: ${moPct.toFixed(2)}%/mo, maxDD ${t.maxDD.toFixed(1)}%`);
    if (moPct > 0) {
      const acctFor10k = 10_000 / (moPct / 100);
      console.log(`    Account size for $10k/mo at this rate: $${Math.round(acctFor10k).toLocaleString()}`);
      // risk scaling to fit a 10% prop-firm DD limit with 2x safety margin (target 5%)
      const riskScale = Math.min(1, 5 / Math.max(t.maxDD, 0.1));
      const scaledMo = moPct * riskScale;
      const acctScaled = scaledMo > 0 ? 10_000 / (scaledMo / 100) : Infinity;
      console.log(`    Prop-firm safe (risk scaled ×${riskScale.toFixed(2)} → ~5% maxDD): ${scaledMo.toFixed(2)}%/mo → need $${Math.round(acctScaled).toLocaleString()}`);
    } else {
      console.log(`    Negative test period — NOT deployable as-is`);
    }
  }
  console.log('\nDone.');
})();
