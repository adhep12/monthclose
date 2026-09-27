import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCassStatement, looksLikeCass } from '../app/js/poc/cass.js';
import { computePoc, defaultExclusions, statementAdjustments } from '../app/js/poc/calc.js';

const L = (arr) => arr.map((text) => ({ page: 1, text }));
const DASH = '- - - - - - - -';

function statement({ acct, title = '', credits, debits, checks = [], begin = '.00', end = '.00' }) {
  const ct = credits.reduce((s, c) => s + c[1], 0), dt = [...debits, ...checks].reduce((s, c) => s + c[1], 0);
  const f = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2 });
  return L([
    'Page: 1', `THE BIBLE PROJECT Branch: 015`, `${title} Account Number: ${acct}`, 'Statement Date: 7/31/26',
    `Beginning Balance 7/01/26 ${begin}`,
    `Deposits / Misc Credits ${credits.length} ${f(ct)}`,
    `Withdrawals / Misc Debits ${debits.length + checks.length} ${f(dt)}`,
    `** Ending Balance 7/31/26 ${end} **`,
    `${DASH} DEPOSITS AND OTHER CREDITS ${DASH}`, 'Date Deposits Withdrawals Activity Description',
    ...credits.flatMap(([d, a, desc, more]) => [`${d} ${f(a).replace(/^0/, '')} ${desc}`, ...(more ? [more] : [])]),
    'Page: 2', 'THE BIBLE PROJECT Account Number: x', 'Statement Date: 7/31/26',
    `${DASH} OTHER DEBITS AND WITHDRAWALS ${DASH}`, 'Date Deposits Withdrawals Activity Description',
    ...debits.map(([d, a, desc]) => `${d} ${f(a)} ${desc}`),
    ...(checks.length ? [`${DASH} CHECKS ${DASH}`, 'Date Check No. Amount', checks.map(([d, a], i) => `${d} ${770 + i} ${f(a)}`).join(' ')] : []),
    `${DASH} DAILY BALANCE SUMMARY ${DASH}`, '7/01 1,000.00 7/02 2,000.00',
  ]);
}

const outgoing = statement({ acct: '40063410', title: 'OUTGOING WIRES',
  credits: [['7/01', 8364.66, 'Trnsfr from Checking Acct Ending in 5884'], ['7/14', 2497.69, 'WEX COBRA/DBI COBRA'], ['7/15', 0.15, 'PEOPLE CENTER/BVC']],
  debits: [['7/01', 8364.66, 'THE GUARDIAN/JUL GP INS'], ['7/20', 2497.84, 'PLANE/PAYMENT']] });
const incoming = statement({ acct: '40055892', title: 'INCOMING WIRES',
  credits: [['7/02', 5000, 'FIDELITY INVESTM/GrantPaymt'], ['7/25', 400.03, 'STATE OF OHIO/TAXREFUNDS']],
  debits: [['7/02', 5000, 'Trnsfr to Checking Acct Ending in 5884'], ['7/25', 400.03, 'Trnsfr to Checking Acct Ending in 5884']] });
const operating = statement({ acct: '40055884', begin: '10,000.00', end: '1,100,000.00',
  credits: [['7/06', 1000000, 'STRIPE/TRANSFER', 'ST-ABC'], ['7/06', 5400.03, 'Trnsfr from Checking Acct Ending in 5892'], ['7/10', 100000, 'DEPOSIT CONNECTION DEPOSIT']],
  debits: [['7/12', 14400.03, 'ADP WAGE PAY/WAGE PAY']], checks: [['7/01', 1000]] });

test('parses a Cass statement and ties it to the summary', () => {
  assert.ok(looksLikeCass(operating));
  const s = parseCassStatement(operating);
  assert.equal(s.kind, 'operating');
  assert.equal(s.month, '2026-07');
  assert.equal(s.transactions.filter((t) => t.section === 'credit').length, 3);
  assert.equal(s.transactions.find((t) => t.section === 'check').amount, 1000);
  assert.equal(s.transactions[0].detail, 'ST-ABC');
  assert.ok(s.check.creditsOk && s.check.debitsOk && s.check.balanceOk);
});

test('reads amounts under a dollar and identifies wire accounts', () => {
  const s = parseCassStatement(outgoing);
  assert.equal(s.kind, 'outgoing');
  assert.equal(s.transactions.find((t) => /PEOPLE/.test(t.desc)).amount, 0.15);
  assert.ok(s.check.creditsOk);
  assert.equal(parseCassStatement(incoming).kind, 'incoming');
});

test('a statement that doesn’t add up fails its check', () => {
  const broken = operating.filter((l) => !/DEPOSIT CONNECTION/.test(l.text));
  assert.equal(parseCassStatement(broken).check.creditsOk, false);
});

test('proof of cash follows the Cass rules', () => {
  const statements = { operating: parseCassStatement(operating), incoming: parseCassStatement(incoming), outgoing: parseCassStatement(outgoing) };
  const excluded = defaultExclusions(statements);
  assert.equal(Object.keys(excluded).length, 1); // the Ohio tax refund
  const adj = Object.fromEntries(statementAdjustments({ statements, excluded }).map((a) => [a.id.startsWith('auto-ex') ? 'ex' : a.id, a.amount]));
  assert.equal(adj['auto-stripe'], -1000000);
  assert.equal(adj['auto-incoming'], 0); // every Incoming deposit was swept into Operating
  assert.equal(adj['auto-outgoing'], 0); // the WEX refund paid the plane bill; nothing swept back into Operating
  assert.equal(adj.ex, -400.03);

  const rec = { month: '2026-07', statements, excluded, bank: { stripe: { rev: 1000000 } }, dit: [{ amount: 300 }], gl: { revenue: 1102500 } };
  const c = computePoc(rec, { prior: { dit: [{ amount: 500 }] } });
  assert.equal(c.bankRev, 2105400.03); // Stripe 1,000,000 + Operating credits 1,105,400.03
  assert.equal(c.ditChange, -200);
  assert.equal(c.revAdjusted, 1104800); // the WEX refund never reached Operating, so nothing comes out for it
  assert.equal(c.diffRev, 2300);
});

test('interest side: bank interest plus accrual less prior accrual realized', () => {
  const c = computePoc({ bank: { cd: { int: 34379.48 }, ics: { int: 9215.38 } }, timing: { accrued: 38113, realizedPrior: 34379.48 }, gl: { interest: 47328.38 } });
  assert.equal(c.intAdjusted, 47328.38);
  assert.equal(c.diffInt, 0);
});

test('Stripe payouts per the CSV are checked against the Stripe transfers into Cass', async () => {
  const { stripePayoutCheck } = await import('../app/js/poc/calc.js');
  const op = parseCassStatement(operating); // one STRIPE/TRANSFER credit of 1,000,000
  assert.equal(stripePayoutCheck({ statements: { operating: op } }).state, 'incomplete');
  assert.equal(stripePayoutCheck({ statements: { operating: op }, stripe: { payouts: 1000000 } }).state, 'match');
  const off = stripePayoutCheck({ statements: { operating: op }, stripe: { payouts: 1250000 } });
  assert.equal(off.state, 'mismatch');
  assert.equal(off.diff, -250000);
  const explained = { statements: { operating: op }, stripe: { payouts: 1250000 }, stripeCheck: { diff: -250000, note: 'timing' } };
  assert.equal(stripePayoutCheck(explained).state, 'explained');
  // The explanation is for that exact difference: if a number changes, it flags again.
  assert.equal(stripePayoutCheck({ ...explained, stripe: { payouts: 1300000 } }).state, 'mismatch');
});

test('an ignored Stripe transfer drops out of the payout check only', async () => {
  const { stripePayoutCheck, statementAdjustments } = await import('../app/js/poc/calc.js');
  const operating = { transactions: [
    { id: '5884-0', section: 'credit', date: '2026-07-02', amount: 1000, desc: 'STRIPE TRANSFER' },
    { id: '5884-1', section: 'credit', date: '2026-07-15', amount: 42.5, desc: 'STRIPE TRANSFER' },
  ] };
  const rec = { statements: { operating }, stripe: { payouts: 1000 } };
  assert.equal(stripePayoutCheck(rec).state, 'mismatch');
  rec.stripeIgnored = { '5884-1': { note: 'stray payment', by: 'A' } };
  const chk = stripePayoutCheck(rec);
  assert.equal(chk.state, 'match');
  assert.equal(chk.ignored.length, 1);
  assert.equal(statementAdjustments(rec).find((a) => a.id === 'auto-stripe').amount, -1042.5);
});

test('wire accounts count by what swept into Operating; Fidelity MoneyLine money is a Delap withdrawal', async () => {
  const { statementAdjustments, computePoc } = await import('../app/js/poc/calc.js');
  const statements = {
    operating: { summary: { credits: { total: 178622.14, count: 2 }, ending: 0 }, transactions: [
      { id: 'op-0', section: 'credit', date: '2025-12-04', amount: 93972.75, desc: 'Trnsfr from Checking Acct Ending in 5892' },
      { id: 'op-1', section: 'credit', date: '2025-12-29', amount: 84649.39, desc: 'Trnsfr from Checking Acct Ending in 3410' },
    ] },
    incoming: { transactions: [
      { id: 'in-0', section: 'credit', date: '2025-12-02', amount: 100000, desc: 'WIRE IN/DONOR' },
      { id: 'in-1', section: 'debit', date: '2025-12-03', amount: 6027.25, desc: 'BROTHERHOOD/PREM PYMT' },
      { id: 'in-2', section: 'debit', date: '2025-12-04', amount: 93972.75, desc: 'Trnsfr to Checking Acct Ending in 5884' },
    ] },
    outgoing: { transactions: [
      { id: 'out-0', section: 'credit', date: '2025-12-16', amount: 2460.68, desc: 'WEX COBRA/DBI COBRA' },
      { id: 'out-1', section: 'credit', date: '2025-12-01', amount: 57.14, desc: 'FID BKG SVC LLC/MONEYLINE' },
      { id: 'out-2', section: 'credit', date: '2025-12-29', amount: 84649.39, desc: 'FID BKG SVC LLC/MONEYLINE' },
    ] },
  };
  const adj = Object.fromEntries(statementAdjustments({ statements }).map((a) => [a.id, a.amount]));
  assert.equal(adj['auto-incoming'], 6027.25); // the premium paid out of Incoming is added back
  assert.equal(adj['auto-outgoing'], -84649.39); // only what swept back into Operating comes out
  // Delap: 5,084,983.41 − 5,145,263.38 + 84,706.53 withdrawn = 24,426.56 (the workbook's December figure)
  const c = computePoc({ month: '2025-12', statements, bank: { delap: { ending: 5084983.41 } } }, { prior: { bank: { delap: { ending: 5145263.38 } } } });
  assert.equal(c.lines.find((l) => l.id === 'delap').int, 24426.56);
  const typed = computePoc({ month: '2025-12', statements, bank: { delap: { ending: 5084983.41, netDeposits: 0 } } }, { prior: { bank: { delap: { ending: 5145263.38 } } } });
  assert.equal(typed.lines.find((l) => l.id === 'delap').int, -60279.97); // typed net deposits win
});
