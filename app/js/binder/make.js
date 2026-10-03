// The binder's schedules and JE files, made at download time from what the app holds. Each maker
// returns workbook bytes; `months` narrows a year's schedule to the months asked for.

import { workbookBytes } from '../xlsx-io.js';
import { cashTieOut, balancesFrom } from '../bs/cash.js';
import { apTieOut, BUCKETS, AP_ACCOUNT } from '../bs/ap-aging.js';
import { statementEndings } from '../views/balance-sheet.js';
import { monthSummary, fyMonths } from '../cd/schedule.js';
import { rollForwardSheets, restrictedJe } from '../restricted/funds.js';
import { monthJes, jeReady, importRows, IMPORT_COL_WIDTHS } from '../je/month.js';
import { isBalanced } from '../fa/je.js';
import { addMonths, lastDayOfMonth, monthName } from '../fiscal.js';

const short = (m) => monthName(m, { short: true });

// ctx: { user, recBy, cds, tbBy, agingBy, bsCfg, gl: { result } (restricted funds run), glBy,
// jeDefaults, restrictedCfg, names }
export const MAKERS = {
  async poc(item, ctx) {
    const mod = await import('../views/poc-year.js');
    const api = await mod.default(document.createElement('main'), { user: ctx.user, rerender: () => {}, binder: { fy: item.fy } });
    return api.workbook();
  },

  async cash(item, ctx, months) {
    const rows = [['Month', 'Account', 'Name', 'GL balance', 'Statement ending', 'Difference', 'Check']];
    for (const m of months) {
      const { balances } = balancesFrom(ctx.tbBy, m, addMonths(m, 1));
      if (!balances) continue;
      const t = cashTieOut(balances, statementEndings(ctx.recBy[m], ctx.cds, m), ctx.bsCfg);
      for (const r of t.rows) rows.push([short(m), r.account, r.label, r.gl, r.statement, r.diff, r.flag ? r.flag.text : r.statement == null ? (r.source ? 'No statement attached' : '') : r.diff ? 'Reconciling items (timing)' : 'Matches statement']);
      rows.push([short(m), '', 'Total cash on the balance sheet', t.total, null, null, ''], []);
    }
    return workbookBytes([{ name: 'Cash', rows, cols: [10, 8, 36, 16, 16, 14, 60] },
      { name: 'About', rows: [['Cash accounts (1000–1201) at month end from the trial balance, against the statement ending balance in proof of cash.'], [`Petty cash (1025) should stay ${ctx.bsCfg.pettyCash}; Cash Clearing (1200) is flagged above ${ctx.bsCfg.clearingThreshold} either way.`], ['Differences between a statement and the GL are timing (checks not yet cleared, deposits in transit), worked through in the proof of cash.']], cols: [120] }]);
  },

  async ap(item, ctx, months) {
    const tie = [['Month', 'AP aging total', `GL ${AP_ACCOUNT}`, 'Difference', 'Ties', 'Aged on', 'Report']];
    const late = [['Month', 'Vendor', 'Ref.', 'Vendor ref.', 'Due', 'Days past due', 'Over 60 days', 'Balance']];
    const bills = [['Month', 'Vendor', 'Ref.', 'Vendor ref.', 'Doc. date', 'Due', ...BUCKETS.map(([, l]) => l), 'Balance']];
    for (const m of months) {
      const a = ctx.agingBy[m];
      if (!a) continue;
      const { balances } = balancesFrom(ctx.tbBy, m, addMonths(m, 1));
      const t = apTieOut(a, balances ? balances[AP_ACCOUNT]?.end ?? 0 : null);
      tie.push([short(m), t.total, t.glBalance, t.variance, t.glBalance == null ? 'No trial balance' : t.ties ? 'Yes' : 'NO', a.agedOn, a.fileName || '']);
      for (const x of t.exceptions) late.push([short(m), x.vendor, x.ref, x.vendorRef, x.due, x.daysPastDue, x.amount, x.balance]);
      for (const v of a.vendors) for (const d of v.docs) bills.push([short(m), v.name, d.ref, d.vendorRef, d.date, d.due, ...BUCKETS.map(([k]) => d[k]), d.balance]);
    }
    return workbookBytes([{ name: 'Tie-out', rows: tie, cols: [10, 16, 16, 14, 16, 12, 40] }, { name: 'Over 60 days', rows: late, cols: [10, 34, 10, 16, 12, 12, 14, 14] }, { name: 'Open bills', rows: bills, cols: [10, 34, 10, 16, 12, 12, 13, 13, 13, 13, 13, 14] }]);
  },

  async cds(item, ctx) {
    const months = fyMonths(item.fy);
    const inFy = ctx.cds.filter((cd) => months.some((m) => cd.earned?.[m]?.amount) || months.some((m) => cd.maturity && cd.maturity.slice(0, 7) === m))
      .sort((a, b) => (a.effective || '').localeCompare(b.effective || ''));
    const rows = [[`CD schedule FY${item.fy}`], [], ['CD', 'Chain', 'Effective', 'Maturity', 'Rate', 'Principal', ...months.map(short), 'Paid at maturity']];
    for (const cd of inFy) rows.push([`…${cd.last4}`, cd.chain || '', cd.effective || '', cd.maturity || '', cd.rate ? { v: cd.rate, z: '0.00%' } : null, cd.principal, ...months.map((m) => cd.earned?.[m]?.amount ?? null), cd.status === 'matured' ? cd.interestPaid : null]);
    const sums = months.map((m) => monthSummary(ctx.cds, m));
    rows.push([], ['Interest earned', '', '', '', '', '', ...sums.map((x) => x.accrued)], ['Paid at maturity', '', '', '', '', '', ...sums.map((x) => x.realized)], ['Balance at month end', '', '', '', '', '', ...sums.map((x) => x.balance)]);
    return workbookBytes([{ name: 'CD schedule', rows, cols: [10, 12, 11, 11, 8, 15, ...months.map(() => 13), 15] }]);
  },

  async restricted(item, ctx, months) {
    if (!ctx.gl.result) throw new Error('No GL register with grant codes is loaded.');
    const have = ctx.gl.result.months;
    const inScope = months.filter((m) => have.includes(m));
    if (!inScope.length) throw new Error('No GL for these months.');
    return workbookBytes(rollForwardSheets(ctx.gl.result, inScope[0], inScope[inScope.length - 1]));
  },

  async jes(item, ctx) {
    const ready = monthJesFor(item.month, ctx);
    return workbookBytes([{ name: 'Acumatica', rows: importRows(ready), cols: IMPORT_COL_WIDTHS }]);
  },

  async tb(item, ctx) {
    const tb = ctx.tbBy[item.month];
    const rows = [[`Trial Balance Summary, period ${tb.period} (${monthName(tb.month)})`], [`From ${tb.fileName || 'an upload'}${tb.runAt ? `, run ${tb.runAt}` : ''}`], [],
      ['Account', 'Type', 'Description', 'Beginning Balance', 'Debit', 'Credit', 'Ending Balance'],
      ...Object.entries(tb.accounts).sort(([a], [b]) => a.localeCompare(b)).map(([a, x]) => [a, x.type, x.description, x.begin, x.debit, x.credit, x.end])];
    return workbookBytes([{ name: 'Trial balance', rows, cols: [9, 10, 44, 18, 16, 16, 18] }]);
  },
};

// The month's JEs that are ready (proof of cash's, and the restricted funds reclass).
export function monthJesFor(m, ctx) {
  const rec = ctx.recBy[m] || { month: m };
  const jes = monthJes(rec, { recs: ctx.recBy, glBy: ctx.glBy, cds: ctx.cds, jeDefaults: ctx.jeDefaults }).filter(jeReady);
  if (ctx.gl.result?.months.includes(m)) {
    const lines = restrictedJe(ctx.gl.result, m, ctx.restrictedCfg, ctx.names);
    const je = { batch: 6, id: 'restricted', label: 'Restricted net assets', description: 'Restricted Net Assets', date: lastDayOfMonth(m), lines, problems: [], balanced: isBalanced(lines) };
    if (jeReady(je)) jes.push(je);
  }
  return jes;
}
