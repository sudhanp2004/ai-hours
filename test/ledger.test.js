// The ledger keeps the same count as liveTotal/breakdown, incrementally: finished records are
// summed once, and each tick only looks at the few that can still be gaining time.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/total.js');
const { createLedger, liveTotal, breakdown } = globalThis.__aiHours;

const NOW = 1790764800000;
// A deterministic mix of every kind of record the store can hold, including broken ones.
function randomRecords(n, seed = 7) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const sites = ['chatgpt', 'claude', 'gemini', undefined];
  const models = ['gpt-5', 'claude-opus-5-5', null];
  return Array.from({ length: n }, (_, i) => {
    const start = NOW - Math.floor(rnd() * 5 * 3600e3);
    const ms = (k) => Math.floor(rnd() * k); // whole milliseconds, as the tracker stores them
    const kind = Math.floor(rnd() * 7);
    const base = { id: 'r' + i, site: sites[i % 4], start, server: { model: models[i % 3] }, flags: [] };
    if (kind === 0) return { ...base, end: start + ms(4 * 3600e3) }; // finished (some past the cap)
    if (kind === 1) return { ...base, end: null, recovered: { durationMs: ms(1e6) } };
    if (kind === 2) return { ...base, end: null, outcome: 'pending', lastSeen: start + ms(9e4) };
    if (kind === 3) return { ...base, start: NOW - 20000, end: null, lastSeen: NOW - ms(50000) }; // live or stale
    if (kind === 4) return { ...base, end: start - 5 }; // broken: ends before it starts
    if (kind === 5) return { ...base, start: 'x', end: NOW }; // broken: not a number
    return { ...base, end: null, lastSeen: null }; // never got a sign of life
  });
}
const strip = (b) => JSON.parse(JSON.stringify(b));

test('the ledger agrees with liveTotal and breakdown on thousands of mixed records, over time', () => {
  const recs = randomRecords(3000);
  const ledger = createLedger();
  for (const r of recs) ledger.set('rec:' + r.id, r, NOW);
  for (const now of [NOW, NOW + 10000, NOW + 40000, NOW + 600000]) {
    assert.deepEqual(ledger.live(now), liveTotal(recs, now), `liveTotal at +${now - NOW}`);
    assert.deepEqual(strip(ledger.breakdown(now)), strip(breakdown(recs, now)), `breakdown at +${now - NOW}`);
  }
});

test('updating and deleting records keeps it in step', () => {
  const recs = randomRecords(500, 3);
  const ledger = createLedger();
  for (const r of recs) ledger.set('rec:' + r.id, r, NOW);
  // A live reply finishes, a pending one is recovered, one is removed.
  const live = recs.find((r) => r.end == null && r.outcome !== 'pending' && r.lastSeen != null);
  const done = { ...live, end: live.start + 5000 };
  const pending = recs.find((r) => r.outcome === 'pending');
  const recovered = { ...pending, recovered: { durationMs: 42000 } };
  ledger.set('rec:' + done.id, done, NOW);
  ledger.set('rec:' + recovered.id, recovered, NOW);
  ledger.delete('rec:' + recs[0].id);
  const now2 = recs.map((r) => (r === live ? done : r === pending ? recovered : r)).slice(1);
  assert.deepEqual(ledger.live(NOW + 1000), liveTotal(now2, NOW + 1000));
  assert.deepEqual(strip(ledger.breakdown(NOW + 1000)), strip(breakdown(now2, NOW + 1000)));
});

test('a reply that comes back to life (resumed after a refresh) is counted live again', () => {
  const ledger = createLedger();
  const r = { id: 'a', site: 'claude', start: NOW - 60000, end: null, outcome: 'pending', lastSeen: NOW - 50000, server: {} };
  ledger.set('rec:a', r, NOW);
  assert.deepEqual(ledger.live(NOW), { ms: 10000, working: 0 });
  ledger.set('rec:a', { ...r, outcome: 'unknown', lastSeen: NOW }, NOW);
  assert.deepEqual(ledger.live(NOW), { ms: 60000, working: 1 });
});

test('a tick touches only the replies that can still gain time', () => {
  const ledger = createLedger();
  for (const r of randomRecords(5000, 11)) ledger.set('rec:' + r.id, r, NOW);
  ledger.live(NOW + 120000); // everything is stale by now, so nothing stays active
  assert.equal(ledger.activeCount(), 0);
});
