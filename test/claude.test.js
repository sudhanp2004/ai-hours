const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
require('../extension/src/sites/claude-network.js');
require('../extension/src/sites/claude-page.js');
const { site } = globalThis.__aiHours;
const pb = require('./protobuf-helper.js');

const SECRET = 'SECRET-TEXT-MUST-NOT-LEAK';
const CONV = '6cab7d36-4dac-4b37-a10d-c3c54d465243';
const RPC = '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService';

test('network and page halves merge into one config', () => {
  assert.equal(site.site, 'claude');
  assert.deepEqual(site.hosts, ['claude.ai']);
  assert.equal(site.stopButton, 'button[data-testid="chat-input-stop"]');
  assert.equal(site.verified, true);
  assert.ok(site.timelineUrl.test(`${RPC}/StreamTimeline`));
  assert.ok(!site.timelineUrl.test(`${RPC}/PerformAction`));
  // No passive conversation load exists on claude.ai, so no closed-tab recovery (spec §11).
  assert.equal(site.conversationUrl, null);
});

// PerformAction carries every action; the one action field says which (probe, 2026-10-03).
test('requestKind: field 2 is a send, field 3 a stop, anything else is neither', () => {
  const send = pb.msg(pb.fld(1, pb.header(CONV, 2)), pb.fld(2, pb.msg(pb.fld(1, pb.s('m-1')), pb.fld(3, pb.s(SECRET)))));
  const stop = pb.msg(pb.fld(1, pb.header(CONV, 3)), pb.fld(3, []));
  const settings = pb.msg(pb.fld(1, pb.header(CONV, 1)), pb.fld(15, pb.msg(pb.fld(12, pb.s('Asia/Calcutta')))));
  assert.equal(site.requestKind(`${RPC}/PerformAction`, new Uint8Array(send)), 'send');
  assert.equal(site.requestKind(`${RPC}/PerformAction`, new Uint8Array(stop).buffer), 'stop');
  assert.equal(site.requestKind(`${RPC}/PerformAction`, new Uint8Array(settings)), null);
  assert.equal(site.requestKind(`${RPC}/GetNewConversationDefaults`, new Uint8Array(send)), null);
  assert.equal(site.requestKind(`${RPC}/PerformAction`, 'a string'), null);
  assert.equal(site.requestKind(`${RPC}/PerformAction`, new Uint8Array([0xff, 0xff, 0xff])), null, 'garbage');
});

function feed(chunks) {
  const seen = [];
  const dec = site.createTimelineDecoder((s) => seen.push(s));
  for (const c of chunks) dec.push(new Uint8Array(c));
  return dec.idle().then(() => seen);
}

test('timeline: the conversation status flips running → idle; deltas and heartbeats are silent', async () => {
  const seen = await feed([
    pb.env(0, pb.statusFrame(CONV, 1)),
    pb.env(0, pb.heartbeat()),
    pb.env(0, pb.statusFrame(CONV, 2)),
    pb.env(0, pb.deltaFrame(SECRET)),
    pb.env(0, pb.statusFrame(CONV, 1)),
    pb.env(2, [...Buffer.from('{"metadata":{"Stream-Close-Reason":["cadence"]}}')]),
  ]);
  assert.deepEqual(seen, ['idle', 'running', 'idle']);
  assert.ok(!JSON.stringify(seen).includes(SECRET));
});

test('timeline: envelopes split across chunks, and several in one chunk', async () => {
  const all = [...pb.env(0, pb.statusFrame(CONV, 2)), ...pb.env(0, pb.statusFrame(CONV, 1))];
  const seen = await feed([all.slice(0, 3), all.slice(3, 40), all.slice(40)]);
  assert.deepEqual(seen, ['running', 'idle']);
});

// Flag 1 frames are gzip (connect-content-encoding: gzip). A rotated stream's first frame is a
// compressed snapshot, so the end of a reply can arrive inside one.
test('timeline: gzip frames are decompressed, and order is kept around them', async () => {
  const gz = [...zlib.gzipSync(Buffer.from(pb.statusFrame(CONV, 2)))];
  const seen = await feed([pb.env(1, gz), pb.env(0, pb.statusFrame(CONV, 1))]);
  assert.deepEqual(seen, ['running', 'idle']);
});

test('timeline: a corrupt frame is skipped, not fatal', async () => {
  const seen = await feed([pb.env(1, [1, 2, 3]), pb.env(0, [0xff, 0xff]), pb.env(0, pb.statusFrame(CONV, 2))]);
  assert.deepEqual(seen, ['running']);
});

// Status messages come at the start and end of a reply; between them only text deltas and
// heartbeats arrive. Each is a sign the stream is alive, or a long reply would go stale.
test('timeline: every data frame is activity, the trailer is not', async () => {
  let n = 0;
  const dec = site.createTimelineDecoder(() => {}, () => n++);
  for (const f of [pb.statusFrame(CONV, 2), pb.deltaFrame(SECRET), pb.heartbeat()]) dec.push(new Uint8Array(pb.env(0, f)));
  dec.push(new Uint8Array(pb.env(2, [...Buffer.from('{}')])));
  await dec.idle();
  assert.equal(n, 3);
});

test('an unknown status value after running counts as not running', async () => {
  const seen = await feed([pb.env(0, pb.statusFrame(CONV, 2)), pb.env(0, pb.statusFrame(CONV, 7))]);
  assert.deepEqual(seen, ['running', 'idle']);
});

test('timeline: the conversation’s model is reported with its status', async () => {
  const models = [];
  const dec = site.createTimelineDecoder((s, model) => models.push(model));
  dec.push(new Uint8Array(pb.env(0, pb.statusFrame(CONV, 2))));
  await dec.idle();
  assert.deepEqual(models, ['claude-opus-5-5']);
});
