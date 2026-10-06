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
    id: 'a', site: 'chatgpt', tabId: 7, tabKey: null, start: 1000, firstByte: null, finished: null, end: null,
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
    id: 'dom-1', site: 'chatgpt', tabId: 7, tabKey: null, start: 1000, firstByte: null, finished: null, end: 4000,
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

// ---- a reply picked up after a refresh (spec §11 refresh): found live on Claude, 2026-10-06
const orphan = (over) => ({
  id: 'old', site: 'claude', tabId: 7, start: 1000, firstByte: 1500, finished: null, end: null, lastSeen: 4000,
  outcome: 'pending', source: 'fetch-only', confidence: 'high', flags: [], dom: { start: 1050, end: null },
  sent: { conversationId: null, messageId: null }, recovered: null, server: {}, ...over,
});

test('a picked-up reply claims the stop button already showing on the new page: no second record', () => {
  const { tracker, writes, latest, sig, show, hide } = setup();
  show(9000); // the reloaded page renders the running reply's stop button first
  sig('resume', {}); // (content.js handles resume; the tracker sees adopt)
  tracker.adopt('L2', orphan(), 9400);
  hide(15000);
  sig('end', { localId: 'L2', t: 15000, lastChunk: 15000, outcome: 'completed' });
  tracker.tick(30000);
  assert.deepEqual([...new Set(writes.map((w) => w.id))], ['old'], 'no dom-only record');
  assert.equal(latest('old').end, 15000);
  assert.equal(latest('old').source, 'fetch+dom');
});

// ---- the same, with nothing but the stop button to go on (Perplexity, ChatGPT, DeepSeek): the
// reload aborts the request, and the new page sees the reply running but never sees it sent.
function resumable(rec = orphan()) {
  const writes = [];
  const asked = [];
  let left = rec;
  const tracker = createTracker({
    site: 'chatgpt', tabId: 7, newId: () => 'dom-1', write: (r) => writes.push(structuredClone(r)),
    resume: (t) => (asked.push(t), [left, (left = null)][0]),
  });
  const show = (t) => { tracker.domRaw(true, t); tracker.confirm(t + 350); };
  const hide = (t) => { tracker.domRaw(false, t); tracker.confirm(t + 350); };
  const latest = (id) => writes.filter((r) => r.id === id).at(-1);
  return { tracker, writes, asked, show, hide, latest };
}

test('a stop button nothing here sent takes over the previous page\'s reply, ended when it goes', () => {
  const { tracker, writes, asked, show, hide, latest } = resumable();
  show(9000);
  tracker.tick(12000);
  assert.deepEqual(asked, [9000], 'asked with the time the button showed');
  assert.equal(latest('old').end, null);
  assert.equal(latest('old').outcome, 'unknown', 'running again, no longer pending');
  tracker.tick(17000);
  assert.equal(latest('old').lastSeen, 17000, 'kept alive while its button shows');
  hide(20000);
  tracker.tick(40000);
  assert.deepEqual([...new Set(writes.map((w) => w.id))], ['old'], 'no dom-only record');
  const r = latest('old');
  assert.equal(r.start, 1000, 'measured from the original send, across the reload');
  assert.equal(r.end, 20000);
  assert.equal(r.outcome, 'completed');
  assert.equal(r.source, 'fetch+dom');
  assert.ok(r.flags.includes('resumed'));
});

test('a resumed reply whose button went before the tick is ended at the button', () => {
  const { tracker, writes, show, hide, latest } = resumable();
  show(9000);
  hide(11000);
  tracker.tick(14000);
  assert.deepEqual([...new Set(writes.map((w) => w.id))], ['old']);
  assert.equal(latest('old').end, 11000);
});

test('a stop button for a reply sent from this page never takes over an orphan', () => {
  const { tracker, writes, asked, show, hide } = resumable();
  tracker.onSignal({ type: 'start', localId: 'a', t: 9000 });
  show(9050);
  tracker.tick(12000);
  hide(15000);
  tracker.onSignal({ type: 'end', localId: 'a', t: 15000, lastChunk: 15000, outcome: 'completed' });
  tracker.tick(30000);
  assert.deepEqual(asked, []);
  assert.deepEqual([...new Set(writes.map((w) => w.id))], ['a']);
});

test('with no orphan to take, an unsent stop button is still a dom-only record', () => {
  const { tracker, writes, show, hide, latest } = resumable(null);
  show(9000);
  hide(11000);
  tracker.tick(25000);
  assert.equal(latest('dom-1').source, 'dom-only');
  assert.deepEqual([...new Set(writes.map((w) => w.id))], ['dom-1']);
});

test('a stop press on a resumed reply ends it as stopped', () => {
  const { tracker, show, hide, latest } = resumable();
  show(9000);
  tracker.tick(12000);
  tracker.onSignal({ type: 'stop', t: 13000 });
  hide(13100);
  assert.equal(latest('old').end, 13000);
  assert.equal(latest('old').outcome, 'stopped');
});

test('if the stop button took the reply first, claude\'s timeline resume hands it to the stream', () => {
  const { tracker, writes, show, hide, latest } = resumable();
  show(9000);
  tracker.tick(12000);
  tracker.adopt('L2', null, 12500); // content.js: no orphan left to give
  hide(20000);
  assert.equal(latest('old').end, null, 'the button no longer ends it: the timeline does');
  tracker.onSignal({ type: 'end', localId: 'L2', t: 20100, lastChunk: 20100, outcome: 'completed' });
  assert.equal(latest('old').end, 20100);
  assert.deepEqual([...new Set(writes.map((w) => w.id))], ['old']);
});

test('a picked-up reply also claims a stop button that appears just after it', () => {
  const { tracker, writes, sig, show, hide } = setup();
  tracker.adopt('L2', orphan(), 9000);
  show(9800);
  hide(14000);
  sig('end', { localId: 'L2', t: 14000, lastChunk: 14000, outcome: 'completed' });
  tracker.tick(30000);
  assert.deepEqual([...new Set(writes.map((w) => w.id))], ['old']);
});

// Perplexity shows its stop button ~2.4 s after the reply request starts (measured live,
// 2026-10-06), past the default 2 s window, so every reply was flagged dom-missing and the
// popup warned that "a chat site may have changed". A site can widen the window.
test('a site with a slow stop button pairs it within its own window', () => {
  const writes = [];
  const t = globalThis.__aiHours.createTracker({ site: 'perplexity', tabId: 7, pairAfterMs: 6000, newId: () => 'x', write: (r) => writes.push(structuredClone(r)) });
  t.onSignal({ type: 'start', localId: 'a', t: 1000 });
  t.domRaw(true, 3400); t.confirm(3750);
  t.domRaw(false, 8000); t.confirm(8350);
  t.onSignal({ type: 'end', localId: 'a', t: 8000, lastChunk: 8000, outcome: 'completed' });
  assert.equal(writes.at(-1).source, 'fetch+dom');
  assert.deepEqual(writes.at(-1).flags, []);
});

test('the default window stays 2 s: a button 2.4 s late is not paired', () => {
  const { tracker, sig, latest } = setup();
  sig('start', { localId: 'a', t: 1000 });
  tracker.domRaw(true, 3400); tracker.confirm(3750);
  sig('end', { localId: 'a', t: 8000, lastChunk: 8000, outcome: 'completed' });
  assert.deepEqual(latest('a').flags, ['dom-missing']);
});

// Found live on Perplexity (store 1.0.1, 2026-10-06): a stop button outside the pairing window
// was also turned into a DOM-only record, so the same reply was counted twice.
test('a late stop button overlapping a measured reply joins it instead of becoming a second record', () => {
  const { tracker, writes, sig, latest } = setup();
  sig('start', { localId: 'a', t: 1000 });
  tracker.domRaw(true, 3400); tracker.confirm(3750); // 2.4 s late: outside the default window
  tracker.domRaw(false, 5400); tracker.confirm(5750);
  sig('end', { localId: 'a', t: 5200, lastChunk: 5200, outcome: 'completed' });
  tracker.tick(20000);
  tracker.tick(40000);
  assert.deepEqual([...new Set(writes.map((w) => w.id))], ['a'], 'no dom-only twin');
  assert.equal(latest('a').end, 5200, 'the measured times stand');
  assert.equal(latest('a').source, 'fetch+dom');
});

test('a stop button with no measured reply at that time is still its own DOM-only record', () => {
  const { tracker, writes, sig } = setup();
  sig('start', { localId: 'a', t: 1000 });
  sig('end', { localId: 'a', t: 2000, lastChunk: 2000, outcome: 'completed' });
  tracker.domRaw(true, 9000); tracker.confirm(9350);
  tracker.domRaw(false, 12000); tracker.confirm(12350);
  tracker.tick(25000);
  assert.ok(writes.some((w) => w.source === 'dom-only' && w.start === 9000));
});
