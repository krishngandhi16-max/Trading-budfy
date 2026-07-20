/**
 * End-of-day flatten for the Strategy Lab.
 *
 * At 15:55 ET (2:55 PM Central) every trading day it closes ALL open
 * strategy-lab stock positions and cancels any resting entry orders, so the
 * account is flat before the 16:00 ET (3:00 PM Central) close — no overnight
 * risk, no positions left unprotected.
 *
 * Scope: ONLY the 3 strategies' stock trades (tracked in our store). It cancels
 * open orders by SYMBOL for symbols we hold, and closes those positions. The
 * crypto bot trades different symbols (BTC/ETH/SOL), so its holdings are never
 * touched.
 */

const alpaca = require('./brokers/alpaca');
const store  = require('./store');
const { isFlattenWindow, nyDateKey } = require('./marketHours');

const LABELS = {
  liquidity_sweep: 'Liquidity Sweep',
  volume_profile:  'Volume Profile',
  master:          'Master',
};

let lastFlattenDay = null;

/** Called on every reconcile tick; runs the flatten once when the window opens. */
async function maybeFlatten() {
  if (!alpaca.isEnabled()) return { ran: false, reason: 'broker_disabled' };
  if (!isFlattenWindow())  return { ran: false, reason: 'outside_window' };
  const day = nyDateKey();
  if (lastFlattenDay === day) return { ran: false, reason: 'already_done_today' };
  lastFlattenDay = day;
  return flattenNow('eod');
}

/** Force a flatten right now (used by maybeFlatten and the manual endpoint). */
async function flattenNow(reason = 'manual') {
  const open = store.getOpenTrades();
  const filled  = open.filter((t) => t.status === 'open');
  const pending = open.filter((t) => t.status === 'pending');

  const labSymbols = new Set(open.map((t) => t.symbol.toUpperCase()));

  // 1. Cancel any resting orders for our symbols (unfilled entries + TP/SL legs).
  let orders = [];
  try { orders = await alpaca.listOrders('open', 500); } catch (e) { console.warn('[eod] listOrders:', e.message); }
  for (const o of orders) {
    if (o.symbol && labSymbols.has(o.symbol.toUpperCase())) {
      try { await alpaca.cancelOrder(o.id); } catch (e) { console.warn('[eod] cancel', o.id, e.message); }
    }
  }

  // 2. Grab live prices once (to estimate realized PnL on the close).
  let positions = [];
  try { positions = await alpaca.getPositions(); } catch (e) { console.warn('[eod] getPositions:', e.message); }
  const posByKey = new Map(positions.map((p) => [alpaca.normaliseKey(p.symbol), p]));

  // 3. Pending entries that never filled → mark canceled.
  for (const t of pending) {
    store.updateTrade(t.id, { status: 'canceled', closeReason: 'eod_unfilled', closedAt: new Date().toISOString() });
    store.addActivity({ strategy: t.strategy, symbol: t.symbol, kind: 'skip',
      message: `EOD: canceled unfilled ${t.symbol} (${LABELS[t.strategy] || t.strategy})` });
  }

  // 4. Filled positions → market-close and book realized PnL.
  let closed = 0;
  for (const t of filled) {
    const pos = posByKey.get(alpaca.normaliseKey(t.symbol));
    const entryFill = t.fillPrice ?? t.entryPrice;
    const exit = pos && pos.raw ? num(pos.raw.current_price) ?? entryFill : entryFill;

    try { await alpaca.closePosition(t.symbol, 'stocks'); }
    catch (e) { console.warn('[eod] closePosition', t.symbol, e.message); }

    const dir = t.direction === 'long' ? 1 : -1;
    const realized = round2((exit - entryFill) * t.quantity * dir);
    store.updateTrade(t.id, {
      status: 'closed', realizedPl: realized, unrealizedPl: 0,
      closeReason: reason, closedAt: new Date().toISOString(), exitPrice: exit,
    });
    store.addActivity({ strategy: t.strategy, symbol: t.symbol, kind: realized >= 0 ? 'tp' : 'sl',
      message: `EOD CLOSE ${t.symbol} (${LABELS[t.strategy] || t.strategy}) @ ~${exit} — ${realized >= 0 ? '+' : ''}$${realized}` });
    closed++;
  }

  if (closed > 0 || pending.length > 0) {
    store.addActivity({ kind: 'info',
      message: `🌙 End-of-day flatten (${reason}) — closed ${closed} position(s), canceled ${pending.length} pending. Account is flat for the night.` });
  }
  return { ran: true, closed, canceledPending: pending.length };
}

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function round2(n) { return parseFloat(Number(n).toFixed(2)); }

module.exports = { maybeFlatten, flattenNow };
