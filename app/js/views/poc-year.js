// Proof of cash for a fiscal year, laid out like the "Proof of Cash - YYYY" workbook: a revenue and
// an interest column for each month, a YTD total of the months done so far, and the same row
// groups (per bank statement → adjustments for timing → adjusted → GL → difference), with the
// Cass Operating adjustment detail underneath.

import { h, mount, statusPill, toast } from '../ui.js';
import { loadPocMonths, listGlActivity, loadPocConfig, savePocConfig, loadCds, listSoa } from '../data.js';
import { monthSummary } from '../cd/schedule.js';
import { computePoc, glFigures, BANK_SOURCES } from '../poc/calc.js';
import { confirmationState } from '../audit.js';
import { money, round2, sum } from '../money.js';
import { fiscalYear, fyStart, addMonths, monthName } from '../fiscal.js';
import { explain } from '../store.js';

const FY_KEY = 'monthclose:poc-fy';
// Row order of the workbook's "Per Bank Statement" block.
const SHEET_ORDER = ['wise', 'paypal', 'stripe', 'keyOp', 'keyMM', 'ics', 'cd', 'delap', 'tschetter', 'cassOp'];

// Adjustment detail rows, named the way the workbook names them, so imported months and months
// built from statements land on the same row.
function adjKey(a) {
  if (a.id === 'auto-stripe') return 'Stripe Transfers';
  if (a.id === 'auto-incoming') return 'Incoming Wire Sweep Net activity';
  if (a.id === 'auto-outgoing') return 'Outgoing Wire Sweep Net activity';
  if (a.id?.startsWith('auto-ex-')) return 'Deposits that aren’t revenue';
  return a.label.trim().replace(/\s*-\s*plus \(minus\)?\s*$/i, '').replace(/^\((.*)\)$/, '$1').trim();
}

export default async function (main, { month, setMonth, rerender }) {
  const [recs, glActs, cfg, cds, soas] = await Promise.all([loadPocMonths(), listGlActivity(), loadPocConfig(), loadCds(), listSoa()]);
  const byMonth = Object.fromEntries(recs.map((r) => [r.month, r]));
  const glBy = Object.fromEntries(glActs.map((g) => [g.month, g]));
  const soaBy = Object.fromEntries(soas.map((s) => [s.month, s]));

  const hasData = (r) => r && !r.source?.ditOnly;
  const years = [...new Set([...(cfg.fiscalYears || []), fiscalYear(month), ...recs.filter(hasData).map((r) => fiscalYear(r.month))])].sort();
  let fy;
  try { fy = Number(localStorage.getItem(FY_KEY)) || fiscalYear(month); } catch { fy = fiscalYear(month); }
  if (!years.includes(fy)) fy = fiscalYear(month);
  const pickFy = (y) => { try { localStorage.setItem(FY_KEY, String(y)); } catch { /* ignore */ } rerender(); };

  async function addYear() {
    const next = Math.max(...years) + 1;
    if (!confirm(`Add FY${next} (October ${next - 1} – September ${next})?`)) return;
    try { await savePocConfig({ ...cfg, fiscalYears: [...new Set([...(cfg.fiscalYears || []), ...years, next])] }); pickFy(next); }
    catch (err) { toast(explain(err, 'Couldn’t add the year.'), 'error'); }
  }

  const months = Array.from({ length: 12 }, (_, i) => addMonths(fyStart(fy), i));
  const cols = months.map((m) => {
    const rec = byMonth[m];
    if (!hasData(rec)) return { m, rec: null, c: null };
    const gl = glFigures({ glActivity: glBy[m], soa: soaBy[m], month: m, config: cfg });
    const cd = { ...monthSummary(cds, m), hasData: cds.some((x) => x.earned?.[m]) };
    return { m, rec, c: computePoc(rec, { prior: byMonth[addMonths(m, -1)], gl, cd }) };
  });
  // YTD covers the months whose bank deposits have been entered; a month that only has, say,
  // deposits in transit or CD interest so far shows in its column but isn't totalled yet.
  const done = cols.filter((x) => x.c && x.c.bankRev);
  const line = (c, id) => c.lines.find((l) => l.id === id);

  // Every row: [label, revenue(c), interest(c), options]
  const bankRows = SHEET_ORDER.map((id) => {
    const src = BANK_SOURCES.find((s) => s.id === id);
    const mark = (k) => (c, rec) => {
      const l = line(c, id);
      if (l[k] == null) return null;
      const st = confirmationState(rec.bank?.[id], l.values);
      return { mark: st === 'confirmed' ? '✓' : st === 'stale' ? '!' : '', title: `${l.from === 'typed' ? 'Typed' : `From ${l.from || 'the workbook'}`}${st === 'confirmed' ? ` · confirmed by ${rec.bank[id].confirmation.by}` : st === 'stale' ? ' · changed since it was confirmed' : ''}` };
    };
    return { label: src.label, rev: (c) => line(c, id).rev, int: (c) => line(c, id).int, meta: { rev: mark('rev'), int: mark('int') } };
  });

  const adjLabels = [];
  for (const { c } of cols.filter((x) => x.c)) for (const a of c.adjustments) { const k = adjKey(a); if (!adjLabels.includes(k)) adjLabels.push(k); }
  const adjFor = (k) => (c) => { const list = c.adjustments.filter((a) => adjKey(a) === k); return list.length ? round2(sum(list, (a) => a.amount)) : null; };

  const rows = [
    { section: 'Per Bank Statement' },
    ...bankRows,
    { label: 'Cass Operating - Total Adjustments', rev: (c) => c.adjTotal, hint: 'Itemized below' },
    { label: 'Total Bank Revenue / Interest', rev: (c) => round2(c.bankRev + c.adjTotal), int: (c) => c.bankInt, strong: true },
    { section: 'Adjustments for Timing' },
    { label: 'Plus Deposit in Transit (change)', rev: (c) => c.ditChange },
    { label: 'Plus Accrued Interest', int: (c) => c.timing.accrued || 0 },
    { label: 'Less realized accrued interest from prior period', int: (c) => -(c.timing.realizedPrior || 0) },
    { label: 'Change in Restricted Revenue', rev: (c) => c.timing.restricted || null },
    { label: 'Merchandise AR', rev: (c) => c.timing.merchAR || null },
    { label: 'Bank Revenue - Adjusted', rev: (c) => c.revAdjusted, int: (c) => c.intAdjusted, strong: true },
    { label: 'Total GL Revenue / Interest Income', rev: (c) => c.glRev, int: (c) => c.glInt },
    { label: 'Difference', rev: (c) => c.diffRev, int: (c) => c.diffInt, strong: true, diff: true },
    { label: '% difference', pct: true },
    { section: 'Cass Operating Adjustments' },
    ...adjLabels.map((k) => ({ label: k, rev: adjFor(k) })),
  ];

  const ytd = (f) => (f ? round2(sum(done, (x) => f(x.c) || 0)) : null);
  const pctOf = (d, g) => (d == null || !g ? '' : `${((d / g) * 100).toFixed(2)}%`);
  const cell = (v, { strong, diff, meta } = {}) => {
    const cls = ['num'];
    if (diff && v != null && Math.abs(v) >= 1) cls.push(v < 0 ? 'neg' : 'pos');
    return h('td', { class: cls.join(' '), title: meta?.title || '' },
      v == null ? '' : strong ? h('strong', {}, money(v)) : money(v),
      meta?.mark ? h('span', { class: meta.mark === '✓' ? 'good-text' : 'warn-text' }, ` ${meta.mark}`) : null);
  };
  const statusOf = (rec) => (rec?.signoff?.reviewed ? statusPill('Reviewed', 'good') : rec?.signoff?.prepared ? statusPill('Prepared', 'info') : rec?.source?.kind === 'import' && !rec.updatedAt ? statusPill('From workbook', 'neutral') : rec ? statusPill('In progress', 'warn') : null);
  const openMonth = (m) => (e) => { e.preventDefault(); setMonth(m); location.hash = '#/poc/month'; };
  const range = done.length ? `${monthName(done[0].m, { short: true }).split(' ')[0]}–${monthName(done[done.length - 1].m, { short: true }).split(' ')[0]}` : 'no months yet';
  const nCols = 3 + months.length * 2;

  mount(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `${fy} Proof of Cash Summary`),
        h('p', { class: 'muted' }, 'Laid out like the workbook. Click a month to open it. ✓ = confirmed, ! = changed since it was confirmed; hover a figure for its source.')),
      h('div', { class: 'actions' },
        h('a', { class: 'btn primary', href: '#/poc/month' }, `Open ${monthName(month)}`),
        h('a', { class: 'btn', href: '#/poc/import' }, 'Import workbook'))),
    h('div', { class: 'row tabs' },
      years.map((y) => h('button', { class: y === fy ? 'tab active' : 'tab', onclick: () => pickFy(y) }, `FY${y}`)),
      h('button', { class: 'tab add', onclick: addYear }, '+ Add fiscal year')),
    h('div', { class: 'table-wrap sheet' }, h('table', {},
      h('thead', {},
        h('tr', {}, h('th', { class: 'label-col' }, ''),
          h('th', { class: 'num ytd', colspan: 2 }, 'YTD', h('div', { class: 'muted small' }, done.length ? `${range} · ${done.length} mo.` : range)),
          cols.map(({ m, rec }) => h('th', { class: 'num month', colspan: 2 },
            h('a', { href: '#/poc/month', onclick: openMonth(m) }, monthName(m, { short: true }).split(' ')[0]), h('div', {}, statusOf(rec))))),
        h('tr', {}, h('th', { class: 'label-col' }, ''),
          h('th', { class: 'num ytd sub' }, 'Revenue'), h('th', { class: 'num ytd sub' }, 'Interest'),
          months.map(() => [h('th', { class: 'num sub' }, 'Revenue'), h('th', { class: 'num sub int' }, 'Interest')]))),
      h('tbody', {}, rows.map((r) => {
        if (r.section) return h('tr', { class: 'section-row' }, h('td', { colspan: nCols }, r.section));
        if (r.pct) {
          return h('tr', { class: 'pct-row' }, h('td', { class: 'label-col' }, r.label),
            h('td', { class: 'num ytd' }, pctOf(ytd((c) => c.diffRev), ytd((c) => c.glRev))),
            h('td', { class: 'num ytd' }, pctOf(ytd((c) => c.diffInt), ytd((c) => c.glInt))),
            cols.map(({ c }) => [h('td', { class: 'num' }, c ? pctOf(c.diffRev, c.glRev) : ''), h('td', { class: 'num int' }, c ? pctOf(c.diffInt, c.glInt) : '')]));
        }
        return h('tr', { class: r.strong ? 'strong-row' : '' },
          h('td', { class: 'label-col', title: r.hint || '' }, r.label),
          cell(r.rev ? ytd(r.rev) : null, { strong: true, diff: r.diff }), cell(r.int ? ytd(r.int) : null, { strong: true, diff: r.diff }),
          cols.map(({ c, rec }) => {
            if (!c) return [h('td'), h('td', { class: 'int' })];
            const rv = r.rev ? r.rev(c) : null, iv = r.int ? r.int(c) : null;
            const revCell = cell(rv, { strong: r.strong, diff: r.diff, meta: r.meta?.rev?.(c, rec) });
            const intCell = cell(iv, { strong: r.strong, diff: r.diff, meta: r.meta?.int?.(c, rec) });
            intCell.classList.add('int');
            return [revCell, intCell];
          }));
      })))),
    done.length ? null : h('p', { class: 'muted' }, `Nothing entered for FY${fy} yet. Click a month to start it.`),
  );
}
