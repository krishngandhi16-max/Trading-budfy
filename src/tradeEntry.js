/**
 * Phase 2 — Paper trade entry
 *
 * Pipeline:
 *   1. Score signals  →  2. Run 13 gates  →  3. Size position
 *   →  4. Write to DB  →  5. Write to paper_trades.json
 */

const fs   = require('fs');
const path = require('path');

const { pool }             = require('./db');
const { calculatePosition } = require('./position');
const { runAllGates }       = require('./gates');
const { scoreSignals }      = require('./scoring');

const PAPER_TRADES_PATH = path.resolve(__dirname, '../data/paper_trades.json');

// ── JSON helpers ──────────────────────────────────────────────────────────────

function readPaperTrades() {
  try {
    const raw = fs.readFileSync(PAPER_TRADES_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writePaperTrades(trades) {
  fs.writeFileSync(PAPER_TRADES_PATH, JSON.stringify(trades, null, 2));
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getOpenTradesCount() {
  try {
    const res = await pool.query("SELECT COUNT(*) FROM trades WHERE status = 'open'");
    return parseInt(res.rows[0].count, 10);
  } catch {
    return readPaperTrades().filter((t) => t.status === 'open').length;
  }
}

async function getAccountStats() {
  try {
    const res = await pool.query(
      'SELECT balance, equity FROM pt_account ORDER BY id DESC LIMIT 1'
    );
    if (res.rows.length > 0) {
      return {
        accountBalance: parseFloat(res.rows[0].balance),
        peakBalance:    parseFloat(res.rows[0].equity),
      };
    }
  } catch { /* fallthrough */ }

  // JSON fallback: derive peak from max closing balance seen in trades
  return { accountBalance: 100000, peakBalance: 100000 };
}

// ── Entry ─────────────────────────────────────────────────────────────────────

/**
 * Attempt to open a paper trade.
 *
 * @param {Object} params
 * @param {string} params.symbol        Base symbol (e.g. 'AAPL')
 * @param {string} params.marketType    'stocks' | 'crypto' | 'futures' | 'forex' | 'metals'
 * @param {string} params.direction     'long' | 'short'
 * @param {number} params.entryPrice    Current / desired entry price
 * @param {number} params.stopLossPrice Stop-loss price
 * @param {Array}  params.tfResults     Output of detectAllTimeframes()
 * @param {number} [params.riskPct=0.01] Risk fraction (0.01–0.03)
 *
 * @returns {Promise<{
 *   entered:    boolean,
 *   reason?:    string,       // why it was rejected
 *   gates?:     Array,        // gate results
 *   trade?:     Object,       // full trade record (if entered)
 *   dbId?:      number|null,
 *   position?:  Object,
 *   score?:     Object,
 * }>}
 */
async function enterTrade({ symbol, marketType, direction, entryPrice, stopLossPrice, tfResults, riskPct = 0.01 }) {
  // ── Step 1: Score signals ──────────────────────────────────────────────────
  const score = scoreSignals(tfResults);

  // ── Step 2: Build gate context and run all 13 gates ───────────────────────
  const openTradesCount          = await getOpenTradesCount();
  const { accountBalance, peakBalance } = await getAccountStats();

  const gateResult = runAllGates({ tfResults, score, openTradesCount, accountBalance, peakBalance });

  if (!gateResult.passed) {
    return {
      entered:   false,
      reason:    `Gate ${gateResult.failedGate} (${gateResult.failedReason})`,
      gates:     gateResult.results,
      score,
    };
  }

  // ── Step 3: Size position ─────────────────────────────────────────────────
  let position;
  try {
    position = calculatePosition({ accountBalance, entryPrice, stopLossPrice, direction, riskPct });
  } catch (err) {
    return { entered: false, reason: `Position sizing error: ${err.message}`, gates: gateResult.results };
  }

  // ── Step 4: Build trade record ────────────────────────────────────────────
  const now = new Date().toISOString();

  const signals = {
    score,
    gates: gateResult.results,
    tfSummary: tfResults.map((r) => ({
      timeframe:  r.timeframe,
      fvgCount:   r.fvg.length,
      sweepCount: r.sweep.length,
      bosCount:   r.bos.length,
      obCount:    r.ob.length,
    })),
  };

  const trade = {
    symbol,
    marketType,
    direction,
    entryPrice,
    stopLoss:    position.stopLoss,
    takeProfit:  position.takeProfit,
    trailingSL:  position.stopLoss,   // tracks current active SL; moves to entry at +1.5R
    quantity:    position.quantity,
    riskAmount:  position.riskAmount,
    riskPct:     position.riskPct,
    riskPerUnit: position.riskPerUnit,
    confidence:  score.confidence,
    bias:        score.bias,
    signals,
    status:      'open',
    openedAt:    now,
    closedAt:    null,
    exitPrice:   null,
    pnl:         null,
    closeReason: null,
    learningFlags: null,
    milestones:  { trailActivated: false },
    dbId:        null,
  };

  // ── Step 5a: Write to DB ──────────────────────────────────────────────────
  try {
    const res = await pool.query(`
      INSERT INTO trades
        (symbol, market_type, direction, entry_price, stop_loss, take_profit,
         trailing_sl, quantity, status, confidence, signals, risk_pct, r_size, opened_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12,NOW())
      RETURNING id
    `, [
      symbol,
      marketType,
      direction,
      entryPrice,
      position.stopLoss,
      position.takeProfit,
      position.stopLoss,
      position.quantity,
      score.confidence,
      JSON.stringify(signals),
      position.riskPct,
      position.riskPerUnit,
    ]);
    trade.dbId = res.rows[0].id;
  } catch (err) {
    console.warn('[tradeEntry] DB insert failed (JSON fallback active):', err.message);
  }

  // ── Step 5b: Append to paper_trades.json ─────────────────────────────────
  const all = readPaperTrades();
  all.push(trade);
  writePaperTrades(all);

  return {
    entered:  true,
    trade,
    dbId:     trade.dbId,
    position,
    score,
    gates:    gateResult.results,
  };
}

module.exports = {
  enterTrade,
  readPaperTrades,
  writePaperTrades,
  getOpenTradesCount,
  getAccountStats,
};
