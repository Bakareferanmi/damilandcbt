import test from 'node:test';
import assert from 'node:assert/strict';
import { AnswerQueue } from '../public/answer-queue.js';
import { memoryStorage, deferred } from './helpers.mjs';

const options = (extra = {}) => ({ key: 'student:1:attempt:1', storage: memoryStorage(), allowed: [1, 2, 3, 4, 5], send: async (id, chosen, revision) => ({ chosen, revision }), ...extra });

test('submit waits for an in-flight save and sends the newer choice next', async () => {
  const first = deferred(), calls = [];
  const q = new AnswerQueue(options({ send: async (id, chosen, revision) => { calls.push(chosen); if (revision === 1) await first.promise; return { chosen, revision }; } }));
  q.choose(1, 'A'); const saving = q.flush();
  q.choose(1, 'B'); const submitting = q.flush();
  let done = false; submitting.then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false);
  first.resolve(); await Promise.all([saving, submitting]);
  assert.deepEqual(calls, ['A', 'B']); assert.equal(q.count, 0);
});

test('failed saves survive refresh and are isolated by student and attempt', async () => {
  const storage = memoryStorage();
  const q = new AnswerQueue(options({ storage, send: async () => { throw Error('offline'); } }));
  q.choose(1, 'C'); await assert.rejects(q.flush(), /offline/);
  const restored = new AnswerQueue(options({ storage }));
  assert.equal(restored.answers[1], 'C'); assert.equal(restored.count, 1);
  assert.equal(new AnswerQueue(options({ storage, key: 'student:2:attempt:2' })).count, 0);
  await restored.flush(); assert.equal(storage.getItem(q.key), null);
});

test('lost acknowledgements reconcile with the server without replaying old choices', () => {
  const storage = memoryStorage(); const q = new AnswerQueue(options({ storage })); q.choose(1, 'B');
  const restored = new AnswerQueue(options({ storage, answers: { 1: 'B' }, revisions: { 1: 1 } }));
  assert.equal(restored.count, 0);
});

test('server revisions win over older local choices', () => {
  const storage = memoryStorage(); const q = new AnswerQueue(options({ storage })); q.choose(1, 'B');
  const restored = new AnswerQueue(options({ storage, answers: { 1: 'D' }, revisions: { 1: 2 } }));
  assert.equal(restored.answers[1], 'D'); assert.equal(restored.count, 0); assert.equal(restored.conflicts, 1);
});

test('a reconnect uses at most three concurrent saves', async () => {
  let current = 0, peak = 0;
  const q = new AnswerQueue(options({ send: async (id, chosen, revision) => { peak = Math.max(peak, ++current); await Promise.resolve(); current--; return { chosen, revision }; } }));
  for (let id = 1; id <= 5; id++) q.choose(id, 'A');
  await q.flush(); assert.equal(peak, 3); assert.equal(q.count, 0);
});

test('storage failure keeps in-memory choices and reports that refresh recovery is unavailable', async () => {
  const q = new AnswerQueue(options({ storage: { getItem() { throw Error(); }, setItem() { throw Error(); }, removeItem() { throw Error(); } } }));
  q.choose(1, 'D'); assert.equal(q.storageError, true); assert.equal(q.answers[1], 'D');
  await q.flush(); assert.equal(q.count, 0); assert.equal(q.storageError, true);
});

test('unacknowledged or conflicting revisions never leave the pending queue', async () => {
  const q = new AnswerQueue(options({ send: async () => ({ chosen: 'D', revision: 9 }) }));
  q.choose(1, 'B'); await assert.rejects(q.flush(), /another request/);
  assert.equal(q.count, 1); assert.ok(q.terminal);
});
