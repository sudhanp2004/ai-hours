// ChatGPT site config. Endpoints and selectors verified in DevTools on 2026-09-30 (see spike/).
// parseEvent returns structural signals only, never message text.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});

  const str = (x) => (typeof x === 'string' && x.length <= 64 ? x : null);
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

  function messageSignal(m) {
    const md = m.metadata && typeof m.metadata === 'object' ? m.metadata : {};
    return {
      kind: 'message',
      role: str(m.author?.role),
      contentType: str(m.content?.content_type),
      status: str(m.status),
      messageId: str(m.id),
      createTime: num(m.create_time),
      turnExchangeId: str(md.turn_exchange_id),
      requestId: str(md.request_id),
      reasoningStart: num(md.reasoning_start_time),
      reasoningEnd: num(md.reasoning_end_time),
    };
  }

  // Status changes arrive as {p:'/message/status', v} or batched inside {o:'patch', v:[ops]}.
  function setsFinishedStatus(j) {
    const ops = j.p === '/message/status' ? [j] : j.o === 'patch' && Array.isArray(j.v) ? j.v : [];
    return ops.some((op) => op?.p === '/message/status' && typeof op.v === 'string' && op.v.startsWith('finished'));
  }

  function parseEvent({ data }) {
    if (data === '[DONE]') return { kind: 'done' };
    let j;
    try {
      j = JSON.parse(data);
    } catch {
      return null;
    }
    if (!j || typeof j !== 'object') return null;
    const m = j.v?.message ?? j.message;
    if (m && typeof m === 'object') return messageSignal(m);
    if (setsFinishedStatus(j)) return { kind: 'finished' };
    return null;
  }

  ns.chatgpt = {
    site: 'chatgpt',
    streamUrl: /\/backend-(api|anon)\/f\/conversation$/,
    stopUrl: /\/backend-(api|anon)\/stop_conversation$/,
    stopButton: 'button[data-testid="stop-button"]',
    parseEvent,
  };
})(globalThis);
