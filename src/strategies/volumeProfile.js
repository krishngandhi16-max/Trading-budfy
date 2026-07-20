/**
 * Strategy 2 — Volume Profile Mean Reversion.
 *
 * Compute the rolling Volume Profile (VAL / POC / VAH). When the latest 5m bar
 * CLOSES below VAL → price is "cheap" → market BUY, target POC, stop VAL−1.5·ATR.
 * When it CLOSES above VAH → "expensive" → market SELL, target POC, stop VAH+1.5·ATR.
 *
 * Fires only on the fresh cross (previous bar was inside the value area) so we
 * don't re-enter every bar while price sits outside the zone.
 */

const { volumeProfile, atr, round } = require('./lib');

const NAME = 'volume_profile';

function evaluate(symbol, bars5m /*, barsDaily */) {
  if (!bars5m || bars5m.length < 30) return null;

  const vp = volumeProfile(bars5m, 400, 24, 70);
  if (!vp) return null;

  const last = bars5m[bars5m.length - 1];
  const prev = bars5m[bars5m.length - 2];
  const a = atr(bars5m, 14);
  if (!(a > 0)) return null;

  // Fresh cross below VAL → BUY (target POC)
  if (last.close < vp.val && prev.close >= vp.val) {
    const entry = last.close;
    const stop = vp.val - 1.5 * a;
    const target = vp.poc;
    if (target > entry && stop < entry) {
      return build(symbol, 'long', entry, stop, target, vp, a);
    }
  }

  // Fresh cross above VAH → SELL (target POC)
  if (last.close > vp.vah && prev.close <= vp.vah) {
    const entry = last.close;
    const stop = vp.vah + 1.5 * a;
    const target = vp.poc;
    if (target < entry && stop > entry) {
      return build(symbol, 'short', entry, stop, target, vp, a);
    }
  }

  return null;
}

function build(symbol, direction, entry, stop, target, vp, a) {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  return {
    strategy: NAME,
    symbol,
    direction,
    entryType: 'market',
    entryPrice: round(entry, 2),
    stopLoss: round(stop, 2),
    takeProfit: round(target, 2),
    meta: {
      rr: risk > 0 ? round(reward / risk, 2) : null,
      val: round(vp.val, 2), poc: round(vp.poc, 2), vah: round(vp.vah, 2),
      atr: round(a, 4),
    },
  };
}

module.exports = { evaluate, NAME };
