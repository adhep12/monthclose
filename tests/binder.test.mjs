import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statementItems, governanceItems, trialBalanceItems, madeItems, filterItems, zipName, indexCsv } from '../app/js/binder/items.js';
import { zipWriter, crc32 } from '../app/js/zip.js';

const recs = [
  { month: '2025-10', statements: { operating: { fileName: 'CassOperating_2025-10.pdf', fileKey: 'k1' }, incoming: { fileName: 'scan 0001.pdf', fileKey: 'k2' } },
    stripe: { fileName: 'balance_summary.csv', fileKey: 'k3' }, bankStatements: { wise: { fileName: 'Wise_2025-10.pdf', fileKey: 'k4' } } },
  { month: '2026-03', statements: { operating: { fileName: 'CassOperating_2026-03.pdf', fileKey: 'k5' } },
    bankFiles: { tschetter: [{ fileName: 'IMG_1.png', fileKey: 'k6' }] }, bankStatements: { paypal: { fileName: 'pp.pdf', fileKey: null } } },
  { month: '2026-10', statements: { operating: { fileName: 'CassOperating_2026-10.pdf', fileKey: 'k7' } } },
];
const cds = [
  { files: { '2026-03-31': { name: 'CDARS statement.pdf', key: 'k8' } } },
  { files: { '2026-03-31': { name: 'CDARS statement.pdf', key: 'k8' } } }, // one statement covers several CDs
];

test('statements: every stored file, named {Account}_{YYYY-MM} even if attached under the bank’s name', () => {
  const items = statementItems(recs, cds);
  assert.deepEqual(items.map((i) => `${i.folder}/${i.name}`), [
    '01 Statements/CassOperating/CassOperating_2025-10.pdf',
    '01 Statements/CassIncomingWires/CassIncomingWires_2025-10.pdf',
    '01 Statements/Stripe/Stripe_2025-10.csv',
    '01 Statements/Wise/Wise_2025-10.pdf',
    '01 Statements/CassOperating/CassOperating_2026-03.pdf',
    '01 Statements/Tschetter/Tschetter_2026-03.png',
    '01 Statements/CassOperating/CassOperating_2026-10.pdf',
    '01 Statements/CassCDARS/CassCDARS_2026-03-31.pdf',
  ]);
  assert.deepEqual(items.map((i) => i.fy), [2026, 2026, 2026, 2026, 2026, 2026, 2027, 2026]);
});

test('filters: one account for a year, a category for a year, a month, everything', () => {
  const items = [
    ...statementItems(recs, cds),
    ...madeItems({ pocFys: [2026], restrictedFys: [2026], cdFys: [2026], jeMonths: ['2026-03'] }),
    ...governanceItems([{ type: 'board-minutes', date: '2026-03-12', fileName: 'BoardMinutes_2026-03-12.pdf', fileKey: 'g1' }, { type: 'coi', person: 'A', fy: 2026, date: '2025-11-01', fileName: 'COI_FY2026_A.pdf' }]),
    ...trialBalanceItems([{ month: '2026-09', fileKey: 't1', fileName: 'TrialBalance_2026-09.pdf' }, { month: '2026-08', accounts: {} }]),
  ];
  assert.deepEqual(filterItems(items, { account: 'cassOp', period: 'FY2026' }).map((i) => i.name), ['CassOperating_2025-10.pdf', 'CassIncomingWires_2025-10.pdf', 'CassOperating_2026-03.pdf']);
  assert.equal(filterItems(items, { category: 'statement', period: 'FY2026' }).length, 7);
  assert.deepEqual(filterItems(items, { category: 'schedule:restricted', period: 'FY2026' }).map((i) => i.name), ['RestrictedFunds_FY2026.xlsx']);
  assert.deepEqual(filterItems(items, { category: 'schedule:assets' }), []);
  // A month: its statements, the year's schedules (made for that month), its JEs and governance.
  assert.deepEqual(filterItems(items, { period: '2026-03' }).map((i) => i.name), ['CassOperating_2026-03.pdf', 'Tschetter_2026-03.png', 'CassCDARS_2026-03-31.pdf',
    'ProofOfCash_FY2026.xlsx', 'CDSchedule_FY2026.xlsx', 'RestrictedFunds_FY2026.xlsx', 'JEs_2026-03.xlsx', 'BoardMinutes_2026-03-12.pdf']);
  // A governance document with no file isn't listed; a TB with no stored file is made from its figures.
  assert.equal(filterItems(items, { category: 'governance' }).length, 1);
  assert.deepEqual(filterItems(items, { category: 'tb' }).map((i) => i.file ? 'stored' : i.make), ['stored', 'tb']);
  assert.equal(filterItems(items, {}).length, items.length);
});

test('zip names follow the filter', () => {
  assert.equal(zipName({ account: 'cassOp', period: 'FY2026' }), 'BP_CassOperating_FY26.zip');
  assert.equal(zipName({ period: 'FY2026' }), 'BP_FullAuditBinder_FY26.zip');
  assert.equal(zipName({ category: 'statement', period: 'FY2026' }), 'BP_Statements_FY26.zip');
  assert.equal(zipName({ category: 'schedule:assets', period: '2026-03' }), 'BP_Schedules-Assets_2026-03.zip');
  assert.equal(zipName({}), 'BP_FullAuditBinder_AllPeriods.zip');
});

test('the index lists every file, and says why one is missing', () => {
  const csv = indexCsv([
    { folder: '01 Statements/Wise', name: 'Wise_2026-09.pdf', category: 'statement', account: 'wise', months: ['2026-09'], fy: 2026, included: true, note: 'As stored' },
    { folder: '02 Schedules/Proof of cash', name: 'ProofOfCash_FY2026.xlsx', category: 'schedule', topic: 'cash', months: ['2025-10', '2026-09'], fy: 2026, included: false, note: 'Couldn’t fetch, "403"' },
  ]);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[1], '01 Statements/Wise,Wise_2026-09.pdf,statement,,Wise,2026-09,FY2026,Yes,As stored');
  assert.equal(lines[2], '02 Schedules/Proof of cash,ProofOfCash_FY2026.xlsx,schedule,cash,,2025-10 to 2026-09,FY2026,NO,"Couldn’t fetch, ""403"""');
});

test('zip: stored entries with their CRCs, and duplicate names kept apart', () => {
  assert.equal(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  const z = zipWriter(new Date(2026, 8, 30, 12, 0, 0));
  z.add('a/x.pdf', 'one');
  z.add('a/x.pdf', 'two');
  const b = z.bytes();
  const dv = new DataView(b.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  assert.equal(dv.getUint32(b.length - 22, true), 0x06054b50);
  assert.equal(dv.getUint16(b.length - 22 + 10, true), 2);
  assert.match(new TextDecoder().decode(b), /a\/x \(2\)\.pdf/);
});

test('month-end checklist: the Slab steps, ticked with who and when, and the app’s evidence', async () => {
  const { closeChecklist, checklistRows, STEPS } = await import('../app/js/close/checklist.js');
  const c = closeChecklist('2026-09', {
    rec: { statements: { operating: { fileName: 'CassOperating_2026-09.pdf', attachedBy: 'Alex', attachedAt: '2026-10-02T10:00:00Z' }, incoming: {}, outgoing: {} } },
    aging: { fileName: 'APAging_2026-09.xlsx', uploadedBy: 'Alex' }, apTies: true, apLate: 0,
    govDocs: [{ type: 'cc-compilation', period: '2026-09', fileName: 'CCCompilation_2026-09.pdf', uploadedBy: 'Joel' }],
    close: { ticks: { 'cass-op': { prepared: { by: 'Alex', at: '2026-10-03T10:00:00Z' }, approved: { by: 'Joel', at: '2026-10-04T10:00:00Z' } }, stripe: { prepared: { by: 'Alex', at: 'x' } } } },
  });
  const s = Object.fromEntries(c.steps.map((x) => [x.id, x]));
  assert.equal(s['cass-op'].done, true);
  assert.deepEqual(s['cass-op'].evidence.detail, { by: 'Alex', at: '2026-10-02T10:00:00Z', file: 'CassOperating_2026-09.pdf' });
  assert.equal(s.stripe.done, false); // prepared, not approved
  assert.equal(s['ap-aging'].evidence.label, 'Ties to GL 2010');
  assert.equal(s.cc.evidence.ok, true); // September is a CC compilation month
  assert.equal(s.divvy.evidence, null); // done outside the app
  assert.ok(!closeChecklist('2026-08', {}).steps.some((x) => x.id === 'cc'));
  assert.ok(closeChecklist('2026-09', {}).steps.some((x) => x.id === 'ncf')); // quarterly
  assert.equal(c.done, 1);
  assert.equal(new Set(STEPS.map((x) => x.id)).size, STEPS.length);
  const rows = checklistRows([c]);
  assert.match(rows.find((r) => r[2] === 'Cass Operating')[5], /^Prepared: Alex 2026-10-03 10:00; Approved \/ released: Joel/);
});
