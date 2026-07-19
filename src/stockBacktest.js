/**
 * Stock bot backtest — portfolio simulation of stockBot.ts logic on $100k.
 *
 * Replicates the live bot exactly: UT Bot (1.5, 10) + EMA100 regime filter +
 * RSI(14) chase filter, long/short, 1% equity risk, 20% notional cap, whole
 * shares, ATR stop, flip-only exits. All symbols share ONE equity pool, same
 * as the real account. Reports per-month P&L to answer "can this do $X/month".
 *
 * Run: node src/stockBacktest.js
 */

require('dotenv').config();

const ALPACA_KEY    = process.env.ALPACA_API_KEY    ?? '';
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY ?? '';

if (!ALPACA_KEY || !ALPACA_SECRET) {
  console.error('Set ALPACA_API_KEY and ALPACA_SECRET_KEY env vars');
  process.exit(1);
}

const KEY_VALUE    = 1.5;
const ATR_PERIOD   = 10;
const EMA_PERIOD   = 100;
const RSI_PERIOD   = 14;
const RISK_PCT     = 0.01;
const NOTIONAL_PCT = 0.20;
const MAX_NOTIONAL = 195_000;
const START_EQUITY = 100_000;
const YEARS_BACK   = 2;

const SYMBOLS = ['NVDA', 'AMD', 'TSLA', 'MSFT', 'META', 'AMZN', 'AVGO'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchAllBars(symbol) {
  const end   = new Date();
  const start = new Date(end.getTime() - YEARS_BACK * 365 * 24 * 60 * 60 * 1000);
  const allBars = [];
  let nextToken = null;
  let page = 0;

  while (true) {
    if (page > 0) await sleep(1500);
    let url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbol}` +
              `&timeframe=1Hour&start=${start.toISOString()}&end=${end.toISOString()}` +
              `&limit=1000&adjustment=split&feed=iex&sort=asc`;
    if (nextToken) url += `&page_token=${encodeURIComponent(nextToken)}`;

    const res  = await fetch(url, {
      headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    const bars = data.bars?.[symbol] ?? [];
    allBars.push(...bars);
    nextToken = data.next_page_token;
    page++;
    if (!nextToken || bars.length === 0) break;
  }
  return allBars;
}

// ── Indicators — identical to stockBot.ts ────────────────────────────────────

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
  const ema = new Array(bars.length).fill(0);
  ema[0] = bars[0].c;
  for (let i = 1; i < bars.length; i++) ema[i] = bars[i].c * k + ema[i-1] * (1 - k);
  return ema;
}

function calcRSI(bars, period = RSI_PERIOD) {
  const rsi = new Array(bars.length).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < bars.length; i++) {
    const change = bars[i].c - bars[i-1].c;
    const gain = Math.max(change, 0), loss = Math.max(-change, 0);
    if (i <= period) { avgGain += gain / period; avgLoss += loss / period; }
    else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (i >= period) rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcUTBot(bars, atr) {
  const results = [];
  let dir = 1;
  for (let i = 0; i < bars.length; i++) {
    const src = bars[i].c;
    const nLoss = KEY_VALUE * (atr[i] > 0 ? atr[i] : bars[i].h - bars[i].l);
    let newTrail;
    if (i === 0) { newTrail = src - nLoss; }
    else {
      const pt = results[i-1].trailStop, ps = bars[i-1].c;
      if      (src > pt && ps > pt) newTrail = Math.max(pt, src - nLoss);
      else if (src < pt && ps < pt) newTrail = Math.min(pt, src + nLoss);
      else if (src > pt)            newTrail = src - nLoss;
      else                          newTrail = src + nLoss;
    }
    const prevDir = i === 0 ? dir : results[i-1].direction;
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

// ── Portfolio simulation ─────────────────────────────────────────────────────

function runPortfolio(symbolData) {
  // Global timeline = union of all bar timestamps
  const tsSet = new Set();
  for (const { bars } of Object.values(symbolData))
    for (const b of bars) tsSet.add(b.t);
  const timeline = [...tsSet].sort();

  let equity = START_EQUITY;
  const positions = {};            // symbol -> { side, entry, qty, sl }
  const closedTrades = [];
  const monthlyPnl = {};           // 'YYYY-MM' -> pnl
  let peakEquity = equity, maxDrawdown = 0;

  const record = (symbol, side, entry, exitPrice, qty, ts) => {
    const pnl = side === 'long' ? (exitPrice - entry) * qty : (entry - exitPrice) * qty;
    equity += pnl;
    closedTrades.push({ symbol, side, entry, exit: exitPrice, qty, pnl, ts });
    const month = ts.slice(0, 7);
    monthlyPnl[month] = (monthlyPnl[month] ?? 0) + pnl;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
  };

  for (const ts of timeline) {
    for (const symbol of SYMBOLS) {
      const d = symbolData[symbol];
      if (!d) continue;
      const i = d.tsIndex.get(ts);
      if (i === undefined || i < EMA_PERIOD + 10 || i >= d.bars.length - 1) continue;

      const price    = d.bars[i].c;
      const low      = d.bars[i].l;
      const high     = d.bars[i].h;
      const aboveEma = price > d.ema[i];
      const bullFlip = d.ut[i-1].direction === -1 && d.ut[i].direction === 1;
      const bearFlip = d.ut[i-1].direction ===  1 && d.ut[i].direction === -1;
      const stopDist = KEY_VALUE * d.atr[i];
      const pos      = positions[symbol];

      if (pos) {
        if (pos.side === 'long') {
          const slHit = low <= pos.sl;
          if (slHit || bearFlip || !aboveEma) {
            record(symbol, 'long', pos.entry, slHit ? pos.sl : price, pos.qty, ts);
            delete positions[symbol];
          }
        } else {
          const slHit = high >= pos.sl;
          if (slHit || bullFlip || aboveEma) {
            record(symbol, 'short', pos.entry, slHit ? pos.sl : price, pos.qty, ts);
            delete positions[symbol];
          }
        }
        continue;
      }

      if (stopDist <= 0) continue;
      const qty = Math.floor(Math.min(
        (equity * RISK_PCT) / stopDist,
        (equity * NOTIONAL_PCT) / price,
        MAX_NOTIONAL / price,
      ));
      if (qty <= 0) continue;

      if (bullFlip && aboveEma && d.rsi[i] < 70) {
        positions[symbol] = { side: 'long', entry: price, qty, sl: price - stopDist };
      } else if (bearFlip && !aboveEma && d.rsi[i] > 30) {
        positions[symbol] = { side: 'short', entry: price, qty, sl: price + stopDist };
      }
    }
  }

  // Close remaining positions at last price
  for (const [symbol, pos] of Object.entries(positions)) {
    const d = symbolData[symbol];
    const last = d.bars[d.bars.length - 1];
    record(symbol, pos.side, pos.entry, last.c, pos.qty, last.t);
  }

  return { equity, closedTrades, monthlyPnl, maxDrawdown };
}

// ── Report ───────────────────────────────────────────────────────────────────

function report({ equity, closedTrades, monthlyPnl, maxDrawdown }) {
  const fmt = n => (n >= 0 ? `+$${n.toFixed(0)}` : `-$${Math.abs(n).toFixed(0)}`);
  const wins = closedTrades.filter(t => t.pnl > 0);
  const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = closedTrades.filter(t => t.pnl <= 0).reduce((s, t) => s - t.pnl, 0);

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  PORTFOLIO RESULT — all symbols, shared $100k account');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  Final equity:    $${equity.toFixed(0)}  (${fmt(equity - START_EQUITY)})`);
  console.log(`  Total return:    ${(((equity / START_EQUITY) - 1) * 100).toFixed(1)}%`);
  console.log(`  Trades:          ${closedTrades.length}`);
  console.log(`  Win rate:        ${closedTrades.length ? ((wins.length / closedTrades.length) * 100).toFixed(0) : 0}%`);
  console.log(`  Profit factor:   ${grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : '∞'}`);
  console.log(`  Avg win:         ${wins.length ? fmt(grossWin / wins.length) : 'N/A'}`);
  const losses = closedTrades.length - wins.length;
  console.log(`  Avg loss:        ${losses ? fmt(-grossLoss / losses) : 'N/A'}`);
  console.log(`  Max drawdown:    ${(maxDrawdown * 100).toFixed(1)}%`);

  console.log('\n  Monthly P&L:');
  const months = Object.keys(monthlyPnl).sort();
  let above10k = 0;
  for (const m of months) {
    const p = monthlyPnl[m];
    if (p >= 10_000) above10k++;
    const bar = '█'.repeat(Math.min(40, Math.round(Math.abs(p) / 500)));
    console.log(`    ${m}  ${fmt(p).padStart(9)}  ${p >= 0 ? bar : '▒' + bar}`);
  }
  const avgMonth = months.length ? (equity - START_EQUITY) / months.length : 0;
  console.log(`\n  Avg month: ${fmt(avgMonth)} | Months ≥ +$10k: ${above10k}/${months.length}`);

  // Per-symbol breakdown
  console.log('\n  Per-symbol:');
  for (const s of SYMBOLS) {
    const trades = closedTrades.filter(t => t.symbol === s);
    if (!trades.length) { console.log(`    ${s.padEnd(6)} no trades`); continue; }
    const pnl = trades.reduce((sum, t) => sum + t.pnl, 0);
    const w   = trades.filter(t => t.pnl > 0).length;
    console.log(`    ${s.padEnd(6)} ${String(trades.length).padStart(3)} trades  ${((w/trades.length)*100).toFixed(0).padStart(3)}% win  ${fmt(pnl).padStart(9)}`);
  }
  console.log('');
}

(async () => {
  console.log(`Fetching ${YEARS_BACK}y of 1H bars (IEX feed) and simulating stockBot on $${START_EQUITY.toLocaleString()}...\n`);
  const symbolData = {};
  for (let i = 0; i < SYMBOLS.length; i++) {
    if (i > 0) await sleep(3000);
    const sym = SYMBOLS[i];
    process.stdout.write(`  Fetching ${sym}...`);
    try {
      const bars = await fetchAllBars(sym);
      if (bars.length < EMA_PERIOD + 20) { console.log(` only ${bars.length} bars — skipping`); continue; }
      console.log(` ${bars.length} bars (${bars[0].t.slice(0,10)} → ${bars[bars.length-1].t.slice(0,10)})`);
      const atr = calcATR(bars);
      symbolData[sym] = {
        bars, atr,
        ema: calcEMA(bars, EMA_PERIOD),
        rsi: calcRSI(bars),
        ut:  calcUTBot(bars, atr),
        tsIndex: new Map(bars.map((b, idx) => [b.t, idx])),
      };
    } catch (e) { console.log(` ERROR: ${e.message}`); }
  }

  if (Object.keys(symbolData).length === 0) {
    console.error('No data fetched — check API keys.');
    process.exit(1);
  }
  report(runPortfolio(symbolData));
})();
