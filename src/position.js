/**
 * Phase 2 — Position sizing
 *
 * Rules:
 *  - Risk 1–3 % of account balance per trade (clamped)
 *  - Take-profit is FORCED to exactly 2× the risk distance (2:1 R:R)
 *  - Stop loss must already be on the correct side of entry
 */

const MIN_RISK_PCT = 0.01; // 1 %
const MAX_RISK_PCT = 0.03; // 3 %

/**
 * Calculate position size and levels for a paper trade.
 *
 * @param {Object} params
 * @param {number} params.accountBalance  Current account balance in $.
 * @param {number} params.entryPrice      Intended entry price.
 * @param {number} params.stopLossPrice   Stop-loss price (must differ from entry).
 * @param {string} params.direction       'long' | 'short'
 * @param {number} [params.riskPct=0.01]  Fraction of balance to risk (0.01 = 1 %).
 * @returns {{
 *   quantity:    number,  // units to buy/sell
 *   riskAmount:  number,  // $ at risk
 *   riskPct:     number,  // clamped risk fraction
 *   riskPerUnit: number,  // |entry - SL| — the R distance
 *   stopLoss:    number,
 *   takeProfit:  number,  // entry ± 2R (forced 2:1)
 *   rrRatio:     number,  // always 2.0
 * }}
 */
function calculatePosition({ accountBalance, entryPrice, stopLossPrice, direction, riskPct = 0.01 }) {
  if (!['long', 'short'].includes(direction)) {
    throw new Error(`direction must be 'long' or 'short', got: ${direction}`);
  }
  if (accountBalance <= 0) {
    throw new Error('accountBalance must be positive');
  }

  const clampedRisk  = Math.max(MIN_RISK_PCT, Math.min(MAX_RISK_PCT, riskPct));
  const riskAmount   = accountBalance * clampedRisk;
  const riskPerUnit  = Math.abs(entryPrice - stopLossPrice);

  if (riskPerUnit === 0) {
    throw new Error('entryPrice and stopLossPrice cannot be equal');
  }

  // Validate SL direction
  if (direction === 'long'  && stopLossPrice >= entryPrice) {
    throw new Error('Long trade: stopLossPrice must be below entryPrice');
  }
  if (direction === 'short' && stopLossPrice <= entryPrice) {
    throw new Error('Short trade: stopLossPrice must be above entryPrice');
  }

  const quantity   = riskAmount / riskPerUnit;

  // Force 2:1 R:R
  const takeProfit = direction === 'long'
    ? entryPrice + 2 * riskPerUnit
    : entryPrice - 2 * riskPerUnit;

  return {
    quantity:    round(quantity,   8),
    riskAmount:  round(riskAmount, 2),
    riskPct:     clampedRisk,
    riskPerUnit: round(riskPerUnit, 8),
    stopLoss:    stopLossPrice,
    takeProfit:  round(takeProfit, 8),
    rrRatio:     2.0,
  };
}

function round(n, dp) {
  return parseFloat(n.toFixed(dp));
}

module.exports = { calculatePosition, MIN_RISK_PCT, MAX_RISK_PCT };
