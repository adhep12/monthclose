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

test('Stripe sales the GL moves out of revenue (shipping, sales tax) come off the Stripe line', () => {
  const g = glBy();
  // October 2025's shape: merchandise to the merch lines (still revenue), shipping to 9050.
  g['2026-02'].stripeReclass = [
    { batch: 'S1', date: '2026-02-28', desc: 'Inventory - Reclass Stripe Purchases from Sales', accounts: { 4015: -24426.57, 4081: 5810, 4084: 15680, 4085: 1330, 4083: 1000, 9050: 606.57 } },
    { batch: 'S2', date: '2026-02-28', desc: 'reclass of stripe clearing account to giving', accounts: { 4015: 97.5, 1200: -97.5 } },
    { batch: 'S3', date: '2026-02-28', desc: 'Inventory Reversal - Reclass Stripe Purchases', accounts: { 4015: 7420, 4084: -7420 } },
  ];
  const d = depositChecks({ recs: { '2026-02': feb() }, glBy: g })['2026-02'];
  const adj = d.adjustments.filter((a) => a.id.startsWith('auto-glstripe-'));
  assert.deepEqual(adj.map((a) => [a.id, a.account, a.amount]), [['auto-glstripe-S1', 'stripe', -606.57], ['auto-glstripe-S2', 'stripe', 97.5]]);
  assert.match(adj[0].note, /to 9050 .* 606\.57/);
});

test('a rule and the GL disagree: flagged to decide, counted as revenue until then', () => {
  // A 5,000 gift lands in Cass two days after Wise paid a vendor 5,000: the matching rule calls it
  // a transfer, but the GL booked it as a gift.
  const rec = feb();
  rec.statements.operating.transactions.push(cr('5884-7', '2026-02-10', 5000, 'DEPOSIT CONNECTION DEPOSIT'));
  rec.bankStatements = { wise: { items: [{ id: 'w1', desc: 'Sent money to A Vendor Ltd', amount: -5000, balance: 100, date: '2026-02-08' }] } };
  const g = glBy();
  g['2026-02'].receipts.push(gl('G10', '2026-02-10', 5000, { 4010: 5000 }, '2.10.2026 February Deposit'));
  const check = () => depositChecks({ recs: { '2026-02': rec }, glBy: g })['2026-02'];
  let d = check();
  assert.equal(d.conflicts.length, 1);
  assert.equal(d.conflicts[0].rule.type, 'transfer');
  assert.equal(d.conflicts[0].match.batch, 'G10');
  assert.ok(!computePoc(rec, { deposits: d }).adjustments.some((a) => a.id === 'auto-tr-5884-7')); // revenue for now
  // "It's a transfer": set by hand, so it comes out and the flag clears.
  rec.excluded = { '5884-7': { type: 'transfer', note: 'Confirmed' } };
  d = check();
  assert.equal(d.conflicts.length, 0);
  assert.ok(computePoc(rec, { deposits: d }).adjustments.some((a) => a.id === 'auto-tr-5884-7' && a.amount === -5000));
  // "It's revenue": the rule is overruled, and stays that way.
  rec.excluded = {}; rec.dismissed = { '5884-7': true };
  d = check();
  assert.equal(d.conflicts.length, 0);
  assert.ok(!computePoc(rec, { deposits: d }).adjustments.some((a) => a.id === 'auto-tr-5884-7'));
  // An automatic finding stored on an older record doesn't count as someone deciding.
  rec.dismissed = {}; rec.excluded = { '5884-7': { type: 'transfer', note: 'x', auto: true } };
  assert.equal(check().conflicts.length, 1);
});

test('KeyBank: deposits are giving unless the GL says they came from another of our accounts', () => {
  const g = glBy();
  g['2026-02'].keyReceipts = [
    gl('K1', '2026-02-12', 155, { 4010: 100, 4075: 55 }, 'Keybank Cash Giving + Cheers Club'),
    gl('K2', '2026-02-20', 2000, { 1100: 2000 }, 'Transfer Cass Operating to KeyBank'),
  ];
  const d = depositChecks({ recs: { '2026-02': feb() }, glBy: g })['2026-02'];
  assert.equal(d.keyBank.glIn, 2155);
  assert.deepEqual(d.adjustments.filter((a) => a.account === 'keyOp').map((a) => [a.id, a.type, a.amount]), [['auto-glkey-K2', 'transfer', -2000]]);
});

test('what the statements can’t show comes from the GL, each as its own labelled adjustment', () => {
  const g = glBy();
  g['2026-02'].paypalRefunds = [{ batch: 'P1', date: '2026-02-28', desc: 'Paypal - Giving, Fees', amount: 15337 }];
  g['2026-02'].wiseReceipts = [gl('W1', '2026-02-14', 699993.89, { 4018: 700000, 8590: -6.11 }, 'Wise Donation - A Foundation'), gl('W2', '2026-02-01', 1053.6, { 4050: 1053.6 }, 'Interest Earned')];
  g['2026-02'].keyReceipts = [gl('K1', '2026-02-12', 155, { 4010: 480, 4075: 75, 8036: -400 }, 'Keybank Cash Giving + Cheers Club')];
  g['2026-02'].noCashRevenue = [
    { batch: 'A1', date: '2026-02-10', desc: 'PKO1 - Air Order', accounts: { 1210: -52, 4084: 52 } },
    { batch: 'R1', date: '2026-02-20', desc: 'Reverse gift sent to a different NFP', accounts: { 2052: 3018.7, 4018: -3018.7 } },
    { batch: 'I1', date: '2026-02-28', desc: 'Interest Earned - 0001', accounts: { 1150: -100, 4050: 100 } }, // interest isn't revenue
  ];
  const d = depositChecks({ recs: { '2026-02': feb() }, glBy: g })['2026-02'];
  const by = Object.fromEntries(d.adjustments.map((a) => [a.id, a]));
  assert.equal(by['auto-glpaypal-P1'].amount, -15337);
  assert.equal(by['auto-glpaypal-P1'].account, 'paypal');
  assert.equal(by['auto-glwise-fees'].amount, 6.11); // the interest batch isn't a fee
  assert.equal(by['auto-glkey-K1'].amount, 400); // cash gifts spent before the deposit
  assert.match(by['auto-glkey-K1'].label, /spent before they were deposited/);
  assert.equal(by['auto-glnocash-A1'].amount, 52);
  assert.equal(by['auto-glnocash-A1'].type, 'timing');
  assert.equal(by['auto-glnocash-R1'].amount, -3018.7);
  assert.equal(by['auto-glnocash-I1'], undefined);
  for (const a of Object.values(by)) assert.ok(a.note && a.why, `${a.id} explains itself`);
});

test('matching across month end: a check booked on the last day and deposited a week later; two batches in one deposit', () => {
  const recs = { '2026-02': feb() };
  recs['2026-03'] = { month: '2026-03', statements: { operating: { summary: { credits: { total: 0 }, ending: 0 }, transactions: [
    cr('5884-a', '2026-03-07', 8565, 'DEPOSIT CONNECTION DEPOSIT'), cr('5884-b', '2026-03-30', 595, 'ORIG:A BOOKSHOP') ] } } };
  const g = glBy();
  g['2026-02'].receipts.push(gl('C1', '2026-02-28', 8565, { 8015: 8565 }, 'Deposit - Cigna Reimbursement Check'));
  g['2026-03'].receipts.push(gl('AR1', '2026-03-30', 520, { 1210: 520 }, 'PKO1 - Air Order'), gl('AR2', '2026-03-30', 75, { 1210: 75 }, 'PKO2 - Air Order'));
  const d = depositChecks({ recs, glBy: g })['2026-03'];
  assert.equal(d.exclusions['5884-a'].type, 'not-revenue');
  assert.match(d.exclusions['5884-a'].note, /C1/);
  assert.equal(d.exclusions['5884-b'].type, 'prior-period');
  assert.match(d.exclusions['5884-b'].note, /AR1 \+ AR2/);
});

test('first month of the GL: last month’s deposits in transit unknown, so this month’s count in full', () => {
  // October 2025: September isn't in this GL. Its deposits clearing in October are marked by hand.
  const rec = { month: '2025-10', statements: { operating: { summary: { credits: { total: 133829.22 }, ending: 0 }, transactions: [
    cr('5884-1', '2025-10-02', 12090, 'DEPOSIT CONNECTION DEPOSIT'), cr('5884-2', '2025-10-07', 96730.72, 'DEPOSIT CONNECTION DEPOSIT'), cr('5884-3', '2025-10-08', 25008.5, 'DEPOSIT CONNECTION DEPOSIT')] } },
    excluded: { '5884-1': { type: 'prior-period', note: 'September Deposit' }, '5884-2': { type: 'prior-period', note: 'September Deposit' }, '5884-3': { type: 'prior-period', note: 'September Deposit' } } };
  const c = computePoc(rec, { deposits: { dit: { total: 152862.12, rows: [] } }, priorDeposits: null });
  assert.equal(c.ditChange, 152862.12);
  assert.ok(c.priorDitMissing);
  assert.match(c.warnings.find((w) => w.kind === 'prior-dit').text, /3 are, 133,829\.22/);
  assert.equal(c.revAdjusted, 152862.12); // 133,829.22 deposited − 133,829.22 marked + 152,862.12 in transit
  // September's list entered later as well: the marked deposits would come out twice.
  const again = computePoc(rec, { deposits: { dit: { total: 152862.12, rows: [] } }, prior: { dit: [{ amount: 12090 }, { amount: 96730.72 }, { amount: 25008.5 }] } });
  assert.equal(again.ditChange, 19032.9);
  assert.equal(again.warnings.find((w) => w.kind === 'dit-twice').text.split(';').length, 3);
});

test('evidence: what the statements show, what the GL shows, and where both agree', () => {
  const rec = feb();
  rec.statements.operating.transactions.push({ id: '5884-cb', section: 'debit', date: '2026-02-19', amount: 25, desc: 'CHARGE BACK' });
  rec.bankStatements = {
    paypal: { source: 'paypal', received: 16358.48, revenue: 16358.48, paymentsSent: -15337, sent: [{ date: '2026-02-13', desc: 'General Payment A Donor', amount: 15337 }] },
    wise: { items: [{ id: 'w1', desc: 'Sent money to BibleProject', amount: -200000, balance: 1, date: '2026-02-19' }] },
  };
  const g = glBy();
  g['2026-02'].paypalRefunds = [{ batch: 'P1', date: '2026-02-28', desc: 'Paypal - Giving, Fees', amount: 15337 }];
  g['2026-02'].noCashRevenue = [{ batch: 'A1', date: '2026-02-10', desc: 'PKO1 - Air Order', accounts: { 1210: -52, 4084: 52 } }];
  const c = computePoc(rec, { deposits: depositChecks({ recs: { '2026-02': rec }, glBy: g })['2026-02'] });
  const ev = (id) => c.adjustments.find((a) => a.id === id)?.evidence;
  assert.equal(ev('auto-stripe'), undefined); // no Stripe line in this month
  assert.equal(ev('auto-tr-5892-3'), 'both'); // Wise shows it leaving, Cass arriving, the GL books a transfer
  assert.match(c.adjustments.find((a) => a.id === 'auto-tr-5892-3').note, /the GL agrees/);
  assert.equal(ev('auto-ex-5884-5'), 'glWhat'); // the statement has the deposit; only the GL says it's a tax refund
  assert.equal(ev('auto-glpaypal-P1'), 'both');
  assert.match(c.adjustments.find((a) => a.id === 'auto-glpaypal-P1').statement, /2026-02-13 General Payment A Donor/);
  assert.equal(ev('auto-glrev-G9'), 'both'); // the chargeback's returned item is on the statement
  assert.equal(ev('auto-glnocash-A1'), 'gl'); // sold on account: no bank document
  assert.equal(ev('auto-incoming'), 'statement');
});

test('a Stripe transfer that’s a gift through someone else’s Stripe stays in revenue', () => {
  // October 2025: 9.43 "STRIPE/TRANSFER" on Cass, not one of our payouts; the GL books it as a DAF gift.
  const rec = feb();
  rec.statements.operating.transactions.push(cr('5884-s1', '2026-02-02', 308676.23, 'STRIPE/TRANSFER'), cr('5884-s2', '2026-02-27', 9.43, 'STRIPE/TRANSFER'));
  rec.stripe = { payouts: 308676.23, revenue: 0, payments: 0, refunds: 0 };
  const g = glBy();
  g['2026-02'].receipts.push(gl('ST1', '2026-02-02', 308676.23, { 1200: 308676.23 }, 'Transfer Stripe Checking to Cass Operating'), gl('EV1', '2026-02-27', 9.43, { 4018: 9.43 }, 'DAF Gifts - Every.org via Stripe Transfer'));
  const d = depositChecks({ recs: { '2026-02': rec }, glBy: g })['2026-02'];
  assert.deepEqual(d.stripeGifts.map((x) => x.id), ['5884-s2']);
  const c = computePoc(rec, { deposits: d });
  assert.equal(c.adjustments.find((a) => a.id === 'auto-stripe').amount, -308676.23); // the gift isn't taken out
  assert.equal(c.stripeCheck.state, 'match');
  assert.ok(c.stripeCheck.ignored[0].ignored.gift);
});

test('a deposit the GL doesn’t have, once someone decides, is shown as decided', () => {
  // November 2025: a 324.08 Divvy reimbursement with no GL batch, marked not revenue.
  const rec = feb();
  rec.excluded = { '5884-6': { type: 'not-revenue', note: 'Divvy reimbursement', by: 'A', at: 'x' } };
  const d = depositChecks({ recs: { '2026-02': rec }, glBy: glBy() })['2026-02'];
  const x = d.noGl.find((n) => n.line.id === '5884-6');
  assert.equal(x.decided.type, 'not-revenue');
  assert.equal(x.decided.by, 'A');
  const c = computePoc(rec, { deposits: d });
  assert.ok(c.adjustments.some((a) => a.id === 'auto-ex-5884-6' && a.amount === -10479.69)); // and it's taken out
  rec.excluded = {}; rec.dismissed = { '5884-6': { by: 'B', at: 'y' } };
  assert.deepEqual(depositChecks({ recs: { '2026-02': rec }, glBy: glBy() })['2026-02'].noGl.find((n) => n.line.id === '5884-6').decided, { type: 'revenue', by: 'B', at: 'y' });
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

test('PayPal grants booked together match the deposits they came in as, closest first', () => {
  // October: 500 + 15 were one 515 batch on 10/7, and another 500 was its own batch on 10/15.
  // The 10/8 500 mustn't take the 10/15 batch, leaving the 15 and the 10/15 500 with nothing.
  const pp = (id, date, amount) => cr(id, date, amount, `PAYPAL INC./PAYMENT 0000${id}`);
  const rec = { month: '2025-10', statements: { operating: { transactions: [pp('1', '2025-10-08', 500), pp('2', '2025-10-08', 15), pp('3', '2025-10-15', 500), pp('4', '2025-10-20', 25), pp('5', '2025-10-24', 100)] } } };
  const g = { '2025-10': { receipts: [
    gl('P515', '2025-10-07', 515, { 4018: 515 }, 'DAF Gifts - PayPal Grants (2)'),
    gl('P500', '2025-10-15', 500, { 4018: 500 }, 'DAF Gifts - PayPal Grant'),
    // Grants in one batch can reach the bank days apart.
    gl('P125', '2025-10-19', 125, { 4018: 125 }, 'DAF Gifts - PayPal Grants (2)'),
  ] } };
  const d = depositChecks({ recs: { '2025-10': rec }, glBy: g })['2025-10'];
  const batch = (id) => d.lines.find((x) => x.line.id === id).match?.batch;
  assert.deepEqual(['1', '2', '3', '4', '5'].map(batch), ['P515', 'P515', 'P500', 'P125', 'P125']);
  assert.deepEqual(d.noGl, []);
});

test('a PayPal deposit only matches a PayPal batch, never a same-amount AP entry', () => {
  // January: GL017465 (1/7) is two 100 grants booked as one 200; GL017495 (1/9) is one 100 grant;
  // AP012998 (1/12) is a 100 vendor check booked to accounts payable.
  const pp = (id, date, amount) => cr(id, date, amount, `PAYPAL INC./PAYMENT 0000${id}`);
  const rec = { month: '2026-01', statements: { operating: { transactions: [pp('1', '2026-01-07', 100), pp('2', '2026-01-08', 100), pp('3', '2026-01-09', 100)] } } };
  const g = { '2026-01': { receipts: [
    gl('GL017465', '2026-01-07', 200, { 4018: 200 }, 'DAF Gifts - PayPal Grants (2)'),
    gl('GL017495', '2026-01-09', 100, { 4018: 100 }, 'DAF Gifts - PayPal Grant'),
    { ...gl('AP012998', '2026-01-12', 100, { 2010: 100 }, 'VO Podcast Sample One-Off'), ap: true },
  ] } };
  const d = depositChecks({ recs: { '2026-01': rec }, glBy: g })['2026-01'];
  const batch = (id) => d.lines.find((x) => x.line.id === id).match?.batch;
  assert.deepEqual(['1', '2', '3'].map(batch), ['GL017465', 'GL017465', 'GL017495']);
  assert.deepEqual(d.exclusions, {});
});

test('Stripe money that isn’t a payout, moved to giving the next month, is timing in both months', () => {
  // January: 97.50 in through Stripe, booked to Stripe clearing (GL017570); February: the GL moves
  // it to giving (GL017834, Dr 1200 Cr 4015).
  const st = (id, date, amount) => cr(id, date, amount, 'STRIPE/TRANSFER');
  const jan = { month: '2026-01', statements: { operating: { transactions: [st('1', '2026-01-05', 1000), st('2', '2026-01-06', 97.5)], summary: { credits: { total: 1097.5 }, ending: 0 } } }, stripe: { payouts: 1000 } };
  const g = {
    '2026-01': { receipts: [
      gl('S1', '2026-01-05', 1000, { 1200: 1000 }, 'Transfer Stripe Checking to Cass Operating - CC & ACH'),
      gl('GL017570', '2026-01-06', 97.5, { 1200: 97.5 }, 'Transfer Stripe Checking to Cass Operating - CC & ACH'),
    ] },
    '2026-02': { receipts: [], stripeReclass: [{ batch: 'GL017834', date: '2026-02-28', desc: 'reclass of stripe clearing account to giving', accounts: { 1200: -97.5, 4015: 97.5 } }] },
  };
  const d = depositChecks({ recs: { '2026-01': jan }, glBy: g });
  const cj = computePoc(jan, { deposits: d['2026-01'] });
  const by = Object.fromEntries(cj.adjustments.map((a) => [a.id, a]));
  assert.equal(by['auto-stripe'].amount, -1000);
  assert.equal(by['auto-stripelate-2'].amount, -97.5);
  assert.equal(by['auto-stripelate-2'].type, 'timing');
  assert.equal(cj.stripeCheck.state, 'match');
  const feb = d['2026-02'].adjustments.find((a) => a.id === 'auto-glstripe-GL017834');
  assert.equal(feb.amount, 97.5);
  assert.equal(feb.type, 'timing');
  assert.match(feb.note, /Received 2026-01-06/);
});

test('this month’s grant batch takes its own deposits before next month’s same-amount grant', () => {
  // April: 2,000 + 500 on 4/29 are GL018119 (2,500, two grants); May's own 2,000 grant (GL018123,
  // 5/1) is the 5/1 deposit.
  const pp = (id, date, amount) => cr(id, date, amount, `PAYPAL INC./PAYMENT 0000${id}`);
  const recs = {
    '2026-04': { month: '2026-04', statements: { operating: { transactions: [pp('a1', '2026-04-29', 2000), pp('a2', '2026-04-29', 500)] } } },
    '2026-05': { month: '2026-05', statements: { operating: { transactions: [pp('m1', '2026-05-01', 2000)] } } },
  };
  const g = {
    '2026-04': { receipts: [gl('GL018119', '2026-04-29', 2500, { 4018: 2500 }, 'DAF Gifts - PayPal Grants (2)')] },
    '2026-05': { receipts: [gl('GL018123', '2026-05-01', 2000, { 4018: 2000 }, 'DAF Gifts - PayPal Grant')] },
  };
  const d = depositChecks({ recs, glBy: g });
  const batch = (m, id) => d[m].lines.find((x) => x.line.id === id).match?.batch;
  assert.deepEqual([batch('2026-04', 'a1'), batch('2026-04', 'a2'), batch('2026-05', 'm1')], ['GL018119', 'GL018119', 'GL018123']);
});

test('revenue above the cash deposited: platform fees and revenue released from a liability', () => {
  const rec = { month: '2026-06', statements: { operating: { transactions: [cr('1', '2026-06-10', 43314.70, 'ORIG:OVERFLOW')] } } };
  const g = {
    '2026-01': { receipts: [], noCashRevenue: [{ batch: 'GL017932', date: '2026-01-01', desc: 'Reverse Overflow gift', accounts: { 2052: 3018.70, 4018: -3018.70 } }] },
    '2026-06': { receipts: [gl('GL018378', '2026-06-10', 43314.70, { 4018: 46760, 2052: -3018.70, 8070: -426.60 }, 'DAF Gifts - Overflow')] },
  };
  const d = depositChecks({ recs: { '2026-06': rec }, glBy: g })['2026-06'];
  const by = Object.fromEntries(d.adjustments.map((a) => [a.id, a]));
  assert.equal(by['auto-glfee-GL018378-8070'].amount, 426.6);
  assert.equal(by['auto-glrelease-GL018378-2052'].amount, 3018.7);
  assert.equal(by['auto-glrelease-GL018378-2052'].type, 'timing');
  assert.match(by['auto-glrelease-GL018378-2052'].note, /held back by GL GL017932/);
});

test('a confirmed match is kept, flagged if the GL entry changes, and a rejected entry is never tried again', () => {
  const pp = (id, date, amount) => cr(id, date, amount, `PAYPAL INC./PAYMENT 0000${id}`);
  const rec = { month: '2026-01', statements: { operating: { transactions: [pp('1', '2026-01-09', 100)] } } };
  const g = (fp) => ({ '2026-01': { receipts: [
    { ...gl('GL017495', '2026-01-09', 100, { 4018: 100 }, 'DAF Gifts - PayPal Grant'), fp, lines: [{ id: 'GL GL017495 1', a: '1100', amt: 100 }, { id: 'GL GL017495 2', a: '4018', cv: 'PAYPC001', d: 'PayPal Grant', amt: -100 }] },
    { ...gl('GL017499', '2026-01-10', 100, { 4018: 100 }, 'DAF Gifts - PayPal Grant'), fp: 'x' },
  ] } });
  let d = depositChecks({ recs: { '2026-01': rec }, glBy: g('a') })['2026-01'];
  assert.equal(d.lines[0].match.batch, 'GL017495');
  assert.equal(d.lines[0].match.confidence.tie.id, 'GL GL017495 1');
  // Confirmed, then the batch is edited in Acumatica: still matched, flagged low.
  rec.glMatch = { 1: { batch: 'GL017495', fp: 'a', by: 'Alex', at: 'x' } };
  d = depositChecks({ recs: { '2026-01': rec }, glBy: g('a') })['2026-01'];
  assert.equal(d.lines[0].match.confidence.level, 'confirmed');
  d = depositChecks({ recs: { '2026-01': rec }, glBy: g('b') })['2026-01'];
  assert.equal(d.lines[0].match.confidence.level, 'low');
  // Rejected: matched to the other entry instead.
  delete rec.glMatch;
  rec.glNot = { 1: { batches: ['GL017495'] } };
  d = depositChecks({ recs: { '2026-01': rec }, glBy: g('a') })['2026-01'];
  assert.equal(d.lines[0].match.batch, 'GL017499');
});

test('match confidence: names agree is high; an AP entry naming someone else is low', () => {
  const rec = { month: '2026-08', statements: { operating: { transactions: [
    cr('p', '2026-08-12', 150, 'PAYPAL INC./PAYMENT 0000p'), cr('a', '2026-08-14', 600, 'PARAMOUNT SECURI/BILL PAYMT')] } } };
  const g = { '2026-08': { receipts: [
    gl('GL018673', '2026-08-12', 150, { 4018: 150 }, 'DAF Gifts - PayPal Grant'),
    { ...gl('AP014203', '2026-08-14', 600, { 2010: 600 }, 'Quarterly Door License Fee'), ap: true, module: 'AP' },
  ] } };
  const d = depositChecks({ recs: { '2026-08': rec }, glBy: g })['2026-08'];
  const lv = (id) => d.lines.find((x) => x.line.id === id).match.confidence.level;
  assert.equal(lv('p'), 'high');
  assert.equal(lv('a'), 'low');
});
