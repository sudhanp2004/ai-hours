// The private channel between main-world.js and content.js (spec §12, Tamper resistance).
// Page scripts share main-world's JS world, so anything on window could be forged.
const test = require('node:test');
const assert = require('node:assert/strict');
const { posts, channels, doc } = require('./page-env.js');

globalThis.location = new URL('https://chatgpt.com/c/abc');
globalThis.fetch = async () => new Response('{}', { headers: { 'content-type': 'application/json' } });
for (const f of ['sse', 'sites/chatgpt-network', 'main-world']) require(`../extension/src/${f}.js`);
const channel = channels[0];

test('the hook offers its channel once at load, attached only for the moment of the hello', () => {
  assert.equal(channel.hellos, 1);
  assert.equal(channel.parent, null, 'detached again: the page cannot find it in the document');
});

test('content.js arriving second asks with ready, and gets the hello then', () => {
  doc.dispatchEvent(new Event('aihours:ready'));
  assert.equal(channel.hellos, 2);
});

test('once content.js acknowledges, a page asking with ready gets nothing', () => {
  channel.dispatchEvent(new Event('aihours:ack'));
  doc.dispatchEvent(new Event('aihours:ready'));
  assert.equal(channel.hellos, 2);
});

test('signals travel on the channel only, never through window.postMessage', async () => {
  posts.length = 0;
  await fetch('/backend-api/stop_conversation', { method: 'POST' });
  assert.deepEqual(posts.map((p) => p.type), ['stop']);
});

// A page that replaces the DOM's event functions after load must not see or block signals:
// the hook saved the originals at document_start.
test('a page patching dispatchEvent later cannot observe the signals', async () => {
  const seen = [];
  const orig = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (e) { seen.push(e.type); return orig.call(this, e); };
  try {
    posts.length = 0;
    await fetch('/backend-api/stop_conversation', { method: 'POST' });
    assert.deepEqual(posts.map((p) => p.type), ['stop']);
    assert.ok(!seen.includes('aihours:signal'));
  } finally {
    EventTarget.prototype.dispatchEvent = orig;
  }
});
