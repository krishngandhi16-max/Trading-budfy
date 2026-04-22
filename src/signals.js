/**
 * ICT signal detection: FVG, Sweep, BOS, OB
 * Operates on an array of OHLC bars: { time, open, high, low, close, volume }
 *
 * Supported timeframes: 1M, 5M, 15M, 1H, 4H, 1D
 */

const SUPPORTED_TIMEFRAMES = ['1M', '5M', '15M', '1H', '4H', '1D'];

// ── Fair Value Gap (FVG) ─────────────────────────────────────────────────────
// Bullish FVG: bar[i-1].high < bar[i+1].low  (gap between i-1 and i+1)
// Bearish FVG: bar[i-1].low  > bar[i+1].high
function detectFVG(bars) {
  const signals = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const prev = bars[i - 1];
    const curr = bars[i];
    const next = bars[i + 1];

    if (prev.high < next.low) {
      signals.push({
        type:      'FVG',
        direction: 'bullish',
        time:      curr.time,
        gapTop:    next.low,
        gapBottom: prev.high,
      });
    } else if (prev.low > next.high) {
      signals.push({
        type:      'FVG',
        direction: 'bearish',
        time:      curr.time,
        gapTop:    prev.low,
        gapBottom: next.high,
      });
    }
  }
  return signals;
}

// ── Liquidity Sweep ──────────────────────────────────────────────────────────
// Bullish sweep: bar wicks below the prior n-bar swing low then closes above it
// Bearish sweep: bar wicks above the prior n-bar swing high then closes below it
function detectSweep(bars, swingLookback = 10) {
  const signals = [];

  for (let i = swingLookback; i < bars.length; i++) {
    const window = bars.slice(i - swingLookback, i);
    const swingLow  = Math.min(...window.map((b) => b.low));
    const swingHigh = Math.max(...window.map((b) => b.high));
    const curr = bars[i];

    if (curr.low < swingLow && curr.close > swingLow) {
      signals.push({
        type:       'Sweep',
        direction:  'bullish',
        time:       curr.time,
        swingLevel: swingLow,
        wick:       curr.low,
      });
    }

    if (curr.high > swingHigh && curr.close < swingHigh) {
      signals.push({
        type:       'Sweep',
        direction:  'bearish',
        time:       curr.time,
        swingLevel: swingHigh,
        wick:       curr.high,
      });
    }
  }
  return signals;
}

// ── Break of Structure (BOS) ─────────────────────────────────────────────────
// Bullish BOS:  close breaks above the most recent swing high
// Bearish BOS:  close breaks below the most recent swing low
function detectBOS(bars, swingLookback = 10) {
  const signals = [];

  for (let i = swingLookback; i < bars.length; i++) {
    const window = bars.slice(i - swingLookback, i);
    const prevSwingHigh = Math.max(...window.map((b) => b.high));
    const prevSwingLow  = Math.min(...window.map((b) => b.low));
    const curr = bars[i];

    if (curr.close > prevSwingHigh) {
      signals.push({
        type:      'BOS',
        direction: 'bullish',
        time:      curr.time,
        level:     prevSwingHigh,
        close:     curr.close,
      });
    } else if (curr.close < prevSwingLow) {
      signals.push({
        type:      'BOS',
        direction: 'bearish',
        time:      curr.time,
        level:     prevSwingLow,
        close:     curr.close,
      });
    }
  }
  return signals;
}

// ── Order Block (OB) ─────────────────────────────────────────────────────────
// Bullish OB:  last bearish candle before a strong bullish move (3 bars)
// Bearish OB:  last bullish candle before a strong bearish move (3 bars)
function detectOB(bars, moveLookforward = 3) {
  const signals = [];

  for (let i = 0; i < bars.length - moveLookforward; i++) {
    const curr = bars[i];
    const isBearish = curr.close < curr.open;
    const isBullish = curr.close > curr.open;

    const futureClose = bars[i + moveLookforward].close;
    const move        = futureClose - curr.close;
    const range       = curr.high - curr.low || 1;
    const relativeMove = Math.abs(move) / range;

    if (isBearish && move > 0 && relativeMove >= 1.5) {
      signals.push({
        type:      'OB',
        direction: 'bullish',
        time:      curr.time,
        obHigh:    curr.open,
        obLow:     curr.close,
      });
    }

    if (isBullish && move < 0 && relativeMove >= 1.5) {
      signals.push({
        type:      'OB',
        direction: 'bearish',
        time:      curr.time,
        obHigh:    curr.close,
        obLow:     curr.open,
      });
    }
  }
  return signals;
}

/**
 * Run all four ICT detectors on the provided bars for a given timeframe.
 *
 * @param {Array}  bars      OHLC array from fetchOHLC()
 * @param {string} timeframe One of SUPPORTED_TIMEFRAMES
 * @returns {{ timeframe, fvg, sweep, bos, ob }}
 */
function detectSignals(bars, timeframe) {
  if (!SUPPORTED_TIMEFRAMES.includes(timeframe)) {
    throw new Error(`Unsupported timeframe: ${timeframe}. Use one of: ${SUPPORTED_TIMEFRAMES.join(', ')}`);
  }

  return {
    timeframe,
    fvg:   detectFVG(bars),
    sweep: detectSweep(bars),
    bos:   detectBOS(bars),
    ob:    detectOB(bars),
  };
}

/**
 * Run signal detection across multiple timeframes.
 * barsMap = { '1H': [...bars], '4H': [...bars], ... }
 *
 * @param {Object} barsMap  { [timeframe]: bars[] }
 * @returns {Array<{ timeframe, fvg, sweep, bos, ob }>}
 */
function detectAllTimeframes(barsMap) {
  return Object.entries(barsMap).map(([tf, bars]) => detectSignals(bars, tf));
}

module.exports = {
  detectFVG,
  detectSweep,
  detectBOS,
  detectOB,
  detectSignals,
  detectAllTimeframes,
  SUPPORTED_TIMEFRAMES,
};
