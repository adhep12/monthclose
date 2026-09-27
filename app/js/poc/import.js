// Reads the existing "Proof of Cash - YYYY" workbook into month records, so the app has the
// fiscal year's history (and each month's deposits in transit to compute the next change from).
//
// Summary sheet: row 1 has month names; each month takes two columns (revenue, then interest).
// Rows are found by their label in column B, not by position. Supporting Details: a header row of
// months starting with the prior September, check deposits in transit listed beneath, then "Total".

import { cellAt, text, num } from '../xlsx-io.js';
import { fyStart, addMonths, toMonth } from '../fiscal.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function monthIndex(s) {
  const t = s.toLowerCase().trim();
  const i = MONTHS.findIndex((m) => t.startsWith(m.slice(0, 3)));
  return i < 0 ? null : i + 1;
}

const BANK_ROWS = [
  [/^wise$/i, 'wise'], [/^paypal$/i, 'paypal'], [/^stripe$/i, 'stripe'],
  [/^keybank operating/i, 'keyOp'], [/^keybank money market/i, 'keyMM'],
  [/^cass money market|^ics/i, 'ics'], [/^cass cd$/i, 'cd'], [/^delap/i, 'delap'],
  [/^tschetter/i, 'tschetter'], [/^cass operating$/i, 'cassOp'],
];

export function findPocSheets(wb) {
  const summary = wb.SheetNames.find((n) => /proof of cash/i.test(n));
  const support = wb.SheetNames.find((n) => /supporting/i.test(n));
  return { summary, support };
}

export function parsePocWorkbook(XLSX, wb) {
  const { summary, support } = findPocSheets(wb);
  if (!summary) throw new Error('No “Proof of Cash Summary” sheet in that workbook.');
  const fy = Number((summary.match(/(20\d\d)/) || [])[1]);
  if (!fy) throw new Error(`Couldn’t tell the fiscal year from the sheet name “${summary}”.`);
  const ws = wb.Sheets[summary];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const at = (r, c) => cellAt(XLSX, ws, r, c);
  const warnings = [];

  // Month columns: revenue column = the one whose header is just a month name.
  const cols = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    const hdr = text(at(0, c));
    if (!hdr || /interest/i.test(hdr)) continue;
    const mi = monthIndex(hdr);
    if (mi == null) continue;
    const m = mi >= 10 ? toMonth(fy - 1, mi) : toMonth(fy, mi);
    cols.push({ month: m, rev: c, int: c + 1 });
  }
  if (!cols.length) throw new Error('Couldn’t find the month columns in row 1.');

  const records = Object.fromEntries(cols.map((k) => [k.month, {
    month: k.month, bank: {}, adjustments: [], dit: [], timing: {}, gl: {}, excluded: {}, statements: {},
    source: { kind: 'import', file: 'Proof of Cash workbook' },
  }]));

  let adjStart = null, adjEnd = null, glRevDone = false;
  for (let r = range.s.r; r <= range.e.r; r++) {
    const label = text(at(r, 1));
    if (!label) continue;
    const bank = BANK_ROWS.find(([re]) => re.test(label));
    if (bank && adjStart == null) {
      for (const k of cols) {
        const rev = num(at(r, k.rev)), int = num(at(r, k.int));
        if (rev != null || int != null) records[k.month].bank[bank[1]] = { rev, int };
      }
      continue;
    }
    if (/accrued interest/i.test(label) && /^plus/i.test(label)) cols.forEach((k) => { records[k.month].timing.accrued = num(at(r, k.int)) ?? undefined; });
    else if (/realized accrued interest/i.test(label)) cols.forEach((k) => { records[k.month].timing.realizedPrior = num(at(r, k.int)) ?? undefined; });
    else if (/restricted revenue/i.test(label)) cols.forEach((k) => { records[k.month].timing.restricted = num(at(r, k.rev)) ?? undefined; });
    else if (/^merchandise ar/i.test(label)) cols.forEach((k) => { records[k.month].timing.merchAR = num(at(r, k.rev)) ?? undefined; });
    else if (/^total gl revenue/i.test(label) && !glRevDone && cols.some((k) => num(at(r, k.rev)) != null)) {
      glRevDone = true;
      cols.forEach((k) => { const v = num(at(r, k.rev)); if (v != null) records[k.month].gl.revenue = v; });
    } else if (/^total gl interest/i.test(label)) cols.forEach((k) => { const v = num(at(r, k.int)); if (v != null) records[k.month].gl.interest = v; });
    else if (/^\(/.test(label) && adjStart == null) adjStart = r;
    else if (/^ytd revenue check/i.test(label) && adjStart != null) { adjEnd = r; break; }
  }

  // The itemized adjustments (the rows that add up to "Cass Operating - Total Adjustments").
  if (adjStart != null) {
    for (let r = adjStart; r < (adjEnd ?? range.e.r); r++) {
      const label = text(at(r, 1)).replace(/^\(|\)$/g, '').trim();
      if (!label) continue;
      for (const k of cols) {
        const v = num(at(r, k.rev));
        if (v) records[k.month].adjustments.push({ id: `imp-${r + 1}`, label, amount: v, note: 'From the workbook' });
      }
    }
  }

  // Deposits in transit, including the prior September (which the October change needs).
  if (support) {
    const ss = wb.Sheets[support];
    const sr = XLSX.utils.decode_range(ss['!ref']);
    const sat = (r, c) => cellAt(XLSX, ss, r, c);
    let hdr = -1;
    for (let r = sr.s.r; r <= Math.min(sr.e.r, 15) && hdr < 0; r++) {
      if (/sept?\.? ?20\d\d/i.test(text(sat(r, 2)))) hdr = r;
    }
    if (hdr < 0) warnings.push('Couldn’t find the deposits-in-transit table on the Supporting Details sheet.');
    else {
      const first = fyStart(fy); // column C is the prior September, D is October…
      for (let c = 2; c <= sr.e.c; c++) {
        const m = addMonths(first, c - 3);
        if (!records[m]) records[m] = { month: m, bank: {}, adjustments: [], dit: [], timing: {}, gl: {}, excluded: {}, statements: {}, source: { kind: 'import', file: 'Proof of Cash workbook', ditOnly: true } };
        for (let r = hdr + 1; r <= sr.e.r; r++) {
          if (/^total/i.test(text(sat(r, 0)))) break;
          const v = num(sat(r, c));
          if (v) records[m].dit.push({ id: `imp-${r + 1}`, amount: v, note: 'From the workbook' });
        }
      }
    }
  }

  return { fiscalYear: fy, records: Object.values(records).sort((a, b) => a.month.localeCompare(b.month)), warnings };
}
