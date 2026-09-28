// The export's audit trail. Every adjustment line, and every deposit in transit, as a row someone
// outside the team can follow without the app: a reference number, what moved and who it was,
// where it is on the bank statement, the GL batch and line that booked it, and how to check it.
//
// Pure: takes what the sheet already worked out (computePoc, depositChecks, the GL uploads), so it
// can be tested without a browser.

import { reviewableDeposits, outgoingItems, EVIDENCE, ADJUSTMENT_TYPES } from './calc.js';
import { wiseSender } from './banks.js';
import { accountName, depositHint } from './gl-deposits.js';
import { round2, sum } from '../money.js';

const money2 = (v) => (v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
const priorMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; };
const same = (a, b) => Math.abs(Math.abs(a) - Math.abs(b)) < 0.005;
// Acumatica batch numbers named in a note ("GL GL017661", "AP014203").
const BATCH = /\b((?:GL|AR|AP|CA|IN)\d{5,})\b/;
const PLUMBING = /^Trnsfr (from|to) Checking Acct/i;

// Every GL batch the uploads know, by Acumatica's batch number: its date, description, what it
// booked (cash side included) and, for batches that touch a bank account, its lines.
export function glBatchIndex(glBy = {}) {
  const out = new Map();
  const put = (m, x, cash) => {
    if (!x?.batch || out.has(x.batch)) return;
    const accounts = { ...(x.accounts || {}) };
    // Cash receipts keep the cash side apart (x.amount, debit positive); put it back.
    if (cash && x.amount) accounts[cash] = round2((accounts[cash] || 0) - x.amount);
    out.set(x.batch, { batch: x.batch, month: m, date: x.date, desc: x.desc, accounts, cash, lines: x.lines || null, module: x.module || null });
  };
  for (const [m, g] of Object.entries(glBy)) {
    for (const x of g?.receipts || []) put(m, x, '1100');
    for (const x of g?.keyReceipts || []) put(m, x, '1061');
    for (const x of g?.wiseReceipts || []) put(m, x, '1013');
    for (const x of [...(g?.noCashRevenue || []), ...(g?.stripeReclass || [])]) put(m, x, null);
    for (const x of g?.paypalRefunds || []) put(m, { ...x, accounts: { 4012: -x.amount } }, null);
  }
  return out;
}

// What a batch booked, as a journal entry: "Dr 1100 Cass 5,000.00 · Cr 4018 5,000.00". The
// accounts are kept net credit positive.
export function bookedText(b) {
  if (!b?.accounts) return '';
  const e = Object.entries(b.accounts).filter(([, v]) => Math.abs(v) >= 0.005);
  const dr = e.filter(([, v]) => v < 0), cr = e.filter(([, v]) => v > 0);
  const name = (a) => accountName(a, { 1100: 'Cass' });
  return [...dr.map(([a, v]) => `Dr ${name(a)} ${money2(-v)}`), ...cr.map(([a, v]) => `Cr ${name(a)} ${money2(v)}`)].join(' · ');
}

// Every transaction on the month's statements, with the document it's on.
function statementLines(rec) {
  const out = [];
  for (const kind of ['operating', 'incoming', 'outgoing']) {
    const s = rec?.statements?.[kind];
    if (!s) continue;
    const doc = `${s.label || 'Cass'}${s.last4 ? ` …${s.last4}` : ''} statement${s.statementDate ? ` dated ${s.statementDate}` : ''}${s.fileName ? ` (${s.fileName})` : ''}`;
    for (const t of s.transactions || []) out.push({ ...t, doc, where: t.section === 'credit' ? 'Deposits and other credits' : t.section === 'check' ? 'Checks' : 'Other debits and withdrawals' });
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
  const b = rec?.bankStatements?.[account];
  const f = b?.fileName ? ` (${b.fileName})` : '';
  if (account === 'stripe') return `Stripe monthly statement CSV${rec?.stripe?.fileName ? ` (${rec.stripe.fileName})` : ''}`;
  if (account === 'paypal') return `PayPal statement${f}`;
  if (account === 'wise') return `Wise statement${f}`;
  if (account === 'keyOp') return `KeyBank Operating statement${f} — total deposits only`;
  return '';
}

// One row per line of each adjustment (a sweep, a transfer, a refund), then this month's deposits
// in transit and last month's that cleared. Rows are in sheet order (order: the sheet's adjustment
// rows), each kind of line together by date, and numbered in that order: A-2025-11-001.
// ctx: { m, rec, c (computePoc), glIndex, priorDeposits, priorRec, groupOf, lineOf, order }
export function auditRows({ m, rec, c, glIndex = new Map(), priorDeposits = null, priorRec = null, groupOf, lineOf, order = [] }) {
  const stmt = statementLines(rec || {});
  const dep = c.deposits;
  const matchOf = (id) => (id ? dep?.lines?.find((x) => x.line.id === id)?.match || null : null);
  const rows = [];

  for (const a of c.adjustments) {
    const items = a.detail?.length ? a.detail : [{ date: a.date || '', desc: a.label, amount: a.amount, note: a.note }];
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
      const plumbing = PLUMBING.test(d.desc || '');
      const who = whoOf({ a, d, t, glLine, plumbing });
      const evidence = a.evidence || 'statement';
      const row = {
        ref: '', month: m, group: groupOf(a), line: lineOf(a), account: a.account || 'cassOp',
        type: ADJUSTMENT_TYPES[a.type] || (a.auto ? 'From the statements' : ''),
        date: d.date || '', desc: plumbing && d.note ? `${d.desc} — ${d.note}` : d.desc || a.label, who, amount: round2(shown),
        direction: shown < 0 ? 'Taken out of bank revenue' : 'Added to bank revenue',
        bankDoc: t?.doc || (a.statement ? a.statement.replace(/:.*$/, '') : accountDoc(rec, a.account)),
        bankWhere: t?.where || '', bankDate: t?.date || '', bankDesc: t ? [t.desc, t.detail].filter(Boolean).join(' — ') : a.statement ? a.statement.replace(/^[^:]*:\s*/, '') : '',
        bankAmount: t ? t.amount : null,
        glBatch: batchNo || '', glDate: b?.date || '', glDesc: b?.desc || '', glMonth: b?.month ? monthLabel(b.month) : '',
        glLine: glLine?.id || '', glPayer: glLine ? [glLine.cv, glLine.d].filter(Boolean).join(' · ') : '', glBooked: bookedText(b),
        evidence: (EVIDENCE[evidence] || EVIDENCE.statement).label, evidenceKey: evidence,
        why: a.why || '', note: [a.note, d.note && d.note !== a.note ? d.note : ''].filter(Boolean).join(' · '),
        enteredBy: a.enteredBy || '', enteredAt: a.enteredAt || '',
        a, item: { a, date: d.date || '', desc: d.desc || a.label, shown },
      };
      row.verify = verifyText(row, { a, t, b, rec });
      rows.push(row);
    }
  }
  // Deposits in transit: this month's, less last month's (which reached the bank this month). The
  // sheet's Timing row includes the change.
  if (c.ditChange != null) {
    for (const x of ditList(dep?.dit, rec)) rows.push(ditRow(x, 1, `Deposits in transit at the end of ${monthLabel(m)}`));
    if (!c.priorDitMissing) for (const x of ditList(priorDeposits?.dit, priorRec)) rows.push(ditRow(x, -1, `${monthLabel(priorMonth(m))}’s deposits in transit, cleared this month`));
  }
  const rank = (g) => (order.includes(g) ? order.indexOf(g) : order.length);
  const lines = [...new Set(rows.map((r) => r.line))];
  rows.forEach((r, i) => { r.i = i; });
  rows.sort((x, y) => rank(x.group) - rank(y.group) || lines.indexOf(x.line) - lines.indexOf(y.line) || String(x.date).localeCompare(String(y.date)) || x.i - y.i);
  rows.forEach((r, i) => { r.ref = `A-${m}-${String(i + 1).padStart(3, '0')}`; delete r.i; });
  return rows;

  function ditRow(x, sign, line) {
    const b = x.batch ? glIndex.get(x.batch) : null;
    const amount = round2(sign * x.amount);
    const cleared = sign > 0 ? nextMonth(m) : m;
    const row = {
      ref: '', month: m, group: groupOf({ type: 'timing' }), line, account: 'cassOp', type: ADJUSTMENT_TYPES.timing,
      date: x.date || '', desc: x.desc, who: '', amount, direction: amount < 0 ? 'Taken out of bank revenue' : 'Added to bank revenue',
      bankDoc: x.batch ? `Cass Operating statement for ${monthLabel(cleared)}` : '', bankWhere: x.batch ? 'Deposits and other credits' : '', bankDate: '', bankDesc: x.evidence || '', bankAmount: null,
      glBatch: x.batch || '', glDate: b?.date || x.date || '', glDesc: b?.desc || (x.batch ? x.desc : ''), glMonth: b?.month ? monthLabel(b.month) : '',
      glLine: '', glPayer: '', glBooked: bookedText(b),
      evidence: x.batch ? (x.settled ? EVIDENCE.both.label : EVIDENCE.gl.label) : EVIDENCE.typed.label, evidenceKey: x.batch ? (x.settled ? 'both' : 'gl') : 'typed',
      why: sign > 0 ? 'Booked as revenue in the GL this month, but reached the bank next month — added so the bank side matches the GL.'
        : 'Counted in last month’s deposits in transit; the money reached the bank this month, so it comes out here to avoid counting it twice.',
      note: x.status || '', enteredBy: x.by || '', enteredAt: '', dit: true,
    };
    row.verify = x.batch
      ? `In Acumatica open batch ${x.batch}${row.glDate ? ` (${row.glDate})` : ''}: revenue booked in ${row.glMonth || 'the month'}. On the ${monthLabel(cleared)} Cass Operating statement, find the deposit of ${money2(Math.abs(x.amount))} in the first days of the month.`
      : `Entered by hand${x.by ? ` by ${x.by}` : ''}. Ask for the deposit slip, and find the ${money2(Math.abs(x.amount))} deposit early on the ${monthLabel(cleared)} statement.`;
    return row;
  }
}

// A month's deposits in transit, one per line: from the GL where it has the month, else typed or
// imported from the workbook.
function ditList(dit, rec) {
  if (dit) {
    return [
      ...dit.rows.filter((r) => r.counts).map((r) => ({ batch: r.batch, date: r.date, desc: r.desc, amount: round2(r.sign * r.amount), evidence: r.evidence, settled: r.settled,
        status: r.settled ? 'The statements show it' : r.choice ? `Confirmed by ${r.choice.by}${r.choice.note ? ` — ${r.choice.note}` : ''}` : r.flagged ? 'To confirm' : 'From the GL', by: r.choice?.by || '' })),
      ...dit.manual.filter((x) => !x.duplicate).map((x) => ({ batch: null, date: x.d.date || '', desc: x.d.note || 'Typed deposit in transit', amount: x.d.amount, status: 'Typed', by: x.d.enteredBy || '' })),
    ];
  }
  return (rec?.dit || []).map((d) => ({ batch: null, date: d.date || '', desc: d.note || 'Deposit in transit', amount: d.amount, status: String(d.id || '').startsWith('imp-') ? 'From the workbook' : 'Typed', by: d.enteredBy || '' }));
}

// The GL line that is this item: the one the deposit match tied it to, else the one line of the
// batch (off the cash side) with this amount.
function glLineFor(b, match, amount, t) {
  // (A deposit matched one to one is tied to the batch's cash line; the payer is on the other side.)
  const cash = b?.cash || '1100';
  const tie = match?.confidence?.tie;
  const tied = tie?.id ? b?.lines?.find((x) => x.id === tie.id) || { id: tie.id, d: tie.desc, cv: tie.cv } : null;
  if (tied && tied.a !== cash) return tied;
  const lines = (b?.lines || []).filter((x) => x.a !== cash);
  const hits = lines.filter((x) => same(x.amt, amount));
  if (hits.length === 1) return hits[0];
  if (t && hits.length > 1) return hits.find((x) => `${x.d} ${x.cv}`.toLowerCase().split(/\W+/).some((w) => w.length > 3 && `${t.desc} ${t.detail || ''}`.toLowerCase().includes(w))) || null;
  return null;
}

// Who the money came from or went to, in the words of whichever document names them best.
function whoOf({ a, d, t, glLine, plumbing }) {
  if (a.id === 'auto-stripe' || a.id === 'auto-stripe-disputes') return 'Stripe (our own account)';
  if (glLine?.cv || glLine?.d) return [glLine.d, glLine.cv].filter(Boolean).join(' · ');
  const sender = t?.account === 'wise' ? wiseSender(t.desc) : '';
  if (sender) return sender;
  if (plumbing) return d.note ? d.note.replace(/^Per the GL:\s*/, '') : 'Between our own Cass accounts';
  if (t) return [t.desc, t.detail].filter(Boolean).join(' — ');
  return '';
}

// How to check it, step by step, in the order an auditor would: the bank document, then the GL.
function verifyText(r, { a, t, b }) {
  const steps = [];
  if (t) steps.push(`On the ${r.bankDoc}, under “${t.where}”, find ${t.date} ${money2(t.amount)} “${t.desc}”.`);
  else if (r.bankDesc) steps.push(`On the ${r.bankDoc || 'statement'}, find ${r.bankDesc}.`);
  else if (r.bankDoc && a.account !== 'cassOp') steps.push(`The ${r.bankDoc} is the source of the ${a.account === 'stripe' ? 'Stripe' : a.account} line this adjusts.`);
  if (r.glBatch) {
    steps.push(`In Acumatica, open batch ${r.glBatch}${r.glDate ? ` (${r.glDate})` : ''}${b?.desc ? ` “${b.desc}”` : ''}${r.glBooked ? `: it books ${r.glBooked}` : ''}${r.glLine ? `; line ${r.glLine}${r.glPayer ? ` names ${r.glPayer}` : ''}` : ''}.`);
  }
  if (a.type === 'transfer' && /Matches .* leaving/.test(a.note || '')) steps.push(`The other side: ${a.note.replace(/^Matches /, '')} — find it on that account’s statement.`);
  if (r.evidenceKey === 'gl') steps.push('No bank document shows this — it is a book entry. Ask for the support behind the GL batch (the reclass memo, the platform’s payout report, the receipt).');
  if (r.evidenceKey === 'glWhat') steps.push(`The statement doesn’t say who paid; vouch it to the check image or deposit slip${t ? ` (${depositHint(t.desc) || 'the bank’s deposit detail'})` : ''}.`);
  if (r.evidenceKey === 'typed') steps.push(`Entered by hand${r.enteredBy ? ` by ${r.enteredBy}` : ''}${a.note ? `: “${a.note}”` : ''} — ask for the document behind it.`);
  if (!steps.length && a.why) steps.push(`Worked out from the statements: ${a.why}`);
  return steps.join(' ');
}

// The rows totalled by month, group and line, with the refs each covers, for going from a number
// on the sheet to its lines.
export function auditSummary(rows) {
  const out = [];
  const key = (r) => `${r.month}|${r.group}|${r.line}`;
  const by = new Map();
  for (const r of rows) {
    const x = by.get(key(r)) || { month: r.month, group: r.group, line: r.line, count: 0, total: 0, first: r.ref, last: r.ref, glOnly: 0 };
    x.count++; x.total = round2(x.total + r.amount); x.last = r.ref;
    if (r.evidenceKey === 'gl') x.glOnly = round2(x.glOnly + Math.abs(r.amount));
    by.set(key(r), x);
  }
  for (const x of by.values()) out.push(x);
  return out;
}

// Every GL line of the batches the rows name, so the batches can be vouched without Acumatica.
export function auditGlLines(rows, glIndex) {
  const refs = new Map();
  for (const r of rows) if (r.glBatch) refs.set(r.glBatch, [...(refs.get(r.glBatch) || []), r.ref]);
  const out = [];
  for (const [batch, rs] of refs) {
    const b = glIndex.get(batch);
    if (!b?.lines?.length) continue;
    for (const l of b.lines) out.push({ refs: rs.join(', '), batch, date: b.date, desc: b.desc, id: l.id, account: accountName(l.a, { 1100: 'Cass' }), cv: l.cv || '', d: l.d || '', ref: l.ref || '', debit: l.amt > 0 ? l.amt : null, credit: l.amt < 0 ? -l.amt : null });
  }
  return out;
}

export const auditTotal = (rows) => round2(sum(rows, (r) => r.amount));
