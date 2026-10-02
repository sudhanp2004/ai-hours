const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/sites/perplexity-network.js');
require('../extension/src/sites/perplexity-page.js');
const { site } = globalThis.__aiHours;

const SECRET = 'SECRET-TEXT-MUST-NOT-LEAK';
const msg = (over) => ({
  event: 'message',
  data: JSON.stringify({
    backend_uuid: 'b-1', context_uuid: 'ctx-1', uuid: 'u-1', frontend_context_uuid: 'fctx-1',
    frontend_uuid: 'f-1', status: 'PENDING', text_completed: false, final_sse_message: false,
    message_mode: 'STREAMING', text: SECRET, blocks: [{ markdown_block: { answer: SECRET } }], ...over,
  }),
});

// Endpoints verified in DevTools on 2026-10-03 (spec §11, Probe results).
test('stream, stop and thread URL patterns match the verified endpoints only', () => {
  assert.ok(site.streamUrl.test('/rest/sse/perplexity_ask'));
  assert.ok(!site.streamUrl.test('/rest/sse/perplexity_terminate'));
  assert.ok(!site.streamUrl.test('/rest/sse/recent_thread_updates'));
  assert.ok(!site.streamUrl.test('/rest/sse/related-queries/9835cee3'));
  assert.ok(site.stopUrl.test('/rest/sse/perplexity_terminate'));
  assert.ok(site.conversationUrl.test('/rest/thread/9b10f091-3b65-45e9-9ada-e31ba8250963'));
  assert.ok(site.conversationUrl.test('/rest/thread/how-to-cook-rice-AbC_12.xY'));
  assert.ok(!site.conversationUrl.test('/rest/thread/9b10f091-3b65-45e9-9ada-e31ba8250963/entry-metadata'));
  assert.ok(!site.conversationUrl.test('/rest/thread/mark_viewed'));
});

test('network and page halves merge into one config', () => {
  assert.equal(site.site, 'perplexity');
  assert.deepEqual(site.hosts, ['perplexity.ai']);
  assert.equal(site.stopButton, 'button[aria-label^="Stop response"]');
  assert.equal(site.verified, true);
  for (const k of ['parseEvent', 'parseConversation', 'sendIds']) assert.equal(typeof site[k], 'function', k);
});

// The page aborts its own fetch 1 ms after this event, so it is the only reliable end.
test('end_of_stream → done', () => {
  assert.deepEqual(site.parseEvent({ event: 'end_of_stream', data: '{}' }), { kind: 'done' });
});

test('a message event → structural signal keyed by the entry’s frontend uuid, no text', () => {
  const sig = site.parseEvent(msg());
  assert.deepEqual(sig, { kind: 'message', role: 'assistant', status: 'PENDING', turnExchangeId: 'f-1' });
  assert.ok(!JSON.stringify(sig).includes(SECRET));
});

test('non-JSON, non-object and unrelated events → null', () => {
  assert.equal(site.parseEvent({ event: 'message', data: 'not json' }), null);
  assert.equal(site.parseEvent({ event: 'message', data: '42' }), null);
  assert.equal(site.parseEvent({ event: 'message', data: 'null' }), null);
  assert.equal(site.parseEvent({ event: 'ping', data: '{}' }), null);
});

test('long strings are dropped, so text cannot leak through an id field', () => {
  const sig = site.parseEvent(msg({ frontend_uuid: SECRET.repeat(5), status: SECRET.repeat(5) }));
  assert.equal(sig.turnExchangeId, null);
  assert.equal(sig.status, null);
});

// Not yet seen on the wire: the probe recorded the send body's shape only as "JSON". If the
// field is elsewhere, sendIds returns nulls and matching falls back to the stream's id.
test('sendIds reads the thread and entry frontend uuids, never the query', () => {
  const body = JSON.stringify({ query_str: SECRET, params: { frontend_uuid: 'f-1', frontend_context_uuid: 'fctx-1', last_backend_uuid: 'b-0' } });
  const ids = site.sendIds(body);
  assert.deepEqual(ids, { conversationId: 'fctx-1', messageId: 'f-1' });
  assert.ok(!JSON.stringify(ids).includes(SECRET));
});

test('sendIds survives a bad body, a missing params object and a non-string body', () => {
  const none = { conversationId: null, messageId: null };
  assert.deepEqual(site.sendIds('nope'), none);
  assert.deepEqual(site.sendIds(JSON.stringify({ query_str: SECRET })), none);
  assert.deepEqual(site.sendIds(undefined), none);
  assert.deepEqual(site.sendIds(new Uint8Array(3)), none);
});

const THREAD = {
  status: 'success',
  thread_metadata: { title: SECRET },
  entries: [
    {
      backend_uuid: 'b-1', frontend_uuid: 'f-1', status: 'COMPLETED', query_str: SECRET,
      entry_created_datetime: '2026-10-02T21:18:25.305997+00:00',
      entry_updated_datetime: '2026-10-02T21:18:29.743000+00:00',
      updated_datetime: '2026-10-02T21:19:07.999000+00:00',
      blocks: [{ markdown_block: { answer: SECRET } }],
    },
    {
      backend_uuid: 'b-2', frontend_uuid: 'f-2', status: 'PENDING', query_str: SECRET,
      entry_created_datetime: '2026-10-02T21:19:02.725819+00:00',
      entry_updated_datetime: '2026-10-02T21:19:03.000000+00:00',
    },
  ],
};

// entry_created is the send and entry_updated the end, both on the server clock: on the
// probe, updated − created matched the reply's length within 0.5 s on all three turns.
test('parseConversation: one turn per entry, server span from created to updated, no text', () => {
  const turns = site.parseConversation(THREAD);
  assert.equal(turns.length, 2);
  const [a, b] = turns;
  assert.equal(a.turnExchangeId, 'f-1');
  assert.equal(a.userMessageId, 'f-1');
  assert.ok(Math.abs(a.startSec - (Date.parse('2026-10-02T21:18:25Z') / 1000 + 0.305997)) < 1e-6);
  assert.ok(Math.abs(a.endSec - a.startSec - 4.437) < 0.001);
  assert.equal(a.userCreateTime, a.startSec);
  assert.equal(a.startIsSend, true, 'the span already includes the send, so recovery must not add watched time to it');
  assert.equal(b.endSec, null, 'a turn still generating has no end, so it is not usable yet');
  assert.ok(!JSON.stringify(turns).includes(SECRET));
});

test('parseConversation survives junk', () => {
  assert.deepEqual(site.parseConversation(null), []);
  assert.deepEqual(site.parseConversation({ entries: 'x' }), []);
  const [t] = site.parseConversation({ entries: [{ status: 'COMPLETED', entry_created_datetime: 'not a date' }, 7] });
  assert.equal(t.startSec, null);
  assert.equal(t.endSec, null);
});
