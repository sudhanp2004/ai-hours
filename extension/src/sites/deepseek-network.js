// DeepSeek network config (MAIN world). Verified in DevTools on 2026-10-04 (spec §11, Probe
// results). The reply is one XMLHttpRequest whose body is SSE; it ends right after
// response/status becomes FINISHED (or INCOMPLETE when stopped), so the request's own start
// and end time it, the same shape as Gemini. Stop is its own request.
// The page-side half lives in deepseek-page.js: a file can't be listed in both worlds.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});

  // The request names the model as model_type ("default") plus a DeepThink switch. Only those
  // two fields are read; the prompt is in the same body and is never touched.
  function modelFromRequest(body) {
    let j;
    try {
      j = JSON.parse(typeof body === 'string' ? body : '');
    } catch {
      return null;
    }
    const type = j?.model_type;
    if (typeof type !== 'string' || !/^[\w.-]{1,32}$/.test(type)) return null;
    return `deepseek-${type}${j.thinking_enabled === true ? '-deepthink' : ''}`;
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
  });
})(globalThis);
