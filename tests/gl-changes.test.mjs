import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glChanges, fingerprint } from '../app/js/gl.js';

test('a new GL upload is compared with the last one, batch by batch', () => {
  const before = { index: { A: { fp: 'f1', total: 100, desc: 'a' }, B: { fp: 'f2', total: 200, desc: 'b' }, C: { fp: 'f3', total: 50, desc: 'c' } } };
  const after = { index: { A: { fp: 'f1', total: 100, desc: 'a' }, B: { fp: 'f9', total: 215, desc: 'b' }, D: { fp: 'f4', total: 70, desc: 'd' } } };
  const ch = glChanges(before, after);
  assert.deepEqual(ch.added.map((x) => x.batch), ['D']);
  assert.deepEqual(ch.changed.map((x) => [x.batch, x.was, x.now]), [['B', 200, 215]]);
  assert.deepEqual(ch.removed.map((x) => x.batch), ['C']);
  assert.equal(glChanges({}, after), null);
});

test('a batch fingerprint changes when a line’s account or amount changes', () => {
  const a = [{ id: 'GL GL1 1', a: '1100', amt: 100 }, { id: 'GL GL1 2', a: '4018', amt: -100 }];
  assert.equal(fingerprint(a), fingerprint([...a].reverse()));
  assert.notEqual(fingerprint(a), fingerprint([a[0], { ...a[1], a: '2052' }]));
  assert.notEqual(fingerprint(a), fingerprint([a[0], { ...a[1], amt: -90 }]));
});
