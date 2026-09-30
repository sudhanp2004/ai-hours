const test = require('node:test');
const assert = require('node:assert/strict');

const SECRET = 'SECRET-TEXT-MUST-NOT-LEAK';
const enc = new TextEncoder();
const posts = [];
let respond = null;

globalThis.window = globalThis;
globalThis.location = new URL('https://chatgpt.com/c/abc');
globalThis.postMessage = (m, origin) => { assert.equal(origin, 'https://chatgpt.com'); posts.push(m); };
globalThis.fetch = async (input, init) => respond(input, init);

const sse = (chunks, gapMs = 5) => () => new Response(new ReadableStream({
  async start(c) {
    for (const x of chunks) { c.enqueue(enc.encode(x)); await new Promise((r) => setTimeout(r, gapMs)); }
    c.close();
  },
}), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });

function load() {
  for (const f of ['sse', 'chatgpt-network', 'main-world']) {
    const p = require.resolve(`../extension/src/${f}.js`);
    delete require.cache[p];
    require(p);
  }
}
load();
// Page instrumentation (RUM/Sentry) or another extension wraps fetch after us...
const ours = window.fetch;
window.fetch = function thirdPartyWrapper(...args) { return ours.apply(this, args); };
load(); // ...then an extension update re-injects us: must not add a second wrapper

async function waitForEnd() {
  for (let i = 0; i < 400; i++) {
    const e = posts.find((p) => p.type === 'end');
    if (e) return e;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('no end signal');
}

const STREAM = [
  'event: delta_encoding\ndata: "v1"\n\n',
  `event: delta\ndata: ${JSON.stringify({ o: 'add', v: { message: { id: 'm1', author: { role: 'assistant' }, status: 'in_progress', content: { content_type: 'text', parts: [SECRET] }, metadata: { turn_exchange_id: 't1' } } } })}\n\n`,
  `event: delta\ndata: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: SECRET })}\n\n`,
  `event: delta\ndata: ${JSON.stringify({ p: '', o: 'patch', v: [{ p: '/message/status', o: 'replace', v: 'finished_successfully' }] })}\n\n`,
  'data: {"type":"message_stream_complete"}\n\n',
  'data: [DONE]\n\n',
];

test('chat stream is timed; the page gets the full body; no text crosses the boundary', async () => {
  posts.length = 0;
  respond = sse(STREAM);
  const res = await fetch('/backend-api/f/conversation', { method: 'POST' });
  assert.ok((await res.text()).includes(SECRET));
  const end = await waitForEnd();
  const starts = posts.filter((p) => p.type === 'start');
  assert.equal(starts.length, 1, 'exactly one wrapper');
  assert.equal(end.outcome, 'completed');
  assert.ok(end.t >= starts[0].t);
  assert.deepEqual(posts.map((p) => p.type), ['start', 'firstByte', 'message', 'finished', 'end']);
  assert.equal(posts.find((p) => p.type === 'message').sig.turnExchangeId, 't1');
  assert.ok(posts.every((p) => p.__aih === 1 && (p.type === 'stop' || p.localId === starts[0].localId)));
  assert.ok(!JSON.stringify(posts).includes(SECRET));
});

test('stream closed without [DONE] → closed', async () => {
  posts.length = 0;
  respond = sse(STREAM.slice(0, 3));
  await (await fetch('/backend-api/f/conversation', { method: 'POST' })).text();
  assert.equal((await waitForEnd()).outcome, 'closed');
});

test('non-stream error response passes through untouched and ends as error', async () => {
  posts.length = 0;
  respond = () => new Response('{"detail":"rate limited"}', { status: 429, headers: { 'content-type': 'application/json' } });
  const res = await fetch('/backend-api/f/conversation', { method: 'POST' });
  assert.equal(res.status, 429);
  assert.equal(await res.text(), '{"detail":"rate limited"}');
  const end = await waitForEnd();
  assert.deepEqual([end.outcome, end.lastChunk], ['error', null]);
});

test('network rejection ends as error and is rethrown to the page', async () => {
  posts.length = 0;
  respond = () => Promise.reject(new TypeError('Failed to fetch'));
  await assert.rejects(fetch('/backend-api/f/conversation', { method: 'POST' }), TypeError);
  assert.equal((await waitForEnd()).outcome, 'error');
});

test('stop_conversation posts a stop signal and passes through', async () => {
  posts.length = 0;
  respond = () => new Response('{}', { headers: { 'content-type': 'application/json' } });
  const res = await fetch('https://chatgpt.com/backend-api/stop_conversation', { method: 'POST' });
  assert.equal(await res.text(), '{}');
  assert.deepEqual(posts.map((p) => p.type), ['stop']);
});

test('other requests (incl. Request objects and other origins) pass through silently', async () => {
  posts.length = 0;
  respond = () => new Response('ok');
  await fetch('/backend-api/f/conversation/prepare', { method: 'POST' });
  await fetch(new Request('https://chatgpt.com/backend-api/conversations'));
  await fetch('https://example.com/backend-api/f/conversation', { method: 'POST' });
  assert.equal(posts.length, 0);
});

// ---- Task 5: the sign of life, and reading a loaded conversation
// The real throttle is 2 s; the fake stream sends in milliseconds, so tests shrink it.
function withAliveEvery(ms, fn) {
  const site = globalThis.__aiHours.chatgpt;
  const prev = site.aliveEveryMs;
  site.aliveEveryMs = ms;
  return Promise.resolve(fn()).finally(() => (site.aliveEveryMs = prev));
}

test('a streaming reply posts alive signals so other tabs can count it live', async () => {
  posts.length = 0;
  respond = sse([...STREAM, ...STREAM, ...STREAM]);
  const end = await withAliveEvery(5, async () => {
    await (await fetch('/backend-api/f/conversation', { method: 'POST' })).text();
    return waitForEnd();
  });
  const alive = posts.filter((p) => p.type === 'alive');
  assert.ok(alive.length > 0, 'a sign of life per throttle window');
  const localId = posts.find((p) => p.type === 'start').localId;
  assert.ok(alive.every((p) => p.localId === localId && p.t <= end.t));
  assert.ok(alive.every((p) => p.t >= posts.find((q) => q.type === 'firstByte').t));
});

test('alive is throttled, not posted per chunk', async () => {
  posts.length = 0;
  const many = Array.from({ length: 40 }, (_, i) => (i === 0 ? STREAM[0] : `event: delta\ndata: {"o":"append","v":"${i}"}\n\n`));
  respond = sse(many);
  await withAliveEvery(20, async () => {
    await (await fetch('/backend-api/f/conversation', { method: 'POST' })).text();
    await waitForEnd();
  });
  const alive = posts.filter((p) => p.type === 'alive');
  assert.ok(alive.length > 0);
  assert.ok(alive.length < 20, `throttled, got ${alive.length} alive for 40 chunks`);
});

test('a reply shorter than the throttle window posts no alive at all', async () => {
  posts.length = 0;
  respond = sse(STREAM);
  await (await fetch('/backend-api/f/conversation', { method: 'POST' })).text();
  await waitForEnd();
  assert.equal(posts.filter((p) => p.type === 'alive').length, 0);
  assert.equal(posts.filter((p) => p.type === 'firstByte').length, 1, 'firstByte is already a sign of life');
});

const CONVERSATION = {
  title: SECRET,
  messages: [
    {
      id: 'u1', author: { role: 'user' }, create_time: 1790764720.263, update_time: 1790764728.7,
      content: { content_type: 'text', parts: [SECRET] },
      metadata: { turn_exchange_id: 'tx-1', request_id: 'rq-1' },
    },
    {
      id: 'a1', author: { role: 'assistant' }, create_time: 1790764724.1, update_time: 1790764727.2,
      content: { content_type: 'text', parts: [SECRET] }, status: 'finished_successfully',
      metadata: { turn_exchange_id: 'tx-1', finish_details: { type: 'stop' } },
    },
  ],
};

test('loading a conversation posts its turns, with ids and timestamps but no text', async () => {
  posts.length = 0;
  respond = () => new Response(JSON.stringify(CONVERSATION), { headers: { 'content-type': 'application/json' } });
  const id = '6abce67c-11fc-83ee-bf0d-21bad86c85c0';
  const res = await fetch(`/backend-api/conversations/${id}`);
  assert.ok((await res.json()).title === SECRET, 'the page still gets the whole response');
  const conv = posts.find((p) => p.type === 'conversation');
  assert.equal(conv.conversationId, id);
  assert.equal(conv.turns.length, 1);
  assert.deepEqual(
    { turnExchangeId: conv.turns[0].turnExchangeId, userMessageId: conv.turns[0].userMessageId, endSec: conv.turns[0].endSec },
    { turnExchangeId: 'tx-1', userMessageId: 'u1', endSec: 1790764727.2 },
  );
  assert.ok(!JSON.stringify(posts).includes(SECRET));
});

test('a conversation request that fails or is not JSON is silent', async () => {
  posts.length = 0;
  respond = () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  await (await fetch('/backend-api/conversations/6abce67c-11fc-83ee-bf0d-21bad86c85c0')).text();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posts.filter((p) => p.type === 'conversation').length, 0);
});

test('the send request posts its two ids with the start signal, never the prompt', async () => {
  posts.length = 0;
  respond = () => new Response('{}', { headers: { 'content-type': 'application/json' } });
  await fetch('/backend-api/f/conversation', {
    method: 'POST',
    body: JSON.stringify({
      conversation_id: 'c-1',
      messages: [{ id: 'u-9', author: { role: 'user' }, content: { parts: [SECRET] } }],
    }),
  });
  const start = posts.find((p) => p.type === 'start');
  assert.deepEqual(start.sent, { conversationId: 'c-1', messageId: 'u-9' });
  assert.ok(!JSON.stringify(posts).includes(SECRET));
});
