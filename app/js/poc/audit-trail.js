// The export's audit trail. Every adjustment line, and every deposit in transit, as a row someone
// outside the team can follow without the app: a permanent reference number, what moved and who it
// was, where it is on the bank statement (by file name, so the PDFs can be sent along), the GL
// batch that booked it, and why it's adjusted.
//
// Pure: takes what the sheet already worked out (computePoc, depositChecks, the GL uploads), so it
// can be tested without a browser.

import { reviewableDeposits, outgoingItems, EVIDENCE } from './calc.js';
import { wiseSender } from './banks.js';
import { accountName } from './gl-deposits.js';
import { round2 } from '../money.js';

const money2 = (v) => (v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
const priorMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; };
const same = (a, b) => Math.abs(Math.abs(a) - Math.abs(b)) < 0.005;
const md = (d) => (d ? `${Number(d.slice(5, 7))}/${d.slice(8, 10)}` : '');
// Acumatica batch numbers named in a note ("GL GL017661", "AP014203").
const BATCH = /\b((?:GL|AR|AP|CA|IN)\d{5,})\b/;
const PLUMBING = /^Trnsfr (from|to) Checking Acct/i;

// Interest the GL booked with no deposit of its own (gl.js noCashInterest): its own sheet row on
// the interest side, and its own group in the audit tabs, so it never mixes into revenue's.
export const NO_CASH_INTEREST = 'Plus interest received without a deposit';

// Every GL batch the uploads know, by Acumatica's batch number: its date, description, what it
// booked (cash side included) and, for batches that touch a bank account, its lines.
export function glBatchIndex(glBy = {}) {
  const out = new Map();
  const put = (m, x, cash) => {
    if (!x?.batch || out.has(x.batch)) return;
    const accounts = { ...(x.accounts || {}) };
    // Cash receipts keep the cash side apart (x.amount, debit positive); put it back.
    if (cash && x.amount) accounts[cash] = round2((accounts[cash] || 0) - x.amount);
    out.set(x.batch, { batch: x.batch, month: m, date: x.date, desc: x.desc, accounts, cash, lines: x.lines || null });
  };
  for (const [m, g] of Object.entries(glBy)) {
    for (const x of g?.receipts || []) put(m, x, '1100');
    for (const x of g?.keyReceipts || []) put(m, x, '1061');
    for (const x of g?.wiseReceipts || []) put(m, x, '1013');
    for (const x of [...(g?.noCashRevenue || []), ...(g?.stripeReclass || [])]) put(m, x, null);
    for (const x of g?.noCashInterest || []) put(m, { ...x, accounts: { 4050: x.amount } }, null);
    for (const x of g?.paypalRefunds || []) put(m, { ...x, accounts: { 4012: -x.amount } }, null);
  }
  return out;
}

// What a batch booked, as a journal entry: "Dr 1100 Cass - General Operating 5,000.00 / Cr 4018 … 5,000.00". The
// accounts are kept net credit positive.
export function bookedText(b) {
  if (!b?.accounts) return '';
  const e = Object.entries(b.accounts).filter(([, v]) => Math.abs(v) >= 0.005);
  const name = (a) => accountName(a);
  return [...e.filter(([, v]) => v < 0).map(([a, v]) => `Dr ${name(a)} ${money2(-v)}`), ...e.filter(([, v]) => v > 0).map(([a, v]) => `Cr ${name(a)} ${money2(v)}`)].join(' / ');
}

// Every transaction on the month's statements, with the file it's on.
function statementLines(rec) {
  const out = [];
  for (const kind of ['operating', 'incoming', 'outgoing']) {
    const s = rec?.statements?.[kind];
    if (!s) continue;
    const doc = `${s.label || 'Cass'}${s.last4 ? ` …${s.last4}` : ''}${s.statementDate ? `, statement ${s.statementDate}` : ''}${s.fileName ? ` (${s.fileName})` : ''}`;
    for (const t of s.transactions || []) out.push({ ...t, doc, where: t.section === 'credit' ? 'Credits' : t.section === 'check' ? 'Checks' : 'Debits' });
  }
  const w = rec?.bankStatements?.wise;
  if (w) {
    const doc = `Wise statement${w.fileName ? ` (${w.fileName})` : ''}`;
    for (const t of reviewableDeposits(rec).filter((x) => x.account === 'wise')) out.push({ ...t, doc, where: 'Money in' });
    for (const t of outgoingItems(rec).filter((x) => x.account === 'wise')) out.push({ ...t, doc, where: 'Money out' });
  }
  return out;
}

// The document an account's figure comes from, when the item isn't a line on a statement.
function accountDoc(rec, account) {
  const f = (b) => (b?.fileName ? ` (${b.fileName})` : '');
  if (account === 'stripe') return `Stripe monthly CSV${f(rec?.stripe)}`;
  if (account === 'paypal') return `PayPal statement${f(rec?.bankStatements?.paypal)}`;
  if (account === 'wise') return `Wise statement${f(rec?.bankStatements?.wise)}`;
  if (account === 'keyOp') return `KeyBank Operating statement${f(rec?.bankStatements?.keyOp)}, total deposits only`;
  return '';
}

// One row per line of each adjustment (a sweep, a transfer, a refund), then this month's deposits
// in transit and last month's that cleared, in sheet order (order: the sheet's adjustment rows),
// each kind of line together by date. Each row has a key that stays the same from one export to
// the next, for its permanent ref (assignRefs).
// ctx: { m, rec, c (computePoc), glIndex, priorDeposits, priorRec, groupOf, lineOf, order }
export function auditRows({ m, rec, c, glIndex = new Map(), priorDeposits = null, priorRec = null, groupOf, lineOf, order = [] }) {
  const stmt = statementLines(rec || {});
  const dep = c.deposits;
  const matchOf = (id) => (id ? dep?.lines?.find((x) => x.line.id === id)?.match || null : null);
  const rows = [];

  for (const a of c.adjustments) {
    const items = a.detail?.length ? a.detail : [{ date: a.date || '', desc: a.label, amount: a.amount }];
    const txnOf = /^auto-(tr|ex)-/.test(a.id || '') ? a.id.replace(/^auto-(tr|ex)-/, '') : null;
    for (const d of items) {
      const shown = a.detail?.length ? (a.amount < 0 ? -1 : 1) * Math.abs(d.amount) : a.amount;
      // The statement line: by its id where the adjustment keeps it, else the same date and amount.
      const id = txnOf || d.id || null;
      const t = (id && stmt.find((x) => x.id === id))
        || (a.account === 'cassOp' || a.account === 'wise' || !a.account ? stmt.find((x) => x.date === d.date && same(x.amount, d.amount) && (!d.desc || x.desc === d.desc)) : null)
        || null;
      const match = matchOf(t?.id);
      const batchNo = (String(d.note || '').match(BATCH) || [])[1] || a.gl || match?.batch || (String(a.note || '').match(BATCH) || [])[1] || null;
      const b = batchNo ? glIndex.get(batchNo) || (match?.batch === batchNo ? match : null) : null;
      const glLine = glLineFor(b, match, shown, t);
      const line = lineOf(a);
      const desc = PLUMBING.test(d.desc || '') && d.note ? d.note.replace(/^Per the GL:\s*/, '') : d.desc || a.label;
      const evidence = a.evidence || 'statement';
      rows.push({
        key: a.auto ? `${a.id}|${d.date || ''}|${d.desc || ''}` : `typed|${a.id}`,
        month: m, group: groupOf(a), line,
        // (An adjustment without per-item detail is its own label, which already says what it is.)
        what: `${!desc || desc === line ? line : desc === a.label ? desc : `${line} — ${desc}`}${!a.auto && a.date && !t ? ` (${md(a.date)})` : ''}`,
        who: whoOf({ a, d, t, glLine }),
        date: d.date || '', amount: round2(shown),
        evidence: (EVIDENCE[evidence] || EVIDENCE.statement).label, evidenceKey: evidence,
        bank: t ? `${t.doc} · ${t.where} · ${md(t.date)} ${money2(t.amount)} “${[t.desc, t.detail].filter(Boolean).join(' — ')}”`
          : a.statement ? a.statement
            : evidence === 'gl' ? 'None: a book entry, the statement shows the net deposit only'
              : accountDoc(rec, a.account),
        glBatch: batchNo || '',
        gl: b ? [`${md(b.date)} ${b.desc || ''}`.trim(), bookedText(b), glLine?.id ? `line ${glLine.id}` : ''].filter(Boolean).join(' · ') : '',
        why: a.auto ? a.why || a.note || '' : [a.note ? `“${a.note}”` : '', a.enteredBy ? `typed by ${a.enteredBy}${a.enteredAt ? `, ${a.enteredAt.slice(0, 10)}` : ''}` : ''].filter(Boolean).join(' — '),
        a,
      });
    }
  }
  // Deposits in transit: this month's, less last month's (which reached the bank this month). The
  // sheet's Timing row includes the change.
  if (c.ditChange != null) {
    for (const x of ditList(dep?.dit, rec)) rows.push(ditRow(x, 1, `Deposit in transit at the end of ${monthLabel(m)}`));
    if (!c.priorDitMissing) for (const x of ditList(priorDeposits?.dit, priorRec)) rows.push(ditRow(x, -1, `${monthLabel(priorMonth(m))}’s deposit in transit, cleared this month`));
  }
  // Interest received without a deposit (an escrow's interest credited on a closing statement):
  // no bank document, so the GL entry and the settlement document are the evidence.
  for (const x of c.timing?.noCashInterestItems || []) {
    const b = glIndex.get(x.batch);
    const ok = rec?.intConfirm?.[x.batch];
    rows.push({
      key: `nocashint|${x.batch}`, month: m, group: NO_CASH_INTEREST, line: NO_CASH_INTEREST,
      what: `Interest booked with no deposit of its own — ${x.desc}`, who: 'Received inside another settlement',
      date: x.date || '', amount: round2(x.amount),
      evidence: EVIDENCE.gl.label, evidenceKey: 'gl',
      bank: 'None: no deposit of its own; the settlement document (e.g. a closing statement) shows it',
      glBatch: x.batch,
      gl: b ? [`${md(b.date)} ${b.desc || ''}`.trim(), `Cr ${accountName('4050')} ${money2(x.amount)}`].filter(Boolean).join(' · ') : `Cr ${accountName('4050')} ${money2(x.amount)}`,
      why: `Interest income the GL booked with no cash or investment account on the other side: received inside another settlement, so no statement lists it.${ok ? ` Confirmed by ${ok.by}${ok.at ? `, ${String(ok.at).slice(0, 10)}` : ''}${ok.note ? `: “${ok.note}”` : ''}.` : ' Not confirmed yet.'}`,
    });
  }
  // Two lines alike in every way (the same fee twice on one day) are told apart by their order.
  const seen = {};
  for (const r of rows) { seen[r.key] = (seen[r.key] || 0) + 1; if (seen[r.key] > 1) r.key += `#${seen[r.key]}`; }
  const rank = (g) => (order.includes(g) ? order.indexOf(g) : order.length);
  const lines = [...new Set(rows.map((r) => r.line))];
  rows.forEach((r, i) => { r.i = i; });
  rows.sort((x, y) => rank(x.group) - rank(y.group) || lines.indexOf(x.line) - lines.indexOf(y.line) || String(x.date).localeCompare(String(y.date)) || x.i - y.i);
  rows.forEach((r) => { delete r.i; });
  return rows;

  function ditRow(x, sign, line) {
    const b = x.batch ? glIndex.get(x.batch) : null;
    const amount = round2(sign * x.amount);
    const cleared = sign > 0 ? nextMonth(m) : m;
    return {
      key: `dit|${sign > 0 ? 'in' : 'out'}|${x.batch || `${x.date}|${x.desc}`}`,
      month: m, group: groupOf({ type: 'timing' }), line, what: `${line} — ${x.desc}`, who: 'Deposit',
      date: x.date || '', amount,
      evidence: x.batch ? (x.settled ? EVIDENCE.both.label : EVIDENCE.gl.label) : EVIDENCE.typed.label, evidenceKey: x.batch ? (x.settled ? 'both' : 'gl') : 'typed',
      bank: `Cass Operating, ${monthLabel(cleared)} statement${x.evidence ? ` · ${x.evidence}` : ''}`,
      glBatch: x.batch || '',
      gl: b ? [`${md(b.date)} ${b.desc || ''}`.trim(), bookedText(b)].filter(Boolean).join(' · ') : '',
      why: sign > 0 ? `Booked as revenue in ${monthLabel(m)}, reached the bank in ${monthLabel(cleared)}.${x.status && x.status !== 'The statements show it' ? ` ${x.status}.` : ''}`
        : `Counted in ${monthLabel(priorMonth(m))}’s deposits in transit; reached the bank this month, so it comes out here.`,
      dit: true,
    };
  }
}

// A month's deposits in transit, one per line: from the GL where it has the month, else typed or
// imported from the workbook.
function ditList(dit, rec) {
  if (dit) {
    return [
      ...dit.rows.filter((r) => r.counts).map((r) => ({ batch: r.batch, date: r.date, desc: r.desc, amount: round2(r.sign * r.amount), evidence: r.evidence, settled: r.settled,
        status: r.settled ? 'The statements show it' : r.choice ? `Confirmed by ${r.choice.by}${r.choice.note ? ` — ${r.choice.note}` : ''}` : r.flagged ? 'Not confirmed yet' : 'From the GL' })),
      ...dit.manual.filter((x) => !x.duplicate).map((x) => ({ batch: null, date: x.d.date || '', desc: x.d.note || 'Typed deposit in transit', amount: x.d.amount, status: 'Typed' })),
    ];
  }
  return (rec?.dit || []).map((d) => ({ batch: null, date: d.date || '', desc: d.note || 'Deposit in transit', amount: d.amount, status: String(d.id || '').startsWith('imp-') ? 'From the workbook' : 'Typed' }));
}

// The GL line that is this item: the one the deposit match tied it to, else the one line of the
// batch (off the cash side) with this amount.
function glLineFor(b, match, amount, t) {
  // (A deposit matched one to one is tied to the batch's cash line; the payer is on the other side.)
  const cash = b?.cash || '1100';
  const tie = match?.confidence?.tie;
  const tied = tie?.id ? b?.lines?.find((x) => x.id === tie.id) || { id: tie.id, d: tie.desc, cv: tie.cv } : null;
  if (tied && tied.a !== cash) return tied;
  const hits = (b?.lines || []).filter((x) => x.a !== cash && same(x.amt, amount));
  if (hits.length === 1) return hits[0];
  if (t && hits.length > 1) return hits.find((x) => `${x.d} ${x.cv}`.toLowerCase().split(/\W+/).some((w) => w.length > 3 && `${t.desc} ${t.detail || ''}`.toLowerCase().includes(w))) || null;
  return null;
}

// Who the money came from or went to, in the words of whichever document names them best.
function whoOf({ a, d, t, glLine }) {
  if (a.id === 'auto-stripe' || a.id === 'auto-stripe-disputes') return 'Stripe (our account)';
  if (!a.auto) return a.enteredBy ? `Typed by ${a.enteredBy}` : 'From the workbook';
  if (glLine?.cv || glLine?.d) return [glLine.d, glLine.cv].filter(Boolean).join(' · ');
  const sender = t?.account === 'wise' ? wiseSender(t.desc) : '';
  if (sender) return sender;
  if (PLUMBING.test(d.desc || '')) return 'Between our own Cass accounts';
  if (t) return [t.desc, t.detail].filter(Boolean).join(' — ');
  return '';
}

// Permanent refs. stored = rec.refs ({ seq, lines: { [key]: { ref, amount, what, date, at, retired? } } }),
// changed in place. A row seen before keeps its ref; a new one gets the next number (A-2026-02-010);
// a numbered line no longer among the rows is retired (its number is never used again) and comes
// back to life if it returns. Returns what to report: retired lines and amounts changed since.
export function assignRefs(m, rows, stored, now = new Date().toISOString()) {
  stored.lines ||= {};
  stored.seq ||= Object.keys(stored.lines).length;
  let changed = false;
  for (const r of rows) {
    let s = stored.lines[r.key];
    if (!s) {
      s = stored.lines[r.key] = { ref: `A-${m}-${String(++stored.seq).padStart(3, '0')}`, amount: r.amount, what: r.what, date: r.date, at: now };
      changed = true;
    } else if (s.retired) { delete s.retired; changed = true; }
    r.ref = s.ref;
    if (!same(s.amount, r.amount) || Math.sign(s.amount) !== Math.sign(r.amount)) r.was = s.amount;
  }
  const live = new Set(rows.map((r) => r.key));
  const retired = [];
  for (const [k, s] of Object.entries(stored.lines)) {
    if (live.has(k)) continue;
    if (!s.retired) { s.retired = now; changed = true; }
    retired.push(s);
  }
  return { changed, retired: retired.sort((x, y) => x.ref.localeCompare(y.ref)), amountChanged: rows.filter((r) => r.was != null) };
}

// The rows totalled by month, sheet row and kind of line: the bridge from a number on the sheet
// to its lines.
export function auditSummary(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.month}|${r.group}|${r.line}`;
    const x = by.get(k) || { month: r.month, group: r.group, line: r.line, count: 0, total: 0, glOnly: 0 };
    x.count++; x.total = round2(x.total + r.amount);
    if (r.evidenceKey === 'gl') x.glOnly = round2(x.glOnly + Math.abs(r.amount));
    by.set(k, x);
  }
  return [...by.values()];
}
