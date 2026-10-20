import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { deferred } from './helpers.mjs';

const html = readFileSync('public/exam.html', 'utf8');
const source = html.slice(html.indexOf('async function finish(auto)'), html.indexOf('\nfunction showDone()'));
function harness({ flush = async () => {}, api } = {}) {
  const elements = new Map();
  const context = vm.createContext({
    finishing: false, tick: null, retryTimer: null, submitFails: 0, deadline: 100000, data: { attemptId: 1 },
    queue: { flush, terminal: null }, api, makeQueue() {}, showDone() {}, flush() {}, updateTimer() {},
    performance: { now: () => 0 }, clearInterval() {}, clearTimeout() {}, setInterval() {}, setTimeout() {},
    $: (id) => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); },
  });
  vm.runInContext(source, context);
  return { context, elements, finish: (auto = false) => vm.runInContext(`finish(${auto})`, context) };
}

test('voluntary submission does not proceed after a failed answer save', async () => {
  let submits = 0;
  const h = harness({ flush: async () => { throw Error('offline'); }, api: async () => { submits++; } });
  await h.finish(); assert.equal(submits, 0); assert.equal(h.context.finishing, false);
  assert.match(h.elements.get('saved').textContent, /offline/);
});

test('submission waits for pending saves before making the submit request', async () => {
  const saving = deferred(); let calls = 0;
  const h = harness({ flush: () => saving.promise, api: async () => { calls++; return { ok: true, data: { attemptId: 1, status: 'submitted' } }; } });
  const result = h.finish(); await Promise.resolve(); assert.equal(calls, 0);
  saving.resolve(); await result; assert.equal(calls, 2);
});

test('a rejected submit request resets the guard so a later retry succeeds', async () => {
  let attempts = 0;
  const h = harness({ api: async () => { if (++attempts === 1) throw Error('network lost'); return { ok: true, data: { attemptId: 1, status: 'submitted' } }; } });
  await h.finish(); assert.equal(h.context.finishing, false);
  assert.equal(h.elements.get('submit-btn').disabled, false);
  await h.finish(); assert.equal(attempts, 3);
});

test('automatic submission at expiry can finalise accepted work while retaining pending choices', async () => {
  let calls = 0;
  const h = harness({ flush: async () => { throw Error('offline'); }, api: async () => { calls++; return { ok: true, data: { attemptId: 1, status: 'submitted' } }; } });
  await h.finish(true); assert.equal(calls, 2); assert.equal(h.context.finishing, false);
});

test('an old attempt response stops retries instead of submitting the replacement attempt', async () => {
  const h = harness({ api: async () => ({ ok: false, status: 409, data: { attemptChanged: true, error: 'Refresh the exam' } }) });
  await h.finish(); assert.equal(h.context.queue.terminal.terminal, true);
  assert.equal(h.context.finishing, false); assert.equal(h.elements.get('submit-btn').disabled, true);
});
