// Audit binder: pick what to hand the auditors — a category, an account, a period, any or none —
// and download it as one zip, with an index. Nothing is stored here: it's a view over the
// statements, schedules, governance documents, JEs and trial balances the other pages keep.

import { h, mount, table, toast, select, statusPill } from '../ui.js';
import { loadPocMonths, loadCds, listGovernanceDocs, loadTrialBalances, listApAging, listGlActivity, listRestrictedFunds, loadPocConfig, loadRestrictedConfig, loadBsConfig, loadConfig, listInventoryMonths, loadInventoryConfig, loadAssets } from '../data.js';
import { firstKnownMonth } from '../fa/rollforward.js';
import { CATEGORIES, TOPICS, statementItems, governanceItems, trialBalanceItems, madeItems, filterItems, zipName, indexCsv } from '../binder/items.js';
import { MAKERS, monthJesFor } from '../binder/make.js';
import { fundsFromGl } from '../restricted/funds.js';
import { BANK_SOURCES } from '../poc/calc.js';
import { zipWriter } from '../zip.js';
import { fileUrl } from '../store.js';
import { monthName, fiscalYear, addMonths, currentMonth } from '../fiscal.js';

const KEY = 'monthclose:binder';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
const keep = (f) => { try { localStorage.setItem(KEY, JSON.stringify(f)); } catch { /* ignore */ } };
const short = (m) => monthName(m, { short: true });

export default async function (main, { user, rerender }) {
  const [recs, cds, docs, tbs, agings, gls, others, pocCfg, restrictedCfg, bsCfg, faCfg, invs, invCfg, assets] = await Promise.all([
    loadPocMonths(), loadCds(), listGovernanceDocs(), loadTrialBalances(), listApAging(), listGlActivity(), listRestrictedFunds(),
    loadPocConfig(), loadRestrictedConfig(), loadBsConfig(), loadConfig(), listInventoryMonths(), loadInventoryConfig(), loadAssets({ fresh: true })]);
  const recBy = Object.fromEntries(recs.map((r) => [r.month, r]));
  const glBy = Object.fromEntries(gls.map((g) => [g.month, g]));
  const tbBy = Object.fromEntries(tbs.map((t) => [t.month, t]));
  const agingBy = Object.fromEntries(agings.map((a) => [a.month, a]));
  const gl = fundsFromGl(gls, others);
  const invBy = Object.fromEntries(invs.map((r) => [r.month, r]));
  const ctx = { user, recBy, cds, tbBy, agingBy, bsCfg, gl, glBy, jeDefaults: pocCfg.jeDefaults || {}, restrictedCfg, names: faCfg.accountNames || {}, invBy, invCfg, assets, faCfg };
  // Fixed assets: the months the app depreciates (from the listing's month on, through last month).
  const faStart = assets.length ? firstKnownMonth(assets) : null;
  const faMonths = [];
  for (let m = faStart; m && m <= addMonths(currentMonth(), -1); m = addMonths(m, 1)) faMonths.push(m);
  if (faStart && !faMonths.length) faMonths.push(addMonths(faStart, -1));

  const hasPoc = (r) => r && !r.source?.ditOnly && (Object.keys(r.statements || {}).length || r.stripe || r.ics || Object.keys(r.bankStatements || {}).length || Object.keys(r.bank || {}).length);
  const cashMonths = [...new Set(tbs.flatMap((t) => [t.month, addMonths(t.month, -1)]))].sort();
  const jeMonths = [...new Set([...recs.map((r) => r.month), ...(gl.result?.months || []), ...invs.map((r) => r.month), ...faMonths])].sort().filter((m) => monthJesFor(m, ctx).length);
  const items = [
    ...statementItems(recs, cds),
    ...madeItems({
      pocFys: [...new Set(recs.filter(hasPoc).map((r) => fiscalYear(r.month)))].sort(),
      cashMonths, apMonths: agings.map((a) => a.month).sort(), agings,
      cdFys: [...new Set(cds.flatMap((c) => Object.keys(c.earned || {})).map(fiscalYear))].sort(),
      restrictedFys: [...new Set((gl.result?.months || []).map(fiscalYear))].sort(),
      jeMonths,
      inventoryMonths: invs.filter((r) => r.warehouse || r.distribution || r.sales).map((r) => r.month).sort(),
      inventoryFiles: invs.filter((r) => r.warehouse?.fileKey).map((r) => ({ month: r.month, fileKey: r.warehouse.fileKey, fileName: r.warehouse.fileName })),
      faMonths,
    }),
    ...governanceItems(docs),
    ...trialBalanceItems(tbs),
  ];

  const nowFy = fiscalYear(addMonths(currentMonth(), -1));
  const f = { category: '', account: '', period: `FY${nowFy}`, ...(load() || {}) };
  const set = (k, v) => { f[k] = v; if (k === 'category' && v && v !== 'statement') f.account = ''; keep(f); rerender(); };

  const fys = [...new Set([nowFy, ...items.map((i) => i.fy).filter(Boolean)])].sort((a, b) => b - a);
  const months = [...new Set(items.flatMap((i) => i.months))].filter((m) => m <= currentMonth()).sort().reverse();
  const shown = filterItems(items, f);
  const name = zipName(f);
  const count = (cat) => shown.filter((i) => i.category === cat).length;
  const scope = (i) => (/^\d{4}-\d{2}$/.test(f.period) ? [f.period] : i.months);
  const assetsAsked = f.category === 'schedule:assets';

  async function download(btn) {
    btn.disabled = true;
    const z = zipWriter();
    const rows = [];
    let n = 0;
    for (const it of shown) {
      btn.textContent = `Adding ${++n} of ${shown.length}…`;
      const row = { ...it, months: scope(it).filter((m) => it.months.includes(m)), included: false, note: '' };
      try {
        let bytes;
        if (it.file) {
          const url = await fileUrl(it.file.col, it.file.key);
          if (!url) throw new Error('File storage isn’t available here.');
          const res = await fetch(url);
          if (!res.ok) throw new Error(`The file couldn’t be fetched (${res.status}).`);
          bytes = new Uint8Array(await res.arrayBuffer());
          row.note = 'As stored';
        } else {
          bytes = await MAKERS[it.make](it, ctx, row.months);
          row.note = it.make === 'poc' || it.make === 'cds' ? 'Made at download; the whole fiscal year' : it.make === 'fa' && faStart && faStart > row.months[0] ? `Made at download; the roll-forward runs from ${faStart}, when the listing was imported` : 'Made at download';
        }
        z.add(`${it.folder}/${it.name}`, bytes);
        row.included = true;
      } catch (err) { row.note = err?.message || String(err); }
      rows.push(row);
    }
    z.add('Index.csv', indexCsv(rows));
    z.add('README.txt', readme(f, rows, user));
    const missing = rows.filter((r) => !r.included);
    const a = h('a', { href: URL.createObjectURL(z.blob()), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    btn.disabled = false; btn.textContent = `Download ${name}`;
    toast(missing.length ? `${name}: ${rows.length - missing.length} of ${rows.length} included. Index.csv says what’s missing and why.` : `${name}: ${rows.length} files.`, missing.length ? 'error' : 'info');
  }

  const catOptions = [['', 'Everything'], ...CATEGORIES.flatMap(([k, l]) => (k === 'schedule' ? [[k, `${l} (all)`], ...TOPICS.map(([t, tl]) => [`schedule:${t}`, `Schedules — ${tl}`])] : [[k, l]]))];
  const periodOptions = [['', 'All periods'], ...fys.map((y) => [`FY${y}`, `FY${y} (Oct ${y - 1} – Sep ${y})`]), ...months.map((m) => [m, monthName(m)])];
  const btn = h('button', { class: 'primary', disabled: !shown.length, onclick: (e) => download(e.target) }, `Download ${name}`);

  mount(main,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Audit binder'),
        h('p', { class: 'muted' }, 'Everything for the auditors in one zip: statements, schedules, governance documents, journal entries and trial balances. Narrow it down, or leave it all for the full binder.'))),
    h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Category'), select(catOptions, f.category, { onchange: (e) => set('category', e.target.value) })),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Account'), select([['', 'All accounts'], ...BANK_SOURCES.map((s) => [s.id, s.label])], f.account,
        { onchange: (e) => set('account', e.target.value), disabled: !!f.category && f.category !== 'statement' }), h('span', { class: 'field-hint' }, 'Statements only.')),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Period'), select(periodOptions, f.period, { onchange: (e) => set('period', e.target.value) }))),
    h('div', { class: 'row', style: { margin: '1rem 0' } }, btn,
      h('span', { class: 'muted' }, shown.length ? CATEGORIES.filter(([k]) => count(k)).map(([k, l]) => `${count(k)} ${l.toLowerCase()}`).join(' · ') : 'Nothing matches.')),
    assetsAsked && !assets.length ? h('div', { class: 'notice' }, 'No fixed assets in the app yet: import the Fixed Asset Listing on the Fixed assets tab.') : null,
    h('p', { class: 'muted small' }, 'Statements, governance documents and uploaded reports go in as stored. Schedules and JE files are made when you download, from the figures as they are now. Index.csv in the zip lists every file with its category, account and period, and anything that couldn’t be included.'),
    table([
      { label: 'Folder', cell: (i) => i.folder.replace(/^\d+ /, '') },
      { label: 'File', cell: (i) => i.name },
      { label: 'Period', cell: (i) => { const ms = scope(i).filter((m) => i.months.includes(m)); return ms.length === 1 ? short(ms[0]) : ms.length ? `${short(ms[0])} – ${short(ms[ms.length - 1])}` : ''; } },
      { label: '', cell: (i) => (i.file ? statusPill('Stored', 'neutral') : statusPill('Made at download', 'info')) },
    ], shown, { empty: 'Nothing in the app matches. Try another period or category.' }));
}

function readme(f, rows, user) {
  const scope = [f.category ? `Category: ${f.category}` : 'All categories', f.account ? `Account: ${BANK_SOURCES.find((s) => s.id === f.account)?.label}` : 'All accounts', f.period ? `Period: ${f.period}` : 'All periods'].join(' · ');
  return [
    'BibleProject audit binder',
    `Made ${new Date().toLocaleString()}${user ? ` by ${user}` : ''} from the Month Close app.`,
    scope,
    '',
    '01 Statements      bank and investment statements, one folder per account, named {Account}_{YYYY-MM}',
    '02 Schedules       proof of cash, cash tie-out, AP tie-out and aging reports, CD schedule, restricted funds roll-forward',
    '03 Governance      board minutes, COI disclosures, signatory lists, CC compilations',
    '04 Journal entries each month\'s JEs in the Acumatica import layout',
    '05 Trial balances  the Trial Balance Summary for each month, as uploaded where it was kept',
    '',
    'Index.csv lists every file with its category, account and period.',
    `${rows.filter((r) => r.included).length} of ${rows.length} files included.${rows.some((r) => !r.included) ? ' The ones that aren\'t are in Index.csv with the reason.' : ''}`,
    '',
  ].join('\r\n');
}
