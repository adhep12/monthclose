// The monthly PayPal giving JE, from the PayPal statement's Activity Summary. Laid out like the
// posted batch, line for line:
//   Cr 4012  payments received          Dr 8590  fees          Dr 1012  received less fees
//   Dr 8030 / Cr 1012  payments sent (software paid with PayPal)
//   Dr 4012 / Cr 1012  chargebacks (a donor's gift taken back)
// Zero lines are left out.

import { round2 } from '../money.js';
import { paypalTies } from '../poc/banks.js';

const GIVING = { account: '4012', sub: '000-000' };
const FEES = { account: '8590', sub: '013-000' };
const PAYPAL = { account: '1012', sub: '000-000' };
const SOFTWARE = { account: '8030', sub: '013-000' };

export const PAYPAL_JE = { description: 'Paypal Giving' };

// `b` is the attached statement (rec.bankStatements.paypal). Returns { lines, problems, notes }.
export function paypalJe(b) {
  if (b.chargeback === undefined) return { lines: [], problems: ['The PayPal statement was attached before the app read its chargebacks. Attach it again.'], notes: [] };
  const lines = [], problems = [], notes = [];
  const push = ({ account, sub }, debit, tranDescription) => {
    const v = round2(debit);
    if (v) lines.push({ account, sub, debit: v > 0 ? v : 0, credit: v < 0 ? -v : 0, tranDescription });
  };
  const received = b.received ?? b.revenue ?? 0;
  const fees = -(b.fees || 0); // printed negative
  const sent = Math.abs(b.paymentsSent || 0);
  const chargeback = -(b.chargeback || 0);
  push(GIVING, -received, 'Paypal Giving "Payments received Total"');
  push(FEES, fees, 'Paypal Giving "Fees Total"');
  push(PAYPAL, received - fees, 'Paypal Giving less Fees');
  push(SOFTWARE, sent, 'Dispute Software paid with paypal');
  push(PAYPAL, -sent, 'Dispute Software paid with paypal');
  push(GIVING, chargeback, 'Payment Refund');
  push(PAYPAL, -chargeback, 'Chargeback');

  if (sent) notes.push(`Payments sent (${sent.toFixed(2)}) are booked to 8030 Software: ${(b.sent || []).map((x) => `${x.date} ${x.desc} ${x.amount.toFixed(2)}`).join('; ') || 'see the statement'}. A refund to a donor belongs in 4012 instead: change that line after importing.`);
  const other = [['Withdrawals and Debits', b.withdrawals], ['Deposits and Credits', b.depositsCredits], ['Transfers', b.transfers]].filter(([, v]) => round2(v || 0));
  if (other.length) notes.push(`Not in this entry: ${other.map(([k, v]) => `${k} ${round2(v).toFixed(2)}`).join(', ')}. Money moved to or from our own accounts is booked by the entry on the other side.`);
  if (paypalTies(b) === false) problems.push('The statement doesn’t add up to its ending balance. Check it before booking.');
  return { lines, problems, notes };
}
