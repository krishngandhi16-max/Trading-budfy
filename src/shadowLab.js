/**
 * Phase 4 — Shadow Strategy Lab: S1–S6 isolated channels
 *
 * Each channel is a self-contained strategy variant. They share the same
 * underlying ICT signal data (tfResults) but apply different entry rules,
 * confidence thresholds, and risk parameters. No channel influences another.
 *
 * Channel definitions (since CLAUDE.md does not exist, defined here
 * from ICT first principles):
 *
 *   S1  Trend Continuation   — HTF BOS + 1D FVG + 1H OB; 70% confidence
 *   S2  Sweep & Reverse      — Liquidity sweep on 1H/4H + OB after sweep; 65%
 *   S3  FVG Cascade          — FVG aligned on ≥3 timeframes; 75%
 *   S4  OB Retest            — OB on 4H + BOS on 15M confirming retest; 65%
 *   S5  Session Breakout     — Active kill zone + BOS on 15M + FVG on 1H; 60%
 *   S6  Full Confluence      — All four ICT signals on ≥1 timeframe; 80%
 *
 * All channel trades are stored in data/shadow_lab.json keyed by channel ID.
 * No broker calls are ever made from the lab.
 */

const fs   = require('fs');
const path = require('path');

const { calculatePosition } = require('./position');
const { scoreSignals }      = require('./scoring');

const LAB_PATH = path.resolve(__dirname, '../data/shadow_lab.json');

// ── File helpers ──────────────────────────────────────────────────────────────

function readLab() {
  try {
    const raw = JSON.parse(fs.readFileSync(LAB_PATH, 'utf8'));
    return Array.isArray(raw) ? objectify(raw) : raw;
  } catch {
    return {};
  }
}

// Convert old array format to keyed object if needed
function objectify(arr) {
  const obj = {};
  for (const item of arr) {
    if (item.channel) {
      obj[item.channel] = obj[item.channel] || { trades: [] };
      obj[item.channel].trades.push(...(item.trades || []));
    }
  }
  return obj;
}

function writeLab(data) {
  fs.writeFileSync(LAB_PATH, JSON.stringify(data, null, 2));
}

function ensureChannel(lab, id) {
  if (!lab[id]) lab[id] = { trades: [] };
  return lab[id];
}

// ── Signal helpers ────────────────────────────────────────────────────────────

function findTF(tfResults, label) {
  return tfResults.find((r) => r.timeframe === label) || null;
}

function hasSig(tfResults, labels, signalKey, direction) {
  return labels.some((label) => {
    const r = findTF(tfResults, label);
    return r && (r[signalKey] || []).some((s) => s.direction === direction);
  });
}

function countTFsWithFVG(tfResults, direction) {
  return tfResults.filter((r) => (r.fvg || []).some((s) => s.direction === direction)).length;
}

function allFourPresent(tfResults, direction) {
  return tfResults.some((r) =>
    (r.fvg   || []).some((s) => s.direction === direction) &&
    (r.sweep || []).some((s) => s.direction === direction) &&
    (r.bos   || []).some((s) => s.direction === direction) &&
    (r.ob    || []).some((s) => s.direction === direction)
  );
}

function isKillZone() {
  const h = new Date().getUTCHours();
  return (h >= 7 && h < 10) || (h >= 13 && h < 16);
}

// ── Channel definitions ───────────────────────────────────────────────────────

const CHANNELS = {
  /**
   * S1 — Trend Continuation
   * HTF BOS on 4H or 1D, FVG on 1D, OB on 1H. Classic ICT continuation setup.
   */
  S1: {
    name:           'Trend Continuation',
    minConfidence:  70,
    minRiskPct:     0.015,
    maxRiskPct:     0.02,

    evaluate(tfResults, score) {
      const d = score.bias;
      if (d === 'neutral') return { entry: false, reason: 'neutral bias' };

      const htfBOS  = hasSig(tfResults, ['4H', '1D'], 'bos', d);
      const dailyFVG = hasSig(tfResults, ['1D'],       'fvg', d);
      const h1OB     = hasSig(tfResults, ['1H'],       'ob',  d);

      if (!htfBOS)   return { entry: false, reason: 'S1: no HTF BOS' };
      if (!dailyFVG) return { entry: false, reason: 'S1: no 1D FVG' };
      if (!h1OB)     return { entry: false, reason: 'S1: no 1H OB' };

      return { entry: true, reason: 'HTF BOS + 1D FVG + 1H OB', riskPct: this.minRiskPct };
    },
  },

  /**
   * S2 — Sweep & Reverse
   * Liquidity swept on 1H or 4H, followed immediately by an OB in the
   * opposite direction. Classic engineered liquidity reversal.
   */
  S2: {
    name:          'Sweep & Reverse',
    minConfidence: 65,
    minRiskPct:    0.015,
    maxRiskPct:    0.025,

    evaluate(tfResults, score) {
      const d        = score.bias;
      if (d === 'neutral') return { entry: false, reason: 'neutral bias' };

      const swept    = hasSig(tfResults, ['1H', '4H'], 'sweep', d);
      const obAfter  = hasSig(tfResults, ['1H', '4H'], 'ob',    d);

      if (!swept)   return { entry: false, reason: 'S2: no sweep on 1H/4H' };
      if (!obAfter) return { entry: false, reason: 'S2: no OB after sweep' };

      return { entry: true, reason: 'Sweep + OB reversal', riskPct: 0.02 };
    },
  },

  /**
   * S3 — FVG Cascade
   * Fair Value Gap present on at least 3 timeframes in the same direction.
   * Multi-TF gap alignment signals a strong imbalance likely to fill.
   */
  S3: {
    name:          'FVG Cascade',
    minConfidence: 75,
    minRiskPct:    0.01,
    maxRiskPct:    0.015,

    evaluate(tfResults, score) {
      const d = score.bias;
      if (d === 'neutral') return { entry: false, reason: 'neutral bias' };

      const fvgTFCount = countTFsWithFVG(tfResults, d);
      if (fvgTFCount < 3) {
        return { entry: false, reason: `S3: FVG on ${fvgTFCount} TFs (need ≥3)` };
      }

      return { entry: true, reason: `FVG on ${fvgTFCount} timeframes`, riskPct: this.minRiskPct };
    },
  },

  /**
   * S4 — OB Retest
   * Order Block on 4H with price returning to its zone, confirmed by a
   * break of structure on 15M (micro-BOS confirming the retest).
   */
  S4: {
    name:          'OB Retest',
    minConfidence: 65,
    minRiskPct:    0.02,
    maxRiskPct:    0.025,

    evaluate(tfResults, score) {
      const d = score.bias;
      if (d === 'neutral') return { entry: false, reason: 'neutral bias' };

      const h4OB    = hasSig(tfResults, ['4H'], 'ob',  d);
      const m15BOS  = hasSig(tfResults, ['15M'], 'bos', d);

      if (!h4OB)   return { entry: false, reason: 'S4: no 4H OB' };
      if (!m15BOS) return { entry: false, reason: 'S4: no 15M BOS confirmation' };

      return { entry: true, reason: '4H OB + 15M BOS retest confirmation', riskPct: 0.02 };
    },
  },

  /**
   * S5 — Session Breakout
   * Entries are restricted to active London/NY kill zones. Must have BOS
   * on 15M and FVG on 1H as an entry zone. Session timing is the edge.
   */
  S5: {
    name:          'Session Breakout',
    minConfidence: 60,
    minRiskPct:    0.015,
    maxRiskPct:    0.03,

    evaluate(tfResults, score) {
      const d = score.bias;
      if (d === 'neutral') return { entry: false, reason: 'neutral bias' };

      if (!isKillZone()) return { entry: false, reason: 'S5: outside kill zone' };

      const m15BOS = hasSig(tfResults, ['15M', '5M'], 'bos', d);
      const h1FVG  = hasSig(tfResults, ['1H'],        'fvg', d);

      if (!m15BOS) return { entry: false, reason: 'S5: no 15M BOS' };
      if (!h1FVG)  return { entry: false, reason: 'S5: no 1H FVG' };

      return { entry: true, reason: 'Kill zone + 15M BOS + 1H FVG', riskPct: 0.02 };
    },
  },

  /**
   * S6 — Full Confluence
   * All four ICT signals (FVG + Sweep + BOS + OB) must be present on at
   * least one timeframe simultaneously. Highest conviction setup; allows
   * the highest risk of any channel.
   */
  S6: {
    name:          'Full Confluence',
    minConfidence: 80,
    minRiskPct:    0.02,
    maxRiskPct:    0.03,

    evaluate(tfResults, score) {
      const d = score.bias;
      if (d === 'neutral') return { entry: false, reason: 'neutral bias' };

      if (!allFourPresent(tfResults, d)) {
        return { entry: false, reason: 'S6: not all four signals (FVG+Sweep+BOS+OB) on one TF' };
      }

      return { entry: true, reason: 'Full ICT confluence — all four signals', riskPct: this.maxRiskPct };
    },
  },
};

// ── Channel runner ────────────────────────────────────────────────────────────

/**
 * Evaluate a single channel and log a trade if conditions are met.
 * No broker interaction — purely paper within shadow_lab.json.
 *
 * @param {string}  channelId        'S1'–'S6'
 * @param {string}  symbol
 * @param {string}  marketType
 * @param {number}  entryPrice
 * @param {number}  stopLossPrice
 * @param {Array}   tfResults        detectAllTimeframes() output
 * @param {number}  [accountBalance=100000]  Virtual balance for sizing
 * @returns {{ entered: boolean, channel: string, reason?: string, trade?: Object }}
 */
function runChannel(channelId, symbol, marketType, entryPrice, stopLossPrice, tfResults, accountBalance = 100_000) {
  const ch = CHANNELS[channelId];
  if (!ch) return { entered: false, channel: channelId, reason: `unknown channel: ${channelId}` };

  const score  = scoreSignals(tfResults);

  if (score.confidence < ch.minConfidence) {
    return {
      entered: false,
      channel: channelId,
      reason:  `${channelId}: confidence ${score.confidence}% < ${ch.minConfidence}%`,
    };
  }

  const eval_  = ch.evaluate(tfResults, score);
  if (!eval_.entry) {
    return { entered: false, channel: channelId, reason: eval_.reason };
  }

  const direction = score.bias === 'bearish' ? 'short' : 'long';

  let position;
  try {
    position = calculatePosition({
      accountBalance,
      entryPrice,
      stopLossPrice,
      direction,
      riskPct: eval_.riskPct ?? ch.minRiskPct,
    });
  } catch (err) {
    return { entered: false, channel: channelId, reason: `sizing: ${err.message}` };
  }

  const trade = {
    channel:     channelId,
    channelName: ch.name,
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
    entryReason: eval_.reason,
    status:      'open',
    openedAt:    new Date().toISOString(),
    closedAt:    null,
    exitPrice:   null,
    pnl:         null,
    closeReason: null,
    milestones:  { trailActivated: false },
  };

  const lab = readLab();
  ensureChannel(lab, channelId).trades.push(trade);
  writeLab(lab);

  return { entered: true, channel: channelId, channelName: ch.name, trade, score, position };
}

// ── Channel stats ─────────────────────────────────────────────────────────────

/**
 * Return win-rate, P&L, trade count per channel.
 * @returns {Object}  { S1: { wins, losses, winRate, totalPnl }, … }
 */
function getLabStats() {
  const lab  = readLab();
  const out  = {};

  for (const [id, ch] of Object.entries(CHANNELS)) {
    const trades  = lab[id]?.trades || [];
    const closed  = trades.filter((t) => t.status === 'closed');
    const wins    = closed.filter((t) => t.pnl > 0).length;
    const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);

    out[id] = {
      name:      ch.name,
      open:      trades.filter((t) => t.status === 'open').length,
      closed:    closed.length,
      wins,
      losses:    closed.length - wins,
      winRate:   closed.length ? parseFloat((wins / closed.length).toFixed(4)) : null,
      totalPnl:  parseFloat(totalPnl.toFixed(2)),
    };
  }

  return out;
}

/**
 * Close a lab trade (found by channel + symbol + openedAt).
 */
function closeLabTrade(channelId, symbol, openedAt, exitPrice, reason) {
  const lab = readLab();
  const ch  = lab[channelId];
  if (!ch) return { closed: false, reason: 'channel not found' };

  const idx = ch.trades.findIndex((t) => t.symbol === symbol && t.openedAt === openedAt && t.status === 'open');
  if (idx === -1) return { closed: false, reason: 'trade not found' };

  const trade = ch.trades[idx];
  const move  = trade.direction === 'long' ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
  const pnl   = parseFloat((move * trade.quantity).toFixed(2));

  ch.trades[idx] = {
    ...trade,
    status:      'closed',
    exitPrice,
    pnl,
    closeReason: reason,
    closedAt:    new Date().toISOString(),
  };

  writeLab(lab);
  return { closed: true, pnl, trade: ch.trades[idx] };
}

/**
 * Monitor all open lab trades across all channels against current prices.
 * Mirrors Phase 2 close logic (TP / SL / trailing at +1.5R).
 *
 * @param {Object} currentPrices  { SYMBOL: price }
 */
function monitorLabTrades(currentPrices) {
  const lab     = readLab();
  const results = [];
  let   changed = false;

  for (const [id, ch] of Object.entries(lab)) {
    for (let i = 0; i < ch.trades.length; i++) {
      const t = ch.trades[i];
      if (t.status !== 'open') continue;

      const price = currentPrices[t.symbol?.toUpperCase()] ?? currentPrices[t.symbol];
      if (price == null) { results.push({ channel: id, symbol: t.symbol, action: 'skipped' }); continue; }

      const trailActive = t.milestones?.trailActivated;
      const activeSL    = trailActive ? t.entryPrice : (t.trailingSL ?? t.stopLoss);
      const R           = t.riskPerUnit;
      const l1_5R       = t.direction === 'long' ? t.entryPrice + 1.5 * R : t.entryPrice - 1.5 * R;

      const hitTP  = t.direction === 'long' ? price >= t.takeProfit : price <= t.takeProfit;
      const hitSL  = t.direction === 'long' ? price <= activeSL     : price >= activeSL;
      const at1_5R = t.direction === 'long' ? price >= l1_5R        : price <= l1_5R;

      if (hitTP || hitSL) {
        const reason   = hitTP ? 'tp' : (trailActive ? 'trailing_sl' : 'sl');
        const exitAt   = hitTP ? t.takeProfit : activeSL;
        const move     = t.direction === 'long' ? exitAt - t.entryPrice : t.entryPrice - exitAt;
        const pnl      = parseFloat((move * t.quantity).toFixed(2));
        ch.trades[i]   = { ...t, status: 'closed', exitPrice: exitAt, pnl, closeReason: reason, closedAt: new Date().toISOString() };
        changed = true;
        results.push({ channel: id, symbol: t.symbol, action: 'closed', reason, pnl });
      } else if (at1_5R && !trailActive) {
        ch.trades[i] = { ...t, trailingSL: t.entryPrice, milestones: { ...t.milestones, trailActivated: true } };
        changed = true;
        results.push({ channel: id, symbol: t.symbol, action: 'trail_activated' });
      } else {
        results.push({ channel: id, symbol: t.symbol, action: 'monitoring', price });
      }
    }
  }

  if (changed) writeLab(lab);
  return results;
}

module.exports = {
  CHANNELS,
  runChannel,
  getLabStats,
  closeLabTrade,
  monitorLabTrades,
};
