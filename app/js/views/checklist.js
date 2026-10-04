// Month-end checklist: the Slab close checklist, ticked off here month by month (who, when), with
// what the app shows as evidence and, where a step needs a file, where to get it and its format.

import { h, mount, table, toast, statusPill } from '../ui.js';
import { loadPocMonths, loadCds, listGlActivity, loadTrialBalances, listApAging, listInventoryMonths, loadAssets, listGovernanceDocs, listCloseMonths, loadCloseMonth, saveCloseMonth, loadBsConfig } from '../data.js';
import { closeChecklist, checklistRows, SECTIONS } from '../close/checklist.js';
import { apTieOut, AP_ACCOUNT } from '../bs/ap-aging.js';
import { cashTieOut, balancesFrom } from '../bs/cash.js';
import { statementEndings } from './balance-sheet.js';
import { downloadWorkbook } from '../xlsx-io.js';
import { explain } from '../store.js';
import { when, nowIso, logChange } from '../audit.js';
import { monthName, fiscalYear, fyStart, addMonths, currentMonth } from '../fiscal.js';

const MONTH_KEY = 'monthclose:checklist-month';
const short = (m) => monthName(m, { short: true });

// Everything the checklist reads; forMonth(m) gives the month's checklist.
export async function loadCloseData() {
  const [recs, cds, gls, tbs, agings, invs, assets, govDocs, closes, bsCfg] = await Promise.all([loadPocMonths(), loadCds(), listGlActivity(), loadTrialBalances(),
    listApAging(), listInventoryMonths(), loadAssets({ fresh: true }), listGovernanceDocs(), listCloseMonths(), loadBsConfig()]);
  const by = (xs) => Object.fromEntries(xs.map((x) => [x.month, x]));
  const recBy = by(recs), glBy = by(gls), tbBy = by(tbs), agingBy = by(agings), invBy = by(invs), closeBy = by(closes);
  const forMonth = (m) => {
    const { balances } = balancesFrom(tbBy, m, addMonths(m, 1));
    const aging = agingBy[m];
    const ap = aging && balances ? apTieOut(aging, balances[AP_ACCOUNT]?.end ?? 0) : null;
    const cash = balances ? cashTieOut(balances, statementEndings(recBy[m], cds, m), bsCfg) : null;
    return closeChecklist(m, { rec: recBy[m], cds, gl: glBy[m], tb: tbBy[m], aging, apTies: ap ? ap.ties : null, apLate: ap?.exceptions.length || 0,
      cashFlags: cash?.flags.length || 0, inv: invBy[m], hasAssets: assets.length > 0, govDocs, close: closeBy[m] });
  };
  return { forMonth, closeBy };
}

export default async function (main, { user, rerender }) {
  const d = await loadCloseData();
  let month = null;
  try { month = localStorage.getItem(MONTH_KEY); } catch { /* ignore */ }
  if (!month) month = addMonths(currentMonth(), -1);
  const pick = (m) => { try { localStorage.setItem(MONTH_KEY, m); } catch { /* ignore */ } rerender(); };
  const fy = fiscalYear(month);
  const months = Array.from({ length: 12 }, (_, i) => addMonths(fyStart(fy), i)).filter((m) => m < currentMonth());
  const lists = months.map((m) => d.forMonth(m));
  const c = d.forMonth(month);

  // A tick (or its undo) reads the month fresh and saves it with a log line.
  async function tick(step, key, label, on) {
    try {
      const rec = { month, ticks: {}, ...((await loadCloseMonth(month)) || {}) };
      rec.ticks = { ...(rec.ticks || {}), [step.id]: { ...(rec.ticks?.[step.id] || {}) } };
      if (on) rec.ticks[step.id][key] = { by: user, at: nowIso() }; else delete rec.ticks[step.id][key];
      logChange(rec, user, `${on ? '' : 'Undid '}${label}: ${step.title}`);
      await saveCloseMonth(rec);
      rerender();
    } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
  }

  const exportFy = () => downloadWorkbook(`Close checklist FY${fy}.xlsx`, [{ name: 'Checklist', rows: checklistRows(lists), cols: [9, 14, 60, 30, 7, 50, 40, 28, 50, 30, 14, 40], freeze: { ySplit: 1 } }]);
  const signCell = (s) => h('div', { class: 'stack' }, s.signed.map((x, i) => (x.done
    ? h('div', { class: 'small good-text' }, `✓ ${x.label} · ${x.by}`, h('span', { class: 'muted' }, ` · ${when(x.at)}`),
      i > 0 && x.by === s.signed[0].by ? h('span', { class: 'warn-text', title: 'The same person prepared and approved this.' }, ' (same person)') : null,
      h('button', { class: 'link', onclick: () => tick(s, x.key, x.label, false) }, 'undo'))
    : h('button', { class: 'small-btn', disabled: i > 0 && !s.signed[0].done, title: i > 0 && !s.signed[0].done ? `${s.signed[0].label} first` : '', onclick: () => tick(s, x.key, x.label, true) }, x.label))));

  mount(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `Month-end checklist — ${monthName(month)}`),
        h('p', { class: 'muted' }, 'The close checklist from Slab, ticked off here. Each step shows who did it and when, what the app has as evidence, and which file to upload where.')),
      h('div', { class: 'actions' },
        h('label', { class: 'month-pick' }, h('span', {}, 'Month'), h('input', { type: 'month', value: month, onchange: (e) => e.target.value && pick(e.target.value) })),
        h('button', { onclick: exportFy }, `Export FY${fy} (Excel)`))),
    h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '.4rem', marginBottom: '1rem' } }, lists.map((l) => h('button', {
      class: `small-btn${l.month === month ? ' primary' : ''}`, onclick: () => pick(l.month), title: `${l.done} of ${l.total} steps done`,
    }, `${short(l.month)} ${l.done === l.total ? '✓' : `${l.done}/${l.total}`}`))),
    h('div', { class: `notice ${c.done === c.total ? 'good' : ''}` }, c.done === c.total ? `${monthName(month)} is closed: all ${c.total} steps signed off.` : `${c.done} of ${c.total} steps signed off for ${monthName(month)}.`),
    SECTIONS.map((sec) => {
      const steps = c.steps.filter((s) => s.section === sec);
      if (!steps.length) return null;
      return h('section', {}, h('h2', {}, sec),
        table([
          { label: 'Step', cell: (s) => h('div', {}, h('strong', {}, s.title), h('div', { class: 'muted small' }, s.owner),
            s.upload ? h('div', { class: 'small' }, 'Upload: ', s.upload.file, s.upload.format ? ` · ${s.upload.format}` : '', s.upload.from ? h('span', { class: 'muted' }, ` · from ${s.upload.from}`) : null, ' → ', h('a', { href: s.upload.tab }, s.upload.where)) : null) },
          { label: 'In the app', cell: (s) => (s.evidence ? h('div', { class: 'small' }, statusPill(s.evidence.ok ? '✓' : '—', s.evidence.ok ? 'good' : 'warn'), ' ', s.evidence.label,
            s.evidence.detail?.by ? h('div', { class: 'muted' }, [s.evidence.detail.file, s.evidence.detail.by, s.evidence.detail.at ? when(s.evidence.detail.at) : ''].filter(Boolean).join(' · ')) : null) : h('span', { class: 'muted small' }, 'Outside the app')) },
          { label: 'Signed off', cell: signCell },
        ], steps));
    }),
    h('p', { class: 'muted small' }, 'Files from Acumatica and Salesforce: Excel unless it says otherwise (the trial balance can be PDF). Bank statements: the electronic PDF, not a scan. Whatever a file is called, it’s stored as {Account}_{YYYY-MM}. The Excel export (and the audit binder) has every step, sign-off and piece of evidence for the year.'));
}
