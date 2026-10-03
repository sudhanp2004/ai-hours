// Runs in the page's MAIN world at document_start. Wraps fetch and XMLHttpRequest to time
// chat replies and posts structural signals to content.js. Never posts message text.
// Three shapes of reply, chosen by what the adapter declares (spec §11):
//   streamUrl   — one request whose response is the reply (fetch+SSE: ChatGPT, Perplexity;
//                 XHR: Gemini, timed by the request's own start and end),
//   requestKind + timelineUrl — a send request, with progress on a separate long-lived
//                 stream that reports running/idle (claude.ai).
(function () {
  // The flag lives on window, not on fetch: something else may wrap fetch after us, and a
  // re-injection after an extension update must still see that we're already installed.
  const FLAG = Symbol.for('aiHours.fetchWrapped');
  if (window[FLAG]) return;
  Object.defineProperty(window, FLAG, { value: true });

  const ns = () => globalThis.__aiHours; // read at call time so re-injected adapters take effect
  const origFetch = window.fetch;
  const post = (type, payload) => window.postMessage({ __aih: 1, type, ...payload }, location.origin);
  // How often a streaming reply says "still here". Other tabs count it live from this, and
  // each one becomes a storage write there, so it is throttled well above the chunk rate.
  const aliveEvery = () => ns().site?.aliveEveryMs ?? 2000;

  // Same-origin path only. An adapter whose requests are named in the query (Gemini's rpc
  // ids) asks for the query too.
  function pathOf(input) {
    try {
      const u = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (u.origin !== location.origin) return '';
      return ns().site?.matchQuery ? u.pathname + u.search : u.pathname;
    } catch {
      return '';
    }
  }

  async function wrappedFetch(input, init) {
    const site = ns().site;
    if (!site) return origFetch.apply(window, arguments);
    const path = pathOf(input);
    const kind = site.requestKind?.(path, init?.body) ?? null;
    if (kind === 'stop' || site.stopUrl?.test(path)) post('stop', { t: Date.now() });
    if (kind === 'send') return trackSend(arguments);
    if (site.timelineUrl?.test(path)) return readTimeline(arguments);
    if (site.conversationUrl && site.conversationUrl.test(path)) return readConversation(path, arguments);
    if (!site.streamUrl?.test(path)) return origFetch.apply(window, arguments);

    const localId = crypto.randomUUID();
    // The ids of the message and conversation we're about to create. Reading them now is
    // what lets a tab closed a second later still be matched to its finished reply.
    post('start', { localId, t: Date.now(), sent: ns().site.sendIds?.(init?.body) });
    let res;
    try {
      res = await origFetch.apply(window, arguments);
    } catch (e) {
      post('end', { localId, t: Date.now(), lastChunk: null, outcome: 'error' });
      throw e;
    }
    const type = res.headers.get('content-type') || '';
    if (res.ok && type.includes('text/event-stream') && res.body) readStream(localId, res.clone());
    else post('end', { localId, t: Date.now(), lastChunk: null, outcome: 'error' });
    return res;
  }
  window.fetch = wrappedFetch;

  // ---- claude.ai: a send request, then running/idle from a long-lived timeline stream.
  // One reply runs at a time per page; the timeline may be any of several streams over the
  // reply's life, because the server closes and the page reopens it every few minutes.
  let reply = null; // {localId, running, lastAlive}

  async function trackSend(args) {
    const localId = crypto.randomUUID();
    const t = Date.now();
    // A previous reply never seen to go idle (its timeline opened before we were injected)
    // is closed off at its last sign of life: an error, never a guessed duration.
    if (reply) post('end', { localId: reply.localId, t, lastChunk: reply.running ? reply.lastAlive : reply.start, outcome: 'error' });
    reply = { localId, start: t, running: false, lastAlive: 0 };
    post('start', { localId, t, sent: null });
    let res;
    try {
      res = await origFetch.apply(window, args);
    } catch (e) {
      failReply(localId);
      throw e;
    }
    if (!res.ok) failReply(localId);
    return res;
  }

  function failReply(localId) {
    if (reply?.localId !== localId) return;
    reply = null;
    post('end', { localId, t: Date.now(), lastChunk: null, outcome: 'error' });
  }

  function onStatus(status, model) {
    const r = reply;
    if (!r) return;
    const t = Date.now();
    if (status === 'running') {
      if (!r.running) (r.running = true), (r.lastAlive = t), post('firstByte', { localId: r.localId, t });
      else if (t - r.lastAlive >= aliveEvery()) (r.lastAlive = t), post('alive', { localId: r.localId, t });
      // The model, once per reply, as the same server fact the other sites send.
      if (model && model !== r.model) (r.model = model), post('message', { localId: r.localId, sig: { kind: 'message', role: 'assistant', model } });
    } else if (r.running) {
      // Idle before running is the server echoing the state the send found; only idle
      // after running ends the reply.
      reply = null;
      post('end', { localId: r.localId, t, lastChunk: t, outcome: 'completed' });
    }
  }

  async function readTimeline(args) {
    const res = await origFetch.apply(window, args);
    try {
      if (!res.ok || !res.body) return res;
      const decoder = ns().site.createTimelineDecoder(onStatus);
      const reader = res.clone().body.getReader();
      (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          decoder.push(value);
        }
      })().catch(() => {}); // a rotated or aborted stream just stops reporting
    } catch {
      // Never disturb the page's own request.
    }
    return res;
  }

  // ---- XMLHttpRequest (Gemini): the reply is one XHR, so its own start and end time it.
  const XHR = window.XMLHttpRequest?.prototype;
  if (XHR) {
    const URL_KEY = Symbol('aiHours.xhrUrl');
    const origOpen = XHR.open;
    const origSend = XHR.send;
    XHR.open = function (method, url) {
      this[URL_KEY] = url;
      return origOpen.apply(this, arguments);
    };
    XHR.send = function () {
      try {
        watchXhr(this, pathOf(this[URL_KEY]));
      } catch {
        // Never disturb the page's own request.
      }
      return origSend.apply(this, arguments);
    };
  }

  function watchXhr(xhr, path) {
    const site = ns().site;
    if (!site || !path) return;
    if (site.stopUrl?.test(path)) post('stop', { t: Date.now() });
    if (!site.streamUrl?.test(path)) return;
    const localId = crypto.randomUUID();
    post('start', { localId, t: Date.now(), sent: null });
    let lastChunk = null;
    let lastAlive = 0;
    let model = null;
    // Looked for while the reply streams, not at the end: Stop finishes the record at the
    // press, and a model learned after that would have nothing to attach to.
    const findModel = () => {
      if (model || !site.modelFromResponse) return;
      try {
        model = site.modelFromResponse(xhr.responseText);
      } catch {
        return;
      }
      if (model) post('message', { localId, sig: { kind: 'message', role: 'assistant', model } });
    };
    xhr.addEventListener('progress', () => {
      const t = Date.now();
      if (lastChunk === null) post('firstByte', { localId, t }), (lastAlive = t);
      else if (t - lastAlive >= aliveEvery()) post('alive', { localId, t }), (lastAlive = t);
      lastChunk = t;
      findModel();
    });
    // loadend fires once, after load, error, abort or timeout. Status 0 is an abort or a
    // network failure; a finished reply is a 2xx.
    xhr.addEventListener('loadend', () => {
      findModel();
      const ok = xhr.status >= 200 && xhr.status < 300;
      post('end', { localId, t: Date.now(), lastChunk, outcome: ok ? 'completed' : 'error' });
    });
  }

  async function readStream(localId, res) {
    const { site, createSseParser } = ns();
    let lastChunk = null;
    let doneAt = null;
    const parser = createSseParser((ev) => {
      const sig = site.parseEvent(ev);
      if (!sig) return;
      if (sig.kind === 'done') doneAt = lastChunk;
      else if (sig.kind === 'finished') post('finished', { localId, t: lastChunk });
      else if (sig.kind === 'message') post('message', { localId, sig });
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let lastAlive = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const t = Date.now();
        if (lastChunk === null) post('firstByte', { localId, t }), (lastAlive = t);
        // The sign of life other tabs count this reply by. Throttled: chunks can be
        // hundreds per second, and every post is a storage write on the other side.
        if (t - lastAlive >= aliveEvery()) post('alive', { localId, t }), (lastAlive = t);
        lastChunk = t;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
      parser.end();
      post('end', { localId, t: doneAt ?? Date.now(), lastChunk, outcome: doneAt !== null ? 'completed' : 'closed' });
    } catch {
      // Perplexity aborts its own fetch right after its end event, which errors this copy
      // too. A reply that already said it was done is complete.
      if (doneAt !== null) post('end', { localId, t: doneAt, lastChunk, outcome: 'completed' });
      else post('end', { localId, t: Date.now(), lastChunk, outcome: 'error' });
    }
  }

  // Opening a chat fetches the whole conversation. We read a copy for its ids and
  // timestamps only, to finish a record whose tab was closed mid-reply (spec §6b).
  async function readConversation(path, args) {
    const res = await origFetch.apply(window, args);
    try {
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.includes('application/json') || !res.body) return res;
      res.clone()
        .json()
        .then((json) => {
          const turns = ns().site.parseConversation(json);
          if (turns.length) post('conversation', { conversationId: path.split('/').pop(), turns });
        })
        .catch(() => {}); // a shape we don't understand is simply no recovery
    } catch {
      // Never disturb the page's own request.
    }
    return res;
  }
})();
