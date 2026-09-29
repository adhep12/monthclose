// The month's journal entries: a preview of each, and one Acumatica import file with all of them.

import { h, table, statusPill, toast } from '../ui.js';
import { monthJes, jeReady, importRows, IMPORT_COL_WIDTHS } from '../je/month.js';
import { downloadWorkbook } from '../xlsx-io.js';
import { money } from '../money.js';
import { monthName } from '../fiscal.js';

export async function downloadJes(m, jes) {
  const ready = jes.filter(jeReady);
  if (!ready.length) { toast('No journal entries are ready for this month yet.', 'error'); return; }
  const name = ready.length === 1 ? `${ready[0].label} JE` : 'JEs';
  await downloadWorkbook(`${name} - ${monthName(m)}.xlsx`, [{ name: 'Acumatica', rows: importRows(ready), cols: IMPORT_COL_WIDTHS }]);
}

function jeStatus(je) {
  if (je.missing) return statusPill(je.missing, 'neutral');
  if (je.problems.length) return statusPill('Check the file', 'bad');
  if (!je.balanced) return statusPill('Doesn’t balance', 'bad');
  return statusPill('Ready', 'good');
}

export function jePreview(je) {
  return h('div', {},
    je.problems.length ? h('div', { class: 'notice warn' }, h('ul', {}, je.problems.map((p) => h('li', {}, p)))) : null,
    je.lines.length ? table([
      { label: 'Account', cell: (l) => l.account },
      { label: 'Subaccount', cell: (l) => l.sub },
      { label: 'Debit', num: true, cell: (l) => money(l.debit) },
      { label: 'Credit', num: true, cell: (l) => money(l.credit) },
      { label: 'Transaction description', cell: (l) => l.tranDescription },
    ], je.lines, { foot: (c) => (c.label === 'Debit' ? money(je.debits) : c.label === 'Credit' ? money(je.credits) : c.label === 'Account' ? 'Total' : '') }) : null,
    je.lines.length && !je.balanced ? h('p', { class: 'error' }, 'This entry doesn’t balance.') : null);
}

// One process's JE, for its account pop-up.
export function accountJeBlock(rec, id) {
  const je = monthJes(rec).find((x) => x.id === id);
  if (!je || je.missing) return null;
  return h('div', {},
    h('h3', {}, `Journal entry: batch ${je.batch}, ${je.description}`),
    h('div', { class: 'row' }, jeStatus(je), h('span', { class: 'small muted' }, ` dated ${je.date}`), h('span', { class: 'spacer' }),
      h('button', { class: 'small-btn', disabled: !jeReady(je), onclick: () => downloadJes(rec.month, [je]) }, 'Download for Acumatica')),
    jePreview(je));
}

// Every JE for the month, for the month pop-up.
export function monthJeBlock(rec) {
  const jes = monthJes(rec);
  const ready = jes.filter(jeReady);
  return h('div', {},
    h('h3', {}, 'Journal entries'),
    h('p', { class: 'muted small' }, 'Built from the statements attached to this month. The download is one file for Acumatica’s import, each entry its own batch number.'),
    table([
      { label: 'Batch', cell: (je) => String(je.batch) },
      { label: 'Entry', cell: (je) => je.description },
      { label: 'Amount', num: true, cell: (je) => (je.lines.length ? money(je.debits) : '') },
      { label: 'Status', cell: jeStatus },
    ], jes),
    jes.filter((je) => je.lines.length).map((je) => h('details', { class: 'small' }, h('summary', {}, `Batch ${je.batch}: ${je.description}`), jePreview(je))),
    h('div', { class: 'row', style: { marginTop: '.5rem' } },
      h('button', { class: 'primary', disabled: !ready.length, onclick: () => downloadJes(rec.month, jes) },
        ready.length ? `Download ${ready.length === 1 ? 'the JE' : `all ${ready.length} JEs`} for Acumatica` : 'No JEs ready yet')));
}
