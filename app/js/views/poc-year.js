// Proof of cash for a fiscal year (October–September; FY2026 = October 2025 – September 2026),
// laid out like the "Proof of Cash - YYYY" workbook. This is where the work happens: click an
// account's cell for a month to attach its statement or type its figures; click Total
// Adjustments to open up what's being taken out; click GL to load Acumatica's numbers.

import { h, mount, toast, fileButton, ask, panel, table, notify, statusPill, dropTarget } from '../ui.js';
import { loadPocMonths, loadPocMonth, savePocMonth, listGlActivity, saveGlActivity, loadPocConfig, savePocConfig, loadCds, saveCd, deleteCd, listSoa, saveSoa } from '../data.js';
import { monthSummary, cdSourcesFor, detachCdarsStatement, detachExport } from '../cd/schedule.js';
import { computePoc, glFigures, BANK_SOURCES, balanceMethodInterest, ADJUSTMENT_TYPES } from '../poc/calc.js';
import { attachFiles, ACCOUNT_FILES } from '../poc/attach.js';
import { parseGlRegister, parseStatementOfActivities } from '../gl.js';
import { readWorkbook } from '../xlsx-io.js';
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
const TYPED_FIELDS = ['rev', 'int', 'ending', 'priorEnding', 'netDeposits'];
// Row order of the workbook's "Per Bank Statement" block.
const SHEET_ORDER = ['wise', 'paypal', 'stripe', 'keyOp', 'keyMM', 'ics', 'cd', 'delap', 'tschetter', 'cassOp'];
const label = (id) => BANK_SOURCES.find((s) => s.id === id)?.label || id;
const short = (m) => monthName(m, { short: true }).split(' ')[0];
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

// Adjustment detail rows, named the way the workbook names them, so imported months and months
// built from statements land on the same row.
export function adjKey(a) {
  if (a.id === 'auto-stripe') return 'Stripe Transfers';
  if (a.id === 'auto-incoming') return 'Incoming Wire Sweep Net activity';
  if (a.id === 'auto-outgoing') return 'Outgoing Wire Sweep Net activity';
  if (a.id?.startsWith('auto-tr-')) return 'Transfers between accounts';
  if (a.id?.startsWith('auto-ex-')) return 'Deposits that aren’t revenue';
  return a.label.trim().replace(/\s*-\s*plus \(minus\)?\s*$/i, '').replace(/^\((.*)\)$/, '$1').trim();
}

// Where the sheet was scrolled (sideways and down), per fiscal year. Kept for the whole visit so
// attaching a statement, or going to a month and back, returns you to the same spot.
const scrollMemory = {};

function blank(month) {
  return { month, bank: {}, statements: {}, bankStatements: {}, excluded: {}, adjustments: [], dit: [], timing: {}, gl: {}, notes: '', log: [], autoConfirm: {} };
}

export default async function (main, { user, rerender }) {
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
  const cols = months.map((m) => {
    const rec = byMonth[m];
    const gl = glFor(m);
    // A month with GL loaded but no proof of cash yet still shows its GL figures.
    if (!hasData(rec) && !gl) return { m, rec: null, c: null };
    const r = hasData(rec) ? rec : { ...blank(m), ...(rec || {}), source: undefined };
    return { m, rec: hasData(rec) ? rec : null, c: computePoc(r, { prior: byMonth[addMonths(m, -1)], gl, cd: cdFor(m) }) };
  });
  // YTD covers the months whose Cass Operating deposits are in — the main account, so a month
  // with only a stray figure or two entered doesn't pull its whole GL into the totals yet.
  const line = (c, id) => c.lines.find((l) => l.id === id);
  const done = cols.filter((x) => x.c && line(x.c, 'cassOp').rev != null);

  // ---- Rows ----------------------------------------------------------------------------------
  const bankRows = SHEET_ORDER.map((id) => {
    const mark = (k) => (c, rec) => {
      const l = line(c, id);
      if (id === 'stripe' && k === 'rev' && c.stripeCheck?.state === 'mismatch') return { mark: '⚠', title: stripeFlagText(c.stripeCheck) };
      if (l[k] == null) return null;
      const st = confirmationState(rec.bank?.[id], l.values);
      return { mark: st === 'confirmed' ? '✓' : st === 'stale' ? '!' : '', title: `${l.from === 'typed' ? 'Typed' : `From ${l.from || 'the workbook'}`}${st === 'confirmed' ? ` · confirmed by ${rec.bank[id].confirmation.by}` : st === 'stale' ? ' · changed since it was confirmed' : ' · not confirmed yet'}` };
    };
    return { label: label(id), account: id, rev: (c) => line(c, id).rev, int: (c) => line(c, id).int, meta: { rev: mark('rev'), int: mark('int') } };
  });
  const adjLabels = [];
  for (const { c } of cols.filter((x) => x.c)) for (const a of c.adjustments) { const k = adjKey(a); if (!adjLabels.includes(k)) adjLabels.push(k); }
  const adjFor = (k) => (c) => { const list = c.adjustments.filter((a) => adjKey(a) === k); return list.length ? round2(sum(list, (a) => a.amount)) : null; };

  const rows = [
    { section: 'Per Bank Statement' },
    ...bankRows,
    { label: `${adjOpen ? '▾' : '▸'} Cass Operating - Total Adjustments`, rev: (c) => c.adjTotal, toggle: true, hint: 'Click to open up what’s being adjusted',
      meta: { rev: (c) => (c.stripeCheck?.state === 'mismatch' ? { mark: '⚠', title: stripeFlagText(c.stripeCheck) } : null) } },
    ...(adjOpen ? adjLabels.map((k) => ({ label: k, rev: adjFor(k), indent: true, adjKey: k,
      meta: k === 'Stripe Transfers' ? { rev: (c) => (c.stripeCheck?.state === 'mismatch' ? { mark: '⚠', title: stripeFlagText(c.stripeCheck) } : c.stripeCheck?.state === 'match' ? { mark: '✓', title: 'Matches the Stripe CSV payouts' } : null) } : null })) : []),
    { label: 'Total Bank Revenue / Interest', rev: (c) => round2(c.bankRev + c.adjTotal), int: (c) => c.bankInt, strong: true },
    { section: 'Adjustments for Timing' },
    { label: 'Plus Deposit in Transit (change)', rev: (c) => c.ditChange, dit: true },
    { label: 'Plus Accrued Interest', int: (c) => c.timing.accrued || 0 },
    { label: 'Less realized accrued interest from prior period', int: (c) => -(c.timing.realizedPrior || 0) },
    { label: 'Change in Restricted Revenue', rev: (c) => c.timing.restricted || null },
    { label: 'Merchandise AR', rev: (c) => c.timing.merchAR || null },
    { label: 'Bank Revenue - Adjusted', rev: (c) => c.revAdjusted, int: (c) => c.intAdjusted, strong: true },
    { label: 'Total GL Revenue / Interest Income', rev: (c) => c.glRev, int: (c) => c.glInt, gl: true },
    { label: 'Difference', rev: (c) => c.diffRev, int: (c) => c.diffInt, strong: true, diff: true },
    { label: '% difference', pct: true },
  ];

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
    if (r.dit) return () => { location.hash = `#/poc/${m}`; };
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

  function sheet(showRev, showInt, title) {
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
              h('a', { href: `#/poc/${m}`, title: `Open ${monthName(m)} details` }, short(m)), ' ', statusOf(rec)))),
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

    await panel(`${label(id)} — ${monthName(m)}`, (body) => {
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
        const c = computePoc(rec, { prior, gl: glFor(m), cd: cdFor(m) });
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
                ? h('div', { class: 'form-grid' },
                  field('Ending value', inp('ending')),
                  field(`${monthName(addMonths(m, -1))} ending value`, prior?.bank?.[id]?.ending != null && b.priorEnding == null
                    ? h('span', {}, money(prior.bank[id].ending, { dash: false }), h('span', { class: 'muted small' }, ' (from last month)')) : inp('priorEnding')),
                  field('Net deposits (withdrawals)', inp('netDeposits'), 'Money put in is positive, taken out negative.'),
                  field('Revenue', inp('rev')),
                  h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Gain / interest'), h('strong', {}, money(balanceMethodInterest(b, prior?.bank?.[id]), { dash: false }))))
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

          id === 'cassOp' ? cassSummary(c, m) : null,
          id === 'cassOp' || id === 'stripe' ? stripeCheckBox(c.stripeCheck, { rec, user, onChange: async () => { try { await saveRec(rec); dirty = true; } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); } draw(); } }) : null,
          id === 'cd' ? h('p', { class: 'small' }, `CD schedule: ${money(cdFor(m).accrued)} earned in ${monthName(m)}, ${money(cdFor(m).realized)} paid at maturity. `, h('a', { href: '#/cds' }, 'Open the CD schedule')) : null,

          h('h3', {}, 'Confirmation'),
          stampBadge({ enteredBy: l.enteredBy, enteredAt: l.enteredAt, obj: b, values: l.values, user,
            onConfirm: async () => {
              confirmValues(b, user, l.values); logChange(rec, user, `Confirmed ${label(id)}: revenue ${money(l.rev, { dash: false })}, interest ${money(l.int, { dash: false })}`);
              try { await saveRec(rec); dirty = true; } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
              draw();
            },
            onUnconfirm: async () => { delete b.confirmation; logChange(rec, user, `Removed confirmation on ${label(id)}`); try { await saveRec(rec); dirty = true; } catch (err) { toast(explain(err), 'error'); } draw(); } }),
          h('p', { style: { marginTop: '1.25rem' } }, h('a', { href: `#/poc/${m}` }, `Open all of ${monthName(m)} →`)));
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

  function cassSummary(c, m) {
    const cassAdj = c.adjustments.filter((a) => a.account === 'cassOp' || a.auto);
    return h('div', {}, h('h3', {}, 'Taken out of Cass deposits'),
      cassAdj.length ? table([
        { label: 'What', cell: (a) => h('div', {}, adjKey(a), a.detail?.length ? h('div', { class: 'muted small wrap' }, a.detail.slice(0, 6).map((d) => `${d.date} ${d.desc} ${money(d.amount)}`).join(' · '), a.detail.length > 6 ? ` … +${a.detail.length - 6} more` : '') : null) },
        { label: 'Type', cell: (a) => ADJUSTMENT_TYPES[a.type] || '' },
        { label: 'Amount', num: true, cell: (a) => money(a.amount) },
      ], cassAdj) : h('p', { class: 'muted' }, 'Nothing yet — attach the Cass statements.'),
      h('p', { class: 'small' }, h('a', { href: `#/poc/${m}` }, 'Review every deposit (revenue / transfer / not revenue) on the month page →')));
  }

  // ---- Adjustment detail panel -------------------------------------------------------------
  async function openAdjustments(key, m) {
    const col = cols.find((x) => x.m === m);
    if (!col?.c) return;
    const list = col.c.adjustments.filter((a) => adjKey(a) === key);
    await panel(`${key} — ${monthName(m)}`, (body) => {
      // Detail lines carry the transaction's own (positive) amount; show them with the adjustment's sign.
      const items = list.flatMap((a) => (a.detail?.length ? a.detail.map((d) => ({ ...d, a, shown: (a.amount < 0 ? -1 : 1) * Math.abs(d.amount) })) : [{ date: a.date || '', desc: a.label, note: a.note, a, shown: a.amount }]));
      mount(body,
        h('p', { class: 'muted' }, list[0]?.why || 'Each item comes out of bank deposits because it isn’t revenue.'),
        table([
          { label: 'Account', cell: (x) => label(x.a.account || 'cassOp') },
          { label: 'Type', cell: (x) => ADJUSTMENT_TYPES[x.a.type] || (x.a.auto ? 'From the statements' : 'Entered') },
          { label: 'Date', cell: (x) => x.date || '' },
          { label: 'Description', cell: (x) => h('span', { class: 'wrap' }, x.desc) },
          { label: 'Amount', num: true, cell: (x) => money(x.shown) },
          { label: 'Note / who', cell: (x) => h('span', { class: 'small' }, [x.note || x.a.note, x.a.enteredBy ? `${x.a.enteredBy} · ${when(x.a.enteredAt)}` : ''].filter(Boolean).join(' · ')) },
        ], items, { foot: (c) => (c.label === 'Amount' ? money(round2(sum(list, (a) => a.amount))) : c.label === 'Account' ? 'Total' : '') }),
        h('p', { class: 'small' }, h('a', { href: `#/poc/${m}` }, `Change these on the ${monthName(m)} page →`)));
    }, { wide: true });
  }

  // ---- GL panel: statement of activities or GL register, or typed --------------------------
  async function openGl(m) {
    let dirty = false;
    await panel(`GL — ${monthName(m)}`, (body) => {
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

  const remember = () => {
    scrollMemory[fy] = { y: window.scrollY, x: [...main.querySelectorAll('.sheet')].map((el) => el.scrollLeft) };
  };

  mount(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `FY${fy} Proof of Cash`),
        h('p', { class: 'muted' }, `October ${fy - 1} – September ${fy}. Drop a statement on an account’s cell to attach it (the number updates in place); click a cell to see its detail or type figures; click a month to open all of it. `,
          'Dots: green reviewed, blue prepared, amber in progress, grey from the workbook. ✓ confirmed, ! changed since confirmed.')),
      h('div', { class: 'actions' },
        fileButton('Upload GL register…', '.xlsx,.xls', async (file) => { if (await uploadGlRegister(file)) rerender(); }),
        h('a', { class: 'btn', href: '#/poc/import' }, 'Import workbook'))),
    h('div', { class: 'row tabs' },
      years.map((y) => h('button', { class: y === fy ? 'tab active' : 'tab', onclick: () => pickFy(y), title: `October ${y - 1} – September ${y}` }, `FY${y}`, h('span', { class: 'tab-sub' }, ` Oct ${String(y - 1).slice(2)}–Sep ${String(y).slice(2)}`))),
      h('button', { class: 'tab add', onclick: addYear }, '+ Add fiscal year'),
      h('span', { class: 'spacer' }),
      h('div', { class: 'seg' }, [['stacked', 'Revenue above interest'], ['side', 'Side by side (workbook)']].map(([v, l]) =>
        h('button', { class: v === show ? 'active' : '', onclick: () => { store.set(SHOW_KEY, v); rerender(); } }, l)))),
    show === 'side' ? sheet(true, true) : [sheet(true, false, 'Revenue'), sheet(false, true, 'Interest')],
  );

  const saved = scrollMemory[fy];
  if (saved) {
    main.querySelectorAll('.sheet').forEach((el, i) => { el.scrollLeft = saved.x[i] ?? saved.x[0] ?? 0; });
    window.scrollTo(0, saved.y);
    requestAnimationFrame(() => window.scrollTo(0, saved.y));
  }
  // Keep the memory current as you scroll, and keep the two stacked sheets side-scrolled together.
  const sheets = [...main.querySelectorAll('.sheet')];
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
  if (b) out.push({ label: BANK_SOURCES.find((s) => s.id === id)?.label || id, s: b, ok: b.ties !== false, detach: () => { delete rec.bankStatements[id]; } });
  return out;
}

function rowKV(k, v) {
  return h('div', { class: 'recon-row' }, h('span', {}, k), h('span', { class: 'num' }, v));
}

function field(labelText, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, labelText), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}
