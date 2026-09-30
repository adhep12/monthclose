// Proof of cash for one month: cash that hit the banks, adjusted for money that isn't revenue and
// for timing, compared with revenue and interest in the GL.
//
// A month record (collection poc-months, key 'YYYY-MM'):
//   bank:        { [source]: { rev, int, note } }   typed from statements (Cass Operating comes
//                                                   from the parsed statement when attached)
//   statements:  { operating, incoming, outgoing }  parsed Cass statements (see cass.js)
//   excluded:    { [txnId]: note }                  deposits marked as not revenue
//   adjustments: [{ id, label, amount, note }]      other adjustments, signed as they apply
//   dit:         [{ id, amount, note }]             checks deposited in transit at month end
//   timing:      { accrued, realizedPrior, restricted, merchAR }
//   gl:          { revenue, interest, note }        typed override of the GL figures

import { classifyWiseItems, wiseTotals, wiseTies, wiseSender, paypalRevenue, paypalTies } from './banks.js';
import { stripeRevenue } from './stripe.js';
import { round2, sum } from '../money.js';

// gl = the cash account in Acumatica whose month-end balance the statement's ending balance
// should match. revenueGl = the revenue line on the statement of activities it feeds, where the
// match is one-to-one.
export const BANK_SOURCES = [
  { id: 'cassOp', label: 'Cass Operating', gl: '1100', hint: 'Operating, Incoming and Outgoing statements' },
  { id: 'stripe', label: 'Stripe', gl: '1015', revenueGl: '4015', hint: 'Stripe monthly statement CSV' },
  { id: 'paypal', label: 'PayPal', gl: '1012', revenueGl: '4012' },
  { id: 'wise', label: 'Wise', gl: '1013' },
  { id: 'keyOp', label: 'KeyBank Operating', gl: '1061' },
  { id: 'keyMM', label: 'KeyBank Money Market', gl: '1060' },
  { id: 'ics', label: 'Cass Money Market / ICS', gl: '1160', hint: 'ICS monthly statement PDF' },
  { id: 'cd', label: 'Cass CD (CDARS)', gl: '1150', hint: 'From the CD schedule' },
  { id: 'delap', label: 'Delap Fidelity Investment', gl: '1170', method: 'balance' },
  { id: 'tschetter', label: 'Tschetter Group', gl: '1171', method: 'balance' },
];

// Investment accounts: the month's gain/interest is the change in value, less money moved in
// (or plus money taken out). Last month's ending value comes from last month's proof of cash.
export function balanceMethodInterest(b = {}, priorB = {}) {
  const prior = b.priorEnding ?? priorB?.ending ?? null;
  if (b.ending == null || prior == null) return null;
  // Fees the manager takes out of the account are booked as an expense, with the gain grossed up
  // by the same amount — so they're added back here.
  return round2(b.ending - prior - (b.netDeposits || 0) + (b.fees || 0));
}

export const ADJUSTMENT_TYPES = {
  transfer: 'Transfer between accounts',
  timing: 'Timing',
  refund: 'Refund / return',
  'not-revenue': 'Deposit that isn’t revenue',
  'prior-period': 'Recognized in another month',
  other: 'Other',
};

export const DEFAULT_POC_CONFIG = {
  // GL revenue = credits less debits in these accounts. CC rewards (4077) are included — the
  // Divvy rewards land in Cass Operating and count as bank revenue.
  revenueAccounts: ['4010', '4012', '4015', '4017', '4018', '4075', '4077', '4081', '4083', '4084', '4085'],
  // GL interest = interest income plus investment gain/loss.
  interestAccounts: ['4050', '8999'],
};

const SWEEP_IN = /Trnsfr from Checking/i;
const SWEEP_OUT = /Trnsfr to Checking/i;
const INCOMING_ACCT = '5892';
const OUTGOING_ACCT = '3410';
const money2 = (v) => (v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const STRIPE = /^STRIPE/i;
// Money from the Delap Fidelity account arriving in Cass (Fidelity's MoneyLine transfers).
export const FIDELITY = /FID BKG SVC|MONEYLINE/i;
// Deposits that are almost never revenue; excluded by default, and anyone can put them back.
const AUTO_EXCLUDE = /TAX ?REFUND|IRS TREAS|US TREASURY/i;

export function isSweep(t) {
  return SWEEP_IN.test(t.desc) || SWEEP_OUT.test(t.desc);
}

// ---- Deposits that aren't revenue --------------------------------------------------------
// rec.excluded[id] = { type: 'transfer' | 'not-revenue', note, auto }   (older records: a string
// note, meaning not-revenue). rec.dismissed[id] = true when someone un-ticks an automatic one,
// so re-attaching a statement doesn't tick it again.

export function exclusionInfo(v) {
  if (v == null) return null;
  return typeof v === 'string' ? { type: 'not-revenue', note: v } : v;
}

// Accept either a month record or (older callers) its Cass statements object.
// Wise items as they should be read — statements attached before the sign fix are re-read here.
const wiseItems = (rec) => classifyWiseItems(structuredClone(rec.bankStatements?.wise?.items || []));
// Whether an attached statement's transactions account for its whole balance change. Wise
// statements attached before the reader handled wrapped descriptions are missing lines, and this
// is how they show up (re-attach them).
export function statementTies(rec, id) {
  const b = rec.bankStatements?.[id];
  if (!b) return true;
  if (id === 'wise' && b.items?.length) return wiseTies(wiseItems(rec), b.ending);
  if (id === 'paypal') return paypalTies(b) !== false;
  return b.ties !== false;
}
// Money sent to, or received from, another of our own accounts.
const OWN = /bible ?project|cass commercial|\bcass\b/i;

const asRec = (x) => (x && (x.operating || x.incoming || x.outgoing) && !x.statements ? { statements: x } : x || {});

// Money arriving that counts as revenue unless someone marks it: Cass Operating and Incoming
// credits (not the internal sweeps, not Stripe — that's handled as its own line) and money
// received into Wise.
export function reviewableDeposits(recIn) {
  const rec = asRec(recIn);
  const st = rec.statements || {};
  const out = [];
  for (const kind of ['operating', 'incoming']) {
    const s = st[kind];
    if (!s) continue;
    for (const t of s.transactions) if (t.section === 'credit' && !isSweep(t) && !STRIPE.test(t.desc)) out.push({ ...t, kind, account: 'cassOp' });
  }
  wiseItems(rec).forEach((it, i) => {
    if (it.kind === 'received') out.push({ id: it.id || `wise-${i}`, date: it.date, amount: Math.abs(it.amount), desc: it.desc, kind: 'wise', account: 'wise' });
  });
  return out;
}
export const excludableCredits = reviewableDeposits;

// Money leaving one of our accounts — the other half of a transfer.
export function outgoingItems(recIn) {
  const rec = asRec(recIn);
  const st = rec.statements || {};
  const out = [];
  for (const kind of ['operating', 'incoming', 'outgoing']) {
    for (const t of st[kind]?.transactions || []) if (t.section !== 'credit' && !isSweep(t)) out.push({ ...t, account: 'cassOp', kind });
  }
  wiseItems(rec).forEach((it, i) => { if (it.kind === 'sent') out.push({ id: it.id || `wise-${i}`, date: it.date, amount: Math.abs(it.amount), desc: it.desc, account: 'wise' }); });
  (rec.ics?.items || []).forEach((it) => { if (it.withdrawal) out.push({ date: it.date, amount: it.amount, desc: `ICS ${it.type}`, account: 'ics' }); });
  return out;
}

// The same transfer seen from both ends. Sent to ourselves by name, a wire fee or a day or two
// in transit is allowed for; otherwise the amounts must match to the cent within 5 days.
const sameMoney = (a, b, own) => (own
  ? Math.abs(a.amount - b.amount) <= Math.max(0.005, Math.min(100, a.amount * 0.0005)) && daysApart(a.date, b.date) <= 7
  : Math.abs(a.amount - b.amount) < 0.005 && daysApart(a.date, b.date) <= 5);
const daysApart = (a, b) => (a && b ? Math.abs(Date.parse(a) - Date.parse(b)) / 86400000 : 99);

// Deposits that are really money moving between our own accounts: the same amount (at least
// $1,000) left another of our accounts within 5 days, or Wise shows it came from BibleProject.
export function detectTransfers(recIn) {
  const rec = asRec(recIn);
  const outs = outgoingItems(rec);
  const found = {};
  for (const d of reviewableDeposits(rec)) {
    if (d.account === 'wise' && /bible ?project/i.test(wiseSender(d.desc))) { found[d.id] = { type: 'transfer', note: 'Sent from our own account', auto: true }; continue; }
    if (d.account !== 'wise' && FIDELITY.test(`${d.desc} ${d.detail || ''}`)) { found[d.id] = { type: 'transfer', note: 'From the Delap Fidelity account', auto: true }; continue; }
    const m = outs.find((o) => o.account !== d.account && sameMoney(o, d, OWN.test(o.desc)));
    // Under $1,000 a same-amount match could be coincidence, unless the money was sent to us by name.
    if (m && (d.amount >= 1000 || OWN.test(m.desc))) found[d.id] = { type: 'transfer', note: `Matches ${m.date} ${m.desc} leaving ${m.account === 'cassOp' ? 'Cass' : m.account}`, auto: true };
  }
  return found;
}

// Every Wise payment out, and whether it turned up as a deposit in another of our accounts. Money
// sent to ourselves should land somewhere; if it lands in Cass it's taken out of revenue there.
export function wiseOutgoingCheck(recIn) {
  const rec = asRec(recIn);
  const deposits = reviewableDeposits(rec).filter((d) => d.account !== 'wise');
  return wiseItems(rec).filter((it) => it.kind === 'sent').map((it) => {
    const amount = Math.abs(it.amount);
    const toOwn = OWN.test(it.desc);
    const landed = deposits.find((d) => sameMoney({ amount, date: it.date }, d, toOwn) && (amount >= 1000 || toOwn));
    const excluded = landed ? effectiveExclusions(rec)[landed.id] : null;
    const state = landed ? (excluded?.type === 'transfer' ? 'transfer' : 'counted') : toOwn ? 'missing' : 'paid';
    return { ...it, amount, toOwn, landed, state };
  });
}

// What's excluded right now: automatic findings (re-worked out from the statements every time, so
// attaching statements in any order gets the same answer) plus anything someone set by hand.
// deposits: this month's GL deposit check (gl-deposits.js), when the GL register is loaded.
// Automatic findings are worked out fresh; rec.excluded keeps only what a person set (older
// records also stored automatic ones, marked auto, which are ignored here). A rule the GL
// contradicts (deposits.suspended) waits for a person to decide.
export function manualExclusions(rec) {
  return Object.fromEntries(Object.entries(rec.excluded || {}).filter(([, v]) => !exclusionInfo(v)?.auto));
}
export function effectiveExclusions(recIn, deposits = null) {
  const rec = asRec(recIn);
  const rules = defaultExclusions(rec);
  for (const id of deposits?.suspended || []) delete rules[id];
  return { ...rules, ...(deposits?.exclusions || {}), ...manualExclusions(rec) };
}

// A wire account that sweeps into Operating but whose statement isn't attached: its deposits
// (Wise transfers, DAF gifts, refunds) can't be checked, and a transfer looks like revenue.
export function missingStatements(rec) {
  const st = rec.statements || {};
  const op = st.operating;
  const out = [];
  if (!op) {
    if (st.incoming || st.outgoing) out.push({ kind: 'operating', text: 'The Operating (…5884) statement isn’t attached. Cass bank activity is Operating’s deposits, so the month can’t be worked out without it.' });
    return out;
  }
  const swept = (acct) => op.transactions.some((t) => isSweep(t) && new RegExp(`${acct}\\b`).test(t.desc));
  if (!st.incoming && swept(INCOMING_ACCT)) out.push({ kind: 'incoming', text: 'Operating has sweeps from Incoming Wires (…5892), but that statement isn’t attached. Wires in there (Wise transfers, DAF gifts, refunds) can’t be checked, so a transfer would count as revenue.' });
  if (!st.outgoing && swept(OUTGOING_ACCT)) out.push({ kind: 'outgoing', text: 'Operating has sweeps from Outgoing Wires (…3410), but that statement isn’t attached. What landed there (refunds, Fidelity transfers) can’t be checked.' });
  return out;
}

// Delap Fidelity money that reached Cass this month — a withdrawal from Delap, so it's added back
// when working out Delap's gain, and a transfer (not revenue) on the Cass side.
export function fidelityTransfers(recIn) {
  const rec = asRec(recIn);
  const st = rec.statements || {};
  const items = [];
  for (const kind of ['operating', 'incoming', 'outgoing']) {
    for (const t of st[kind]?.transactions || []) if (t.section === 'credit' && !isSweep(t) && FIDELITY.test(`${t.desc} ${t.detail || ''}`)) items.push({ ...t, kind });
  }
  return { items, total: round2(sum(items, (t) => t.amount)) };
}

export function defaultExclusions(recIn) {
  const rec = asRec(recIn);
  const ex = {};
  for (const t of reviewableDeposits(rec)) {
    if (AUTO_EXCLUDE.test(`${t.desc} ${t.detail || ''}`)) ex[t.id] = { type: 'not-revenue', note: 'Tax refund — not revenue (excluded automatically)', auto: true };
  }
  Object.assign(ex, detectTransfers(rec));
  for (const id of Object.keys(rec.dismissed || {})) delete ex[id];
  return ex;
}

// Adjustments that come straight off the statements. Each carries the account it belongs to.
export function statementAdjustments(rec, deposits = null) {
  const st = rec.statements || {};
  const adj = [];
  if (rec.stripe?.disputes) {
    adj.push({ id: 'auto-stripe-disputes', account: 'stripe', type: 'refund', label: 'Stripe disputes', amount: round2(rec.stripe.disputes), auto: true,
      note: `Stripe CSV “Disputes” gross ${money2(rec.stripe.disputes)} — charges donors disputed, taken back by Stripe. The GL books them against 4015.`,
      why: 'Stripe’s payments less refunds still includes charges donors later disputed; the GL takes them off revenue.',
      detail: [{ date: `${rec.month}-01`.slice(0, 10), amount: -rec.stripe.disputes, desc: 'Stripe CSV: Disputes, gross amount' }] });
  }
  if (st.operating) {
    // Gifts that arrived through someone else's Stripe account stay in revenue.
    const split = stripeSplit(rec, deposits);
    const stripe = split.payouts;
    for (const t of split.late) {
      adj.push({ id: `auto-stripelate-${t.id}`, account: 'cassOp', type: 'timing', label: 'Stripe money the GL recognizes as giving later', amount: -t.amount, auto: true, gl: t.late.glIn, evidence: 'both',
        note: `Not one of Stripe’s payouts: GL ${t.late.glIn} holds it in Stripe clearing; GL ${t.late.to.batch} (${t.late.to.date}) moves it to giving`,
        why: 'Came into Cass through Stripe but wasn’t one of Stripe’s payouts (a gift through another Stripe account). The GL held it in Stripe clearing (1200) and recognizes it as giving in a later month, so it comes out now and is counted then.',
        detail: [{ id: t.id, date: t.date, amount: t.amount, desc: t.desc, note: `${t.desc} — the GL recognizes it as giving on ${t.late.to.date} (${t.late.to.batch})` }] });
    }
    if (stripe.length) {
      adj.push({ id: 'auto-stripe', account: 'cassOp', type: 'transfer', label: 'Stripe transfers into Cass', amount: -round2(sum(stripe, (t) => t.amount)), auto: true,
        detail: stripe.map((t) => ({ id: t.id, date: t.date, amount: t.amount, desc: t.desc })),
        why: 'Money moving from Stripe to Cass — Stripe revenue is already counted on the Stripe line.' });
    }
  }
  // The wire accounts reach Operating only through the daily sweeps, so what they add to
  // Operating's credits is exactly the "Trnsfr from Checking Acct Ending in …" lines.
  const sweepsFrom = (acct) => (st.operating?.transactions || []).filter((t) => t.section === 'credit' && SWEEP_IN.test(t.desc) && new RegExp(`${acct}\\b`).test(t.desc));
  if (st.incoming) {
    // Every Incoming deposit is revenue. Operating only sees what was swept across — short by
    // anything paid out of Incoming first (an insurance premium, say) or still sitting there.
    const deposits = st.incoming.transactions.filter((t) => t.section === 'credit' && !isSweep(t));
    const paidOut = st.incoming.transactions.filter((t) => t.section !== 'credit' && !isSweep(t));
    const swept = st.operating ? round2(sum(sweepsFrom(INCOMING_ACCT), (t) => t.amount)) : null;
    const amount = swept == null ? round2(sum(paidOut, (t) => t.amount)) : round2(sum(deposits, (t) => t.amount) - swept);
    adj.push({ id: 'auto-incoming', account: 'cassOp', type: 'other', label: 'Incoming Wires — deposits not swept into Operating', amount, auto: true,
      detail: paidOut.map((t) => ({ date: t.date, amount: t.amount, desc: t.desc, note: 'Paid out of Incoming before the sweep' })),
      why: `Incoming deposits ${money2(sum(deposits, (t) => t.amount))}${swept == null ? '' : `, swept into Operating ${money2(swept)}`}. The gap — payments made out of Incoming, or money not yet swept — is revenue Operating never saw, so it’s added back.` });
  }
  if (st.operating) {
    // Money landing in Outgoing (refunds, Fidelity transfers) isn't revenue. Most of it just
    // shrinks what Operating sends over; only a day that ends with Outgoing in credit sweeps back
    // into Operating's credits, and that's what comes out.
    const back = sweepsFrom(OUTGOING_ACCT);
    const landed = (st.outgoing?.transactions || []).filter((t) => t.section === 'credit' && !isSweep(t));
    if (back.length || landed.length) {
      adj.push({ id: 'auto-outgoing', account: 'cassOp', type: 'refund', label: 'Outgoing Wires — swept back into Operating', amount: -round2(sum(back, (t) => t.amount)) || 0, auto: true,
        detail: back.map((t) => ({ date: t.date, amount: t.amount, desc: t.desc,
          note: landed.filter((x) => x.date <= t.date && daysApart(x.date, t.date) <= 3).map((x) => `${x.desc} ${money2(x.amount)}`).join(', ') })),
        why: st.outgoing
          ? `${money2(sum(landed, (t) => t.amount))} landed in Outgoing${landed.length ? ` (${landed.map((x) => `${x.date} ${x.desc} ${money2(x.amount)}`).join('; ')})` : ''}. Only ${money2(sum(back, (t) => t.amount))} of it swept back into Operating’s credits; the rest reduced Operating’s transfers out.`
          : `${money2(sum(back, (t) => t.amount))} swept back into Operating from Outgoing. The Outgoing statement isn’t attached, so what landed there is taken from the GL where it can be.` });
    }
  }
  const reviewable = reviewableDeposits(rec);
  // Where each exclusion's evidence comes from: a statement rule (the matching payment out of
  // another account, the wording), the GL, both, or a person.
  const rules = defaultExclusions(rec);
  for (const id of deposits?.suspended || []) delete rules[id];
  const glEx = deposits?.exclusions || {};
  const manual = manualExclusions(rec);
  for (const [id, v] of Object.entries(effectiveExclusions(rec, deposits))) {
    const t = reviewable.find((x) => x.id === id);
    const info = exclusionInfo(v);
    if (!t || !info) continue;
    const transfer = info.type === 'transfer';
    const what = transfer ? 'Transfer between accounts' : info.type === 'prior-period' ? 'Recognized in another month' : 'Not revenue';
    const rule = exclusionInfo(rules[id]), gl = exclusionInfo(glEx[id]);
    // The statement's own wording can say what it is: a named benefits/insurance/tax payer, or for a
    // transfer, us as the sender ("From BibleProject Via WISE").
    const words = `${t.desc} ${t.detail || ''}`;
    const named = NAMED_PAYER.test(words) || (info.type === 'transfer' && FROM_US.test(words));
    let evidence, note = info.note;
    if (manual[id]) { evidence = 'typed'; if (gl) note = `${info.note || ''}${info.note ? ' · ' : ''}the GL agrees: ${gl.note}`; }
    else if (rule && gl) { evidence = 'both'; note = `${rule.note} · the GL agrees: ${gl.note}`; }
    else if (rule) evidence = 'statement';
    else if (gl && named) { evidence = 'both'; note = `The statement says so (${[t.desc, t.detail].filter(Boolean).join(' — ')}) · the GL agrees: ${gl.note}`; }
    else evidence = 'glWhat';
    adj.push({ id: `${transfer ? 'auto-tr-' : 'auto-ex-'}${id}`, account: t.account, type: info.type, label: `${what}: ${t.desc}`,
      amount: -t.amount, auto: true, note, gl: info.gl, evidence, detail: [{ date: t.date, amount: t.amount, desc: t.desc, note }] });
  }
  // From the GL: revenue it took back, Stripe reclasses, fees, refunds, revenue with no cash.
  for (const a of deposits?.adjustments || []) adj.push({ evidence: 'gl', ...a });
  for (const a of adj) if (!a.evidence) a.evidence = 'statement';
  return adj;
}

// Where an adjustment's evidence comes from, for anyone checking it.
export const EVIDENCE = {
  statement: { label: 'Statement', hint: 'The bank statement (or Stripe / PayPal / Wise report) shows it and says what it is.' },
  both: { label: 'Statement + GL', hint: 'The statement shows it, and the GL books it the same way.' },
  glWhat: { label: 'Statement amount · GL says what', hint: 'The deposit and its amount are on the statement, but the statement doesn’t say who or what it was (a check deposit, say). The GL batch does — vouch it to the check or deposit slip.' },
  gl: { label: 'GL', hint: 'Only the GL shows it — a book entry with no bank document behind it (a reclass, a fee netted out, cash spent before deposit).' },
  typed: { label: 'Typed', hint: 'Entered by a person, with their note.' },
};
// Payers whose name on the statement says what a deposit is: benefits refunds, payroll credits,
// insurance and expense reimbursements, tax refunds.
const FROM_US = /\bfrom bible ?project\b|^bible ?project\/|\bBP WISE\b/i;
const NAMED_PAYER = /WEX COBRA|ADP (WAGE|TAX)|CIGNA|DIVVY REIMBURSEM|PLANE\/REFUND|TAX ?REFUND|IRS TREAS|US TREASURY|FID BKG SVC|MONEYLINE/i;

// ---- Stripe payouts vs Cass --------------------------------------------------------------
// What Stripe says it paid out in the month (monthly CSV) should equal the STRIPE/TRANSFER
// credits on the Cass Operating statement. A payout at month end can land in Cass the next
// month, so a difference can be explained (with a note) — the explanation is tied to the exact
// difference, so it flags again if either number changes.
// Each Stripe transfer into Cass Operating is one of our payouts (money moving from Stripe — a
// transfer) or a gift paid through someone else's Stripe account (Every.org), which stays in
// revenue. The GL says which (a transfer it books as revenue is a gift); a person can say
// otherwise either way: rec.stripeAs[id] = { as: 'payout' | 'gift', by, at }.
export function stripeSplit(recIn, deposits = null) {
  const rec = asRec(recIn);
  const all = (rec.statements?.operating?.transactions || []).filter((t) => t.section === 'credit' && STRIPE.test(t.desc));
  const gl = Object.fromEntries((deposits?.stripeGifts || []).map((g) => [g.id, g]));
  const lateBy = Object.fromEntries((deposits?.stripeLate || []).map((x) => [x.id, x]));
  const payouts = [], gifts = [], late = [];
  for (const t of all) {
    const by = rec.stripeAs?.[t.id] || null;
    // Not a payout, and the GL recognizes it in a later month: timing (see gl-deposits.js).
    if (lateBy[t.id] && !by) { late.push({ ...t, late: lateBy[t.id] }); continue; }
    const gift = by ? by.as === 'gift' : !!gl[t.id];
    (gift ? gifts : payouts).push({ ...t, gl: gl[t.id] || null, by });
  }
  return { payouts, gifts, late };
}

export function stripePayoutCheck(rec, deposits = null) {
  const op = rec.statements?.operating;
  const all = op ? op.transactions.filter((t) => t.section === 'credit' && STRIPE.test(t.desc)) : null;
  // Transfers someone chose to leave out of this check (small Stripe payments that aren't payouts).
  // They still come out of Cass deposits as Stripe money; only the comparison skips them. A gift
  // through someone else's Stripe account (per the GL) is left out too, and stays in revenue.
  const split = stripeSplit(rec, deposits);
  const gifts = Object.fromEntries(split.gifts.map((g) => [g.id, { note: g.by ? `A gift, not a Stripe payout — counted as revenue by ${g.by.by || 'someone'}` : `A gift, not a Stripe payout — the GL books it as revenue: ${g.gl.batch} ${g.gl.desc} (${g.gl.label})`, gift: true, by: g.by?.by || 'GL' }]));
  for (const t of split.late) gifts[t.id] = { note: `Not a Stripe payout — the GL recognizes it as giving on ${t.late.to.date} (${t.late.to.batch}); timing`, gift: true, late: true, by: 'GL' };
  const ignoredBy = { ...(rec.stripeIgnored || {}), ...gifts };
  const transfers = all ? all.filter((t) => !ignoredBy[t.id]) : null;
  const ignored = all ? all.filter((t) => ignoredBy[t.id]).map((t) => ({ ...t, ignored: ignoredBy[t.id] })) : [];
  const cass = transfers ? round2(sum(transfers, (t) => t.amount)) : null;
  const csv = rec.stripe ? round2(rec.stripe.payouts || 0) : null;
  const base = { cass, csv, transfers: transfers || [], ignored, explained: rec.stripeCheck || null };
  if (cass == null || csv == null) return { ...base, state: 'incomplete', diff: null };
  const diff = round2(cass - csv);
  if (Math.abs(diff) < 0.005) return { ...base, state: 'match', diff };
  if (rec.stripeCheck?.diff === diff) return { ...base, state: 'explained', diff };
  // A hint for the usual cause: transfers in the first days of the month are often last
  // month's payouts arriving late.
  const early = (transfers || []).filter((t) => Number(t.date.slice(8, 10)) <= 3);
  return { ...base, state: 'mismatch', diff, early };
}

export function glFigures({ glActivity, tb, soa = null, month, config = DEFAULT_POC_CONFIG }) {
  // Net debit per account for the month: from a GL register upload, or failing that a TB for
  // the same period (its Debit/Credit columns are the period's activity), or failing that the
  // statement of activities (whole dollars, totals only).
  let net = null, source = null;
  if (!glActivity?.accounts && !(tb && tb.month === month) && soa) {
    return { source: `Statement of activities (${soa.fileName || 'upload'})`, revenue: {}, interest: {}, revenueTotal: soa.revenueTotal, interestTotal: soa.interestTotal, soaOnly: true };
  }
  if (glActivity?.accounts) { net = glActivity.accounts; source = `GL register (${glActivity.fileName || 'upload'})`; }
  else if (tb && tb.month === month) {
    net = Object.fromEntries(Object.entries(tb.accounts).map(([a, x]) => [a, x.debit - x.credit]));
    source = `Trial balance ${tb.period}`;
  }
  if (!net) return null;
  const pick = (list) => Object.fromEntries(list.map((a) => [a, round2(-(net[a] || 0))]));
  const revenue = pick(config.revenueAccounts);
  const interest = pick(config.interestAccounts);
  return { source, revenue, interest, revenueTotal: round2(sum(Object.values(revenue))), interestTotal: round2(sum(Object.values(interest))) };
}

// Figures that come from an attached statement (or the CD schedule) rather than being typed.
export function autoFigures(rec, cd = null, prior = null, deposits = null) {
  const st = rec.statements || {};
  const auto = {};
  for (const [id, b] of Object.entries(rec.bankStatements || {})) {
    // An investment statement gives the ending value (in rec.bank); its gain is worked out below.
    if (BANK_SOURCES.find((s) => s.id === id)?.method === 'balance') continue;
    const t = id === 'wise' && b.items?.length ? wiseTotals(wiseItems(rec))
      : id === 'paypal' ? { revenue: paypalRevenue(b), interest: b.interest } : { revenue: b.revenue, interest: b.interest };
    auto[id] = { rev: t.revenue, int: t.interest, ending: b.ending, from: `${b.fileName || 'statement'}`, by: b.attachedBy, at: b.attachedAt };
  }
  for (const s of BANK_SOURCES.filter((x) => x.method === 'balance')) {
    let b = rec.bank?.[s.id];
    // Fidelity money that reached Cass left Delap: a withdrawal, unless someone typed net deposits.
    if (s.id === 'delap' && b && b.netDeposits == null) { const fid = fidelityTransfers(rec).total; if (fid) b = { ...b, netDeposits: -fid }; }
    // Fees the GL booked (Dr 8070), unless someone typed them.
    const glFee = deposits?.fees?.[s.id];
    if (b && b.fees == null && glFee) b = { ...b, fees: glFee.amount };
    const int = balanceMethodInterest(b, prior?.bank?.[s.id]);
    if (int != null) auto[s.id] = { int, from: 'change in balance', by: b.enteredBy, at: b.enteredAt, computed: true, feesFromGl: b.fees != null && rec.bank?.[s.id]?.fees == null ? glFee : null };
  }
  if (st.operating) auto.cassOp = { rev: st.operating.summary.credits.total, ending: st.operating.summary.ending, from: 'Cass statements', by: st.operating.attachedBy, at: st.operating.attachedAt };
  if (rec.stripe) auto.stripe = { rev: stripeRevenue(rec.stripe), ending: rec.stripe.endBalance, from: 'Stripe CSV', by: rec.stripe.attachedBy, at: rec.stripe.attachedAt };
  if (rec.ics) auto.ics = { int: rec.ics.interest, ending: rec.ics.ending, from: 'ICS statement', by: rec.ics.attachedBy, at: rec.ics.attachedAt };
  if (cd?.hasData) auto.cd = { int: cd.realized, ending: cd.balance, from: 'CD schedule', by: cd.by, at: cd.at };
  return auto;
}

// deposits / priorDeposits: the GL deposit check for this month and last (gl-deposits.js). With
// them, deposits in transit come from the GL; without, from what was typed or imported.
export function computePoc(rec, { prior = null, gl = null, cd = null, glBalances = null, deposits = null, priorDeposits = null } = {}) {
  const bank = rec.bank || {};
  const auto = autoFigures(rec, cd, prior, deposits);
  const lines = BANK_SOURCES.map((s) => {
    const a = auto[s.id];
    const b = bank[s.id] || {};
    const pick = (k) => (a && a[k] !== undefined ? a[k] : b[k] ?? null);
    const rev = pick('rev'), int = pick('int'), ending = pick('ending');
    const glBal = glBalances && s.gl ? glBalances[s.gl] ?? null : null;
    return {
      ...s, rev, int, ending, note: b.note || '',
      from: a ? a.from : (b.rev != null || b.int != null || b.ending != null ? 'typed' : null),
      enteredBy: a ? a.by : b.enteredBy, enteredAt: a ? a.at : b.enteredAt,
      glBalance: glBal,
      balanceDiff: ending == null || glBal == null ? null : round2(ending - glBal),
      values: { rev, int, ending },
    };
  });
  const bankRev = round2(sum(lines, (l) => l.rev));
  const bankInt = round2(sum(lines, (l) => l.int));

  // An automatic adjustment to another account (Stripe disputes, PayPal refunds, Wise fees, KeyBank)
  // only counts once that account's own figure is in — otherwise it would stand alone.
  const hasFigure = (id) => lines.find((l) => l.id === id)?.rev != null;
  const all = statementAdjustments(rec, deposits);
  const waiting = all.filter((a) => a.account && a.account !== 'cassOp' && !hasFigure(a.account));
  const adjustments = [...all.filter((a) => !waiting.includes(a)), ...(rec.adjustments || []).map((a) => ({ ...a, auto: false, evidence: 'typed' }))];
  const adjTotal = round2(sum(adjustments, (a) => a.amount));

  const ditTotal = deposits?.dit ? deposits.dit.total : round2(sum(rec.dit || [], (d) => d.amount));
  const priorDit = priorDeposits?.dit ? priorDeposits.dit.total : prior ? round2(sum(prior.dit || [], (d) => d.amount)) : null;
  // Last month's deposits in transit unknown (the first month of the GL, with nothing entered for
  // the month before): this month's count in full, and the deposits that cleared last month's are
  // marked "Recognized in another month" on the deposit list instead. Said so, either way.
  const priorDitMissing = priorDit == null && ditTotal !== 0;
  const ditChange = priorDit == null ? (priorDitMissing ? ditTotal : null) : round2(ditTotal - priorDit);
  const markedPrior = reviewableDeposits(rec).filter((d) => exclusionInfo(manualExclusions(rec)[d.id])?.type === 'prior-period');
  const ditNotes = [];
  if (priorDitMissing) {
    ditNotes.push({ kind: 'prior-dit', text: `Last month’s deposits in transit aren’t known (that month isn’t in the GL, and none were entered for it), so this month’s ${money2(ditTotal)} counts in full. Deposits early this month that belong to last month have to be marked “Recognized in another month” on the deposit list${markedPrior.length ? ` — ${markedPrior.length} are, ${money2(sum(markedPrior, (d) => d.amount))}` : ' — none are yet'}.` });
  } else if (priorDit != null && markedPrior.length) {
    // Both at once would take last month's deposits out twice.
    const priorAmounts = [...(priorDeposits?.dit?.rows || []).filter((r) => r.counts).map((r) => r.sign * r.amount), ...(prior?.dit || []).map((d) => d.amount)];
    const twice = markedPrior.filter((d) => priorAmounts.some((a) => Math.abs(a - d.amount) < 0.005));
    if (twice.length) ditNotes.push({ kind: 'dit-twice', text: `${twice.map((d) => `${d.date} ${d.desc} ${money2(d.amount)}`).join('; ')}: marked “Recognized in another month”, but also on last month’s deposits in transit, which the change already takes out — so it comes out twice. Count it as revenue, or take it off last month’s list.` });
  }

  // Accrued and realized CD interest come from the CD schedule when it has the month.
  const t = { ...(rec.timing || {}) };
  if (cd?.hasData) { t.accrued = cd.accrued; t.realizedPrior = cd.realized; t.fromSchedule = true; }
  const revAdjusted = round2(bankRev + adjTotal + (ditChange || 0) + (t.restricted || 0) + (t.merchAR || 0));
  const intAdjusted = round2(bankInt + (t.accrued || 0) - (t.realizedPrior || 0));

  // GL figures: a number typed in the app (stamped typedAt) wins; then Acumatica (GL register or
  // statement of activities upload); then whatever came in with the old workbook.
  const g = rec.gl || {};
  const typed = g.typedAt ? g : {};
  const glRev = typed.revenue ?? gl?.revenueTotal ?? g.revenue ?? null;
  const glInt = typed.interest ?? gl?.interestTotal ?? g.interest ?? null;
  const glSource = typed.revenue != null || typed.interest != null ? 'typed' : gl ? gl.source : g.revenue != null || g.interest != null ? 'workbook' : null;
  const workbookGl = !g.typedAt && gl && (g.revenue != null || g.interest != null) ? { revenue: g.revenue ?? null, interest: g.interest ?? null } : null;

  const diffRev = glRev == null ? null : round2(revAdjusted - glRev);
  const diffInt = glInt == null ? null : round2(intAdjusted - glInt);

  return {
    lines, bankRev, bankInt, adjustments, adjTotal,
    ditTotal, priorDit, ditChange, timing: t,
    revAdjusted, intAdjusted,
    glRev, glInt, glSource, gl, workbookGl,
    stripeCheck: stripePayoutCheck(rec, deposits),
    warnings: [...missingStatements(rec), ...ditNotes], deposits, ditFromGl: !!deposits?.dit, waiting, priorDitMissing,
    diffRev, diffInt,
    pctRev: diffRev == null || !glRev ? null : diffRev / glRev,
    pctInt: diffInt == null || !glInt ? null : diffInt / glInt,
  };
}
