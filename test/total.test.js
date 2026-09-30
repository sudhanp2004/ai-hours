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

// ---- liveTotal: the pill counts every tab, not just its own
const { liveTotal } = globalThis.__aiHours;
const LIVE = 30000; // well inside the 30 s stale cutoff
const STALE_AFTER_MS = 30000;

const live = (start, over) => ({ end: null, lastSeen: null, outcome: 'unknown', ...over, start });
const saved = (start, end, over) => ({ end, lastSeen: null, outcome: 'completed', ...over, start });

test('liveTotal counts a finished record once, via its end', () => {
  const r = liveTotal([saved(NOW - 60000, NOW - 30000)], NOW);
  assert.equal(r.ms, 30000);
  assert.equal(r.working, 0, 'a finished record is not working');
});

test('liveTotal counts two open replies in two tabs at 2 s per second', () => {
  const records = [
    live(NOW - LIVE, { tabId: 1, lastSeen: NOW - 100 }),
    live(NOW - LIVE, { tabId: 2, lastSeen: NOW - 100 }),
  ];
  assert.deepEqual(liveTotal(records, NOW), { ms: LIVE * 2, working: 2 });
  assert.equal(liveTotal(records, NOW + 1000).ms, LIVE * 2 + 2000);
});

test('liveTotal adds a recovered record by its recovered duration, never end - start', () => {
  const rec = {
    start: NOW - 100000, end: null, outcome: 'recovered', lastSeen: NOW - 95000,
    recovered: { durationMs: 45000 }, // includes time after the tab was closed
  };
  assert.equal(liveTotal([rec], NOW).ms, 45000);
});

test('liveTotal excludes a pending record: a closed tab stops counting at once', () => {
  const records = [
    saved(NOW - 60000, NOW - 50000),
    live(NOW - 40000, { tabId: 9, outcome: 'pending', lastSeen: NOW - 30000 }),
  ];
  assert.deepEqual(liveTotal(records, NOW), { ms: 10000, working: 0 });
});

test('liveTotal stops counting an open record with no sign of life for 30 s', () => {
  const fresh = [live(NOW - 10000, { lastSeen: NOW - (STALE_AFTER_MS - 1000) })];
  assert.equal(liveTotal(fresh, NOW).ms, 10000, 'a tab still streaming is inside the cutoff');
  const dead = [live(NOW - 100000, { lastSeen: NOW - (STALE_AFTER_MS + 1000) })];
  assert.equal(liveTotal(dead, NOW).ms, 0, 'a crashed browser cannot be watched further');
});

test('liveTotal falls back to start when a record never got a sign of life', () => {
  assert.equal(liveTotal([live(NOW - 4000, {})], NOW).ms, 4000);
});

test('liveTotal ignores a negative elapsed time (clock moved backwards)', () => {
  assert.equal(liveTotal([live(NOW + 60000, { lastSeen: NOW + 60000 })], NOW).ms, 0);
});

test('liveTotal matches the saved total for a set with nothing in flight', () => {
  const records = [
    saved(NOW - 90000, NOW - 60000, { outcome: 'stopped' }),
    saved(NOW - 50000, NOW - 40000, { source: 'dom-only' }),
  ];
  assert.equal(liveTotal(records, NOW).ms, summarize(records, NOW).totalMs);
});

test('the pill width matches the number of tabs gaining time', () => {
  const records = [
    live(NOW - 5000, { tabId: 1, lastSeen: NOW }),
    live(NOW - 5000, { tabId: 2, lastSeen: NOW }),
    saved(NOW - 40000, NOW - 30000, { tabId: 3 }),
  ];
  assert.equal(liveTotal(records, NOW).working, 2);
});

test('formatClock always shows seconds, for the live counter', () => {
  assert.equal(formatClock(0), '0s');
  assert.equal(formatClock(42999), '42s');
  assert.equal(formatClock(754000), '12m 34s');
  assert.equal(formatClock(3 * HOUR + 12 * 60000 + 41000), '3h 12m 41s');
  assert.equal(formatClock(312 * HOUR), '312h 0m 0s');
});
