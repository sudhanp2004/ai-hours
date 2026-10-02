// Inject after wide-probe.js on claude.ai (no reload). Logs every /claudeai-rpc/ call with a
// schema-free protobuf summary of its request body, and splits StreamTimeline into Connect
// envelopes (1 byte flag + 4 byte big-endian length; flag & 2 = end-of-stream trailer).
// Read with: __Q.log  (prompt/reply text shows only as <Nb> lengths; identifiers and
// type.googleapis.com names are kept).
(() => {
const Q = window.__Q = { log: [], t0: window.__P?.t0 ?? Date.now() };
const now = () => Date.now() - Q.t0;
const varint = (b, i) => { let x = 0, s = 0, c; do { if (i >= b.length) throw 0; c = b[i++]; x += (c & 0x7f) * 2 ** s; s += 7; } while (c & 0x80 && s < 64); return [x, i]; };
const fields = (b, depth = 0) => { const out = []; let i = 0; while (i < b.length) { let k; [k, i] = varint(b, i); const f = Math.floor(k / 8), w = k & 7; if (f < 1 || f > 2000) throw 0;
  if (w === 0) { let v; [v, i] = varint(b, i); out.push(`${f}=${v}`); }
  else if (w === 2) { let l; [l, i] = varint(b, i); if (i + l > b.length) throw 0; const sub = b.subarray(i, i + l); i += l;
    const str = new TextDecoder('utf-8', { fatal: false }).decode(sub);
    if (/^type\.googleapis\.com\//.test(str)) out.push(`${f}:@${str.slice(20)}`);
    else if (/^[\w.:\/-]{1,64}$/.test(str) && l > 0) out.push(`${f}:"${str}"`);
    else { let inner = null; if (depth < 5 && l > 1) { try { inner = fields(sub, depth + 1); } catch {} } out.push(inner ? `${f}{${inner.join(' ')}}` : `${f}:<${l}b>`); } }
  else if (w === 1) { i += 8; out.push(`${f}=f64`); } else if (w === 5) { i += 4; out.push(`${f}=f32`); } else throw 0; }
  return out; };
Q.fields = fields;
const desc = (u8) => { try { return fields(u8).join(' ').slice(0, 900); } catch { return `<unparsed ${u8.length}b>`; } };
const of = window.fetch;
window.fetch = async function (input, init) {
  const url = input instanceof Request ? input.url : String(input);
  if (!/claudeai-rpc/.test(url)) return of.apply(this, arguments);
  const name = url.split('/').pop(); const rec = { name, t: now() };
  const body = init?.body;
  rec.req = body instanceof Uint8Array ? desc(body) : body instanceof ArrayBuffer ? desc(new Uint8Array(body)) : body ? `[${body.constructor?.name}]` : null;
  Q.log.push(rec);
  const res = await of.apply(this, arguments); rec.status = res.status;
  if (name === 'StreamTimeline') { rec.frames = []; const rd = res.clone().body.getReader(); let buf = new Uint8Array(0);
    (async () => { for (;;) { const { value, done } = await rd.read(); if (done) { rec.end = now(); break; }
      const nb = new Uint8Array(buf.length + value.length); nb.set(buf); nb.set(value, buf.length); buf = nb;
      while (buf.length >= 5) { const flag = buf[0], len = (buf[1] << 24 | buf[2] << 16 | buf[3] << 8 | buf[4]) >>> 0; if (buf.length < 5 + len) break;
        const p = buf.subarray(5, 5 + len); buf = buf.slice(5 + len);
        rec.frames.push({ t: now(), flag, len, d: flag & 2 ? new TextDecoder().decode(p).slice(0, 200) : desc(p) }); } } })().catch((e) => (rec.err = String(e)));
  }
  return res;
};
return 'Q installed';
})()
