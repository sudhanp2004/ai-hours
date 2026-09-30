// content.js is browser-only glue, so this runs it against stubbed chrome APIs in a vm
// context, the way the v1 session did for its own wiring check. It covers the paths that
// only exist here: asking for the tab id, orphan cleanup and closed-tab recovery.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'extension');
const FILES = ['chatgpt-page', 'verify', 'reconcile', 'tracker', 'total', 'overlay'];

const T0 = 1790764800000;
const rec = (over) => ({
  id: 'r', site: 'chatgpt', tabId: 7, start: T0, firstByte: null, finished: null, end: null,
  lastSeen: null, outcome: 'unknown', source: 'fetch-only', confidence: 'high', flags: [],
  dom: null, sent: { conversationId: null, messageId: null }, recovered: null, server: {}, ...over,
});

// A minimal document: the overlay needs createElement/attachShadow, the observer a node.
function fakeDocument(selector) {
  const makeEl = () => {
    const el = {
      isConnected: false, textContent: '', classList: { toggle() {} }, style: {}, dataset: {},
      setAttribute() {}, getAttribute: () => null, remove() {}, appendChild() {}, querySelector: () => null,
    };
    return el;
  };
  return {
    body: makeEl(),
    createElement: () => ({ ...makeEl(), attachShadow: () => ({ innerHTML: '', querySelector: makeEl }) }),
    querySelector: () => null,
    documentElement: makeEl(),
  };
}

function setup({ stored = {}, tabId = 7 } = {}) {
  const store = { ...stored };
  const sent = [];
  const listeners = { message: null, storage: null };
  const ctx = {
    console,
    crypto: { randomUUID: () => 'uuid-' + sent.length },
    setTimeout: (fn) => fn(),
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    structuredClone,
    Date: { now: () => T0 },
  };
  ctx.removeEventListener = () => {};
  ctx.document = fakeDocument();
  ctx.location = new URL('https://chatgpt.com/c/abc');
  ctx.chrome = {
    runtime: { id: 'ext', lastError: null, sendMessage: (m, cb) => cb(tabId === null ? undefined : { tabId }) },
    storage: {
      local: {
        get: async (k) => (k === null ? { ...store } : { [k]: store[k] }),
        set: async (obj) => { Object.assign(store, obj); sent.push(obj); },
      },
      onChanged: { addListener: (fn) => (listeners.storage = fn), removeListener() {} },
    },
  };
  const context = vm.createContext(ctx);
  // Inside the context, `window` is the context's own global, which is not the host object.
  // content.js drops any message whose e.source isn't `window`, so the listener and the
  // message source both have to be installed from inside.
  vm.runInContext(
    `
    globalThis.window = globalThis;
    globalThis.addEventListener = (type, fn) => { if (type === 'message') globalThis.__onMessage = fn; };
    globalThis.removeEventListener = () => {};
    globalThis.__deliver = (data) => globalThis.__onMessage({ source: window, data });
  `,
    context,
  );
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(root, 'src', `${f}.js`), 'utf8'), context, { filename: f });
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'content.js'), 'utf8'), context, { filename: 'content.js' });
  // runInContext takes no sandbox argument, so the payload goes on the context object.
  const send = (context, data) => {
    Object.assign(context, { __payload: { __aih: 1, ...data } });
    vm.runInContext('__deliver(__payload)', context);
  };
  return { context, store, sent, listeners, send };
}

// The ask for the tab id and the orphan scan each resolve on their own microtask, so tests
// settle twice before asserting on anything the tracker has written.
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

// runInContext takes no sandbox, so values go on the context object itself.
function inContext(context, expr, values = {}) {
  Object.assign(context, values);
  return vm.runInContext(expr, context);
}

test('content.js loads and registers its listeners', async () => {
  const { context } = setup();
  await settle();
  assert.equal(inContext(context, 'typeof __aiHours.stopContent'), 'function');
});

test('a record written by the tracker carries this tab id and the send ids', async () => {
  const { context, store, send } = setup();
  await settle();
  send(context, { type: 'start', localId: 'a', t: T0, sent: { conversationId: 'c', messageId: 'u' } });
  await settle();
  // The record crosses into the vm realm, so prototypes differ: compare structure.
  assert.deepEqual({ ...store['rec:a'].sent }, { conversationId: 'c', messageId: 'u' });
  assert.equal(store['rec:a'].tabId, 7);
});

// The tab id and the leftover scan are both async, so a send can land in between. Holding
// signals until then is what keeps a brand-new record out of the leftover scan's sights.
test('a signal that arrives before the tab is ready is held, not dropped', async () => {
  const { context, store, send } = setup();
  send(context, { type: 'start', localId: 'early', t: T0 });
  assert.equal(store['rec:early'], undefined, 'not measured yet');
  await settle();
  assert.equal(store['rec:early'].tabId, 7, 'measured once the tab id is known');
});

test('a record this page creates is never closed as a leftover of the last one', async () => {
  const { context, store, send } = setup({ stored: { 'rec:old': rec({ id: 'old', tabId: 7, start: T0 - 60000, lastSeen: T0 - 55000 }) } });
  send(context, { type: 'start', localId: 'new', t: T0 });
  await settle();
  assert.equal(store['rec:old'].outcome, 'pending', 'the leftover is closed');
  assert.equal(store['rec:new'].outcome, 'unknown', 'the new one keeps counting');
  assert.equal(store['rec:new'].end, null);
});

test('a finished stream is saved with its end', async () => {
  const { context, store, send } = setup();
  await settle();
  send(context, { type: 'start', localId: 'a', t: T0 });
  send(context, { type: 'end', localId: 'a', t: T0 + 5000, lastChunk: T0 + 5000, outcome: 'completed' });
  await settle();
  assert.equal(store['rec:a'].outcome, 'completed');
  assert.equal(store['rec:a'].end, T0 + 5000);
});

// ---- closed-tab recovery, wired end to end through content.js
const PENDING = rec({
  id: 'p', tabId: 3, start: T0 - 60000, firstByte: T0 - 54000, lastSeen: T0 - 55000,
  outcome: 'pending', sent: { conversationId: 'c', messageId: 'u1' },
  server: { turnExchangeId: 'tx-1' },
});

const TURNS = [
  {
    turnExchangeId: 'tx-1', requestId: 'rq', userMessageId: 'u1', userCreateTime: (T0 - 60000) / 1000,
    startSec: (T0 - 50000) / 1000, endSec: (T0 - 20000) / 1000, reasoningStart: null, reasoningEnd: null, finishType: 'stop',
  },
];

test('loading a conversation finishes a pending record from the server timestamps', async () => {
  const { context, store, send } = setup({ stored: { 'rec:p': PENDING } });
  await settle();
  send(context, { type: 'conversation', conversationId: 'c', turns: TURNS });
  await settle();
  const r = store['rec:p'];
  assert.equal(r.outcome, 'recovered');
  // Watched 5 s, then the server ran it for 30 s we never saw.
  assert.equal(r.recovered.durationMs, 5000 + 30000);
  assert.equal(r.recovered.matchedBy, 'turnExchangeId');
  assert.equal(r.end, null, 'end stays unknown: the duration spans two clocks');
});

test('the recovered duration reaches the pill and the popup', async () => {
  const { context, store, send } = setup({ stored: { 'rec:p': PENDING } });
  await settle();
  send(context, { type: 'conversation', turns: TURNS });
  await settle();
  assert.equal(inContext(context, '__aiHours.summarize(records, now).totalMs', { records: Object.values(store), now: T0 }), 35000);
  assert.equal(inContext(context, '__aiHours.liveTotal(records, now).ms', { records: Object.values(store), now: T0 }), 35000);
});

test('a still-streaming record in another tab is never touched by a conversation load', async () => {
  const liveRec = rec({ id: 'live', tabId: 9, start: T0 - 10000, lastSeen: T0, outcome: 'unknown', sent: { messageId: 'u1' } });
  const { context, store, send } = setup({ stored: { 'rec:live': liveRec } });
  await settle();
  send(context, { type: 'conversation', turns: TURNS });
  await settle();
  assert.equal(store['rec:live'].outcome, 'unknown');
  assert.equal(store['rec:live'].recovered, null);
});

test('a turn still generating does not complete the record', async () => {
  const { context, store, send } = setup({ stored: { 'rec:p': PENDING } });
  await settle();
  send(context, { type: 'conversation', turns: [{ ...TURNS[0], endSec: null }] });
  await settle();
  assert.equal(store['rec:p'].outcome, 'pending');
});

test('an unrelated conversation leaves the record pending, not guessed', async () => {
  const { context, store, send } = setup({ stored: { 'rec:p': PENDING } });
  await settle();
  send(context, { type: 'conversation', turns: [{ ...TURNS[0], turnExchangeId: 'other', userMessageId: 'z', userCreateTime: 1 }] });
  await settle();
  assert.equal(store['rec:p'].outcome, 'pending');
  assert.equal(store['rec:p'].recovered, null);
});

test('a recovered record is not recovered a second time on the next load', async () => {
  const { context, store, send } = setup({ stored: { 'rec:p': PENDING } });
  await settle();
  send(context, { type: 'conversation', turns: TURNS });
  await settle();
  send(context, { type: 'conversation', turns: TURNS });
  await settle();
  assert.equal(store['rec:p'].recovered.durationMs, 35000, 'counted once');
});

test('records left by a previous document in this tab are closed, not counted live', async () => {
  const orphan = rec({ id: 'old', tabId: 7, start: T0 - 60000, lastSeen: T0 - 55000 });
  const { store, sent } = setup({ stored: { 'rec:old': orphan } });
  await settle();
  assert.equal(store['rec:old'].outcome, 'pending');
  assert.equal(store['rec:old'].end, null);
  assert.ok(sent.some((w) => 'rec:old' in w));
});

test('orphans from another tab, and finished records, are left alone', async () => {
  const stored = {
    'rec:other': rec({ id: 'other', tabId: 9, start: T0 - 60000, lastSeen: T0 - 55000 }),
    'rec:done': rec({ id: 'done', tabId: 7, start: T0 - 60000, end: T0 - 55000, outcome: 'completed' }),
  };
  const { store } = setup({ stored });
  await settle();
  assert.equal(store['rec:other'].outcome, 'unknown');
  assert.equal(store['rec:done'].outcome, 'completed');
});

test('an orphaned record stops counting live immediately', async () => {
  const stored = { 'rec:old': rec({ id: 'old', tabId: 7, start: T0 - 60000, lastSeen: T0 - 1000 }) };
  const { context, store } = setup({ stored });
  await settle();
  assert.equal(store['rec:old'].outcome, 'pending', 'the orphan was closed');
  assert.equal(inContext(context, '__aiHours.liveTotal(records, now).ms', { records: Object.values(store), now: T0 }), 0);
});

test('no tab id means no orphan cleanup, and nothing is invented', async () => {
  const stored = { 'rec:old': rec({ id: 'old', tabId: 7, start: T0 - 60000, lastSeen: T0 - 55000 }) };
  const { store, sent } = setup({ stored, tabId: null });
  await settle();
  assert.equal(store['rec:old'].outcome, 'unknown');
  assert.deepEqual(sent, []);
});