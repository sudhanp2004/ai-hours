// DeepSeek network config (MAIN world). Verified in DevTools on 2026-10-04 (spec §11, Probe
// results). The reply is one XMLHttpRequest whose body is SSE; it ends right after
// response/status becomes FINISHED (or INCOMPLETE when stopped), so the request's own start
// and end time it, the same shape as Gemini. Stop is its own request.
// The page-side half lives in deepseek-page.js: a file can't be listed in both worlds.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});

  const nameOf = (type, thinking) =>
    typeof type === 'string' && /^[\w.-]{1,32}$/.test(type) ? `deepseek-${type}${thinking === true ? '-deepthink' : ''}` : null;

  // The request names the model as model_type ("default") plus a DeepThink switch. Only those
  // two fields are read; the prompt is in the same body and is never touched.
  function modelFromRequest(body) {
    let j;
    try {
      j = JSON.parse(typeof body === 'string' ? body : '');
    } catch {
      return null;
    }
    return nameOf(j?.model_type, j?.thinking_enabled);
  }

  // A follow-up in a chat sends model_type: null, since the chat keeps its model (seen live,
  // 2026-10-06). Every reply opens with an event naming it, then the response object, which
  // says whether DeepThink is on. Only the first few events are read, and only those two fields.
  const SCAN_EVENTS = 6;
  function modelFromResponse(text, state = {}) {
    if (typeof text !== 'string' || state.done) return null;
    let at = state.offset ?? 0;
    for (;;) {
      const nl = text.indexOf('\n', at);
      if (nl < 0) break; // the last line may still be arriving
      const line = text.slice(at, nl);
      at = nl + 1;
      if (!line.startsWith('data:')) continue;
      state.events = (state.events ?? 0) + 1;
      let j;
      try {
        j = JSON.parse(line.slice(5));
      } catch {
        j = null;
      }
      if (typeof j?.model_type === 'string') state.type = j.model_type;
      const thinking = j?.v?.response?.thinking_enabled;
      if (state.type !== undefined && (typeof thinking === 'boolean' || state.events >= SCAN_EVENTS)) {
        state.done = true;
        return nameOf(state.type, thinking);
      }
      if (state.events >= SCAN_EVENTS) return (state.done = true), null;
    }
    state.offset = at;
    return null;
  }

  ns.site = Object.assign(ns.site || {}, {
    verified: true,
    streamUrl: /^\/api\/v0\/chat\/completion$/,
    stopUrl: /^\/api\/v0\/chat\/stop_stream$/,
    // history_messages came back with no messages (cache_control: MERGE): the app keeps its
    // own copy and asks only for changes. Nothing to recover from, so a reply whose tab
    // closed keeps the time that was watched (spec §11).
    conversationUrl: null,
    parseEvent: null,
    sendIds: null,
    parseConversation: null,
    modelFromRequest,
    modelFromResponse,
  });
})(globalThis);
