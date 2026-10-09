import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStripeMonthly } from '../app/js/poc/stripe.js';
import { stripeJe } from '../app/js/je/stripe.js';
import { monthJes, jeReady, importRows, importCsv, IMPORT_COLUMNS } from '../app/js/je/month.js';

// The Stripe monthly statement CSV's layout, two months (made-up figures).
const csv = (a, b) => [
  '"","",Month (all times in UTC),2026-08-01,2026-07-01',
  '"","",Currency,USD,USD', '""', 'Monthly Activity Summary',
  `"",Payments (cards),Count,10,10`, `"","",Gross Amount,${a[0]},${b[0]}`, `"","",Fees,${a[1]},${b[1]}`,
  `"",Refunds (cards),Count,1,1`, `"","",Gross Amount,${a[2]},${b[2]}`, `"","",Fees Returned,${a[3]},${b[3]}`,
  `"",Disputes,Count,0,1`, `"","",Gross Amount,${a[4]},${b[4]}`, `"","",Fees,${a[5]},${b[5]}`,
  `"",Dispute Reversals,Count,0,1`, `"","",Gross Amount,${a[6]},${b[6]}`, `"","",Fees Returned,${a[7]},${b[7]}`,
  `"",Other Adjustments,Count,1,1`, `"","",Gross Amount,${a[8]},${b[8]}`, `"","",Fees,0.00,0.00`,
  `"",Payments (other),Count,1,1`, `"","",Gross Amount,${a[9]},${b[9]}`, `"","",Fees,${a[10]},${b[10]}`,
  `"",Refunds (other),Count,1,0`, `"","",Gross Amount,${a[11]},${b[11]}`, `"","",Fees Returned,${a[12]},${b[12]}`,
  `Net Activity,"","",${a[13]},${b[13]}`, '""', 'Payouts and Transfers Summary',
  `"",Payouts and Transfers,Count,5,4`, `"","",Amount,${a[14]},${b[14]}`, '""', 'Balance Summary',
  `"","",Start of Month Balance,${a[15]},${b[15]}`, `"","",Net Activity,${a[13]},${b[13]}`,
  `"","",Less Net Payouts and Transfers,-${a[14]},-${b[14]}`, `"","",End of Month Balance,${a[16]},${b[16]}`,
].join('\n');
//             cards  fees  refund ret  disp  dfee rev  rret  other  ach   achfee achref ret   net     payout start  end
const aug = [100000, -2500, -500, 0, 0, 0, 0, 0, -300, 20000, -100, -25, -3.8, 116571.2, 150000, 60000, 26571.2];
const jul = [90000, -2200, -100, 1.5, -40, -15, 25, 15, -250, 10000, -50, 0, 0, 97386.5, 80000, 20000, 37386.5];
const months = parseStripeMonthly(csv(aug, jul)).months;

test('Stripe JE: the workbook lines, signs as the CSV prints them, balanced by payouts and Stripe Checking', () => {
  const { lines, problems } = stripeJe(months[0]);
  assert.deepEqual(problems, []);
  assert.deepEqual(lines.map((l) => [l.account, l.sub, l.debit, l.credit, l.tranDescription]), [
    ['1200', '000-000', 150000, 0, '9 Payouts & Transfers'],
    ['4015', '000-000', 0, 100000, '1 Payments CC Gross Amount'],
    ['4015', '000-000', 500, 0, '3 Refunds CC Gross Amount'],
    ['4015', '000-000', 0, 20000, '7 Payments ACH Gross Amount'],
    ['8590', '013-000', 300, 0, '6 Other Adjustments Fees'],
    ['8590', '013-000', 2500, 0, '2 Payment CC Fees'],
    ['8590', '013-000', 100, 0, '8 Payment Wire Fees'],
    ['4015', '000-000', 25, 0, '88 Wire Refunds Gross Amount'],
    ['1015', '000-000', 0, 33428.8, '99 Stripe Checking'],
    ['8590', '013-000', 3.8, 0, '888 ACH Fee return'],
  ]);
});

test('Stripe JE: disputes net of reversals, fees net of fees returned; a rising balance debits Stripe Checking', () => {
  const { lines, problems } = stripeJe(months[1]);
  assert.deepEqual(problems, []);
  const by = (d) => lines.find((l) => l.tranDescription === d);
  assert.equal(by('4 Dispute Gross Amount').debit, 15);
  assert.equal(by('5 Dispute Fees'), undefined); // 15 in fees, 15 returned
  assert.deepEqual([by('99 Stripe Checking').debit, by('99 Stripe Checking').credit], [17386.5, 0]);
  assert.equal(lines.filter((l) => l.tranDescription === '888 ACH Fee return')[0].credit, 1.5);
  const [je] = monthJes({ month: '2026-07', stripe: months[1] });
  assert.ok(jeReady(je));
});

test('Stripe JE: a CSV that doesn’t add up, or one attached before the figures were kept, isn’t ready', () => {
  const off = parseStripeMonthly(csv([...aug.slice(0, 13), 116000, ...aug.slice(14)], jul)).months[0];
  assert.equal(stripeJe(off).problems.length, 2);
  const [old] = monthJes({ month: '2026-08', stripe: { month: '2026-08', payments: 1 } });
  assert.equal(jeReady(old), false);
  assert.equal(monthJes({ month: '2026-08' })[0].missing, 'Attach the Stripe CSV.');
});

test('Import file: one row per line, batch number, month-end date, blank empty side', () => {
  const [je] = monthJes({ month: '2026-08', stripe: months[0] });
  const rows = importRows([je]);
  assert.deepEqual(rows[0], IMPORT_COLUMNS);
  assert.equal(rows.length, 1 + je.lines.length);
  const [batch, date, desc, account, sub, debit, credit, tran] = rows[1];
  assert.deepEqual([batch.v, date.v, desc, account.v, sub, debit, credit, tran], [1, 46265, 'Monthly Stripe Giving', 1200, '000-000', 150000, '', '9 Payouts & Transfers']);
});

// ---- Tschetter and Delap ------------------------------------------------------------------
import { parseSchwab, detectBank } from '../app/js/poc/banks.js';
import { investmentJe } from '../app/js/je/investments.js';

const schwabApril = [
  'Schwab One® Account of', 'Account Number Statement Period', 'BIBLEPROJECT 4730-4318 April 1-30, 2026', 'Account Summary',
  'Beginning Account Value $5,163,322.62 $5,097,857.19', 'Deposits 0.00 0.00', 'Withdrawals 0.00 0.00',
  'Dividends and Interest 24,007.12 94,956.84', 'Market Appreciation/(Depreciation) (17,131.46) (12,998.83)',
  'Expenses (3,227.08) (12,844.00)', 'Ending Account Value $5,166,971.20 $5,166,971.20',
].map((text) => ({ text }));

test('Schwab statement: period, values, this month’s and year-to-date expenses, ties', () => {
  assert.equal(detectBank(schwabApril), 'schwab');
  const s = parseSchwab(schwabApril);
  assert.deepEqual([s.source, s.month, s.beginning, s.ending, s.fees, s.feesYtd, s.market, s.ties],
    ['tschetter', '2026-04', 5163322.62, 5166971.2, 3227.08, 12844, -17131.46, true]);
});

// Jan: photographed statement, figures typed. Feb, Mar: portal screenshots. Apr: the statement.
const tsch = (bank, extra = {}) => ({ bank: { tschetter: bank }, ...extra });
const fy = () => ({
  '2026-01': { month: '2026-01', ...tsch({ ending: 5134615.60, feesYtd: 3186.16 }) },
  '2026-02': { month: '2026-02', ...tsch({ ending: 5154602.05 }) },
  '2026-03': { month: '2026-03', ...tsch({ ending: 5163322.62, beginning: 5164013.51 }) },
  '2026-04': { month: '2026-04', ...tsch({ ending: 5166971.20 }, { bankStatements: { tschetter: parseSchwab(schwabApril) } }) },
});
const rows = (je) => je.lines.map((l) => [l.account, l.debit, l.credit]);

// The GL for Jan-Mar: Jan's statement booked its fees, Feb and Mar were screenshots (gain only).
const glFy = () => ({
  '2026-01': { investmentGl: [{ account: 'tschetter', batch: 'GL1', value: 0, gain: 3186.16, fee: 3186.16 }] },
  '2026-02': { investmentGl: [{ account: 'tschetter', batch: 'GL2', value: 19986.45, gain: 19986.45, fee: 0 }] },
  '2026-03': { investmentGl: [] },
});

test('Tschetter: a statement books the change since last booked and its year-to-date fees less what the GL booked', () => {
  const je = investmentJe('tschetter', '2026-04', { recs: fy(), glBy: glFy() });
  assert.deepEqual(je.problems, []);
  assert.deepEqual(je.notes, []);
  assert.deepEqual(rows(je), [['1171', 3648.58, 0], ['8999', 0, 13306.42], ['8070', 9657.84, 0]]);
  assert.equal(je.lines[0].tranDescription, 'Unrealized Gains - Tschetter Group 4-30-2026, fees Feb-Apr 2026');
  assert.match(je.working.feeBasis, /12844\.00 less 3186\.16 the GL booked to 8070 in 2026 through Jan 2026/);
});

test('Tschetter: screenshot months book the gain only, from the last ending booked, and flag a beginning that differs', () => {
  const je = investmentJe('tschetter', '2026-03', { recs: fy() });
  assert.deepEqual(rows(je), [['1171', 8720.57, 0], ['8999', 0, 8720.57]]);
  assert.equal(je.lines[0].tranDescription, 'Unrealized Gains - Tschetter Group 3-31-2026');
  assert.match(je.notes.join(' '), /starts at 5164013\.51, not the 5154602\.05 last booked/);
});

test('Tschetter: an earlier statement doesn’t count as booked; only the GL does, so a month booked short is caught up', () => {
  // Jan's statement is in the app, but the GL booked only part of its fees.
  const glBy = glFy(); glBy['2026-01'].investmentGl[0].fee = 3000;
  const je = investmentJe('tschetter', '2026-04', { recs: fy(), glBy });
  assert.equal(je.working.fees, 9844);
  assert.equal(je.working.feeMonths, 'Feb-Apr 2026');
  // Nothing booked this year at all: the whole year to date.
  const none = { '2026-01': { investmentGl: [] }, '2026-02': { investmentGl: [] }, '2026-03': { investmentGl: [] } };
  const all = investmentJe('tschetter', '2026-04', { recs: fy(), glBy: none });
  assert.equal(all.working.fees, 12844);
  assert.equal(all.working.feeMonths, 'Jan-Apr 2026');
  // This month's own GL entry isn't counted: rebuilding after posting gives the same JE.
  const posted = glFy(); posted['2026-04'] = { investmentGl: [{ account: 'tschetter', batch: 'GL4', value: 3648.58, gain: 13306.42, fee: 9657.84 }] };
  assert.equal(investmentJe('tschetter', '2026-04', { recs: fy(), glBy: posted }).working.fees, 9657.84);
});

test('Tschetter: fees follow the calendar year like the statement, across the October fiscal year start', () => {
  // Nov 2026 is in fiscal 2027; the statement's year to date still runs from January 2026.
  const recs = { '2026-10': { month: '2026-10', ...tsch({ ending: 100 }) }, '2026-11': { month: '2026-11', ...tsch({ ending: 100, feesYtd: 36000 }) } };
  const glBy = {};
  for (let m = 1; m <= 10; m++) glBy[`2026-${String(m).padStart(2, '0')}`] = { investmentGl: m === 9 ? [{ account: 'tschetter', batch: 'GL9', value: 0, gain: 0, fee: 29154.39 }] : m === 10 ? [{ account: 'tschetter', batch: 'GL10', value: 0, gain: 0, fee: 3300 }] : [] };
  glBy['2025-12'] = { investmentGl: [{ account: 'tschetter', batch: 'GLD', value: 0, gain: 0, fee: 5000 }] }; // last calendar year: not counted
  const je = investmentJe('tschetter', '2026-11', { recs, glBy });
  assert.equal(je.working.fees, round(36000 - 29154.39 - 3300));
  assert.equal(je.working.feeMonths, 'Nov 2026');
});

test('Tschetter: a month with no GL in the app is flagged, and the JE is still built', () => {
  const glBy = glFy(); delete glBy['2026-02']; delete glBy['2026-03'];
  const je = investmentJe('tschetter', '2026-04', { recs: fy(), glBy });
  assert.deepEqual(je.problems, []);
  assert.equal(je.working.fees, 9657.84);
  assert.match(je.notes.join(' '), /No GL in the app for Feb 2026, Mar 2026: any fees booked to 8070 then aren’t counted/);
});

test('Tschetter: a month with no value is picked up by the next; a statement from last year short of December is flagged', () => {
  const recs = fy(); delete recs['2026-02'];
  const je = investmentJe('tschetter', '2026-03', { recs });
  assert.equal(je.working.change, round(5163322.62 - 5134615.60));
  assert.match(je.notes.join(' '), /No ending value for Feb 2026/);
  recs['2025-10'] = { month: '2025-10', ...tsch({ ending: 5000000, feesYtd: 30000 }) };
  assert.match(investmentJe('tschetter', '2026-01', { recs }).notes.join(' '), /Fees after Oct 2025 to Dec 2025/);
  assert.equal(investmentJe('tschetter', '2025-09', { recs }), null);
});

test('Delap: gain only; money moved out is booked by its own entry, so it isn’t in the change', () => {
  const recs = { '2026-07': { month: '2026-07', bank: { delap: { ending: 100000 } } }, '2026-08': { month: '2026-08', bank: { delap: { ending: 110000, netDeposits: -10000 } } } };
  const je = investmentJe('delap', '2026-08', { recs });
  assert.deepEqual(rows(je), [['1170', 20000, 0], ['8999', 0, 20000]]);
  assert.equal(je.lines[0].tranDescription, 'Unrealized Gains - Delap 8-31-2026');
  const all = monthJes(recs['2026-08'], { recs });
  assert.deepEqual(all.map((x) => [x.batch, x.id, jeReady(x)]), [[1, 'stripe', false], [2, 'paypal', false], [3, 'tschetter', false], [4, 'delap', true], [5, 'cd', false]]);
});
const round = (n) => Math.round(n * 100) / 100;

// ---- PayPal --------------------------------------------------------------------------------
import { parsePaypal } from '../app/js/poc/banks.js';

const paypalLines = (sent = '0.00', ending = '1,494.00') => [
  'Merchant Account ID: X PayPal ID: finance@example.com 8/1/26 - 8/31/26', 'Activity Summary (8/1/26 - 8/31/26)', 'USD',
  'Beginning Available Balance 1,000.00', 'Payments received 600.00', `Payments sent ${sent}`, 'Withdrawals and Debits 0.00',
  'Deposits and Credits 0.00', 'Fees -30.00', 'Chargeback -10.00', `Ending Available Balance ${ending}`,
  'Transaction History - USD', 'General Payment Some Software Co', '8/12/26 -66.00 0.00 -66.00',
].map((text) => ({ text }));

test('PayPal statement: the chargeback is read and the statement ties with it', () => {
  const b = parsePaypal(paypalLines('-66.00', '1,494.00'));
  assert.deepEqual([b.received, b.fees, b.paymentsSent, b.chargeback, b.ties], [600, -30, -66, -10, true]);
});

test('PayPal JE: giving, fees, net to 1012; payments sent to 8030; chargeback back out of giving', () => {
  const b = parsePaypal(paypalLines('-66.00', '1,494.00'));
  const je = monthJes({ month: '2026-08', bankStatements: { paypal: b } }).find((x) => x.id === 'paypal');
  assert.equal(je.batch, 2);
  assert.ok(jeReady(je));
  assert.deepEqual(je.lines.map((l) => [l.account, l.debit, l.credit, l.tranDescription]), [
    ['4012', 0, 600, 'Paypal Giving "Payments received Total"'],
    ['8590', 30, 0, 'Paypal Giving "Fees Total"'],
    ['1012', 570, 0, 'Paypal Giving less Fees'],
    ['8030', 66, 0, 'Dispute Software paid with paypal'],
    ['1012', 0, 66, 'Dispute Software paid with paypal'],
    ['4012', 10, 0, 'Payment Refund'],
    ['1012', 0, 10, 'Chargeback'],
  ]);
  assert.deepEqual(je.sent.map((x) => [x.date, x.desc, x.amount, x.as]), [['2026-08-12', 'General Payment Some Software Co', 66, 'software']]);
  // A statement attached before chargebacks were read has to be attached again.
  const { chargeback, ...old } = b;
  assert.equal(jeReady(monthJes({ month: '2026-08', bankStatements: { paypal: old } }).find((x) => x.id === 'paypal')), false);
});

test('PayPal JE: a payment sent that was a refund to a donor is booked with the chargebacks (Feb 2026 shape)', () => {
  const lines = [
    'Merchant Account ID: X PayPal ID: finance@example.com 2/1/26 - 2/28/26', 'USD',
    'Beginning Available Balance 20,000.00', 'Payments received 16,358.48', 'Payments sent -15,337.00', 'Withdrawals and Debits 0.00',
    'Deposits and Credits 0.00', 'Fees -800.00', 'Ending Available Balance 20,221.48',
    'Transaction History - USD', 'General Payment A Donor', '2/13/26 -15,337.00 0.00 -15,337.00',
  ].map((text) => ({ text }));
  const b = parsePaypal(lines);
  assert.equal(b.ties, true);
  const pp = (chosen) => monthJes({ month: '2026-02', bankStatements: { paypal: b }, paypalSentAs: chosen }).find((x) => x.id === 'paypal');
  assert.deepEqual(pp().lines.map((l) => [l.account, l.debit, l.credit]).slice(3), [['8030', 15337, 0], ['1012', 0, 15337]]);
  const [x] = pp().sent;
  const je = pp({ [x.key]: { as: 'refund' } });
  assert.deepEqual(je.lines.map((l) => [l.account, l.debit, l.credit, l.tranDescription]), [
    ['4012', 0, 16358.48, 'Paypal Giving "Payments received Total"'],
    ['8590', 800, 0, 'Paypal Giving "Fees Total"'],
    ['1012', 15558.48, 0, 'Paypal Giving less Fees'],
    ['4012', 15337, 0, 'Payment Refund'],
    ['1012', 0, 15337, 'Chargeback'],
  ]);
  assert.ok(jeReady(je));
});

test('Edited defaults: account, subaccount and description replace the built-in ones; placeholders still fill in', () => {
  const jeDefaults = {
    stripe: { description: 'Stripe Giving', lines: { payouts: { account: '1201' }, cardFees: { sub: '014-000', desc: 'Card fees' } } },
    tschetter: { lines: { fees: { desc: 'Tschetter advisor fees{fees}' } } },
  };
  const [je] = monthJes({ month: '2026-08', stripe: months[0] }, { jeDefaults });
  assert.equal(je.description, 'Stripe Giving');
  assert.deepEqual([je.lines[0].account, je.lines[0].sub, je.lines[0].tranDescription, je.lines[0].edited], ['1201', '000-000', '9 Payouts & Transfers', true]);
  const fees = je.lines.find((l) => l.key === 'cardFees');
  assert.deepEqual([fees.account, fees.sub, fees.tranDescription], ['8590', '014-000', 'Card fees']);
  assert.equal(importRows([je])[1][3].v, 1201);
  const t = monthJes(fy()['2026-04'], { recs: fy(), glBy: glFy(), jeDefaults }).find((x) => x.id === 'tschetter');
  assert.deepEqual(t.lines.map((l) => l.tranDescription), ['Unrealized Gains - Tschetter Group 4-30-2026, fees Feb-Apr 2026',
    'Unrealized Gains - Tschetter Group 4-30-2026, fees Feb-Apr 2026', 'Tschetter advisor fees, fees Feb-Apr 2026']);
});

test('CD interest: batch 5, one pair per CD from the CD schedule; edits apply to every CD', () => {
  const cds = [{ last4: '3987', earned: { '2026-08': { amount: 18299.54 } } }, { last4: '9874', earned: { '2026-08': { amount: 18313.23 } } }, { last4: '7416', earned: {} }];
  const je = monthJes({ month: '2026-08' }, { cds }).find((x) => x.id === 'cd');
  assert.equal(je.batch, 5);
  assert.ok(jeReady(je));
  assert.deepEqual(je.lines.map((l) => [l.account, l.debit, l.credit, l.tranDescription]), [
    ['1150', 18299.54, 0, 'Interest Earned - 3987'], ['4050', 0, 18299.54, 'Interest Earned - 3987'],
    ['1150', 18313.23, 0, 'Interest Earned - 9874'], ['4050', 0, 18313.23, 'Interest Earned - 9874'],
  ]);
  const edited = monthJes({ month: '2026-08' }, { cds, jeDefaults: { cd: { lines: { income: { account: '4051', desc: 'CD interest {cd}' } } } } }).find((x) => x.id === 'cd');
  assert.deepEqual(edited.lines.filter((l) => l.key === 'income').map((l) => [l.account, l.tranDescription]), [['4051', 'CD interest 3987'], ['4051', 'CD interest 9874']]);
  assert.equal(monthJes({ month: '2026-07' }, { cds }).find((x) => x.id === 'cd').missing, 'Attach the CDARS statements or the IntraFi export.');
});

test('CSV: the same columns and rows, dates m/d/yyyy, text with commas or quotes quoted', () => {
  const [je] = monthJes({ month: '2026-08', stripe: months[0] });
  const rows = importCsv([{ ...je, description: 'Stripe, "monthly"' }]).trim().split('\r\n');
  assert.equal(rows[0], IMPORT_COLUMNS.join(','));
  assert.equal(rows[1], '1,8/31/2026,"Stripe, ""monthly""",1200,000-000,150000.00,,9 Payouts & Transfers');
  assert.equal(rows.length, 1 + je.lines.length);
});

test('A Tschetter fee entry and its reversal net out, even when the reversal has no 1171 line (Apr 2026)', async () => {
  const { investmentAccountOf } = await import('../app/js/gl.js');
  const original = { desc: 'Unrealized Gains - Tschetter Group (Expenses Quarterly)', accounts: { 1171: 0, 8999: -9697.84, 8070: 9697.84 } };
  const reversal = { desc: 'Unrealized Gains - Tschetter Group (Expenses Quarterly) - Reversal', accounts: { 8999: 9697.84, 8070: -9697.84 } };
  assert.deepEqual([investmentAccountOf(original), investmentAccountOf(reversal)], ['1171', '1171']);
  assert.equal(investmentAccountOf({ desc: 'Unrealized Gains - Delap', accounts: { 8999: 5 } }), '1170');
  // A DAF gift batch with an Overflow fee (8070) names no investment: not counted as one.
  assert.equal(investmentAccountOf({ desc: 'DAF Gifts - Fidelity, NCF, Overflow', accounts: { 1100: -10, 4018: 10.5, 8070: -0.5 } }), null);
});
