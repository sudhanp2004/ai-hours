const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/verify.js');
const { withinPairWindow, classify } = globalThis.__aiHours;

test('pair window: 500 ms before to 2000 ms after the fetch start', () => {
  assert.ok(withinPairWindow(1000, 1060));
  assert.ok(withinPairWindow(1000, 3000));
  assert.ok(!withinPairWindow(1000, 3001));
  assert.ok(withinPairWindow(1000, 500));
  assert.ok(!withinPairWindow(1000, 499));
});

test('fetch + dom → high confidence, no flags', () => {
  assert.deepEqual(classify({ fetch: { end: 5000 }, dom: { start: 1060, end: 7000 } }),
    { source: 'fetch+dom', confidence: 'high', flags: [] });
});

test('fetch only → dom-missing', () => {
  assert.deepEqual(classify({ fetch: { end: 5000 }, dom: null }),
    { source: 'fetch-only', confidence: 'high', flags: ['dom-missing'] });
});

test('dom only → low confidence, fetch-missing', () => {
  assert.deepEqual(classify({ fetch: null, dom: { start: 1000, end: 4000 } }),
    { source: 'dom-only', confidence: 'low', flags: ['fetch-missing'] });
});

test('end gap over 10 s → large-gap; exactly 10 s is fine', () => {
  assert.deepEqual(classify({ fetch: { end: 5000 }, dom: { start: 1000, end: 15001 } }).flags, ['large-gap']);
  assert.deepEqual(classify({ fetch: { end: 5000 }, dom: { start: 1000, end: 15000 } }).flags, []);
});

test('dom still visible (end null) → no gap flag yet', () => {
  assert.deepEqual(classify({ fetch: { end: 5000 }, dom: { start: 1000, end: null } }).flags, []);
});
