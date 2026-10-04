const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/verify.js');
require('../extension/src/tracker.js');
const { createTracker } = globalThis.__aiHours;

function setup() {
  const writes = [];
  let n = 0;
  const tracker = createTracker({ site: 'chatgpt', tabId: 7, newId: () => `dom-${++n}`, write: (r) => writes.push(structuredClone(r)) });
  const latest = (id) => writes.filter((r) => r.id === id).at(-1);
  const sig = (type, fields) => tracker.onSignal({ __aih: 1, type, ...fields });
  const show = (t) => { tracker.domRaw(true, t); tracker.confirm(t + 350); };
  const hide = (t) => { tracker.domRaw(false, t); tracker.confirm(t + 350); };
  return { tracker, writes, latest, sig, show, hide };
}

const msg = (over) => ({
  kind: 'message', role: 'assistant', contentType: 'text', status: 'in_progress', messageId: null,
  createTime: null, turnExchangeId: null, requestId: null, reasoningStart: null, reasoningEnd: null, ...over,
});

test('start writes an unknown record immediately', () => {
  const { writes, sig } = setup();
  sig('start', { localId: 'a', t: 1000, sent: { conversationId: 'c1', messageId: 'u1' } });
  assert.deepEqual(writes, [{
    id: 'a', site: 'chatgpt', tabId: 7, start: 1000, firstByte: null, finished: null, end: null,
    lastSeen: null, outcome: 'unknown', source: 'fetch-only', confidence: 'high', flags: [],
    dom: null, sent: { conversationId: 'c1', messageId: 'u1' }, recovered: null, server: {},
  }]);
});

test('the record carries its tab id, so a close can be matched to it', () => {
  const { latest, sig } = setup();
  sig('start', { localId: 'a', t: 1000 });
  assert.equal(latest('a').tabId, 7);
});

test('a missing sent payload still records empty ids, never undefined', () => {
  const { latest, sig } = setup();
  sig('start', { localId: 'a', t: 1000 });
  assert.deepEqual(latest('a').sent, { conversationId: null, messageId: null });
});

test('every chunk refreshes lastSeen, which is the sign of life for other tabs', () => {
  const { latest, sig } = setup();
  sig('start', { localId: 'a', t: 1000 });
  sig('firstByte', { localId: 'a', t: 3000 });
  sig('alive', { localId: 'a', t: 5000 });
  assert.equal(latest('a').lastSeen, 5000);
});

test('alive for an unknown stream is ignored, not written as a phantom record', () => {
  const { writes, sig } = setup();
  sig('alive', { localId: 'ghost', t: 5000 });
  assert.deepEqual(writes, []);
});

test('completed stream with stop button → fetch times, high confidence', () => {
  const { latest, sig, show, hide } = setup();
  sig('start', { localId: 'a', t: 1000 });
  show(1060);
  sig('firstByte', { localId: 'a', t: 3900 });
  sig('message', { localId: 'a', sig: msg({ role: 'user', turnExchangeId: 'turn-1', requestId: 'req-1' }) });
  sig('message', { localId: 'a', sig: msg({ messageId: 'm1', createTime: 1790764724.1, turnExchangeId: 'turn-1' }) });
  sig('finished', { localId: 'a', t: 5000 });
  sig('end', { localId: 'a', t: 5900, lastChunk: 5900, outcome: 'completed' });
  hide(8600);
  const r = latest('a');
  assert.equal(r.outcome, 'completed');
  assert.equal(r.end, 5900);
  assert.equal(r.firstByte, 3900);
  assert.equal(r.finished, 5000);
  assert.equal(r.source, 'fetch+dom');
  assert.equal(r.confidence, 'high');
  assert.deepEqual(r.flags, []);
  assert.deepEqual(r.dom, { start: 1060, end: 8600 });
  assert.deepEqual(r.server, { turnExchangeId: 'turn-1', requestId: 'req-1', messageId: 'm1', msgCreate: 1790764724.1 });
});

test('stop → outcome stopped, end at the stop request time', () => {
  const { latest, sig, show } = setup();
  sig('start', { localId: 'a', t: 1000 });
  show(1060);
  sig('stop', { t: 9000 });
  sig('end', { localId: 'a', t: 14500, lastChunk: 14500, outcome: 'completed' });
  assert.equal(latest('a').outcome, 'stopped');
  assert.equal(latest('a').end, 9000);
});

test('stop applies only to the most recent open stream', () => {
  const { latest, sig } = setup();
  sig('start', { localId: 'a', t: 1000 });
  sig('start', { localId: 'b', t: 2000 });
  sig('stop', { t: 3000 });
  sig('end', { localId: 'a', t: 5000, lastChunk: 5000, outcome: 'completed' });
  sig('end', { localId: 'b', t: 6000, lastChunk: 6000, outcome: 'completed' });
  assert.equal(latest('a').outcome, 'completed');
  assert.equal(latest('a').end, 5000);
  assert.equal(latest('b').outcome, 'stopped');
  assert.equal(latest('b').end, 3000);
});

test('read error or close without [DONE] → error, end at last chunk', () => {
  const { latest, sig } = setup();
  sig('start', { localId: 'a', t: 1000 });
  sig('end', { localId: 'a', t: 20000, lastChunk: 12000, outcome: 'error' });
  sig('start', { localId: 'b', t: 30000 });
  sig('end', { localId: 'b', t: 40000, lastChunk: 35000, outcome: 'closed' });
  assert.deepEqual([latest('a').outcome, latest('a').end], ['error', 12000]);
  assert.deepEqual([latest('b').outcome, latest('b').end], ['error', 35000]);
});

test('rejected before any chunk → error, end at rejection time', () => {
  const { latest, sig } = setup();
  sig('start', { localId: 'a', t: 1000 });
  sig('end', { localId: 'a', t: 1800, lastChunk: null, outcome: 'error' });
  assert.equal(latest('a').end, 1800);
});

test('fetch with no stop button → fetch-only, dom-missing', () => {
  const { latest, sig } = setup();
  sig('start', { localId: 'a', t: 1000 });
  sig('end', { localId: 'a', t: 5000, lastChunk: 5000, outcome: 'completed' });
  assert.equal(latest('a').source, 'fetch-only');
  assert.deepEqual(latest('a').flags, ['dom-missing']);
});

test('stop button hiding >10 s after [DONE] re-writes the record with large-gap', () => {
  const { latest, sig, show, hide } = setup();
  sig('start', { localId: 'a', t: 1000 });
  show(1060);
  sig('end', { localId: 'a', t: 5000, lastChunk: 5000, outcome: 'completed' });
  assert.deepEqual(latest('a').flags, []);
  hide(16000);
  assert.deepEqual(latest('a').flags, ['large-gap']);
});

test('stop button shown just before the fetch start is still paired', () => {
  const { latest, sig, show } = setup();
  show(1000);
  sig('start', { localId: 'a', t: 1300 });
  sig('end', { localId: 'a', t: 5000, lastChunk: 5000, outcome: 'completed' });
  assert.equal(latest('a').source, 'fetch+dom');
});

test('stop-button flicker under 300 ms is ignored', () => {
  const { tracker, writes } = setup();
  tracker.domRaw(true, 1000);
  tracker.domRaw(false, 1100);
  tracker.confirm(1500);
  tracker.tick(20000);
  assert.equal(writes.length, 0);
});

test('stop button with no fetch → one dom-only record after 10 s', () => {
  const { tracker, writes, show, hide } = setup();
  show(1000);
  hide(4000);
  tracker.tick(10999);
  assert.equal(writes.length, 0);
  tracker.tick(11001);
  tracker.tick(12000);
  // A DOM-only record has the same shape as every other record, so the total treats them
  // alike. Its sign of life is the moment the stop button went away.
  assert.deepEqual(writes, [{
    id: 'dom-1', site: 'chatgpt', tabId: 7, start: 1000, firstByte: null, finished: null, end: 4000,
    lastSeen: 4000, outcome: 'unknown', source: 'dom-only', confidence: 'low', flags: ['fetch-missing'],
    dom: { start: 1000, end: 4000 }, sent: { conversationId: null, messageId: null }, recovered: null, server: {},
  }]);
});

test('signals for unknown streams are ignored', () => {
  const { writes, sig } = setup();
  sig('firstByte', { localId: 'nope', t: 1 });
  sig('message', { localId: 'nope', sig: msg({}) });
  sig('end', { localId: 'nope', t: 2, lastChunk: 2, outcome: 'completed' });
  sig('stop', { t: 3 });
  assert.equal(writes.length, 0);
});

test('server merge: skips memory-context messages, keeps first reasoning start and latest end', () => {
  const { latest, sig } = setup();
  sig('start', { localId: 'a', t: 1000 });
  sig('message', { localId: 'a', sig: msg({ contentType: 'model_editable_context', messageId: 'ctx', createTime: 1 }) });
  sig('message', { localId: 'a', sig: msg({ contentType: 'code', messageId: 'c1', createTime: 2, reasoningStart: 10 }) });
  sig('message', { localId: 'a', sig: msg({ contentType: 'reasoning_recap', messageId: 'r1', createTime: 3, reasoningStart: 11, reasoningEnd: 30 }) });
  sig('end', { localId: 'a', t: 5000, lastChunk: 5000, outcome: 'completed' });
  assert.deepEqual(latest('a').server, { messageId: 'r1', msgCreate: 2, reasoningStart: 10, reasoningEnd: 30 });
});

// ChatGPT can switch models inside one turn (auto routing), so the last one named wins.
test('server merge: the answering model is kept, the latest named one winning', () => {
  const { latest, sig } = setup();
  sig('start', { localId: 'a', t: 1000 });
  sig('message', { localId: 'a', sig: msg({ model: 'gpt-5' }) });
  sig('message', { localId: 'a', sig: msg({ model: null }) });
  sig('message', { localId: 'a', sig: msg({ model: 'gpt-5-thinking' }) });
  sig('message', { localId: 'a', sig: msg({ contentType: 'model_editable_context', model: 'memory-model' }) });
  sig('end', { localId: 'a', t: 5000, lastChunk: 5000, outcome: 'completed' });
  assert.equal(latest('a').server.model, 'gpt-5-thinking');
});

test('request that fails before the stop-button debounce settles is still paired, not double-counted', () => {
  const { tracker, writes, latest, sig, show, hide } = setup();
  sig('start', { localId: 'a', t: 1000 });
  sig('end', { localId: 'a', t: 1200, lastChunk: null, outcome: 'error' });
  show(1060);
  hide(1500);
  tracker.tick(20000);
  assert.equal(latest('a').source, 'fetch+dom');
  assert.deepEqual(latest('a').flags, []);
  assert.deepEqual(latest('a').dom, { start: 1060, end: 1500 });
  assert.equal(writes.filter((r) => r.id.startsWith('dom-')).length, 0);
});

// Pressing Stop does not cut ChatGPT's stream: the stop button fires its own request and
// [DONE] still arrives, up to ~5 s later. Every other tab's pill is counting that stream
// meanwhile, so the stop time is saved the moment the user presses it, not at [DONE].
test('pressing Stop saves the record at once, so every pill freezes at the press', () => {
  const { latest, sig, show } = setup();
  sig('start', { localId: 'a', t: 1000 });
  show(1060);
  sig('stop', { t: 4000 });
  assert.deepEqual(
    { outcome: latest('a').outcome, end: latest('a').end, source: latest('a').source },
    { outcome: 'stopped', end: 4000, source: 'fetch+dom' },
  );
});

test('the [DONE] after a stop does not extend the frozen end or rewrite it', () => {
  const { writes, latest, sig } = setup();
  sig('start', { localId: 'a', t: 1000 });
  sig('stop', { t: 4000 });
  const writesAtStop = writes.length;
  sig('end', { localId: 'a', t: 9000, lastChunk: 9000, outcome: 'completed' });
  assert.equal(writes.length, writesAtStop, 'the end signal has nothing left to change');
  assert.deepEqual([latest('a').outcome, latest('a').end], ['stopped', 4000]);
});

test('a stop with nothing running writes nothing', () => {
  const { writes, sig } = setup();
  sig('stop', { t: 4000 });
  assert.deepEqual(writes, []);
});

// ---- tamper resistance (spec §12)
test('at most 4 replies run at once in one tab; more starts are ignored', () => {
  const { writes, sig } = setup();
  for (let i = 0; i < 6; i++) sig('start', { localId: 'r' + i, t: 1000 + i });
  assert.deepEqual([...new Set(writes.map((w) => w.id))], ['r0', 'r1', 'r2', 'r3']);
});

test('an end more than 3 hours after the start is cut to 3 hours and flagged', () => {
  const { latest, sig } = setup();
  sig('start', { localId: 'a', t: 1000 });
  sig('end', { localId: 'a', t: 1000 + 5 * 3600e3, lastChunk: 1000 + 5 * 3600e3, outcome: 'completed' });
  assert.equal(latest('a').end, 1000 + 3 * 3600e3);
  assert.ok(latest('a').flags.includes('capped'));
});
