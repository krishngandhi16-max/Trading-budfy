/**
 * Phase 3 — Broker router
 *
 * Routes market orders to the correct broker by market type:
 *   stocks  → Alpaca (paper)
 *   crypto  → Alpaca (paper)
 *   forex   → Oanda  (practice)
 *   metals  → Oanda  (practice)
 *   futures → unsupported (no-op with warning)
 *
 * Also owns the FIFO guard: blocks opening a position in the opposite
 * direction if an existing same-symbol position is already open at the broker.
 */

const alpaca = require('./alpaca');
const oanda  = require('./oanda');

// ── Broker selection ──────────────────────────────────────────────────────────

const ALPACA_MARKETS = new Set(['stocks', 'crypto']);
const OANDA_MARKETS  = new Set(['forex', 'metals']);

/**
 * Return the broker module for a given market type, or null for unsupported.
 */
function brokerFor(marketType) {
  if (ALPACA_MARKETS.has(marketType)) return alpaca;
  if (OANDA_MARKETS.has(marketType))  return oanda;
  return null;
}

/**
 * Whether any broker is enabled for this market type.
 */
function isEnabled(marketType) {
  const b = brokerFor(marketType);
  return b != null && b.isEnabled();
}

// ── Symbol normalisation (shared comparison key) ──────────────────────────────

/**
 * Strip all separator chars and uppercase — used only for comparing symbols
 * across broker responses and our local records.
 * 'BTC/USD', 'BTC-USD', 'EUR_USD' all → 'BTCUSD', 'EURUSD'
 */
function normKey(symbol) {
  return symbol.toUpperCase().replace(/[/_\-]/g, '');
}

// ── FIFO guard ────────────────────────────────────────────────────────────────

/**
 * Check whether opening a new position would violate FIFO rules.
 *
 * US equity and most broker rules require that you cannot hold offsetting
 * positions in the same instrument. We enforce: if a position in the OPPOSITE
 * direction already exists at the broker, block the new order.
 *
 * The guard is a no-op when the broker is disabled (returns false immediately).
 *
 * @param {string} symbol
 * @param {string} marketType
 * @param {string} direction  'long' | 'short'
 * @returns {Promise<{ violated: boolean, reason: string }>}
 */
async function checkFifo(symbol, marketType, direction) {
  const broker = brokerFor(marketType);

  if (!broker || !broker.isEnabled()) {
    return { violated: false, reason: 'broker disabled — FIFO check skipped' };
  }

  let positions;
  try {
    positions = await broker.getPositions();
  } catch (err) {
    // If we can't reach the broker, fail safe (don't block)
    console.warn(`[BrokerRouter] FIFO check fetch failed: ${err.message}`);
    return { violated: false, reason: 'broker unreachable — FIFO check skipped' };
  }

  const key      = normKey(symbol);
  const existing = positions.find((p) => normKey(p.symbol) === key);

  if (!existing) {
    return { violated: false, reason: 'no existing position' };
  }

  if (existing.direction !== direction) {
    return {
      violated: true,
      reason:   `FIFO violation: ${symbol} already has an open ${existing.direction} position at ${broker === alpaca ? 'Alpaca' : 'Oanda'}`,
    };
  }

  return { violated: false, reason: `same-direction ${existing.direction} add-on allowed` };
}

// ── Order submission ──────────────────────────────────────────────────────────

/**
 * Submit a market order to the correct broker.
 * Runs the FIFO guard first; throws on violation.
 *
 * @param {{ symbol, marketType, direction, quantity }} params
 * @returns {Promise<Object>}  Broker order object, or { mocked, skipped } if unsupported
 */
async function submitOrder({ symbol, marketType, direction, quantity }) {
  const broker = brokerFor(marketType);

  if (!broker) {
    console.warn(`[BrokerRouter] No broker for market type '${marketType}' — order skipped`);
    return { skipped: true, reason: `unsupported market type: ${marketType}` };
  }

  // FIFO guard
  const fifo = await checkFifo(symbol, marketType, direction);
  if (fifo.violated) {
    throw new Error(fifo.reason);
  }

  try {
    const order = await broker.submitOrder({ symbol, marketType, direction, quantity });
    console.log(`[BrokerRouter] Order submitted (${marketType}→${broker === alpaca ? 'Alpaca' : 'Oanda'}):`, symbol, direction, quantity);
    return order;
  } catch (err) {
    console.error(`[BrokerRouter] submitOrder failed for ${symbol}: ${err.message}`);
    throw err;
  }
}

// ── Position close ────────────────────────────────────────────────────────────

/**
 * Close a position at the correct broker.
 * Best-effort — logs errors but does not throw.
 *
 * @param {string} symbol
 * @param {string} marketType
 * @returns {Promise<Object>}
 */
async function closePosition(symbol, marketType) {
  const broker = brokerFor(marketType);

  if (!broker) {
    return { skipped: true, reason: `unsupported market type: ${marketType}` };
  }

  try {
    const result = await broker.closePosition(symbol, marketType);
    console.log(`[BrokerRouter] Position closed at broker: ${symbol}`);
    return result;
  } catch (err) {
    console.error(`[BrokerRouter] closePosition failed for ${symbol}: ${err.message}`);
    return { error: err.message };
  }
}

// ── Position fetch (all brokers) ──────────────────────────────────────────────

/**
 * Fetch all open positions from every enabled broker.
 * Results are merged and tagged with { broker: 'alpaca' | 'oanda' }.
 *
 * @returns {Promise<Array>}
 */
async function getAllPositions() {
  const [alpacaPos, oandaPos] = await Promise.allSettled([
    alpaca.getPositions(),
    oanda.getPositions(),
  ]);

  const result = [];
  if (alpacaPos.status === 'fulfilled') result.push(...alpacaPos.value);
  else console.warn('[BrokerRouter] Alpaca getPositions failed:', alpacaPos.reason?.message);

  if (oandaPos.status === 'fulfilled') result.push(...oandaPos.value);
  else console.warn('[BrokerRouter] Oanda getPositions failed:', oandaPos.reason?.message);

  return result;
}

// ── Account fetch (per-broker) ────────────────────────────────────────────────

/**
 * Get account summaries from both brokers.
 * @returns {Promise<{ alpaca: Object, oanda: Object }>}
 */
async function getAccounts() {
  const [alpacaAcc, oandaAcc] = await Promise.allSettled([
    alpaca.getAccount(),
    oanda.getAccount(),
  ]);

  return {
    alpaca: alpacaAcc.status === 'fulfilled' ? alpacaAcc.value : { error: alpacaAcc.reason?.message },
    oanda:  oandaAcc.status  === 'fulfilled' ? oandaAcc.value  : { error: oandaAcc.reason?.message },
  };
}

module.exports = {
  brokerFor,
  isEnabled,
  checkFifo,
  submitOrder,
  closePosition,
  getAllPositions,
  getAccounts,
  normKey,
};
