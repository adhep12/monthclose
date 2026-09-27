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

export const BANK_SOURCES = [
  { id: 'wise', label: 'Wise' },
  { id: 'paypal', label: 'PayPal' },
  { id: 'stripe', label: 'Stripe' },
  { id: 'keyOp', label: 'KeyBank Operating' },
  { id: 'keyMM', label: 'KeyBank Money Market' },
  { id: 'ics', label: 'Cass Money Market / ICS' },
  { id: 'cd', label: 'Cass CD' },
  { id: 'delap', label: 'Delap Fidelity Investment' },
  { id: 'tschetter', label: 'Tschetter Group' },
  { id: 'cassOp', label: 'Cass Operating' },
];

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

// Deposits someone may reasonably mark as "not revenue": credits on Operating and Incoming
// that aren't internal sweeps. (Outgoing's non-sweep credits are already taken out as a group.)
export function excludableCredits(statements) {
  const out = [];
  for (const kind of ['operating', 'incoming']) {
    const s = statements?.[kind];
    if (!s) continue;
    for (const t of s.transactions) if (t.section === 'credit' && !isSweep(t)) out.push({ ...t, kind });
  }
  return out;
}

export function defaultExclusions(statements) {
  const ex = {};
  for (const t of excludableCredits(statements)) {
    if (AUTO_EXCLUDE.test(`${t.desc} ${t.detail || ''}`)) ex[t.id] = 'Tax refund — not revenue (excluded automatically)';
  }
  return ex;
}

// Adjustments that come straight off the statements.
export function statementAdjustments(rec) {
  const st = rec.statements || {};
  const adj = [];
  if (st.operating) {
    const stripe = st.operating.transactions.filter((t) => t.section === 'credit' && STRIPE.test(t.desc));
    if (stripe.length) {
      adj.push({ id: 'auto-stripe', label: 'Stripe transfers into Cass', amount: -round2(sum(stripe, (t) => t.amount)), auto: true,
        detail: stripe.map((t) => ({ date: t.date, amount: t.amount, desc: t.desc })),
        why: 'Stripe revenue is counted on the Stripe line, so its transfers into Cass come out here.' });
    }
  }
  if (st.incoming) {
    const out = st.incoming.transactions.filter((t) => t.section !== 'credit' && !isSweep(t));
    adj.push({ id: 'auto-incoming', label: 'Incoming Wires — money out that isn’t the sweep', amount: -round2(sum(out, (t) => t.amount)), auto: true,
      detail: out.map((t) => ({ date: t.date, amount: t.amount, desc: t.desc })),
      why: 'Every Incoming deposit counts as revenue, so anything returned from Incoming reduces deposits.' });
  }
  if (st.outgoing) {
    const inn = st.outgoing.transactions.filter((t) => t.section === 'credit' && !isSweep(t));
    adj.push({ id: 'auto-outgoing', label: 'Outgoing Wires — money in that isn’t the sweep', amount: -round2(sum(inn, (t) => t.amount)), auto: true,
      detail: inn.map((t) => ({ date: t.date, amount: t.amount, desc: t.desc })),
      why: 'Refunds and returns landing in Outgoing reach Operating through the sweep but aren’t revenue.' });
  }
  const credits = excludableCredits(st);
  for (const [id, note] of Object.entries(rec.excluded || {})) {
    const t = credits.find((x) => x.id === id);
    if (t) adj.push({ id: `auto-ex-${id}`, label: `Not revenue: ${t.desc}`, amount: -t.amount, auto: true, note,
      detail: [{ date: t.date, amount: t.amount, desc: t.desc }] });
  }
  return adj;
}

export function glFigures({ glActivity, tb, month, config = DEFAULT_POC_CONFIG }) {
  // Net debit per account for the month: from a GL register upload, or failing that a TB for
  // the same period (its Debit/Credit columns are the period's activity).
  let net = null, source = null;
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

export function computePoc(rec, { prior = null, gl = null } = {}) {
  const bank = rec.bank || {};
  const st = rec.statements || {};
  const lines = BANK_SOURCES.map((s) => {
    let rev = bank[s.id]?.rev ?? null;
    let from = rev == null ? null : 'typed';
    if (s.id === 'cassOp' && st.operating) { rev = st.operating.summary.credits.total; from = 'statement'; }
    return { ...s, rev, int: bank[s.id]?.int ?? null, note: bank[s.id]?.note || '', from };
  });
  const bankRev = round2(sum(lines, (l) => l.rev));
  const bankInt = round2(sum(lines, (l) => l.int));

  const adjustments = [...statementAdjustments(rec), ...(rec.adjustments || []).map((a) => ({ ...a, auto: false }))];
  const adjTotal = round2(sum(adjustments, (a) => a.amount));

  const ditTotal = round2(sum(rec.dit || [], (d) => d.amount));
  const priorDit = prior ? round2(sum(prior.dit || [], (d) => d.amount)) : null;
  const ditChange = priorDit == null ? null : round2(ditTotal - priorDit);

  const t = rec.timing || {};
  const revAdjusted = round2(bankRev + adjTotal + (ditChange || 0) + (t.restricted || 0) + (t.merchAR || 0));
  const intAdjusted = round2(bankInt + (t.accrued || 0) - (t.realizedPrior || 0));

  const glRev = rec.gl?.revenue ?? gl?.revenueTotal ?? null;
  const glInt = rec.gl?.interest ?? gl?.interestTotal ?? null;
  const glSource = rec.gl?.revenue != null || rec.gl?.interest != null ? 'typed' : gl?.source || null;

  const diffRev = glRev == null ? null : round2(revAdjusted - glRev);
  const diffInt = glInt == null ? null : round2(intAdjusted - glInt);

  return {
    lines, bankRev, bankInt, adjustments, adjTotal,
    ditTotal, priorDit, ditChange, timing: t,
    revAdjusted, intAdjusted,
    glRev, glInt, glSource, gl,
    diffRev, diffInt,
    pctRev: diffRev == null || !glRev ? null : diffRev / glRev,
    pctInt: diffInt == null || !glInt ? null : diffInt / glInt,
  };
}
