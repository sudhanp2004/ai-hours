const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const sites = () => manifest.content_scripts.filter((c) => (c.world || 'ISOLATED') === 'MAIN');
const entries = (world) => manifest.content_scripts.filter((c) => (c.world || 'ISOLATED') === world);

test('permissions are minimal, and grant exactly the sites being measured', () => {
  assert.equal(manifest.manifest_version, 3);
  // identity and alarms (1.1, sync) carry no install warning, so they never disable the
  // extension for existing users on update.
  assert.deepEqual(manifest.permissions, ['storage', 'unlimitedStorage', 'scripting', 'identity', 'alarms']);
  // The permission list and the measured sites are the same list: a site in one but not the
  // other would either ask for access we don't use, or measure a site we never asked about.
  const matches = [...new Set(manifest.content_scripts.flatMap((c) => c.matches))].sort();
  assert.deepEqual([...manifest.host_permissions].sort(), matches);
  for (const cs of manifest.content_scripts) assert.equal(cs.run_at, 'document_start');
});

test('every referenced file exists', () => {
  const files = [
    manifest.background.service_worker, manifest.action.default_popup, ...manifest.content_scripts.flatMap((c) => c.js),
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
  ];
  // Chrome needs a 128 px icon, or the extension shows a grey letter tile.
  assert.ok(manifest.icons['128']);
  for (const f of files) assert.ok(fs.existsSync(path.join(root, f)), f);
  const html = fs.readFileSync(path.join(root, manifest.action.default_popup), 'utf8');
  for (const [, src] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(root, 'popup', src)), src);
  }
});

// Every site needs both halves of its adapter: the MAIN half for the network and the
// ISOLATED half for the selector. One without the other cannot measure anything.
test('each enabled site has both halves of its adapter', () => {
  for (const { matches, js } of manifest.content_scripts) {
    const halves = js.filter((f) => f.includes('/sites/')).map((f) => f.split('/').pop().replace('-network.js', '').replace('-page.js', ''));
    assert.deepEqual(halves.length, 1, `${matches} lists exactly one adapter file`);
    const base = halves[0];
    const site = base.replace(/-network$/, '');
    assert.ok(
      manifest.content_scripts.some((c) => c.js.includes(`src/sites/${site}-page.js`) || c.js.includes(`src/sites/${base}-page.js`)),
      `${site} has a page-side half`,
    );
  }
});

test('scripts load after their dependencies', () => {
  for (const s of sites()) {
    assert.deepEqual(s.js.slice(-1), ['src/main-world.js'], 'main-world wraps fetch, so it goes last');
    assert.ok(s.js[0].endsWith('sse.js'), 'the SSE parser is needed by the adapter and must come first');
    assert.ok(s.js[1].includes('/sites/'), 'the adapter registers ns.site before anything reads it');
  }
  for (const cs of manifest.content_scripts.filter((c) => (c.world || 'ISOLATED') !== 'MAIN')) {
    assert.deepEqual(cs.js.slice(-1), ['src/content.js']);
    assert.ok(cs.js[0].includes('/sites/'), 'the page adapter first, so content.js can see ns.site');
  }
});

// The worker shares reconcile.js and manifest-match.js with the content script, so it must
// be an ES module to import them (a classic worker has no importScripts in MV3).
test('the service worker is a module, and imports the files it needs', () => {
  assert.equal(manifest.background.type, 'module');
  const worker = fs.readFileSync(path.join(root, manifest.background.service_worker), 'utf8');
  assert.match(worker, /import '\.\/reconcile\.js'/);
  assert.match(worker, /import '\.\/manifest-match\.js'/);
  assert.match(worker, /import '\.\/total\.js'/, 'the synced summary is computed in the worker');
});

// Chrome injects a file listed in two content_scripts entries only once per frame, so a
// file shared between the MAIN and ISOLATED entries silently never runs in one of them.
// Sharing between entries with *different* matches is fine: those entries can never
// both apply to one page, so the collision never happens.
test('no script file is shared between entries that can match the same page', () => {
  const overlaps = (a, b) => a.some((p) => b.some((q) => p.split('://')[1] === q.split('://')[1]));
  for (const a of manifest.content_scripts) {
    for (const b of manifest.content_scripts) {
      if (a === b || !overlaps(a.matches, b.matches)) continue;
      const shared = a.js.filter((f) => b.js.includes(f));
      assert.deepEqual(shared, [], `${a.matches} and ${b.matches} overlap`);
    }
  }
});

// Each world is a separate JS global in Chrome, so each entry must provide everything its
// last script needs on its own. (Node's require shares one global and would hide a gap.)
// This is the guard that makes a new site's adapter correct before it is ever enabled.
test('every enabled entry is self-sufficient, and its adapter is verified', () => {
  const vm = require('node:vm');
  const load = (files) => {
    const ctx = vm.createContext({});
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
    return ctx.__aiHours;
  };
  for (const s of sites()) {
    const main = load(s.js.slice(0, -1));
    assert.equal(typeof main.createSseParser, 'function', `${s.matches} MAIN: sse.js`);
    assert.equal(main.site.verified, true, `${s.matches} MAIN: adapter is marked verified`);
    // Each site declares exactly one complete reply shape (main-world.js header).
    const a = main.site;
    const sse = typeof a.streamUrl?.test === 'function' && typeof a.parseEvent === 'function';
    const xhr = typeof a.streamUrl?.test === 'function' && a.parseEvent == null; // timed by the request itself
    const timeline = typeof a.requestKind === 'function' && typeof a.timelineUrl?.test === 'function' && typeof a.createTimelineDecoder === 'function';
    assert.equal([sse, xhr, timeline].filter(Boolean).length, 1, `${s.matches} MAIN: one complete reply shape`);
    // Recovery is optional, but all-or-nothing: a URL without its parser would read nothing.
    assert.equal(a.conversationUrl == null, a.parseConversation == null, `${s.matches} MAIN: recovery pieces`);
  }
  for (const cs of manifest.content_scripts.filter((c) => (c.world || 'ISOLATED') !== 'MAIN')) {
    const iso = load(cs.js.slice(0, -1));
    assert.equal(iso.site.verified, true, `${cs.matches} ISOLATED: adapter is marked verified`);
    assert.equal(typeof iso.site.site, 'string');
    assert.ok(Array.isArray(iso.site.hosts) && iso.site.hosts.length, 'hosts gate content.js');
    assert.equal(typeof iso.site.stopButton, 'string');
    assert.equal(typeof iso.createTracker, 'function');
    assert.equal(typeof iso.matchTurn, 'function');
    assert.equal(typeof iso.recover, 'function');
    assert.equal(typeof iso.summarize, 'function');
    assert.equal(typeof iso.liveTotal, 'function');
    assert.equal(typeof iso.createOverlay, 'function');
  }
});

// Every adapter on disk, enabled or not, must say which facts were observed. A stub that
// doesn't is how a guessed endpoint would end up in the manifest later.
test('every adapter on disk states whether it was verified, and a stub is never enabled', () => {
  const dir = path.join(root, 'src', 'sites');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  const enabled = manifest.content_scripts.flatMap((c) => c.js).filter((f) => f.includes('/sites/')).map((f) => path.basename(f));
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(src, /verified:\s*(true|false)/, `${f} states verified:`);
    if (/verified:\s*false/.test(src)) {
      assert.ok(!enabled.includes(f), `${f} is a stub and must not be in the manifest`);
    }
  }
});
