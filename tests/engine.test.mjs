import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule, accumThrough, depreciationFor, disposalSummary, lifeFromEndDate, fullyDepreciatedMonth } from '../app/js/fa/engine.js';
import { buildDepreciationJE, buildDisposalJE, isBalanced, DEFAULT_FA_CONFIG } from '../app/js/fa/je.js';
import { toPeriod, fromPeriod, addMonths, monthDiff, lastDayOfMonth } from '../app/js/fiscal.js';
import { round2 } from '../app/js/money.js';

const base = { id: 'x', name: 'Test', group: '1540', cost: 12000, salvage: 0, inService: '2026-01-15', lifeMonths: 12, method: 'SL', convention: 'next-month' };

test('fiscal periods run October–September', () => {
  assert.equal(toPeriod('2025-10'), '01-2026');
  assert.equal(toPeriod('2026-07'), '10-2026');
  assert.equal(toPeriod('2026-09'), '12-2026');
  assert.equal(fromPeriod('12-2026'), '2026-09');
  assert.equal(fromPeriod('01-2026'), '2025-10');
  assert.equal(addMonths('2026-11', 3), '2027-02');
  assert.equal(monthDiff('2025-10', '2026-09'), 11);
  assert.equal(lastDayOfMonth('2028-02'), '2028-02-29');
});

test('straight-line, next-month convention starts the month after', () => {
  const rows = schedule(base, '2027-06');
  assert.equal(rows[0].month, '2026-02');
  assert.equal(rows.length, 12);
  assert.equal(rows[0].dep, 1000);
  assert.equal(rows.at(-1).month, '2027-01');
  assert.equal(round2(rows.at(-1).accum), 12000);
});

test('full-month convention starts in the in-service month', () => {
  const rows = schedule({ ...base, convention: 'full-month' }, '2027-06');
  assert.equal(rows[0].month, '2026-01');
  assert.equal(rows.at(-1).month, '2026-12');
});

test('mid-month convention takes half at each end', () => {
  const rows = schedule({ ...base, convention: 'mid-month' }, '2027-06');
  assert.equal(rows.length, 13);
  assert.equal(rows[0].dep, 500);
  assert.equal(rows.at(-1).dep, 500);
  assert.equal(round2(rows.at(-1).accum), 12000);
});

test('rounding remainder lands in the last month', () => {
  const rows = schedule({ ...base, cost: 1000, lifeMonths: 3 }, '2027-01');
  assert.deepEqual(rows.map((r) => r.dep).map(round2), [333.33, 333.33, 333.34]);
});

test('salvage value is not depreciated', () => {
  const rows = schedule({ ...base, salvage: 2400 }, '2030-01');
  assert.equal(round2(rows.at(-1).accum), 9600);
  assert.equal(round2(rows.at(-1).nbv), 2400);
});

test('double declining balance switches to straight-line and fully depreciates', () => {
  const a = { ...base, method: 'DB200', lifeMonths: 60, cost: 10000 };
  const rows = schedule(a, '2032-01');
  assert.equal(rows.length, 60);
  assert.ok(rows[0].dep > rows[30].dep);
  assert.equal(round2(rows.at(-1).accum), 10000);
});

test('fixed monthly with an opening balance picks up after the cutover and caps at cost', () => {
  const a = { ...base, method: 'FIXED', fixedMonthly: 43.47116667, cost: 2608.27, inService: '2022-06-15',
    lifeMonths: 60, openingAD: 2608.27 - 434.7116667, openingAsOf: '2026-08' };
  assert.equal(depreciationFor(a, '2026-08'), 0);
  assert.equal(round2(depreciationFor(a, '2026-09')), 43.47);
  assert.equal(round2(accumThrough(a, '2030-01')), 2608.27);
  assert.equal(fullyDepreciatedMonth(a), '2027-06');
});

test('construction in progress does not depreciate', () => {
  assert.equal(schedule({ ...base, status: 'cip' }, '2030-01').length, 0);
});

test('disposal stops depreciation per convention and computes gain/loss', () => {
  const a = { ...base, disposal: { date: '2026-06-10', proceeds: 8000 } };
  const rows = schedule(a, '2027-06');
  assert.equal(rows.at(-1).month, '2026-06'); // next-month: full month in the disposal month
  const s = disposalSummary(a);
  assert.equal(s.accum, 5000);
  assert.equal(s.nbv, 7000);
  assert.equal(s.gainLoss, 1000);
  const full = schedule({ ...a, convention: 'full-month' }, '2027-06');
  assert.equal(full.at(-1).month, '2026-05');
});

test('lease end date sets the life', () => {
  assert.equal(lifeFromEndDate('2026-04-05', '2028-04-30', 'next-month'), 24);
  assert.equal(lifeFromEndDate('2026-04-05', '2028-04-30', 'full-month'), 25);
});

test('monthly JE: schedule basis, balanced, one expense debit', () => {
  const assets = [base, { ...base, id: 'y', group: '1555', cost: 8400, lifeMonths: 84 }];
  const je = buildDepreciationJE({ month: '2026-03', assets });
  assert.equal(je.basis, 'schedule');
  assert.equal(je.total, 1100);
  assert.ok(isBalanced(je.lines));
  assert.equal(je.lines[0].account, '7999');
  assert.equal(je.lines[0].sub, '013-000');
  assert.equal(je.lines[0].dept, '013 - Finance');
  assert.equal(je.lines.find((l) => l.account === '1541').credit, 1000);
  assert.equal(je.lines.find((l) => l.account === '1556').credit, 100);
});

test('monthly JE: true-up to GL corrects a missed month', () => {
  // Feb was never booked: GL A/D at the end of Feb is 0, so March's entry catches up both months.
  const je = buildDepreciationJE({ month: '2026-03', assets: [base], priorBalances: { 1541: 0 } });
  assert.equal(je.basis, 'true-up');
  const g = je.perGroup.find((x) => x.ad === '1541');
  assert.equal(g.scheduled, 1000);
  assert.equal(g.amount, 2000);
  assert.equal(g.variance, 1000);
});

test('monthly JE includes an asset disposed that month, excludes earlier disposals', () => {
  const a = { ...base, disposal: { date: '2026-06-10', proceeds: 0 } };
  assert.equal(buildDepreciationJE({ month: '2026-06', assets: [a] }).total, 1000);
  assert.equal(buildDepreciationJE({ month: '2026-07', assets: [a] }).total, 0);
});

test('disposal JE clears cost and A/D and books the loss', () => {
  const cfg = { ...DEFAULT_FA_CONFIG, disposal: { ...DEFAULT_FA_CONFIG.disposal, gainLossAccount: '8998' } };
  const je = buildDisposalJE({ asset: { ...base, disposal: { date: '2026-06-10', proceeds: 2000 } }, config: cfg });
  assert.ok(isBalanced(je.lines));
  const by = Object.fromEntries(je.lines.map((l) => [l.account, l]));
  assert.equal(by['1541'].debit, 5000);
  assert.equal(by['1100'].debit, 2000);
  assert.equal(by['8998'].debit, 5000);
  assert.equal(by['1540'].credit, 12000);
});
