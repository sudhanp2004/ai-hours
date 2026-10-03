// claude.ai network config (MAIN world). Verified in DevTools on 2026-10-03 (spec §11, Probe
// results). claude.ai speaks Connect-RPC with binary protobuf, not SSE: a send and a stop are
// both a PerformAction, and the reply's progress arrives on a separate, long-lived
// StreamTimeline. Only field numbers and one status value are read, never text.
// The page-side half lives in claude-page.js: a file can't be listed in both worlds.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});

  // ---- a schema-free protobuf reader: just enough to walk to a field by number
  function varint(b, i) {
    let x = 0;
    let shift = 0;
    for (;;) {
      if (i >= b.length || shift > 63) throw new Error('truncated');
      const c = b[i++];
      x += (c & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(c & 0x80)) return [x, i];
    }
  }

  // Top-level fields of one message as [field, wireType, value]: a number for varints, a
  // byte slice for length-delimited fields. Throws on anything that isn't protobuf.
  function fields(b) {
    const out = [];
    let i = 0;
    while (i < b.length) {
      let key;
      [key, i] = varint(b, i);
      const f = Math.floor(key / 8);
      const w = key % 8;
      if (f < 1) throw new Error('bad field');
      if (w === 0) {
        let v;
        [v, i] = varint(b, i);
        out.push([f, w, v]);
      } else if (w === 2) {
        let len;
        [len, i] = varint(b, i);
        if (i + len > b.length) throw new Error('truncated');
        out.push([f, w, b.subarray(i, i + len)]);
        i += len;
      } else if (w === 1) i += 8;
      else if (w === 5) i += 4;
      else throw new Error('bad wire type');
    }
    if (i > b.length) throw new Error('truncated');
    return out;
  }

  const sub = (b, f) => b && fields(b).find(([n, w]) => n === f && w === 2)?.[2];
  const num = (b, f) => b && fields(b).find(([n, w]) => n === f && w === 0)?.[2];

  function bytesOf(body) {
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    return null;
  }

  // PerformAction's body is a header (field 1) plus exactly one action. Field 2 is a send,
  // field 3 a stop; others (15 = chat settings, on create/open) are neither.
  function requestKind(path, body) {
    if (!/^\/claudeai-rpc\/[\w.]*\.ConversationService\/PerformAction$/.test(path)) return null;
    const b = bytesOf(body);
    if (!b) return null;
    try {
      const top = fields(b).map(([f]) => f);
      if (top.includes(2)) return 'send';
      if (top.includes(3)) return 'stop';
    } catch {
      // Not protobuf after all: say nothing rather than guess.
    }
    return null;
  }

  // event (1) → conversation state (1) → conversation (2) → status (3): 2 while a reply runs,
  // 1 when idle. Text deltas, acks and heartbeats are other event fields, so they read null.
  // The same conversation's field 6.2 names its model (e.g. claude-opus-5-5).
  function statusOf(msg) {
    try {
      const conv = sub(sub(sub(msg, 1), 1), 2);
      const status = num(conv, 3) ?? null;
      const m = sub(sub(conv, 6), 2);
      const model = m && m.length <= 64 ? new TextDecoder().decode(m) : null;
      return { status, model: model && /^[\w.-]+$/.test(model) ? model : null };
    } catch {
      return { status: null, model: null };
    }
  }

  async function gunzip(bytes) {
    const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(ds).arrayBuffer());
  }

  // Splits Connect envelopes (1 flag byte + 4-byte big-endian length) and reports
  // 'running' / 'idle' per status message, in arrival order. Flag 1 = gzip, flag 2 = the
  // end-of-stream trailer. The stream's own end means nothing: the server rotates it.
  // onActivity fires for every data frame: status messages come only at a reply's start and
  // end, so the deltas and heartbeats between them are what show it is still alive.
  function createTimelineDecoder(onStatus, onActivity) {
    let buf = new Uint8Array(0);
    let chain = Promise.resolve();
    function handle(flag, payload) {
      chain = chain
        .then(async () => {
          if (flag & 2) return;
          const msg = flag & 1 ? await gunzip(payload) : payload;
          const { status, model } = statusOf(msg);
          if (status === 2) onStatus('running', model);
          else if (status !== null) onStatus('idle', model);
        })
        .catch(() => {}); // one bad frame is skipped, never fatal
    }
    return {
      push(chunk) {
        const next = new Uint8Array(buf.length + chunk.length);
        next.set(buf);
        next.set(chunk, buf.length);
        buf = next;
        while (buf.length >= 5) {
          const len = ((buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4]) >>> 0;
          if (buf.length < 5 + len) break;
          if (!(buf[0] & 2)) onActivity?.();
          handle(buf[0], buf.slice(5, 5 + len));
          buf = buf.slice(5 + len);
        }
      },
      idle: () => chain, // for tests: resolves once every pushed frame is handled
    };
  }

  ns.site = Object.assign(ns.site || {}, {
    verified: true,
    streamUrl: null, // no single response carries the reply here; see timelineUrl
    stopUrl: null, // a stop shares the send's URL; requestKind tells them apart
    timelineUrl: /^\/claudeai-rpc\/[\w.]*\.ConversationService\/StreamTimeline$/,
    requestKind,
    createTimelineDecoder,
    // No passive conversation load: opening a chat fetches a protobuf snapshot with no end
    // times. A reply whose tab closed stays unknown rather than guessed (spec §11).
    conversationUrl: null,
    parseEvent: null,
    sendIds: null,
    parseConversation: null,
  });
})(globalThis);
