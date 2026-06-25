/**
 * Phase 2 — Trading engine orchestrator
 *
 * Two public functions:
 *   scanSymbol(params)           → full entry pipeline for one symbol
 *   monitorTrades(symbols, map)  → price-check all open trades, fire close logic
 */

const { fetchOHLC }           = require('./ohlc');
const { detectAllTimeframes } = require('./signals');
const { scoreSignals }        = require('./scoring');
const { enterTrade }          = require('./tradeEntry');
const { processOpenTrades }   = require('./tradeClose');

// Timeframes fetched for analysis (1M is too noisy for signal detection;
// used only for current-price reads during monitoring).
const ANALYSIS_TIMEFRAMES = ['5M', '15M', '1H', '4H', '1D'];

// ── OHLC multi-fetch ──────────────────────────────────────────────────────────

/**
 * Fetch OHLC bars for all analysis timeframes concurrently.
 * Tolerates partial failures — missing timeframes are skipped.
 *
 * @returns {{ barsMap: Object, errors: Array }}
 */
async function fetchAllTimeframes(symbol, marketType) {
  const barsMap = {};
  const errors  = [];

  await Promise.allSettled(
    ANALYSIS_TIMEFRAMES.map(async (tf) => {
      try {
        barsMap[tf] = await fetchOHLC(symbol, marketType, tf);
      } catch (err) {
        errors.push({ tf, error: err.message });
      }
    })
  );

  return { barsMap, errors };
}

// ── Entry pipeline ────────────────────────────────────────────────────────────

/**
 * Full scan-and-enter pipeline for a single symbol.
 *
 * @param {Object} params
 * @param {string}  params.symbol        Base symbol (e.g. 'AAPL', 'BTC', 'EURUSD')
 * @param {string}  params.marketType    'stocks' | 'crypto' | 'futures' | 'forex' | 'metals'
 * @param {number}  params.stopLossPrice Stop-loss price (required for sizing)
 * @param {string}  [params.direction]   'long' | 'short' — inferred from bias if omitted
 * @param {number}  [params.riskPct=0.01] Risk fraction (0.01–0.03)
 *
 * @returns {Promise<Object>}  Entry result — see tradeEntry.enterTrade() return shape
 */
async function scanSymbol({ symbol, marketType, stopLossPrice, direction, riskPct = 0.01 }) {
  console.log(`[Engine] Scanning ${symbol} (${marketType})…`);

  // ── 1. Fetch OHLC ──────────────────────────────────────────────────────────
  const { barsMap, errors } = await fetchAllTimeframes(symbol, marketType);

  if (errors.length > 0) {
    console.warn(`[Engine] Fetch errors for ${symbol}:`, errors.map((e) => `${e.tf}: ${e.error}`).join(', '));
  }

  if (Object.keys(barsMap).length === 0) {
    return { entered: false, reason: 'No OHLC data fetched', errors };
  }

  // ── 2. Detect signals on all available timeframes ─────────────────────────
  const tfResults = detectAllTimeframes(barsMap);

  // ── 3. Score (needed for direction inference) ─────────────────────────────
  const score = scoreSignals(tfResults);

  // ── 4. Resolve entry price from most granular fetched bars ────────────────
  const ltfBars    = barsMap['5M'] ?? barsMap['15M'] ?? barsMap['1H'];
  const entryPrice = ltfBars[ltfBars.length - 1].close;

  // ── 5. Infer direction from bias if not supplied ──────────────────────────
  // Crypto cannot be shorted on Alpaca paper — always long for crypto
  const resolvedDirection = marketType === 'crypto'
    ? 'long'
    : (direction ?? (score.bias === 'bearish' ? 'short' : 'long'));

  if (!stopLossPrice) {
    return {
      entered: false,
      reason:  'stopLossPrice is required for position sizing',
      score,
      entryPrice,
      resolvedDirection,
      hint: `Detected entry ~${entryPrice}, bias: ${score.bias}. Supply stopLossPrice below (long) or above (short) entry.`,
    };
  }

  // ── 6. Run gates + enter trade ────────────────────────────────────────────
  const result = await enterTrade({
    symbol,
    marketType,
    direction:     resolvedDirection,
    entryPrice,
    stopLossPrice,
    tfResults,
    riskPct,
  });

  return { ...result, entryPrice, score, resolvedDirection, tfResults, fetchErrors: errors };
}

// ── Monitor loop ──────────────────────────────────────────────────────────────

/**
 * Fetch current prices for a list of symbols and run the close-check on all
 * open paper trades.
 *
 * @param {string[]} symbols         Symbols to get live prices for.
 * @param {Object}   [marketTypeMap] { SYMBOL: marketType } — defaults to 'stocks'.
 *
 * @returns {Promise<Array>}  Action results from processOpenTrades().
 */
async function monitorTrades(symbols, marketTypeMap = {}) {
  const currentPrices = {};

  await Promise.allSettled(
    symbols.map(async (symbol) => {
      const marketType = marketTypeMap[symbol] ?? 'stocks';
      try {
        const bars = await fetchOHLC(symbol, marketType, '1M');
        currentPrices[symbol.toUpperCase()] = bars[bars.length - 1].close;
      } catch (err) {
        console.warn(`[Engine] Price fetch failed for ${symbol}: ${err.message}`);
      }
    })
  );

  return processOpenTrades(currentPrices);
}

module.exports = { scanSymbol, monitorTrades, fetchAllTimeframes };
