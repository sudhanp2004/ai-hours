// claude.ai page config (ISOLATED world). Selector verified in DevTools on 2026-10-03.
// The network half lives in claude-network.js.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});
  ns.site = Object.assign(ns.site || {}, {
    verified: true,
    hosts: ['claude.ai'],
    site: 'claude',
    // aria-label "Stop response"; the test id is not localized, so it is the one to use.
    stopButton: 'button[data-testid="chat-input-stop"]',
  });
})(globalThis);
