// The audit binder: everything the app can hand an auditor, each tagged { category, topic,
// account, months, fy } so a download can be one account for a year, every statement for a year,
// one kind of schedule, or everything.
//
// An item is a stored file ({ file: { col, key } }) or something made at download time
// ({ make: 'poc' | 'cash' | 'ap' | 'cds' | 'restricted' | 'jes' | 'tb', ... }). `folder` and `name`
// are where it goes in the zip.

import { BANK_SOURCES } from '../poc/calc.js';
import { STATEMENT_ACCOUNTS, statementName } from '../naming.js';
import { docFy, typeLabel } from '../governance/docs.js';
import { fiscalYear, fyStart, addMonths, monthOfDate } from '../fiscal.js';

export const CATEGORIES = [
  ['statement', 'Statements'],
  ['schedule', 'Schedules'],
  ['governance', 'Governance'],
  ['je', 'Journal entries'],
  ['tb', 'Trial balances'],
];
export const TOPICS = [
  ['close', 'Close checklist'],
  ['cash', 'Cash (proof of cash, cash tie-out)'],
  ['ap', 'Accounts payable'],
  ['investments', 'Investments (CD schedule)'],
  ['restricted', 'Restricted funds'],
  ['inventory', 'Inventory'],
  ['assets', 'Fixed assets'],
];
const FOLDERS = { statement: '01 Statements', schedule: '02 Schedules', governance: '03 Governance', je: '04 Journal entries', tb: '05 Trial balances' };
const accountLabel = (id) => BANK_SOURCES.find((s) => s.id === id)?.label || id;
export const fyMonths = (fy) => Array.from({ length: 12 }, (_, i) => addMonths(fyStart(fy), i));

// A name in the stored format already ({Base}_{YYYY-MM}…), or the stored format made from the
// account and month for files attached before statements were renamed.
function nameFor(meta, account, period, kind) {
  const n = meta.fileName || meta.name || '';
  if (/^[A-Za-z]+_\d{4}-\d{2}/.test(n)) return n;
  return statementName({ account, period, kind, original: meta.originalName || n || 'statement.pdf' });
}

// Every statement file the proof of cash months and the CD schedule hold.
export function statementItems(recs = [], cds = []) {
  const out = [];
  const seen = new Set();
  const add = (meta, account, month, kind) => {
    const key = meta?.fileKey || meta?.key;
    if (!key || seen.has(key)) return;
    seen.add(key);
    const base = account === 'cassOp' && kind ? { operating: 'CassOperating', incoming: 'CassIncomingWires', outgoing: 'CassOutgoingWires' }[kind] : STATEMENT_ACCOUNTS[account];
    out.push({ category: 'statement', account, months: [month], fy: fiscalYear(month), file: { col: 'statements', key },
      folder: `${FOLDERS.statement}/${base || accountLabel(account)}`, name: nameFor(meta, account, month, kind), label: `${accountLabel(account)} · ${month}` });
  };
  for (const rec of recs) {
    const m = rec.month;
    for (const [kind, st] of Object.entries(rec.statements || {})) add(st, 'cassOp', m, kind);
    if (rec.stripe) add(rec.stripe, 'stripe', m);
    if (rec.ics) add(rec.ics, 'ics', m);
    for (const [id, b] of Object.entries(rec.bankStatements || {})) add(b, id, m);
    for (const [id, list] of Object.entries(rec.bankFiles || {})) for (const f of list || []) add(f, id, m);
  }
  for (const cd of cds) for (const [date, f] of Object.entries(cd.files || {})) {
    if (!f?.key) continue;
    const m = monthOfDate(date);
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    out.push({ category: 'statement', account: 'cd', months: [m], fy: fiscalYear(m), file: { col: 'statements', key: f.key },
      folder: `${FOLDERS.statement}/CassCDARS`, name: nameFor(f, 'cd', date), label: `${accountLabel('cd')} · ${date}` });
  }
  return out;
}

export function governanceItems(docs = []) {
  return docs.filter((d) => d.fileKey).map((d) => {
    const m = d.type === 'cc-compilation' ? d.period : d.date ? monthOfDate(d.date) : null;
    return { category: 'governance', months: m ? [m] : [], fy: docFy(d), file: { col: 'governance-files', key: d.fileKey },
      folder: `${FOLDERS.governance}/${typeLabel(d.type)}`, name: d.fileName, label: `${typeLabel(d.type)} · ${d.person ? `${d.person} · ` : ''}${d.date || d.period || ''}` };
  });
}

// Trial balances: the file as uploaded where it was kept, otherwise a workbook made from the figures.
export function trialBalanceItems(tbs = []) {
  return tbs.map((tb) => ({ category: 'tb', months: [tb.month], fy: fiscalYear(tb.month),
    ...(tb.fileKey ? { file: { col: 'source-files', key: tb.fileKey }, name: tb.fileName } : { make: 'tb', month: tb.month, name: `TrialBalance_${tb.month}.xlsx` }),
    folder: FOLDERS.tb, label: `Trial balance · ${tb.month}` }));
}

// Schedules and JEs made at download time, one per fiscal year (or per month, for JEs), for the
// fiscal years and months the app has anything for.
export function madeItems({ closeFys = [], pocFys = [], cashMonths = [], apMonths = [], agings = [], cdFys = [], restrictedFys = [], jeMonths = [], inventoryMonths = [], inventoryFiles = [], faMonths = [] }) {
  const out = [];
  for (const fy of closeFys) out.push({ category: 'schedule', topic: 'close', fy, months: fyMonths(fy), make: 'checklist', folder: `${FOLDERS.schedule}/Close checklist`, name: `CloseChecklist_FY${fy}.xlsx`, label: `Month-end checklist FY${fy}` });
  for (const fy of pocFys) out.push({ category: 'schedule', topic: 'cash', fy, months: fyMonths(fy), make: 'poc', folder: `${FOLDERS.schedule}/Proof of cash`, name: `ProofOfCash_FY${fy}.xlsx`, label: `Proof of cash FY${fy}` });
  for (const fy of [...new Set(cashMonths.map(fiscalYear))]) out.push({ category: 'schedule', topic: 'cash', fy, months: cashMonths.filter((m) => fiscalYear(m) === fy), make: 'cash', folder: `${FOLDERS.schedule}/Cash tie-out`, name: `CashTieOut_FY${fy}.xlsx`, label: `Cash tie-out FY${fy}` });
  for (const fy of [...new Set(apMonths.map(fiscalYear))]) out.push({ category: 'schedule', topic: 'ap', fy, months: apMonths.filter((m) => fiscalYear(m) === fy), make: 'ap', folder: `${FOLDERS.schedule}/Accounts payable`, name: `APTieOut_FY${fy}.xlsx`, label: `AP tie-out FY${fy}` });
  for (const a of agings.filter((x) => x.fileKey)) out.push({ category: 'schedule', topic: 'ap', fy: fiscalYear(a.month), months: [a.month], file: { col: 'source-files', key: a.fileKey }, folder: `${FOLDERS.schedule}/Accounts payable`, name: a.fileName, label: `AP aging report · ${a.month}` });
  for (const fy of cdFys) out.push({ category: 'schedule', topic: 'investments', fy, months: fyMonths(fy), make: 'cds', folder: `${FOLDERS.schedule}/CD schedule`, name: `CDSchedule_FY${fy}.xlsx`, label: `CD schedule FY${fy}` });
  for (const fy of restrictedFys) out.push({ category: 'schedule', topic: 'restricted', fy, months: fyMonths(fy), make: 'restricted', folder: `${FOLDERS.schedule}/Restricted funds`, name: `RestrictedFunds_FY${fy}.xlsx`, label: `Restricted funds roll-forward FY${fy}` });
  for (const fy of [...new Set(inventoryMonths.map(fiscalYear))]) out.push({ category: 'schedule', topic: 'inventory', fy, months: inventoryMonths.filter((m) => fiscalYear(m) === fy), make: 'inventory', folder: `${FOLDERS.schedule}/Inventory`, name: `InventoryTieOut_FY${fy}.xlsx`, label: `Inventory tie-out FY${fy}` });
  for (const f of inventoryFiles) out.push({ category: 'schedule', topic: 'inventory', fy: fiscalYear(f.month), months: [f.month], file: { col: 'source-files', key: f.fileKey }, folder: `${FOLDERS.schedule}/Inventory`, name: f.fileName, label: `Warehouse count · ${f.month}` });
  for (const fy of [...new Set(faMonths.map(fiscalYear))]) out.push({ category: 'schedule', topic: 'assets', fy, months: faMonths.filter((m) => fiscalYear(m) === fy), make: 'fa', folder: `${FOLDERS.schedule}/Fixed assets`, name: `FixedAssets_FY${fy}.xlsx`, label: `Fixed asset roll-forward and listing FY${fy}` });
  for (const m of jeMonths) out.push({ category: 'je', fy: fiscalYear(m), months: [m], make: 'jes', month: m, folder: FOLDERS.je, name: `JEs_${m}.xlsx`, label: `Journal entries · ${m}` });
  return out;
}

// filter: { category: '' | 'statement' | 'schedule' | 'schedule:<topic>' | …, account: '' | id,
// period: '' (everything) | 'FY2026' | 'YYYY-MM' }. A schedule made for a year is in a month's
// download too when that month is in it (made for just that month).
export function filterItems(items, { category = '', account = '', period = '' } = {}) {
  const [cat, topic] = category.split(':');
  return items.filter((it) => {
    if (account && (it.category !== 'statement' || it.account !== account)) return false;
    if (cat && it.category !== cat) return false;
    if (topic && it.topic !== topic) return false;
    if (/^FY\d{4}$/.test(period)) return it.fy === Number(period.slice(2));
    if (/^\d{4}-\d{2}$/.test(period)) return it.months.includes(period);
    return true;
  });
}

// "BP_CassOperating_FY26.zip", "BP_FullAuditBinder_FY26.zip", "BP_Schedules-Restricted_2026-03.zip".
export function zipName({ category = '', account = '', period = '' } = {}) {
  const [cat, topic] = category.split(':');
  const what = account ? STATEMENT_ACCOUNTS[account] || account
    : cat ? `${{ statement: 'Statements', schedule: 'Schedules', governance: 'Governance', je: 'JournalEntries', tb: 'TrialBalances' }[cat]}${topic ? `-${topic[0].toUpperCase()}${topic.slice(1)}` : ''}`
      : 'FullAuditBinder';
  const when = /^FY\d{4}$/.test(period) ? `FY${period.slice(4)}` : period || 'AllPeriods';
  return `BP_${what}_${when}.zip`;
}

// The index at the top of every zip: what's in it, where, and anything that couldn't be included.
export function indexCsv(rows) {
  const q = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  const head = ['Folder', 'File', 'Category', 'Topic', 'Account', 'Period', 'Fiscal year', 'Included', 'Note'];
  return `${[head, ...rows.map((r) => [r.folder, r.name, r.category, r.topic || '', r.account ? accountLabel(r.account) : '', r.months.length === 1 ? r.months[0] : r.months.length ? `${r.months[0]} to ${r.months[r.months.length - 1]}` : '', r.fy ? `FY${r.fy}` : '', r.included ? 'Yes' : 'NO', r.note || ''])].map((r) => r.map(q).join(',')).join('\r\n')}\r\n`;
}

