// copilot network config (MAIN world). STUB — not yet verified, so not in the manifest.
// Fill in from spike/site-probe.js, then flip verified to true and add this site to
// manifest.json (both halves, one entry each) in the same commit.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});
  ns.site = Object.assign(ns.site || {}, {
    verified: false,          // flip to true only after the probe confirms the endpoints
    // TODO(probe fact 2): regex for the chat stream URL, e.g. /\/stream\/generate$/
    streamUrl: null,
    // TODO(probe fact 4): regex for the stop request, if the site issues one
    stopUrl: null,
    // TODO(probe fact 6): regex for the conversation-load URL, or null if chats load
    // from memory (which means no closed-tab recovery on this site — see spec §11)
    conversationUrl: null,
    // TODO(probe fact 3): SSE → Signal | null. Reuse the shape from chatgpt-network.js.
    // If the stream is not SSE, stop here and read spec ⚑8 before writing this.
    parseEvent: null,
    // TODO(probe fact 1): read the two ids out of the send body, ids only, never text
    sendIds: null,
    // TODO(probe fact 6): loaded conversation JSON → Turn[]. Reuse turnFor's shape.
    parseConversation: null,
  });
})(globalThis);
