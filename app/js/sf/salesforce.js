// Salesforce giving against the GL, month by month.
//
// Salesforce records a gift on its close date, gross; the GL records it when the money is booked,
// after refunds, and sometimes in another month (a grant recognized when pledged, a gift held in a
// liability). So the two are expected to differ; the point is to say by how much each reason
// accounts for, channel by channel, and what's left unexplained.

import { cellAt, text, isoDate } from '../xlsx-io.js';
import { round2, sum } from '../money.js';

export const CHANNELS = ['Stripe', 'PayPal', 'Check', 'Wire', 'Patreon', 'Cash'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const money2 = (v) => (v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthsBetween = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
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

// ---- Which months a report covers ------------------------------------------------------------
// From its date filter ("Date Field: Close Date equals Custom (10/1/2025 to 12/31/2025)"): every
// month the range touches, up to the month the report was run (a "Current FY" report doesn't cover
// the months still to come). A month the range only partly covers is listed in `partial`. Null when
// the filter has no dates ("Last Quarter"): then only the months with gifts in them are known.
const mdY = (s) => { const [m, d, y] = s.split('/').map(Number); return { y: y < 100 ? 2000 + y : y, m, d }; };
const ym = (x) => `${x.y}-${String(x.m).padStart(2, '0')}`;
const lastDay = (x) => new Date(Date.UTC(x.y, x.m, 0)).getUTCDate();
export function coveredMonths(filters = [], asOf = null) {
  const f = filters.find((t) => /Close Date/i.test(t) && /\d{1,2}\/\d{1,2}\/\d{2,4}\s+to\s+\d{1,2}\/\d{1,2}\/\d{2,4}/.test(t));
  if (!f) return null;
  const [, a, b] = f.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s+to\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  const from = mdY(a), to = mdY(b);
  const stop = asOf && asOf.slice(0, 7) < ym(to) ? asOf.slice(0, 7) : ym(to);
  const months = [], partial = [];
  for (let y = from.y, m = from.m; `${y}-${String(m).padStart(2, '0')}` <= stop; m === 12 ? (y++, m = 1) : m++) months.push(`${y}-${String(m).padStart(2, '0')}`);
  if (from.d > 1) partial.push(ym(from));
  if (to.d < lastDay(to) && ym(to) <= stop && !partial.includes(ym(to))) partial.push(ym(to));
  return { months, partial, from: a, to: b };
}

// What a report leaves out that the GL still has in it: "Stripe Transaction Status not equal to
// Disputed,Refunded,…" means refunded and disputed Stripe gifts aren't in Salesforce's figures, so
// the GL's Stripe refunds and disputes don't explain a difference.
export function reportExcludes(filters = []) {
  const f = filters.find((t) => /Stripe Transaction Status not equal to/i.test(t)) || '';
  return { refunds: /\brefunded\b/i.test(f), disputes: /\bdisputed\b/i.test(f) };
}

// A report's title, "As of" date and filter lines: the text above its header row.
function reportHead(XLSX, ws, head, col) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  const top = [];
  for (let r = range.s.r; r < head; r++) for (let c = range.s.c; c <= Math.min(range.e.c, col + 3); c++) { const t = text(cellAt(XLSX, ws, r, c)); if (t) { top.push(t); break; } }
  const asOf = (top.join(' ').match(/As of (\d{4}-\d{2}-\d{2})/) || [])[1] || null;
  const filters = top.slice(1).filter((t) => !/^As of |^Filtered By$/i.test(t));
  return { title: top[0] || '', asOf, filters };
}

// The gift-level opportunity report (one row per gift: Amount, Close Date, Payment Method, and
// Donor-Advised, primary contact, card transaction id when it has them), totalled the way the
// summary report is: by month and payment method. Check and wire gifts are kept, compact
// ([date, amount, donor-advised fund, contact id]), for matching gifts to the GL later.
export function parseSalesforceGifts(XLSX, wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  let head = -1; const col = {};
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 60) && head < 0; r++) {
    const names = {};
    for (let c = range.s.c; c <= range.e.c; c++) { const t = text(cellAt(XLSX, ws, r, c)).replace(/\s*[↑↓]\s*$/, ''); if (t) names[t.toLowerCase()] = c; }
    if ('amount' in names && 'close date' in names && 'payment method' in names) {
      head = r;
      col.amount = names.amount; col.date = names['close date']; col.method = names['payment method'];
      col.daf = names['donor-advised']; col.contact = names['18 char id primary contact'];
    }
  }
  if (head < 0) throw new Error('This doesn’t look like a Salesforce opportunity report (no “Amount”, “Close Date” and “Payment Method” columns).');
  const months = {};
  for (let r = head + 1; r <= range.e.r; r++) {
    const date = isoDate(cellAt(XLSX, ws, r, col.date));
    const cell = cellAt(XLSX, ws, r, col.amount);
    const v = typeof cell?.v === 'number' ? cell.v : amt(cell?.v);
    if (!date || v == null) continue; // the report's total and footer lines
    const method = text(cellAt(XLSX, ws, r, col.method)) || '(none)';
    const m = (months[date.slice(0, 7)] ||= { month: date.slice(0, 7), methods: {}, total: 0, count: 0, gifts: [] });
    const x = (m.methods[method] ||= { amount: 0, count: 0 });
    x.amount += v; x.count++; m.total += v; m.count++;
    if (/^(check|wire)$/i.test(method)) m.gifts.push([date, round2(v), col.daf != null ? text(cellAt(XLSX, ws, r, col.daf)) : '', col.contact != null ? text(cellAt(XLSX, ws, r, col.contact)) : '', method[0].toUpperCase()]);
  }
  for (const m of Object.values(months)) {
    m.total = round2(m.total);
    for (const x of Object.values(m.methods)) x.amount = round2(x.amount);
  }
  if (!Object.keys(months).length) throw new Error('No gifts found in that report.');
  return { kind: 'gifts', ...reportHead(XLSX, ws, head, col.amount), months: Object.values(months).sort((x, y) => x.month.localeCompare(y.month)) };
}

// Either Salesforce report — the summary by month and payment method, or the gift-level one — with
// the months it covers (so an upload replaces exactly those) and what it leaves out.
export function parseSalesforceReport(XLSX, wb) {
  let res;
  try { res = { kind: 'summary', ...parseSalesforceSummary(XLSX, wb) }; } catch (err) {
    if (!/no “Close Date \/ Payment Method” header/.test(err.message)) throw err;
    res = parseSalesforceGifts(XLSX, wb);
  }
  const cover = coveredMonths(res.filters, res.asOf);
  const found = res.months.map((x) => x.month);
  const months = cover ? [...new Set([...cover.months, ...found])].sort() : found;
  const byMonth = Object.fromEntries(res.months.map((x) => [x.month, x]));
  // A month the report covers with no gifts in it had none: it's saved as zero, replacing any earlier upload.
  res.months = months.map((m) => byMonth[m] || { month: m, methods: {}, total: 0, count: 0, ...(res.kind === 'gifts' ? { gifts: [] } : {}) });
  return { ...res, covered: cover, excludes: reportExcludes(res.filters) };
}

// Salesforce's payment methods, in the GL's channels (anything else is counted as its own).
export const channelOf = (method) => ({ stripe: 'Stripe', paypal: 'PayPal', check: 'Check', wire: 'Wire', patreon: 'Patreon', cash: 'Cash' }[String(method).toLowerCase()] || 'Other');

// What a person can say a difference is, when they explain it themselves.
export const SF_ADJ_TYPES = {
  timing: 'Timing: the other side has it in another month',
  restricted: 'Restricted gift',
  agency: 'Agency / pass-through gift',
  'not-received': 'In Salesforce, money not received',
  'not-in-sf': 'In the GL, not in Salesforce',
  'prior-period': 'Belongs to an earlier or later period',
  channel: 'Recorded under a different giving type',
  other: 'Other',
};

// ---- Who a gift came from -------------------------------------------------------------------
// Salesforce names a wire's donor-advised fund ("National Christian Foundation"); the GL line names
// who paid ("NCF"). The same sponsor, one name, on both sides. Names not listed stay as they are.
const SPONSORS = [
  [/national christian|^ncf\b/i, 'NCF'], [/^fidelity(?! giving marketplace)/i, 'Fidelity'], [/great commission/i, 'Great Commission Foundation'],
  [/stewardship/i, 'Stewardship'], [/benevity|benvity|online giving/i, 'Benevity'], [/overflow/i, 'Overflow'], [/signatry/i, 'Signatry'],
  [/renaissance|\(ren\)/i, 'Renaissance'], [/morgan stanley/i, 'Morgan Stanley'], [/u\.?s\.? charitable/i, 'US Charitable'],
  [/american endowment|^aef\b/i, 'AEF'], [/giveclear/i, 'GiveClear'], [/murdock/i, 'MJ Murdock'], [/thrivent/i, 'Thrivent'],
  [/patreon/i, 'Patreon'],
];
export const sponsorOf = (name) => { const n = String(name || '').trim(); return (SPONSORS.find(([re]) => re.test(n)) || [, n || '(none)'])[1]; };
// Platforms that collect gifts from many donors and pay them to us in lumps, months apart:
// Salesforce records each donor's gift when it's made, the GL the payout when it arrives.
// (Patreon is its own channel; the others are wires.)
export const LUMP_PLATFORMS = ['Great Commission Foundation', 'Stewardship', 'Patreon'];
const LUMP_GAP = 6; // months without a payout before it's worth asking why

// A month's wire gifts by sponsor: Salesforce from the gift-level report's kept gifts, the GL from
// its payers (gl.js). Null on a side that doesn't have them (a summary report, an older GL upload).
function sponsorsSf(sf) {
  if (!Array.isArray(sf?.gifts)) return null;
  const o = {};
  for (const g of sf.gifts) if (g[4] === 'W') { const k = sponsorOf(g[2]); o[k] = round2((o[k] || 0) + g[1]); }
  return o;
}
function sponsorsGl(giving) {
  if (!giving?.payers) return null;
  const o = {};
  for (const [who, v] of Object.entries(giving.payers.Wire || {})) { const k = sponsorOf(who); o[k] = round2((o[k] || 0) + v); }
  return o;
}

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
  // (Unless the report already leaves refunded and disputed gifts out: then Salesforce agrees with the GL there.)
  if (!sf?.excludes?.refunds) add('Stripe', refunds, 'Stripe refunds', 'Salesforce keeps a refunded gift at its full amount; the GL takes the refund off Stripe revenue.', 'GL “Monthly Stripe Giving”: Refunds CC / Wire Refunds Gross Amount');
  if (!sf?.excludes?.disputes) add('Stripe', disputes, 'Stripe disputes', 'Salesforce keeps a disputed gift; the GL takes the dispute off revenue.', 'GL “Monthly Stripe Giving”: Dispute Gross Amount');
  // Money received now for revenue the GL recognized earlier (a pledge or grant receivable).
  for (const x of found.priorPeriod || []) add(x.channel, x.amount, `Received now, recognized by the GL earlier: ${x.desc}`, 'The GL recognized this when it was pledged or granted (a grant / pledge receivable, 1220); Salesforce records it when it’s paid.', x.source);
  // GL revenue with no cash this month.
  for (const x of found.noCash || []) add(x.channel || 'Wire', -x.amount, `${x.amount > 0 ? 'Recognized by the GL with no cash this month' : 'Taken out of revenue by the GL with no cash'}: ${x.desc}`,
    x.amount > 0 ? 'The GL booked revenue now (a pledge, a grant receivable, a gift released from a liability) that Salesforce records when it’s paid, or recorded already.' : 'The GL moved a gift out of revenue (to a liability, or reversed it); Salesforce still has it.', x.source);
  // Revenue the GL took back out after booking it (moved to agency as a pass-through gift, reversed,
  // a chargeback): Salesforce still has the gift.
  for (const x of found.reversals || []) add(x.channel || 'Check', x.amount, `Taken back out of revenue by the GL: ${x.desc}`, 'The GL booked this as a gift, then took it back out (to agency as a pass-through gift, a reversal or a returned item); Salesforce still has it as a gift.', x.source);
  // Explanations a person entered for the month (kept on the Salesforce month, sf.adjustments).
  for (const x of sf?.adjustments || []) {
    if (!x.amount) continue;
    reasons.push({ channel: x.channel, amount: round2(x.amount), what: `${SF_ADJ_TYPES[x.type] || x.type}${x.sponsor ? ` (${x.sponsor})` : ''}${x.note ? `: ${x.note}` : ''}`,
      why: `Entered by ${x.by || 'someone'}${x.at ? ` on ${String(x.at).slice(0, 10)}` : ''}.`, source: 'Typed', evidence: 'typed', id: x.id });
  }
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
  const give = (m, channel, amount, what, why, source, evidence = 'pattern') => {
    if (Math.abs(amount) < 0.005 && evidence !== 'flag') return;
    const r = m.rows.find((x) => x.channel === channel);
    m.reasons.push({ channel, amount: round2(amount), what, why, source, evidence, flag: evidence === 'flag' });
    if (r && evidence !== 'flag') { r.explained = round2(r.explained + amount); r.unexplained = round2(r.unexplained - amount); }
  };
  const sfSp = inputs.map((x) => sponsorsSf(x.sf)), glSp = inputs.map((x) => sponsorsGl(x.giving));
  const both = (i) => sfSp[i] && glSp[i];
  // Platforms that pay in lumps: a running balance of what Salesforce has recorded and the GL hasn't
  // received yet. While it's owed to us the difference is timing; a payout brings it down. A payout
  // bigger than what's owed pays for gifts from before these months (Patreon's first withdrawal,
  // February 2026, cleared a balance built up before this year).
  for (const p of LUMP_PLATFORMS) {
    const channel = p === 'Patreon' ? 'Patreon' : 'Wire';
    let bal = 0, lastPaid = null;
    out.forEach((m, i) => {
      const sfv = channel === 'Patreon' ? m.rows.find((x) => x.channel === 'Patreon')?.sf ?? 0 : both(i) ? sfSp[i][p] || 0 : null;
      const glv = channel === 'Patreon' ? m.rows.find((x) => x.channel === 'Patreon')?.gl ?? 0 : both(i) ? glSp[i][p] || 0 : null;
      if (sfv == null || !m.month || (!sfv && !glv && !bal)) return;
      if (glv) lastPaid = m.month;
      const d = round2(sfv - glv);
      let owed = d, before = 0;
      if (bal + d < 0) { before = round2(bal + d); owed = round2(-bal); }
      bal = round2(Math.max(0, bal + d));
      if (owed > 0) give(m, channel, owed, `${p}: gifts not paid out to us yet`, `${p} collects gifts from many donors and pays them to us in lumps. Salesforce records each gift when it’s made; the GL records the payout. ${money2(bal)} recorded in Salesforce is waiting to be paid out at the end of the month.`, `Salesforce ${money2(sfv)}, GL ${money2(glv)}`);
      else if (owed < 0) give(m, channel, owed, `${p}: payout for gifts in earlier months`, `The GL booked a ${p} payout of ${money2(glv)}, paying for gifts Salesforce recorded in earlier months. ${money2(bal)} still to be paid out.`, `Salesforce ${money2(sfv)}, GL ${money2(glv)}`);
      if (before <= -100) give(m, channel, before, `${p}: payout for gifts from before these months`, `The payout is more than Salesforce has recorded since the months here began, so ${money2(-before)} of it is for gifts given before then (recognized in the GL only when paid out).`, `Salesforce ${money2(sfv)}, GL ${money2(glv)}`);
      const since = lastPaid ? monthsBetween(lastPaid, m.month) : i + 1;
      if (i === out.length - 1 && bal >= 5000 && since >= LUMP_GAP) give(m, channel, 0, `${p}: no payout for ${since} months`, `${money2(bal)} recorded in Salesforce hasn’t been paid out to us${lastPaid ? ` since the payout in ${lastPaid}` : ''}. Check with ${p} when the next payout is due.`, 'Salesforce and GL', 'flag');
    });
  }
  // The other wire sponsors: what one sponsor leaves one month and cancels (within 10%) in the next
  // month or the one after is timing on that sponsor (Benevity's year-end gifts, say).
  const spNames = [...new Set(sfSp.concat(glSp).filter(Boolean).flatMap((o) => Object.keys(o)))].filter((n) => !LUMP_PLATFORMS.includes(n) && n !== '(none)');
  for (const n of spNames) {
    const left = out.map((m, i) => (both(i) ? round2((sfSp[i][n] || 0) - (glSp[i][n] || 0)) : null));
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j <= Math.min(i + 2, out.length - 1); j++) {
        const x = left[i], y = left[j];
        if (x == null || y == null || Math.sign(x) === Math.sign(y) || Math.min(Math.abs(x), Math.abs(y)) < 1000 || Math.abs(x + y) > 0.1 * Math.max(Math.abs(x), Math.abs(y))) continue;
        const why = `${n} gifts, Salesforce minus GL: ${money2(x)} in ${out[i].month} and ${money2(y)} in ${out[j].month}, which cancel out — the same gifts dated one side of the month end in Salesforce and the other in the GL.`;
        give(out[i], 'Wire', x, `${n}: timing with ${out[j].month}`, why, `Salesforce and GL, ${n}`);
        give(out[j], 'Wire', y, `${n}: timing with ${out[i].month}`, why, `Salesforce and GL, ${n}`);
        left[i] = 0; left[j] = 0; break;
      }
    }
  }
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
  // Running totals from the first month: each giving type, and each wire sponsor, Salesforce against
  // the GL. A lump payout (Patreon's February) reads against everything Salesforce had built up.
  const run = { channels: {}, sponsors: {} };
  out.forEach((m, i) => {
    for (const r of m.rows) { const x = (run.channels[r.channel] ||= { sf: 0, gl: 0 }); x.sf = round2(x.sf + r.sf); x.gl = round2(x.gl + r.gl); }
    if (both(i)) for (const n of new Set([...Object.keys(sfSp[i]), ...Object.keys(glSp[i])])) { const x = (run.sponsors[n] ||= { sf: 0, gl: 0 }); x.sf = round2(x.sf + (sfSp[i][n] || 0)); x.gl = round2(x.gl + (glSp[i][n] || 0)); }
    m.toDate = { from: out[0].month, channels: structuredClone(run.channels), sponsors: both(i) ? structuredClone(run.sponsors) : null,
      thisMonth: both(i) ? { sf: sfSp[i], gl: glSp[i] } : null };
  });
  for (const m of out) {
    m.explained = round2(sum(m.reasons, (x) => x.amount)); m.unexplained = round2(m.diff - m.explained);
    m.explainedShare = m.diff ? Math.max(0, Math.min(1, 1 - Math.abs(m.unexplained) / Math.abs(m.diff))) : 1;
  }
  return out;
}
