// main-world.js on claude.ai: the send is a PerformAction, and the reply's progress comes
// from the separate, long-lived StreamTimeline (spec §11, Probe results).
const test = require('node:test');
const assert = require('node:assert/strict');
const pb = require('./protobuf-helper.js');

const SECRET = 'SECRET-TEXT-MUST-NOT-LEAK';
const CONV = '6cab7d36-4dac-4b37-a10d-c3c54d465243';
const RPC = '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService';
const posts = [];
let respond = null;

globalThis.window = globalThis;
globalThis.location = new URL(`https://claude.ai/chat/${CONV}`);
globalThis.postMessage = (m) => posts.push(m);
globalThis.fetch = async (input, init) => respond(input, init);
for (const f of ['sse', 'sites/claude-network', 'main-world']) require(`../extension/src/${f}.js`);

// A timeline the test pushes frames into, like the page's open StreamTimeline.
function openTimeline() {
  let ctl;
  const body = new ReadableStream({ start: (c) => (ctl = c) });
  const push = (frame) => ctl.enqueue(new Uint8Array(pb.env(0, frame)));
  return { res: new Response(body, { headers: { 'content-type': 'application/connect+proto' } }), push, close: () => ctl.close() };
}
const proto = () => new Response(new Uint8Array(0), { headers: { 'content-type': 'application/proto' } });
const send = () => new Uint8Array(pb.msg(pb.fld(1, pb.header(CONV, 2)), pb.fld(2, pb.msg(pb.fld(1, pb.s('m-1')), pb.fld(3, pb.s(SECRET))))));
const stop = () => new Uint8Array(pb.msg(pb.fld(1, pb.header(CONV, 3)), pb.fld(3, [])));
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

async function until(type) {
  for (let i = 0; i < 200; i++) {
    const p = posts.find((x) => x.type === type);
    if (p) return p;
    await tick(5);
  }
  throw new Error('no ' + type);
}

test('send → running → idle is one completed reply; no text crosses the boundary', async () => {
  posts.length = 0;
  const tl = openTimeline();
  respond = (input) => (String(input).endsWith('StreamTimeline') ? tl.res : proto());
  const page = await fetch(`${RPC}/StreamTimeline`, { method: 'POST', body: new Uint8Array(5) });
  tl.push(pb.statusFrame(CONV, 1)); // the snapshot says idle: nothing starts
  await tick();
  assert.equal(posts.length, 0);

  await fetch(`${RPC}/PerformAction`, { method: 'POST', body: send() });
  tl.push(pb.statusFrame(CONV, 1)); // the server's echo before it starts running
  tl.push(pb.statusFrame(CONV, 2));
  tl.push(pb.deltaFrame(SECRET));
  await tick();
  tl.push(pb.statusFrame(CONV, 1));
  const end = await until('end');
  assert.deepEqual(posts.map((p) => p.type), ['start', 'firstByte', 'end']);
  assert.equal(end.outcome, 'completed');
  assert.ok(end.t >= posts[1].t);
  assert.ok(posts.every((p) => p.localId === posts[0].localId));
  assert.ok(!JSON.stringify(posts).includes(SECRET));
  // The page still reads its own stream untouched.
  tl.close();
  assert.ok((await page.arrayBuffer()).byteLength > 0);
});

test('a stop is its own PerformAction: it posts stop and passes through', async () => {
  posts.length = 0;
  respond = () => proto();
  const res = await fetch(`${RPC}/PerformAction`, { method: 'POST', body: stop() });
  assert.equal(res.status, 200);
  assert.deepEqual(posts.map((p) => p.type), ['stop']);
});

test('a reply that runs across a rotated timeline still ends on the new one', async () => {
  posts.length = 0;
  const a = openTimeline();
  const b = openTimeline();
  let n = 0;
  respond = (input) => (String(input).endsWith('StreamTimeline') ? (n++ ? b.res : a.res) : proto());
  await fetch(`${RPC}/StreamTimeline`, { method: 'POST' });
  await fetch(`${RPC}/PerformAction`, { method: 'POST', body: send() });
  a.push(pb.statusFrame(CONV, 2));
  await tick();
  a.close(); // Stream-Close-Reason: cadence
  await fetch(`${RPC}/StreamTimeline`, { method: 'POST' });
  b.push(pb.statusFrame(CONV, 1));
  assert.equal((await until('end')).outcome, 'completed');
});

test('a send the server rejects ends as error', async () => {
  posts.length = 0;
  respond = () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } });
  await fetch(`${RPC}/PerformAction`, { method: 'POST', body: send() });
  assert.equal((await until('end')).outcome, 'error');
});

test('a reply never seen to go idle is closed off by the next send, without a guessed end', async () => {
  posts.length = 0;
  respond = () => proto();
  await fetch(`${RPC}/PerformAction`, { method: 'POST', body: send() });
  await tick(30);
  await fetch(`${RPC}/PerformAction`, { method: 'POST', body: send() });
  const [first, , second] = posts;
  assert.deepEqual(posts.map((p) => p.type), ['start', 'end', 'start']);
  assert.equal(posts[1].localId, first.localId);
  assert.equal(posts[1].outcome, 'error');
  assert.equal(posts[1].lastChunk, first.t, 'no time is invented for a reply we never saw run');
  assert.notEqual(second.localId, first.localId);
});

test('settings actions and other RPCs pass through silently', async () => {
  posts.length = 0;
  respond = () => proto();
  await fetch(`${RPC}/PerformAction`, { method: 'POST', body: new Uint8Array(pb.msg(pb.fld(1, pb.header(CONV, 1)), pb.fld(15, []))) });
  await fetch(`${RPC}/GetNewConversationDefaults`, { method: 'POST' });
  await fetch('/api/organizations/x/chat_conversations/y');
  assert.equal(posts.length, 0);
});
