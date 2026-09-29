import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStripeMonthly } from '../app/js/poc/stripe.js';
import { stripeJe } from '../app/js/je/stripe.js';
import { monthJes, jeReady, importRows, IMPORT_COLUMNS } from '../app/js/je/month.js';

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

test('Tschetter: a statement books the change since last booked and the fees since the last statement', () => {
  const je = investmentJe('tschetter', '2026-04', { recs: fy() });
  assert.deepEqual(je.problems, []);
  assert.deepEqual(rows(je), [['1171', 3648.58, 0], ['8999', 0, 13306.42], ['8070', 9657.84, 0]]);
  assert.equal(je.lines[0].tranDescription, 'Unrealized Gains - Tschetter Group 4-30-2026, fees Feb-Apr 2026');
  assert.match(je.working.feeBasis, /12844\.00 less 3186\.16 on the Jan 2026 statement/);
});

test('Tschetter: screenshot months book the gain only, from the last ending booked, and flag a beginning that differs', () => {
  const je = investmentJe('tschetter', '2026-03', { recs: fy() });
  assert.deepEqual(rows(je), [['1171', 8720.57, 0], ['8999', 0, 8720.57]]);
  assert.equal(je.lines[0].tranDescription, 'Unrealized Gains - Tschetter Group 3-31-2026');
  assert.match(je.notes.join(' '), /starts at 5164013\.51, not the 5154602\.05 last booked/);
});

test('Tschetter: fees already booked come from the GL when the earlier statement isn’t in the app', () => {
  const recs = fy(); delete recs['2026-01'].bank.tschetter.feesYtd;
  const glBy = { '2026-01': { investmentGl: [{ account: 'tschetter', batch: 'GL1', value: 0, gain: 3186.16, fee: 3186.16 }] } };
  const je = investmentJe('tschetter', '2026-04', { recs, glBy });
  assert.equal(je.working.fees, 9657.84);
  assert.equal(je.working.feeMonths, 'Feb-Apr 2026');
  // Nothing booked this year at all: the whole year to date.
  assert.equal(investmentJe('tschetter', '2026-04', { recs }).working.feeMonths, 'Jan-Apr 2026');
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
  assert.deepEqual(all.map((x) => [x.batch, x.id, jeReady(x)]), [[1, 'stripe', false], [2, 'paypal', false], [3, 'tschetter', false], [4, 'delap', true]]);
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
