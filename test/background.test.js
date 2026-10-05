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
  const calls = { injected: [], removed: [], sent: [], queries: [], alarms: [] };
  const chrome = {
    runtime: {
      onInstalled: { addListener: (fn) => { calls.onInstalled ??= fn; (calls.installListeners ||= []).push(fn); } },
      // Two listeners: the tab-id answer (first) and the popup's sync buttons.
      onMessage: { addListener: (fn) => { calls.onMessage ??= fn; (calls.messageListeners ||= []).push(fn); } },
      onStartup: { addListener: (fn) => { const prev = calls.onStartup; calls.onStartup = prev ? (...a) => (prev(...a), fn(...a)) : fn; } },
      id: 'ext-id',
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
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener: (fn) => (calls.onChanged = fn) },
      sync: { get: async () => ({}), set: async (o) => (calls.synced = { ...calls.synced, ...o }) },
      ...over.storage,
    },
    alarms: {
      get: async () => undefined,
      create: (name, o) => calls.alarms.push([name, o]),
      clear: async (name) => calls.alarms.push(['clear', name]),
      onAlarm: { addListener: (fn) => (calls.onAlarm = fn) },
    },
    identity: { getRedirectURL: () => 'https://ext-id.chromiumapp.org/', launchWebAuthFlow: over.launchWebAuthFlow ?? (async () => { throw new Error('no'); }) },
  };
  return { chrome, calls };
}

// The worker imports these for their side effects (see the stub comment above), so the test
// loads the real files rather than stubbing their exports.
const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'extension', 'src', f), 'utf8');

function load(over) {
  const { chrome, calls } = stubChrome(over);
  const ctx = vm.createContext({ chrome, console, crypto, URL, URLSearchParams, TextDecoder, atob, Date, fetch: over?.fetch ?? (async () => { throw new Error('offline'); }) });
  for (const f of ['reconcile.js', 'manifest-match.js', 'total.js']) {
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
// ---- the Chrome-sync backup and the legacy import (spec §13)

function memoryStore() {
  const data = {};
  return {
    data,
    api: {
      get: async (k) => (k == null ? { ...data } : Object.fromEntries([].concat(k).filter((x) => x in data).map((x) => [x, data[x]]))),
      set: async (o) => Object.assign(data, o),
      remove: async (k) => [].concat(k).forEach((x) => delete data[x]),
    },
  };
}




test('the synced summary: this install\u2019s totals per site, under its own device id, written only when changed', async () => {
  const local = memoryStore();
  local.data['rec:a'] = { id: 'a', site: 'claude', start: Date.now() - 9000, end: Date.now() - 4000, outcome: 'completed', server: { model: 'claude-opus-5-5' } };
  const synced = [];
  const sync = { get: async () => ({}), set: async (o) => synced.push(o) };
  const { calls } = load({ storage: { local: local.api, sync } });
  calls.installListeners.forEach((fn) => fn({ reason: 'install' }));
  await new Promise((r) => setTimeout(r, 20));
  const device = local.data['device:id'];
  assert.match(device, /^[0-9a-f-]{36}$/);
  assert.equal(synced.length, 1);
  const item = synced[0][`sum:${device}:claude`];
  assert.equal(item.models['claude-opus-5-5'], 5000);
  assert.equal(item.sub, null);
  calls.onAlarm({ name: 'aih-summary' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(synced.length, 1, 'nothing changed, so nothing is written: Chrome sync limits writes');
});

// A one-time import of history saved from an earlier copy of the extension (one loaded before
// its id changed): extension/import/legacy-history.json, kept out of git and of the store package.
test('legacy history is imported once, never over records already here, and leaves no tab ties', async () => {
  const local = memoryStore();
  local.data['rec:b'] = { id: 'b', site: 'claude', start: 5, end: 9, outcome: 'completed', note: 'local copy wins' };
  const legacy = {
    'rec:a': { id: 'a', site: 'gemini', tabId: 7, start: 1, end: 3, outcome: 'completed' },
    'rec:b': { id: 'b', site: 'claude', start: 5, end: 9, outcome: 'completed' },
    'device:id': 'not a record',
  };
  let fetched = 0;
  const fetch = async (url) => {
    fetched++;
    assert.match(String(url), /import\/legacy-history\.json$/);
    return new Response(JSON.stringify(legacy), { headers: { 'content-type': 'application/json' } });
  };
  const { calls } = load({ fetch, storage: { local: local.api }, runtime: { getURL: (p) => `chrome-extension://ext-id/${p}` } });
  calls.installListeners.forEach((fn) => fn({ reason: 'update' }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(local.data['rec:a'].site, 'gemini');
  assert.equal(local.data['rec:a'].tabId, null, 'not tied to a tab of this browser session');
  assert.equal(local.data['rec:b'].note, 'local copy wins');
  assert.equal(local.data['device:id'] === 'not a record', false, 'only records are imported');
  assert.ok(local.data['import:legacyDone']);
  calls.onStartup();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetched, 1, 'imported once');
});

test('no legacy file (every normal install): nothing happens', async () => {
  const local = memoryStore();
  const fetch = async () => { throw new TypeError('Failed to fetch'); };
  const { calls } = load({ fetch, storage: { local: local.api }, runtime: { getURL: (p) => `chrome-extension://ext-id/${p}` } });
  calls.installListeners.forEach((fn) => fn({ reason: 'install' }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(local.data['import:legacyDone'], undefined, 'a file added later still gets imported');
});
