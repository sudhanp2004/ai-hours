// Stateless. Its jobs are events in and events out; nothing is held between them that
// storage doesn't hold:
//   1. re-inject scripts into already-open tabs after an install/update,
//   2. tell the world a tab is gone, so its unfinished replies stop counting at once,
//   3. sign-in and sync with the backend, only for users who signed in (spec §13).
// Closed-tab replies are finished later from ChatGPT's own conversation data (spec §6b).
// reconcile.js is plain JS with no exports, so this import is for its side effect only:
// the same file is also loaded as a classic script by the content script.
import './reconcile.js';
import './manifest-match.js';
import './sync.js';
import './total.js'; // summaryOf/summaryItems for the Chrome-sync backup

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install' && reason !== 'update') return;
  const { content_scripts: scripts } = chrome.runtime.getManifest();
  const tabs = await chrome.tabs.query({ url: scripts.flatMap((s) => s.matches) });
  for (const tab of tabs) {
    // Only this tab's own site (spec §11). Injecting every entry would give a Claude tab
    // the ChatGPT stop-button selector, so its replies would be tracked against the wrong
    // selector and flagged as dom-missing forever.
    for (const s of globalThis.__aiHours.scriptsFor(scripts, tab.url)) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: s.world || 'ISOLATED', files: s.js });
      } catch (e) {
        console.warn('AI Hours: re-inject failed', tab.id, e);
      }
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const all = await chrome.storage.local.get(null);
    const records = Object.entries(all)
      .filter(([key]) => key.startsWith('rec:'))
      .map(([, r]) => r);
    const changed = globalThis.__aiHours.pendingByTab(records, tabId, Date.now());
    const update = {};
    for (const [id, rec] of Object.entries(changed)) update['rec:' + id] = rec;
    if (Object.keys(update).length) await chrome.storage.local.set(update);
  } catch (e) {
    // Never throw into Chrome: a lost close signal only costs us the live cutoff.
    console.warn('AI Hours: could not mark closed tab', tabId, e);
  }
});

// A content script needs its own tab id so each record can be attributed to it. Chrome
// puts it on sender.tab, so there is nothing to remember.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.__aih !== 1 || msg.type !== 'tabId' || !sender.tab) return;
  sendResponse({ tabId: sender.tab.id });
  return true;
});

// ---- Sign-in and sync (spec §13). Signed out, none of this sends anything.
const { sync } = globalThis.__aiHours;
const ALARM = 'aih-sync';
const local = chrome.storage.local;
// The ID token lives in session storage: never on disk, and not readable by content scripts.
const session = chrome.storage.session;

async function signedInUser() {
  return (await local.get('auth:user'))['auth:user'] ?? null;
}

async function setStatus(state, detail) {
  await local.set({ 'sync:status': { state, at: Date.now(), ...detail } });
}

// Google's OpenID flow through chrome.identity. Silent renewal uses prompt=none with the
// signed-in account as the hint, so it can never quietly switch to another Google account.
async function googleSignIn({ silent, sub }) {
  const nonce = crypto.randomUUID();
  const url = new URL(sync.authUrl({ clientId: sync.CONFIG.clientId, redirectUri: chrome.identity.getRedirectURL(), nonce, silent }));
  if (sub) url.searchParams.set('login_hint', sub);
  const redirect = await chrome.identity.launchWebAuthFlow({ url: String(url), interactive: !silent });
  const got = sync.tokenFromRedirect(redirect, { clientId: sync.CONFIG.clientId, nonce, now: Date.now() });
  if (sub && got.sub !== sub) throw new Error('a different Google account answered');
  await session.set({ 'auth:token': { token: got.token, exp: got.exp } });
  return got;
}

// A token with at least two minutes left, renewed silently if needed; null when signed out
// or when renewal needs the user (then the popup asks them to sign in again).
async function token() {
  const t = (await session.get('auth:token'))['auth:token'];
  if (t && t.exp - Date.now() > 2 * 60 * 1000) return t.token;
  const user = await signedInUser();
  if (!user) return null;
  try {
    return (await googleSignIn({ silent: true, sub: user.sub })).token;
  } catch {
    await setStatus('needs-sign-in');
    return null;
  }
}

const engine = sync.createSync({ store: local, fetch: (...a) => fetch(...a), now: () => Date.now(), token });

// Every record write, while signed in, is queued for upload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !Object.keys(changes).some((k) => k.startsWith('rec:'))) return;
  signedInUser().then((u) => u && engine.noteChanges(changes));
});

let running = null; // one sync at a time
function runSync() {
  return (running ??= (async () => {
    try {
      if (!(await signedInUser())) return setStatus('signed-out');
      const pulled = await engine.pull();
      const pushed = await engine.push();
      const why = pulled.skipped ?? pushed.skipped;
      const pending = Object.keys((await local.get('sync:dirty'))['sync:dirty'] ?? {}).length;
      if (why === 'auth' || why === 'signed-out') await setStatus('needs-sign-in', { pending });
      else if (why) await setStatus(why === 'offline' ? 'offline' : 'error', { pending });
      else await setStatus('ok', { pending, lastSync: Date.now() });
    } finally {
      running = null;
    }
  })());
}

function scheduleSync() {
  chrome.alarms.create(ALARM, { periodInMinutes: 5, delayInMinutes: 1 });
}
chrome.alarms.onAlarm.addListener((a) => a.name === ALARM && runSync());
chrome.runtime.onStartup.addListener(() => signedInUser().then((u) => u && scheduleSync()));

async function signIn() {
  const got = await googleSignIn({ silent: false });
  await local.set({ 'auth:user': { sub: got.sub } }); // the opaque Google id only
  // Everything recorded before signing in goes up too, each at its own time.
  const all = await local.get(null);
  for (const [k, r] of Object.entries(all)) if (k.startsWith('rec:')) await engine.markDirty([k], r.updatedMs ?? r.end ?? r.start);
  scheduleSync();
  await runSync();
}

async function signOut() {
  await chrome.alarms.clear(ALARM);
  await session.remove('auth:token');
  await local.remove(['auth:user', 'sync:dirty', 'sync:pulledUpTo']);
  await setStatus('signed-out');
}

// The popup's buttons. Only the extension's own pages may ask (never a content script).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.__aih !== 1 || !String(msg.type).startsWith('sync:') || sender.tab || sender.id !== chrome.runtime.id) return;
  const act = {
    'sync:signIn': signIn,
    'sync:signOut': signOut,
    'sync:now': runSync,
    // Deleting the server copy also signs out, so nothing is uploaded again behind the user.
    'sync:wipe': async () => {
      const res = await engine.wipeRemote();
      if (!res.ok) throw new Error(res.skipped);
      await signOut();
    },
  }[msg.type];
  if (!act) return;
  act().then(
    () => sendResponse({ ok: true }),
    async (e) => {
      const error = String(e?.message ?? e);
      // The popup has usually closed by now (Google's window took focus), so the error is
      // kept for the next time it opens.
      if (msg.type === 'sync:signIn') await setStatus('sign-in-failed', { error });
      sendResponse({ ok: false, error });
    },
  );
  return true;
});

// ---- Chrome-sync backup (spec §13): automatic, no sign-in. Each install keeps a compact
// summary of its totals in chrome.storage.sync, which Chrome keeps in the user's Google account,
// restores after a reinstall and copies to their other computers.
const SUMMARY_ALARM = 'aih-summary';

async function deviceId() {
  let id = (await local.get('device:id'))['device:id'];
  if (!id) await local.set({ 'device:id': (id = crypto.randomUUID()) });
  return id;
}

async function writeSummary() {
  try {
    const [device, all, user] = [await deviceId(), await local.get(null), await signedInUser()];
    const records = Object.entries(all).filter(([k]) => k.startsWith('rec:')).map(([, r]) => r);
    const summary = globalThis.__aiHours.summaryOf(records, Date.now(), { device, sub: user?.sub ?? null });
    const items = globalThis.__aiHours.summaryItems(summary);
    // Chrome sync allows only so many writes an hour: skip it when nothing changed.
    const fingerprint = JSON.stringify(Object.values(items).map((i) => [i.site, i.sub, i.models]));
    if (all['summary:last'] === fingerprint) return;
    await chrome.storage.sync.set(items);
    await local.set({ 'summary:last': fingerprint });
  } catch (e) {
    console.warn('AI Hours: could not save the synced summary', e); // tried again on the next change
  }
}

// At most once a minute after a record changes, so a streaming reply doesn't spend the quota.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !Object.keys(changes).some((k) => k.startsWith('rec:'))) return;
  chrome.alarms.get(SUMMARY_ALARM).then((a) => a || chrome.alarms.create(SUMMARY_ALARM, { delayInMinutes: 1 }));
});
chrome.alarms.onAlarm.addListener((a) => a.name === SUMMARY_ALARM && writeSummary());
chrome.runtime.onInstalled.addListener(() => deviceId().then(writeSummary));
chrome.runtime.onStartup.addListener(() => writeSummary());
