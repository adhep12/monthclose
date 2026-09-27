import { h, mount, field, select, table, toast, statusPill } from '../ui.js';
import { loadAssets, loadConfig, saveAsset, deleteAsset } from '../data.js';
import { schedule, METHODS, CONVENTIONS, lifeFromEndDate, disposalSummary, fullyDepreciatedMonth } from '../fa/engine.js';
import { buildDisposalJE, jeRows, isBalanced } from '../fa/je.js';
import { downloadWorkbook } from '../xlsx-io.js';
import { money, parseAmount, sum, round2 } from '../money.js';
import { fiscalYear, monthName, monthOfDate, addMonths, lastDayOfMonth } from '../fiscal.js';
import { explain } from '../store.js';
import { assetStatus } from './fa-register.js';

const DRAFT_KEY = 'monthclose:asset-draft';

function newId() {
  return `fa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export default async function (main, { params, month, user }) {
  const [assets, cfg] = await Promise.all([loadAssets(), loadConfig()]);
  const id = params[0];
  const existing = id ? assets.find((a) => a.id === id) : null;
  if (id && !existing) {
    mount(main, h('h1', {}, 'Asset not found'), h('p', {}, h('a', { href: '#/fa' }, 'Back to fixed assets')));
    return;
  }

  // Unsaved edits survive a sign-in reload.
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(`${DRAFT_KEY}:${id || 'new'}`) || 'null'); } catch { /* ignore */ }
  const a = structuredClone(draft || existing || {
    id: newId(), name: '', group: cfg.groups[0]?.asset || '', cost: 0, salvage: 0,
    inService: lastDayOfMonth(month), lifeMonths: 60, method: 'SL', convention: 'next-month',
    status: 'active', disposal: null, source: { kind: 'manual' },
  });
  const isNew = !existing;
  const stash = () => { try { localStorage.setItem(`${DRAFT_KEY}:${id || 'new'}`, JSON.stringify(a)); } catch { /* ignore */ } };
  const clearDraft = () => { try { localStorage.removeItem(`${DRAFT_KEY}:${id || 'new'}`); } catch { /* ignore */ } };

  const preview = h('div');
  const disposalHost = h('div');

  const bindText = (key, props = {}) => h('input', { type: 'text', value: a[key] ?? '', ...props,
    oninput: (e) => { a[key] = e.target.value; stash(); } });
  const bindNum = (key, props = {}) => h('input', { type: 'text', inputmode: 'decimal', class: 'num',
    value: a[key] != null ? String(a[key]) : '', ...props,
    oninput: (e) => { const n = parseAmount(e.target.value); a[key] = Number.isFinite(n) ? n : null; stash(); draw(); } });

  const lifeInput = h('input', { type: 'number', min: 1, step: 1, class: 'num', value: a.lifeMonths ?? '',
    oninput: (e) => { a.lifeMonths = Number(e.target.value) || null; stash(); draw(); } });
  const lifeYears = h('span', { class: 'field-hint' });
  const endDate = h('input', { type: 'date', title: 'Lease end date',
    onchange: (e) => {
      if (!e.target.value || !a.inService) return;
      a.lifeMonths = lifeFromEndDate(a.inService, e.target.value, a.convention);
      lifeInput.value = a.lifeMonths; stash(); draw();
    } });

  const methodSel = select(Object.entries(METHODS), a.method, { onchange: (e) => { a.method = e.target.value; stash(); drawFixed(); draw(); } });
  const convSel = select(Object.entries(CONVENTIONS), a.convention, { onchange: (e) => { a.convention = e.target.value; stash(); draw(); } });
  const groupSel = select(cfg.groups.map((g) => [g.asset, `${g.asset} · ${g.name}`]), a.group, { onchange: (e) => { a.group = e.target.value; stash(); } });
  const statusSel = select([['active', 'In service'], ['cip', 'Construction in progress (not depreciating)']], a.status || 'active',
    { onchange: (e) => { a.status = e.target.value; stash(); draw(); } });
  const inService = h('input', { type: 'date', value: a.inService || '', onchange: (e) => { a.inService = e.target.value; stash(); draw(); } });

  const fixedHost = h('div', { class: 'form-grid' });
  function drawFixed() {
    const show = a.method === 'FIXED' || a.openingAsOf;
    mount(fixedHost, show ? [
      a.method === 'FIXED' ? field('Monthly amount', bindNum('fixedMonthly'), 'Carried over from the old spreadsheet.') : null,
      field('Opening accumulated depreciation', bindNum('openingAD')),
      field('Opening balance as of (month end)', h('input', { type: 'month', value: a.openingAsOf || '',
        onchange: (e) => { a.openingAsOf = e.target.value || null; stash(); draw(); } })),
    ] : []);
  }

  function draw() {
    lifeYears.textContent = a.lifeMonths ? `${round2(a.lifeMonths / 12)} years` : '';
    const far = addMonths(monthOfDate(a.inService || lastDayOfMonth(month)), (a.lifeMonths || 0) + 2);
    const rows = a.inService ? schedule(a, far) : [];
    const byFy = [];
    for (const r of rows) {
      const fy = fiscalYear(r.month);
      let g = byFy.find((x) => x.fy === fy);
      if (!g) byFy.push(g = { fy, dep: 0, months: 0, end: r });
      g.dep += r.dep; g.months++; g.end = r;
    }
    const done = fullyDepreciatedMonth(a);
    mount(preview,
      h('h2', {}, 'Schedule'),
      h('div', { class: 'stats' },
        stat('First month', rows[0] ? monthName(rows[0].month, { short: true }) : '—'),
        stat('Monthly', rows[0] ? money(rows.length > 1 ? rows[1].dep : rows[0].dep) : '—'),
        stat('Fully depreciated', done ? monthName(done, { short: true }) : a.disposal ? 'Disposed first' : '—'),
        stat(`Status ${monthName(month, { short: true })}`, statusPill(...assetStatus(a, month)))),
      a.openingAsOf ? h('p', { class: 'muted small' }, `History before ${monthName(addMonths(a.openingAsOf, 1))} comes from the opening balance; the schedule shows months after it.`) : null,
      table([
        { label: 'Fiscal year', cell: (g) => `FY${g.fy}` },
        { label: 'Months', num: true, cell: (g) => g.months },
        { label: 'Depreciation', num: true, cell: (g) => money(g.dep) },
        { label: 'Accum. at year end', num: true, cell: (g) => money(g.end.accum) },
        { label: 'NBV at year end', num: true, cell: (g) => money(g.end.nbv) },
      ], byFy, { empty: 'Enter a cost, in-service date and life to see the schedule.' }),
      rows.length ? h('details', {}, h('summary', {}, `Month by month (${rows.length})`),
        table([
          { label: 'Month', cell: (r) => monthName(r.month, { short: true }) },
          { label: 'Depreciation', num: true, cell: (r) => money(r.dep) },
          { label: 'Accumulated', num: true, cell: (r) => money(r.accum) },
          { label: 'Net book value', num: true, cell: (r) => money(r.nbv) },
        ], rows, { foot: (c) => (c.label === 'Depreciation' ? money(sum(rows, (r) => r.dep)) : c.label === 'Month' ? 'Total' : '') })) : null,
    );
  }

  function validate() {
    const errs = [];
    if (!a.name?.trim()) errs.push('Give the asset a name.');
    if (!(a.cost > 0)) errs.push('Cost must be more than zero.');
    if (!a.inService) errs.push('Enter the in-service date.');
    if (!(a.lifeMonths > 0) && a.method !== 'FIXED') errs.push('Enter the useful life in months.');
    if ((a.salvage || 0) >= a.cost) errs.push('Salvage value must be less than cost.');
    if (!cfg.groups.some((g) => g.asset === a.group)) errs.push('Pick an asset account.');
    return errs;
  }

  async function save(btn) {
    const errs = validate();
    if (errs.length) { toast(errs.join(' '), 'error'); return; }
    btn.disabled = true;
    try {
      a.updatedBy = user; a.updatedAt = new Date().toISOString();
      if (isNew) { a.createdBy = user; a.createdAt = a.updatedAt; }
      await saveAsset(a);
      clearDraft();
      toast('Saved.');
      if (isNew) location.hash = `#/fa/asset/${encodeURIComponent(a.id)}`;
    } catch (err) {
      toast(explain(err, 'Couldn’t save — your changes are still here.'), 'error');
    } finally { btn.disabled = false; }
  }

  // ---- Retire / dispose ------------------------------------------------------------------
  function drawDisposal() {
    if (isNew) { mount(disposalHost); return; }
    const d = a.disposal || { date: '', proceeds: 0, notes: '' };
    const dateIn = h('input', { type: 'date', value: d.date || '' });
    const procIn = h('input', { type: 'text', inputmode: 'decimal', class: 'num', value: d.proceeds ? String(d.proceeds) : '' });
    const notesIn = h('input', { type: 'text', value: d.notes || '', placeholder: 'Sold, scrapped, donated…' });
    const out = h('div');

    const current = () => ({ date: dateIn.value, proceeds: parseAmount(procIn.value) || 0, notes: notesIn.value });
    function drawPreview() {
      const disp = current();
      if (!disp.date) { mount(out, h('p', { class: 'muted' }, 'Enter a disposal date to see the entry.')); return; }
      const temp = { ...a, disposal: disp };
      const s = disposalSummary(temp);
      let je = null, jeErr = null;
      try { je = buildDisposalJE({ asset: temp, config: cfg }); } catch (e) { jeErr = e.message; }
      mount(out,
        h('div', { class: 'stats' },
          stat('Accum. dep. at disposal', money(s.accum)),
          stat('Net book value', money(s.nbv)),
          stat('Proceeds', money(s.proceeds)),
          stat(s.gainLoss >= 0 ? 'Gain' : 'Loss', money(Math.abs(s.gainLoss)))),
        !cfg.disposal.gainLossAccount && round2(s.gainLoss) !== 0
          ? h('div', { class: 'notice warn' }, 'Set the gain/loss on disposal account in Settings before exporting this entry.') : null,
        jeErr ? h('p', { class: 'error' }, jeErr) : je ? jeTable(je.lines) : null,
      );
    }
    [dateIn, procIn].forEach((el) => el.addEventListener('input', drawPreview));

    async function saveDisposal(btn) {
      const disp = current();
      if (!disp.date) { toast('Enter the disposal date.', 'error'); return; }
      btn.disabled = true;
      try {
        a.disposal = disp;
        a.updatedBy = user; a.updatedAt = new Date().toISOString();
        await saveAsset(a);
        toast('Disposal saved. Depreciation stops per the asset’s convention.');
        drawDisposal(); draw();
      } catch (err) { a.disposal = existing.disposal; toast(explain(err, 'Couldn’t save the disposal.'), 'error'); }
      finally { btn.disabled = false; }
    }
    async function undo(btn) {
      if (!confirm('Put this asset back in service? Its disposal will be cleared.')) return;
      btn.disabled = true;
      try { a.disposal = null; await saveAsset(a); toast('Disposal cleared.'); drawDisposal(); draw(); }
      catch (err) { toast(explain(err, 'Couldn’t clear the disposal.'), 'error'); }
      finally { btn.disabled = false; }
    }
    async function download() {
      const disp = current();
      if (!disp.date) return;
      const je = buildDisposalJE({ asset: { ...a, disposal: disp }, config: cfg });
      if (je.lines.some((l) => !l.account)) { toast('Set the gain/loss on disposal account in Settings first.', 'error'); return; }
      await downloadWorkbook(`Disposal JE - ${a.name.slice(0, 40)} - ${disp.date}.xlsx`,
        [{ name: 'Journal Transactions', rows: jeRows(je.lines), cols: [16, 10, 9, 30, 11, 10, 8, 6, 13, 13, 34] }]);
    }

    mount(disposalHost,
      h('h2', {}, a.disposal ? 'Disposal' : 'Retire this asset'),
      h('p', { class: 'muted' }, 'Depreciation stops at disposal, and the entry clears the cost and accumulated depreciation and books any gain or loss.'),
      h('div', { class: 'form-grid' },
        field('Disposal date', dateIn),
        field('Proceeds', procIn, 'Leave blank if scrapped or donated.'),
        field('Notes', notesIn)),
      out,
      h('div', { class: 'row', style: { marginTop: '.75rem' } },
        h('button', { class: 'primary', onclick: (e) => saveDisposal(e.currentTarget) }, a.disposal ? 'Update disposal' : 'Save disposal'),
        h('button', { onclick: download }, 'Download disposal JE'),
        a.disposal ? h('button', { class: 'danger', onclick: (e) => undo(e.currentTarget) }, 'Undo disposal') : null),
    );
    drawPreview();
  }

  async function remove(btn) {
    if (!confirm(`Delete “${a.name}” from the register? This can’t be undone. (To take an asset off the books, retire it instead.)`)) return;
    btn.disabled = true;
    try { await deleteAsset(a.id); clearDraft(); toast('Deleted.'); location.hash = '#/fa'; }
    catch (err) { toast(explain(err, 'Couldn’t delete.'), 'error'); btn.disabled = false; }
  }

  mount(main,
    h('p', { class: 'small' }, h('a', { href: '#/fa' }, '← Fixed assets')),
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, isNew ? 'Add an asset' : a.name),
        existing?.source?.kind === 'import' ? h('p', { class: 'muted small' }, `Imported from the FA listing (row ${existing.source.row}).`) : null),
      h('div', { class: 'actions' },
        !isNew ? h('button', { class: 'danger', onclick: (e) => remove(e.currentTarget) }, 'Delete') : null,
        h('button', { class: 'primary', onclick: (e) => save(e.currentTarget) }, isNew ? 'Add asset' : 'Save changes'))),
    draft ? h('div', { class: 'notice warn' }, 'Restored unsaved changes from earlier. ',
      h('button', { onclick: () => { clearDraft(); location.reload(); } }, 'Discard them')) : null,
    h('div', { class: 'form-grid' },
      field('Name', bindText('name', { placeholder: 'e.g. Mac Studio – serial K10DQ…' })),
      field('Asset account', groupSel),
      field('Status', statusSel),
      field('Serial / tag', bindText('serial')),
      field('Cost', bindNum('cost')),
      field('Salvage value', bindNum('salvage'), 'Usually 0.'),
      field('In-service date', inService),
      field('Method', methodSel),
      field('Convention', convSel),
      field('Useful life (months)', lifeInput, lifeYears),
      field('…or lease end date', endDate, 'For leasehold improvements: sets the life to the lease term.'),
      h('label', { class: 'field wide' }, h('span', { class: 'field-label' }, 'Notes'), bindText('notes'))),
    fixedHost,
    preview,
    disposalHost,
  );
  lifeYears.textContent = '';
  drawFixed();
  draw();
  drawDisposal();
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));
}

export function jeTable(lines) {
  const ok = isBalanced(lines);
  return h('div', {},
    table([
      { label: 'Department', cell: (l) => l.dept },
      { label: 'Account', cell: (l) => l.account },
      { label: 'Description', cell: (l) => l.description },
      { label: 'Subaccount', cell: (l) => l.sub },
      { label: 'Debit', num: true, cell: (l) => money(l.debit) },
      { label: 'Credit', num: true, cell: (l) => money(l.credit) },
      { label: 'Transaction description', cell: (l) => l.tranDescription },
    ], lines, { foot: (c) => (c.label === 'Debit' ? money(sum(lines, (l) => l.debit)) : c.label === 'Credit' ? money(sum(lines, (l) => l.credit)) : c.label === 'Department' ? 'Total' : '') }),
    ok ? null : h('p', { class: 'error' }, 'This entry doesn’t balance.'));
}
