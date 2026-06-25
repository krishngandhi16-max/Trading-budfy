/**
 * Phase 4 — 90-day self-tuning backtest engine
 *
 * Processes symbols in batches of 100 (sequentially within each batch to
 * respect Yahoo Finance rate limits). For each symbol:
 *   1. Fetch 6 months of 1D bars (covers ~90 trading days)
 *   2. Slide a 30-bar detection window across the history
 *   3. At each step, detect ICT signals + score → simulate entry
 *   4. Simulate TP / SL resolution on subsequent bars
 *
 * After all batches, the self-tuner adjusts weights.json so that signal
 * types that correlated with wins get a higher weight, and those correlated
 * with losses get a lower weight (conservative 30% learning rate, clamped
 * to [5, 50] per signal weight).
 *
 * Results are appended to data/shadow_backtest.json.
 */

const fs   = require('fs');
const path = require('path');

const yahooFinance        = require('yahoo-finance2').default;
const { buildTicker }     = require('./ohlc');
const { detectFVG, detectSweep, detectBOS, detectOB } = require('./signals');
const { scoreSignals, loadWeights, DEFAULT_WEIGHTS }  = require('./scoring');

const BACKTEST_PATH = path.resolve(__dirname, '../data/shadow_backtest.json');
const WEIGHTS_PATH  = path.resolve(__dirname, '../data/weights.json');

const BATCH_SIZE       = 100;
const SIGNAL_WINDOW    = 30;   // bars of history used for signal detection at each step
const MIN_CONFIDENCE   = 60;
const VIRTUAL_BALANCE  = 100_000;
const RISK_PCT         = 0.01;
const MAX_HOLD_BARS    = 30;   // max bars to wait for TP/SL resolution
const FETCH_DELAY_MS   = 120;  // polite delay between Yahoo Finance calls
const LEARNING_RATE    = 0.30;
const WEIGHT_MIN       = 5;
const WEIGHT_MAX       = 50;

// ── OHLC fetch ────────────────────────────────────────────────────────────────

async function fetchHistoricalBars(symbol, marketType) {
  const ticker = buildTicker(symbol, marketType);
  const result = await yahooFinance.chart(ticker, { interval: '1d', range: '6mo' });

  if (!result?.quotes?.length) {
    throw new Error(`No historical data for ${ticker}`);
  }

  return result.quotes
    .filter((q) => q.open != null && q.close != null)
    .map((q) => ({
      time:   q.date instanceof Date ? q.date.toISOString() : String(q.date),
      open:   q.open,
      high:   q.high,
      low:    q.low,
      close:  q.close,
      volume: q.volume ?? 0,
    }));
}

// ── Single-bar signal snapshot ────────────────────────────────────────────────

/**
 * Detect signals on a rolling window of bars ending at index i.
 * Returns a scored result plus a signal-presence map for self-tuning.
 */
function snapshotAt(allBars, i) {
  const windowStart = Math.max(0, i - SIGNAL_WINDOW);
  const bars        = allBars.slice(windowStart, i);
  if (bars.length < 5) return null;

  const tfResult = {
    timeframe: '1D',
    fvg:   detectFVG(bars),
    sweep: detectSweep(bars),
    bos:   detectBOS(bars),
    ob:    detectOB(bars),
  };

  const scored = scoreSignals([tfResult]);

  // Track which signal types were active (any signal in the window)
  const presence = {
    FVG:   tfResult.fvg.length   > 0,
    Sweep: tfResult.sweep.length > 0,
    BOS:   tfResult.bos.length   > 0,
    OB:    tfResult.ob.length    > 0,
  };

  return { ...scored, presence };
}

// ── Symbol simulation ─────────────────────────────────────────────────────────

/**
 * Simulate paper trades on a historical bar series for one symbol.
 * Returns an array of completed (tp/sl) trade records.
 */
function simulateSymbol(symbol, bars) {
  const trades       = [];
  let virtualBalance = VIRTUAL_BALANCE;
  let peakBalance    = VIRTUAL_BALANCE;
  let i              = SIGNAL_WINDOW;

  while (i < bars.length - 1) {
    const snapshot = snapshotAt(bars, i);
    if (!snapshot || snapshot.confidence < MIN_CONFIDENCE || snapshot.bias === 'neutral') {
      i++;
      continue;
    }

    const direction  = snapshot.bias === 'bearish' ? 'short' : 'long';
    const entryBar   = bars[i];
    const entryPrice = entryBar.open;

    // Stop loss at prior bar's extreme
    const stopPrice = direction === 'long'
      ? bars[i - 1].low
      : bars[i - 1].high;

    // Validate SL is on correct side and not degenerate
    if (stopPrice <= 0 || stopPrice === entryPrice) { i++; continue; }
    if (direction === 'long'  && stopPrice >= entryPrice) { i++; continue; }
    if (direction === 'short' && stopPrice <= entryPrice) { i++; continue; }

    const riskPerUnit = Math.abs(entryPrice - stopPrice);
    const riskAmount  = virtualBalance * RISK_PCT;
    const quantity    = riskAmount / riskPerUnit;
    const takeProfit  = direction === 'long'
      ? entryPrice + 2 * riskPerUnit
      : entryPrice - 2 * riskPerUnit;

    // Walk forward to find resolution
    let outcome   = null;
    let exitPrice = null;
    let exitIdx   = null;

    for (let j = i + 1; j < Math.min(i + MAX_HOLD_BARS + 1, bars.length); j++) {
      const bar = bars[j];
      if (direction === 'long') {
        if (bar.low  <= stopPrice)  { outcome = 'sl'; exitPrice = stopPrice;  exitIdx = j; break; }
        if (bar.high >= takeProfit) { outcome = 'tp'; exitPrice = takeProfit; exitIdx = j; break; }
      } else {
        if (bar.high >= stopPrice)  { outcome = 'sl'; exitPrice = stopPrice;  exitIdx = j; break; }
        if (bar.low  <= takeProfit) { outcome = 'tp'; exitPrice = takeProfit; exitIdx = j; break; }
      }
    }

    if (!outcome) { i++; continue; } // unresolved within window — skip

    const move = direction === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice;
    const pnl  = parseFloat((move * quantity).toFixed(2));
    const R    = parseFloat((move / riskPerUnit).toFixed(2));

    virtualBalance = parseFloat((virtualBalance + pnl).toFixed(2));
    peakBalance    = Math.max(peakBalance, virtualBalance);

    trades.push({
      symbol,
      barIndex:   i,
      entryTime:  entryBar.time,
      exitTime:   bars[exitIdx].time,
      direction,
      entryPrice,
      stopPrice,
      takeProfit,
      exitPrice,
      outcome,
      pnl,
      R,
      confidence: snapshot.confidence,
      bias:       snapshot.bias,
      presence:   snapshot.presence,   // { FVG, Sweep, BOS, OB } booleans
    });

    // Advance past the exit bar to avoid overlapping trades
    i = exitIdx + 1;
  }

  const wins   = trades.filter((t) => t.outcome === 'tp').length;
  const losses = trades.filter((t) => t.outcome === 'sl').length;
  const totalR = trades.reduce((s, t) => s + t.R, 0);

  return {
    symbol,
    trades,
    summary: {
      count:         trades.length,
      wins,
      losses,
      winRate:       trades.length ? parseFloat((wins / trades.length).toFixed(4)) : 0,
      avgR:          trades.length ? parseFloat((totalR / trades.length).toFixed(3)) : 0,
      profitFactor:  computeProfitFactor(trades),
      finalBalance:  virtualBalance,
      maxDrawdown:   parseFloat(((peakBalance - virtualBalance) / peakBalance).toFixed(4)),
    },
  };
}

function computeProfitFactor(trades) {
  const grossWin  = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  return grossLoss === 0 ? (grossWin > 0 ? Infinity : 1) : parseFloat((grossWin / grossLoss).toFixed(3));
}

// ── Weight self-tuner ─────────────────────────────────────────────────────────

/**
 * Compute new weights from backtest results using a bounded learning rule.
 *
 * For each signal type, compare the win rate of trades where it was present
 * against the overall win rate. If the signal predicts wins better than
 * average, its weight increases; if worse, it decreases.
 *
 * Learning rate is capped at 30% per run and weights are clamped to [5, 50].
 */
function tuneWeights(allTrades, currentWeights) {
  const totalTrades = allTrades.length;
  if (totalTrades < 10) return currentWeights; // not enough data

  const totalWins   = allTrades.filter((t) => t.outcome === 'tp').length;
  const baseWinRate = totalWins / totalTrades;
  if (baseWinRate === 0) return currentWeights;

  const SIGNAL_KEYS = ['FVG', 'Sweep', 'BOS', 'OB'];
  const updated     = JSON.parse(JSON.stringify(currentWeights));

  for (const key of SIGNAL_KEYS) {
    const withSignal    = allTrades.filter((t) => t.presence?.[key]);
    const winsWithSig   = withSignal.filter((t) => t.outcome === 'tp').length;
    const winRateWith   = withSignal.length ? winsWithSig / withSignal.length : baseWinRate;

    // ratio > 1 → signal predicts wins better than average
    const ratio      = winRateWith / baseWinRate;
    const adjustment = 1 + LEARNING_RATE * (ratio - 1);

    const clamp = (v) => Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, parseFloat(v.toFixed(2))));

    if (updated[key]) {
      updated[key].bullish = clamp(currentWeights[key].bullish * adjustment);
      updated[key].bearish = clamp(currentWeights[key].bearish * adjustment);
    }
  }

  return updated;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function readBacktestHistory() {
  try { return JSON.parse(fs.readFileSync(BACKTEST_PATH, 'utf8')); }
  catch { return []; }
}

function appendBacktestRun(run) {
  const history = readBacktestHistory();
  history.push(run);
  // Keep last 20 runs to prevent unbounded growth
  const trimmed = history.slice(-20);
  fs.writeFileSync(BACKTEST_PATH, JSON.stringify(trimmed, null, 2));
}

function saveWeights(weights) {
  fs.writeFileSync(WEIGHTS_PATH, JSON.stringify(weights, null, 2));
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the 90-day backtest on an array of symbols, batched in groups of 100.
 *
 * @param {Array<{symbol: string, marketType: string}>} symbols
 * @param {Object} [opts]
 * @param {boolean} [opts.tune=true]    Write updated weights to weights.json
 * @param {boolean} [opts.save=true]    Append run to shadow_backtest.json
 * @returns {Promise<Object>}           Run summary
 */
async function runBacktest(symbols, opts = {}) {
  const { tune = true, save = true } = opts;
  const runId    = `bt_${Date.now()}`;
  const startedAt = new Date().toISOString();

  console.log(`[Backtest] Starting run ${runId} — ${symbols.length} symbols in batches of ${BATCH_SIZE}`);

  const allTrades       = [];
  const symbolResults   = [];
  const errors          = [];
  const currentWeights  = loadWeights();

  // Process in batches of BATCH_SIZE
  for (let batchStart = 0; batchStart < symbols.length; batchStart += BATCH_SIZE) {
    const batch    = symbols.slice(batchStart, batchStart + BATCH_SIZE);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
    const batchOf  = Math.ceil(symbols.length / BATCH_SIZE);

    console.log(`[Backtest] Batch ${batchNum}/${batchOf} — ${batch.length} symbols`);

    for (const { symbol, marketType } of batch) {
      try {
        const bars   = await fetchHistoricalBars(symbol, marketType);
        const result = simulateSymbol(symbol, bars);

        allTrades.push(...result.trades);
        symbolResults.push({ symbol, marketType, ...result.summary });

      } catch (err) {
        errors.push({ symbol, error: err.message });
        console.warn(`[Backtest] Skipped ${symbol}: ${err.message}`);
      }

      // Polite delay between Yahoo Finance calls
      await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
    }
  }

  // Aggregate stats across all symbols
  const totalTrades = allTrades.length;
  const totalWins   = allTrades.filter((t) => t.outcome === 'tp').length;
  const totalLosses = allTrades.filter((t) => t.outcome === 'sl').length;
  const allR        = allTrades.map((t) => t.R);
  const avgR        = totalTrades ? parseFloat((allR.reduce((s, r) => s + r, 0) / totalTrades).toFixed(3)) : 0;

  // Self-tune weights
  let weightsAfter = currentWeights;
  if (tune && totalTrades >= 10) {
    weightsAfter = tuneWeights(allTrades, currentWeights);
    saveWeights(weightsAfter);
    console.log('[Backtest] Weights updated after self-tuning');
  }

  const run = {
    runId,
    startedAt,
    completedAt:   new Date().toISOString(),
    symbolCount:   symbols.length,
    errored:       errors.length,
    totalTrades,
    totalWins,
    totalLosses,
    winRate:       totalTrades ? parseFloat((totalWins / totalTrades).toFixed(4)) : 0,
    avgR,
    profitFactor:  computeProfitFactor(allTrades),
    weightsBefore: currentWeights,
    weightsAfter,
    symbolResults,
    errors,
  };

  if (save) appendBacktestRun(run);

  console.log(`[Backtest] Run ${runId} complete — ${totalTrades} trades, win rate ${(run.winRate * 100).toFixed(1)}%, avg R ${avgR}`);

  return run;
}

module.exports = { runBacktest, simulateSymbol, tuneWeights, fetchHistoricalBars, BATCH_SIZE };
