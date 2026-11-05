// Activity Ledger web UI. No framework, no build step. All chain-derived text goes through
// textContent (never innerHTML) because notes and counterparties are untrusted input.
const $ = (id) => document.getElementById(id);
const PAGE = 50;
const KIND_LABEL = {
  transfer_in: 'Received', transfer_out: 'Sent', trade: 'Swap', lp_add: 'Add liquidity', lp_remove: 'Remove liquidity',
  lend_supply: 'Lend', lend_withdraw: 'Withdraw', borrow: 'Borrow', repay: 'Repay', reward_claim: 'Reward claim',
  interest_income: 'Interest', fee: 'Network fee', mint: 'Mint', burn: 'Burn', liquidation: 'Liquidation',
  vault_deposit: 'Vault deposit', vault_withdraw: 'Vault withdraw', unclassified: 'Unclassified', no_op: 'Notice',
};
const WARN_HELP = {
  unpriced: 'No USD price found for a leg, so its value is blank. Add a manual price file.',
  no_lots: 'A disposal had no matching acquisition (history before 2025-09-07 is out of reach).',
  unknown_basis: 'Cost basis could not be determined.',
  unclassified: 'A contract call that moved no recognised assets for this account.',
  negative_interest: 'Computed interest was negative; check the position.',
  lp_value_unpriced: 'Liquidity value could not be priced.',
  unknown_debt: 'A repayment for debt borrowed before the sync window, or taken over in a liquidation. The interest part cannot be split out.',
  liquidation_unvalued: 'A Blend liquidation moved collateral and debt as shares, and no pool rate or price was available nearby, so no gain or loss is booked.',
  liquidation_estimated: 'A Blend liquidation valued with exchange rates derived from the pool\'s own events a few ledgers away. Collateral is treated as sold for the debt it relieved.',
};

const state = { accounts: [], data: null, tab: 'events', kind: '', query: '', page: 0, job: null };

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

function usd(s, { sign = false } = {}) {
  if (s == null || s === '') return '';
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const frac = f.replace(/0+$/, '').padEnd(2, '0');
  const body = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + frac;
  return (neg ? '-' : sign && /[1-9]/.test(s) ? '+' : '') + '$' + body;
}
const units = (s) => {
  const [i, f] = s.split('.');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : '');
};
const when = (iso) => iso.replace('T', ' ').replace(/:\d\dZ$/, ' UTC').replace('Z', ' UTC');
const short = (s, a = 6, b = 6) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);

async function api(path, init) {
  const r = await fetch(path, init);
  let body = null;
  try { body = await r.json(); } catch { /* download or empty */ }
  if (!r.ok) throw new Error(body?.error ?? `Request failed (${r.status})`);
  return body;
}

function parseAddresses() {
  return [...new Set($('addresses').value.split(/[\s,]+/).filter(Boolean))];
}
function showError(msg) {
  const box = $('error');
  box.textContent = msg ?? '';
  box.hidden = !msg;
}

// ---- stored accounts -------------------------------------------------------------------------
async function loadAccounts() {
  try {
    state.accounts = (await api('/api/accounts')).accounts;
  } catch (e) { showError(e.message); return; }
  const list = clear($('stored'));
  $('stored-wrap').hidden = state.accounts.length === 0;
  for (const a of state.accounts) {
    list.append(h('li', { class: 'Box-row d-flex flex-items-center flex-justify-between gap-2' },
      h('div', { class: 'min-width-0' },
        h('code', { class: 'f6 text-mono', title: a.account }, short(a.account, 8, 8)),
        h('div', { class: 'f6 color-fg-muted' }, `${a.txs.toLocaleString()} transactions` + (a.skipped ? `, ${a.skipped} skipped` : ''))),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { $('addresses').value = a.account; openReport(); } }, 'Open report')));
  }
}

// ---- sync ------------------------------------------------------------------------------------
async function startSync(ev) {
  ev.preventDefault();
  showError(null);
  const accounts = parseAddresses();
  if (accounts.length === 0) return showError('Enter at least one Stellar address (starts with G).');
  const limit = $('limit').value.trim();
  $('sync').disabled = true;
  try {
    const { id } = await api('/api/sync', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accounts, limit: limit === '' ? null : Number(limit) }),
    });
    watchJob(id, accounts);
  } catch (e) {
    showError(e.message);
    $('sync').disabled = false;
  }
}

function watchJob(id, accounts) {
  const panel = $('progress');
  panel.hidden = false;
  const es = new EventSource(`/api/jobs/${id}/stream`);
  es.onmessage = (m) => {
    const job = JSON.parse(m.data);
    renderProgress(job);
    if (job.status !== 'running') {
      es.close();
      $('sync').disabled = false;
      loadAccounts();
api('/api/meta').then((m) => {
  if (m.earliest) $('history-note').textContent = `Horizon can only discover activity from ${m.earliest.slice(0, 10)} onward, and that date moves forward daily. Sync early and keep your database.`;
}).catch(() => {});
      if (job.status === 'done') openReport(accounts);
    }
  };
  es.onerror = () => { es.close(); $('sync').disabled = false; showError('Lost connection to the local server. Is it still running?'); };
}

function renderProgress(job) {
  const body = clear($('progress-body'));
  for (const p of job.progress) {
    const label = { waiting: 'Waiting', running: 'Syncing', done: 'Done', error: 'Failed' }[p.state];
    body.append(h('div', { class: 'Box-row d-flex flex-items-center flex-justify-between gap-3' },
      h('div', { class: 'min-width-0' },
        h('code', { class: 'f6' }, short(p.account, 8, 8)),
        h('div', { class: 'f6 color-fg-muted' }, `${p.txs.toLocaleString()} transactions stored` + (p.skipped ? `, ${p.skipped} skipped` : ''),
          p.error ? h('span', { class: 'color-fg-danger' }, ` (${p.error})`) : null)),
      h('span', { class: 'Label ' + (p.state === 'error' ? 'Label--danger' : p.state === 'done' ? 'Label--success' : 'Label--accent') }, label)));
  }
  $('progress-bar').hidden = job.status !== 'running';
}

// ---- report ----------------------------------------------------------------------------------
function reportQuery(accounts) {
  const q = new URLSearchParams({ accounts: accounts.join(' '), method: $('method').value, lp: $('lp').value });
  if ($('year').value) q.set('year', $('year').value);
  return q;
}

async function openReport(accounts = parseAddresses(), keepYear = false) {
  showError(null);
  if (accounts.length === 0) return showError('Enter at least one Stellar address (starts with G).');
  if (!keepYear) $('year').value = '';
  $('report').hidden = false;
  $('report-loading').hidden = false;
  $('report-body').hidden = true;
  try {
    state.data = await api('/api/report?' + reportQuery(accounts));
  } catch (e) {
    $('report-loading').hidden = true;
    $('report').hidden = true;
    return showError(e.message);
  }
  state.page = 0; state.kind = ''; state.query = '';
  $('report-loading').hidden = true;
  $('report-body').hidden = false;
  renderReport();
  $('report').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

function stat(label, value, note, tone) {
  return h('div', { class: 'stat' },
    h('div', { class: 'f6 color-fg-muted' }, label),
    h('div', { class: 'stat-value text-mono' + (tone ? ' ' + tone : '') }, value),
    note ? h('div', { class: 'f6 color-fg-muted' }, note) : null);
}
const tone = (s) => (s.startsWith('-') ? 'color-fg-danger' : '');

function renderReport() {
  const d = state.data;
  const yr = $('year');
  const prev = yr.value;
  clear(yr).append(h('option', { value: '' }, 'All years'), ...d.years.map((y) => h('option', { value: y }, y)));
  yr.value = d.year ? String(d.year) : prev;

  const t = d.totals;
  const net = (a, b) => {
    // exact decimal sum without floats: compare via BigInt of micro units
    const mic = (s) => { const n = s.startsWith('-'); const [i, f = ''] = s.replace('-', '').split('.'); const v = BigInt(i) * 1000000n + BigInt(f.padEnd(6, '0')); return n ? -v : v; };
    const v = mic(a) + mic(b); const neg = v < 0n; const abs = (neg ? -v : v).toString().padStart(7, '0');
    return (neg ? '-' : '') + abs.slice(0, -6) + '.' + abs.slice(-6);
  };
  const gain = net(t.gains.shortTerm, t.gains.longTerm);
  clear($('stats')).append(
    stat('Realised gain', usd(gain, { sign: true }), `${t.gains.disposals} disposals, short ${usd(t.gains.shortTerm)} / long ${usd(t.gains.longTerm)}`, tone(gain)),
    stat('Lending interest', usd(t.income.interest), 'Recognised on withdrawal'),
    stat('Rewards', usd(t.income.reward), 'Valued at claim time'),
    stat('Network fees', usd(t.expenses.networkFees), t.expenses.borrowInterest !== '0' ? `Borrow interest ${usd(t.expenses.borrowInterest)}` : null),
    stat('Events', t.events.toLocaleString(), `${t.confidence.exact} exact, ${t.confidence.heuristic} heuristic, ${t.confidence.unknown} unknown`));

  const wcount = Object.values(d.warnings.counts).reduce((s, n) => s + n, 0);
  const tabs = [['events', 'Events', d.events.length], ['gains', 'Gains', d.gains.length], ['income', 'Income', d.income.length],
    ['balances', 'Balances', d.balances.length + d.positions.length], ['warnings', 'Warnings', wcount]];
  const nav = clear($('tabs'));
  for (const [id, label, n] of tabs) {
    nav.append(h('button', { class: 'tab' + (state.tab === id ? ' selected' : ''), type: 'button', role: 'tab', 'aria-selected': String(state.tab === id),
      onclick: () => { state.tab = id; state.page = 0; renderReport(); } },
      label, ' ', h('span', { class: 'Counter' }, String(n))));
  }
  renderTab();
}

function table(cols, rows, empty) {
  if (rows.length === 0) return h('div', { class: 'blankslate' }, h('p', { class: 'color-fg-muted mb-0' }, empty));
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, cols.map((c) => h('td', { class: c.num ? 'num' : '' }, c.cell(r))))))));
}

function renderTab() {
  const d = state.data;
  const host = clear($('tab-body'));
  if (state.tab === 'events') {
    const kinds = [...new Set(d.events.map((e) => e.kind))].sort();
    const q = state.query.trim().toLowerCase();
    const rows = d.events.filter((e) => (!state.kind || e.kind === state.kind) &&
      (!q || e.tx.toLowerCase().includes(q) || (e.counterparty ?? '').toLowerCase().includes(q) || e.legs.some((l) => l.symbol.toLowerCase().includes(q))));
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    state.page = Math.min(state.page, pages - 1);
    host.append(h('div', { class: 'd-flex flex-wrap gap-2 mb-3 flex-items-end' },
      h('div', {}, h('label', { class: 'f6 d-block mb-1', for: 'f-kind' }, 'Type'),
        h('select', { id: 'f-kind', class: 'form-select', onchange: (e) => { state.kind = e.target.value; state.page = 0; renderTab(); } },
          h('option', { value: '' }, 'All types'), kinds.map((k) => h('option', { value: k, selected: k === state.kind }, KIND_LABEL[k] ?? k)))),
      h('div', {}, h('label', { class: 'f6 d-block mb-1', for: 'f-q' }, 'Search'),
        h('input', { id: 'f-q', class: 'form-control', type: 'search', placeholder: 'Asset, counterparty or tx hash', value: state.query,
          oninput: (e) => { state.query = e.target.value; state.page = 0; renderTab(); const i = $('f-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); } })),
      h('div', { class: 'f6 color-fg-muted ml-auto' }, `${rows.length.toLocaleString()} of ${d.events.length.toLocaleString()} events`)));
    const slice = rows.slice(state.page * PAGE, (state.page + 1) * PAGE);
    host.append(table([
      { label: 'Time', cell: (e) => when(e.time) },
      { label: 'Type', cell: (e) => h('span', { class: 'Label' }, KIND_LABEL[e.kind] ?? e.kind) },
      { label: 'Movements', cell: (e) => h('div', {}, e.legs.map((l) => h('div', { class: 'text-mono ' + (l.dir === 'in' ? 'color-fg-success' : 'color-fg-danger') }, `${l.dir === 'in' ? '+' : '-'}${units(l.amount)} ${l.symbol}`))) },
      { label: 'USD', num: true, cell: (e) => e.usd == null ? h('span', { class: 'color-fg-muted', title: 'No price found' }, 'unpriced') : usd(e.usd) },
      { label: 'Source', cell: (e) => h('span', { class: 'color-fg-muted' }, e.protocol ?? 'classic', e.confidence !== 'exact' ? ` (${e.confidence})` : '') },
      { label: 'Transaction', cell: (e) => h('a', { href: `https://stellar.expert/explorer/public/tx/${e.tx}`, target: '_blank', rel: 'noopener noreferrer', class: 'text-mono f6' }, short(e.tx, 6, 4)) },
    ], slice, 'No events match these filters.'));
    host.append(pager(pages));
  } else if (state.tab === 'gains') {
    host.append(table([
      { label: 'Asset', cell: (g) => g.asset }, { label: 'Units', num: true, cell: (g) => units(g.units) },
      { label: 'Acquired', cell: (g) => when(g.acquired) }, { label: 'Disposed', cell: (g) => when(g.disposed) },
      { label: 'Proceeds', num: true, cell: (g) => usd(g.proceeds) }, { label: 'Basis', num: true, cell: (g) => usd(g.basis) },
      { label: 'Gain', num: true, cell: (g) => h('span', { class: tone(g.gain) }, usd(g.gain, { sign: true })) },
      { label: 'Term', cell: (g) => g.term === 'long' ? 'Long' : 'Short' },
    ], d.gains, 'No disposals in this period. Gains appear when you swap or sell an asset you acquired earlier.'));
  } else if (state.tab === 'income') {
    host.append(table([
      { label: 'Time', cell: (i) => when(i.time) }, { label: 'Kind', cell: (i) => i.kind === 'interest' ? 'Lending interest' : 'Reward' },
      { label: 'Amount', num: true, cell: (i) => `${units(i.units)} ${i.asset}` }, { label: 'USD', num: true, cell: (i) => usd(i.usd) },
      { label: 'Price source', cell: (i) => h('span', { class: 'color-fg-muted' }, i.source) },
    ], d.income, 'No income recognised. Interest appears when a lending position is withdrawn; rewards when you claim them.'));
  } else if (state.tab === 'balances') {
    host.append(h('h3', { class: 'f4 mb-2' }, 'Open balances'),
      table([{ label: 'Asset', cell: (b) => b.symbol }, { label: 'Units', num: true, cell: (b) => units(b.units) }], d.balances, 'No open balances.'),
      h('h3', { class: 'f4 mt-4 mb-2' }, 'Open lending positions'),
      table([{ label: 'Asset', cell: (p) => p.asset }, { label: 'Where', cell: (p) => (p.kind === 'backstop' ? 'Backstop' : 'Pool') + ' ' + short(p.pool, 4, 4) },
        { label: 'Principal', num: true, cell: (p) => units(p.principal) }, { label: 'Shares', num: true, cell: (p) => p.shares }],
        d.positions, 'No open lending positions.'),
      h('h3', { class: 'f4 mt-4 mb-2' }, 'Open borrows'),
      table([{ label: 'Asset', cell: (p) => p.asset }, { label: 'Pool', cell: (p) => short(p.pool, 4, 4) },
        { label: 'Principal borrowed', num: true, cell: (p) => units(p.principal) }, { label: 'Debt shares', num: true, cell: (p) => p.shares }],
        d.debts, 'No open borrows.'));
  } else {
    const entries = Object.entries(d.warnings.counts);
    if (entries.length === 0) host.append(h('div', { class: 'blankslate' }, h('p', { class: 'mb-0' }, 'No warnings. Every movement was classified and priced.')));
    for (const [code, n] of entries) {
      host.append(h('div', { class: 'flash mb-2' }, h('strong', {}, `${code.replace(/_/g, ' ')} (${n})`), h('div', { class: 'f6' }, WARN_HELP[code] ?? '')));
    }
    if (d.warnings.items.length) {
      host.append(table([{ label: 'Code', cell: (w) => w.code }, { label: 'Detail', cell: (w) => w.message }, { label: 'Event', cell: (w) => h('span', { class: 'text-mono f6' }, short(w.eventId, 8, 4)) }],
        d.warnings.items, ''));
    }
  }
}

function pager(pages) {
  if (pages <= 1) return h('div');
  return h('div', { class: 'd-flex flex-items-center flex-justify-center gap-3 mt-3' },
    h('button', { class: 'btn btn-sm', type: 'button', disabled: state.page === 0, onclick: () => { state.page--; renderTab(); } }, 'Previous'),
    h('span', { class: 'f6 color-fg-muted' }, `Page ${state.page + 1} of ${pages}`),
    h('button', { class: 'btn btn-sm', type: 'button', disabled: state.page >= pages - 1, onclick: () => { state.page++; renderTab(); } }, 'Next'));
}

function download(format) {
  const q = reportQuery(state.data.accounts);
  q.set('format', format);
  const a = h('a', { href: '/api/export?' + q });
  document.body.append(a); a.click(); a.remove();
}

// ---- boot ------------------------------------------------------------------------------------
$('sync-form').addEventListener('submit', startSync);
$('open-report').addEventListener('click', () => openReport());
for (const id of ['year', 'method', 'lp']) $(id).addEventListener('change', () => state.data && openReport(state.data.accounts, true));
for (const b of document.querySelectorAll('[data-export]')) b.addEventListener('click', () => state.data && download(b.dataset.export));
loadAccounts();
api('/api/meta').then((m) => {
  if (m.earliest) $('history-note').textContent = `Horizon can only discover activity from ${m.earliest.slice(0, 10)} onward, and that date moves forward daily. Sync early and keep your database.`;
}).catch(() => {});
