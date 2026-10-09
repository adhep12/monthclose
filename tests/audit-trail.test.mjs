import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depositChecks } from '../app/js/poc/gl-deposits.js';
import { computePoc } from '../app/js/poc/calc.js';
import { glBatchIndex, auditRows, auditSummary, assignRefs, bookedText } from '../app/js/poc/audit-trail.js';
import { adjGroup, adjDetail, ADJ_GROUPS } from '../app/js/views/poc-year.js';

// A February shaped like FY2026's (anonymized): a Wise transfer into Incoming, a sales tax refund
// check, a chargeback, and a deposit in transit at month end.
const cr = (id, date, amount, desc, detail) => ({ id, section: 'credit', date, amount, desc, ...(detail ? { detail } : {}) });
const sweep = (id, date, amount, from) => ({ id, section: 'credit', date, amount, desc: `Trnsfr from Checking Acct Ending in ${from}` });
const line = (id, a, amt, cv = '', d = '') => ({ id, a, amt, cv, d, ref: '' });
const gl = (batch, date, amount, accounts, desc, lines) => ({ batch, date, desc, amount, accounts, lines });

function feb() {
  const incoming = { label: 'Cass Incoming Wires', last4: '5892', statementDate: '2026-02-28', fileName: 'incoming-feb.pdf', transactions: [
    cr('5892-1', '2026-02-20', 199998.87, 'WISE US INC/BP Wise'), cr('5892-2', '2026-02-20', 425, 'NCF/ACH'),
  ] };
  const operating = { label: 'Cass Operating', last4: '5884', statementDate: '2026-02-28', fileName: 'operating-feb.pdf', transactions: [
    sweep('5884-1', '2026-02-20', 200423.87, '5892'),
    cr('5884-2', '2026-02-11', 108.87, 'DEPOSIT CONNECTION DEPOSIT'),
  ] };
  operating.summary = { credits: { total: 200532.74 }, ending: 0 };
  return { month: '2026-02', statements: { operating, incoming }, adjustments: [
    { id: 'x1', account: 'cassOp', type: 'not-revenue', label: 'Returned ACH', amount: -400, note: 'Bank returned it 2/9', enteredBy: 'Jordan', enteredAt: '2026-03-02T10:00:00Z' },
  ] };
}
const glBy = () => ({
  '2026-02': { receipts: [
    gl('GL0100', '2026-02-20', 199998.87, { 1013: 199998.87 }, 'Wise Transfer', [line('GL GL0100 1', '1100', 199998.87), line('GL GL0100 2', '1013', -199998.87, '', 'Transfer from Wise')]),
    gl('GL0101', '2026-02-20', 425, { 4018: 425 }, 'DAF Gifts - NCF', [line('GL GL0101 1', '1100', 425), line('GL GL0101 2', '4018', -425, 'NCF001', 'National Christian Foundation')]),
    gl('GL0102', '2026-02-11', 108.87, { 2042: 108.87 }, 'Deposit - MI Sales Tax Refund', [line('GL GL0102 1', '1100', 108.87), line('GL GL0102 2', '2042', -108.87, 'MIDEPT', 'State of Michigan')]),
    gl('GL0103', '2026-02-18', -25, { 4010: -25 }, 'Deposit Error - Chargeback'),
    gl('GL0104', '2026-02-28', 5000, { 4010: 5000 }, '3.3.2026 February Deposit'),
  ] },
});

function build() {
  const rec = feb();
  const g = glBy();
  const dep = depositChecks({ recs: { '2026-02': rec }, glBy: g });
  const c = computePoc(rec, { deposits: dep['2026-02'] });
  return { rec, c, rows: auditRows({ m: '2026-02', rec, c, glIndex: glBatchIndex(g), groupOf: adjGroup, lineOf: adjDetail, order: ADJ_GROUPS }), g };
}

test('each adjustment line says who, where it is on the statement and in the GL', () => {
  const { rows } = build();
  const wise = rows.find((r) => r.date === '2026-02-20' && r.amount === -199998.87);
  assert.ok(wise, 'the Wise transfer is a line');
  assert.equal(wise.group, 'Transfers between our accounts');
  assert.equal(wise.bank, 'Cass Incoming Wires …5892, statement 2026-02-28 (incoming-feb.pdf) · Credits · 2/20 199,998.87 “WISE US INC/BP Wise”');
  assert.equal(wise.glBatch, 'GL0100');
  assert.equal(wise.gl, '2/20 Wise Transfer · Dr 1100 Cass - General Operating 199,998.87 / Cr 1013 Wise 199,998.87 · line GL GL0100 2');
  assert.equal(wise.who, 'Transfer from Wise');

  // Who: the payer on the GL line when the statement doesn't name them.
  const tax = rows.find((r) => r.date === '2026-02-11');
  assert.equal(tax.who, 'State of Michigan · MIDEPT');
  assert.equal(tax.evidence, 'Statement amount · GL says what');
  assert.match(tax.what, /DEPOSIT CONNECTION DEPOSIT/);
});

test('GL-only and typed lines say so', () => {
  const { rows } = build();
  const cb = rows.find((r) => r.glBatch === 'GL0103');
  assert.equal(cb.evidenceKey, 'gl');
  const typed = rows.find((r) => r.a?.id === 'x1');
  assert.equal(typed.evidence, 'Typed');
  assert.equal(typed.who, 'Typed by Jordan');
  assert.equal(typed.why, '“Bank returned it 2/9” — typed by Jordan, 2026-03-02');
});

test('deposits in transit are lines too, so the Timing row adds up', () => {
  const { rows, c } = build();
  const dit = rows.filter((r) => r.dit);
  assert.ok(dit.some((r) => r.glBatch === 'GL0104' && r.amount === 5000 && r.who === 'Deposit'));
  const timing = rows.filter((r) => r.group === 'Timing');
  const sheet = c.adjustments.filter((a) => adjGroup(a) === 'Timing').reduce((t, a) => t + a.amount, 0) + (c.ditChange || 0);
  assert.equal(Math.round(timing.reduce((t, r) => t + r.amount, 0) * 100), Math.round(sheet * 100));
  const all = rows.reduce((t, r) => t + r.amount, 0);
  assert.equal(Math.round(all * 100), Math.round((c.adjTotal + (c.ditChange || 0)) * 100));
  const sm = auditSummary(rows);
  assert.equal(sm.reduce((t, x) => t + x.count, 0), rows.length);
});

test('refs are permanent: kept on re-export, new lines get the next number, gone lines are retired', () => {
  const stored = {};
  let { rows } = build();
  assert.equal(assignRefs('2026-02', rows, stored).changed, true);
  const first = Object.fromEntries(rows.map((r) => [r.key, r.ref]));
  assert.deepEqual(new Set(Object.values(first)).size, rows.length);
  // Exported again: same numbers, nothing to save.
  ({ rows } = build());
  assert.equal(assignRefs('2026-02', rows, stored).changed, false);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.key, r.ref])), first);
  // A line added: the next number. A line gone: retired, and its number isn't used again.
  const { rec, g } = build();
  rec.adjustments.push({ id: 'x2', account: 'cassOp', type: 'other', label: 'Bank fee refund', amount: 12, enteredBy: 'Jordan' });
  rec.adjustments = rec.adjustments.filter((a) => a.id !== 'x1');
  const dep = depositChecks({ recs: { '2026-02': rec }, glBy: g });
  const c = computePoc(rec, { deposits: dep['2026-02'] });
  rows = auditRows({ m: '2026-02', rec, c, glIndex: glBatchIndex(g), groupOf: adjGroup, lineOf: adjDetail, order: ADJ_GROUPS });
  const res = assignRefs('2026-02', rows, stored);
  const n = Object.keys(first).length;
  assert.equal(rows.find((r) => r.a?.id === 'x2').ref, `A-2026-02-${String(n + 1).padStart(3, '0')}`);
  assert.deepEqual(res.retired.map((s) => s.ref), [first['typed|x1']]);
  for (const r of rows.filter((r) => first[r.key])) assert.equal(r.ref, first[r.key]);
});

test('bookedText writes a batch as a journal entry', () => {
  assert.equal(bookedText({ accounts: { 1100: -50, 4010: 50 } }), 'Dr 1100 Cass - General Operating 50.00 / Cr 4010 Checks 50.00');
  assert.equal(bookedText(null), '');
});
