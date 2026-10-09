// Fixed assets: the asset listing (imported from the Fixed Asset Listing workbook, then kept here),
// tied to the GL by account, the month's depreciation JE and any disposals.

import { h, mount, table, toast, fileButton, panel, ask, field, select, statusPill } from '../ui.js';
import { loadAssets, saveAsset, deleteAsset, loadConfig, saveConfig, loadTrialBalances } from '../data.js';
import { parseFaListing, listingSheets, defaultListingSheet } from '../fa/import.js';
import { buildDepreciationJE, buildDisposalsJE, isBalanced } from '../fa/je.js';
import { accumThrough, depreciationFor, isDisposedBefore, METHODS, CONVENTIONS, fullyDepreciatedMonth } from '../fa/engine.js';
import { firstKnownMonth } from '../fa/rollforward.js';
import { balancesFrom } from '../bs/cash.js';
import { downloadJes } from './month-jes.js';
import { jeTable } from './je-table.js';
import { readWorkbook } from '../xlsx-io.js';
import { explain } from '../store.js';
import { nowIso } from '../audit.js';
import { money, parseAmount, round2, sum } from '../money.js';
import { monthName, addMonths, currentMonth, lastDayOfMonth, monthOfDate } from '../fiscal.js';

const MONTH_KEY = 'monthclose:assets-month';
export const DEPRECIATION_BATCH = 9;
export const DISPOSAL_BATCH = 10;

// The month's JEs, in the shape the Acumatica download takes.
export function faJes(assets, month, config, priorBalances) {
  const out = [];
  const dep = buildDepreciationJE({ month, assets, config, priorBalances });
  if (dep.lines.some((l) => l.debit || l.credit)) out.push({ batch: DEPRECIATION_BATCH, id: 'depreciation', label: 'Depreciation', description: 'Depreciation', date: lastDayOfMonth(month), lines: dep.lines.filter((l) => l.debit || l.credit), problems: [], dep });
  const disp = buildDisposalsJE({ month, assets, config });
  if (disp.lines.length) out.push({ batch: DISPOSAL_BATCH, id: 'disposals', label: 'Disposals', description: 'Fixed Asset Disposals', date: lastDayOfMonth(month), lines: disp.lines, problems: [], disp });
  return out.map((je) => ({ ...je, balanced: isBalanced(je.lines) }));
}

// Accumulated depreciation per A/D account at the end of `month`, from the trial balances (as
// positive numbers), for the JE's true-up.
export function adBalances(tbBy, month, config) {
  const { balances } = balancesFrom(tbBy, month, addMonths(month, 1));
  if (!balances) return null;
  return Object.fromEntries(config.groups.map((g) => [g.ad, -(balances[g.ad]?.end || 0)]));
}

export default async function (main, { user, rerender }) {
  const [assets, cfg, tbs] = await Promise.all([loadAssets({ fresh: true }), loadConfig(), loadTrialBalances()]);
  const tbBy = Object.fromEntries(tbs.map((t) => [t.month, t]));
  const start = firstKnownMonth(assets);
  let month = null;
  try { month = localStorage.getItem(MONTH_KEY); } catch { /* ignore */ }
  if (!month) month = start && start <= addMonths(currentMonth(), -1) ? addMonths(currentMonth(), -1) : start || addMonths(currentMonth(), -1);
  const pick = (m) => { try { localStorage.setItem(MONTH_KEY, m); } catch { /* ignore */ } rerender(); };

  const head = h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, `Fixed assets — ${monthName(month)}`),
      h('p', { class: 'muted' }, 'The asset listing, tied to the GL by account, and the month’s depreciation and disposal JEs.')),
    h('div', { class: 'actions' },
      h('label', { class: 'month-pick' }, h('span', {}, 'Month'), h('input', { type: 'month', value: month, onchange: (e) => e.target.value && pick(e.target.value) })),
      fileButton('Import FA listing…', '.xlsx', (f) => importListing(f, assets, user, rerender)),
      h('button', { onclick: () => editAsset(null, cfg, user, rerender) }, 'Add an asset…'),
      h('button', { onclick: () => editAccounts(cfg, rerender) }, 'JE accounts…')));

  if (!assets.length) {
    mount(main, head, h('div', { class: 'notice' }, 'No assets yet. Import the Fixed Asset Listing workbook: each asset comes in with what’s left to depreciate as of the month the listing runs through, and the app carries on from the month after.'));
    return;
  }

  const before = start && month < start;
  const { balances, tb } = balancesFrom(tbBy, month, addMonths(month, 1));
  const prior = adBalances(tbBy, addMonths(month, -1), cfg);
  const jes = before ? [] : faJes(assets, month, cfg, prior);
  const live = (a) => !(a.disposal?.date && monthOfDate(a.disposal.date) <= month);
  const groups = cfg.groups.map((g) => {
    const list = assets.filter((a) => a.group === g.asset);
    const on = list.filter(live);
    const cost = round2(sum(on, (a) => a.cost)), accum = round2(sum(on, (a) => accumThrough(a, month)));
    const glCost = balances ? balances[g.asset]?.end || 0 : null, glAd = balances ? -(balances[g.ad]?.end || 0) : null;
    return { ...g, list, on, cost, accum, glCost, glAd, costDiff: glCost == null ? null : round2(cost - glCost), adDiff: glAd == null ? null : round2(accum - glAd) };
  }).filter((g) => g.list.length || g.glCost);
  const under = assets.filter((a) => a.source?.kind !== 'import' && a.cost < (cfg.capitalizationThreshold || 7500));

  const diff = (v) => (v == null ? '' : v === 0 ? h('span', { class: 'good-text' }, '✓') : h('span', { class: 'error' }, money(v)));
  mount(main, head,
    before ? h('div', { class: 'notice warn' }, `The listing was imported as of ${monthName(addMonths(start, -1))}: the app depreciates from ${monthName(start)} on. Earlier months are in the workbook.`) : null,
    h('h2', {}, 'Tie-out to the GL'),
    table([
      { label: 'Account', cell: (g) => h('div', {}, `${g.asset} / ${g.ad}`, h('div', { class: 'muted small' }, g.name)) },
      { label: 'Assets', num: true, cell: (g) => g.on.length },
      { label: 'Cost', num: true, cell: (g) => money(g.cost) },
      { label: 'GL cost', num: true, cell: (g) => (g.glCost == null ? '' : money(g.glCost)) },
      { label: '', cell: (g) => diff(g.costDiff) },
      { label: 'A/D', num: true, cell: (g) => money(g.accum) },
      { label: 'GL A/D', num: true, cell: (g) => (g.glAd == null ? '' : money(g.glAd)) },
      { label: ' ', cell: (g) => diff(g.adDiff) },
      { label: 'Net book value', num: true, cell: (g) => money(round2(g.cost - g.accum)) },
    ], groups, { foot: (c) => ({ Account: 'Total', Cost: money(round2(sum(groups, (g) => g.cost))), 'A/D': money(round2(sum(groups, (g) => g.accum))), 'Net book value': money(round2(sum(groups, (g) => g.cost - g.accum))) })[c.label] ?? '' }),
    h('p', { class: 'muted small' }, balances ? `GL from the trial balance for ${monthName(tb.month)}${tb.month === month ? '' : ' (its beginning balances)'}. A difference of a cent or two is the old listing’s rounding.` : `Upload the trial balance for ${monthName(month)} on the Balance sheet tab to tie the listing to the GL.`),
    under.length ? h('div', { class: 'notice warn' }, `Under the ${money(cfg.capitalizationThreshold || 7500)} capitalization threshold (expense these instead): ${under.map((a) => `${a.name} ${money(a.cost)}`).join(', ')}.`) : null,

    h('h2', {}, `Journal entries — ${monthName(month)}`),
    jes.length ? jes.map((je) => h('div', { class: 'card', style: { marginBottom: '.8rem' } },
      h('div', { class: 'row' }, h('h3', {}, `Batch ${je.batch} — ${je.label}`), h('span', { class: 'spacer' }), je.balanced ? statusPill('Balances', 'good') : statusPill('Doesn’t balance', 'bad')),
      je.dep ? h('p', { class: 'small muted' }, je.dep.basis === 'true-up'
        ? `Brings each A/D account to the schedule as of ${monthName(month)}, from the trial balance at the end of ${monthName(addMonths(month, -1))}${je.dep.perGroup.some((g) => g.variance) ? ` — including ${je.dep.perGroup.filter((g) => g.variance).map((g) => `${g.ad} ${money(g.variance)}`).join(', ')} the GL was off by` : ''}.`
        : `The month’s scheduled depreciation. With last month’s trial balance it would true each A/D account up to the schedule.`) : null,
      je.disp ? h('p', { class: 'small muted' }, `${je.disp.assets.length} asset(s) disposed: ${je.disp.assets.map((a) => a.name).join(', ')}.`) : null,
      jeTable(je.lines))) : h('p', { class: 'muted' }, before ? '' : `Nothing to book for ${monthName(month)}.`),
    jes.length ? h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => downloadJes(month, jes) }, 'Download for Acumatica')) : null,

    h('h2', {}, 'Assets'),
    groups.map((g) => h('details', { 'data-key': g.asset },
      h('summary', {}, `${g.asset} ${g.name} — ${g.on.length} in service, net ${money(round2(g.cost - g.accum))}`),
      table([
        { label: 'Name', cell: (a) => a.name },
        { label: 'In service', cell: (a) => a.inService || '' },
        { label: 'Cost', num: true, cell: (a) => money(a.cost) },
        { label: 'This month', num: true, cell: (a) => (isDisposedBefore(a, month) ? '' : money(depreciationFor(a, month))) },
        { label: 'A/D', num: true, cell: (a) => money(accumThrough(a, a.disposal?.date && monthOfDate(a.disposal.date) <= month ? monthOfDate(a.disposal.date) : month)) },
        { label: 'Status', cell: (a) => (a.disposal?.date ? statusPill(`Disposed ${a.disposal.date}`, 'neutral') : a.status === 'cip' ? statusPill('In progress', 'info') : (fullyDepreciatedMonth(a) || '9999') <= month ? statusPill('Fully depreciated', 'neutral') : statusPill('Depreciating', 'good')) },
      ], g.list.sort((x, y) => String(y.inService).localeCompare(String(x.inService))), { rowProps: (a) => ({ class: 'clickable', onclick: () => editAsset(a, cfg, user, rerender) }) }))));
}

async function importListing(file, existing, user, rerender) {
  try {
    const { XLSX, wb } = await readWorkbook(file);
    const sheets = listingSheets(wb);
    const sheet = sheets.length > 1 ? defaultListingSheet(wb) : sheets[0];
    const res = parseFaListing(XLSX, wb, sheet);
    const toDelete = res.assets.filter((a) => /\bdelete\b/i.test(a.name));
    await panel('Import the fixed asset listing', (body, close) => {
      const markDelete = h('input', { type: 'checkbox', checked: true });
      body.append(
        h('p', {}, `“${res.sheetName}”: ${res.assets.length} assets, depreciated through ${monthName(res.cutover)}. The app carries on from ${monthName(addMonths(res.cutover, 1))}.`),
        table([{ label: 'Account', cell: (b) => b.group || '—' }, { label: 'Name', cell: (b) => b.name }, { label: 'Assets', num: true, cell: (b) => b.count }, { label: 'Cost', num: true, cell: (b) => money(b.sheetCost) }], res.blocks.filter((b) => b.count)),
        res.warnings.length ? h('div', { class: 'notice warn' }, h('strong', {}, 'Check these in the workbook:'), h('ul', {}, res.warnings.map((w) => h('li', {}, w)))) : null,
        toDelete.length ? h('label', { class: 'row' }, markDelete, `${toDelete.length} assets are named “Delete” (${money(round2(sum(toDelete, (a) => a.cost)))}). Mark them disposed at the end of ${monthName(res.cutover)} — the disposal JE for them was booked in Acumatica.`) : null,
        existing.length ? h('div', { class: 'notice warn' }, `This replaces the ${existing.length} assets already in the app, and anything typed about them.`) : null,
        h('div', { class: 'row dialog-actions' }, h('button', { class: 'primary', onclick: async (e) => {
          if (existing.length && !(await ask('Replace the asset listing?', `The ${existing.length} assets in the app are deleted and the ${res.assets.length} from the workbook take their place. This can’t be undone.`, { ok: 'Replace', danger: true }))) return;
          e.target.disabled = true;
          try {
            for (const a of existing) await deleteAsset(a.id);
            let n = 0;
            for (const a of res.assets) {
              const rec = { ...a, importedBy: user, importedAt: nowIso(), importedFrom: file.name };
              if (markDelete.checked && toDelete.includes(a)) rec.disposal = { date: lastDayOfMonth(res.cutover), proceeds: 0, booked: true, note: 'Disposed at fiscal year end; booked in Acumatica.' };
              await saveAsset(rec);
              if (++n % 20 === 0) e.target.textContent = `Saving ${n} of ${res.assets.length}…`;
            }
            toast(`${res.assets.length} assets imported.`); close(); rerender();
          } catch (err) { e.target.disabled = false; toast(explain(err, 'The import stopped part way. Import again to finish.'), 'error'); }
        } }, `Import ${res.assets.length} assets`)));
    }, { wide: true });
  } catch (err) { toast(explain(err, `${file.name}:`), 'error'); }
}

function editAsset(asset, cfg, user, rerender) {
  const a = asset ? structuredClone(asset) : { id: `fa-${Date.now().toString(36)}`, name: '', group: cfg.groups[0].asset, cost: null, salvage: 0, inService: '', lifeMonths: 60, method: 'SL', convention: 'next-month', status: 'active', source: { kind: 'typed' } };
  panel(asset ? asset.name : 'Add an asset', (body, close) => {
    const name = h('input', { value: a.name, autofocus: !asset });
    const group = select(cfg.groups.map((g) => [g.asset, `${g.asset} ${g.name}`]), a.group);
    const cost = h('input', { class: 'num', value: a.cost ?? '' });
    const inService = h('input', { type: 'date', value: a.inService || '' });
    const life = h('input', { class: 'num', value: a.lifeMonths ?? 60 });
    const method = select(Object.entries(METHODS), a.method);
    const conv = select(Object.entries(CONVENTIONS), a.convention || 'next-month');
    const cip = h('input', { type: 'checkbox', checked: a.status === 'cip' });
    const dDate = h('input', { type: 'date', value: a.disposal?.date || '' });
    const dProceeds = h('input', { class: 'num', value: a.disposal?.proceeds ?? '' });
    body.append(
      h('div', { class: 'form-grid' }, field('Name', name), field('Asset account', group), field('Cost', cost), field('In service', inService),
        field('Life (months)', life), field('Method', method), field('Convention', conv)),
      h('label', { class: 'row' }, cip, 'Construction in progress (not depreciated until it’s in service)'),
      a.method === 'FIXED' ? h('p', { class: 'muted small' }, `Imported: ${money(a.fixedMonthly)} a month from the listing, from ${money(a.openingAD)} depreciated through ${a.openingAsOf}.`) : null,
      h('h3', {}, 'Disposal'),
      h('div', { class: 'form-grid' }, field('Date disposed', dDate), field('Proceeds', dProceeds, 'Money received for it, if any.')),
      a.disposal?.booked ? h('p', { class: 'muted small' }, a.disposal.note || 'Booked in Acumatica before the app.') : null,
      h('div', { class: 'row dialog-actions' },
        asset ? h('button', { class: 'danger', onclick: async () => {
          if (!(await ask('Delete this asset?', `${asset.name} is removed from the listing, as if it had never been bought. To record selling or scrapping it, give it a disposal date instead.`, { ok: 'Delete', danger: true }))) return;
          try { await deleteAsset(asset.id); toast('Deleted.'); close(); rerender(); } catch (err) { toast(explain(err, 'Couldn’t delete.'), 'error'); }
        } }, 'Delete') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'primary', onclick: async () => {
          const c = parseAmount(cost.value), l = parseAmount(life.value), p = dProceeds.value.trim() ? parseAmount(dProceeds.value) : 0;
          if (!name.value.trim() || !Number.isFinite(c) || !inService.value || !(l > 0)) { toast('Give it a name, a cost, an in-service date and a life.', 'error'); return; }
          if (!Number.isFinite(p)) { toast('Proceeds should be a number.', 'error'); return; }
          if (!asset && c < (cfg.capitalizationThreshold || 7500) && !(await ask('Under the capitalization threshold', `${money(c)} is under ${money(cfg.capitalizationThreshold || 7500)}: it would normally be expensed, not added as an asset. Add it anyway?`, { ok: 'Add anyway' }))) return;
          const rec = { ...a, name: name.value.trim(), group: group.value, cost: round2(c), inService: inService.value, lifeMonths: Math.round(l), method: method.value, convention: conv.value,
            status: cip.checked ? 'cip' : 'active', disposal: dDate.value ? { ...(a.disposal || {}), date: dDate.value, proceeds: round2(p) } : null, updatedBy: user, updatedAt: nowIso() };
          if (rec.method !== 'FIXED') { delete rec.fixedMonthly; }
          try { await saveAsset(rec); toast('Saved.'); close(); rerender(); } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
        } }, 'Save')));
  }, { wide: true });
}

function editAccounts(cfg, rerender) {
  panel('Fixed asset JE accounts', (body, close) => {
    const d = cfg.disposal;
    const inputs = { gainLossAccount: h('input', { value: d.gainLossAccount }), gainLossSub: h('input', { value: d.gainLossSub }), proceedsAccount: h('input', { value: d.proceedsAccount }), proceedsSub: h('input', { value: d.proceedsSub }) };
    const exp = { account: h('input', { value: cfg.expense.account }), sub: h('input', { value: cfg.expense.sub }) };
    const threshold = h('input', { class: 'num', value: cfg.capitalizationThreshold ?? 7500 });
    body.append(
      h('h3', {}, 'Depreciation'), h('div', { class: 'form-grid' }, field('Expense account', exp.account), field('Subaccount', exp.sub)),
      h('h3', {}, 'Disposals'), h('div', { class: 'form-grid' }, field('Gain/loss account', inputs.gainLossAccount), field('Subaccount', inputs.gainLossSub),
        field('Proceeds were booked to', inputs.proceedsAccount, 'The JE moves money received out of here.'), field('Subaccount', inputs.proceedsSub)),
      h('h3', {}, 'Capitalization'), field('Threshold', threshold, 'Assets under this are expensed.'),
      h('div', { class: 'row dialog-actions' }, h('button', { class: 'primary', onclick: async () => {
        const next = { ...cfg, expense: { ...cfg.expense, account: exp.account.value.trim(), sub: exp.sub.value.trim() },
          disposal: { ...d, ...Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()])) }, capitalizationThreshold: parseAmount(threshold.value) || 7500 };
        try { await saveConfig(next); toast('Saved.'); close(); rerender(); } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
      } }, 'Save')));
  });
}
