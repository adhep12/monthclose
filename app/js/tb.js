// Acumatica "Trial Balance Summary" export.
//
// Beginning Balance is the balance at the end of the prior period, whenever in the month the
// report is run. So a TB for 12-2026 (September) gives August's closing balances in its
// Beginning Balance column — exactly what the September true-ups need.
//
// Signs as exported: debit-normal accounts positive; contra-assets (accumulated depreciation)
// negative on the Asset side; liabilities/net assets/income positive as credits.

import { cellAt, text, num } from './xlsx-io.js';
import { fromPeriod, addMonths } from './fiscal.js';

export function parseTrialBalance(XLSX, wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const at = (r, c) => cellAt(XLSX, ws, r, c);

  let period = null, runAt = null, headerRow = -1;
  const col = {};
  for (let r = range.s.r; r <= range.e.r && headerRow < 0; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const t = text(at(r, c));
      if (/^financial period:?$/i.test(t)) period = text(at(r, c + 1));
      if (/^date:?$/i.test(t)) runAt = text(at(r, c + 1));
      if (/^account$/i.test(t) && /beginning balance/i.test(rowText(at, r, range))) headerRow = r;
    }
  }
  if (headerRow < 0) throw new Error('This doesn’t look like a Trial Balance Summary export (no Account / Beginning Balance header).');
  if (!/^\d{2}-\d{4}$/.test(period || '')) throw new Error('Couldn’t read the Financial Period from the report header.');

  for (let c = range.s.c; c <= range.e.c; c++) {
    const h = text(at(headerRow, c)).toLowerCase();
    if (h === 'account') col.account = c;
    else if (h === 'type') col.type = c;
    else if (h === 'description') col.description = c;
    else if (h === 'beginning balance') col.begin = c;
    else if (h === 'debit') col.debit = c;
    else if (h === 'credit') col.credit = c;
    else if (h === 'ending balance') col.end = c;
  }

  const accounts = {};
  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const a = text(at(r, col.account));
    if (!/^\d{4}$/.test(a)) continue;
    accounts[a] = {
      type: text(at(r, col.type)),
      // Descriptions come as "Equipment - A/D  -  BUILDINGPROP"; drop the account-class suffix.
      description: text(at(r, col.description)).replace(/\s+-\s+[A-Z]+$/, '').trim(),
      begin: num(at(r, col.begin)) || 0,
      debit: num(at(r, col.debit)) || 0,
      credit: num(at(r, col.credit)) || 0,
      end: num(at(r, col.end)) || 0,
    };
  }
  const month = fromPeriod(period);
  return { period, month, runAt, accounts };
}

function rowText(at, r, range) {
  let s = '';
  for (let c = range.s.c; c <= range.e.c; c++) s += ' ' + text(at(r, c));
  return s;
}

// Balance of an account at the end of `month`, from a TB for that month (ending) or the month
// after (beginning). Returns null when the TB can't answer. Accounts missing from the TB were
// zero-balance suppressed, so they count as 0.
export function balanceAtEndOf(tb, account, month) {
  let v;
  if (tb.month === month) v = tb.accounts[account]?.end;
  else if (tb.month === addMonths(month, 1)) v = tb.accounts[account]?.begin;
  else return null;
  return v ?? 0;
}

export function accountNames(tb) {
  return Object.fromEntries(Object.entries(tb.accounts).map(([a, x]) => [a, x.description]));
}
