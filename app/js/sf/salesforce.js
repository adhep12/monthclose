// Salesforce giving against the GL, month by month.
//
// Salesforce records a gift on its close date, gross; the GL records it when the money is booked,
// after refunds, and sometimes in another month (a grant recognized when pledged, a gift held in a
// liability). So the two are expected to differ; the point is to say by how much each reason
// accounts for, channel by channel, and what's left unexplained.

import { cellAt, text } from '../xlsx-io.js';
import { round2, sum } from '../money.js';

export const CHANNELS = ['Stripe', 'PayPal', 'Check', 'Wire', 'Patreon', 'Cash'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const amt = (s) => { const n = Number(String(s ?? '').replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1')); return Number.isFinite(n) ? n : null; };

// The Salesforce opportunity summary report, by close date and payment method ("Opportunity Proof
// of Cash"): a row per month and method with the sum of amount and a record count.
export function parseSalesforceSummary(XLSX, wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  // Salesforce exports start at B2: find the "Close Date" header wherever it is, and read from its
  // column and row.
  let r0 = -1, c0 = -1;
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 40) && r0 < 0; r++) {
    for (let c = range.s.c; c <= Math.min(range.e.c, range.s.c + 10); c++) {
      if (/^close date/i.test(text(cellAt(XLSX, ws, r, c))) && /payment method/i.test(text(cellAt(XLSX, ws, r, c + 1)))) { r0 = r; c0 = c; break; }
    }
  }
  if (r0 < 0) throw new Error('This doesn’t look like the Salesforce opportunity summary (no “Close Date / Payment Method” header).');
  const at = (r, c) => text(cellAt(XLSX, ws, r, c0 + c));
  const rows = range.e.r, colsN = range.e.c - c0;
  const head = r0;
  const titleAt = (r) => text(cellAt(XLSX, ws, r, c0));
  const cols = {};
  for (let c = 0; c <= colsN; c++) { const t = at(head, c); if (/sum of amount/i.test(t)) cols.amount = c; if (/record count/i.test(t)) cols.count = c; }
  if (cols.amount == null) throw new Error('No “Sum of Amount” column in that report.');
  const months = {};
  let cur = null;
  for (let r = head + 1; r <= rows; r++) {
    const a = at(r, 0);
    const mm = a.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (mm && MONTHS.includes(mm[1].toLowerCase())) cur = `${mm[2]}-${String(MONTHS.indexOf(mm[1].toLowerCase()) + 1).padStart(2, '0')}`;
    else if (a) { if (/^total/i.test(a)) cur = null; continue; }
    if (!cur) continue;
    const v = amt(at(r, cols.amount));
    if (v == null) continue;
    const method = at(r, 1) || '(none)';
    const m = (months[cur] ||= { month: cur, methods: {}, total: 0, count: 0 });
    const n = cols.count != null ? Number(amt(at(r, cols.count)) || 0) : 0;
    m.methods[method] = { amount: round2((m.methods[method]?.amount || 0) + v), count: (m.methods[method]?.count || 0) + n };
    m.total = round2(m.total + v); m.count += n;
  }
  const top = []; for (let r = range.s.r; r < head; r++) { const t = titleAt(r); if (t) top.push(t); }
  const asOf = (top.join(' ').match(/As of (\d{4}-\d{2}-\d{2})/) || [])[1] || null;
  const filters = top.filter((t) => /Date Field|Opportunity|Show:|Probability/i.test(t) && !/^Opportunity Proof/i.test(t) && t !== top[0]);
  if (!Object.keys(months).length) throw new Error('No months found in that report.');
  return { title: top[0] || '', asOf, filters, months: Object.values(months).sort((x, y) => x.month.localeCompare(y.month)) };
}

// Salesforce's payment methods, in the GL's channels (anything else is counted as its own).
export const channelOf = (method) => ({ stripe: 'Stripe', paypal: 'PayPal', check: 'Check', wire: 'Wire', patreon: 'Patreon', cash: 'Cash' }[String(method).toLowerCase()] || 'Other');

// One month. sf: parseSalesforceSummary's month. giving: the GL register's p.giving (gl.js).
// found: what else the proof of cash knows about the month —
//   priorPeriod: deposits the GL booked to a receivable (revenue recognized in an earlier month)
//   noCash:      GL revenue with no cash this month (a grant recognized when pledged, a gift moved
//                to a liability), with the accounts on its other side
//   releases:    revenue released from a liability inside a deposit (Dr 2052)
export function reconcileMonth({ sf, giving, found = {} }) {
  const sfBy = {}, sfCount = {};
  for (const [method, x] of Object.entries(sf?.methods || {})) { const ch = channelOf(method); sfBy[ch] = round2((sfBy[ch] || 0) + x.amount); sfCount[ch] = (sfCount[ch] || 0) + (x.count || 0); }
  const glBy = { ...(giving?.channels || {}) };
  const chans = [...new Set([...CHANNELS, ...Object.keys(sfBy), ...Object.keys(glBy)])];
  const rows = chans.map((ch) => ({ channel: ch, sf: sfBy[ch] ?? 0, count: sfCount[ch] || 0, gl: glBy[ch] ?? 0, diff: round2((sfBy[ch] ?? 0) - (glBy[ch] ?? 0)) }))
    .filter((r) => r.sf || r.gl);
  const sfTotal = round2(sum(rows, (r) => r.sf)), glTotal = round2(sum(rows, (r) => r.gl));
  const diff = round2(sfTotal - glTotal);

  // Reasons, each with the amount it explains (in Salesforce − GL terms) and its channel.
  const reasons = [];
  const add = (channel, amount, what, why, source, evidence = 'gl') => { if (Math.abs(amount) >= 0.005 || evidence === 'flag') reasons.push({ channel, amount: round2(amount), what, why, source, evidence, flag: evidence === 'flag' }); };
  // Stripe: Salesforce keeps a refunded or disputed gift; the GL takes it off revenue.
  const st = giving?.stripe || {};
  const refunds = -sum(Object.entries(st).filter(([k]) => /refund/i.test(k)), ([, v]) => v);
  const disputes = -sum(Object.entries(st).filter(([k]) => /dispute/i.test(k)), ([, v]) => v);
  add('Stripe', refunds, 'Stripe refunds', 'Salesforce keeps a refunded gift at its full amount; the GL takes the refund off Stripe revenue.', 'GL “Monthly Stripe Giving”: Refunds CC / Wire Refunds Gross Amount');
  add('Stripe', disputes, 'Stripe disputes', 'Salesforce keeps a disputed gift; the GL takes the dispute off revenue.', 'GL “Monthly Stripe Giving”: Dispute Gross Amount');
  // Money received now for revenue the GL recognized earlier (a pledge or grant receivable).
  for (const x of found.priorPeriod || []) add(x.channel, x.amount, `Received now, recognized by the GL earlier: ${x.desc}`, 'The GL recognized this when it was pledged or granted (a receivable); Salesforce records it when it’s paid.', x.source);
  // GL revenue with no cash this month.
  for (const x of found.noCash || []) add(x.channel || 'Wire', -x.amount, `${x.amount > 0 ? 'Recognized by the GL with no cash this month' : 'Taken out of revenue by the GL with no cash'}: ${x.desc}`,
    x.amount > 0 ? 'The GL booked revenue now (a pledge, a grant receivable, a gift released from a liability) that Salesforce records when it’s paid, or recorded already.' : 'The GL moved a gift out of revenue (to a liability, or reversed it); Salesforce still has it.', x.source);
  for (const x of found.releases || []) add(x.channel || 'Wire', -x.amount, `Released from a liability by the GL: ${x.desc}`, 'Part of this deposit’s revenue was a gift the GL had held back earlier; Salesforce recorded it when it was given.', x.source);
  // A GL channel far above what Salesforce has for it: likely a line booked to the wrong payer.
  for (const r of rows) {
    if (r.gl > 5000 && r.sf >= 0 && r.gl > 5 * Math.max(r.sf, 1)) {
      const lines = (giving?.big?.[r.channel] || []).slice(0, 3);
      add(r.channel, 0, `The GL has far more ${r.channel} than Salesforce`, `GL ${r.channel} ${r.gl.toFixed(2)} against Salesforce ${r.sf.toFixed(2)}. Largest GL lines: ${lines.map((l) => `${l.batch} ${l.payer} ${l.amount.toFixed(2)}`).join('; ') || '—'}. Check who the payer on those lines really is.`, 'GL lines', 'flag');
    }
  }
  const byChannel = {};
  for (const r of rows) {
    const ex = round2(sum(reasons.filter((x) => x.channel === r.channel), (x) => x.amount));
    byChannel[r.channel] = { ...r, explained: ex, unexplained: round2(r.diff - ex) };
  }
  const explained = round2(sum(reasons, (x) => x.amount));
  const unexplained = round2(diff - explained);
  return { month: sf?.month || null, sfTotal, glTotal, diff, pct: glTotal ? diff / glTotal : null, rows: Object.values(byChannel), reasons: reasons.filter((x) => x.amount || x.flag), explained, unexplained,
    explainedShare: diff ? Math.max(0, Math.min(1, 1 - Math.abs(unexplained) / Math.abs(diff))) : 1, restricted: giving?.restricted || [] };
}

// Every month at once: each month reconciled, then what's left in a channel one month that the next
// month's leftover cancels (within 10%) is month-end timing — a gift Salesforce dates one side of the
// month end and the GL the other (Stripe's day ends at midnight UTC, Salesforce's at midnight
// Pacific: year-end giving on the evening of 12/31 is December in Salesforce, January in Stripe).
export function reconcileYear(inputs) {
  const out = inputs.map(reconcileMonth);
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i], b = out[i + 1];
    if (!a.month || !b.month) continue;
    for (const ra of a.rows) {
      const rb = b.rows.find((x) => x.channel === ra.channel);
      if (!rb) continue;
      const x = ra.unexplained, y = rb.unexplained;
      if (Math.sign(x) === Math.sign(y) || Math.min(Math.abs(x), Math.abs(y)) < 1000 || Math.abs(x + y) > 0.1 * Math.max(Math.abs(x), Math.abs(y))) continue;
      const why = `${ra.channel} left unexplained in ${a.month} (${x.toFixed(2)}) and ${b.month} (${y.toFixed(2)}) cancel out: gifts on one side of the month end in Salesforce and the other in the GL.${ra.channel === 'Stripe' ? ' Stripe’s day ends at midnight UTC, Salesforce’s at midnight Pacific.' : ''}`;
      for (const [m, r, v, other] of [[a, ra, x, b.month], [b, rb, y, a.month]]) {
        m.reasons.push({ channel: r.channel, amount: round2(v), what: `Month-end timing with ${other}`, why, source: 'Salesforce and GL, both months', evidence: 'pattern' });
        r.explained = round2(r.explained + v); r.unexplained = round2(r.unexplained - v);
      }
    }
  }
  for (const m of out) {
    m.explained = round2(sum(m.reasons, (x) => x.amount)); m.unexplained = round2(m.diff - m.explained);
    m.explainedShare = m.diff ? Math.max(0, Math.min(1, 1 - Math.abs(m.unexplained) / Math.abs(m.diff))) : 1;
  }
  return out;
}
