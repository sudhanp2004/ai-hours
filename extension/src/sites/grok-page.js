// grok page config (ISOLATED world). STUB — not yet verified, so not in the manifest.
// Fill in from spike/site-probe.js, then flip verified to true and add this site to
// manifest.json (both halves, one entry each) in the same commit.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});
  ns.site = Object.assign(ns.site || {}, {
    verified: false,          // flip to true only after the probe confirms the selector
    hosts: ['grok.com'],
    site: 'grok',
    stopButton: null,         // TODO(probe fact 5): a stable selector, e.g. 'button[data-testid="…"]'
  });
})(globalThis);
