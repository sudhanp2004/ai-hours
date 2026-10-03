// main-world.js on gemini.google.com: the reply is one XMLHttpRequest, and Stop is a
// batchexecute call named by its rpcids query (spec §11, Probe results).
const test = require('node:test');
const assert = require('node:assert/strict');

const SECRET = 'SECRET-TEXT-MUST-NOT-LEAK';
const BE = '/_/BardChatUi/data/batchexecute';
const SG = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';
const posts = [];

// Just enough XMLHttpRequest for the hook: open/send on the prototype, events by hand.
class FakeXHR {
  constructor() { this.listeners = {}; this.status = 0; this.responseText = ''; }
  open(method, url) { this.url = url; }
  send(body) { this.sent = body; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ type }); }
}

globalThis.window = globalThis;
globalThis.location = new URL('https://gemini.google.com/app/1f9dadf233e175e7');
globalThis.postMessage = (m) => posts.push(m);
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
  x.fire('progress');
  await tick();
  x.status = 200;
  x.fire('loadend');
  assert.deepEqual(posts.map((p) => p.type), ['start', 'firstByte', 'end']);
  const end = posts.at(-1);
  assert.equal(end.outcome, 'completed');
  assert.ok(end.lastChunk >= posts[1].t);
  assert.ok(posts.every((p) => p.localId === posts[0].localId));
  assert.ok(!JSON.stringify(posts).includes(SECRET) && !JSON.stringify(posts).includes('TOKEN'));
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
