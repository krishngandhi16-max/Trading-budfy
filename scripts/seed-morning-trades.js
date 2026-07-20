/**
 * One-off: seed the 3 (well, 4) real trades from the morning of 2026-07-20 into
 * the dashboard as closed records, with accurate realized P&L computed from the
 * Alpaca fill activity.
 *
 * Run once in the Replit shell:  node scripts/seed-morning-trades.js
 *
 * NOTE (honesty): these came from the OLD paper account and were placed BEFORE
 * the position-size cap, so they were massively oversized (BMY was a ~$161k
 * short). They are kept for the record but do NOT represent how the bot trades
 * now. They're tagged strategy 'imported' so they don't distort the live books'
 * win-rate / profit-factor stats.
 */

const store = require('../src/store');

const MORNING = [
  { symbol: 'BMY',  direction: 'short', qty: 2631, entry: 61.21,  exit: 60.80,  pnl:  1091.18 },
  { symbol: 'BNY',  direction: 'short', qty: 632,  entry: 158.11, exit: 157.42, pnl:   436.08 },
  { symbol: 'ABBV', direction: 'long',  qty: 233,  entry: 254.50, exit: 253.56, pnl:  -219.02 },
  { symbol: 'DPZ',  direction: 'short', qty: 27,   entry: 332.22, exit: 327.80, pnl:   119.39 },
];

for (const t of MORNING) {
  const rec = store.addTrade({
    strategy: 'imported',
    symbol: t.symbol,
    direction: t.direction,
    entryType: 'market',
    entryPrice: t.entry,
    stopLoss: null,
    takeProfit: null,
    quantity: t.qty,
    riskAmount: null,
    clientOrderId: `imported__${t.symbol}__morning`,
    status: 'open',
    meta: { note: 'old account, pre-sizing-fix, manual record' },
  });
  store.updateTrade(rec.id, {
    fillPrice: t.entry,
    status: 'closed',
    realizedPl: t.pnl,
    unrealizedPl: 0,
    exitPrice: t.exit,
    closeReason: 'manual',
    closedAt: '2026-07-20T16:25:00.000Z',
  });
  console.log(`seeded ${t.symbol} ${t.direction} ${t.qty} → ${t.pnl >= 0 ? '+' : ''}$${t.pnl}`);
}

const net = MORNING.reduce((s, t) => s + t.pnl, 0);
console.log(`\nDone. ${MORNING.length} trades seeded, net ${net >= 0 ? '+' : ''}$${net.toFixed(2)}.`);
console.log('They appear under a separate "imported" tag and do not affect the 3 live strategy books.');
