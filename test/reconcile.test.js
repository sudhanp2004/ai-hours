const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/reconcile.js');
const { matchTurn, recover, pendingByTab } = globalThis.__aiHours;

const T0 = 1790764800000;
const sec = (ms) => ms / 1000;

// A record that was watched for 5 s and then lost its tab.
const watched = (over) => ({
  id: 'r1', tabId: 7, start: T0, firstByte: T0 + 3000, finished: null, end: null,
  lastSeen: T0 + 5000, outcome: 'pending', source: 'fetch-only', confidence: 'high', flags: [],
  dom: null, sent: { conversationId: 'c1', messageId: 'u1' }, recovered: null,
  server: { turnExchangeId: 'tx-1' }, ...over,
});

const turn = (over) => ({
  turnExchangeId: 'tx-1', requestId: null, userMessageId: 'u1',
  userCreateTime: sec(T0), startSec: sec(T0 + 6000), endSec: sec(T0 + 30000),
  reasoningStart: null, reasoningEnd: null, finishType: 'stop', ...over,
});

// ---- matching, most reliable key first
test('matches on the live stream turn id', () => {
  assert.equal(matchTurn(watched(), [turn({ turnExchangeId: 'other' }), turn()])?.turnExchangeId, 'tx-1');
});

test('matches on the user message id captured at send, when there is no turn id', () => {
  const rec = watched({ server: {} });
  assert.equal(matchTurn(rec, [turn({ userMessageId: 'nope' }), turn()])?.userMessageId, 'u1');
});

test('falls back to send time within 2 s, for a close before the first chunk', () => {
  const rec = watched({ server: {}, sent: { conversationId: 'c1', messageId: 'no-such-id' } });
  const near = [turn({ userMessageId: 'x', userCreateTime: sec(T0 + 1500) })];
  assert.ok(matchTurn(rec, near));
  const far = [turn({ userMessageId: 'x', userCreateTime: sec(T0 + 30000) })];
  assert.equal(matchTurn(rec, far), null);
});

test('no match when the send time is outside the window and the ids differ', () => {
  const rec = watched({ server: {}, sent: { messageId: 'x' } });
  assert.equal(matchTurn(rec, [turn({ userMessageId: 'y', userCreateTime: sec(T0 + 60000) })]), null);
  assert.equal(matchTurn(rec, []), null);
  assert.equal(matchTurn(rec, [turn({ userMessageId: 'y', userCreateTime: null })]), null);
});

test('a turn still generating does not match, because it has no end yet', () => {
  assert.equal(matchTurn(watched(), [turn({ endSec: null })]), null);
});

// ---- the recovered duration: two spans, two clocks, never subtracted
test('observed time plus the server span, not a clock mix', () => {
  // Watched 5 s. The server ran the turn 6000 -> 30000, i.e. 24 s we never saw.
  const r = recover(watched(), turn(), T0 + 60000);
  assert.equal(r.recovered.durationMs, 5000 + 24000);
  assert.equal(r.outcome, 'recovered');
  assert.equal(r.recovered.serverStart, sec(T0 + 6000));
  assert.equal(r.recovered.serverEnd, sec(T0 + 30000));
  assert.equal(r.recovered.matchedBy, 'turnExchangeId');
});

test('a close before generation started keeps only the server span', () => {
  const rec = watched({ firstByte: null, lastSeen: null, server: {}, sent: { messageId: 'u1' } });
  const r = recover(rec, turn(), T0 + 60000);
  assert.equal(r.recovered.durationMs, 24000);
});

test('no server span at all recovers only what was watched', () => {
  const r = recover(watched(), turn({ startSec: null, endSec: null }), T0 + 60000);
  assert.equal(r.recovered.durationMs, 5000);
});

// Perplexity's server span runs from the send, so the watched part is already inside it.
// Adding the two would count those seconds twice; the larger of the two is the honest one.
test('a server span that starts at the send overlaps the watched time, so it is not added', () => {
  const r = recover(watched(), turn({ startSec: sec(T0), endSec: sec(T0 + 24000), startIsSend: true }), T0 + 60000);
  assert.equal(r.recovered.durationMs, 24000);
  const short = recover(watched(), turn({ startSec: sec(T0), endSec: sec(T0 + 2000), startIsSend: true }), T0 + 60000);
  assert.equal(short.recovered.durationMs, 5000, 'the watched time is a floor: clock drift cannot shrink it');
});

test('the observed span stops at the sign of life, never at the reopen', () => {
  // Tab closed at 5 s, chat reopened 10 minutes later. The wait is not AI work.
  const r = recover(watched(), turn(), T0 + 600000);
  assert.equal(r.recovered.durationMs, 5000 + 24000);
});

test('a backwards server span (device clock drift) can never subtract from the total', () => {
  const r = recover(watched(), turn({ startSec: sec(T0 + 30000), endSec: sec(T0 + 20000) }), T0 + 60000);
  assert.equal(r.recovered.durationMs, 5000);
  assert.ok(r.recovered.durationMs >= 0);
});

test('a recovered record learns its model from the turn, unless it already knew it', () => {
  assert.equal(recover(watched({ server: {} }), turn({ model: 'gpt-5' }), T0 + 60000).server.model, 'gpt-5');
  assert.equal(recover(watched({ server: { model: 'gpt-5-thinking' } }), turn({ model: 'gpt-5' }), T0 + 60000).server.model, 'gpt-5-thinking');
  assert.equal(recover(watched({ server: {} }), turn(), T0 + 60000).server.model, undefined);
});

test('a recovered record keeps its identity, so it still counts once', () => {
  const r = recover(watched(), turn(), T0 + 60000);
  assert.equal(r.id, 'r1');
  assert.equal(r.end, null, 'end stays null: the duration is recovered.durationMs');
  assert.equal(r.recovered.at, T0 + 60000);
  assert.equal(r.sent.messageId, 'u1');
  assert.deepEqual(r.server, { turnExchangeId: 'tx-1' });
});

test('recovery records how it matched, for verification', () => {
  assert.equal(recover(watched({ server: {} }), turn(), T0).recovered.matchedBy, 'messageId');
  assert.equal(recover(watched({ server: {}, sent: { messageId: 'zz' } }), turn({ userMessageId: 'zz' }), T0).recovered.matchedBy, 'messageId');
  // No turn id and no matching message id: only the send time is left.
  const drifted = watched({ server: {}, sent: { messageId: 'stale-id' } });
  assert.equal(recover(drifted, turn({ userMessageId: 'zz', userCreateTime: sec(T0 + 900) }), T0).recovered.matchedBy, 'sendTime');
});

// ---- tab-close bookkeeping (the worker's half, pure so it can be tested)
test('markPending flags only this tab\u2019s unfinished records', () => {
  const recs = [
    { id: 'a', tabId: 7, end: null, lastSeen: T0 + 4000 },
    { id: 'b', tabId: 7, end: T0 + 9000, outcome: 'completed' },
    { id: 'c', tabId: 9, end: null, lastSeen: T0 + 2000 },
  ];
  const out = pendingByTab(recs, 7, T0 + 5000);
  assert.deepEqual(Object.keys(out), ['a']);
  assert.equal(out.a.outcome, 'pending');
  assert.equal(out.a.lastSeen, T0 + 4000, 'the sign of life is kept; only the outcome changes');
  assert.equal(out.a.end, null, 'no end is invented: the duration is still unknown');
});

test('markPending ignores records that already ended, or another tab, or a re-mark', () => {
  const recs = [
    { id: 'a', tabId: 7, end: T0 + 9000 },
    { id: 'b', tabId: 8, end: null },
    { id: 'c', tabId: 7, end: null, outcome: 'pending' },
  ];
  assert.deepEqual(pendingByTab(recs, 7, T0), {});
});

test('a record recovered later is never re-pending or re-recovered', () => {
  const done = recover(watched(), turn(), T0);
  assert.deepEqual(pendingByTab([done], 7, T0 + 90000), {}, 'recovered has an end-equivalent duration');
  assert.equal(matchTurn(done, [turn()]), null);
});
// ---- which records a conversation load may finish
const { isRecoverable } = globalThis.__aiHours;

test('recoverable: pending, or unfinished and silent for over 30 s (a browser quit sends no close event)', () => {
  assert.equal(isRecoverable(watched({ outcome: 'pending' }), T0 + 6000), true);
  const quit = watched({ outcome: 'unknown', lastSeen: T0 + 5000 });
  assert.equal(isRecoverable(quit, T0 + 5000 + 30001), true);
  assert.equal(isRecoverable(quit, T0 + 5000 + 29000), false, 'still inside the live window: its tab may be streaming');
  assert.equal(isRecoverable(watched({ outcome: 'unknown', lastSeen: null }), T0 + 30001), true, 'no sign of life: measured from start');
});

test('never recoverable: already finished or already recovered', () => {
  assert.equal(isRecoverable(watched({ end: T0 + 9000, outcome: 'completed' }), T0 + 99999), false);
  assert.equal(isRecoverable(watched({ recovered: { durationMs: 1 } }), T0 + 99999), false);
});
