// Depreciation engine. Pure functions only — no DOM, no storage — so the same code runs in the
// browser and in the node tests.
//
// An asset:
//   { id, name, group,               // group = asset GL account, e.g. '1540'
//     cost, salvage,                 // salvage defaults to 0
//     inService: 'YYYY-MM-DD',
//     lifeMonths,
//     method: 'SL' | 'DB200' | 'DB150' | 'FIXED',
//     convention: 'next-month' | 'full-month' | 'mid-month',
//     fixedMonthly,                  // FIXED only: the monthly amount carried over from the old sheet
//     openingAD, openingAsOf,        // accumulated depreciation through the end of month 'YYYY-MM'
//     disposal: { date, proceeds } } // optional
//
// Conventions:
//   next-month  — nothing in the month placed in service; a full month in the month of disposal.
//   full-month  — a full month in the month placed in service; nothing in the month of disposal.
//   mid-month   — half a month at each end.
//
// SL and DB amounts are rounded to cents each month and the final month absorbs the remainder.
// FIXED amounts are kept unrounded, the way the spreadsheet did it; the JE rounds per account.

import { addMonths, monthDiff, monthOfDate } from '../fiscal.js';
import { round2 } from '../money.js';

export const METHODS = {
  SL: 'Straight-line',
  DB200: 'Double declining balance',
  DB150: '150% declining balance',
  FIXED: 'Fixed monthly (carried over)',
};

export const CONVENTIONS = {
  'next-month': 'Start the month after',
  'full-month': 'Full month when placed in service',
  'mid-month': 'Half month at start and end',
};

const EPS = 0.004;

export function depreciableBase(a) {
  return (a.cost || 0) - (a.salvage || 0);
}

function startMonth(a) {
  const m = monthOfDate(a.inService);
  return a.convention === 'next-month' || !a.convention ? addMonths(m, 1) : m;
}

// Last month that gets depreciation because of a disposal, and the fraction of it.
function disposalCutoff(a) {
  if (!a.disposal?.date) return null;
  const dm = monthOfDate(a.disposal.date);
  switch (a.convention) {
    case 'full-month': return { month: addMonths(dm, -1), factor: 1 };
    case 'mid-month': return { month: dm, factor: 0.5 };
    default: return { month: dm, factor: 1 };
  }
}

// Month-by-month rows from the first depreciable month (or the month after the opening balance)
// through `through`, stopping early once fully depreciated or disposed.
export function schedule(a, through) {
  const base = depreciableBase(a);
  const rows = [];
  // Construction in progress isn't depreciated until it's placed in service.
  if (!(base > 0) || !a.inService || a.status === 'cip') return rows;

  const start = startMonth(a);
  const mid = a.convention === 'mid-month';
  const life = Math.max(1, Math.round(a.lifeMonths || 0));
  const totalMonths = mid ? life + 1 : life;
  const cut = disposalCutoff(a);

  let accum = 0;
  let i = 0;
  let m = start;

  if (a.openingAsOf != null && a.openingAD != null) {
    accum = a.openingAD;
    const skip = monthDiff(start, a.openingAsOf) + 1;
    if (skip > 0) { i = skip; m = addMonths(start, skip); }
  }

  const slMonthly = round2(base / life);
  const dbRate = a.method === 'DB200' ? 2 / life : a.method === 'DB150' ? 1.5 / life : 0;

  // Guard against runaway loops on odd data (e.g. a FIXED amount of 0.0001).
  for (let guard = 0; guard < 1200; guard++) {
    if (monthDiff(m, through) < 0) break;
    const remaining = base - accum;
    if (remaining <= EPS) break;
    if (cut && monthDiff(cut.month, m) > 0) break;

    let factor = 1;
    if (mid && i === 0) factor = 0.5;
    if (mid && i === totalMonths - 1) factor = 0.5;
    if (cut && m === cut.month) factor = Math.min(factor, cut.factor);

    let dep;
    const isLast = i >= totalMonths - 1;
    switch (a.method) {
      case 'FIXED':
        dep = (a.fixedMonthly || 0) * factor;
        break;
      case 'DB200':
      case 'DB150': {
        const monthsLeft = Math.max(1, totalMonths - i);
        const db = remaining * dbRate;
        const sl = remaining / monthsLeft;
        dep = round2(Math.max(db, sl) * factor);
        if (isLast && factor === 1) dep = remaining;
        break;
      }
      default:
        dep = round2(slMonthly * factor);
        if (isLast && !(cut && m === cut.month && cut.factor < 1)) dep = remaining;
    }
    if (dep > remaining) dep = remaining;
    if (dep <= 0) break;

    accum += dep;
    rows.push({ month: m, dep, accum, nbv: (a.cost || 0) - accum });
    i++;
    m = addMonths(m, 1);
  }
  return rows;
}

// Accumulated depreciation through the end of `month`. Before the opening balance month we
// don't know the history, so the opening balance is returned for any earlier month.
export function accumThrough(a, month) {
  const rows = schedule(a, month);
  if (rows.length) return rows[rows.length - 1].accum;
  return a.openingAD || 0;
}

export function depreciationFor(a, month) {
  const rows = schedule(a, month);
  const last = rows[rows.length - 1];
  return last && last.month === month ? last.dep : 0;
}

// Month in which the asset becomes fully depreciated, or null if it never does (disposed first).
export function fullyDepreciatedMonth(a) {
  const rows = schedule(a, addMonths(monthOfDate(a.inService || '2000-01-01'), 1300));
  const last = rows[rows.length - 1];
  if (!last) return a.openingAD >= depreciableBase(a) - EPS ? a.openingAsOf : null;
  return last.accum >= depreciableBase(a) - EPS ? last.month : null;
}

export function isDisposedBefore(a, month) {
  return !!a.disposal?.date && monthDiff(monthOfDate(a.disposal.date), month) > 0;
}

export function disposalSummary(a) {
  if (!a.disposal?.date) return null;
  const dm = monthOfDate(a.disposal.date);
  const accum = accumThrough(a, dm);
  const nbv = (a.cost || 0) - accum;
  const proceeds = a.disposal.proceeds || 0;
  return { month: dm, accum, nbv, proceeds, gainLoss: proceeds - nbv };
}

// Useful when adding a leasehold improvement: life = months from in-service to the lease end.
export function lifeFromEndDate(inService, endDate, convention = 'next-month') {
  const n = monthDiff(monthOfDate(inService), monthOfDate(endDate));
  return convention === 'full-month' ? n + 1 : Math.max(1, n);
}
