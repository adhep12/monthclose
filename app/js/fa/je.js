// Builds the monthly depreciation JE and disposal JEs in the shape of Acumatica's Journal
// Transactions grid, so the export can be loaded straight back in.

import { accumThrough, depreciationFor, isDisposedBefore, disposalSummary } from './engine.js';
import { round2, sum } from '../money.js';
import { monthOfDate } from '../fiscal.js';

// Column order matches the Journal Transactions export from Acumatica.
export const JE_COLUMNS = ['Department ID', 'Grant / Program ID', 'Account', 'Description',
  'Subaccount', 'Ref. Number', 'Quantity', 'UOM', 'Debit Amount', 'Credit Amount',
  'Transaction Description', 'Inventory ID', 'Customer/Vendor', 'DTF Anchor', 'Redistribution',
  'DTF Entry', 'Indirect Expense'];

export const DEFAULT_FA_CONFIG = {
  groups: [
    { asset: '1540', ad: '1541', name: 'Equipment' },
    { asset: '1552', ad: '1553', name: 'Imago Facilities Improvement (CIP)' },
    { asset: '1555', ad: '1556', name: 'Office Space & Commons A' },
    { asset: '1560', ad: '1561', name: 'Recording Studio' },
    { asset: '1570', ad: '1571', name: 'Commons B / Imago Kitchen LHI' },
    { asset: '1572', ad: '1573', name: 'Sound Stage' },
    { asset: '1574', ad: '1575', name: 'West Conference Room' },
    { asset: '1576', ad: '1577', name: 'Room 202 - T.I.' },
    { asset: '1580', ad: '1581', name: 'Server - on site' },
  ],
  expense: { account: '7999', sub: '013-000', dept: '013 - Finance', description: 'Depreciation' },
  adSub: '000-000',
  adDept: '000 - General',
  tranDescription: 'Accumulated Depreciation',
  // Disposals (the FYE disposal JE): money received for disposed equipment was booked to
  // Equipment expense when it came in, so the JE moves it out of there.
  disposal: {
    gainLossAccount: '8990',   // Gain/Loss on Disposal of Assets
    gainLossSub: '000-000',
    gainLossDept: '000 - General',
    proceedsAccount: '8049',   // Equipment (where the cash received was booked)
    proceedsSub: '010-000',
    proceedsDept: '010 - Product Engineering',
  },
  // Assets under this cost are expensed (from October 2023).
  capitalizationThreshold: 7500,
  // Account descriptions for the JE "Description" column; filled from a trial balance upload.
  accountNames: {},
};

function line(cfg, { dept, account, sub, debit = 0, credit = 0, tranDescription }) {
  return {
    dept,
    account,
    description: cfg.accountNames?.[account] || '',
    sub,
    debit: round2(debit),
    credit: round2(credit),
    tranDescription,
  };
}

// Included in a month's depreciation: everything not disposed before that month. An asset
// disposed *in* the month is included, since its disposal is booked by its own JE.
function assetsFor(assets, group, month) {
  return assets.filter((a) => a.group === group && !isDisposedBefore(a, month));
}

// priorBalances: { '1541': 324304.70, ... } — accumulated depreciation per GL at the end of the
// prior month, as positive numbers. When a group has no prior balance the JE falls back to the
// scheduled amount for that group.
export function buildDepreciationJE({ month, assets, config = DEFAULT_FA_CONFIG, priorBalances = null }) {
  const perGroup = config.groups.map((g) => {
    const list = assetsFor(assets, g.asset, month);
    const scheduled = round2(sum(list, (a) => depreciationFor(a, month)));
    const expected = round2(sum(list, (a) => accumThrough(a, month)));
    const prior = priorBalances && priorBalances[g.ad] != null ? round2(priorBalances[g.ad]) : null;
    const trueUp = prior == null ? null : round2(expected - prior);
    const amount = trueUp == null ? scheduled : trueUp;
    return {
      ...g,
      count: list.length,
      scheduled,
      expected,
      prior,
      trueUp,
      amount,
      variance: trueUp == null ? 0 : round2(trueUp - scheduled),
    };
  });

  const total = round2(sum(perGroup, (g) => g.amount));
  const tran = config.tranDescription;
  const lines = [
    line(config, {
      dept: config.expense.dept, account: config.expense.account, sub: config.expense.sub,
      debit: total > 0 ? total : 0, credit: total < 0 ? -total : 0, tranDescription: tran,
    }),
    ...perGroup.map((g) => line(config, {
      dept: config.adDept, account: g.ad, sub: config.adSub,
      debit: g.amount < 0 ? -g.amount : 0, credit: g.amount > 0 ? g.amount : 0,
      tranDescription: tran,
    })),
  ];
  // Account names from the trial balance may be missing; the expense line has a sensible default.
  if (!lines[0].description) lines[0].description = config.expense.description || '';

  return { month, perGroup, total, lines, basis: perGroup.some((g) => g.prior != null) ? 'true-up' : 'schedule' };
}

export function buildDisposalJE({ asset, config = DEFAULT_FA_CONFIG }) {
  const s = disposalSummary(asset);
  if (!s) return null;
  const g = config.groups.find((x) => x.asset === asset.group);
  if (!g) throw new Error(`No accumulated depreciation account set up for ${asset.group}.`);
  const d = config.disposal;
  const tran = `Disposal - ${asset.name}`.slice(0, 255);
  const lines = [
    line(config, { dept: config.adDept, account: g.ad, sub: config.adSub, debit: s.accum, tranDescription: tran }),
  ];
  if (s.proceeds) {
    lines.push(line(config, { dept: d.proceedsDept, account: d.proceedsAccount, sub: d.proceedsSub, debit: s.proceeds, tranDescription: tran }));
  }
  const gl = round2(s.gainLoss);
  if (gl !== 0) {
    lines.push(line(config, {
      dept: d.gainLossDept, account: d.gainLossAccount, sub: d.gainLossSub,
      debit: gl < 0 ? -gl : 0, credit: gl > 0 ? gl : 0, tranDescription: tran,
    }));
  }
  lines.push(line(config, { dept: config.adDept, account: asset.group, sub: config.adSub, credit: asset.cost, tranDescription: tran }));
  return { month: monthOfDate(asset.disposal.date), summary: s, lines };
}

// Every asset disposed in `month`, in one JE, laid out like the FYE disposal JE: proceeds out of
// where they were booked, A/D removed per account, the gain or loss, original cost removed per
// account. Assets marked `disposal.booked` (booked in Acumatica before the app) are left out.
export function buildDisposalsJE({ month, assets, config = DEFAULT_FA_CONFIG }) {
  const list = assets.filter((a) => a.disposal?.date && monthOfDate(a.disposal.date) === month && !a.disposal.booked);
  if (!list.length) return { month, assets: [], lines: [] };
  const d = config.disposal;
  const sums = list.map((a) => ({ a, s: disposalSummary(a) })).filter((x) => x.s);
  const proceeds = round2(sum(sums, (x) => x.s.proceeds || 0));
  const gain = round2(sum(sums, (x) => x.s.gainLoss));
  const byGroup = {};
  for (const { a, s: x } of sums) {
    const g = (byGroup[a.group] ||= { cost: 0, accum: 0 });
    g.cost += a.cost; g.accum += x.accum;
  }
  const lines = [];
  if (proceeds) lines.push(line(config, { dept: d.proceedsDept, account: d.proceedsAccount, sub: d.proceedsSub, debit: proceeds, tranDescription: 'FYE - Fixed Asset Disposals - to reclass cash received from disposal of equipment' }));
  for (const [group, g] of Object.entries(byGroup)) {
    const ad = config.groups.find((x) => x.asset === group)?.ad;
    if (!ad) throw new Error(`No accumulated depreciation account set up for ${group}.`);
    lines.push(line(config, { dept: config.adDept, account: ad, sub: config.adSub, debit: round2(g.accum), tranDescription: 'FYE - Fixed Asset Disposals - to remove depreciation' }));
  }
  if (gain) lines.push(line(config, { dept: d.gainLossDept, account: d.gainLossAccount, sub: d.gainLossSub, debit: gain < 0 ? -gain : 0, credit: gain > 0 ? gain : 0, tranDescription: `FYE - Fixed Asset Disposals - for ${gain > 0 ? 'gain' : 'loss'} on disposal of assets` }));
  for (const [group, g] of Object.entries(byGroup)) lines.push(line(config, { dept: config.adDept, account: group, sub: config.adSub, credit: round2(g.cost), tranDescription: 'FYE - Fixed Asset Disposals - to remove FA original cost' }));
  return { month, assets: list, lines, proceeds, gain };
}

export function isBalanced(lines) {
  return round2(sum(lines, (l) => l.debit) - sum(lines, (l) => l.credit)) === 0;
}

// Rows for the spreadsheet export, header first.
export function jeRows(lines) {
  return [
    JE_COLUMNS,
    ...lines.map((l) => [l.dept, '', l.account, l.description, l.sub, '', 0, '', l.debit, l.credit,
      l.tranDescription, '', '', '', '', '', '']),
  ];
}
