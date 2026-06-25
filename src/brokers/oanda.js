/**
 * Phase 3 — Oanda REST v20 broker client
 *
 * Handles: forex, metals (XAU/USD, XAG/USD, etc.)
 * Mode:    practice (api-fxpractice.oanda.com) — never the live URL
 * Guard:   all calls are no-ops when BROKER_ENABLED !== 'true'
 *
 * Env vars required:
 *   OANDA_API_KEY       Oanda personal access token
 *   OANDA_ACCOUNT_ID    Oanda account ID (e.g. '001-001-1234567-001')
 *   BROKER_ENABLED      Set to 'true' to enable real (practice) API calls
 */

// ── Config ───────────────────────────────────────────────────────────────────

const PRACTICE_HOST = 'api-fxpractice.oanda.com';

function isEnabled() {
  return process.env.BROKER_ENABLED === 'true';
}

function accountId() {
  return process.env.OANDA_ACCOUNT_ID || '';
}

function headers() {
  return {
    Authorization:  `Bearer ${process.env.OANDA_API_KEY || ''}`,
    'Content-Type': 'application/json',
    Accept:         'application/json',
  };
}

// ── Symbol normalisation ──────────────────────────────────────────────────────

/**
 * Convert our internal symbol to Oanda instrument format (BASE_QUOTE).
 *
 *   forex:  'EURUSD'  → 'EUR_USD'
 *           'EUR_USD' → 'EUR_USD' (pass-through)
 *   metals: 'XAU'     → 'XAU_USD'
 *           'XAUUSD'  → 'XAU_USD'
 *           'XAG'     → 'XAG_USD'
 */
function toOandaInstrument(symbol, marketType) {
  const s = symbol.toUpperCase().replace(/[/-]/g, '');

  if (marketType === 'metals') {
    // Already has quote (e.g. XAUUSD → XAU_USD)
    if (s.length >= 6) return `${s.slice(0, 3)}_${s.slice(3)}`;
    // Base only (e.g. XAU → XAU_USD)
    return `${s}_USD`;
  }

  // forex: 6-char pair (EURUSD → EUR_USD)
  if (s.length === 6) return `${s.slice(0, 3)}_${s.slice(3)}`;

  // Already separated (e.g. EUR_USD stored as 'EUR_USD')
  if (s.includes('_')) return s;

  return s;
}

/**
 * Strip Oanda formatting back to a plain comparison key.
 * 'EUR_USD' → 'EURUSD', 'XAU_USD' → 'XAUUSD'
 */
function normaliseKey(symbol) {
  return symbol.toUpperCase().replace(/[/_\-]/g, '');
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function apiFetch(method, path, body = null) {
  const url  = `https://${PRACTICE_HOST}${path}`;
  const opts = { method, headers: headers() };
  if (body != null) opts.body = JSON.stringify(body);

  const res  = await fetch(url, opts);
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Oanda ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  if (!text) return {};
  try { return JSON.parse(text); } catch { return text; }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Submit a market order.
 * Units are positive (buy/long) or negative (sell/short).
 *
 * @param {{ symbol, marketType, direction, quantity }} params
 * @returns {Promise<Object>}  Oanda orderFillTransaction or mock
 */
async function submitOrder({ symbol, marketType, direction, quantity }) {
  if (!isEnabled()) {
    return { mocked: true, broker: 'oanda', symbol, direction, quantity };
  }

  const instrument = toOandaInstrument(symbol, marketType);
  const units      = direction === 'long'
    ? String(quantity)
    : String(-Math.abs(quantity));

  const res = await apiFetch('POST', `/v3/accounts/${accountId()}/orders`, {
    order: {
      type:        'MARKET',
      instrument,
      units,
      timeInForce: 'FOK',
    },
  });

  // Oanda wraps the fill in orderFillTransaction
  return res.orderFillTransaction || res;
}

/**
 * Close an open position entirely (both long and short units if any).
 * @returns {Promise<Object>}
 */
async function closePosition(symbol, marketType) {
  if (!isEnabled()) return { mocked: true, broker: 'oanda' };

  const instrument = toOandaInstrument(symbol, marketType);
  return apiFetch('PUT', `/v3/accounts/${accountId()}/positions/${instrument}/close`, {
    longUnits:  'ALL',
    shortUnits: 'ALL',
  });
}

/**
 * Get all open positions, normalised to the shared position shape.
 * @returns {Promise<Array<{symbol, direction, quantity, avgEntryPrice, unrealizedPl, broker}>>}
 */
async function getPositions() {
  if (!isEnabled()) return [];

  const res       = await apiFetch('GET', `/v3/accounts/${accountId()}/positions`);
  const positions = res.positions || [];
  const result    = [];

  for (const p of positions) {
    const longUnits  = parseFloat(p.long?.units  || '0');
    const shortUnits = parseFloat(p.short?.units || '0');

    if (longUnits > 0) {
      result.push({
        symbol:        p.instrument,
        normKey:       normaliseKey(p.instrument),
        direction:     'long',
        quantity:      longUnits,
        avgEntryPrice: parseFloat(p.long?.averagePrice || '0'),
        unrealizedPl:  parseFloat(p.unrealizedPL || '0'),
        broker:        'oanda',
        raw:           p,
      });
    }

    if (shortUnits < 0) {
      result.push({
        symbol:        p.instrument,
        normKey:       normaliseKey(p.instrument),
        direction:     'short',
        quantity:      Math.abs(shortUnits),
        avgEntryPrice: parseFloat(p.short?.averagePrice || '0'),
        unrealizedPl:  parseFloat(p.unrealizedPL || '0'),
        broker:        'oanda',
        raw:           p,
      });
    }
  }

  return result;
}

/**
 * Get account summary.
 * @returns {Promise<{equity, balance, currency}>}
 */
async function getAccount() {
  if (!isEnabled()) {
    return { equity: 100000, balance: 100000, currency: 'USD', mocked: true };
  }

  const res = await apiFetch('GET', `/v3/accounts/${accountId()}/summary`);
  const a   = res.account || {};
  return {
    equity:   parseFloat(a.NAV      || a.balance || '0'),
    balance:  parseFloat(a.balance  || '0'),
    currency: a.currency || 'USD',
    raw:      a,
  };
}

module.exports = { submitOrder, closePosition, getPositions, getAccount, isEnabled, normaliseKey, toOandaInstrument };
