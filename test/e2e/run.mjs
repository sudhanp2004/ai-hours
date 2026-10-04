// Loads the real unpacked extension via CDP (Chrome 137+ ignores --load-extension), opens the
// fake chatgpt.com, and reads the extension's storage and pill. Run through e2e.sh.
const EXT = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ver = await (await fetch('http://127.0.0.1:9333/json/version')).json();
let id = 0; const pending = new Map(); const events = [];
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else events.push(d); };
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const load = await send('Extensions.loadUnpacked', { path: EXT });
console.log('loadUnpacked:', JSON.stringify(load.result ?? load.error));
const extId = load.result?.id;
await sleep(1000);
const t = await send('Target.createTarget', { url: 'https://chatgpt.com/c/abc' });
const page = await send('Target.attachToTarget', { targetId: t.result.targetId, flatten: true });
const ps = page.result.sessionId;
await send('Runtime.enable', {}, ps);
await sleep(9000);
const title = await send('Runtime.evaluate', { expression: 'document.title + " | pill:" + !!document.querySelector("ai-hours-counter")' }, ps);
console.log('page:', title.result?.result?.value);
for (const e of events.filter((e) => e.method === 'Runtime.exceptionThrown')) console.log('page exception:', e.params.exceptionDetails.exception?.description?.slice(0, 300));
const targets = (await send('Target.getTargets')).result.targetInfos;
const sw = targets.find((x) => x.type === 'service_worker' && x.url.includes(extId));
console.log('sw:', !!sw);
const swS = (await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).result.sessionId;
const st = await send('Runtime.evaluate', { expression: 'chrome.storage.local.get(null).then(a => JSON.stringify(Object.values(a).map(r => ({ site: r.site, start: r.start, end: r.end, outcome: r.outcome, flags: r.flags, model: r.server && r.server.model }))))', awaitPromise: true }, swS);
console.log('records:', st.result?.result?.value ?? JSON.stringify(st.result));
async function staleMark() {
  const d = (await send('DOM.getDocument', { depth: -1, pierce: true }, ps)).result.root;
  let found = null;
  (function walk(n) {
    if (!n || found !== null) return;
    if ((n.attributes || []).join(' ').includes('class stale')) found = (n.children || []).map((c) => c.nodeValue).join('');
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
  })(d);
  return found;
}
const count = async () => JSON.parse((await send('Runtime.evaluate', { expression: 'chrome.storage.local.get(null).then(a => JSON.stringify(Object.keys(a).filter(k => k.startsWith("rec:")).length))', awaitPromise: true }, swS)).result.result.value);
const ask = async () => { await send('Runtime.evaluate', { expression: 'document.title="x"; ask()' }, ps); await sleep(6000); };
const first = JSON.parse(st.result.result.value);
if (first.length !== 1 || first[0].outcome !== 'completed' || first[0].model !== 'gpt-5') { console.log('FAIL: the first reply must be recorded, completed, with its model'); process.exit(1); }
if (first[0].flags.length) { console.log('FAIL: the stop button must be seen and paired (flags: ' + first[0].flags + ')'); process.exit(1); }
console.log('after first reply:', await count());
// Reload the extension the way the ↻ button does: reinstall from the same path.
const re = await send('Extensions.loadUnpacked', { path: EXT });
console.log('reloaded:', JSON.stringify(re.result ?? re.error));
await sleep(2000);
const sw2 = (await send('Target.getTargets')).result.targetInfos.find((x) => x.type === 'service_worker' && x.url.includes(extId));
const swS2 = (await send('Target.attachToTarget', { targetId: sw2.targetId, flatten: true })).result.sessionId;
const count2 = async () => JSON.parse((await send('Runtime.evaluate', { expression: 'chrome.storage.local.get(null).then(a => JSON.stringify(Object.keys(a).filter(k => k.startsWith("rec:")).length))', awaitPromise: true }, swS2)).result.result.value);
await ask();
const afterReload = await count2(); const markA = await staleMark();
console.log('reply in the open tab after reload, no refresh:', afterReload, '| pill mark:', JSON.stringify(markA));
if (afterReload !== 1 || markA !== '↻') { console.log('FAIL: an unpaired tab must not count and must show ↻'); process.exit(1); }
await send('Page.enable', {}, ps);
await send('Page.reload', {}, ps);
await sleep(9000);
const afterRefresh = await count2(); const markB = await staleMark();
console.log('after refreshing the tab (page sends one reply itself):', afterRefresh, '| pill mark:', JSON.stringify(markB));
if (afterRefresh !== 2 || markB !== '') { console.log('FAIL: a refreshed tab must count again'); process.exit(1); }
console.log('PASS');
const fail = (m) => { console.log('FAIL:', m); process.exit(1); };
process.exit(0);
