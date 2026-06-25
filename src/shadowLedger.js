/**
 * Phase 4 — Shadow A/B Ledger
 *
 * Side-by-side parallel paper ledger that runs HIGHER standards than the
 * main trading engine:
 *
 *   Dimension          Main (A)        Shadow (B)
 *   ─────────────────  ──────────────  ──────────────────────────────
 *   Confidence min     60 %            80 %
 *   Risk range         1–3 %           1.5–3 %
 *   Broker mirror      yes (Phase 3)   NO — paper only
 *   Gate checks        all 13          confidence + drawdown only
 *
 * Purpose: test whether tighter conviction improves outcomes before
 * promoting settings to the main engine.
 *
 * Shadow trades go to data/shadow_trades.json.
 * Comparison report is written to data/insights.json.
 */

const fs   = require('fs');
const path = require('path');

const { scoreSignals }   = require('./scoring');
const { calculatePosition } = require('./position');

const SHADOW_PATH   = path.resolve(__dirname, '../data/shadow_trades.json');
const INSIGHTS_PATH = path.resolve(__dirname, '../data/insights.json');

// ── Shadow constants ──────────────────────────────────────────────────────────

const SHADOW_MIN_CONFIDENCE  = 80;   // higher bar than main (60)
const SHADOW_MIN_RISK_PCT    = 0.015;
const SHADOW_MAX_RISK_PCT    = 0.03;
const SHADOW_VIRTUAL_BALANCE = 100_000; // independent virtual account
const SHADOW_MAX_OPEN        = 3;
const SHADOW_MAX_DRAWDOWN    = 0.06;

// ── File helpers ──────────────────────────────────────────────────────────────

function readShadowTrades() {
  try { return JSON.parse(fs.readFileSync(SHADOW_PATH, 'utf8')); }
  catch { return []; }
}

function writeShadowTrades(trades) {
  fs.writeFileSync(SHADOW_PATH, JSON.stringify(trades, null, 2));
}

function readInsights() {
  try { return JSON.parse(fs.readFileSync(INSIGHTS_PATH, 'utf8')); }
  catch { return []; }
}

function writeInsights(data) {
  fs.writeFileSync(INSIGHTS_PATH, JSON.stringify(data, null, 2));
}

// ── Shadow account state (derived from shadow_trades.json) ────────────────────

function shadowAccountStats() {
  const trades  = readShadowTrades();
  const closed  = trades.filter((t) => t.status === 'closed');
  const open    = trades.filter((t) => t.status === 'open');

  const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const balance  = parseFloat((SHADOW_VIRTUAL_BALANCE + totalPnl).toFixed(2));

  // Track peak balance for drawdown calc
  let running = SHADOW_VIRTUAL_BALANCE;
  let peak    = SHADOW_VIRTUAL_BALANCE;
  for (const t of closed.sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt))) {
    running += (t.pnl || 0);
    if (running > peak) peak = running;
  }
  const drawdown = peak > 0 ? (peak - running) / peak : 0;

  return { balance, peak, drawdown, openCount: open.length, closed: closed.length };
}

// ── Shadow entry gate (lightweight — confidence + drawdown only) ───────────────

/**
 * Shadow-specific gate check. Deliberately lighter than the 13-gate main
 * engine because we want the shadow to be ruled purely by conviction level.
 */
function shadowGates(score, stats) {
  if (score.bias === 'neutral') {
    return { passed: false, reason: 'neutral bias' };
  }
  if (score.confidence < SHADOW_MIN_CONFIDENCE) {
    return { passed: false, reason: `confidence ${score.confidence}% < ${SHADOW_MIN_CONFIDENCE}%` };
  }
  if (stats.openCount >= SHADOW_MAX_OPEN) {
    return { passed: false, reason: `shadow open trades at cap (${stats.openCount})` };
  }
  if (stats.drawdown >= SHADOW_MAX_DRAWDOWN) {
    return { passed: false, reason: `shadow drawdown ${(stats.drawdown * 100).toFixed(1)}% >= 6%` };
  }
  return { passed: true, reason: 'ok' };
}

// ── Main: evaluate and optionally enter a shadow trade ───────────────────────

/**
 * Evaluate whether a shadow B trade should be opened.
 * If it qualifies, the trade is appended to shadow_trades.json.
 * NO broker call is ever made.
 *
 * @param {string}  symbol
 * @param {string}  marketType
 * @param {number}  entryPrice
 * @param {number}  stopLossPrice
 * @param {Array}   tfResults      Output of detectAllTimeframes()
 * @param {number}  [riskPct]      Clamped to [1.5%, 3%]
 * @returns {{ entered: boolean, reason?: string, trade?: Object, score: Object }}
 */
function evaluateShadow({ symbol, marketType, entryPrice, stopLossPrice, tfResults, riskPct = SHADOW_MIN_RISK_PCT }) {
  const score = scoreSignals(tfResults);
  const stats = shadowAccountStats();
  const gate  = shadowGates(score, stats);

  if (!gate.passed) {
    return { entered: false, reason: gate.reason, score };
  }

  const direction = score.bias === 'bearish' ? 'short' : 'long';

  let position;
  try {
    const clampedRisk = Math.max(SHADOW_MIN_RISK_PCT, Math.min(SHADOW_MAX_RISK_PCT, riskPct));
    position = calculatePosition({
      accountBalance: stats.balance,
      entryPrice,
      stopLossPrice,
      direction,
      riskPct:        clampedRisk,
    });
  } catch (err) {
    return { entered: false, reason: `sizing error: ${err.message}`, score };
  }

  const trade = {
    ledger:      'shadow_B',
    symbol,
    marketType,
    direction,
    entryPrice,
    stopLoss:    position.stopLoss,
    takeProfit:  position.takeProfit,
    trailingSL:  position.stopLoss,
    quantity:    position.quantity,
    riskAmount:  position.riskAmount,
    riskPct:     position.riskPct,
    riskPerUnit: position.riskPerUnit,
    confidence:  score.confidence,
    bias:        score.bias,
    status:      'open',
    openedAt:    new Date().toISOString(),
    closedAt:    null,
    exitPrice:   null,
    pnl:         null,
    closeReason: null,
    milestones:  { trailActivated: false },
  };

  const all = readShadowTrades();
  all.push(trade);
  writeShadowTrades(all);

  return { entered: true, trade, score, position };
}

// ── Shadow close ──────────────────────────────────────────────────────────────

/**
 * Close a shadow trade by index in shadow_trades.json.
 * Finds the trade by symbol + openedAt timestamp.
 */
function closeShadowTrade(symbol, openedAt, exitPrice, reason) {
  const all = readShadowTrades();
  const idx = all.findIndex((t) => t.symbol === symbol && t.openedAt === openedAt && t.status === 'open');
  if (idx === -1) return { closed: false, reason: 'trade not found' };

  const trade = all[idx];
  const move  = trade.direction === 'long'
    ? exitPrice - trade.entryPrice
    : trade.entryPrice - exitPrice;
  const pnl   = parseFloat((move * trade.quantity).toFixed(2));

  all[idx] = {
    ...trade,
    status:      'closed',
    exitPrice,
    pnl,
    closeReason: reason,
    closedAt:    new Date().toISOString(),
  };

  writeShadowTrades(all);
  return { closed: true, pnl, trade: all[idx] };
}

// ── A/B comparison report ─────────────────────────────────────────────────────

/**
 * Compare main-ledger (paper_trades.json) vs shadow-ledger stats and write
 * a comparison report to data/insights.json.
 *
 * @param {Array} mainTrades   Paper trades from readPaperTrades()
 * @returns {Object}           Comparison report
 */
function compareAB(mainTrades) {
  const shadowTrades = readShadowTrades();

  function stats(trades, label) {
    const closed = trades.filter((t) => t.status === 'closed');
    if (!closed.length) return { label, count: 0 };

    const wins        = closed.filter((t) => t.pnl > 0).length;
    const totalPnl    = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    const avgConfidence = parseFloat((closed.reduce((s, t) => s + (t.confidence || 0), 0) / closed.length).toFixed(1));

    return {
      label,
      count:       closed.length,
      wins,
      losses:      closed.length - wins,
      winRate:     parseFloat((wins / closed.length).toFixed(4)),
      totalPnl:    parseFloat(totalPnl.toFixed(2)),
      avgConfidence,
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    A: stats(mainTrades, 'main_paper'),
    B: stats(shadowTrades, 'shadow_B'),
    verdict: null,
  };

  // Verdict: which ledger is performing better?
  if (report.A.count > 0 && report.B.count > 0) {
    const aScore = report.A.winRate * 0.5 + (report.A.totalPnl > 0 ? 0.5 : 0);
    const bScore = report.B.winRate * 0.5 + (report.B.totalPnl > 0 ? 0.5 : 0);
    report.verdict = bScore > aScore
      ? 'shadow_B outperforming — consider raising main confidence threshold'
      : aScore > bScore
        ? 'main_A outperforming — shadow threshold may be too restrictive'
        : 'ledgers performing equally';
  }

  // Prepend to insights (keep last 50 snapshots)
  const insights = readInsights();
  insights.unshift(report);
  writeInsights(insights.slice(0, 50));

  return report;
}

// ── Shadow monitor (price-check open shadow trades) ───────────────────────────

/**
 * Run TP / SL / trail checks on all open shadow trades.
 * Mirrors the logic in tradeClose.js but stays entirely within shadow JSON.
 *
 * @param {Object} currentPrices  { SYMBOL: price }
 * @returns {Array}  Actions taken
 */
function monitorShadowTrades(currentPrices) {
  const all     = readShadowTrades();
  const results = [];

  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    if (t.status !== 'open') continue;

    const price = currentPrices[t.symbol.toUpperCase()] ?? currentPrices[t.symbol];
    if (price == null) { results.push({ symbol: t.symbol, action: 'skipped' }); continue; }

    const trailActive = t.milestones?.trailActivated;
    const activeSL    = trailActive ? t.entryPrice : (t.trailingSL ?? t.stopLoss);
    const R           = t.riskPerUnit;
    const level1_5R   = t.direction === 'long' ? t.entryPrice + 1.5 * R : t.entryPrice - 1.5 * R;

    const hitTP    = t.direction === 'long' ? price >= t.takeProfit : price <= t.takeProfit;
    const hitSL    = t.direction === 'long' ? price <= activeSL     : price >= activeSL;
    const at1_5R   = t.direction === 'long' ? price >= level1_5R    : price <= level1_5R;

    if (hitTP) {
      closeShadowTrade(t.symbol, t.openedAt, t.takeProfit, 'tp');
      results.push({ symbol: t.symbol, action: 'closed', reason: 'tp', price });
    } else if (hitSL) {
      const reason = trailActive ? 'trailing_sl' : 'sl';
      closeShadowTrade(t.symbol, t.openedAt, activeSL, reason);
      results.push({ symbol: t.symbol, action: 'closed', reason, price });
    } else if (at1_5R && !trailActive) {
      all[i] = { ...t, trailingSL: t.entryPrice, milestones: { ...t.milestones, trailActivated: true } };
      writeShadowTrades(all);
      results.push({ symbol: t.symbol, action: 'trail_activated', newSL: t.entryPrice });
    } else {
      results.push({ symbol: t.symbol, action: 'monitoring', price });
    }
  }

  return results;
}

module.exports = {
  evaluateShadow,
  closeShadowTrade,
  monitorShadowTrades,
  compareAB,
  shadowAccountStats,
  SHADOW_MIN_CONFIDENCE,
  SHADOW_MIN_RISK_PCT,
  SHADOW_MAX_RISK_PCT,
};
