// Perplexity page config (ISOLATED world). Selector verified in DevTools on 2026-10-03.
// The network half lives in perplexity-network.js.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});
  ns.site = Object.assign(ns.site || {}, {
    verified: true,
    hosts: ['perplexity.ai'],
    site: 'perplexity',
    // The label reads "Stop response (Esc)" and has no test id, so match its prefix.
    // English UI only: the label is localized.
    stopButton: 'button[aria-label^="Stop response"]',
  });
})(globalThis);
