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
  return round2(b.ending - prior - (b.netDeposits || 0));
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
const STRIPE = /^STRIPE/i;
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
  const w = rec.bankStatements?.wise;
  (w?.items || []).forEach((it, i) => {
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
  (rec.bankStatements?.wise?.items || []).forEach((it) => { if (it.kind === 'sent') out.push({ date: it.date, amount: Math.abs(it.amount), desc: it.desc, account: 'wise' }); });
  (rec.ics?.items || []).forEach((it) => { if (it.withdrawal) out.push({ date: it.date, amount: it.amount, desc: `ICS ${it.type}`, account: 'ics' }); });
  return out;
}

const daysApart = (a, b) => (a && b ? Math.abs(Date.parse(a) - Date.parse(b)) / 86400000 : 99);

// Deposits that are really money moving between our own accounts: the same amount (at least
// $1,000) left another of our accounts within 5 days, or Wise shows it came from BibleProject.
export function detectTransfers(recIn) {
  const rec = asRec(recIn);
  const outs = outgoingItems(rec);
  const found = {};
  for (const d of reviewableDeposits(rec)) {
    if (d.account === 'wise' && /bible ?project/i.test(d.desc)) { found[d.id] = { type: 'transfer', note: 'Sent from our own account', auto: true }; continue; }
    if (d.amount < 1000) continue;
    const m = outs.find((o) => o.account !== d.account && Math.abs(o.amount - d.amount) < 0.005 && daysApart(o.date, d.date) <= 5);
    if (m) found[d.id] = { type: 'transfer', note: `Matches ${m.date} ${m.desc} leaving ${m.account === 'cassOp' ? 'Cass' : m.account}`, auto: true };
  }
  return found;
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
export function statementAdjustments(rec) {
  const st = rec.statements || {};
  const adj = [];
  if (st.operating) {
    const stripe = st.operating.transactions.filter((t) => t.section === 'credit' && STRIPE.test(t.desc));
    if (stripe.length) {
      adj.push({ id: 'auto-stripe', account: 'cassOp', type: 'transfer', label: 'Stripe transfers into Cass', amount: -round2(sum(stripe, (t) => t.amount)), auto: true,
        detail: stripe.map((t) => ({ date: t.date, amount: t.amount, desc: t.desc })),
        why: 'Money moving from Stripe to Cass — Stripe revenue is already counted on the Stripe line.' });
    }
  }
  if (st.incoming) {
    const out = st.incoming.transactions.filter((t) => t.section !== 'credit' && !isSweep(t));
    adj.push({ id: 'auto-incoming', account: 'cassOp', type: 'refund', label: 'Incoming Wires — money out that isn’t the sweep', amount: -round2(sum(out, (t) => t.amount)), auto: true,
      detail: out.map((t) => ({ date: t.date, amount: t.amount, desc: t.desc })),
      why: 'Every Incoming deposit counts as revenue, so anything returned from Incoming reduces deposits.' });
  }
  if (st.outgoing) {
    const inn = st.outgoing.transactions.filter((t) => t.section === 'credit' && !isSweep(t));
    adj.push({ id: 'auto-outgoing', account: 'cassOp', type: 'refund', label: 'Outgoing Wires — money in that isn’t the sweep', amount: -round2(sum(inn, (t) => t.amount)), auto: true,
      detail: inn.map((t) => ({ date: t.date, amount: t.amount, desc: t.desc })),
      why: 'Refunds and returns landing in Outgoing reach Operating through the sweep but aren’t revenue.' });
  }
  const deposits = reviewableDeposits(rec);
  for (const [id, v] of Object.entries(rec.excluded || {})) {
    const t = deposits.find((x) => x.id === id);
    const info = exclusionInfo(v);
    if (!t || !info) continue;
    const transfer = info.type === 'transfer';
    adj.push({ id: `${transfer ? 'auto-tr-' : 'auto-ex-'}${id}`, account: t.account, type: info.type, label: `${transfer ? 'Transfer between accounts' : 'Not revenue'}: ${t.desc}`,
      amount: -t.amount, auto: true, note: info.note, detail: [{ date: t.date, amount: t.amount, desc: t.desc, note: info.note }] });
  }
  return adj;
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
export function autoFigures(rec, cd = null, prior = null) {
  const st = rec.statements || {};
  const auto = {};
  for (const [id, b] of Object.entries(rec.bankStatements || {})) {
    auto[id] = { rev: b.revenue, int: b.interest, ending: b.ending, from: `${b.fileName || 'statement'}`, by: b.attachedBy, at: b.attachedAt };
  }
  for (const s of BANK_SOURCES.filter((x) => x.method === 'balance')) {
    const b = rec.bank?.[s.id];
    const int = balanceMethodInterest(b, prior?.bank?.[s.id]);
    if (int != null) auto[s.id] = { int, from: 'change in balance', by: b.enteredBy, at: b.enteredAt, computed: true };
  }
  if (st.operating) auto.cassOp = { rev: st.operating.summary.credits.total, ending: st.operating.summary.ending, from: 'Cass statements', by: st.operating.attachedBy, at: st.operating.attachedAt };
  if (rec.stripe) auto.stripe = { rev: rec.stripe.revenue, ending: rec.stripe.endBalance, from: 'Stripe CSV', by: rec.stripe.attachedBy, at: rec.stripe.attachedAt };
  if (rec.ics) auto.ics = { int: rec.ics.interest, ending: rec.ics.ending, from: 'ICS statement', by: rec.ics.attachedBy, at: rec.ics.attachedAt };
  if (cd?.hasData) auto.cd = { int: cd.realized, ending: cd.balance, from: 'CD schedule', by: cd.by, at: cd.at };
  return auto;
}

export function computePoc(rec, { prior = null, gl = null, cd = null, glBalances = null } = {}) {
  const bank = rec.bank || {};
  const auto = autoFigures(rec, cd, prior);
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

  const adjustments = [...statementAdjustments(rec), ...(rec.adjustments || []).map((a) => ({ ...a, auto: false }))];
  const adjTotal = round2(sum(adjustments, (a) => a.amount));

  const ditTotal = round2(sum(rec.dit || [], (d) => d.amount));
  const priorDit = prior ? round2(sum(prior.dit || [], (d) => d.amount)) : null;
  const ditChange = priorDit == null ? null : round2(ditTotal - priorDit);

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
    diffRev, diffInt,
    pctRev: diffRev == null || !glRev ? null : diffRev / glRev,
    pctInt: diffInt == null || !glInt ? null : diffInt / glInt,
  };
}
