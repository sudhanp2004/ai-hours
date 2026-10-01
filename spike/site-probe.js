// Site probe — run once per site, in that site's own DevTools console, BEFORE writing its
// adapter. Prints the six facts the adapter needs (spec §11) and nothing else.
//
// How to use:
//   1. Open the site. Open DevTools → Console. Paste this whole file, press Enter.
//   2. Reload the tab (the probe installs on load, so it must be there before you send).
//   3. Start a NEW chat and send a long prompt. Let it finish.
//   4. Press Stop on a second prompt, if the site has a stop button.
//   5. Type  REPORT  and press Enter. Copy the output back.
//   6. Open an OLD chat so it loads from the network, then type REPORT again.
//
// It prints key NAMES, timestamps and lengths. Message text is never printed and never
// leaves the page. Run it on a throwaway chat if you would rather not probe a real one.
//
// What it cannot tell you, and you must read off the Network panel by eye:
//   · whether the stop button's selector is stable (the probe prints candidates only)
//   · what a reply looks like in the stream beyond the first 3 frames
//   · whether previews, typing indicators or voice use the same endpoints

(() => {
  const KEY = '__aih_probe_v1';
  if (window[KEY]) {
    console.log('[probe] already installed. Reload the tab, then send a prompt.');
    return;
  }
  window[KEY] = { requests: [], frames: [], stops: 0 };

  const P = window[KEY];

  // ---------------------------------------------------------------- key names only
  // The privacy rule: record the shape of a payload, never its content. A key name is
  // structure; a value under it might be the user's prompt.
  const shape = (v, depth = 0) => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
    if (typeof v === 'object') {
      if (depth >= 3) return '{…}';
      const o = {};
      for (const k of Object.keys(v)) o[k] = shape(v[k], depth + 1);
      return o;
    }
    if (typeof v === 'string') return `string(${/^\d{4}-\d{2}-\d{2}T/.test(v) ? 'datetime' : v.length})`;
    return typeof v;
  };

  // Anything that smells like a timestamp, so the probe can point at the field names that
  // recovery would need (⚑: which of these is the user message, which is the reply).
  const TIME_KEYS = /(time|date|created|updated|start|end|at)$/i;

  const findTimes = (v, out = [], path = '', depth = 0) => {
    if (depth > 4 || v === null || typeof v !== 'object') return out;
    if (Array.isArray(v)) {
      v.slice(0, 3).forEach((x, i) => findTimes(x, out, `${path}[${i}]`, depth + 1));
      return out;
    }
    for (const [k, x] of Object.entries(v)) {
      if (TIME_KEYS.test(k) && (typeof x === 'number' || typeof x === 'string')) {
        out.push(`${path}.${k} = ${typeof x === 'number' ? x : x.slice(0, 24)}`);
      } else findTimes(x, out, `${path}.${k}`, depth + 1);
    }
    return out;
  };

  const redact = (s) =>
    String(s ?? '')
      .replace(/"(?:text|content|parts|prompt|query|message|value|body)"\s*:\s*"(?:[^"\\]|\\.)*"/gi, '"$1":"…"')
      .slice(0, 300);

  // ---------------------------------------------------------------- fetch + XHR
  const record = (method, url, status, ctype, note) => {
    P.requests.push({ method, path: url.replace(location.origin, '').slice(0, 120), status, ctype, note, at: Date.now() - P.t0 });
  };

  const of = window.fetch;
  window.fetch = async function (input, init) {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
    if (!url.startsWith(location.origin)) return of.apply(this, arguments);
    const body = init?.body;
    const t = {
      method, path: url.replace(location.origin, '').slice(0, 120), t: Date.now(),
      reqShape: typeof body === 'string' ? tryShape(body) : body ? `[${body.constructor?.name}]` : null,
      ctype: null, status: null, frames: 0, isStream: false, done: false,
    };
    P.requests.push(t);
    let res;
    try {
      res = await of.apply(this, arguments);
    } catch (e) {
      t.status = 'network-error';
      throw e;
    }
    t.status = res.status;
    t.ctype = res.headers.get('content-type');
    t.isStream = !!t.ctype?.includes('text/event-stream');
    // Only clone responses we're allowed to read twice, and only to look at framing.
    if (res.ok && (t.isStream || t.ctype?.includes('application/json'))) {
      try {
        const copy = res.clone();
        if (t.isStream) void readFrames(t, copy);
        else
          copy.json().then((j) => {
            t.jsonShape = shape(j);
            t.jsonTimes = findTimes(j).slice(0, 12);
          }).catch(() => {});
      } catch {}
    }
    return res;
  };

  function tryShape(text) {
    try {
      return { shape: shape(JSON.parse(text)), times: findTimes(JSON.parse(text)).slice(0, 8) };
    } catch {
      return `[non-JSON ${text.length} chars]`;
    }
  }

  // Read a few frames to learn the framing and the terminal marker. This is the one fact
  // that decides whether the existing SSE parser can be reused at all (spec ⚑8).
  async function readFrames(t, res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (let i = 0; i < 400; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split(/\n\n|\r\n\r\n/);
        buf = parts.pop();
        for (const p of parts) {
          if (!p.trim()) continue;
          t.frames++;
          if (t.frames <= 3) {
            const dataLine = p.split(/\r?\n/).find((l) => l.startsWith('data:')) ?? p;
            P.frames.push({ path: t.path, raw: redact(dataLine).slice(0, 220) });
          }
          // The terminal marker: [DONE], or a JSON field that means finished.
          if (/\[DONE\]/.test(p)) t.done = '[DONE]';
          else if (/"(?:finish_reason|type)"\s*:\s*"(?:stop|end_turn|content_stop|finished)"/i.test(p)) t.done ??= 'json finish field';
          if (t.frames > 3 && t.done) break;
        }
        if (t.frames > 3 && t.done) break;
      }
    } catch {}
  }

  const ox = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.addEventListener('load', () => record(method, url, this.status, this.getResponseHeader('content-type'), 'xhr'));
    return ox.call(this, method, url, ...rest);
  };

  // ---------------------------------------------------------------- stop button
  // Candidates only. A selector has to be checked by eye against the real button.
  const BUTTON_WORDS = ['stop', 'cancel', 'halt', 'abort'];
  setInterval(() => {
    const hits = [];
    for (const b of document.querySelectorAll('button,[role="button"]')) {
      const words = [
        b.getAttribute('aria-label'), b.getAttribute('data-testid'), b.getAttribute('title'),
        b.className?.toString?.(), b.innerText,
      ].filter(Boolean).join(' ').toLowerCase();
      if (BUTTON_WORDS.some((w) => words.includes(w)) && b.offsetParent !== null) {
        hits.push({
          tag: b.tagName.toLowerCase(),
          testid: b.getAttribute('data-testid'),
          aria: b.getAttribute('aria-label'),
          selector: b.getAttribute('data-testid')
            ? `button[data-testid="${b.getAttribute('data-testid')}"]`
            : b.id ? `#${b.id}` : `${b.tagName.toLowerCase()}[aria-label="${b.getAttribute('aria-label')}"]`,
        });
      }
    }
    if (hits.length) P.stops = hits;
  }, 400);

  // ---------------------------------------------------------------- report
  P.t0 = Date.now();
  window.addEventListener('beforeunload', () => (P.t0 = Date.now() - (performance.timeOrigin ? 0 : 0)));

  const onCommand = (e) => {
    if (e.key !== 'Enter' || e.target?.isContentEditable) return;
    if ((e.target.value || '').trim().toUpperCase() !== 'REPORT') return;
    e.target.value = '';
    console.log(buildReport());
  };
  document.addEventListener('keydown', onCommand, true);

  function buildReport() {
    const L = [];
    const line = (s = '') => L.push(s);
    line(`AI HOURS SITE PROBE — ${location.hostname}`);
    line(`(key names and timestamps only; no message text)`);
    line();

    const streams = P.requests.filter((r) => r.isStream || r.frames > 0);
    line(`1-2. SEND + STREAM REQUESTS  (${P.requests.length} same-origin requests seen)`);
    if (!P.requests.length) line('   none yet — send a prompt first');
    for (const r of P.requests.slice(0, 30)) {
      line(`   ${r.method} ${r.path}`);
      line(`      status=${r.status} ctype=${r.ctype} stream=${!!r.isStream} frames=${r.frames || 0} end=${r.done ?? '—'}`);
      if (r.reqShape) line(`      request body: ${JSON.stringify(r.reqShape)}`);
      if (r.jsonShape) line(`      json shape: ${JSON.stringify(r.jsonShape).slice(0, 400)}`);
    }
    line();

    line('3. FIRST STREAM FRAMES  (framing + terminal marker)');
    if (!P.frames.length) line('   none yet — send a prompt first');
    for (const f of P.frames.slice(0, 6)) line(`   ${f.path}\n      ${f.raw}`);
    line(`   >>> is it SSE "data:" lines, or something else? (spec ⚑8)`);
    line();

    line('4. STOP');
    line(`   stop-endpoint observed: ${P.requests.some((r) => /stop|cancel|abort/i.test(r.path)) ? 'yes — see requests above' : 'none seen yet (press Stop, then REPORT)'}`);
    line(`   does the stream survive the stop? compare frames/end of the stream request before and after.`);
    line();

    line('5. STOP BUTTON CANDIDATES  (verify by eye; prefer data-testid)');
    if (!P.stops.length) line('   none visible right now — REPORT while a reply is streaming');
    for (const s of P.stops) line(`   ${s.selector}\n      tag=${s.tag} testid=${s.testid} aria=${s.aria}`);
    line();

    line('6. CONVERSATION LOAD  (open an OLD chat first, so it refetches)');
    const loads = P.requests.filter((r) => r.jsonShape);
    if (!loads.length) line('   no JSON response seen — the site may load chats from memory, which means NO closed-tab recovery here');
    for (const r of loads.slice(0, 8)) {
      line(`   ${r.method} ${r.path}`);
      line(`      json shape: ${JSON.stringify(r.jsonShape).slice(0, 400)}`);
      if (r.jsonTimes?.length) line(`      timestamp fields: ${r.jsonTimes.join(', ')}`);
    }
    line();
    line('paste all of this back');
    return L.join('\n');
  }

  console.log('[probe] installed. Reload this tab, send a prompt, then type REPORT + Enter.');
})();
