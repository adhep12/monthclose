// Cass deposits checked against how the GL booked them.
//
// The GL register upload keeps every batch that put money into Cass (1100), with the accounts on
// its other side (gl.js, `receipts`). Each deposit on the Operating, Incoming and Outgoing
// statements is matched to one of those batches, which says what it was:
//   revenue (4010, 4018…)             nothing to do
//   another of our accounts (1013…)   a transfer, not revenue
//   a receivable (1210, 1220)         revenue booked in an earlier month
//   anything else (7220, 2041…)       a refund, reimbursement or pass-through — not revenue
// The GL books a day's Incoming wires, or a check deposit and its mobile deposits, as one batch,
// so one batch can match several statement lines.
//
// The same matching gives deposits in transit: a revenue batch in the GL for one month whose money
// reached the bank the next month. The GL names the bank date in the batch description
// ("3.3.2026 February Deposit"), so a month can be worked out before next month's statement is in;
// once it is, the statement confirms it.
//
// Everything here is worked out again every time from the statements and the GL. What people
// decide is stored on the month: rec.dismissed (a finding they overruled, shared with the other
// automatic findings) and rec.ditGl (whether a GL deposit is in transit at month end).

import { round2, sum } from '../money.js';
import { addMonths, lastDayOfMonth } from '../fiscal.js';
import { PAYPAL_GL } from '../gl.js';
import { DEFAULT_POC_CONFIG, isSweep, defaultExclusions, manualExclusions, exclusionInfo } from './calc.js';

const STRIPE = /^STRIPE/i;
const DAY = 86400000;
const cents = (n) => Math.round(n * 100);
const CLEARING = '1200';
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (m) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

// Names for the accounts a Cass deposit is usually booked to, for the notes.
const ACCOUNT_NAMES = {
  1012: 'PayPal', 1013: 'Wise', 1015: 'Stripe', 1020: 'pass-through cash', 1060: 'KeyBank money market', 1061: 'KeyBank',
  1150: 'CDARS', 1160: 'ICS', 1170: 'Delap Fidelity', 1171: 'Tschetter', 1200: 'Stripe clearing', 1210: 'accounts receivable',
  1220: 'grants / pledges receivable', 2010: 'accounts payable', 2041: 'agency (pass-through)', 2042: 'sales tax', 2050: 'payroll',
  9050: 'shipping (COGS)',
};
export const accountName = (a, names = {}) => `${a} ${names[a] || ACCOUNT_NAMES[a] || ''}`.trim();
const money2 = (v) => (v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Money leaving Cass (not the sweeps between its own accounts), for matching a chargeback.
const cassDebits = (rec) => ['operating', 'incoming', 'outgoing'].flatMap((k) => (rec?.statements?.[k]?.transactions || []).filter((t) => t.section !== 'credit' && !isSweep(t)));

// What a bank's wording for a deposit usually means, in plain words, for a deposit a person has to
// look at. Empty when there's nothing to add to the bank's own description.
const HINTS = [
  [/^PAYPAL/i, 'Likely a PayPal Giving Fund grant (a donor-advised gift through PayPal); the GL books these as “DAF Gifts - PayPal Grant(s)”, often several in one entry'],
  [/DIVVY\/?REWARDS|DIVVY.*CASH ?BACK/i, 'Divvy card rewards (cash back), counted as revenue'],
  [/DIVVY REIMBURSEM/i, 'Divvy paying us back (a card reimbursement) — usually not revenue; check what it was for'],
  [/DEPOSIT CONNECTION/i, 'Check deposit made at the bank'],
  [/MOBILE DEPOSIT/i, 'Check deposited by phone'],
  [/WEX COBRA/i, 'WEX COBRA refund — benefits, not revenue'],
  [/ADP (WAGE|TAX)/i, 'ADP payroll refund — not revenue'],
  [/CIGNA/i, 'Cigna insurance refund — not revenue'],
  [/IRS TREAS|US TREASURY|TAX ?REFUND/i, 'Tax refund — not revenue'],
  [/FIDELITY|FID BKG SVC/i, 'Fidelity: a Fidelity Charitable grant, or money from our own Fidelity account'],
  [/NCF/i, 'National Christian Foundation grant (a donor-advised gift)'],
  [/WISE/i, 'From Wise — our own account, or a donor paying through Wise'],
  [/^ORIG:|WIRE|FEDWIRE/i, 'Wire transfer'],
];
export function depositHint(desc) {
  return (HINTS.find(([re]) => re.test(String(desc || ''))) || [, ''])[1];
}

// Names, for telling whether a deposit and a GL entry are about the same payer: the bank's words
// for it ("FIDELITY INVESTM/GrantPaymt", "NCF/ACH", "PAYPAL INC./PAYMENT") against the GL's
// (the batch description, each line's description — the payer on a gift line — and customer).
const GENERIC = new Set(['orig', 'ach', 'payment', 'payments', 'pmt', 'inc', 'llc', 'ltd', 'corp', 'transfer', 'trnsfr', 'deposit', 'deposits', 'daf',
  'gift', 'gifts', 'grant', 'grants', 'the', 'and', 'for', 'from', 'via', 'with', 'bank', 'business', 'mobile', 'connection', 'checking', 'acct', 'account',
  'ending', 'foundation', 'charitable', 'fund', 'giving', 'donation', 'donations', 'cass', 'operating', 'wire', 'wires', 'credit', 'debit', 'usd', 'reference',
  'received', 'money', 'general', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);
// The same payer under the bank's name and the GL's: giving platforms pay through funds with
// other names (Your Cause through the Blackbaud Giving Fund, "BBGF-…"; Benevity through the
// American / UK Online Giving Foundation).
// Each: the words that say it (on the statement or in the GL), the payer they mean. Shown in
// the app's "Payer names" list, where more can be added (config.aliases: { bank, gl }).
export const BUILT_IN_ALIASES = [
  { re: /\bBBGF\b|BLACKBAUD|YOUR ?CAUSE/i, name: 'Your Cause', bank: 'BBGF-… (Blackbaud Giving Fund)', gl: 'Your Cause' },
  { re: /AMER(ICAN)? ONLINE GIV|UK ONLINE GIVING|BENEVITY/i, name: 'Benevity', bank: 'AMER ONLINE GIV1, THE UK ONLINE GIVING FOUNDATION', gl: 'Benevity' },
  { re: /AMRCNENDWMNT|AMERICAN ENDOWMENT|\bAEF\b/i, name: 'American Endowment Fund', bank: 'AMRCNENDWMNTFUND/AEF', gl: 'AEF, American Endowment Fund' },
  { re: /\bU\.? ?S\.? CHARITABLE/i, name: 'U.S. Charitable', bank: 'U.S. Charitable/U.S. Chari', gl: 'U.S. Charitable, US Charitable' },
  { re: /\bNCF\b|NATIONAL CHRISTIAN/i, name: 'NCF', bank: 'NCF/ACH', gl: 'NCF' },
  { re: /FIDELITY|\bFID\b/i, name: 'Fidelity', bank: 'FIDELITY INVESTM/GrantPaymt, FID BKG SVC', gl: 'Fidelity' },
  { re: /SCHWAB/i, name: 'Schwab', bank: 'SCHWAB', gl: 'Schwab' },
  { re: /PAYPAL/i, name: 'PayPal', bank: 'PAYPAL INC./PAYMENT', gl: 'PayPal Grant' },
  { re: /STRIPE/i, name: 'Stripe', bank: 'STRIPE/TRANSFER', gl: 'Transfer Stripe Checking to Cass' },
  { re: /\bWISE\b/i, name: 'Wise', bank: 'WISE US INC', gl: 'Wise Transfer, Wise Donation' },
  { re: /OVERFLOW/i, name: 'Overflow', bank: 'OVERFLOW', gl: 'Overflow' },
  { re: /\bIPAY\b/i, name: 'iPay Solutions', bank: 'IPAY', gl: 'iPay Solutions' },
  { re: /RENAISSANCE/i, name: 'Renaissance Charitable', bank: 'RENAISSANCE', gl: 'Renaissance Charitable' },
  { re: /SIGNATRY/i, name: 'Signatry', bank: 'SIGNATRY', gl: 'Signatry' },
  { re: /GIVE ?CLEAR/i, name: 'GiveClear', bank: 'GIVECLEAR', gl: 'GiveClear Foundation' },
  { re: /CHARIOT/i, name: 'Chariot', bank: 'CHARIOT', gl: 'Chariot' },
  { re: /FRONT ?STREAM/i, name: 'FrontStream', bank: 'FRONTSTREAM', gl: 'FrontStream' },
  { re: /MORGAN STANLEY/i, name: 'Morgan Stanley', bank: 'MORGAN STANLEY', gl: 'Morgan Stanley' },
  { re: /THRIVENT/i, name: 'Thrivent', bank: 'THRIVENT', gl: 'Thrivent Grant' },
  { re: /CYBER ?GRANTS/i, name: 'Cybergrants', bank: 'CYBERGRANTS', gl: 'Cybergrants' },
  { re: /DIVVY/i, name: 'Divvy', bank: 'DIVVY', gl: 'Divvy' },
];
const esc = (w) => w.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Built-in names plus any added in the app: each added one is the bank's words and the GL's words,
// comma-separated, for the same payer.
export function aliasList(extra = []) {
  const added = (extra || []).filter((a) => a?.bank || a?.gl).map((a) => {
    const words = [...String(a.bank || '').split(','), ...String(a.gl || '').split(',')].map((w) => w.trim()).filter(Boolean);
    return { re: new RegExp(words.map(esc).join('|'), 'i'), name: a.name || words[words.length - 1], bank: a.bank, gl: a.gl, added: true };
  });
  return [...BUILT_IN_ALIASES, ...added];
}
export const nameWords = (s, aliases = BUILT_IN_ALIASES) => {
  const t = String(s || '');
  return [...new Set([...aliases.filter((x) => x.re.test(t)).map((x) => `=${x.name.toLowerCase()}`),
    ...t.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !GENERIC.has(w))])];
};
const sameWord = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && !a.startsWith('=') && !b.startsWith('=') && (a.startsWith(b.slice(0, 5)) || b.startsWith(a.slice(0, 5))));
// The GL words a deposit agrees with ([] when none), and whether both sides name someone at all.
export function namesAgree(bankText, glTexts, aliases = BUILT_IN_ALIASES) {
  const bank = nameWords(bankText, aliases), gl = nameWords(glTexts.join(' '), aliases);
  return { agree: bank.filter((w) => gl.some((u) => sameWord(w, u))).map((w) => w.replace(/^=/, '')), bankNamed: bank.length > 0, glNamed: gl.length > 0 };
}
const CHECK = /DEPOSIT CONNECTION|MOBILE DEPOSIT|REMOTE DEPOSIT|BRANCH DEPOSIT/i;

// What the GL booked a batch to, in proof of cash terms.
export function glKind(r, config = DEFAULT_POC_CONFIG, names = {}) {
  const credited = Object.entries(r.accounts || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const revenue = round2(sum(credited.filter(([a]) => config.revenueAccounts.includes(a)), ([, v]) => v));
  const other = credited.filter(([a]) => !config.revenueAccounts.includes(a));
  const label = credited.map(([a]) => accountName(a, names)).join(', ');
  if (!other.length) return { kind: 'revenue', revenue, label };
  const main = other[0][0];
  if (main === '1200') return { kind: 'stripe', revenue, label };
  if (/^10\d\d$/.test(main) || ['1100', '1150', '1160', '1170', '1171'].includes(main)) return { kind: 'transfer', revenue, label };
  if (/^12[1-9]\d$/.test(main)) return { kind: 'prior-period', revenue, label };
  return { kind: 'not-revenue', revenue, label };
}

// The bank date(s) the GL names in a batch description: "3.3.2026 February Deposit",
// "8.18.2026-8.19.2026 August Mobile Deposits". Falls back to the batch date.
export function bankWindow(r) {
  const m = String(r.desc || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s*-\s*(\d{1,2})\.(\d{1,2})\.(\d{4}))?/);
  const iso = (mo, d, y) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (!m) return { from: r.date, to: r.date, named: false };
  const from = iso(m[1], m[2], m[3]);
  return { from, to: m[4] ? iso(m[4], m[5], m[6]) : from, named: true };
}
const distance = (date, w) => {
  const t = Date.parse(date), a = Date.parse(w.from), b = Date.parse(w.to);
  if (Number.isNaN(t) || Number.isNaN(a)) return 99;
  return t < a ? (a - t) / DAY : t > b ? (t - b) / DAY : 0;
};

// Every credit on the month's Cass statements, except the sweeps between them.
export function bankLines(rec) {
  const out = [];
  for (const kind of ['operating', 'incoming', 'outgoing']) {
    for (const t of rec?.statements?.[kind]?.transactions || []) if (t.section === 'credit' && !isSweep(t)) out.push({ ...t, kind });
  }
  return out;
}

// Lines from `pool` adding up to `target`, trying the biggest first. Bounded, so a busy day
// can't hang the page; not finding a group just leaves the batch unmatched for a person to look at.
function subsetSum(pool, target) {
  const items = [...pool].sort((a, b) => b.c - a.c);
  const suffix = []; let run = 0;
  for (let i = items.length - 1; i >= 0; i--) { run += items[i].c; suffix[i] = run; }
  let steps = 0; const pick = [];
  const go = (i, left) => {
    if (left === 0) return true;
    if (i >= items.length || left < 0 || suffix[i] < left || ++steps > 50000) return false;
    pick.push(items[i]);
    if (go(i + 1, left - items[i].c)) return true;
    pick.pop();
    return go(i + 1, left);
  };
  return go(0, target) ? pick.map((x) => x.line) : null;
}

// Match one month's statement lines to GL batches. Batches already used by another month are
// skipped. This month's batches are tried first, then last month's (deposits in transit clearing),
// then next month's (deposited now, booked next month).
//
// Incoming Wires is swept to Operating every day, and the GL books each day's wires as one batch
// ("DAF Gifts - …"), sometimes with a wire of its own split out (a Wise transfer). So Incoming is
// matched a day at a time: the day's credits against one batch, or a few that add up to them.
// Operating deposits are matched one to one, then in groups (a check deposit and its mobile
// deposits; several PayPal grants), steered by what the batch says it is.
function matchMonth(month, lines, receiptsBy, used, rec = {}) {
  const byLine = new Map();
  byLine.pinIssues = [];
  const RANK = { this: 0, prior: 1, next: 2 };
  const all = [[month, 'this'], [addMonths(month, -1), 'prior'], [addMonths(month, 1), 'next']]
    .flatMap(([m, when]) => (receiptsBy[m] || []).filter((r) => r.amount > 0).map((r) => { const kind = glKind(r).kind; return { r, when, w: bankWindow(r), kind, stripe: kind === 'stripe' }; }));
  const open = (x) => !used.has(x.r.batch);
  const take = (x, ls) => { used.add(x.r.batch); for (const l of ls) byLine.set(l, { r: x.r, when: x.when, group: ls.length, batches: [x.r] }); };
  // Last or next month's batch has to be close: it's borrowing across the month end.
  // A refund or reimbursement check booked last month (no bank date in its name) can take a week or
  // so to reach the bank (the Cigna check: booked 12/31, deposited 1/7), so it gets longer early in
  // the month. Gifts and grants are booked the day the money arrives, so they don't: a same-amount
  // grant last month isn't this month's (a 2,000 PayPal grant 4/27 vs 5/8).
  const near = (x, date, days) => {
    const d = distance(date, x.w);
    if (x.when === 'this') return d <= days;
    if (x.when === 'prior' && !x.w.named && x.kind !== 'revenue' && Number(String(date).slice(8, 10)) <= 12) return d <= 12;
    return d <= Math.min(days, 3);
  };
  const order = (date) => (a, b) => RANK[a.when] - RANK[b.when] || distance(date, a.w) - distance(date, b.w);
  // A person's word comes first. A match someone confirmed (rec.glMatch[line] = { batch, fp }) is
  // taken before any rule runs, so a new upload or a rule change can't move it; if the batch has
  // changed in the GL since, or is gone, that's flagged. A batch someone said isn't this deposit
  // (rec.glNot[line].batches) is never tried for it again.
  const rejected = (x, l) => (rec.glNot?.[l.id]?.batches || []).includes(x.r.batch);
  const pinned = {};
  for (const l of lines) { const p = rec.glMatch?.[l.id]; if (p?.batch) (pinned[p.batch] ||= []).push(l); }
  const find = (batch) => {
    const x = all.find((y) => y.r.batch === batch);
    if (x) return x;
    const r = Object.entries(receiptsBy).flatMap(([m, rs]) => rs.map((r_) => ({ r: r_, m }))).find((y) => y.r.batch === batch);
    return r ? { r: r.r, when: r.m < month ? 'prior' : r.m > month ? 'next' : 'this', w: bankWindow(r.r), kind: glKind(r.r).kind, stripe: glKind(r.r).kind === 'stripe' } : null;
  };
  for (const [key, ls] of Object.entries(pinned)) {
    const pin = rec.glMatch[ls[0].id];
    // One deposit confirmed against several batches (two receivable payments in one wire).
    const ids = pin.batches?.length > 1 ? pin.batches : [key];
    const xs = ids.map(find);
    if (xs.some((x) => !x || !open(x))) { for (const l of ls) byLine.pinIssues.push({ line: l, pin, state: xs.some((x) => !x) ? 'gone' : 'used' }); continue; }
    const fps = xs.map((x) => x.r.fp);
    const state = (pin.fps || [pin.fp]).some((f, i) => f && fps[i] && f !== fps[i]) ? 'changed' : 'ok';
    if (xs.length === 1) take(xs[0], ls);
    else {
      for (const x of xs) used.add(x.r.batch);
      const accounts = {};
      for (const x of xs) for (const [a, v] of Object.entries(x.r.accounts)) accounts[a] = round2((accounts[a] || 0) + v);
      const r = { batch: ids.join(' + '), date: xs[0].r.date, desc: xs.map((x) => x.r.desc).join(' + '), amount: ls[0].amount, accounts };
      byLine.set(ls[0], { r, when: xs[0].when, group: 1, batches: xs.map((x) => x.r) });
    }
    for (const l of ls) if (byLine.get(l)) byLine.get(l).pin = { ...pin, state };
  }
  // Batches that can only be an Operating deposit: a PayPal grant, or a deposit the GL names by
  // its bank date ("1.9.2026 January Deposit"). Incoming wires and Stripe transfers never take them.
  const operatingOnly = (x) => /paypal/i.test(x.r.desc) || (x.w.named && /\bdeposits?\b/i.test(x.r.desc));

  const fits = (x, l) => {
    if (rejected(x, l)) return false;
    if (STRIPE.test(l.desc) !== x.stripe) return false;
    if (operatingOnly(x) && l.kind !== 'operating') return false;
    if (/paypal/i.test(x.r.desc) && l.kind === 'operating') return /PAYPAL/i.test(l.desc);
    // A PayPal deposit is a PayPal grant, or money from our own PayPal account (1012): never some
    // other batch that happens to be the same amount (January: a 100 PayPal grant took AP012998,
    // a 100 vendor check booked to accounts payable, three days later).
    if (/PAYPAL/i.test(l.desc) && l.kind === 'operating') return /paypal/i.test(x.r.desc) || PAYPAL_GL in (x.r.accounts || {});
    return true;
  };

  // Stripe payouts, one to one.
  for (const l of lines.filter((y) => STRIPE.test(y.desc) && !byLine.has(y))) {
    const x = all.filter((y) => open(y) && y.stripe && !rejected(y, l) && Math.abs(y.r.amount - l.amount) < 0.005 && near(y, l.date, 5)).sort(order(l.date))[0];
    if (x) take(x, [l]);
  }
  // A Stripe transfer that isn't one of our payouts can be a gift paid through someone else's Stripe
  // account (Every.org, October: 9.43), which the GL books as revenue.
  for (const l of lines.filter((y) => STRIPE.test(y.desc) && !byLine.has(y))) {
    const x = all.filter((y) => open(y) && y.kind === 'revenue' && !operatingOnly(y) && !rejected(y, l) && Math.abs(y.r.amount - l.amount) < 0.005 && near(y, l.date, 5)).sort(order(l.date))[0];
    if (x) take(x, [l]);
  }

  // Incoming, a day at a time.
  const days = {};
  for (const l of lines.filter((y) => y.kind === 'incoming' && !byLine.has(y))) (days[l.date] ||= []).push(l);
  for (const [date, ls] of Object.entries(days).sort()) {
    const total = cents(sum(ls, (l) => l.amount));
    const cands = all.filter((x) => open(x) && !x.stripe && !operatingOnly(x) && !ls.some((l) => rejected(x, l)) && near(x, date, 3) && cents(x.r.amount) <= total).sort(order(date));
    const one = cands.find((x) => cents(x.r.amount) === total);
    if (one) { take(one, ls); continue; }
    const batches = subsetSum(cands.slice(0, 16).map((x) => ({ line: x, c: cents(x.r.amount) })), total);
    if (!batches) continue;
    // Which wires make up each batch: the smaller ones by amount, the biggest takes the rest.
    batches.sort((a, b) => a.r.amount - b.r.amount);
    let rest = [...ls]; const plan = [];
    for (const x of batches.slice(0, -1)) {
      const part = subsetSum(rest.map((l) => ({ line: l, c: cents(l.amount) })), cents(x.r.amount));
      if (!part) { rest = null; break; }
      plan.push([x, part]); rest = rest.filter((l) => !part.includes(l));
    }
    if (!rest) continue;
    plan.push([batches[batches.length - 1], rest]);
    for (const [x, part] of plan) take(x, part);
  }

  // Everything else: one to one, closest pairs first — so a 500 grant on 10/15 takes the 500 batch
  // booked 10/15, not one a week away that another 500 needed (October: 500 + 15 were one 515
  // batch on 10/7, and a second 500 was its own batch on 10/15).
  // Then one batch for several lines. The GL books PayPal grants a few at a time ("PayPal Grants
  // (2)"), and the grants in one batch can reach the bank up to a week apart.
  // Close matches go first — one to one, then groups, within a day or two — and only what's left is
  // tried across the wider window, so a batch can't take a grant another batch booked the day it
  // arrived (November: 15 + 300 were one batch on 11/7, and another 300 was 150 + 150 on 11/14).
  const left = () => lines.filter((l) => !byLine.has(l));
  const grants = (x) => /paypal grant/i.test(x.r.desc) && x.when === 'this';
  // This month's own batches go first, one to one and in groups, before a deposit borrows a batch
  // from across the month end (April: a 2,000 and a 500 on 4/29 are April's 2,500 batch — the
  // 2,000 mustn't take May's own 2,000 grant booked 5/1).
  for (const [wide, own] of [[false, true], [false, false], [true, false]]) {
    const pool = own ? all.filter((y) => y.when === 'this') : all;
    const pairs = [];
    left().forEach((l, i) => {
      for (const y of pool) if (open(y) && fits(y, l) && Math.abs(y.r.amount - l.amount) < 0.005 && near(y, l.date, wide ? 7 : 2)) pairs.push({ l, y, i, d: distance(l.date, y.w) });
    });
    pairs.sort((a, b) => RANK[a.y.when] - RANK[b.y.when] || a.d - b.d || a.i - b.i);
    for (const p of pairs) if (!byLine.has(p.l) && open(p.y)) take(p.y, [p.l]);
    for (const x of [...pool].sort((a, b) => RANK[a.when] - RANK[b.when] || b.r.amount - a.r.amount)) {
      if (!open(x) || x.r.ap || (wide && !grants(x))) continue;
      const cand = left().filter((l) => fits(x, l) && near(x, l.date, wide ? 7 : x.w.named ? 1 : 2));
      for (const set of [cand.filter((l) => l.kind === 'operating'), cand.filter((l) => l.kind === 'incoming'), cand.filter((l) => l.kind === 'outgoing'), cand]) {
        if (set.length < 2) continue;
        const found = subsetSum(set.slice(0, 40).map((l) => ({ line: l, c: cents(l.amount) })), cents(x.r.amount));
        if (found) { take(x, found); break; }
      }
    }
  }
  // One deposit, several batches of the same kind: two receivable payments in one wire (Koorong
  // Books, March: 520 + 75).
  for (const l of left()) {
    const cand = all.filter((x) => open(x) && fits(x, l) && near(x, l.date, 3) && x.r.amount < l.amount).sort(order(l.date)).slice(0, 12);
    const found = subsetSum(cand.map((x) => ({ line: x, c: cents(x.r.amount) })), cents(l.amount));
    if (!found || found.length < 2 || new Set(found.map((x) => glKind(x.r).kind)).size > 1) continue;
    for (const x of found) used.add(x.r.batch);
    const accounts = {};
    for (const x of found) for (const [a, v] of Object.entries(x.r.accounts)) accounts[a] = round2((accounts[a] || 0) + v);
    const r = { batch: found.map((x) => x.r.batch).join(' + '), date: found[0].r.date, desc: found.map((x) => x.r.desc).join(' + '), amount: l.amount, accounts };
    byLine.set(l, { r, when: found[0].when, group: 1, batches: found.map((x) => x.r) });
  }
  return byLine;
}

// A reversal that just undoes a batch posted twice — same description, amount and accounts —
// cancels out with it, before anything is matched. Any other reversal takes revenue back (a
// chargeback, a deposit reclassed) and needs an adjustment.
export function pairDuplicates(receipts) {
  const cancelled = new Set();
  for (const rev of receipts.filter((r) => r.amount < 0)) {
    const twin = [...receipts].reverse().find((r) => r.amount > 0 && !cancelled.has(r.batch) && r.desc === rev.desc && Math.abs(r.amount + rev.amount) < 0.005
      && Object.keys(r.accounts).sort().join() === Object.keys(rev.accounts).sort().join());
    if (twin) { cancelled.add(twin.batch); cancelled.add(rev.batch); }
  }
  return cancelled;
}

const TYPE = { transfer: 'transfer', 'prior-period': 'prior-period', 'not-revenue': 'not-revenue' };
const WHY = {
  transfer: 'money from another of our accounts',
  'prior-period': 'collected on a receivable — the revenue was booked in an earlier month',
  'not-revenue': 'booked to a non-revenue account',
};

// The whole fiscal picture at once: every month's matching, findings and deposits in transit.
// recs: { 'YYYY-MM': month record }, glBy: { 'YYYY-MM': gl-activity record (with receipts) }.
// Months are matched in order, so a batch used by one month can't be claimed by the next.
export function depositChecks({ recs, glBy, config = DEFAULT_POC_CONFIG, names = {} }) {
  // Payer names: the built-in aliases and any added in the app.
  const aliases = aliasList(config.aliases);
  const receiptsBy = {};
  const cancelledBy = {};
  for (const [m, g] of Object.entries(glBy || {})) {
    if (!g?.receipts) continue;
    cancelledBy[m] = pairDuplicates(g.receipts);
    receiptsBy[m] = g.receipts.filter((r) => !cancelledBy[m].has(r.batch));
  }
  const months = [...new Set([...Object.keys(recs || {}), ...Object.keys(receiptsBy)])].sort();
  const used = new Set();
  const matched = {}; // month → Map(line → match)
  const matchedBatch = new Map(); // batch → { month, lines }
  for (const m of months) {
    const lines = bankLines(recs[m]);
    const byLine = lines.length ? matchMonth(m, lines, receiptsBy, used, recs[m] || {}) : Object.assign(new Map(), { pinIssues: [] });
    matched[m] = { lines, byLine };
    for (const [l, x] of byLine) {
      for (const r of x.batches || [x.r]) {
        const e = matchedBatch.get(r.batch) || { month: m, lines: [] };
        e.lines.push(l); matchedBatch.set(r.batch, e);
      }
    }
  }
  // Money that came in through Stripe but wasn't one of Stripe's payouts (a gift through another
  // Stripe account): the GL holds it in Stripe clearing (1200) and moves it to giving later
  // ("reclass of stripe clearing account to giving"). That's timing — received in one month,
  // recognized in a later one — so the two ends are linked. January: 97.50 in (GL017570), moved to
  // giving in February (GL017834).
  const late = {}, clearing = {};
  for (const m of months) {
    for (const x of glBy[m]?.stripeReclass || []) {
      if (!(x.accounts?.[CLEARING] < 0)) continue;
      const amount = revenueIn(x.accounts);
      if (amount < 0.005) continue;
      for (const mm of [addMonths(m, -1), addMonths(m, -2), m]) {
        const hit = [...(matched[mm]?.byLine || [])].find(([l, y]) => STRIPE.test(l.desc) && glKind(y.r).kind === 'stripe' && Math.abs(l.amount - amount) < 0.005 && !late[mm]?.[l.id]);
        if (!hit) continue;
        const [l, y] = hit;
        (late[mm] ||= {})[l.id] = { id: l.id, date: l.date, desc: l.desc, amount: l.amount, glIn: y.r.batch, to: { month: m, batch: x.batch, date: x.date, desc: x.desc } };
        (clearing[m] ||= {})[x.batch] = { month: mm, id: l.id, date: l.date, desc: l.desc, glIn: y.r.batch };
        break;
      }
    }
  }
  const out = {};
  for (const m of months) out[m] = monthFindings(m);
  return out;

  function revenueIn(accounts) {
    return round2(sum(Object.entries(accounts || {}).filter(([a]) => config.revenueAccounts.includes(a)), ([, v]) => v));
  }

  // How sure the match between a deposit and its GL batch is, and why. The amount always agrees
  // (that's how it was found); what else does:
  //   the names — the payer on the statement is the payer on the GL line (Fidelity, NCF, PayPal);
  //   the line — a GL line in the batch has this deposit's amount (its identifier is kept);
  //   the kind — a check deposit to a "<date> Deposit" batch, Stripe to Stripe clearing;
  //   the date — the bank date the GL names, or the same day;
  // and what counts against it: another free GL entry of the same amount nearby (it could as well
  // be that one), names that differ, an AP entry (a vendor check), borrowing across the month end,
  // a group spread over several days. A person confirming it (a pin) settles it.
  function confidenceOf(l, x, m) {
    const r = x.r;
    const plus = [], minus = [];
    if (x.pin) {
      return x.pin.state === 'changed'
        ? { level: 'low', plus: [], minus: [`Confirmed by ${x.pin.by}, but the GL batch has changed since (re-upload) — check it again`] }
        : { level: 'confirmed', plus: [`Confirmed by ${x.pin.by}`], minus: [] };
    }
    const glLines = (x.batches || [r]).flatMap((b) => b.lines || []);
    const credits = glLines.filter((g) => g.amt < 0);
    // The GL line that is this deposit: same amount, the payer named alike if both are named.
    const bankText = `${l.desc} ${l.detail || ''}`;
    const same = credits.filter((g) => Math.abs(Math.abs(g.amt) - l.amount) < 0.005);
    const tieLine = same.find((g) => namesAgree(bankText, [g.d, g.cv], aliases).agree.length) || (same.length === 1 ? same[0] : null);
    const tie = x.group > 1 || (x.batches || []).length > 1 ? tieLine : glLines.find((g) => g.a === '1100' && Math.abs(g.amt - l.amount) < 0.005) || tieLine;
    const names = namesAgree(bankText, [r.desc, ...glLines.map((g) => `${g.d} ${g.cv}`)], aliases);
    // A GL line of its own with this amount, inside an entry that adds up to the day or the group.
    // (For a deposit matched one to one, its GL line having the same amount is just the match itself.)
    const lineTie = !!tie && same.length > 0 && (x.group > 1 || (x.batches || []).length > 1);
    if (names.agree.length) plus.push(`Names agree: ${names.agree.join(', ')}`);
    else if (names.bankNamed && names.glNamed && !CHECK.test(l.desc) && !lineTie) minus.push(`The statement names ${nameWords(bankText, aliases).slice(0, 3).map((w) => w.replace(/^=/, '')).join(', ')}; the GL entry doesn’t`);
    if (tie) plus.push(`GL line ${tie.id}${tie.d ? ` (${tie.d})` : ''}${lineTie && x.group > 1 ? ' — its own line, in an entry that adds up to the group' : ''}`);
    if (CHECK.test(l.desc) && (bankWindow(r).named || /\bdeposits?\b/i.test(r.desc))) plus.push('A check deposit, and the GL entry is the day’s deposit');
    if (STRIPE.test(l.desc) && glKind(r).kind === 'stripe') plus.push('Stripe to Stripe clearing');
    const d = distance(l.date, bankWindow(r));
    if (bankWindow(r).named && d === 0) plus.push('The GL names this bank date');
    else if (d === 0) plus.push('Same day');
    else if (d > 2) minus.push(`${d} days apart`);
    // Borrowing across the month end is expected when the GL names the bank date (a deposit in transit).
    if (x.when !== 'this' && !(bankWindow(r).named && d === 0)) minus.push(`${x.when === 'prior' ? 'Last' : 'Next'} month’s GL entry`);
    if (r.ap || r.module === 'AP') minus.push('An AP entry (a vendor check or refund), not a receipt');
    // One entry for several deposits is normal (a day's wires, "PayPal Grants (6)"); it's weak only
    // when they're days apart or this deposit has no line of its own in it.
    if (x.group > 1 && l.kind !== 'incoming') {
      const ls = [...(matched[m]?.byLine || [])].filter(([, y]) => y.r === r).map(([ll]) => ll.date).sort();
      const span = ls.length ? (Date.parse(ls[ls.length - 1]) - Date.parse(ls[0])) / DAY : 0;
      if (span > 2) minus.push(`One GL entry for ${x.group} deposits over ${span} days`);
      else if (!lineTie) minus.push(`One GL entry for ${x.group} deposits, none of its lines this amount`);
    }
    // Another GL entry with this amount, within a week, that nothing else matched.
    const alt = [addMonths(m, -1), m, addMonths(m, 1)].flatMap((mm) => receiptsBy[mm] || [])
      .filter((y) => y.batch !== r.batch && y.amount > 0 && Math.abs(y.amount - l.amount) < 0.005 && !matchedBatch.has(y.batch) && distance(l.date, bankWindow(y)) <= 7);
    if (alt.length && !names.agree.length) minus.push(`Could also be ${alt.slice(0, 2).map((y) => `${y.batch} ${y.desc.slice(0, 30)}`).join(', ')}${alt.length > 2 ? '…' : ''} (same amount, unmatched)`);
    const strong = names.agree.length || lineTie || plus.some((p) => /check deposit|Stripe to Stripe|names this bank date/.test(p));
    const bad = minus.some((p) => /AP entry|names .* doesn’t|Could also be/.test(p));
    const level = bad || (minus.length >= 2) ? 'low' : strong && !minus.length ? 'high' : 'medium';
    return { level, plus, minus, tie: tie ? { id: tie.id, desc: tie.d, cv: tie.cv } : null };
  }

  function monthFindings(m) {
    const rec = recs[m] || {};
    const receipts = receiptsBy[m] || null;
    const { lines, byLine } = matched[m] || { lines: [], byLine: new Map() };
    const hasStatements = !!(rec.statements?.operating || rec.statements?.incoming);
    const res = { month: m, available: !!receipts, hasStatements, lines: [], exclusions: {}, adjustments: [], covered: [], noGl: [], glOnly: [], dit: null,
      conflicts: [], suspended: [], keyBank: null };
    // Investment fees the GL booked this month (added back to the change in value when not typed).
    for (const f of glBy[m]?.investmentFees || []) {
      const x = (res.fees ||= {})[f.account] || (res.fees[f.account] = { amount: 0, batches: [] });
      x.amount = round2(x.amount + f.amount); x.batches.push(f);
    }
    // Interest the GL booked with no deposit behind it (gl.js noCashInterest).
    res.noCashInterest = glBy[m]?.noCashInterest || [];
    for (const g of glBy[m]?.investmentGl || []) {
      const x = (res.investment ||= {})[g.account] || (res.investment[g.account] = { gain: 0, batches: [] });
      x.gain = round2(x.gain + g.gain); x.batches.push(g);
    }
    // Confirmed matches that couldn't be kept: the batch is gone from the GL, or another deposit
    // has it now.
    res.pinIssues = (byLine.pinIssues || []).map((p) => ({ line: p.line, pin: p.pin, state: p.state }));
    // This month's end of a Stripe clearing link (see above): money received now, recognized later.
    if (late[m]) res.stripeLate = Object.values(late[m]);
    if (!receipts && !byLine.size && !glBy[m]?.keyReceipts) return res;

    // Hand-entered adjustments (typed, or from the workbook) already cover some of these. One
    // adjustment covers one finding of the same amount, so nothing comes out twice.
    const hand = (rec.adjustments || []).filter((a) => a.amount).map((a) => ({ a, free: true }));
    const coveredBy = (amount) => {
      const h = hand.find((x) => x.free && Math.abs(Math.abs(x.a.amount) - Math.abs(amount)) < 0.005);
      if (h) h.free = false;
      return h?.a || null;
    };
    const dismissed = rec.dismissed || {};
    // The statement rules (a matching payment out of another account, a tax refund, Fidelity
    // wording) against the GL: when the GL booked the deposit as revenue, the rule waits for a
    // person. Until then it counts as revenue, the way the GL has it.
    const rules = defaultExclusions(rec);
    const manual = manualExclusions(rec);

    for (const l of lines) {
      const x = byLine.get(l);
      const k = x ? glKind(x.r, config, names) : null;
      res.lines.push({ line: l, match: x ? { ...x.r, lines: undefined, when: x.when, group: x.group, ...k, confidence: confidenceOf(l, x, m), pin: x.pin || null,
        batchIds: (x.batches || [x.r]).map((b) => b.batch), fps: (x.batches || [x.r]).map((b) => b.fp || null) } : null });
      if (x && STRIPE.test(l.desc) && k.kind === 'revenue') (res.stripeGifts ||= []).push({ id: l.id, batch: x.r.batch, desc: x.r.desc, label: k.label });
      if (!x) {
        // Someone may already have said how it counts (revenue, or taken out and why).
        const decided = manual[l.id] ? exclusionInfo(manual[l.id]) : dismissed[l.id] ? { type: 'revenue', ...(typeof dismissed[l.id] === 'object' ? dismissed[l.id] : {}) } : null;
        if (!STRIPE.test(l.desc) && l.kind !== 'outgoing') res.noGl.push({ line: l, covered: decided ? null : coveredBy(l.amount), decided });
        continue;
      }
      if (k.kind === 'revenue' && rules[l.id] && !manual[l.id]) {
        res.conflicts.push({ line: l, rule: exclusionInfo(rules[l.id]), match: { ...x.r, ...k, when: x.when } });
        res.suspended.push(l.id);
        continue;
      }
      // Outgoing credits reach Operating only through the sweep, which the sweep rule already takes out.
      if (k.kind === 'revenue' || k.kind === 'stripe' || l.kind === 'outgoing') continue;
      const info = { type: TYPE[k.kind], note: `GL ${x.r.batch}: ${x.r.desc} — ${WHY[k.kind]} (${k.label})`, auto: true, gl: x.r.batch };
      const by = coveredBy(l.amount);
      if (by) { res.covered.push({ line: l, info, by }); continue; }
      // Someone counted it as revenue anyway: kept, so the app can say where it was taken out from.
      if (!dismissed[l.id]) res.exclusions[l.id] = info;
      else (res.overruled ||= {})[l.id] = info;
    }

    if (receipts) {
      for (const rev of receipts.filter((r) => r.amount < 0)) {
        const id = `auto-glrev-${rev.batch}`;
        // A chargeback is on the Cass statement too: the returned item comes back out as a debit.
        // (A deposit made at month end comes back on next month's statement.)
        const back = [...cassDebits(rec), ...cassDebits(recs[addMonths(m, 1)])].find((t) => Math.abs(t.amount + rev.amount) < 0.005 && Math.abs(Date.parse(t.date) - Date.parse(rev.date)) / DAY <= 14);
        const adj = { id, account: 'cassOp', type: 'not-revenue', label: `Revenue the GL took back: ${rev.desc}`, amount: rev.amount, auto: true, gl: rev.batch,
          evidence: back ? 'both' : 'gl', statement: back ? `Cass statement: ${back.date} ${back.desc} ${money2(back.amount)} out` : null,
          note: `GL ${rev.batch} (${rev.date}) moves ${round2(-rev.amount)} out of revenue (${glKind({ accounts: Object.fromEntries(Object.entries(rev.accounts).map(([a, v]) => [a, -v])) }, config, names).label}).`,
          why: 'The deposit is on a statement as revenue, but the GL took it back out — a chargeback, or a deposit reclassed to another account.',
          detail: [{ date: rev.date, amount: -rev.amount, desc: rev.desc }] };
        const by = coveredBy(rev.amount);
        if (by) res.covered.push({ adjustment: adj, by });
        else if (!dismissed[id]) res.adjustments.push(adj);
      }
      for (const r of receipts) {
        if (r.amount <= 0 || r.ap) continue;
        const k = glKind(r, config, names);
        if (k.kind === 'stripe') continue;
        const at = matchedBatch.get(r.batch);
        if (!at || at.month !== m) res.glOnly.push({ receipt: { ...r, ...k }, landed: at || null });
      }
      res.cancelled = [...(cancelledBy[m] || [])];
      // Stripe sales the GL took out of revenue (shipping, sales tax) or added (a stray transfer).
      for (const x of glBy[m]?.stripeReclass || []) {
        const net = round2(sum(Object.entries(x.accounts).filter(([a]) => config.revenueAccounts.includes(a)), ([, v]) => v));
        if (Math.abs(net) < 0.005) continue;
        const moved = Object.entries(x.accounts).filter(([a, v]) => !config.revenueAccounts.includes(a) && Math.abs(v) >= 0.005);
        const id = `auto-glstripe-${x.batch}`;
        if (dismissed[id]) continue;
        const from = clearing[m]?.[x.batch];
        if (from) {
          res.adjustments.push({ id, account: 'cassOp', type: 'timing', label: 'Stripe money received earlier, recognized as giving now', amount: net, auto: true, gl: x.batch, evidence: 'both', clearing: true,
            note: `Received ${from.date} through Stripe (${from.desc} ${money2(net)}, GL ${from.glIn}); GL ${x.batch} (${x.date}) moves it from Stripe clearing to giving`,
            why: 'Came into Cass through Stripe but wasn’t one of Stripe’s payouts (a gift through another Stripe account). The GL held it in Stripe clearing (1200) and moved it to giving this month, so it’s counted now — it was taken out as timing the month it arrived.',
            detail: [{ date: x.date, amount: net, desc: `${x.desc} — received ${from.date} (${monthLabel(from.month)})` }] });
          continue;
        }
        res.adjustments.push({ id, account: 'stripe', type: 'not-revenue', label: `Stripe, per the GL: ${x.desc}`, amount: net, auto: true, gl: x.batch,
          note: `GL ${x.batch} (${x.date}): ${moved.map(([a, v]) => `${v > 0 ? 'to' : 'from'} ${accountName(a, names)} ${round2(Math.abs(v)).toFixed(2)}`).join(', ')}`,
          why: 'Stripe’s gross includes sales the GL doesn’t count as revenue — shipping (9050) and sales tax (2042) on merchandise — and the GL sometimes adds a stray Stripe transfer to giving.',
          detail: [{ date: x.date, amount: net, desc: x.desc }] });
      }
    }
    // KeyBank: the statement only gives a total, so the GL says what went in. Money from another of
    // our accounts comes out; the rest is cash giving (the usual case).
    const key = glBy[m]?.keyReceipts;
    if (key) {
      const ins = key.filter((r) => r.amount > 0);
      for (const r of ins) {
        // What the GL counted as revenue against what was deposited. Less: part of the deposit
        // wasn't giving (a transfer, a reimbursement). More: cash gifts spent before the deposit.
        const revenue = revenueIn(r.accounts);
        const amount = round2(revenue - r.amount);
        if (Math.abs(amount) < 0.005) continue;
        const own = Object.entries(r.accounts).filter(([a, v]) => v > 0 && glKind({ accounts: { [a]: v } }, config).kind === 'transfer');
        const others = Object.entries(r.accounts).filter(([a, v]) => !config.revenueAccounts.includes(a) && Math.abs(v) >= 0.005);
        const id = `auto-glkey-${r.batch}`;
        const adj = { id, account: 'keyOp', type: amount < 0 && own.length ? 'transfer' : 'other', auto: true, gl: r.batch, amount,
          label: amount < 0 ? (own.length ? `KeyBank deposit from another of our accounts: ${r.desc}` : `KeyBank deposit that isn’t giving: ${r.desc}`) : `Cash gifts spent before they were deposited: ${r.desc}`,
          note: `GL ${r.batch} (${r.date}): deposited ${money2(r.amount)}, of which the GL counts ${money2(revenue)} as revenue; the rest went to ${others.map(([a, v]) => `${accountName(a, names)} ${money2(Math.abs(v))}`).join(', ')}.`,
          why: 'The KeyBank statement only has the total deposited; the GL shows what it was.',
          detail: [{ date: r.date, amount: Math.abs(amount), desc: r.desc }] };
        const by = coveredBy(amount);
        if (by) res.covered.push({ adjustment: adj, by });
        else if (!dismissed[id]) res.adjustments.push(adj);
      }
      res.keyBank = { glIn: round2(sum(ins, (r) => r.amount)), batches: ins };
    }
    // Wise takes its fee out of an incoming wire; the GL books the gift in full (e.g. 699,993.89
    // received, 700,000 to 4018, 6.11 fee), so the fee is added back to the Wise line.
    const wiseFees = (glBy[m]?.wiseReceipts || []).filter((r) => r.amount > 0 && revenueIn(r.accounts) > 0)
      .map((r) => ({ r, fee: round2(revenueIn(r.accounts) - r.amount) })).filter((x) => Math.abs(x.fee) >= 0.005);
    if (wiseFees.length && !dismissed['auto-glwise-fees']) {
      res.adjustments.push({ id: 'auto-glwise-fees', account: 'wise', type: 'other', label: 'Wise fees taken from incoming gifts', auto: true,
        amount: round2(sum(wiseFees, (x) => x.fee)),
        note: wiseFees.map((x) => `GL ${x.r.batch}: ${x.r.desc} — received ${money2(x.r.amount)}, booked ${money2(x.r.amount + x.fee)}`).join('; '),
        why: 'Wise pays out an incoming wire less its fee; the GL books the gift in full and the fee as an expense, so the fee is added back.',
        detail: wiseFees.map((x) => ({ date: x.r.date, amount: x.fee, desc: x.r.desc, note: `GL ${x.r.batch}: received ${money2(x.r.amount)}, booked ${money2(x.r.amount + x.fee)}` })) });
    }
    // Money given back to donors out of PayPal, from the GL's "Payment Refund" lines.
    for (const r of glBy[m]?.paypalRefunds || []) {
      const id = `auto-glpaypal-${r.batch}`;
      if (dismissed[id]) continue;
      // The PayPal statement's transaction history lists the payment back: date, payee, amount.
      const pp = rec.bankStatements?.paypal;
      const onStmt = (pp?.sent || []).find((s) => Math.abs(s.amount - r.amount) < 0.005);
      const inTotal = !onStmt && pp && Math.abs(Math.min(0, pp.paymentsSent || 0)) >= r.amount - 0.005;
      res.adjustments.push({ id, account: 'paypal', type: 'refund', label: 'PayPal: given back to donors', amount: -r.amount, auto: true, gl: r.batch,
        evidence: onStmt || inTotal ? 'both' : 'gl',
        statement: onStmt ? `PayPal statement: ${onStmt.date} ${onStmt.desc} −${money2(onStmt.amount)}` : inTotal ? `PayPal statement: “Payments sent” ${money2(pp.paymentsSent)} (attach the statement again to see each payment)` : null,
        note: `GL ${r.batch} (${r.date}) books a “Payment Refund” of ${money2(r.amount)} against 4012${onStmt ? `; the PayPal statement shows it: ${onStmt.date} ${onStmt.desc} −${money2(onStmt.amount)}` : '; on the PayPal statement it’s part of “Payments sent”'}.`,
        why: 'The PayPal statement’s “Payments received” is before any gift was given back; the GL takes refunds off revenue.',
        detail: [{ date: r.date, amount: r.amount, desc: r.desc }] });
    }
    // Revenue the GL booked with no cash this month: merchandise sold on account (collected later,
    // when the receivable is paid), or a gift moved to a liability.
    for (const x of glBy[m]?.noCashRevenue || []) {
      let amount = revenueIn(x.accounts);
      if (Math.abs(amount) < 0.005) continue;
      // OneStory prepaid rent (2033): rent received before it's earned. The part of the entry that
      // moves revenue into (or out of) the liability is timing on its own line, linked to the
      // month the money came in; whatever's left is revenue moved with no cash.
      const prepaid = round2(-(x.accounts['2033'] || 0));
      if ('4030' in x.accounts && Math.abs(prepaid) >= 0.005) {
        const pid = `auto-glprepaid-${x.batch}`;
        const into = prepaid < 0;
        const from = into ? null : Object.keys(glBy).filter((mm) => mm < m).sort().reverse()
          .find((mm) => (glBy[mm]?.noCashRevenue || []).some((y) => (y.accounts['2033'] || 0) > 0.005));
        const padj = { id: pid, account: 'osmOp', type: 'timing', auto: true, gl: x.batch, amount: prepaid, evidence: 'gl',
          label: into ? 'Prepaid rent received, not yet earned (2033)' : `Prepaid rent earned (2033)${from ? `, received ${monthLabel(from)}` : ''}`,
          note: `GL ${x.batch} (${x.date}): ${into ? 'moves' : 'releases'} ${money2(Math.abs(prepaid))} ${into ? 'from rental income into' : 'from'} ${accountName('2033', names)}${into ? '' : ' into rental income'}.`,
          why: into ? 'The money came in this month, but it’s rent for a later period: the GL holds it as prepaid rent (a liability) until it’s earned.'
            : 'Rent received in an earlier month, recognized now: the GL takes it out of prepaid rent with no cash moving this month.',
          detail: [{ date: x.date, amount: Math.abs(prepaid), desc: x.desc }] };
        if (!dismissed[pid]) res.adjustments.push(padj);
        amount = round2(amount - prepaid);
        if (Math.abs(amount) < 0.005) continue;
      }
      const id = `auto-glnocash-${x.batch}`;
      const onAccount = Object.keys(x.accounts).some((a) => /^12[1-9]\d$/.test(a));
      // OneStory Marshall's rent (4030) belongs with its own account's line.
      const adj = { id, account: '4030' in x.accounts ? 'osmOp' : 'cassOp', type: onAccount ? 'timing' : 'other', auto: true, gl: x.batch, amount,
        label: onAccount ? `Merchandise sold on account: ${x.desc}` : `Revenue the GL moved with no cash: ${x.desc}`,
        note: `GL ${x.batch} (${x.date}): ${Object.entries(x.accounts).map(([a, v]) => `${accountName(a, names)} ${v > 0 ? 'Cr' : 'Dr'} ${money2(Math.abs(v))}`).join(', ')}`,
        why: onAccount ? 'Booked as revenue when sold; the cash comes in later, when the receivable is paid (that deposit is then taken out as recognized in an earlier month).'
          : 'The GL changed revenue without any money moving this month.',
        detail: [{ date: x.date, amount: Math.abs(amount), desc: x.desc }] };
      const by = coveredBy(amount);
      if (by) res.covered.push({ adjustment: adj, by });
      else if (!dismissed[id]) res.adjustments.push(adj);
    }
    // A Cass deposit the GL booked as more revenue than the cash that came in. The rest of the
    // entry is a debit that isn't cash: a fee the giving platform kept (Overflow — Dr 8070; the
    // GL grosses up the gift and books the fee as an expense), or revenue released from a
    // liability (Dr 2052: a gift held back earlier, recognized now). Either way that part of the
    // revenue never reached the bank. (KeyBank and Wise have their own, above.)
    for (const r of receipts || []) {
      if (r.amount <= 0 || r.ap) continue;
      const debits = Object.entries(r.accounts).filter(([a, v]) => v < 0 && !config.revenueAccounts.includes(a));
      if (!debits.length || revenueIn(r.accounts) < 0.005) continue;
      for (const [acct, v] of debits) {
        const amount = round2(-v);
        const fee = /^8/.test(acct);
        const id = `auto-gl${fee ? 'fee' : 'release'}-${r.batch}-${acct}`;
        if (dismissed[id]) continue;
        // The earlier entry that put it in the liability, when there is one (January: a 3,018.70
        // Overflow gift moved to 2052, recognized in June).
        const earlier = fee ? null : Object.keys(glBy).filter((mm) => mm < m).sort().reverse()
          .flatMap((mm) => (glBy[mm]?.noCashRevenue || []).map((x) => ({ ...x, month: mm })))
          .find((x) => Math.abs((x.accounts[acct] || 0) - amount) < 0.005);
        const adj = { id, account: 'cassOp', type: fee ? 'other' : 'timing', auto: true, gl: r.batch, amount, evidence: 'gl', // the statement shows the net deposit only
          label: fee ? `Fees kept by the giving platform: ${r.desc}` : `Revenue released from ${accountName(acct, names)}: ${r.desc}`,
          note: `GL ${r.batch} (${r.date}): deposit ${money2(r.amount)}, revenue ${money2(revenueIn(r.accounts))}, ${accountName(acct, names)} Dr ${money2(amount)}${earlier ? ` — held back by GL ${earlier.batch} (${earlier.date}, ${monthLabel(earlier.month)})` : ''}`,
          why: fee ? 'The platform (Overflow and the like) sends the gift less its fee. The GL books the whole gift as revenue and the fee as an expense (8070), so revenue is more than the deposit by the fee.'
            : 'Part of this entry’s revenue comes from a liability, not from the deposit — a gift held back earlier and recognized now. That part never reached the bank this month.',
          detail: [{ date: r.date, amount, desc: r.desc }] };
        const by = coveredBy(amount);
        if (by) res.covered.push({ adjustment: adj, by });
        else res.adjustments.push(adj);
      }
    }
    res.dit = ditFor(m, rec);
    return res;
  }

  // Deposits in transit at the end of month m, from the GL. Each row is a GL deposit near month
  // end; it counts when it's in transit — booked in m but in the bank in m+1 (plus), or in the
  // bank in m but booked in m+1 (minus). The statements decide where they can; otherwise the date
  // in the batch description suggests it, and a person confirms (rec.ditGl[batch] = { in }).
  function ditFor(m, rec) {
    const receipts = receiptsBy[m];
    if (!receipts) return null;
    const next = addMonths(m, 1);
    const end = lastDayOfMonth(m);
    const nextEarly = `${next}-10`;
    const nearEnd = new Date(Date.parse(end) - 4 * DAY).toISOString().slice(0, 10);
    const thisIn = !!(recs[m]?.statements?.operating);
    const nextIn = !!(recs[next]?.statements?.operating);
    const choices = rec.ditGl || {};
    const rows = [];
    // settled: the statements say where it belongs. A person can still override it (overridden).
    const add = (r, sign, suggested, evidence, { flagged = false, settled = false } = {}) => {
      const choice = choices[r.batch];
      const counts = choice ? !!choice.in : suggested;
      rows.push({ batch: r.batch, glMonth: sign > 0 ? m : next, date: r.date, bank: bankWindow(r), desc: r.desc, amount: r.amount, sign,
        suggested, evidence, settled, flagged: flagged && !choice, choice: choice || null, counts, overridden: !!choice && counts !== suggested });
    };
    for (const r of receipts) {
      if (r.amount <= 0) continue;
      const k = glKind(r, config);
      if (k.kind !== 'revenue') continue;
      const at = matchedBatch.get(r.batch);
      const w = bankWindow(r);
      // Mid-month deposits the statements don't show aren't a month-end question; they're listed
      // with the GL deposits not found on a statement.
      if (!at && w.to < nearEnd) continue;
      if (at?.month === m) { add(r, 1, false, `On the ${short(m)} statement, ${at.lines[0].date}`, { settled: true }); continue; }
      if (at?.month === next) { add(r, 1, true, `Cleared ${at.lines[0].date} on the ${short(next)} statement`, { settled: true }); continue; }
      // Not found on a statement (or the statements aren't in yet): the GL's bank date suggests it.
      const late = w.to > end;
      add(r, 1, late, `${w.named ? `The GL says deposited ${w.from}` : `Booked ${r.date}`}${thisIn ? `; not on the ${short(m)} statement` : ''}${nextIn ? `; not on the ${short(next)} statement` : ''}`,
        { flagged: true });
    }
    for (const r of receiptsBy[next] || []) {
      if (r.amount <= 0) continue;
      const k = glKind(r, config);
      if (k.kind !== 'revenue') continue;
      const at = matchedBatch.get(r.batch);
      const w = bankWindow(r);
      if (at?.month === m) { add(r, -1, true, `On the ${short(m)} statement ${at.lines[0].date}, but booked in the GL in ${short(next)}`, { settled: true }); continue; }
      if (at) continue; // in the bank the month the GL has it
      // Early next month: usually next month's own deposit, but it could have been in the bank by
      // month end. Worth a look while next month's statement isn't in.
      if (w.from <= end) add(r, -1, !thisIn, `The GL says deposited ${w.from}, but booked it in ${short(next)}${thisIn ? `; not on the ${short(m)} statement` : ''}`, { flagged: true });
      else if (!thisIn && w.from <= nextEarly) add(r, -1, false, `The GL says deposited ${w.from}, in ${short(next)}`, { flagged: true });
    }
    const total = round2(sum(rows.filter((x) => x.counts), (x) => x.sign * x.amount));
    // Typed deposits in transit still count, unless the GL already has the same one.
    const glAmounts = rows.filter((x) => x.counts).map((x) => x.sign * x.amount);
    const manual = (rec.dit || []).filter((d) => !String(d.id || '').startsWith('imp-')).map((d) => {
      const i = glAmounts.findIndex((a) => Math.abs(a - (d.amount || 0)) < 0.005);
      if (i >= 0) glAmounts.splice(i, 1);
      return { d, duplicate: i >= 0 };
    });
    const workbook = (rec.dit || []).filter((d) => String(d.id || '').startsWith('imp-'));
    return {
      rows, glTotal: total, manual,
      total: round2(total + sum(manual.filter((x) => !x.duplicate), (x) => x.d.amount)),
      workbookTotal: workbook.length ? round2(sum(workbook, (d) => d.amount)) : null,
      flagged: rows.filter((x) => x.flagged).length, thisIn, nextIn,
    };
  }
}

const short = (m) => new Date(`${m}-15T00:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
