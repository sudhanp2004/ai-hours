// Gemini network config (MAIN world). Verified in DevTools on 2026-10-03 (spec §11, Probe
// results). The reply is one XMLHttpRequest (not fetch), timed by its own start and end, so
// no frame is ever parsed and no text is ever read. Stop is a batchexecute call whose rpc id
// is in the query string, so URLs here are matched with their query.
// The page-side half lives in gemini-page.js: a file can't be listed in both worlds.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});
  ns.site = Object.assign(ns.site || {}, {
    verified: true,
    matchQuery: true,
    streamUrl: /^\/_\/BardChatUi\/data\/assistant\.lamda\.BardFrontendService\/StreamGenerate(?:\?|$)/,
    // rpcids may list several ids, comma-separated (%2C once encoded).
    stopUrl: /^\/_\/BardChatUi\/data\/batchexecute\?(?:.*&)?rpcids=(?:[^&]*(?:,|%2C))?NkpXw(?:,|%2C|&|$)/,
    // The loaded chat (rpc hNvQHb) has one timestamp per turn, the send, and no end. With
    // nothing honest to recover from, a reply whose tab closed stays unknown (spec §11).
    conversationUrl: null,
    parseEvent: null,
    sendIds: null, // the send body is the prompt itself; nothing in it is worth the risk
    parseConversation: null,
  });
})(globalThis);
