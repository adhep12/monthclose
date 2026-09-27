import { h, mount, table, toast, fileButton } from '../ui.js';
import { loadPocMonths, loadPocMonth, replacePocMonth } from '../data.js';
import { readWorkbook } from '../xlsx-io.js';
import { parsePocWorkbook } from '../poc/import.js';
import { computePoc } from '../poc/calc.js';
import { money } from '../money.js';
import { addMonths, monthName } from '../fiscal.js';
import { explain } from '../store.js';
import { logChange } from '../audit.js';

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
      // Months already in the app: skip them, add only what statements can't supply, or replace them.
      const mode = h('select', {}, h('option', { value: 'merge', selected: true }, 'Add deposits in transit and hand adjustments only — keep attached statements and typed figures'),
        h('option', { value: 'skip' }, 'Skip them'), h('option', { value: 'overwrite' }, 'Replace them with the workbook (removes attached statements)'));
      const go = h('button', { class: 'primary' }, 'Import');
      go.addEventListener('click', async () => {
        go.disabled = true;
        let n = 0;
        try {
          const merged = [];
          for (const { r, exists } of rows) {
            if (exists && mode.value === 'skip') continue;
            if (exists && mode.value === 'merge') {
              const cur = await loadPocMonth(r.month);
              const added = mergeFromWorkbook(cur, r, user);
              if (added.length) { await replacePocMonth(cur); merged.push(`${monthName(r.month)}: ${added.join(', ')}`); n++; }
              continue;
            }
            await replacePocMonth({ ...r, importedBy: user, importedAt: new Date().toISOString() });
            n++;
          }
          if (merged.length) console.info('Merged from the workbook:\n' + merged.join('\n'));
          toast(`Imported ${n} months into FY${res.fiscalYear}.`);
          try { localStorage.setItem('monthclose:poc-fy', String(res.fiscalYear)); } catch { /* ignore */ }
          location.hash = '#/poc';
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
        rows.some((x) => x.exists) ? h('label', { class: 'field', style: { marginTop: '.5rem' } }, h('span', { class: 'field-label' }, 'Months already in the app'), mode,
          h('span', { class: 'field-hint' }, 'Adding brings in the workbook’s deposits in transit (for months with none entered) and its hand-entered adjustments — CC rewards, reimbursements, returned wires, transfers into Operating. It leaves out Stripe transfers, wire sweeps, Wise and Fidelity transfers, which the statements work out.')) : null,
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

// Bring the parts of a workbook month that statements can't supply into a month already in the
// app. Returns what was added, for the log.
const FROM_STATEMENTS = /stripe transfers|wire sweep|wise transfers|fidelity investment transfer/i;
export function mergeFromWorkbook(cur, r, user) {
  const added = [];
  cur.dit ||= []; cur.adjustments ||= []; cur.timing ||= {};
  if (!cur.dit.length && r.dit.length) { cur.dit = r.dit.map((d) => ({ ...d })); added.push(`${r.dit.length} deposits in transit`); }
  for (const a of r.adjustments) {
    if (FROM_STATEMENTS.test(a.label)) continue;
    if (cur.adjustments.some((x) => x.label === a.label && x.amount === a.amount)) continue;
    cur.adjustments.push({ ...a, enteredBy: user, enteredAt: new Date().toISOString() });
    added.push(`${a.label} ${money(a.amount)}`);
  }
  for (const k of ['restricted', 'merchAR']) if (cur.timing[k] == null && r.timing[k] != null) { cur.timing[k] = r.timing[k]; added.push(k === 'restricted' ? 'restricted revenue change' : 'merchandise AR'); }
  if (added.length) logChange(cur, user, `From the workbook: ${added.join(', ')}`);
  return added;
}
