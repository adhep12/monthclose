import { h, mount, table, toast, statusPill, select, ask, notify, dropTarget } from '../ui.js';
import { loadPocMonth, savePocMonth, loadGlActivity, loadTrialBalance, loadPocConfig, loadCds, saveCd, loadConfig, loadSoa } from '../data.js';
import { computePoc, glFigures, BANK_SOURCES, ADJUSTMENT_TYPES, reviewableDeposits, exclusionInfo, balanceMethodInterest, defaultExclusions } from '../poc/calc.js';
import { attachFiles } from '../poc/attach.js';
import { stripeCheckBox } from './stripe-check.js';
import { monthSummary } from '../cd/schedule.js';
import { ACCEPT } from '../ingest.js';
import { balanceAtEndOf } from '../tb.js';
import { money, parseAmount, round2 } from '../money.js';
import { addMonths } from '../fiscal.js';
import { explain, fileUrl } from '../store.js';
import { stampEntered, confirmValues, confirmationState, logChange, stampBadge, when, nowIso } from '../audit.js';

const KIND_LABEL = { operating: 'Operating …5884', incoming: 'Incoming Wires …5892', outgoing: 'Outgoing Wires …3410' };
const uid = () => Math.random().toString(36).slice(2, 9);
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(2)}%`);
const fmtV = (v) => (v == null ? '—' : money(v, { dash: false }));

function blank(month) {
  return { month, bank: {}, statements: {}, bankStatements: {}, excluded: {}, adjustments: [], dit: [], timing: {}, gl: {}, notes: '', log: [], autoConfirm: {} };
}

export default async function (main, { month, monthName, user, rerender }) {
  const prevMonth = addMonths(month, -1);
  const [loaded, prior, glAct, tbThis, tbNext, cfg, faCfg, cds, soa] = await Promise.all([
    loadPocMonth(month), loadPocMonth(prevMonth), loadGlActivity(month), loadTrialBalance(month),
    loadTrialBalance(addMonths(month, 1)), loadPocConfig(), loadConfig(), loadCds(), loadSoa(month)]);
  const DRAFT = `monthclose:poc-draft:${month}`;
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(DRAFT) || 'null'); } catch { /* ignore */ }
  const rec = Object.assign(blank(month), structuredClone(draft || loaded || {}));
  // Show automatic findings (transfers, tax refunds) as set, whatever order the statements came in.
  rec.excluded = { ...defaultExclusions(rec), ...(rec.excluded || {}) };
  const gl = glFigures({ glActivity: glAct, tb: tbThis, soa, month, config: cfg });
  const names = faCfg.accountNames || {};

  // GL cash balances at month end: next month's TB (beginning) or this month's (ending).
  const balTb = tbNext || tbThis;
  const glBalances = balTb ? Object.fromEntries(BANK_SOURCES.map((s) => [s.gl, balanceAtEndOf(balTb, s.gl, month)])) : null;

  function cdSummary() {
    const s = monthSummary(cds, month);
    const stamps = cds.map((c) => c.earned?.[month]).filter(Boolean).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    return { ...s, hasData: cds.some((c) => c.earned?.[month]), by: stamps[0]?.by || 'CD schedule', at: stamps[0]?.at };
  }
  const calc = () => computePoc(rec, { prior, gl, cd: cdSummary(), glBalances });

  // ---- Saving: debounced, logged, with a browser copy until the save lands ------------------
  const saveState = h('span', { class: 'muted small' }, loaded ? `Saved · ${when(loaded.updatedAt)}` : 'Not saved yet');
  const pendingLog = new Map();
  let timer = null;
  const fmt = (v) => (typeof v === 'number' ? money(v, { dash: false }) : v == null || v === '' ? '(blank)' : String(v));
  function track(key, label, from, to) {
    const p = pendingLog.get(key);
    pendingLog.set(key, { label, from: p ? p.from : from, to });
  }
  function changed({ now = false } = {}) {
    try { localStorage.setItem(DRAFT, JSON.stringify(rec)); } catch { /* ignore */ }
    saveState.textContent = 'Unsaved changes…';
    refresh();
    clearTimeout(timer);
    timer = setTimeout(save, now ? 0 : 900);
  }
  async function save() {
    for (const { label, from, to } of pendingLog.values()) {
      if (String(from ?? '') !== String(to ?? '')) logChange(rec, user, `${label}: ${fmt(from)} → ${fmt(to)}`);
    }
    pendingLog.clear();
    saveState.textContent = 'Saving…';
    try {
      rec.updatedBy = user; rec.updatedAt = nowIso();
      await savePocMonth(rec);
      try { localStorage.removeItem(DRAFT); } catch { /* ignore */ }
      saveState.textContent = `Saved · ${when(rec.updatedAt)}`;
      drawLog();
    } catch (err) {
      saveState.textContent = 'Not saved';
      toast(explain(err, 'Couldn’t save — your changes are kept in this browser.'), 'error');
    }
  }

  const numInput = (get, set, props = {}) => h('input', {
    type: 'text', inputmode: 'decimal', class: 'num', size: 13, value: get() == null ? '' : String(get()), ...props,
    oninput: (e) => { const t = e.target.value.trim(); const n = parseAmount(t); set(t === '' ? null : Number.isFinite(n) ? n : get()); changed(); },
  });
  const textInput = (get, set, props = {}) => h('input', { type: 'text', value: get() || '', ...props, oninput: (e) => { set(e.target.value); changed(); } });

  // ---- Hosts -------------------------------------------------------------------------------
  const summaryHost = h('div');
  const uploadHost = h('div');
  const cardsHost = h('div', { class: 'cards wide' });
  const reviewHost = h('div');
  const autoAdjHost = h('div');
  const adjHost = h('div');
  const ditHost = h('div');
  const timingHost = h('div');
  const glHost = h('div');
  const logHost = h('div');
  const signHost = h('div');
  const ditTotals = h('span', { class: 'small' });
  const stripeHost = h('div');

  function refresh() {
    const c = calc();
    drawSummary(c); drawCards(c); drawAutoAdj(c); drawTiming(c); drawGl(c); drawSignoff(c);
  }

  function drawSummary(c) {
    const confirmable = c.lines.filter((l) => l.rev != null || l.int != null || l.ending != null);
    const confirmed = confirmable.filter((l) => confirmationState(rec.bank[l.id], l.values) === 'confirmed').length;
    const diffCell = (d, p) => (d == null ? h('span', { class: 'muted' }, 'needs GL') : h('span', { class: Math.abs(d) < 1 ? 'good-text' : '' }, money(d), p != null ? ` (${pct(p)})` : ''));
    mount(summaryHost, h('div', { class: 'cards wide' },
      h('div', { class: 'card' }, h('h3', {}, 'Revenue'),
        h('div', { class: 'recon' },
          row('Bank activity', money(c.bankRev)),
          row('Adjustments', money(c.adjTotal)),
          row('Change in deposits in transit', c.ditChange == null ? h('span', { class: 'muted' }, 'no prior month') : money(c.ditChange)),
          c.timing.restricted ? row('Change in restricted revenue', money(c.timing.restricted)) : null,
          c.timing.merchAR ? row('Merchandise AR', money(c.timing.merchAR)) : null,
          row('Bank revenue, adjusted', money(c.revAdjusted), 'total'),
          row(`GL revenue${c.glSource === 'typed' ? ' (typed)' : ''}`, c.glRev == null ? '—' : money(c.glRev)),
          row('Difference', diffCell(c.diffRev, c.pctRev), 'total'))),
      h('div', { class: 'card' }, h('h3', {}, 'Interest'),
        h('div', { class: 'recon' },
          row('Bank interest', money(c.bankInt)),
          row(`Plus accrued interest${c.timing.fromSchedule ? ' (CD schedule)' : ''}`, money(c.timing.accrued || 0)),
          row('Less prior period accrual realized', money(-(c.timing.realizedPrior || 0))),
          row('Interest, adjusted', money(c.intAdjusted), 'total'),
          row('GL interest', c.glInt == null ? '—' : money(c.glInt)),
          row('Difference', diffCell(c.diffInt, c.pctInt), 'total'))),
      h('div', { class: 'card' }, h('h3', {}, 'Accounts'),
        h('div', { class: 'recon' },
          row('Figures confirmed', `${confirmed} of ${confirmable.length}`),
          row('Accounts not entered', String(c.lines.length - confirmable.length)),
          row('Balances that don’t match the GL', String(c.lines.filter((l) => l.balanceDiff != null && Math.abs(l.balanceDiff) >= 0.01).length)),
          row('Trial balance used for GL balances', balTb ? balTb.period : h('span', { class: 'muted' }, 'none')),
          row('', saveState)))));
  }

  // ---- Uploads -----------------------------------------------------------------------------
  async function onFiles(files) {
    const { messages } = await attachFiles({ files, rec, cds, month, user, ask, saveCd });
    const bad = messages.filter((m) => m.bad);
    if (bad.length) notify('Please check', bad.map((m) => m.text));
    else if (messages.length) toast(messages.map((m) => m.text).join(' · '));
    drawUploads(); drawReview(); drawAdj(); changed({ now: true });
  }

  function attachedList() {
    const out = [];
    for (const [k, s] of Object.entries(rec.statements)) out.push({ label: `Cass ${KIND_LABEL[k]}`, s, ok: s.check.creditsOk && s.check.debitsOk && s.check.balanceOk, detach: () => { delete rec.statements[k]; } });
    if (rec.stripe) out.push({ label: 'Stripe', s: rec.stripe, ok: true, detach: () => { delete rec.stripe; } });
    if (rec.ics) out.push({ label: 'ICS', s: rec.ics, ok: rec.ics.ties !== false, detach: () => { delete rec.ics; } });
    for (const [k, s] of Object.entries(rec.bankStatements)) out.push({ label: BANK_SOURCES.find((x) => x.id === k)?.label || k, s, ok: s.ties !== false, detach: () => { delete rec.bankStatements[k]; } });
    return out;
  }

  function drawUploads() {
    const input = h('input', { type: 'file', accept: ACCEPT, multiple: true, class: 'visually-hidden', onchange: (e) => { const f = [...e.target.files]; e.target.value = ''; onFiles(f); } });
    const list = attachedList();
    mount(uploadHost,
      dropTarget(h('label', { class: 'drop-zone' }, h('strong', {}, 'Drop statements here'), h('span', { class: 'drop-hint' }, ' or click to choose — Cass (Operating, Incoming, Outgoing), Stripe CSV, ICS, CDARS, Wise, PayPal, KeyBank, any number at once'), input), onFiles),
      list.length ? table([
        { label: 'Statement', cell: (x) => x.label },
        { label: 'File', cell: (x) => h('span', { class: 'break' }, x.s.fileName || '') },
        { label: 'Attached', cell: (x) => `${x.s.attachedBy || ''} · ${when(x.s.attachedAt)}` },
        { label: 'Reads cleanly', cell: (x) => (x.ok ? statusPill('Ties to its own totals', 'good') : statusPill('Doesn’t tie — check', 'bad')) },
        { label: '', cell: (x) => h('div', { class: 'row' },
          x.s.fileKey ? h('button', { class: 'small-btn', onclick: async () => { const u = await fileUrl('statements', x.s.fileKey).catch(() => null); if (u) window.open(u, '_blank', 'noopener'); else toast('Couldn’t open the stored file.', 'error'); } }, 'View') : null,
          h('button', { class: 'small-btn danger', onclick: async () => { if (!(await ask('Detach statement', `Detach ${x.label} (${x.s.fileName || ''})? Its figures come out of this month.`, { ok: 'Detach', danger: true }))) return; x.detach(); logChange(rec, user, `Detached ${x.label} statement ${x.s.fileName || ''}`); drawUploads(); drawReview(); changed({ now: true }); } }, 'Detach')) },
      ], list) : null);
  }

  // ---- Account cards -----------------------------------------------------------------------
  function drawCards(c) {
    const active = document.activeElement;
    const focusKey = active && cardsHost.contains(active) ? active.dataset.k : null;
    const caret = focusKey ? active.selectionStart : null;
    mount(cardsHost, c.lines.map((l) => card(l)));
    if (focusKey) {
      const el = cardsHost.querySelector(`[data-k="${focusKey}"]`);
      if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch { /* ignore */ } }
    }
  }

  function card(l) {
    const b = rec.bank[l.id] || (rec.bank[l.id] = {});
    const src = BANK_SOURCES.find((x) => x.id === l.id);
    const balanceMethod = src.method === 'balance';
    const autoFrom = l.from && l.from !== 'typed' && !balanceMethod;
    const state = confirmationState(b, l.values);
    const setTyped = (k, label) => (v) => { track(`${l.id}.${k}`, `${l.label} ${label}`, b[k], v); b[k] = v; stampEntered(b, user); };
    const inp = (k, label) => numInput(() => b[k], setTyped(k, label), { 'data-k': `${l.id}.${k}` });
    const fig = (label, k) => [h('span', {}, label), h('span', { class: 'num' }, autoFrom && l[k] != null ? fmtV(l[k]) : inp(k, label.toLowerCase()))];
    const priorB = prior?.bank?.[l.id];

    const body = balanceMethod
      ? h('div', { class: 'figs' },
        h('span', {}, 'Ending value'), h('span', { class: 'num' }, inp('ending', 'ending value')),
        h('span', {}, `${monthName(prevMonth, { short: true })} ending value`), h('span', { class: 'num' }, priorB?.ending != null && b.priorEnding == null ? fmtV(priorB.ending) : inp('priorEnding', 'prior month ending')),
        h('span', { title: 'Money put in is positive, money taken out is negative. Left blank for Delap, Fidelity MoneyLine transfers into Cass are used.' }, 'Net deposits (withdrawals)'), h('span', { class: 'num' }, inp('netDeposits', 'net deposits')),
        h('span', { title: 'Management fees deducted from the account. The GL books them as an expense and grosses up the gain, so they’re added back.' }, 'Fees taken out'), h('span', { class: 'num' }, inp('fees', 'fees')),
        h('span', {}, h('strong', {}, 'Gain / interest')), h('span', { class: 'num' }, h('strong', {}, fmtV(l.int ?? balanceMethodInterest(b, priorB)))),
        h('span', {}, 'Revenue'), h('span', { class: 'num' }, inp('rev', 'revenue')))
      : h('div', { class: 'figs' }, fig('Revenue', 'rev'), fig('Interest', 'int'), fig('Ending balance', 'ending'));
    const glRev = src.revenueGl && gl ? gl.revenue[src.revenueGl] : null;
    const adjs = rec.adjustments.filter((a) => a.account === l.id);
    const pill = state === 'confirmed' ? statusPill('Confirmed', 'good') : state === 'stale' ? statusPill('Changed since confirmed', 'warn')
      : l.rev != null || l.int != null || l.ending != null ? statusPill('To confirm', 'info') : statusPill('Not entered', 'neutral');
    return h('div', { class: `card acct-card ${state}` },
      h('div', { class: 'row' }, h('h3', {}, l.label), h('span', { class: 'muted small' }, `GL ${src.gl}`), h('span', { class: 'spacer' }), pill),
      h('div', { class: 'muted small' }, autoFrom ? `From ${l.from}` : balanceMethod ? 'Typed — gain is the change in value' : l.from === 'typed' ? 'Typed' : src.hint ? `Attach: ${src.hint}, or type` : 'Attach the statement, or type'),
      body,
      h('div', { class: 'figs small' },
        h('span', {}, `GL ${src.gl} at month end`), h('span', { class: 'num' }, l.glBalance == null ? h('span', { class: 'muted' }, balTb ? '—' : 'needs trial balance') : fmtV(l.glBalance)),
        h('span', {}, 'Balance vs GL'), h('span', { class: 'num' }, l.balanceDiff == null ? '—' : h('span', { class: Math.abs(l.balanceDiff) < 0.01 ? 'good-text' : 'error' }, money(l.balanceDiff, { dash: false }))),
        glRev != null ? [h('span', {}, `Revenue vs GL ${src.revenueGl}`), h('span', { class: 'num' }, l.rev == null ? '—' : money(round2(l.rev - glRev), { dash: false }))] : null),
      adjs.length ? h('div', { class: 'small' }, h('strong', {}, 'Adjustments: '), adjs.map((a) => `${a.label} ${money(a.amount)}`).join(' · ')) : null,
      textInput(() => b.note, (v) => { track(`${l.id}.note`, `${l.label} note`, b.note, v); b.note = v; }, { placeholder: 'Note', 'data-k': `${l.id}.note` }),
      stampBadge({ enteredBy: l.enteredBy, enteredAt: l.enteredAt, obj: b, values: l.values, user,
        onConfirm: () => { confirmValues(b, user, l.values); logChange(rec, user, `Confirmed ${l.label}: revenue ${fmt(l.rev)}, interest ${fmt(l.int)}, ending ${fmt(l.ending)}`); changed({ now: true }); },
        onUnconfirm: () => { delete b.confirmation; logChange(rec, user, `Removed confirmation on ${l.label}`); changed({ now: true }); } }));
  }

  // ---- Deposits to review -----------------------------------------------------------------
  function drawReview() {
    const deps = reviewableDeposits(rec);
    if (!deps.length) { mount(reviewHost); return; }
    const flagged = deps.filter((t) => t.id in rec.excluded || /REFUND|TAX|RETURN|REVERSAL|IRS|TRANSFER|TRNSFR|BIBLE ?PROJECT/i.test(`${t.desc} ${t.detail || ''}`));
    const setKind = (t, v) => {
      const had = exclusionInfo(rec.excluded[t.id]);
      if (v === 'revenue') { delete rec.excluded[t.id]; if (had?.auto) rec.dismissed = { ...(rec.dismissed || {}), [t.id]: true }; }
      else rec.excluded[t.id] = { type: v, note: had?.note || '' };
      logChange(rec, user, `${t.date} ${t.desc} ${money(t.amount)}: ${v === 'revenue' ? 'counted as revenue' : v === 'transfer' ? 'marked as a transfer between accounts' : 'marked as not revenue'}`);
      drawReview(); changed();
    };
    const tableFor = (list) => table([
      { label: 'Treat as', cell: (t) => select([['revenue', 'Revenue'], ['transfer', 'Transfer between accounts'], ['not-revenue', 'Not revenue (refund etc.)']],
        exclusionInfo(rec.excluded[t.id])?.type || 'revenue', { onchange: (e) => setKind(t, e.target.value) }) },
      { label: 'Account', cell: (t) => (t.kind === 'incoming' ? 'Cass Incoming' : t.kind === 'wise' ? 'Wise' : 'Cass Operating') },
      { label: 'Date', cell: (t) => t.date },
      { label: 'Description', cell: (t) => h('span', { title: t.detail || '' }, t.desc) },
      { label: 'Amount', num: true, cell: (t) => money(t.amount) },
      { label: 'Note', cell: (t) => (t.id in rec.excluded ? textInput(() => exclusionInfo(rec.excluded[t.id]).note, (v) => { rec.excluded[t.id] = { ...exclusionInfo(rec.excluded[t.id]), note: v }; }, { placeholder: 'Why', size: 30 }) : '') },
    ], list, { empty: 'Nothing flagged.' });
    mount(reviewHost, h('h2', {}, 'Deposits to review'),
      h('p', { class: 'muted' }, 'Everything deposited counts as revenue unless it’s marked here. Money moving between our own accounts is found automatically (same amount leaving another account within 5 days) and taken out as a transfer; tax refunds are taken out as not revenue. Change any of them.'),
      tableFor(flagged), h('details', {}, h('summary', {}, `All ${deps.length} deposits`), tableFor(deps)));
  }

  // ---- Adjustments -------------------------------------------------------------------------
  function drawAutoAdj(c) {
    const auto = c.adjustments.filter((a) => a.auto);
    stripeHost.replaceChildren(stripeCheckBox(c.stripeCheck, { rec, user, onChange: () => changed({ now: true }) }));
    const stmt = rec.statements.operating || rec.statements.incoming || rec.statements.outgoing;
    mount(autoAdjHost, auto.length ? table([
      { label: 'From the Cass statements', cell: (a) => h('div', {}, a.label, a.why ? h('div', { class: 'muted small wrap' }, a.why) : null,
        a.detail?.length ? h('details', { class: 'small' }, h('summary', {}, `${a.detail.length} item${a.detail.length === 1 ? '' : 's'}`),
          h('ul', {}, a.detail.map((d) => h('li', {}, `${d.date} ${d.desc} ${money(d.amount)}`)))) : null) },
      { label: 'Amount', num: true, cell: (a) => money(a.amount) },
      { label: 'Entered / confirmed', cell: (a) => {
        const o = rec.autoConfirm[a.id] || (rec.autoConfirm[a.id] = {});
        return stampBadge({ enteredBy: stmt?.attachedBy, enteredAt: stmt?.attachedAt, obj: o, values: { amount: a.amount }, user,
          onConfirm: () => { confirmValues(o, user, { amount: a.amount }); logChange(rec, user, `Confirmed ${a.label} ${money(a.amount)}`); changed({ now: true }); } });
      } },
    ], auto) : h('p', { class: 'muted' }, 'Attach the Cass statements to calculate Stripe transfers and wire sweep adjustments.'));
  }

  function drawAdj() {
    const accountOpts = BANK_SOURCES.map((s) => [s.id, s.label]);
    mount(adjHost,
      table([
        { label: 'Account', cell: (a) => select(accountOpts, a.account || 'cassOp', { onchange: (e) => { track(`adj.${a.id}.account`, `Adjustment “${a.label}” account`, a.account, e.target.value); a.account = e.target.value; stampEntered(a, user); changed(); } }) },
        { label: 'Type', cell: (a) => select(Object.entries(ADJUSTMENT_TYPES), a.type || 'other', { onchange: (e) => { track(`adj.${a.id}.type`, `Adjustment “${a.label}” type`, a.type, e.target.value); a.type = e.target.value; changed(); } }) },
        { label: 'Date', cell: (a) => h('input', { type: 'date', value: a.date || '', onchange: (e) => { track(`adj.${a.id}.date`, `Adjustment “${a.label}” date`, a.date, e.target.value); a.date = e.target.value; changed(); } }) },
        { label: 'What', cell: (a) => textInput(() => a.label, (v) => { track(`adj.${a.id}.label`, 'Adjustment name', a.label, v); a.label = v; }, { size: 28 }) },
        { label: 'Amount', num: true, cell: (a) => numInput(() => a.amount, (v) => { track(`adj.${a.id}.amount`, `Adjustment “${a.label}”`, a.amount, v); a.amount = v ?? 0; stampEntered(a, user); }) },
        { label: 'Note', cell: (a) => textInput(() => a.note, (v) => { a.note = v; }, { size: 20 }) },
        { label: 'Entered / confirmed', cell: (a) => stampBadge({ enteredBy: a.enteredBy, enteredAt: a.enteredAt, obj: a, values: { amount: a.amount, account: a.account }, user,
          onConfirm: () => { confirmValues(a, user, { amount: a.amount, account: a.account }); logChange(rec, user, `Confirmed adjustment “${a.label}” ${money(a.amount)}`); drawAdj(); changed({ now: true }); } }) },
        { label: '', cell: (a) => h('button', { class: 'small-btn danger', onclick: async () => { if (!(await ask('Remove adjustment', `Remove “${a.label}” (${money(a.amount)})?`, { ok: 'Remove', danger: true }))) return; rec.adjustments = rec.adjustments.filter((x) => x !== a); logChange(rec, user, `Removed adjustment “${a.label}” ${money(a.amount)}`); drawAdj(); changed({ now: true }); } }, 'Remove') },
      ], rec.adjustments, { empty: 'No other adjustments.' }),
      h('div', { class: 'row', style: { marginTop: '.5rem' } },
        h('button', { onclick: () => {
          rec.adjustments.push(stampEntered({ id: uid(), account: 'cassOp', type: 'transfer', date: '', label: 'New adjustment', amount: 0, note: '' }, user));
          logChange(rec, user, 'Added an adjustment'); drawAdj(); changed();
        } }, 'Add adjustment'),
        h('span', { class: 'muted small' }, 'Transfers, timing, refunds… Enter the amount as it affects bank revenue: money that isn’t revenue is negative.')));
  }

  // ---- Deposits in transit and timing ------------------------------------------------------
  function drawDit() {
    mount(ditHost,
      table([
        { label: 'Date', cell: (d) => h('input', { type: 'date', value: d.date || '', onchange: (e) => { d.date = e.target.value; changed(); } }) },
        { label: 'Check deposit in transit', cell: (d) => textInput(() => d.note, (v) => { d.note = v; }, { size: 30, placeholder: 'Donor / reference' }) },
        { label: 'Amount', num: true, cell: (d) => numInput(() => d.amount, (v) => { track(`dit.${d.id}`, `Deposit in transit ${d.note || ''}`, d.amount, v); d.amount = v ?? 0; stampEntered(d, user); }) },
        { label: 'Entered / confirmed', cell: (d) => stampBadge({ enteredBy: d.enteredBy, enteredAt: d.enteredAt, obj: d, values: { amount: d.amount }, user,
          onConfirm: () => { confirmValues(d, user, { amount: d.amount }); logChange(rec, user, `Confirmed deposit in transit ${d.note || ''} ${money(d.amount)}`); drawDit(); changed({ now: true }); } }) },
        { label: '', cell: (d) => h('button', { class: 'small-btn danger', onclick: () => { rec.dit = rec.dit.filter((x) => x !== d); logChange(rec, user, `Removed deposit in transit ${d.note || ''} ${money(d.amount)}`); drawDit(); changed({ now: true }); } }, 'Remove') },
      ], rec.dit, { empty: 'No deposits in transit entered.' }),
      h('div', { class: 'row', style: { marginTop: '.5rem' } },
        h('button', { onclick: () => { rec.dit.push(stampEntered({ id: uid(), date: '', amount: 0, note: '' }, user)); logChange(rec, user, 'Added a deposit in transit'); drawDit(); changed(); } }, 'Add deposit in transit'),
        ditTotals));
    refresh();
  }

  function drawTiming(c) {
    ditTotals.textContent = `This month ${money(c.ditTotal, { dash: false })} · ${monthName(prevMonth)} ${c.priorDit == null ? 'not entered' : money(c.priorDit, { dash: false })} · change ${c.ditChange == null ? '—' : money(c.ditChange, { dash: false })}`;
    const mode = c.timing.fromSchedule ? 'schedule' : 'typed';
    if (timingHost.dataset.mode === mode) return; // inputs already built — don't steal focus
    timingHost.dataset.mode = mode;
    const t = rec.timing;
    mount(timingHost, h('div', { class: 'form-grid', style: { marginTop: '1rem' } },
      c.timing.fromSchedule
        ? [h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Plus accrued interest'), h('span', {}, money(c.timing.accrued), ' ', h('a', { href: '#/cds' }, statusPill('CD schedule', 'info')))),
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Less prior period accrual realized'), h('span', {}, money(c.timing.realizedPrior), ' ', h('a', { href: '#/cds' }, statusPill('CD schedule', 'info'))))]
        : [h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Plus accrued interest'), numInput(() => t.accrued, (v) => { track('t.accrued', 'Accrued interest', t.accrued, v); t.accrued = v; })),
          h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Less prior period accrual realized'), numInput(() => t.realizedPrior, (v) => { track('t.realized', 'Realized accrual', t.realizedPrior, v); t.realizedPrior = v; }))],
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Change in restricted revenue'), numInput(() => t.restricted, (v) => { track('t.restricted', 'Change in restricted revenue', t.restricted, v); t.restricted = v; })),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Merchandise AR'), numInput(() => t.merchAR, (v) => { track('t.merch', 'Merchandise AR', t.merchAR, v); t.merchAR = v; }))));
  }

  // ---- GL (statement of activities lines) --------------------------------------------------
  function glNote() {
    const t = rec.gl || {};
    const differs = gl && t.typedAt && ((t.revenue != null && round2(t.revenue - gl.revenueTotal) !== 0) || (t.interest != null && round2(t.interest - gl.interestTotal) !== 0));
    return h('div', { 'data-role': 'gl-note' }, differs ? h('div', { class: 'notice warn' }, `The typed GL figures differ from Acumatica now (revenue ${money(gl.revenueTotal)}, interest ${money(gl.interestTotal)}) — something was posted after they were entered. Clear them to use Acumatica’s.`) : null);
  }
  function drawGl() {
    if (glHost.childElementCount) { glHost.querySelector('[data-role=gl-note]')?.replaceWith(glNote()); return; }
    const t = rec.gl || (rec.gl = {});
    mount(glHost,
      gl ? h('div', {}, h('p', {}, `From ${gl.source}.`),
        table([
          { label: 'Statement of activities line', cell: (r) => `${r[0]} · ${names[r[0]] || ''}` },
          { label: 'Credit less debit', num: true, cell: (r) => money(r[1]) },
        ], [...Object.entries(gl.revenue), ...Object.entries(gl.interest)].filter((r) => r[1]),
        { foot: (col) => (col.label === 'Credit less debit' ? `${money(gl.revenueTotal)} revenue · ${money(gl.interestTotal)} interest` : '') }))
        : h('div', { class: 'notice warn' }, `No GL activity for ${monthName(month)} yet. `, h('a', { href: '#/tb' }, 'Upload the GL register'), ' (or type the totals below).'),
      soa ? soaCheck() : h('p', { class: 'muted small' }, 'Upload this month’s Statement of Activities on the Acumatica uploads page to check these against the report.'),
      glNote(),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Revenue (override)'), numInput(() => t.revenue, (v) => { track('gl.rev', 'GL revenue override', t.revenue, v); t.revenue = v; t.typedAt = nowIso(); t.typedBy = user; })),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Interest (override)'), numInput(() => t.interest, (v) => { track('gl.int', 'GL interest override', t.interest, v); t.interest = v; t.typedAt = nowIso(); t.typedBy = user; })),
        h('button', { onclick: () => { rec.gl = {}; logChange(rec, user, 'Cleared GL overrides'); mount(glHost); changed({ now: true }); } }, 'Clear overrides')));
  }

  // The report is in whole dollars, so anything under a dollar is rounding.
  function soaCheck() {
    const rows = [
      ['Revenue', soa.revenueTotal, gl?.soaOnly ? null : gl?.revenueTotal],
      ['Net interest', soa.interestTotal, gl?.soaOnly ? null : gl?.interestTotal],
    ];
    return h('div', {}, h('h3', {}, `Statement of activities — ${soa.fileName || ''}`),
      table([
        { label: '', cell: (r) => r[0] },
        { label: 'Report', num: true, cell: (r) => money(r[1]) },
        { label: 'GL register', num: true, cell: (r) => (r[2] == null ? '—' : money(r[2])) },
        { label: 'Difference', num: true, cell: (r) => (r[2] == null ? '—' : Math.abs(r[2] - r[1]) < 1 ? h('span', { class: 'good-text' }, 'rounding only') : h('span', { class: 'error' }, money(round2(r[2] - r[1])))) },
      ], rows),
      h('details', { class: 'small' }, h('summary', {}, 'Report lines'),
        table([{ label: 'Line', cell: (l) => l.line }, { label: 'This month', num: true, cell: (l) => money(l.ptd) }, { label: 'Year to date', num: true, cell: (l) => money(l.ytd) }], soa.lines.filter((l) => l.ptd || l.ytd))));
  }

  // ---- Sign-off and activity log -----------------------------------------------------------
  function drawSignoff(c) {
    const snap = { diffRev: c.diffRev, diffInt: c.diffInt };
    const same = (s) => s && s.diffRev === snap.diffRev && s.diffInt === snap.diffInt;
    const p = rec.signoff?.prepared, r = rec.signoff?.reviewed;
    const mark = (k) => {
      rec.signoff = { ...(rec.signoff || {}), [k]: { by: user, at: nowIso(), ...snap } };
      if (k === 'prepared') delete rec.signoff.reviewed;
      logChange(rec, user, `Marked ${k}: revenue difference ${fmt(snap.diffRev)}, interest difference ${fmt(snap.diffInt)}`);
      changed({ now: true });
    };
    mount(signHost, h('div', { class: 'row' },
      p ? h('span', {}, statusPill(same(p) ? 'Prepared' : 'Prepared — numbers changed since', same(p) ? 'info' : 'warn'), ` ${p.by} · ${when(p.at)} · difference then ${fmt(p.diffRev)}`)
        : h('button', { onclick: () => mark('prepared') }, 'Mark prepared'),
      p && !r ? h('button', { class: 'primary', onclick: () => mark('reviewed'), title: p.by === user ? 'You prepared this — ideally someone else reviews it.' : '' }, 'Mark reviewed') : null,
      r ? h('span', {}, statusPill(same(r) ? 'Reviewed' : 'Reviewed — numbers changed since', same(r) ? 'good' : 'warn'), ` ${r.by} · ${when(r.at)}`) : null,
      p && !same(p) ? h('button', { onclick: () => mark('prepared') }, 'Re-mark prepared') : null,
      p ? h('button', { onclick: () => { delete rec.signoff; logChange(rec, user, 'Reopened the month'); changed({ now: true }); } }, 'Reopen') : null));
  }

  function drawLog() {
    const entries = [...(rec.log || [])].reverse();
    mount(logHost, entries.length
      ? h('ul', { class: 'log' }, entries.map((e) => h('li', {}, h('span', { class: 'muted' }, `${when(e.at)} · ${e.by} — `), e.what)))
      : h('p', { class: 'muted' }, 'Nothing yet.'));
  }

  mount(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `Proof of cash — ${monthName(month)}`),
        h('p', { class: 'muted' }, 'Each bank account’s statement against Acumatica: who entered each figure, who confirmed it, and every adjustment in between.')),
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/poc' }, '← Back to the fiscal year'))),
    draft ? h('div', { class: 'notice warn' }, 'Restored changes that hadn’t saved yet. They’ll save now. ',
      h('button', { onclick: () => { try { localStorage.removeItem(DRAFT); } catch { /* ignore */ } rerender(); } }, 'Discard them instead')) : null,
    summaryHost,
    h('h2', {}, 'Statements'), uploadHost,
    h('h2', {}, 'Accounts'), cardsHost,
    reviewHost,
    h('h2', {}, 'Adjustments'), stripeHost, autoAdjHost, h('h3', {}, 'Other adjustments'), adjHost,
    h('h2', {}, 'Timing'), ditHost, timingHost,
    h('h2', {}, 'GL (statement of activities)'), glHost,
    h('h2', {}, 'Notes'),
    h('textarea', { rows: 3, style: { width: '100%' }, oninput: (e) => { track('notes', 'Notes', rec.notes, e.target.value); rec.notes = e.target.value; changed(); } }, rec.notes || ''),
    h('h2', {}, 'Sign-off'), signHost,
    h('h2', {}, 'Activity'), logHost,
  );
  drawUploads(); drawReview(); drawAdj(); drawDit(); drawLog();
  if (draft) changed({ now: true });
}

function row(label, value, cls = '') {
  return h('div', { class: `recon-row ${cls}` }, h('span', {}, label), h('span', { class: 'num' }, value));
}
