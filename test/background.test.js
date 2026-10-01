const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// background.js is Chrome-only, so its logic is split: markPending lives in reconcile.js
// (tested there) and the listener wiring is exercised here against stubbed chrome APIs.
require('../extension/src/reconcile.js');
const { pendingByTab } = globalThis.__aiHours;

const T0 = 1790764800000;
const src = fs
  .readFileSync(path.join(__dirname, '..', 'extension', 'src', 'background.js'), 'utf8')
  // The worker is an ES module ("type": "module" in the manifest) so it can share
  // reconcile.js. vm has no module linker, and the test already loaded reconcile.js above.
  .replace(/^import .*$/gm, '');

function stubChrome(over = {}) {
  const calls = { injected: [], removed: [], sent: [], queries: [] };
  const chrome = {
    runtime: {
      onInstalled: { addListener: (fn) => (calls.onInstalled = fn) },
      onMessage: { addListener: (fn) => (calls.onMessage = fn) },
      getManifest: () => ({ content_scripts: [{ matches: ['https://chatgpt.com/*'], js: ['a.js'] }, { matches: ['https://chatgpt.com/*'], js: ['b.js'] }] }),
      lastError: null,
      ...over.runtime,
    },
    tabs: {
      query: async (q) => { calls.queries.push(q); return over.tabs ?? []; },
      onRemoved: { addListener: (fn) => (calls.onRemoved = fn) },
      ...over.tabsApi,
    },
    scripting: {
      executeScript: async (opts) => { calls.injected.push(opts); if (over.failOn === opts.files[0]) throw new Error('nope'); },
    },
    storage: over.storage ?? { local: { get: async () => ({}), set: async () => {} } },
  };
  return { chrome, calls };
}

// The worker imports these for their side effects (see the stub comment above), so the test
// loads the real files rather than stubbing their exports.
const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', f), 'utf8');

function load(over) {
  const { chrome, calls } = stubChrome(over);
  const ctx = vm.createContext({ chrome, console });
  for (const f of ['reconcile.js', 'manifest-match.js']) {
    vm.runInContext(SRC(f), ctx, { filename: f });
  }
  vm.runInContext(src, ctx, { filename: 'background.js' });
  return { chrome, calls, ns: ctx.__aiHours };
}

test('registers both listeners: install/update and tab removal', () => {
  const { calls } = load();
  assert.equal(typeof calls.onInstalled, 'function');
  assert.equal(typeof calls.onRemoved, 'function');
});

test('a closed tab marks its unfinished records pending and writes only those', async () => {
  const stored = {
    'rec:a': { id: 'a', tabId: 7, end: null, lastSeen: T0 + 4000, outcome: 'unknown' },
    'rec:b': { id: 'b', tabId: 7, end: T0 + 9000, outcome: 'completed' },
    'rec:c': { id: 'c', tabId: 9, end: null, lastSeen: T0 + 2000, outcome: 'unknown' },
  };
  const writes = [];
  const { calls } = load({
    storage: {
      local: {
        get: async () => stored,
        set: async (obj) => writes.push(obj),
      },
    },
  });
  await calls.onRemoved(7, { windowId: 1 });
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0]), ['rec:a']);
  assert.equal(writes[0]['rec:a'].outcome, 'pending');
  assert.equal(writes[0]['rec:a'].lastSeen, T0 + 4000, 'the sign of life is preserved');
  assert.equal(writes[0]['rec:a'].end, null, 'no duration is invented');
});

test('closing a tab with nothing running writes nothing', async () => {
  const writes = [];
  const { calls } = load({
    storage: { local: { get: async () => ({ 'rec:a': { id: 'a', tabId: 7, end: T0, outcome: 'completed' } }), set: async (o) => writes.push(o) } },
  });
  await calls.onRemoved(7);
  assert.deepEqual(writes, []);
});

test('a failing storage read on tab close never throws into Chrome', async () => {
  const { calls } = load({
    storage: { local: { get: async () => { throw new Error('quota'); }, set: async () => {} } },
  });
  await assert.doesNotReject(() => calls.onRemoved(7));
});

test('a content script can ask which tab it is', () => {
  const { calls } = load();
  let reply = null;
  const keepAlive = calls.onMessage({ __aih: 1, type: 'tabId' }, { tab: { id: 42 } }, (r) => (reply = r));
  assert.equal(reply.tabId, 42);
  assert.equal(keepAlive, true, 'the reply channel must be kept open');
});

test('a message without our marker, or without a tab, is ignored', () => {
  const { calls } = load();
  let asked = 0;
  const respond = () => asked++;
  assert.equal(calls.onMessage({ type: 'tabId' }, { tab: { id: 1 } }, respond), undefined);
  assert.equal(calls.onMessage({ __aih: 1, type: 'somethingElse' }, { tab: { id: 1 } }, respond), undefined);
  assert.equal(calls.onMessage({ __aih: 1, type: 'tabId' }, {}, respond), undefined);
  assert.equal(asked, 0);
});

test('re-injection still runs only for install and update', async () => {
  const { calls } = load({ tabs: [{ id: 1, url: 'https://chatgpt.com/c/x' }] });
  await calls.onInstalled({ reason: 'install' });
  assert.equal(calls.injected.length, 2, 'one per entry matching this tab');
  await calls.onInstalled({ reason: 'chrome_update' });
  assert.equal(calls.injected.length, 2, 'a browser update re-injects nothing');
});

// The bug this guards: with more than one site, injecting every entry would hand a Claude
// tab the ChatGPT stop-button selector, so its replies would be tracked against a selector
// that never matches and flagged dom-missing forever.
test('a tab is only given the entries for its own site', async () => {
  const manifest = {
    content_scripts: [
      { matches: ['https://chatgpt.com/*'], js: ['gpt-main.js'] },
      { matches: ['https://chatgpt.com/*'], js: ['gpt-page.js'] },
      { matches: ['https://claude.ai/*'], js: ['claude-main.js'] },
      { matches: ['https://claude.ai/*'], js: ['claude-page.js'] },
    ],
  };
  const { calls } = load({
    runtime: { getManifest: () => manifest },
    tabs: [{ id: 1, url: 'https://claude.ai/chat/1' }, { id: 2, url: 'https://chatgpt.com/c/1' }],
  });
  await calls.onInstalled({ reason: 'update' });
  const for1 = calls.injected.filter((i) => i.target.tabId === 1).map((i) => i.files[0]);
  const for2 = calls.injected.filter((i) => i.target.tabId === 2).map((i) => i.files[0]);
  assert.deepEqual(for1.sort(), ['claude-main.js', 'claude-page.js']);
  assert.deepEqual(for2.sort(), ['gpt-main.js', 'gpt-page.js']);
});

// Chrome withholds tab.url without a matching host permission. Guessing there would inject
// the wrong adapter, so every entry is offered instead and content.js refuses on its own
// hosts check.
test('a tab with no readable url is offered every entry, and the page decides', async () => {
  const { calls } = load({ tabs: [{ id: 1 }] });
  await calls.onInstalled({ reason: 'update' });
  assert.equal(calls.injected.length, 2, 'both entries tried; the hosts check on the page filters');
});

test('a tab that cannot be injected does not stop the others', async () => {
  const { calls } = load({
    tabs: [{ id: 1, url: 'https://chatgpt.com/c/1' }, { id: 2, url: 'https://chatgpt.com/c/2' }],
    failOn: 'a.js',
  });
  await calls.onInstalled({ reason: 'update' });
  assert.equal(calls.injected.filter((i) => i.files[0] === 'b.js').length, 2);
});

// The pure helper is what both the worker and the tests rely on.
test('pendingByTab is the single source of the close rule', () => {
  const out = pendingByTab([{ id: 'a', tabId: 1, end: null }], 1, T0);
  assert.equal(out.a.outcome, 'pending');
  assert.equal(out.a.closedAt, T0);
});