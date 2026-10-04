// DeepSeek page config (ISOLATED world). Selector verified in DevTools on 2026-10-04.
// The network half lives in deepseek-network.js.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});
  ns.site = Object.assign(ns.site || {}, {
    verified: true,
    hosts: ['chat.deepseek.com'],
    site: 'deepseek',
    // The send button turns into Stop by swapping its icon to a rounded square; it has no
    // label or test id, so the icon's path is the only handle. A redesign would break it,
    // which loses only the cross-check, never the count.
    stopButton: '.ds-button--primary path[d^="M2 4.88"]',
  });
})(globalThis);
