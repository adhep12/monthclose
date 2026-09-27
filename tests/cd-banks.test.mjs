import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthSummary, applyCdarsStatement, earnedThrough, cdInterestJE } from '../app/js/cd/schedule.js';
import { parseCdarsStatement, parseIcsStatement } from '../app/js/cd/intrafi.js';
import { parseStripeMonthly } from '../app/js/poc/stripe.js';
import { parsePaypal, parseKeybank, parseWise } from '../app/js/poc/banks.js';
import { balanceMethodInterest, computePoc } from '../app/js/poc/calc.js';
import { confirmValues, confirmationState } from '../app/js/audit.js';
import { isBalanced } from '../app/js/fa/je.js';

const L = (arr) => arr.map((text) => ({ page: 1, text }));

test('CDARS month-end and maturity statements build the schedule', () => {
  const cds = [];
  const maturity = parseCdarsStatement(L(['Date', '07/23/2026', 'Summary of Accounts',
    '1000000001 06/25/2026 07/23/2026 3.50% $1,000,000.00 $0.00',
    'Account ID: 1000000001', 'Product Term 4-Week Non-Personal CD Effective Date 06/25/2026',
    'Account Balance $0.00 YTD Interest Paid $2,685.00', 'Annual Percentage Yield 3.56% Interest Earned Since Last Statement 2,110.00',
    'Some Bank FDIC Cert. 1', '07/23/2026 Interest Payment 2,685.00', '07/23/2026 Maturity Payout - Funds To (1,002,685.00)']));
  const monthEnd = parseCdarsStatement(L(['Date', '07/31/2026', 'Summary of Accounts',
    '1000000002 07/23/2026 08/20/2026 3.50% $0.00 $1,002,685.00',
    'Account ID: 1000000002', 'Account Balance $1,002,685.00 YTD Interest Paid $0.00',
    'Annual Percentage Yield 3.56% Interest Accrued 769.00', 'Interest Earned Since Last Statement 769.00']));
  applyCdarsStatement(cds, maturity, { user: 'A' });
  applyCdarsStatement(cds, monthEnd, { user: 'A' });
  applyCdarsStatement(cds, monthEnd, { user: 'A' }); // uploading twice doesn't double count
  // June's interest for the first CD, as if from the June month-end statement.
  cds[0].earned['2026-06'] = { amount: 575, source: 'statement' };

  const s = monthSummary(cds, '2026-07');
  assert.equal(s.accrued, 2879); // 2,110 + 769
  assert.equal(s.realized, 2685);
  assert.equal(s.balance, 1003454); // new CD principal + July interest not yet paid
  assert.equal(earnedThrough(cds[0], '2026-07'), 2685);
  const je = cdInterestJE(cds, '2026-07');
  assert.equal(je.length, 4);
  assert.ok(isBalanced(je));
  assert.equal(je[0].tranDescription, 'Interest Earned - 0001');
});

test('ICS statement ties opening + interest to ending', () => {
  const r = parseIcsStatement(L(['Date', '07/31/2026', 'Previous Period Ending Balance $3,612,385.34 Interest Rate at End of Statement Period 3.00%',
    'Total Program Deposits 0.00', 'Total Program Withdrawals (0.00) YTD Interest Paid 62,555.30', 'Interest Capitalized 9,215.38',
    'Current Period Ending Balance $3,621,600.72']));
  assert.equal(r.interest, 9215.38);
  assert.ok(r.ties);
});

test('Stripe revenue is gross payments less refunds', () => {
  const csv = [
    '"","",Month (all times in UTC),2026-07-01,2026-06-01', '"","",Currency,USD,USD', '""', 'Monthly Activity Summary',
    '"",Payments (cards),Count,1,1', '"","",Gross Amount,1000.00,500.00', '"","",Fees,-30.00,-15.00',
    '"",Refunds (cards),Count,1,0', '"","",Gross Amount,-50.00,0.00', '"","",Fees Returned,0.00,0.00',
    '"",Payments (other),Count,1,1', '"","",Gross Amount,200.00,100.00', '"","",Fees,-2.00,-1.00',
    '""', 'Payouts and Transfers Summary', '"",Payouts and Transfers,Count,1,1', '"","",Amount,1100.00,580.00',
    '""', 'Balance Summary', '"","",Start of Month Balance,10.00,0.00', '"","",End of Month Balance,28.00,10.00'].join('\n');
  const jul = parseStripeMonthly(csv).months.find((m) => m.month === '2026-07');
  assert.equal(jul.revenue, 1150);
  assert.equal(jul.payouts, 1100);
  assert.equal(jul.fees, -32);
  assert.equal(jul.endBalance, 28);
});

test('PayPal, KeyBank and Wise statements', () => {
  const pp = parsePaypal(L(['Merchant Account ID: X PayPal ID: y 7/1/26 - 7/31/26', 'Beginning Available Balance 100.00', 'Payments received 50.00',
    'Payments sent 0.00', 'Withdrawals and Debits 0.00', 'Deposits and Credits 0.00', 'Fees -2.00', 'Ending Available Balance 148.00']));
  assert.equal(pp.revenue, 50);
  assert.ok(pp.ties);
  const kb = parseKeybank(L(['KeyBank', 'Business Banking Statement', 'July 31, 2026', 'Key Business Silver Money Market Svgs 370443007080',
    'Beginning balance 6-30-26 $15,493.40', 'Interest paid +0.14', 'Ending balance 7-31-26 $15,493.54']));
  assert.equal(kb.source, 'keyMM');
  assert.equal(kb.interest, 0.14);
  assert.ok(kb.ties);
  const w = parseWise(L(['July 1, 2026 [GMT-07:00] - July 31, 2026 [GMT-07:00]', 'USD on July 31, 2026 [GMT-07:00] 250,470.81 USD',
    'Description Incoming Outgoing Amount', 'Converted 1,000.00 GBP to 1,336.87 USD', '1,336.87 250,470.81', 'July 20, 2026 Transaction: X',
    'Interest payment', '633.06 249,133.94', 'July 1, 2026 Transaction: Y']));
  assert.equal(w.revenue, 1336.87);
  assert.equal(w.interest, 633.06);
});

test('Wise statements with day-first dates', () => {
  const w = parseWise(L(['USD statement', '1 June 2026 [GMT-06:00] - 30 June 2026 [GMT-06:00]', 'USD on 30 June 2026 [GMT-06:00] 248,500.88 USD',
    'Description Incoming Outgoing Amount', 'Interest payment', '1,272.00 248,500.88', '1 June 2026 Transaction: BALANCE_INTEREST-x']));
  assert.equal(w.month, '2026-06');
  assert.equal(w.interest, 1272);
  assert.equal(w.items[0].date, '2026-06-01');
});

test('Delap/Tschetter gain = change in value less money moved in', () => {
  assert.equal(balanceMethodInterest({ ending: 5186270.92 }, { ending: 5161886.70 }), 24384.22);
  assert.equal(balanceMethodInterest({ ending: 5084983.41, netDeposits: -84706.53 }, { ending: 5145263.38 }), 24426.56);
  assert.equal(balanceMethodInterest({ ending: 100 }, {}), null);
  const c = computePoc({ month: '2026-07', bank: { delap: { ending: 110 } } }, { prior: { bank: { delap: { ending: 100 } } } });
  assert.equal(c.lines.find((l) => l.id === 'delap').int, 10);
});

test('a confirmation goes stale when the number changes', () => {
  const o = {};
  confirmValues(o, 'MW', { rev: 10 });
  assert.equal(confirmationState(o, { rev: 10 }), 'confirmed');
  assert.equal(confirmationState(o, { rev: 11 }), 'stale');
  assert.equal(confirmationState({}, { rev: 10 }), 'none');
});

test('detaching a CDARS statement puts the schedule back the way it was', async () => {
  const { applyCdarsStatement, detachCdarsStatement, cdSourcesFor } = await import('../app/js/cd/schedule.js');
  const cds = [{ id: '1000000001', last4: '0001', principal: 1000000, effective: '2026-06-25', maturity: '2026-07-23', status: 'active',
    earned: { '2026-07': { amount: 2100, source: 'workbook' } }, stmtEarned: {} }];
  const stmt = parseCdarsStatement(L(['Date', '07/23/2026', 'Summary of Accounts',
    '1000000001 06/25/2026 07/23/2026 3.50% $1,000,000.00 $0.00',
    '1000000002 07/23/2026 08/20/2026 3.50% $0.00 $1,002,685.00',
    'Account ID: 1000000001', 'Account Balance $0.00 YTD Interest Paid $2,685.00', 'Annual Percentage Yield 3.56% Interest Earned Since Last Statement 2,110.00',
    '07/23/2026 Interest Payment 2,685.00', '07/23/2026 Maturity Payout - Funds To (1,002,685.00)',
    'Account ID: 1000000002', 'Account Balance $1,002,685.00 YTD Interest Paid $0.00', 'Annual Percentage Yield 3.56% Interest Accrued 100.00', 'Interest Earned Since Last Statement 100.00']));
  const touched = applyCdarsStatement(cds, stmt, { user: 'A' });
  touched.forEach((cd) => { cd.files = { [stmt.date]: { name: 'cdars.pdf', by: 'A' } }; });
  assert.equal(cds[0].earned['2026-07'].amount, 2110);
  assert.equal(cds[0].status, 'matured');
  assert.equal(cds.length, 2);
  const src = cdSourcesFor(cds, '2026-07');
  assert.equal(src.length, 1);
  assert.deepEqual(src[0].cds, ['0001', '0002']);

  const { changed, removed } = detachCdarsStatement(cds, stmt.date);
  assert.equal(changed.length, 1);
  assert.equal(removed.length, 1); // the CD this statement created
  assert.deepEqual(cds[0].earned['2026-07'], { amount: 2100, source: 'workbook' }); // workbook figure back
  assert.equal(cds[0].status, 'active');
  assert.equal(cds[0].interestPaid, 0);
});
