// The monthly Stripe giving JE ("Monthly Stripe Giving"), from the Stripe monthly statement CSV.
// Laid out like the Acumatica tab of the "Month Close Bank Recs" workbook, line for line, with
// its transaction descriptions. Each CSV figure is booked with the sign Stripe prints: money
// that added to the Stripe balance (gifts, fees returned) is a credit, money that came off it
// (refunds, disputes, fees) a debit. Payouts go to Cash Clearing (1200) and the change in the
// Stripe balance to Stripe Checking (1015), which is what makes it balance.

import { round2 } from '../money.js';

const CLEARING = { account: '1200', sub: '000-000' };
const REV = { account: '4015', sub: '000-000' };
const FEES = { account: '8590', sub: '013-000' };
const CHECKING = { account: '1015', sub: '000-000' };

// [key, transaction description, account, credit (a negative is a debit) from the CSV month's figures].
// The key names the line for its edited defaults (je/month.js).
const LINES = [
  ['payouts', '9 Payouts & Transfers', CLEARING, (f) => -f.payouts],
  ['cardGross', '1 Payments CC Gross Amount', REV, (f) => f.cardGross],
  ['cardRefunds', '3 Refunds CC Gross Amount', REV, (f) => f.cardRefunds],
  ['otherGross', '7 Payments ACH Gross Amount', REV, (f) => f.otherGross],
  ['otherAdjustments', '6 Other Adjustments Fees', FEES, (f) => f.otherAdjustments + f.otherAdjustmentFees],
  ['cardFees', '2 Payment CC Fees', FEES, (f) => f.cardFees],
  ['disputes', '4 Dispute Gross Amount', REV, (f) => f.disputes + f.disputeReversals],
  ['disputeFees', '5 Dispute Fees', FEES, (f) => f.disputeFees + f.disputeReversalFeesReturned],
  ['otherFees', '8 Payment Wire Fees', FEES, (f) => f.otherFees],
  ['otherRefunds', '88 Wire Refunds Gross Amount', REV, (f) => f.otherRefunds],
  ['checking', '99 Stripe Checking', CHECKING, (f) => f.startBalance - f.endBalance],
  ['otherRefundFeesReturned', '888 ACH Fee return', FEES, (f) => f.otherRefundFeesReturned],
  ['cardRefundFeesReturned', '888 ACH Fee return', FEES, (f) => f.cardRefundFeesReturned],
];
const NOTES = { otherRefundFeesReturned: 'fees returned on ACH refunds', cardRefundFeesReturned: 'fees returned on card refunds' };
export const STRIPE_TEMPLATE = LINES.map(([key, desc, { account, sub }]) => ({ key, desc, account, sub, note: NOTES[key] }));
const ACTIVITY = ['cardGross', 'cardFees', 'cardRefunds', 'cardRefundFeesReturned', 'disputes', 'disputeFees',
  'disputeReversals', 'disputeReversalFeesReturned', 'otherAdjustments', 'otherAdjustmentFees', 'otherGross',
  'otherFees', 'otherRefunds', 'otherRefundFeesReturned'];

export const STRIPE_JE = { description: 'Monthly Stripe Giving' };

// `m` is one month of parseStripeMonthly (as saved on the month: rec.stripe). Returns
// { lines, problems }: lines of { account, sub, debit, credit, tranDescription }, zero lines left out.
export function stripeJe(m) {
  const f = m?.csv;
  if (!f) return { lines: [], problems: ['The Stripe CSV was attached before the app kept the figures the JE needs. Attach it again.'] };
  const lines = [];
  for (const [key, tranDescription, { account, sub }, credit] of LINES) {
    const v = round2(credit(f));
    if (v) lines.push({ key, account, sub, debit: v < 0 ? -v : 0, credit: v > 0 ? v : 0, tranDescription });
  }
  const problems = [];
  const activity = round2(ACTIVITY.reduce((s, k) => s + f[k], 0));
  if (activity !== round2(f.netActivity)) problems.push(`The CSV’s activity lines add up to ${activity}, not its Net Activity of ${round2(f.netActivity)}. It has a row the app doesn’t know about.`);
  if (round2(f.startBalance + f.netActivity - f.payouts) !== round2(f.endBalance)) problems.push('The CSV’s balance summary doesn’t roll forward (start + net activity − payouts ≠ end).');
  return { lines, problems };
}
