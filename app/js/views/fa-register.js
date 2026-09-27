import { h, mount, table, statusPill, select } from '../ui.js';
import { loadAssets, loadConfig } from '../data.js';
import { accumThrough, depreciationFor, depreciableBase, isDisposedBefore } from '../fa/engine.js';
import { money, round2, sum } from '../money.js';
import { monthOfDate, monthDiff } from '../fiscal.js';

export function assetStatus(a, month) {
  if (a.disposal?.date && monthDiff(monthOfDate(a.disposal.date), month) >= 0) return ['Disposed', 'neutral'];
  if (a.status === 'cip') return ['CIP', 'info'];
  if (accumThrough(a, month) >= depreciableBase(a) - 0.004) return ['Fully depreciated', 'neutral'];
  if (monthDiff(month, monthOfDate(a.inService)) >= 0 && depreciationFor(a, month) === 0) return ['Not started', 'warn'];
  return ['Depreciating', 'good'];
}

const FILTER_KEY = 'monthclose:fa-filter';

export default async function (main, { month, monthName }) {
  const [assets, cfg] = await Promise.all([loadAssets(), loadConfig()]);
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(FILTER_KEY) || '{}'); } catch { /* ignore */ }
  const state = { q: saved.q || '', group: saved.group || '', status: saved.status || 'on-books' };

  const rows = assets.map((a) => {
    const accum = accumThrough(a, month);
    return { a, accum, nbv: a.cost - accum, dep: depreciationFor(a, month), status: assetStatus(a, month) };
  });

  // Summary per asset account, as of the end of the selected month (assets still on the books).
  const onBooks = rows.filter((r) => !isDisposedBefore(r.a, month) && r.status[0] !== 'Disposed');
  const summary = cfg.groups.map((g) => {
    const list = onBooks.filter((r) => r.a.group === g.asset);
    return { g, count: list.length, cost: sum(list, (r) => r.a.cost), accum: sum(list, (r) => r.accum), dep: sum(list, (r) => r.dep) };
  }).filter((s) => s.count);

  const listHost = h('div');
  const search = h('input', { type: 'search', placeholder: 'Search name, account, serial…', value: state.q });
  const groupSel = select([['', 'All asset accounts'], ...cfg.groups.map((g) => [g.asset, `${g.asset} · ${g.name}`])], state.group);
  const statusSel = select([['on-books', 'On the books'], ['depreciating', 'Depreciating'], ['full', 'Fully depreciated'], ['disposed', 'Disposed'], ['all', 'Everything']], state.status);

  function drawList() {
    try { localStorage.setItem(FILTER_KEY, JSON.stringify(state)); } catch { /* ignore */ }
    const q = state.q.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (state.group && r.a.group !== state.group) return false;
      const s = r.status[0];
      if (state.status === 'on-books' && s === 'Disposed') return false;
      if (state.status === 'depreciating' && s !== 'Depreciating') return false;
      if (state.status === 'full' && s !== 'Fully depreciated') return false;
      if (state.status === 'disposed' && s !== 'Disposed') return false;
      if (q && !`${r.a.name} ${r.a.group} ${r.a.serial || ''} ${r.a.notes || ''}`.toLowerCase().includes(q)) return false;
      return true;
    }).sort((x, y) => x.a.group.localeCompare(y.a.group) || (x.a.inService || '').localeCompare(y.a.inService || ''));

    mount(listHost, h('p', { class: 'muted small' }, `${list.length} of ${rows.length} assets`),
      table([
        { label: 'Asset', cell: (r) => h('a', { href: `#/fa/asset/${encodeURIComponent(r.a.id)}` }, r.a.name) },
        { label: 'Account', cell: (r) => r.a.group },
        { label: 'In service', cell: (r) => r.a.inService || '' },
        { label: 'Life', num: true, cell: (r) => r.a.lifeMonths ? `${r.a.lifeMonths} mo` : '' },
        { label: 'Cost', num: true, cell: (r) => money(r.a.cost) },
        { label: `Dep. ${monthName(month, { short: true })}`, num: true, cell: (r) => money(r.dep) },
        { label: 'Accum. dep.', num: true, cell: (r) => money(r.accum) },
        { label: 'Net book value', num: true, cell: (r) => money(r.nbv) },
        { label: 'Status', cell: (r) => statusPill(...r.status) },
      ], list, {
        empty: assets.length ? 'No assets match.' : 'No assets yet — import the FA listing or add one.',
        foot: (c) => ({ Cost: money(sum(list, (r) => r.a.cost)), 'Accum. dep.': money(sum(list, (r) => r.accum)),
          'Net book value': money(sum(list, (r) => r.nbv)), Asset: 'Total' })[c.label]
          ?? (c.label.startsWith('Dep.') ? money(sum(list, (r) => r.dep)) : ''),
      }));
  }

  search.addEventListener('input', () => { state.q = search.value; drawList(); });
  groupSel.addEventListener('change', () => { state.group = groupSel.value; drawList(); });
  statusSel.addEventListener('change', () => { state.status = statusSel.value; drawList(); });

  mount(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Fixed assets'), h('p', { class: 'muted' }, `Balances as of the end of ${monthName(month)}.`)),
      h('div', { class: 'actions' },
        h('a', { class: 'btn', href: '#/fa/import' }, 'Import FA listing'),
        h('a', { class: 'btn primary', href: '#/fa/new' }, 'Add asset'))),
    summary.length ? table([
      { label: 'Asset account', cell: (s) => `${s.g.asset} · ${s.g.name}` },
      { label: 'A/D account', cell: (s) => s.g.ad },
      { label: 'Assets', num: true, cell: (s) => s.count },
      { label: 'Cost', num: true, cell: (s) => money(s.cost) },
      { label: `Dep. ${monthName(month, { short: true })}`, num: true, cell: (s) => money(s.dep) },
      { label: 'Accum. dep.', num: true, cell: (s) => money(s.accum) },
      { label: 'Net book value', num: true, cell: (s) => money(s.cost - s.accum) },
    ], summary, {
      foot: (c) => ({ 'Asset account': 'Total', Cost: money(sum(summary, (s) => s.cost)),
        'Accum. dep.': money(sum(summary, (s) => s.accum)), 'Net book value': money(round2(sum(summary, (s) => s.cost - s.accum))),
        Assets: sum(summary, (s) => s.count) })[c.label] ?? (c.label.startsWith('Dep.') ? money(sum(summary, (s) => s.dep)) : ''),
    }) : null,
    h('h2', {}, 'Assets'),
    h('div', { class: 'toolbar' }, search, groupSel, statusSel),
    listHost,
  );
  drawList();
}
