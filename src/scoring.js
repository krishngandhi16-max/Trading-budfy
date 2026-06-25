const fs   = require('fs');
const path = require('path');

const WEIGHTS_PATH = path.resolve(__dirname, '../data/weights.json');

// Default weights used when weights.json is empty or a key is missing
const DEFAULT_WEIGHTS = {
  FVG:   { bullish: 25, bearish: 25 },
  Sweep: { bullish: 30, bearish: 30 },
  BOS:   { bullish: 25, bearish: 25 },
  OB:    { bullish: 20, bearish: 20 },

  // Timeframe multipliers (higher timeframe = higher conviction)
  timeframe: {
    '1M':  0.5,
    '5M':  0.65,
    '15M': 0.75,
    '1H':  0.85,
    '4H':  0.95,
    '1D':  1.0,
  },
};

/**
 * Load weights from data/weights.json, falling back to DEFAULT_WEIGHTS for
 * any missing key.
 */
function loadWeights() {
  try {
    const raw = fs.readFileSync(WEIGHTS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // Merge with defaults so partial configs still work
    return {
      FVG:       { ...DEFAULT_WEIGHTS.FVG,   ...(parsed.FVG   || {}) },
      Sweep:     { ...DEFAULT_WEIGHTS.Sweep, ...(parsed.Sweep || {}) },
      BOS:       { ...DEFAULT_WEIGHTS.BOS,   ...(parsed.BOS   || {}) },
      OB:        { ...DEFAULT_WEIGHTS.OB,    ...(parsed.OB    || {}) },
      timeframe: { ...DEFAULT_WEIGHTS.timeframe, ...(parsed.timeframe || {}) },
    };
  } catch {
    return DEFAULT_WEIGHTS;
  }
}

/**
 * Count the most recent occurrence of each signal type/direction pair in a
 * single timeframe result.
 *
 * @param {{ fvg, sweep, bos, ob }} tfResult  Output of detectSignals()
 * @returns {{ FVG_bullish, FVG_bearish, Sweep_bullish, ... }}
 */
function countSignals(tfResult) {
  const counts = {
    FVG_bullish:   0, FVG_bearish:   0,
    Sweep_bullish: 0, Sweep_bearish: 0,
    BOS_bullish:   0, BOS_bearish:   0,
    OB_bullish:    0, OB_bearish:    0,
  };

  for (const sig of tfResult.fvg   || []) counts[`FVG_${sig.direction}`]++;
  for (const sig of tfResult.sweep || []) counts[`Sweep_${sig.direction}`]++;
  for (const sig of tfResult.bos   || []) counts[`BOS_${sig.direction}`]++;
  for (const sig of tfResult.ob    || []) counts[`OB_${sig.direction}`]++;

  return counts;
}

/**
 * Score a single timeframe result.
 *
 * @param {{ timeframe, fvg, sweep, bos, ob }} tfResult
 * @param {Object} weights  Loaded weight config
 * @returns {{ timeframe, bullishScore, bearishScore, tfMultiplier }}
 */
function scoreSingleTimeframe(tfResult, weights) {
  const tf  = tfResult.timeframe;
  const mul = weights.timeframe[tf] ?? 1;
  const c   = countSignals(tfResult);

  const rawBullish =
    c.FVG_bullish   * weights.FVG.bullish   +
    c.Sweep_bullish * weights.Sweep.bullish +
    c.BOS_bullish   * weights.BOS.bullish   +
    c.OB_bullish    * weights.OB.bullish;

  const rawBearish =
    c.FVG_bearish   * weights.FVG.bearish   +
    c.Sweep_bearish * weights.Sweep.bearish +
    c.BOS_bearish   * weights.BOS.bearish   +
    c.OB_bearish    * weights.OB.bearish;

  return {
    timeframe:     tf,
    bullishScore:  rawBullish * mul,
    bearishScore:  rawBearish * mul,
    tfMultiplier:  mul,
    counts:        c,
  };
}

/**
 * Compute an overall confidence % from an array of per-timeframe signal results.
 *
 * Confidence is expressed as a number in [0, 100].
 * A positive value means bullish conviction; negative means bearish conviction.
 * The absolute value is the confidence percentage, the sign is the bias.
 *
 * @param {Array<{ timeframe, fvg, sweep, bos, ob }>} tfResults  detectAllTimeframes() output
 * @returns {{
 *   confidence: number,   // 0-100
 *   bias: 'bullish'|'bearish'|'neutral',
 *   bullishTotal: number,
 *   bearishTotal: number,
 *   breakdown: Array
 * }}
 */
function scoreSignals(tfResults) {
  const weights = loadWeights();

  let bullishTotal = 0;
  let bearishTotal = 0;
  const breakdown = [];

  for (const tfResult of tfResults) {
    const scored = scoreSingleTimeframe(tfResult, weights);
    bullishTotal += scored.bullishScore;
    bearishTotal += scored.bearishScore;
    breakdown.push(scored);
  }

  const total = bullishTotal + bearishTotal;

  if (total === 0) {
    return { confidence: 0, bias: 'neutral', bullishTotal: 0, bearishTotal: 0, breakdown };
  }

  const bullishPct = (bullishTotal / total) * 100;
  const bearishPct = (bearishTotal / total) * 100;

  // Confidence = how far the dominant side is from 50-50 (scaled to 0-100)
  const dominance   = Math.abs(bullishPct - bearishPct);
  const confidence  = Math.min(100, Math.round(dominance));
  const bias        = bullishTotal >= bearishTotal ? 'bullish' : 'bearish';

  return {
    confidence,
    bias,
    bullishTotal: Math.round(bullishTotal * 100) / 100,
    bearishTotal: Math.round(bearishTotal * 100) / 100,
    breakdown,
  };
}

module.exports = { scoreSignals, loadWeights, DEFAULT_WEIGHTS };
