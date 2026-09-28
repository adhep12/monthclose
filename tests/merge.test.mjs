import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeChanges } from '../app/js/merge.js';

test('a pop-up’s changes go onto the month as it is now, without undoing what others saved', () => {
  const base = { month: 'm', bank: { wise: { rev: 1 } }, statements: { operating: { a: 1 } }, log: [{ what: 'x' }] };
  // Since the pop-up read it: someone confirmed PayPal and logged it.
  const current = { month: 'm', bank: { wise: { rev: 1 }, paypal: { confirmation: { by: 'B' } } }, statements: { operating: { a: 1 } }, log: [{ what: 'x' }, { what: 'B confirmed PayPal' }] };
  // The pop-up confirmed Wise and detached Operating.
  const local = { month: 'm', bank: { wise: { rev: 1, confirmation: { by: 'A' } } }, statements: {}, log: [{ what: 'x' }, { what: 'A confirmed Wise' }] };
  const out = mergeChanges(current, base, local);
  assert.deepEqual(out.bank.wise.confirmation, { by: 'A' });
  assert.deepEqual(out.bank.paypal.confirmation, { by: 'B' });
  assert.deepEqual(out.statements, {});
  assert.deepEqual(out.log.map((e) => e.what), ['x', 'B confirmed PayPal', 'A confirmed Wise']);
});
