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
