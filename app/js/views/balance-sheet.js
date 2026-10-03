// Balance sheet checks for a month: cash account by account (GL against the statements proof of
// cash has, petty cash, the clearing account) and Accounts Payable against the AP aging report.

import { h, mount, table, toast, fileButton, statusPill } from '../ui.js';
import { loadTrialBalance, saveTrialBalance, loadPocMonth, loadCds, listApAging, saveApAging, loadBsConfig } from '../data.js';
import { parseTrialBalance, parseTrialBalanceText, looksLikeTrialBalance } from '../tb.js';
import { parseApAging, apTieOut, AP_ACCOUNT, BUCKETS } from '../bs/ap-aging.js';
import { cashTieOut, PETTY_CASH, CLEARING } from '../bs/cash.js';
import { autoFigures, BANK_SOURCES } from '../poc/calc.js';
import { monthSummary } from '../cd/schedule.js';
import { readWorkbook } from '../xlsx-io.js';
import { pdfLines } from '../pdf-text.js';
import { explain } from '../store.js';
import { nowIso, when } from '../audit.js';
import { money } from '../money.js';
import { monthName, addMonths, currentMonth } from '../fiscal.js';

const MONTH_KEY = 'monthclose:bs-month';

// Every account's balance at the end of `month`: the month's TB (ending) or next month's (beginning).
async function balancesAt(month) {
  const tb = await loadTrialBalance(month);
  if (tb) return { tb, balances: Object.fromEntries(Object.entries(tb.accounts).map(([a, x]) => [a, { description: x.description, end: x.end }])) };
  const next = await loadTrialBalance(addMonths(month, 1));
  if (next) return { tb: next, balances: Object.fromEntries(Object.entries(next.accounts).map(([a, x]) => [a, { description: x.description, end: x.begin }])) };
  return { tb: null, balances: null };
}

// Statement ending balances proof of cash has for the month, by its account id.
function statementEndings(rec, cds, month) {
  if (!rec && !cds.length) return {};
  const cd = { ...monthSummary(cds, month), hasData: cds.some((x) => x.earned?.[month]) };
  const auto = rec ? autoFigures(rec, cd) : cd.hasData ? autoFigures({}, cd) : {};
  const out = {};
  for (const s of BANK_SOURCES) {
    const v = auto[s.id]?.ending ?? rec?.bank?.[s.id]?.ending;
    if (v != null) out[s.id] = v;
  }
  return out;
}

export async function readTrialBalance(file) {
  if (/\.pdf$/i.test(file.name)) {
    const lines = await pdfLines(await file.arrayBuffer());
    if (!looksLikeTrialBalance(lines)) throw new Error('This PDF isn’t a Trial Balance Summary.');
    return parseTrialBalanceText(lines);
  }
  const { XLSX, wb } = await readWorkbook(file);
  return parseTrialBalance(XLSX, wb);
}

export default async function (main, { user, rerender }) {
  const agings = await listApAging();
  let month = null;
  try { month = localStorage.getItem(MONTH_KEY); } catch { /* ignore */ }
  if (!month) month = agings.map((a) => a.month).sort().pop() || addMonths(currentMonth(), -1);
  const pickMonth = (m) => { try { localStorage.setItem(MONTH_KEY, m); } catch { /* ignore */ } rerender(); };

  const [{ tb, balances }, rec, cds, cfg] = await Promise.all([balancesAt(month), loadPocMonth(month), loadCds(), loadBsConfig()]);
  const aging = agings.find((a) => a.month === month) || null;

  async function onTrialBalance(file) {
    try {
      const t = await readTrialBalance(file);
      await saveTrialBalance({ ...t, fileName: file.name, uploadedBy: user, uploadedAt: nowIso() });
      toast(`Trial balance for ${monthName(t.month)} saved.`);
      pickMonth(t.month);
    } catch (err) { toast(explain(err, `${file.name}:`), 'error'); }
  }
  async function onAging(file) {
    try {
      const { XLSX, wb } = await readWorkbook(file);
      const a = parseApAging(XLSX, wb);
      await saveApAging({ ...a, fileName: file.name, uploadedBy: user, uploadedAt: nowIso() });
      toast(`AP aging for ${monthName(a.month)} saved.`);
      pickMonth(a.month);
    } catch (err) { toast(explain(err, `${file.name}:`), 'error'); }
  }

  const tbNote = tb ? h('p', { class: 'muted small' }, `GL balances from the trial balance for ${monthName(tb.month)}${tb.month === month ? '' : ' (its beginning balances)'}${tb.fileName ? ` · ${tb.fileName}` : ''}${tb.uploadedBy ? ` · ${tb.uploadedBy}, ${when(tb.uploadedAt)}` : ''}.`) : null;

  mount(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `Balance sheet checks — ${monthName(month)}`),
        h('p', { class: 'muted' }, 'Cash on the balance sheet and Accounts Payable, tied to the trial balance.')),
      h('div', { class: 'actions' },
        h('label', { class: 'month-pick' }, h('span', {}, 'Month'), h('input', { type: 'month', value: month, onchange: (e) => e.target.value && pickMonth(e.target.value) })),
        fileButton('Upload trial balance…', '.pdf,.xlsx', onTrialBalance),
        fileButton('Upload AP aging…', '.xlsx', onAging))),
    balances ? null : h('div', { class: 'notice warn' }, `No trial balance for ${monthName(month)} yet. Upload the Trial Balance Summary for ${monthName(month)} (PDF or Excel) to see the GL side.`),
    cashSection(balances, statementEndings(rec, cds, month), cfg, month),
    apSection(aging, balances, month),
    tbNote);
}

function cashSection(balances, endings, cfg, month) {
  if (!balances) return null;
  const t = cashTieOut(balances, endings, cfg);
  const check = (r) => {
    if (r.account === PETTY_CASH) return r.flag ? statusPill('Moved', 'bad') : statusPill(`Fixed at ${money(cfg.pettyCash)}`, 'good');
    if (r.account === CLEARING) return r.flag ? statusPill('Not cleared', 'bad') : statusPill(r.gl ? 'Small balance' : 'Cleared', r.gl ? 'warn' : 'good');
    if (r.statement == null) return r.source ? statusPill('No statement yet', 'neutral') : null;
    return r.diff === 0 ? statusPill('Matches statement', 'good') : statusPill('Reconciling items', 'info');
  };
  return h('section', {},
    h('h2', {}, 'Cash'),
    h('div', { class: 'stats' },
      stat('Total cash on the balance sheet', money(t.total)),
      stat('Statements in proof of cash', `${t.rows.filter((r) => r.statement != null).length} of ${t.rows.filter((r) => r.source).length}`),
      stat('Checks', t.flags.length ? h('span', { class: 'error' }, `${t.flags.length} to look at`) : h('span', { class: 'good-text' }, 'All clear'))),
    t.flags.length ? h('div', { class: 'notice bad' }, h('ul', {}, t.flags.map((r) => h('li', {}, `${r.account} ${r.label}: ${money(r.gl, { dash: false })}. ${r.flag.text}`)))) : null,
    table([
      { label: 'Account', cell: (r) => r.account },
      { label: 'Name', cell: (r) => r.label },
      { label: 'GL balance', num: true, cell: (r) => money(r.gl, { dash: false }) },
      { label: 'Statement ending', num: true, cell: (r) => (r.statement == null ? '' : money(r.statement, { dash: false })) },
      { label: 'Difference', num: true, cell: (r) => (r.diff == null ? '' : money(r.diff)) },
      { label: '', cell: check },
    ], t.rows, { foot: (c) => (c.label === 'Name' ? 'Total cash' : c.label === 'GL balance' ? money(t.total) : '') }),
    h('p', { class: 'muted small' }, `A difference between a statement and the GL is timing — checks not yet cleared, deposits in transit — and proof of cash works through it for ${monthName(month)}. Clearing (1200) warns above ${money(cfg.clearingThreshold)} either way.`));
}

function apSection(aging, balances, month) {
  const gl = balances ? (balances[AP_ACCOUNT]?.end ?? 0) : null;
  if (!aging) return h('section', {}, h('h2', {}, 'Accounts payable'),
    h('p', { class: 'muted' }, `Upload the AP Aged Period-Sensitive report for ${monthName(month)} (Excel) to tie it to GL ${AP_ACCOUNT}${gl != null ? ` (${money(gl, { dash: false })})` : ''}.`));
  const t = apTieOut(aging, gl);
  const verdict = gl == null ? statusPill('Needs the trial balance', 'neutral')
    : t.ties ? statusPill('Ties to the GL', 'good') : statusPill(`Off by ${money(t.variance, { dash: false })}`, 'bad');
  return h('section', {},
    h('h2', {}, 'Accounts payable'),
    h('div', { class: 'cards wide' },
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h3', {}, 'Tie-out'), h('span', { class: 'spacer' }), verdict),
        h('div', { class: 'recon' },
          recon('AP aging, company total', money(t.total, { dash: false })),
          recon(`GL ${AP_ACCOUNT} Accounts Payable`, gl == null ? h('span', { class: 'muted' }, 'upload a trial balance') : money(gl, { dash: false })),
          recon('Difference', t.variance == null ? '—' : h('span', { class: t.ties ? 'good-text' : 'error' }, money(t.variance, { dash: false })), 'total')),
        t.addsUp ? null : h('p', { class: 'error small' }, 'The report’s documents don’t add up to its own company total — export it again.')),
      h('div', { class: 'card' }, h('h3', {}, 'By age'),
        h('div', { class: 'recon' }, BUCKETS.map(([k, label]) => recon(label, h('span', { class: (k === 'd90' || k === 'over90') && aging.total[k] ? 'error' : '' }, money(aging.total[k]))))))),
    h('h3', {}, 'Over 60 days past due'),
    t.exceptions.length
      ? table([
        { label: 'Vendor', cell: (x) => x.vendor },
        { label: 'Ref.', cell: (x) => x.ref },
        { label: 'Vendor ref.', cell: (x) => x.vendorRef },
        { label: 'Due', cell: (x) => x.due || '' },
        { label: 'Days past due', num: true, cell: (x) => x.daysPastDue ?? '' },
        { label: 'Over 60 days', num: true, cell: (x) => money(x.amount) },
      ], t.exceptions)
      : h('p', { class: 'good-text' }, 'Nothing over 60 days.'),
    h('details', {}, h('summary', {}, `Every open bill (${aging.vendors.reduce((n, v) => n + v.docs.length, 0)})`),
      table([
        { label: 'Vendor', cell: (x) => x.vendor },
        { label: 'Ref.', cell: (x) => x.ref },
        { label: 'Doc. date', cell: (x) => x.date || '' },
        { label: 'Due', cell: (x) => x.due || '' },
        ...BUCKETS.map(([k, label]) => ({ label, num: true, cell: (x) => money(x[k]) })),
        { label: 'Balance', num: true, cell: (x) => money(x.balance) },
      ], aging.vendors.flatMap((v) => v.docs.map((d) => ({ ...d, vendor: v.name }))))),
    h('p', { class: 'muted small' }, `${aging.fileName || 'AP aging'} · aged on ${aging.agedOn || '?'}${aging.uploadedBy ? ` · ${aging.uploadedBy}, ${when(aging.uploadedAt)}` : ''}.`));
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));
}
function recon(label, value, cls = '') {
  return h('div', { class: `recon-row ${cls}` }, h('span', {}, label), h('span', { class: 'num' }, value));
}
