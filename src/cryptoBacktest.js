/**
 * UT Bot + EMA100 backtest using Alpaca crypto data
 * Run: node src/cryptoBacktest.js
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
const MA200        = 200;
const RISK_PCT     = 0.01;
const MAX_NOTIONAL = 195_000;
const SYMBOLS      = ['BTC/USD', 'ETH/USD', 'SOL/USD'];

async function fetchAllBars(symbol) {
  const sym   = encodeURIComponent(symbol);
  const end   = new Date();
  const start = new Date(end.getTime() - 4 * 365 * 24 * 60 * 60 * 1000);
  const allBars = [];
  let nextToken = null;

  while (true) {
    let url = `https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=${sym}` +
              `&timeframe=1H&start=${start.toISOString()}&end=${end.toISOString()}` +
              `&limit=1000&sort=asc`;
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
    if (!nextToken || bars.length === 0) break;
  }
  return allBars;
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
  const ema = new Array(bars.length).fill(0);
  ema[0] = bars[0].c;
  for (let i = 1; i < bars.length; i++) ema[i] = bars[i].c * k + ema[i-1] * (1 - k);
  return ema;
}

function calcUTBot(bars, atr) {
  const results = [];
  let dir = 1;
  for (let i = 0; i < bars.length; i++) {
    const src = bars[i].c, atrVal = atr[i] > 0 ? atr[i] : (bars[i].h - bars[i].l);
    const nLoss = KEY_VALUE * atrVal;
    let newTrail;
    if (i === 0) { newTrail = src - nLoss; }
    else {
      const pt = results[i-1].trailStop, ps = bars[i-1].c;
      if (src > pt && ps > pt)      newTrail = Math.max(pt, src - nLoss);
      else if (src < pt && ps < pt) newTrail = Math.min(pt, src + nLoss);
      else if (src > pt)            newTrail = src - nLoss;
      else                          newTrail = src + nLoss;
    }
    const prevDir = i === 0 ? dir : results[i-1].direction;
    if (i > 0) {
      const ps = bars[i-1].c;
      if      (ps <= results[i-1].trailStop && src > newTrail) dir = 1;
      else if (ps >= results[i-1].trailStop && src < newTrail) dir = -1;
      else                                                      dir = prevDir;
    }
    results.push({ direction: dir, trailStop: newTrail });
  }
  return results;
}

function classify(price, sma, prevSma) {
  if (price > sma && sma > prevSma) return 'bull';
  if (price < sma && sma < prevSma) return 'bear';
  return 'sideways';
}

function backtest(bars) {
  const atr   = calcATR(bars);
  const ema   = calcEMA(bars, EMA_PERIOD);
  const sma   = calcEMA(bars, MA200);
  const utbot = calcUTBot(bars, atr);

  const mkStat = () => ({ trades: 0, wins: 0, pnl: 0, grossWin: 0, grossLoss: 0 });
  const stats  = { bull: mkStat(), bear: mkStat(), sideways: mkStat() };
  let equity   = 100_000;
  let pos      = null;

  for (let i = MA200 + 1; i < bars.length - 1; i++) {
    const price    = bars[i].c;
    const aboveEma = price > ema[i];
    const bullFlip = utbot[i-1].direction === -1 && utbot[i].direction === 1;
    const bearFlip = utbot[i-1].direction === 1  && utbot[i].direction === -1;
    const stopDist = KEY_VALUE * atr[i];
    const cond     = classify(price, sma[i], sma[i-1]);

    if (pos) {
      const exit = bearFlip || !aboveEma || price <= pos.sl;
      if (exit) {
        const exitPrice = price <= pos.sl ? pos.sl : price;
        const pnl = (exitPrice - pos.entry) * pos.qty;
        const s   = stats[pos.cond];
        s.trades++; s.pnl += pnl;
        if (pnl > 0) { s.wins++; s.grossWin += pnl; } else { s.grossLoss += Math.abs(pnl); }
        equity += pnl;
        pos = null;
      }
    }

    if (!pos && bullFlip && aboveEma && stopDist > 0) {
      const qty = Math.min((equity * RISK_PCT) / stopDist, (equity * 0.25) / price, MAX_NOTIONAL / price);
      pos = { entry: price, qty, sl: price - stopDist, cond };
    }
  }

  // close open position at end
  if (pos) {
    const pnl = (bars[bars.length-1].c - pos.entry) * pos.qty;
    const s   = stats[pos.cond];
    s.trades++; s.pnl += pnl;
    if (pnl > 0) { s.wins++; s.grossWin += pnl; } else { s.grossLoss += Math.abs(pnl); }
  }

  return stats;
}

function print(symbol, stats, bars) {
  const all = { trades:0, wins:0, pnl:0, grossWin:0, grossLoss:0 };
  for (const s of Object.values(stats)) {
    all.trades += s.trades; all.wins += s.wins; all.pnl += s.pnl;
    all.grossWin += s.grossWin; all.grossLoss += s.grossLoss;
  }
  const wr  = s => s.trades ? `${((s.wins/s.trades)*100).toFixed(0)}%` : 'N/A';
  const pfv = s => s.grossLoss === 0 ? (s.grossWin > 0 ? '∞' : 'N/A') : (s.grossWin/s.grossLoss).toFixed(2);
  const fmt = n => (n >= 0 ? `+$${n.toFixed(0)}` : `-$${Math.abs(n).toFixed(0)}`).padStart(10);
  const dateRange = `${bars[0].t.slice(0,10)} → ${bars[bars.length-1].t.slice(0,10)}`;

  console.log(`\n════════════════════════════════════════════════`);
  console.log(`  ${symbol}  (${bars.length} bars, ${dateRange})`);
  console.log(`════════════════════════════════════════════════`);
  console.log(`  Condition  │ Trades │  Win%  │     PnL    │   PF`);
  console.log(`─────────────┼────────┼────────┼────────────┼──────`);
  for (const [c, s] of Object.entries(stats))
    console.log(`  ${c.padEnd(11)}│  ${String(s.trades).padStart(4)}  │  ${wr(s).padStart(4)}  │${fmt(s.pnl)} │ ${pfv(s)}`);
  console.log(`─────────────┼────────┼────────┼────────────┼──────`);
  console.log(`  TOTAL      │  ${String(all.trades).padStart(4)}  │  ${wr(all).padStart(4)}  │${fmt(all.pnl)} │ ${pfv(all)}`);
  console.log(`  Starting equity: $100,000 | Risk: 1%/trade | Long-only`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('Fetching Alpaca bars and running UT Bot + EMA100 backtest...\n');
  for (let i = 0; i < SYMBOLS.length; i++) {
    if (i > 0) { process.stdout.write('  Waiting 10s to avoid rate limit...'); await sleep(10_000); console.log(' done'); }
    const sym = SYMBOLS[i];
    process.stdout.write(`  Fetching ${sym}...`);
    try {
      const bars = await fetchAllBars(sym);
      if (bars.length < MA200 + 10) { console.log(` only ${bars.length} bars — skipping`); continue; }
      console.log(` ${bars.length} bars`);
      print(sym, backtest(bars), bars);
    } catch (e) { console.log(` ERROR: ${e.message}`); }
  }
})();
