// Restricted funds: each fund's roll-forward (opening + gifts − released = ending), month or fiscal
// year to date, and the month's reclass JE. Language funds come from the GL register; other funds
// (Bolthouse, Murdock…) are typed in.

import { h, mount, table, toast, fileButton, panel, ask, field, select } from '../ui.js';
import { listGlActivity, loadRestrictedConfig, saveRestrictedConfig, listRestrictedFunds, saveRestrictedFund, deleteRestrictedFund, loadConfig } from '../data.js';
import { runFunds, span, totals, restrictedJe, openingNotes, grantActivity, rollForwardSheets, GENERAL } from '../restricted/funds.js';
import { uploadGlRegister } from '../gl-upload.js';
import { downloadJes } from './month-jes.js';
import { jeTable } from './je-table.js';
import { isBalanced } from '../fa/je.js';
import { downloadWorkbook } from '../xlsx-io.js';
import { explain } from '../store.js';
import { nowIso } from '../audit.js';
import { money, parseAmount, round2 } from '../money.js';
import { monthName, fiscalYear, fyStart, lastDayOfMonth, currentMonth, addMonths } from '../fiscal.js';

const MONTH_KEY = 'monthclose:restricted-month';
const VIEW_KEY = 'monthclose:restricted-view';
const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { /* ignore */ } return null; };
const short = (m) => monthName(m, { short: true });

export const JE_BATCH = 6;
export const JE_DESCRIPTION = 'Restricted Net Assets';

export default async function (main, { user, rerender }) {
  const [gls, cfg, others, faCfg] = await Promise.all([listGlActivity(), loadRestrictedConfig(), listRestrictedFunds(), loadConfig()]);
  const glBy = Object.fromEntries(gls.map((g) => [g.month, g]));
  const activity = {};
  const stale = [];
  for (const g of gls) { const a = grantActivity(g); if (a) activity[g.month] = a; else stale.push(g.month); }
  const loaded = Object.keys(activity).sort();
  let month = pref(MONTH_KEY) || loaded[loaded.length - 1] || addMonths(currentMonth(), -1);
  const view = pref(VIEW_KEY) || 'fy';
  const fy = fiscalYear(month);
  const go = (k, v) => { pref(k, v); rerender(); };

  const onGl = async (file) => { if (await uploadGlRegister(file, { user, glBy })) rerender(); };

  if (!loaded.length) {
    mount(main, head(month, view, go, onGl),
      h('div', { class: 'notice warn' }, stale.length
        ? `The GL register for ${stale.length} month${stale.length === 1 ? '' : 's'} was loaded before this page kept grant codes. Load it again (any page’s GL register upload does it) and the schedule fills in.`
        : 'Load a GL register to start. Load last year’s too: the schedule runs every fund forward from the first month it has.'));
    return;
  }

  const start = loaded[0];
  const end = month > loaded[loaded.length - 1] ? month : loaded[loaded.length - 1];
  const result = runFunds({ activity, others, start, end });
  const from = view === 'month' ? month : fyStart(fy) < start ? start : fyStart(fy);
  const funds = result.funds.filter((f) => { const s = span(f, from, month); return s.open || s.add || s.rel || s.end; });
  const t = totals(funds, from, month);
  const gaps = result.gaps.filter((m) => m <= month);
  const notes = openingNotes(result);

  const jeLines = restrictedJe(result, month, cfg, faCfg.accountNames || {});
  const je = { batch: JE_BATCH, id: 'restricted', label: 'Restricted net assets', description: JE_DESCRIPTION, date: lastDayOfMonth(month), lines: jeLines, problems: [], notes: [], balanced: isBalanced(jeLines) };

  async function exportExcel() {
    await downloadWorkbook(`Restricted funds ${short(from)} to ${short(month)}.xlsx`, rollForwardSheets(result, from, month));
  }

  mount(main,
    head(month, view, go, onGl, exportExcel),
    stale.length ? h('div', { class: 'notice warn' }, `The GL for ${stale.map(short).join(', ')} was loaded before this page kept grant codes, so those months aren’t in the schedule. Load the GL register for them again.`) : null,
    gaps.length ? h('div', { class: 'notice warn' }, `No GL register for ${gaps.map(short).join(', ')}: those months count as no gifts and no spending. Load them to fill the gap.`) : null,

    h('div', { class: 'stats' },
      stat(`Restricted at the start of ${short(from)}`, money(t.open, { dash: false })),
      stat('Gifts', money(t.add, { dash: false })),
      stat('Released', money(t.rel, { dash: false })),
      stat(`Restricted at the end of ${short(month)}`, money(t.end, { dash: false }))),

    table([
      { label: 'Fund', cell: (f) => h('div', {}, f.name, h('div', { class: 'muted small' }, f.kind === 'language' ? `Grants ${f.codes.join(', ')}` : f.kind === 'general' ? 'Translation gifts with no language' : f.def?.release === 'schedule' ? 'Released on a schedule' : `Typed in · grants ${f.codes.join(', ') || 'none yet'}`)) },
      { label: 'Opening', num: true, cell: (f) => money(span(f, from, month).open) },
      { label: 'Gifts', num: true, cell: (f) => money(span(f, from, month).add) },
      { label: 'Released', num: true, cell: (f) => money(span(f, from, month).rel) },
      { label: 'Ending', num: true, cell: (f) => h('strong', {}, money(span(f, from, month).end)) },
    ], funds, {
      empty: 'No restricted gifts or balances in this period.',
      rowProps: (f) => ({ class: 'clickable', onclick: () => showFund(f, result, fy, month) }),
      foot: (c) => ({ Fund: 'Total', Opening: money(t.open), Gifts: money(t.add), Released: money(t.rel), Ending: money(t.end) })[c.label] ?? '',
    }),
    h('p', { class: 'muted small' }, 'Every Translation Support (4017) gift is restricted to the language its grant code names (Portuguese covers 611, 618, 627 and 665; Spanish 632, 662–664; French 613, 654, 667; Arabic 602–606). Spending on that language’s codes releases it. Gifts with no language are general localization, released by translation spending the language’s own fund didn’t cover. A fund never goes below zero: spending past it is unrestricted money. Click a fund for its months.'),
    notes.length ? h('details', { class: 'small' }, h('summary', {}, `Before ${short(start)}: ${notes.length} fund${notes.length === 1 ? '' : 's'} could carry an older balance`),
      h('p', { class: 'muted' }, `The schedule starts every fund at zero in ${short(start)}, the first month with a GL register. Funds that later ran short have spent any older balance by now; these never ran short, so an older balance would still be in them:`),
      h('ul', {}, notes.map((n) => h('li', {}, n.fund)))) : null,

    h('h2', {}, `Reclass JE — ${monthName(month)}`),
    h('div', { class: 'card' },
      h('p', { class: 'small' }, jeLines.length
        ? `Moves this month’s gifts less releases into net assets with donor restrictions: Dr ${cfg.offsetAccount} / Cr ${cfg.restrictedAccount} when restricted money grows, the other way round when it’s released.`
        : `Nothing moved in ${monthName(month)}: no restricted gifts and nothing released.`),
      jeLines.length ? jeTable(jeLines) : null,
      h('div', { class: 'row' },
        h('button', { onclick: () => downloadJes(month, [je]), disabled: !jeLines.length }, 'Download for Acumatica'),
        h('button', { onclick: () => editAccounts(cfg, rerender) }, 'JE accounts…'))),

    h('h2', {}, 'Other restricted funds'),
    h('p', { class: 'muted small' }, 'Grants and gifts that aren’t Translation Support (Bolthouse, Murdock…). Type the opening balance, the gifts, and how each is released.'),
    table([
      { label: 'Fund', cell: (o) => o.name },
      { label: 'Released', cell: (o) => (o.release === 'schedule' ? `${money(Number(o.monthly) || 0)} a month${o.from ? ` from ${short(o.from)}` : ''}${o.to ? ` to ${short(o.to)}` : ''}` : `As spent on grants ${(o.codes || []).join(', ') || '(none yet)'}`) },
      { label: 'Ending', num: true, cell: (o) => { const f = result.funds.find((x) => x.id === `other:${o.id}`); return f ? money(span(f, from, month).end) : ''; } },
      { label: '', cell: (o) => h('button', { class: 'small-btn', onclick: (e) => { e.stopPropagation(); editFund(o, user, rerender); } }, 'Edit') },
    ], others, { empty: 'None yet.' }),
    h('div', { class: 'row' }, h('button', { onclick: () => editFund(null, user, rerender) }, 'Add a fund…')),
  );
}

function head(month, view, go, onGl, onExport = null) {
  return h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, `Restricted funds — ${view === 'month' ? monthName(month) : `FY${fiscalYear(month)} to ${monthName(month, { short: true })}`}`),
      h('p', { class: 'muted' }, 'Restricted gifts by fund: what came in, what was released by spending, and what’s left.')),
    h('div', { class: 'actions' },
      h('label', { class: 'month-pick' }, h('span', {}, 'Month'), h('input', { type: 'month', value: month, onchange: (e) => e.target.value && go(MONTH_KEY, e.target.value) })),
      h('div', { class: 'seg' },
        h('button', { class: view === 'month' ? 'active' : '', onclick: () => go(VIEW_KEY, 'month') }, 'This month'),
        h('button', { class: view === 'fy' ? 'active' : '', onclick: () => go(VIEW_KEY, 'fy') }, 'Year to date')),
      onExport ? h('button', { onclick: onExport }, 'Export Excel') : null,
      fileButton('Upload GL register…', '.xlsx', onGl)));
}

function showFund(f, result, fy, month) {
  const months = result.months.filter((m) => m >= fyStart(fy) && m <= month);
  panel(f.name, (body) => {
    body.append(
      h('p', { class: 'muted small' }, f.kind === 'language' ? `Gifts and spending on grants ${f.codes.join(', ')}.`
        : f.id === GENERAL ? 'Translation gifts with no language (grant 000 and the like), released by translation spending a language’s own fund didn’t cover.' : ''),
      table([
        { label: 'Month', cell: (m) => short(m) },
        { label: 'Opening', num: true, cell: (m) => money(f.rows[m].open) },
        { label: 'Gifts', num: true, cell: (m) => money(f.rows[m].add) },
        { label: f.id === GENERAL ? 'Spending not covered' : 'Spending', num: true, cell: (m) => money(f.rows[m].spend) },
        { label: 'Released', num: true, cell: (m) => money(f.rows[m].rel) },
        { label: 'Ending', num: true, cell: (m) => money(f.rows[m].end) },
      ], months),
      f.unmet ? h('p', { class: 'muted small' }, `Since ${short(result.months[0])}, ${money(f.unmet)} of spending found no restricted money left and was paid from unrestricted funds.`) : null);
  }, { wide: true });
}

function editAccounts(cfg, rerender) {
  panel('Reclass JE accounts', (body, close) => {
    const r = h('input', { value: cfg.restrictedAccount }), o = h('input', { value: cfg.offsetAccount }), s = h('input', { value: cfg.sub });
    body.append(
      h('p', { class: 'small' }, 'Where the reclass posts. Restricted gifts with no condition the donor could take them back over are net assets with donor restrictions (3200). If a grant turns out to be conditional, its fund would post to Restricted Deferred Revenue (2060) instead.'),
      h('div', { class: 'form-grid' }, field('Restricted account', r), field('Offset (without donor restrictions)', o), field('Subaccount', s)),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => {
        try { await saveRestrictedConfig({ restrictedAccount: r.value.trim(), offsetAccount: o.value.trim(), sub: s.value.trim() }); toast('Saved.'); close(); rerender(); }
        catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
      } }, 'Save')));
  });
}

function editFund(fund, user, rerender) {
  const f = fund ? structuredClone(fund) : { id: `fund-${Date.now().toString(36)}`, name: '', opening: 0, openingMonth: '', gifts: [], release: 'spend', codes: [] };
  panel(fund ? `Edit ${fund.name}` : 'Add a restricted fund', (body, close) => {
    const name = h('input', { value: f.name, autofocus: true });
    const opening = h('input', { class: 'num', value: f.opening || '' });
    const openingMonth = h('input', { type: 'month', value: f.openingMonth || '' });
    const release = select([['spend', 'As it’s spent, on its grant codes'], ['schedule', 'On a schedule, a fixed amount each month']], f.release);
    const codes = h('input', { value: (f.codes || []).join(', '), placeholder: '131, 146' });
    const monthly = h('input', { class: 'num', value: f.monthly || '' });
    const from = h('input', { type: 'month', value: f.from || '' }), to = h('input', { type: 'month', value: f.to || '' });
    const giftsHost = h('div');
    const drawGifts = () => mount(giftsHost, table([
      { label: 'Month', cell: (g) => short(g.month) },
      { label: 'Amount', num: true, cell: (g) => money(g.amount) },
      { label: 'Note', cell: (g) => g.note || '' },
      { label: '', cell: (g) => h('button', { class: 'small-btn', onclick: () => { f.gifts = f.gifts.filter((x) => x !== g); drawGifts(); } }, 'Remove') },
    ], f.gifts || [], { empty: 'No gifts typed yet.' }));
    drawGifts();
    const gMonth = h('input', { type: 'month' }), gAmt = h('input', { class: 'num', size: 12 }), gNote = h('input', { placeholder: 'Note' });
    body.append(
      h('div', { class: 'form-grid' }, field('Name', name), field('Opening balance', opening), field('As of the start of', openingMonth, 'The month the opening balance comes in.')),
      h('div', { class: 'form-grid' }, field('Released', release), field('Grant codes (as spent)', codes, 'Spending on these codes releases it.'),
        field('Monthly amount (schedule)', monthly), field('From', from), field('To', to)),
      h('h3', {}, 'Gifts'), giftsHost,
      h('div', { class: 'row' }, gMonth, gAmt, gNote, h('button', { onclick: () => {
        const amount = parseAmount(gAmt.value);
        if (!gMonth.value || !Number.isFinite(amount)) { toast('Give the gift a month and an amount.', 'error'); return; }
        f.gifts = [...(f.gifts || []), { month: gMonth.value, amount: round2(amount), note: gNote.value.trim() }].sort((a, b) => a.month.localeCompare(b.month));
        gAmt.value = ''; gNote.value = ''; drawGifts();
      } }, 'Add gift')),
      h('div', { class: 'row dialog-actions' },
        fund ? h('button', { class: 'danger', onclick: async () => {
          if (!(await ask('Delete this fund?', `${fund.name} and its typed gifts are removed from the schedule. Nothing in Acumatica changes.`, { ok: 'Delete', danger: true }))) return;
          try { await deleteRestrictedFund(fund.id); toast('Deleted.'); close(); rerender(); } catch (err) { toast(explain(err, 'Couldn’t delete.'), 'error'); }
        } }, 'Delete fund') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'primary', onclick: async () => {
          const o = parseAmount(opening.value || '0');
          if (!name.value.trim()) { toast('Give the fund a name.', 'error'); return; }
          if (!Number.isFinite(o) || (o && !openingMonth.value)) { toast('An opening balance needs a number and the month it’s as of.', 'error'); return; }
          const rec = { ...f, name: name.value.trim(), opening: round2(o), openingMonth: openingMonth.value, release: release.value,
            codes: codes.value.split(/[\s,]+/).filter((c) => /^\d{3}$/.test(c)), monthly: parseAmount(monthly.value || '0') || 0, from: from.value, to: to.value,
            updatedBy: user, updatedAt: nowIso() };
          try { await saveRestrictedFund(rec); toast('Saved.'); close(); rerender(); } catch (err) { toast(explain(err, 'Couldn’t save.'), 'error'); }
        } }, 'Save')));
  }, { wide: true });
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));
}
