// Acumatica "GL Register Detailed" export → net activity per account per month.
//
// The report is batch-grouped: a header row per batch (period like '10-2026', module, batch #,
// date, status, description), then one row per line (customer/vendor, account, subaccount, …,
// identifier like 'GL GL018616 3', debit, credit), then a "Batch Total" row.

import { cellAt, text, num, isoDate } from './xlsx-io.js';
import { fromPeriod } from './fiscal.js';
import { round2 } from './money.js';

export function parseGlRegister(XLSX, wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const at = (r, c) => cellAt(XLSX, ws, r, c);
  if (!/GL Register/i.test(text(at(0, 0)))) throw new Error('This doesn’t look like a GL Register Detailed export.');

  const periods = {};
  let period = null, module = null, batch = null, lines = 0;
  for (let r = range.s.r; r <= range.e.r; r++) {
    const a = text(at(r, 0));
    if (/^\d{2}-\d{4}$/.test(a)) {
      period = a; module = text(at(r, 1));
      batch = { batch: text(at(r, 2)), module, date: isoDate(at(r, 3)), desc: text(at(r, 5)), status: text(at(r, 4)), by: text(at(r, 6)), mod: text(at(r, 7)), accounts: {}, refunds: 0, lines: [] };
      const m = fromPeriod(period);
      (periods[m] || (periods[m] = { month: m, period, accounts: {}, lines: 0, batches: [] })).batches.push(batch);
      continue;
    }
    const ident = text(at(r, 7));
    if (!period || !module || !ident.startsWith(`${module} `)) continue;
    const acct = text(at(r, 1));
    if (!/^\d{4}$/.test(acct)) continue;
    const net = (num(at(r, 8)) || 0) - (num(at(r, 9)) || 0);
    const m = fromPeriod(period);
    const p = periods[m];
    p.accounts[acct] = (p.accounts[acct] || 0) + net;
    batch.accounts[acct] = (batch.accounts[acct] || 0) + net;
    // Each line keeps Acumatica's identifier ("GL GL017661 2": module, batch, line), unique across
    // the ledger, and who it names — the payer on a gift line ("Fidelity", customer FIDEC001).
    batch.lines.push({ id: ident, a: acct, cv: text(at(r, 0)), d: text(at(r, 5)), ref: text(at(r, 4)), amt: round2(net) });
    const grant = grantOf(text(at(r, 2)));
    if (GIVING.includes(acct)) (p.givingLines ||= []).push({ batch, id: ident, a: acct, cv: text(at(r, 0)), d: text(at(r, 5)), amt: round2(-net), grant });
    addGrantActivity((p.grants ||= { gifts: {}, spend: {} }), acct, grant, net);
    // PayPal gifts given back ("Payment Refund", a debit to 4012) inside the month's PayPal batch.
    // (A whole batch reversed out of the wrong period also debits 4012, but it isn't money given back.)
    if (acct === '4012' && net > 0 && /refund/i.test(text(at(r, 5)))) batch.refunds += net;
    p.lines++;
    lines++;
  }
  for (const p of Object.values(periods)) {
    for (const k of Object.keys(p.accounts)) p.accounts[k] = round2(p.accounts[k]);
    p.receipts = cashReceipts(p.batches);
    p.keyReceipts = cashReceipts(p.batches, KEYBANK_GL);
    p.wiseReceipts = cashReceipts(p.batches, WISE_GL);
    p.paypalRefunds = p.batches.filter((b) => b.refunds >= 0.005 && PAYPAL_GL in b.accounts)
      .map((b) => ({ batch: b.batch, date: b.date, desc: b.desc.slice(0, 120), amount: round2(b.refunds) }));
    p.noCashRevenue = noCashRevenue(p.batches);
    p.noCashInterest = noCashInterest(p.batches);
    p.stripeReclass = stripeReclasses(p.batches);
    p.investmentFees = investmentFees(p.batches);
    p.investmentGl = investmentGl(p.batches);
    p.largeMerch = largeMerch(p.batches);
    p.giving = givingByChannel(p.givingLines || []);
    p.grants = roundGrants(p.grants || { gifts: {}, spend: {} });
    delete p.givingLines;
    // Every batch in the month, by Acumatica's batch number, so the next upload can say what was
    // added, changed or removed since.
    p.index = Object.fromEntries(p.batches.map((b) => [b.batch, { fp: fingerprint(b.lines), total: round2(b.lines.reduce((t, l) => t + Math.max(l.amt, 0), 0)), desc: b.desc.slice(0, 80), date: b.date, status: b.status }]));
    delete p.batches;
  }
  if (!lines) throw new Error('No journal lines found in that file.');
  const header = (label) => {
    for (let r = 0; r < 6; r++) for (let c = 0; c < 10; c++) if (new RegExp(`^${label}`, 'i').test(text(at(r, c)))) return text(at(r, c + 1));
    return null;
  };
  return { periods: Object.values(periods).sort((x, y) => x.month.localeCompare(y.month)), lines,
    runAt: header('Date:'), fromPeriod: header('From Period:'), toPeriod: header('To Period:') };
}

// Merch and inventory lines of $10,000 or more (accounts 9000–9099, 1500–1509): a merch order
// of $15,000 or more is inventory, not an expense, so the inventory page lists them.
const LARGE_MERCH = 10000;
function largeMerch(batches) {
  const out = [];
  for (const b of batches) for (const l of b.lines) {
    const n = Number(l.a);
    if (((n >= 9000 && n <= 9099) || (n >= 1500 && n <= 1509)) && Math.abs(l.amt) >= LARGE_MERCH) out.push({ batch: b.batch, date: b.date, account: l.a, desc: (l.d || b.desc).slice(0, 80), amount: l.amt });
  }
  return out;
}

// Restricted giving and what it pays for, by grant (the second part of the subaccount: 005-627 is
// department 005, grant 627 Portuguese Video). Gifts are Translation Support (4017), credits less
// debits; spending is expense lines (accounts 5000 and up) on any grant but 000, debits less
// credits. The restricted funds schedule (restricted/funds.js) works from these.
//   grants: { gifts: { '627': 103000, '000': 20000 }, spend: { '627': 185739.12, '131': 4210 } }
export const RESTRICTED_GIFTS = '4017';
export function grantOf(sub) {
  const m = String(sub || '').match(/^\d{3}-(\d{3})$/);
  return m ? m[1] : '000';
}
function addGrantActivity(g, acct, grant, net) {
  if (acct === RESTRICTED_GIFTS) g.gifts[grant] = (g.gifts[grant] || 0) - net;
  else if (/^[5-9]/.test(acct) && grant !== '000') g.spend[grant] = (g.spend[grant] || 0) + net;
}
function roundGrants(g) {
  const r = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round2(v)]).filter(([, v]) => v));
  return { gifts: r(g.gifts), spend: r(g.spend) };
}

// Money into and out of Cass (1100) batch by batch, so deposits on the statements can be matched to
// how the GL booked them. Each batch keeps the accounts on its other side, net credit positive
// (what the deposit was booked to). AP batches that debit cash are mostly voided checks, which
// never reach a statement, but some are money paid back to us (a vendor refund); they're kept,
// marked, and only used when a deposit matches them.
//   { batch, date, desc, amount, accounts: { '4018': 12425 } }   amount > 0: money in
//                                                                amount < 0: money out, e.g. a
//                                                                reversal of revenue (chargeback)
export const CASS_GL = '1100';
export const KEYBANK_GL = '1061';
export const WISE_GL = '1013';
export const PAYPAL_GL = '1012';
// Accounts where revenue arrives as cash: a revenue entry with none of these on its other side
// had no cash this month (a sale on account, a gift reclassed to a liability).
const CASH_SIDE = ['1100', '1110', '1111', '1012', '1013', '1015', '1200', '1020', '1060', '1061', '2041'];
function cashReceipts(batches, cashGl = CASS_GL) {
  const out = [];
  for (const b of batches) {
    const cash = round2(b.accounts[cashGl] || 0);
    if (!cash) continue;
    const other = {};
    for (const [acct, net] of Object.entries(b.accounts)) if (acct !== cashGl && Math.abs(net) >= 0.005) other[acct] = round2(-net);
    // Only money in, and money out that takes revenue back (a chargeback, a deposit reclassed).
    if (cash < 0 && !Object.entries(other).some(([acct, v]) => /^4/.test(acct) && v < 0)) continue;
    out.push({ batch: b.batch, date: b.date, desc: b.desc.slice(0, 120), amount: cash, accounts: other, ...(b.module === 'AP' ? { ap: true } : {}),
      module: b.module, status: b.status, by: b.by, mod: b.mod, lines: b.lines, fp: fingerprint(b.lines) });
  }
  return out;
}

// Giving (gifts, not merchandise, royalties or card rewards) by the channel Salesforce records it
// under, for reconciling the GL to Salesforce: Stripe (4015), PayPal (4012, and PayPal Giving Fund
// grants — "PayPal Grant" lines in 4018), Patreon, Cash (KeyBank), Check (4010 deposits) and Wire
// (4018: DAF gifts, wires). Restricted gifts (4017) are counted in the channel they came in by and
// listed. Each channel keeps its large lines so a difference can be traced to gifts.
export const GIVING = ['4010', '4012', '4015', '4017', '4018'];
export function givingChannel(l) {
  const b = l.batch;
  if (b.accounts[KEYBANK_GL] || b.lines.some((x) => x.a === KEYBANK_GL)) return 'Cash';
  if (l.a === '4015') return 'Stripe';
  // A check booked to PayPal revenue ("Check - … BP receiving check", March 2026) is a check.
  if (l.a === '4012' && /^check\b|receiving check/i.test(l.d)) return 'Check';
  if (l.a === '4012' || /paypal/i.test(l.d) || /^PAYP/i.test(l.cv)) return 'PayPal';
  // (Check deposits are to customer PATROC001 — patrons, not Patreon.)
  if (/patreon/i.test(l.d)) return 'Patreon';
  if (l.a === '4010' || (l.a === '4017' && (bankDated(b.desc) || /\bdeposits?\b/i.test(b.desc)))) return 'Check';
  return 'Wire';
}
const bankDated = (d) => /\d{1,2}\.\d{1,2}\.\d{4}/.test(String(d || ''));
function givingByChannel(lines) {
  const channels = {}, big = {}, restricted = [], stripe = {}, payers = {}, wireLines = [];
  for (const l of lines) {
    const ch = givingChannel(l);
    channels[ch] = round2((channels[ch] || 0) + l.amt);
    // Who paid, as the GL line names them (NCF, Fidelity, Great Commission Foundation), for matching
    // Salesforce's donor-advised funds sponsor by sponsor. Check deposits name no one.
    if (ch === 'Wire' || ch === 'Patreon') { const who = String(l.d || l.cv).replace(/^Wise Donation - /i, '').slice(0, 60); (payers[ch] ||= {})[who] = round2((payers[ch][who] || 0) + l.amt); }
    // Each wire line of 1,000 or more, for finding the Salesforce gift it pays: [date, amount, payer, batch].
    if (ch === 'Wire' && l.amt >= 1000) wireLines.push([l.batch.date, round2(l.amt), String(l.d || l.cv).replace(/^Wise Donation - /i, '').slice(0, 60), l.batch.batch]);
    const line = { batch: l.batch.batch, date: l.batch.date, desc: l.batch.desc.slice(0, 50), line: l.id, payer: String(l.d).slice(0, 40), acct: l.a, amount: l.amt };
    if (l.a === '4017') restricted.push({ ...line, channel: ch, grant: l.grant });
    if (ch === 'Stripe') { const k = String(l.d).replace(/^\d+\s+/, '') || l.batch.desc; stripe[k] = round2((stripe[k] || 0) + l.amt); }
    else if (Math.abs(l.amt) >= 1000) (big[ch] ||= []).push(line);
  }
  for (const ch of Object.keys(big)) big[ch] = big[ch].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 40);
  return { channels, total: round2(Object.values(channels).reduce((a, b) => a + b, 0)), restricted, stripe, big, payers, wireLines };
}

// What a batch is, line for line: changes if any line's account or amount changes, or a line is
// added or removed — so a later upload can tell a batch someone edited in Acumatica.
export function fingerprint(lines) {
  const s = (lines || []).map((l) => `${l.id}:${l.a}:${l.amt}`).sort().join('|');
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${(lines || []).length}-${h.toString(16)}`;
}

// Revenue entries with no cash on the other side: merchandise sold on account (Dr 1210), a gift
// reclassed to a liability (Cr 2052). Stripe's own reclasses are kept separately.
// Interest income (4050) booked with no cash or investment account on the other side: received
// inside another settlement, not as its own deposit (Sep 2026: GL019115, 576.13 of interest on the
// OneStory escrow, credited on the closing statement). CD interest (1150), ICS (1160), the money
// markets and the investment gains (8999) all have their account on the other side.
const NOT_NO_CASH = ['1060', '1120', '1150', '1160', '1170', '1171', '8999'];
function noCashInterest(batches) {
  const out = [];
  for (const b of batches) {
    if (!('4050' in b.accounts) || CASH_SIDE.some((a) => a in b.accounts) || NOT_NO_CASH.some((a) => a in b.accounts)) continue;
    const amount = round2(-(b.accounts['4050'] || 0));
    if (Math.abs(amount) >= 0.005) out.push({ batch: b.batch, date: b.date, desc: b.desc.slice(0, 120), amount });
  }
  return out;
}

function noCashRevenue(batches) {
  const out = [];
  for (const b of batches) {
    if (/stripe/i.test(b.desc) || CASH_SIDE.some((a) => a in b.accounts)) continue;
    const accounts = {};
    for (const [acct, net] of Object.entries(b.accounts)) if (Math.abs(net) >= 0.005) accounts[acct] = round2(-net);
    if (!Object.keys(accounts).some((a) => /^40[1-8]\d$/.test(a))) continue;
    out.push({ batch: b.batch, date: b.date, desc: b.desc.slice(0, 120), accounts });
  }
  return out;
}

// Stripe sales the GL moves after booking the month's Stripe giving to 4015: merchandise to the
// merch revenue lines, shipping to 9050, sales tax to 2042, and now and then a stray Stripe
// transfer into giving. What leaves (or joins) revenue is an adjustment to the Stripe line.
function stripeReclasses(batches) {
  const out = [];
  for (const b of batches) {
    if (!/stripe/i.test(b.desc) || /Monthly Stripe Giving/i.test(b.desc) || b.accounts[CASS_GL] || !b.accounts['4015']) continue;
    const accounts = {};
    for (const [acct, net] of Object.entries(b.accounts)) if (Math.abs(net) >= 0.005) accounts[acct] = round2(-net);
    out.push({ batch: b.batch, date: b.date, desc: b.desc.slice(0, 120), accounts });
  }
  return out;
}

// Management fees taken out of an investment account. The GL books the month's gain from the
// statement's change in value, grossed up by the fee (Cr 8999), with the fee as an expense
// (Dr 8070) — so the fee is added back to the change in value. Tschetter bills monthly, but its
// fees are booked only when a statement arrives (je/investments.js).
export const INVESTMENT_GL = { 1170: 'delap', 1171: 'tschetter' };
// Which investment account a batch is about: the one it has a line on, or, for an 8070 / 8999
// entry with no investment line, the one its description names. A reversal is often keyed
// without the zero 1171 line the original had (Apr 2026: GL018327, Tschetter fees 9,697.84,
// reversed by GL019056), and without this it wouldn't net out.
const NAMED = [[/tschetter/i, '1171'], [/delap/i, '1170']];
export function investmentAccountOf(b) {
  const onLine = Object.keys(INVESTMENT_GL).find((a) => a in b.accounts);
  if (onLine) return onLine;
  if (!('8070' in b.accounts || '8999' in b.accounts)) return null;
  return (NAMED.find(([re]) => re.test(b.desc || '')) || [])[1] || null;
}
function investmentFees(batches) {
  const out = [];
  for (const b of batches) {
    const acct = investmentAccountOf(b);
    const fee = round2(b.accounts['8070'] || 0);
    if (acct && fee) out.push({ account: INVESTMENT_GL[acct], batch: b.batch, date: b.date, desc: b.desc.slice(0, 120), amount: fee });
  }
  return out;
}

// What the GL booked for each investment account's month: the change in value (Dr 1171), the gain
// (Cr 8999) and any fee (Dr 8070), batch by batch, so the gain worked out from the statements can
// be shown against it.
function investmentGl(batches) {
  const out = [];
  for (const b of batches) {
    const acct = investmentAccountOf(b);
    if (!acct || !('8999' in b.accounts || '4050' in b.accounts)) continue;
    const gain = round2(-((b.accounts['8999'] || 0) + (b.accounts['4050'] || 0)));
    if (!gain && !b.accounts['8070']) continue;
    out.push({ account: INVESTMENT_GL[acct], batch: b.batch, date: b.date, desc: b.desc.slice(0, 120), value: round2(b.accounts[acct] || 0), gain, fee: round2(b.accounts['8070'] || 0) });
  }
  return out;
}

// Acumatica "Statement of Activities - Comparative" (Excel). Whole dollars. We keep each line's
// period-to-date and year-to-date actuals, plus the totals proof of cash compares against:
//   revenue  = Total Contributions + Total Merchandise Revenue + Total Other Income
//   interest = −(Net Interest Expense/Income)   (income shows as negative on the report)
export function parseStatementOfActivities(XLSX, wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const at = (r, c) => cellAt(XLSX, ws, r, c);
  let asOf = null;
  for (let r = 0; r < 8 && !asOf; r++) {
    const m = text(at(r, 0)).match(/As of\s+(\w+)\s+(\d{1,2}),\s+(\d{4})/i);
    if (m) {
      const mi = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].indexOf(m[1].toLowerCase()) + 1;
      asOf = `${m[3]}-${String(mi).padStart(2, '0')}`;
    }
  }
  if (!asOf || !/statement of activ/i.test(`${text(at(0, 0))} ${text(at(1, 0))}`)) throw new Error('This doesn’t look like the Statement of Activities export (no “As of …” date).');
  const lines = [];
  const totals = {};
  for (let r = 6; r <= range.e.r; r++) {
    const group = text(at(r, 0)), line = text(at(r, 1));
    const ptd = num(at(r, 2)), ytd = num(at(r, 5));
    if (line) lines.push({ line, ptd: ptd ?? 0, ytd: ytd ?? 0, budget: num(at(r, 3)) });
    else if (group && (ptd != null || ytd != null)) totals[group] = { ptd: ptd ?? 0, ytd: ytd ?? 0 };
  }
  const ptdOf = (label) => totals[label]?.ptd ?? 0;
  const interestLine = lines.find((l) => /net interest/i.test(l.line));
  return {
    month: asOf, lines, totals,
    revenueTotal: ptdOf('Total Contributions') + ptdOf('Total Merchandise Revenue') + ptdOf('Total Other Income'),
    interestTotal: interestLine ? -interestLine.ptd : 0,
  };
}

// What changed in a month's GL between two uploads, batch by batch: added, changed (a line's
// account or amount, or lines added or removed — someone edited it in Acumatica) and removed
// (deleted or moved to another period). An earlier upload without an index can't be compared.
export function glChanges(before, after) {
  if (!before?.index || !after?.index) return null;
  const added = [], changed = [], removed = [];
  for (const [b, x] of Object.entries(after.index)) {
    const was = before.index[b];
    if (!was) added.push({ batch: b, ...x });
    else if (was.fp !== x.fp) changed.push({ batch: b, desc: x.desc, date: x.date, was: was.total, now: x.total });
  }
  for (const [b, x] of Object.entries(before.index)) if (!after.index[b]) removed.push({ batch: b, ...x });
  return { added, changed, removed };
}
