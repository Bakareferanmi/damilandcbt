import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

for (const page of ['exam', 'results']) {
  test(`${page}: result printing waits for signature images and cleans up afterward`, async () => {
    const harness = setup(page);
    const printing = harness.run();
    assert.equal(harness.prints, 0);
    assert.match(harness.box.innerHTML, /\/signatures\/gm.png/);
    assert.match(harness.box.innerHTML, /\/signatures\/principal.png/);
    for (const image of ['gm', 'principal']) assert.ok(existsSync(`public/signatures/${image}.png`));
    harness.resolve();
    await printing;
    assert.equal(harness.prints, 1);
    assert.equal(harness.printing, true);
    harness.afterprint();
    assert.equal(harness.removed, true);
    assert.equal(harness.printing, false);
  });
  test(`${page}: missing images prevent an unsigned slip from printing`, async () => {
    const harness = setup(page);
    const printing = harness.run();
    harness.reject(new Error('Image failed to load'));
    await printing;
    assert.equal(harness.prints, 0);
    assert.equal(harness.removed, true);
    assert.equal(harness.alerts, 1);
  });
}

function setup(page) {
  const html = readFileSync(`public/${page}.html`, 'utf8');
  const start = html.indexOf(page === 'exam' ? 'const pctOf =' : 'function slipHtml(x)');
  const end = html.indexOf(page === 'exam' ? "$('slip-csv').onclick" : "$('print-all').onclick", start);
  const h = { prints: 0, removed: false, printing: false, alerts: 0 };
  const loaded = new Promise((resolve, reject) => { h.resolve = resolve; h.reject = reject; });
  h.box = { innerHTML: '', querySelectorAll: () => [{ decode: () => loaded }], remove: () => { h.removed = true; } };
  const button = {};
  const x = { fullName: 'Test Student', code: 'TEST001', className: 'SS3 Science', groupNo: 1, scores: [], total: 0, outOf: 0 };
  const context = vm.createContext({
    $, esc: String, data: { slip: x, results: [] }, sessionName: '2026/2027', examNameTxt: 'Test exam', x,
    document: { getElementById: () => null, createElement: () => h.box,
      body: { appendChild() {}, classList: { add: () => { h.printing = true; }, remove: () => { h.printing = false; } } } },
    window: { print: () => { h.prints++; }, addEventListener: (_, callback) => { h.afterprint = callback; } },
    requestAnimationFrame: callback => callback(), alert: () => { h.alerts++; }
  });
  function $(id) { assert.equal(id, 'slip-print'); return button; }
  vm.runInContext(html.slice(start, end), context);
  h.run = () => page === 'exam' ? button.onclick() : vm.runInContext('printSlips([x])', context);
  return h;
}
