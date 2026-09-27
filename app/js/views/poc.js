import { h, mount, table, toast, statusPill } from '../ui.js';
import { loadPocMonth, savePocMonth, loadGlActivity, loadTrialBalance, loadPocConfig } from '../data.js';
import { computePoc, glFigures, BANK_SOURCES, excludableCredits, defaultExclusions } from '../poc/calc.js';
import { parseCassStatement, looksLikeCass } from '../poc/cass.js';
import { pdfLines } from '../pdf-text.js';
import { money, parseAmount, round2 } from '../money.js';
import { addMonths } from '../fiscal.js';
import { explain, uploadFile, fileUrl, filesAvailable } from '../store.js';

const PRESETS = ['Wise transfers', 'Wise revenue recognized in prior month', 'PayPal transfers',
  'Cass Money Market / ICS transfer', 'Cass CD transfer', 'Cass Fidelity investment transfer',
  'Cass Operating net activity', 'Operating account — reimbursements', 'Operating account — CC rewards for prior month',
  'Operating account — returned wires'];

const KIND_LABEL = { operating: 'Operating …5884', incoming: 'Incoming Wires …5892', outgoing: 'Outgoing Wires …3410' };

function blank(month) {
  return { month, bank: {}, statements: {}, excluded: {}, adjustments: [], dit: [], timing: {}, gl: {}, notes: '' };
}

const uid = () => Math.random().toString(36).slice(2, 9);
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(2)}%`);

export default async function (main, { month, monthName, user, rerender }) {
  const prevMonth = addMonths(month, -1);
  const [loaded, prior, glAct, tb, cfg] = await Promise.all([
    loadPocMonth(month), loadPocMonth(prevMonth), loadGlActivity(month), loadTrialBalance(month), loadPocConfig()]);
  const DRAFT = `monthclose:poc-draft:${month}`;
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(DRAFT) || 'null'); } catch { /* ignore */ }
  const rec = Object.assign(blank(month), structuredClone(draft || loaded || {}));
  const gl = glFigures({ glActivity: glAct, tb, month, config: cfg });

  // ---- Saving: debounced, with a browser copy as a net until the save lands ---------------
  const saveState = h('span', { class: 'muted small' }, loaded ? 'Saved' : 'Not saved yet');
  let timer = null;
  function changed({ now = false } = {}) {
    try { localStorage.setItem(DRAFT, JSON.stringify(rec)); } catch { /* ignore */ }
    saveState.textContent = 'Unsaved changes…';
    refresh();
    clearTimeout(timer);
    timer = setTimeout(save, now ? 0 : 900);
  }
  async function save() {
    saveState.textContent = 'Saving…';
    try {
      rec.updatedBy = user; rec.updatedAt = new Date().toISOString();
      await savePocMonth(rec);
      try { localStorage.removeItem(DRAFT); } catch { /* ignore */ }
      saveState.textContent = `Saved ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } catch (err) {
      saveState.textContent = 'Not saved';
      toast(explain(err, 'Couldn’t save — your changes are kept in this browser.'), 'error');
    }
  }

  const numInput = (get, set, props = {}) => h('input', {
    type: 'text', inputmode: 'decimal', class: 'num', size: 14, value: get() == null ? '' : String(get()), ...props,
    oninput: (e) => { const n = parseAmount(e.target.value); set(e.target.value.trim() === '' ? null : Number.isFinite(n) ? n : get()); changed(); },
  });
  const textInput = (get, set, props = {}) => h('input', { type: 'text', value: get() || '', ...props, oninput: (e) => { set(e.target.value); changed(); } });

  // ---- Sections -----------------------------------------------------------------------------
  const summaryHost = h('div');
  const stmtHost = h('div');
  const reviewHost = h('div');
  const bankTotals = h('tfoot');
  const autoAdjHost = h('div');
  const manualAdjHost = h('div');
  const ditHost = h('div');
  const glHost = h('div');
  const bankHost = h('div');
  const drawBank = () => mount(bankHost, bankTable());

  function refresh() {
    const c = computePoc(rec, { prior, gl });
    drawSummary(c);
    drawAutoAdj(c);
    drawBankTotals(c);
    drawDitTotals(c);
    drawGl(c);
  }

  function drawSummary(c) {
    const diffCell = (d, p) => (d == null ? h('span', { class: 'muted' }, 'needs GL') : h('span', { class: Math.abs(d) < 1 ? 'good-text' : '' }, money(d), p != null ? ` (${pct(p)})` : ''));
    mount(summaryHost, h('div', { class: 'cards wide' },
      h('div', { class: 'card' },
        h('h3', {}, 'Revenue'),
        h('div', { class: 'recon' },
          row('Bank activity', money(c.bankRev)),
          row('Adjustments', money(c.adjTotal)),
          row('Change in deposits in transit', c.ditChange == null ? h('span', { class: 'muted', title: `No ${monthName(prevMonth)} proof of cash to compare with` }, 'no prior month') : money(c.ditChange)),
          c.timing.restricted ? row('Change in restricted revenue', money(c.timing.restricted)) : null,
          c.timing.merchAR ? row('Merchandise AR', money(c.timing.merchAR)) : null,
          row('Bank revenue, adjusted', money(c.revAdjusted), 'total'),
          row(`GL revenue${c.glSource ? ` (${c.glSource === 'typed' ? 'typed' : 'from Acumatica'})` : ''}`, c.glRev == null ? '—' : money(c.glRev)),
          row('Difference', diffCell(c.diffRev, c.pctRev), 'total'))),
      h('div', { class: 'card' },
        h('h3', {}, 'Interest'),
        h('div', { class: 'recon' },
          row('Bank interest', money(c.bankInt)),
          row('Plus accrued interest', money(c.timing.accrued || 0)),
          row('Less prior period accrual realized', money(-(c.timing.realizedPrior || 0))),
          row('Interest, adjusted', money(c.intAdjusted), 'total'),
          row('GL interest', c.glInt == null ? '—' : money(c.glInt)),
          row('Difference', diffCell(c.diffInt, c.pctInt), 'total')))));
  }

  // Statements ------------------------------------------------------------------------------
  async function onFiles(fileList) {
    for (const file of fileList) {
      try {
        const lines = await pdfLines(await file.arrayBuffer());
        if (!looksLikeCass(lines)) { toast(`${file.name} isn’t a Cass statement I can read.`, 'error'); continue; }
        const s = parseCassStatement(lines);
        if (s.month !== month && !confirm(`${file.name} is the ${monthName(s.month)} statement, but you’re closing ${monthName(month)}. Attach it anyway?`)) continue;
        let fileKey = null;
        if (filesAvailable()) {
          try { fileKey = (await uploadFile('statements', file))?.key || null; }
          catch (err) { toast(explain(err, `Couldn’t store ${file.name}; its numbers are still used.`), 'error'); }
        }
        rec.statements[s.kind] = { ...s, fileName: file.name, fileKey, attachedBy: user, attachedAt: new Date().toISOString() };
        for (const [id, note] of Object.entries(defaultExclusions({ [s.kind]: s }))) if (!(id in rec.excluded)) rec.excluded[id] = note;
        // Imported workbook lines that the statement now calculates would double count.
        const dup = /stripe transfers|wire sweep/i;
        const before = rec.adjustments.length;
        rec.adjustments = rec.adjustments.filter((a) => !(a.note === 'From the workbook' && dup.test(a.label)));
        if (rec.adjustments.length < before) toast('Removed the workbook’s Stripe / wire sweep lines — the statements calculate those now.');
        if (!s.check.creditsOk || !s.check.debitsOk) toast(`${file.name}: the transactions I read don’t add up to the statement’s totals. Check before relying on it.`, 'error');
      } catch (err) {
        console.error(err);
        toast(`${file.name}: ${err.message}`, 'error');
      }
    }
    drawStatements(); drawReview(); drawManualAdj(); drawBank(); changed({ now: true });
  }

  function drawStatements() {
    const input = h('input', { type: 'file', accept: '.pdf,application/pdf', multiple: true, class: 'visually-hidden',
      onchange: (e) => { const f = [...e.target.files]; e.target.value = ''; onFiles(f); } });
    const kinds = ['operating', 'incoming', 'outgoing'];
    mount(stmtHost,
      h('div', { class: 'cards' }, kinds.map((k) => {
        const s = rec.statements[k];
        if (!s) return h('div', { class: 'card dashed' }, h('h3', {}, KIND_LABEL[k]), h('p', { class: 'muted' }, 'Not attached.'));
        const ok = s.check.creditsOk && s.check.debitsOk && s.check.balanceOk;
        return h('div', { class: 'card' },
          h('div', { class: 'row' }, h('h3', {}, KIND_LABEL[k]), h('span', { class: 'spacer' }),
            ok ? statusPill('Ties to statement', 'good') : statusPill('Doesn’t tie', 'bad')),
          h('p', { class: 'small break' }, `${s.statementDate} · ${s.fileName || ''}`),
          h('p', { class: 'small' }, `${s.summary.credits.count} credits ${money(s.summary.credits.total)} · ${s.summary.debits.count} debits ${money(s.summary.debits.total)}`),
          ok ? null : h('p', { class: 'small error' }, `Read ${s.check.credits.count} credits ${money(s.check.credits.total)}, ${s.check.debits.count} debits ${money(s.check.debits.total)}.`),
          s.month !== month ? h('p', { class: 'small error' }, `This is the ${monthName(s.month)} statement.`) : null,
          h('div', { class: 'row' },
            s.fileKey ? h('button', { onclick: async () => { const u = await fileUrl('statements', s.fileKey).catch(() => null); if (u) window.open(u, '_blank', 'noopener'); else toast('Couldn’t open the stored PDF.', 'error'); } }, 'View PDF') : null,
            h('button', { class: 'danger', onclick: () => { if (!confirm('Detach this statement?')) return; delete rec.statements[k]; drawStatements(); drawReview(); drawBank(); changed({ now: true }); } }, 'Detach')));
      })),
      h('div', { class: 'row', style: { marginTop: '.75rem' } },
        h('label', { class: 'btn primary' }, 'Attach Cass statements (PDF)…', input),
        h('span', { class: 'muted small' }, 'Pick all three at once. They’re read in your browser; ',
          filesAvailable() ? 'the PDFs are kept with this month.' : 'the PDFs themselves aren’t stored in preview mode.')));
  }

  function drawReview() {
    const credits = excludableCredits(rec.statements);
    if (!credits.length) { mount(reviewHost); return; }
    const flagged = credits.filter((t) => t.id in rec.excluded || /REFUND|TAX|RETURN|REVERSAL|IRS/i.test(`${t.desc} ${t.detail || ''}`));
    const tableFor = (list) => table([
      { label: 'Not revenue', cell: (t) => h('input', { type: 'checkbox', checked: t.id in rec.excluded, 'aria-label': 'Not revenue',
        onchange: (e) => { if (e.target.checked) rec.excluded[t.id] = ''; else delete rec.excluded[t.id]; drawReview(); changed(); } }) },
      { label: 'Account', cell: (t) => (t.kind === 'incoming' ? 'Incoming' : 'Operating') },
      { label: 'Date', cell: (t) => t.date },
      { label: 'Description', cell: (t) => h('span', { title: t.detail || '' }, t.desc) },
      { label: 'Amount', num: true, cell: (t) => money(t.amount) },
      { label: 'Note', cell: (t) => (t.id in rec.excluded ? textInput(() => rec.excluded[t.id], (v) => { rec.excluded[t.id] = v; }, { placeholder: 'Why it isn’t revenue', size: 32 }) : '') },
    ], list, { empty: 'Nothing flagged.' });
    mount(reviewHost,
      h('h2', {}, 'Deposits to review'),
      h('p', { class: 'muted' }, 'Everything deposited to Operating and Incoming counts as revenue unless it’s marked here. Refunds and tax refunds are flagged; tax refunds are excluded automatically.'),
      tableFor(flagged),
      h('details', {}, h('summary', {}, `All ${credits.length} deposits`), tableFor(credits)));
  }

  // Bank lines ------------------------------------------------------------------------------
  function bankTable() {
    const b = (id) => (rec.bank[id] ||= {});
    return h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Account'), h('th', { class: 'num' }, 'Revenue'), h('th', { class: 'num' }, 'Interest'), h('th', {}, 'Note'))),
      h('tbody', {}, BANK_SOURCES.map((s) => h('tr', {},
        h('td', {}, s.label),
        h('td', { class: 'num' }, s.id === 'cassOp' && rec.statements.operating
          ? h('span', { title: 'Total credits on the Operating statement' }, money(rec.statements.operating.summary.credits.total), ' ', statusPill('statement', 'info'))
          : numInput(() => rec.bank[s.id]?.rev, (v) => { b(s.id).rev = v; })),
        h('td', { class: 'num' }, s.id === 'cassOp' ? '' : numInput(() => rec.bank[s.id]?.int, (v) => { b(s.id).int = v; })),
        h('td', {}, textInput(() => rec.bank[s.id]?.note, (v) => { b(s.id).note = v; }, { size: 28, placeholder: s.id === 'delap' || s.id === 'tschetter' ? 'e.g. ending less beginning value' : '' }))))),
      bankTotals));
  }
  function drawBankTotals(c) {
    mount(bankTotals, h('tr', {}, h('td', {}, 'Total'), h('td', { class: 'num' }, money(c.bankRev)), h('td', { class: 'num' }, money(c.bankInt)), h('td')));
  }

  // Adjustments -----------------------------------------------------------------------------
  function drawAutoAdj(c) {
    const auto = c.adjustments.filter((a) => a.auto);
    mount(autoAdjHost, auto.length ? table([
      { label: 'From the statements', cell: (a) => h('div', {}, a.label, a.why ? h('div', { class: 'muted small wrap' }, a.why) : null,
        a.detail?.length > 1 || (a.detail?.length && !a.id.startsWith('auto-ex')) ? h('details', { class: 'small' }, h('summary', {}, `${a.detail.length} item${a.detail.length === 1 ? '' : 's'}`),
          h('ul', {}, a.detail.map((d) => h('li', {}, `${d.date} ${d.desc} ${money(d.amount)}`)))) : null) },
      { label: 'Amount', num: true, cell: (a) => money(a.amount) },
    ], auto) : h('p', { class: 'muted' }, 'Attach statements to calculate the Stripe transfers and wire sweep adjustments.'));
  }

  function drawManualAdj() {
    const preset = h('select', {}, h('option', { value: '' }, 'Add an adjustment…'), PRESETS.map((p) => h('option', { value: p }, p)), h('option', { value: '__other' }, 'Other…'));
    preset.addEventListener('change', () => {
      if (!preset.value) return;
      const label = preset.value === '__other' ? (prompt('What is this adjustment?') || '').trim() : preset.value;
      if (label) { rec.adjustments.push({ id: uid(), label, amount: 0, note: '' }); drawManualAdj(); changed(); }
      preset.value = '';
    });
    mount(manualAdjHost,
      rec.adjustments.length ? table([
        { label: 'Adjustment', cell: (a) => textInput(() => a.label, (v) => { a.label = v; }, { size: 40 }) },
        { label: 'Amount', num: true, cell: (a) => numInput(() => a.amount, (v) => { a.amount = v ?? 0; }) },
        { label: 'Note', cell: (a) => textInput(() => a.note, (v) => { a.note = v; }, { size: 28 }) },
        { label: '', cell: (a) => h('button', { class: 'danger', onclick: () => { rec.adjustments = rec.adjustments.filter((x) => x !== a); drawManualAdj(); changed(); } }, 'Remove') },
      ], rec.adjustments) : null,
      h('div', { class: 'row', style: { marginTop: '.5rem' } }, preset,
        h('span', { class: 'muted small' }, 'Enter amounts as they affect bank revenue: money that isn’t revenue is negative.')));
  }

  // Deposits in transit ---------------------------------------------------------------------
  const ditTotals = h('p', { class: 'small' });
  function drawDit() {
    mount(ditHost,
      table([
        { label: 'Check deposit in transit', cell: (d) => textInput(() => d.note, (v) => { d.note = v; }, { size: 36, placeholder: 'Donor / reference' }) },
        { label: 'Amount', num: true, cell: (d) => numInput(() => d.amount, (v) => { d.amount = v ?? 0; }) },
        { label: '', cell: (d) => h('button', { class: 'danger', onclick: () => { rec.dit = rec.dit.filter((x) => x !== d); drawDit(); changed(); } }, 'Remove') },
      ], rec.dit, { empty: 'No deposits in transit entered.' }),
      h('div', { class: 'row', style: { marginTop: '.5rem' } },
        h('button', { onclick: () => { rec.dit.push({ id: uid(), amount: 0, note: '' }); drawDit(); changed(); } }, 'Add deposit in transit'),
        ditTotals));
    refresh();
  }
  function drawDitTotals(c) {
    ditTotals.textContent = `This month ${money(c.ditTotal, { dash: false })} · ${monthName(prevMonth)} ${c.priorDit == null ? 'not entered' : money(c.priorDit, { dash: false })} · change ${c.ditChange == null ? '—' : money(c.ditChange, { dash: false })}`;
  }

  // GL --------------------------------------------------------------------------------------
  function drawGl(c) {
    const t = rec.gl || (rec.gl = {});
    const typedDiffers = gl && ((t.revenue != null && round2(t.revenue - gl.revenueTotal) !== 0) || (t.interest != null && round2(t.interest - gl.interestTotal) !== 0));
    mount(glHost,
      gl ? h('div', {},
        h('p', {}, `From ${gl.source}: revenue ${money(gl.revenueTotal)}, interest ${money(gl.interestTotal)}.`),
        h('details', { class: 'small' }, h('summary', {}, 'By account'),
          table([{ label: 'Account', cell: (r) => r[0] }, { label: 'Credit less debit', num: true, cell: (r) => money(r[1]) }],
            [...Object.entries(gl.revenue), ...Object.entries(gl.interest)].filter((r) => r[1])))) : h('div', { class: 'notice warn' }, `No GL activity for ${monthName(month)} yet. `, h('a', { href: '#/tb' }, 'Upload the GL register'), ' (or type the totals below).'),
      typedDiffers ? h('div', { class: 'notice warn' }, `The typed GL figures differ from Acumatica now (revenue ${money(gl.revenueTotal)}, interest ${money(gl.interestTotal)}) — something was posted after they were entered. Clear them to use Acumatica’s.`) : null,
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Revenue (override)'), numInput(() => t.revenue, (v) => { t.revenue = v; }, { onchange: () => drawGl(computePoc(rec, { prior, gl })) })),
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Interest (override)'), numInput(() => t.interest, (v) => { t.interest = v; }, { onchange: () => drawGl(computePoc(rec, { prior, gl })) })),
        t.revenue != null || t.interest != null ? h('button', { onclick: () => { rec.gl = {}; changed({ now: true }); } }, 'Clear overrides') : null));
  }

  // Sign-off --------------------------------------------------------------------------------
  function signoff() {
    const box = h('div');
    const draw = () => mount(box, h('div', { class: 'row' },
      rec.preparedBy ? h('span', {}, statusPill('Prepared', 'info'), ` ${rec.preparedBy} · ${rec.preparedAt?.slice(0, 10)}`) : h('button', { onclick: () => { rec.preparedBy = user; rec.preparedAt = new Date().toISOString(); draw(); changed({ now: true }); } }, 'Mark prepared'),
      rec.preparedBy && !rec.reviewedBy ? h('button', { class: 'primary', onclick: () => { rec.reviewedBy = user; rec.reviewedAt = new Date().toISOString(); draw(); changed({ now: true }); } }, 'Mark reviewed') : null,
      rec.reviewedBy ? h('span', {}, statusPill('Reviewed', 'good'), ` ${rec.reviewedBy} · ${rec.reviewedAt?.slice(0, 10)}`) : null,
      rec.preparedBy ? h('button', { onclick: () => { delete rec.preparedBy; delete rec.preparedAt; delete rec.reviewedBy; delete rec.reviewedAt; draw(); changed({ now: true }); } }, 'Reopen') : null));
    draw();
    return box;
  }

  const t = rec.timing;
  mount(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `Proof of cash — ${monthName(month)}`),
        h('p', { class: 'muted' }, 'Cash into the banks, adjusted for money that isn’t revenue and for timing, against revenue in the GL. ', saveState)),
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/poc/ytd' }, 'Fiscal year view'), h('a', { class: 'btn', href: '#/poc/import' }, 'Import workbook'))),
    draft ? h('div', { class: 'notice warn' }, 'Restored changes that hadn’t saved yet. They’ll save now. ',
      h('button', { onclick: () => { try { localStorage.removeItem(DRAFT); } catch { /* ignore */ } rerender(); } }, 'Discard them instead')) : null,
    summaryHost,
    h('h2', {}, 'Cass statements'), stmtHost,
    reviewHost,
    h('h2', {}, 'Bank activity'),
    h('p', { class: 'muted' }, 'From each statement: revenue deposits and interest earned. Cass Operating fills in from its statement.'),
    bankHost,
    h('h2', {}, 'Adjustments'), autoAdjHost, h('h3', {}, 'Other adjustments'), manualAdjHost,
    h('h2', {}, 'Timing'),
    ditHost,
    h('div', { class: 'form-grid', style: { marginTop: '1rem' } },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Plus accrued interest'), numInput(() => t.accrued, (v) => { t.accrued = v; })),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Less prior period accrual realized'), numInput(() => t.realizedPrior, (v) => { t.realizedPrior = v; }), h('span', { class: 'field-hint' }, 'Enter as a positive number.')),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Change in restricted revenue'), numInput(() => t.restricted, (v) => { t.restricted = v; })),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Merchandise AR'), numInput(() => t.merchAR, (v) => { t.merchAR = v; }))),
    h('h2', {}, 'GL'), glHost,
    h('h2', {}, 'Notes'),
    h('textarea', { rows: 3, style: { width: '100%' }, oninput: (e) => { rec.notes = e.target.value; changed(); } }, rec.notes || ''),
    h('h2', {}, 'Sign-off'), signoff(),
  );
  drawStatements(); drawReview(); drawManualAdj(); drawBank(); drawDit();
  if (draft) changed({ now: true });
}

function row(label, value, cls = '') {
  return h('div', { class: `recon-row ${cls}` }, h('span', {}, label), h('span', { class: 'num' }, value));
}
