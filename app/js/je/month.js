// A month's journal entries, and the one file that imports them all into Acumatica. The file is
// laid out like the Acumatica tab of the "Month Close Bank Recs" workbook: one row per line,
// BatchNbr keeping each entry's lines together. Each process has its own batch number.

import { stripeJe, STRIPE_JE } from './stripe.js';
import { investmentJe } from './investments.js';
import { paypalJe, PAYPAL_JE } from './paypal.js';
import { isBalanced } from '../fa/je.js';
import { round2, sum } from '../money.js';
import { lastDayOfMonth } from '../fiscal.js';

export const IMPORT_COLUMNS = ['BatchNbr', 'Transaction Date', 'Document Description', 'Account', 'Subaccount',
  'Debit Amount', 'Credit Amount', 'Transaction Description'];

// Batch numbers, in order. More are added as each process's JE is set up.
// `build(rec, ctx)`: ctx.recs is every month's record by month (investments look back), ctx.glBy
// the GL by month.
export const JE_BATCHES = [
  { batch: 1, id: 'stripe', label: 'Stripe', description: STRIPE_JE.description, needs: 'Attach the Stripe CSV.',
    build: (rec) => (rec.stripe ? stripeJe(rec.stripe) : null) },
  { batch: 2, id: 'paypal', label: 'PayPal', description: PAYPAL_JE.description, needs: 'Attach the PayPal statement.',
    build: (rec) => (rec.bankStatements?.paypal ? paypalJe(rec.bankStatements.paypal) : null) },
  { batch: 3, id: 'tschetter', label: 'Tschetter', description: 'Unrealized Gains - Tschetter Group', needs: 'Attach the statement, or type the ending value.',
    build: (rec, ctx) => investmentJe('tschetter', rec.month, ctx) },
  { batch: 4, id: 'delap', label: 'Delap', description: 'Unrealized Gains - Delap', needs: 'Type the ending value.',
    build: (rec, ctx) => investmentJe('delap', rec.month, ctx) },
];

// Every JE the month has a file for: { batch, id, label, description, date, lines, problems, notes,
// balanced }. A process with no file yet is listed with `missing`.
export function monthJes(rec, { recs = {}, glBy = {} } = {}) {
  const ctx = { recs: { ...recs, [rec.month]: rec }, glBy };
  return JE_BATCHES.map((b) => {
    const built = b.build(rec || {}, ctx);
    const base = { batch: b.batch, id: b.id, label: b.label, description: b.description, date: lastDayOfMonth(rec.month) };
    if (!built) return { ...base, missing: b.needs, lines: [], problems: [], notes: [] };
    return { ...base, notes: [], ...built, balanced: isBalanced(built.lines),
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
