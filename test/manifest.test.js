const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const scripts = (world) => manifest.content_scripts.find((c) => (c.world || 'ISOLATED') === world).js;

test('permissions are minimal', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage', 'unlimitedStorage', 'scripting']);
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
  for (const cs of manifest.content_scripts) {
    assert.deepEqual(cs.matches, ['https://chatgpt.com/*']);
    assert.equal(cs.run_at, 'document_start');
  }
});

test('every referenced file exists', () => {
  const files = [manifest.background.service_worker, manifest.action.default_popup, ...manifest.content_scripts.flatMap((c) => c.js)];
  for (const f of files) assert.ok(fs.existsSync(path.join(root, f)), f);
  const html = fs.readFileSync(path.join(root, manifest.action.default_popup), 'utf8');
  for (const [, src] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(root, 'popup', src)), src);
  }
});

test('scripts load after their dependencies', () => {
  assert.deepEqual(scripts('MAIN'), ['src/sse.js', 'src/chatgpt-network.js', 'src/main-world.js']);
  assert.deepEqual(scripts('ISOLATED'), ['src/chatgpt-page.js', 'src/verify.js', 'src/tracker.js', 'src/content.js']);
});

// Chrome injects a file listed in two content_scripts entries only once per frame, so a
// file shared between the MAIN and ISOLATED entries silently never runs in one of them.
test('no script file is shared between content_scripts entries', () => {
  const all = manifest.content_scripts.flatMap((c) => c.js);
  assert.deepEqual(all.filter((f, i) => all.indexOf(f) !== i), []);
});

// Each world is a separate JS global in Chrome, so each list must provide everything its
// last script needs on its own. (Node's require shares one global and would hide a gap.)
test('each world is self-sufficient', () => {
  const vm = require('node:vm');
  const load = (files) => {
    const ctx = vm.createContext({});
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
    return ctx.__aiHours;
  };
  const main = load(scripts('MAIN').slice(0, -1));
  assert.equal(typeof main.createSseParser, 'function');
  assert.equal(typeof main.chatgpt.streamUrl.test, 'function');
  assert.equal(typeof main.chatgpt.stopUrl.test, 'function');
  assert.equal(typeof main.chatgpt.parseEvent, 'function');
  const isolated = load(scripts('ISOLATED').slice(0, -1));
  assert.equal(typeof isolated.chatgpt.site, 'string');
  assert.equal(typeof isolated.chatgpt.stopButton, 'string');
  assert.equal(typeof isolated.createTracker, 'function');
});
