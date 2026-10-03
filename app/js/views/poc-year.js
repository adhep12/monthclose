// Proof of cash for a fiscal year (October–September; FY2026 = October 2025 – September 2026),
// laid out like the "Proof of Cash - YYYY" workbook. This is where the work happens: click an
// account's cell for a month to attach its statement or type its figures; click Total
// Adjustments to open up what's being taken out; click GL to load Acumatica's numbers.

import { h, mount, toast, fileButton, ask, askValue, panel, table, notify, statusPill, dropTarget, carryScroll, topPanelScroll, nextDialog } from '../ui.js';
import { loadPocMonths, loadPocMonth, savePocMonth, listGlActivity, saveGlActivity, loadPocConfig, savePocConfig, loadCds, saveCd, deleteCd, listSoa, saveSoa, listSfGiving, saveSfGiving } from '../data.js';
import { monthSummary, cdSourcesFor, detachCdarsStatement, detachExport } from '../cd/schedule.js';
import { computePoc, glFigures, BANK_SOURCES, balanceMethodInterest, ADJUSTMENT_TYPES, wiseOutgoingCheck, fidelityTransfers, statementTies, EVIDENCE, reviewableDeposits, defaultExclusions, exclusionInfo, stripeSplit } from '../poc/calc.js';
import { attachFiles, ACCOUNT_FILES } from '../poc/attach.js';
import { depositChecks, depositHint, aliasList } from '../poc/gl-deposits.js';
import { glBatchIndex, auditRows, auditSummary, assignRefs } from '../poc/audit-trail.js';
import { parseStatementOfActivities } from '../gl.js';
import { uploadGlRegister as uploadGl } from '../gl-upload.js';
import { readWorkbook, downloadWorkbook } from '../xlsx-io.js';
import { confirmationState, confirmValues, stampEntered, stampBadge, logChange, nowIso, when } from '../audit.js';
import { money, round2, sum, parseAmount } from '../money.js';
import { fiscalYear, fyStart, addMonths, monthName, currentMonth } from '../fiscal.js';
import { explain, fileUrl } from '../store.js';
import { mergeChanges } from '../merge.js';
import { parseSalesforceReport, reconcileYear, byPattern, CHANNELS as SF_CHANNELS, SF_ADJ_TYPES, DEFAULT_SF_TOLERANCE, withinTolerance, ytdTolerance, suspectGifts } from '../sf/salesforce.js';
import { stripeCheckBox, stripeFlagText } from './stripe-check.js';
import { accountJeBlock, monthJeBlock, openJeDefaults } from './month-jes.js';
import { monthJes, jeReady } from '../je/month.js';

const FY_KEY = 'monthclose:poc-fy';
const SHOW_KEY = 'monthclose:poc-show';
const ADJ_OPEN_KEY = 'monthclose:poc-adj-open';
// Accounts whose empty cells turn into an undo "−" once something is attached or typed.
const UNDOABLE = ['ics', 'cd', 'delap', 'tschetter'];
const TYPED_FIELDS = ['rev', 'int', 'ending', 'priorEnding', 'netDeposits', 'fees', 'beginning', 'feesYtd'];
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
  if (a.id?.startsWith('auto-stripelate-') || (a.id?.startsWith('auto-glstripe-') && a.clearing)) return 'Stripe money recognized in another month';
  if (a.id?.startsWith('auto-glstripe-')) return 'Stripe shipping and sales tax';
  if (a.id === 'auto-stripe-disputes') return 'Stripe disputes';
  if (a.id?.startsWith('auto-glpaypal-')) return 'PayPal given back to donors';
  if (a.id === 'auto-glwise-fees') return 'Wise fees on incoming gifts';
  if (a.id?.startsWith('auto-glkey-')) return a.type === 'transfer' ? 'KeyBank deposits from our accounts' : a.amount > 0 ? 'KeyBank cash gifts spent before deposit' : 'KeyBank deposits that aren’t giving';
  if (a.id?.startsWith('auto-glnocash-')) return 'Revenue booked with no cash this month';
  if (a.id?.startsWith('auto-glfee-')) return 'Fees kept by giving platforms (Overflow)';
  if (a.id?.startsWith('auto-glrelease-')) return 'Revenue released from a liability';
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
  if (id.startsWith('auto-glfee-')) return ADJ_GROUPS[3];
  if (id.startsWith('auto-glnocash-') || id.startsWith('auto-glrelease-') || id.startsWith('auto-stripelate-') || (id.startsWith('auto-glstripe-') && a.clearing)) return ADJ_GROUPS[4];
  if (id.startsWith('auto-glkey-')) return a.type === 'transfer' ? ADJ_GROUPS[0] : a.amount > 0 ? ADJ_GROUPS[3] : ADJ_GROUPS[2];
  if (id === 'auto-stripe-disputes' || id.startsWith('auto-glstripe-') || id.startsWith('auto-glpaypal-') || id === 'auto-glwise-fees') return ADJ_GROUPS[3];
  // Entered by hand, or from the workbook: by the type chosen.
  if (a.type === 'transfer') return /wire sweep/i.test(a.label || '') ? ADJ_GROUPS[1] : ADJ_GROUPS[0];
  if (a.type === 'timing' || a.type === 'prior-period') return ADJ_GROUPS[4];
  if (a.type === 'refund' || a.type === 'not-revenue') return ADJ_GROUPS[2];
  return ADJ_GROUPS[3];
}
export const adjKey = adjGroup;

// Say what each item of an adjustment was, and who: a sweep between our own Cass accounts
// ("Trnsfr from Checking Acct Ending in 3410") tells you nothing, so what landed there is shown
// instead. Without the Outgoing statement the GL says what landed there: money into Cass it
// booked on or just before the sweep that isn't a deposit on Operating or Incoming (Fidelity,
// WEX COBRA). Items are { date, desc, note, a }; their notes are filled in from the GL where
// the statement had none. Returns the text to show for an item.
// Confirmed: who checked each line of an adjustment, at its amount (goes stale if the amount
// changes). Each line (each sweep, each transfer) is confirmed on its own; a whole adjustment
// confirmed before lines could be still counts. x is { a, date, desc, shown }.
const lineKey = (x) => (x.a.detail?.length ? `${x.a.id}|${x.date}|${round2(Math.abs(x.shown))}|${x.desc}` : x.a.id);
function confirmOf(saved, x) {
  if (!x.a.auto) {
    const t = (saved.adjustments || []).find((y) => y.id === x.a.id);
    return t?.confirmation ? { o: t, st: confirmationState(t, { amount: x.a.amount }) } : { st: 'none' };
  }
  const line_ = saved.autoConfirm?.[lineKey(x)];
  if (line_?.confirmation) return { o: line_, st: confirmationState(line_, { amount: round2(x.shown) }) };
  const whole = saved.autoConfirm?.[x.a.id];
  if (whole?.confirmation && confirmationState(whole, { amount: x.a.amount }) === 'confirmed') return { o: whole, st: 'confirmed' };
  return { st: whole?.confirmation ? 'stale' : 'none' };
}
const confirmLines = (xs, user) => (rec) => {
  for (const x of xs) {
    if (!x.a.auto) { const t = (rec.adjustments || []).find((y) => y.id === x.a.id); if (t) confirmValues(t, user, { amount: x.a.amount }); continue; }
    rec.autoConfirm ||= {};
    confirmValues(rec.autoConfirm[lineKey(x)] ||= {}, user, { amount: round2(x.shown) });
  }
};
// An adjustment's lines, each with its own (positive) amount shown with the adjustment's sign.
const linesOf = (list) => list.flatMap((a) => (a.detail?.length ? a.detail.map((d) => ({ ...d, a, shown: (a.amount < 0 ? -1 : 1) * Math.abs(d.amount) })) : [{ date: a.date || '', desc: a.label, note: a.note, a, shown: a.amount }]));

// ---- One way of checking a line, in every pop-up ------------------------------------------------
// Every line that can be checked shows the same things in the same place:
//   Status  — To check · ✓ Confirmed (who, when) · Changed (who, why) · the statement shows it
//   Confirm — keeps how it counts now, and records who checked it
//   Change… — counts it differently; then Undo, Leave out, Edit or Remove where they apply
// and every section has its title, what's left to check, "Confirm all" and its subtotal.
const STATUS = {
  todo: ['To check', 'warn'], confirmed: ['✓ Confirmed', 'good'], changed: ['Changed', 'info'],
  override: ['Overridden*', 'bad'], statement: ['✓ Statement shows it', 'good'], stale: ['Changed since confirmed', 'warn'],
};
function statusCell({ state, text, by, at, counts, note }) {
  const [t, kind] = STATUS[state] || [text || '', 'neutral'];
  return h('div', { class: 'status' },
    state ? statusPill(text || t, kind) : null,
    by ? h('span', { class: 'small muted' }, `${by}${at ? ` · ${when(at)}` : ''}`) : null,
    counts ? h('span', { class: 'small' }, counts) : null,
    note ? h('span', { class: 'small wrap' }, note) : null);
}
function actionsCell({ confirm = null, confirmLabel = 'Confirm', change = null, more = [] }) {
  const parts = [confirm ? h('button', { class: 'small-btn confirm-btn', onclick: confirm }, confirmLabel) : null, change, ...more].filter(Boolean);
  return parts.length ? h('div', { class: 'row-actions' }, parts) : '';
}
// A menu of other ways something can count. Picking one does it; the menu itself never shows a
// current value (that's what Status is for).
function changeSelect(options, current, onPick, placeholder = 'Change…') {
  const others = options.filter(([v]) => v !== current);
  if (!others.length) return null;
  return h('select', { class: 'change-select', onchange: (e) => { const v = e.target.value; e.target.selectedIndex = 0; if (v) onPick(v); } },
    h('option', { value: '', selected: true }, placeholder), others.map(([v, t]) => h('option', { value: v }, t)));
}
function reviewHead(title, { total = null, todo = 0, count = 0, onConfirmAll = null, level = 'h3' } = {}) {
  return h('div', { class: 'row review-head' }, h(level, {}, title),
    count ? (todo ? statusPill(`${todo} to check`, 'warn') : statusPill('✓ All checked', 'good')) : null,
    todo && onConfirmAll ? h('button', { class: 'small-btn confirm-btn', onclick: onConfirmAll }, `Confirm all ${todo}`) : null,
    h('span', { class: 'spacer' }),
    total != null ? h('strong', { class: 'num' }, money(total)) : null);
}

// How sure a deposit's match to its GL entry is (gl-deposits.js confidenceOf), as a pill.
const MATCH_LEVEL = { confirmed: ['✓ Confirmed match', 'good'], high: ['High', 'good'], medium: ['Medium', 'info'], low: ['Low', 'warn'] };
const matchPill = (cf) => { const [t, k] = MATCH_LEVEL[cf?.level] || ['', 'neutral']; return t ? statusPill(t, k) : null; };
// Matches a person should look at: low confidence (including a confirmed one whose GL entry has
// changed since), and confirmed ones that couldn't be kept (the GL entry is gone, or taken).
function matchesToCheck(c) {
  const dep = c.deposits;
  if (!dep) return [];
  return [...(dep.lines || []).filter((x) => x.match && x.match.confidence?.level === 'low').map((x) => ({ ...x, kind: 'low' })),
    ...(dep.pinIssues || []).map((p) => ({ line: p.line, match: null, pin: p.pin, kind: p.state }))];
}

const PLUMBING = /^Trnsfr (from|to) Checking Acct/i;
function whatLanded(c, items) {
  const glOnly = (c.deposits?.glOnly || []).map((g) => g.receipt).filter((r) => r.kind !== 'revenue');
  const fromGl = (x) => {
    if (!PLUMBING.test(x.desc || '') || x.note || !x.date) return '';
    const near = glOnly.filter((r) => r.date <= x.date && (Date.parse(x.date) - Date.parse(r.date)) / 864e5 <= 3);
    return near.length ? `Per the GL: ${near.map((r) => `${r.desc} ${money(r.amount)} (${r.batch})`).join('; ')}` : '';
  };
  for (const x of items) if (!x.note) x.note = fromGl(x) || x.note;
  return (x) => (PLUMBING.test(x.desc || '') && (x.note || x.a.note) ? x.note || x.a.note : x.desc);
}

// Where the sheet was scrolled (sideways and down), per fiscal year, so attaching a statement or
// going to a month and back returns you to the same spot. Kept for this browser tab too, so a
// reload (the platform signing you in again after a save or an upload) comes back there as well.
const SCROLL_KEY = 'monthclose:poc-scroll';
const scrollMemory = (() => { try { return JSON.parse(sessionStorage.getItem(SCROLL_KEY) || '{}'); } catch { return {}; } })();
let scrollSaveQueued = false;
const keepScroll = () => {
  if (scrollSaveQueued) return;
  scrollSaveQueued = true;
  setTimeout(() => { scrollSaveQueued = false; try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify(scrollMemory)); } catch { /* private mode: memory only */ } }, 250);
};
// After a decision made in a pop-up is saved, the sheet redraws and the same pop-up opens again
// with the new numbers.
let reopenAfter = null;
// The month records this page saved last, by month (see byMonth). Once this page has saved a
// month it works from its own copy: reading it back from the platform straight after can return
// the month as it was before, and a save based on that is refused as a conflict (409).
const recentSaves = {};
const recentGl = {}; // the same, for GL register uploads
const recentSf = {}; // and Salesforce reports
// The months as last listed, reused when the page redraws after a decision (listing again straight
// after a save can bring back the old copies). Listed afresh when the page is opened, and at most
// every five minutes.
let listed = null;
const LIST_FRESH_MS = 5 * 60 * 1000;
async function readMonth(m, { fresh = false } = {}) {
  if (!fresh && recentSaves[m]) return structuredClone(recentSaves[m]);
  return loadPocMonth(m);
}
const REVIEW_TYPES = [['revenue', 'Revenue'], ['transfer', 'Transfer between accounts'], ['prior-period', 'Recognized in another month'], ['not-revenue', 'Not revenue (refund etc.)']];

function blank(month) {
  return { month, bank: {}, statements: {}, bankStatements: {}, excluded: {}, adjustments: [], dit: [], timing: {}, gl: {}, notes: '', log: [], autoConfirm: {} };
}

export default async function (main, { user, rerender, month: openMonthParam = null }) {
  const relist = !listed || Date.now() - listed.at > LIST_FRESH_MS || !Object.keys(recentSaves).length;
  const [recs, glActs, cfg, cds, soas, sfList] = await Promise.all([relist ? loadPocMonths() : listed.recs, listGlActivity(), loadPocConfig(), loadCds(), listSoa(), listSfGiving().catch(() => [])]);
  if (relist) listed = { at: Date.now(), recs };
  // Right after a save, the platform's list can still hand back the month as it was; what this
  // page just saved wins until the list catches up.
  const byMonth = Object.fromEntries(recs.map((r) => [r.month, recentSaves[r.month] && String(recentSaves[r.month].updatedAt || '') > String(r.updatedAt || '') ? { key: r.key, ...recentSaves[r.month] } : r]));
  for (const [m_, r_] of Object.entries(recentSaves)) if (!byMonth[m_]) byMonth[m_] = r_;
  const glBy = Object.fromEntries(glActs.map((g) => [g.month, recentGl[g.month] && String(recentGl[g.month].uploadedAt || '') > String(g.uploadedAt || '') ? recentGl[g.month] : g]));
  for (const [m_, g_] of Object.entries(recentGl)) if (!glBy[m_]) glBy[m_] = g_;
  const soaBy = Object.fromEntries(soas.map((s) => [s.month, s]));
  const sfStamp = (x) => String(x?.updatedAt || x?.uploadedAt || '');
  const sfBy = Object.fromEntries(sfList.map((x) => [x.month, recentSf[x.month] && sfStamp(recentSf[x.month]) > sfStamp(x) ? recentSf[x.month] : x]));
  for (const [m_, x_] of Object.entries(recentSf)) if (!sfBy[m_]) sfBy[m_] = x_;
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
  // What the JE blocks need: every month, the GL, the edited defaults and the editor. `after`
  // redraws the pop-up the editor was opened from.
  const jeCtx = (after, extra = {}) => ({ recs: byMonth, glBy, cds, jeDefaults: cfg.jeDefaults || {}, ...extra,
    editDefaults: (id) => openJeDefaults(id, { jeDefaults: cfg.jeDefaults || {}, save: async (bid, over) => {
      // Read the settings fresh so this doesn't write an old copy over someone else's change.
      const fresh = { ...cfg, ...((await loadPocConfig()) || {}) };
      fresh.jeDefaults = { ...(fresh.jeDefaults || {}) };
      if (over) fresh.jeDefaults[bid] = { ...over, by: user, at: nowIso() }; else delete fresh.jeDefaults[bid];
      try { await savePocConfig(fresh); } catch (err) { throw new Error(explain(err, 'Couldn’t save.')); }
      Object.assign(cfg, fresh);
      toast(over ? 'Saved: the new default for every month.' : 'Back to the built-in lines.');
      await after();
    } }) });
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
  // YTD covers the months that have ended: September counts from October 1st. A month in YTD that
  // is still waiting on a statement or the GL is listed, since its difference will still move.
  const line = (c, id) => c.lines.find((l) => l.id === id);
  const hasFig = (l) => !!l && (l.rev != null || l.int != null);
  // Where a figure came from, in words. Figures typed in the app carry who entered them; the
  // workbook import's figures don't.
  const sourceOf = (l) => (l.from === 'typed' ? (l.enteredBy ? 'Typed' : 'Workbook import') : l.from || 'Workbook import');
  const usedAccounts = SHEET_ORDER.filter((id) => cols.some((x) => x.rec && hasFig(line(x.c, id))));
  const waitingOn = (x) => {
    if (!x.rec) return ['nothing attached'];
    const out = usedAccounts.filter((id) => !hasFig(line(x.c, id))).map(label);
    if ((x.c.warnings || []).some((w) => ['operating', 'incoming', 'outgoing'].includes(w.kind))) out.push('a Cass statement');
    if (x.c.diffRev == null) out.push('the GL');
    return out;
  };
  const done = cols.filter((x) => x.m < currentMonth());
  const stillWaiting = done.map((x) => ({ m: x.m, why: waitingOn(x) })).filter((x) => x.why.length);
  const pctText = (d, base) => (d == null || !base ? '' : `${((d / base) * 100).toFixed(2)}%`);
  // The YTD variance, in a line above each section: how big the difference is against the GL.
  const ytdBar = (parts, { ms = done.map((x) => x.m), note = null } = {}) => h('div', { class: 'ytd-bar' },
    h('strong', {}, `YTD variance, ${ms.length ? `${short(ms[0])}–${short(ms[ms.length - 1])} (${ms.length} month${ms.length === 1 ? '' : 's'})` : 'no months ended yet'}`),
    ms.length ? parts.map(([k, d, base]) => h('span', { class: 'ytd-part' }, `${k} `, h('strong', { class: Math.abs(d || 0) >= 1 ? 'warn-text' : 'good-text' }, money(d, { dash: false })),
      base ? h('span', { class: 'muted' }, ` · ${pctText(d, base)} of GL`) : null)) : null,
    stillWaiting.length ? h('div', { class: 'small warn-text' }, `In YTD but not finished, so the variance will move: ${stillWaiting.map((x) => `${short(x.m)} (${x.why[0] === 'nothing attached' ? 'nothing attached' : `waiting on ${x.why.join(', ')}`})`).join('; ')}.`) : null,
    note ? h('div', { class: 'small muted' }, note) : null);

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
      if (id === 'cassOp' && k === 'rev' && matchesToCheck(c).length) return { mark: '⚠', title: `${matchesToCheck(c).length} matches to the GL to check (low confidence, or the GL entry changed since it was confirmed) — open to check` };
      if (id === 'cassOp' && k === 'rev' && c.deposits?.noGl?.some((x) => !x.covered && !x.decided)) return { mark: '⚠', title: `${c.deposits.noGl.filter((x) => !x.covered && !x.decided).length} deposits the GL doesn’t have, not decided yet — open to check` };
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

  // A month that has ended with nothing in it (no statements, no GL) has no figures: it adds nothing.
  const ytd = (f) => (f ? round2(sum(done, (x) => (x.c ? f(x.c) || 0 : 0))) : null);
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
    const hasAny = (r) => done.length === 0 || r.strong || r.account || r.toggle || r.gl || [r.rev && showRev && [ytd(r.rev), ...done.map((x) => (x.c ? r.rev(x.c) : null))], r.int && showInt && [ytd(r.int), ...done.map((x) => (x.c ? r.int(x.c) : null))]]
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
            h('th', { class: 'num ytd', colspan: span, title: `YTD adds up the months that have ended.${stillWaiting.length ? `\nStill waiting (in YTD, so it will move) — ${stillWaiting.map((x) => `${short(x.m)}: ${x.why.join(', ')}`).join('; ')}` : ''}` }, 'YTD', h('div', { class: 'muted small' }, done.length ? `${range} · ${done.length} mo.` : range)),
            cols.map(({ m, rec }) => h('th', { class: 'num month', colspan: span },
              h('a', { href: '#/poc', title: `Open ${monthName(m)}: statements, notes, sign-off, activity`, onclick: (e) => { e.preventDefault(); openMonth(m); } }, short(m)), ' ', statusOf(rec),
              todoBadge(m)))),
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
      const saved = await readMonth(m);
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
    recentSaves[rec.month] = structuredClone(rec);
  }
  // Save what a long-open pop-up changed (local, against base — the month as the pop-up read it)
  // onto the month as it is now. If it changed again in between, read it again and apply once
  // more. Returns the month as saved.
  async function saveMerged(m, base, local) {
    for (let attempt = 0; ; attempt++) {
      const current = Object.assign(blank(m), structuredClone((await readMonth(m, { fresh: attempt > 0 })) || {}));
      const next = mergeChanges(current, base, local);
      try { await saveRec(next); return next; } catch (err) { if (!err?.conflict || attempt) throw err; }
    }
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
        const rec = Object.assign(blank(m), structuredClone((await readMonth(m)) || {}));
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
    let rec = Object.assign(blank(m), structuredClone((await readMonth(m)) || {}));
    // What this pop-up changes is saved onto the month as it is at the time (saveMerged).
    let base = structuredClone(rec);
    const commit = async () => { rec = await saveMerged(m, base, rec); base = structuredClone(rec); dirty = true; };
    const prior = (await readMonth(addMonths(m, -1))) || byMonth[addMonths(m, -1)] || null;
    const files = ACCOUNT_FILES[id] || {};
    const src = BANK_SOURCES.find((s) => s.id === id);

    await panel(`${label(id)} — ${monthName(m)}`, (body, close) => {
      let draw = () => {};
      const doAttach = async (list) => {
        if (!list.length) return;
        const res = await attachFiles({ files: list, rec, cds, month: m, user, expectAccount: id, ask, saveCd });
        if (res.changed) {
          try { await commit(); } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
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
              x.ok === false ? statusPill('Doesn’t tie', 'bad') : x.evidence ? statusPill('Kept as evidence', 'neutral') : statusPill('Ties', 'good'),
              x.s.fileKey ? h('button', { class: 'small-btn', onclick: async () => { const u = await fileUrl('statements', x.s.fileKey).catch(() => null); if (u) window.open(u, '_blank', 'noopener'); } }, 'View') : null,
              h('button', { class: 'small-btn danger', onclick: async () => {
                if (!(await ask('Detach statement', `Detach ${x.s.fileName || x.label}? Its figures come out of ${monthName(m)}.`, { ok: 'Detach', danger: true }))) return;
                await x.detach(); logChange(rec, user, `Detached ${x.label} ${x.s.fileName || ''}`);
                try { await commit(); } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
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
                  field('Beginning value (optional)', inp('beginning'), 'From the statement or screenshot. Only a check: the JE books the change from the last ending booked, and flags a beginning that differs.'),
                  id === 'tschetter' ? field('Expenses year to date', rec.bankStatements?.tschetter ? h('span', {}, money(rec.bankStatements.tschetter.feesYtd, { dash: false }), h('span', { class: 'muted small' }, ' (from the statement)')) : inp('feesYtd'),
                    'From a statement only (January to December). Filled in, the JE books the fees since they were last booked; left blank (screenshots), only the gain.') : null,
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
                  try { await commit(); toast('Saved.'); } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
                  draw();
                } }, 'Save'))),
          auto && src.id !== 'cd' ? h('p', { class: 'muted small' }, 'Detach the statement to type figures instead.') : null,
          h('h3', {}, 'Confirm the figures'),
          stampBadge({ enteredBy: l.enteredBy, enteredAt: l.enteredAt, obj: b, values: l.values, user,
            onConfirm: async () => {
              confirmValues(b, user, l.values); logChange(rec, user, `Confirmed ${label(id)}: revenue ${money(l.rev, { dash: false })}, interest ${money(l.int, { dash: false })}`);
              try { await commit(); } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
              draw();
            },
            onUnconfirm: async () => { delete b.confirmation; logChange(rec, user, `Removed confirmation on ${label(id)}`); try { await commit(); } catch (err) { toast(explain(err), 'error'); } draw(); } }),

          id === 'cassOp' ? cassSummary(c, m, close) : null,
          id === 'cassOp' || id === 'stripe' ? stripeCheckBox(c.stripeCheck, { rec, user, onChange: async () => { try { await commit(); } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); } draw(); } }) : null,
          id === 'wise' ? wiseOutBox(rec, close) : null,
          accountJeBlock(rec, id, jeCtx(() => draw(), { setSentAs: async (x, as) => {
            rec.paypalSentAs = { ...(rec.paypalSentAs || {}), [x.key]: { as, by: user, at: nowIso() } };
            logChange(rec, user, `PayPal payment sent ${x.date} ${x.desc} ${money(x.amount, { dash: false })}: booked as ${as === 'refund' ? 'a refund to a donor (4012)' : 'software (8030)'}`);
            try { await commit(); } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
            draw();
          } })),
          id === 'cd' ? h('p', { class: 'small' }, `CD schedule: ${money(cdFor(m).accrued)} earned in ${monthName(m)}, ${money(cdFor(m).realized)} paid at maturity. `, h('a', { href: '#/cds' }, 'Open the CD schedule')) : null,

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
        { label: 'Status', cell: (x) => status[x.state](x) },
        { label: '', cell: (x) => actionsCell({ confirm: x.state === 'counted' && x.landed ? () => treatAs(x.landed.month || rec.month, x.landed, 'transfer', `Money from Wise: ${x.date} ${x.desc}`, { kind: 'account', id: 'wise', m: rec.month }, close) : null, confirmLabel: 'Take out as a transfer' }) },
      ], outs));
  }

  // opts.only: just one of the sections still to decide ('matches', 'conflicts', 'noGl'), with
  // decisions reopening opts.again — for a month's to-do list.
  function cassSummary(c, m, close, opts = {}) {
    const cassAdj = c.adjustments.filter((a) => a.account === 'cassOp' || a.auto);
    const dep = c.deposits;
    const again = opts.again || { kind: 'account', id: 'cassOp', m };
    const saved = byMonth[m] || {};
    const conflicts = dep?.conflicts || [];
    // Deposits the GL doesn't have: those still to check first, then those someone has decided.
    const noGl = (dep?.noGl || []).filter((x) => !x.covered && !(opts.only && x.decided)).sort((x, y) => !!x.decided - !!y.decided);
    const typeName = (t) => (REVIEW_TYPES.find((x) => x[0] === t) || [, t])[1];
    // Deposits a statement rule already takes out (a Divvy reimbursement): confirming keeps that.
    const ruleOut = new Map(Object.entries(byMonth[m] ? defaultExclusions(byMonth[m]) : {}));
    const nowType = (x) => x.decided?.type || ruleOut.get(x.line.id)?.type || 'revenue';
    const confirmNoGl = (xs) => (rec) => {
      for (const x of xs) {
        const o = ruleOut.get(x.line.id);
        rec.excluded ||= {};
        if (o) { rec.excluded[x.line.id] = { type: o.type, note: `Confirmed: ${o.note || typeName(o.type)}`, by: user, at: nowIso() }; if (rec.dismissed) delete rec.dismissed[x.line.id]; }
        else { delete rec.excluded[x.line.id]; (rec.dismissed ||= {})[x.line.id] = { by: user, at: nowIso() }; }
      }
    };
    const undoNoGl = (x) => decide(m, (rec) => { if (rec.excluded) delete rec.excluded[x.line.id]; if (rec.dismissed) delete rec.dismissed[x.line.id]; },
      `${x.line.date} ${x.line.desc} ${money(x.line.amount)}: decision undone — back to checking`, again, close);
    const todoNoGl = noGl.filter((x) => !x.decided);
    const deposit = (line, sub) => h('div', {}, depositCell(line), sub ? h('div', { class: 'small muted wrap' }, sub) : null);

    // What comes out of Cass deposits, a line per kind; each kind's lines are checked in its own
    // pop-up (Transfers, Wire sweeps…), where the same Confirm and Change… are.
    const kinds = [...new Set(cassAdj.map(adjDetail))].map((kind) => {
      const as = cassAdj.filter((a) => adjDetail(a) === kind);
      const its = linesOf(as);
      return { kind, as, its, group: adjGroup(as[0]), todo: its.filter((x) => confirmOf(saved, x).st !== 'confirmed') };
    });
    const takenTodo = kinds.flatMap((k) => k.todo);
    const review = (group) => { close(true); openAdjustments(group, m); };
    const toCheck = matchesToCheck(c);
    const lowLines = toCheck.filter((x) => x.match);
    const saved_ = byMonth[m] || {};
    const matchSection = toCheck.length ? h('div', { class: 'adj-section' },
      reviewHead('Matches to the GL to check', { count: toCheck.length, todo: toCheck.length,
        onConfirmAll: lowLines.length ? () => confirmMatch(m, c, lowLines, again, close) : null }),
      h('p', { class: 'muted small' }, 'Each deposit is matched to the GL entry that booked it by amount and date, then checked against the names, the GL line, the kind of deposit and whether another entry could as well be it. These are the weak ones. Confirm match pins it (later uploads and rules won’t move it, and it’s flagged if the GL entry changes); Not this entry matches it again without that entry.'),
      table([
        { label: 'Date', cell: (x) => x.line.date },
        { label: 'Description', cell: (x) => depositCell(x.line) },
        { label: 'Amount', num: true, cell: (x) => money(x.line.amount) },
        { label: 'GL entry', cell: (x) => (x.match ? matchCell(x) : h('span', { class: 'small wrap' }, `Confirmed ${x.pin.batch} (${x.pin.desc || ''}) — ${x.kind === 'gone' ? 'no longer in the GL' : 'now matched to another deposit'}`)) },
        { label: 'Status', cell: (x) => statusCell(x.match ? { state: 'todo', text: x.match.pin ? 'GL changed since confirmed' : 'Low confidence', by: x.match.pin?.by, at: x.match.pin?.at }
          : { state: 'todo', text: x.kind === 'gone' ? 'GL entry gone' : 'GL entry taken', by: x.pin.by, at: x.pin.at }) },
        { label: '', cell: (x) => actionsCell(x.match
          ? { confirm: () => confirmMatch(m, c, [x], again, close), confirmLabel: x.match.pin ? 'Confirm again' : 'Confirm match',
            more: [h('button', { class: 'small-btn', onclick: () => rejectMatch(m, x, again, close) }, 'Not this entry')] }
          : { more: [h('button', { class: 'small-btn', onclick: () => unconfirmMatch(m, c, x, again, close) }, 'Clear the confirmation')] }) },
      ], toCheck)) : null;
    const rejectedAny = Object.keys(saved_.glNot || {}).length;
    const conflictSection = conflicts.length ? h('div', { class: 'adj-section' },
        reviewHead('A rule and the GL disagree', { count: conflicts.length, todo: conflicts.length }),
        h('p', { class: 'muted small' }, 'A statement rule says the deposit isn’t revenue, but the GL booked it as revenue. It counts as revenue, the GL’s way, until you decide: Confirm keeps it as revenue; Change… takes it out the rule’s way.'),
        table([
          { label: 'Date', cell: (x) => x.line.date },
          { label: 'Description', cell: (x) => deposit(x.line, `The rule: ${x.rule.note} · The GL: ${x.match.batch} ${x.match.desc}`) },
          { label: 'Amount', num: true, cell: (x) => money(x.line.amount) },
          { label: 'Status', cell: () => statusCell({ state: 'todo', counts: 'Counts as revenue (the GL)' }) },
          { label: '', cell: (x) => actionsCell({ confirm: () => treatAs(m, x.line, 'revenue', '', again, close),
            change: changeSelect([[x.rule.type, `The rule: ${typeName(x.rule.type).toLowerCase()}`], ...REVIEW_TYPES.filter(([v]) => v !== x.rule.type && v !== 'revenue')], 'revenue',
              (v) => treatAs(m, x.line, v, v === x.rule.type ? `Confirmed: ${x.rule.note}` : '', again, close)) }) },
        ], conflicts)) : null;
    const noGlSection = noGl.length ? h('div', { class: 'adj-section' },
        reviewHead('Deposits the GL doesn’t have', { count: noGl.length, todo: todoNoGl.length,
          onConfirmAll: () => decide(m, confirmNoGl(todoNoGl), `Confirmed ${todoNoGl.length} deposits the GL doesn’t match: ${todoNoGl.map((x) => `${x.line.date} ${money(x.line.amount)} as ${typeName(nowType(x)).toLowerCase()}`).join(', ')}`, again, close) }),
        h('p', { class: 'muted small' }, 'On the statement, but no GL batch this month or either side matches it — often revenue booked in another month, or several deposits booked as one entry that doesn’t add up the same way. Confirm keeps how it counts now; Change… counts it differently.'),
        table([
          { label: 'Date', cell: (x) => x.line.date },
          { label: 'Description', cell: (x) => deposit(x.line, x.decided?.note || '') },
          { label: 'Amount', num: true, cell: (x) => money(x.line.amount) },
          { label: 'Status', cell: (x) => (x.decided
            ? statusCell({ state: x.decided.type === (ruleOut.get(x.line.id)?.type || 'revenue') ? 'confirmed' : 'changed', by: x.decided.by, at: x.decided.at, counts: `Counts as ${typeName(x.decided.type).toLowerCase()}` })
            : statusCell({ state: 'todo', counts: ruleOut.has(x.line.id) ? `Counts as ${typeName(nowType(x)).toLowerCase()} (a statement rule)` : 'Counts as revenue' })) },
          { label: '', cell: (x) => actionsCell({
            confirm: x.decided ? null : () => decide(m, confirmNoGl([x]), `${x.line.date} ${x.line.desc} ${money(x.line.amount)}: confirmed as ${typeName(nowType(x)).toLowerCase()} (no GL batch matched it)`, again, close),
            change: changeSelect(REVIEW_TYPES, nowType(x), (v) => treatAs(m, x.line, v, '', again, close), 'Change how it counts…'),
            more: x.decided ? [h('button', { class: 'small-btn', onclick: () => undoNoGl(x) }, 'Undo')] : [] }) },
        ], noGl)) : null;
    if (opts.only === 'matches') return matchSection;
    if (opts.only === 'conflicts') return conflictSection;
    if (opts.only === 'noGl') return noGlSection;
    return h('div', {},
      matchSection,
      rejectedAny ? h('p', { class: 'small muted' }, `${rejectedAny} deposit${rejectedAny === 1 ? '' : 's'} with a GL entry ruled out (“Not this entry”) — see the deposit list below to undo.`) : null,
      conflictSection,
      noGlSection,
      decisionsMade(m, c, close),
      h('div', { class: 'adj-section' },
        reviewHead('Taken out of Cass deposits', { total: round2(sum(cassAdj, (a) => a.amount)), count: kinds.reduce((n, k) => n + k.its.length, 0), todo: takenTodo.length,
          onConfirmAll: () => decide(m, confirmLines(takenTodo, user), `Confirmed all ${takenTodo.length} lines taken out of Cass deposits`, again, close) }),
        kinds.length ? table([
          { label: 'What', cell: (k) => {
            const items = k.its.slice(0, 6);
            const what = whatLanded(c, items);
            return h('div', {}, h('span', {}, k.kind), h('span', { class: 'small muted' }, ` · ${k.group}`), items.length && k.as.some((a) => a.detail?.length) ? h('div', { class: 'muted small wrap' }, items.map((x) => (what(x) === x.desc ? `${x.date} ${x.desc} ${money(Math.abs(x.shown))}` : `${x.date} swept ${money(Math.abs(x.shown))}: ${what(x)}`)).join(' · '), k.its.length > 6 ? ` … +${k.its.length - 6} more` : '') : null);
          } },
          { label: 'Amount', num: true, cell: (k) => money(round2(sum(k.as, (a) => a.amount))) },
          { label: 'Evidence', cell: (k) => h('div', { class: 'stack' }, [...new Set(k.as.map((a) => a.evidence || 'statement'))].map(evidencePill)) },
          { label: 'Status', cell: (k) => statusCell(k.todo.length ? { state: 'todo', text: `${k.todo.length} of ${k.its.length} to check` } : { state: 'confirmed', text: `✓ All ${k.its.length} confirmed` }) },
          { label: '', cell: (k) => actionsCell({ more: [h('button', { class: 'small-btn', title: `Open ${k.group} for ${monthName(m)}`, onclick: () => review(k.group) }, k.todo.length ? 'Check lines →' : 'See lines →')] }) },
        ], kinds) : h('p', { class: 'muted' }, 'Nothing yet — attach the Cass statements.')),
      allDeposits(c, m, close));
  }

  // Every decision a person made on month m, with the group it took the line out of: recorded with
  // the decision, or — for one made before that was recorded — worked out from what the line would
  // count as if nobody had decided (the GL's or a statement rule's treatment).
  function monthDecisions(m, c) {
    const saved = byMonth[m] || {};
    const depById = new Map(reviewableDeposits(saved).map((t) => [t.id, t]));
    const ofType = (t) => (t === 'transfer' ? ADJ_GROUPS[0] : t === 'prior-period' ? ADJ_GROUPS[4] : t ? ADJ_GROUPS[2] : null);
    const automatic = (id) => {
      const { [id]: _d, ...dismissed } = saved.dismissed || {};
      return c.deposits?.overruled?.[id] || c.deposits?.exclusions?.[id] || defaultExclusions({ ...saved, dismissed })[id] || null;
    };
    const out = [];
    for (const [id, v] of Object.entries(saved.dismissed || {})) {
      if (!v) continue;
      const dep = depById.get(id);
      if (dep) { out.push({ id, v, type: 'revenue', line: dep, from: v.from || ofType(automatic(id)?.type) }); continue; }
      // A GL finding left out (auto-glrev-…, auto-glnocash-…).
      const o = typeof v === 'object' ? v : {};
      out.push({ id, v, type: 'left', line: { id, date: o.date || '', desc: o.desc || id.replace(/^auto-gl\w*?-/, 'GL finding '), amount: o.amount ?? 0 },
        from: o.from || adjGroup({ id, type: /^auto-glkey-/.test(id) ? 'not-revenue' : '', amount: -1 }) });
    }
    for (const [id, raw] of Object.entries(saved.excluded || {})) {
      const v = exclusionInfo(raw);
      if (!v || v.auto) continue;
      const dep = depById.get(id) || { id, date: v.date || '', desc: v.desc || id, amount: Math.abs(v.amount || 0) };
      out.push({ id, v, type: v.type, line: dep, from: v.from || ofType(automatic(id)?.type) });
    }
    return out;
  }

  // Every decision a person made on the month's deposits and GL findings, wherever it was made:
  // who, when, and Undo — so one that moved a line out of sight can always be found again.
  function decisionsMade(m, c, close) {
    const saved = byMonth[m] || {};
    const again = { kind: 'account', id: 'cassOp', m };
    const typeName = (t) => (REVIEW_TYPES.find((x) => x[0] === t) || [, t])[1];
    const rows = monthDecisions(m, c).map((d) => ({ ...d, v: typeof d.v === 'object' ? d.v : {} }))
      .sort((x, y) => String(x.line.date).localeCompare(String(y.line.date)));
    if (!rows.length) return null;
    return h('details', { class: 'adj-section', open: true }, h('summary', {}, h('strong', {}, `Decisions made this month (${rows.length})`), h('span', { class: 'muted small' }, ' — every deposit someone counted differently, and every GL finding left out, with Undo')),
      table([
        { label: 'Date', cell: (d) => d.line.date || '' },
        { label: 'Description', cell: (d) => h('div', {}, h('span', { class: 'wrap' }, d.line.desc), d.from ? h('div', { class: 'small muted' }, `Was under ${d.from}`) : null) },
        { label: 'Amount', num: true, cell: (d) => money(d.line.amount) },
        { label: 'Status', cell: (d) => statusCell({ state: 'changed', by: d.v?.by, at: d.v?.at, counts: d.type === 'left' ? 'Left out of this month' : `Counts as ${typeName(d.type).toLowerCase()}`, note: d.v?.note || '' }) },
        { label: '', cell: (d) => actionsCell({
          change: d.type === 'left' ? null : changeSelect(REVIEW_TYPES, d.type, (v) => treatAs(m, d.line, v, '', again, close), 'Change how it counts…'),
          more: [h('button', { class: 'small-btn', onclick: () => undoDecision(m, d.id, `${d.line.date || ''} ${d.line.desc} ${money(d.line.amount)}`, again, close) }, 'Undo')] }) },
      ], rows));
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
    const typeName = (t) => (REVIEW_TYPES.find((x) => x[0] === t) || [, t])[1];
    return h('details', { style: { marginTop: '1rem' } }, h('summary', {}, `Every deposit this month (${deps.length}) — how each counts, and what the GL booked it as`),
      table([
        { label: 'Date', cell: (t) => t.date },
        { label: 'Description', cell: (t) => h('div', {}, h('span', { class: 'wrap', title: t.detail || '' }, t.desc), h('div', { class: 'small muted' }, t.kind === 'incoming' ? 'Cass Incoming' : t.kind === 'wise' ? 'Wise' : 'Cass Operating')) },
        { label: 'Amount', num: true, cell: (t) => money(t.amount) },
        { label: 'Per the GL', cell: (t) => { const x = glOf.get(t.id); return t.kind === 'wise' ? '' : x ? h('div', {}, h('span', { class: 'small' }, `${kindName[x.kind] || x.kind} · `), matchCell({ line: t, match: x })) : dep?.available ? statusPill('No GL deposit', 'bad') : ''; } },
        { label: 'Status', cell: (t) => { const x = glOf.get(t.id); return h('div', { class: 'status' }, x ? matchPill(x.confidence) : null, statusCell({ state: null, by: x?.pin ? `Match confirmed by ${x.pin.by}` : '', at: x?.pin?.at, counts: `Counts as ${typeName(out.get(t.id)?.type || 'revenue').toLowerCase()}`, note: out.get(t.id)?.note || '' })); } },
        { label: '', cell: (t) => { const x = glOf.get(t.id); const e = { line: t, match: x };
          return actionsCell({ confirm: x && !x.pin ? () => confirmMatch(m, c, [e], again, close) : null, confirmLabel: 'Confirm match',
            change: changeSelect(REVIEW_TYPES, out.get(t.id)?.type || 'revenue', (v) => treatAs(m, t, v, '', again, close), 'Change how it counts…'),
            more: [x?.pin ? h('button', { class: 'small-btn', onclick: () => unconfirmMatch(m, c, e, again, close) }, 'Undo confirm match') : null,
              x && !x.pin ? h('button', { class: 'small-btn', onclick: () => rejectMatch(m, e, again, close) }, 'Not this entry') : null,
              byMonth[m]?.glNot?.[t.id] ? h('button', { class: 'small-btn', title: `Ruled out: ${byMonth[m].glNot[t.id].batches.join(', ')}`, onclick: () => undoReject(m, t, again, close) }, 'Allow ruled-out entries') : null] }); } },
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
          const r = Object.assign(blank(m), structuredClone((await readMonth(m)) || {}));
          const res = await attachFiles({ files, rec: r, cds, month: m, user, ask, saveCd });
          const bad = res.messages.filter((x) => x.bad);
          if (bad.length) await notify('Please check', bad.map((x) => x.text));
          else if (res.messages.length) toast(res.messages.map((x) => x.text).join(' · '));
          if (res.changed) { await saveRec(r); reopenAfter = again; carryScroll(topPanelScroll()); const opened = nextDialog(); await rerender(); await opened; close(true); }
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

        monthJeBlock(rec, jeCtx(async () => { reopenAfter = again; carryScroll(topPanelScroll()); const opened = nextDialog(); await rerender(); await opened; close(true); })),

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
      // Read the month fresh, apply the change, save; if someone saved it in between, once more.
      for (let attempt = 0; ; attempt++) {
        const rec = Object.assign(blank(m), structuredClone((await readMonth(m, { fresh: attempt > 0 })) || {}));
        change(rec);
        logChange(rec, user, what);
        try { await saveRec(rec); break; } catch (err) { if (!err?.conflict || attempt) throw err; }
      }
      reopenAfter = again;
      // The page redraws underneath; the new pop-up opens over this one where it was scrolled to,
      // then this one goes.
      carryScroll(topPanelScroll());
      const opened = again ? nextDialog() : null;
      await rerender();
      if (opened) await opened;
      close?.(true);
    } catch (err) { toast(explain(err, 'Couldn’t save that.'), 'error'); }
  }
  // How a deposit on the statement counts: revenue, or taken out (and why).
  // Which pop-up a decision was made in (an adjustment group), and the line itself, are kept with
  // it: a line decided out of a group (counted as revenue, moved to another group) is still listed
  // there under "Changed here", with Undo.
  const madeIn = (again, line) => (again?.kind === 'adjustments' ? { from: again.key, date: line.date || '', desc: line.desc || '', amount: line.amount } : {});
  function treatAs(m, line, type, note, again, close) {
    const name = (REVIEW_TYPES.find((x) => x[0] === type) || [, type])[1].toLowerCase();
    return decide(m, (rec) => {
      rec.excluded ||= {};
      delete rec.excluded[line.id];
      if (type === 'revenue') rec.dismissed = { ...(rec.dismissed || {}), [line.id]: { by: user, at: nowIso(), ...madeIn(again, line) } };
      else { rec.excluded[line.id] = { type, note: note || '', by: user, at: nowIso(), ...madeIn(again, line) }; if (rec.dismissed) delete rec.dismissed[line.id]; }
    }, `${line.date} ${line.desc} ${money(line.amount)}: ${type === 'revenue' ? 'counted as revenue' : `marked as ${name}`} (from the fiscal year sheet)`, again, close);
  }
  // Confirming a deposit's match to its GL entry pins it: kept whatever later uploads or rules do,
  // and flagged if the entry changes. Every deposit matched to the same entry (a day's wires, a
  // "PayPal Grants (6)") is pinned with it, since they stand or fall together.
  const groupOf = (c, x) => (c.deposits?.lines || []).filter((y) => y.match && y.match.batch === x.match.batch);
  function confirmMatch(m, c, xs, again, close) {
    const all_ = [...new Set(xs.flatMap((x) => groupOf(c, x)))];
    return decide(m, (rec) => {
      rec.glMatch ||= {};
      for (const y of all_) rec.glMatch[y.line.id] = { batch: y.match.batch, batches: y.match.batchIds, fp: y.match.fps?.[0] || null, fps: y.match.fps, amount: y.line.amount, desc: y.match.desc, by: user, at: nowIso() };
    }, `Confirmed the GL match: ${xs.map((x) => `${x.line.date} ${x.line.desc} ${money(x.line.amount)} = ${x.match.batch}`).join('; ')}${all_.length > xs.length ? ` (with ${all_.length - xs.length} more deposits in the same GL entry)` : ''}`, again, close);
  }
  function unconfirmMatch(m, c, x, again, close) {
    const ids = x.match ? groupOf(c, x).map((y) => y.line.id) : [x.line.id];
    return decide(m, (rec) => { for (const id of ids) if (rec.glMatch) delete rec.glMatch[id]; },
      `Took back the confirmed GL match of ${x.line.date} ${x.line.desc} ${money(x.line.amount)}${x.match ? ` (${x.match.batch})` : ''}`, again, close);
  }
  // Not this entry: the deposit is matched again without it (and never to it again).
  function rejectMatch(m, x, again, close) {
    return decide(m, (rec) => {
      rec.glNot ||= {};
      const was = rec.glNot[x.line.id]?.batches || [];
      rec.glNot[x.line.id] = { batches: [...new Set([...was, ...(x.match.batchIds || [x.match.batch])])], by: user, at: nowIso() };
      if (rec.glMatch) delete rec.glMatch[x.line.id];
    }, `${x.line.date} ${x.line.desc} ${money(x.line.amount)}: not GL ${x.match.batch} (${x.match.desc}) — matched again without it`, again, close);
  }
  function undoReject(m, line, again, close) {
    return decide(m, (rec) => { if (rec.glNot) delete rec.glNot[line.id]; }, `${line.date} ${line.desc} ${money(line.amount)}: rejected GL entries allowed again`, again, close);
  }
  // The GL entry a deposit is matched to, with what backs the match and what doesn't.
  function matchCell(x) {
    const mt = x.match, cf = mt?.confidence;
    if (!mt) return h('span', { class: 'small muted' }, 'No GL entry');
    return h('div', { class: 'small' }, h('div', { class: 'wrap' }, `${mt.batch} · ${mt.desc.slice(0, 60)}`),
      cf?.tie ? h('div', { class: 'muted' }, `Line ${cf.tie.id}${cf.tie.desc ? ` — ${cf.tie.desc}` : ''}`) : null,
      cf?.plus?.length ? h('div', { class: 'good-text wrap' }, `✓ ${cf.plus.filter((p) => !/^GL line/.test(p)).join(' · ')}`) : null,
      cf?.minus?.length ? h('div', { class: 'warn-text wrap' }, `⚠ ${cf.minus.join(' · ')}`) : null);
  }

  // Back to how the statements and the GL have it, as if nobody had decided.
  function undoDecision(m, id, what, again, close) {
    return decide(m, (rec) => { if (rec.excluded) delete rec.excluded[id]; if (rec.dismissed) delete rec.dismissed[id]; }, `${what}: decision undone — back to the automatic treatment`, again, close);
  }
  // The bank's description, and what it usually means.
  function depositCell(line) {
    const hint = depositHint(line.desc);
    return h('div', {}, h('span', { class: 'wrap' }, `${line.desc}${line.detail ? ` — ${line.detail}` : ''}`), hint ? h('div', { class: 'small muted wrap' }, hint) : null);
  }
  function leaveOut(m, a, again, close) {
    return decide(m, (rec) => { rec.dismissed = { ...(rec.dismissed || {}), [a.id]: { by: user, at: nowIso(), left: true, ...madeIn(again, { date: a.date, desc: a.label, amount: a.amount }) } }; }, `Left out “${a.label}” ${money(a.amount)} (from the fiscal year sheet)`, again, close);
  }
  // Deposits in transit for month m: every row can be decided or overridden, even one a statement
  // has settled; typed ones can be added and removed. Rows are checked like every other line:
  // Status, then Confirm (as suggested), then Change… and Undo.
  const ditShown = (r) => r.counts || r.flagged || r.choice;
  const ditTodoRows = (c) => (c.deposits?.dit?.rows || []).filter((r) => r.flagged);
  const confirmDit = (rows) => (rec) => {
    if (!rows.length) return;
    rec.ditGl = { ...(rec.ditGl || {}), ...Object.fromEntries(rows.map((r) => [r.batch, { in: r.suggested, by: user, at: nowIso() }])) };
  };
  // opts.onlyTodo: just the rows still to confirm, for a month's to-do list.
  function ditBlock(m, c, close, again, opts = {}) {
    const dit = c.deposits?.dit;
    const M = short(m), N = short(addMonths(m, 1));
    // Going against what a statement shows needs a reason, and stays marked (*).
    const setIn = async (r, inTransit) => {
      let note = '';
      if (r.settled && inTransit !== r.suggested) {
        note = (await askValue('Override the statement?', `${r.desc} ${money(r.amount)}: ${r.evidence}. Say why it belongs the other way — it will be marked * wherever it shows.`, { ok: 'Override' }))?.trim();
        if (!note) { toast('Not changed — an override needs a reason.'); return; }
      }
      decide(m, (rec) => { rec.ditGl = { ...(rec.ditGl || {}), [r.batch]: { in: inTransit, by: user, at: nowIso(), ...(note ? { note } : {}) } }; },
        `${r.desc} ${money(r.amount)}: ${inTransit ? `in transit at the end of ${monthName(m)}` : 'not in transit'}${note ? ` — overriding the statement: ${note}` : ''}`, again, close);
    };
    const clearChoice = (r) => decide(m, (rec) => { if (rec.ditGl) delete rec.ditGl[r.batch]; },
      `${r.desc} ${money(r.amount)}: back to ${r.settled ? 'what the statement shows' : 'the GL’s suggestion'}`, again, close);
    const rows = dit ? dit.rows.filter(opts.onlyTodo ? (r) => r.flagged : ditShown) : [];
    const typed = (byMonth[m]?.dit || []).filter((d) => !dit || !String(d.id || '').startsWith('imp-'));
    const dup = new Set((dit?.manual || []).filter((x) => x.duplicate).map((x) => x.d.id));
    // Where each choice puts the deposit, in words.
    const choices = (r) => (r.sign > 0 ? [['in', `Hit the bank in ${N} — in transit`], ['out', `Hit the bank in ${M}`]] : [['in', `Hit the bank in ${M} — booked in ${N}`], ['out', `Hit the bank in ${N}`]]);
    const countsAs = (r) => (choices(r).find(([v]) => v === (r.counts ? 'in' : 'out')) || [, ''])[1];
    const rowStatus = (r) => {
      if (r.overridden && r.settled) return statusCell({ state: 'override', by: r.choice.by, at: r.choice.at, counts: countsAs(r), note: r.choice.note ? `* ${r.choice.note}` : '' });
      if (r.choice) return statusCell({ state: r.choice.in === r.suggested ? 'confirmed' : 'changed', by: r.choice.by, at: r.choice.at, counts: countsAs(r) });
      if (r.settled) return statusCell({ state: 'statement', counts: countsAs(r) });
      return statusCell({ state: r.flagged ? 'todo' : null, counts: countsAs(r) });
    };
    const rowActions = (r) => actionsCell({
      confirm: r.flagged ? () => setIn(r, r.suggested) : null,
      change: changeSelect(choices(r), r.counts ? 'in' : 'out', (v) => setIn(r, v === 'in')),
      more: r.choice ? [h('button', { class: 'small-btn', title: r.settled ? 'Go back to what the statement shows' : 'Go back to the GL’s suggestion', onclick: () => clearChoice(r) }, 'Undo')] : [],
    });
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
        { label: 'GL date', cell: (r) => r.date },
        { label: 'Description', cell: (r) => h('div', {}, h('span', { class: 'wrap' }, r.desc), h('div', { class: 'small muted wrap' }, r.evidence)) },
        { label: 'Amount', num: true, cell: (r) => (r.counts ? money(r.sign * r.amount) : h('s', { class: 'muted', title: 'Not in transit — not counted' }, money(r.sign * r.amount))) },
        { label: 'Status', cell: rowStatus },
        { label: '', cell: rowActions },
      ], rows, { empty: 'Nothing near month end.', foot: opts.onlyTodo ? null : (col_) => (col_.label === 'Amount' ? money(dit.glTotal) : col_.label === 'Description' ? 'In transit, from the GL' : '') })
        : h('p', { class: 'muted small' }, 'No GL register for this month — deposits in transit are the typed ones below.'),
      opts.onlyTodo ? null : h('div', {},
      h('h4', {}, 'Typed deposits in transit'),
      typed.length ? table([
        { label: 'Date', cell: (d) => d.date || '' },
        { label: 'Description', cell: (d) => h('span', { class: 'wrap' }, d.note || '') },
        { label: 'Amount', num: true, cell: (d) => (dup.has(d.id) ? h('span', { title: 'Also on the GL’s list — not counted twice' }, h('s', { class: 'muted' }, money(d.amount))) : money(d.amount)) },
        { label: 'Status', cell: (d) => statusCell({ state: null, by: d.enteredBy ? `Typed by ${d.enteredBy}` : String(d.id || '').startsWith('imp-') ? 'From the workbook' : 'Typed', at: d.enteredAt, counts: dup.has(d.id) ? 'Also on the GL’s list — not counted twice' : '' }) },
        { label: '', cell: (d) => actionsCell({ more: [h('button', { class: 'small-btn danger', onclick: () => removeTyped(d) }, 'Remove')] }) },
      ], typed) : null,
      h('div', { class: 'row inline-form', style: { marginTop: '.4rem' } }, f.date, f.note, f.amount, h('button', { onclick: addTyped }, 'Add deposit in transit'))));
  }

  // ---- Adjustment detail panel -------------------------------------------------------------
  // An adjustment group's lines, each with its Status and actions: shared by the group's pop-up and
  // a month's to-do list (which shows only the lines still to confirm). Decisions reopen `again_`.
  // edit(a) opens a typed adjustment for editing (only the group's own pop-up has the form).
  function adjKit(key, m, c, close, again_, edit = null) {
    const list = c.adjustments.filter((a) => adjKey(a) === key);
    const fillForm = (a) => (edit ? edit(a) : (close(true), openAdjustments(key, m)));
    const items = linesOf(list);
    const what = whatLanded(c, items);
    const extra = (x) => [what(x) === (x.note || x.a.note) ? '' : x.note || x.a.note, x.a.enteredBy ? `Typed by ${x.a.enteredBy} · ${when(x.a.enteredAt)}` : ''].filter(Boolean).join(' · ');
    const withNotes = items.some((x) => extra(x));
    // What can be decided here: how a deposit counts, or leaving out something the GL found.
    const lineOf = (a) => (/^auto-(tr|ex)-/.test(a.id || '') ? a.id.replace(/^auto-(tr|ex)-/, '') : null);
    const saved = byMonth[m] || {};
    const isTodo = (x) => confirmOf(saved, x).st !== 'confirmed';
    const confirmOne = (x) => decide(m, confirmLines([x], user), `Confirmed ${x.date || ''} ${what(x)} ${money(x.shown)}`.replace(/\s+/g, ' '), again_, close);
    const confirmMany = (xs, name) => () => decide(m, confirmLines(xs, user), `Confirmed all ${xs.length} lines of “${name}”`, again_, close);
    // A Stripe transfer says how it counts, and who decided if a person did.
    const stripeOf = (x) => (x.a.id === 'auto-stripe' && x.id ? saved.stripeAs?.[x.id] || null : undefined);
    const status = (x) => {
      const { o, st } = confirmOf(saved, x);
      const sb = stripeOf(x);
      const counts = sb !== undefined ? 'Counts as a Stripe payout (a transfer, not revenue)' : '';
      const note = sb ? `Made a payout by ${sb.by} · ${when(sb.at)}` : '';
      if (st === 'confirmed') return statusCell({ state: 'confirmed', by: o.confirmation.by, at: o.confirmation.at, counts, note });
      return statusCell({ state: st === 'stale' ? 'stale' : 'todo', counts, note });
    };
    const setStripe = (t, as) => decide(m, (rec) => { rec.stripeAs = { ...(rec.stripeAs || {}), [t.id]: { as, by: user, at: nowIso() } }; },
      `${t.date} ${t.desc} ${money(Math.abs(t.amount ?? t.shown))}: counted as ${as === 'gift' ? 'revenue — a gift, not a Stripe payout' : 'a Stripe payout (transfer)'}`, again_, close);
    const undoStripe = (t) => decide(m, (rec) => { if (rec.stripeAs) delete rec.stripeAs[t.id]; },
      `${t.date} ${t.desc} ${money(Math.abs(t.amount ?? t.shown))}: back to how the GL has it`, again_, close);
    const typeName = (t) => (REVIEW_TYPES.find((y) => y[0] === t) || [, ADJUSTMENT_TYPES[t] || t])[1];
    const action = (x) => {
      const id = lineOf(x.a);
      const todo = isTodo(x);
      const more = [];
      let change = null;
      if (stripeOf(x) !== undefined) {
        change = changeSelect([['gift', 'A gift — count as revenue']], null, () => setStripe(x, 'gift'), 'Change how it counts…');
        if (stripeOf(x)) more.push(h('button', { class: 'small-btn', onclick: () => undoStripe(x) }, 'Undo'));
      } else if (id) change = changeSelect(REVIEW_TYPES, x.a.type || 'not-revenue', (v) => treatAs(m, { id, date: x.date, desc: x.desc, amount: Math.abs(x.shown) }, v, '', again_, close), 'Change how it counts…');
      else if (/^auto-gl/.test(x.a.id || '')) more.push(h('button', { class: 'small-btn', title: 'Found in the GL, but it doesn’t belong in this month’s proof of cash', onclick: () => leaveOut(m, x.a, again_, close) }, 'Leave out'));
      else if (!x.a.auto) more.push(h('button', { class: 'small-btn', onclick: () => fillForm(x.a) }, 'Edit'),
        h('button', { class: 'small-btn danger', onclick: async () => {
          if (!(await ask('Remove adjustment', `Remove “${x.a.label}” (${money(x.a.amount)})?`, { ok: 'Remove', danger: true }))) return;
          decide(m, (rec) => { rec.adjustments = (rec.adjustments || []).filter((y) => y.id !== x.a.id); }, `Removed adjustment “${x.a.label}” ${money(x.a.amount)}`, again_, close);
        } }, 'Remove'));
      if (!todo) more.push(h('button', { class: 'small-btn', title: 'Take the confirmation back — the line goes back to “To check”', onclick: () => unconfirmOne(x) }, 'Undo confirm'));
      return actionsCell({ confirm: todo ? () => confirmOne(x) : null, confirmLabel: confirmOf(saved, x).st === 'stale' ? 'Confirm again' : 'Confirm', change, more });
    };
    // Taking a confirmation back. One made for a whole adjustment (before lines could be
    // confirmed one at a time) stays on its other lines.
    const unconfirmOne = (x) => decide(m, (rec) => {
      if (!x.a.auto) { const t = (rec.adjustments || []).find((y) => y.id === x.a.id); if (t) delete t.confirmation; return; }
      const ac = rec.autoConfirm || {};
      const whole = ac[x.a.id];
      if (whole?.confirmation) {
        for (const y of items.filter((y) => y.a === x.a && y !== x)) ac[lineKey(y)] ||= { confirmation: { ...whole.confirmation, values: { amount: round2(y.shown) } } };
        delete ac[x.a.id];
      }
      delete ac[lineKey(x)];
    }, `Took back the confirmation of ${x.date || ''} ${what(x)} ${money(x.shown)}`.replace(/\s+/g, ' '), again_, close);
    const cols_ = [
      { label: 'Date', cell: (x) => x.date || '' },
      { label: 'Description', cell: (x) => h('div', {}, h('span', { class: 'wrap' }, what(x)),
        h('div', { class: 'small muted' }, [label(x.a.account || 'cassOp'), x.a.statement].filter(Boolean).join(' · '))) },
      { label: 'Amount', num: true, cell: (x) => money(x.shown) },
      { label: 'Evidence', cell: (x) => evidencePill(x.a.evidence) },
      ...(withNotes ? [{ label: 'Note / who', cell: (x) => h('span', { class: 'small wrap' }, extra(x)) }] : []),
      { label: 'Status', cell: (x) => status(x) },
      { label: '', cell: (x) => action(x) },
    ];
    return { list, items, what, isTodo, confirmMany, lineOf, typeName, setStripe, undoStripe, cols_ };
  }

  async function openAdjustments(key, m) {
    const col = cols.find((x) => x.m === m);
    if (!col?.c) return;
    const list = col.c.adjustments.filter((a) => adjKey(a) === key);
    const c = col.c;
    await panel(`${key} — ${monthName(m)}`, (body, close) => {
      const again_ = { kind: 'adjustments', key, m };
      const saved = byMonth[m] || {};
      const { items, what, isTodo, confirmMany, lineOf, typeName, setStripe, undoStripe, cols_ } = adjKit(key, m, c, close, again_, (a) => fillForm(a));
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
      // One section per kind of item, each with its reason, what's left to check and its subtotal.
      const kinds = [...new Set(list.map(adjDetail))];
      const section = (kind) => {
        const as = list.filter((a) => adjDetail(a) === kind);
        const its = items.filter((x) => as.includes(x.a));
        const todo = its.filter(isTodo);
        const why = [...new Set(as.map((a) => a.why).filter(Boolean))][0];
        return h('div', { class: 'adj-section' },
          reviewHead(kind, { total: round2(sum(as, (a) => a.amount)), count: its.length, todo: todo.length, onConfirmAll: confirmMany(todo, kind) }),
          why ? h('p', { class: 'muted small' }, why) : null,
          table(cols_, its));
      };
      const again = { kind: 'adjustments', key, m };
      const ditTodo = key === TIMING ? ditTodoRows(c) : [];
      const dit = key === TIMING && c.ditChange != null ? h('div', { class: 'adj-section' },
        reviewHead('Deposits in transit (change)', { total: c.ditChange, count: (c.deposits?.dit?.rows || []).filter(ditShown).length, todo: ditTodo.length,
          onConfirmAll: () => decide(m, confirmDit(ditTodo), `Confirmed ${ditTodo.length} deposits in transit as suggested`, again, close) }),
        h('p', { class: 'muted small' }, `${monthName(m)} in transit ${money(c.ditTotal, { dash: false })}, less ${monthName(addMonths(m, -1))}’s ${c.priorDit == null ? '(not known — counted as none)' : money(c.priorDit, { dash: false })}. `,
          h('button', { class: 'small-btn', onclick: () => { close(true); openDit(m); } }, `${monthName(addMonths(m, -1))}’s list too`)),
        ditBlock(m, c, close, again)) : null;
      // Lines decided out of this group here — counted as revenue, left out, or moved to another
      // group — so a mistake can be put right: who did it, and Undo.
      const inGroup = new Set([...list.map((a) => a.id), ...list.map(lineOf).filter(Boolean)]);
      const depById = new Map(reviewableDeposits(saved).map((t) => [t.id, t]));
      const decisions = monthDecisions(m, c)
        .filter((d) => d.from === key && !inGroup.has(d.id))
        .map((d) => ({ ...d, v: typeof d.v === 'object' ? d.v : {} }));
      const movedTo = (d) => { const a = c.adjustments.find((y) => lineOf(y) === d.id); return a ? adjGroup(a) : null; };
      // Stripe transfers that stay in revenue: gifts through someone else's Stripe account.
      const gifts = key === ADJ_GROUPS[0] ? stripeSplit(saved, c.deposits).gifts : [];
      const giftSection = gifts.length ? h('div', { class: 'adj-section' },
        reviewHead('Stripe transfers counted as revenue (gifts)', { total: round2(sum(gifts, (t) => t.amount)) }),
        h('p', { class: 'muted small' }, 'Stripe transfers into Cass that aren’t one of our payouts — a gift paid through someone else’s Stripe account (Every.org). They stay in revenue, so they aren’t taken out above.'),
        table([
          { label: 'Date', cell: (t) => t.date },
          { label: 'Description', cell: (t) => h('div', {}, h('span', { class: 'wrap' }, t.desc), h('div', { class: 'small muted wrap' }, t.gl ? `Per the GL: ${t.gl.batch} ${t.gl.desc} (${t.gl.label})` : 'Cass Operating')) },
          { label: 'Amount', num: true, cell: (t) => money(t.amount) },
          { label: 'Status', cell: (t) => (t.by ? statusCell({ state: 'changed', by: t.by.by, at: t.by.at, counts: 'Counts as revenue — a gift' })
            : statusCell({ state: 'statement', text: '✓ The GL books it as revenue', counts: 'Counts as revenue — a gift' })) },
          { label: '', cell: (t) => actionsCell({ change: changeSelect([['payout', 'A Stripe payout — take it out as a transfer']], null, () => setStripe(t, 'payout'), 'Change how it counts…'),
            more: t.by ? [h('button', { class: 'small-btn', onclick: () => undoStripe(t) }, 'Undo')] : [] }) },
        ], gifts)) : null;
      const changedHere = decisions.length ? h('div', { class: 'adj-section' },
        reviewHead('Changed here', { count: 0 }),
        h('p', { class: 'muted small' }, 'Lines someone took out of this group in this pop-up. They no longer count here; Undo puts them back the way the statements and the GL have them.'),
        table([
          { label: 'Date', cell: (d) => d.line.date || '' },
          { label: 'Description', cell: (d) => h('span', { class: 'wrap' }, d.line.desc || d.id) },
          { label: 'Amount', num: true, cell: (d) => money(d.type === 'left' ? d.v.amount : d.line.amount) },
          { label: 'Status', cell: (d) => statusCell({ state: 'changed', by: d.v.by, at: d.v.at,
            counts: d.type === 'left' ? 'Left out of this month' : d.type === 'revenue' ? 'Counts as revenue' : `Counts as ${typeName(d.type).toLowerCase()}${movedTo(d) ? ` — now under ${movedTo(d)}` : ''}`, note: d.v.note || '' }) },
          { label: '', cell: (d) => actionsCell({
            change: d.type === 'left' ? null : changeSelect(REVIEW_TYPES, d.type, (v) => treatAs(m, d.line, v, '', again_, close), 'Change how it counts…'),
            more: [h('button', { class: 'small-btn', onclick: () => undoDecision(m, d.id, `${d.line.date || ''} ${d.line.desc || d.id} ${money(d.line.amount)}`, again_, close) }, 'Undo')] }) },
        ], decisions)) : null;
      // Everything in this pop-up at once: what's left to check, and one button for all of it.
      const allTodo = items.filter(isTodo);
      const count = items.length + (dit ? (c.deposits?.dit?.rows || []).filter(ditShown).length : 0);
      const todoN = allTodo.length + ditTodo.length;
      const bar = count ? h('div', { class: 'review-bar' },
        todoN ? statusPill(`${todoN} to check`, 'warn') : statusPill('✓ Everything here is checked', 'good'),
        h('span', { class: 'muted small' }, todoN ? `of ${count} lines — confirm each below, or all at once` : `${count} lines`),
        h('span', { class: 'spacer' }),
        todoN ? h('button', { class: 'small-btn confirm-btn', onclick: () => decide(m, (rec) => { confirmLines(allTodo, user)(rec); confirmDit(ditTodo)(rec); }, `Confirmed all ${todoN} lines of “${key}”`, again, close) }, `Confirm all ${todoN}`) : null) : null;
      mount(body,
        bar,
        dit, kinds.map(section), giftSection, changedHere,
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
      { label: 'Status', cell: (x) => (x.from === 'To confirm' ? statusPill('To check', 'warn') : x.from === 'Statement' ? statusPill('✓ Statement shows it', 'good') : h('span', { class: 'small muted' }, x.from)) },
    ], list, { empty, foot: (col_) => (col_.label === 'Amount' ? money(round2(sum(list, (x) => x.amount))) : col_.label === 'GL date' ? 'Total' : '') });
    const prevC = cols.find((x) => x.m === prev)?.c;
    // Each list's heading: what's left to check, and Confirm all.
    const ditHead = (mm, cc, title, close, back = mm) => {
      const todo = ditTodoRows(cc);
      return reviewHead(title, { total: cc.ditTotal, count: (cc.deposits?.dit?.rows || []).filter(ditShown).length, todo: todo.length,
        onConfirmAll: () => decide(mm, confirmDit(todo), `Confirmed ${todo.length} deposits in transit as suggested`, { kind: 'dit', m: back }, close) });
    };
    await panel(`Deposits in transit — ${monthName(m)}`, (body, close) => {
      mount(body,
        h('p', { class: 'muted' }, `Money the GL booked as revenue in one month that reached the bank in the next. The change is ${monthName(m)}’s in transit less ${monthName(prev)}’s, which reached the bank in ${monthName(m)}. The GL names the bank date in each batch (“3.3.2026 February Deposit”); the next month’s statement confirms it.`),
        ditHead(m, c, `In transit at the end of ${monthName(m)} (plus)`, close), c.deposits?.dit ? ditBlock(m, c, close, { kind: 'dit', m }) : tableOf(thisList, 'None.'),
        prevC?.deposits?.dit ? ditHead(prev, prevC, `In transit at the end of ${monthName(prev)}, reached the bank in ${monthName(m)} (less)`, close, m) : h('h3', {}, `In transit at the end of ${monthName(prev)}, reached the bank in ${monthName(m)} (less)`),
        priorList ? (prevC?.deposits?.dit ? ditBlock(prev, prevC, close, { kind: 'dit', m }) : tableOf(priorList, 'None.')) : h('p', { class: 'small warn-text' }, `Not known — ${monthName(prev)} isn’t in the GL and none were entered for it, so nothing comes off. Its deposits that reached the bank in ${monthName(m)} are marked “Recognized in another month” on the deposit list instead.`),
        h('div', { class: 'recon', style: { marginTop: '.75rem' } },
          rowKV(`${monthName(m)} in transit`, money(c.ditTotal)),
          rowKV(`Less ${monthName(prev)} in transit`, c.priorDit == null ? 'not known' : money(-c.priorDit)),
          rowKV('Change, into adjusted bank revenue', money(c.ditChange ?? 0))),
        null);
    }, { wide: true });
  }

  // ---- GL panel: statement of activities or GL register, or typed --------------------------
  // ---- Salesforce vs the GL: giving, month by month ------------------------------------------------
  // Separate from the proof of cash: Salesforce's gifts by close date and payment method against the
  // GL's giving (4010, 4012, 4015, 4017, 4018) in the same channels, with every reason the app can
  // put a number on, and what's left.
  const CHECKISH = /DEPOSIT CONNECTION|MOBILE DEPOSIT|REMOTE DEPOSIT|BRANCH DEPOSIT/i;
  const GIVING_ACCTS = ['4010', '4012', '4015', '4017', '4018'];
  function sfFound(m) {
    const c = cols.find((x) => x.m === m)?.c;
    // Only gifts: a deposit collected on a grant or pledge receivable (1220). Merchandise sold on
    // account (1210, the air orders) and card rewards aren't in Salesforce's giving at all.
    const priorPeriod = (c?.adjustments || []).filter((a) => a.type === 'prior-period' && /^auto-ex-/.test(a.id || '') && /\b1220\b/.test(a.note || ''))
      .map((a) => ({ channel: CHECKISH.test(a.detail?.[0]?.desc || a.label) ? 'Check' : 'Wire', amount: -a.amount, desc: (a.detail?.[0]?.desc || a.label).slice(0, 60), source: a.note || '' }));
    const noCash = (glBy[m]?.noCashRevenue || []).map((x) => ({ amount: round2(GIVING_ACCTS.reduce((t, a) => t + (x.accounts[a] || 0), 0)), desc: x.desc, source: `GL ${x.batch} (${x.date})` }))
      .filter((x) => Math.abs(x.amount) >= 0.005);
    const releases = (c?.adjustments || []).filter((a) => /^auto-glrelease-/.test(a.id || '')).map((a) => ({ amount: a.amount, desc: a.label, source: a.note || '' }));
    // Gifts the GL took back out of revenue (moved to agency, reversed, a returned item): Salesforce
    // still has them. Only gift accounts (4010-4018), not royalties or merchandise.
    const reversals = (c?.adjustments || []).filter((a) => /^auto-glrev-/.test(a.id || '') && /\b40(1[0-8])\b/.test(a.note || ''))
      .map((a) => { const d = a.detail?.[0]?.desc || a.label; return { channel: /paypal/i.test(d) ? 'PayPal' : /deposit/i.test(d) ? 'Check' : 'Wire', amount: -a.amount, desc: d.slice(0, 60), source: a.note || '' }; });
    return { priorPeriod, noCash, releases, reversals };
  }
  const sfYear = (() => {
    const ms = cols.map((x) => x.m).filter((m) => sfBy[m] || glBy[m]?.giving);
    const res = reconcileYear(ms.map((m) => ({ sf: sfBy[m] ? { ...sfBy[m], month: m } : { month: m, methods: {} }, giving: glBy[m]?.giving, found: sfFound(m) })));
    // What's not explained, added up month by month through the months that have ended.
    let run = 0;
    const doneMs = new Set(done.map((x) => x.m));
    res.forEach((r, i) => { if (sfBy[ms[i]] && doneMs.has(ms[i])) { run = round2(run + r.unexplained); r.running = run; } });
    return Object.fromEntries(res.map((r, i) => [ms[i], r]));
  })();
  // Salesforce wire gifts the GL doesn't seem to have (salesforce.js suspectGifts), by month.
  const sfSuspects = (() => {
    const ms = cols.map((x) => x.m).filter((m) => sfBy[m]);
    const tol = { ...DEFAULT_SF_TOLERANCE, ...(cfg.sfTolerance || {}) };
    const res = suspectGifts(ms.map((m) => ({ sf: { ...sfBy[m], month: m }, giving: glBy[m]?.giving, found: sfFound(m) })), { min: tol.giftMin });
    const by = {}, decided = {}, matched = {}, skipped = {};
    for (const g of res.missing) (by[g.month] ||= []).push(g);
    for (const g of res.decided) (decided[g.month] ||= []).push(g);
    for (const g of res.matched) (matched[g.month] ||= []).push(g);
    for (const g of res.skipped) (skipped[g.month] ||= []).push(g);
    return { by, decided, matched, skipped, looked: res.looked };
  })();
  const pct = (v) => (v == null ? '' : `${(v * 100).toFixed(1)}%`);
  const pct2 = (v) => (v == null ? '' : `${(v * 100).toFixed(2)}%`);
  // The limits for what's left unexplained (settings: Tolerance…).
  const sfTol = { ...DEFAULT_SF_TOLERANCE, ...(cfg.sfTolerance || {}) };
  const tolText = `limits: ${pct2(sfTol.monthPct)} of GL giving a month, ${pct2(sfTol.ytdPct)} year to date; any giving type over ${money(sfTol.item, { dash: false })} unexplained is listed to look at`;
  const tolPill = (t, ytd = false) => (t.share == null ? '' : statusPill(t.ok ? 'Within tolerance' : 'Investigate', t.ok ? 'good' : 'warn'));
  // The section's rows, shared with the Excel export.
  const sfRowsDef = () => [
    { label: 'Salesforce (by close date)', f: (r) => r.sfTotal, strong: true },
    { label: 'GL giving (4010, 4012, 4015, 4017, 4018)', f: (r) => r.glTotal, strong: true },
    { label: 'Difference (Salesforce − GL)', f: (r) => r.diff, strong: true },
    { label: '% of GL', f: (r) => r.pct, fmt: pct, noYtd: true, share: true, ytdOf: (t) => t.pct, ytdFmt: pct },
    { label: 'Explained', f: (r) => r.explained, cls: 'good-text' },
    { label: 'by the GL or a person', indent: true, f: (r) => round2(r.explained - byPattern(r)) },
    { label: 'by a pattern only (timing, lump payouts owed): not checked', indent: true, f: (r) => byPattern(r), cls: (v) => (Math.abs(v) >= 1000 ? 'warn-text' : '') },
    { label: 'Not explained', f: (r) => r.unexplained, cls: (v) => (Math.abs(v) >= 1000 ? 'warn-text' : '') },
    { label: '% of the differences explained', f: (r) => r.explainedShare, fmt: pct, noYtd: true, share: true, ytdOf: (t) => t.explainedShare, ytdFmt: pct },
    { label: 'Not explained, % of GL', f: (r) => withinTolerance(r, sfTol).share, fmt: pct2, noYtd: true, share: true, ytdOf: (t) => t.share },
    { label: 'Tolerance', strong: true, status: (r) => withinTolerance(r, sfTol), f: () => null, noYtd: true },
    { section: 'Not explained, by channel' },
    ...SF_CHANNELS.map((ch) => ({ label: ch, indent: true, f: (r) => r.rows.find((x) => x.channel === ch)?.unexplained ?? null, cls: (v) => (Math.abs(v) >= 1000 ? 'warn-text' : '') })),
    // DAF grants paid by check are "Check" in Salesforce and 4018 ("Wire") in the GL, so the two
    // are best read together.
    { label: 'Check + Wire together', indent: true, f: (r) => round2(sum(r.rows.filter((x) => x.channel === 'Check' || x.channel === 'Wire'), (x) => x.unexplained)), cls: (v) => (Math.abs(v) >= 1000 ? 'warn-text' : '') },
    // Timing spread over several months (year-end giving recorded in Salesforce in Nov–Dec, reaching
    // the GL in Jan–Feb) shows as a running total that rises, then comes back.
    { label: 'Not explained, running total', f: (r) => r.running ?? null, noYtd: true, cls: (v) => (Math.abs(v) >= 1000 ? 'warn-text' : '') },
  ];
  // YTD over the months that have ended (as the proof of cash), with a Salesforce report and GL giving.
  const sfDoneSet = new Set(done.map((x) => x.m));
  const sfYtdMonths = () => cols.map((x) => x.m).filter((m) => sfBy[m] && glBy[m]?.giving && sfDoneSet.has(m));
  function sfSection() {
    const ms = cols.map((x) => x.m);
    const any = ms.some((m) => sfBy[m]);
    const doneSet = sfDoneSet;
    const both = sfYtdMonths();
    const needGl = ms.some((m) => sfBy[m] && glBy[m] && (!glBy[m].giving || (Array.isArray(sfBy[m].gifts) && !glBy[m].giving.payers)));
    const cell = (m, v, cls = '') => h('td', { class: `num clickable-cell ${cls}${doneSet.has(m) ? '' : ' muted'}`, title: doneSet.has(m) ? 'Open the month' : 'This month hasn’t ended yet — not in YTD', onclick: () => openSfMonth(m) }, v);
    const ytd = (f) => { const v = both.map((m) => f(sfYear[m])).filter((x) => x != null); return v.length ? round2(sum(v, (x) => x)) : null; };
    const rowsDef = sfRowsDef();
    const ytdT = ytdTolerance(both.map((m) => sfYear[m]), sfTol);
    return h('div', { class: 'sheet-block', style: { marginTop: '1.5rem' } },
      h('div', { class: 'row' }, h('h2', {}, 'Salesforce vs GL — giving'), h('span', { class: 'spacer' }),
        any ? h('button', { class: 'btn', onclick: exportSalesforce, title: 'Download Salesforce vs GL — the months, each channel, every reason with its source, restricted gifts and the largest GL lines — as an Excel workbook' }, 'Export Excel') : null,
        h('button', { class: 'btn', onclick: openSfTolerance, title: 'How much unexplained difference is acceptable' }, 'Tolerance…'),
        fileButton('Upload Salesforce reports…', '.xlsx,.xls', async (files) => { if (await uploadSalesforce(files)) rerender(); }, { multiple: true })),
      any ? (() => { const ms = sfYtdMonths(); const t = (f) => round2(sum(ms, (m) => f(sfYear[m]) || 0)); const gl = t((r) => r.glTotal);
        return ytdBar([['Difference', t((r) => r.diff), gl], ['Not explained', t((r) => r.unexplained), gl]],
          { ms, note: ms.length !== done.length ? `Only months with a Salesforce report and the GL’s giving by channel count here: ${done.map((x) => x.m).filter((m) => !ms.includes(m)).map(short).join(', ')} ${done.length - ms.length === 1 ? 'is' : 'are'} missing one.` : null }); })() : null,
      h('p', { class: 'muted small' }, 'Salesforce’s gifts by close date and payment method against the GL’s giving in the same channels. Some difference is expected — refunds, month-end timing, grants the GL recognizes when pledged, gifts held back — and each reason the app can put a number on is counted as explained. Click a month for the detail.'),
      any ? h('p', { class: 'muted small' }, `Tolerance ${tolText}.`) : null,
      !any ? h('p', { class: 'muted' }, 'Upload Salesforce opportunity reports to start: the gift-level report (Amount, Close Date, Payment Method) or the summary by close date and payment method. Several at once is fine — each replaces only the months its date filter covers.')
        : h('div', { class: 'table-wrap sheet' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', { class: 'label-col' }, ''), h('th', { class: 'num ytd', title: `Totals over the months that have ended, with a Salesforce report and the GL’s giving.${stillWaiting.length ? `\nStill waiting (in YTD, so it will move) — ${stillWaiting.map((x) => `${short(x.m)}: ${x.why.join(', ')}`).join('; ')}` : ''}` }, 'YTD', h('div', { class: 'muted small' }, both.length ? `${short(both[0])}–${short(both[both.length - 1])} · ${both.length} mo.` : 'no months yet')),
            ms.map((m) => h('th', { class: 'num month' }, h('a', { href: '#/poc', onclick: (e) => { e.preventDefault(); openSfMonth(m); } }, short(m)))))),
          h('tbody', {}, rowsDef.map((d) => (d.section ? h('tr', { class: 'section' }, h('td', { class: 'label-col', colspan: ms.length + 2 }, d.section))
            : h('tr', { class: d.strong ? 'strong' : '' }, h('td', { class: `label-col${d.indent ? ' indent' : ''}` }, d.label),
              h('td', { class: 'num ytd' }, d.status ? tolPill(ytdT) : d.ytdOf ? (d.ytdFmt || pct2)(d.ytdOf(ytdT)) : d.noYtd ? '' : money(ytd(d.f))),
              ms.map((m) => { const r = sfYear[m]; if (!r || !sfBy[m]) return h('td', { class: 'num muted' }, sfBy[m] ? '' : '');
                if (d.status) { const t = d.status(r); return cell(m, h('span', { title: t.big.length ? `Over ${money(sfTol.item, { dash: false })} unexplained: ${t.big.map((x) => `${x.channel} ${money(x.unexplained, { dash: false })}`).join(', ')}` : '' }, tolPill(t), t.big.length ? h('div', { class: 'small muted' }, `${t.big.length} to look at`) : null)); }
                const v = d.f(r); const cls = typeof d.cls === 'function' ? (v == null ? '' : d.cls(v)) : d.cls || '';
                return cell(m, v == null ? '' : (d.fmt ? d.fmt(v) : money(v)), cls); }))))))),
      needGl ? h('p', { class: 'small warn-text' }, 'Some months’ GL register was uploaded before giving was kept by channel and payer — upload the GL register again to compare them, sponsor by sponsor.') : null);
  }
  // Excel: the section as it stands, then everything behind it.
  async function exportSalesforce() {
    const ms = cols.map((x) => x.m).filter((m) => sfBy[m]);
    const ytdMs = sfYtdMonths();
    const share = (v) => (v == null ? null : { v: Math.round(v * 1e6) / 1e6, z: '0.0%' });
    const stamp = `Exported ${new Date().toLocaleString()}${user ? ` by ${user}` : ''} · Salesforce opportunities by close date against GL giving (4010, 4012, 4015, 4017, 4018)`;
    const summary = [[`FY${fy} Salesforce vs GL — giving`], [stamp],
      [`YTD = ${ytdMs.length ? `${short(ytdMs[0])}–${short(ytdMs[ytdMs.length - 1])} (${ytdMs.length} months ended, with a Salesforce report and GL giving)` : 'no months ended yet'}. Months not in YTD: ${ms.filter((m) => !ytdMs.includes(m)).map(short).join(', ') || 'none'}.`], [],
      ['', 'YTD', ...ms.map((m) => monthName(m))]];
    const ytdT = ytdTolerance(ytdMs.map((m) => sfYear[m]), sfTol);
    summary.splice(3, 0, [`Tolerance ${tolText}.`]);
    for (const d of sfRowsDef()) {
      if (d.section) { summary.push([d.section.toUpperCase()]); continue; }
      if (d.status) {
        const word = (t) => (t.share == null ? '' : t.ok ? 'Within tolerance' : `INVESTIGATE${t.big?.length ? '' : ''}`);
        summary.push([d.label, word(ytdT), ...ms.map((m) => (sfYear[m] ? `${word(d.status(sfYear[m]))}${d.status(sfYear[m]).big.length ? ` (${d.status(sfYear[m]).big.map((x) => `${x.channel} ${money(x.unexplained, { dash: false })}`).join(', ')} to look at)` : ''}` : ''))]);
        continue;
      }
      if (d.ytdOf) { const z = (v) => (v == null ? null : { v: Math.round(v * 1e6) / 1e6, z: d.ytdFmt ? '0.0%' : '0.00%' }); summary.push([d.label, z(d.ytdOf(ytdT)), ...ms.map((m) => (sfYear[m] ? z(d.f(sfYear[m])) : null))]); continue; }
      const vals = ms.map((m) => { const v = sfYear[m] ? d.f(sfYear[m]) : null; return d.share ? share(v) : v; });
      const ytd = d.noYtd ? null : round2(sum(ytdMs.map((m) => d.f(sfYear[m]) ?? 0), (x) => x));
      const ytdShare = d.share && ytdMs.length ? (() => { const df = sum(ytdMs, (m) => sfYear[m].diff), gl = sum(ytdMs, (m) => sfYear[m].glTotal), un = sum(ytdMs, (m) => sfYear[m].unexplained);
        return share(d.label === '% of GL' ? (gl ? df / gl : null) : df ? Math.max(0, Math.min(1, 1 - Math.abs(un) / Math.abs(df))) : 1); })() : null;
      summary.push([`${d.indent ? '    ' : ''}${d.label}`, d.share ? ytdShare : ytd, ...vals]);
    }
    const byChannel = [['Month', 'Channel', 'Salesforce', 'Salesforce gifts', 'GL', 'Difference', 'Explained', 'Not explained', 'In YTD']];
    const reasons = [['Month', 'Channel', 'Reason', 'Why', 'Source', 'Evidence', 'Amount']];
    const EV = { gl: 'GL', pattern: 'Pattern across months', flag: 'To check', typed: 'Typed' };
    const toDate = [['Month', 'Giving type / sponsor', 'Salesforce this month', 'GL this month', 'Salesforce to date', 'GL to date', 'Difference to date']];
    const restricted = [['Month', 'Date', 'GL batch', 'GL line', 'Payer', 'Batch description', 'Channel', 'Amount']];
    const largest = [['Month', 'Channel', 'Not explained in the channel', 'Date', 'GL line', 'Payer', 'Batch description', 'Amount']];
    for (const m of ms) {
      const r = sfYear[m]; if (!r) continue;
      for (const x of r.rows) byChannel.push([monthName(m), x.channel, x.sf, x.count || null, x.gl, x.diff, x.explained, x.unexplained, ytdMs.includes(m) ? 'Yes' : 'No — GL not complete']);
      byChannel.push([monthName(m), 'Total', r.sfTotal, null, r.glTotal, r.diff, r.explained, r.unexplained, ytdMs.includes(m) ? 'Yes' : 'No — GL not complete']);
      for (const x of r.reasons) reasons.push([monthName(m), x.channel, x.what, x.why, x.source || '', EV[x.evidence] || x.evidence || '', x.flag ? 'CHECK' : x.amount]);
      if (r.toDate) {
        for (const x of r.rows) { const t = r.toDate.channels[x.channel]; if (t) toDate.push([monthName(m), x.channel, x.sf, x.gl, t.sf, t.gl, round2(t.sf - t.gl)]); }
        for (const [n, t] of Object.entries(r.toDate.sponsors || {}).sort((a, b) => Math.abs(b[1].sf - b[1].gl) - Math.abs(a[1].sf - a[1].gl))) {
          const a = r.toDate.thisMonth?.sf?.[n] || 0, b = r.toDate.thisMonth?.gl?.[n] || 0;
          if (Math.abs(t.sf - t.gl) >= 1000 || a >= 1000 || b >= 1000) toDate.push([monthName(m), `    Wire: ${n}`, a, b, t.sf, t.gl, round2(t.sf - t.gl)]);
        }
      }
      for (const x of r.restricted) restricted.push([monthName(m), x.date, x.batch, x.line, x.payer, x.desc, x.channel, x.amount]);
      for (const row of r.rows.filter((x) => Math.abs(x.unexplained) >= 1000 && x.channel !== 'Stripe')) {
        for (const l of (glBy[m]?.giving?.big?.[row.channel] || []).slice(0, 20)) largest.push([monthName(m), row.channel, row.unexplained, l.date, l.line, l.payer, l.desc, l.amount]);
      }
    }
    const sources = [['Month', 'Salesforce file', 'As of', 'Uploaded by', 'Uploaded at', 'Salesforce filters', 'GL file', 'GL uploaded by', 'GL uploaded at']];
    for (const m of ms) { const x = sfBy[m], g = glBy[m]; sources.push([monthName(m), x?.fileName || '', x?.asOf || '', x?.uploadedBy || '', x?.uploadedAt ? when(x.uploadedAt) : '', (x?.filters || []).join(' · '), g?.fileName || '', g?.uploadedBy || '', g?.uploadedAt ? when(g.uploadedAt) : '']); }
    try {
      await downloadWorkbook(`Salesforce vs GL FY${fy} ${new Date().toISOString().slice(0, 10)}.xlsx`, [
        { name: 'Salesforce vs GL', rows: summary, cols: [42, 16, ...ms.map(() => 16)], freeze: { xSplit: 1, ySplit: 5 } },
        { name: 'By channel', rows: byChannel, cols: [16, 12, 16, 12, 16, 16, 16, 16, 22] },
        { name: 'Reasons', rows: reasons, cols: [16, 10, 50, 80, 50, 20, 16] },
        { name: 'Running totals', rows: toDate, cols: [16, 44, 16, 16, 16, 16, 16], freeze: { ySplit: 1 } },
        { name: 'Gifts to look at', rows: [[`Salesforce wire gifts of ${money(sfTol.giftMin, { dash: false })} or more the GL doesn't seem to have (no line from the same sponsor or a processor, 3 days before to 45 days after; a line of the same amount under another name is shown as a possible match). ${sfSuspects.looked} looked for.`], [],
          ['Month', 'Close date', 'Donor-advised fund', 'Primary contact (Salesforce 18-character ID)', 'Amount', 'Status', 'Decided by', 'When', 'Note'],
          ...Object.entries(sfSuspects.by).sort().flatMap(([mm, gs]) => gs.map((g) => [monthName(mm), g.date, g.fund, g.contact, g.amount, g.maybe ? `To look at - possible match: ${g.maybe.date} ${g.maybe.payer} ${g.maybe.amount}${g.maybe.batch ? ` (${g.maybe.batch})` : ''}` : 'To look at'])),
          ...Object.entries(sfSuspects.decided).sort().flatMap(([mm, gs]) => gs.map((g) => [monthName(mm), g.date, g.fund, g.contact, g.amount,
            g.decision.status === 'found' ? 'In the GL' : SF_ADJ_TYPES[g.decision.type] || 'Explained', g.decision.by || '', g.decision.at ? when(g.decision.at) : '', g.decision.note || '']))], cols: [16, 12, 44, 30, 14, 40, 18, 20, 60] },
        { name: 'Restricted gifts', rows: restricted, cols: [16, 12, 12, 16, 30, 40, 10, 14] },
        { name: 'Largest GL lines', rows: largest, cols: [16, 10, 18, 12, 16, 30, 40, 14] },
        { name: 'Sources', rows: sources, cols: [16, 40, 12, 18, 20, 70, 40, 18, 20] },
      ]);
    } catch (err) { toast(explain(err, 'Couldn’t build the Excel file.'), 'error'); }
  }
  // Salesforce reports, one or several at once (a year of gifts is more than one export). Each
  // replaces exactly the months its date filter covers — a month in the range with no gifts is
  // saved as none — and leaves every other month as it was. Where two of the files cover the same
  // month, the one run most recently wins.
  async function uploadSalesforce(files) {
    const read = [];
    for (const [i, file] of files.entries()) {
      toast(`Reading ${file.name}${files.length > 1 ? ` (${i + 1} of ${files.length})` : ''}… a large report can take a minute.`);
      await new Promise((r) => setTimeout(r, 50)); // let the message show before the page is busy
      try {
        const { XLSX, wb } = await readWorkbook(file);
        read.push({ file, res: parseSalesforceReport(XLSX, wb) });
      } catch (err) { await notify(`Couldn’t read ${file.name}`, [explain(err, '')]); }
    }
    if (!read.length) return false;
    const winner = {};
    for (const x of read) for (const mo of x.res.months) {
      const w = winner[mo.month];
      if (!w || String(x.res.asOf || '') >= String(w.res.asOf || '')) winner[mo.month] = x;
    }
    const lines = read.map(({ file, res }) => {
      const mine = res.months.filter((mo) => winner[mo.month] === read.find((y) => y.file === file));
      const lost = res.months.filter((mo) => !mine.includes(mo));
      const cover = res.covered ? `covers ${res.covered.from} to ${res.covered.to}` : 'has no date range in its filter, so only the months with gifts in it are replaced';
      return [
        `${file.name}${res.asOf ? ` (run ${res.asOf})` : ''}, ${res.kind === 'gifts' ? 'gift by gift' : 'summary'}: ${cover}.`,
        `  ${mine.map((mo) => `${short(mo.month)} ${money(mo.total, { dash: false })}${sfBy[mo.month] ? ' (replaces the earlier upload)' : ''}`).join(' · ') || 'no months'}`,
        ...(lost.length ? [`  Not used for ${lost.map((mo) => short(mo.month)).join(', ')}: another of these files was run more recently.`] : []),
        ...(res.covered?.partial?.length ? [`  Only part of ${res.covered.partial.map(short).join(', ')} is in the date range, so that month will be short.`] : []),
        ...(res.excludes.refunds || res.excludes.disputes ? [`  Leaves out ${[res.excludes.refunds && 'refunded', res.excludes.disputes && 'disputed'].filter(Boolean).join(' and ')} Stripe gifts, so the GL’s Stripe ${[res.excludes.refunds && 'refunds', res.excludes.disputes && 'disputes'].filter(Boolean).join(' and ')} won’t be counted as explaining a difference.`] : []),
      ];
    });
    const n = Object.keys(winner).length;
    const line_ = (l) => h('span', { style: { display: 'block', marginLeft: l.startsWith('  ') ? '1rem' : 0, marginTop: l.startsWith('  ') ? 0 : '.5rem' } }, l.trim());
    const kept = Object.keys(winner).filter((m) => sfBy[m]?.adjustments?.length);
    const text_ = [...lines.flat().map(line_), line_(`Every other month stays as it is.${kept.length ? ` Explanations you typed for ${kept.map(short).join(', ')} are kept.` : ''}`)];
    if (!(await ask('Load Salesforce reports', text_, { ok: `Load ${n} month${n === 1 ? '' : 's'}` }))) return false;
    try {
      for (const [m, { file, res }] of Object.entries(winner).sort()) {
        const mo = res.months.find((x) => x.month === m);
        // Explanations someone typed for the month stay with it.
        const rec = { ...mo, kind: res.kind, excludes: res.excludes, fileName: file.name, asOf: res.asOf, filters: res.filters, uploadedBy: user, uploadedAt: nowIso(),
          ...(res.covered?.partial?.includes(m) ? { partial: true } : {}), ...(sfBy[m]?.adjustments?.length ? { adjustments: sfBy[m].adjustments } : {}) };
        await saveSfGiving(rec); sfBy[m] = rec; recentSf[m] = rec;
      }
      toast(`Salesforce loaded for ${n} month${n === 1 ? '' : 's'}: ${Object.keys(winner).sort().map(short).join(', ')}.`);
    } catch (err) { notify('Couldn’t save the Salesforce figures', [explain(err, 'Some months may not have saved — upload again.')]); }
    return true;
  }
  // Explaining a difference by hand: which giving type (and sponsor), what it is, how much of the
  // Salesforce − GL difference it accounts for, and why. Kept on the Salesforce month.
  async function saveSfAdj(m, change, what, close) {
    try {
      const rec = structuredClone(sfBy[m]);
      rec.adjustments ||= [];
      change(rec);
      rec.updatedAt = nowIso(); rec.updatedBy = user;
      await saveSfGiving(rec); sfBy[m] = rec; recentSf[m] = rec;
      toast(what);
      reopenAfter = { kind: 'sf', m };
      carryScroll(topPanelScroll());
      const opened = nextDialog(); await rerender(); await opened; close?.(true);
    } catch (err) { toast(explain(err, 'Couldn’t save that.'), 'error'); }
  }
  async function removeSfAdj(m, x, close) {
    if (!(await ask('Remove explanation', `Remove “${x.what}” (${money(x.amount, { dash: false })})?`, { ok: 'Remove', danger: true }))) return;
    saveSfAdj(m, (rec) => { rec.adjustments = rec.adjustments.filter((y) => y.id !== x.id); }, 'Explanation removed', close);
  }
  function sfAdjForm(m, r, close) {
    const left = (ch) => r.rows.find((x) => x.channel === ch)?.unexplained ?? 0;
    const first = r.rows.slice().sort((a, b) => Math.abs(b.unexplained) - Math.abs(a.unexplained))[0]?.channel || 'Wire';
    const sponsors = Object.keys(r.toDate?.sponsors || {}).filter((n) => n !== '(none)').sort();
    const fx = {
      channel: h('select', {}, [...new Set([...SF_CHANNELS, ...r.rows.map((x) => x.channel)])].map((ch) => h('option', { value: ch, selected: ch === first }, ch))),
      sponsor: h('input', { type: 'text', size: 18, placeholder: 'Sponsor (optional)', list: `sf-sponsors-${m}` }),
      type: h('select', {}, Object.entries(SF_ADJ_TYPES).map(([v, t]) => h('option', { value: v }, t))),
      amount: h('input', { type: 'text', inputmode: 'decimal', class: 'num', size: 12, value: String(round2(left(first))) }),
      note: h('input', { type: 'text', size: 32, placeholder: 'Why (for anyone checking)' }),
    };
    fx.channel.addEventListener('change', () => { fx.amount.value = String(round2(left(fx.channel.value))); });
    const save = () => {
      const amount = parseAmount(fx.amount.value);
      if (!Number.isFinite(amount) || !amount) { toast('Type the amount it explains.', 'error'); return; }
      if (!fx.note.value.trim()) { toast('Say why, for anyone checking.', 'error'); return; }
      const v = { id: Math.random().toString(36).slice(2, 9), channel: fx.channel.value, sponsor: fx.sponsor.value.trim(), type: fx.type.value, amount, note: fx.note.value.trim(), by: user, at: nowIso() };
      saveSfAdj(m, (rec) => { rec.adjustments.push(v); }, `Explanation added: ${v.channel} ${money(amount, { dash: false })}`, close);
    };
    return h('div', { class: 'adj-section' },
      h('h4', {}, 'Explain a difference yourself'),
      h('div', { class: 'row inline-form' }, fx.channel, fx.sponsor, h('datalist', { id: `sf-sponsors-${m}` }, sponsors.map((n) => h('option', { value: n }))), fx.type, fx.amount, fx.note,
        h('button', { class: 'primary', onclick: save }, 'Add')),
      h('p', { class: 'muted small' }, 'The amount is how much of the Salesforce − GL difference it accounts for: positive when Salesforce is higher, negative when the GL is. It starts at what’s left unexplained for the giving type. It counts as explained, shows who entered it, and stays with the month when Salesforce is uploaded again.'));
  }
  // Running totals from the first month: what Salesforce has built up against what the GL has booked,
  // per giving type and per wire sponsor, so a lump payout reads against everything before it.
  function sfToDate(r) {
    const t = r.toDate;
    if (!t) return null;
    const ms = `${short(t.from)}–${short(r.month)}`;
    const chRows = Object.entries(t.channels).map(([ch, x]) => ({ name: ch, month: r.rows.find((y) => y.channel === ch) || { sf: 0, gl: 0 }, ...x })).filter((x) => x.sf || x.gl);
    const spRows = Object.entries(t.sponsors || {}).map(([n, x]) => ({ name: n, month: { sf: t.thisMonth?.sf?.[n] || 0, gl: t.thisMonth?.gl?.[n] || 0 }, ...x }))
      .filter((x) => Math.abs(x.sf - x.gl) >= 1000 || x.month.gl >= 1000 || x.month.sf >= 1000).sort((a, b) => Math.abs(b.sf - b.gl) - Math.abs(a.sf - a.gl));
    const cols_ = [
      { label: '', cell: (x) => x.name },
      { label: `Salesforce ${short(r.month)}`, num: true, cell: (x) => money(x.month.sf) },
      { label: `GL ${short(r.month)}`, num: true, cell: (x) => money(x.month.gl) },
      { label: `Salesforce ${ms}`, num: true, cell: (x) => money(x.sf) },
      { label: `GL ${ms}`, num: true, cell: (x) => money(x.gl) },
      { label: 'Difference to date', num: true, cell: (x) => h('strong', { class: Math.abs(x.sf - x.gl) >= 1000 ? 'warn-text' : '' }, money(round2(x.sf - x.gl))) },
    ];
    return h('div', { class: 'adj-section' },
      h('h3', {}, `Running totals, ${ms}`),
      h('p', { class: 'muted small' }, 'Everything Salesforce has recorded since the first month against everything the GL has booked. A payout that covers several months (Patreon, Great Commission Foundation, Stewardship) reads against what built up before it.'),
      table(cols_.map((c, i) => (i ? c : { ...c, label: 'Giving type' })), chRows),
      spRows.length ? h('details', { class: 'adj-section' }, h('summary', {}, `Wire gifts by sponsor (${spRows.length} with a difference or a payout)`), table(cols_.map((c, i) => (i ? c : { ...c, label: 'Sponsor' })), spRows))
        : h('p', { class: 'muted small' }, 'Wire gifts by sponsor need the gift-level Salesforce report and the GL register uploaded since payers were kept.'));
  }
  // What a flagged gift is, decided on the gift itself. An explanation (with the gift's amount) counts
  // as explained; "it's in the GL" only takes it off the list — there's no difference to explain.
  const GIFT_CHOICES = [
    ['not-received', 'Not received: a duplicate, or a pledge not paid'],
    ['other-account', 'Received into another account (stock not sold yet, say)'],
    ['found', 'It’s in the GL: take it off the list'],
    ['other', 'Something else: explain it'],
  ];
  async function decideGift(m, g, choice, close) {
    const label = GIFT_CHOICES.find((x) => x[0] === choice)[1];
    const note = await askValue(label, `${g.date} · ${g.fund || 'no fund named'} · ${money(g.amount, { dash: false })}. Say why, for anyone checking${choice === 'found' ? ' (which GL batch has it)' : ''}.`, { ok: 'Save' });
    if (note == null) return;
    if (!note.trim()) { toast('Say why, for anyone checking.', 'error'); return; }
    const stamp = { by: user, at: nowIso() };
    saveSfAdj(m, (rec) => {
      if (choice === 'found') rec.giftChecks = { ...(rec.giftChecks || {}), [g.key]: { status: 'found', note: note.trim(), ...stamp } };
      else rec.adjustments.push({ id: Math.random().toString(36).slice(2, 9), gift: g.key, channel: 'Wire', sponsor: g.sp, type: choice, amount: g.amount, note: `${g.date} ${g.fund || ''} gift: ${note.trim()}`.replace(/\s+/g, ' '), ...stamp });
    }, `${g.date} ${money(g.amount, { dash: false })}: ${label.split(':')[0]}`, close);
  }
  function undoGift(m, g, close) {
    saveSfAdj(m, (rec) => {
      rec.adjustments = (rec.adjustments || []).filter((a) => a.gift !== g.key);
      if (rec.giftChecks) delete rec.giftChecks[g.key];
    }, `${g.date} ${money(g.amount, { dash: false })}: back on the list`, close);
  }
  function giftsSection(m, close) {
    const open = sfSuspects.by[m] || [], done_ = sfSuspects.decided[m] || [];
    const matched = sfSuspects.matched[m] || [], skipped = sfSuspects.skipped[m] || [];
    if (!open.length && !done_.length && !matched.length && !skipped.length) return null;
    const lineText = (l) => `${l.date} ${l.payer || '(no name)'} ${money(l.amount, { dash: false })}${l.batch ? ` (${l.batch})` : ''}`;
    const cols_ = [
      { label: 'Close date', cell: (g) => g.date },
      { label: 'Donor-advised fund', cell: (g) => g.fund || '(none)' },
      { label: 'Primary contact', cell: (g) => h('span', { class: 'small' }, g.contact) },
      { label: 'Amount', num: true, cell: (g) => money(g.amount) },
    ];
    return h('div', { class: 'adj-section' },
      reviewHead('Salesforce gifts the GL doesn’t seem to have', { count: open.length + done_.length, todo: open.length }),
      h('p', { class: 'muted small' }, `Wire gifts of ${money(sfTol.giftMin, { dash: false })} or more with no GL line from the same sponsor or a payment processor from 3 days before to 45 days after. A line of the same amount under another name is shown as a possible match, not taken as the gift. Look each up and say what it is: an explanation counts toward “Explained”; “it’s in the GL” just takes it off the list.`),
      open.length ? table([...cols_,
        { label: 'Possible match', cell: (g) => (g.maybe ? h('span', { class: 'small wrap' }, `Same amount, another name: ${lineText(g.maybe)}. Check it’s this gift.`) : h('span', { class: 'small muted' }, 'Nothing in the GL')) },
        { label: 'Status', cell: () => statusCell({ state: 'todo' }) },
        { label: '', cell: (g) => actionsCell({ change: changeSelect(GIFT_CHOICES, null, (v) => decideGift(m, g, v, close), 'Say what it is…') }) },
      ], open) : null,
      done_.length ? h('div', {}, h('h4', {}, 'Looked at'),
        table([...cols_,
          { label: 'Status', cell: (g) => statusCell({ state: g.decision.status === 'found' ? 'confirmed' : 'changed', text: g.decision.status === 'found' ? '✓ In the GL' : SF_ADJ_TYPES[g.decision.type] || 'Explained', by: g.decision.by, at: g.decision.at, note: g.decision.note }) },
          { label: '', cell: (g) => actionsCell({ more: [h('button', { class: 'small-btn', onclick: () => undoGift(m, g, close) }, 'Undo')] }) },
        ], done_)) : null,
      matched.length || skipped.length ? h('details', { class: 'small', 'data-key': 'gifts-found' },
        h('summary', {}, `How the other wire gifts were found (${matched.length + skipped.length})`),
        table([...cols_,
          { label: 'Found as', cell: (g) => h('span', { class: 'small wrap' }, g.line ? `${g.how}: ${lineText(g.line)}` : `Not looked for: ${g.why}`) },
        ], [...matched, ...skipped].sort((a, b) => b.amount - a.amount))) : null);
  }
  async function openSfTolerance() {
    await panel('Salesforce vs GL — tolerance', (body, close) => {
      const fx = {
        monthPct: h('input', { type: 'text', inputmode: 'decimal', class: 'num', size: 6, value: String(round2(sfTol.monthPct * 100)) }),
        ytdPct: h('input', { type: 'text', inputmode: 'decimal', class: 'num', size: 6, value: String(round2(sfTol.ytdPct * 100)) }),
        item: h('input', { type: 'text', inputmode: 'decimal', class: 'num', size: 10, value: String(sfTol.item) }),
        giftMin: h('input', { type: 'text', inputmode: 'decimal', class: 'num', size: 10, value: String(sfTol.giftMin) }),
      };
      const save = async () => {
        const v = { monthPct: parseAmount(fx.monthPct.value) / 100, ytdPct: parseAmount(fx.ytdPct.value) / 100, item: parseAmount(fx.item.value), giftMin: parseAmount(fx.giftMin.value) };
        if (![v.monthPct, v.ytdPct, v.item, v.giftMin].every((x) => Number.isFinite(x) && x >= 0)) { toast('Type a number in each.', 'error'); return; }
        try { cfg.sfTolerance = { ...v, by: user, at: nowIso() }; await savePocConfig(cfg); toast('Tolerance saved'); close(true); rerender(); }
        catch (err) { toast(explain(err, 'Couldn’t save that.'), 'error'); }
      };
      mount(body,
        h('p', { class: 'muted' }, 'Salesforce and the GL won’t tie to zero: they’re kept on different dates and at different detail. What’s held to a limit is the part of the difference nothing explains.'),
        h('div', { class: 'recon' },
          rowKV('Each month, unexplained as % of GL giving', h('span', {}, fx.monthPct, ' %')),
          rowKV('Year to date, unexplained as % of GL giving', h('span', {}, fx.ytdPct, ' %')),
          rowKV('List any giving type with more unexplained than', h('span', {}, '$ ', fx.item)),
          rowKV('Look for Salesforce wire gifts the GL doesn’t have, from', h('span', {}, '$ ', fx.giftMin))),
        h('p', { class: 'muted small' }, `A month over its limit shows “Investigate”. Giving types over the amount are listed in the month to look at, whatever the percentage. Defaults: ${pct2(DEFAULT_SF_TOLERANCE.monthPct)}, ${pct2(DEFAULT_SF_TOLERANCE.ytdPct)}, ${money(DEFAULT_SF_TOLERANCE.item, { dash: false })}.${cfg.sfTolerance?.by ? ` Last set by ${cfg.sfTolerance.by}${cfg.sfTolerance.at ? ` · ${when(cfg.sfTolerance.at)}` : ''}.` : ''}`),
        h('div', { class: 'row dialog-actions' }, h('button', { class: 'primary', onclick: save }, 'Save')));
    });
  }
  async function openSfMonth(m) {
    const r = sfYear[m];
    const sfm = sfBy[m];
    await panel(`Salesforce vs GL — ${monthName(m)}`, (body, close) => {
      if (!r || !sfm) { mount(body, h('p', { class: 'muted' }, 'No Salesforce figures for this month yet — upload the report.')); return; }
      const g = glBy[m]?.giving;
      const leftCh = r.rows.filter((x) => Math.abs(x.unexplained) >= 1000).map((x) => x.channel);
      mount(body,
        h('div', { class: 'review-bar' },
          (() => { const t = withinTolerance(r, sfTol); return statusPill(`${t.ok ? 'Within tolerance' : 'Investigate'}: ${money(r.unexplained, { dash: false })} not explained, ${pct2(t.share)} of GL (limit ${pct2(sfTol.monthPct)})`, t.ok ? 'good' : 'warn'); })(),
          h('span', { class: 'muted small' }, `Salesforce ${money(r.sfTotal, { dash: false })} · GL ${money(r.glTotal, { dash: false })} · difference ${money(r.diff, { dash: false })} (${pct(r.pct)}) · ${pct(r.explainedShare)} of the differences found explained`)),
        h('p', { class: 'muted small' }, `Salesforce from ${sfm.fileName || 'an upload'}${sfm.asOf ? ` (run ${sfm.asOf})` : ''}, ${sfm.kind === 'gifts' ? 'gift by gift' : 'the summary report'}, uploaded by ${sfm.uploadedBy || 'someone'}${sfm.uploadedAt ? ` · ${when(sfm.uploadedAt)}` : ''}.${sfm.excludes?.refunds || sfm.excludes?.disputes ? ' The report leaves out refunded and disputed Stripe gifts, so the GL’s Stripe refunds and disputes aren’t counted as explaining the difference.' : ''}${sfm.partial ? ' The report’s date range covers only part of this month.' : ''}`),
        (() => { const big = withinTolerance(r, sfTol).big; return big.length ? h('p', { class: 'small warn-text' }, `To look at (over ${money(sfTol.item, { dash: false })} unexplained): ${big.map((x) => `${x.channel} ${money(x.unexplained, { dash: false })}`).join(' · ')}. Use “Explain a difference yourself” below for anything you’ve found.`) : null; })(),
        giftsSection(m, close),
        h('h3', {}, 'By channel'),
        table([
          { label: 'Channel', cell: (x) => x.channel },
          { label: 'Salesforce', num: true, cell: (x) => h('div', {}, money(x.sf), x.count ? h('div', { class: 'small muted' }, `${x.count.toLocaleString()} gifts`) : null) },
          { label: 'GL', num: true, cell: (x) => money(x.gl) },
          { label: 'Difference', num: true, cell: (x) => money(x.diff) },
          { label: 'Explained', num: true, cell: (x) => money(x.explained) },
          { label: 'Not explained', num: true, cell: (x) => h('strong', { class: Math.abs(x.unexplained) >= 1000 ? 'warn-text' : '' }, money(x.unexplained)) },
        ], r.rows, { foot: (col_) => ({ Channel: 'Total', Salesforce: money(r.sfTotal), GL: money(r.glTotal), Difference: money(r.diff), Explained: money(r.explained), 'Not explained': money(r.unexplained) }[col_.label] || '') }),
        h('h3', {}, 'What explains it'),
        r.reasons.length ? table([
          { label: 'Channel', cell: (x) => x.channel },
          { label: 'Reason', cell: (x) => h('div', {}, h('strong', {}, x.what), h('div', { class: 'small muted wrap' }, x.why)) },
          { label: 'Source', cell: (x) => h('span', { class: 'small wrap' }, x.source || '') },
          { label: 'Amount', num: true, cell: (x) => (x.flag ? statusPill('Check', 'warn') : money(x.amount)) },
          { label: '', cell: (x) => (x.id ? h('button', { class: 'small-btn danger', onclick: () => removeSfAdj(m, x, close) }, 'Remove') : '') },
        ], r.reasons) : h('p', { class: 'muted small' }, 'Nothing the app can put a number on yet.'),
        sfAdjForm(m, r, close),
        sfToDate(r),
        r.restricted.length ? h('div', {}, h('h3', {}, 'Restricted gifts (4017) in the GL'),
          h('p', { class: 'muted small' }, 'Counted in the channel they came in by, as Salesforce does. Salesforce may record a restricted gift when it’s given and the GL when it’s released, so they’re listed here to check.'),
          table([
            { label: 'Date', cell: (x) => x.date },
            { label: 'GL', cell: (x) => h('span', { class: 'small wrap' }, `${x.batch} · ${x.payer} · ${x.desc}`) },
            { label: 'Channel', cell: (x) => x.channel },
            { label: 'Amount', num: true, cell: (x) => money(x.amount) },
          ], r.restricted)) : null,
        leftCh.length ? h('div', {}, h('h3', {}, 'Where to look'),
          h('p', { class: 'muted small' }, 'The largest GL gifts in each channel with a difference left. Check these against Salesforce first.'),
          leftCh.map((ch) => h('details', { class: 'adj-section' }, h('summary', {}, `${ch}: ${money(r.rows.find((x) => x.channel === ch).unexplained, { dash: false })} not explained`),
            table([
              { label: 'Date', cell: (x) => x.date },
              { label: 'GL line', cell: (x) => h('span', { class: 'small wrap' }, `${x.line} · ${x.payer}`, h('div', { class: 'muted' }, x.desc)) },
              { label: 'Amount', num: true, cell: (x) => money(x.amount) },
            ], (g?.big?.[ch] || []).slice(0, 20), { empty: ch === 'Stripe' ? 'Stripe is one monthly total in the GL.' : 'No single GL line of 1,000 or more.' })))) : null,
        h('p', { class: 'small muted', style: { marginTop: '1rem' } }, `Salesforce: ${sfm.fileName || ''}${sfm.asOf ? ` (as of ${sfm.asOf})` : ''} · uploaded by ${sfm.uploadedBy || ''} ${when(sfm.uploadedAt)}. ${(sfm.filters || []).join(' · ')}`));
    }, { wide: true });
  }

  // ---- A month's to-do list: every decision still open, with a way to it -------------------------
  // GL-only items this large need someone to confirm them against a document (the platform's
  // remittance, the investment statement), not just the GL.
  const GL_ONLY_LIMIT = () => cfg.glOnlyThreshold ?? 500;
  // Each item: what, how many, a line of detail, go() to the pop-up it belongs to, and inline(close)
  // — the rows themselves, with the same Status, Confirm and Change… as in that pop-up, so it can be
  // decided right here. Decisions made here reopen the to-do list where it was.
  function monthTodo(m) {
    const c = cols.find((x) => x.m === m)?.c;
    const saved = byMonth[m];
    if (!c || !saved) return [];
    const dep = c.deposits;
    const again = { kind: 'todo', m };
    const out = [];
    const add = (what, n, detail, go, kind = 'warn', inline = null) => { if (n) out.push({ what, n, detail, go, kind, inline }); };
    const missing = (c.warnings || []).filter((w) => ['operating', 'incoming', 'outgoing'].includes(w.kind));
    add('Statements missing', missing.length, missing.map((w) => w.text).join(' '), () => openMonth(m), 'warn',
      () => h('p', { class: 'small' }, 'Attach them in the month’s pop-up (or drop them on the Cass Operating cell).'));
    const other = (c.warnings || []).filter((w) => !['operating', 'incoming', 'outgoing'].includes(w.kind));
    add('Deposits in transit to look at', other.length, other.map((w) => w.text).join(' '), () => openAdjustments(TIMING, m));
    const low = matchesToCheck(c);
    add('Matches to the GL to check', low.length, low.slice(0, 4).map((x) => `${x.line.date} ${x.line.desc} ${money(x.line.amount, { dash: false })}`).join('; '), () => openAccount('cassOp', m), 'warn',
      (close) => cassSummary(c, m, close, { only: 'matches', again }));
    add('A rule and the GL disagree', dep?.conflicts?.length || 0, (dep?.conflicts || []).map((x) => `${x.line.date} ${x.line.desc} ${money(x.line.amount, { dash: false })}`).join('; '), () => openAccount('cassOp', m), 'warn',
      (close) => cassSummary(c, m, close, { only: 'conflicts', again }));
    const noGl = (dep?.noGl || []).filter((x) => !x.covered && !x.decided);
    add('Deposits the GL doesn’t have', noGl.length, noGl.map((x) => `${x.line.date} ${x.line.desc} ${money(x.line.amount, { dash: false })}`).join('; '), () => openAccount('cassOp', m), 'warn',
      (close) => cassSummary(c, m, close, { only: 'noGl', again }));
    const dit = ditTodoRows(c);
    add('Deposits in transit to confirm', dit.length, dit.map((r) => `${r.desc} ${money(r.amount, { dash: false })}`).join('; '), () => openAdjustments(TIMING, m), 'warn',
      (close) => h('div', {}, h('div', { class: 'row' }, h('button', { class: 'small-btn confirm-btn', onclick: () => decide(m, confirmDit(dit), `Confirmed ${dit.length} deposits in transit as suggested`, again, close) }, `Confirm all ${dit.length} as suggested`)),
        ditBlock(m, c, close, again, { onlyTodo: true })));
    for (const g of ADJ_GROUPS) {
      const lines_ = linesOf(c.adjustments.filter((a) => adjKey(a) === g));
      const todo = lines_.filter((x) => confirmOf(saved, x).st !== 'confirmed');
      const big = todo.filter((x) => x.a.evidence === 'gl' && Math.abs(x.shown) >= GL_ONLY_LIMIT());
      add(`${g}: lines to confirm`, todo.length, big.length ? `${big.length} rest on the GL alone and are ${money(GL_ONLY_LIMIT(), { dash: false })} or more — confirm against a document: ${big.slice(0, 3).map((x) => `${x.desc || x.a.label} ${money(x.shown, { dash: false })}`).join('; ')}` : `${todo.length} of ${lines_.length} lines`,
        () => openAdjustments(g, m), big.length ? 'warn' : 'info',
        (close) => {
          const kit = adjKit(g, m, c, close, again);
          const open_ = kit.items.filter(kit.isTodo).sort((x, y) => (y.a.evidence === 'gl' && Math.abs(y.shown) >= GL_ONLY_LIMIT()) - (x.a.evidence === 'gl' && Math.abs(x.shown) >= GL_ONLY_LIMIT()));
          return h('div', {}, h('div', { class: 'row' }, h('button', { class: 'small-btn confirm-btn', onclick: kit.confirmMany(open_, g) }, `Confirm all ${open_.length}`)), table(kit.cols_, open_));
        });
    }
    if (c.stripeCheck?.state === 'mismatch') {
      add('Stripe payouts don’t match Cass', 1, `Difference ${money(c.stripeCheck.diff, { dash: false })} — explain it or find the payout`, () => openAccount('stripe', m), 'warn',
        (close) => h('div', { class: 'row' }, h('span', { class: 'small' }, `Stripe CSV payouts ${money(c.stripeCheck.csv, { dash: false })}, Stripe transfers into Cass ${money(c.stripeCheck.cass, { dash: false })}.`), h('span', { class: 'spacer' }),
          h('button', { class: 'small-btn confirm-btn', onclick: async () => {
            const note = (await askValue('Explain the difference', `${stripeFlagText(c.stripeCheck)} What explains it?`, { ok: 'Mark explained' }))?.trim();
            if (note) decide(m, (r) => { r.stripeCheck = { diff: c.stripeCheck.diff, note, by: user, at: nowIso() }; }, `Explained Stripe payout difference ${money(c.stripeCheck.diff, { dash: false })}: ${note}`, again, close);
          } }, 'Explain…')));
    }
    if (wiseOutgoingCheck(saved).some((x) => x.state === 'missing')) add('Money out of Wise with no deposit found', 1, 'Sent to one of our accounts, not found on the other side', () => openAccount('wise', m));
    for (const s_ of BANK_SOURCES) {
      const l = line(c, s_.id);
      if (!l || (!l.rev && !l.int)) continue;
      const st = confirmationState(saved.bank?.[s_.id], l.values);
      if (st !== 'confirmed') add(`${s_.label}: figures to confirm`, 1, st === 'stale' ? 'Changed since it was confirmed' : [l.rev ? `Revenue ${money(l.rev, { dash: false })}` : '', l.int ? `interest ${money(l.int, { dash: false })}` : ''].filter(Boolean).join(', '), () => openAccount(s_.id, m), 'info',
        (close) => h('div', {},
          h('div', { class: 'recon' },
            l.rev != null ? rowKV('Revenue', money(l.rev, { dash: false })) : null,
            l.int != null ? rowKV(s_.method === 'balance' ? 'Gain / interest' : 'Interest', money(l.int, { dash: false })) : null,
            l.ending != null ? rowKV('Ending balance', money(l.ending, { dash: false })) : null,
            rowKV('From', `${sourceOf(l)}${l.enteredBy ? ` · ${l.enteredBy}${l.enteredAt ? `, ${when(l.enteredAt)}` : ''}` : ''}`),
            st === 'stale' && saved.bank?.[s_.id]?.confirmation ? rowKV('Confirmed before', `${saved.bank[s_.id].confirmation.by} · ${when(saved.bank[s_.id].confirmation.at)} — the figures have changed since`) : null),
          h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '.4rem' } },
            h('button', { class: 'small-btn confirm-btn', title: l.enteredBy && l.enteredBy === user ? 'You entered this — ideally someone else confirms it.' : '',
              onclick: () => decide(m, (r) => { r.bank ||= {}; confirmValues(r.bank[s_.id] ||= {}, user, l.values); }, `Confirmed ${s_.label}: revenue ${money(l.rev, { dash: false })}, interest ${money(l.int, { dash: false })}`, again, close) }, 'Confirm figures'))));
    }
    const so = saved.signoff;
    const snap = { diffRev: c.diffRev, diffInt: c.diffInt };
    const mark = (k, close) => decide(m, (r) => { r.signoff = { ...(r.signoff || {}), [k]: { by: user, at: nowIso(), ...snap } }; if (k === 'prepared') delete r.signoff.reviewed; },
      `Marked ${k}: revenue difference ${money(snap.diffRev, { dash: false })}, interest difference ${money(snap.diffInt, { dash: false })}`, again, close);
    if (!so?.prepared) add('Not marked prepared', 1, '', () => openMonth(m), 'info',
      (close) => h('div', { class: 'row' }, h('span', { class: 'small' }, `Revenue difference ${money(c.diffRev, { dash: false })}, interest difference ${money(c.diffInt, { dash: false })}.`), h('span', { class: 'spacer' }), h('button', { class: 'small-btn confirm-btn', onclick: () => mark('prepared', close) }, 'Mark prepared')));
    else if (!so?.reviewed) add('Prepared, not reviewed', 1, `Prepared by ${so.prepared.by}`, () => openMonth(m), 'info',
      (close) => h('div', { class: 'row' }, h('span', { class: 'small' }, `Prepared by ${so.prepared.by} · ${when(so.prepared.at)}.`), h('span', { class: 'spacer' }), h('button', { class: 'small-btn confirm-btn', title: so.prepared.by === user ? 'You prepared this — ideally someone else reviews it.' : '', onclick: () => mark('reviewed', close) }, 'Mark reviewed')));
    return out;
  }
  function todoBadge(m) {
    const c = cols.find((x) => x.m === m)?.c;
    if (!c || !byMonth[m]) return null;
    const items = monthTodo(m);
    const warn = items.filter((x) => x.kind === 'warn').length;
    return h('button', { class: `todo-badge${items.length ? '' : ' done'}`, title: items.map((x) => `${x.what} (${x.n})`).join('\n') || 'Nothing left to decide',
      onclick: (e) => { e.stopPropagation(); openTodo(m); } }, items.length ? `${items.length} to do${warn ? ' ⚠' : ''}` : '0 to do ✓');
  }
  async function openTodo(m) {
    const c = cols.find((x) => x.m === m)?.c;
    await panel(`To do — ${monthName(m)}`, (body, close) => {
      const items = monthTodo(m);
      mount(body,
        c ? h('div', { class: 'review-bar' },
          items.length ? statusPill(`${items.length} to do`, items.some((x) => x.kind === 'warn') ? 'warn' : 'info') : statusPill('0 to do — everything is decided', 'good'),
          h('span', { class: 'muted small' }, `Revenue difference ${money(c.diffRev, { dash: false })} · interest difference ${money(c.diffInt, { dash: false })}`)) : null,
        h('p', { class: 'muted small' }, `Everything still open for ${monthName(m)}, most important first. Open one to decide it here — the same Confirm and Change… as in its own pop-up; once decided it drops off this list and lives in its row on the sheet, where it can still be changed. GL-only lines of ${money(GL_ONLY_LIMIT(), { dash: false })} or more come first in their group: confirm them against a document, not just the GL.`),
        items.map((x) => h('details', { class: 'todo-item', 'data-key': x.what },
          h('summary', {}, h('span', { class: 'todo-title' }, x.what), ' ', statusPill(String(x.n), x.kind),
            x.detail ? h('div', { class: 'small muted wrap todo-detail' }, x.detail) : null),
          h('div', { class: 'todo-body' },
            x.inline ? x.inline(close) : null,
            h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '.4rem' } }, h('button', { class: 'small-btn', onclick: () => { close(true); x.go(); } }, 'Open the full pop-up →'))))));
    }, { wide: true });
  }

  // ---- Payer names: which names on a statement and in the GL are the same payer --------------
  async function openAliases() {
    await panel('Payer names', (body, close) => {
      const list = aliasList(cfg.aliases);
      const f = { bank: h('input', { type: 'text', size: 30, placeholder: 'On the statement, e.g. BBGF, AMER ONLINE GIV' }), gl: h('input', { type: 'text', size: 30, placeholder: 'In the GL, e.g. Your Cause' }) };
      const save = (aliases, what) => (async () => {
        try { cfg.aliases = aliases; await savePocConfig(cfg); toast(what); reopenAfter = { kind: 'aliases' }; carryScroll(topPanelScroll()); const opened = nextDialog(); await rerender(); await opened; close(true); }
        catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
      })();
      mount(body,
        h('p', { class: 'muted small' }, 'When a deposit is matched to a GL entry, the payer on the statement is compared with the payer on the GL line. Giving platforms often pay under another name — these count as the same payer. Words are matched anywhere in the description, ignoring case; separate several with commas.'),
        table([
          { label: 'Payer', cell: (a) => h('strong', {}, a.name) },
          { label: 'On the statement', cell: (a) => h('span', { class: 'small wrap' }, a.bank || '') },
          { label: 'In the GL', cell: (a) => h('span', { class: 'small wrap' }, a.gl || '') },
          { label: '', cell: (a) => (a.added ? actionsCell({ more: [h('button', { class: 'small-btn danger', onclick: () => save((cfg.aliases || []).filter((x) => !(x.bank === a.bank && x.gl === a.gl)), `Removed ${a.name}`) }, 'Remove')] }) : h('span', { class: 'small muted' }, 'Built in')) },
        ], list),
        h('h4', {}, 'Add a payer name'),
        h('div', { class: 'row inline-form' }, f.bank, f.gl, h('button', { class: 'primary', onclick: () => {
          const bank = f.bank.value.trim(), gl = f.gl.value.trim();
          if (!bank || !gl) { toast('Fill in both: how the statement says it, and how the GL says it.', 'error'); return; }
          save([...(cfg.aliases || []), { bank, gl, name: gl.split(',')[0].trim(), by: user, at: nowIso() }], `Added: ${bank} = ${gl}`);
        } }, 'Add')));
    }, { wide: true });
  }

  // Each GL register upload for the month against the one before, batch by batch.
  function glHistory(m) {
    const hist = glBy[m]?.history || [];
    if (!hist.length) return null;
    return h('details', { class: 'adj-section' }, h('summary', {}, h('strong', {}, `GL uploads (${hist.length})`), h('span', { class: 'muted small' }, ' — what each upload added, changed or removed')),
      table([
        { label: 'Uploaded', cell: (e) => h('div', {}, `${e.by || ''} · ${when(e.at)}`, h('div', { class: 'small muted break' }, `${e.file || ''}${e.runAt ? ` (run ${e.runAt})` : ''}`)) },
        { label: 'Batches', num: true, cell: (e) => e.batches ?? '' },
        { label: 'What changed', cell: (e) => (e.first ? h('span', { class: 'small muted' }, 'First upload with batch detail') : h('div', { class: 'small wrap' },
          !e.added?.length && !e.changed?.length && !e.removed?.length ? 'Nothing' : null,
          e.added?.length ? h('div', {}, `${e.added.length} new: ${e.added.slice(0, 8).join(', ')}${e.added.length > 8 ? '…' : ''}`) : null,
          e.changed?.length ? h('div', { class: 'warn-text' }, `${e.changed.length} changed: ${e.changed.map((x) => `${x.batch} ${x.desc} ${money(x.was, { dash: false })} → ${money(x.now, { dash: false })}`).join('; ')}`) : null,
          e.removed?.length ? h('div', { class: 'warn-text' }, `${e.removed.length} removed: ${e.removed.map((x) => `${x.batch} ${x.desc} ${money(x.total, { dash: false })}`).join('; ')}`) : null)) },
      ], [...hist].reverse()));
  }

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
          glHistory(m),
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

  const uploadGlRegister = (file) => uploadGl(file, { user, glBy, onSaved: (g) => { recentGl[g.month] = g; } });

  // ---- Export: Excel workbook, or print / save as PDF ---------------------------------------
  // The sheet as it stands (every adjustment line opened up), plus where each number came from.
  async function exportExcel() {
    const stamp = `Exported ${new Date().toLocaleString()}${user ? ` by ${user}` : ''} · figures as imported and entered in the Proof of Cash app`;
    const all = rows.flatMap((r) => (r.toggle ? [{ ...r, label: 'Total Adjustments (all accounts)' }, ...adjRows().map((a) => ({ ...a, label: `    ${a.label}` }))] : r.indent ? [] : [r]));
    const pct = (d, g) => (d == null || !g ? null : { v: Math.round((d / g) * 1e6) / 1e6, z: '0.00%' });
    const at = (f, c) => (f && c ? f(c) ?? null : null);
    const sheetRows = [
      [`FY${fy} Proof of Cash — October ${fy - 1} to September ${fy}`], [stamp], [`YTD = ${done.length ? `${range} (${done.length} months ended)` : 'no months ended yet'}`], [],
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

    // The audit trail: every adjustment line (deposits in transit included) with its permanent
    // ref, who, where it is on the statement and in the GL, and why (audit-trail.js). Refs are
    // saved on the month the first time a line is exported, so they never change.
    const glIndex = glBatchIndex(glBy);
    const adj = [['Ref', 'Period', 'Sheet row', 'What it is', 'Who', 'Amount', 'Evidence', 'Bank statement', 'GL batch', 'GL entry', 'Why']];
    const summary = [['Period', 'Sheet row', 'Kind of line', 'Lines', 'Amount', 'GL only', 'Sheet shows', 'Ties']];
    const checks = [['Month', 'Check', 'Result', 'Detail']];
    const trails = {};
    try {
      for (const { m, c, rec } of cols) {
        if (!c) continue;
        const rows_ = (r) => auditRows({ m, rec: r, c, glIndex, priorDeposits: depChecks[addMonths(m, -1)] || null, priorRec: byMonth[addMonths(m, -1)] || null, groupOf: adjGroup, lineOf: adjDetail, order: ADJ_GROUPS });
        const rs = rows_(rec || byMonth[m] || blank(m));
        if (!rs.length) continue;
        // A month with nothing saved yet (only its GL) has nowhere to keep refs: numbered for this
        // export only, and said so.
        if (!rec) { const tmp = {}; trails[m] = { rs, ...assignRefs(m, rs, tmp), unsaved: true }; continue; }
        for (let attempt = 0; ; attempt++) {
          const fresh = Object.assign(blank(m), structuredClone((await readMonth(m, { fresh: attempt > 0 })) || {}));
          fresh.refs = structuredClone(fresh.refs || {});
          const res = assignRefs(m, rs, fresh.refs);
          if (!res.changed) { trails[m] = { rs, ...res }; break; }
          try { await saveRec(fresh); trails[m] = { rs, ...res }; break; } catch (err) { if (!err?.conflict || attempt) throw err; }
        }
      }
    } catch (err) { toast(explain(err, 'Couldn’t save the reference numbers, so the export wasn’t made. Try again.'), 'error'); return; }
    for (const { m, c, rec } of cols) {
      if (!c) continue;
      const t = trails[m];
      if (t) {
        // The month as a real date shown "Feb 2026", so Excel's filter lists the months by year, in order.
        const period = { v: new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1, 12), z: 'mmm yyyy' };
        for (const r of t.rs) adj.push([r.ref, period, r.group, r.what, r.who, r.amount, r.evidence, r.bank, r.glBatch, r.gl, r.why]);
        const rowTotal = Object.fromEntries(ADJ_GROUPS.map((k) => [k, adjFor(k)(c)]));
        const sm = auditSummary(t.rs);
        for (const k of ADJ_GROUPS) {
          const xs = sm.filter((x) => x.group === k);
          if (!xs.length) continue;
          const tot = round2(sum(xs, (x) => x.total));
          xs.forEach((x, i) => summary.push([period, k, x.line, { v: x.count, z: '0' }, x.total, x.glOnly || null,
            i === xs.length - 1 ? rowTotal[k] : null, i === xs.length - 1 ? (Math.abs(tot - (rowTotal[k] || 0)) < 0.005 ? 'Yes' : `NO — lines ${money(tot, { dash: false })}`) : '']));
        }
        for (const s_ of t.retired) checks.push([monthName(m), 'Ref no longer an adjustment', s_.ref, `Was: ${s_.what}${s_.date ? ` ${s_.date}` : ''} ${money(s_.amount, { dash: false })}. Its number isn’t used again; the month’s activity log says what changed.`]);
        for (const r of t.amountChanged) checks.push([monthName(m), 'Ref amount changed', r.ref, `${r.what}: ${money(r.was, { dash: false })} when first numbered, now ${money(r.amount, { dash: false })}`]);
        if (t.unsaved) checks.push([monthName(m), 'Refs not saved', 'TEMPORARY', 'Nothing is saved for this month yet (only its GL is loaded), so its refs are for this export only.']);
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
        const open = dep.noGl.filter((x) => !x.covered && !x.decided);
        checks.push([monthName(m), 'Deposits vs GL', open.length ? `${open.length} NOT IN THE GL` : 'All matched',
          `${dep.lines.filter((x) => x.match).length} of ${dep.lines.length} matched; ${Object.keys(dep.exclusions).length} not revenue per the GL${open.length ? `; not in the GL: ${open.map((x) => `${x.line.date} ${x.line.desc} ${money(x.line.amount, { dash: false })}`).join(', ')}` : ''}`]);
      }
      if (dep?.lines?.some((x) => x.match)) {
        const lv = {}; for (const x of dep.lines) if (x.match) lv[x.match.confidence?.level || 'medium'] = (lv[x.match.confidence?.level || 'medium'] || 0) + 1;
        const low = matchesToCheck(c);
        checks.push([monthName(m), 'Match confidence', low.length ? `${low.length} TO CHECK` : 'OK',
          `${['confirmed', 'high', 'medium', 'low'].filter((k) => lv[k]).map((k) => `${lv[k]} ${k}`).join(', ')}${low.length ? `; to check: ${low.map((x) => `${x.line.date} ${x.line.desc} ${money(x.line.amount, { dash: false })} → ${x.match?.batch || x.pin?.batch} (${x.match ? x.match.confidence.minus.join('; ') : x.kind === 'gone' ? 'confirmed entry no longer in the GL' : 'confirmed entry taken'})`).join('; ')}` : ''}`]);
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
        { name: 'How to audit this', rows: readMeRows(stamp), cols: [30, 110] },
        { name: 'Adjustments summary', rows: summary, cols: [10, 28, 44, 7, 15, 14, 15, 18], freeze: { ySplit: 1 } },
        { name: 'Adjustments detail', rows: adj, cols: [15, 10, 26, 50, 32, 14, 22, 60, 12, 60, 60], freeze: { xSplit: 1, ySplit: 1 } },
        { name: 'Checks', rows: checks, cols: [14, 24, 28, 90] },
      ]);
    } catch (err) { toast(explain(err, 'Couldn’t build the Excel file.'), 'error'); }
  }

  // The export's first page for someone who hasn't seen the app: what each tab is and how to check
  // a line.
  function readMeRows(stamp) {
    const ev = (k) => [`  ${EVIDENCE[k].label}`, EVIDENCE[k].hint];
    return [
      [`FY${fy} Proof of Cash — how to audit this workbook`], [],
      ['What it is', 'Cash that reached the bank each month, adjusted for money that isn’t revenue and for timing, compared with revenue and interest in the GL (Acumatica). Every adjustment is listed line by line, each with a reference number.'],
      [],
      ['Tabs'],
      [`  FY${fy} Proof of Cash`, 'The sheet. The five adjustment rows (Transfers between our accounts · Wire sweeps · Deposits that aren’t revenue · Fees, refunds & reclasses · Timing) are opened up under Total Adjustments.'],
      ['  Adjustments summary', 'Each sheet row, month by month, broken into its kinds of line, and whether the lines add up to what the sheet shows. Start here to go from a number on the sheet to its lines: filter Adjustments detail by that Sheet row.'],
      ['  Adjustments detail', 'One row per item that moves — each sweep, transfer, refund, reclass and deposit in transit — with who it was, where it is on the bank statement and the GL batch that booked it.'],
      ['  Checks', 'Controls run each month: Stripe payouts vs Cass, deposits vs GL, match confidence, GL-only items, deposits in transit, and refs that changed.'],
      [],
      ['Reference numbers', 'A-YYYY-MM-NNN. A line gets its number the first time it is exported and keeps it, so a ref from an older export still means the same line. A line added later gets the next free number, so numbers within a sheet row aren’t always in order. A number is never reused: if a line stops being an adjustment, the Checks tab says so.'],
      ['Period', 'The month the adjustment belongs to, on every row of Adjustments summary and Adjustments detail — filter on it to see one month or several. Each line’s own date is in its Bank statement or GL entry.'],
      ['Signs', 'Amounts are as they affect bank revenue: negative is taken out (not revenue, or not this month’s), positive is added.'],
      [],
      ['Evidence — what backs each line'],
      ev('statement'), ev('both'), ev('glWhat'), ev('gl'), ev('typed'),
      [],
      ['To verify a line', '1. Find it by Ref on Adjustments detail. 2. Bank statement names the file (the PDFs or CSVs sent with this workbook), the section, and the date, amount and wording to look for. 3. In Acumatica, open the GL batch and check it books the GL entry shown. 4. For a transfer, Why names the other side — find it on that account’s statement. 5. GL-only and typed lines have no bank document: ask for the support behind the GL batch or the note.'],
      [],
      [stamp],
    ];
  }

  // Print (or "Save as PDF" in the print dialog): revenue and interest stacked, one per page width.
  function printPdf() {
    document.body.classList.add('printing');
    const done_ = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', done_); };
    window.addEventListener('afterprint', done_);
    setTimeout(() => window.print(), 50);
  }

  // Export: the sheet as Excel, or printed / saved as PDF.
  function openExport() {
    return panel('Export', (body, close) => mount(body,
      h('p', { class: 'muted small' }, `FY${fy} proof of cash.`),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => { close(true); exportExcel(); }, title: 'The sheet, adjustment detail, sources and checks, for an auditor' }, 'Excel workbook'),
        h('button', { onclick: () => { close(true); printPdf(); }, title: 'Print, or choose “Save as PDF” in the print dialog' }, 'Print / PDF'))));
  }

  // Download for Acumatica: pick the month, see which of its JEs can be made, download them.
  // Starts on the latest month with anything attached (up to this month).
  const hasAttachments = (m) => {
    const r = byMonth[m];
    return !!(r && (r.stripe || Object.keys(r.bankStatements || {}).length || Object.keys(r.statements || {}).length
      || r.bank?.tschetter?.ending != null || r.bank?.delap?.ending != null)) || cds.some((c) => c.earned?.[m]);
  };
  function openJeExport(start = null) {
    const now = currentMonth();
    const m = start || [...months].reverse().find((x) => x <= now && hasAttachments(x)) || months.filter((x) => x < now).pop() || months[0];
    return panel('Download for Acumatica', (body, close) => {
      const rec = byMonth[m] || blank(m);
      const again = async () => { close(true); await openJeExport(m); };
      const jes = monthJes(rec, jeCtx(again));
      const short = jes.filter((je) => !jeReady(je));
      mount(body,
        h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Period'),
          h('select', { onchange: (e) => { close(true); openJeExport(e.target.value); } },
            months.map((x) => h('option', { value: x, selected: x === m }, `${monthName(x)}${hasAttachments(x) ? '' : ' (nothing attached)'}`))))),
        short.length ? h('div', { class: 'notice warn' },
          h('strong', {}, short.length === jes.length ? `None of ${monthName(m)}’s journal entries can be made yet.` : `${short.length} of ${jes.length} journal entries for ${monthName(m)} can’t be made yet. The download has only the ready ones.`),
          h('ul', {}, short.map((je) => h('li', {}, `Batch ${je.batch}, ${je.label}: ${je.missing || je.problems[0] || (je.lines.length ? 'doesn’t balance' : 'nothing to book this month')}`))),
          h('button', { class: 'small-btn', onclick: () => { close(true); openMonth(m); } }, `Open ${monthName(m)} to attach them →`)) : h('div', { class: 'notice' }, `All ${jes.length} journal entries for ${monthName(m)} are ready.`),
        monthJeBlock(rec, jeCtx(again)));
    }, { wide: true });
  }

  const remember = () => {
    scrollMemory[fy] = { y: window.scrollY, x: [...main.querySelectorAll('.screen-only .sheet')].map((el) => el.scrollLeft) };
    keepScroll();
  };

  mount(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `FY${fy} Proof of Cash`),
        h('p', { class: 'muted' }, `October ${fy - 1} – September ${fy}. Drop a statement on an account’s cell to attach it (the number updates in place); click a cell to see its detail or type figures; click a month to open all of it. `,
          'Dots: green reviewed, blue prepared, amber in progress, grey from the workbook. ✓ confirmed, ! changed since confirmed.')),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: openExport, title: 'The sheet as an Excel workbook, or printed / saved as PDF' }, 'Export'),
        h('button', { class: 'btn', onclick: () => openJeExport(), title: 'A month’s journal entries, in one file for Acumatica’s import' }, 'Download for Acumatica'),
        fileButton('Upload GL register…', '.xlsx,.xls', async (file) => { if (await uploadGlRegister(file)) rerender(); }),
        h('button', { class: 'btn', onclick: openAliases, title: 'The names the app treats as the same payer on a statement and in the GL' }, 'Payer names'))),
    h('div', { class: 'row tabs' },
      years.map((y) => h('button', { class: y === fy ? 'tab active' : 'tab', onclick: () => pickFy(y), title: `October ${y - 1} – September ${y}` }, `FY${y}`, h('span', { class: 'tab-sub' }, ` Oct ${String(y - 1).slice(2)}–Sep ${String(y).slice(2)}`))),
      h('button', { class: 'tab add', onclick: addYear }, '+ Add fiscal year'),
      h('span', { class: 'spacer' }),
      h('div', { class: 'seg' }, [['stacked', 'Revenue above interest'], ['side', 'Side by side (workbook)']].map(([v, l]) =>
        h('button', { class: v === show ? 'active' : '', onclick: () => { store.set(SHOW_KEY, v); rerender(); } }, l)))),
    h('div', { class: 'screen-only' },
      ytdBar([['Revenue', ytd((c) => c.diffRev), ytd((c) => c.glRev)], ['Interest', ytd((c) => c.diffInt), ytd((c) => c.glInt)]]),
      show === 'side' ? sheet(true, true) : [sheet(true, false, 'Revenue'), sheet(false, true, 'Interest')]),
    h('div', { class: 'screen-only' }, sfSection()),
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
    if (r.kind === 'adjustments') openAdjustments(r.key, r.m);
    else if (r.kind === 'dit') openDit(r.m);
    else if (r.kind === 'account') openAccount(r.id, r.m);
    else if (r.kind === 'month') openMonth(r.m);
    else if (r.kind === 'gl') openGl(r.m);
    else if (r.kind === 'todo') openTodo(r.m);
    else if (r.kind === 'aliases') openAliases();
    else if (r.kind === 'sf') openSfMonth(r.m);
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
  (rec.bankFiles?.[id] || []).forEach((f, i) => out.push({ label: f.scanned ? 'Scanned statement' : 'Screenshot', s: f, evidence: true, detach: () => { rec.bankFiles[id].splice(i, 1); } }));
  return out;
}

function rowKV(k, v) {
  return h('div', { class: 'recon-row' }, h('span', {}, k), h('span', { class: 'num' }, v));
}

function field(labelText, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, labelText), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}
