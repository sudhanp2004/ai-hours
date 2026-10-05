// Chrome-sync backup (spec §13, revised): each install keeps a compact per-site/per-model
// summary in chrome.storage.sync; the totals add the other installs' summaries to this one's.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/total.js');
const { summaryOf, summaryItems, combine, breakdown } = globalThis.__aiHours;

const NOW = 1790764800000;
const done = (site, model, ms) => ({ site, start: NOW - 1e6, end: NOW - 1e6 + ms, server: model ? { model } : {} });

test('a summary is the totals per site and model, in whole milliseconds, and small', () => {
  const recs = [done('claude', 'claude-opus-5-5', 30000), done('claude', 'claude-opus-5-5', 12000.7), done('chatgpt', null, 5000)];
  const s = summaryOf(recs, NOW, { device: 'd1', sub: null });
  assert.deepEqual(s, { v: 1, device: 'd1', sub: null, at: NOW, sites: { claude: { 'claude-opus-5-5': 42000 }, chatgpt: { '': 5000 } } });
});

// Chrome sync allows 8 KB per item, so each site is its own item; a site with an absurd number
// of models folds its rarest into "model not recorded", keeping the total exact.
test('summary items: one per site, each under 8 KB, totals preserved', () => {
  const many = [];
  for (let i = 0; i < 200; i++) many.push(done('claude', `claude-model-number-${i}-preview-2026-with-a-long-name`.slice(0, 64), 1000 + i));
  const items = summaryItems(summaryOf(many, NOW, { device: 'd1', sub: 'g' }));
  assert.deepEqual(Object.keys(items), ['sum:d1:claude']);
  const item = items['sum:d1:claude'];
  assert.ok(JSON.stringify(item).length < 8000, `${JSON.stringify(item).length} bytes`);
  const total = Object.values(item.models).reduce((a, b) => a + b, 0);
  assert.equal(total, many.reduce((a, r) => a + (r.end - r.start), 0));
  assert.deepEqual({ ...item, models: undefined }, { v: 1, device: 'd1', sub: 'g', at: NOW, site: 'claude', models: undefined });
});

test('combine reads per-site items too', () => {
  const local = breakdown([], NOW);
  const items = summaryItems({ v: 1, device: 'laptop', sub: null, at: NOW, sites: { claude: { m: 5000 }, gemini: { '': 2000 } } });
  assert.equal(combine(local, Object.values(items), { device: 'me', sub: null }).ms, 7000);
});

test('combine adds other installs’ summaries to this one’s totals, never its own', () => {
  const local = breakdown([done('claude', 'claude-opus-5-5', 60000)], NOW);
  const mine = { v: 1, device: 'me', sub: null, at: NOW, sites: { claude: { 'claude-opus-5-5': 60000 } } };
  const laptop = { v: 1, device: 'laptop', sub: null, at: NOW, sites: { claude: { 'claude-opus-5-5': 15000 }, gemini: { '3.6 Flash': 9000 } } };
  const old = { v: 1, device: 'old-install', sub: null, at: NOW, sites: { chatgpt: { '': 4000 } } };
  const c = combine(local, [mine, laptop, old], { device: 'me', sub: null });
  assert.equal(c.ms, 60000 + 15000 + 9000 + 4000);
  assert.deepEqual(c.sites.map((s) => [s.site, s.ms]), [['claude', 75000], ['gemini', 9000], ['chatgpt', 4000]]);
  assert.deepEqual(c.sites[2].models, [{ model: null, ms: 4000, working: 0 }], "'' is 'model not recorded'");
  assert.equal(c.working, local.working);
});

test('summaries from devices that upload to the same account are skipped: their replies arrive as records', () => {
  const local = breakdown([], NOW);
  const synced = { v: 1, device: 'laptop', sub: 'g-1', at: NOW, sites: { claude: { '': 50000 } } };
  const notSignedIn = { v: 1, device: 'desktop', sub: null, at: NOW, sites: { claude: { '': 7000 } } };
  const otherAccount = { v: 1, device: 'work', sub: 'g-2', at: NOW, sites: { claude: { '': 3000 } } };
  assert.equal(combine(local, [synced, notSignedIn, otherAccount], { device: 'me', sub: 'g-1' }).ms, 10000);
  assert.equal(combine(local, [synced, notSignedIn], { device: 'me', sub: null }).ms, 57000, 'signed out here: every other summary counts');
});

test('broken summaries count nothing', () => {
  const local = breakdown([], NOW);
  const junk = [null, 'x', { v: 1, device: 'a', sites: { claude: { m: 'lots' } } }, { v: 1, device: 'b', sites: { claude: { m: -5 } } }, { v: 2, device: 'c', sites: {} }];
  assert.equal(combine(local, junk, { device: 'me', sub: null }).ms, 0);
});
