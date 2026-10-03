// Perplexity network config (MAIN world). Endpoints verified in DevTools on 2026-10-03
// (spec §11, Probe results). parseEvent returns structural signals only, never answer text.
// The page-side half lives in perplexity-page.js: a file can't be listed in both worlds.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});

  const str = (x) => (typeof x === 'string' && x.length <= 64 ? x : null);
  const obj = (x) => (x && typeof x === 'object' ? x : null);

  // ISO with microseconds and an offset, e.g. 2026-10-02T21:18:25.305997+00:00. Date.parse
  // keeps only milliseconds, so the fraction is added back by hand.
  function isoSec(s) {
    if (typeof s !== 'string') return null;
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
    if (!m) return null;
    const whole = Date.parse(m[1] + (m[3] || 'Z'));
    if (!Number.isFinite(whole)) return null;
    return whole / 1000 + (m[2] ? Number('0.' + m[2]) : 0);
  }

  // Each message event carries the whole answer so far; only its ids and status are read.
  // The reply ends at `end_of_stream`, never at the stream closing: the page aborts its own
  // fetch right after that event, so the body never closes cleanly.
  function parseEvent({ event, data }) {
    if (event === 'end_of_stream') return { kind: 'done' };
    if (event !== 'message') return null;
    let j;
    try {
      j = JSON.parse(data);
    } catch {
      return null;
    }
    if (!obj(j)) return null;
    // frontend_uuid names the entry (one question and its answer) in the stream and in the
    // loaded thread alike, so it is this site's turn id.
    return { kind: 'message', role: 'assistant', status: str(j.status), turnExchangeId: str(j.frontend_uuid), model: str(j.display_model) };
  }

  // The send body. Ids only: the question (query_str) is in the same body and is never read.
  function sendIds(body) {
    let j;
    try {
      j = JSON.parse(typeof body === 'string' ? body : '');
    } catch {
      return { conversationId: null, messageId: null };
    }
    const p = obj(obj(j)?.params) || {};
    return { conversationId: str(p.frontend_context_uuid), messageId: str(p.frontend_uuid) };
  }

  // One turn per thread entry. entry_created is the send and entry_updated the end, both on
  // the server clock, so the span already includes the wait before the first byte.
  function parseConversation(json) {
    const entries = Array.isArray(json?.entries) ? json.entries : [];
    const turns = [];
    for (const e of entries) {
      if (!obj(e)) continue;
      const created = isoSec(e.entry_created_datetime);
      const id = str(e.frontend_uuid);
      turns.push({
        turnExchangeId: id, requestId: null, userMessageId: id, userCreateTime: created,
        startSec: created,
        // A turn still generating has no end yet, so it is not usable for recovery.
        endSec: e.status === 'COMPLETED' && created != null ? isoSec(e.entry_updated_datetime) : null,
        startIsSend: true,
        model: str(e.display_model),
        reasoningStart: null, reasoningEnd: null,
        // A stopped entry is also COMPLETED on the wire; no stop flag was seen.
        finishType: null,
      });
    }
    return turns;
  }

  ns.site = Object.assign(ns.site || {}, {
    verified: true,
    streamUrl: /^\/rest\/sse\/perplexity_ask$/,
    stopUrl: /^\/rest\/sse\/perplexity_terminate$/,
    // The slug is the /search/{slug} path segment; mark_viewed is a sibling POST.
    conversationUrl: /^\/rest\/thread\/(?!mark_viewed$)[\w.-]+$/,
    parseEvent,
    sendIds,
    parseConversation,
  });
})(globalThis);
