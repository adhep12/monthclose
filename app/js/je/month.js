// A month's journal entries, and the one file that imports them all into Acumatica. The file is
// laid out like the Acumatica tab of the "Month Close Bank Recs" workbook: one row per line,
// BatchNbr keeping each entry's lines together. Each process has its own batch number.

import { stripeJe, STRIPE_JE, STRIPE_TEMPLATE } from './stripe.js';
import { investmentJe, investmentTemplate, fillVars } from './investments.js';
import { paypalJe, PAYPAL_JE, PAYPAL_TEMPLATE } from './paypal.js';
import { cdInterestJE } from '../cd/schedule.js';
import { isBalanced } from '../fa/je.js';
import { round2, sum } from '../money.js';
import { lastDayOfMonth } from '../fiscal.js';

const CD_TEMPLATE = [
  { key: 'cd', account: '1150', sub: '000-000', desc: 'Interest Earned - {cd}', note: 'each CD' },
  { key: 'income', account: '4050', sub: '000-000', desc: 'Interest Earned - {cd}', note: 'each CD' },
];

export const IMPORT_COLUMNS = ['BatchNbr', 'Transaction Date', 'Document Description', 'Account', 'Subaccount',
  'Debit Amount', 'Credit Amount', 'Transaction Description'];

// Batch numbers, in order. More are added as each process's JE is set up.
// `build(rec, ctx)`: ctx.recs is every month's record by month (investments look back), ctx.glBy
// the GL by month.
export const JE_BATCHES = [
  { batch: 1, id: 'stripe', label: 'Stripe', description: STRIPE_JE.description, needs: 'Attach the Stripe CSV.', template: STRIPE_TEMPLATE,
    build: (rec) => (rec.stripe ? stripeJe(rec.stripe) : null) },
  { batch: 2, id: 'paypal', label: 'PayPal', description: PAYPAL_JE.description, needs: 'Attach the PayPal statement.', template: PAYPAL_TEMPLATE,
    build: (rec) => (rec.bankStatements?.paypal ? paypalJe(rec.bankStatements.paypal, rec.paypalSentAs) : null) },
  { batch: 3, id: 'tschetter', label: 'Tschetter', description: 'Unrealized Gains - Tschetter Group', needs: 'Attach the statement, or type the ending value.', template: investmentTemplate('tschetter'),
    build: (rec, ctx) => investmentJe('tschetter', rec.month, ctx) },
  { batch: 4, id: 'delap', label: 'Delap', description: 'Unrealized Gains - Delap', needs: 'Type the ending value.', template: investmentTemplate('delap'),
    build: (rec, ctx) => investmentJe('delap', rec.month, ctx) },
  { batch: 5, id: 'cd', label: 'CD interest', description: 'CD Interest', needs: 'Attach the CDARS statements or the IntraFi export.', template: CD_TEMPLATE,
    build: (rec, ctx) => cdJe(ctx.cds || [], rec.month) },
];

// The CD schedule's interest for the month, one line pair per CD (as the CD schedule's own
// download): Dr 1150 / Cr 4050 "Interest Earned - 1234".
function cdJe(cds, month) {
  const lines = cdInterestJE(cds, month).map((l, i) => {
    const vars = { cd: l.tranDescription.replace(/^Interest Earned - /, '') };
    return { key: i % 2 ? 'income' : 'cd', account: l.account, sub: l.sub, debit: l.debit, credit: l.credit, tranDescription: l.tranDescription, vars };
  });
  return lines.length ? { lines, problems: [] } : null;
}

// Edited defaults (config.jeDefaults, saved from the JE pop-up), per batch id:
//   { description, lines: { <line key>: { account, sub, desc } }, by, at } (only what differs from built in)
// A line's edited description can use the same {placeholders} as its built-in one.
export function applyDefaults(built, over) {
  if (!built || !over?.lines) return built;
  return { ...built, lines: built.lines.map((l) => {
    const o = over.lines[l.key];
    if (!o) return l;
    return { ...l, account: o.account || l.account, sub: o.sub || l.sub, tranDescription: o.desc ? fillVars(o.desc, l.vars) : l.tranDescription, edited: true };
  }) };
}

// Every JE the month has a file for: { batch, id, label, description, date, lines, problems, notes,
// balanced }. A process with no file yet is listed with `missing`.
export function monthJes(rec, { recs = {}, glBy = {}, jeDefaults = {}, cds = [] } = {}) {
  const ctx = { recs: { ...recs, [rec.month]: rec }, glBy, cds };
  return JE_BATCHES.map((b) => {
    const over = jeDefaults[b.id];
    const built = applyDefaults(b.build(rec || {}, ctx), over);
    const base = { batch: b.batch, id: b.id, label: b.label, description: over?.description || b.description, date: lastDayOfMonth(rec.month) };
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
// The same rows as CSV: dates m/d/yyyy, amounts without separators, an empty side blank.
export function importCsv(jes) {
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const us = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${m}/${d}/${y}`; };
  const out = [IMPORT_COLUMNS.map(q).join(',')];
  for (const je of jes) for (const l of je.lines) {
    out.push([je.batch, us(je.date), je.description, l.account, l.sub, l.debit ? l.debit.toFixed(2) : '', l.credit ? l.credit.toFixed(2) : '', l.tranDescription].map(q).join(','));
  }
  return `${out.join('\r\n')}\r\n`;
}
export const IMPORT_COL_WIDTHS = [9, 16, 24, 9, 11, 14, 14, 30];
