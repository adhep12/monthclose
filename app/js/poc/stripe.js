// Stripe "monthly statement" CSV (Reports → Balance → monthly summary). Months run across the
// columns; rows are grouped by section. The Stripe line is the CSV's gross payments (cards and
// other) less gross refunds. Disputes come off as their own adjustment, which makes it what the GL
// books to 4015 ("Monthly Stripe Giving": FY2026 ties to the cent every month). Fees are an
// expense (8590).
export function stripeRevenue(m) {
  if (!m) return null;
  if (m.payments == null) return m.revenue ?? null;
  return round2((m.payments || 0) + (m.refunds || 0));
}

import { round2 } from '../money.js';

function parseCsv(textIn) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < textIn.length; i++) {
    const ch = textIn[i];
    if (q) {
      if (ch === '"' && textIn[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && textIn[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function looksLikeStripeMonthly(textIn) {
  return /Monthly Activity Summary/.test(textIn) && /Payouts and Transfers Summary/.test(textIn);
}

export function parseStripeMonthly(textIn) {
  const rows = parseCsv(textIn);
  const monthRow = rows.find((r) => r[2] === 'Month (all times in UTC)');
  if (!monthRow) throw new Error('No month row in that Stripe CSV.');
  const months = monthRow.slice(3).map((d) => d.slice(0, 7));
  const partial = (rows.find((r) => r[2] === 'Partial month ending') || [])[3] || null;

  // Rows carry a section name in column B only on their first line, then labels in column C.
  const data = {};
  let section = null, top = null;
  for (const r of rows) {
    if (r[0] && !r[1] && !r[2]) { top = r[0]; section = null; continue; }
    if (r[1]) section = r[1];
    const label = r[2];
    if (!label || !top) continue;
    const key = `${top}|${r[0] && !r[1] ? r[0] : section || ''}|${label}`;
    data[key] = r.slice(3).map((v) => (v === '' ? 0 : Number(v)));
  }
  const get = (key, i) => (data[key] ? data[key][i] || 0 : 0);

  return {
    partialMonthEnding: partial,
    months: months.map((m, i) => {
      const payments = round2(get('Monthly Activity Summary|Payments (cards)|Gross Amount', i) + get('Monthly Activity Summary|Payments (other)|Gross Amount', i));
      const refunds = round2(get('Monthly Activity Summary|Refunds (cards)|Gross Amount', i) + get('Monthly Activity Summary|Refunds (other)|Gross Amount', i));
      const out = {
        month: m,
        payments,
        refunds,
        disputes: round2(get('Monthly Activity Summary|Disputes|Gross Amount', i) + get('Monthly Activity Summary|Dispute Reversals|Gross Amount', i)),
        fees: round2(['Payments (cards)', 'Refunds (cards)', 'Disputes', 'Dispute Reversals', 'Other Adjustments', 'Payments (other)', 'Refunds (other)']
          .reduce((s, sec) => s + get(`Monthly Activity Summary|${sec}|Fees`, i) + get(`Monthly Activity Summary|${sec}|Fees Returned`, i), 0)),
        otherAdjustments: get('Monthly Activity Summary|Other Adjustments|Gross Amount', i),
        payouts: get('Payouts and Transfers Summary|Payouts and Transfers|Amount', i),
        startBalance: get('Balance Summary||Start of Month Balance', i),
        endBalance: get('Balance Summary||End of Month Balance', i),
      };
      out.revenue = stripeRevenue(out);
      return out;
    }),
  };
}
