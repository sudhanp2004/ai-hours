// Stateless. Its jobs are events in and events out; nothing is held between them that
// storage doesn't hold:
//   1. re-inject scripts into already-open tabs after an install/update,
//   2. tell the world a tab is gone, so its unfinished replies stop counting at once,
//   3. back the totals up through Chrome sync, automatically (spec §13).
// Closed-tab replies are finished later from ChatGPT's own conversation data (spec §6b).
// reconcile.js is plain JS with no exports, so this import is for its side effect only:
// the same file is also loaded as a classic script by the content script.
import './reconcile.js';
import './manifest-match.js';
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

// Optional full-history sign-in (Google + Neon, spec §13) is not part of this release: it is
// built and tested (src/sync.js, and the wiring in git history at commit 2124ba6) but kept out
// until it is verified end to end, so the extension sends nothing to any server of ours.
const local = chrome.storage.local;

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
    const [device, all] = [await deviceId(), await local.get(null)];
    const records = Object.entries(all).filter(([k]) => k.startsWith('rec:')).map(([, r]) => r);
    const summary = globalThis.__aiHours.summaryOf(records, Date.now(), { device, sub: null });
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
// ---- One-time import of history saved from an earlier copy of the extension, e.g. an unpacked
// copy loaded before its id changed (chrome.storage belongs to an id, so a new id starts empty).
// Put the records, as {"rec:<id>": record}, in extension/import/legacy-history.json; it is kept
// out of git and out of the store package. Never overwrites a record already here.
async function importLegacy() {
  if ((await local.get('import:legacyDone'))['import:legacyDone']) return;
  let data;
  try {
    const res = await fetch(chrome.runtime.getURL('import/legacy-history.json'));
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return; // no file: the normal case
  }
  const keys = Object.keys(data ?? {}).filter((k) => k.startsWith('rec:') && data[k] && typeof data[k] === 'object');
  const here = await local.get(keys);
  const add = {};
  for (const k of keys) if (!here[k]) add[k] = { ...data[k], tabId: null, updatedMs: data[k].updatedMs ?? Date.now() };
  if (Object.keys(add).length) await local.set(add);
  await local.set({ 'import:legacyDone': Date.now() });
}

chrome.runtime.onInstalled.addListener(() => importLegacy().then(deviceId).then(writeSummary));
chrome.runtime.onStartup.addListener(() => importLegacy().then(writeSummary));
