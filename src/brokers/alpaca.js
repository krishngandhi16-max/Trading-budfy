/**
 * Phase 3 — Alpaca REST v2 broker client
 *
 * Handles: stocks, crypto
 * Mode:    paper trading ONLY (paper-api.alpaca.markets) — never the live URL
 * Guard:   all calls are no-ops when BROKER_ENABLED !== 'true'
 *
 * Env vars required:
 *   ALPACA_API_KEY     Alpaca key ID
 *   ALPACA_API_SECRET  Alpaca secret key
 *   BROKER_ENABLED     Set to 'true' to enable real (paper) API calls
 */

// ── Config ───────────────────────────────────────────────────────────────────

const PAPER_HOST = 'paper-api.alpaca.markets';
const DATA_HOST  = 'data.alpaca.markets';

function isEnabled() {
  return process.env.BROKER_ENABLED === 'true';
}

// Market data works with the same keys even when trading is disabled, as long
// as keys are present. Used by the scanner to fetch bars in mock mode too.
function hasKeys() {
  return !!(process.env.ALPACA_API_KEY && process.env.ALPACA_API_SECRET);
}

function headers() {
  return {
    'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY    || '',
    'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET || '',
    'Content-Type': 'application/json',
  };
}

// ── Symbol normalisation ──────────────────────────────────────────────────────

/**
 * Convert our internal symbol to the Alpaca format.
 *   stocks:  'AAPL'     → 'AAPL'
 *   crypto:  'BTC'      → 'BTC/USD'
 *            'BTC-USD'  → 'BTC/USD'
 *            'BTC/USD'  → 'BTC/USD' (pass-through)
 */
function toAlpacaSymbol(symbol, marketType) {
  const s = symbol.toUpperCase();
  if (marketType !== 'crypto') return s;
  if (s.includes('/')) return s;
  if (s.endsWith('-USD')) return s.replace('-USD', '/USD');
  return `${s}/USD`;
}

/**
 * Strip Alpaca formatting back to a plain key for comparison.
 * 'BTC/USD' → 'BTCUSD', 'AAPL' → 'AAPL'
 */
function normaliseKey(symbol) {
  return symbol.toUpperCase().replace(/[/_\-]/g, '');
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function apiFetch(method, path, body = null, host = PAPER_HOST) {
  const url  = `https://${host}${path}`;
  const opts = { method, headers: headers() };
  if (body != null) opts.body = JSON.stringify(body);

  const res  = await fetch(url, opts);
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Alpaca ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  // Some endpoints (e.g. DELETE /positions) return 207 or empty body
  if (!text) return {};
  try { return JSON.parse(text); } catch { return text; }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Submit a market order.
 * Returns { mocked: true } when broker is disabled.
 *
 * @param {{ symbol, marketType, direction, quantity }} params
 * @returns {Promise<Object>}  Alpaca order object or mock
 */
async function submitOrder({ symbol, marketType, direction, quantity }) {
  if (!isEnabled()) {
    return { mocked: true, broker: 'alpaca', symbol, direction, quantity };
  }

  // Alpaca paper trading does not support shorting crypto
  if (marketType === 'crypto' && direction === 'short') {
    console.warn(`[Alpaca] Short orders are not supported for crypto (${symbol}) — order skipped`);
    return { skipped: true, reason: 'crypto short not supported on Alpaca paper', symbol };
  }

  const ticker = toAlpacaSymbol(symbol, marketType);
  const side   = direction === 'long' ? 'buy' : 'sell';

  // Crypto uses 'gtc'; stocks use 'day'
  const tif = marketType === 'crypto' ? 'gtc' : 'day';

  return apiFetch('POST', '/v2/orders', {
    symbol:        ticker,
    qty:           String(quantity),
    side,
    type:          'market',
    time_in_force: tif,
  });
}

/**
 * Close an open position entirely.
 * @returns {Promise<Object>}
 */
async function closePosition(symbol, marketType) {
  if (!isEnabled()) return { mocked: true, broker: 'alpaca' };
  const ticker = toAlpacaSymbol(symbol, marketType);
  return apiFetch('DELETE', `/v2/positions/${encodeURIComponent(ticker)}`);
}

/**
 * Get all open positions.
 * @returns {Promise<Array<{symbol, direction, quantity, avgEntryPrice, unrealizedPl, broker}>>}
 */
async function getPositions() {
  if (!isEnabled()) return [];

  const raw = await apiFetch('GET', '/v2/positions');
  return raw.map((p) => ({
    symbol:        p.symbol,
    normKey:       normaliseKey(p.symbol),
    direction:     p.side === 'long' ? 'long' : 'short',
    quantity:      Math.abs(parseFloat(p.qty)),
    avgEntryPrice: parseFloat(p.avg_entry_price),
    unrealizedPl:  parseFloat(p.unrealized_pl),
    broker:        'alpaca',
    raw:           p,
  }));
}

/**
 * Get account summary.
 * @returns {Promise<{equity, balance, currency}>}
 */
async function getAccount() {
  if (!isEnabled()) {
    return { equity: 100000, balance: 100000, currency: 'USD', mocked: true };
  }

  const a = await apiFetch('GET', '/v2/account');
  return {
    equity:   parseFloat(a.equity),
    balance:  parseFloat(a.cash),
    currency: a.currency,
    raw:      a,
  };
}

// ── Bracket orders (entry + TP + SL) ──────────────────────────────────────────

/**
 * Submit a bracket order: an entry leg plus attached take-profit and stop-loss
 * legs (OCO). Equities only in this app. Returns { mocked, payload } when the
 * broker is disabled so the scanner can be dry-run and inspected.
 *
 * @param {Object} p
 * @param {string} p.symbol          e.g. 'AAPL'
 * @param {'buy'|'sell'} p.side       entry side
 * @param {number} p.qty              whole shares (>0)
 * @param {'market'|'limit'} p.entryType
 * @param {number} [p.limitPrice]     required when entryType='limit'
 * @param {number} p.takeProfit       TP limit price
 * @param {number} p.stopLoss         SL stop price
 * @param {string} [p.clientOrderId]  strategy-tagged id (must be unique per order)
 * @returns {Promise<Object>}
 */
async function submitBracketOrder({ symbol, side, qty, entryType, limitPrice, takeProfit, stopLoss, clientOrderId }) {
  const payload = {
    symbol:        symbol.toUpperCase(),
    qty:           String(qty),
    side,
    type:          entryType,
    time_in_force: 'day',
    order_class:   'bracket',
    take_profit:   { limit_price: round2str(takeProfit) },
    stop_loss:     { stop_price:  round2str(stopLoss) },
  };
  if (entryType === 'limit') payload.limit_price = round2str(limitPrice);
  if (clientOrderId) payload.client_order_id = clientOrderId;

  if (!isEnabled()) {
    return { mocked: true, broker: 'alpaca', payload };
  }
  return apiFetch('POST', '/v2/orders', payload);
}

function round2str(n) { return String(parseFloat(Number(n).toFixed(2))); }

// ── Order queries (fills / TP-SL leg reconciliation) ──────────────────────────

/**
 * List orders. status: 'open' | 'closed' | 'all'. Includes nested legs so the
 * reconciler can see which bracket leg (TP or SL) filled.
 * @returns {Promise<Array>}
 */
async function listOrders(status = 'all', limit = 500) {
  if (!isEnabled()) return [];
  const q = `?status=${status}&limit=${limit}&nested=true`;
  return apiFetch('GET', `/v2/orders${q}`);
}

/** Get a single order by Alpaca id or client_order_id. */
async function getOrder(id, byClientId = false) {
  if (!isEnabled()) return null;
  const path = byClientId
    ? `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(id)}`
    : `/v2/orders/${encodeURIComponent(id)}`;
  return apiFetch('GET', path);
}

// ── Market data (bars) ────────────────────────────────────────────────────────

/**
 * Fetch bars for many symbols at once from the Alpaca market-data API.
 * Batches to <=100 symbols/request. Returns { SYMBOL: [ {time,open,high,low,close,volume}... ] }.
 *
 * @param {string[]} symbols
 * @param {string} timeframe   Alpaca timeframe, e.g. '5Min', '1Day'
 * @param {Object} opts        { start, end, limit, feed }
 */
async function getBars(symbols, timeframe, opts = {}) {
  const out = {};
  if (!hasKeys()) return out;              // no data without keys
  const { start, end, limit = 1000, feed = 'iex' } = opts;

  const batches = [];
  for (let i = 0; i < symbols.length; i += 100) batches.push(symbols.slice(i, i + 100));

  for (const batch of batches) {
    const params = new URLSearchParams({
      symbols:   batch.join(','),
      timeframe,
      limit:     String(limit),
      adjustment:'raw',
      feed,
    });
    if (start) params.set('start', start);
    if (end)   params.set('end', end);

    let pageToken = null;
    do {
      if (pageToken) params.set('page_token', pageToken);
      const res = await apiFetch('GET', `/v2/stocks/bars?${params.toString()}`, null, DATA_HOST);
      const barsBySym = res.bars || {};
      for (const [sym, arr] of Object.entries(barsBySym)) {
        if (!out[sym]) out[sym] = [];
        for (const b of arr) {
          out[sym].push({
            time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
          });
        }
      }
      pageToken = res.next_page_token || null;
    } while (pageToken);
  }
  return out;
}

module.exports = {
  submitOrder, closePosition, getPositions, getAccount, isEnabled, hasKeys, normaliseKey,
  submitBracketOrder, listOrders, getOrder, getBars,
};
