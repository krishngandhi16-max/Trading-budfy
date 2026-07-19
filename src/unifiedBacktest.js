/**
 * Unified backtest — stocks vs crypto, same timescale, 1 year of 1H bars.
 * Fetches both asset classes in parallel. Reports which one carries returns.
 *
 * Run: node src/unifiedBacktest.js
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
const MAX_NOTIONAL = 195_000;
const START_EQUITY = 100_000;
const YEARS_BACK   = 1;

const STOCKS = ['NVDA', 'AMD', 'TSLA', 'MSFT', 'META'];
const CRYPTO  = ['BTC/USD', 'ETH/USD', 'SOL/USD', 'AVAX/USD'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchBars(symbol, type) {
  const end = new Date();
  const start = new Date(end.getTime() - YEARS_BACK * 365 * 24 * 60 * 60 * 1000);
  const allBars = [];

  if (type === 'crypto') {
    let nextToken = null;
    let page = 0;
    while (true) {
      if (page > 0) await sleep(500);
      let url = `https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(symbol)}` +
                `&timeframe=1H&start=${start.toISOString()}&end=${end.toISOString()}` +
                `&limit=1000&sort=asc`;
      if (nextToken) url += `&page_token=${encodeURIComponent(nextToken)}`;
      const res = await fetch(url, {
        headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 100)}`);
      const data = await res.json();
      const bars = data.bars?.[symbol] ?? [];
      allBars.push(...bars);
      nextToken = data.next_page_token;
      page++;
      if (!nextToken || !bars.length) break;
    }
  } else {
    let nextToken = null;
    let page = 0;
    while (true) {
      if (page > 0) await sleep(500);
      let url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbol}` +
                `&timeframe=1Hour&start=${start.toISOString()}&end=${end.toISOString()}` +
                `&limit=1000&adjustment=split&feed=iex&sort=asc`;
      if (nextToken) url += `&page_token=${encodeURIComponent(nextToken)}`;
      const res = await fetch(url, {
        headers: { 'APCA-API-KEY-ID': ALPACA_KEY, 'APCA-API-SECRET-KEY': ALPACA_SECRET },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 100)}`);
      const data = await res.json();
      const bars = data.bars?.[symbol] ?? [];
      allBars.push(...bars);
      nextToken = data.next_page_token;
      page++;
      if (!nextToken || !bars.length) break;
    }
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
    if (i === 0) newTrail = src - nLoss;
    else {
      const pt = results[i-1].trailStop, ps = bars[i-1].c;
      if (src > pt && ps > pt) newTrail = Math.max(pt, src - nLoss);
      else if (src < pt && ps < pt) newTrail = Math.min(pt, src + nLoss);
      else if (src > pt) newTrail = src - nLoss;
      else newTrail = src + nLoss;
    }
    const prevDir = i === 0 ? dir : results[i-1].direction;
    if (i > 0) {
      const ps = bars[i-1].c, pt = results[i-1].trailStop;
      if (ps <= pt && src > newTrail) dir = 1;
      else if (ps >= pt && src < newTrail) dir = -1;
      else dir = prevDir;
    }
    results.push({ direction: dir, trailStop: newTrail });
  }
  return results;
}

function runPortfolio(symbolData, isStocks) {
  const tsSet = new Set();
  for (const d of Object.values(symbolData)) {
    if (!d) continue;
    for (const b of d.bars) tsSet.add(b.t);
  }
  const timeline = [...tsSet].sort();

  let equity = START_EQUITY;
  const positions = {};
  const closedTrades = [];
  let peakEquity = equity, maxDD = 0;

  const record = (symbol, side, entry, exit, qty, pnl) => {
    equity += pnl;
    closedTrades.push({ symbol, side, entry, exit, qty, pnl });
    peakEquity = Math.max(peakEquity, equity);
    maxDD = Math.max(maxDD, (peakEquity - equity) / peakEquity);
  };

  for (const ts of timeline) {
    for (const symbol of Object.keys(symbolData)) {
      const d = symbolData[symbol];
      if (!d) continue;
      const i = d.idx.get(ts);
      if (i === undefined || i < EMA_PERIOD + 10 || i >= d.bars.length - 1) continue;

      const price = d.bars[i].c, lo = d.bars[i].l, hi = d.bars[i].h;
      const aboveEma = price > d.ema[i];
      const bullFlip = d.ut[i-1].direction === -1 && d.ut[i].direction === 1;
      const bearFlip = d.ut[i-1].direction === 1 && d.ut[i].direction === -1;
      const stopDist = KEY_VALUE * d.atr[i];
      const pos = positions[symbol];

      if (pos) {
        if (pos.side === 'long') {
          if (lo <= pos.sl || bearFlip || !aboveEma) {
            const exit = lo <= pos.sl ? pos.sl : price;
            const pnl  = (exit - pos.entry) * pos.qty;
            record(symbol, 'long', pos.entry, exit, pos.qty, pnl);
            delete positions[symbol];
          }
        } else {
          if (hi >= pos.sl || bullFlip || aboveEma) {
            const exit = hi >= pos.sl ? pos.sl : price;
            const pnl  = (pos.entry - exit) * pos.qty;
            record(symbol, 'short', pos.entry, exit, pos.qty, pnl);
            delete positions[symbol];
          }
        }
        continue;
      }

      if (stopDist <= 0) continue;
      const qty = Math.floor(Math.min((equity * RISK_PCT) / stopDist, (equity * 0.25) / price, MAX_NOTIONAL / price));
      if (qty <= 0) continue;

      if (isStocks) {
        if (bullFlip && aboveEma && d.rsi[i] < 70) positions[symbol] = { side: 'long', entry: price, qty, sl: price - stopDist };
        else if (bearFlip && !aboveEma && d.rsi[i] > 30) positions[symbol] = { side: 'short', entry: price, qty, sl: price + stopDist };
      } else {
        if (bullFlip && aboveEma) positions[symbol] = { side: 'long', entry: price, qty, sl: price - stopDist };
      }
    }
  }

  for (const [symbol, pos] of Object.entries(positions)) {
    const d = symbolData[symbol];
    const last = d.bars[d.bars.length - 1];
    const pnl = pos.side === 'long' ? (last.c - pos.entry) * pos.qty : (pos.entry - last.c) * pos.qty;
    record(symbol, pos.side, pos.entry, last.c, pos.qty, pnl);
  }

  return { equity, closedTrades, maxDD };
}

function fmt(n) { return (n >= 0 ? `+$${n.toFixed(0)}` : `-$${Math.abs(n).toFixed(0)}`).padStart(11); }

(async () => {
  console.log(`Fetching ${YEARS_BACK}y of 1H bars (parallel fetch)...\n`);

  const fetchAll = async (symbols, type) => {
    const result = {};
    for (const sym of symbols) {
      process.stdout.write(`  ${type.padEnd(6)} ${sym.padEnd(8)}`);
      try {
        const bars = await fetchBars(sym, type);
        if (bars.length < EMA_PERIOD + 20) {
          console.log(` only ${bars.length} bars — skipping`);
          continue;
        }
        const atr = calcATR(bars);
        result[sym] = {
          bars, atr,
          ema: calcEMA(bars, EMA_PERIOD),
          rsi: type === 'stocks' ? calcRSI(bars) : new Array(bars.length).fill(50),
          ut: calcUTBot(bars, atr),
          idx: new Map(bars.map((b, i) => [b.t, i])),
        };
        console.log(` ✓ ${bars.length} bars`);
      } catch (e) { console.log(` ✗ ${e.message}`); }
    }
    return result;
  };

  const [stocks, crypto] = await Promise.all([
    fetchAll(STOCKS, 'stocks'),
    fetchAll(CRYPTO, 'crypto'),
  ]);

  if (!Object.keys(stocks).length || !Object.keys(crypto).length) {
    console.error('No data — check API keys');
    process.exit(1);
  }

  const sRes = runPortfolio(stocks, true);
  const cRes = runPortfolio(crypto, false);

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  STOCKS (5 names, RSI filter)              CRYPTO (4 names)');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`  Final equity:  $${sRes.equity.toFixed(0).padStart(9)}    Final equity:  $${cRes.equity.toFixed(0).padStart(9)}`);
  console.log(`  Return:        ${(((sRes.equity / START_EQUITY) - 1) * 100).toFixed(1).padStart(6)}%    Return:        ${(((cRes.equity / START_EQUITY) - 1) * 100).toFixed(1).padStart(6)}%`);
  console.log(`  Trades:        ${String(sRes.closedTrades.length).padStart(9)}    Trades:        ${String(cRes.closedTrades.length).padStart(9)}`);
  const sWr = sRes.closedTrades.length ? ((sRes.closedTrades.filter(t => t.pnl > 0).length / sRes.closedTrades.length) * 100).toFixed(0) : 0;
  const cWr = cRes.closedTrades.length ? ((cRes.closedTrades.filter(t => t.pnl > 0).length / cRes.closedTrades.length) * 100).toFixed(0) : 0;
  console.log(`  Win rate:      ${String(sWr).padStart(3)}%         Win rate:      ${String(cWr).padStart(3)}%`);
  console.log(`  Max drawdown:  ${(sRes.maxDD * 100).toFixed(1).padStart(5)}%       Max drawdown:  ${(cRes.maxDD * 100).toFixed(1).padStart(5)}%`);
  console.log('════════════════════════════════════════════════════════════════');

  const combined = START_EQUITY * 2;
  const combinedEq = sRes.equity + cRes.equity - START_EQUITY;
  console.log(`\n  If trading BOTH ($${(combined / 1000).toFixed(0)}k split): $${combinedEq.toFixed(0)} final`);
  console.log(`  Combined return: ${(((combinedEq / combined) - 1) * 100).toFixed(1)}%`);
})();
