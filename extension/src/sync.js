// Sign-in and sync with the AI Hours backend (spec §13). Loaded by the service worker (and
// the popup, for its constants). No browser API is used directly: storage, fetch, the clock
// and the token come in as parameters, so all of it is testable without Chrome.
//
// The backend is Neon's Data API (PostgREST over Postgres). It checks each request's Google ID
// token itself, and row-level security limits every user to their own rows.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});

  const CONFIG = {
    api: 'https://ep-little-union-b38xtax2.apirest.c-4.ap-southeast-1.aws.neon.tech/neondb/rest/v1',
    clientId: '822593684452-t3f70ule6u8nfms79s9nl25h0snhe8st.apps.googleusercontent.com',
  };
  const SITES = ['chatgpt', 'perplexity', 'claude', 'gemini', 'deepseek'];
  const OUTCOMES = ['unknown', 'completed', 'stopped', 'error', 'pending', 'recovered'];
  const MAX_REPLY_MS = 3 * 60 * 60 * 1000; // the same cap as spec §12, and the database's
  const COLUMNS = 'id,site,model,start_ms,end_ms,last_seen,outcome,recovered_ms,updated_ms';
  const DIRTY = 'sync:dirty'; // record key -> the updatedMs it was queued at
  const PULLED = 'sync:pulledUpTo'; // the newest updated_ms seen from the server
  const SKEW_MS = 24 * 60 * 60 * 1000; // devices' clocks may disagree; re-read a day back

  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const int = (x) => Math.round(x);

  // ---- records <-> rows: only what totals need, never a conversation or message id
  function toRow(r) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || r.id.length > 64) return null;
    if (!SITES.includes(r.site) || !OUTCOMES.includes(r.outcome) || !num(r.start)) return null;
    if (r.end != null && (!num(r.end) || r.end < r.start)) return null;
    const model = typeof r.server?.model === 'string' && r.server.model.length <= 64 ? r.server.model : null;
    const end = r.end == null ? null : int(Math.min(r.end, r.start + MAX_REPLY_MS));
    const lastSeen = num(r.lastSeen) && r.lastSeen >= r.start ? int(r.lastSeen) : null;
    const recovered = num(r.recovered?.durationMs) ? int(Math.min(Math.max(0, r.recovered.durationMs), MAX_REPLY_MS)) : null;
    const updated = num(r.updatedMs) ? r.updatedMs : r.end ?? r.lastSeen ?? r.start;
    return {
      id: r.id, site: r.site, model, start_ms: int(r.start), end_ms: end, last_seen: lastSeen,
      outcome: r.outcome, recovered_ms: recovered, updated_ms: int(updated),
    };
  }

  function fromRow(row) {
    if (!row || typeof row.id !== 'string' || !SITES.includes(row.site) || !num(row.start_ms)) return null;
    return {
      id: row.id, site: row.site, tabId: null, start: row.start_ms, end: row.end_ms ?? null,
      lastSeen: row.last_seen ?? null, firstByte: null, finished: null, outcome: row.outcome,
      source: 'synced', confidence: 'high', flags: ['synced'], dom: null,
      sent: { conversationId: null, messageId: null },
      recovered: row.recovered_ms == null ? null : { durationMs: row.recovered_ms },
      server: row.model ? { model: row.model } : {},
      updatedMs: row.updated_ms,
    };
  }

  // ---- Google sign-in: an OpenID ID token, asked for with the openid scope only
  function authUrl({ clientId, redirectUri, nonce, silent }) {
    const q = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'id_token', scope: 'openid',
      nonce, prompt: silent ? 'none' : 'select_account',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  function decodeJwt(token) {
    const part = String(token).split('.')[1] ?? '';
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  }

  // The token's signature is checked by the server; these checks make sure the extension
  // never stores a token meant for someone else, replayed, or already expired.
  function tokenFromRedirect(url, { clientId, nonce, now }) {
    const params = new URLSearchParams(new URL(url).hash.slice(1));
    if (params.get('error')) throw new Error(params.get('error'));
    const token = params.get('id_token');
    if (!token) throw new Error('no id_token in the sign-in reply');
    const c = decodeJwt(token);
    if (c.aud !== clientId) throw new Error('wrong audience');
    if (c.iss !== 'https://accounts.google.com' && c.iss !== 'accounts.google.com') throw new Error('wrong issuer');
    if (c.nonce !== nonce) throw new Error('nonce mismatch');
    if (!num(c.exp) || c.exp * 1000 <= now) throw new Error('token expired');
    if (typeof c.sub !== 'string' || !c.sub) throw new Error('no subject');
    return { token, sub: c.sub, exp: c.exp * 1000 };
  }

  // ---- push and pull
  function createSync({ api = CONFIG.api, store, fetch, now, token, batch = 500, page = 1000 }) {
    let queue = Promise.resolve(); // every read-modify-write of the outbox runs in order
    const serial = (fn) => (queue = queue.then(fn, fn));
    const justPulled = new Map(); // key -> updatedMs that pull itself wrote
    // Always a copy: the caller may keep it as a snapshot while the stored outbox moves on.
    const getDirty = async () => ({ ...((await store.get(DIRTY))[DIRTY] ?? {}) });

    const markDirty = (keys, at) =>
      serial(async () => {
        const d = await getDirty();
        for (const k of keys) d[k] = at ?? now();
        await store.set({ [DIRTY]: d });
      });

    // Removes keys whose queued time is still the one this upload sent: a record changed
    // again meanwhile stays queued for the next round.
    const clear = (keys, sent) =>
      serial(async () => {
        const d = await getDirty();
        for (const k of keys) if (d[k] === sent[k]) delete d[k];
        await store.set({ [DIRTY]: d });
      });

    // chrome.storage.onChanged, for record keys: a local write queues the record, unless it is
    // pull's own write coming back.
    function noteChanges(changes) {
      const keys = {};
      for (const [k, c] of Object.entries(changes)) {
        if (!k.startsWith('rec:') || !c.newValue) continue;
        const at = c.newValue.updatedMs ?? now();
        if (justPulled.get(k) === c.newValue.updatedMs) {
          justPulled.delete(k);
          continue;
        }
        keys[k] = at;
      }
      for (const [k, at] of Object.entries(keys)) markDirty([k], at);
    }
    const flushNotes = () => serial(() => {});

    const headers = (t, extra) => ({ Authorization: `Bearer ${t}`, ...extra });
    const upsert = (t, rows) =>
      fetch(`${api}/records?${new URLSearchParams({ on_conflict: 'user_id,id' })}`, {
        method: 'POST',
        headers: headers(t, { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(rows),
      });

    async function push() {
      const t = await token();
      if (!t) return { skipped: 'signed-out', sent: 0 };
      const dirty = await getDirty();
      const keys = Object.keys(dirty);
      let sent = 0;
      let rejected = 0;
      try {
        for (let i = 0; i < keys.length; i += batch) {
          const chunk = keys.slice(i, i + batch);
          const recs = await store.get(chunk);
          const ok = [];
          const bad = [];
          for (const k of chunk) {
            const row = toRow(recs[k]);
            if (row) ok.push([k, row]);
            else bad.push(k);
          }
          if (bad.length) (rejected += bad.length), await clear(bad, dirty); // can never be sent
          if (!ok.length) continue;
          const res = await upsert(t, ok.map(([, r]) => r));
          if (res.status === 401 || res.status === 403) return { skipped: 'auth', sent, rejected };
          if (res.ok) {
            sent += ok.length;
            await clear(ok.map(([k]) => k), dirty);
            continue;
          }
          if (res.status >= 500) return { skipped: 'server', sent, rejected };
          // The server refused the batch: send one by one to find the record it objects to.
          for (const [k, row] of ok) {
            const one = await upsert(t, [row]);
            if (one.status === 401 || one.status === 403) return { skipped: 'auth', sent, rejected };
            if (one.ok) sent++;
            else if (one.status >= 500) return { skipped: 'server', sent, rejected };
            else rejected++;
            await clear([k], dirty);
          }
        }
      } catch {
        return { skipped: 'offline', sent, rejected };
      }
      return { sent, rejected };
    }

    async function pull() {
      const t = await token();
      if (!t) return { skipped: 'signed-out', received: 0, written: 0 };
      let received = 0;
      let written = 0;
      // Only rows changed since the last pull, re-reading a day back in case another device's
      // clock runs behind ours. The first pull on a device reads everything.
      const upTo = (await store.get(PULLED))[PULLED] ?? null;
      let newest = upTo ?? 0;
      try {
        for (let offset = 0; ; offset += page) {
          const q = new URLSearchParams({ select: COLUMNS, order: 'updated_ms.asc,id.asc', limit: String(page), offset: String(offset) });
          if (upTo != null) q.set('updated_ms', `gt.${Math.max(0, upTo - SKEW_MS)}`);
          const res = await fetch(`${api}/records?${q}`, { headers: headers(t) });
          if (res.status === 401 || res.status === 403) return { skipped: 'auth', received, written };
          if (!res.ok) return { skipped: 'server', received, written };
          const rows = await res.json();
          received += rows.length;
          const keys = rows.map((r) => 'rec:' + r.id);
          const local = await store.get(keys);
          const out = {};
          for (const row of rows) {
            if (num(row.updated_ms) && row.updated_ms > newest) newest = row.updated_ms;
            const remote = fromRow(row);
            if (!remote) continue;
            const key = 'rec:' + remote.id;
            const cur = local[key];
            if (cur && (cur.updatedMs ?? 0) >= remote.updatedMs) continue; // ours is as new or newer
            out[key] = cur
              // Keep what only this device knows (its tab, ids, DOM timing); take the rest.
              ? { ...cur, ...remote, tabId: cur.tabId, sent: cur.sent, dom: cur.dom, source: cur.source,
                  server: { ...cur.server, ...remote.server }, flags: cur.flags ?? [] }
              : remote;
            justPulled.set(key, remote.updatedMs);
          }
          written += Object.keys(out).length;
          if (Object.keys(out).length) await store.set(out);
          if (rows.length < page) break;
        }
      } catch {
        return { skipped: 'offline', received, written };
      }
      if (newest !== upTo) await store.set({ [PULLED]: newest });
      return { received, written, upTo: newest };
    }

    // Every row of this user's (RLS limits the delete to them), and nothing left queued to
    // put it back.
    async function wipeRemote() {
      const t = await token();
      if (!t) return { ok: false, skipped: 'signed-out' };
      try {
        const res = await fetch(`${api}/records?${new URLSearchParams({ id: 'not.is.null' })}`, {
          method: 'DELETE', headers: headers(t, { Prefer: 'return=minimal' }),
        });
        if (!res.ok) return { ok: false, skipped: res.status === 401 || res.status === 403 ? 'auth' : 'server' };
      } catch {
        return { ok: false, skipped: 'offline' };
      }
      await serial(() => store.set({ [DIRTY]: {} }));
      return { ok: true };
    }

    return { markDirty, noteChanges, flushNotes, push, pull, wipeRemote };
  }

  ns.sync = { CONFIG, toRow, fromRow, authUrl, tokenFromRedirect, decodeJwt, createSync };
})(globalThis);
