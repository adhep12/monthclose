// Reads the existing "Fixed Asset Listing" workbook (one sheet per fiscal year) into assets.
//
// The sheet's history uses a mix of conventions, so rather than re-deriving it we take each
// asset's "Remaining" value as the truth at the cutover month and carry the monthly amount
// forward from there (method FIXED). New assets added in the app use the real methods.
//
// Layout it expects (FA Listing FY26):
//   - a "Month Number" row; its value under the current year's column is how many months of the
//     fiscal year the sheet has been depreciated through
//   - a header row with Name / Date / Amount / Account # / Asset Life / Months /
//     Monthly Depreciation / "YYYY Total" columns / Remaining
//   - assets grouped in blocks, each ending in a "Total …" row that carries the asset account
//   - occasionally a subtotal row that itself depreciates (E = SUM(range) with a monthly amount);
//     the rows it sums are folded into it

import { cellAt, text, num, isoDate } from '../xlsx-io.js';
import { addMonths, fyStart, lastDayOfMonth } from '../fiscal.js';

export function listingSheets(wb) {
  return wb.SheetNames.filter((n) => /FA Listing/i.test(n));
}

export function defaultListingSheet(wb) {
  const withFy = listingSheets(wb)
    .map((n) => ({ n, fy: Number((n.match(/FY\s*(\d{2,4})/i) || [])[1]) }))
    .filter((x) => x.fy)
    .sort((a, b) => b.fy - a.fy);
  return withFy[0]?.n || listingSheets(wb)[0] || wb.SheetNames[0];
}

const acct = (s) => (String(s || '').match(/^\s*(\d{4})/) || [])[1] || '';

export function parseFaListing(XLSX, wb, sheetName = defaultListingSheet(wb)) {
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`There's no sheet called “${sheetName}” in that workbook.`);
  const range = XLSX.utils.decode_range(ws['!ref']);
  const warnings = [];
  const at = (r, c) => cellAt(XLSX, ws, r, c);

  // Header row and columns.
  let headerRow = -1;
  const col = {};
  const yearCols = [];
  for (let r = range.s.r; r <= Math.min(range.e.r, 40) && headerRow < 0; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (/^name$/i.test(text(at(r, c)))) { headerRow = r; break; }
    }
  }
  if (headerRow < 0) throw new Error('Couldn’t find the header row (a cell that says “Name”).');
  for (let c = range.s.c; c <= range.e.c; c++) {
    const h = text(at(headerRow, c)).toLowerCase().replace(/\s+/g, ' ');
    const y = h.match(/^(\d{4}) total$/);
    if (y) yearCols.push({ year: Number(y[1]), c });
    else if (h === 'name') col.name = c;
    else if (h === 'date') col.date = c;
    else if (h === 'amount') col.cost = c;
    else if (h === 'account #') col.account = c;
    else if (h === 'asset life') col.life = c;
    else if (h === 'months') col.months = c;
    else if (h === 'monthly depreciation') col.monthly = c;
    else if (h === 'remaining') col.remaining = c;
  }
  for (const k of ['name', 'cost', 'monthly']) {
    if (col[k] == null) throw new Error(`Couldn’t find the “${k}” column in the header row.`);
  }
  if (!yearCols.length) throw new Error('Couldn’t find any “YYYY Total” columns.');
  yearCols.sort((a, b) => a.year - b.year);
  const fy = yearCols[yearCols.length - 1].year;
  const fyCol = yearCols[yearCols.length - 1].c;

  // Months of the current fiscal year already depreciated.
  let monthsIn = null;
  for (let r = range.s.r; r < headerRow; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      if (/^month number$/i.test(text(at(r, c)))) monthsIn = num(at(r, fyCol));
    }
  }
  if (!(monthsIn >= 0 && monthsIn <= 12)) {
    throw new Error(`Couldn’t read how many months of FY${fy} are included (the “Month Number” row).`);
  }
  const cutover = addMonths(fyStart(fy), monthsIn - 1);

  const assets = [];
  const blocks = [];
  let pending = [];
  let pendingStart = headerRow + 1;

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const name = text(at(r, col.name));
    const costCell = at(r, col.cost);
    const cost = num(costCell);
    const monthly = num(at(r, col.monthly));
    const ownAcct = col.account != null ? acct(text(at(r, col.account))) : '';
    const sumRange = (costCell?.f || '').match(/SUM\(\s*[A-Z]+(\d+)\s*:\s*[A-Z]+(\d+)\s*\)/i);

    if (cost != null && monthly != null && name) {
      // An asset row — possibly a subtotal that depreciates in aggregate.
      if (sumRange) {
        const [lo, hi] = [Number(sumRange[1]) - 1, Number(sumRange[2]) - 1];
        const folded = pending.filter((a) => a.row >= lo && a.row <= hi);
        if (folded.length) {
          warnings.push(`Row ${r + 1} “${name}” is a subtotal that depreciates as one asset; its ${folded.length} detail rows were folded into it.`);
          pending = pending.filter((a) => !(a.row >= lo && a.row <= hi));
        }
      }
      pending.push({ row: r, name, cost, monthly, ownAcct,
        date: isoDate(at(r, col.date)), rawDate: text(at(r, col.date)),
        life: col.life != null ? num(at(r, col.life)) : null,
        months: col.months != null ? num(at(r, col.months)) : null,
        remaining: col.remaining != null ? num(at(r, col.remaining)) : null,
        yearTotal: yearCols.reduce((t, y) => t + (num(at(r, y.c)) || 0), 0) });
      continue;
    }

    const isTotal = cost != null && monthly == null && (ownAcct || /^total/i.test(name));
    if (!isTotal) continue;

    // Everything since the previous total belongs to this block. (The total's own SUM range
    // can't be trusted for this — "Server Grant" sums the detail rows but not the subtotal
    // row that actually depreciates.)
    const group = ownAcct || acct(name);
    const inBlock = pending;
    const isCip = /\bCIP\b|construction in progress/i.test(name);
    for (const p of inBlock) assets.push(toAsset(p, group || p.ownAcct, { fy, cutover, isCip, warnings }));
    blocks.push({ row: r, name, group, sheetCost: cost, count: inBlock.length,
      sheetRemaining: col.remaining != null ? num(at(r, col.remaining)) : null });
    pending = pending.filter((p) => !inBlock.includes(p));
    pendingStart = r + 1;
  }
  for (const p of pending) {
    warnings.push(`Row ${p.row + 1} “${p.name}” isn’t followed by a “Total” row, so it has no asset account. It was skipped.`);
  }
  void pendingStart;

  return { sheetName, fiscalYear: fy, monthsIn, cutover, assets, blocks, warnings };
}

function toAsset(p, group, { fy, cutover, isCip, warnings }) {
  let remaining = p.remaining;
  if (remaining == null) {
    remaining = p.cost - p.yearTotal;
    warnings.push(`Row ${p.row + 1} “${p.name}” has no Remaining value; used cost less the yearly totals.`);
  }
  if (Math.abs(remaining) < 0.01) remaining = 0;
  if (remaining < 0) warnings.push(`Row ${p.row + 1} “${p.name}” is over-depreciated by ${(-remaining).toFixed(2)}.`);
  if (remaining > p.cost + 0.005) warnings.push(`Row ${p.row + 1} “${p.name}” has more remaining than it cost.`);

  let inService = p.date;
  if (!inService) {
    inService = lastDayOfMonth(cutover);
    warnings.push(`Row ${p.row + 1} “${p.name}” has an unreadable date (“${p.rawDate}”); set to ${inService} — please correct it.`);
  }
  const lifeMonths = p.months || (p.life ? Math.round(p.life * 12) : null);

  return {
    id: `fy${String(fy).slice(-2)}-r${p.row + 1}`,
    name: p.name.replace(/\s+/g, ' ').trim(),
    group,
    cost: p.cost,
    salvage: 0,
    inService,
    lifeMonths,
    method: 'FIXED',
    convention: 'next-month',
    fixedMonthly: p.monthly,
    openingAD: p.cost - remaining,
    openingAsOf: cutover,
    status: isCip ? 'cip' : 'active',
    disposal: null,
    source: { kind: 'import', row: p.row + 1 },
  };
}
