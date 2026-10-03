// Gemini page config (ISOLATED world). Selector verified in DevTools on 2026-10-03.
// The network half lives in gemini-network.js.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});
  ns.site = Object.assign(ns.site || {}, {
    verified: true,
    hosts: ['gemini.google.com'],
    site: 'gemini',
    // No test id exists. English UI only: the label is localized.
    stopButton: 'button[aria-label="Stop response"]',
  });
})(globalThis);
