import { h, mount, table, toast, fileButton, select } from '../ui.js';
import { loadAssets, loadConfig, saveAsset } from '../data.js';
import { readWorkbook } from '../xlsx-io.js';
import { parseFaListing, listingSheets, defaultListingSheet } from '../fa/import.js';
import { priorMonthTB } from './fa-je.js';
import { balanceAtEndOf } from '../tb.js';
import { money, round2, sum } from '../money.js';
import { addMonths, monthName } from '../fiscal.js';
import { explain } from '../store.js';

export default async function (main, { user }) {
  const [existing, cfg] = await Promise.all([loadAssets(), loadConfig()]);
  const out = h('div');

  async function onFile(file) {
    mount(out, h('p', { class: 'muted' }, `Reading ${file.name}…`));
    try {
      const { XLSX, wb } = await readWorkbook(file);
      const sheets = listingSheets(wb);
      if (!sheets.length) throw new Error('No “FA Listing …” sheets in that workbook.');
      const sheetSel = select(sheets.map((s) => [s, s]), defaultListingSheet(wb));
      const body = h('div');
      sheetSel.addEventListener('change', () => show(XLSX, wb, sheetSel.value, body));
      mount(out, h('div', { class: 'row' }, h('span', { class: 'field-label' }, 'Sheet'), sheetSel), body);
      await show(XLSX, wb, sheetSel.value, body);
    } catch (err) {
      mount(out, h('div', { class: 'notice bad' }, err.message || String(err)));
    }
  }

  async function show(XLSX, wb, sheet, body) {
    let res;
    try { res = parseFaListing(XLSX, wb, sheet); }
    catch (err) { mount(body, h('div', { class: 'notice bad' }, err.message)); return; }

    // Tie the imported balances to the GL at the cutover month end, if we have a TB for it.
    const tbInfo = await priorMonthTB(addMonths(res.cutover, 1));
    const groups = [...new Set(res.assets.map((a) => a.group))];
    const tie = groups.map((g) => {
      const list = res.assets.filter((a) => a.group === g);
      const ad = cfg.groups.find((x) => x.asset === g)?.ad;
      const cost = round2(sum(list, (a) => a.cost));
      const accum = round2(sum(list, (a) => a.openingAD));
      const glCost = tbInfo ? round2(balanceAtEndOf(tbInfo.tb, g, res.cutover)) : null;
      const glAD = tbInfo && ad ? round2(-balanceAtEndOf(tbInfo.tb, ad, res.cutover)) : null;
      return { g, name: cfg.groups.find((x) => x.asset === g)?.name || '(not set up)', ad, count: list.length, cost, accum, glCost, glAD };
    });
    const unknown = groups.filter((g) => !cfg.groups.some((x) => x.asset === g));
    const updates = res.assets.filter((a) => existing.some((e) => e.id === a.id)).length;
    const diffCell = (a, b) => (b == null ? '—' : round2(a - b) === 0 ? h('span', { class: 'pill good' }, 'ties') : h('span', { class: 'error' }, money(round2(a - b))));

    const go = h('button', { class: 'primary', onclick: () => doImport(res, go) }, `Import ${res.assets.length} assets`);

    mount(body,
      h('p', {}, `${res.sheetName}: FY${res.fiscalYear}, depreciated through ${monthName(res.cutover)} (${res.monthsIn} months). `,
        `Opening balances are as of the end of ${monthName(res.cutover)}; the app takes over from ${monthName(addMonths(res.cutover, 1))}.`),
      tbInfo ? null : h('div', { class: 'notice warn' }, `No trial balance for ${monthName(addMonths(res.cutover, 1))} or ${monthName(res.cutover)} is uploaded, so the import can’t be tied to the GL yet. `, h('a', { href: '#/tb' }, 'Upload one'), ' first if you want the check.'),
      table([
        { label: 'Asset account', cell: (r) => `${r.g} · ${r.name}` },
        { label: 'Assets', num: true, cell: (r) => r.count },
        { label: 'Cost', num: true, cell: (r) => money(r.cost) },
        { label: 'GL cost', num: true, cell: (r) => (r.glCost == null ? '—' : money(r.glCost)) },
        { label: 'Diff', num: true, cell: (r) => diffCell(r.cost, r.glCost) },
        { label: 'Accum. dep.', num: true, cell: (r) => money(r.accum) },
        { label: 'GL A/D', num: true, cell: (r) => (r.glAD == null ? '—' : money(r.glAD)) },
        { label: 'Diff ', num: true, cell: (r) => diffCell(r.accum, r.glAD) },
      ], tie, { foot: (c) => ({ 'Asset account': 'Total', Assets: sum(tie, (r) => r.count), Cost: money(sum(tie, (r) => r.cost)), 'Accum. dep.': money(sum(tie, (r) => r.accum)) })[c.label] ?? '' }),
      h('p', { class: 'muted small' }, 'Differences of a cent or two are rounding in the spreadsheet. Anything larger is worth a look before importing — e.g. construction in progress that was expensed in the GL but is still on the listing.'),
      unknown.length ? h('div', { class: 'notice bad' }, `These asset accounts aren’t set up in Settings: ${unknown.join(', ')}. Add them there first.`) : null,
      res.warnings.length ? h('div', { class: 'notice warn' }, h('strong', {}, `${res.warnings.length} things to check:`), h('ul', {}, res.warnings.map((w) => h('li', {}, w)))) : null,
      updates ? h('p', {}, `${updates} of these were imported before and will be overwritten with the values from this sheet (disposals recorded in the app are kept).`) : null,
      h('div', { class: 'row' }, go, h('a', { href: '#/fa', class: 'btn' }, 'Cancel')),
    );
    if (unknown.length) go.disabled = true;
  }

  async function doImport(res, btn) {
    btn.disabled = true;
    let done = 0;
    try {
      for (const a of res.assets) {
        const prev = existing.find((e) => e.id === a.id);
        await saveAsset({ ...a, disposal: prev?.disposal || null, notes: prev?.notes || '', serial: prev?.serial || '',
          createdBy: prev?.createdBy || user, createdAt: prev?.createdAt || new Date().toISOString(),
          updatedBy: user, updatedAt: new Date().toISOString() });
        done++;
        btn.textContent = `Importing… ${done}/${res.assets.length}`;
      }
      toast(`Imported ${done} assets.`);
      location.hash = '#/fa';
    } catch (err) {
      toast(explain(err, `Stopped after ${done} of ${res.assets.length}. Running the import again picks up where it left off.`), 'error');
      btn.disabled = false;
      btn.textContent = 'Try again';
    }
  }

  mount(main,
    h('p', { class: 'small' }, h('a', { href: '#/fa' }, '← Fixed assets')),
    h('h1', {}, 'Import the FA listing'),
    h('p', { class: 'muted' }, 'Upload the Fixed Asset Listing workbook. Each asset comes in with its cost, monthly amount and remaining balance from the sheet; from then on the app calculates depreciation. Nothing is saved until you press Import.'),
    h('div', { class: 'row' }, fileButton('Choose workbook…', '.xlsx,.xls', onFile, { class: 'primary' })),
    out,
  );
}
