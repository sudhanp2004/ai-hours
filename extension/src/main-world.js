// Runs in the page's MAIN world at document_start. Wraps fetch to time chat streams and
// posts structural signals to content.js. Never posts message text.
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

  function pathOf(input) {
    try {
      const u = new URL(input instanceof Request ? input.url : String(input), location.href);
      return u.origin === location.origin ? u.pathname : '';
    } catch {
      return '';
    }
  }

  async function wrappedFetch(input, init) {
    const site = ns().site;
    if (!site) return origFetch.apply(window, arguments);
    const path = pathOf(input);
    if (site.stopUrl?.test(path)) post('stop', { t: Date.now() });
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
      post('end', { localId, t: Date.now(), lastChunk, outcome: 'error' });
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
