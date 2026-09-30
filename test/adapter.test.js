const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/adapter-chatgpt.js');
const { chatgpt } = globalThis.__aiHours;

const SECRET = 'SECRET-TEXT-MUST-NOT-LEAK';
const ev = (x) => ({ event: 'delta', data: typeof x === 'string' ? x : JSON.stringify(x) });

test('stream and stop URL patterns match the verified endpoints only', () => {
  assert.ok(chatgpt.streamUrl.test('/backend-api/f/conversation'));
  assert.ok(chatgpt.streamUrl.test('/backend-anon/f/conversation'));
  assert.ok(!chatgpt.streamUrl.test('/backend-api/f/conversation/prepare'));
  assert.ok(!chatgpt.streamUrl.test('/backend-api/conversation/init'));
  assert.ok(chatgpt.stopUrl.test('/backend-api/stop_conversation'));
});

test('[DONE] → done', () => {
  assert.deepEqual(chatgpt.parseEvent(ev('[DONE]')), { kind: 'done' });
});

test('non-JSON, non-object and unrelated events → null', () => {
  assert.equal(chatgpt.parseEvent(ev('"v1"')), null);
  assert.equal(chatgpt.parseEvent(ev('garbage')), null);
  assert.equal(chatgpt.parseEvent(ev({ type: 'title_generation', title: SECRET })), null);
  assert.equal(chatgpt.parseEvent(ev({ p: '/message/content/parts/0', o: 'append', v: SECRET })), null);
  assert.equal(chatgpt.parseEvent(ev({ v: SECRET })), null);
});

test('message add → structural signal only', () => {
  const sig = chatgpt.parseEvent(ev({
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
  const sig = chatgpt.parseEvent(ev({ message: { id: 'm2', author: { role: 'assistant' }, status: 'finished_successfully' } }));
  assert.equal(sig.kind, 'message');
  assert.equal(sig.messageId, 'm2');
});

test('long strings are dropped, so text cannot leak through structural fields', () => {
  const sig = chatgpt.parseEvent(ev({ v: { message: { author: { role: SECRET.repeat(4) }, content: { content_type: SECRET.repeat(4) } } } }));
  assert.equal(sig.role, null);
  assert.equal(sig.contentType, null);
  assert.ok(!JSON.stringify(sig).includes(SECRET));
});

test('batched patch that sets a finished status → finished', () => {
  const sig = chatgpt.parseEvent(ev({
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
  assert.deepEqual(chatgpt.parseEvent(ev({ p: '/message/status', o: 'replace', v: 'finished_partial_completion' })), { kind: 'finished' });
  assert.equal(chatgpt.parseEvent(ev({ p: '/message/status', o: 'replace', v: 'in_progress' })), null);
});
