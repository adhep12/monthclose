// CDARS schedule. One record per CD (collection "cds", key = the CD's account ID):
//   { id, last4, chain, term, effective, maturity, rate, principal,
//     earned:    { 'YYYY-MM': { amount, source: 'statement' | 'workbook' | 'export' | 'typed', by, at } },
//     stmtEarned:{ 'YYYY-MM-DD': amount }   // per statement, so re-uploading one can't double count
//     interestPaid, status: 'active' | 'matured', notes }
//
// GL 1150 = principal of the CDs open at month end + the interest they've earned so far
// (accrued monthly, Dr 1150 / Cr 4050). At maturity principal + interest rolls into the next CD
// inside 1150, so interest paid at maturity is "realized" but doesn't move the GL.

import { cellAt, text, num, isoDate } from '../xlsx-io.js';
import { round2, sum } from '../money.js';
import { addMonths, monthOfDate, lastDayOfMonth, toMonth, fyStart } from '../fiscal.js';

export const normalizeId = (s) => String(s || '').replace(/\D/g, '');
const earnedAmt = (cd, m) => cd.earned?.[m]?.amount || 0;

export function isOpenAtEndOf(cd, month) {
  const end = lastDayOfMonth(month);
  return !!cd.effective && cd.effective <= end && (!cd.maturity || cd.maturity > end);
}

export function earnedThrough(cd, month) {
  return round2(sum(Object.entries(cd.earned || {}).filter(([m]) => m <= month), ([, e]) => e.amount || 0));
}

export function monthSummary(cds, month) {
  const rows = cds.map((cd) => ({
    cd,
    earned: earnedAmt(cd, month),
    paid: cd.maturity && monthOfDate(cd.maturity) === month ? cd.interestPaid || 0 : 0,
    open: isOpenAtEndOf(cd, month),
  }));
  const open = rows.filter((r) => r.open);
  return {
    month,
    accrued: round2(sum(rows, (r) => r.earned)),
    realized: round2(sum(rows, (r) => r.paid)),
    principal: round2(sum(open, (r) => r.cd.principal || 0)),
    unpaidInterest: round2(sum(open, (r) => earnedThrough(r.cd, month))),
    balance: round2(sum(open, (r) => (r.cd.principal || 0) + earnedThrough(r.cd, month))),
    rows: rows.filter((r) => r.earned || r.paid || r.open),
  };
}

// Rough check against the statement: simple interest on principal for the days in the month.
export function expectedInterest(cd, month) {
  if (!cd.rate || !cd.principal || !cd.effective) return null;
  const start = Math.max(Date.parse(`${month}-01`), Date.parse(cd.effective));
  const endDay = Date.parse(lastDayOfMonth(month)) + 86400000;
  const end = cd.maturity ? Math.min(endDay, Date.parse(cd.maturity)) : endDay;
  const days = Math.max(0, Math.round((end - start) / 86400000));
  return round2(cd.principal * cd.rate * days / 365);
}

export function applyCdarsStatement(cds, stmt, { user = '', file = '' } = {}) {
  const byId = new Map(cds.map((c) => [c.id, c]));
  const touched = [];
  for (const a of stmt.accounts) {
    const id = normalizeId(a.accountId);
    const cd = byId.get(id) || { id, last4: id.slice(-4), earned: {}, stmtEarned: {}, status: 'active' };
    if (!byId.has(id)) { cds.push(cd); byId.set(id, cd); }
    cd.effective = a.effective || cd.effective;
    cd.maturity = a.maturity || cd.maturity;
    cd.rate = a.rate ?? cd.rate;
    cd.term = a.term || cd.term;
    const principal = a.opening > 0 ? a.opening : a.ending > 0 && !cd.principal ? a.ending : null;
    if (principal) cd.principal = principal;
    cd.stmtEarned = { ...(cd.stmtEarned || {}), [stmt.date]: a.earnedSinceLast || 0 };
    const m = stmt.month;
    const fromStatements = round2(sum(Object.entries(cd.stmtEarned).filter(([d]) => d.startsWith(m)), ([, v]) => v));
    cd.earned = { ...(cd.earned || {}), [m]: { amount: fromStatements, source: 'statement', by: user, at: new Date().toISOString(), file } };
    if (a.matured) { cd.status = 'matured'; cd.interestPaid = a.interestPaid || a.ytdPaid || cd.interestPaid || 0; }
    touched.push(cd);
  }
  return touched;
}

// IntraFi export run on the 1st: accrued interest on each open CD is through the prior month end,
// so that month's interest = accrued − what's already been recorded for earlier months.
// CDs that matured in the month without a statement are flagged, not guessed.
export function applyIntrafiExport(cds, exp, month, { user = '' } = {}) {
  const notes = [];
  for (const row of exp.rows.filter((r) => r.service === 'CDARS')) {
    const cd = cds.find((c) => c.last4 === row.last4 && (c.maturity === row.maturity || !row.maturity));
    if (row.status === 'Active') {
      if (!cd) { notes.push(`CD …${row.last4} (${money2(row.principal)}, matures ${row.maturity}) isn’t in the schedule yet — upload its CDARS statement or add it.`); continue; }
      const prior = earnedThrough({ ...cd, earned: Object.fromEntries(Object.entries(cd.earned || {}).filter(([m]) => m < month)) }, addMonths(month, -1));
      cd.earned = { ...(cd.earned || {}), [month]: { amount: round2(row.accrued - prior), source: 'export', by: user, at: new Date().toISOString() } };
      if (!cd.principal) cd.principal = row.principal;
    } else if (cd && row.maturity && monthOfDate(row.maturity) === month && !cd.earned?.[month]) {
      notes.push(`CD …${row.last4} matured ${row.maturity}. Its final interest isn’t in the export — upload the maturity statement.`);
    }
  }
  return notes;
}
const money2 = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

// ---- Import from "CDARS Interest Calculation - Rolling" -------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthIdx = (s) => { const i = MONTHS.findIndex((m) => String(s).toLowerCase().trim().startsWith(m.slice(0, 3))); return i < 0 ? null : i + 1; };

export function parseCdarsWorkbook(XLSX, wb) {
  const sheetName = [...wb.SheetNames].sort().reverse().find((n) => /^\d{4}$/.test(n.trim())) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const at = (r, c) => cellAt(XLSX, ws, r, c);
  const cds = new Map();
  const warnings = [];

  // Summary table: Letter | Account ID | Effective | Maturity | Rate | Opening Balance | status
  let hdr = -1;
  for (let r = 0; r < 20 && hdr < 0; r++) if (/account id/i.test(text(at(r, 2)))) hdr = r;
  if (hdr < 0) throw new Error('Couldn’t find the CD summary table (an “Account ID” header in column C).');
  for (let r = hdr + 1; r <= range.e.r; r++) {
    const idText = text(at(r, 2));
    if (!/^\d{6}-\d{4}$/.test(idText)) { if (!idText && !text(at(r, 1))) break; continue; }
    const id = normalizeId(idText);
    cds.set(id, {
      id, last4: id.slice(-4), chain: text(at(r, 1)), effective: isoDate(at(r, 3)), maturity: isoDate(at(r, 4)),
      rate: num(at(r, 5)), principal: num(at(r, 6)), status: /matured/i.test(text(at(r, 7))) ? 'matured' : 'active',
      earned: {}, stmtEarned: {}, interestPaid: 0,
    });
  }

  // Fiscal-year blocks: a "Fiscal Year YYYY" / "FY YYYY" label in column B, CD IDs across the
  // same row or the next, then one row per month.
  for (let r = 0; r <= range.e.r; r++) {
    const fyM = text(at(r, 1)).match(/^(?:fiscal year|fy)\s*(\d{4})/i);
    if (!fyM) continue;
    const fy = Number(fyM[1]);
    let idRow = -1;
    for (const rr of [r, r + 1]) {
      for (let c = 2; c <= range.e.c; c++) if (/^\d{6}-\d{4}$/.test(text(at(rr, c)))) { idRow = rr; break; }
      if (idRow >= 0) break;
    }
    if (idRow < 0) continue;
    const idCols = [];
    for (let c = 2; c <= range.e.c; c++) {
      const t = text(at(idRow, c));
      if (/^\d{6}-\d{4}$/.test(t)) idCols.push({ c, id: normalizeId(t) });
    }
    for (let rr = idRow + 1; rr <= Math.min(range.e.r, idRow + 16); rr++) {
      const label = text(at(rr, 1));
      if (/^total/i.test(label)) break;
      const mi = monthIdx(label);
      if (mi == null) continue;
      const m = mi >= 10 ? toMonth(fy - 1, mi) : toMonth(fy, mi);
      for (const { c, id } of idCols) {
        const v = num(at(rr, c));
        if (!v) continue;
        const cd = cds.get(id);
        if (!cd) { warnings.push(`Interest for ${id} in ${m} but that CD isn’t in the summary table.`); continue; }
        cd.earned[m] = { amount: round2((cd.earned[m]?.amount || 0) + v), source: 'workbook' };
      }
      r = Math.max(r, rr);
    }
  }

  for (const cd of cds.values()) {
    if (cd.status === 'matured') cd.interestPaid = round2(sum(Object.values(cd.earned), (e) => e.amount));
  }
  return { sheetName, cds: [...cds.values()], warnings };
}

// One JE line pair per CD: Dr 1150 / Cr 4050 "Interest Earned - 1234", as posted today.
export function cdInterestJE(cds, month, { cdAccount = '1150', incomeAccount = '4050', sub = '000-000', dept = '000 - General', names = {} } = {}) {
  const lines = [];
  for (const cd of cds) {
    const a = earnedAmt(cd, month);
    if (!a) continue;
    const tran = `Interest Earned - ${cd.last4}`;
    lines.push({ dept, account: cdAccount, description: names[cdAccount] || '', sub, debit: a > 0 ? a : 0, credit: a < 0 ? -a : 0, tranDescription: tran });
    lines.push({ dept, account: incomeAccount, description: names[incomeAccount] || '', sub, debit: a < 0 ? -a : 0, credit: a > 0 ? a : 0, tranDescription: tran });
  }
  return lines;
}

export function fyMonths(fy) {
  return Array.from({ length: 12 }, (_, i) => addMonths(fyStart(fy), i));
}
