import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depositChecks, bankWindow, glKind, pairDuplicates } from '../app/js/poc/gl-deposits.js';
import { computePoc, missingStatements } from '../app/js/poc/calc.js';

// Statement lines and GL batches shaped like FY2026's (amounts and names anonymized).
const cr = (id, date, amount, desc) => ({ id, section: 'credit', date, amount, desc });
const sweep = (id, date, amount, from) => ({ id, section: 'credit', date, amount, desc: `Trnsfr from Checking Acct Ending in ${from}` });
const gl = (batch, date, amount, accounts, desc = 'DAF Gifts - NCF, Fidelity') => ({ batch, date, desc, amount, accounts });

function feb() {
  const incoming = { transactions: [
    cr('5892-1', '2026-02-13', 181170.64, 'ORIG:A FOUNDATION'), cr('5892-2', '2026-02-13', 2550, 'NCF/ACH'),
    cr('5892-3', '2026-02-20', 199998.87, 'WISE US INC/BP Wise'), cr('5892-4', '2026-02-20', 12000, 'FIDELITY INVESTM/GrantPaymt'), cr('5892-5', '2026-02-20', 425, 'NCF/ACH'),
  ] };
  const operating = { transactions: [
    sweep('5884-1', '2026-02-13', 183720.64, '5892'), sweep('5884-2', '2026-02-20', 212423.87, '5892'),
    cr('5884-3', '2026-02-12', 4005, 'DEPOSIT CONNECTION DEPOSIT'), cr('5884-4', '2026-02-12', 425, 'Business Mobile Deposit'),
    cr('5884-5', '2026-02-11', 108.87, 'DEPOSIT CONNECTION DEPOSIT'), cr('5884-6', '2026-02-27', 10479.69, 'DIVVY/REWARDS'),
  ] };
  operating.summary = { credits: { total: 0 }, ending: 0 };
  return { month: '2026-02', statements: { operating, incoming }, adjustments: [] };
}
const glBy = () => ({
  '2026-02': { receipts: [
    gl('G1', '2026-02-13', 183720.64, { 4018: 183720.64 }),
    gl('G2', '2026-02-20', 199998.87, { 1013: 199998.87 }, 'Wise Transfer'),
    gl('G3', '2026-02-20', 12425, { 4018: 12425 }),
    gl('G4', '2026-02-12', 4430, { 4010: 4430 }, '2.12.2026 February Deposit + Mobile Deposits'),
    gl('G5', '2026-02-11', 108.87, { 2042: 108.87 }, 'Deposit - MI Sales Tax Refund'),
    gl('G6', '2026-02-28', 25814.02, { 4010: 25814.02 }, '3.3.2026 February Deposit'),
    gl('G7', '2026-02-05', 2345, { 4018: 2345 }, 'DAF Gifts - NCF'), gl('G8', '2026-02-06', -2345, { 4018: -2345 }, 'DAF Gifts - NCF'),
    gl('G9', '2026-02-18', -25, { 4010: -25 }, '2.3.2026 February Deposit Error - Chargeback'),
  ] },
  '2026-03': { receipts: [gl('H1', '2026-03-02', 700, { 4010: 700 }, '3.2.2026 March Deposit')] },
});

test('each day of Incoming wires matches the GL batches that add up to it', () => {
  const d = depositChecks({ recs: { '2026-02': feb() }, glBy: glBy() })['2026-02'];
  const batch = (id) => d.lines.find((x) => x.line.id === id).match?.batch;
  assert.equal(batch('5892-1'), 'G1'); assert.equal(batch('5892-2'), 'G1');
  assert.equal(batch('5892-3'), 'G2'); // the Wise transfer is its own batch…
  assert.equal(batch('5892-4'), 'G3'); assert.equal(batch('5892-5'), 'G3'); // …the rest of the day is another
  assert.equal(batch('5884-3'), 'G4'); assert.equal(batch('5884-4'), 'G4'); // check deposit + mobile deposit
});

test('deposits the GL booked to non-revenue accounts come out, with the batch as the reason', () => {
  const rec = feb();
  const d = depositChecks({ recs: { '2026-02': rec }, glBy: glBy() })['2026-02'];
  assert.equal(d.exclusions['5892-3'].type, 'transfer');
  assert.match(d.exclusions['5892-3'].note, /G2: Wise Transfer/);
  assert.equal(d.exclusions['5884-5'].type, 'not-revenue');
  assert.equal(Object.keys(d.exclusions).length, 2);
  // The Divvy rewards aren't in the GL this month or either side: flagged, not taken out.
  assert.deepEqual(d.noGl.map((x) => x.line.id), ['5884-6']);
  // A duplicate batch and its reversal cancel; a chargeback takes revenue back.
  assert.deepEqual(d.adjustments.map((a) => [a.id, a.amount]), [['auto-glrev-G9', -25]]);
  const c = computePoc(rec, { deposits: d });
  assert.ok(c.adjustments.some((a) => a.id === 'auto-tr-5892-3' && a.amount === -199998.87));
  assert.ok(c.adjustments.some((a) => a.id === 'auto-glrev-G9'));
  // Someone says the tax refund is revenue after all: it stays in.
  rec.dismissed = { '5884-5': true };
  assert.equal(depositChecks({ recs: { '2026-02': rec }, glBy: glBy() })['2026-02'].exclusions['5884-5'], undefined);
});

test('an adjustment entered by hand covers the GL finding of the same amount, so nothing comes out twice', () => {
  const rec = feb();
  rec.adjustments = [{ id: 'a', label: 'Wise transfers', amount: -199998.87 }, { id: 'b', label: 'CC rewards for prior month', amount: -10479.69 }];
  const d = depositChecks({ recs: { '2026-02': rec }, glBy: glBy() })['2026-02'];
  assert.equal(d.exclusions['5892-3'], undefined);
  assert.equal(d.covered.length, 1);
  assert.equal(d.noGl[0].covered.label, 'CC rewards for prior month');
});

test('deposits in transit come from the GL, and the next statement confirms them', () => {
  const recs = { '2026-02': feb() };
  let d = depositChecks({ recs, glBy: glBy() })['2026-02'].dit;
  const row = d.rows.find((r) => r.batch === 'G6');
  assert.equal(row.counts, true); // the GL says deposited 3/3
  assert.equal(row.flagged, true); // March's statement isn't in yet
  assert.equal(d.total, 25814.02);
  // March's statement arrives with the deposit on it.
  recs['2026-03'] = { month: '2026-03', statements: { operating: { transactions: [cr('5884-9', '2026-03-03', 25814.02, 'DEPOSIT CONNECTION DEPOSIT'), cr('5884-8', '2026-03-02', 700, 'DEPOSIT CONNECTION DEPOSIT')] } } };
  d = depositChecks({ recs, glBy: glBy() })['2026-02'].dit;
  assert.equal(d.rows.find((r) => r.batch === 'G6').settled, true);
  assert.equal(d.flagged, 0);
  assert.equal(d.total, 25814.02);
  // March's own 3/2 deposit is March's, and doesn't touch February.
  assert.ok(!d.rows.some((r) => r.batch === 'H1' && r.counts));
});

test('without next month’s statement, a person decides; typed deposits in transit the GL also has count once', () => {
  const rec = feb();
  rec.ditGl = { G6: { in: false, by: 'A', at: 'x' } };
  rec.dit = [{ id: 'imp-1', amount: 9999 }, { id: 'm1', amount: 25814.02 }, { id: 'm2', amount: 100 }];
  let d = depositChecks({ recs: { '2026-02': rec }, glBy: glBy() })['2026-02'].dit;
  assert.equal(d.rows.find((r) => r.batch === 'G6').counts, false);
  assert.equal(d.total, 25914.02); // typed 25,814.02 + 100; the workbook's 9,999 isn't used alongside the GL
  assert.equal(d.workbookTotal, 9999);
  rec.ditGl = {};
  d = depositChecks({ recs: { '2026-02': rec }, glBy: glBy() })['2026-02'].dit;
  assert.equal(d.total, 25914.02); // GL 25,814.02 + typed 100; the typed duplicate isn't added again
  assert.ok(d.manual.find((x) => x.d.id === 'm1').duplicate);
  // Change in deposits in transit uses both months' GL lists.
  const c = computePoc(rec, { deposits: { dit: d }, priorDeposits: { dit: { total: 45318.21 } } });
  assert.equal(c.ditChange, -19404.19);
});

test('a missing wire statement is flagged when Operating shows its sweeps', () => {
  const rec = feb();
  assert.deepEqual(missingStatements(rec).map((w) => w.kind), []);
  delete rec.statements.incoming;
  assert.deepEqual(missingStatements(rec).map((w) => w.kind), ['incoming']);
  assert.deepEqual(missingStatements({ statements: { incoming: {} } }).map((w) => w.kind), ['operating']);
});

test('GL helpers: bank dates in batch names, what a batch was booked to, duplicates', () => {
  assert.deepEqual(bankWindow({ desc: '8.18.2026-8.19.2026 August Mobile Deposits', date: '2026-08-18' }), { from: '2026-08-18', to: '2026-08-19', named: true });
  assert.equal(bankWindow({ desc: 'DAF Gifts', date: '2026-02-13' }).from, '2026-02-13');
  assert.equal(glKind({ accounts: { 1220: 750000 } }).kind, 'prior-period');
  assert.equal(glKind({ accounts: { 1170: 5 } }).kind, 'transfer');
  assert.equal(glKind({ accounts: { 7220: 5 } }).kind, 'not-revenue');
  assert.equal(glKind({ accounts: { 4018: 5 } }).kind, 'revenue');
  // A reclass out of revenue (same description, different accounts) isn't a duplicate.
  assert.equal(pairDuplicates([gl('A', 'd', 100000, { 4017: 100000 }, 'X'), gl('B', 'd', -100000, { 4017: -100000, 1020: 100000, 2041: -100000 }, 'X')]).size, 0);
});
