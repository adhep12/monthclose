// Fixed assets by asset account over a span of months: cost and accumulated depreciation at the
// start, what was added, depreciated and disposed, and the end — the schedule the auditors ask for.
// The app knows depreciation from each asset's opening balance on (the listing it was imported
// from), so a span can't start before then.

import { accumThrough, depreciationFor, isDisposedBefore } from './engine.js';
import { DEFAULT_FA_CONFIG } from './je.js';
import { addMonths, monthOfDate } from '../fiscal.js';
import { round2, sum } from '../money.js';

const inServiceBy = (a, m) => !!a.inService && monthOfDate(a.inService) <= m;
const disposedIn = (a, from, to) => !!a.disposal?.date && monthOfDate(a.disposal.date) >= from && monthOfDate(a.disposal.date) <= to;

// The first month the app can account for: the month after the latest opening balance.
export function firstKnownMonth(assets) {
  const asOf = assets.map((a) => a.openingAsOf).filter(Boolean).sort().pop();
  return asOf ? addMonths(asOf, 1) : null;
}

export function rollForward(assets, from, to, config = DEFAULT_FA_CONFIG) {
  const before = addMonths(from, -1);
  const months = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) months.push(m);
  const groups = config.groups.map((g) => {
    const list = assets.filter((a) => a.group === g.asset);
    const open = list.filter((a) => inServiceBy(a, before) && !isDisposedBefore(a, from));
    const added = list.filter((a) => a.inService && monthOfDate(a.inService) >= from && monthOfDate(a.inService) <= to);
    const gone = list.filter((a) => disposedIn(a, from, to));
    const end = list.filter((a) => inServiceBy(a, to) && !(a.disposal?.date && monthOfDate(a.disposal.date) <= to));
    const r = {
      ...g,
      openCost: round2(sum(open, (a) => a.cost)),
      additions: round2(sum(added, (a) => a.cost)),
      disposals: round2(sum(gone, (a) => a.cost)),
      endCost: round2(sum(end, (a) => a.cost)),
      openAD: round2(sum(open, (a) => accumThrough(a, before))),
      depreciation: round2(sum(list, (a) => sum(months, (m) => (isDisposedBefore(a, m) ? 0 : depreciationFor(a, m))))),
      disposalAD: round2(sum(gone, (a) => accumThrough(a, monthOfDate(a.disposal.date)))),
      endAD: round2(sum(end, (a) => accumThrough(a, to))),
      count: end.length,
    };
    r.nbv = round2(r.endCost - r.endAD);
    // Opening + additions − disposals = ending, for both.
    r.ties = round2(r.openCost + r.additions - r.disposals - r.endCost) === 0 && round2(r.openAD + r.depreciation - r.disposalAD - r.endAD) === 0;
    return r;
  });
  return { from, to, groups };
}

// Rows for a workbook: the roll-forward, then every asset at `to`.
export function faSheets(assets, from, to, config = DEFAULT_FA_CONFIG) {
  const sheets = [];
  if (from <= to) {
    const rf = rollForward(assets, from, to, config);
    const head = ['Asset account', 'Name', 'Cost at start', 'Additions', 'Disposals', 'Cost at end', 'A/D at start', 'Depreciation', 'A/D on disposals', 'A/D at end', 'Net book value', 'Assets', 'Adds up'];
    const rows = [[`Fixed assets ${from} to ${to}`], [], head, ...rf.groups.map((g) => [g.asset, g.name, g.openCost, g.additions, g.disposals, g.endCost, g.openAD, g.depreciation, g.disposalAD, g.endAD, g.nbv, { v: g.count, z: '0' }, g.ties ? 'Yes' : 'NO'])];
    const t = (k) => round2(sum(rf.groups, (g) => g[k]));
    rows.push(['Total', '', t('openCost'), t('additions'), t('disposals'), t('endCost'), t('openAD'), t('depreciation'), t('disposalAD'), t('endAD'), t('nbv')]);
    sheets.push({ name: 'Roll-forward', rows, cols: [12, 32, 15, 13, 13, 15, 15, 13, 15, 15, 15, 8, 8] });
  }
  const list = [['Asset account', 'Name', 'In service', 'Cost', 'Life (months)', 'Method', 'Monthly', `A/D at ${to}`, 'Net book value', 'Disposed', 'Proceeds']];
  for (const a of [...assets].sort((x, y) => x.group.localeCompare(y.group) || String(x.inService).localeCompare(String(y.inService)))) {
    const ad = round2(accumThrough(a, a.disposal?.date && monthOfDate(a.disposal.date) <= to ? monthOfDate(a.disposal.date) : to));
    list.push([a.group, a.name, a.inService || '', a.cost, a.lifeMonths ? { v: a.lifeMonths, z: '0' } : null, a.method, a.method === 'FIXED' ? a.fixedMonthly : null, ad, round2(a.cost - ad), a.disposal?.date || '', a.disposal ? a.disposal.proceeds || 0 : null]);
  }
  sheets.push({ name: 'Asset listing', rows: list, cols: [12, 50, 11, 14, 8, 8, 12, 14, 14, 11, 12] });
  return sheets;
}
