import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osmAccountOf, osmStatement, looksLikeCass } from '../app/js/poc/cass.js';
import { DEFAULT_POC_CONFIG, BANK_SOURCES } from '../app/js/poc/calc.js';

const L = (arr) => arr.map((text) => ({ text }));
// OneStory Marshall's Cass statements, September 2026 (the accounts' first month).
const operating = L(['Page: 1', 'ONESTORY MARSHALL LLC Branch: 015', '810 NW MARSHALL ST Account Number: 40074676',
  'PORTLAND OR 97209-3359 Statement Date: 9/30/26', 'KF - ADVANTAGE ONESTORY MARSHALL LLC Acct 40074676',
  'Beginning Balance 9/29/26 .00', 'Deposits / Misc Credits 1 27,204.20', 'Withdrawals / Misc Debits 0 .00',
  '** Ending Balance 9/30/26 27,204.20 **', 'Service Charge .00',
  '- - - - - - - - - - - - - - DEPOSITS AND OTHER CREDITS - - - - - - - - - - - - - -', 'Date Deposits Withdrawals Activity Description',
  '9/30 27,204.20 ORIG:TICOR TITLE COMPANY OF OREGONCLACKA', 'TRN:P202609300128975',
  '- - - - - - - - - - - - - - DAILY BALANCE SUMMARY - - - - - - - - - - - - - -', '9/30 27,204.20']);
const savings = L(['Page: 1', 'ONESTORY MARSHALL LLC Branch: 015', '810 NW MARSHALL ST Account Number: 70024839',
  'PORTLAND OR 97209-3359 Statement Date: 9/30/26', 'KF MONEY MARKET ONESTORY MARSHALL LLC Acct 70024839',
  'Beginning Balance 9/29/26 .00', 'Deposits / Misc Credits 0 .00', 'Withdrawals / Misc Debits 0 .00', '** Ending Balance 9/30/26 .00 **']);

test('OneStory Marshall statements are told apart from BibleProject’s Cass Operating by account number', () => {
  assert.equal(looksLikeCass(operating), true); // it would otherwise be read as Cass Operating
  assert.equal(osmAccountOf(operating), 'osmOp');
  assert.equal(osmAccountOf(savings), 'osmSav');
  assert.equal(osmAccountOf(L(['Account Number: 1234565884', 'Statement Date: 9/30/26'])), null);
});

test('A OneStory statement is a bank line: deposits, interest, ending, and it ties', () => {
  const op = osmStatement(operating, 'osmOp');
  assert.deepEqual([op.source, op.month, op.beginning, op.revenue, op.interest, op.ending, op.ties], ['osmOp', '2026-09', 0, 27204.2, 0, 27204.2, true]);
  const sav = osmStatement(savings, 'osmSav');
  assert.deepEqual([sav.revenue, sav.interest, sav.ending, sav.ties], [0, 0, 0, true]);
  const withInterest = osmStatement(L([...savings.slice(0, 6).map((l) => l.text), 'Deposits / Misc Credits 1 1.25', 'Withdrawals / Misc Debits 0 .00', '** Ending Balance 10/31/26 1.25 **',
    '- - - - DEPOSITS AND OTHER CREDITS - - - -', '10/31 1.25 INTEREST PAID']), 'osmSav');
  assert.deepEqual([withInterest.revenue, withInterest.interest], [0, 1.25]);
});

test('OneStory: its own accounts (1110, 1111), and its rent (4030) counts as revenue', () => {
  assert.deepEqual(BANK_SOURCES.filter((s) => s.id.startsWith('osm')).map((s) => [s.id, s.gl]), [['osmOp', '1110'], ['osmSav', '1111']]);
  assert.ok(DEFAULT_POC_CONFIG.revenueAccounts.includes('4030'));
});
