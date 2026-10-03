// Acumatica "AP Aged Period-Sensitive (Detailed)" export, and its tie-out to Accounts Payable.
//
// The report is vendor-grouped: a vendor row (ID, name), a "Past Due" banner, a column header
// (Doc. Type · Ref. Number · Vendor Ref. · Branch · Due Date · Doc. Date · Current · 1 - 30 Days ·
// 31 - 60 Days · 61 - 90 Days · Over 90 Days · Balance), one row per open document, then
// "Vendor Total:". The last row is "Company Total:". The header gives the Financial Period
// ('12-2026' = September 2026) and the Aged On date.

import { cellAt, text, num, isoDate } from '../xlsx-io.js';
import { fromPeriod } from '../fiscal.js';
import { round2, sum } from '../money.js';

export const AP_ACCOUNT = '2010';
export const BUCKETS = [
  ['current', 'Current'], ['d30', '1–30 days'], ['d60', '31–60 days'], ['d90', '61–90 days'], ['over90', 'Over 90 days'],
];
const HEADS = { 'doc. type': 'type', 'ref. number': 'ref', 'vendor ref.': 'vendorRef', 'due date': 'due', 'doc. date': 'date',
  current: 'current', '1 - 30 days': 'd30', '31 - 60 days': 'd60', '61 - 90 days': 'd90', 'over 90 days': 'over90', balance: 'balance' };
const AMOUNTS = ['current', 'd30', 'd60', 'd90', 'over90', 'balance'];

export function parseApAging(XLSX, wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const at = (r, c) => cellAt(XLSX, ws, r, c);
  if (!/AP Aged/i.test(text(at(0, 0)))) throw new Error('This doesn’t look like an AP Aged Period-Sensitive export.');

  let period = null, agedOn = null, runAt = null;
  for (let r = 0; r < 6; r++) for (let c = range.s.c; c <= range.e.c; c++) {
    const t = text(at(r, c));
    if (/^financial period:?$/i.test(t)) period = text(at(r, c + 1));
    if (/^aged on:?$/i.test(t)) agedOn = isoDate(at(r, c + 1));
    if (/^date:?$/i.test(t)) runAt = text(at(r, c + 1));
  }
  if (!/^\d{2}-\d{4}$/.test(period || '')) throw new Error('Couldn’t read the Financial Period from the report header.');

  const vendors = [];
  let col = null, cols = null, vendor = null, total = null;
  const amounts = (r) => Object.fromEntries(AMOUNTS.map((k) => [k, round2(num(at(r, cols[k])) || 0)]));
  // Rows after the "Vendor · Vendor Name" heading. `col` is set by a vendor's column header and
  // cleared by its total, so a row with something in column A is a vendor before its header and a
  // document after it.
  let started = false;
  for (let r = range.s.r; r <= range.e.r; r++) {
    const a = text(at(r, 0));
    if (!started) { started = /^vendor$/i.test(a); continue; }
    if (/^doc\.? type$/i.test(a)) {
      col = {};
      for (let c = range.s.c; c <= range.e.c; c++) { const k = HEADS[text(at(r, c)).toLowerCase()]; if (k) col[k] = c; }
      cols = col;
      continue;
    }
    let label = null;
    for (let c = range.s.c; c <= range.e.c && !label; c++) if (/total:$/i.test(text(at(r, c)))) label = text(at(r, c));
    // (The company total comes after the last vendor's, with the last header's columns.)
    if (label && cols) {
      if (/^company/i.test(label)) total = amounts(r);
      else if (vendor) vendor.total = amounts(r);
      col = null;
      continue;
    }
    if (!a) continue;
    if (!col) { vendor = { id: a, name: text(at(r, 2)), docs: [], total: null }; vendors.push(vendor); continue; }
    if (vendor) vendor.docs.push({ type: a, ref: text(at(r, col.ref)), vendorRef: text(at(r, col.vendorRef)), due: isoDate(at(r, col.due)), date: isoDate(at(r, col.date)), ...amounts(r) });
  }
  if (!total) throw new Error('Couldn’t find the Company Total row.');
  return { period, month: fromPeriod(period), agedOn, runAt, vendors, total };
}

const days = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

// The tie-out: the report's total against GL 2010 (a credit balance, positive as the TB shows it),
// and every document with anything 61 days or more past due.
export function apTieOut(aging, glBalance) {
  const docTotal = round2(sum(aging.vendors.flatMap((v) => v.docs), (d) => d.balance));
  const exceptions = aging.vendors.flatMap((v) => v.docs.filter((d) => d.d90 || d.over90).map((d) => ({
    vendor: v.name, vendorId: v.id, ref: d.ref, vendorRef: d.vendorRef, due: d.due, amount: round2(d.d90 + d.over90), balance: d.balance,
    daysPastDue: d.due && aging.agedOn ? days(d.due, aging.agedOn) : null,
  }))).sort((x, y) => (y.daysPastDue ?? 0) - (x.daysPastDue ?? 0));
  const variance = glBalance == null ? null : round2(aging.total.balance - glBalance);
  return {
    total: aging.total.balance, glBalance, variance, ties: variance === 0,
    // The report's own arithmetic: its documents add up to its total.
    addsUp: docTotal === aging.total.balance,
    exceptions,
  };
}
