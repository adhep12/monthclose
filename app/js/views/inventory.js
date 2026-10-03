// Inventory: the monthly tie-out (warehouse units + Portland on hand, valued at cost, against the
// GL), what departments took, and the two JEs — adjusting inventory and reclassing Stripe merch
// purchases out of donations.

import { h, mount, table, toast, fileButton, panel, ask, askValue, field, select, statusPill } from '../ui.js';
import { listInventoryMonths, saveInventoryMonth, loadInventoryConfig, saveInventoryConfig, loadTrialBalances, listGlActivity, SOURCE_FILES } from '../data.js';
import { parseInventoryGrid, parseDistribution, parseProductSales } from '../inventory/parse.js';
import { tieOut, stripeReclass, monthInputs, inventoryJes, largePurchases, valueUnits } from '../inventory/tieout.js';
import { balancesFrom } from '../bs/cash.js';
import { downloadJes } from './month-jes.js';
import { jeTable } from './je-table.js';
import { isBalanced } from '../fa/je.js';
import { readWorkbook } from '../xlsx-io.js';
import { uploadFile, filesAvailable, explain } from '../store.js';
import { storedName, renamed } from '../naming.js';
import { nowIso, when } from '../audit.js';
import { money, parseAmount, round2 } from '../money.js';
import { monthName, addMonths, currentMonth, lastDayOfMonth } from '../fiscal.js';

const MONTH_KEY = 'monthclose:inventory-month';
const short = (m) => monthName(m, { short: true });
const units = (n) => (n == null ? '' : Number(n).toLocaleString('en-US'));

async function keep(file, report, month) {
  const fileName = storedName(report, month, file.name);
  let fileKey = null;
  if (filesAvailable()) { try { fileKey = (await uploadFile(SOURCE_FILES, renamed(file, fileName)))?.key || null; } catch { /* figures still saved */ } }
  return { fileName, originalName: file.name, fileKey };
}

export default async function (main, { user, rerender }) {
  const [recs, cfg, tbs, gls] = await Promise.all([listInventoryMonths(), loadInventoryConfig(), loadTrialBalances(), listGlActivity()]);
  const recBy = Object.fromEntries(recs.map((r) => [r.month, r]));
  const tbBy = Object.fromEntries(tbs.map((t) => [t.month, t]));
  let month = null;
  try { month = localStorage.getItem(MONTH_KEY); } catch { /* ignore */ }
  if (!month) month = recs.filter((r) => r.warehouse).map((r) => r.month).sort().pop() || addMonths(currentMonth(), -1);
  const pick = (m) => { try { localStorage.setItem(MONTH_KEY, m); } catch { /* ignore */ } rerender(); };

  const rec = recBy[month] || { month };
  // Portland's count carries forward from the last month that has one.
  const lastPdx = recs.filter((r) => r.month < month && r.pdx).sort((a, b) => a.month.localeCompare(b.month)).pop();
  const pdx = rec.pdx || lastPdx?.pdx || {};
  const { balances } = balancesFrom(tbBy, addMonths(month, -1), month);
  const input = monthInputs({ ...rec, pdx }, balances, cfg);
  const t = tieOut(input, cfg);
  const reclass = stripeReclass(rec.sales || {}, cfg);
  const jes = inventoryJes(t, reclass, lastDayOfMonth(month), cfg).map((je) => ({ ...je, balanced: isBalanced(je.lines) }));
  const big = largePurchases(gls.find((g) => g.month === month), cfg);

  async function save(change, msg) {
    const fresh = { month, ...(recBy[month] || {}) };
    change(fresh);
    fresh.updatedBy = user; fresh.updatedAt = nowIso();
    try { await saveInventoryMonth(fresh); if (msg) toast(msg); rerender(); } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
  }

  async function onGrid(file) {
    try {
      const { XLSX, wb } = await readWorkbook(file);
      const g = parseInventoryGrid(XLSX, wb);
      const m = await askValue('Which month-end is this count for?', 'The warehouse export run on the 1st is the month before’s ending count.', { type: 'month', value: month, ok: 'Use it' });
      if (!m || !/^\d{4}-\d{2}$/.test(m)) return;
      const src = await keep(file, 'InventoryGrid', m);
      const fresh = { month: m, ...(recBy[m] || {}), warehouse: { units: g.units, warehouse: g.warehouse, ...src, by: user, at: nowIso() }, updatedBy: user, updatedAt: nowIso() };
      await saveInventoryMonth(fresh);
      toast(`Warehouse units for ${monthName(m)} saved.`);
      pick(m);
    } catch (err) { toast(explain(err, `${file.name}:`), 'error'); }
  }
  // A report covering several months updates each of them.
  async function onMany(file, parse, field_, report, base, describe) {
    try {
      const { XLSX, wb } = await readWorkbook(file);
      const res = parse(XLSX, wb);
      const ms = Object.keys(res.months).sort();
      if (!ms.length) { toast(`${file.name}: no months in it.`, 'error'); return; }
      if (!(await ask(`Load ${report}`, `${describe(res)} for ${ms.map(short).join(', ')}. Each of these months takes what this file says, replacing an earlier upload.`, { ok: `Load ${ms.length} months` }))) return;
      const src = await keep(file, base, ms[ms.length - 1]);
      for (const m of ms) await saveInventoryMonth({ month: m, ...(recBy[m] || {}), [field_]: res.months[m], [`${field_}File`]: { ...src, by: user, at: nowIso() }, updatedBy: user, updatedAt: nowIso() });
      toast(`${report} loaded for ${ms.length} months.`);
      rerender();
    } catch (err) { toast(explain(err, `${file.name}:`), 'error'); }
  }

  const typed = (it, key, value, label) => h('input', { class: 'num', size: 9, value: value ?? '', title: label, onchange: (e) => {
    const v = e.target.value.trim() === '' ? null : parseAmount(e.target.value);
    if (v != null && !Number.isFinite(v)) { toast('That isn’t a number.', 'error'); return; }
    save((r) => { r[key] = { ...(r[key] || (key === 'pdx' ? pdx : {})), [it.id]: v }; if (key === 'pdx') { r.pdxBy = user; r.pdxAt = nowIso(); } }, `${label} saved.`);
  } });

  const stamp = (x, label) => (x ? h('div', { class: 'muted small' }, `${label}: ${x.fileName || ''}${x.by ? ` · ${x.by}, ${when(x.at)}` : ''}`) : h('div', { class: 'muted small' }, `${label}: not uploaded`));

  mount(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `Inventory — ${monthName(month)}`),
        h('p', { class: 'muted' }, 'Warehouse and Portland units at cost against the GL, merch departments took, and the month’s two inventory JEs.')),
      h('div', { class: 'actions' },
        h('label', { class: 'month-pick' }, h('span', {}, 'Month'), h('input', { type: 'month', value: month, onchange: (e) => e.target.value && pick(e.target.value) })),
        fileButton('Warehouse export…', '.xlsx', onGrid),
        fileButton('Merch distribution sheet…', '.xlsx', (f) => onMany(f, parseDistribution, 'distribution', 'Merch distribution', 'MerchDistribution', (r) => `${Object.values(r.months).reduce((n, x) => n + x.length, 0)} lines`)),
        fileButton('Product sales report…', '.xlsx', (f) => onMany(f, parseProductSales, 'sales', 'Product sales', 'ProductSales', () => 'Salesforce product sales')),
        h('button', { onclick: () => editCosts(cfg, rerender) }, 'Costs…'))),
    h('div', { class: 'cards wide' }, h('div', { class: 'card' },
      stamp(rec.warehouse, 'Warehouse (Extensiv)'), stamp(rec.distributionFile, 'Merch distribution sheet'), stamp(rec.salesFile, 'Salesforce product sales'),
      h('div', { class: 'muted small' }, `GL before adjusting: ${balances ? `trial balance for ${short(addMonths(month, -1))}` : 'no trial balance for last month — type the balances below'}`))),

    h('h2', {}, 'Tie-out'),
    table([
      { label: 'Item', cell: (it) => h('div', {}, it.name, h('div', { class: 'muted small' }, `${it.account} · SKU ${it.skus.join(', ')}`)) },
      { label: 'Warehouse', num: true, cell: (it) => units(it.warehouse) },
      { label: 'Portland', num: true, cell: (it) => typed(it, 'pdx', pdx[it.id], `Portland count, ${it.short}`) },
      { label: 'Units', num: true, cell: (it) => units(it.units) },
      { label: 'Cost / unit', num: true, cell: (it) => (it.unitCost == null ? '' : it.unitCost.toFixed(2)) },
      { label: 'Ending value', num: true, cell: (it) => money(it.value) },
      { label: 'GL before', num: true, cell: (it) => (input.priorFrom[it.id] === 'tb' ? money(it.prior) : typed(it, 'priorTyped', rec.priorTyped?.[it.id], `GL balance, ${it.short}`)) },
      { label: 'Adjustment', num: true, cell: (it) => (it.diff == null ? '' : h('strong', {}, money(it.diff))) },
      { label: 'Departments', num: true, cell: (it) => money(it.allocated) },
      { label: 'Perks (020-320)', num: true, cell: (it) => money(it.perks) },
    ], t.items, { foot: (c) => ({ Item: 'Total', 'Ending value': money(round2(t.items.reduce((s, i) => s + (i.value || 0), 0))), Adjustment: money(round2(t.items.reduce((s, i) => s + (i.diff || 0), 0))) })[c.label] ?? '' }),
    t.items.some((i) => i.valueNote) ? h('div', { class: 'notice warn' }, t.items.filter((i) => i.valueNote).map((i) => `${i.name}: ${i.valueNote}`).join(' ')) : null,
    h('p', { class: 'muted small' }, `Units are the warehouse’s “Available Primary” plus the Portland count (it carries forward from the last month that has one; type a new count when there is one). Valued ${cfg.items.every((i) => i.method !== 'average') ? 'first in, first out: what’s left is the newest purchase' : 'per item as set in Costs'}. The adjustment is the ending value less the GL; departments’ share comes from the merch distribution sheet and the rest is Patron Care perks.`),
    h('details', {}, h('summary', {}, 'Additions this month (inventory purchases booked to the inventory accounts)'),
      h('div', { class: 'row' }, t.items.map((it) => field(it.short, typed(it, 'additions', rec.additions?.[it.id], `Additions, ${it.short}`))))),

    h('h2', {}, 'Merch departments took'),
    (rec.distribution || []).length ? table([
      { label: 'Department', cell: (d) => d.dept },
      { label: 'Item', cell: (d) => `${d.item}${d.info ? ` — ${d.info}` : ''}` },
      { label: 'Qty', num: true, cell: (d) => d.qty },
      { label: 'Cost', num: true, cell: (d) => money(d.cost) },
      { label: 'Account', cell: (d) => (d.account ? `${d.account} ${d.sub}` : h('span', { class: 'error' }, `no account for “${d.category || '?'}”`)) },
    ], rec.distribution, { foot: (c) => (c.label === 'Cost' ? money(t.distributionTotal) : c.label === 'Department' ? 'Total' : '') })
      : h('p', { class: 'muted' }, `Nothing from the merch distribution sheet for ${monthName(month)}.`),
    t.unmapped.length ? h('div', { class: 'notice warn' }, `${t.unmapped.length} line(s) have a category with no account (“None”), so they aren’t in the JE: ${t.unmapped.map((d) => d.item).join(', ')}.`) : null,

    h('h2', {}, `Merch purchases of ${money(cfg.inventoryThreshold)} or more`),
    big.length ? h('div', { class: 'notice warn' }, h('p', {}, 'A merch order this large is inventory, not an expense: add it as an item with its cost.'),
      h('ul', {}, big.map((b) => h('li', {}, `${b.date} ${b.batch} · ${b.account} · ${b.desc} · ${money(b.amount)}`))))
      : h('p', { class: 'muted small' }, gls.some((g) => g.month === month) ? `None in the GL for ${monthName(month)}.` : `Load the GL register for ${monthName(month)} to check.`),

    h('h2', {}, 'Journal entries'),
    jes.length ? jes.map((je) => h('div', { class: 'card', style: { marginBottom: '.8rem' } },
      h('div', { class: 'row' }, h('h3', {}, `Batch ${je.batch} — ${je.description}`), h('span', { class: 'spacer' }), je.balanced ? statusPill('Balances', 'good') : statusPill('Doesn’t balance', 'bad')),
      je.id === 'inventory-reclass' ? h('p', { class: 'small muted' }, reclass.groups.filter((g) => g.amount).map((g) => `${g.label} ${money(g.amount)}${g.discounts ? ` (sales ${money(g.sales)} less discounts ${money(-g.discounts)})` : ''}`).join(' · ')) : null,
      jeTable(je.lines))) : h('p', { class: 'muted' }, 'Nothing to book yet: upload the warehouse export (and the GL balances) for the adjustment, the product sales report for the reclass.'),
    jes.length ? h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => downloadJes(month, jes) }, 'Download for Acumatica')) : null);
}

function editCosts(cfg, rerender) {
  const items = structuredClone(cfg.items);
  panel('Inventory costs', (body, close) => {
    const host = h('div');
    const draw = () => mount(host, items.map((it) => h('div', { class: 'card', style: { marginBottom: '.8rem' } },
      h('div', { class: 'row' }, h('h3', {}, it.name), h('span', { class: 'spacer' }),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Method'), select([['fifo', 'First in, first out'], ['average', 'Average cost']], it.method, { onchange: (e) => { it.method = e.target.value; } }))),
      table([
        { label: 'Purchase', cell: (l) => h('input', { value: l.note || '', onchange: (e) => { l.note = e.target.value; } }) },
        { label: 'Units', num: true, cell: (l) => h('input', { class: 'num', size: 9, value: l.units ?? '', placeholder: 'any', onchange: (e) => { const v = parseAmount(e.target.value); l.units = Number.isFinite(v) ? v : null; } }) },
        { label: 'Total cost', num: true, cell: (l) => h('input', { class: 'num', size: 12, value: l.total ?? '', onchange: (e) => { const v = parseAmount(e.target.value); l.total = Number.isFinite(v) ? v : null; if (l.total != null) delete l.unitCost; } }) },
        { label: 'or cost per unit', num: true, cell: (l) => h('input', { class: 'num', size: 8, value: l.unitCost ?? '', onchange: (e) => { const v = parseAmount(e.target.value); l.unitCost = Number.isFinite(v) ? v : null; if (l.unitCost != null) { delete l.total; } } }) },
        { label: '', cell: (l) => h('button', { class: 'small-btn', onclick: () => { it.layers = it.layers.filter((x) => x !== l); draw(); } }, 'Remove') },
      ], it.layers),
      h('button', { class: 'small-btn', onclick: () => { it.layers.push({ note: 'New order', units: null, total: null }); draw(); } }, 'Add a purchase'),
      h('p', { class: 'muted small' }, `Oldest first. 1,000 units would be worth ${money(valueUnits(1000, it.layers, it.method).value)}.`))));
    draw();
    body.append(h('p', { class: 'small' }, 'Each purchase of an inventory item: units and what they cost in total (or a cost per unit when there’s no purchase on record). First in, first out values what’s on hand at the newest purchases’ cost.'), host,
      h('div', { class: 'row dialog-actions' }, h('button', { class: 'primary', onclick: async () => {
        for (const it of items) if (it.layers.some((l) => l.unitCost == null && !(l.units > 0 && l.total != null))) { toast(`${it.name}: each purchase needs units and a total cost, or a cost per unit.`, 'error'); return; }
        try { await saveInventoryConfig({ ...cfg, items }); toast('Saved.'); close(); rerender(); } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
      } }, 'Save')));
  }, { wide: true });
}
