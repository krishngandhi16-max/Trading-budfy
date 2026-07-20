/**
 * Strategy primitives shared by all three books.
 *
 * These port the exact logic already validated in the TradingView Pine script
 * (tradingview/master_indicator.pine) and its Python check
 * (scratchpad/logic_check.py):
 *   - Previous Day High / Low
 *   - Rolling Volume Profile  → VAL / POC / VAH (typical-price binning, 70% VA)
 *   - Fair Value Gap (3-candle gap)
 *   - Break of Structure by candle BODY close
 *   - Volume SMA / spike / exhaustion
 *   - ATR
 *
 * Bar shape (from ohlc.js / Alpaca): { time, open, high, low, close, volume }
 */

// ── Simple indicators ─────────────────────────────────────────────────────────

/** Simple moving average of the last `n` values ending at index `i` (inclusive). */
function smaAt(values, n, i) {
  const lo = Math.max(0, i - n + 1);
  let sum = 0;
  for (let k = lo; k <= i; k++) sum += values[k];
  return sum / (i - lo + 1);
}

/** Wilder-ish ATR over the last `n` bars (simple average of true ranges). */
function atr(bars, n = 14) {
  if (bars.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const slice = trs.slice(-n);
  return slice.reduce((s, t) => s + t, 0) / slice.length;
}

// ── Previous Day High / Low ─────────────────────────────────────────────────

/**
 * PDH/PDL from a daily-bar array. Uses the most recent CLOSED daily bar
 * (the last element is assumed to be yesterday's completed daily candle when
 * called intraday; if the last bar is today's forming candle, pass sliced bars).
 *
 * @param {Array} dailyBars  daily OHLC, oldest→newest
 * @returns {{ pdh:number, pdl:number }|null}
 */
function prevDayLevels(dailyBars) {
  if (!dailyBars || dailyBars.length < 2) return null;
  // Second-to-last is the last fully-closed prior day relative to a forming
  // final bar; if caller already trimmed the forming bar, last is fine. We take
  // the last TWO and pick the earlier one to be safe against a forming candle.
  const prev = dailyBars[dailyBars.length - 2];
  return { pdh: prev.high, pdl: prev.low };
}

// ── Volume Profile (rolling window) ─────────────────────────────────────────

/**
 * Compute VAL / POC / VAH over the last `lookback` bars using typical-price
 * volume binning and value-area expansion around the POC.
 *
 * Mirrors the Pine implementation exactly.
 *
 * @param {Array}  bars      OHLC, oldest→newest
 * @param {number} lookback  bars to include (default 400)
 * @param {number} bins      price rows (default 24)
 * @param {number} vaPct     value-area percent (default 70)
 * @returns {{ poc:number, vah:number, val:number, covered:number }|null}
 */
function volumeProfile(bars, lookback = 400, bins = 24, vaPct = 70) {
  const window = bars.slice(-lookback);
  if (window.length < 10) return null;

  let hi = -Infinity, lo = Infinity;
  for (const b of window) { if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; }
  if (!(hi > lo)) return null;

  const binSize = (hi - lo) / bins;
  const vols = new Array(bins).fill(0);
  for (const b of window) {
    const tp = (b.high + b.low) / 2;
    let idx = Math.floor((tp - lo) / binSize);
    if (idx < 0) idx = 0;
    if (idx > bins - 1) idx = bins - 1;
    vols[idx] += b.volume;
  }

  let pocIdx = 0, maxV = -1, total = 0;
  for (let i = 0; i < bins; i++) {
    total += vols[i];
    if (vols[i] > maxV) { maxV = vols[i]; pocIdx = i; }
  }
  if (total <= 0) return null;

  let up = pocIdx + 1, dn = pocIdx - 1, vaTop = pocIdx, vaBot = pocIdx, acc = maxV;
  while (acc < total * vaPct / 100 && (up < bins || dn >= 0)) {
    const upV = up < bins ? vols[up] : -1;
    const dnV = dn >= 0 ? vols[dn] : -1;
    if (upV >= dnV) { acc += upV; vaTop = up; up++; }
    else { acc += dnV; vaBot = dn; dn--; }
  }

  return {
    poc: lo + (pocIdx + 0.5) * binSize,
    vah: lo + (vaTop + 1) * binSize,
    val: lo + vaBot * binSize,
    covered: acc / total * 100,
  };
}

// ── Fair Value Gap (3-candle) ───────────────────────────────────────────────

/**
 * Bullish FVG at index i: bars[i].low > bars[i-2].high.
 * Bearish FVG at index i: bars[i].high < bars[i-2].low.
 * Returns the gap zone or null.
 */
function fvgAt(bars, i) {
  if (i < 2) return null;
  if (bars[i].low > bars[i - 2].high) {
    return { direction: 'bullish', top: bars[i].low, bottom: bars[i - 2].high };
  }
  if (bars[i].high < bars[i - 2].low) {
    return { direction: 'bearish', top: bars[i - 2].low, bottom: bars[i].high };
  }
  return null;
}

// ── Long-side sweep→BOS→FVG→pullback state machine ──────────────────────────
//
// This is the shared engine for Liquidity Sweep and Master. It walks the 5m
// bars for the current session and returns the FIRST armed setup whose pullback
// into the FVG has occurred on the latest bar (so the scanner acts on fresh
// signals only), or null.
//
// options:
//   requireVolumeFilters (Master): declining sweep volume + volume-spike BOS +
//                                   VAL/VAH macro bias + low-volume pullback
//   targetMode: 'rr' (TP = entry ± minRR·risk) | 'poc' (TP = POC/… )
//   minRR, volSpikeX, volLen, vaLevels {val, vah, poc}
//
// Returns { direction, entryPrice, stopLoss, takeProfit, meta } | null

function scanLongShort(bars, pdl, pdh, opts) {
  const {
    requireVolumeFilters = false,
    targetMode = 'rr',
    minRR = 2.5,
    volSpikeX = 1.5,
    volLen = 20,
    vaLevels = null,
  } = opts || {};

  const vols = bars.map((b) => b.volume);
  const lastIdx = bars.length - 1;

  // Run the long machine and the short machine; return whichever fires on the
  // final bar. (A symbol rarely arms both at once.)
  const longSetup = runSide('long', bars, vols, pdl, pdh, lastIdx, {
    requireVolumeFilters, targetMode, minRR, volSpikeX, volLen, vaLevels,
  });
  if (longSetup) return longSetup;

  return runSide('short', bars, vols, pdl, pdh, lastIdx, {
    requireVolumeFilters, targetMode, minRR, volSpikeX, volLen, vaLevels,
  });
}

function runSide(side, bars, vols, pdl, pdh, lastIdx, opts) {
  const { requireVolumeFilters, targetMode, minRR, volSpikeX, volLen, vaLevels } = opts;
  const isLong = side === 'long';

  // States: 0 idle · 1 swept · 2 BOS (waiting FVG) · 3 armed (waiting pullback)
  let state = 0;
  let sweepExtreme = null;   // sweep low (long) / high (short)
  let sweepStruct = null;    // highest high (long) / lowest low (short) of sweep leg
  let bosBar = null;
  let fvgTop = null, fvgBot = null, fvgBar = null;
  let exhaust = false, bias = false;

  const FVG_WAIT = 10;
  const ARMED_BARS = 30;

  for (let i = 1; i <= lastIdx; i++) {
    const b = bars[i];
    const volSma = smaAt(vols, volLen, i);

    // Reset the machine at each new trading day (mirrors Pine's newDay reset):
    // a sweep/BOS/FVG sequence is only valid within a single session relative to
    // the prior day's PDH/PDL.
    if (dayKey(bars[i].time) !== dayKey(bars[i - 1].time)) {
      state = 0;
    }

    if (state === 0) {
      const swept = isLong ? b.low < pdl : b.high > pdh;
      if (swept) {
        state = 1;
        sweepExtreme = isLong ? b.low : b.high;
        sweepStruct = isLong ? b.high : b.low;
        exhaust = b.volume <= vols[i - 1] || b.volume < volSma;
        bias = vaLevels
          ? (isLong ? b.close <= vaLevels.val : b.close >= vaLevels.vah)
          : false;
      }
    } else if (state === 1) {
      sweepExtreme = isLong ? Math.min(sweepExtreme, b.low) : Math.max(sweepExtreme, b.high);
      const bodyBos = isLong
        ? (b.close > sweepStruct && b.close > pdl)
        : (b.close < sweepStruct && b.close < pdh);
      const volSpike = b.volume > volSma * volSpikeX;
      const filtersOk = requireVolumeFilters ? (volSpike && exhaust && bias) : true;
      if (bodyBos && filtersOk) {
        state = 2; bosBar = i;
      } else {
        sweepStruct = isLong ? Math.max(sweepStruct, b.high) : Math.min(sweepStruct, b.low);
        const stillSweeping = isLong ? b.low < pdl : b.high > pdh;
        if (stillSweeping) {
          exhaust = b.volume <= vols[i - 1] || b.volume < volSma;
          bias = bias || (vaLevels
            ? (isLong ? b.close <= vaLevels.val : b.close >= vaLevels.vah)
            : false);
        }
      }
    } else if (state === 2) {
      const gap = fvgAt(bars, i);
      const want = isLong ? 'bullish' : 'bearish';
      if (gap && gap.direction === want) {
        fvgTop = gap.top; fvgBot = gap.bottom; fvgBar = i; state = 3;
      } else if (i - bosBar > FVG_WAIT) {
        state = 0;
      }
    } else if (state === 3 && i > fvgBar) {
      const invalidated = isLong ? b.close < fvgBot : b.close > fvgTop;
      if (invalidated || i - fvgBar > ARMED_BARS) {
        state = 0;
      } else {
        const touched = isLong ? b.low <= fvgTop : b.high >= fvgBot;
        if (touched) {
          const entry = isLong ? fvgTop : fvgBot;
          const risk = isLong ? entry - sweepExtreme : sweepExtreme - entry;
          let target;
          if (targetMode === 'poc' && vaLevels) {
            target = vaLevels.poc;
          } else if (targetMode === 'pdhl') {
            target = isLong ? pdh : pdl;
          } else {
            target = isLong ? entry + minRR * risk : entry - minRR * risk;
          }
          const rr = risk > 0 ? (isLong ? (target - entry) / risk : (entry - target) / risk) : 0;
          const rrOk = rr >= minRR || targetMode === 'poc'; // POC target isn't RR-gated
          const volOk = !requireVolumeFilters || b.volume < volSma;

          // Only act if this pullback happened on the LATEST bar (fresh signal).
          const fresh = i === lastIdx;

          if (rrOk && volOk && fresh && risk > 0 && target != null) {
            return {
              direction: side,
              entryType: 'limit',
              entryPrice: round(entry, 2),
              stopLoss: round(sweepExtreme, 2),
              takeProfit: round(target, 2),
              meta: { rr: round(rr, 2), fvgTop: round(fvgTop, 2), fvgBot: round(fvgBot, 2), sweepBar: bosBar },
            };
          }
          // If RR can never pass for this setup, reset; otherwise a later touch
          // (still same fvg) could qualify — but we only fire fresh, so reset to
          // avoid re-arming stale setups.
          if (!rrOk) state = 0;
        }
      }
    }
  }
  return null;
}

function round(n, dp = 2) { return parseFloat(n.toFixed(dp)); }

/** Date portion of an ISO timestamp (UTC) — used for day-boundary detection. */
function dayKey(t) {
  if (!t) return '';
  const s = String(t);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

module.exports = {
  smaAt, atr, prevDayLevels, volumeProfile, fvgAt, scanLongShort, round,
};
