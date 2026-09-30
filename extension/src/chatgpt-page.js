// ChatGPT page config (ISOLATED world). Selector verified in DevTools on 2026-09-30 (see spike/).
// The network half of ns.chatgpt lives in chatgpt-network.js.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});

  ns.chatgpt = Object.assign(ns.chatgpt || {}, {
    site: 'chatgpt',
    stopButton: 'button[data-testid="stop-button"]',
  });
})(globalThis);
