/**
 * S&P 500 strategy scanner.
 *
 * Every ~4 minutes during US regular hours it:
 *   1. batch-fetches 5-minute + daily bars for all S&P 500 symbols (Alpaca data),
 *   2. runs all three strategies on each symbol,
 *   3. for every fresh signal, sizes the trade to a FIXED $500 risk and places a
 *      strategy-tagged Alpaca paper BRACKET order (entry + TP + SL),
 *   4. records the trade and an activity-feed event.
 *
 * Guards against double-entries (same strategy+symbol already active) and against
 * conflicting broker positions (the 3 books share one Alpaca account).
 */

const fs   = require('fs');
const path = require('path');

const alpaca = require('./brokers/alpaca');
const store  = require('./store');
const { isMarketOpen } = require('./marketHours');

const liquiditySweep = require('./strategies/liquiditySweep');
const volumeProfile  = require('./strategies/volumeProfile');
const master         = require('./strategies/master');

const STRATEGY_MODULES = [liquiditySweep, volumeProfile, master];

const SP500 = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../data/sp500.json'), 'utf8')
);

// ── helpers ───────────────────────────────────────────────────────────────────

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

/** Fixed-$risk share sizing. Returns whole shares (>=0). */
function sizeByRisk(entryPrice, stopLoss) {
  const perShare = Math.abs(entryPrice - stopLoss);
  if (!(perShare > 0)) return 0;
  return Math.floor(store.RISK_PER_TRADE / perShare);
}

// ── one scan pass ─────────────────────────────────────────────────────────────

async function runScanOnce({ force = false } = {}) {
  if (!alpaca.hasKeys()) {
    store.addActivity({ kind: 'error', message: 'No Alpaca API keys set — scanner cannot fetch data. Add ALPACA_API_KEY / ALPACA_API_SECRET in Secrets.' });
    return { ran: false, reason: 'no_keys' };
  }
  if (!force && !isMarketOpen()) {
    return { ran: false, reason: 'market_closed' };
  }

  const started = Date.now();
  // Enough 5-minute history for a 400-bar volume profile (~5 RTH days) plus buffer.
  const bars5mBySym  = await alpaca.getBars(SP500, '5Min', { start: isoDaysAgo(12), limit: 1000 });
  const barsDayBySym = await alpaca.getBars(SP500, '1Day', { start: isoDaysAgo(8),  limit: 20 });

  // Broker positions once per pass (shared-account conflict guard).
  let brokerPositions = [];
  try { brokerPositions = await alpaca.getPositions(); } catch { /* mock / disabled */ }
  const posByKey = new Map(brokerPositions.map((p) => [alpaca.normaliseKey(p.symbol), p]));

  const signals = [];
  for (const symbol of SP500) {
    const bars5m  = bars5mBySym[symbol];
    const barsDay = barsDayBySym[symbol];
    if (!bars5m || bars5m.length < 30 || !barsDay || barsDay.length < 2) continue;

    for (const mod of STRATEGY_MODULES) {
      let setup;
      try { setup = mod.evaluate(symbol, bars5m, barsDay); }
      catch (err) { console.warn(`[scanner] ${mod.NAME} ${symbol} threw: ${err.message}`); continue; }
      if (setup) signals.push(setup);
    }
  }

  const placed = [];
  for (const sig of signals) {
    const result = await tryPlace(sig, posByKey);
    if (result) placed.push(result);
  }

  // Resolve counterfactuals for trades we closed early, using the same bars.
  resolveWhatIfs(bars5mBySym);

  const summary = {
    ran: true,
    scanned: SP500.length,
    withData: Object.keys(bars5mBySym).length,
    signals: signals.length,
    placed: placed.length,
    ms: Date.now() - started,
  };
  store.addActivity({
    kind: 'info',
    message: `Scan complete — ${summary.withData}/${summary.scanned} symbols had data, ${summary.signals} signals, ${summary.placed} orders placed`,
    data: summary,
  });
  return summary;
}

// ── place a single signal ─────────────────────────────────────────────────────

async function tryPlace(sig, posByKey) {
  const { strategy, symbol, direction, entryType, entryPrice, stopLoss, takeProfit } = sig;

  // Guard 1: already have an active trade for this strategy+symbol.
  if (store.hasActiveTrade(strategy, symbol)) {
    return null; // silent — avoids feed spam every scan while a trade is live
  }

  // Guard 2: conflicting broker position (books share one Alpaca account).
  const existing = posByKey.get(alpaca.normaliseKey(symbol));
  if (existing && existing.direction !== direction) {
    store.addActivity({
      strategy, symbol, kind: 'skip',
      message: `Skipped ${direction.toUpperCase()} ${symbol} (${label(strategy)}) — account already ${existing.direction} ${symbol} from another strategy`,
    });
    return null;
  }

  // Size to fixed $500 risk.
  const qty = sizeByRisk(entryPrice, stopLoss);
  if (qty < 1) {
    store.addActivity({
      strategy, symbol, kind: 'skip',
      message: `Skipped ${symbol} (${label(strategy)}) — risk/share too large for $${store.RISK_PER_TRADE} (needs <1 share)`,
    });
    return null;
  }

  const side          = direction === 'long' ? 'buy' : 'sell';
  const clientOrderId = `${strategy}__${symbol}__${Date.now()}`;

  let order;
  try {
    order = await alpaca.submitBracketOrder({
      symbol, side, qty, entryType,
      limitPrice: entryType === 'limit' ? entryPrice : undefined,
      takeProfit, stopLoss, clientOrderId,
    });
  } catch (err) {
    store.addActivity({
      strategy, symbol, kind: 'error',
      message: `Order REJECTED ${symbol} (${label(strategy)}): ${err.message}`,
    });
    return null;
  }

  const trade = store.addTrade({
    strategy, symbol, direction, entryType,
    entryPrice, stopLoss, takeProfit, quantity: qty,
    riskAmount: store.RISK_PER_TRADE,
    clientOrderId,
    brokerOrderId: order && order.id ? order.id : null,
    status: 'pending',
    meta: sig.meta,
  });

  const verb = direction === 'long' ? 'BUY' : 'SELL';
  const mock = order && order.mocked ? ' [MOCK]' : '';
  store.addActivity({
    strategy, symbol, kind: 'entry',
    message: `${verb} ${qty} ${symbol} (${label(strategy)})${mock} — entry ${entryPrice}, stop ${stopLoss}, target ${takeProfit}`,
    data: { clientOrderId, qty, entryType, entryPrice, stopLoss, takeProfit, meta: sig.meta },
  });

  return trade;
}

function label(strategy) {
  return {
    liquidity_sweep: 'Liquidity Sweep',
    volume_profile:  'Volume Profile',
    master:          'Master',
  }[strategy] || strategy;
}

// ── what-if resolver ───────────────────────────────────────────────────────────
// For each early-closed trade still "watching", scan the bars AFTER we closed it
// to see whether its original TP or SL would have been hit first. Resolves to the
// hypothetical P&L so the UI can show "you closed for X, it would've done Y".
// Gives up (resolves at last price) after 3 calendar days so watches don't linger.

function resolveWhatIfs(barsBySym) {
  const watching = store.getWhatIfWatching();
  for (const t of watching) {
    const bars = barsBySym[t.symbol];
    if (!bars || !bars.length) continue;

    const from     = new Date(t.whatIf.watchFrom).getTime();
    const after    = bars.filter((b) => new Date(b.time).getTime() > from);
    if (!after.length) continue;

    const entry = t.fillPrice ?? t.entryPrice;
    const dir   = t.direction === 'long' ? 1 : -1;
    const tp    = t.takeProfit;
    const sl    = t.stopLoss;

    let outcome = null, exit = null;
    for (const b of after) {
      const hitTP = t.direction === 'long' ? b.high >= tp : b.low <= tp;
      const hitSL = t.direction === 'long' ? b.low <= sl : b.high >= sl;
      if (hitTP && hitSL) { outcome = 'sl'; exit = sl; break; }   // pessimistic: assume stop first
      if (hitTP)          { outcome = 'tp'; exit = tp; break; }
      if (hitSL)          { outcome = 'sl'; exit = sl; break; }
    }

    if (outcome) {
      const pl = (exit - entry) * t.quantity * dir;
      store.resolveWhatIf(t.id, outcome, pl);
      store.addActivity({
        strategy: t.strategy, symbol: t.symbol, kind: 'info',
        message: `WHAT-IF ${t.symbol} (${label(t.strategy)}): if held, would have ${outcome === 'tp' ? 'HIT TARGET' : 'STOPPED OUT'} for ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)} (you booked ${t.realizedPl >= 0 ? '+' : ''}$${t.realizedPl})`,
      });
      continue;
    }

    // Give up after 3 days → resolve at the last available close.
    if (Date.now() - from > 3 * 86400_000) {
      const last = after[after.length - 1].close;
      const pl = (last - entry) * t.quantity * dir;
      store.resolveWhatIf(t.id, 'expired', pl);
    }
  }
}

// ── interval driver ────────────────────────────────────────────────────────────

let timer = null;
function startScanner(intervalMs = 4 * 60 * 1000) {
  if (timer) return;
  const tick = async () => {
    try { await runScanOnce(); }
    catch (err) { console.error('[scanner] pass failed:', err.message); }
  };
  tick();                              // run immediately on boot
  timer = setInterval(tick, intervalMs);
  console.log(`[scanner] started — scanning ${SP500.length} symbols every ${Math.round(intervalMs / 1000)}s`);
}
function stopScanner() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { runScanOnce, startScanner, stopScanner, sizeByRisk, SP500 };
