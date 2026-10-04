// The per-LLM breakdown: model names, the numbers, and the panel's HTML.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/total.js');
require('../extension/src/models.js');
require('../extension/src/breakdown-view.js');
const { modelName, siteInfo, breakdown, liveTotal, breakdownHtml } = globalThis.__aiHours;

const NOW = 1790764800000;
const done = (site, model, ms, over) => ({ site, start: NOW - 100000, end: NOW - 100000 + ms, server: model ? { model } : {}, flags: [], ...over });

// ---- names
test('model names: known families read like the sites write them, anything else is shown raw', () => {
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-sonnet-4-5'), 'Sonnet 4.5');
  assert.equal(modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelName('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(modelName('claude-opus-4'), 'Opus 4');
  assert.equal(modelName('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
  assert.equal(modelName('gpt-5'), 'GPT-5');
  assert.equal(modelName('gpt-5-thinking'), 'GPT-5 Thinking');
  assert.equal(modelName('gpt-4o'), 'GPT-4o');
  assert.equal(modelName('gpt-4.1-mini'), 'GPT-4.1 Mini');
  assert.equal(modelName('o3'), 'o3');
  assert.equal(modelName('turbo'), 'turbo', 'unknown: the raw slug, so a new model still shows up');
  assert.equal(modelName(null), null);
});

test('site info: display names, and which sites can recover a closed tab', () => {
  assert.deepEqual(siteInfo('chatgpt'), { name: 'ChatGPT', recovers: true });
  assert.deepEqual(siteInfo('perplexity'), { name: 'Perplexity', recovers: true });
  assert.deepEqual(siteInfo('claude'), { name: 'Claude', recovers: false });
  assert.deepEqual(siteInfo('gemini'), { name: 'Gemini', recovers: false });
  assert.deepEqual(siteInfo('newsite'), { name: 'newsite', recovers: false });
});

// ---- numbers
test('breakdown: per site and per model, biggest first, summing to the live total', () => {
  const records = [
    done('claude', 'claude-opus-5-5', 60000),
    done('claude', 'claude-sonnet-4-5', 20000),
    done('claude', 'claude-opus-5-5', 30000),
    done('chatgpt', 'gpt-5', 50000),
    done('chatgpt', null, 5000),
  ];
  const b = breakdown(records, NOW);
  assert.equal(b.ms, liveTotal(records, NOW).ms);
  assert.deepEqual(b.sites.map((s) => [s.site, s.ms]), [['claude', 110000], ['chatgpt', 55000]]);
  assert.deepEqual(b.sites[0].models, [{ model: 'claude-opus-5-5', ms: 90000, working: 0 }, { model: 'claude-sonnet-4-5', ms: 20000, working: 0 }]);
  assert.deepEqual(b.sites[1].models.map((m) => m.model), ['gpt-5', null], 'history from before models were recorded');
});

test('breakdown counts exactly what the pill counts: live, recovered, pending and stale alike', () => {
  const records = [
    done('chatgpt', 'gpt-5', 10000),
    { site: 'chatgpt', start: NOW - 9000, end: null, lastSeen: NOW - 1000, server: { model: 'gpt-5' } }, // live
    { site: 'claude', start: NOW - 9000, end: null, lastSeen: NOW - 60000, server: {} }, // stale
    { site: 'perplexity', start: NOW - 9000, end: null, outcome: 'pending', server: {} }, // closed tab
    { site: 'perplexity', start: NOW - 99000, end: null, recovered: { durationMs: 7000 }, server: { model: 'turbo' } },
  ];
  const b = breakdown(records, NOW);
  assert.equal(b.ms, liveTotal(records, NOW).ms);
  assert.equal(b.working, 1);
  assert.deepEqual(b.sites.map((s) => [s.site, s.ms, s.working]), [['chatgpt', 19000, 1], ['perplexity', 7000, 0]]);
});

test('records without a site (older versions) are counted under ChatGPT, the only site then', () => {
  const b = breakdown([{ start: NOW - 5000, end: NOW, server: {} }], NOW);
  assert.deepEqual(b.sites.map((s) => s.site), ['chatgpt']);
});

// ---- HTML
const data = () => breakdown([
  done('claude', 'claude-opus-5-5', 3_700_000),
  done('chatgpt', 'gpt-5', 125000),
  done('chatgpt', null, 5000),
], NOW);

test('collapsed: one row per LLM with its time; models hidden; no-recovery sites marked', () => {
  const html = breakdownHtml(data(), new Set());
  assert.match(html, /Claude/);
  assert.match(html, /1h 1m 40s/);
  assert.match(html, /ChatGPT/);
  assert.doesNotMatch(html, /Opus 5\.5/);
  assert.match(html, /aria-expanded="false"/);
  // The honesty mark: Claude can't recover closed tabs, ChatGPT can.
  const claudeRow = html.slice(html.indexOf('Claude'), html.indexOf('ChatGPT'));
  assert.match(claudeRow, /class="mark"/);
  assert.match(html, /closed mid-reply/);
});

test('expanded: that LLM’s models appear with their own times; older history is labelled', () => {
  const html = breakdownHtml(data(), new Set(['chatgpt']));
  assert.match(html, /GPT-5/);
  assert.match(html, /Model not recorded/);
  assert.doesNotMatch(html, /Opus 5\.5/, 'only the expanded LLM opens');
  assert.match(html, /data-site="chatgpt" aria-expanded="true"/);
});

test('names from the server are escaped, so a hostile slug cannot inject markup', () => {
  const evil = breakdown([done('chatgpt', '<img src=x onerror=alert(1)>', 1000)], NOW);
  const html = breakdownHtml(evil, new Set(['chatgpt']));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('nothing recorded yet: a quiet empty state, not an empty box', () => {
  assert.match(breakdownHtml(breakdown([], NOW), new Set()), /No AI time recorded yet/);
});

// ---- the live panel: rebuilt only when its rows change, so clicks and focus survive ticks
function fakeContainer() {
  const c = { builds: 0, handlers: {}, cells: [] };
  Object.defineProperty(c, 'innerHTML', { set(v) { c.builds++; c.html = v; c.cells = [...v.matchAll(/data-k="([^"]*)">([^<]*)</g)].map(([, k, t]) => ({ dataset: { k: k.replace(/&#39;/g, "'") }, textContent: t })); } });
  c.addEventListener = (type, fn) => (c.handlers[type] = fn);
  c.querySelectorAll = (sel) => (sel === '[data-k]' ? c.cells : []);
  return c;
}

test('panel: a tick rewrites times in place; only a change of rows rebuilds it', () => {
  const c = fakeContainer();
  const panel = globalThis.__aiHours.createBreakdownPanel(c);
  const live = (now) => breakdown([done('claude', 'claude-opus-5-5', 1000), { site: 'claude', start: NOW - 5000, end: null, lastSeen: now, server: {} }], now);
  panel.update(live(NOW));
  panel.update(live(NOW + 1000));
  panel.update(live(NOW + 2000));
  assert.equal(c.builds, 1, 'ticks do not rebuild');
  assert.equal(c.cells.find((x) => x.dataset.k === 'claude').textContent, '8s');
  panel.update(breakdown([done('claude', 'claude-opus-5-5', 1000), done('gemini', null, 2000)], NOW));
  assert.equal(c.builds, 2, 'a new site is a new row');
});

test('panel: clicking a row opens that LLM’s models', () => {
  const c = fakeContainer();
  const panel = globalThis.__aiHours.createBreakdownPanel(c);
  panel.update(data());
  c.handlers.click({ target: { closest: () => ({ dataset: { site: 'claude' } }) } });
  assert.match(c.html, /Opus 5\.5/);
  c.handlers.click({ target: { closest: () => ({ dataset: { site: 'claude' } }) } });
  assert.doesNotMatch(c.html, /Opus 5\.5/);
});

test('DeepSeek: its request-derived slugs read as the product names', () => {
  assert.equal(modelName('deepseek-default'), 'DeepSeek');
  assert.equal(modelName('deepseek-default-deepthink'), 'DeepSeek DeepThink');
  assert.equal(modelName('deepseek-expert'), 'DeepSeek Expert');
  assert.deepEqual(siteInfo('deepseek'), { name: 'DeepSeek', recovers: false });
});
