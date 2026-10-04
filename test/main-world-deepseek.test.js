// main-world.js on chat.deepseek.com: the reply is one XMLHttpRequest with an SSE body, and
// Stop is its own request (spec §11, Probe results, 2026-10-04).
const test = require('node:test');
const assert = require('node:assert/strict');

const SECRET = 'SECRET-TEXT-MUST-NOT-LEAK';
const { posts } = require('./page-env.js');
class FakeXHR {
  constructor() { this.listeners = {}; this.status = 0; this.responseText = ''; }
  open(method, url) { this.url = url; }
  send(body) { this.sent = body; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ type }); }
}
globalThis.location = new URL('https://chat.deepseek.com/a/chat/s/e5bde4d4-18ea-4bae-b3d0-56b6c9304569');
globalThis.fetch = async () => new Response('ok');
globalThis.XMLHttpRequest = FakeXHR;
for (const f of ['sse', 'sites/deepseek-network', 'sites/deepseek-page', 'main-world']) require(`../extension/src/${f}.js`);
const { site } = globalThis.__aiHours;

const body = (over) => JSON.stringify({ chat_session_id: 's', parent_message_id: 3, model_type: 'default', prompt: SECRET, ref_file_ids: [], thinking_enabled: false, search_enabled: false, ...over });
const xhr = (url, b) => { const x = new XMLHttpRequest(); x.open('POST', url, true); x.send(b); return x; };

test('adapter: verified URLs, the stop icon selector, and no recovery', () => {
  assert.equal(site.site, 'deepseek');
  assert.deepEqual(site.hosts, ['chat.deepseek.com']);
  assert.equal(site.stopButton, '.ds-button--primary path[d^="M2 4.88"]');
  assert.equal(site.conversationUrl, null, 'history_messages comes back empty: the app caches messages itself');
  assert.ok(site.streamUrl.test('/api/v0/chat/completion'));
  assert.ok(!site.streamUrl.test('/api/v0/chat/create_pow_challenge'));
  assert.ok(site.stopUrl.test('/api/v0/chat/stop_stream'));
});

test('adapter: the model comes from two request fields, never the prompt', () => {
  assert.equal(site.modelFromRequest(body()), 'deepseek-default');
  assert.equal(site.modelFromRequest(body({ thinking_enabled: true })), 'deepseek-default-deepthink');
  assert.equal(site.modelFromRequest(body({ model_type: SECRET.repeat(4) })), null, 'a long value is not a model name');
  assert.equal(site.modelFromRequest('not json'), null);
  assert.equal(site.modelFromRequest(undefined), null);
});

test('send to loadend is one completed reply, with its model; the prompt never crosses', () => {
  posts.length = 0;
  const x = xhr('/api/v0/chat/completion', body({ thinking_enabled: true }));
  x.responseText = 'event: ready\ndata: {"request_message_id":3}\n\n';
  x.fire('progress');
  x.status = 200;
  x.fire('loadend');
  assert.deepEqual(posts.map((p) => p.type), ['start', 'message', 'firstByte', 'end']);
  assert.equal(posts[1].sig.model, 'deepseek-default-deepthink');
  assert.equal(posts.at(-1).outcome, 'completed');
  assert.ok(!JSON.stringify(posts).includes(SECRET));
});

test('stop_stream posts stop; other API calls are silent', () => {
  posts.length = 0;
  xhr('/api/v0/chat/create_pow_challenge', '{}');
  xhr('/api/v0/chat_session/create', '{}');
  assert.equal(posts.length, 0);
  xhr('/api/v0/chat/stop_stream', JSON.stringify({ chat_session_id: 's', message_id: 4 }));
  assert.deepEqual(posts.map((p) => p.type), ['stop']);
});
