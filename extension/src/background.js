// Stateless. Two jobs, both events in and events out; nothing is held between them:
//   1. re-inject scripts into already-open tabs after an install/update,
//   2. tell the world a tab is gone, so its unfinished replies stop counting at once.
// Closed-tab replies are finished later from ChatGPT's own conversation data (spec §6b).
// reconcile.js is plain JS with no exports, so this import is for its side effect only:
// the same file is also loaded as a classic script by the content script.
import './reconcile.js';

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install' && reason !== 'update') return;
  const { content_scripts: scripts } = chrome.runtime.getManifest();
  const tabs = await chrome.tabs.query({ url: scripts.flatMap((s) => s.matches) });
  for (const tab of tabs) {
    for (const s of scripts) {
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
