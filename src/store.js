/**
 * Strategy-lab data store (JSON-primary, decoupled from the old v3 engine).
 *
 * Two files under data/:
 *   strategy_trades.json  — every trade the scanner opens, tagged by strategy
 *   activity.json         — the in-app activity feed (newest last)
 *
 * JSON is the source of truth here because it's the most reliable option on
 * Replit's ephemeral/DB-optional environment. Reads/writes are synchronous and
 * cheap at this scale (hundreds of records).
 */

const fs   = require('fs');
const path = require('path');

const TRADES_PATH   = path.resolve(__dirname, '../data/strategy_trades.json');
const ACTIVITY_PATH = path.resolve(__dirname, '../data/activity.json');

const STRATEGIES = ['liquidity_sweep', 'volume_profile', 'master'];
const STARTING_BALANCE = 1_000_000;   // display notional per strategy book
const RISK_PER_TRADE   = 500;         // fixed $ risk per trade

// ── low-level json io ────────────────────────────────────────────────────────

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}
function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// ── trades ───────────────────────────────────────────────────────────────────

function getTrades() { return readJson(TRADES_PATH, []); }
function writeTrades(t) { writeJson(TRADES_PATH, t); }

function getOpenTrades(strategy = null) {
  return getTrades().filter((t) =>
    (t.status === 'pending' || t.status === 'open') &&
    (!strategy || t.strategy === strategy));
}

/** Append a new trade record and return it. */
function addTrade(trade) {
  const all = getTrades();
  const rec = {
    id:            trade.clientOrderId || `${trade.strategy}_${trade.symbol}_${Date.now()}`,
    strategy:      trade.strategy,
    symbol:        trade.symbol,
    direction:     trade.direction,
    entryType:     trade.entryType,
    entryPrice:    trade.entryPrice,     // intended entry (limit price or signal price)
    fillPrice:     null,                 // actual fill (from Alpaca)
    stopLoss:      trade.stopLoss,
    takeProfit:    trade.takeProfit,
    quantity:      trade.quantity,
    riskAmount:    trade.riskAmount,
    clientOrderId: trade.clientOrderId,
    brokerOrderId: trade.brokerOrderId || null,
    status:        trade.status || 'pending',   // pending → open → closed (or canceled)
    unrealizedPl:  0,
    realizedPl:    null,
    closeReason:   null,
    meta:          trade.meta || {},
    openedAt:      new Date().toISOString(),
    filledAt:      null,
    closedAt:      null,
  };
  all.push(rec);
  writeTrades(all);
  return rec;
}

/** Patch a trade in place by id. Returns the updated record or null. */
function updateTrade(id, patch) {
  const all = getTrades();
  const idx = all.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...patch };
  writeTrades(all);
  return all[idx];
}

function findTradeByClientId(clientOrderId) {
  return getTrades().find((t) => t.clientOrderId === clientOrderId) || null;
}

/** Is there already an open/pending trade for this strategy+symbol? */
function hasActiveTrade(strategy, symbol) {
  return getOpenTrades(strategy).some((t) => t.symbol === symbol.toUpperCase());
}

// ── per-strategy stats ───────────────────────────────────────────────────────

function strategyStats(strategy) {
  const trades = getTrades().filter((t) => t.strategy === strategy);
  const closed = trades.filter((t) => t.status === 'closed');
  const open   = trades.filter((t) => t.status === 'open' || t.status === 'pending');

  const realized   = closed.reduce((s, t) => s + (t.realizedPl || 0), 0);
  const unrealized = open.reduce((s, t) => s + (t.unrealizedPl || 0), 0);
  const wins       = closed.filter((t) => (t.realizedPl || 0) > 0).length;

  return {
    strategy,
    startingBalance: STARTING_BALANCE,
    realizedPl:   round2(realized),
    unrealizedPl: round2(unrealized),
    totalPl:      round2(realized + unrealized),
    equity:       round2(STARTING_BALANCE + realized + unrealized),
    openCount:    open.length,
    closedCount:  closed.length,
    wins,
    losses:       closed.length - wins,
    winRate:      closed.length ? round2((wins / closed.length) * 100) : null,
  };
}

function allStrategyStats() { return STRATEGIES.map(strategyStats); }

// ── activity feed ────────────────────────────────────────────────────────────

function getActivity(limit = 200) {
  const all = readJson(ACTIVITY_PATH, []);
  return all.slice(-limit).reverse();   // newest first
}

/**
 * Append an activity event.
 * @param {Object} e { strategy, symbol, kind, message, data }
 *   kind: 'entry' | 'fill' | 'tp' | 'sl' | 'skip' | 'info' | 'error'
 */
function addActivity(e) {
  const all = readJson(ACTIVITY_PATH, []);
  all.push({
    ts:       new Date().toISOString(),
    strategy: e.strategy || null,
    symbol:   e.symbol || null,
    kind:     e.kind || 'info',
    message:  e.message || '',
    data:     e.data || null,
  });
  // keep the file bounded
  const trimmed = all.slice(-2000);
  writeJson(ACTIVITY_PATH, trimmed);
}

function round2(n) { return parseFloat(Number(n).toFixed(2)); }

module.exports = {
  STRATEGIES, STARTING_BALANCE, RISK_PER_TRADE,
  getTrades, getOpenTrades, addTrade, updateTrade, findTradeByClientId, hasActiveTrade,
  strategyStats, allStrategyStats,
  getActivity, addActivity,
};
