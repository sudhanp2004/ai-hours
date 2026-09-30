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
  assert.deepEqual(scripts('MAIN'), ['src/sse.js', 'src/adapter-chatgpt.js', 'src/main-world.js']);
  assert.deepEqual(scripts('ISOLATED'), ['src/adapter-chatgpt.js', 'src/verify.js', 'src/tracker.js', 'src/content.js']);
});
