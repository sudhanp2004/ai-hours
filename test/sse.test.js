const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/sse.js');
const { createSseParser } = globalThis.__aiHours;

function collect(chunks) {
  const out = [];
  const parser = createSseParser((e) => out.push(e));
  for (const c of chunks) parser.push(c);
  parser.end();
  return out;
}

test('splits events on blank lines and reads event names', () => {
  assert.deepEqual(collect(['event: delta\ndata: {"a":1}\n\ndata: [DONE]\n\n']), [
    { event: 'delta', data: '{"a":1}' },
    { event: 'message', data: '[DONE]' },
  ]);
});

test('reassembles an event split across chunks', () => {
  assert.deepEqual(collect(['data: {"a"', ':1}\n', '\n']), [{ event: 'message', data: '{"a":1}' }]);
});

test('normalises CRLF, including a CR/LF pair split across chunks', () => {
  assert.deepEqual(collect(['data: x\r', '\n\r\ndata: y\r\n\r\n']), [
    { event: 'message', data: 'x' },
    { event: 'message', data: 'y' },
  ]);
});

test('joins multi-line data with newlines', () => {
  assert.deepEqual(collect(['data: a\ndata: b\n\n']), [{ event: 'message', data: 'a\nb' }]);
});

test('end() flushes a final event with no trailing blank line', () => {
  assert.deepEqual(collect(['data: [DONE]']), [{ event: 'message', data: '[DONE]' }]);
});

test('ignores comment/keep-alive blocks', () => {
  assert.deepEqual(collect([': ping\n\n']), []);
});
