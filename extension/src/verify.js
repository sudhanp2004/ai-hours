// Fetch-vs-DOM cross-verification (spec §5). Pure.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});
  const PAIR_BEFORE_MS = 500;
  const PAIR_AFTER_MS = 2000;
  const LARGE_GAP_MS = 10000;

  // The stop button appears ~50–70 ms after the send fetch (spike, 2026-09-30).
  // A site whose button comes later (Perplexity, ~2.4 s) passes its own afterMs.
  ns.withinPairWindow = (fetchStart, domStart, afterMs = PAIR_AFTER_MS) =>
    domStart >= fetchStart - PAIR_BEFORE_MS && domStart <= fetchStart + afterMs;

  ns.classify = function classify({ fetch, dom }) {
    if (!fetch) return { source: 'dom-only', confidence: 'low', flags: ['fetch-missing'] };
    if (!dom) return { source: 'fetch-only', confidence: 'high', flags: ['dom-missing'] };
    const gap = fetch.end != null && dom.end != null && Math.abs(fetch.end - dom.end) > LARGE_GAP_MS;
    return { source: 'fetch+dom', confidence: 'high', flags: gap ? ['large-gap'] : [] };
  };
})(globalThis);
