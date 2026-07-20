/* Strategy Lab dashboard — vanilla JS, polls the API every few seconds. */

const LABELS = {
  liquidity_sweep: 'Liquidity Sweep',
  volume_profile:  'Volume Profile',
  master:          'Master',
};

let activeTab = 'overview';
let cache = { strategies: null, activity: [] };

const $ = (sel) => document.querySelector(sel);
const money = (n) => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const cls   = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const sign  = (n) => (n > 0 ? '+' : '');

// ── tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('#tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    render();
  });
});
$('#scanBtn').addEventListener('click', async () => {
  $('#scanBtn').textContent = 'Scanning…';
  try { await fetch('/api/scan-now', { method: 'POST' }); } catch {}
  $('#scanBtn').textContent = 'Run one scan now';
  await refresh();
});
$('#flattenBtn').addEventListener('click', async () => {
  if (!confirm('Close ALL open strategy-lab positions right now and lock in current P&L?\n\n(Your crypto bot is not affected. Closed trades will still be tracked to show what they would have done.)')) return;
  $('#flattenBtn').textContent = 'Closing…';
  try { await fetch('/api/flatten-now', { method: 'POST' }); } catch {}
  $('#flattenBtn').textContent = '💰 Lock in profits';
  await refresh();
});
$('#resetBtn').addEventListener('click', async () => {
  if (!confirm("Wipe ALL tracked trades and activity history?\n\nUse this after switching to a different Alpaca account — old records can never match a different account's positions. This does NOT touch your broker account, only this dashboard's memory of past trades. Cannot be undone.")) return;
  $('#resetBtn').textContent = 'Resetting…';
  try { await fetch('/api/reset-store', { method: 'POST' }); } catch {}
  $('#resetBtn').textContent = '🗑 Reset data (new account)';
  await refresh();
});

// ── data ────────────────────────────────────────────────────────────────────────
async function refresh() {
  try {
    const [s, a] = await Promise.all([
      fetch('/api/strategies').then((r) => r.json()),
      fetch('/api/activity?limit=200').then((r) => r.json()),
    ]);
    cache.strategies = s;
    cache.activity = a.activity || [];
    renderBanners(s.mode);
    render();
    renderFeed($('#feed-list'), cache.activity.slice(0, 40));
    $('#lastUpdate').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    $('#lastUpdate').textContent = 'Connection error — retrying…';
  }
}

// ── banners ─────────────────────────────────────────────────────────────────────
function renderBanners(mode) {
  const b = [];
  if (!mode.hasKeys) b.push(['bad', '⚠ No Alpaca API keys — add ALPACA_API_KEY / ALPACA_API_SECRET in Secrets']);
  else if (!mode.brokerEnabled) b.push(['warn', '🧪 MOCK MODE — set BROKER_ENABLED=true to place real paper orders']);
  else b.push(['ok', '● LIVE paper trading']);
  if (!mode.scannerEnabled) b.push(['warn', '⏸ Scanner off — set SCANNER_ENABLED=true (or use “Run one scan now”)']);
  b.push([mode.marketOpen ? 'ok' : 'warn', mode.marketOpen ? '🟢 Market open' : '🔴 Market closed (US regular hours only)']);
  $('#banners').innerHTML = b.map(([k, t]) => `<span class="banner ${k}">${t}</span>`).join('');
}

// ── views ───────────────────────────────────────────────────────────────────────
function render() {
  if (!cache.strategies) { $('#view').innerHTML = '<div class="empty">Loading…</div>'; return; }
  if (activeTab === 'overview') return renderOverview();
  if (activeTab === 'feed')     return renderFullFeed();
  return renderStrategy(activeTab);
}

function pf(v) { return v == null ? '∞' : v; }

function renderOverview() {
  const s = cache.strategies;
  const o = s.overall || {};

  const overallCard = `
    <div class="card" style="grid-column:1/-1;border-color:var(--blue)">
      <h4>ALL STRATEGIES COMBINED</h4>
      <div class="big ${cls(o.totalPl)}">${sign(o.totalPl)}${money(o.totalPl)}</div>
      <div class="statgrid">
        <div><span>Win rate</span><b>${o.winRate == null ? '—' : o.winRate + '%'}</b></div>
        <div><span>Profit factor</span><b>${pf(o.profitFactor)}</b></div>
        <div><span>Expectancy/trade</span><b class="${cls(o.expectancy)}">${o.expectancy == null ? '—' : money(o.expectancy)}</b></div>
        <div><span>Record (W-L)</span><b>${o.wins}-${o.losses}</b></div>
        <div><span>Open / Closed</span><b>${o.openCount} / ${o.closedCount}</b></div>
        <div><span>Avg win / loss</span><b>${money(o.avgWin)} / ${money(o.avgLoss)}</b></div>
      </div>
      ${o.whatIfCount ? `<div class="row" style="margin-top:8px"><span>“What-if” on ${o.whatIfCount} early-closed trades</span><span class="${cls(o.whatIfPl)}">would-have ${money(o.whatIfPl)}</span></div>` : ''}
    </div>`;

  const cards = s.strategies.map((st) => `
    <div class="card">
      <h4>${LABELS[st.strategy]}</h4>
      <div class="big ${cls(st.totalPl)}">${sign(st.totalPl)}${money(st.totalPl)}</div>
      <div class="row"><span>Win rate</span><span>${st.winRate == null ? '—' : st.winRate + '%'}</span></div>
      <div class="row"><span>Profit factor</span><span>${pf(st.profitFactor)}</span></div>
      <div class="row"><span>Expectancy</span><span class="${cls(st.expectancy)}">${st.expectancy == null ? '—' : money(st.expectancy)}</span></div>
      <div class="row"><span>Open / Closed</span><span>${st.openCount} / ${st.closedCount}</span></div>
    </div>`).join('');

  const acct = s.account && !s.account.error
    ? `<div class="card"><h4>Alpaca account equity</h4><div class="big">${money(s.account.equity)}</div>
         <div class="row"><span>Cash</span><span>${money(s.account.balance)}</span></div>
         ${s.account.mocked ? '<div class="row"><span>mode</span><span>mock</span></div>' : ''}</div>`
    : '';

  $('#view').innerHTML = `<div class="cards">${overallCard}${cards}${acct}</div>
    <div class="section-title">How to read this</div>
    <div class="card" style="color:var(--muted);font-size:13px">
      Each strategy runs on its own $1,000,000 book, risks $500 per trade, and flattens at 2:55&nbsp;PM Central.
      <b>Profit factor</b> = gross wins ÷ gross losses (above 1 = profitable; 2+ is strong).
      <b>Expectancy</b> = average $ made per closed trade. <b>What-if</b> shows what trades you closed early
      <i>would</i> have done if left to hit their target/stop.
    </div>`;
}

function renderStrategy(name) {
  fetch(`/api/strategy/${name}/trades`).then((r) => r.json()).then((d) => {
    if (activeTab !== name) return; // user switched away
    const st = d.stats;
    const head = `
      <div class="cards">
        <div class="card"><h4>${LABELS[name]} — Total P&amp;L</h4><div class="big ${cls(st.totalPl)}">${sign(st.totalPl)}${money(st.totalPl)}</div>
          <div class="row"><span>Realized</span><span class="${cls(st.realizedPl)}">${money(st.realizedPl)}</span></div>
          <div class="row"><span>Unrealized</span><span class="${cls(st.unrealizedPl)}">${money(st.unrealizedPl)}</span></div></div>
        <div class="card"><h4>Quality</h4><div class="big">${pf(st.profitFactor)}</div>
          <div class="row"><span>Profit factor</span><span>${pf(st.profitFactor)}</span></div>
          <div class="row"><span>Expectancy</span><span class="${cls(st.expectancy)}">${st.expectancy == null ? '—' : money(st.expectancy)}</span></div></div>
        <div class="card"><h4>Record</h4><div class="big">${st.wins}-${st.losses}</div>
          <div class="row"><span>Win rate</span><span>${st.winRate == null ? '—' : st.winRate + '%'}</span></div>
          <div class="row"><span>Avg win / loss</span><span>${money(st.avgWin)} / ${money(st.avgLoss)}</span></div>
          <div class="row"><span>Open</span><span>${st.openCount}</span></div></div>
      </div>`;

    $('#view').innerHTML = head +
      `<div class="section-title">Open trades (${d.open.length})</div>${openTable(d.open)}` +
      `<div class="section-title">History (${d.closed.length})</div>${closedTable(d.closed)}`;
  });
}

function openTable(rows) {
  if (!rows.length) return '<div class="table-wrap"><div class="empty">No open trades right now.</div></div>';
  return `<div class="table-wrap"><table><thead><tr>
    <th>Symbol</th><th>Side</th><th>Status</th><th>Qty</th><th>Entry</th><th>Stop</th><th>Target</th><th>Unrealized</th><th>Opened</th>
    </tr></thead><tbody>${rows.map((t) => `<tr>
      <td><b>${t.symbol}</b></td>
      <td><span class="badge ${t.direction}">${t.direction.toUpperCase()}</span></td>
      <td><span class="badge ${t.status}">${t.status}</span></td>
      <td>${t.quantity}</td>
      <td>${t.fillPrice ?? t.entryPrice}</td>
      <td>${t.stopLoss}</td>
      <td>${t.takeProfit}</td>
      <td class="${cls(t.unrealizedPl)}">${sign(t.unrealizedPl)}${money(t.unrealizedPl)}</td>
      <td>${new Date(t.openedAt).toLocaleString()}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function closedTable(rows) {
  if (!rows.length) return '<div class="table-wrap"><div class="empty">No closed trades yet.</div></div>';
  return `<div class="table-wrap"><table><thead><tr>
    <th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Result</th><th>P&amp;L</th><th>What-if (if held)</th><th>Closed</th>
    </tr></thead><tbody>${rows.map((t) => `<tr>
      <td><b>${t.symbol}</b></td>
      <td><span class="badge ${t.direction}">${t.direction.toUpperCase()}</span></td>
      <td>${t.quantity}</td>
      <td>${t.fillPrice ?? t.entryPrice}</td>
      <td>${t.exitPrice ?? '—'}</td>
      <td>${reasonText(t.closeReason)}</td>
      <td class="${cls(t.realizedPl)}">${t.realizedPl == null ? '—' : sign(t.realizedPl) + money(t.realizedPl)}</td>
      <td>${whatIfText(t)}</td>
      <td>${t.closedAt ? new Date(t.closedAt).toLocaleString() : '—'}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function reasonText(r) {
  return {
    tp: '🎯 Target', sl: '🛑 Stop', eod: '🌙 EOD close', manual: '💰 You closed',
    canceled: '✖ Unfilled', eod_unfilled: '✖ Unfilled', expired: '✖ Expired', rejected: '✖ Rejected',
    closed_externally: '🔄 Closed elsewhere', closed_unreconciled: '❓ Closed (unmatched)',
  }[r] || (r || '—');
}

// Counterfactual column: only meaningful for trades closed early (manual/EOD).
function whatIfText(t) {
  if (!t.whatIf) return '—';
  if (t.whatIf.status === 'watching') return '<span style="color:var(--muted)">⏳ watching…</span>';
  const pl = t.whatIf.pl;
  const tag = t.whatIf.outcome === 'tp' ? '🎯' : t.whatIf.outcome === 'sl' ? '🛑' : '⏱';
  const diff = pl - (t.realizedPl || 0);
  const hint = diff > 0 ? ` (left ${money(diff)} on the table)` : diff < 0 ? ` (saved ${money(-diff)})` : '';
  return `<span class="${cls(pl)}">${tag} ${sign(pl)}${money(pl)}</span><span style="color:var(--muted);font-size:11px">${hint}</span>`;
}

// ── feed ────────────────────────────────────────────────────────────────────────
function renderFeed(ul, items) {
  if (!ul) return;
  ul.innerHTML = items.map((e) => `
    <li class="k-${e.kind}">${escapeHtml(e.message)}
      <span class="t">${new Date(e.ts).toLocaleTimeString()}${e.strategy ? ' · ' + (LABELS[e.strategy] || e.strategy) : ''}</span>
    </li>`).join('') || '<li class="empty">No activity yet.</li>';
}

function renderFullFeed() {
  $('#view').innerHTML = `<h3 style="color:var(--muted)">Activity feed</h3><ul id="feed-full"></ul>`;
  renderFeed($('#feed-full'), cache.activity);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── boot ────────────────────────────────────────────────────────────────────────
refresh();
setInterval(refresh, 5000);
