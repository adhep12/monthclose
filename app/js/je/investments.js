// The monthly unrealized gain JE for Tschetter (1171) and Delap (1170). One entry:
//   Dr/Cr the investment account   the change in value since it was last booked
//   Dr 8070 Bank Fees               the manager's fees since they were last booked (Tschetter)
//   Cr/Dr 8999 Investment Gain      the two together: the gain before fees
//
// Statements come late, so a month can be booked from the portal screenshots, which give the
// value but not the fees. "Since it was last booked":
// - Value: this month's ending less the latest earlier ending the app has (a skipped month is
//   picked up), less money moved in or out (booked by its own entry, e.g. Fidelity → Cass).
// - Fees: only a Schwab statement books them. The advisor bills monthly, but statements come late
//   and a month is often booked before its statement arrives. The statement's expenses are
//   calendar year to date, so the fees to book are that figure less what the GL has booked to
//   8070 in Tschetter entries earlier this calendar year. A screenshot month books no fees; the
//   next statement catches them up, and so does any month booked short. A month whose GL isn't
//   in the app can't be counted, so it's flagged and the JE still built.

import { round2 } from '../money.js';
import { addMonths, lastDayOfMonth } from '../fiscal.js';
import { fidelityTransfers } from '../poc/calc.js';

export const INVESTMENT_JE = {
  tschetter: { account: '1171', name: 'Tschetter Group', fees: true },
  delap: { account: '1170', name: 'Delap', fees: false },
};
const GAIN = { account: '8999', sub: '000-000' };
const FEES = { account: '8070', sub: '013-000' };
// {date} is the month end (4-30-2026); {fees} ", fees Feb-Apr 2026" when fees are booked.
export const investmentTemplate = (id) => {
  const desc = `Unrealized Gains - ${INVESTMENT_JE[id].name} {date}{fees}`;
  return [{ key: 'value', account: INVESTMENT_JE[id].account, sub: '000-000', desc }, { key: 'gain', ...GAIN, desc },
    ...(INVESTMENT_JE[id].fees ? [{ key: 'fees', ...FEES, desc }] : [])];
};
const LOOKBACK = 24;
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (m) => `${SHORT[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
export const monthSpan = (a, b) => (a === b ? short(a) : `${SHORT[Number(a.slice(5)) - 1]}-${short(b)}`);
export const fillVars = (t, vars = {}) => String(t).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const dateText = (m) => { const [y, mo, d] = lastDayOfMonth(m).split('-').map(Number); return `${mo}-${d}-${y}`; };

// A month's year-to-date fees, from its Schwab statement or typed from a scanned one. Null when
// the month was booked from screenshots.
export const feesYtdOf = (rec, id = 'tschetter') => rec?.bankStatements?.[id]?.feesYtd ?? rec?.bank?.[id]?.feesYtd ?? null;
const endingOf = (rec, id) => rec?.bank?.[id]?.ending ?? null;
function netDepositsOf(rec, id) {
  if (!rec) return 0;
  const typed = rec.bank?.[id]?.netDeposits;
  if (typed != null) return typed;
  return id === 'delap' ? -(fidelityTransfers(rec).total || 0) : 0;
}

// Fees still to book at `month`: its statement's year to date less what the GL booked to 8070
// in this account's entries from January to last month. `missing` lists the months in that span
// with no GL in the app; their fees, if any, aren't counted.
export function feesSince(id, month, ytd, { glBy = {} } = {}) {
  const year = month.slice(0, 4);
  let booked = 0, last = null;
  const missing = [];
  for (let m = `${year}-01`; m < month; m = addMonths(m, 1)) {
    if (!Array.isArray(glBy[m]?.investmentGl)) { missing.push(m); continue; }
    for (const g of glBy[m].investmentGl) if (g.account === id && g.fee) { booked += g.fee; last = m; }
  }
  booked = round2(booked);
  const basis = last
    ? `year to date ${ytd.toFixed(2)} less ${booked.toFixed(2)} the GL booked to 8070 in ${year} through ${short(last)}`
    : `year to date ${ytd.toFixed(2)}, nothing booked to 8070 yet in ${year}`;
  return { fees: round2(ytd - booked), booked, first: last ? addMonths(last, 1) : `${year}-01`, basis, missing };
}

// Returns null when the month has no ending value yet, else
// { lines, problems, notes, working }.
export function investmentJe(id, month, { recs = {}, glBy = {} } = {}) {
  const cfg = INVESTMENT_JE[id];
  const rec = recs[month];
  const ending = endingOf(rec, id);
  if (ending == null) return null;
  const problems = [], notes = [];

  let prior = rec.bank[id].priorEnding ?? null, from = null;
  if (prior == null) {
    for (let k = 1; k <= LOOKBACK && prior == null; k++) {
      const m = addMonths(month, -k);
      if (endingOf(recs[m], id) != null) { prior = endingOf(recs[m], id); from = m; }
    }
  }
  if (prior == null) problems.push('No earlier ending value to work from. Type last month’s ending value.');
  if (from && from !== addMonths(month, -1)) notes.push(`No ending value for ${monthSpan(addMonths(from, 1), addMonths(month, -1))}: the change is from ${short(from)}’s ${prior.toFixed(2)}, so those months are included.`);
  let net = 0;
  for (let m = from ? addMonths(from, 1) : month; m <= month; m = addMonths(m, 1)) net += netDepositsOf(recs[m], id);
  net = round2(net);
  const change = prior == null ? 0 : round2(ending - prior - net);

  // The statement's (or screenshot's) own beginning value, when it isn't where the last booking
  // left off: the JE still books from the last booking, so the account ends at the right value.
  const beginning = rec.bankStatements?.[id]?.beginning ?? rec.bank[id].beginning ?? null;
  if (beginning != null && prior != null && round2(beginning - prior)) {
    notes.push(`This month starts at ${beginning.toFixed(2)}, not the ${prior.toFixed(2)} last booked (${round2(beginning - prior).toFixed(2)} apart). The JE books the change from ${prior.toFixed(2)}, so ${cfg.account} ends at ${ending.toFixed(2)}.`);
  }

  let fee = null;
  const ytd = cfg.fees ? feesYtdOf(rec, id) : null;
  if (ytd != null) {
    fee = feesSince(id, month, ytd, { glBy });
    if (fee.fees < 0) problems.push(`Fees come out negative (${fee.basis}). Check the year-to-date expenses.`);
    if (fee.missing.length) notes.push(`No GL in the app for ${fee.missing.map(short).join(', ')}: any fees booked to 8070 then aren’t counted, so the fees here may be too high. Load that GL to check.`);
    // A statement from last calendar year that wasn't December leaves that year's last months out.
    for (let m = addMonths(`${month.slice(0, 4)}-01`, -1), k = 0; k < 12; m = addMonths(m, -1), k++) {
      if (feesYtdOf(recs[m], id) == null) continue;
      if (!m.endsWith('-12')) notes.push(`Fees after ${short(m)} to Dec ${m.slice(0, 4)} aren’t in this year’s figures. Attach the December ${m.slice(0, 4)} statement to book them.`);
      break;
    }
  }

  const fees = fee && fee.fees > 0 ? fee.fees : 0;
  const vars = { date: dateText(month), fees: fees ? `, fees ${monthSpan(fee.first, month)}` : '' };
  const T = Object.fromEntries(investmentTemplate(id).map((t) => [t.key, t]));
  const lines = [];
  const push = (key, debit) => {
    const { account, sub, desc } = T[key];
    const v = round2(debit);
    if (v) lines.push({ key, account, sub, debit: v > 0 ? v : 0, credit: v < 0 ? -v : 0, tranDescription: fillVars(desc, vars), vars });
  };
  push('value', change);
  push('gain', -(change + fees));
  if (fees) push('fees', fees);

  const gl = (glBy[month]?.investmentGl || []).filter((g) => g.account === id);
  if (gl.length) notes.push(`The GL already has ${gl.map((g) => `${g.batch} (${cfg.account} ${g.value.toFixed(2)}${g.fee ? `, fees ${g.fee.toFixed(2)}` : ''})`).join(', ')} this month.`);

  return { lines, problems, notes, working: { beginning, ending, prior, from, net, change, fees, feeBasis: fee?.basis || null, feeMonths: fees ? monthSpan(fee.first, month) : null, ytd } };
}
