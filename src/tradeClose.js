/**
 * Phase 2/3 — Auto-close logic
 *
 * Three close triggers (checked in priority order per trade):
 *   1. TP hit (price reaches takeProfit)          → close at full 2R profit
 *   2. SL hit (price reaches active stop)         → close at loss or breakeven
 *   3. +1.5R milestone crossed (not yet trailed)  → move SL to entry (breakeven),
 *                                                    keep trade open
 *
 * Trailing-stop lifecycle:
 *   open  →  [price hits +1.5R]  →  SL moves to entry (breakeven)
 *         →  [price hits +2R=TP] →  trade closes at full profit
 *         →  [price pulls back to entry after trail] → closes at breakeven
 *
 * Phase 3 addition: broker close is fired (best-effort) for every local close.
 */

const { pool }                              = require('./db');
const { readPaperTrades, writePaperTrades } = require('./tradeEntry');
const { attachLearningFlags }               = require('./learningFlags');
const broker                                = require('./brokers/router');

// ── Math helpers ──────────────────────────────────────────────────────────────

function round(n, dp = 2) {
  return parseFloat(n.toFixed(dp));
}

/**
 * Compute realised PnL for a trade given an exit price.
 */
function computePnl(trade, exitPrice) {
  const move = trade.direction === 'long'
    ? exitPrice - trade.entryPrice
    : trade.entryPrice - exitPrice;
  return round(move * trade.quantity, 2);
}

// ── Single-trade evaluation ───────────────────────────────────────────────────

/**
 * Evaluate a single open trade against current price.
 *
 * @returns {{
 *   hitTP:              boolean,
 *   hitSL:              boolean,
 *   shouldActivateTrail: boolean,  // +1.5R crossed and trail not yet active
 *   activeSL:           number,    // current effective stop (original or entry)
 * }}
 */
function evaluateTrade(trade, currentPrice) {
  const { direction, entryPrice, stopLoss, takeProfit, trailingSL, milestones } = trade;
  const trailActive = milestones && milestones.trailActivated;

  // Active SL is entryPrice once trail fires, otherwise the stored trailingSL
  // (which starts equal to the original stop loss).
  const activeSL = trailActive ? entryPrice : (trailingSL ?? stopLoss);

  // TP hit
  const hitTP = direction === 'long'
    ? currentPrice >= takeProfit
    : currentPrice <= takeProfit;

  // SL / trail-SL hit
  const hitSL = direction === 'long'
    ? currentPrice <= activeSL
    : currentPrice >= activeSL;

  // +1.5R level (milestone to activate trailing stop)
  const R         = trade.riskPerUnit;
  const level1_5R = direction === 'long'
    ? entryPrice + 1.5 * R
    : entryPrice - 1.5 * R;

  const at1_5R = direction === 'long'
    ? currentPrice >= level1_5R
    : currentPrice <= level1_5R;

  const shouldActivateTrail = at1_5R && !trailActive;

  return { hitTP, hitSL, shouldActivateTrail, activeSL };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function dbCloseTrade(dbId, exitPrice, pnl, closeReason, learningFlags) {
  if (!dbId) return;
  try {
    await pool.query(`
      UPDATE trades
      SET  status        = 'closed',
           exit_price    = $1,
           closed_at     = NOW(),
           pnl           = $2,
           close_reason  = $3,
           learning_flags = $4
      WHERE id = $5
    `, [exitPrice, pnl, closeReason, JSON.stringify(learningFlags), dbId]);
  } catch (err) {
    console.warn('[tradeClose] DB close update failed:', err.message);
  }
}

async function dbActivateTrail(dbId, entryPrice) {
  if (!dbId) return;
  try {
    await pool.query(
      'UPDATE trades SET trailing_sl = $1 WHERE id = $2',
      [entryPrice, dbId]
    );
  } catch (err) {
    console.warn('[tradeClose] DB trail update failed:', err.message);
  }
}

async function dbUpdateAccountBalance(pnl) {
  try {
    await pool.query(`
      UPDATE pt_account
      SET  balance    = balance + $1,
           equity     = equity  + $1,
           updated_at = NOW()
      WHERE id = (SELECT id FROM pt_account ORDER BY id DESC LIMIT 1)
    `, [pnl]);
  } catch (err) {
    console.warn('[tradeClose] Account balance update failed:', err.message);
  }
}

// ── Close action ──────────────────────────────────────────────────────────────

/**
 * Mutates allTrades[idx] to closed state and persists to disk + DB.
 * Also fires a best-effort broker position close (Phase 3).
 */
async function closeTrade(trade, idx, allTrades, exitPrice, reason) {
  const pnl         = computePnl(trade, exitPrice);
  const closedTrade = {
    ...trade,
    status:       'closed',
    exitPrice,
    closedAt:     new Date().toISOString(),
    pnl,
    closeReason:  reason,
  };
  closedTrade.learningFlags = attachLearningFlags(closedTrade);

  allTrades[idx] = closedTrade;
  writePaperTrades(allTrades);

  await dbCloseTrade(trade.dbId, exitPrice, pnl, reason, closedTrade.learningFlags);
  await dbUpdateAccountBalance(pnl);

  // Phase 3: close at broker (best-effort, phantom_cleanup skips broker)
  if (reason !== 'phantom_cleanup') {
    broker.closePosition(trade.symbol, trade.marketType).catch((err) =>
      console.warn(`[tradeClose] Broker close failed for ${trade.symbol}: ${err.message}`)
    );
  }

  return closedTrade;
}

// ── Trail activation ──────────────────────────────────────────────────────────

/**
 * Move the trailing SL to entry (breakeven) when +1.5R is reached.
 * Mutates allTrades[idx] and persists.
 */
async function activateTrailingStop(trade, idx, allTrades) {
  const updated = {
    ...trade,
    trailingSL: trade.entryPrice,
    milestones: { ...trade.milestones, trailActivated: true },
  };
  allTrades[idx] = updated;
  writePaperTrades(allTrades);

  await dbActivateTrail(trade.dbId, trade.entryPrice);

  return updated;
}

// ── Main monitor loop ─────────────────────────────────────────────────────────

/**
 * Process all open trades against current market prices.
 *
 * @param {Object} currentPrices  Map of UPPER-CASE symbol → latest price.
 *                                e.g. { 'AAPL': 152.50, 'BTC-USD': 43000 }
 * @returns {Promise<Array>}      Array of action results per trade.
 */
async function processOpenTrades(currentPrices) {
  const allTrades = readPaperTrades();
  const results   = [];

  for (let i = 0; i < allTrades.length; i++) {
    const trade = allTrades[i];
    if (trade.status !== 'open') continue;

    // Resolve symbol key — try exact, then uppercased
    const sym          = trade.symbol.toUpperCase();
    const currentPrice = currentPrices[sym] ?? currentPrices[trade.symbol];

    if (currentPrice == null) {
      results.push({ symbol: trade.symbol, action: 'skipped', reason: 'no_price_data' });
      continue;
    }

    const { hitTP, hitSL, shouldActivateTrail, activeSL } = evaluateTrade(trade, currentPrice);

    // Priority 1: TP
    if (hitTP) {
      const closed = await closeTrade(trade, i, allTrades, trade.takeProfit, 'tp');
      results.push({
        symbol: trade.symbol,
        action: 'closed',
        reason: 'tp',
        exitPrice: closed.exitPrice,
        pnl:       closed.pnl,
        flags:     closed.learningFlags,
      });
      continue;
    }

    // Priority 2: SL (or trailing SL at breakeven)
    if (hitSL) {
      const reason = (trade.milestones && trade.milestones.trailActivated)
        ? 'trailing_sl'
        : 'sl';
      const closed = await closeTrade(trade, i, allTrades, activeSL, reason);
      results.push({
        symbol: trade.symbol,
        action: 'closed',
        reason,
        exitPrice: closed.exitPrice,
        pnl:       closed.pnl,
        flags:     closed.learningFlags,
      });
      continue;
    }

    // Priority 3: Activate trail at +1.5R
    if (shouldActivateTrail) {
      const updated = await activateTrailingStop(trade, i, allTrades);
      results.push({
        symbol:     trade.symbol,
        action:     'trail_activated',
        newSL:      updated.trailingSL,
        currentPrice,
      });
      continue;
    }

    // No action — trade is open and monitoring
    results.push({
      symbol: trade.symbol,
      action: 'monitoring',
      currentPrice,
      trailActive: !!(trade.milestones && trade.milestones.trailActivated),
    });
  }

  return results;
}

module.exports = {
  processOpenTrades,
  evaluateTrade,
  computePnl,
  activateTrailingStop,
};
