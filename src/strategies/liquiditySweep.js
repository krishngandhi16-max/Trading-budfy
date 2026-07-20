/**
 * Strategy 1 — Daily Liquidity Sweep.
 *
 * Sweep PDL → bullish BOS (body close) → bullish FVG → limit entry inside the
 * FVG. SL = sweep low. TP = 2.5R. Mirror for shorts (sweep PDH → TP 2.5R).
 * No volume-profile or volume filters — pure price structure + R:R ≥ 2.5.
 */

const { prevDayLevels, scanLongShort } = require('./lib');

const NAME = 'liquidity_sweep';

/**
 * @param {string} symbol
 * @param {Array}  bars5m    5-minute bars for the current session (oldest→newest)
 * @param {Array}  barsDaily daily bars (for PDH/PDL)
 * @returns {null | { strategy, symbol, direction, entryType, entryPrice, stopLoss, takeProfit, meta }}
 */
function evaluate(symbol, bars5m, barsDaily) {
  const levels = prevDayLevels(barsDaily);
  if (!levels || !bars5m || bars5m.length < 15) return null;

  const setup = scanLongShort(bars5m, levels.pdl, levels.pdh, {
    requireVolumeFilters: false,
    targetMode: 'rr',
    minRR: 2.5,
  });
  if (!setup) return null;

  return {
    strategy: NAME,
    symbol,
    ...setup,
    meta: { ...setup.meta, pdh: levels.pdh, pdl: levels.pdl },
  };
}

module.exports = { evaluate, NAME };
