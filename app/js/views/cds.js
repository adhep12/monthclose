import { h, mount, table, toast, fileButton, statusPill, ask, askValue, notify } from '../ui.js';
import { loadCds, saveCd, loadTrialBalance, loadConfig } from '../data.js';
import { monthSummary, fyMonths, applyCdarsStatement, applyIntrafiExport, parseCdarsWorkbook, cdInterestJE, expectedInterest, earnedThrough } from '../cd/schedule.js';
import { readStatementFile, ACCEPT } from '../ingest.js';
import { readWorkbook, downloadWorkbook } from '../xlsx-io.js';
import { jeRows } from '../fa/je.js';
import { jeTable } from './je-table.js';
import { balanceAtEndOf } from '../tb.js';
import { money, parseAmount, round2 } from '../money.js';
import { fiscalYear, monthName, addMonths, lastDayOfMonth, monthOfDate, currentMonth } from '../fiscal.js';
import { explain, uploadFile, filesAvailable } from '../store.js';
import { when } from '../audit.js';
import { statementName, renamed, statementTags } from '../naming.js';
import { acct, setAccountNames } from '../accounts.js';

const SOURCE_LABEL = { statement: 'CDARS statement', workbook: 'old workbook', export: 'IntraFi export', typed: 'typed' };

// GL 1150 at the end of `month`: from that month's TB (ending) or the next month's (beginning).
export async function gl1150(month, account = '1150') {
  const tb = (await loadTrialBalance(addMonths(month, 1))) || (await loadTrialBalance(month));
  if (!tb) return null;
  const v = balanceAtEndOf(tb, account, month);
  return v == null ? null : { balance: v, tb };
}

const MONTH_KEY = 'monthclose:cd-month';

export default async function (main, { user, rerender }) {
  const cdsFirst = await loadCds();
  // The month shown: last picked on this browser, else the latest month with CD interest.
  let month = null;
  try { month = localStorage.getItem(MONTH_KEY); } catch { /* ignore */ }
  if (!month) month = cdsFirst.flatMap((c) => Object.keys(c.earned || {})).sort().pop() || addMonths(currentMonth(), -1);
  const pickMonth = (m) => { try { localStorage.setItem(MONTH_KEY, m); } catch { /* ignore */ } rerender(); };
  const [cds, gl, cfg] = [cdsFirst, await gl1150(month), await loadConfig()];
  setAccountNames(cfg.accountNames);
  const fy = fiscalYear(month);
  const months = fyMonths(fy);
  const s = monthSummary(cds, month);
  const variance = gl ? round2(s.balance - gl.balance) : null;

  async function persist(list, msg) {
    let n = 0;
    try { for (const cd of list) { await saveCd(cd); n++; } toast(msg); rerender(); }
    catch (err) { toast(explain(err, `Saved ${n} of ${list.length} CDs.`), 'error'); }
  }

  async function onUpload(file) {
    try {
      const r = await readStatementFile(file);
      if (r.type === 'skip') { toast(`${file.name}: ${r.why}`); return; }
      if (r.type === 'picture') { toast(`${file.name}: ${r.why}`, 'error'); return; }
      let fileKey = null;
      const stored = r.type === 'cdars' ? statementName({ account: 'cd', period: r.data.date, original: file.name })
        : statementName({ account: 'IntraFiExport', period: month, original: file.name });
      if (filesAvailable()) { try { fileKey = (await uploadFile('statements', renamed(file, stored)))?.key || null; } catch { /* numbers still used */ } }
      if (r.type === 'cdars') {
        const touched = applyCdarsStatement(cds, r.data, { user, file: file.name });
        touched.forEach((cd) => { cd.files = { ...(cd.files || {}), [r.data.date]: { name: stored, originalName: file.name, ...statementTags('cd', r.data.month), key: fileKey } }; });
        await persist(touched, `${file.name}: updated ${touched.map((c) => `…${c.last4}`).join(', ')} for ${monthName(r.data.month)}.`);
      } else if (r.type === 'intrafi-export') {
        const m = await askValue('Which month is this export for?', 'Accrued interest in the export runs through the day before you ran it — run on the 1st, it’s the month before.', { type: 'month', value: month, ok: 'Apply' });
        if (!m || !/^\d{4}-\d{2}$/.test(m)) return;
        const notes = applyIntrafiExport(cds, r.data, m, { user });
        await persist(cds.filter((c) => c.earned?.[m]?.source === 'export'), `Updated accruals for ${monthName(m)} from the IntraFi export.`);
        if (notes.length) notify('From the IntraFi export', notes);
      } else {
        toast(`${file.name} is a ${r.type} file — attach it on the Proof of cash page.`, 'error');
      }
    } catch (err) { console.error(err); toast(`${file.name}: ${err.message}`, 'error'); }
  }

  async function onWorkbook(file) {
    try {
      const { XLSX, wb } = await readWorkbook(file);
      const res = parseCdarsWorkbook(XLSX, wb);
      const existing = new Set(cds.map((c) => c.id));
      const fresh = res.cds.filter((c) => !existing.has(c.id));
      if (!(await ask('Import CDARS workbook', `${res.cds.length} CDs in “${res.sheetName}”. ${fresh.length} are new; ${res.cds.length - fresh.length} already here keep their statement figures and take the workbook’s only for months that have none.`, { ok: 'Import' }))) return;
      const merged = res.cds.map((w) => {
        const cur = cds.find((c) => c.id === w.id);
        if (!cur) return { ...w, importedBy: user, importedAt: new Date().toISOString() };
        const earned = { ...w.earned, ...Object.fromEntries(Object.entries(cur.earned || {}).filter(([, e]) => e.source !== 'workbook')) };
        return { ...w, ...cur, earned, chain: cur.chain || w.chain };
      });
      await persist(merged, `Imported ${merged.length} CDs.`);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function downloadJe() {
    const lines = cdInterestJE(cds, month, { names: cfg.accountNames });
    await downloadWorkbook(`CD interest JE - ${month}.xlsx`, [{ name: 'Journal Transactions', rows: jeRows(lines), cols: [16, 10, 9, 30, 11, 10, 8, 6, 13, 13, 26] }]);
  }

  // Month-by-month grid for the fiscal year.
  const inFy = cds.filter((cd) => months.some((m) => cd.earned?.[m]?.amount) || months.some((m) => cd.maturity && monthOfDate(cd.maturity) === m))
    .sort((a, b) => (a.effective || '').localeCompare(b.effective || ''));
  const sums = months.map((m) => monthSummary(cds, m));
  const cell = (cd, m) => {
    const e = cd.earned?.[m];
    if (!e?.amount) return '';
    const exp = expectedInterest(cd, m);
    const off = exp && Math.abs(e.amount - exp) > Math.max(25, exp * 0.01);
    return h('span', { class: e.source === 'statement' ? 'cell-statement' : e.source === 'typed' ? 'cell-typed' : '',
      title: `${SOURCE_LABEL[e.source] || e.source}${e.by ? ` · ${e.by} ${when(e.at)}` : ''}${exp ? ` · rate × days ≈ ${money(exp)}` : ''}` },
      money(e.amount), off ? ' ⚠' : '');
  };

  const detailHost = h('div');
  function showDetail(cd) {
    const earnedRows = Object.entries(cd.earned || {}).sort(([a], [b]) => a.localeCompare(b));
    const field = (label, key, isNum) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label),
      h('input', { type: isNum ? 'text' : key === 'effective' || key === 'maturity' ? 'date' : 'text', class: isNum ? 'num' : '', value: cd[key] ?? '',
        onchange: (e) => { cd[key] = isNum ? parseAmount(e.target.value) : e.target.value; } }));
    mount(detailHost, h('div', { class: 'card', style: { marginTop: '1rem' } },
      h('div', { class: 'row' }, h('h3', {}, `CD …${cd.last4}`), h('span', { class: 'muted small' }, cd.id), h('span', { class: 'spacer' }),
        h('button', { onclick: () => mount(detailHost) }, 'Close')),
      h('div', { class: 'form-grid' },
        field('Chain', 'chain'), field('Effective', 'effective'), field('Maturity', 'maturity'),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Rate %'), h('input', { class: 'num', value: cd.rate ? round2(cd.rate * 100) : '', onchange: (e) => { cd.rate = parseAmount(e.target.value) / 100; } })),
        field('Principal', 'principal', true), field('Interest paid at maturity', 'interestPaid', true)),
      h('h3', {}, 'Interest earned by month'),
      table([
        { label: 'Month', cell: ([m]) => monthName(m) },
        { label: 'Amount', num: true, cell: ([m, e]) => h('input', { class: 'num', size: 12, value: e.amount, onchange: (ev) => {
          const v = parseAmount(ev.target.value);
          if (Number.isFinite(v)) cd.earned[m] = { amount: v, source: 'typed', by: user, at: new Date().toISOString(), was: e.amount };
        } }) },
        { label: 'Source', cell: ([, e]) => `${SOURCE_LABEL[e.source] || e.source}${e.by ? ` · ${e.by} · ${when(e.at)}` : ''}` },
        { label: 'Rate × days', num: true, cell: ([m]) => money(expectedInterest(cd, m)) },
      ], earnedRows),
      h('div', { class: 'row', style: { marginTop: '.75rem' } },
        h('button', { class: 'primary', onclick: () => persist([cd], 'CD saved.') }, 'Save'),
        h('span', { class: 'muted small' }, `Earned to date ${money(earnedThrough(cd, '9999-12'))}. Typed changes are stamped with your name.`))));
    detailHost.scrollIntoView({ behavior: 'smooth' });
  }

  mount(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `CD schedule — FY${fy}`), h('p', { class: 'muted' }, 'CDARS ladder, interest earned each month, interest paid at maturity, and the GL 1150 tie-out.')),
      h('div', { class: 'actions' },
        h('label', { class: 'month-pick' }, h('span', {}, 'Month'), h('input', { type: 'month', value: month, onchange: (e) => e.target.value && pickMonth(e.target.value) })),
        fileButton('Upload CDARS statements / IntraFi export…', ACCEPT, async (files) => { for (const f of files) await onUpload(f); }, { class: 'primary', multiple: true }),
        fileButton('Import CDARS workbook…', '.xlsx', onWorkbook))),

    h('div', { class: 'cards wide' },
      h('div', { class: 'card' }, h('h3', {}, monthName(month)),
        h('div', { class: 'recon' },
          row(`Interest earned (accrue: Dr ${acct('1150')} / Cr ${acct('4050')})`, money(s.accrued)),
          row('Interest paid at maturity (rolled over)', money(s.realized)),
          row('Principal of open CDs', money(s.principal)),
          row('Interest earned, not yet paid', money(s.unpaidInterest)),
          row('Balance per schedule', money(s.balance), 'total'),
          row('GL 1150', gl ? money(gl.balance) : h('span', { class: 'muted' }, 'upload a trial balance')),
          row('Difference', variance == null ? '—' : h('span', { class: variance === 0 ? 'good-text' : 'error' }, money(variance, { dash: false })), 'total'))),
      h('div', { class: 'card' }, h('h3', {}, 'Interest JE'),
        h('p', { class: 'small' }, `${cdInterestJE(cds, month).length / 2} CDs earned interest in ${monthName(month)}.`),
        h('div', { class: 'row' }, h('button', { onclick: downloadJe, disabled: !s.accrued }, 'Download for Acumatica')),
        h('details', { class: 'small' }, h('summary', {}, 'Preview'), jeTable(cdInterestJE(cds, month, { names: cfg.accountNames }))))),

    h('h2', {}, 'Schedule'),
    h('p', { class: 'muted small' }, 'Green = from a CDARS statement · amber = typed · plain = from the old workbook. ⚠ = more than 1% off rate × days. Hover a figure for its source; click a CD to edit.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'CD'), h('th', {}, 'Effective'), h('th', {}, 'Maturity'), h('th', { class: 'num' }, 'Rate'), h('th', { class: 'num' }, 'Principal'),
        months.map((m) => h('th', { class: 'num' }, monthName(m, { short: true }).split(' ')[0])), h('th', { class: 'num' }, 'Paid at maturity'))),
      h('tbody', {}, inFy.length ? inFy.map((cd) => h('tr', { class: 'clickable', onclick: () => showDetail(cd) },
        h('td', {}, `…${cd.last4}`, cd.chain ? h('span', { class: 'muted small' }, ` ${cd.chain}`) : null),
        h('td', {}, cd.effective || ''), h('td', {}, cd.maturity || ''),
        h('td', { class: 'num' }, cd.rate ? `${round2(cd.rate * 100)}%` : ''),
        h('td', { class: 'num' }, money(cd.principal)),
        months.map((m) => h('td', { class: 'num' }, cell(cd, m))),
        h('td', { class: 'num' }, cd.status === 'matured' ? money(cd.interestPaid) : statusPill('open', 'info'))))
        : h('tr', {}, h('td', { colspan: months.length + 6, class: 'empty' }, 'No CDs yet — import the CDARS workbook, then upload statements each month.'))),
      h('tfoot', {},
        h('tr', {}, h('td', { colspan: 5 }, 'Interest earned'), sums.map((x) => h('td', { class: 'num' }, money(x.accrued))), h('td')),
        h('tr', {}, h('td', { colspan: 5 }, 'Paid at maturity'), sums.map((x) => h('td', { class: 'num' }, money(x.realized))), h('td')),
        h('tr', {}, h('td', { colspan: 5 }, 'Balance at month end'), sums.map((x) => h('td', { class: 'num' }, money(x.balance))), h('td'))))),
    detailHost,
  );
  void lastDayOfMonth;
}

function row(label, value, cls = '') {
  return h('div', { class: `recon-row ${cls}` }, h('span', {}, label), h('span', { class: 'num' }, value));
}
