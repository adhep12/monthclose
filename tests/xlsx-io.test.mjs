import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noLongDashes } from '../app/js/xlsx-io.js';

test('exports use a short dash, never an em or en dash', () => {
  assert.equal(noLongDashes('Deposit in transit — 3.3.2026 February Deposit'), 'Deposit in transit - 3.3.2026 February Deposit');
  assert.equal(noLongDashes('the GL agrees—booked to 2042'), 'the GL agrees - booked to 2042');
  assert.equal(noLongDashes('Oct–Aug'), 'Oct-Aug');
  assert.equal(noLongDashes('A-2026-02-001'), 'A-2026-02-001');
  assert.equal(noLongDashes(-400), -400);
});
