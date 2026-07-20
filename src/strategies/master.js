/**
 * Strategy 3 — The Master Strategy (the perfect storm).
 *
 * All filters must align:
 *   1. Macro bias  : price ≤ VAL for longs (≥ VAH for shorts)   [value-profile]
 *   2. The trap    : sweep PDL (long) / PDH (short)
 *   3. Exhaustion  : declining volume during the sweep
 *   4. Conviction  : 5m BOS by candle BODY close with volume spike ≥ 1.5·SMA20
 *   5. Entry       : bullish/bearish FVG on the reversal leg → limit entry inside it
 *   6. Confirmation: pullback into the FVG on LOW volume
 * SL = sweep extreme.  TP = POC (Point of Control).
 */

const { prevDayLevels, volumeProfile, scanLongShort } = require('./lib');

const NAME = 'master';

function evaluate(symbol, bars5m, barsDaily) {
  const levels = prevDayLevels(barsDaily);
  if (!levels || !bars5m || bars5m.length < 30) return null;

  const vp = volumeProfile(bars5m, 400, 24, 70);
  if (!vp) return null;

  const setup = scanLongShort(bars5m, levels.pdl, levels.pdh, {
    requireVolumeFilters: true,
    targetMode: 'poc',
    minRR: 0,               // POC target is not R:R-gated in Master
    volSpikeX: 1.5,
    volLen: 20,
    vaLevels: vp,
  });
  if (!setup) return null;

  // Guard: POC must be on the profitable side of entry, else skip.
  const okTarget = setup.direction === 'long'
    ? setup.takeProfit > setup.entryPrice
    : setup.takeProfit < setup.entryPrice;
  if (!okTarget) return null;

  return {
    strategy: NAME,
    symbol,
    ...setup,
    meta: {
      ...setup.meta,
      pdh: levels.pdh, pdl: levels.pdl,
      val: round2(vp.val), poc: round2(vp.poc), vah: round2(vp.vah),
    },
  };
}

function round2(n) { return parseFloat(n.toFixed(2)); }

module.exports = { evaluate, NAME };
