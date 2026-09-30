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

const sse = (chunks) => () => new Response(new ReadableStream({
  async start(c) {
    for (const x of chunks) { c.enqueue(enc.encode(x)); await new Promise((r) => setTimeout(r, 5)); }
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
