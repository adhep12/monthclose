import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '../app/vendor/xlsx.mjs';
import { valueUnits, tieOut, adjustingJe, stripeReclass, monthInputs, DEFAULT_INVENTORY_CONFIG } from '../app/js/inventory/tieout.js';
import { parseInventoryGrid, parseDistribution, parseProductSales } from '../app/js/inventory/parse.js';
import { rollForward, firstKnownMonth } from '../app/js/fa/rollforward.js';
import { isBalanced } from '../app/js/fa/je.js';

const book = (sheets) => { const wb = XLSX.utils.book_new(); for (const [n, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), n); return wb; };

test('valuation: first in, first out keeps the newest cost; average blends; a cost per unit has no limit', () => {
  const mugs = [{ units: 10008, total: 166466.66 }, { units: 5016, total: 86854.48 }];
  assert.equal(valueUnits(3122, mugs).value, 54058.95);
  assert.equal(valueUnits(6000, mugs).value, round(86854.48 + 984 * 166466.66 / 10008));
  assert.equal(valueUnits(3122, mugs, 'average').value, round(3122 * (166466.66 + 86854.48) / 15024));
  assert.equal(valueUnits(2561, [{ unitCost: 4.45 }]).value, 11396.45);
  assert.equal(valueUnits(5946, [{ units: 10090, total: 135169.73 }]).value, 79655.03);
  assert.match(valueUnits(20000, mugs).note, /more units than the purchases/);
  // As the workbook valued mugs in September 2026 (3,122 units).
  assert.equal(valueUnits(3122, mugs, 'workbook').value, 55373.54);
});
const round = (n) => Math.round(n * 100) / 100;

const sept = {
  warehouse: { units: { 5100: 5806, 4001: 2558, '8000-TM-WHT': 3122 } }, pdx: { ctb: 140, pcb: 3 },
  prior: { ctb: 81182.22, pcb: 12468.90, mug: 57203.21 },
  distribution: [
    { dept: 'People - 021', sub: '021-817', item: 'How to Read the Bible', qty: 3, cost: 40.20, account: '9000', category: 'Coffee Table Book', info: 'new hire gift' },
    { dept: 'Marketing - 008', sub: '008-000', item: 'How to Read the Bible', qty: 1, cost: 13.40, account: '9000', category: 'Coffee Table Book', info: '' },
    { dept: 'Investor Relations - 020', sub: '020-000', item: 'How to Read the Bible', qty: 6, cost: 80.40, account: '9000', category: 'Coffee Table Book', info: 'Street Lights' },
    { dept: 'Patron Care - 020', sub: '020-320', item: 'Icon Ball Cap', qty: 1, cost: 17.89, account: '9011', category: 'Accessories', info: '' },
    { dept: 'Strategic Relationships - 006', sub: '006-000', item: 'Icon tote', qty: 1, cost: 11.86, account: '9011', category: 'Accessories', info: '' },
    { dept: 'X', sub: '000-000', item: 'DVD KIT', qty: 1, cost: 5, account: null, category: 'None', info: '' },
  ],
};

test('tie-out: the September workbook’s coffee table books and poster books, to the cent', () => {
  const t = tieOut(sept);
  const [ctb, pcb] = t.items;
  assert.deepEqual([ctb.units, ctb.value, ctb.diff, ctb.allocated, ctb.perks], [5946, 79655.03, -1527.19, 134, 1393.19]);
  assert.deepEqual([pcb.units, pcb.value, pcb.diff], [2561, 11396.45, -1072.45]);
  assert.deepEqual(t.other.map((g) => [g.account, g.total]), [['9011', 29.75]]);
  assert.equal(t.unmapped.length, 1);
  const je = adjustingJe(t);
  assert.ok(isBalanced(je));
  assert.deepEqual(je.slice(0, 2).map((l) => [l.account, l.sub, l.debit, l.credit, l.tranDescription]), [['1500', '000-000', 0, 1527.19, 'Adjusting Inventory Numbers'], ['9000', '020-320', 1393.19, 0, 'Coffee Table Book - Perks']]);
  assert.ok(je.some((l) => l.account === '9000' && l.sub === '021-817' && l.debit === 40.2 && l.tranDescription === 'How to Read the Bible - new hire gift - 3'));
  assert.ok(je.some((l) => l.account === '9011' && l.sub === '009-000' && l.credit === 29.75 && l.tranDescription === 'Accessories'));
  // No GL balance for an item: nothing to book yet.
  assert.deepEqual(adjustingJe(tieOut({ ...sept, prior: { ctb: 1 } })), []);
});

test('the GL before adjusting comes from last month’s trial balance, or what was typed', () => {
  const m = monthInputs({ priorTyped: { pcb: 100, mug: 5 } }, { 1500: { end: 81182.22 }, 1506: { end: 7 } });
  assert.deepEqual(m.prior, { ctb: 81182.22, pcb: 100, mug: 7 });
  assert.deepEqual(m.priorFrom, { ctb: 'tb', pcb: 'typed', mug: 'tb' });
});

test('Stripe reclass: HQ stock counts, discounts come off poster books, shipping to COGS', () => {
  const r = stripeReclass({
    'How to Read the Bible: Literary Styles in Scripture': { qty: 78, total: 3510 },
    'How to Read the Bible: Literary Styles in Scripture Book (HQ STOCK)': { qty: 4, total: 180 },
    'BibleProject Read Scripture Poster Collection Book': { qty: 288, total: 10080 },
    DISCOUNT: { qty: 44, total: -6525.5 },
    'BibleProject Travel Mug': { qty: 44, total: 1540 }, 'BibleProject Travel Mug  (HQ STOCK)': { qty: 4, total: 140 },
    'BibleProject Video Thumb Drive': { qty: 16, total: 640 }, SHIPPING: { qty: 9, total: 172.5 },
    'BibleProject Coffee Table Book': { qty: 2, total: 120 }, 'Icon Hoodie-Black-LG': { qty: 5, total: 300 },
  });
  assert.equal(r.total, 9737); // March 2026 in the workbook
  assert.deepEqual(r.lines.map((l) => [l.account, l.sub, l.debit || -l.credit]), [['4015', '000-000', 9737], ['4081', '000-000', -3690], ['4084', '000-000', -3554.5], ['4083', '000-000', -640], ['9050', '009-000', -172.5], ['4085', '000-000', -1680]]);
  assert.deepEqual(stripeReclass({}).lines, []);
});

test('reports: Extensiv units by SKU, the distribution log by month with subaccounts, product sales by month', () => {
  const grid = parseInventoryGrid(XLSX, book({ Sheet1: [['#', ' Description', 'SKU', 'Available Primary', 'Hold Status', 'Warehouse'], [1, 'Mug', '8000-TM-WHT', 3112, 'TRUE', 'McDonough'], [2, 'Book', '5100', 5806, 'FALSE', 'McDonough']] }));
  assert.deepEqual(grid.units, { '8000-TM-WHT': 3112, 5100: 5806 });
  const ref = [['Item Name', 'Cost/Item', 'Category', 'Account #', '', '', '', '', '', '', '', 'Inventory'], ['How to Read', 13.4, 'Coffee Table Book', '', '', '', '', '', '', '', '', '9000', 'Coffee Table Book'], ['Icon Ball Cap', 17.89, 'Accessories', '', '', '', '', '', '', '', '', '9011', 'Accessories']];
  const dist = parseDistribution(XLSX, book({
    'Johanna Input': [['Year', 'Month', 'Department', 'Grant #', 'Item', 'Quantity', 'Total Cost', 'Category', 'Info'],
      [2026, 'September', 'People - 021', 'New Hire Gift - 817', 'How to Read', 3, 40.2, 'Coffee Table Book', 'new hire gift'],
      [2026, 'September', 'Patron Care - 020', '', 'Icon Ball Cap', 1, '', '', ''],
      [2026, 'August', 'Global - 005', '', 'How to Read', 1, 13.4, 'Coffee Table Book', '']],
    Reference: ref }));
  assert.deepEqual(dist.months['2026-09'].map((d) => [d.sub, d.account, d.cost]), [['021-817', '9000', 40.2], ['020-320', '9011', 17.89]]);
  assert.equal(dist.months['2026-08'][0].sub, '005-000');
  const sales = parseProductSales(XLSX, book({ R: [['Product Sales By Product & Month (v2)'], ['Close Date greater or equal 9/1/2017'], ['Close Date →', 'August 2026', '', '', 'September 2026', '', ''], ['Product Name', 'Qty', '$', 'n', 'Qty', '$', 'n'], ['SHIPPING', 2, 57, 2, 33, 1042, 30], ['DISCOUNT', 1, -10, 1, 0, 0, 0], ['Total', 3, 47, 3, 33, 1042, 30]] }));
  assert.deepEqual(sales.months, { '2026-08': { SHIPPING: { qty: 2, total: 57 }, DISCOUNT: { qty: 1, total: -10 } }, '2026-09': { SHIPPING: { qty: 33, total: 1042 } } });
});

test('fixed asset roll-forward: opening + additions − disposals = ending, for cost and depreciation', () => {
  const imported = { id: 'a', name: 'Studio', group: '1560', cost: 12000, inService: '2020-01-15', lifeMonths: 60, method: 'FIXED', fixedMonthly: 200, convention: 'next-month', openingAD: 6000, openingAsOf: '2026-09' };
  const bought = { id: 'b', name: 'Camera', group: '1540', cost: 9000, inService: '2026-10-20', lifeMonths: 60, method: 'SL', convention: 'next-month' };
  const sold = { id: 'c', name: 'Laptop', group: '1540', cost: 3000, inService: '2023-01-10', lifeMonths: 60, method: 'FIXED', fixedMonthly: 50, convention: 'next-month', openingAD: 2000, openingAsOf: '2026-09', disposal: { date: '2026-11-30', proceeds: 400 } };
  assert.equal(firstKnownMonth([imported, sold]), '2026-10');
  const rf = rollForward([imported, bought, sold], '2026-10', '2026-12');
  const eq = rf.groups.find((g) => g.asset === '1540');
  assert.deepEqual([eq.openCost, eq.additions, eq.disposals, eq.endCost], [3000, 9000, 3000, 9000]);
  assert.deepEqual([eq.openAD, eq.depreciation, eq.disposalAD, eq.endAD], [2000, 400, 2100, 300]);
  assert.ok(rf.groups.every((g) => g.ties));
  const st = rf.groups.find((g) => g.asset === '1560');
  assert.deepEqual([st.openAD, st.depreciation, st.endAD, st.nbv], [6000, 600, 6600, 5400]);
});

test('defaults: three inventory items on 1500/1505/1506', () => {
  assert.deepEqual(DEFAULT_INVENTORY_CONFIG.items.map((i) => [i.account, i.expense, i.skus[0]]), [['1500', '9000', '5100'], ['1505', '9004', '4001'], ['1506', '9005', '8000-TM-WHT']]);
});
