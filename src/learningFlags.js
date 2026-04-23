/**
 * Phase 2 — Post-close learning flags
 *
 * Called immediately after a trade closes. Returns an array of string flags
 * that capture what happened and whether signals were predictive.
 * These flags feed future weight-adjustment logic in later phases.
 */

/**
 * Generate learning flags for a closed trade.
 *
 * @param {Object} trade  A closed trade record from paper_trades.json
 * @returns {string[]}    Array of flag strings
 */
function attachLearningFlags(trade) {
  const {
    closeReason,
    confidence,
    pnl,
    direction,
    entryPrice,
    stopLoss,
    takeProfit,
    exitPrice,
    signals,
    milestones,
  } = trade;

  const flags = [];

  // ── Outcome ──────────────────────────────────────────────────────────────
  if (closeReason === 'tp')          flags.push('full_tp');
  if (closeReason === 'sl')          flags.push('stopped_out');
  if (closeReason === 'trailing_sl') flags.push('trail_exit');

  if (pnl > 0)  flags.push('winner');
  if (pnl < 0)  flags.push('loser');
  if (pnl === 0) flags.push('breakeven');

  // ── Trail milestone reached ───────────────────────────────────────────────
  if (milestones && milestones.trailActivated) flags.push('trail_1_5r_reached');

  // ── Confidence band ───────────────────────────────────────────────────────
  if (confidence >= 80)                   flags.push('high_confidence');
  else if (confidence >= 60)              flags.push('medium_confidence');
  else                                    flags.push('low_confidence');

  // ── Signal presence ───────────────────────────────────────────────────────
  const summary = signals && signals.tfSummary;
  if (summary) {
    if (summary.some((t) => t.fvgCount   > 0)) flags.push('fvg_present');
    if (summary.some((t) => t.sweepCount > 0)) flags.push('sweep_present');
    if (summary.some((t) => t.bosCount   > 0)) flags.push('bos_present');
    if (summary.some((t) => t.obCount    > 0)) flags.push('ob_present');
  }

  // ── Direction correctness ─────────────────────────────────────────────────
  if (exitPrice != null && entryPrice != null) {
    const move = direction === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice;
    flags.push(move >= 0 ? 'direction_correct' : 'direction_wrong');
  }

  // ── R-multiple achieved ───────────────────────────────────────────────────
  const R = Math.abs(entryPrice - stopLoss);
  if (R > 0 && exitPrice != null) {
    const move       = direction === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice;
    const rMultiple  = parseFloat((move / R).toFixed(2));
    // Store the actual R multiple as a flag (e.g. 'r_+2.00', 'r_-1.00')
    flags.push(`r_${rMultiple >= 0 ? '+' : ''}${rMultiple}`);

    if (rMultiple >= 2)   flags.push('full_r_achieved');
    if (rMultiple >= 1.5) flags.push('trail_r_achieved');
    if (rMultiple >= 1)   flags.push('one_r_achieved');
    if (rMultiple < 0)    flags.push('negative_r');
  }

  // ── Early exit analysis ───────────────────────────────────────────────────
  // Exited profitably but not via TP (trailing stop fired)
  if (closeReason !== 'tp' && pnl > 0)  flags.push('early_exit_profit');
  // Exited at a loss but not via original SL (e.g. shouldn't happen, guard anyway)
  if (closeReason !== 'sl' && pnl < 0)  flags.push('early_exit_loss');

  // ── Signal-outcome correlation hints ─────────────────────────────────────
  // These help weight-adjustment logic know which signals contributed to wins/losses
  if (signals && signals.score) {
    const { bias, breakdown } = signals.score;
    if (bias === direction || (direction === 'long' && bias === 'bullish') || (direction === 'short' && bias === 'bearish')) {
      flags.push('score_bias_matched');
    } else {
      flags.push('score_bias_mismatched');
    }

    // Flag which timeframes contributed the most to the winning side
    if (breakdown) {
      const dominant = direction === 'long' ? 'bullishScore' : 'bearishScore';
      const topTF = breakdown
        .slice()
        .sort((a, b) => b[dominant] - a[dominant])
        .slice(0, 2)
        .map((b) => `top_tf_${b.timeframe.toLowerCase()}`);
      flags.push(...topTF);
    }
  }

  return flags;
}

module.exports = { attachLearningFlags };
