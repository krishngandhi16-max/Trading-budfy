/**
 * Phase 2 — 13-gate entry validation system (ICT-based).
 * Gates run in order; execution stops at the first failure.
 *
 * Context shape expected by runAllGates():
 * {
 *   tfResults:       Array from detectAllTimeframes()
 *   score:           Object from scoreSignals()
 *   openTradesCount: number
 *   accountBalance:  number
 *   peakBalance:     number
 * }
 */

// ── Constants ────────────────────────────────────────────────────────────────

// London open / NY open kill zones (UTC hours, inclusive start, exclusive end)
const KILL_ZONES = {
  londonOpen: { start: 7,  end: 10 },
  nyOpen:     { start: 13, end: 16 },
};

const MIN_CONFIDENCE   = 60;   // Gate 11 threshold (%)
const MAX_OPEN_TRADES  = 3;    // Gate 12 concurrent trade cap
const MAX_DRAWDOWN_PCT = 0.06; // Gate 13 drawdown limit (6 %)

// ── Helpers ──────────────────────────────────────────────────────────────────

// Return the last n items from an array (most recent signals).
function tail(arr, n = 5) {
  return (arr || []).slice(-n);
}

// True if any signal in the tail matches the given direction.
function hasDirection(signals, direction, n = 5) {
  return tail(signals, n).some((s) => s.direction === direction);
}

// Find a tfResult by timeframe label.
function tf(tfResults, label) {
  return tfResults.find((r) => r.timeframe === label) || null;
}

// True if any result in an array of timeframe labels has a matching signal.
function anyTF(tfResults, labels, signalKey, direction) {
  return labels.some((label) => {
    const r = tf(tfResults, label);
    return r && hasDirection(r[signalKey], direction);
  });
}

// ── Gate functions ───────────────────────────────────────────────────────────

// Gate 1 — Market session active (London open OR NY open kill zone, UTC)
function gate1_sessionActive() {
  const hour = new Date().getUTCHours();
  const inLondon = hour >= KILL_ZONES.londonOpen.start && hour < KILL_ZONES.londonOpen.end;
  const inNY     = hour >= KILL_ZONES.nyOpen.start     && hour < KILL_ZONES.nyOpen.end;
  const passed   = inLondon || inNY;
  return {
    gate:   1,
    name:   'Session Active',
    passed,
    reason: passed
      ? `In kill zone (UTC ${hour}:xx)`
      : `Outside kill zones — London 07-10, NY 13-16 UTC (now ${hour}:xx)`,
  };
}

// Gate 2 — Daily bias is directional (not neutral)
function gate2_dailyBias({ score }) {
  const passed = score.bias !== 'neutral' && score.confidence > 0;
  return {
    gate:   2,
    name:   'Daily Bias',
    passed,
    reason: passed
      ? `Daily bias: ${score.bias} (${score.confidence}% confidence)`
      : 'No clear directional bias on daily timeframe',
  };
}

// Gate 3 — 4H BOS exists and aligns with daily bias
function gate3_h4Alignment({ tfResults, score }) {
  const bias   = score.bias;
  const h4     = tf(tfResults, '4H');
  if (!h4) return { gate: 3, name: '4H Alignment', passed: false, reason: 'No 4H data available' };
  const passed = hasDirection(h4.bos, bias);
  return {
    gate:   3,
    name:   '4H Alignment',
    passed,
    reason: passed
      ? `4H BOS aligns with ${bias} bias`
      : `No ${bias} BOS found on 4H`,
  };
}

// Gate 4 — Break of Structure confirmed on 4H or 1H in bias direction
function gate4_htfBOS({ tfResults, score }) {
  const bias   = score.bias;
  const passed = anyTF(tfResults, ['4H', '1H'], 'bos', bias);
  return {
    gate:   4,
    name:   'HTF Break of Structure',
    passed,
    reason: passed
      ? `${bias} BOS confirmed on 4H or 1H`
      : `No ${bias} BOS on 4H / 1H`,
  };
}

// Gate 5 — Liquidity sweep on 1H or higher in bias direction (swept before entry)
function gate5_liquiditySweep({ tfResults, score }) {
  const bias   = score.bias;
  const passed = anyTF(tfResults, ['1H', '4H', '1D'], 'sweep', bias);
  return {
    gate:   5,
    name:   'Liquidity Sweep',
    passed,
    reason: passed
      ? `${bias} liquidity sweep present on 1H+`
      : `No ${bias} sweep on 1H / 4H / 1D`,
  };
}

// Gate 6 — Fair Value Gap on 4H or 1D in bias direction
function gate6_htfFVG({ tfResults, score }) {
  const bias   = score.bias;
  const passed = anyTF(tfResults, ['4H', '1D'], 'fvg', bias);
  return {
    gate:   6,
    name:   'HTF Fair Value Gap',
    passed,
    reason: passed
      ? `${bias} FVG on 4H or 1D`
      : `No ${bias} FVG on 4H / 1D`,
  };
}

// Gate 7 — Order Block on 4H or 1D in bias direction
function gate7_htfOB({ tfResults, score }) {
  const bias   = score.bias;
  const passed = anyTF(tfResults, ['4H', '1D'], 'ob', bias);
  return {
    gate:   7,
    name:   'HTF Order Block',
    passed,
    reason: passed
      ? `${bias} OB on 4H or 1D`
      : `No ${bias} OB on 4H / 1D`,
  };
}

// Gate 8 — LTF Break of Structure (15M or 5M) confirms bias direction
function gate8_ltfBOS({ tfResults, score }) {
  const bias   = score.bias;
  const passed = anyTF(tfResults, ['15M', '5M'], 'bos', bias);
  return {
    gate:   8,
    name:   'LTF Break of Structure',
    passed,
    reason: passed
      ? `${bias} BOS confirmed on 15M or 5M`
      : `No ${bias} BOS on 15M / 5M`,
  };
}

// Gate 9 — LTF Fair Value Gap (15M or 5M) present as entry zone
function gate9_ltfFVG({ tfResults, score }) {
  const bias   = score.bias;
  const passed = anyTF(tfResults, ['15M', '5M'], 'fvg', bias);
  return {
    gate:   9,
    name:   'LTF Fair Value Gap',
    passed,
    reason: passed
      ? `${bias} FVG entry zone on 15M or 5M`
      : `No ${bias} FVG on 15M / 5M`,
  };
}

// Gate 10 — LTF Order Block (5M or 15M) aligns with direction
function gate10_ltfOB({ tfResults, score }) {
  const bias   = score.bias;
  const passed = anyTF(tfResults, ['5M', '15M'], 'ob', bias);
  return {
    gate:   10,
    name:   'LTF Order Block',
    passed,
    reason: passed
      ? `${bias} OB on 5M or 15M`
      : `No ${bias} OB on 5M / 15M`,
  };
}

// Gate 11 — Confidence score >= 60 %
function gate11_confidence({ score }) {
  const passed = score.confidence >= MIN_CONFIDENCE;
  return {
    gate:   11,
    name:   'Confidence Threshold',
    passed,
    reason: passed
      ? `Confidence ${score.confidence}% >= ${MIN_CONFIDENCE}% minimum`
      : `Confidence ${score.confidence}% < ${MIN_CONFIDENCE}% minimum`,
  };
}

// Gate 12 — Concurrent open trades < 3
function gate12_maxTrades({ openTradesCount }) {
  const passed = openTradesCount < MAX_OPEN_TRADES;
  return {
    gate:   12,
    name:   'Max Open Trades',
    passed,
    reason: passed
      ? `${openTradesCount} open trades (limit ${MAX_OPEN_TRADES})`
      : `At open-trade cap: ${openTradesCount} / ${MAX_OPEN_TRADES}`,
  };
}

// Gate 13 — Account drawdown < 6 % from peak balance
function gate13_drawdown({ accountBalance, peakBalance }) {
  const peak     = peakBalance > 0 ? peakBalance : accountBalance;
  const drawdown = (peak - accountBalance) / peak;
  const passed   = drawdown < MAX_DRAWDOWN_PCT;
  return {
    gate:   13,
    name:   'Drawdown Guard',
    passed,
    reason: passed
      ? `Drawdown ${(drawdown * 100).toFixed(2)}% within ${MAX_DRAWDOWN_PCT * 100}% limit`
      : `Drawdown ${(drawdown * 100).toFixed(2)}% exceeds ${MAX_DRAWDOWN_PCT * 100}% limit`,
  };
}

// ── Runner ───────────────────────────────────────────────────────────────────

const GATE_FNS = [
  gate1_sessionActive,
  gate2_dailyBias,
  gate3_h4Alignment,
  gate4_htfBOS,
  gate5_liquiditySweep,
  gate6_htfFVG,
  gate7_htfOB,
  gate8_ltfBOS,
  gate9_ltfFVG,
  gate10_ltfOB,
  gate11_confidence,
  gate12_maxTrades,
  gate13_drawdown,
];

/**
 * Run all 13 gates in order. Stops at first failure.
 *
 * @param {Object} context  { tfResults, score, openTradesCount, accountBalance, peakBalance }
 * @returns {{ passed, failedGate, failedReason, results }}
 */
function runAllGates(context) {
  const results = [];
  for (const fn of GATE_FNS) {
    const result = fn(context);
    results.push(result);
    if (!result.passed) {
      return {
        passed:       false,
        failedGate:   result.gate,
        failedReason: result.reason,
        results,
      };
    }
  }
  return { passed: true, failedGate: null, failedReason: null, results };
}

module.exports = {
  runAllGates,
  MIN_CONFIDENCE,
  MAX_OPEN_TRADES,
  MAX_DRAWDOWN_PCT,
};
