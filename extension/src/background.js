// Stateless. Content scripts in already-open tabs are orphaned by an install/update,
// so inject the manifest's scripts into them again.
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
