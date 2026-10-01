const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/sites/chatgpt-network.js');
require('../extension/src/sites/chatgpt-page.js');
const { site } = globalThis.__aiHours;

const SECRET = 'SECRET-TEXT-MUST-NOT-LEAK';
const ev = (x) => ({ event: 'delta', data: typeof x === 'string' ? x : JSON.stringify(x) });
const roundtrip = (x) => JSON.stringify(x);

test('stream and stop URL patterns match the verified endpoints only', () => {
  assert.ok(site.streamUrl.test('/backend-api/f/conversation'));
  assert.ok(site.streamUrl.test('/backend-anon/f/conversation'));
  assert.ok(!site.streamUrl.test('/backend-api/f/conversation/prepare'));
  assert.ok(!site.streamUrl.test('/backend-api/conversation/init'));
  assert.ok(!site.streamUrl.test('/backend-api/conversation/experimental/generate_autocompletions'));
  assert.ok(site.stopUrl.test('/backend-api/stop_conversation'));
});

// A conversation is loaded with the plural form; the singular one is a different endpoint
// and reading it as a conversation would pair the wrong messages.
test('conversation URL matches the plural load endpoint only', () => {
  const id = '6abce67c-11fc-83ee-bf0d-21bad86c85c0';
  assert.ok(site.conversationUrl.test(`/backend-api/conversations/${id}`));
  assert.ok(!site.conversationUrl.test(`/backend-api/conversation/${id}`));
  assert.ok(!site.conversationUrl.test('/backend-api/conversations'));
  assert.ok(!site.conversationUrl.test('/backend-api/conversations/not-a-uuid'));
});

test('network and page halves merge into one config', () => {
  assert.equal(site.site, 'chatgpt');
  assert.equal(site.stopButton, 'button[data-testid="stop-button"]');
  assert.equal(typeof site.parseEvent, 'function');
  assert.equal(typeof site.parseConversation, 'function');
  assert.equal(typeof site.sendIds, 'function');
});

test('[DONE] → done', () => {
  assert.deepEqual(site.parseEvent(ev('[DONE]')), { kind: 'done' });
});

test('non-JSON, non-object and unrelated events → null', () => {
  assert.equal(site.parseEvent(ev('"v1"')), null);
  assert.equal(site.parseEvent(ev('garbage')), null);
  assert.equal(site.parseEvent(ev({ type: 'title_generation', title: SECRET })), null);
  assert.equal(site.parseEvent(ev({ p: '/message/content/parts/0', o: 'append', v: SECRET })), null);
  assert.equal(site.parseEvent(ev({ v: SECRET })), null);
});

test('message add → structural signal only', () => {
  const sig = site.parseEvent(ev({
    o: 'add',
    v: {
      message: {
        id: 'm1',
        author: { role: 'assistant', name: SECRET },
        create_time: 1790764724.1,
        status: 'in_progress',
        content: { content_type: 'text', parts: [SECRET] },
        metadata: { turn_exchange_id: 't1', request_id: 'r1', reasoning_start_time: 1790764720.5, title: SECRET },
      },
    },
  }));
  assert.deepEqual(sig, {
    kind: 'message', role: 'assistant', contentType: 'text', status: 'in_progress', messageId: 'm1',
    createTime: 1790764724.1, turnExchangeId: 't1', requestId: 'r1', reasoningStart: 1790764720.5, reasoningEnd: null,
  });
});

test('message at top level (older shape) is also read', () => {
  const sig = site.parseEvent(ev({ message: { id: 'm2', author: { role: 'assistant' }, status: 'finished_successfully' } }));
  assert.equal(sig.kind, 'message');
  assert.equal(sig.messageId, 'm2');
});

test('long strings are dropped, so text cannot leak through structural fields', () => {
  const sig = site.parseEvent(ev({ v: { message: { author: { role: SECRET.repeat(4) }, content: { content_type: SECRET.repeat(4) } } } }));
  assert.equal(sig.role, null);
  assert.equal(sig.contentType, null);
  assert.ok(!roundtrip(sig).includes(SECRET));
});

test('batched patch that sets a finished status → finished', () => {
  const sig = site.parseEvent(ev({
    p: '', o: 'patch',
    v: [
      { p: '/message/content/parts/0', o: 'append', v: SECRET },
      { p: '/message/status', o: 'replace', v: 'finished_successfully' },
      { p: '/message/end_turn', o: 'replace', v: true },
    ],
  }));
  assert.deepEqual(sig, { kind: 'finished' });
});

test('single-op status patch → finished; in_progress is not', () => {
  assert.deepEqual(site.parseEvent(ev({ p: '/message/status', o: 'replace', v: 'finished_partial_completion' })), { kind: 'finished' });
  assert.equal(site.parseEvent(ev({ p: '/message/status', o: 'replace', v: 'in_progress' })), null);
});

// ---- sendIds: the send request body. Only the two ids may come out of it.
test('sendIds reads the conversation id and the new user message id', () => {
  const body = JSON.stringify({
    conversation_id: '6abce67c-11fc-83ee-bf0d-21bad86c85c0',
    messages: [
      { id: 'aaaaaaaa-0000-0000-0000-000000000000', author: { role: 'user' }, content: { parts: [SECRET] } },
    ],
  });
  assert.deepEqual(site.sendIds(body), {
    conversationId: '6abce67c-11fc-83ee-bf0d-21bad86c85c0',
    messageId: 'aaaaaaaa-0000-0000-0000-000000000000',
  });
});

test('sendIds picks the last user message id, not an earlier one', () => {
  const body = JSON.stringify({
    conversation_id: 'cid',
    messages: [
      { id: 'first', author: { role: 'user' } },
      { id: 'reply', author: { role: 'assistant' } },
      { id: 'second', author: { role: 'user' } },
    ],
  });
  assert.equal(site.sendIds(body).messageId, 'second');
});

test('sendIds survives a missing conversation_id, a bad body and no messages', () => {
  assert.deepEqual(site.sendIds(JSON.stringify({ messages: [{ id: 'x', author: { role: 'user' } }] })), {
    conversationId: null,
    messageId: 'x',
  });
  assert.deepEqual(site.sendIds('not json'), { conversationId: null, messageId: null });
  assert.deepEqual(site.sendIds(null), { conversationId: null, messageId: null });
  assert.deepEqual(site.sendIds(JSON.stringify({})), { conversationId: null, messageId: null });
});

test('sendIds never returns prompt text', () => {
  const body = JSON.stringify({
    conversation_id: 'cid',
    prompt: SECRET,
    messages: [{ id: 'mid', author: { role: 'user' }, content: { parts: [SECRET] } }],
  });
  assert.ok(!roundtrip(site.sendIds(body)).includes(SECRET));
});

// ---- parseConversation: the load response. Ids, roles, statuses and timestamps only.
const convMessage = (over) => ({
  id: 'mid-' + Math.random().toString(36).slice(2, 8),
  author: { role: 'user' },
  create_time: 1790764720.263,
  update_time: 1790764728.787,
  content: { content_type: 'text', parts: [SECRET] },
  status: 'finished_successfully',
  metadata: { turn_exchange_id: 'tx-1' },
  ...over,
});

test('parseConversation groups messages into turns keyed by turn_exchange_id', () => {
  const json = {
    create_time: 1790764668.6,
    messages: [
      convMessage({ author: { role: 'user' }, create_time: 1790764720.263 }),
      convMessage({
        author: { role: 'assistant' },
        create_time: 1790764724.1,
        update_time: 1790764727.2,
        metadata: { turn_exchange_id: 'tx-a', request_id: 'rq-a', finish_details: { type: 'stop' } },
      }),
      convMessage({ author: { role: 'user' }, create_time: 1790764800.0 }),
      convMessage({
        author: { role: 'assistant' },
        create_time: 1790764805.0,
        update_time: 1790764830.0,
        metadata: { turn_exchange_id: 'tx-b', reasoning_start_time: 1790764801, reasoning_end_time: 1790764803 },
      }),
    ],
  };
  const turns = site.parseConversation(json);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].turnExchangeId, 'tx-a');
  assert.equal(turns[0].userCreateTime, 1790764720.263);
  assert.equal(turns[0].startSec, 1790764724.1);
  assert.equal(turns[0].endSec, 1790764727.2);
  assert.equal(turns[0].finishType, 'stop');
  assert.equal(turns[1].turnExchangeId, 'tx-b');
  assert.equal(turns[1].reasoningStart, 1790764801);
  assert.equal(turns[1].endSec, 1790764830.0);
});

test('parseConversation reads the user message id so a 1-second-old close can match', () => {
  const json = {
    messages: [
      convMessage({ id: 'user-abc', author: { role: 'user' }, metadata: { turn_exchange_id: 'tx-1' } }),
      convMessage({ author: { role: 'assistant' }, create_time: 100, update_time: 130 }),
    ],
  };
  const [turn] = site.parseConversation(json);
  assert.equal(turn.userMessageId, 'user-abc');
});

test('parseConversation prefers the assistant turn id over the user message id', () => {
  const json = {
    messages: [
      convMessage({ id: 'user-abc', author: { role: 'user' }, metadata: { turn_exchange_id: 'user-tx' } }),
      convMessage({ author: { role: 'assistant' }, metadata: { turn_exchange_id: 'assistant-tx' } }),
    ],
  };
  const [turn] = site.parseConversation(json);
  assert.equal(turn.turnExchangeId, 'assistant-tx');
});

test('parseConversation keeps the earliest assistant create_time in a turn', () => {
  // Reasoning can arrive as its own message; generation started at the first one.
  const json = {
    messages: [
      convMessage({ author: { role: 'user' }, metadata: { turn_exchange_id: 'tx-1' } }),
      convMessage({ author: { role: 'assistant' }, create_time: 200, update_time: 240, content: { content_type: 'reasoning' } }),
      convMessage({ author: { role: 'assistant' }, create_time: 210, update_time: 240 }),
    ],
  };
  const [turn] = site.parseConversation(json);
  assert.equal(turn.startSec, 200);
  assert.equal(turn.endSec, 240);
});

test('parseConversation ends a turn with the latest update_time', () => {
  const json = {
    messages: [
      convMessage({ author: { role: 'assistant' }, create_time: 200, update_time: 240 }),
      convMessage({ author: { role: 'assistant' }, create_time: 201, update_time: 260 }),
    ],
  };
  const [turn] = site.parseConversation(json);
  assert.equal(turn.endSec, 260);
});

test('parseConversation reports the interrupted finish type', () => {
  const json = {
    messages: [
      convMessage({
        author: { role: 'assistant' },
        create_time: 300,
        update_time: 305,
        metadata: { finish_details: { type: 'interrupted' } },
      }),
    ],
  };
  assert.equal(site.parseConversation(json)[0].finishType, 'interrupted');
});

test('parseConversation returns nothing usable for a malformed response', () => {
  assert.deepEqual(site.parseConversation(null), []);
  assert.deepEqual(site.parseConversation({}), []);
  assert.deepEqual(site.parseConversation({ messages: 'x' }), []);
  assert.deepEqual(site.parseConversation({ messages: [null, 3, 'y'] }), []);
});

test('parseConversation keeps a turn with no assistant reply (still generating)', () => {
  const json = { messages: [convMessage({ author: { role: 'user' }, create_time: 100, metadata: { turn_exchange_id: 'tx-1' } })] };
  const [turn] = site.parseConversation(json);
  assert.equal(turn.turnExchangeId, 'tx-1');
  assert.equal(turn.startSec, null);
  assert.equal(turn.endSec, null);
});

test('no conversation field ever carries message text', () => {
  const json = {
    title: SECRET,
    safe_urls: [SECRET],
    messages: [
      convMessage({
        content: { content_type: 'text', parts: [SECRET] },
        metadata: { model_switcher_deny: [{ context: SECRET }] },
      }),
    ],
  };
  assert.ok(!roundtrip(site.parseConversation(json)).includes(SECRET));
});
