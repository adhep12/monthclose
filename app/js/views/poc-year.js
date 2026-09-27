// Proof of cash for a fiscal year (October–September; FY2026 = October 2025 – September 2026),
// laid out like the "Proof of Cash - YYYY" workbook. This is where the work happens: click an
// account's cell for a month to attach its statement or type its figures; click Total
// Adjustments to open up what's being taken out; click GL to load Acumatica's numbers.

import { h, mount, toast, fileButton, ask, askValue, panel, table, notify, statusPill, dropTarget } from '../ui.js';
import { loadPocMonths, loadPocMonth, savePocMonth, listGlActivity, saveGlActivity, loadPocConfig, savePocConfig, loadCds, saveCd, deleteCd, listSoa, saveSoa } from '../data.js';
import { monthSummary, cdSourcesFor, detachCdarsStatement, detachExport } from '../cd/schedule.js';
import { computePoc, glFigures, BANK_SOURCES, balanceMethodInterest, ADJUSTMENT_TYPES, wiseOutgoingCheck, fidelityTransfers, statementTies, EVIDENCE, reviewableDeposits } from '../poc/calc.js';
import { attachFiles, ACCOUNT_FILES } from '../poc/attach.js';
import { depositChecks } from '../poc/gl-deposits.js';
import { parseGlRegister, parseStatementOfActivities } from '../gl.js';
import { readWorkbook, downloadWorkbook } from '../xlsx-io.js';
import { confirmationState, confirmValues, stampEntered, stampBadge, logChange, nowIso, when } from '../audit.js';
import { money, round2, sum, parseAmount } from '../money.js';
import { fiscalYear, fyStart, addMonths, monthName, currentMonth } from '../fiscal.js';
import { explain, fileUrl } from '../store.js';
import { stripeCheckBox, stripeFlagText } from './stripe-check.js';

const FY_KEY = 'monthclose:poc-fy';
const SHOW_KEY = 'monthclose:poc-show';
const ADJ_OPEN_KEY = 'monthclose:poc-adj-open';
// Accounts whose empty cells turn into an undo "−" once something is attached or typed.
const UNDOABLE = ['ics', 'cd', 'delap', 'tschetter'];
const TYPED_FIELDS = ['rev', 'int', 'ending', 'priorEnding', 'netDeposits', 'fees'];
// Row order of the workbook's "Per Bank Statement" block.
const SHEET_ORDER = ['wise', 'paypal', 'stripe', 'keyOp', 'keyMM', 'ics', 'cd', 'delap', 'tschetter', 'cassOp'];
const label = (id) => BANK_SOURCES.find((s) => s.id === id)?.label || id;
const short = (m) => monthName(m, { short: true }).split(' ')[0];
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

// What each adjustment is, specifically — the subheading it sits under when a row is opened, and
// the "Line" in the export. Workbook imports keep their own names.
export function adjDetail(a) {
  if (a.id === 'auto-stripe') return 'Stripe payouts into Cass';
  if (a.id === 'auto-incoming') return 'Incoming Wires sweep';
  if (a.id === 'auto-outgoing') return 'Outgoing Wires sweep';
  if (a.id?.startsWith('auto-tr-')) return 'Money from another of our accounts';
  if (a.id?.startsWith('auto-ex-')) return a.type === 'prior-period' ? 'Deposits recognized in another month' : 'Refunds, reimbursements and other non-revenue deposits';
  if (a.id?.startsWith('auto-glrev-')) return 'Chargebacks and reversals';
  if (a.id?.startsWith('auto-glstripe-')) return 'Stripe shipping and sales tax';
  if (a.id === 'auto-stripe-disputes') return 'Stripe disputes';
  if (a.id?.startsWith('auto-glpaypal-')) return 'PayPal given back to donors';
  if (a.id === 'auto-glwise-fees') return 'Wise fees on incoming gifts';
  if (a.id?.startsWith('auto-glkey-')) return a.type === 'transfer' ? 'KeyBank deposits from our accounts' : a.amount > 0 ? 'KeyBank cash gifts spent before deposit' : 'KeyBank deposits that aren’t giving';
  if (a.id?.startsWith('auto-glnocash-')) return 'Revenue booked with no cash this month';
  return a.label.trim().replace(/\s*-\s*plus \(minus\)?\s*$/i, '').replace(/^\((.*)\)$/, '$1').trim();
}

// The rows on the sheet: adjustments by what they are, whichever account or report they came from.
export const ADJ_GROUPS = ['Transfers between our accounts', 'Wire sweeps', 'Deposits that aren’t revenue', 'Fees, refunds & reclasses', 'Timing'];
export function adjGroup(a) {
  const id = a.id || '';
  if (id === 'auto-stripe' || id.startsWith('auto-tr-')) return ADJ_GROUPS[0];
  if (id === 'auto-incoming' || id === 'auto-outgoing') return ADJ_GROUPS[1];
  if (id.startsWith('auto-ex-')) return a.type === 'prior-period' ? ADJ_GROUPS[4] : ADJ_GROUPS[2];
  if (id.startsWith('auto-glrev-')) return ADJ_GROUPS[2];
  if (id.startsWith('auto-glnocash-')) return ADJ_GROUPS[4];
  if (id.startsWith('auto-glkey-')) return a.type === 'transfer' ? ADJ_GROUPS[0] : a.amount > 0 ? ADJ_GROUPS[3] : ADJ_GROUPS[2];
  if (id === 'auto-stripe-disputes' || id.startsWith('auto-glstripe-') || id.startsWith('auto-glpaypal-') || id === 'auto-glwise-fees') return ADJ_GROUPS[3];
  // Entered by hand, or from the workbook: by the type chosen.
  if (a.type === 'transfer') return /wire sweep/i.test(a.label || '') ? ADJ_GROUPS[1] : ADJ_GROUPS[0];
  if (a.type === 'timing' || a.type === 'prior-period') return ADJ_GROUPS[4];
  if (a.type === 'refund' || a.type === 'not-revenue') return ADJ_GROUPS[2];
  return ADJ_GROUPS[3];
}
export const adjKey = adjGroup;

// Where the sheet was scrolled (sideways and down), per fiscal year. Kept for the whole visit so
// attaching a statement, or going to a month and back, returns you to the same spot.
const scrollMemory = {};
// After a decision made in a pop-up is saved, the sheet redraws and the same pop-up opens again
// with the new numbers.
let reopenAfter = null;
const REVIEW_TYPES = [['revenue', 'Revenue'], ['transfer', 'Transfer between accounts'], ['prior-period', 'Recognized in another month'], ['not-revenue', 'Not revenue (refund etc.)']];

function blank(month) {
  return { month, bank: {}, statements: {}, bankStatements: {}, excluded: {}, adjustments: [], dit: [], timing: {}, gl: {}, notes: '', log: [], autoConfirm: {} };
}

export default async function (main, { user, rerender, month: openMonthParam = null }) {
  const [recs, glActs, cfg, cds, soas] = await Promise.all([loadPocMonths(), listGlActivity(), loadPocConfig(), loadCds(), listSoa()]);
  const byMonth = Object.fromEntries(recs.map((r) => [r.month, r]));
  const glBy = Object.fromEntries(glActs.map((g) => [g.month, g]));
  const soaBy = Object.fromEntries(soas.map((s) => [s.month, s]));
  main.classList.add('wide-page');

  const hasData = (r) => r && !r.source?.ditOnly;
  const nowFy = fiscalYear(addMonths(currentMonth(), -1));
  const years = [...new Set([...(cfg.fiscalYears || []), nowFy, ...recs.filter(hasData).map((r) => fiscalYear(r.month))])].sort();
  let fy = Number(store.get(FY_KEY, '')) || nowFy;
  if (!years.includes(fy)) fy = nowFy;
  const show = store.get(SHOW_KEY, 'stacked');
  const adjOpen = store.get(ADJ_OPEN_KEY, '') === '1';
  const pickFy = (y) => { store.set(FY_KEY, String(y)); rerender(); };

  async function addYear() {
    const next = Math.max(...years) + 1;
    if (!(await ask(`Add FY${next}?`, `October ${next - 1} – September ${next}. October’s deposits-in-transit change carries on from September ${next - 1}.`, { ok: `Add FY${next}` }))) return;
    try { await savePocConfig({ ...cfg, fiscalYears: [...new Set([...(cfg.fiscalYears || []), ...years, next])] }); pickFy(next); }
    catch (err) { toast(explain(err, 'Couldn’t add the year.'), 'error'); }
  }

  const months = Array.from({ length: 12 }, (_, i) => addMonths(fyStart(fy), i));
  const cdFor = (m) => ({ ...monthSummary(cds, m), hasData: cds.some((x) => x.earned?.[m]) });
  const glFor = (m) => glFigures({ glActivity: glBy[m], soa: soaBy[m], month: m, config: cfg });
  // Every deposit against the GL, all months at once (a batch one month uses, another can't).
  const depChecks = depositChecks({ recs: byMonth, glBy, config: cfg });
  const depFor = (m) => ({ deposits: depChecks[m] || null, priorDeposits: depChecks[addMonths(m, -1)] || null });
  const cols = months.map((m) => {
    const rec = byMonth[m];
    const gl = glFor(m);
    // A month with GL loaded but no proof of cash yet still shows its GL figures.
    if (!hasData(rec) && !gl) return { m, rec: null, c: null };
    const r = hasData(rec) ? rec : { ...blank(m), ...(rec || {}), source: undefined };
    return { m, rec: hasData(rec) ? rec : null, c: computePoc(r, { prior: byMonth[addMonths(m, -1)], gl, cd: cdFor(m), ...depFor(m) }) };
  });
  // YTD covers the months whose Cass Operating deposits are in — the main account, so a month
  // with only a stray figure or two entered doesn't pull its whole GL into the totals yet.
  const line = (c, id) => c.lines.find((l) => l.id === id);
  // Where a figure came from, in words. Figures typed in the app carry who entered them; the
  // workbook import's figures don't.
  const sourceOf = (l) => (l.from === 'typed' ? (l.enteredBy ? 'Typed' : 'Workbook import') : l.from || 'Workbook import');
  const done = cols.filter((x) => x.c && line(x.c, 'cassOp').rev != null);

  // ---- Rows ----------------------------------------------------------------------------------
  const bankRows = SHEET_ORDER.map((id) => {
    const mark = (k) => (c, rec) => {
      const l = line(c, id);
      if (id === 'stripe' && k === 'rev' && c.stripeCheck?.state === 'mismatch') return { mark: '⚠', title: stripeFlagText(c.stripeCheck) };
      if (id === 'wise' && k === 'rev' && rec && wiseOutgoingCheck(rec).some((x) => x.state === 'missing')) return { mark: '⚠', title: 'Money sent from Wise to one of our accounts hasn’t turned up as a deposit — open to check' };
      const missing = (c.warnings || []).filter((w) => ['operating', 'incoming', 'outgoing'].includes(w.kind));
      if (id === 'cassOp' && k === 'rev' && missing.length) return { mark: '⚠', title: missing.map((w) => w.text).join('\n') };
      if (id === 'cassOp' && k === 'rev' && c.deposits?.conflicts?.length) return { mark: '⚠', title: `${c.deposits.conflicts.length} deposits a rule takes out but the GL booked as revenue — open the month to decide` };
      if (id === 'keyOp' && k === 'rev' && l.rev != null && c.deposits?.keyBank && Math.abs(l.rev - c.deposits.keyBank.glIn) >= 0.005) return { mark: '⚠', title: `KeyBank deposits ${money(l.rev || 0, { dash: false })}; the GL booked ${money(c.deposits.keyBank.glIn, { dash: false })} into 1061 — open the month to check` };
      if (id === 'cassOp' && k === 'rev' && c.deposits?.noGl?.some((x) => !x.covered)) return { mark: '⚠', title: `${c.deposits.noGl.filter((x) => !x.covered).length} deposits the GL doesn’t have — open the month to check` };
      if (id === 'wise' && k === 'rev' && rec?.bankStatements?.wise && !statementTies(rec, 'wise')) return { mark: '⚠', title: 'The Wise statement doesn’t tie to its own balances — attach it again' };
      if (l[k] == null) return null;
      const st = confirmationState(rec.bank?.[id], l.values);
      return { mark: st === 'confirmed' ? '✓' : st === 'stale' ? '!' : '', title: `${sourceOf(l) === 'Typed' ? 'Typed' : `From ${sourceOf(l) === 'Workbook import' ? 'the workbook' : sourceOf(l)}`}${st === 'confirmed' ? ` · confirmed by ${rec.bank[id].confirmation.by}` : st === 'stale' ? ' · changed since it was confirmed' : ' · not confirmed yet'}` };
    };
    return { label: label(id), account: id, rev: (c) => line(c, id).rev, int: (c) => line(c, id).int, meta: { rev: mark('rev'), int: mark('int') } };
  });
  // Timing includes the change in deposits in transit.
  const TIMING = ADJ_GROUPS[4];
  const adjLabels = ADJ_GROUPS;
  const adjFor = (k) => (c) => {
    const list = c.adjustments.filter((a) => adjKey(a) === k);
    const dit = k === TIMING && c.ditChange != null ? c.ditChange : null;
    return list.length || dit != null ? round2(sum(list, (a) => a.amount) + (dit || 0)) : null;
  };

  // Deposits in transit sit with the other adjustments: this month's in transit, less last month's
  // that reached the bank this month. Opening it lists both, from the GL.
  const overrides = (c) => (c.deposits?.dit?.rows || []).filter((r) => r.overridden && r.settled);
  const ditMeta = { rev: (c) => (overrides(c).length ? { mark: '*', title: `Overridden against the statement: ${overrides(c).map((r) => `${r.desc} ${money(r.amount)} — ${r.choice.note || 'no reason given'} (${r.choice.by})`).join('; ')}` } : c.priorDitMissing ? { mark: '?', title: 'Last month’s deposits in transit aren’t known, so this month’s count in full — open to see' } : c.deposits?.dit?.flagged ? { mark: '?', title: `${c.deposits.dit.flagged} GL deposits near month end to confirm — open to see` } : c.ditFromGl ? { mark: '', title: 'From the GL' } : null) };
  const adjRows = () => adjLabels.map((k) => ({ label: k, rev: adjFor(k), indent: true, adjKey: k,
    meta: k === ADJ_GROUPS[0] ? { rev: (c) => (c.stripeCheck?.state === 'mismatch' ? { mark: '⚠', title: stripeFlagText(c.stripeCheck) } : c.stripeCheck?.state === 'match' ? { mark: '✓', title: 'Stripe payouts match the Stripe CSV' } : null) }
      : k === TIMING ? ditMeta : null }));
  const withDit = (c) => round2(c.adjTotal + (c.ditChange || 0));
  const screenRows = [
    { section: 'Per Bank Statement' },
    ...bankRows,
    { label: `${adjOpen ? '▾' : '▸'} Total Adjustments (all accounts)`, rev: withDit, toggle: true, hint: 'Click to open up what’s being adjusted, deposits in transit included',
      meta: { rev: (c) => (c.stripeCheck?.state === 'mismatch' ? { mark: '⚠', title: stripeFlagText(c.stripeCheck) } : null) } },
    ...(adjOpen ? adjRows() : []),
    { label: 'Total Bank Revenue / Interest', rev: (c) => round2(c.bankRev + withDit(c)), int: (c) => c.bankInt, strong: true },
    { section: 'Adjustments for Timing' },
    { label: 'Plus Accrued Interest', int: (c) => c.timing.accrued || 0 },
    { label: 'Less realized accrued interest from prior period', int: (c) => -(c.timing.realizedPrior || 0) },
    { label: 'Change in Restricted Revenue', rev: (c) => c.timing.restricted || null },
    { label: 'Merchandise AR', rev: (c) => c.timing.merchAR || null },
    { label: 'Bank Revenue - Adjusted', rev: (c) => c.revAdjusted, int: (c) => c.intAdjusted, strong: true },
    { label: 'Total GL Revenue / Interest Income', rev: (c) => c.glRev, int: (c) => c.glInt, gl: true },
    { label: 'Difference', rev: (c) => c.diffRev, int: (c) => c.diffInt, strong: true, diff: true },
    { label: '% difference', pct: true },
  ];
  const rows = screenRows;
  // For printing: every adjustment line shown, whether or not it's opened up on screen.
  const printRows = screenRows.flatMap((r) => (r.toggle ? [{ ...r, label: 'Total Adjustments (all accounts)' }, ...adjRows()] : [r]));

  const ytd = (f) => (f ? round2(sum(done, (x) => f(x.c) || 0)) : null);
  const pctOf = (d, g) => (d == null || !g ? '' : `${((d / g) * 100).toFixed(2)}%`);
  const dot = (kind, text) => h('span', { class: `dot ${kind}`, title: text, 'aria-label': text });
  const statusOf = (rec) => (rec?.signoff?.reviewed ? dot('good', 'Reviewed') : rec?.signoff?.prepared ? dot('info', 'Prepared') : rec?.source?.kind === 'import' && !rec.updatedAt ? dot('neutral', 'From the workbook') : rec ? dot('warn', 'In progress') : null);
  const range = done.length ? `${short(done[0].m)}–${short(done[done.length - 1].m)}` : 'no months yet';

  // What clicking a cell does.
  function onCell(r, m, kind) {
    if (r.account) return () => openAccount(r.account, m);
    if (r.toggle) return () => { store.set(ADJ_OPEN_KEY, adjOpen ? '' : '1'); rerender(); };
    if (r.adjKey) return () => openAdjustments(r.adjKey, m);
    if (r.ditDetail) return () => openDit(m);
    if (r.dit) return () => openDit(m);
    if (r.gl) return () => openGl(m);
    void kind;
    return null;
  }

  // An empty cell shows "+" (nothing there yet — click to add), or for the accounts in UNDOABLE
  // "−" once a statement is attached or figures typed for the month: clicking the "−" undoes that.
  function valueCell(v, { strong, diff, meta, onclick, empty, onEmpty, extra = '' } = {}) {
    const cls = ['num', extra];
    if (diff && v != null && Math.abs(v) >= 1) cls.push(v < 0 ? 'neg' : 'pos');
    if (onclick) cls.push('clickable-cell');
    const hint = () => (onEmpty
      ? h('span', { class: 'remove-hint', role: 'button', title: 'Undo — take the statement or typed figures back out', onclick: (e) => { e.stopPropagation(); onEmpty(); } }, '−')
      : h('span', { class: 'add-hint' }, empty));
    return h('td', { class: cls.join(' '), title: meta?.title || (onclick ? 'Click to open' : ''), onclick },
      v == null ? (onclick && empty ? hint() : '') : strong ? h('strong', {}, money(v)) : money(v),
      meta?.mark ? h('span', { class: meta.mark === '✓' ? 'good-text' : meta.mark === '⚠' ? 'error' : 'warn-text' }, ` ${meta.mark}`) : null);
  }

  function sheet(showRev, showInt, title, { expand = false } = {}) {
    const rows = expand && !adjOpen ? printRows : screenRows;
    const span = (showRev ? 1 : 0) + (showInt ? 1 : 0);
    const nCols = 1 + span * (months.length + 1);
    const hasAny = (r) => done.length === 0 || r.strong || r.account || r.toggle || r.gl || [r.rev && showRev && [ytd(r.rev), ...done.map((x) => r.rev(x.c))], r.int && showInt && [ytd(r.int), ...done.map((x) => r.int(x.c))]]
      .flat().some((v) => v != null && v !== false && Math.abs(v) >= 0.005);
    const body = [];
    for (const r of rows) {
      if (r.section || r.pct) { body.push(r); continue; }
      if ((!showRev || !r.rev) && (!showInt || !r.int)) continue;
      if (r.account && !showRev && ['stripe', 'paypal', 'cassOp', 'keyOp'].includes(r.account) && !hasAny({ ...r, account: null })) continue;
      if (r.account && !showInt && ['ics', 'cd', 'keyMM', 'tschetter'].includes(r.account) && !hasAny({ ...r, account: null })) continue;
      if (!hasAny(r)) continue;
      body.push(r);
    }
    const kept = body.filter((b, i) => !b.section || (body[i + 1] && !body[i + 1].section));
    return h('div', { class: 'sheet-block' },
      title ? h('h2', {}, title) : null,
      h('div', { class: 'table-wrap sheet' }, h('table', {},
        h('thead', {},
          h('tr', {}, h('th', { class: 'label-col' }, ''),
            h('th', { class: 'num ytd', colspan: span }, 'YTD', h('div', { class: 'muted small' }, done.length ? `${range} · ${done.length} mo.` : range)),
            cols.map(({ m, rec }) => h('th', { class: 'num month', colspan: span },
              h('a', { href: '#/poc', title: `Open ${monthName(m)}: statements, notes, sign-off, activity`, onclick: (e) => { e.preventDefault(); openMonth(m); } }, short(m)), ' ', statusOf(rec)))),
          span > 1 ? h('tr', {}, h('th', { class: 'label-col' }, ''),
            h('th', { class: 'num ytd sub' }, 'Revenue'), h('th', { class: 'num ytd sub' }, 'Interest'),
            months.map(() => [h('th', { class: 'num sub' }, 'Revenue'), h('th', { class: 'num sub int' }, 'Interest')])) : null),
        h('tbody', {}, kept.map((r) => {
          if (r.section) return h('tr', { class: 'section-row' }, h('td', { colspan: nCols }, r.section));
          if (r.pct) {
            return h('tr', { class: 'pct-row' }, h('td', { class: 'label-col' }, r.label),
              showRev ? h('td', { class: 'num ytd' }, pctOf(ytd((c) => c.diffRev), ytd((c) => c.glRev))) : null,
              showInt ? h('td', { class: 'num ytd' }, pctOf(ytd((c) => c.diffInt), ytd((c) => c.glInt))) : null,
              cols.map(({ c }) => [showRev ? h('td', { class: 'num' }, c ? pctOf(c.diffRev, c.glRev) : '') : null, showInt ? h('td', { class: `num${span > 1 ? ' int' : ''}` }, c ? pctOf(c.diffInt, c.glInt) : '') : null]));
          }
          const labelCell = h('td', { class: `label-col${r.indent ? ' indent' : ''}${r.toggle ? ' clickable-cell' : ''}`, title: r.hint || '', onclick: r.toggle ? onCell(r) : null }, r.label);
          return h('tr', { class: `${r.strong ? 'strong-row' : ''}${r.indent ? ' detail-row' : ''}` },
            labelCell,
            showRev ? valueCell(r.rev ? ytd(r.rev) : null, { strong: true, diff: r.diff, extra: 'ytd' }) : null,
            showInt ? valueCell(r.int ? ytd(r.int) : null, { strong: true, diff: r.diff, extra: 'ytd' }) : null,
            cols.map(({ m, c, rec }) => {
              const click = onCell(r, m);
              // Files dropped on an account's cell attach to that account and month.
              const droppable = (td) => (td && r.account && ACCOUNT_FILES[r.account]?.accept ? dropTarget(td, (files) => quickAttach(r.account, m, files, td)) : td);
              const intExtra = span > 1 ? 'int' : '';
              const undo = r.account && hasEntry(r.account, m) ? () => undoAccount(r.account, m) : null;
              if (!c) {
                return [showRev ? droppable(valueCell(null, { onclick: r.rev ? click : null, empty: r.account || r.gl ? '+' : '', onEmpty: undo })) : null,
                  showInt ? droppable(valueCell(null, { onclick: r.int ? click : null, empty: r.account || r.gl ? '+' : '', onEmpty: undo, extra: intExtra })) : null];
              }
              return [
                showRev ? droppable(valueCell(r.rev ? r.rev(c) : null, { strong: r.strong, diff: r.diff, meta: r.meta?.rev?.(c, rec), onclick: r.rev ? click : null, empty: r.account || r.gl ? '+' : '', onEmpty: undo })) : null,
                showInt ? droppable(valueCell(r.int ? r.int(c) : null, { strong: r.strong, diff: r.diff, meta: r.meta?.int?.(c, rec), onclick: r.int ? click : null, empty: r.account || r.gl ? '+' : '', onEmpty: undo, extra: intExtra })) : null,
              ];
            }));
        })))));
  }

  // ---- Undo ("−") for ICS, CDARS, Delap and Tschetter ------------------------------------
  // Has someone attached a statement or typed a figure for this account and month? Figures that
  // came in with the workbook import don't count, and neither does saving every field blank.
  function hasEntry(id, m) {
    if (!UNDOABLE.includes(id)) return false;
    const rec = byMonth[m];
    const b = rec?.bank?.[id];
    if (b?.enteredAt && TYPED_FIELDS.some((k) => b[k] != null)) return true;
    if (id === 'ics') return !!rec?.ics;
    if (id === 'cd') return cdSourcesFor(cds, m).length > 0;
    return false;
  }

  async function undoAccount(id, m) {
    if (!(await ask(`Undo ${label(id)} — ${monthName(m)}?`,
      `${id === 'cd' ? 'Detaches the CD statements for the month and takes their interest back out of the CD schedule' : 'Detaches the statement'} and clears any figures typed for ${label(id)}. Workbook figures come back, if there were any.`,
      { ok: 'Undo', danger: true }))) return;
    try {
      const saved = await loadPocMonth(m);
      const rec = Object.assign(blank(m), structuredClone(saved || {}));
      const what = [];
      if (id === 'cd') {
        for (const x of cdAttached(m)) { await x.detach(); what.push(x.s.fileName || x.label); }
      } else {
        for (const x of attachedFor(rec, id)) { x.detach(); what.push(x.s.fileName || x.label); }
      }
      const b = rec.bank[id];
      if (b?.enteredAt) { rec.bank[id] = { ...(b.before || {}) }; what.push('typed figures'); }
      if (saved) {
        logChange(rec, user, `Undid ${label(id)}${what.length ? `: ${what.join(', ')}` : ''}`);
        await saveRec(rec);
      }
      toast(`${label(id)} — ${monthName(m)} undone.`);
    } catch (err) { toast(explain(err, 'Couldn’t undo that.'), 'error'); }
    rerender();
  }

  // ---- Account panel: attach a statement or type figures, confirm -----------------------
  async function saveRec(rec) {
    rec.updatedBy = user; rec.updatedAt = nowIso();
    await savePocMonth(rec);
  }

  // Dropping a statement on a cell: attach it and update the sheet, without opening anything.
  // Only a question that needs an answer (wrong account or month) or a problem interrupts.
  // Drops queue up and run one at a time, so two drops on the same month can't collide; the
  // sheet redraws once the queue is empty.
  let queue = Promise.resolve();
  let pending = 0;
  let anyChanged = false;
  function quickAttach(id, m, files, td) {
    pending++;
    const was = [...td.childNodes];
    td.classList.add('busy');
    td.textContent = 'Queued…';
    const restore = () => { td.replaceChildren(...was); td.classList.remove('busy'); };
    queue = queue.then(async () => {
      td.textContent = 'Reading…';
      try {
        const rec = Object.assign(blank(m), structuredClone((await loadPocMonth(m)) || {}));
        const res = await attachFiles({ files, rec, cds, month: m, user, expectAccount: id, ask, saveCd });
        if (res.changed) { await saveRec(rec); anyChanged = true; td.textContent = 'Saved'; } else restore();
        const bad = res.messages.filter((x) => x.bad);
        if (bad.length) await notify('Please check', bad.map((x) => x.text));
        else if (res.messages.length) toast(`${monthName(m)} · ${res.messages.map((x) => x.text).join(' · ')}`);
      } catch (err) {
        restore();
        toast(explain(err, 'Couldn’t attach that.'), 'error');
      } finally {
        if (--pending === 0 && anyChanged) rerender();
      }
    });
  }

  async function openAccount(id, m, droppedFiles = null) {
    let dirty = false;
    const rec = Object.assign(blank(m), structuredClone((await loadPocMonth(m)) || {}));
    const prior = (await loadPocMonth(addMonths(m, -1))) || byMonth[addMonths(m, -1)] || null;
    const files = ACCOUNT_FILES[id] || {};
    const src = BANK_SOURCES.find((s) => s.id === id);

    await panel(`${label(id)} — ${monthName(m)}`, (body, close) => {
      let draw = () => {};
      const doAttach = async (list) => {
        if (!list.length) return;
        const res = await attachFiles({ files: list, rec, cds, month: m, user, expectAccount: id, ask, saveCd });
        if (res.changed) {
          try { await saveRec(rec); dirty = true; } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
        }
        const bad = res.messages.filter((x) => x.bad);
        if (bad.length) notify('Please check', bad.map((x) => x.text));
        else if (res.messages.length) toast(res.messages.map((x) => x.text).join(' · '));
        draw();
      };
      // Drop statements anywhere in the panel.
      dropTarget(body, doAttach);
      draw = () => {
        const c = computePoc(rec, { prior, gl: glFor(m), cd: cdFor(m), ...depFor(m) });
        const l = line(c, id);
        const b = rec.bank[id] || (rec.bank[id] = {});
        const attached = id === 'cd' ? cdAttached(m) : attachedFor(rec, id);
        const auto = l.from && l.from !== 'typed' && src.method !== 'balance';
        const fields = {};
        const inp = (k) => (fields[k] = h('input', { class: 'num', inputmode: 'decimal', value: b[k] ?? '', size: 16 }));

        const input = h('input', { type: 'file', accept: files.accept || '', multiple: !!files.multiple, class: 'visually-hidden',
          onchange: (e) => { const list = [...e.target.files]; e.target.value = ''; doAttach(list); } });

        mount(body,
          h('p', { class: 'muted' }, files.hint || '', ` GL cash account ${src.gl}.`),
          files.accept ? h('label', { class: 'drop-zone' },
            h('strong', {}, attached.length ? 'Drop another statement here' : 'Drop the statement here'), h('span', { class: 'drop-hint' }, ' or click to choose'), input) : null,
          attached.length ? table([
            { label: 'Statement', cell: (x) => x.label },
            { label: 'File', cell: (x) => h('span', { class: 'break' }, x.s.fileName || '') },
            { label: 'Attached', cell: (x) => `${x.s.attachedBy || ''} · ${when(x.s.attachedAt)}` },
            { label: '', cell: (x) => h('div', { class: 'row' },
              x.ok === false ? statusPill('Doesn’t tie', 'bad') : statusPill('Ties', 'good'),
              x.s.fileKey ? h('button', { class: 'small-btn', onclick: async () => { const u = await fileUrl('statements', x.s.fileKey).catch(() => null); if (u) window.open(u, '_blank', 'noopener'); } }, 'View') : null,
              h('button', { class: 'small-btn danger', onclick: async () => {
                if (!(await ask('Detach statement', `Detach ${x.s.fileName || x.label}? Its figures come out of ${monthName(m)}.`, { ok: 'Detach', danger: true }))) return;
                await x.detach(); logChange(rec, user, `Detached ${x.label} ${x.s.fileName || ''}`);
                try { await saveRec(rec); dirty = true; } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
                draw();
              } }, 'Detach')) },
          ], attached) : null,

          h('h3', {}, 'Figures'),
          auto
            ? h('div', { class: 'recon' },
              rowKV('Revenue (deposits)', money(l.rev, { dash: false })), rowKV('Interest', money(l.int, { dash: false })),
              rowKV('Ending balance', l.ending == null ? '—' : money(l.ending, { dash: false })), rowKV('Source', l.from))
            : h('div', {},
              src.method === 'balance'
                ? [gainWorking(id, m, b, prior, rec, c, l), h('div', { class: 'form-grid' },
                  field('Ending value', inp('ending')),
                  field(`${monthName(addMonths(m, -1))} ending value`, prior?.bank?.[id]?.ending != null && b.priorEnding == null
                    ? h('span', {}, money(prior.bank[id].ending, { dash: false }), h('span', { class: 'muted small' }, ' (from last month)')) : inp('priorEnding')),
                  field('Net deposits (withdrawals)', inp('netDeposits'), id === 'delap' && fidelityTransfers(rec).total && b.netDeposits == null
                    ? `Left blank: Cass received ${money(fidelityTransfers(rec).total, { dash: false })} from Fidelity this month, so that’s used as a withdrawal.` : 'Money put in is positive; taken out (withdrawals, fees) negative.'),
                  field('Fees taken out', inp('fees'), c.deposits?.fees?.[id] && b.fees == null
                    ? `Left blank: the GL booked ${money(c.deposits.fees[id].amount, { dash: false })} in fees this month (${c.deposits.fees[id].batches.map((x) => x.batch).join(', ')}, Dr 8070), so that’s added back.`
                    : 'Management fees deducted from the account (Tschetter bills quarterly). Added back: the GL books them as an expense and grosses up the gain.'),
                  field('Revenue', inp('rev')),
                  h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Gain / interest'), h('strong', {}, money(l.int ?? balanceMethodInterest(b, prior?.bank?.[id]), { dash: false }))))]
                : h('div', { class: 'form-grid' }, field('Revenue (deposits)', inp('rev')), field('Interest', inp('int')), field('Ending balance', inp('ending'))),
              h('div', { class: 'row', style: { marginTop: '.5rem' } },
                h('button', { class: 'primary', onclick: async () => {
                  const changes = [];
                  const before = { ...b };
                  for (const [k, el] of Object.entries(fields)) {
                    const t = el.value.trim(); const v = t === '' ? null : parseAmount(t);
                    if (t !== '' && !Number.isFinite(v)) { toast(`“${t}” isn’t a number.`, 'error'); return; }
                    if ((b[k] ?? null) !== v) { changes.push(`${k} ${b[k] == null ? '(blank)' : money(b[k], { dash: false })} → ${v == null ? '(blank)' : money(v, { dash: false })}`); b[k] = v; }
                  }
                  if (!changes.length) { toast('Nothing changed.'); return; }
                  // What was there before anything was typed (workbook figures), for undo.
                  if (!b.enteredAt && !b.before) b.before = Object.fromEntries(TYPED_FIELDS.filter((k) => before[k] != null).map((k) => [k, before[k]]));
                  stampEntered(b, user); logChange(rec, user, `${label(id)}: ${changes.join(', ')}`);
                  try { await saveRec(rec); dirty = true; toast('Saved.'); } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
                  draw();
                } }, 'Save'))),
          auto && src.id !== 'cd' ? h('p', { class: 'muted small' }, 'Detach the statement to type figures instead.') : null,

          id === 'cassOp' ? cassSummary(c, m, close) : null,
          id === 'cassOp' || id === 'stripe' ? stripeCheckBox(c.stripeCheck, { rec, user, onChange: async () => { try { await saveRec(rec); dirty = true; } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); } draw(); } }) : null,
          id === 'wise' ? wiseOutBox(rec, close) : null,
          id === 'cd' ? h('p', { class: 'small' }, `CD schedule: ${money(cdFor(m).accrued)} earned in ${monthName(m)}, ${money(cdFor(m).realized)} paid at maturity. `, h('a', { href: '#/cds' }, 'Open the CD schedule')) : null,

          h('h3', {}, 'Confirmation'),
          stampBadge({ enteredBy: l.enteredBy, enteredAt: l.enteredAt, obj: b, values: l.values, user,
            onConfirm: async () => {
              confirmValues(b, user, l.values); logChange(rec, user, `Confirmed ${label(id)}: revenue ${money(l.rev, { dash: false })}, interest ${money(l.int, { dash: false })}`);
              try { await saveRec(rec); dirty = true; } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
              draw();
            },
            onUnconfirm: async () => { delete b.confirmation; logChange(rec, user, `Removed confirmation on ${label(id)}`); try { await saveRec(rec); dirty = true; } catch (err) { toast(explain(err), 'error'); } draw(); } }),
          h('p', { style: { marginTop: '1.25rem' } }, h('button', { class: 'small-btn', onclick: () => { close(true); openMonth(m); } }, `${monthName(m)}: statements, notes, sign-off →`)));
      };
      draw();
      if (droppedFiles?.length) doAttach(droppedFiles);
    }, { wide: id === 'cassOp' });
    if (dirty) rerender();
  }

  // CD statements live in the CD schedule, so "attached to this month" means the CDARS
  // statements dated in it (and an IntraFi export applied to it). Detaching takes their interest
  // back out of each CD.
  function cdAttached(m) {
    return cdSourcesFor(cds, m).map((src) => ({
      label: src.kind === 'export' ? `IntraFi export (…${src.cds.join(', …')})` : `CDARS ${src.date} (…${src.cds.join(', …')})`,
      s: { fileName: src.name, fileKey: src.key, attachedBy: src.by, attachedAt: src.at },
      detach: async () => {
        try {
          if (src.kind === 'export') {
            for (const cd of detachExport(cds, m)) await saveCd(cd);
          } else {
            const { changed, removed } = detachCdarsStatement(cds, src.date);
            for (const cd of changed) await saveCd(cd);
            for (const cd of removed) { await deleteCd(cd.id); cds.splice(cds.indexOf(cd), 1); }
          }
        } catch (err) { toast(explain(err, 'Couldn’t update the CD schedule.'), 'error'); }
      },
    }));
  }

  // Money out of Wise is never revenue. Sent to one of our own accounts, it should land there — and
  // if it lands in Cass it comes out of Cass deposits as a transfer.
  function wiseOutBox(rec, close) {
    const outs = wiseOutgoingCheck(rec);
    if (!outs.length) return null;
    const where = (x) => (x.landed ? `${x.landed.account === 'cassOp' ? `Cass ${x.landed.kind}` : label(x.landed.account)} ${x.landed.date}` : '');
    const status = {
      transfer: (x) => statusPill(`In ${where(x)} — taken out of revenue`, 'good'),
      counted: (x) => statusPill(`In ${where(x)} — still counted as revenue there`, 'bad'),
      missing: () => statusPill('Sent to our own account — no matching deposit found', 'bad'),
      paid: () => statusPill('Paid out — not revenue', 'neutral'),
    };
    return h('div', {}, h('h3', {}, 'Money out of Wise'),
      h('p', { class: 'muted small' }, 'None of this counts as Wise revenue. Money sent to one of our own accounts is matched to the deposit on the other side, so it isn’t counted as revenue there either.'),
      table([
        { label: 'Date', cell: (x) => x.date },
        { label: 'Description', cell: (x) => h('span', { class: 'wrap' }, x.desc) },
        { label: 'Amount', num: true, cell: (x) => money(-x.amount) },
        { label: '', cell: (x) => h('div', { class: 'row' }, status[x.state](x),
          x.state === 'counted' && x.landed ? h('button', { class: 'small-btn', onclick: () => treatAs(x.landed.month || rec.month, x.landed, 'transfer', `Money from Wise: ${x.date} ${x.desc}`, { kind: 'account', id: 'wise', m: rec.month }, close) }, 'Take the deposit out as a transfer') : null) },
      ], outs));
  }

  function cassSummary(c, m, close) {
    const cassAdj = c.adjustments.filter((a) => a.account === 'cassOp' || a.auto);
    const dep = c.deposits;
    const again = { kind: 'account', id: 'cassOp', m };
    const conflicts = dep?.conflicts || [];
    const noGl = (dep?.noGl || []).filter((x) => !x.covered);
    return h('div', {},
      conflicts.length ? h('div', { class: 'notice warn' }, h('h3', {}, 'To decide: a rule says it isn’t revenue, the GL booked it as revenue'),
        table([
          { label: 'Date', cell: (x) => x.line.date },
          { label: 'Deposit', cell: (x) => h('span', { class: 'wrap' }, x.line.desc) },
          { label: 'Amount', num: true, cell: (x) => money(x.line.amount) },
          { label: 'The rule / the GL', cell: (x) => h('span', { class: 'small wrap' }, `${x.rule.note} · GL: ${x.match.batch} ${x.match.desc}`) },
          { label: '', cell: (x) => h('div', { class: 'row' },
            h('button', { class: 'small-btn', onclick: () => treatAs(m, x.line, x.rule.type, `Confirmed: ${x.rule.note}`, again, close) }, x.rule.type === 'transfer' ? 'It’s a transfer' : 'Not revenue'),
            h('button', { class: 'small-btn', onclick: () => treatAs(m, x.line, 'revenue', '', again, close) }, 'It’s revenue')) },
        ], conflicts)) : null,
      noGl.length ? h('div', {}, h('h3', {}, 'Deposits the GL doesn’t have'),
        h('p', { class: 'muted small' }, 'On the statement, but no GL batch this month or either side. Usually revenue booked in another month. Counted as revenue until you say otherwise.'),
        table([
          { label: 'Date', cell: (x) => x.line.date },
          { label: 'Deposit', cell: (x) => h('span', { class: 'wrap' }, `${x.line.desc}${x.line.detail ? ` — ${x.line.detail}` : ''}`) },
          { label: 'Amount', num: true, cell: (x) => money(x.line.amount) },
          { label: 'Treat as', cell: (x) => treatSelect(m, x.line, 'revenue', again, close) },
        ], noGl)) : null,
      h('h3', {}, 'Taken out of Cass deposits'),
      cassAdj.length ? table([
        { label: 'What', cell: (a) => h('div', {}, adjDetail(a), a.detail?.length ? h('div', { class: 'muted small wrap' }, a.detail.slice(0, 6).map((d) => `${d.date} ${d.desc} ${money(d.amount)}`).join(' · '), a.detail.length > 6 ? ` … +${a.detail.length - 6} more` : '') : null) },
        { label: 'Type', cell: (a) => ADJUSTMENT_TYPES[a.type] || '' },
        { label: 'Amount', num: true, cell: (a) => money(a.amount) },
      ], cassAdj) : h('p', { class: 'muted' }, 'Nothing yet — attach the Cass statements.'),
      allDeposits(c, m, close));
  }

  // Every deposit on the Cass (and Wise) statements: how it counts, and what the GL booked it as.
  function allDeposits(c, m, close) {
    const rec = byMonth[m];
    if (!rec) return null;
    const dep = c.deposits;
    const again = { kind: 'account', id: 'cassOp', m };
    const glOf = new Map((dep?.lines || []).map((x) => [x.line.id, x.match]));
    const out = new Map(c.adjustments.filter((a) => /^auto-(tr|ex)-/.test(a.id || '')).map((a) => [a.id.replace(/^auto-(tr|ex)-/, ''), a]));
    const deps = reviewableDeposits(rec);
    if (!deps.length) return null;
    const kindName = { revenue: 'Revenue', stripe: 'Stripe', transfer: 'Transfer', 'prior-period': 'Earlier month', 'not-revenue': 'Not revenue' };
    return h('details', { style: { marginTop: '1rem' } }, h('summary', {}, `Every deposit this month (${deps.length}) — how each counts, and what the GL booked it as`),
      table([
        { label: 'Treat as', cell: (t) => treatSelect(m, t, out.get(t.id)?.type || 'revenue', again, close) },
        { label: 'Account', cell: (t) => (t.kind === 'incoming' ? 'Cass Incoming' : t.kind === 'wise' ? 'Wise' : 'Cass Operating') },
        { label: 'Date', cell: (t) => t.date },
        { label: 'Deposit', cell: (t) => h('span', { class: 'wrap', title: t.detail || '' }, t.desc) },
        { label: 'Amount', num: true, cell: (t) => money(t.amount) },
        { label: 'Per the GL', cell: (t) => { const x = glOf.get(t.id); return t.kind === 'wise' ? '' : x ? h('span', { class: 'small' }, `${kindName[x.kind] || x.kind} · ${x.batch} ${x.desc.slice(0, 50)}`) : dep?.available ? statusPill('No GL deposit', 'bad') : ''; } },
        { label: 'Why', cell: (t) => h('span', { class: 'small muted wrap' }, out.get(t.id)?.note || '') },
      ], deps));
  }

  // ---- A month: statements, timing, notes, sign-off, activity ----------------------------------
  async function openMonth(m) {
    const col = cols.find((x) => x.m === m);
    const c = col?.c;
    const rec = byMonth[m] || blank(m);
    const again = { kind: 'month', m };
    await panel(monthName(m), (body, close) => {
      const attached = [
        ...Object.entries(rec.statements || {}).map(([k, s]) => ({ label: `Cass ${k}`, s, ok: s.check?.creditsOk && s.check?.debitsOk && s.check?.balanceOk, detach: (r) => { delete r.statements[k]; } })),
        ...(rec.stripe ? [{ label: 'Stripe', s: rec.stripe, ok: true, detach: (r) => { delete r.stripe; } }] : []),
        ...(rec.ics ? [{ label: 'ICS', s: rec.ics, ok: rec.ics.ties !== false, detach: (r) => { delete r.ics; } }] : []),
        ...Object.entries(rec.bankStatements || {}).map(([k, s]) => ({ label: label(k), s, ok: statementTies(rec, k), detach: (r) => { delete r.bankStatements[k]; } })),
      ];
      const onFiles = async (files) => {
        try {
          const r = Object.assign(blank(m), structuredClone((await loadPocMonth(m)) || {}));
          const res = await attachFiles({ files, rec: r, cds, month: m, user, ask, saveCd });
          const bad = res.messages.filter((x) => x.bad);
          if (bad.length) await notify('Please check', bad.map((x) => x.text));
          else if (res.messages.length) toast(res.messages.map((x) => x.text).join(' · '));
          if (res.changed) { await saveRec(r); reopenAfter = again; close(true); rerender(); }
        } catch (err) { toast(explain(err, 'Couldn’t attach that.'), 'error'); }
      };
      const input = h('input', { type: 'file', accept: '.pdf,.csv,.xlsx', multiple: true, class: 'visually-hidden', onchange: (e) => { const f = [...e.target.files]; e.target.value = ''; onFiles(f); } });
      const t = rec.timing || {};
      const num = (v) => h('input', { type: 'text', inputmode: 'decimal', class: 'num', size: 14, value: v ?? '' });
      const tf = { restricted: num(t.restricted), merchAR: num(t.merchAR), ...(c?.timing?.fromSchedule ? {} : { accrued: num(t.accrued), realizedPrior: num(t.realizedPrior) }) };
      const notes = h('textarea', { rows: 3, style: { width: '100%' } }, rec.notes || '');
      const snap = c ? { diffRev: c.diffRev, diffInt: c.diffInt } : null;
      const same = (s) => s && snap && s.diffRev === snap.diffRev && s.diffInt === snap.diffInt;
      const p = rec.signoff?.prepared, rv = rec.signoff?.reviewed;
      const mark = (k) => decide(m, (r) => { r.signoff = { ...(r.signoff || {}), [k]: { by: user, at: nowIso(), ...snap } }; if (k === 'prepared') delete r.signoff.reviewed; },
        `Marked ${k}: revenue difference ${money(snap?.diffRev, { dash: false })}, interest difference ${money(snap?.diffInt, { dash: false })}`, again, close);
      mount(body,
        c ? h('div', { class: 'recon' },
          rowKV('Revenue difference', c.diffRev == null ? 'needs GL' : h('strong', { class: Math.abs(c.diffRev) < 1 ? 'good-text' : '' }, money(c.diffRev, { dash: false }))),
          rowKV('Interest difference', c.diffInt == null ? 'needs GL' : h('strong', { class: Math.abs(c.diffInt) < 1 ? 'good-text' : '' }, money(c.diffInt, { dash: false })))) : null,
        c?.warnings?.length ? h('div', { class: 'notice warn' }, h('ul', {}, c.warnings.map((w) => h('li', {}, w.text)))) : null,

        h('h3', {}, 'Statements'),
        dropTarget(h('label', { class: 'drop-zone' }, h('strong', {}, 'Drop statements here'), h('span', { class: 'drop-hint' }, ' or click to choose — Cass (Operating, Incoming, Outgoing), Stripe CSV, ICS, CDARS, Wise, PayPal, KeyBank, any number at once'), input), onFiles),
        attached.length ? table([
          { label: 'Statement', cell: (x) => x.label },
          { label: 'File', cell: (x) => h('span', { class: 'break' }, x.s.fileName || '') },
          { label: 'Attached', cell: (x) => `${x.s.attachedBy || ''} · ${when(x.s.attachedAt)}` },
          { label: '', cell: (x) => h('div', { class: 'row' }, x.ok === false ? statusPill('Doesn’t tie — attach again', 'bad') : statusPill('Ties', 'good'),
            x.s.fileKey ? h('button', { class: 'small-btn', onclick: async () => { const u = await fileUrl('statements', x.s.fileKey).catch(() => null); if (u) window.open(u, '_blank', 'noopener'); else toast('Couldn’t open the stored file.', 'error'); } }, 'View') : null,
            h('button', { class: 'small-btn danger', onclick: async () => {
              if (!(await ask('Detach statement', `Detach ${x.label} (${x.s.fileName || ''})? Its figures come out of ${monthName(m)}.`, { ok: 'Detach', danger: true }))) return;
              decide(m, (r) => x.detach(r), `Detached ${x.label} statement ${x.s.fileName || ''}`, again, close);
            } }, 'Detach')) },
        ], attached) : h('p', { class: 'muted small' }, 'Nothing attached yet.'),

        h('h3', {}, 'Timing'),
        h('div', { class: 'form-grid' },
          field('Change in restricted revenue', tf.restricted), field('Merchandise AR', tf.merchAR),
          tf.accrued ? field('Plus accrued interest', tf.accrued) : null, tf.realizedPrior ? field('Less prior period accrual realized', tf.realizedPrior) : null),
        c?.timing?.fromSchedule ? h('p', { class: 'muted small' }, `Accrued ${money(c.timing.accrued, { dash: false })} and realized ${money(c.timing.realizedPrior, { dash: false })} interest come from the CD schedule.`) : null,
        h('div', { class: 'row' }, h('button', { onclick: () => {
          const v = {};
          for (const [k, el] of Object.entries(tf)) { const s_ = el.value.trim(); const n = s_ === '' ? null : parseAmount(s_); if (s_ !== '' && !Number.isFinite(n)) { toast(`“${s_}” isn’t a number.`, 'error'); return; } v[k] = n; }
          decide(m, (r) => { r.timing = { ...(r.timing || {}), ...v }; }, `Timing: ${Object.entries(v).map(([k, n]) => `${k} ${n == null ? '(blank)' : money(n, { dash: false })}`).join(', ')}`, again, close);
        } }, 'Save timing')),

        h('h3', {}, 'Notes'), notes,
        h('div', { class: 'row' }, h('button', { onclick: () => decide(m, (r) => { r.notes = notes.value; }, 'Changed the notes', again, close) }, 'Save notes')),

        h('h3', {}, 'Sign-off'),
        h('div', { class: 'row' },
          p ? h('span', {}, statusPill(same(p) ? 'Prepared' : 'Prepared — numbers changed since', same(p) ? 'info' : 'warn'), ` ${p.by} · ${when(p.at)} · difference then ${money(p.diffRev, { dash: false })}`)
            : h('button', { onclick: () => mark('prepared'), disabled: !c }, 'Mark prepared'),
          p && !rv ? h('button', { class: 'primary', onclick: () => mark('reviewed'), title: p.by === user ? 'You prepared this — ideally someone else reviews it.' : '' }, 'Mark reviewed') : null,
          rv ? h('span', {}, statusPill(same(rv) ? 'Reviewed' : 'Reviewed — numbers changed since', same(rv) ? 'good' : 'warn'), ` ${rv.by} · ${when(rv.at)}`) : null,
          p && !same(p) ? h('button', { onclick: () => mark('prepared') }, 'Re-mark prepared') : null,
          p ? h('button', { onclick: () => decide(m, (r) => { delete r.signoff; }, 'Reopened the month', again, close) }, 'Reopen') : null),

        h('h3', {}, 'Activity'),
        (rec.log || []).length ? h('ul', { class: 'log' }, [...rec.log].reverse().map((e) => h('li', {}, h('span', { class: 'muted' }, `${when(e.at)} · ${e.by} — `), e.what))) : h('p', { class: 'muted' }, 'Nothing yet.'));
    }, { wide: true });
  }

  // ---- Decisions made from the fiscal year's pop-ups ----------------------------------------
  // Saved to that month's record and logged; the sheet redraws and the pop-up
  // reopens.
  async function decide(m, change, what, again, close) {
    try {
      const rec = Object.assign(blank(m), structuredClone((await loadPocMonth(m)) || {}));
      change(rec);
      logChange(rec, user, what);
      await saveRec(rec);
      reopenAfter = again;
      close?.(true);
      rerender();
    } catch (err) { toast(explain(err, 'Couldn’t save that.'), 'error'); }
  }
  // How a deposit on the statement counts: revenue, or taken out (and why).
  function treatAs(m, line, type, note, again, close) {
    const name = (REVIEW_TYPES.find((x) => x[0] === type) || [, type])[1].toLowerCase();
    return decide(m, (rec) => {
      rec.excluded ||= {};
      delete rec.excluded[line.id];
      if (type === 'revenue') rec.dismissed = { ...(rec.dismissed || {}), [line.id]: true };
      else { rec.excluded[line.id] = { type, note: note || '' }; if (rec.dismissed) delete rec.dismissed[line.id]; }
    }, `${line.date} ${line.desc} ${money(line.amount)}: ${type === 'revenue' ? 'counted as revenue' : `marked as ${name}`} (from the fiscal year sheet)`, again, close);
  }
  function treatSelect(m, line, current, again, close) {
    return h('select', { onchange: (e) => treatAs(m, line, e.target.value, '', again, close) }, REVIEW_TYPES.map(([v, t]) => h('option', { value: v, selected: v === current }, t)));
  }
  function leaveOut(m, a, again, close) {
    return decide(m, (rec) => { rec.dismissed = { ...(rec.dismissed || {}), [a.id]: true }; }, `Left out “${a.label}” ${money(a.amount)} (from the fiscal year sheet)`, again, close);
  }
  // Deposits in transit for month m: every row can be decided or overridden, even one a statement
  // has settled; typed ones can be added and removed.
  function ditBlock(m, c, close, again) {
    const dit = c.deposits?.dit;
    const M = short(m), N = short(addMonths(m, 1));
    // Going against what a statement shows needs a reason, and stays marked (*).
    const setIn = async (r, inTransit) => {
      let note = '';
      if (r.settled && inTransit !== r.suggested) {
        note = (await askValue('Override the statement?', `${r.desc} ${money(r.amount)}: ${r.evidence}. Say why it belongs the other way — it will be marked * wherever it shows.`, { ok: 'Override' }))?.trim();
        if (!note) { toast('Not changed — an override needs a reason.'); rerender(); return; }
      }
      decide(m, (rec) => { rec.ditGl = { ...(rec.ditGl || {}), [r.batch]: { in: inTransit, by: user, at: nowIso(), ...(note ? { note } : {}) } }; },
        `${r.desc} ${money(r.amount)}: ${inTransit ? `in transit at the end of ${monthName(m)}` : 'not in transit'}${note ? ` — overriding the statement: ${note}` : ''}`, again, close);
    };
    const clearChoice = (r) => decide(m, (rec) => { if (rec.ditGl) delete rec.ditGl[r.batch]; },
      `${r.desc} ${money(r.amount)}: back to ${r.settled ? 'what the statement shows' : 'the GL’s suggestion'}`, again, close);
    const rows = dit ? dit.rows.filter((r) => r.counts || r.flagged || r.choice) : [];
    const todo = dit ? dit.rows.filter((r) => r.flagged) : [];
    const typed = (byMonth[m]?.dit || []).filter((d) => !dit || !String(d.id || '').startsWith('imp-'));
    const dup = new Set((dit?.manual || []).filter((x) => x.duplicate).map((x) => x.d.id));
    // Typed deposits in transit.
    const f = { date: h('input', { type: 'date' }), note: h('input', { type: 'text', placeholder: 'Donor / reference', size: 28 }), amount: h('input', { type: 'text', inputmode: 'decimal', class: 'num', size: 12, placeholder: 'Amount' }) };
    const addTyped = () => {
      const amount = parseAmount(f.amount.value);
      if (!Number.isFinite(amount) || !amount) { toast('Type the amount.', 'error'); return; }
      decide(m, (rec) => { rec.dit = [...(rec.dit || []), stampEntered({ id: Math.random().toString(36).slice(2, 9), date: f.date.value, note: f.note.value.trim(), amount }, user)]; },
        `Added a deposit in transit: ${f.note.value.trim() || 'deposit'} ${money(amount)}`, again, close);
    };
    const removeTyped = (d) => decide(m, (rec) => { rec.dit = (rec.dit || []).filter((x) => x.id !== d.id); }, `Removed deposit in transit ${d.note || ''} ${money(d.amount)}`, again, close);
    return h('div', {},
      dit ? table([
        { label: 'Hit the bank in', cell: (r) => h('select', { onchange: (e) => setIn(r, e.target.value === 'in') },
          ...(r.sign > 0 ? [['in', `${N} — in transit`], ['out', M]] : [['in', `${M} — booked in ${N}`], ['out', N]]).map(([v, t]) => h('option', { value: v, selected: (r.counts ? 'in' : 'out') === v }, t))) },
        { label: 'GL date', cell: (r) => r.date },
        { label: 'Description', cell: (r) => h('span', { class: 'wrap' }, r.desc) },
        { label: 'Why', cell: (r) => h('span', { class: 'small wrap' }, r.evidence) },
        { label: 'Amount', num: true, cell: (r) => (r.counts ? money(r.sign * r.amount) : h('s', { class: 'muted' }, money(r.sign * r.amount))) },
        { label: '', cell: (r) => h('div', { class: 'row' },
          r.overridden ? h('span', { title: r.choice.note || '' }, statusPill(`Overridden* · ${r.choice.by}`, 'bad'), r.settled && r.choice.note ? h('div', { class: 'small' }, `* ${r.choice.note}`) : null) : r.choice ? h('span', { class: 'small muted' }, `${r.choice.by} · ${when(r.choice.at)}`) : r.settled ? statusPill('Statement', 'good') : r.flagged ? statusPill('To confirm', 'warn') : '',
          r.choice ? h('button', { class: 'small-btn', title: r.settled ? 'Go back to what the statement shows' : 'Go back to the GL’s suggestion', onclick: () => clearChoice(r) }, 'Undo') : null) },
      ], rows, { empty: 'Nothing near month end.', foot: (col_) => (col_.label === 'Amount' ? money(dit.glTotal) : col_.label === 'Hit the bank in' ? 'In transit, from the GL' : '') })
        : h('p', { class: 'muted small' }, 'No GL register for this month — deposits in transit are the typed ones below.'),
      todo.length ? h('div', { class: 'row', style: { marginTop: '.5rem' } }, h('button', { onclick: () => decide(m, (rec) => {
        rec.ditGl = { ...(rec.ditGl || {}), ...Object.fromEntries(todo.map((r) => [r.batch, { in: r.suggested, by: user, at: nowIso() }])) };
      }, `Confirmed ${todo.length} deposits in transit as suggested`, again, close) }, `Confirm ${todo.length} as suggested`)) : null,
      h('h4', {}, 'Typed deposits in transit'),
      typed.length ? table([
        { label: 'Date', cell: (d) => d.date || '' },
        { label: 'Description', cell: (d) => h('span', { class: 'wrap' }, d.note || '') },
        { label: 'Amount', num: true, cell: (d) => (dup.has(d.id) ? h('span', { title: 'Also on the GL’s list — not counted twice' }, h('s', { class: 'muted' }, money(d.amount))) : money(d.amount)) },
        { label: '', cell: (d) => h('div', { class: 'row' }, h('span', { class: 'small muted' }, d.enteredBy ? `${d.enteredBy} · ${when(d.enteredAt)}` : String(d.id || '').startsWith('imp-') ? 'From the workbook' : ''),
          h('button', { class: 'small-btn danger', onclick: () => removeTyped(d) }, 'Remove')) },
      ], typed) : null,
      h('div', { class: 'row inline-form', style: { marginTop: '.4rem' } }, f.date, f.note, f.amount, h('button', { onclick: addTyped }, 'Add deposit in transit')));
  }

  // ---- Adjustment detail panel -------------------------------------------------------------
  async function openAdjustments(key, m) {
    const col = cols.find((x) => x.m === m);
    if (!col?.c) return;
    const list = col.c.adjustments.filter((a) => adjKey(a) === key);
    const c = col.c;
    await panel(`${key} — ${monthName(m)}`, (body, close) => {
      // Detail lines carry the transaction's own (positive) amount; show them with the adjustment's sign.
      const items = list.flatMap((a) => (a.detail?.length ? a.detail.map((d) => ({ ...d, a, shown: (a.amount < 0 ? -1 : 1) * Math.abs(d.amount) })) : [{ date: a.date || '', desc: a.label, note: a.note, a, shown: a.amount }]));
      // Say what each item was, and who: a sweep between our own Cass accounts ("Trnsfr from
      // Checking Acct Ending in 3410") tells you nothing, so what landed there is shown instead.
      const plumbing = /^Trnsfr (from|to) Checking Acct/i;
      // Without the Outgoing statement, the GL says what landed there: money into Cass it booked on
      // or just before the sweep that isn't a deposit on Operating or Incoming (Fidelity, WEX COBRA).
      const glOnly = (col.c.deposits?.glOnly || []).map((g) => g.receipt).filter((r) => r.kind !== 'revenue');
      const fromGl = (x) => {
        if (!plumbing.test(x.desc || '') || x.note || !x.date) return '';
        const near = glOnly.filter((r) => r.date <= x.date && (Date.parse(x.date) - Date.parse(r.date)) / 864e5 <= 3);
        return near.length ? `Per the GL: ${near.map((r) => `${r.desc} ${money(r.amount)} (${r.batch})`).join('; ')}` : '';
      };
      for (const x of items) if (!x.note) x.note = fromGl(x) || x.note;
      const what = (x) => (plumbing.test(x.desc || '') && (x.note || x.a.note) ? x.note || x.a.note : x.desc);
      const extra = (x) => [what(x) === (x.note || x.a.note) ? '' : x.note || x.a.note, x.a.enteredBy ? `${x.a.enteredBy} · ${when(x.a.enteredAt)}` : ''].filter(Boolean).join(' · ');
      const withNotes = items.some((x) => extra(x));
      // What can be decided here: how a deposit counts, or leaving out something the GL found.
      const lineOf = (a) => (/^auto-(tr|ex)-/.test(a.id || '') ? a.id.replace(/^auto-(tr|ex)-/, '') : null);
      const again_ = { kind: 'adjustments', key, m };
      const saved = byMonth[m] || {};
      // Confirmed: who checked this item, at this amount (goes stale if the amount changes).
      const confirmCell = (a) => {
        const o = a.auto ? saved.autoConfirm?.[a.id] : (saved.adjustments || []).find((x) => x.id === a.id);
        const st = o ? confirmationState(o, { amount: a.amount }) : 'none';
        if (st === 'confirmed') return h('span', { class: 'small good-text', title: when(o.confirmation.at) }, `✓ ${o.confirmation.by}`);
        return h('button', { class: 'small-btn', title: st === 'stale' ? 'Changed since it was confirmed' : 'Mark as checked', onclick: () => decide(m, (rec) => {
          if (a.auto) { rec.autoConfirm ||= {}; confirmValues(rec.autoConfirm[a.id] ||= {}, user, { amount: a.amount }); }
          else { const t = (rec.adjustments || []).find((x) => x.id === a.id); if (t) confirmValues(t, user, { amount: a.amount }); }
        }, `Confirmed “${a.label}” ${money(a.amount)}`, again_, close) }, st === 'stale' ? 'Confirm again' : 'Confirm');
      };
      const action = (x) => {
        const id = lineOf(x.a);
        const decideCell = id
          ? treatSelect(m, { id, date: x.date, desc: x.desc, amount: Math.abs(x.shown) }, x.a.type || 'not-revenue', again_, close)
          : /^auto-gl/.test(x.a.id || '') ? h('button', { class: 'small-btn', title: 'Found in the GL, but it doesn’t belong in this month’s proof of cash', onclick: () => leaveOut(m, x.a, again_, close) }, 'Leave out')
          : !x.a.auto ? h('div', { class: 'row' },
            h('button', { class: 'small-btn', onclick: () => fillForm(x.a) }, 'Edit'),
            h('button', { class: 'small-btn danger', onclick: async () => {
              if (!(await ask('Remove adjustment', `Remove “${x.a.label}” (${money(x.a.amount)})?`, { ok: 'Remove', danger: true }))) return;
              decide(m, (rec) => { rec.adjustments = (rec.adjustments || []).filter((y) => y.id !== x.a.id); }, `Removed adjustment “${x.a.label}” ${money(x.a.amount)}`, again_, close);
            } }, 'Remove'))
          : null;
        return h('div', { class: 'row' }, decideCell, confirmCell(x.a));
      };
      // Adding (or editing) an adjustment typed by hand, in this row.
      const DEFAULT_TYPE = { [ADJ_GROUPS[0]]: 'transfer', [ADJ_GROUPS[1]]: 'transfer', [ADJ_GROUPS[2]]: 'not-revenue', [ADJ_GROUPS[3]]: 'other', [ADJ_GROUPS[4]]: 'timing' };
      const formHost = h('div');
      let editing = null;
      const fillForm = (a = null) => {
        editing = a;
        const fx = {
          account: h('select', {}, BANK_SOURCES.map((s_) => h('option', { value: s_.id, selected: (a?.account || 'cassOp') === s_.id }, s_.label))),
          type: h('select', {}, Object.entries(ADJUSTMENT_TYPES).map(([v, t]) => h('option', { value: v, selected: (a?.type || DEFAULT_TYPE[key]) === v }, t))),
          date: h('input', { type: 'date', value: a?.date || '' }),
          label: h('input', { type: 'text', size: 28, placeholder: 'What it is, and who', value: a?.label || (key === ADJ_GROUPS[1] ? 'Wire sweep adjustment' : '') }),
          amount: h('input', { type: 'text', inputmode: 'decimal', class: 'num', size: 12, placeholder: 'Amount', value: a ? String(a.amount) : '' }),
          note: h('input', { type: 'text', size: 28, placeholder: 'Why (for anyone checking)', value: a?.note || '' }),
        };
        const save = () => {
          const amount = parseAmount(fx.amount.value);
          if (!Number.isFinite(amount) || !amount) { toast('Type the amount (money that isn’t revenue is negative).', 'error'); return; }
          if (!fx.label.value.trim()) { toast('Say what it is.', 'error'); return; }
          const v = { account: fx.account.value, type: fx.type.value, date: fx.date.value, label: fx.label.value.trim(), amount, note: fx.note.value.trim() };
          decide(m, (rec) => {
            rec.adjustments ||= [];
            const t = editing && rec.adjustments.find((y) => y.id === editing.id);
            if (t) { Object.assign(t, v); stampEntered(t, user); } else rec.adjustments.push(stampEntered({ id: Math.random().toString(36).slice(2, 9), ...v }, user));
          }, `${editing ? 'Changed' : 'Added'} adjustment “${v.label}” ${money(amount)}`, again_, close);
        };
        mount(formHost, h('h4', {}, editing ? `Change “${editing.label}”` : 'Add an adjustment here'),
          h('div', { class: 'row inline-form' }, fx.account, fx.type, fx.date, fx.label, fx.amount, fx.note,
            h('button', { class: 'primary', onclick: save }, editing ? 'Save' : 'Add'), editing ? h('button', { onclick: () => fillForm(null) }, 'Cancel') : null),
          h('p', { class: 'muted small' }, 'Enter the amount as it affects bank revenue: money that isn’t revenue is negative.'));
      };
      fillForm(null);
      const cols_ = [
        { label: 'Account', cell: (x) => label(x.a.account || 'cassOp') },
        { label: 'Date', cell: (x) => x.date || '' },
        { label: 'Description', cell: (x) => h('span', { class: 'wrap' }, what(x), x.a.statement ? h('div', { class: 'small muted' }, x.a.statement) : null) },
        { label: 'Amount', num: true, cell: (x) => money(x.shown) },
        { label: 'Evidence', cell: (x) => evidencePill(x.a.evidence) },
        ...(withNotes ? [{ label: 'Note / who', cell: (x) => h('span', { class: 'small' }, extra(x)) }] : []),
        { label: '', cell: (x) => action(x) },
      ];
      // One section per kind of item, each with its reason and subtotal.
      const kinds = [...new Set(list.map(adjDetail))];
      const section = (kind) => {
        const as = list.filter((a) => adjDetail(a) === kind);
        const its = items.filter((x) => as.includes(x.a));
        const why = [...new Set(as.map((a) => a.why).filter(Boolean))][0];
        return h('div', { class: 'adj-section' },
          h('div', { class: 'row' }, h('h3', {}, kind), h('span', { class: 'spacer' }), h('strong', { class: 'num' }, money(round2(sum(as, (a) => a.amount))))),
          why ? h('p', { class: 'muted small' }, why) : null,
          table(cols_, its));
      };
      const again = { kind: 'adjustments', key, m };
      const dit = key === TIMING && c.ditChange != null ? h('div', { class: 'adj-section' },
        h('div', { class: 'row' }, h('h3', {}, 'Deposits in transit (change)'), h('span', { class: 'spacer' }), h('strong', { class: 'num' }, money(c.ditChange))),
        h('p', { class: 'muted small' }, `${monthName(m)} in transit ${money(c.ditTotal, { dash: false })}, less ${monthName(addMonths(m, -1))}’s ${c.priorDit == null ? '(not known — counted as none)' : money(c.priorDit, { dash: false })}. `,
          h('button', { class: 'small-btn', onclick: () => openDit(m) }, `${monthName(addMonths(m, -1))}’s list too`)),
        h('h4', {}, `In transit at the end of ${monthName(m)}`),
        ditBlock(m, c, close, again)) : null;
      mount(body,
        dit, kinds.map(section),
        h('div', { class: 'recon', style: { marginTop: '.75rem' } }, rowKV(`${key}, total`, h('strong', {}, money(round2(sum(list, (a) => a.amount) + (dit ? c.ditChange : 0)))))),
        evidenceSummary(list),
        formHost);
    }, { wide: true });
  }

  // ---- Investment gain, step by step (Delap, Tschetter) -----------------------------------------
  // Each figure with where it comes from, then what the GL booked, so the interest line can be
  // followed without opening anything else.
  function gainWorking(id, m, b, prior, rec, c, l) {
    const priorEnding = b.priorEnding ?? prior?.bank?.[id]?.ending ?? null;
    if (b.ending == null || priorEnding == null) return h('p', { class: 'muted small' }, `Enter the ending value${priorEnding == null ? ` (and ${monthName(addMonths(m, -1))}’s)` : ''} from the statement to work out the gain.`);
    const fid = id === 'delap' && b.netDeposits == null ? fidelityTransfers(rec).total : 0;
    const net = b.netDeposits ?? (fid ? -fid : 0);
    const glFee = c.deposits?.fees?.[id];
    const fee = b.fees ?? glFee?.amount ?? 0;
    const inv = c.deposits?.investment?.[id];
    const step = (what, amount, from) => h('div', { class: 'recon-row' }, h('span', {}, what, from ? h('div', { class: 'muted small' }, from) : null), h('span', { class: 'num' }, money(amount, { dash: false })));
    const gain = l.int;
    const diff = inv ? round2(gain - inv.gain) : null;
    return h('div', { class: 'recon', style: { marginBottom: '.75rem' } },
      h('h3', {}, 'How the gain is worked out'),
      step('Ending value', b.ending, 'From the statement'),
      step(`Less ${monthName(addMonths(m, -1))} ending value`, -priorEnding, b.priorEnding != null ? 'Typed' : 'From last month’s statement'),
      net ? step(net < 0 ? 'Plus money taken out' : 'Less money put in', -net, b.netDeposits != null ? 'Typed' : `Fidelity MoneyLine transfers into Cass this month: ${fidelityTransfers(rec).items.map((t) => `${t.date} ${money(t.amount)}`).join(', ')}`) : null,
      fee ? step('Plus fees taken out', fee, b.fees != null ? 'Typed' : `Per the GL: ${glFee.batches.map((x) => `${x.batch} ${x.desc} (Dr 8070 ${money(x.amount)})`).join('; ')} — the GL books the gain before the fee and the fee as an expense`) : null,
      h('div', { class: 'recon-row total' }, h('span', {}, 'Gain / interest'), h('span', { class: 'num' }, h('strong', {}, money(gain, { dash: false })))),
      inv ? h('div', { class: 'recon-row' }, h('span', {}, 'The GL booked', h('div', { class: 'muted small' }, inv.batches.map((x) => `${x.batch} ${x.desc}: gain ${money(x.gain)}${x.fee ? `, fee ${money(x.fee)}` : ''}`).join('; '))),
        h('span', { class: 'num' }, money(inv.gain, { dash: false }), ' ', Math.abs(diff) < 0.005 ? statusPill('Ties', 'good') : statusPill(`${money(diff, { dash: false })} different`, 'bad'))) : null);
  }

  // ---- Evidence --------------------------------------------------------------------------------
  function evidencePill(e) {
    const x = EVIDENCE[e] || EVIDENCE.statement;
    return h('span', { class: `pill ${e === 'gl' ? 'warn' : e === 'typed' ? 'neutral' : e === 'glWhat' ? 'info' : 'good'}`, title: x.hint }, x.label);
  }
  function evidenceSummary(list) {
    const by = {};
    for (const a of list) by[a.evidence || 'statement'] = round2((by[a.evidence || 'statement'] || 0) + Math.abs(a.amount));
    const parts = Object.keys(EVIDENCE).filter((k) => by[k]).map((k) => `${EVIDENCE[k].label} ${money(by[k], { dash: false })}`);
    return parts.length > 1 || by.gl ? h('p', { class: 'small muted' }, `Evidence: ${parts.join(' · ')}.`) : null;
  }

  // ---- Deposits in transit panel -------------------------------------------------------------
  // This month's deposits in transit, less last month's (which reached the bank this month): the
  // change that goes into adjusted bank revenue. From the GL where it has the month.
  async function openDit(m) {
    const col = cols.find((x) => x.m === m);
    if (!col?.c) return;
    const c = col.c;
    const prev = addMonths(m, -1);
    const listOf = (dit, rec) => (dit
      ? [...dit.rows.filter((r) => r.counts).map((r) => ({ date: r.date, desc: r.desc, why: r.evidence, amount: round2(r.sign * r.amount), from: r.settled ? 'Statement' : r.choice ? `Confirmed · ${r.choice.by}` : r.flagged ? 'To confirm' : 'From the GL' })),
        ...dit.manual.filter((x) => !x.duplicate).map((x) => ({ date: x.d.date || '', desc: x.d.note || 'Typed', why: 'Typed', amount: x.d.amount, from: x.d.enteredBy ? `Typed · ${x.d.enteredBy}` : 'Typed' }))]
      : (rec?.dit || []).map((d) => ({ date: d.date || '', desc: d.note || '', why: String(d.id || '').startsWith('imp-') ? 'From the workbook' : 'Typed', amount: d.amount, from: '' })));
    const thisList = listOf(c.deposits?.dit, byMonth[m]);
    const priorList = c.priorDitMissing ? null : listOf(depChecks[prev]?.dit, byMonth[prev]);
    const tableOf = (list, empty) => table([
      { label: 'GL date', cell: (x) => x.date },
      { label: 'Description', cell: (x) => h('span', { class: 'wrap' }, x.desc) },
      { label: 'Why it’s in transit', cell: (x) => h('span', { class: 'small wrap' }, x.why) },
      { label: 'Amount', num: true, cell: (x) => money(x.amount) },
      { label: '', cell: (x) => (x.from === 'To confirm' ? statusPill('To confirm', 'warn') : x.from === 'Statement' ? statusPill('Statement', 'good') : h('span', { class: 'small muted' }, x.from)) },
    ], list, { empty, foot: (col_) => (col_.label === 'Amount' ? money(round2(sum(list, (x) => x.amount))) : col_.label === 'GL date' ? 'Total' : '') });
    await panel(`Deposits in transit — ${monthName(m)}`, (body, close) => {
      mount(body,
        h('p', { class: 'muted' }, `Money the GL booked as revenue in one month that reached the bank in the next. The change is ${monthName(m)}’s in transit less ${monthName(prev)}’s, which reached the bank in ${monthName(m)}. The GL names the bank date in each batch (“3.3.2026 February Deposit”); the next month’s statement confirms it.`),
        h('h3', {}, `In transit at the end of ${monthName(m)} (plus)`), c.deposits?.dit ? ditBlock(m, c, close, { kind: 'dit', m }) : tableOf(thisList, 'None.'),
        h('h3', {}, `In transit at the end of ${monthName(prev)}, reached the bank in ${monthName(m)} (less)`),
        priorList ? (cols.find((x) => x.m === prev)?.c?.deposits?.dit ? ditBlock(prev, cols.find((x) => x.m === prev).c, close, { kind: 'dit', m }) : tableOf(priorList, 'None.')) : h('p', { class: 'small warn-text' }, `Not known — ${monthName(prev)} isn’t in the GL and none were entered for it, so nothing comes off. Its deposits that reached the bank in ${monthName(m)} are marked “Recognized in another month” on the deposit list instead.`),
        h('div', { class: 'recon', style: { marginTop: '.75rem' } },
          rowKV(`${monthName(m)} in transit`, money(c.ditTotal)),
          rowKV(`Less ${monthName(prev)} in transit`, c.priorDit == null ? 'not known' : money(-c.priorDit)),
          rowKV('Change, into adjusted bank revenue', money(c.ditChange ?? 0))),
        null);
    }, { wide: true });
  }

  // ---- GL panel: statement of activities or GL register, or typed --------------------------
  async function openGl(m) {
    let dirty = false;
    await panel(`GL — ${monthName(m)}`, (body, close) => {
      const draw = () => {
        const gl = glFor(m);
        const soa = soaBy[m];
        mount(body,
          h('p', { class: 'muted' }, 'Revenue and interest per Acumatica for the month. Upload the Statement of Activities – Comparative (Excel) for this month, or the GL Register Detailed export, which fills every month it covers.'),
          gl ? h('div', { class: 'recon' }, rowKV('Revenue', money(gl.revenueTotal)), rowKV('Interest', money(gl.interestTotal)), rowKV('Source', gl.source))
            : h('p', {}, 'Nothing loaded for this month yet.'),
          (() => {
            const w = byMonth[m]?.gl;
            if (!gl || !w || w.typedAt || (w.revenue == null && w.interest == null)) return null;
            const dr = w.revenue != null ? round2(gl.revenueTotal - w.revenue) : 0, di = w.interest != null ? round2(gl.interestTotal - w.interest) : 0;
            return Math.abs(dr) >= 1 || Math.abs(di) >= 1
              ? h('div', { class: 'notice warn' }, `The old workbook had revenue ${money(w.revenue)} and interest ${money(w.interest)} for ${monthName(m)}. Acumatica now shows ${money(gl.revenueTotal)} / ${money(gl.interestTotal)} — something was posted after the workbook was tied out.`)
              : h('p', { class: 'small muted' }, 'Matches the figures from the old workbook (to the dollar).');
          })(),
          soa && !gl?.soaOnly ? h('p', { class: 'small' }, `Statement of activities: revenue ${money(soa.revenueTotal)}, interest ${money(soa.interestTotal)} — ${Math.abs(soa.revenueTotal - (gl?.revenueTotal || 0)) < 1 && Math.abs(soa.interestTotal - (gl?.interestTotal || 0)) < 1 ? 'matches the GL register' : 'differs from the GL register'}.`) : null,
          glOverride(m, close),
          h('div', { class: 'row', style: { marginTop: '.75rem' } },
            fileButton('Upload statement of activities…', '.xlsx,.xls', async (file) => {
              try {
                const { XLSX, wb } = await readWorkbook(file);
                const s = parseStatementOfActivities(XLSX, wb);
                if (s.month !== m && !(await ask('Different month', `${file.name} is as of ${monthName(s.month)}, not ${monthName(m)}. Save it for ${monthName(s.month)}?`, { ok: `Save for ${monthName(s.month)}` }))) return;
                const recd = { ...s, fileName: file.name, uploadedBy: user, uploadedAt: nowIso() };
                await saveSoa(recd); soaBy[s.month] = recd; dirty = true;
                toast(`Statement of activities saved for ${monthName(s.month)}: revenue ${money(s.revenueTotal)}, interest ${money(s.interestTotal)}.`);
                draw();
              } catch (err) { notify('Couldn’t read that file', [err.message]); }
            }, { class: 'primary' }),
            fileButton('Upload GL register (all months)…', '.xlsx,.xls', async (file) => { if (await uploadGlRegister(file)) { dirty = true; draw(); } })));
      };
      draw();
    });
    if (dirty) rerender();
  }

  // Typed GL figures, when Acumatica's aren't loaded or aren't right yet. A typed figure wins until
  // it's cleared, and says so if Acumatica moves after it was typed.
  function glOverride(m, close) {
    const g = byMonth[m]?.gl || {};
    const typed = g.typedAt ? g : {};
    const rev = h('input', { type: 'text', inputmode: 'decimal', class: 'num', size: 16, value: typed.revenue ?? '' });
    const int = h('input', { type: 'text', inputmode: 'decimal', class: 'num', size: 16, value: typed.interest ?? '' });
    const gl = glFor(m);
    const differs = gl && g.typedAt && ((g.revenue != null && round2(g.revenue - gl.revenueTotal) !== 0) || (g.interest != null && round2(g.interest - gl.interestTotal) !== 0));
    const again = { kind: 'gl', m };
    return h('div', { style: { marginTop: '1rem' } }, h('h3', {}, 'Typed figures (override)'),
      differs ? h('div', { class: 'notice warn' }, `The typed figures differ from Acumatica now (revenue ${money(gl.revenueTotal)}, interest ${money(gl.interestTotal)}). Clear them to use Acumatica’s.`) : null,
      h('div', { class: 'form-grid' }, field('Revenue', rev), field('Interest', int)),
      h('div', { class: 'row' },
        h('button', { onclick: () => {
          const v = (el) => { const t = el.value.trim(); return t === '' ? null : parseAmount(t); };
          const r_ = v(rev), i_ = v(int);
          if ((r_ != null && !Number.isFinite(r_)) || (i_ != null && !Number.isFinite(i_))) { toast('Those aren’t numbers.', 'error'); return; }
          decide(m, (r) => { r.gl = { ...(r.gl || {}), revenue: r_, interest: i_, typedAt: nowIso(), typedBy: user }; }, `GL override: revenue ${r_ == null ? '(blank)' : money(r_, { dash: false })}, interest ${i_ == null ? '(blank)' : money(i_, { dash: false })}`, again, close);
        } }, 'Save override'),
        g.typedAt ? h('button', { onclick: () => decide(m, (r) => { r.gl = {}; }, 'Cleared GL overrides', again, close) }, 'Clear override') : null));
  }

  async function uploadGlRegister(file) {
    try {
      toast(`Reading ${file.name}… a full year takes a few seconds.`);
      const { XLSX, wb } = await readWorkbook(file);
      const res = parseGlRegister(XLSX, wb);
      if (!(await ask('Load GL register', `${res.lines.toLocaleString()} journal lines for ${res.periods.map((p) => short(p.month)).join(', ')}. Each month replaces any earlier upload for it.`, { ok: `Load ${res.periods.length} months` }))) return false;
      for (const p of res.periods) {
        const g = { ...p, fileName: file.name, runAt: res.runAt, uploadedBy: user, uploadedAt: nowIso() };
        await saveGlActivity(g); glBy[p.month] = g;
      }
      toast(`GL loaded for ${res.periods.length} months.`);
      return true;
    } catch (err) { notify('Couldn’t load the GL register', [explain(err, '')]); return false; }
  }

  // ---- Export: Excel workbook, or print / save as PDF ---------------------------------------
  // The sheet as it stands (every adjustment line opened up), plus where each number came from.
  async function exportExcel() {
    const stamp = `Exported ${new Date().toLocaleString()}${user ? ` by ${user}` : ''} · figures as imported and entered in the Proof of Cash app`;
    const all = rows.flatMap((r) => (r.toggle ? [{ ...r, label: 'Total Adjustments (all accounts)' }, ...adjRows().map((a) => ({ ...a, label: `    ${a.label}` }))] : r.indent ? [] : [r]));
    const pct = (d, g) => (d == null || !g ? null : { v: Math.round((d / g) * 1e6) / 1e6, z: '0.00%' });
    const at = (f, c) => (f && c ? f(c) ?? null : null);
    const sheetRows = [
      [`FY${fy} Proof of Cash — October ${fy - 1} to September ${fy}`], [stamp], [`YTD = ${done.length ? `${range} (${done.length} months with Cass Operating deposits in)` : 'no months yet'}`], [],
      ['', 'YTD Revenue', 'YTD Interest', ...months.flatMap((m) => [`${short(m)} Revenue`, `${short(m)} Interest`])],
    ];
    for (const r of all) {
      if (r.section) { sheetRows.push([r.section.toUpperCase()]); continue; }
      if (r.pct) {
        sheetRows.push([r.label, pct(ytd((c) => c.diffRev), ytd((c) => c.glRev)), pct(ytd((c) => c.diffInt), ytd((c) => c.glInt)),
          ...cols.flatMap(({ c }) => (c ? [pct(c.diffRev, c.glRev), pct(c.diffInt, c.glInt)] : [null, null]))]);
        continue;
      }
      sheetRows.push([r.label, r.rev ? ytd(r.rev) : null, r.int ? ytd(r.int) : null, ...cols.flatMap(({ c }) => [at(r.rev, c), at(r.int, c)])]);
    }

    const adj = [['Month', 'Group', 'Line', 'Account', 'Type', 'Date', 'Description', 'Amount', 'Evidence', 'Note', 'Statement', 'Entered by', 'Entered at']];
    const src = [['Month', 'Account', 'Revenue', 'Interest', 'Ending balance', 'Source', 'Entered / attached by', 'When', 'Confirmation']];
    const checks = [['Month', 'Check', 'Result', 'Detail']];
    for (const { m, c, rec } of cols) {
      if (!c) continue;
      for (const a of c.adjustments) {
        const items = a.detail?.length ? a.detail.map((d) => ({ date: d.date, desc: d.desc, amount: (a.amount < 0 ? -1 : 1) * Math.abs(d.amount) })) : [{ date: a.date || '', desc: a.label, amount: a.amount }];
        for (const it of items) adj.push([monthName(m), adjKey(a), adjDetail(a), label(a.account || 'cassOp'), ADJUSTMENT_TYPES[a.type] || (a.auto ? 'From the statements' : ''), it.date || '', it.desc, it.amount, (EVIDENCE[a.evidence] || EVIDENCE.statement).label, a.note || '', a.statement || '', a.enteredBy || '', a.enteredAt ? when(a.enteredAt) : '']);
      }
      for (const l of c.lines) {
        if (l.rev == null && l.int == null && l.ending == null) continue;
        const st = rec ? confirmationState(rec.bank?.[l.id], l.values) : 'none';
        const conf = rec?.bank?.[l.id]?.confirmation;
        src.push([monthName(m), label(l.id), l.rev ?? null, l.int ?? null, l.ending ?? null, sourceOf(l), l.enteredBy || '', l.enteredAt ? when(l.enteredAt) : '',
          st === 'confirmed' ? `Confirmed by ${conf.by} · ${when(conf.at)}` : st === 'stale' ? 'Changed since confirmed' : 'Not confirmed']);
      }
      const sc = c.stripeCheck;
      if (sc && sc.state !== 'incomplete') {
        checks.push([monthName(m), 'Stripe payouts vs Cass', { match: 'Match', explained: 'Explained', mismatch: 'MISMATCH' }[sc.state],
          `CSV payouts ${money(sc.csv, { dash: false })}; Cass transfers ${money(sc.cass, { dash: false })}; difference ${money(sc.diff, { dash: false })}${sc.explained && sc.state === 'explained' ? `; “${sc.explained.note}” (${sc.explained.by})` : ''}${sc.ignored.length ? `; ignored: ${sc.ignored.map((t) => `${t.date} ${money(t.amount, { dash: false })}${t.ignored.note ? ` (${t.ignored.note})` : ''}`).join(', ')}` : ''}`]);
      }
      if (rec) for (const w of wiseOutgoingCheck(rec).filter((x) => x.state !== 'paid')) {
        checks.push([monthName(m), 'Money out of Wise', { transfer: 'Matched — transfer', counted: 'Found, still counted as revenue', missing: 'NO MATCHING DEPOSIT' }[w.state], `${w.date} ${w.desc} ${money(w.amount, { dash: false })}`]);
      }
      for (const w of c.warnings || []) checks.push([monthName(m), ['operating', 'incoming', 'outgoing'].includes(w.kind) ? 'Statement missing' : 'Deposits in transit', w.kind === 'dit-twice' ? 'COUNTED TWICE' : w.kind === 'prior-dit' ? 'LAST MONTH NOT KNOWN' : 'MISSING', w.text]);
      const dep = c.deposits;
      if (dep?.available && dep.hasStatements) {
        const open = dep.noGl.filter((x) => !x.covered);
        checks.push([monthName(m), 'Deposits vs GL', open.length ? `${open.length} NOT IN THE GL` : 'All matched',
          `${dep.lines.filter((x) => x.match).length} of ${dep.lines.length} matched; ${Object.keys(dep.exclusions).length} not revenue per the GL${open.length ? `; not in the GL: ${open.map((x) => `${x.line.date} ${x.line.desc} ${money(x.line.amount, { dash: false })}`).join(', ')}` : ''}`]);
      }
      { const glOnly = c.adjustments.filter((a) => a.evidence === 'gl');
        if (glOnly.length) checks.push([monthName(m), 'Evidence: GL only', money(round2(sum(glOnly, (a) => Math.abs(a.amount))), { dash: false }), `${glOnly.length} adjustments no statement shows: ${glOnly.map((a) => `${adjDetail(a)} ${money(a.amount, { dash: false })}`).join('; ')}`]); }
      if (dep?.conflicts?.length) checks.push([monthName(m), 'Rule vs GL', `${dep.conflicts.length} TO DECIDE`, dep.conflicts.map((x) => `${x.line.date} ${x.line.desc} ${money(x.line.amount, { dash: false })}: rule says ${x.rule.type}, GL ${x.match.batch} says revenue`).join('; ')]);
      if (dep?.keyBank) { const kl = c.lines.find((x) => x.id === 'keyOp'); if (kl?.rev != null) checks.push([monthName(m), 'KeyBank deposits vs GL', Math.abs((kl?.rev || 0) - dep.keyBank.glIn) < 0.005 ? 'Match' : 'DIFFERENT', `Statement ${money(kl?.rev || 0, { dash: false })}; GL into 1061 ${money(dep.keyBank.glIn, { dash: false })}`]); }
      for (const r of (dep?.dit?.rows || []).filter((x) => x.overridden && x.settled)) checks.push([monthName(m), 'Deposit in transit overridden*', 'AGAINST THE STATEMENT', `${r.desc} ${money(r.amount, { dash: false })}: ${r.evidence}; set ${r.counts ? 'in transit' : 'not in transit'} by ${r.choice.by} — ${r.choice.note || ''}`]);
      if (dep?.dit) checks.push([monthName(m), 'Deposits in transit', dep.dit.flagged ? `${dep.dit.flagged} TO CONFIRM` : 'From the GL', `${money(dep.dit.total, { dash: false })}${dep.dit.workbookTotal != null ? `; the old workbook had ${money(dep.dit.workbookTotal, { dash: false })}` : ''}`]);
      if (c.diffRev != null) checks.push([monthName(m), 'Revenue difference', money(c.diffRev, { dash: false }), c.glRev ? `${((c.diffRev / c.glRev) * 100).toFixed(2)}% of GL revenue (${c.glSource || 'GL'})` : '']);
    }
    try {
      await downloadWorkbook(`Proof of Cash FY${fy} ${new Date().toISOString().slice(0, 10)}.xlsx`, [
        { name: `FY${fy} Proof of Cash`, rows: sheetRows, cols: [44, 15, 13, ...months.flatMap(() => [15, 13])], freeze: { xSplit: 1, ySplit: 5 } },
        { name: 'Adjustments detail', rows: adj, cols: [14, 28, 36, 18, 20, 11, 60, 14, 22, 50, 50, 16, 20] },
        { name: 'Sources', rows: src, cols: [14, 26, 15, 13, 16, 44, 20, 20, 32] },
        { name: 'Checks', rows: checks, cols: [14, 24, 28, 90] },
      ]);
    } catch (err) { toast(explain(err, 'Couldn’t build the Excel file.'), 'error'); }
  }

  // Print (or "Save as PDF" in the print dialog): revenue and interest stacked, one per page width.
  function printPdf() {
    document.body.classList.add('printing');
    const done_ = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', done_); };
    window.addEventListener('afterprint', done_);
    setTimeout(() => window.print(), 50);
  }

  const remember = () => {
    scrollMemory[fy] = { y: window.scrollY, x: [...main.querySelectorAll('.screen-only .sheet')].map((el) => el.scrollLeft) };
  };

  mount(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `FY${fy} Proof of Cash`),
        h('p', { class: 'muted' }, `October ${fy - 1} – September ${fy}. Drop a statement on an account’s cell to attach it (the number updates in place); click a cell to see its detail or type figures; click a month to open all of it. `,
          'Dots: green reviewed, blue prepared, amber in progress, grey from the workbook. ✓ confirmed, ! changed since confirmed.')),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: exportExcel, title: 'Download the sheet, adjustment detail, sources and checks as an Excel workbook' }, 'Export Excel'),
        h('button', { class: 'btn', onclick: printPdf, title: 'Print, or choose “Save as PDF” in the print dialog' }, 'Print / PDF'),
        fileButton('Upload GL register…', '.xlsx,.xls', async (file) => { if (await uploadGlRegister(file)) rerender(); }),
        h('a', { class: 'btn', href: '#/poc/import' }, 'Import workbook'))),
    h('div', { class: 'row tabs' },
      years.map((y) => h('button', { class: y === fy ? 'tab active' : 'tab', onclick: () => pickFy(y), title: `October ${y - 1} – September ${y}` }, `FY${y}`, h('span', { class: 'tab-sub' }, ` Oct ${String(y - 1).slice(2)}–Sep ${String(y).slice(2)}`))),
      h('button', { class: 'tab add', onclick: addYear }, '+ Add fiscal year'),
      h('span', { class: 'spacer' }),
      h('div', { class: 'seg' }, [['stacked', 'Revenue above interest'], ['side', 'Side by side (workbook)']].map(([v, l]) =>
        h('button', { class: v === show ? 'active' : '', onclick: () => { store.set(SHOW_KEY, v); rerender(); } }, l)))),
    h('div', { class: 'screen-only' }, show === 'side' ? sheet(true, true) : [sheet(true, false, 'Revenue'), sheet(false, true, 'Interest')]),
    // What prints: both halves stacked, whichever view is on screen.
    h('div', { class: 'print-only' },
      h('p', { class: 'muted small' }, `Printed ${new Date().toLocaleString()}${user ? ` by ${user}` : ''} · YTD = ${done.length ? `${range}, ${done.length} months` : 'no months yet'}`),
      sheet(true, false, 'Revenue', { expand: true }), sheet(false, true, 'Interest', { expand: true })),
  );

  // An old month link: show that month's fiscal year with the month open.
  if (openMonthParam && !reopenAfter) {
    history.replaceState(null, '', '#/poc');
    reopenAfter = { kind: 'month', m: openMonthParam };
    if (fiscalYear(openMonthParam) !== fy) { store.set(FY_KEY, String(fiscalYear(openMonthParam))); rerender(); return; }
  }
  // A decision was just saved from a pop-up: open it again with the new numbers.
  if (reopenAfter) {
    const r = reopenAfter; reopenAfter = null;
    setTimeout(() => (r.kind === 'adjustments' ? openAdjustments(r.key, r.m) : r.kind === 'dit' ? openDit(r.m) : r.kind === 'account' ? openAccount(r.id, r.m) : r.kind === 'month' ? openMonth(r.m) : r.kind === 'gl' ? openGl(r.m) : null), 0);
  }
  const saved = scrollMemory[fy];
  if (saved) {
    main.querySelectorAll('.screen-only .sheet').forEach((el, i) => { el.scrollLeft = saved.x[i] ?? saved.x[0] ?? 0; });
    window.scrollTo(0, saved.y);
    requestAnimationFrame(() => window.scrollTo(0, saved.y));
  }
  // Keep the memory current as you scroll, and keep the two stacked sheets side-scrolled together.
  const sheets = [...main.querySelectorAll('.screen-only .sheet')];
  sheets.forEach((el) => el.addEventListener('scroll', () => {
    for (const other of sheets) if (other !== el && other.scrollLeft !== el.scrollLeft) other.scrollLeft = el.scrollLeft;
    remember();
  }, { passive: true }));
  const onWinScroll = () => { if (main.isConnected) remember(); else window.removeEventListener('scroll', onWinScroll); };
  window.addEventListener('scroll', onWinScroll, { passive: true });
}

// Statements attached to one account
// Statements attached to one account for a month, with a way to detach each.
function attachedFor(rec, id) {
  const out = [];
  if (id === 'cassOp') {
    for (const [k, s] of Object.entries(rec.statements || {})) out.push({ label: `Cass ${k}`, s, ok: s.check.creditsOk && s.check.debitsOk && s.check.balanceOk, detach: () => { delete rec.statements[k]; } });
  }
  if (id === 'stripe' && rec.stripe) out.push({ label: 'Stripe', s: rec.stripe, detach: () => { delete rec.stripe; } });
  if (id === 'ics' && rec.ics) out.push({ label: 'ICS', s: rec.ics, ok: rec.ics.ties !== false, detach: () => { delete rec.ics; } });
  const b = rec.bankStatements?.[id];
  if (b) out.push({ label: BANK_SOURCES.find((s) => s.id === id)?.label || id, s: b, ok: statementTies(rec, id), detach: () => { delete rec.bankStatements[id]; } });
  return out;
}

function rowKV(k, v) {
  return h('div', { class: 'recon-row' }, h('span', {}, k), h('span', { class: 'num' }, v));
}

function field(labelText, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, labelText), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}
