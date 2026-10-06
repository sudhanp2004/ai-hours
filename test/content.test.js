// content.js is browser-only glue, so this runs it against stubbed chrome APIs in a vm
// context, the way the v1 session did for its own wiring check. It covers the paths that
// only exist here: asking for the tab id, orphan cleanup and closed-tab recovery.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'extension');
const FILES = ['sites/chatgpt-page', 'verify', 'reconcile', 'tracker', 'total', 'models', 'breakdown-view', 'overlay'];

const T0 = 1790764800000;
const rec = (over) => ({
  id: 'r', site: 'chatgpt', tabId: 7, start: T0, firstByte: null, finished: null, end: null,
  lastSeen: null, outcome: 'unknown', source: 'fetch-only', confidence: 'high', flags: [],
  dom: null, sent: { conversationId: null, messageId: null }, recovered: null, server: {}, ...over,
});

// A minimal document: the overlay needs createElement/attachShadow, the observer a node,
// and querySelectorAll because it sweeps any pill left over from an earlier extension copy.
function fakeDocument(selector) {
  const makeEl = () => {
    const el = {
      isConnected: false, textContent: '', classList: { toggle() {}, add() {} }, style: {}, dataset: {},
      setAttribute() {}, getAttribute: () => null, remove() {}, appendChild() {}, querySelector: () => null,
      querySelectorAll: () => [], addEventListener() {},
    };
    return el;
  };
  const body = makeEl();
  body.isConnected = true; // a loaded page, so the pill reveals itself
  const listeners = {};
  const doc = {
    readyState: 'loading', // document_start, when content.js really runs
    listeners,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    dispatchEvent(e) { for (const fn of [...(listeners[e.type] || [])]) fn(e); return true; },
    body,
    // The pill's parts are remembered by selector, so a test can read what it shows.
    createElement: () => ({ ...makeEl(), attachShadow: () => { const parts = {}; doc.pill = parts; return { innerHTML: '', querySelector: (sel) => (parts[sel] ??= makeEl()) }; } }),
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: makeEl(),
  };
  return doc;
}

// The adapter is normally loaded from sites/, which is where the manifest points. A test can
// name different files to simulate a page whose adapter is for another site (see the hosts
// guard below), so the load list is a parameter rather than a constant.
// later: an array to collect timers in, for a test to fire itself; by default they run at once.
function setup({ stored = {}, tabId = 7, siteFiles = FILES, hostname, readyState, synced = {}, session = {}, tabIdAfter = 0, later = null } = {}) {
  const store = { ...stored };
  let asks = 0;
  const sent = [];
  const listeners = { message: null, storage: null };
  const ctx = {
    console,
    crypto: { randomUUID: () => 'uuid-' + sent.length },
    setTimeout: later ? (fn, ms) => later.push({ fn, ms }) : (fn) => fn(),
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    structuredClone,
    CustomEvent,
    // The tab's sessionStorage, which survives a reload in the same tab.
    sessionStorage: { getItem: (k) => session[k] ?? null, setItem: (k, v) => (session[k] = String(v)) },
    Date: { now: () => T0 },
  };
  ctx.removeEventListener = () => {};
  ctx.document = fakeDocument();
  if (readyState) ctx.document.readyState = readyState;
  // A plain object, not a URL: URL.hostname is read-only, and a test needs to stand on a
  // different domain to check the hosts guard.
  ctx.location = { href: 'https://chatgpt.com/c/abc', origin: 'https://chatgpt.com', hostname: hostname ?? 'chatgpt.com' };
  ctx.chrome = {
    // tabIdAfter: how many asks fail first (the worker didn't answer), as seen live 2026-10-06.
    runtime: { id: 'ext', lastError: null, sendMessage: (m, cb) => { asks++; cb(tabId === null || asks <= tabIdAfter ? undefined : { tabId }); } },
    storage: {
      local: {
        get: async (k) => (k === null ? { ...store } : Object.fromEntries([].concat(k).filter((x) => x in store).map((x) => [x, store[x]]))),
        set: async (obj) => { Object.assign(store, obj); sent.push(obj); },
      },
      onChanged: { addListener: (fn) => (listeners.storage = fn), removeListener() {} },
      sync: { get: async () => ({ ...synced }) },
    },
  };
  const context = vm.createContext(ctx);
  // Inside the context, `window` is the context's own global, which is not the host object.
  // content.js drops any message whose e.source isn't `window`, so the listener and the
  // message source both have to be installed from inside.
  vm.runInContext(
    `
    globalThis.window = globalThis;
    globalThis.addEventListener = (type) => { if (type === 'message') throw new Error('window messages must not be trusted'); };
    globalThis.removeEventListener = () => {};
  `,
    context,
  );
  for (const f of siteFiles) vm.runInContext(fs.readFileSync(path.join(root, 'src', `${f}.js`), 'utf8'), context, { filename: f });
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'content.js'), 'utf8'), context, { filename: 'content.js' });
  // Play main-world.js's half of the handshake: a hello whose target is the private channel.
  const channel = new EventTarget();
  let paired = false;
  channel.addEventListener('aihours:ack', () => (paired = true));
  ctx.document.dispatchEvent({ type: 'aihours:hello', target: channel });
  const send = (context, data) =>
    channel.dispatchEvent(new CustomEvent('aihours:signal', { detail: JSON.stringify({ __aih: 1, ...data }) }));
  return { context, store, sent, listeners, send, channel, paired: () => paired, doc: ctx.document };
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

// The hosts guard: if the manifest ever hands a tab an adapter for a different site, that
// adapter's stop-button selector would match nothing and every record would be flagged
// dom-missing. Doing nothing is the recoverable failure; wrong numbers are not.
test('a page whose domain the adapter does not claim records nothing at all', async () => {
  // chatgpt's adapter on a Claude page: the manifest would be wrong, so refuse.
  const { store, paired } = setup({ hostname: 'claude.ai' });
  await settle();
  assert.equal(paired(), false, 'no channel is taken');
  assert.equal(store['rec:a'], undefined, 'nothing is written');
});

test('the hosts guard matches a real subdomain, never a bare prefix', async () => {
  // "evilchatgpt.com" merely *contains* the host; it must not be accepted, or a typo'd
  // manifest pattern would let us run on a domain the user never granted.
  const wrong = setup({ hostname: 'evilchatgpt.com' });
  await settle();
  assert.equal(wrong.paired(), false, 'a bare prefix match is refused');

  // "www.chatgpt.com" is a true subdomain and is legitimately covered by the host.
  const right = setup({ hostname: 'www.chatgpt.com' });
  await settle();
  assert.equal(right.paired(), true, 'a real subdomain is accepted');
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
  send(context, { type: 'start', localId: 'a', t: T0 - 5000 });
  send(context, { type: 'end', localId: 'a', t: T0, lastChunk: T0, outcome: 'completed' });
  await settle();
  assert.equal(store['rec:a'].outcome, 'completed');
  assert.equal(store['rec:a'].end, T0);
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
  // Spread out of the sandbox: its objects have another realm's Object prototype.
  const total = (now) => ({ ...inContext(context, '__aiHours.liveTotal(records, now)', { records: Object.values(store), now }) });
  assert.deepEqual(total(T0), { ms: 59000, working: 0 }, 'what was watched stays, so a refresh never lowers the total');
  assert.deepEqual(total(T0 + 60000), { ms: 59000, working: 0 }, 'and it gains nothing more');
});

// A refresh mid-reply on claude.ai: the server keeps generating, and the new page's timeline
// says so. The new page takes over the old page's record and finishes it on the same clock.
test('a reply still running after a refresh is adopted by the new page and finished there', async () => {
  const stored = { 'rec:old': rec({ id: 'old', tabId: 7, start: T0 - 20000, lastSeen: T0 - 1000, server: { model: 'claude-opus-5-5' } }) };
  const { context, store, send } = setup({ stored });
  await settle();
  assert.equal(store['rec:old'].outcome, 'pending');
  send(context, { type: 'resume', localId: 'L2', t: T0 - 500 });
  await settle();
  assert.equal(store['rec:old'].outcome, 'unknown', 'counting live again');
  assert.equal(store['rec:old'].lastSeen, T0 - 500);
  assert.ok(store['rec:old'].flags.includes('resumed'));
  assert.equal(store['rec:old'].closedAt, undefined);
  send(context, { type: 'end', localId: 'L2', t: T0, lastChunk: T0, outcome: 'completed' });
  await settle();
  assert.equal(store['rec:old'].end, T0);
  assert.equal(store['rec:old'].outcome, 'completed');
  assert.equal(store['rec:old'].server.model, 'claude-opus-5-5', 'its server facts survive the takeover');
});

test('a resume with no orphan from this tab adopts nothing: that reply was sent elsewhere', async () => {
  const stored = { 'rec:other': rec({ id: 'other', tabId: 9, start: T0 - 20000, lastSeen: T0 - 1000 }) };
  const { context, store, sent, send } = setup({ stored });
  await settle();
  send(context, { type: 'resume', localId: 'L2', t: T0 + 500 });
  send(context, { type: 'end', localId: 'L2', t: T0 + 9000, lastChunk: T0 + 9000, outcome: 'completed' });
  await settle();
  assert.deepEqual(Object.keys(store), ['rec:other']);
  assert.equal(store['rec:other'].outcome, 'unknown');
  assert.deepEqual(sent, []);
});

test('an orphan is adopted once, and only if its last sign of life was minutes ago, not hours', async () => {
  const stored = { 'rec:old': rec({ id: 'old', tabId: 7, start: T0 - 3 * 3600e3, lastSeen: T0 - 2 * 3600e3 }) };
  const { context, store, send } = setup({ stored });
  await settle();
  send(context, { type: 'resume', localId: 'L2', t: T0 });
  await settle();
  assert.equal(store['rec:old'].outcome, 'pending', 'too old to be the reply now running');
});

// A refresh mid-reply on ChatGPT: the reloaded page loads the conversation, whose turn still
// being written already has an end. The reply is this page's to take over from its stop
// button, so recovery waits until that chance has passed (seen live, 2026-10-06).
test('this tab\'s own orphan is not recovered from the conversation while it may be resumed', async () => {
  const later = [];
  const own = { ...PENDING, id: 'own', tabId: 7, outcome: 'unknown', lastSeen: T0 - 1000 };
  const { context, store, send, listeners } = setup({ stored: { 'rec:own': own, 'rec:p': PENDING }, later });
  await settle();
  listeners.storage({ 'rec:own': { newValue: store['rec:own'] } }, 'local'); // the orphan close, as Chrome reports it
  send(context, { type: 'conversation', turns: TURNS });
  await settle();
  assert.equal(store['rec:own'].outcome, 'pending', 'left for the stop button to take over');
  assert.equal(store['rec:p'].outcome, 'recovered', 'another tab\'s record is recovered at once');
  const timer = later.find((x) => x.ms >= 30000);
  assert.ok(timer, 'recovery is tried again once the window has passed');
  timer.fn();
  await settle();
  assert.equal(store['rec:own'].outcome, 'recovered', 'not taken over, so recovered after all');
});

test('no tab id means no orphan cleanup, and nothing is invented', async () => {
  const stored = { 'rec:old': rec({ id: 'old', tabId: 7, start: T0 - 60000, lastSeen: T0 - 55000 }) };
  const { store, sent } = setup({ stored, tabId: null });
  await settle();
  assert.equal(store['rec:old'].outcome, 'unknown');
  assert.deepEqual(sent, []);
});
test('a record left unknown by a browser quit is recovered when the chat is opened again', async () => {
  // Quitting Chrome sends no tabs.onRemoved, so the record was never marked pending.
  const quit = { ...PENDING, id: 'q', outcome: 'unknown' }; // last sign of life 55 s ago
  const { context, store, send } = setup({ stored: { 'rec:q': quit } });
  await settle();
  send(context, { type: 'conversation', turns: TURNS });
  await settle();
  assert.equal(store['rec:q'].outcome, 'recovered');
  assert.equal(store['rec:q'].recovered.durationMs, 5000 + 30000);
});

// ---- the private channel (spec §12)
test('a second hello (a page trying to pair after the hook) is ignored', async () => {
  const { store, doc, send } = setup();
  await settle();
  const fake = new EventTarget();
  let acked = false;
  fake.addEventListener('aihours:ack', () => (acked = true));
  doc.dispatchEvent({ type: 'aihours:hello', target: fake });
  assert.equal(acked, false);
  assert.equal((doc.listeners['aihours:hello'] || []).length, 0, 'no longer listening at all');
  fake.dispatchEvent(new CustomEvent('aihours:signal', { detail: JSON.stringify({ __aih: 1, type: 'start', localId: 'x', t: T0 }) }));
  await settle();
  assert.equal(Object.keys(store).length, 0, 'a forged channel writes nothing');
  send(null, { type: 'start', localId: 'real', t: T0 });
  await settle();
  assert.equal(Object.keys(store).length, 1, 'the real one still does');
});

test('signals with times in the future are clamped to now; very old or non-numeric ones are dropped', async () => {
  const { store, send } = setup();
  await settle();
  send(null, { type: 'start', localId: 'a', t: T0 - 5000 });
  send(null, { type: 'end', localId: 'a', t: T0 + 10 * 3600e3, lastChunk: T0 + 10 * 3600e3, outcome: 'completed' });
  await settle();
  const r = Object.values(store)[0];
  assert.equal(r.end, T0, 'a fake future end is clamped to now');
  send(null, { type: 'start', localId: 'b', t: T0 - 3600e3 });
  send(null, { type: 'start', localId: 'c', t: 'soon' });
  await settle();
  assert.equal(Object.keys(store).length, 1, 'old and malformed starts are dropped');
});

test('a copy injected after the page loaded does not pair: a page could answer in the hook\u2019s place', async () => {
  const { paired } = setup({ readyState: 'interactive' });
  await settle();
  assert.equal(paired(), false);
});

// ---- the Chrome-sync backup (spec §13)
test('other installs\u2019 synced totals are added to the pill; this install\u2019s own summary is not', async () => {
  const stored = { 'device:id': 'me', 'rec:a': rec({ id: 'a', start: T0 - 9000, end: T0 - 4000, outcome: 'completed' }) };
  const synced = {
    'sum:me:chatgpt': { v: 1, device: 'me', sub: null, at: T0, site: 'chatgpt', models: { '': 5000 } },
    'sum:laptop:claude': { v: 1, device: 'laptop', sub: null, at: T0, site: 'claude', models: { 'claude-opus-5-5': 20000 } },
  };
  const { doc } = setup({ stored, synced });
  await settle();
  await settle();
  assert.equal(doc.pill['.time'].textContent, '25s', '5 s here + 20 s from the laptop; the 5 s summary of this install is not added again');
});

test('without a device id yet, no synced summary counts: it could be this install\u2019s own', async () => {
  const synced = { 'sum:x:claude': { v: 1, device: 'x', sub: null, at: T0, site: 'claude', models: { m: 20000 } } };
  const { doc } = setup({ synced });
  await settle();
  await settle();
  assert.equal(doc.pill['.time'].textContent, '0s');
});

// ---- tab identity without the worker (found live, 2026-10-06): the worker sometimes never
// answered "which tab am I?", so a refreshed page could not find its own unfinished reply.
test('the tab id is asked again when the worker does not answer at first', async () => {
  const { context, store, send } = setup({ tabIdAfter: 2, stored: {} });
  for (let i = 0; i < 12; i++) await settle();
  await new Promise((r) => setTimeout(r, 1500));
  send(context, { type: 'start', localId: 'a', t: T0 - 1000 });
  await settle();
  assert.equal(store['rec:a'].tabId, 7);
});

test('without any tab id, a refreshed page still finds its own unfinished reply by the tab\u2019s session key', async () => {
  const session = { 'aiHours.tabKey': 'k-1' };
  const stored = { 'rec:old': rec({ id: 'old', tabId: null, tabKey: 'k-1', start: T0 - 20000, lastSeen: T0 - 1000 }) };
  const { context, store, send } = setup({ stored, tabId: null, session });
  for (let i = 0; i < 12; i++) await settle();
  await new Promise((r) => setTimeout(r, 4500)); // the retries give up
  assert.equal(store['rec:old'].outcome, 'pending', 'closed as this tab\u2019s leftover');
  send(context, { type: 'resume', localId: 'L2', t: T0 - 500 });
  await settle();
  assert.ok(store['rec:old'].flags.includes('resumed'), 'and picked up');
});

test('a new record carries the tab\u2019s session key; another tab\u2019s key is never matched', async () => {
  const session = {};
  const stored = { 'rec:other': rec({ id: 'other', tabId: null, tabKey: 'someone-else', start: T0 - 20000, lastSeen: T0 - 1000 }) };
  const { context, store, send } = setup({ stored, session });
  await settle();
  send(context, { type: 'start', localId: 'n', t: T0 - 100 });
  await settle();
  assert.match(store['rec:n'].tabKey, /./);
  assert.equal(store['rec:n'].tabKey, session['aiHours.tabKey']);
  assert.equal(store['rec:other'].outcome, 'unknown');
});
