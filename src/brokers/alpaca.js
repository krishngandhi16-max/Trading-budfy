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

function isEnabled() {
  return process.env.BROKER_ENABLED === 'true';
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

async function apiFetch(method, path, body = null) {
  const url  = `https://${PAPER_HOST}${path}`;
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

module.exports = { submitOrder, closePosition, getPositions, getAccount, isEnabled, normaliseKey };
