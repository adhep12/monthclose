// The three reports behind the monthly inventory tie-out:
//   - Extensiv "InventoryGridExport" (Renewal Logistics' warehouse): units on hand by SKU
//   - the Merch Distribution Sheet: merch taken out for departments, by month ("Johanna Input"),
//     with item costs and category → account ("Reference")
//   - Salesforce "Product Sales By Product & Month": merch sold through Stripe, by month

import { num } from '../xlsx-io.js';
import { toMonth } from '../fiscal.js';
import { round2 } from '../money.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthOf = (name, year) => { const i = MONTHS.indexOf(String(name).trim().toLowerCase()); return i < 0 || !year ? null : toMonth(Number(year), i + 1); };
const rows = (XLSX, ws) => XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });

// Units per SKU: the sum of "Available Primary", as the tie-out has always used.
export function parseInventoryGrid(XLSX, wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const all = rows(XLSX, ws);
  const head = all.findIndex((r) => r.some((c) => /^available primary$/i.test(String(c).trim())));
  if (head < 0) throw new Error('This doesn’t look like an Extensiv inventory grid export (no “Available Primary” column).');
  const h = all[head].map((c) => String(c).trim().toLowerCase());
  const col = { sku: h.indexOf('sku'), desc: h.indexOf('description'), units: h.indexOf('available primary'), hold: h.indexOf('hold status'), wh: h.indexOf('warehouse') };
  const items = [];
  for (const r of all.slice(head + 1)) {
    const sku = String(r[col.sku] ?? '').trim();
    if (!sku) continue;
    items.push({ sku, desc: String(r[col.desc] ?? '').trim(), units: Number(r[col.units]) || 0, hold: String(r[col.hold]).toUpperCase() === 'TRUE', warehouse: String(r[col.wh] ?? '').trim() });
  }
  const units = {};
  for (const it of items) units[it.sku] = (units[it.sku] || 0) + it.units;
  return { items, units, warehouse: items[0]?.warehouse || '' };
}

// "People - 021" → '021'; "New Hire Gift - 817" → '817'.
const code = (s) => (String(s || '').match(/(\d{3})\s*$/) || [])[1] || '';

// The month's merch handed out, as the tie-out's department reclass reads it:
//   { dept, grant, sub, item, qty, cost, category, account, info }
// The subaccount is department-grant; Patron Care with no grant is 020-320.
export function parseDistribution(XLSX, wb) {
  const input = wb.Sheets['Johanna Input'];
  const ref = wb.Sheets.Reference;
  if (!input) throw new Error('This doesn’t look like the Merch Distribution Sheet (no “Johanna Input” tab).');
  const accounts = {}, items = {};
  if (ref) {
    for (const r of rows(XLSX, ref).slice(1)) {
      const [name, cost, cat] = [String(r[0] ?? '').trim(), r[1], String(r[2] ?? '').trim()];
      if (name) items[name] = { cost: typeof cost === 'number' ? cost : null, category: cat };
      const [acct, catName] = [String(r[11] ?? '').trim(), String(r[12] ?? '').trim()];
      if (catName && catName !== 'Account Name') accounts[catName] = /^\d{4}$/.test(acct) ? acct : null;
    }
  }
  const months = {};
  for (const r of rows(XLSX, input).slice(1)) {
    const m = monthOf(r[1], r[0]);
    const item = String(r[4] ?? '').trim();
    if (!m || !item) continue;
    const dept = String(r[2] ?? '').trim();
    const grant = String(r[3] ?? '').trim();
    const qty = Number(r[5]) || 0;
    const category = String(r[7] ?? '').trim() || items[item]?.category || '';
    // The sheet works out the cost (cost per item × quantity); it's read as saved.
    let cost = typeof r[6] === 'number' ? r[6] : num({ v: r[6] });
    if (cost == null && items[item]?.cost != null) cost = items[item].cost * qty;
    const d = code(dept);
    months[m] ||= [];
    months[m].push({ dept, grant, sub: `${d || '000'}-${code(grant) || (/^patron care/i.test(dept) && d === '020' ? '320' : '000')}`,
      item, qty, cost: round2(cost || 0), category, account: accounts[category] ?? null, info: String(r[8] ?? '').trim() });
  }
  return { months, accounts, items };
}

// Product sales by month: { 'YYYY-MM': { 'Product name': { qty, total } } }.
export function parseProductSales(XLSX, wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const all = rows(XLSX, ws);
  // The header row reads "Close Date →" then the months (not the filter lines above it).
  const isHead = (c) => /^close date\s*(→|->)?$/i.test(String(c).trim());
  const hr = all.findIndex((r) => r.some(isHead));
  if (hr < 0) throw new Error('This doesn’t look like the Salesforce Product Sales By Product & Month report.');
  const cols = [];
  // A month heading is "October 2025", or a date when the file is read with dates.
  all[hr].forEach((c, i) => {
    if (c instanceof Date && !Number.isNaN(c.getTime())) { cols.push({ month: toMonth(c.getFullYear(), c.getMonth() + 1), c: i }); return; }
    const m = String(c).trim().match(/^([A-Za-z]+) (\d{4})$/);
    const mo = m && monthOf(m[1], m[2]);
    if (mo) cols.push({ month: mo, c: i });
  });
  if (!cols.length) throw new Error('Couldn’t find the months in the report’s header.');
  const nameCol = all[hr].findIndex(isHead);
  const months = Object.fromEntries(cols.map((x) => [x.month, {}]));
  const amt = (v) => (typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, '')) || 0);
  for (const r of all.slice(hr + 2)) {
    const name = String(r[nameCol] ?? '').trim();
    if (!name || /^total$/i.test(name) || /^(confidential|copyright)/i.test(name)) continue;
    for (const { month, c } of cols) {
      const qty = amt(r[c]), total = amt(r[c + 1]);
      if (qty || total) months[month][name] = { qty, total: round2(total) };
    }
  }
  return { months };
}
