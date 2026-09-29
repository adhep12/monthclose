// A month's journal entries, and the one file that imports them all into Acumatica. The file is
// laid out like the Acumatica tab of the "Month Close Bank Recs" workbook: one row per line,
// BatchNbr keeping each entry's lines together. Each process has its own batch number.

import { stripeJe, STRIPE_JE } from './stripe.js';
import { isBalanced } from '../fa/je.js';
import { round2, sum } from '../money.js';
import { lastDayOfMonth } from '../fiscal.js';

export const IMPORT_COLUMNS = ['BatchNbr', 'Transaction Date', 'Document Description', 'Account', 'Subaccount',
  'Debit Amount', 'Credit Amount', 'Transaction Description'];

// Batch numbers, in order. More are added as each process's JE is set up.
export const JE_BATCHES = [
  { batch: 1, id: 'stripe', label: 'Stripe', description: STRIPE_JE.description, needs: 'the Stripe CSV',
    build: (rec) => (rec.stripe ? stripeJe(rec.stripe) : null) },
];

// Every JE the month has a file for: { batch, id, label, description, date, lines, problems, balanced }.
// A process with no file yet is listed with `missing`.
export function monthJes(rec) {
  return JE_BATCHES.map((b) => {
    const built = b.build(rec || {});
    const base = { batch: b.batch, id: b.id, label: b.label, description: b.description, date: lastDayOfMonth(rec.month) };
    if (!built) return { ...base, missing: `Attach ${b.needs}.`, lines: [], problems: [] };
    return { ...base, ...built, balanced: isBalanced(built.lines),
      debits: round2(sum(built.lines, (l) => l.debit)), credits: round2(sum(built.lines, (l) => l.credit)) };
  });
}

// A JE is ready to import when it has lines, balances and nothing is wrong with its file.
export const jeReady = (je) => je.lines.length > 0 && je.balanced && !je.problems.length;

// Excel's date serial for 'YYYY-MM-DD'.
const serial = (iso) => (Date.UTC(...iso.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0))) - Date.UTC(1899, 11, 30)) / 86400000;

// Rows for the import sheet, header first. Accounts are numbers and an empty side is blank, as
// in the workbook.
export function importRows(jes) {
  const rows = [IMPORT_COLUMNS];
  for (const je of jes) {
    for (const l of je.lines) {
      rows.push([{ v: je.batch, z: '0' }, { v: serial(je.date), z: 'm/d/yy' }, je.description,
        /^\d+$/.test(l.account) ? { v: Number(l.account), z: '0' } : l.account, l.sub,
        l.debit ? l.debit : '', l.credit ? l.credit : '', l.tranDescription]);
    }
  }
  return rows;
}
export const IMPORT_COL_WIDTHS = [9, 16, 24, 9, 11, 14, 14, 30];
