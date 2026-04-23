/**
 * Phase 3 — Position sync
 *
 * Runs every 5 minutes (configurable via SYNC_INTERVAL_MS env var).
 * Each cycle:
 *   1. Fetch all open positions from Alpaca + Oanda
 *   2. Fetch all open paper trades from local JSON
 *   3. Phantom cleanup — local open trades with a brokerOrderId that no
 *      longer exist at the broker are force-closed locally with reason
 *      'phantom_cleanup' (avoids phantom P&L accumulation)
 *   4. Sync account balance from brokers into pt_account table
 *   5. Emit a structured sync report
 *
 * Export:
 *   startSync()   — start the 5-minute interval (idempotent)
 *   stopSync()    — clear the interval
 *   runSync()     — run a single sync cycle immediately (useful for testing)
 */

const { pool }                              = require('./db');
const { readPaperTrades, writePaperTrades } = require('./tradeEntry');
const { attachLearningFlags }               = require('./learningFlags');
const { getAllPositions, getAccounts, normKey } = require('./brokers/router');

const SYNC_INTERVAL_MS = parseInt(process.env.SYNC_INTERVAL_MS || '300000', 10); // 5 min

// ── Concurrency guard — never run two syncs at the same time ─────────────────
let syncing    = false;
let intervalId = null;

// ── Phantom cleanup ───────────────────────────────────────────────────────────

/**
 * A "phantom trade" is a local open trade that has a `brokerOrderId` but no
 * matching position at the broker. This means the position was closed externally
 * (manual close, broker rejection, expiry) without our system knowing.
 *
 * We close it locally with reason 'phantom_cleanup' so it stops accumulating
 * fictional unrealised PnL, and we attach learning flags as usual.
 *
 * Trades WITHOUT a brokerOrderId (pure paper, broker disabled) are never
 * considered phantoms.
 *
 * @param {Array} brokerPositions  Normalised position list from getAllPositions()
 * @param {Array} allTrades        Full paper_trades.json array (mutated in place)
 * @returns {Array} List of trades that were phantom-cleaned
 */
function cleanupPhantoms(brokerPositions, allTrades) {
  const brokerKeys = new Set(brokerPositions.map((p) => normKey(p.symbol)));
  const cleaned    = [];

  for (let i = 0; i < allTrades.length; i++) {
    const trade = allTrades[i];

    // Only process open trades that were actually submitted to a broker
    if (trade.status !== 'open' || !trade.brokerOrderId) continue;

    const key = normKey(trade.symbol);

    if (!brokerKeys.has(key)) {
      // Position gone at broker → phantom
      const closedTrade = {
        ...trade,
        status:       'closed',
        exitPrice:    trade.entryPrice,   // assume flat exit (no price data available)
        closedAt:     new Date().toISOString(),
        pnl:          0,
        closeReason:  'phantom_cleanup',
      };
      closedTrade.learningFlags = attachLearningFlags(closedTrade);
      allTrades[i] = closedTrade;
      cleaned.push(closedTrade);

      console.log(`[Sync] Phantom cleanup: ${trade.symbol} (brokerOrderId: ${trade.brokerOrderId})`);
    }
  }

  return cleaned;
}

// ── Account balance sync ──────────────────────────────────────────────────────

/**
 * Pull equity/balance from each broker and update the pt_account row.
 * We take the sum of both brokers' equity as the combined balance.
 * Falls back gracefully if DB is unavailable.
 */
async function syncAccountBalance(accounts) {
  const alpacaEq = accounts.alpaca?.mocked  ? 0 : (accounts.alpaca?.equity  || 0);
  const oandaEq  = accounts.oanda?.mocked   ? 0 : (accounts.oanda?.equity   || 0);

  // Use whichever broker(s) returned real data
  const totalEquity = alpacaEq + oandaEq;
  if (totalEquity === 0) return; // nothing useful to sync

  try {
    await pool.query(`
      UPDATE pt_account
      SET  equity     = $1,
           updated_at = NOW()
      WHERE id = (SELECT id FROM pt_account ORDER BY id DESC LIMIT 1)
    `, [totalEquity]);
  } catch (err) {
    console.warn('[Sync] Account balance sync failed:', err.message);
  }
}

// ── DB update for phantom-cleaned trades ──────────────────────────────────────

async function dbMarkPhantomClosed(trade) {
  if (!trade.dbId) return;
  try {
    await pool.query(`
      UPDATE trades
      SET  status        = 'closed',
           exit_price    = $1,
           closed_at     = NOW(),
           pnl           = 0,
           close_reason  = 'phantom_cleanup',
           learning_flags = $2
      WHERE id = $3
    `, [trade.entryPrice, JSON.stringify(trade.learningFlags), trade.dbId]);
  } catch (err) {
    console.warn(`[Sync] DB phantom-close failed for trade ${trade.dbId}:`, err.message);
  }
}

// ── Main sync cycle ───────────────────────────────────────────────────────────

async function runSync() {
  if (syncing) {
    console.log('[Sync] Cycle already in progress — skipping');
    return { skipped: true };
  }

  syncing = true;
  const startedAt = new Date().toISOString();

  try {
    // 1. Fetch broker positions from all enabled brokers concurrently
    const brokerPositions = await getAllPositions();

    // 2. Fetch local open trades
    const allTrades  = readPaperTrades();
    const openTrades = allTrades.filter((t) => t.status === 'open');

    // 3. Phantom cleanup
    const phantoms = cleanupPhantoms(brokerPositions, allTrades);

    if (phantoms.length > 0) {
      writePaperTrades(allTrades);
      await Promise.allSettled(phantoms.map(dbMarkPhantomClosed));
    }

    // 4. Account balance sync
    const accounts = await getAccounts();
    await syncAccountBalance(accounts);

    const report = {
      startedAt,
      completedAt:       new Date().toISOString(),
      brokerPositions:   brokerPositions.length,
      localOpenTrades:   openTrades.length,
      phantomsCleaned:   phantoms.length,
      phantomSymbols:    phantoms.map((t) => t.symbol),
      accounts: {
        alpaca: accounts.alpaca?.mocked  ? 'mocked' : `equity=${accounts.alpaca?.equity}`,
        oanda:  accounts.oanda?.mocked   ? 'mocked' : `equity=${accounts.oanda?.equity}`,
      },
    };

    console.log('[Sync] Cycle complete:', JSON.stringify(report));
    return report;

  } catch (err) {
    console.error('[Sync] Cycle error:', err.message);
    return { error: err.message, startedAt };
  } finally {
    syncing = false;
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

/**
 * Start the 5-minute position sync interval.
 * Idempotent — calling twice has no effect.
 * Runs one cycle immediately, then repeats every SYNC_INTERVAL_MS.
 */
function startSync() {
  if (intervalId) return;

  console.log(`[Sync] Starting position sync every ${SYNC_INTERVAL_MS / 1000}s`);

  // Run immediately, then on interval
  runSync().catch((err) => console.error('[Sync] Initial cycle failed:', err.message));
  intervalId = setInterval(
    () => runSync().catch((err) => console.error('[Sync] Cycle failed:', err.message)),
    SYNC_INTERVAL_MS
  );
}

/**
 * Stop the sync interval.
 */
function stopSync() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Sync] Stopped');
  }
}

module.exports = { startSync, stopSync, runSync };
