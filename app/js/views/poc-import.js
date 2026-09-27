import { h, mount, table, toast, fileButton } from '../ui.js';
import { loadPocMonths, replacePocMonth } from '../data.js';
import { readWorkbook } from '../xlsx-io.js';
import { parsePocWorkbook } from '../poc/import.js';
import { computePoc } from '../poc/calc.js';
import { money } from '../money.js';
import { addMonths, monthName } from '../fiscal.js';
import { explain } from '../store.js';

export default async function (main, { user }) {
  const existing = await loadPocMonths();
  const out = h('div');

  async function onFile(file) {
    mount(out, h('p', { class: 'muted' }, `Reading ${file.name}…`));
    try {
      const { XLSX, wb } = await readWorkbook(file);
      const res = parsePocWorkbook(XLSX, wb);
      const byMonth = Object.fromEntries(res.records.map((r) => [r.month, r]));
      const rows = res.records.map((r) => ({
        r, exists: existing.some((e) => e.month === r.month),
        c: r.source.ditOnly ? null : computePoc(r, { prior: byMonth[addMonths(r.month, -1)] }),
      }));
      const overwrite = h('input', { type: 'checkbox' });
      const go = h('button', { class: 'primary' }, 'Import');
      go.addEventListener('click', async () => {
        go.disabled = true;
        let n = 0;
        try {
          for (const { r, exists } of rows) {
            if (exists && !overwrite.checked) continue;
            await replacePocMonth({ ...r, importedBy: user, importedAt: new Date().toISOString() });
            n++;
          }
          toast(`Imported ${n} months.`);
          location.hash = '#/poc/ytd';
        } catch (err) { toast(explain(err, `Stopped after ${n} months.`), 'error'); go.disabled = false; }
      });
      mount(out,
        h('p', {}, `FY${res.fiscalYear}. The difference column is recalculated by the app — it should match row 31 of the workbook.`),
        table([
          { label: 'Month', cell: (x) => monthName(x.r.month) },
          { label: 'What', cell: (x) => (x.r.source.ditOnly ? 'Deposits in transit only' : `${Object.keys(x.r.bank).length} bank lines, ${x.r.adjustments.length} adjustments, ${x.r.dit.length} DIT`) },
          { label: 'Adjusted bank revenue', num: true, cell: (x) => (x.c ? money(x.c.revAdjusted) : '') },
          { label: 'GL revenue', num: true, cell: (x) => (x.c?.glRev != null ? money(x.c.glRev) : '') },
          { label: 'Difference', num: true, cell: (x) => (x.c?.diffRev != null ? money(x.c.diffRev) : '') },
          { label: '', cell: (x) => (x.exists ? h('span', { class: 'pill warn' }, 'already in the app') : '') },
        ], rows),
        rows.some((x) => x.exists) ? h('label', { class: 'row', style: { marginTop: '.5rem' } }, overwrite, 'Overwrite months already in the app') : null,
        res.warnings.length ? h('div', { class: 'notice warn' }, h('ul', {}, res.warnings.map((w) => h('li', {}, w)))) : null,
        h('div', { class: 'row', style: { marginTop: '.75rem' } }, go));
    } catch (err) {
      mount(out, h('div', { class: 'notice bad' }, err.message || String(err)));
    }
  }

  mount(main,
    h('p', { class: 'small' }, h('a', { href: '#/poc' }, '← Proof of cash')),
    h('h1', {}, 'Import the Proof of Cash workbook'),
    h('p', { class: 'muted' }, 'Brings in each month’s bank lines, adjustments, deposits in transit and GL figures, so the fiscal year view is complete and next month’s deposit-in-transit change has something to compare with.'),
    h('div', { class: 'row' }, fileButton('Choose workbook…', '.xlsx,.xls', onFile, { class: 'primary' })),
    out);
}
