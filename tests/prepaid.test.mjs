import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depositChecks } from '../app/js/poc/gl-deposits.js';
import { DEFAULT_POC_CONFIG as config } from '../app/js/poc/calc.js';

// GL019115 (Sep 2026) as noCashRevenue keeps it: credits positive. And a later release.
const sep = { accounts: {}, receipts: [], noCashRevenue: [{ batch: 'GL019115', date: '2026-09-30', desc: 'OneStory Marshall Acquisition & Capitalization FYE 26',
  accounts: { 1530: -3726173.96, 1531: -3726214.54, 8039: 7395777.65, 2031: 48424.88, 2032: 7293, 2033: 27204.2, 4030: -26887.36, 4050: 576.13 } }],
  noCashInterest: [{ batch: 'GL019115', date: '2026-09-30', desc: 'OneStory Marshall Acquisition & Capitalization FYE 26', amount: 576.13 }] };
const oct = { accounts: {}, receipts: [], noCashRevenue: [{ batch: 'GL019200', date: '2026-10-31', desc: 'Release prepaid rent', accounts: { 2033: -27204.2, 4030: 27204.2 } }] };
const recs = { '2026-09': { month: '2026-09' }, '2026-10': { month: '2026-10' } };
const d = depositChecks({ recs, glBy: { '2026-09': sep, '2026-10': oct }, config });
const osm = (m) => d[m].adjustments.filter((a) => a.account === 'osmOp').map((a) => [a.id, a.amount, a.type, a.label]);

test('Prepaid rent: received in September (out of revenue), the rest of the entry is revenue moved with no cash', () => {
  assert.deepEqual(osm('2026-09'), [
    ['auto-glprepaid-GL019115', -27204.2, 'timing', 'Prepaid rent received, not yet earned (2033)'],
    ['auto-glnocash-GL019115', 316.84, 'other', 'Revenue the GL moved with no cash: OneStory Marshall Acquisition & Capitalization FYE 26'],
  ]);
  assert.deepEqual(d['2026-09'].noCashInterest.map((x) => x.amount), [576.13]);
});

test('Prepaid rent: released with no cash, it comes back into revenue, linked to the month it came in', () => {
  assert.deepEqual(osm('2026-10'), [['auto-glprepaid-GL019200', 27204.2, 'timing', 'Prepaid rent earned (2033), received September 2026']]);
  // The two cancel: received September, earned October.
  assert.equal(Math.round((osm('2026-09')[0][1] + osm('2026-10')[0][1]) * 100) / 100, 0);
});
