// main-world.js on gemini.google.com: the reply is one XMLHttpRequest, and Stop is a
// batchexecute call named by its rpcids query (spec §11, Probe results).
const test = require('node:test');
const assert = require('node:assert/strict');

const SECRET = 'SECRET-TEXT-MUST-NOT-LEAK';
const BE = '/_/BardChatUi/data/batchexecute';
const SG = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';
const { posts } = require('./page-env.js');

// Just enough XMLHttpRequest for the hook: open/send on the prototype, events by hand.
class FakeXHR {
  constructor() { this.listeners = {}; this.status = 0; this.responseText = ''; }
  open(method, url) { this.url = url; }
  send(body) { this.sent = body; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ type }); }
}

globalThis.location = new URL('https://gemini.google.com/app/1f9dadf233e175e7');
globalThis.fetch = async () => new Response('ok');
globalThis.XMLHttpRequest = FakeXHR;
for (const f of ['sse', 'sites/gemini-network', 'sites/gemini-page', 'main-world']) require(`../extension/src/${f}.js`);
const { site } = globalThis.__aiHours;

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
function xhr(url, body) {
  const x = new XMLHttpRequest();
  x.open('POST', url, true);
  x.send(body);
  return x;
}

// Built like the real stream: )]}' then length-prefixed lines, each [["wrb.fr",null,"<inner JSON>"]].
const wrb = (inner) => JSON.stringify([['wrb.fr', null, JSON.stringify(inner)]]);
const stream = (...inners) => `)]}'\n\n` + inners.map((i) => `${wrb(i).length}\n${wrb(i)}\n`).join('');
const REPLY = `A long reply that happens to talk about 2.5 Pro and 3.0 Ultra, padded well past forty characters. ${SECRET}`;

test('adapter: the model is the short standalone "3.6 Flash" value, never a mention inside the reply', () => {
  assert.equal(site.modelFromResponse(stream([null, ['c_1', 'r_1'], [['rc_1', [REPLY]]], null, '3.6 Flash'])), '3.6 Flash');
  assert.equal(site.modelFromResponse(stream([null, [['rc_1', [REPLY]]]])), null, 'only mentioned in the text');
  assert.equal(site.modelFromResponse(stream([['x', 'Gemini 2.5 Pro']])), '2.5 Pro', 'a short label around it');
  assert.equal(site.modelFromResponse(stream([['3.6 Flash-Lite']])), '3.6 Flash-Lite');
  assert.equal(site.modelFromResponse(")]}'\n\n12\n[[\"wrb.fr\",nu"), null, 'a half-received chunk');
  assert.equal(site.modelFromResponse(''), null);
});

// Called on every progress event with the whole response so far; with a state object it
// reads only what arrived since the last call, including a line that was cut mid-way.
test('adapter: incremental reads find the model once, even when it arrives split across calls', () => {
  const full = stream([null, [['rc_1', [REPLY]]]], [null, '3.6 Flash']);
  const cut = full.indexOf('3.6 F'); // the model's own line arrives in two pieces
  const st = {};
  assert.equal(site.modelFromResponse(full.slice(0, cut), st), null);
  const consumed = st.offset;
  assert.ok(consumed > 0 && consumed < cut, 'complete lines are not re-read');
  assert.equal(site.modelFromResponse(full, st), '3.6 Flash');
  // A short label seen early is still the fallback when nothing exact turns up later.
  const st2 = {};
  assert.equal(site.modelFromResponse(stream([['x', 'Gemini 2.5 Pro']]), st2), '2.5 Pro');
});

test('adapter: verified URLs, the stop selector, and no recovery', () => {
  assert.equal(site.site, 'gemini');
  assert.deepEqual(site.hosts, ['gemini.google.com']);
  assert.equal(site.stopButton, 'button[aria-label="Stop response"]');
  assert.equal(site.conversationUrl, null, 'the loaded chat has no end time, so nothing to recover from');
  assert.ok(site.streamUrl.test(`${SG}?bl=boq&f.sid=1&hl=en&_reqid=2&rt=c`));
  assert.ok(!site.streamUrl.test(`${BE}?rpcids=NkpXw`));
  assert.ok(site.stopUrl.test(`${BE}?rpcids=NkpXw&source-path=%2Fapp&hl=en`));
  assert.ok(site.stopUrl.test(`${BE}?hl=en&rpcids=ESY5D%2CNkpXw`));
  assert.ok(!site.stopUrl.test(`${BE}?rpcids=ESY5D&hl=en`));
  assert.ok(!site.stopUrl.test(`${BE}?rpcids=NkpXwX`));
});

test('the reply XHR is timed from send to loadend; the prompt never crosses', async () => {
  posts.length = 0;
  const x = xhr(`https://gemini.google.com${SG}?bl=boq&_reqid=2&rt=c`, `f.req=${encodeURIComponent(SECRET)}&at=TOKEN`);
  assert.deepEqual(posts.map((p) => p.type), ['start']);
  await tick();
  x.responseText = `)]}'\n\n120\n[["wrb.fr",null,"${SECRET}"]]`;
  x.fire('progress');
  x.responseText = stream([null, [['rc_1', [REPLY]]], '3.6 Flash']);
  x.fire('progress');
  x.fire('progress');
  await tick();
  x.status = 200;
  x.fire('loadend');
  assert.deepEqual(posts.map((p) => p.type), ['start', 'firstByte', 'message', 'end']);
  assert.equal(posts[2].sig.model, '3.6 Flash', 'once, as a server fact');
  const end = posts.at(-1);
  assert.equal(end.outcome, 'completed');
  assert.ok(end.lastChunk >= posts[1].t);
  assert.ok(posts.every((p) => p.localId === posts[0].localId));
  assert.ok(!JSON.stringify(posts).includes(SECRET) && !JSON.stringify(posts).includes('TOKEN'));
});

// Stop finishes the record at the press, so a model learned only at loadend would be lost.
test('the model is posted while streaming, so a stopped reply keeps it', () => {
  posts.length = 0;
  const x = xhr(`${SG}?rt=c`, 'f.req=x');
  x.responseText = stream([null, '3.6 Flash']);
  x.fire('progress');
  assert.deepEqual(posts.map((p) => p.type), ['start', 'firstByte', 'message']);
});

test('an aborted or failed reply XHR ends as error', () => {
  posts.length = 0;
  const x = xhr(`${SG}?rt=c`, 'f.req=x');
  x.status = 0; // aborted: navigation away, or a network failure
  x.fire('loadend');
  assert.equal(posts.at(-1).outcome, 'error');
});

test('the NkpXw batchexecute posts stop; other batchexecute calls are silent', () => {
  posts.length = 0;
  xhr(`${BE}?rpcids=ESY5D&source-path=%2Fapp`, 'f.req=x');
  assert.equal(posts.length, 0);
  xhr(`${BE}?rpcids=NkpXw&source-path=%2Fapp`, 'f.req=x');
  assert.deepEqual(posts.map((p) => p.type), ['stop']);
});

test('the hook never breaks the page’s own XHR', () => {
  const x = xhr(`${SG}?rt=c`, 'f.req=x');
  assert.equal(x.sent, 'f.req=x');
  assert.match(x.url, /StreamGenerate/);
});
