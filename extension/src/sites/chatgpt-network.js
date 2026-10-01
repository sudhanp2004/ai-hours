// ChatGPT network config (MAIN world). Endpoints verified in DevTools on 2026-09-30 (see spike/).
// parseEvent returns structural signals only, never message text. The page-side half of
// ns.chatgpt lives in chatgpt-page.js: a file can't be listed in both worlds (see manifest test).
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

  // The send request body. Returns two ids and nothing else: the prompt lives in the
  // same body and is discarded here, never returned (spec §6b).
  function sendIds(body) {
    let j;
    try {
      j = JSON.parse(typeof body === 'string' ? body : '');
    } catch {
      return { conversationId: null, messageId: null };
    }
    if (!j || typeof j !== 'object') return { conversationId: null, messageId: null };
    const messages = Array.isArray(j.messages) ? j.messages : [];
    let messageId = null;
    for (const m of messages) {
      if (m && typeof m === 'object' && m.author?.role === 'user') messageId = str(m.id) ?? messageId;
    }
    return { conversationId: str(j.conversation_id), messageId };
  }

  // One turn of a loaded conversation: the user's message and the assistant reply that
  // answers it. Ids, roles, finish type and timestamps only, never content.
  function turnFor(json) {
    const messages = Array.isArray(json?.messages) ? json.messages : [];
    const turns = [];
    let cur = null;
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const role = str(m.author?.role);
      const md = m.metadata && typeof m.metadata === 'object' ? m.metadata : {};
      const create = num(m.create_time);
      const update = num(m.update_time);
      const turnExchangeId = str(md.turn_exchange_id);
      if (role === 'user') {
        cur = {
          turnExchangeId, requestId: str(md.request_id), userMessageId: str(m.id),
          userCreateTime: create, startSec: null, endSec: null,
          reasoningStart: null, reasoningEnd: null, finishType: null,
        };
        turns.push(cur);
        continue;
      }
      if (role !== 'assistant') continue;
      if (!cur) {
        cur = {
          turnExchangeId: null, requestId: null, userMessageId: null, userCreateTime: null,
          startSec: null, endSec: null, reasoningStart: null, reasoningEnd: null, finishType: null,
        };
        turns.push(cur);
      }
      // A reasoning message can start a turn, so keep the earliest create_time.
      if (create != null && (cur.startSec === null || create < cur.startSec)) cur.startSec = create;
      if (update != null && (cur.endSec === null || update > cur.endSec)) cur.endSec = update;
      // The assistant message's turn id wins: the user message's may be absent or stale.
      if (turnExchangeId) cur.turnExchangeId = turnExchangeId;
      if (str(md.request_id)) cur.requestId = cur.requestId ?? str(md.request_id);
      if (num(md.reasoning_start_time) != null) cur.reasoningStart = num(md.reasoning_start_time);
      if (num(md.reasoning_end_time) != null) cur.reasoningEnd = num(md.reasoning_end_time);
      const ft = str(md.finish_details?.type);
      if (ft) cur.finishType = ft;
    }
    return turns;
  }

  ns.site = Object.assign(ns.site || {}, {
    // Endpoints verified in DevTools on 2026-09-30 (see spike/chatgpt-probe.js). ⚑7a–c in
    // the spec are still unconfirmed, so recovery here is unit-tested but unproven.
    verified: true,
    streamUrl: /\/backend-(api|anon)\/f\/conversation$/,
    stopUrl: /\/backend-(api|anon)\/stop_conversation$/,
    conversationUrl: /\/backend-(api|anon)\/conversations\/[0-9a-f-]{36}$/,
    parseEvent,
    sendIds,
    parseConversation: turnFor,
  });
})(globalThis);
