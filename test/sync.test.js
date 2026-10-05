// Sync (spec §13): records ↔ rows, Google sign-in replies, and push/pull against a fake Data API.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/sync.js');
const { sync } = globalThis.__aiHours;

const NOW = 1790764800000;
const CLIENT = '822593684452-t3f70ule6u8nfms79s9nl25h0snhe8st.apps.googleusercontent.com';
const rec = (over) => ({
  id: 'r1', site: 'claude', tabId: 7, start: NOW - 60000, end: NOW - 30000, lastSeen: NOW - 30000,
  outcome: 'completed', flags: [], dom: { start: 1, end: 2 }, sent: { conversationId: 'c', messageId: 'm' },
  server: { model: 'claude-opus-5-5', turnExchangeId: 'tx' }, recovered: null, updatedMs: NOW - 30000, ...over,
});

// ---- records and rows
test('a record becomes a row with only what totals need: no conversation or message ids', () => {
  const row = sync.toRow(rec());
  assert.deepEqual(row, {
    id: 'r1', site: 'claude', model: 'claude-opus-5-5', start_ms: NOW - 60000, end_ms: NOW - 30000,
    last_seen: NOW - 30000, outcome: 'completed', recovered_ms: null, updated_ms: NOW - 30000,
  });
  assert.ok(!JSON.stringify(row).includes('tx') && !JSON.stringify(row).includes('"c"'));
});

test('a row that the database would refuse is not sent at all', () => {
  assert.equal(sync.toRow(rec({ site: 'copilot' })), null, 'unknown site');
  assert.equal(sync.toRow(rec({ end: NOW - 70000 })), null, 'ends before it starts');
  assert.equal(sync.toRow(rec({ start: 'x' })), null, 'not a number');
  assert.equal(sync.toRow(rec({ outcome: 'weird' })), null, 'unknown outcome');
  assert.equal(sync.toRow(null), null);
  // Over-long values are clipped to the same 3-hour cap the database enforces, not dropped.
  assert.equal(sync.toRow(rec({ end: NOW - 60000 + 5 * 3600e3 })).end_ms, NOW - 60000 + 3 * 3600e3);
  assert.equal(sync.toRow(rec({ recovered: { durationMs: 9e9 } })).recovered_ms, 3 * 3600e3);
  // A record from before updatedMs existed uses its own times.
  assert.equal(sync.toRow(rec({ updatedMs: undefined })).updated_ms, NOW - 30000);
});

test('a row comes back as a record the totals understand, marked as synced', () => {
  const r = sync.fromRow(sync.toRow(rec({ recovered: { durationMs: 42000 }, end: null })));
  assert.equal(r.id, 'r1');
  assert.equal(r.start, NOW - 60000);
  assert.equal(r.end, null);
  assert.deepEqual(r.recovered, { durationMs: 42000 });
  assert.equal(r.server.model, 'claude-opus-5-5');
  assert.equal(r.tabId, null, 'it belongs to no tab here, so it is never closed as a leftover');
  assert.equal(r.updatedMs, NOW - 30000);
  assert.ok(r.flags.includes('synced'));
});

// ---- Google sign-in replies
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `${b64({ alg: 'RS256', kid: 'k' })}.${b64(payload)}.sig`;
const claims = (over) => ({ iss: 'https://accounts.google.com', aud: CLIENT, sub: '1234567890', nonce: 'n-1', exp: NOW / 1000 + 3600, ...over });
const redirect = (token) => `https://hbomcdffiihfbfcenjcdjgpnnapiadcm.chromiumapp.org/#id_token=${token}&authuser=0`;

test('the sign-in URL asks Google for an ID token with openid only, and a nonce', () => {
  const u = new URL(sync.authUrl({ clientId: CLIENT, redirectUri: 'https://x.chromiumapp.org/', nonce: 'n-1', silent: false }));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('response_type'), 'id_token');
  assert.equal(u.searchParams.get('scope'), 'openid', 'no email, no name, no profile');
  assert.equal(u.searchParams.get('nonce'), 'n-1');
  assert.equal(u.searchParams.get('prompt'), 'select_account');
  const silent = new URL(sync.authUrl({ clientId: CLIENT, redirectUri: 'https://x.chromiumapp.org/', nonce: 'n-2', silent: true }));
  assert.equal(silent.searchParams.get('prompt'), 'none');
});

test('a sign-in reply is accepted only for our client, from Google, with our nonce, unexpired', () => {
  const ok = sync.tokenFromRedirect(redirect(jwt(claims())), { clientId: CLIENT, nonce: 'n-1', now: NOW });
  assert.equal(ok.sub, '1234567890');
  assert.equal(ok.exp, NOW + 3600e3);
  const bad = (c) => () => sync.tokenFromRedirect(redirect(jwt(claims(c))), { clientId: CLIENT, nonce: 'n-1', now: NOW });
  assert.throws(bad({ aud: 'someone-else' }), /audience/);
  assert.throws(bad({ iss: 'https://evil.example' }), /issuer/);
  assert.throws(bad({ nonce: 'replayed' }), /nonce/);
  assert.throws(bad({ exp: NOW / 1000 - 1 }), /expired/);
  assert.throws(() => sync.tokenFromRedirect('https://x.chromiumapp.org/#error=access_denied', { clientId: CLIENT, nonce: 'n-1', now: NOW }), /access_denied/);
});

// ---- push and pull against a fake Data API
const API = 'https://api.example/neondb/rest/v1';
function fakeServer() {
  const rows = new Map(); // id -> row
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method || 'GET', path: u.pathname, search: u.search, auth: init.headers?.Authorization });
    if (init.headers?.Authorization !== 'Bearer good') return new Response('{"message":"bad token"}', { status: 401 });
    if (init.method === 'POST') {
      const batch = JSON.parse(init.body);
      if (batch.some((r) => r.id === 'poison')) return new Response('{"message":"check"}', { status: 400 });
      for (const r of batch) if (!rows.has(r.id) || rows.get(r.id).updated_ms <= r.updated_ms) rows.set(r.id, r);
      return new Response(null, { status: 201 });
    }
    if (init.method === 'DELETE') {
      rows.clear();
      return new Response(null, { status: 204 });
    }
    const offset = Number(u.searchParams.get('offset') || 0);
    const limit = Number(u.searchParams.get('limit'));
    const page = [...rows.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(offset, offset + limit);
    return new Response(JSON.stringify(page), { headers: { 'content-type': 'application/json' } });
  };
  return { rows, calls, fetch };
}
function fakeStore(init = {}) {
  const data = { ...init };
  return {
    data,
    get: async (k) => (k == null ? { ...data } : Array.isArray(k) ? Object.fromEntries(k.filter((x) => x in data).map((x) => [x, data[x]])) : k in data ? { [k]: data[k] } : {}),
    set: async (o) => Object.assign(data, o),
    remove: async (k) => [].concat(k).forEach((x) => delete data[x]),
  };
}
const engine = (store, server, token = 'good', over = {}) =>
  sync.createSync({ api: API, store, fetch: server.fetch, now: () => NOW, token: async () => token, batch: 2, page: 2, ...over });

test('push sends changed records in batches, idempotently, and clears them only once accepted', async () => {
  const store = fakeStore({ 'rec:a': rec({ id: 'a' }), 'rec:b': rec({ id: 'b' }), 'rec:c': rec({ id: 'c' }) });
  const server = fakeServer();
  const s = engine(store, server);
  await s.markDirty(['rec:a', 'rec:b', 'rec:c']);
  const res = await s.push();
  assert.equal(res.sent, 3);
  assert.deepEqual([...server.rows.keys()].sort(), ['a', 'b', 'c']);
  assert.equal(server.calls.filter((c) => c.method === 'POST').length, 2, 'batches of 2');
  assert.ok(server.calls.every((c) => c.search.includes('on_conflict=user_id%2Cid') || c.method !== 'POST'));
  assert.deepEqual(store.data['sync:dirty'], {});
  assert.equal((await s.push()).sent, 0, 'nothing left to send');
});

test('no token (signed out or expired): nothing is sent and nothing is lost', async () => {
  const store = fakeStore({ 'rec:a': rec({ id: 'a' }) });
  const server = fakeServer();
  const s = engine(store, server, null);
  await s.markDirty(['rec:a']);
  assert.equal((await s.push()).skipped, 'signed-out');
  assert.equal(server.calls.length, 0);
  assert.ok('rec:a' in store.data['sync:dirty']);
});

test('a rejected token stops the sync and keeps the records queued', async () => {
  const store = fakeStore({ 'rec:a': rec({ id: 'a' }) });
  const s = engine(store, fakeServer(), 'expired');
  await s.markDirty(['rec:a']);
  assert.equal((await s.push()).skipped, 'auth');
  assert.ok('rec:a' in store.data['sync:dirty']);
});

test('one bad record does not block the rest: it is found and set aside', async () => {
  const store = fakeStore({ 'rec:a': rec({ id: 'a' }), 'rec:poison': rec({ id: 'poison' }) });
  const server = fakeServer();
  const s = engine(store, server);
  await s.markDirty(['rec:a', 'rec:poison']);
  const res = await s.push();
  assert.equal(res.sent, 1);
  assert.equal(res.rejected, 1);
  assert.ok(server.rows.has('a'));
  assert.deepEqual(store.data['sync:dirty'], {}, 'a record the server refuses is not retried forever');
});

test('a record changed again while its upload was in flight stays queued', async () => {
  const store = fakeStore({ 'rec:a': rec({ id: 'a' }) });
  const server = fakeServer();
  let s;
  const slow = { fetch: async (u, i) => { await s.markDirty(['rec:a'], NOW + 5); return server.fetch(u, i); } };
  s = engine(store, server, 'good', slow);
  await s.markDirty(['rec:a'], NOW);
  await s.push();
  assert.ok('rec:a' in store.data['sync:dirty']);
});

test('pull brings in what this device lacks, keeps whichever copy is newer, and re-sends nothing', async () => {
  const server = fakeServer();
  const remote = (id, over) => server.rows.set(id, sync.toRow(rec({ id, ...over })));
  remote('x', { site: 'gemini' }); // not here yet
  remote('y', { updatedMs: NOW - 1000, end: NOW - 20000 }); // newer than the local copy
  remote('z', { updatedMs: NOW - 90000 }); // older than the local copy
  const store = fakeStore({
    'rec:y': rec({ id: 'y', updatedMs: NOW - 5000, tabId: 3 }),
    'rec:z': rec({ id: 'z', updatedMs: NOW - 1000 }),
  });
  const s = engine(store, server);
  const res = await s.pull();
  assert.equal(res.received, 3);
  assert.equal(res.written, 2);
  assert.equal(store.data['rec:x'].site, 'gemini');
  assert.equal(store.data['rec:y'].end, NOW - 20000, 'the newer remote copy wins');
  assert.equal(store.data['rec:y'].tabId, 3, 'local-only facts are kept');
  assert.equal(store.data['rec:z'].updatedMs, NOW - 1000, 'the newer local copy stays');
  // The storage writes pull made must not come back as changes to upload.
  s.noteChanges({ 'rec:x': { newValue: store.data['rec:x'] }, 'rec:y': { newValue: store.data['rec:y'] } });
  assert.deepEqual(store.data['sync:dirty'] ?? {}, {});
});

test('pull pages through everything', async () => {
  const server = fakeServer();
  for (const id of ['a', 'b', 'c', 'd', 'e']) server.rows.set(id, sync.toRow(rec({ id })));
  const store = fakeStore();
  const res = await engine(store, server).pull();
  assert.equal(res.received, 5);
  assert.equal(Object.keys(store.data).filter((k) => k.startsWith('rec:')).length, 5);
});

test('local changes are noted with their time; non-record keys are ignored', async () => {
  const store = fakeStore();
  const s = engine(store, fakeServer());
  s.noteChanges({ 'rec:a': { newValue: rec({ id: 'a', updatedMs: NOW - 7 }) }, 'sync:status': { newValue: {} }, 'rec:gone': { oldValue: {} } });
  await s.flushNotes();
  assert.deepEqual(store.data['sync:dirty'], { 'rec:a': NOW - 7 });
});

test('delete my synced data removes every row of mine on the server', async () => {
  const server = fakeServer();
  server.rows.set('a', sync.toRow(rec({ id: 'a' })));
  const store = fakeStore({ 'sync:dirty': { 'rec:a': 1 } });
  const res = await engine(store, server).wipeRemote();
  assert.equal(res.ok, true);
  assert.equal(server.rows.size, 0);
  assert.deepEqual(store.data['sync:dirty'], {}, 'nothing queued to put it back');
});

test('a later pull asks only for rows changed since the last one, with a day of slack for clock skew', async () => {
  const server = fakeServer();
  server.rows.set('a', sync.toRow(rec({ id: 'a', updatedMs: NOW - 10 * 86400e3 })));
  const store = fakeStore();
  const s = engine(store, server);
  const first = await s.pull();
  assert.equal(first.upTo, NOW - 10 * 86400e3);
  assert.equal(store.data['sync:pulledUpTo'], NOW - 10 * 86400e3);
  await s.pull();
  const last = server.calls.at(-1);
  assert.match(decodeURIComponent(last.search), new RegExp(`updated_ms=gt\\.${NOW - 11 * 86400e3}`));
  assert.match(decodeURIComponent(last.search), /order=updated_ms\.asc,id\.asc/);
});
