import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '../app/vendor/xlsx.mjs';
import { parseApAging, apTieOut } from '../app/js/bs/ap-aging.js';
import { cashTieOut } from '../app/js/bs/cash.js';
import { parseTrialBalanceText, looksLikeTrialBalance } from '../app/js/tb.js';
import { parseGlRegister, grantOf } from '../app/js/gl.js';
import { runFunds, span, restrictedJe, openingNotes, GENERAL } from '../app/js/restricted/funds.js';
import { governanceStatus, docName, ccPeriods } from '../app/js/governance/docs.js';
import { statementName } from '../app/js/naming.js';
import { isBalanced } from '../app/js/fa/je.js';

const book = (rows) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1'); return wb; };

// Laid out like Acumatica's AP Aged Period-Sensitive (Detailed) export.
const HEAD = ['Doc. Type', 'Ref. Number', 'Vendor Ref.', 'Branch', 'Due Date', 'Doc. Date', 'Current', '1 - 30 Days', '31 - 60 Days', '61 - 90 Days', 'Over 90 Days', 'Balance'];
const AGING = [
  ['AP Aged Period-Sensitive (Detailed)'],
  ['Company/Branch:', 'BIBLEPROJE', '', '', 'Financial Period:', '12-2026', '', '', '', '', 'Date:', '10/3/2026 3:08 PM'],
  ['', '', '', '', 'Aged On:', '9/30/2026'],
  [],
  ['Vendor', '', 'Vendor Name'],
  ['ADPV001', '', 'ADP'],
  [],
  ['', '', '', '', '', '', 'Past Due'],
  HEAD,
  ['Bill', '007546', '732156649', '', '10/25/2026', '9/25/2026', 1786.57, 0, 0, 0, 0, 1786.57],
  ['', '', '', '', '', 'Vendor Total:', 1786.57, 0, 0, 0, 0, 1786.57],
  [],
  ['OLDV001', '', 'Old Vendor'],
  [],
  ['', '', '', '', '', '', 'Past Due'],
  HEAD,
  ['Bill', '007100', 'A-1', '', '7/1/2026', '6/1/2026', 0, 0, 0, 500, 0, 500],
  ['Bill', '006900', 'A-0', '', '5/1/2026', '4/1/2026', 0, 0, 0, 0, 250, 250],
  ['', '', '', '', '', 'Vendor Total:', 0, 0, 0, 500, 250, 750],
  [],
  ['', '', '', '', '', 'Company Total:', 1786.57, 0, 0, 500, 250, 2536.57],
];

test('AP aging: vendors, documents and the company total from the Acumatica layout', () => {
  const a = parseApAging(XLSX, book(AGING));
  assert.equal(a.month, '2026-09');
  assert.equal(a.agedOn, '2026-09-30');
  assert.deepEqual(a.vendors.map((v) => [v.name, v.docs.length, v.total.balance]), [['ADP', 1, 1786.57], ['Old Vendor', 2, 750]]);
  assert.equal(a.total.balance, 2536.57);
});

test('AP aging ties to GL 2010, and lists everything 61 days or more past due', () => {
  const a = parseApAging(XLSX, book(AGING));
  const ok = apTieOut(a, 2536.57);
  assert.equal(ok.ties, true);
  assert.equal(ok.addsUp, true);
  assert.deepEqual(ok.exceptions.map((x) => [x.ref, x.amount, x.daysPastDue]), [['006900', 250, 152], ['007100', 500, 91]]);
  const off = apTieOut(a, 2500);
  assert.equal(off.ties, false);
  assert.equal(off.variance, 36.57);
  assert.equal(apTieOut(a, null).variance, null);
});

test('a trial balance saved as PDF reads like the Excel export', () => {
  const lines = [
    'Trial Balance Summary Page: 1 of 4',
    'Company/Branch: BIBLEPROJE Financial Period: 12-2026 Date: 10/3/2026 3:57 PM',
    'Account Type Description Beginning Balance Debit Credit Ending Balance',
    '1025 Asset Petty Cash - CASHASSET 300.00 0.00 0.00 300.00',
    '1200 Asset Bank Transfer - Cash Clearing Account - CASHASSET 0.00 0.00 1,513,592.67 -1,513,592.67',
    '2010 Liability Accounts Payable - AP 134,604.31 508,116.82 422,265.70 48,753.19',
    'Assets Total 38,988,180.35 12,553,924.66 13,178,543.63 38,363,561.38',
  ].map((text) => ({ page: 1, text }));
  assert.equal(looksLikeTrialBalance(lines), true);
  const tb = parseTrialBalanceText(lines);
  assert.equal(tb.month, '2026-09');
  assert.deepEqual(Object.keys(tb.accounts), ['1025', '1200', '2010']);
  assert.deepEqual(tb.accounts['1200'], { type: 'Asset', description: 'Bank Transfer - Cash Clearing Account', begin: 0, debit: 0, credit: 1513592.67, end: -1513592.67 });
});

test('cash: each account against its statement, petty cash fixed, clearing flagged when large', () => {
  const balances = { 1025: { description: 'Petty Cash', end: 300 }, 1100: { description: 'Cass', end: 1000 }, 1200: { description: 'Clearing', end: -60000 },
    1210: { description: 'AR', end: 5 }, 1060: { description: 'KeyBank MM', end: 50 } };
  const t = cashTieOut(balances, { cassOp: 1250 });
  assert.deepEqual(t.rows.map((r) => r.account), ['1025', '1060', '1100', '1200']);
  assert.equal(t.total, -58650);
  assert.equal(t.rows.find((r) => r.account === '1100').diff, 250);
  assert.deepEqual(t.flags.map((r) => r.account), ['1200']);
  const moved = cashTieOut({ ...balances, 1025: { end: 280 }, 1200: { end: 10 } });
  assert.deepEqual(moved.flags.map((r) => r.account), ['1025']);
});

// A GL Register Detailed export with a restricted gift, translation spending and other spending.
const glRows = [
  ['GL Register Detailed'], [], [], [], [],
  ['Period', 'Module', 'Batch Number', 'Date', 'Status', 'Description', 'Created By', 'Last Modified By', 'Currency', 'Control Total'],
  ['12-2026', 'GL', 'GL1', '9/2/2026', 'Posted', 'Wire gifts'],
  ['Customer/Vendor', 'Account', 'Subaccount', '', 'Ref. Number', 'Description', '', 'Identifier', 'Debit', 'Credit'],
  ['', '1100', '000-000', '', '', 'Wire', '', 'GL GL1 1', 6000, 0],
  ['DONOR1', '4017', '005-627', '', '', 'Portuguese gift', '', 'GL GL1 2', 0, 5000],
  ['DONOR2', '4017', '000-000', '', '', 'General translation gift', '', 'GL GL1 3', 0, 1000],
  ['12-2026', 'AP', 'AP1', '9/5/2026', 'Posted', 'Bills'],
  ['VEND1', '7625', '005-618', '', '', 'Podcast translation', '', 'AP AP1 1', 300, 0],
  ['VEND2', '8035', '021-811', '', '', 'Christmas', '', 'AP AP1 2', 40, 0],
  ['VEND1', '7625', '005-000', '', '', 'Global, no grant', '', 'AP AP1 3', 25, 0],
  ['', '2010', '000-000', '', '', 'AP', '', 'AP AP1 4', 0, 365],
];

test('the GL keeps restricted gifts (4017) and spending by grant code', () => {
  assert.equal(grantOf('005-627'), '627');
  assert.equal(grantOf('000-000'), '000');
  assert.equal(grantOf(''), '000');
  const { periods } = parseGlRegister(XLSX, book(glRows));
  assert.deepEqual(periods[0].grants, { gifts: { 627: 5000, '000': 1000 }, spend: { 618: 300, 811: 40 } });
  assert.deepEqual(periods[0].giving.restricted.map((l) => l.grant), ['627', '000']);
});

test('language funds release as the language spends, never below zero; general localization covers the rest', () => {
  const activity = {
    '2025-10': { gifts: { 627: 1000, '000': 500 }, spend: { 618: 400 } },     // Portuguese gift, spent on Portuguese podcast
    '2025-11': { gifts: {}, spend: { 627: 800, 615: 300, 609: 100, 131: 50 } }, // more than the Portuguese fund holds; Hindi with no fund
    '2025-12': { gifts: { 615: 2000 }, spend: {} },
  };
  const r = runFunds({ activity, start: '2025-10', end: '2025-12' });
  const pt = r.funds.find((f) => f.name === 'Portuguese');
  const hi = r.funds.find((f) => f.name === 'Hindi');
  const gen = r.funds.find((f) => f.id === GENERAL);
  assert.deepEqual(pt.rows['2025-10'], { open: 0, add: 1000, rel: 400, end: 600, spend: 400 });
  assert.deepEqual(pt.rows['2025-11'], { open: 600, add: 0, rel: 600, end: 0, spend: 800 });
  // General: 500 in; November's uncovered translation spending is 200 Portuguese + 300 Hindi + 100 department dev.
  assert.deepEqual(gen.rows['2025-11'], { open: 500, add: 0, rel: 500, end: 0, spend: 600 });
  assert.equal(hi.rows['2025-12'].end, 2000);
  assert.deepEqual(span(pt, '2025-10', '2025-12'), { open: 0, add: 1000, rel: 1000, end: 0, spend: 1200 });
  // Every fund here ran short at some point, so any balance from before October would be spent by now.
  assert.deepEqual(openingNotes(r), []);
  const late = runFunds({ activity: { '2025-10': { gifts: { 638: 100 }, spend: {} } }, start: '2025-10', end: '2025-10' });
  assert.deepEqual(openingNotes(late).map((n) => n.fund), ['Turkish']);
});

test('typed funds: an opening balance, gifts, and release on a schedule or as spent on their grants', () => {
  const others = [
    { id: 'm', name: 'Murdock', opening: 1000, openingMonth: '2025-10', gifts: [{ month: '2025-11', amount: 500 }], release: 'schedule', monthly: 400, from: '2025-10' },
    { id: 'b', name: 'Bolthouse', opening: 300, openingMonth: '2024-01', release: 'spend', codes: ['131'] },
  ];
  const activity = { '2025-10': { gifts: {}, spend: { 131: 200 } }, '2025-11': { gifts: {}, spend: { 131: 200 } } };
  const r = runFunds({ activity, others, start: '2025-10', end: '2025-12' });
  const m = r.funds.find((f) => f.name === 'Murdock');
  const b = r.funds.find((f) => f.name === 'Bolthouse');
  assert.deepEqual(m.rows['2025-10'], { open: 1000, add: 0, rel: 400, end: 600, spend: 400 });
  assert.deepEqual(m.rows['2025-12'], { open: 700, add: 0, rel: 400, end: 300, spend: 400 });
  // An opening from before the schedule starts comes in with its first month.
  assert.deepEqual([b.rows['2025-10'].open, b.rows['2025-11'].rel, b.rows['2025-11'].end], [300, 100, 0]);
  assert.deepEqual(r.gaps, ['2025-12']);
});

test('the reclass JE moves each fund’s change between net assets without and with restrictions', () => {
  const r = runFunds({ activity: { '2025-10': { gifts: { 627: 1000 }, spend: { 627: 250, 615: 10 } } }, start: '2025-10', end: '2025-10' });
  const lines = restrictedJe(r, '2025-10', { restrictedAccount: '3200', offsetAccount: '3001', sub: '000-000' });
  assert.equal(isBalanced(lines), true);
  assert.deepEqual(lines.map((l) => [l.account, l.debit, l.credit]), [['3001', 750, 0], ['3200', 0, 750]]);
  assert.match(lines[0].tranDescription, /^Portuguese translation: gifts 1,000.00, released 250.00$/);
});

test('governance: who has filed a COI this year, the current signatory list, the CC compilation periods', () => {
  const docs = [
    { type: 'coi', person: 'A Person', fy: 2025, date: '2024-11-01' },
    { type: 'coi', person: 'A Person', fy: 2026, date: '2025-11-01' },
    { type: 'coi', person: 'B Person', fy: 2025, date: '2024-11-01' },
    { type: 'signatory-list', date: '2024-03-01' },
    { type: 'signatory-list', date: '2026-01-15' },
    { type: 'cc-compilation', period: '2026-01' },
    { type: 'board-minutes', date: '2025-10-14' },
    { type: 'board-minutes', date: '2026-02-10' },
  ];
  assert.deepEqual(ccPeriods(2026), ['2026-01', '2026-05', '2026-09']);
  const s = governanceStatus(docs, 2026, '2026-06-15');
  assert.deepEqual(s.coi.map((c) => [c.person, c.current, c.latest]), [['A Person', true, 2026], ['B Person', false, 2025]]);
  assert.equal(s.signatories.current.date, '2026-01-15');
  assert.equal(s.signatories.history.length, 1);
  assert.deepEqual(s.cc.map((c) => c.state), ['done', 'due', 'open']);
  assert.deepEqual(s.minutes.map((d) => d.date), ['2026-02-10', '2025-10-14']);
  assert.ok(s.monthsWithout.includes('2025-11') && !s.monthsWithout.includes('2026-02'));
});

test('stored file names: {Account}_{YYYY-MM}', () => {
  assert.equal(statementName({ account: 'cassOp', kind: 'incoming', period: '2026-09', original: 'Stmt 0930.PDF' }), 'CassIncomingWires_2026-09.pdf');
  assert.equal(statementName({ account: 'stripe', period: '2026-09', original: 'balance.csv' }), 'Stripe_2026-09.csv');
  assert.equal(statementName({ account: 'tschetter', period: '2026-09', original: 'shot.png', extra: 'screenshot' }), 'Tschetter_2026-09_screenshot.png');
  assert.equal(statementName({ account: 'cd', period: '2026-09-30', original: 'x.pdf' }), 'CassCDARS_2026-09-30.pdf');
  assert.equal(docName({ type: 'coi', fy: 2026, person: 'Jordan Q. Example' }, 'coi.pdf'), 'COI_FY2026_JordanQExample.pdf');
  assert.equal(docName({ type: 'board-minutes', date: '2026-03-12' }, 'm.pdf'), 'BoardMinutes_2026-03-12.pdf');
});
