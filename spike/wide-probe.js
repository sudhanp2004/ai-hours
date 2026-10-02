(() => {
  if (window.__P) return 'already';
  const P = (window.__P = { reqs: [], ws: [], t0: Date.now() });
  const shape = (v, d = 0) => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return v.length ? [shape(v[0], d + 1), `len${v.length}`] : [];
    if (typeof v === 'object') { if (d >= 4) return '{…}'; const o = {}; for (const k of Object.keys(v).slice(0, 40)) o[k] = shape(v[k], d + 1); return o; }
    if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}T/.test(v) ? 'iso:' + v.slice(0, 24) : `s${v.length}`;
    if (typeof v === 'number') return v > 1e9 ? 'n:' + v : 'n';
    return typeof v;
  };
  const red = (s) => String(s ?? '').replace(/"((?:text|content|parts|prompt|query|message|value|body|delta|completion|title|summary|markdown|answer|thinking))"\s*:\s*"(?:[^"\\]|\\.)*"/gi, '"$1":"…"').slice(0, 260);
  const tryJ = (t) => { try { return shape(JSON.parse(t)); } catch { return `[nonjson ${t.length}]`; } };
  const of = window.fetch;
  window.fetch = async function (input, init) {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const r = { k: 'fetch', method, url: url.replace(location.origin, '').slice(0, 160), t: Date.now() - P.t0, body: typeof init?.body === 'string' ? tryJ(init.body) : init?.body ? `[${init.body.constructor?.name}]` : input instanceof Request && method !== 'GET' ? '[Request obj]' : null, frames: [], last: [], n: 0 };
    if (/\.(js|css|png|svg|woff2?)(\?|$)/.test(url) || /statsig|sentry|analytics|segment|datadog|intercom|growthbook|telemetry|log/i.test(url)) return of.apply(this, arguments);
    P.reqs.push(r);
    let res;
    try { res = await of.apply(this, arguments); } catch (e) { r.status = 'err:' + e.name; throw e; }
    r.status = res.status; r.ctype = res.headers.get('content-type');
    try {
      const c = res.clone();
      if (!/json|html|image|font|css|javascript/.test(r.ctype || '') || /stream/.test(r.ctype || '')) {
        (async () => { const rd = c.body.getReader(); const dec = new TextDecoder(); let buf = ''; r.bytes = 0;
          for (;;) { const { value, done } = await rd.read(); if (done) { r.end = Date.now() - P.t0; r.tail = red(buf.slice(-300)); break; }
            if (r.n === 0) r.first = Date.now() - P.t0; r.lastChunk = Date.now() - P.t0; r.bytes += value.length; r.lastHex = [...value.slice(0, 6)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
            const s = dec.decode(value, { stream: true }); r.n++; buf += s; if (buf.length > 20000) buf = buf.slice(-5000);
            if (r.frames.length < 4) r.frames.push(red(s.slice(0, 260))); } })().catch((e) => (r.rerr = e.name));
      } else if (/json/.test(r.ctype || '')) c.json().then((j) => (r.json = JSON.stringify(shape(j)).slice(0, 1500))).catch(() => {});
    } catch {}
    return res;
  };
  const ox = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__r = { k: 'xhr', method: m, url: String(u).replace(location.origin, '').slice(0, 160), n: 0, frames: [] }; return ox.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    const r = this.__r; if (r && !/log|telemetry|analytics/i.test(r.url)) { r.t = Date.now() - P.t0; r.body = typeof b === 'string' ? `[str ${b.length}] ` + b.slice(0, 0) : b ? `[${b.constructor?.name}]` : null; P.reqs.push(r);
      this.addEventListener('progress', () => { r.n++; if (r.frames.length < 3) r.frames.push(red(this.responseText.slice(-200))); });
      this.addEventListener('loadend', () => { r.status = this.status; r.ctype = this.getResponseHeader('content-type'); r.end = Date.now() - P.t0; try { r.tail = red(this.responseText.slice(-300)); } catch {} }); }
    return os.apply(this, arguments);
  };
  const OW = window.WebSocket;
  window.WebSocket = function (u, p) { const w = p ? new OW(u, p) : new OW(u); const rec = { url: String(u).slice(0, 160), t: Date.now() - P.t0, out: [], in: [], nin: 0, nout: 0 };
    P.ws.push(rec); const s = w.send; w.send = function (d) { rec.nout++; if (rec.out.length < 6) rec.out.push(typeof d === 'string' ? red(d) : '[bin]'); return s.apply(this, arguments); };
    w.addEventListener('message', (e) => { rec.nin++; const d = typeof e.data === 'string' ? red(e.data) : '[bin]'; if (rec.in.length < 6) rec.in.push(d); rec.lastIn = rec.lastIn ? [...rec.lastIn.slice(-3), d] : [d]; });
    w.addEventListener('close', () => (rec.closed = Date.now() - P.t0)); return w; };
  window.WebSocket.prototype = OW.prototype; Object.assign(window.WebSocket, { OPEN: 1, CLOSED: 3, CONNECTING: 0, CLOSING: 2 });
  P.stopCands = () => [...document.querySelectorAll('button,[role="button"]')].filter((b) => b.offsetParent && /stop|cancel/i.test([b.getAttribute('aria-label'), b.getAttribute('data-testid'), b.title, b.innerText].join(' '))).map((b) => ({ aria: b.getAttribute('aria-label'), testid: b.getAttribute('data-testid'), cls: String(b.className).slice(0, 80), text: b.innerText.slice(0, 30) }));
  P.watch = setInterval(() => { const c = P.stopCands(); if (c.length) { P.seenStop = c; P.stopAt = P.stopAt ?? Date.now() - P.t0; P.stopGone = null; } else if (P.stopAt && !P.stopGone) P.stopGone = Date.now() - P.t0; }, 100);
  P.dump = (f) => P.reqs.filter(f || (() => true)).map((r) => `${r.k} ${r.method} ${r.url} t=${r.t} first=${r.first} last=${r.lastChunk} end=${r.end} st=${r.status} ct=${r.ctype} n=${r.n} bytes=${r.bytes} hex=${r.lastHex}`).join('\n');
  return 'installed';
})()
