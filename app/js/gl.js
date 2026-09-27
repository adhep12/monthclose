// Acumatica "GL Register Detailed" export → net activity per account per month.
//
// The report is batch-grouped: a header row per batch (period like '10-2026', module, batch #,
// date, status, description), then one row per line (customer/vendor, account, subaccount, …,
// identifier like 'GL GL018616 3', debit, credit), then a "Batch Total" row.

import { cellAt, text, num } from './xlsx-io.js';
import { fromPeriod } from './fiscal.js';
import { round2 } from './money.js';

export function parseGlRegister(XLSX, wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const at = (r, c) => cellAt(XLSX, ws, r, c);
  if (!/GL Register/i.test(text(at(0, 0)))) throw new Error('This doesn’t look like a GL Register Detailed export.');

  const periods = {};
  let period = null, module = null, lines = 0;
  for (let r = range.s.r; r <= range.e.r; r++) {
    const a = text(at(r, 0));
    if (/^\d{2}-\d{4}$/.test(a)) { period = a; module = text(at(r, 1)); continue; }
    const ident = text(at(r, 7));
    if (!period || !module || !ident.startsWith(`${module} `)) continue;
    const acct = text(at(r, 1));
    if (!/^\d{4}$/.test(acct)) continue;
    const net = (num(at(r, 8)) || 0) - (num(at(r, 9)) || 0);
    const m = fromPeriod(period);
    const p = periods[m] || (periods[m] = { month: m, period, accounts: {}, lines: 0 });
    p.accounts[acct] = (p.accounts[acct] || 0) + net;
    p.lines++;
    lines++;
  }
  for (const p of Object.values(periods)) {
    for (const k of Object.keys(p.accounts)) p.accounts[k] = round2(p.accounts[k]);
  }
  if (!lines) throw new Error('No journal lines found in that file.');
  const header = (label) => {
    for (let r = 0; r < 6; r++) for (let c = 0; c < 10; c++) if (new RegExp(`^${label}`, 'i').test(text(at(r, c)))) return text(at(r, c + 1));
    return null;
  };
  return { periods: Object.values(periods).sort((x, y) => x.month.localeCompare(y.month)), lines,
    runAt: header('Date:'), fromPeriod: header('From Period:'), toPeriod: header('To Period:') };
}
