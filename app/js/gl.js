// Acumatica "GL Register Detailed" export → net activity per account per month.
//
// The report is batch-grouped: a header row per batch (period like '10-2026', module, batch #,
// date, status, description), then one row per line (customer/vendor, account, subaccount, …,
// identifier like 'GL GL018616 3', debit, credit), then a "Batch Total" row.

import { cellAt, text, num, isoDate } from './xlsx-io.js';
import { fromPeriod } from './fiscal.js';
import { round2 } from './money.js';

export function parseGlRegister(XLSX, wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const at = (r, c) => cellAt(XLSX, ws, r, c);
  if (!/GL Register/i.test(text(at(0, 0)))) throw new Error('This doesn’t look like a GL Register Detailed export.');

  const periods = {};
  let period = null, module = null, batch = null, lines = 0;
  for (let r = range.s.r; r <= range.e.r; r++) {
    const a = text(at(r, 0));
    if (/^\d{2}-\d{4}$/.test(a)) {
      period = a; module = text(at(r, 1));
      batch = { batch: text(at(r, 2)), module, date: isoDate(at(r, 3)), desc: text(at(r, 5)), accounts: {}, refunds: 0 };
      const m = fromPeriod(period);
      (periods[m] || (periods[m] = { month: m, period, accounts: {}, lines: 0, batches: [] })).batches.push(batch);
      continue;
    }
    const ident = text(at(r, 7));
    if (!period || !module || !ident.startsWith(`${module} `)) continue;
    const acct = text(at(r, 1));
    if (!/^\d{4}$/.test(acct)) continue;
    const net = (num(at(r, 8)) || 0) - (num(at(r, 9)) || 0);
    const m = fromPeriod(period);
    const p = periods[m];
    p.accounts[acct] = (p.accounts[acct] || 0) + net;
    batch.accounts[acct] = (batch.accounts[acct] || 0) + net;
    // PayPal gifts given back ("Payment Refund", a debit to 4012) inside the month's PayPal batch.
    // (A whole batch reversed out of the wrong period also debits 4012, but it isn't money given back.)
    if (acct === '4012' && net > 0 && /refund/i.test(text(at(r, 5)))) batch.refunds += net;
    p.lines++;
    lines++;
  }
  for (const p of Object.values(periods)) {
    for (const k of Object.keys(p.accounts)) p.accounts[k] = round2(p.accounts[k]);
    p.receipts = cashReceipts(p.batches);
    p.keyReceipts = cashReceipts(p.batches, KEYBANK_GL);
    p.wiseReceipts = cashReceipts(p.batches, WISE_GL);
    p.paypalRefunds = p.batches.filter((b) => b.refunds >= 0.005 && PAYPAL_GL in b.accounts)
      .map((b) => ({ batch: b.batch, date: b.date, desc: b.desc.slice(0, 120), amount: round2(b.refunds) }));
    p.noCashRevenue = noCashRevenue(p.batches);
    p.stripeReclass = stripeReclasses(p.batches);
    p.investmentFees = investmentFees(p.batches);
    p.investmentGl = investmentGl(p.batches);
    delete p.batches;
  }
  if (!lines) throw new Error('No journal lines found in that file.');
  const header = (label) => {
    for (let r = 0; r < 6; r++) for (let c = 0; c < 10; c++) if (new RegExp(`^${label}`, 'i').test(text(at(r, c)))) return text(at(r, c + 1));
    return null;
  };
  return { periods: Object.values(periods).sort((x, y) => x.month.localeCompare(y.month)), lines,
    runAt: header('Date:'), fromPeriod: header('From Period:'), toPeriod: header('To Period:') };
}

// Money into and out of Cass (1100) batch by batch, so deposits on the statements can be matched to
// how the GL booked them. Each batch keeps the accounts on its other side, net credit positive
// (what the deposit was booked to). AP batches that debit cash are mostly voided checks, which
// never reach a statement, but some are money paid back to us (a vendor refund); they're kept,
// marked, and only used when a deposit matches them.
//   { batch, date, desc, amount, accounts: { '4018': 12425 } }   amount > 0: money in
//                                                                amount < 0: money out, e.g. a
//                                                                reversal of revenue (chargeback)
export const CASS_GL = '1100';
export const KEYBANK_GL = '1061';
export const WISE_GL = '1013';
export const PAYPAL_GL = '1012';
// Accounts where revenue arrives as cash: a revenue entry with none of these on its other side
// had no cash this month (a sale on account, a gift reclassed to a liability).
const CASH_SIDE = ['1100', '1012', '1013', '1015', '1200', '1020', '1060', '1061', '2041'];
function cashReceipts(batches, cashGl = CASS_GL) {
  const out = [];
  for (const b of batches) {
    const cash = round2(b.accounts[cashGl] || 0);
    if (!cash) continue;
    const other = {};
    for (const [acct, net] of Object.entries(b.accounts)) if (acct !== cashGl && Math.abs(net) >= 0.005) other[acct] = round2(-net);
    // Only money in, and money out that takes revenue back (a chargeback, a deposit reclassed).
    if (cash < 0 && !Object.entries(other).some(([acct, v]) => /^4/.test(acct) && v < 0)) continue;
    out.push({ batch: b.batch, date: b.date, desc: b.desc.slice(0, 120), amount: cash, accounts: other, ...(b.module === 'AP' ? { ap: true } : {}) });
  }
  return out;
}

// Revenue entries with no cash on the other side: merchandise sold on account (Dr 1210), a gift
// reclassed to a liability (Cr 2052). Stripe's own reclasses are kept separately.
function noCashRevenue(batches) {
  const out = [];
  for (const b of batches) {
    if (/stripe/i.test(b.desc) || CASH_SIDE.some((a) => a in b.accounts)) continue;
    const accounts = {};
    for (const [acct, net] of Object.entries(b.accounts)) if (Math.abs(net) >= 0.005) accounts[acct] = round2(-net);
    if (!Object.keys(accounts).some((a) => /^40[1-8]\d$/.test(a))) continue;
    out.push({ batch: b.batch, date: b.date, desc: b.desc.slice(0, 120), accounts });
  }
  return out;
}

// Stripe sales the GL moves after booking the month's Stripe giving to 4015: merchandise to the
// merch revenue lines, shipping to 9050, sales tax to 2042, and now and then a stray Stripe
// transfer into giving. What leaves (or joins) revenue is an adjustment to the Stripe line.
function stripeReclasses(batches) {
  const out = [];
  for (const b of batches) {
    if (!/stripe/i.test(b.desc) || /Monthly Stripe Giving/i.test(b.desc) || b.accounts[CASS_GL] || !b.accounts['4015']) continue;
    const accounts = {};
    for (const [acct, net] of Object.entries(b.accounts)) if (Math.abs(net) >= 0.005) accounts[acct] = round2(-net);
    out.push({ batch: b.batch, date: b.date, desc: b.desc.slice(0, 120), accounts });
  }
  return out;
}

// Management fees taken out of an investment account. The GL books the month's gain from the
// statement's change in value, grossed up by the fee (Cr 8999), with the fee as an expense
// (Dr 8070) — so the fee is added back to the change in value. Tschetter bills quarterly.
export const INVESTMENT_GL = { 1170: 'delap', 1171: 'tschetter' };
function investmentFees(batches) {
  const out = [];
  for (const b of batches) {
    const acct = Object.keys(INVESTMENT_GL).find((a) => a in b.accounts);
    const fee = round2(b.accounts['8070'] || 0);
    if (acct && fee) out.push({ account: INVESTMENT_GL[acct], batch: b.batch, date: b.date, desc: b.desc.slice(0, 120), amount: fee });
  }
  return out;
}

// What the GL booked for each investment account's month: the change in value (Dr 1171), the gain
// (Cr 8999) and any fee (Dr 8070), batch by batch, so the gain worked out from the statements can
// be shown against it.
function investmentGl(batches) {
  const out = [];
  for (const b of batches) {
    const acct = Object.keys(INVESTMENT_GL).find((a) => a in b.accounts);
    if (!acct || !('8999' in b.accounts || '4050' in b.accounts)) continue;
    const gain = round2(-((b.accounts['8999'] || 0) + (b.accounts['4050'] || 0)));
    if (!gain && !b.accounts['8070']) continue;
    out.push({ account: INVESTMENT_GL[acct], batch: b.batch, date: b.date, desc: b.desc.slice(0, 120), value: round2(b.accounts[acct] || 0), gain, fee: round2(b.accounts['8070'] || 0) });
  }
  return out;
}

// Acumatica "Statement of Activities - Comparative" (Excel). Whole dollars. We keep each line's
// period-to-date and year-to-date actuals, plus the totals proof of cash compares against:
//   revenue  = Total Contributions + Total Merchandise Revenue + Total Other Income
//   interest = −(Net Interest Expense/Income)   (income shows as negative on the report)
export function parseStatementOfActivities(XLSX, wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const at = (r, c) => cellAt(XLSX, ws, r, c);
  let asOf = null;
  for (let r = 0; r < 8 && !asOf; r++) {
    const m = text(at(r, 0)).match(/As of\s+(\w+)\s+(\d{1,2}),\s+(\d{4})/i);
    if (m) {
      const mi = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].indexOf(m[1].toLowerCase()) + 1;
      asOf = `${m[3]}-${String(mi).padStart(2, '0')}`;
    }
  }
  if (!asOf || !/statement of activ/i.test(`${text(at(0, 0))} ${text(at(1, 0))}`)) throw new Error('This doesn’t look like the Statement of Activities export (no “As of …” date).');
  const lines = [];
  const totals = {};
  for (let r = 6; r <= range.e.r; r++) {
    const group = text(at(r, 0)), line = text(at(r, 1));
    const ptd = num(at(r, 2)), ytd = num(at(r, 5));
    if (line) lines.push({ line, ptd: ptd ?? 0, ytd: ytd ?? 0, budget: num(at(r, 3)) });
    else if (group && (ptd != null || ytd != null)) totals[group] = { ptd: ptd ?? 0, ytd: ytd ?? 0 };
  }
  const ptdOf = (label) => totals[label]?.ptd ?? 0;
  const interestLine = lines.find((l) => /net interest/i.test(l.line));
  return {
    month: asOf, lines, totals,
    revenueTotal: ptdOf('Total Contributions') + ptdOf('Total Merchandise Revenue') + ptdOf('Total Other Income'),
    interestTotal: interestLine ? -interestLine.ptd : 0,
  };
}
