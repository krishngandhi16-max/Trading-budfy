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

function renderOverview() {
  const s = cache.strategies;
  const cards = s.strategies.map((st) => `
    <div class="card">
      <h4>${LABELS[st.strategy]}</h4>
      <div class="big ${cls(st.totalPl)}">${sign(st.totalPl)}${money(st.totalPl)}</div>
      <div class="row"><span>Realized</span><span class="${cls(st.realizedPl)}">${money(st.realizedPl)}</span></div>
      <div class="row"><span>Unrealized</span><span class="${cls(st.unrealizedPl)}">${money(st.unrealizedPl)}</span></div>
      <div class="row"><span>Open / Closed</span><span>${st.openCount} / ${st.closedCount}</span></div>
      <div class="row"><span>Win rate</span><span>${st.winRate == null ? '—' : st.winRate + '%'}</span></div>
    </div>`).join('');

  const acct = s.account && !s.account.error
    ? `<div class="card"><h4>Alpaca account equity</h4><div class="big">${money(s.account.equity)}</div>
         <div class="row"><span>Cash</span><span>${money(s.account.balance)}</span></div>
         ${s.account.mocked ? '<div class="row"><span>mode</span><span>mock</span></div>' : ''}</div>`
    : '';

  $('#view').innerHTML = `<div class="cards">${cards}${acct}</div>
    <div class="section-title">How to read this</div>
    <div class="card" style="color:var(--muted);font-size:13px">
      Each strategy runs on its own $1,000,000 book and risks $500 per trade. “Total P&amp;L” =
      realized (closed trades) + unrealized (open trades marked to live price). Click a strategy tab
      to see its open positions and trade history.
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
        <div class="card"><h4>Book equity</h4><div class="big">${money(st.equity)}</div>
          <div class="row"><span>Start</span><span>${money(st.startingBalance)}</span></div></div>
        <div class="card"><h4>Record</h4><div class="big">${st.wins}-${st.losses}</div>
          <div class="row"><span>Win rate</span><span>${st.winRate == null ? '—' : st.winRate + '%'}</span></div>
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
    <th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Result</th><th>P&amp;L</th><th>Closed</th>
    </tr></thead><tbody>${rows.map((t) => `<tr>
      <td><b>${t.symbol}</b></td>
      <td><span class="badge ${t.direction}">${t.direction.toUpperCase()}</span></td>
      <td>${t.quantity}</td>
      <td>${t.fillPrice ?? t.entryPrice}</td>
      <td>${t.exitPrice ?? '—'}</td>
      <td>${reasonText(t.closeReason)}</td>
      <td class="${cls(t.realizedPl)}">${t.realizedPl == null ? '—' : sign(t.realizedPl) + money(t.realizedPl)}</td>
      <td>${t.closedAt ? new Date(t.closedAt).toLocaleString() : '—'}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function reasonText(r) {
  return { tp: '🎯 Target', sl: '🛑 Stop', canceled: '✖ Unfilled', expired: '✖ Expired', rejected: '✖ Rejected' }[r] || (r || '—');
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
