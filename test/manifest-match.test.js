const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/manifest-match.js');
const { matchesAny, scriptsFor } = globalThis.__aiHours;

// One site, two entries, both matching the same domain — the case a second site breaks.
const CHATGPT = [
  { matches: ['https://chatgpt.com/*'], js: ['gpt-main.js'] },
  { matches: ['https://chatgpt.com/*'], js: ['gpt-page.js'] },
];
const CLAUDE = [
  { matches: ['https://claude.ai/*'], js: ['claude-main.js'] },
  { matches: ['https://claude.ai/*'], js: ['claude-page.js'] },
];

test('a match pattern matches its own scheme, host and path', () => {
  assert.ok(matchesAny(['https://chatgpt.com/*'], 'https://chatgpt.com/c/abc'));
  assert.ok(matchesAny(['https://chatgpt.com/*'], 'https://chatgpt.com/'));
  assert.ok(matchesAny(['https://*.google.com/*'], 'https://gemini.google.com/app'));
});

test('a match pattern refuses a different host, scheme or a prefix trick', () => {
  // The prefix cases matter: a regex built carelessly would accept these, and then we'd
  // run on a domain the user never granted.
  assert.ok(!matchesAny(['https://chatgpt.com/*'], 'https://evil.com/chatgpt.com/'));
  assert.ok(!matchesAny(['https://chatgpt.com/*'], 'https://chatgpt.com.evil.com/'));
  assert.ok(!matchesAny(['https://chatgpt.com/*'], 'http://chatgpt.com/c/1'));
  assert.ok(!matchesAny(['https://chatgpt.com/*'], 'https://sub.chatgpt.com/c/1'));
  assert.ok(!matchesAny(['https://chatgpt.com/c/*'], 'https://chatgpt.com/other/1'));
});

test('a dot in the pattern is a literal dot, not any character', () => {
  assert.ok(!matchesAny(['https://chatgpt.com/*'], 'https://chatgptXcom/c/1'));
});

test('a malformed pattern matches nothing rather than everything', () => {
  assert.ok(!matchesAny(['not a pattern'], 'https://chatgpt.com/'));
  assert.ok(!matchesAny(['https://chatgpt.com'], 'https://chatgpt.com/'), 'no path part');
});

test('a site gets exactly its own two entries', () => {
  const all = [...CHATGPT, ...CLAUDE];
  assert.deepEqual(scriptsFor(all, 'https://chatgpt.com/c/1').map((e) => e.js[0]), ['gpt-main.js', 'gpt-page.js']);
  assert.deepEqual(scriptsFor(all, 'https://claude.ai/chat/1').map((e) => e.js[0]), ['claude-main.js', 'claude-page.js']);
});

test('a tab on no supported site gets nothing', () => {
  assert.deepEqual(scriptsFor([...CHATGPT, ...CLAUDE], 'https://example.com/'), []);
});

test('with no url every entry is offered, and the page refuses the wrong one', () => {
  const all = [...CHATGPT, ...CLAUDE];
  assert.equal(scriptsFor(all, undefined).length, 4);
  assert.equal(scriptsFor(all, null).length, 4);
});

test('an entry with no matches list is skipped, not crashed on', () => {
  assert.deepEqual(scriptsFor([{ js: ['x.js'] }], 'https://chatgpt.com/'), []);
});
