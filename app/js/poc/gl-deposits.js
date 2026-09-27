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
import { DEFAULT_POC_CONFIG, isSweep } from './calc.js';

const STRIPE = /^STRIPE/i;
const DAY = 86400000;
const cents = (n) => Math.round(n * 100);

// Names for the accounts a Cass deposit is usually booked to, for the notes.
const ACCOUNT_NAMES = {
  1012: 'PayPal', 1013: 'Wise', 1015: 'Stripe', 1020: 'pass-through cash', 1060: 'KeyBank money market', 1061: 'KeyBank',
  1150: 'CDARS', 1160: 'ICS', 1170: 'Delap Fidelity', 1171: 'Tschetter', 1200: 'Stripe clearing', 1210: 'accounts receivable',
  1220: 'grants / pledges receivable', 2010: 'accounts payable', 2041: 'agency (pass-through)', 2042: 'sales tax', 2050: 'payroll',
  9050: 'shipping (COGS)',
};
export const accountName = (a, names = {}) => `${a} ${names[a] || ACCOUNT_NAMES[a] || ''}`.trim();

// What the GL booked a batch to, in proof of cash terms.
export function glKind(r, config = DEFAULT_POC_CONFIG, names = {}) {
  const credited = Object.entries(r.accounts || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const revenue = round2(sum(credited.filter(([a]) => config.revenueAccounts.includes(a)), ([, v]) => v));
  const other = credited.filter(([a]) => !config.revenueAccounts.includes(a));
  const label = credited.map(([a]) => accountName(a, names)).join(', ');
  if (!other.length) return { kind: 'revenue', revenue, label };
  const main = other[0][0];
  if (main === '1200') return { kind: 'stripe', revenue, label };
  if (/^10\d\d$/.test(main) || ['1150', '1160', '1170', '1171'].includes(main)) return { kind: 'transfer', revenue, label };
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
function matchMonth(month, lines, receiptsBy, used) {
  const byLine = new Map();
  const RANK = { this: 0, prior: 1, next: 2 };
  const all = [[month, 'this'], [addMonths(month, -1), 'prior'], [addMonths(month, 1), 'next']]
    .flatMap(([m, when]) => (receiptsBy[m] || []).filter((r) => r.amount > 0).map((r) => ({ r, when, w: bankWindow(r), stripe: glKind(r).kind === 'stripe' })));
  const open = (x) => !used.has(x.r.batch);
  const take = (x, ls) => { used.add(x.r.batch); for (const l of ls) byLine.set(l, { r: x.r, when: x.when, group: ls.length }); };
  // Last or next month's batch has to be close: it's borrowing across the month end.
  const near = (x, date, days) => distance(date, x.w) <= (x.when === 'this' ? days : Math.min(days, 3));
  const order = (date) => (a, b) => RANK[a.when] - RANK[b.when] || distance(date, a.w) - distance(date, b.w);
  const fits = (x, l) => {
    if (STRIPE.test(l.desc) !== x.stripe) return false;
    if (/paypal/i.test(x.r.desc) && l.kind === 'operating') return /PAYPAL/i.test(l.desc);
    if (/\bdeposits?\b/i.test(x.r.desc) && l.kind === 'operating' && /PAYPAL/i.test(l.desc)) return false;
    return true;
  };

  // Stripe payouts, one to one.
  for (const l of lines.filter((y) => STRIPE.test(y.desc))) {
    const x = all.filter((y) => open(y) && y.stripe && Math.abs(y.r.amount - l.amount) < 0.005 && near(y, l.date, 5)).sort(order(l.date))[0];
    if (x) take(x, [l]);
  }

  // Incoming, a day at a time.
  const days = {};
  for (const l of lines.filter((y) => y.kind === 'incoming')) (days[l.date] ||= []).push(l);
  for (const [date, ls] of Object.entries(days).sort()) {
    const total = cents(sum(ls, (l) => l.amount));
    const cands = all.filter((x) => open(x) && !x.stripe && near(x, date, 3) && cents(x.r.amount) <= total).sort(order(date));
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

  // Everything else: one to one, then one batch for several lines within a day or two.
  const left = () => lines.filter((l) => !byLine.has(l));
  for (const l of left()) {
    const x = all.filter((y) => open(y) && fits(y, l) && Math.abs(y.r.amount - l.amount) < 0.005 && near(y, l.date, 7)).sort(order(l.date))[0];
    if (x) take(x, [l]);
  }
  for (const x of [...all].sort((a, b) => RANK[a.when] - RANK[b.when] || b.r.amount - a.r.amount)) {
    if (!open(x)) continue;
    const cand = left().filter((l) => fits(x, l) && near(x, l.date, x.w.named ? 1 : 2));
    for (const set of [cand.filter((l) => l.kind === 'operating'), cand.filter((l) => l.kind === 'incoming'), cand.filter((l) => l.kind === 'outgoing'), cand]) {
      if (set.length < 2) continue;
      const found = subsetSum(set.slice(0, 40).map((l) => ({ line: l, c: cents(l.amount) })), cents(x.r.amount));
      if (found) { take(x, found); break; }
    }
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
    const byLine = lines.length ? matchMonth(m, lines, receiptsBy, used) : new Map();
    matched[m] = { lines, byLine };
    for (const [l, x] of byLine) {
      const e = matchedBatch.get(x.r.batch) || { month: m, lines: [] };
      e.lines.push(l); matchedBatch.set(x.r.batch, e);
    }
  }
  const out = {};
  for (const m of months) out[m] = monthFindings(m);
  return out;

  function monthFindings(m) {
    const rec = recs[m] || {};
    const receipts = receiptsBy[m] || null;
    const { lines, byLine } = matched[m] || { lines: [], byLine: new Map() };
    const hasStatements = !!(rec.statements?.operating || rec.statements?.incoming);
    const res = { month: m, available: !!receipts, hasStatements, lines: [], exclusions: {}, adjustments: [], covered: [], noGl: [], glOnly: [], dit: null };
    if (!receipts && !byLine.size) return res;

    // Hand-entered adjustments (typed, or from the workbook) already cover some of these. One
    // adjustment covers one finding of the same amount, so nothing comes out twice.
    const hand = (rec.adjustments || []).filter((a) => a.amount).map((a) => ({ a, free: true }));
    const coveredBy = (amount) => {
      const h = hand.find((x) => x.free && Math.abs(Math.abs(x.a.amount) - Math.abs(amount)) < 0.005);
      if (h) h.free = false;
      return h?.a || null;
    };
    const dismissed = rec.dismissed || {};

    for (const l of lines) {
      const x = byLine.get(l);
      const k = x ? glKind(x.r, config, names) : null;
      res.lines.push({ line: l, match: x ? { ...x.r, when: x.when, group: x.group, ...k } : null });
      if (!x) {
        if (!STRIPE.test(l.desc) && l.kind !== 'outgoing') res.noGl.push({ line: l, covered: coveredBy(l.amount) });
        continue;
      }
      // Outgoing credits reach Operating only through the sweep, which the sweep rule already takes out.
      if (k.kind === 'revenue' || k.kind === 'stripe' || l.kind === 'outgoing') continue;
      const info = { type: TYPE[k.kind], note: `GL ${x.r.batch}: ${x.r.desc} — ${WHY[k.kind]} (${k.label})`, auto: true, gl: x.r.batch };
      const by = coveredBy(l.amount);
      if (by) { res.covered.push({ line: l, info, by }); continue; }
      if (!dismissed[l.id]) res.exclusions[l.id] = info;
    }

    if (receipts) {
      for (const rev of receipts.filter((r) => r.amount < 0)) {
        const id = `auto-glrev-${rev.batch}`;
        const adj = { id, account: 'cassOp', type: 'not-revenue', label: `Revenue the GL took back: ${rev.desc}`, amount: rev.amount, auto: true, gl: rev.batch,
          note: `GL ${rev.batch} (${rev.date}) moves ${round2(-rev.amount)} out of revenue (${glKind({ accounts: Object.fromEntries(Object.entries(rev.accounts).map(([a, v]) => [a, -v])) }, config, names).label}).`,
          why: 'The deposit is on a statement as revenue, but the GL took it back out — a chargeback, or a deposit reclassed to another account.',
          detail: [{ date: rev.date, amount: -rev.amount, desc: rev.desc }] };
        const by = coveredBy(rev.amount);
        if (by) res.covered.push({ adjustment: adj, by });
        else if (!dismissed[id]) res.adjustments.push(adj);
      }
      for (const r of receipts) {
        if (r.amount <= 0) continue;
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
        res.adjustments.push({ id, account: 'stripe', type: 'not-revenue', label: `Stripe, per the GL: ${x.desc}`, amount: net, auto: true, gl: x.batch,
          note: `GL ${x.batch} (${x.date}): ${moved.map(([a, v]) => `${v > 0 ? 'to' : 'from'} ${accountName(a, names)} ${round2(Math.abs(v)).toFixed(2)}`).join(', ')}`,
          why: 'Stripe’s gross includes sales the GL doesn’t count as revenue — shipping (9050) and sales tax (2042) on merchandise — and the GL sometimes adds a stray Stripe transfer to giving.',
          detail: [{ date: x.date, amount: net, desc: x.desc }] });
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
    // settled: the statements say where it belongs, so there's nothing to decide.
    const add = (r, sign, suggested, evidence, { flagged = false, settled = false } = {}) => {
      const choice = settled ? null : choices[r.batch];
      rows.push({ batch: r.batch, glMonth: sign > 0 ? m : next, date: r.date, bank: bankWindow(r), desc: r.desc, amount: r.amount, sign,
        suggested, evidence, settled, flagged: flagged && !choice, choice: choice || null, counts: choice ? !!choice.in : suggested });
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
