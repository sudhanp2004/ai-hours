const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/total.js');
const { summarize, hasRecentHealthFlags, formatDuration, formatClock } = globalThis.__aiHours;

const HOUR = 3600000;
const NOW = 1790764800000;
const rec = (over) => ({ start: NOW - 2 * HOUR, end: null, flags: [], ...over });

test('sums every record with an end, whatever its outcome or source', () => {
  const { totalMs } = summarize([
    rec({ end: NOW - 2 * HOUR + 5000, outcome: 'completed' }),
    rec({ end: NOW - 2 * HOUR + 3000, outcome: 'stopped' }),
    rec({ end: NOW - 2 * HOUR + 2000, outcome: 'unknown', source: 'dom-only' }),
  ], NOW);
  assert.equal(totalMs, 10000);
});

test('negative durations (clock changed mid-response) count as zero', () => {
  assert.equal(summarize([rec({ end: NOW - 3 * HOUR })], NOW).totalMs, 0);
});

test('unknown counts only end-less records older than 1 h; younger ones are in progress', () => {
  const { unknown, totalMs } = summarize([
    rec({ start: NOW - 2 * HOUR }),
    rec({ start: NOW - 30 * 1000 }),
  ], NOW);
  assert.equal(unknown, 1);
  assert.equal(totalMs, 0);
});

test('health flags only matter for the last 7 days', () => {
  assert.equal(hasRecentHealthFlags([rec({ flags: ['dom-missing'], start: NOW - 8 * 24 * HOUR })], NOW), false);
  assert.equal(hasRecentHealthFlags([rec({ flags: ['dom-missing'], start: NOW - 24 * HOUR })], NOW), true);
  assert.equal(hasRecentHealthFlags([rec({})], NOW), false);
});

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(42999), '42s');
  assert.equal(formatDuration(60000), '1m 0s');
  assert.equal(formatDuration(754000), '12m 34s');
  assert.equal(formatDuration(HOUR), '1h 0m');
  assert.equal(formatDuration(3 * HOUR + 12 * 60000 + 59000), '3h 12m');
  assert.equal(formatDuration(312 * HOUR), '312h 0m');
});

test('formatClock always shows seconds, for the live counter', () => {
  assert.equal(formatClock(0), '0s');
  assert.equal(formatClock(42999), '42s');
  assert.equal(formatClock(754000), '12m 34s');
  assert.equal(formatClock(3 * HOUR + 12 * 60000 + 41000), '3h 12m 41s');
  assert.equal(formatClock(312 * HOUR), '312h 0m 0s');
});
