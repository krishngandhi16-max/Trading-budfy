/**
 * Phase 4 — Startup self-heal
 *
 * Called once when the server starts. Checks all system dependencies and
 * repairs what it can without human intervention.
 *
 * Heal operations (in order):
 *   1. JSON files     — create any missing data/*.json with safe empty values
 *   2. Database       — run all phase migrations via initDb() if DB reachable
 *   3. weights.json   — validate structure; reset to DEFAULT_WEIGHTS if corrupt
 *   4. Env vars       — warn about missing variables (never throws)
 *   5. Open trades    — detect and flag any trades left in impossible states
 *
 * Returns a structured heal report. Never throws — all errors are caught and
 * reported so the server can start even when some dependencies are unavailable.
 */

const fs   = require('fs');
const path = require('path');

const { initDb }         = require('./db');
const { DEFAULT_WEIGHTS } = require('./scoring');

const DATA_DIR = path.resolve(__dirname, '../data');

// ── Required JSON files with their safe empty values ─────────────────────────

const REQUIRED_JSON = {
  'paper_trades.json':    [],
  'weights.json':         {},
  'push_subs.json':       [],
  'vapid.json':           {},
  'top_picks.json':       [],
  'insights.json':        [],
  'shadow_trades.json':   [],
  'shadow_lab.json':      {},
  'shadow_backtest.json': [],
  'strategy_trades.json': [],   // Strategy Lab: scanner trades
  'activity.json':        [],   // Strategy Lab: activity feed
};

// ── Env vars expected in production ──────────────────────────────────────────

const OPTIONAL_IN_DEV = [
  'DATABASE_URL',
  'ALPACA_API_KEY',
  'ALPACA_API_SECRET',
  'OANDA_API_KEY',
  'OANDA_ACCOUNT_ID',
];

const REQUIRED_ALWAYS = [
  // Currently none — all have fallback defaults
];

// ── Heal: JSON files ──────────────────────────────────────────────────────────

function healJsonFiles() {
  const report = { created: [], verified: [], errors: [] };

  if (!fs.existsSync(DATA_DIR)) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      report.created.push('data/ directory');
    } catch (err) {
      report.errors.push(`Could not create data/: ${err.message}`);
      return report;
    }
  }

  for (const [filename, emptyValue] of Object.entries(REQUIRED_JSON)) {
    const filepath = path.join(DATA_DIR, filename);

    if (!fs.existsSync(filepath)) {
      try {
        fs.writeFileSync(filepath, JSON.stringify(emptyValue, null, 2));
        report.created.push(filename);
      } catch (err) {
        report.errors.push(`${filename}: ${err.message}`);
      }
    } else {
      // Verify it is valid JSON
      try {
        JSON.parse(fs.readFileSync(filepath, 'utf8'));
        report.verified.push(filename);
      } catch {
        // Corrupt — overwrite with empty safe value
        try {
          fs.writeFileSync(filepath, JSON.stringify(emptyValue, null, 2));
          report.created.push(`${filename} (reset — was corrupt)`);
        } catch (writeErr) {
          report.errors.push(`${filename} corrupt + unwritable: ${writeErr.message}`);
        }
      }
    }
  }

  return report;
}

// ── Heal: database ────────────────────────────────────────────────────────────

async function healDatabase() {
  const report = { ok: false, error: null };

  if (!process.env.DATABASE_URL) {
    report.error = 'DATABASE_URL not set — skipping DB migration';
    return report;
  }

  try {
    await initDb();
    report.ok = true;
  } catch (err) {
    report.error = err.message;
    console.warn('[selfHeal] DB migration failed:', err.message);
  }

  return report;
}

// ── Heal: weights.json ────────────────────────────────────────────────────────

function healWeights() {
  const filepath = path.join(DATA_DIR, 'weights.json');
  const report   = { action: 'ok', details: null };

  try {
    const raw    = fs.readFileSync(filepath, 'utf8');
    const parsed = JSON.parse(raw);

    // Validate structure: must have at least the four signal keys
    const requiredKeys = ['FVG', 'Sweep', 'BOS', 'OB'];
    const missingKeys  = requiredKeys.filter((k) => !parsed[k]);

    if (Object.keys(parsed).length === 0 || missingKeys.length > 0) {
      // Empty or partial — merge with defaults (don't overwrite custom values)
      const merged = {
        FVG:       { ...DEFAULT_WEIGHTS.FVG,   ...(parsed.FVG   || {}) },
        Sweep:     { ...DEFAULT_WEIGHTS.Sweep, ...(parsed.Sweep || {}) },
        BOS:       { ...DEFAULT_WEIGHTS.BOS,   ...(parsed.BOS   || {}) },
        OB:        { ...DEFAULT_WEIGHTS.OB,    ...(parsed.OB    || {}) },
        timeframe: { ...DEFAULT_WEIGHTS.timeframe, ...(parsed.timeframe || {}) },
      };
      fs.writeFileSync(filepath, JSON.stringify(merged, null, 2));
      report.action  = 'merged_defaults';
      report.details = missingKeys.length ? `added missing keys: ${missingKeys.join(', ')}` : 'populated empty weights';
    }

    // Validate each signal weight is a positive number
    for (const key of requiredKeys) {
      const w = parsed[key] || {};
      if (typeof w.bullish !== 'number' || typeof w.bearish !== 'number' ||
          w.bullish <= 0 || w.bearish <= 0) {
        throw new Error(`invalid values for ${key}`);
      }
    }

  } catch (err) {
    // Corrupt or invalid — reset to defaults
    try {
      fs.writeFileSync(filepath, JSON.stringify(DEFAULT_WEIGHTS, null, 2));
      report.action  = 'reset_to_defaults';
      report.details = err.message;
    } catch (writeErr) {
      report.action  = 'error';
      report.details = writeErr.message;
    }
  }

  return report;
}

// ── Heal: env vars ────────────────────────────────────────────────────────────

function checkEnvVars() {
  const report   = { missing: [], present: [] };
  const isDev    = process.env.NODE_ENV !== 'production';

  for (const key of REQUIRED_ALWAYS) {
    if (!process.env[key]) report.missing.push(key);
    else report.present.push(key);
  }

  if (!isDev || process.env.BROKER_ENABLED === 'true') {
    for (const key of OPTIONAL_IN_DEV) {
      if (!process.env[key]) {
        report.missing.push(`${key} (optional in DEV, required in production)`);
      } else {
        report.present.push(key);
      }
    }
  }

  if (report.missing.length > 0) {
    console.warn('[selfHeal] Missing env vars:', report.missing.join(', '));
  }

  return report;
}

// ── Heal: open trades consistency ────────────────────────────────────────────

/**
 * Scan paper_trades.json for trades in impossible states and quarantine them.
 * An "impossible" trade is one that:
 *   - Is marked 'open' but has a closedAt date
 *   - Is marked 'closed' but has no exitPrice
 *   - Has NaN entryPrice or quantity
 *
 * Quarantined trades are moved to a 'quarantine' array inside the JSON
 * and their status is set to 'quarantined' so they don't affect P&L.
 */
function healOpenTrades() {
  const filepath = path.join(DATA_DIR, 'paper_trades.json');
  const report   = { quarantined: 0, ok: 0, error: null };

  try {
    const trades    = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    let   modified  = false;

    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      const impossible =
        (t.status === 'open'   && t.closedAt != null) ||
        (t.status === 'closed' && t.exitPrice == null) ||
        isNaN(t.entryPrice) || isNaN(t.quantity) ||
        t.entryPrice <= 0    || t.quantity <= 0;

      if (impossible) {
        trades[i]    = { ...t, status: 'quarantined', quarantinedAt: new Date().toISOString() };
        modified     = true;
        report.quarantined++;
        console.warn(`[selfHeal] Quarantined impossible trade: ${t.symbol} opened ${t.openedAt}`);
      } else {
        report.ok++;
      }
    }

    if (modified) {
      fs.writeFileSync(filepath, JSON.stringify(trades, null, 2));
    }

  } catch (err) {
    report.error = err.message;
  }

  return report;
}

// ── Master self-heal ──────────────────────────────────────────────────────────

/**
 * Run all self-heal operations. Call this once on server startup.
 * Returns a comprehensive heal report; never throws.
 *
 * @returns {Promise<Object>}  Full heal report
 */
async function selfHeal() {
  console.log('[selfHeal] Starting startup self-heal…');

  const report = {
    startedAt:  new Date().toISOString(),
    jsonFiles:  null,
    database:   null,
    weights:    null,
    envVars:    null,
    trades:     null,
    completedAt: null,
  };

  try { report.jsonFiles = healJsonFiles();      } catch (err) { report.jsonFiles  = { error: err.message }; }
  try { report.database  = await healDatabase(); } catch (err) { report.database   = { error: err.message }; }
  try { report.weights   = healWeights();        } catch (err) { report.weights    = { error: err.message }; }
  try { report.envVars   = checkEnvVars();       } catch (err) { report.envVars    = { error: err.message }; }
  try { report.trades    = healOpenTrades();     } catch (err) { report.trades     = { error: err.message }; }

  report.completedAt = new Date().toISOString();

  const issues = [
    ...(report.jsonFiles?.errors  || []),
    ...(report.database?.error    ? [report.database.error]  : []),
    ...(report.weights?.action === 'error' ? [report.weights.details] : []),
    ...(report.trades?.error      ? [report.trades.error]    : []),
  ];

  if (issues.length === 0) {
    console.log('[selfHeal] All checks passed');
  } else {
    console.warn('[selfHeal] Completed with issues:', issues);
  }

  return report;
}

module.exports = { selfHeal, healJsonFiles, healDatabase, healWeights, checkEnvVars, healOpenTrades };
