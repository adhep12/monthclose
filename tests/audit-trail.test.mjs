import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depositChecks } from '../app/js/poc/gl-deposits.js';
import { computePoc } from '../app/js/poc/calc.js';
import { glBatchIndex, auditRows, auditSummary, auditGlLines, bookedText } from '../app/js/poc/audit-trail.js';
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

test('each adjustment line says where it is on the statement and in the GL', () => {
  const { rows } = build();
  const wise = rows.find((r) => r.bankDate === '2026-02-20' && r.amount === -199998.87);
  assert.ok(wise, 'the Wise transfer is a line');
  assert.match(wise.ref, /^A-2026-02-\d{3}$/);
  assert.equal(wise.group, 'Transfers between our accounts');
  assert.match(wise.bankDoc, /Cass Incoming Wires …5892 statement dated 2026-02-28 \(incoming-feb\.pdf\)/);
  assert.equal(wise.bankWhere, 'Deposits and other credits');
  assert.equal(wise.glBatch, 'GL0100');
  assert.equal(wise.glBooked, 'Dr 1100 Cass 199,998.87 · Cr 1013 Wise 199,998.87');
  assert.equal(wise.direction, 'Taken out of bank revenue');
  assert.match(wise.verify, /incoming-feb\.pdf.*find 2026-02-20 199,998\.87 “WISE US INC\/BP Wise”.*open batch GL0100/);

  // Who: the payer on the GL line when the statement doesn't name them.
  const tax = rows.find((r) => r.bankDate === '2026-02-11');
  assert.equal(tax.glLine, 'GL GL0102 2');
  assert.equal(tax.who, 'State of Michigan · MIDEPT');
  assert.equal(tax.evidence, 'Statement amount · GL says what');
  assert.match(tax.verify, /check image or deposit slip/);
});

test('GL-only and typed lines say what support to ask for', () => {
  const { rows } = build();
  const cb = rows.find((r) => r.glBatch === 'GL0103');
  assert.equal(cb.evidenceKey, 'gl');
  assert.match(cb.verify, /No bank document/);
  const typed = rows.find((r) => r.a?.id === 'x1');
  assert.equal(typed.evidence, 'Typed');
  assert.match(typed.verify, /Entered by hand by Jordan: “Bank returned it 2\/9”/);
});

test('deposits in transit are lines too, so the Timing row adds up', () => {
  const { rows, c } = build();
  const dit = rows.filter((r) => r.dit);
  assert.ok(dit.some((r) => r.glBatch === 'GL0104' && r.amount === 5000));
  const timing = rows.filter((r) => r.group === 'Timing');
  const sheet = c.adjustments.filter((a) => adjGroup(a) === 'Timing').reduce((t, a) => t + a.amount, 0) + (c.ditChange || 0);
  assert.equal(Math.round(timing.reduce((t, r) => t + r.amount, 0) * 100), Math.round(sheet * 100));
  // Every group's lines add up to what the sheet shows for it.
  const all = rows.reduce((t, r) => t + r.amount, 0);
  assert.equal(Math.round(all * 100), Math.round((c.adjTotal + (c.ditChange || 0)) * 100));
});

test('the summary gives each line kind its refs; GL lines lists the batches named', () => {
  const { rows, g } = build();
  const sm = auditSummary(rows);
  assert.ok(sm.every((x) => x.first <= x.last && x.count >= 1));
  const gls = auditGlLines(rows, glBatchIndex(g));
  assert.ok(gls.some((l) => l.batch === 'GL0102' && l.cv === 'MIDEPT' && l.credit === 108.87));
  assert.ok(gls.some((l) => l.batch === 'GL0102' && l.account === '1100 Cass' && l.debit === 108.87));
});

test('bookedText writes a batch as a journal entry', () => {
  assert.equal(bookedText({ accounts: { 1100: -50, 4010: 50 } }), 'Dr 1100 Cass 50.00 · Cr 4010 50.00');
  assert.equal(bookedText(null), '');
});

test('refs run in sheet order, so each sheet row covers one range', () => {
  const { rows } = build();
  assert.deepEqual(rows.map((r) => r.ref), rows.map((_, i) => `A-2026-02-${String(i + 1).padStart(3, '0')}`));
  const rank = rows.map((r) => ADJ_GROUPS.indexOf(r.group));
  assert.deepEqual(rank, [...rank].sort((a, b) => a - b));
});
