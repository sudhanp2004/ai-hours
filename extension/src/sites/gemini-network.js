// Gemini network config (MAIN world). Verified in DevTools on 2026-10-03 (spec §11, Probe
// results). The reply is one XMLHttpRequest (not fetch), timed by its own start and end.
// Stop is a batchexecute call whose rpc id is in the query string, so URLs here are matched
// with their query. The only thing read from the response is the model's name.
// The page-side half lives in gemini-page.js: a file can't be listed in both worlds.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});

  // The response names its model as a short value such as "3.6 Flash" (seen 2026-10-03; the
  // request only carries an opaque code). Only short strings are considered, so a reply
  // that mentions "2.5 Pro" in a sentence is never mistaken for it.
  const MODEL = /\b(\d+(?:\.\d+)? (?:Flash|Pro|Ultra|Nano)(?:[- ](?:Lite|Thinking|Preview|Experimental))*)\b/;
  const SHORT = 40;

  function modelFromResponse(text) {
    if (typeof text !== 'string') return null;
    let loose = null;
    function walk(v, depth) {
      if (typeof v === 'string') {
        if (v.length > SHORT) return null;
        const m = MODEL.exec(v);
        if (!m) return null;
        if (m[1] === v) return v; // the value is exactly a model name: take it
        loose = loose ?? m[1]; // a short label around one, kept in case nothing exact turns up
        return null;
      }
      if (!Array.isArray(v) || depth > 64) return null;
      for (const x of v) {
        const hit = walk(x, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    // )]}' then length-prefixed lines, each [["wrb.fr", null, "<JSON as a string>"], ...].
    for (const line of text.split('\n')) {
      if (!line.startsWith('[')) continue;
      let outer;
      try {
        outer = JSON.parse(line);
      } catch {
        continue; // the last line may still be arriving
      }
      for (const e of Array.isArray(outer) ? outer : []) {
        if (!Array.isArray(e) || e[0] !== 'wrb.fr' || typeof e[2] !== 'string') continue;
        let inner;
        try {
          inner = JSON.parse(e[2]);
        } catch {
          continue;
        }
        const hit = walk(inner, 0);
        if (hit) return hit;
      }
    }
    return loose;
  }

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
    modelFromResponse,
  });
})(globalThis);
