/**
 * Reconciler — turns Alpaca order/position state into our trade records.
 *
 * Runs every ~1 minute:
 *   - pending → open   when the entry (parent) order fills
 *   - open → closed    when the TP or SL bracket leg fills (realized PnL)
 *   - pending → canceled when a day bracket expires/cancels unfilled
 *   - refreshes unrealized PnL on all open trades from live prices
 *
 * In mock mode (no keys / BROKER_ENABLED != 'true') Alpaca returns nothing, so
 * this is a no-op and pending trades simply stay pending — the UI shows MOCK MODE.
 */

const alpaca = require('./brokers/alpaca');
const store  = require('./store');
const { maybeFlatten } = require('./eodFlatten');

function label(strategy) {
  return {
    liquidity_sweep: 'Liquidity Sweep',
    volume_profile:  'Volume Profile',
    master:          'Master',
  }[strategy] || strategy;
}

async function reconcileOnce() {
  if (!alpaca.isEnabled()) return { ran: false, reason: 'broker_disabled' };

  // End-of-day flatten runs first (once, inside the 15:55–16:00 ET window).
  try { await maybeFlatten(); } catch (e) { console.warn('[reconcile] eod flatten:', e.message); }

  let orders = [], positions = [];
  try { orders = await alpaca.listOrders('all', 500); } catch (e) { console.warn('[reconcile] listOrders:', e.message); }
  try { positions = await alpaca.getPositions(); } catch (e) { console.warn('[reconcile] getPositions:', e.message); }

  const orderByClient = new Map();
  for (const o of orders) if (o.client_order_id) orderByClient.set(o.client_order_id, o);
  const posByKey = new Map(positions.map((p) => [alpaca.normaliseKey(p.symbol), p]));

  const open = store.getOpenTrades();
  let changed = 0;

  for (const t of open) {
    const order = orderByClient.get(t.clientOrderId);

    // ── Handle entry fill / cancellation ──────────────────────────────────────
    if (t.status === 'pending') {
      if (!order) continue;
      if (order.status === 'filled') {
        store.updateTrade(t.id, {
          status: 'open',
          fillPrice: num(order.filled_avg_price) ?? t.entryPrice,
          filledAt: order.filled_at || new Date().toISOString(),
          brokerOrderId: order.id,
        });
        store.addActivity({
          strategy: t.strategy, symbol: t.symbol, kind: 'fill',
          message: `FILLED ${t.direction === 'long' ? 'BUY' : 'SELL'} ${t.quantity} ${t.symbol} (${label(t.strategy)}) @ ${num(order.filled_avg_price) ?? t.entryPrice}`,
        });
        changed++;
        continue;
      }
      if (['canceled', 'expired', 'rejected', 'done_for_day'].includes(order.status) && num(order.filled_qty) === 0) {
        store.updateTrade(t.id, { status: 'canceled', closedAt: new Date().toISOString(), closeReason: order.status });
        store.addActivity({
          strategy: t.strategy, symbol: t.symbol, kind: 'skip',
          message: `Order ${order.status} (unfilled) ${t.symbol} (${label(t.strategy)}) — limit never hit`,
        });
        changed++;
        continue;
      }
      continue; // still working
    }

    // ── Handle exit (open trade) ──────────────────────────────────────────────
    if (t.status === 'open') {
      const entryFill = t.fillPrice ?? t.entryPrice;
      const legs = (order && order.legs) || [];
      const filledLeg = legs.find((l) => l.status === 'filled');

      if (filledLeg) {
        const exitFill = num(filledLeg.filled_avg_price) ?? num(filledLeg.limit_price) ?? num(filledLeg.stop_price);
        const reason   = filledLeg.type === 'limit' ? 'tp' : 'sl';
        const dir      = t.direction === 'long' ? 1 : -1;
        const realized = round2((exitFill - entryFill) * t.quantity * dir);
        store.updateTrade(t.id, {
          status: 'closed', realizedPl: realized, unrealizedPl: 0,
          closeReason: reason, closedAt: filledLeg.filled_at || new Date().toISOString(),
          exitPrice: exitFill,
        });
        store.addActivity({
          strategy: t.strategy, symbol: t.symbol, kind: reason,
          message: `${reason === 'tp' ? 'TARGET HIT ✅' : 'STOPPED OUT ❌'} ${t.symbol} (${label(t.strategy)}) @ ${exitFill} — ${realized >= 0 ? '+' : ''}$${realized}`,
          data: { realized, reason },
        });
        changed++;
        continue;
      }

      const pos = posByKey.get(alpaca.normaliseKey(t.symbol));

      // Self-heal: the broker shows NO position for this symbol at all, but we
      // still have it marked 'open'. This happens if it was closed by something
      // our leg-detection above didn't catch — a manual close in Alpaca's UI,
      // the flatten button, EOD flatten, or a request that got interrupted
      // mid-write. Without this, the dashboard would show a trade as open
      // forever after the broker has already closed it. Find the most recent
      // FILLED order on the opposite side to recover the real exit price.
      if (!pos) {
        const closingSide = t.direction === 'long' ? 'sell' : 'buy';
        const candidates = orders
          .filter((o) => o.symbol === t.symbol && o.side === closingSide && o.status === 'filled')
          .sort((a, b) => new Date(b.filled_at) - new Date(a.filled_at));
        const fill = candidates[0];
        const exitFill = fill ? (num(fill.filled_avg_price) ?? entryFill) : entryFill;
        const dir = t.direction === 'long' ? 1 : -1;
        const realized = round2((exitFill - entryFill) * t.quantity * dir);
        store.updateTrade(t.id, {
          status: 'closed', realizedPl: realized, unrealizedPl: 0,
          closeReason: fill ? 'closed_externally' : 'closed_unreconciled',
          closedAt: (fill && fill.filled_at) || new Date().toISOString(),
          exitPrice: exitFill,
        });
        store.addActivity({
          strategy: t.strategy, symbol: t.symbol, kind: realized >= 0 ? 'tp' : 'sl',
          message: `${fill ? 'Position closed' : 'Position vanished (no matching fill found)'} ${t.symbol} (${label(t.strategy)}) @ ${exitFill} — ${realized >= 0 ? '+' : ''}$${realized}`,
          data: { realized, source: fill ? 'matched_fill' : 'fallback' },
        });
        changed++;
        continue;
      }

      // Still open → refresh unrealized PnL from the live position price.
      const cur = pos.raw ? num(pos.raw.current_price) : null;
      if (cur != null) {
        const dir = t.direction === 'long' ? 1 : -1;
        const upl = round2((cur - entryFill) * t.quantity * dir);
        if (upl !== t.unrealizedPl) { store.updateTrade(t.id, { unrealizedPl: upl }); changed++; }
      }
    }
  }

  return { ran: true, open: open.length, changed };
}

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function round2(n) { return parseFloat(Number(n).toFixed(2)); }

// ── interval driver ────────────────────────────────────────────────────────────

let timer = null;
function startReconciler(intervalMs = 60 * 1000) {
  if (timer) return;
  const tick = async () => {
    try { await reconcileOnce(); }
    catch (err) { console.error('[reconcile] pass failed:', err.message); }
  };
  tick();
  timer = setInterval(tick, intervalMs);
  console.log(`[reconcile] started — every ${Math.round(intervalMs / 1000)}s`);
}
function stopReconciler() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { reconcileOnce, startReconciler, stopReconciler };
