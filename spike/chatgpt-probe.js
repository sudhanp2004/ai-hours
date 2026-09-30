// THROWAWAY SPIKE: AI Hours, ChatGPT probe. Not extension code; delete after the spike.
//
// Paste into the DevTools console on chatgpt.com. It wraps fetch, times chat streams,
// and watches the stop button. It records timestamps, event names and structural
// fields (type / op / patch path / role / content_type / status) only, never message text.
//
//   copy(__aiProbe.report())   -> copies the full log to your clipboard to paste back
//   __aiProbe.stop()           -> removes the probe (or just reload the page)
(() => {
  if (window.__aiProbe) { console.warn('[probe] already running; call __aiProbe.stop() first'); return; }

  const T0 = performance.now();
  const t = () => Math.round(performance.now() - T0); // ms since probe was pasted
  const journal = [];
  const log = (msg) => {
    journal.push(`t=${t()}ms ${msg}`);
    console.log('%c[probe]', 'color:#c60;font-weight:bold', `t=${t()}ms`, msg);
  };
  const dump = (label, obj) => {
    journal.push(`${label} ${JSON.stringify(obj)}`);
    console.log('%c[probe]', 'color:#c60;font-weight:bold', label);
    console.table(obj);
  };

  // ---- fetch wrapper ----------------------------------------------------------
  const origFetch = window.fetch;
  let reqSeq = 0;
  const streams = [];

  const pathOf = (input) => {
    try {
      const u = new URL(input instanceof Request ? input.url : String(input), location.href);
      return u.origin === location.origin ? u.pathname : u.host + u.pathname;
    } catch { return '?'; }
  };
  const methodOf = (input, init) =>
    (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const collapseIds = (p) => p.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '{id}');

  window.fetch = async function (input, init) {
    const method = methodOf(input, init);
    const path = pathOf(input);
    const id = ++reqSeq;
    const tStart = t();
    const loud = method !== 'GET' || path.includes('conversation');
    if (loud) log(`#${id} ${method} ${collapseIds(path)}`);

    let res;
    try {
      res = await origFetch.apply(window, arguments);
    } catch (e) {
      if (loud) log(`#${id} fetch rejected before headers: ${e.name} (+${t() - tStart}ms)`);
      throw e;
    }

    try {
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/event-stream') && res.body) {
        readStream(id, collapseIds(path), res.clone(), tStart);
      } else if (method === 'GET' && /\/conversation\/[0-9a-f-]{36}$/i.test(path)) {
        inspectConversation(id, res.clone());
      }
    } catch (e) { log(`probe error: ${e}`); }
    return res;
  };

  // ---- stream timing ----------------------------------------------------------
  async function readStream(id, path, res, tStart) {
    const s = {
      id, path, status: res.status, tStart, tHeaders: t(), tFirstChunk: null, tDone: null,
      tClose: null, lastChunk: null, chunks: 0, events: 0, bytes: 0, maxGap: 0, maxGapAt: null,
      seen: {}, outcome: 'open',
    };
    streams.push(s);
    log(`#${id} STREAM OPEN ${path} status=${res.status}, headers +${s.tHeaders - tStart}ms after send`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        const now = t();
        if (done) break;
        s.chunks++;
        s.bytes += value.byteLength;
        if (s.tFirstChunk === null) {
          s.tFirstChunk = now;
          log(`#${id} first chunk +${now - tStart}ms`);
        }
        if (s.lastChunk !== null) {
          const gap = now - s.lastChunk;
          if (gap > s.maxGap) { s.maxGap = gap; s.maxGapAt = s.lastChunk - tStart; }
          if (gap > 2000) log(`#${id} SILENCE ${gap}ms with no bytes (from +${s.lastChunk - tStart}ms)`);
        }
        s.lastChunk = now;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          handleEvent(s, buf.slice(0, i), now);
          buf = buf.slice(i + 2);
        }
      }
      s.outcome = s.tDone !== null ? 'completed' : 'closed-without-DONE';
    } catch (e) {
      s.outcome = `error:${e.name}`;
    }
    s.tClose = t();
    summarize(s);
  }

  function handleEvent(s, raw, now) {
    let name = 'message';
    let data = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    s.events++;
    see(s, `event:${name}`, now);
    if (data === '[DONE]') {
      s.tDone = now;
      log(`#${s.id} [DONE] +${now - s.tStart}ms`);
      return;
    }
    let j;
    try { j = JSON.parse(data); } catch { see(s, 'data:(non-JSON)', now); return; }
    if (!j || typeof j !== 'object') return;

    // Structural fields only. Never read `v` values or message content.
    if (typeof j.type === 'string') see(s, `type:${j.type}`, now);
    if (typeof j.o === 'string') see(s, `op:${j.o}`, now);
    if (typeof j.p === 'string') see(s, `path:${j.p.replace(/\d+/g, 'N')}`, now);
    if (Array.isArray(j.v)) {
      for (const op of j.v) if (typeof op?.p === 'string') see(s, `path:${op.p.replace(/\d+/g, 'N')}`, now);
    }
    const m = j.v?.message || j.message;
    if (m && typeof m === 'object') {
      see(s, `msg:${m.author?.role}/${m.content?.content_type}/${m.status}`, now);
    }
  }

  // First time a structural key shows up in a stream -> log it, so phase changes
  // (e.g. thinking -> text) are visible on the timeline.
  function see(s, key, now) {
    const e = s.seen[key];
    if (e) { e.count++; e.last = now - s.tStart; return; }
    s.seen[key] = { first: now - s.tStart, last: now - s.tStart, count: 1 };
    log(`#${s.id}   first ${key} +${now - s.tStart}ms`);
  }

  function summarize(s) {
    const rel = (x) => (x === null ? null : x - s.tStart);
    log(`#${s.id} STREAM CLOSED: ${s.outcome}`);
    dump(`#${s.id} summary (ms after send)`, [{
      path: s.path, outcome: s.outcome, headers: rel(s.tHeaders), firstChunk: rel(s.tFirstChunk),
      DONE: rel(s.tDone), streamClose: rel(s.tClose), chunks: s.chunks, events: s.events,
      kb: +(s.bytes / 1024).toFixed(1), maxSilenceMs: s.maxGap, maxSilenceAt: s.maxGapAt,
    }]);
    dump(`#${s.id} timeline of structural keys`,
      Object.entries(s.seen)
        .sort((a, b) => a[1].first - b[1].first)
        .map(([key, v]) => ({ key, ...v })));
  }

  // ---- conversation load: are there timestamps we could use for background work? --
  async function inspectConversation(id, res) {
    let j;
    try { j = await res.json(); } catch { return; }
    const rows = [];
    for (const node of Object.values(j.mapping || {})) {
      const m = node?.message;
      if (!m) continue;
      const extra = {};
      for (const [k, v] of Object.entries(m.metadata || {})) {
        const timeish = /time|duration|async|finished/i.test(k);
        if (timeish && (typeof v === 'number' || typeof v === 'boolean')) extra[k] = v;
        else if (/status$/i.test(k) && typeof v === 'string' && v.length < 40) extra[k] = v;
      }
      rows.push({
        role: m.author?.role, type: m.content?.content_type, status: m.status,
        create_time: m.create_time, update_time: m.update_time, ...extra,
      });
    }
    rows.sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
    log(`#${id} CONVERSATION LOADED: ${rows.length} messages; conv create=${j.create_time} update=${j.update_time} async_status=${j.async_status}`);
    dump(`#${id} per-message time fields`, rows);
  }

  // ---- DOM: stop button + tab visibility --------------------------------------
  const STOP_SEL = 'button[data-testid="stop-button"], button[aria-label*="Stop" i]';
  let stopVisible = false;
  const obs = new MutationObserver(() => {
    const el = document.querySelector(STOP_SEL);
    if (!!el !== stopVisible) {
      stopVisible = !!el;
      log(stopVisible
        ? `DOM stop button APPEARED (testid=${el.dataset.testid}, aria-label="${el.getAttribute('aria-label')}")`
        : 'DOM stop button GONE');
    }
  });
  obs.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['data-testid', 'aria-label'],
  });
  const onVis = () => log(`tab visibility: ${document.visibilityState}`);
  document.addEventListener('visibilitychange', onVis);

  window.__aiProbe = {
    streams,
    report: () => journal.join('\n'),
    stop() {
      window.fetch = origFetch;
      obs.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      delete window.__aiProbe;
      console.log('[probe] removed');
    },
  };
  log(`probe installed on ${location.pathname}`);
})();
