import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmValues, confirmationState } from '../app/js/audit.js';

test('a confirmation still holds when storage returns the figures reordered or without empty fields', () => {
  const b = confirmValues({}, 'Alex', { rev: 2247222.66, int: null, ending: 2624741.64 });
  // As a database might hand it back: keys sorted, the null dropped.
  b.confirmation.values = { ending: 2624741.64, rev: 2247222.66 };
  assert.equal(confirmationState(b, { rev: 2247222.66, int: null, ending: 2624741.64 }), 'confirmed');
  assert.equal(confirmationState(b, { rev: 2247222.66, int: undefined, ending: 2624741.640000001 }), 'confirmed');
  // A real change still shows.
  assert.equal(confirmationState(b, { rev: 2247300, int: null, ending: 2624741.64 }), 'stale');
});
