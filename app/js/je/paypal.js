// The monthly PayPal giving JE, from the PayPal statement's Activity Summary. Laid out like the
// posted batch, line for line:
//   Cr 4012  payments received          Dr 8590  fees          Dr 1012  received less fees
//   Dr 8030 / Cr 1012  payments sent for software
//   Dr 4012 / Cr 1012  chargebacks, and payments sent that were refunds to a donor (Feb and Mar
//                      2026: 15,337 sent back, booked "Payment Refund" / "Chargeback")
// Which payments sent were refunds is decided per payment (rec.paypalSentAs); wording that says
// refund starts as one.
// Zero lines are left out.

import { round2 } from '../money.js';
import { paypalTies } from '../poc/banks.js';

const GIVING = { account: '4012', sub: '000-000' };
const FEES = { account: '8590', sub: '013-000' };
const PAYPAL = { account: '1012', sub: '000-000' };
const SOFTWARE = { account: '8030', sub: '013-000' };

export const PAYPAL_JE = { description: 'Paypal Giving' };

export const sentKey = (x) => `${x.date}|${x.amount}|${x.desc}`;
export const sentAs = (x, chosen = {}) => chosen[sentKey(x)]?.as || (/refund/i.test(x.desc) ? 'refund' : 'software');

// `b` is the attached statement (rec.bankStatements.paypal), `chosen` rec.paypalSentAs. Returns
// { lines, problems, notes, sent } — sent: each payment sent with how it's booked.
export function paypalJe(b, chosen = {}) {
  if (b.chargeback === undefined) return { lines: [], problems: ['The PayPal statement was attached before the app read its chargebacks. Attach it again.'], notes: [] };
  const lines = [], problems = [], notes = [];
  const push = ({ account, sub }, debit, tranDescription) => {
    const v = round2(debit);
    if (v) lines.push({ account, sub, debit: v > 0 ? v : 0, credit: v < 0 ? -v : 0, tranDescription });
  };
  const received = b.received ?? b.revenue ?? 0;
  const fees = -(b.fees || 0); // printed negative
  const sent = Math.abs(b.paymentsSent || 0);
  const items = (b.sent || []).map((x) => ({ ...x, key: sentKey(x), as: sentAs(x, chosen) }));
  const refunds = round2(items.filter((x) => x.as === 'refund').reduce((t, x) => t + x.amount, 0));
  const software = round2(sent - refunds);
  const chargeback = round2(-(b.chargeback || 0) + refunds);
  push(GIVING, -received, 'Paypal Giving "Payments received Total"');
  push(FEES, fees, 'Paypal Giving "Fees Total"');
  push(PAYPAL, received - fees, 'Paypal Giving less Fees');
  push(SOFTWARE, software, 'Dispute Software paid with paypal');
  push(PAYPAL, -software, 'Dispute Software paid with paypal');
  push(GIVING, chargeback, 'Payment Refund');
  push(PAYPAL, -chargeback, 'Chargeback');

  if (round2(items.reduce((t, x) => t + x.amount, 0)) !== round2(sent)) notes.push(`The statement’s payments sent (${sent.toFixed(2)}) aren’t all in its transaction history; what isn’t is booked as software.`);
  const other = [['Withdrawals and Debits', b.withdrawals], ['Deposits and Credits', b.depositsCredits], ['Transfers', b.transfers]].filter(([, v]) => round2(v || 0));
  if (other.length) notes.push(`Not in this entry: ${other.map(([k, v]) => `${k} ${round2(v).toFixed(2)}`).join(', ')}. Money moved to or from our own accounts is booked by the entry on the other side.`);
  if (paypalTies(b) === false) problems.push('The statement doesn’t add up to its ending balance. Check it before booking.');
  return { lines, problems, notes, sent: items };
}
