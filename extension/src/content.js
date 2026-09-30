// ISOLATED world. Wires the tracker to main-world signals, the stop button, storage and the
// on-page counter.
(function () {
  const ns = globalThis.__aiHours;
  ns.stopContent?.(); // an older copy may still be running after an extension update
  const site = ns.chatgpt;

  const tracker = ns.createTracker({
    site: site.site,
    newId: () => crypto.randomUUID(),
    write(rec) {
      // Orphaned by an extension update: the re-injected copy takes over.
      if (!chrome.runtime?.id) return stop();
      // Count it immediately, so the counter never dips between the stream ending and the
      // storage change event arriving.
      remember('rec:' + rec.id, structuredClone(rec));
      // Any other failure is logged, never fatal: stopping would silently freeze the count.
      chrome.storage.local.set({ ['rec:' + rec.id]: rec }).catch((e) => console.warn('AI Hours: could not save record', e));
    },
  });

  function onMessage(e) {
    if (e.source !== window || e.data?.__aih !== 1) return;
    tracker.onSignal(e.data);
  }

  let lastVisible = false;
  const observer = new MutationObserver(() => {
    const visible = !!document.querySelector(site.stopButton);
    if (visible === lastVisible) return;
    lastVisible = visible;
    tracker.domRaw(visible, Date.now());
    // Times come from domRaw, so throttled timers in background tabs only delay, never skew.
    setTimeout(() => tracker.confirm(Date.now()), 350);
  });

  window.addEventListener('message', onMessage);
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['data-testid'],
  });
  const ticker = setInterval(() => tracker.tick(Date.now()), 5000);

  // Live counter: saved total (all tabs, kept in sync with storage) + this tab's open streams.
  const overlay = ns.createOverlay(document);
  const records = new Map(); // storage key -> record
  let savedMs = null; // null until storage has been read, so we never show a partial total

  function remember(key, rec) {
    if (rec) records.set(key, rec);
    else records.delete(key);
    if (savedMs !== null) recompute();
  }

  function recompute() {
    savedMs = ns.summarize([...records.values()], Date.now()).totalMs;
  }

  function render() {
    if (savedMs === null) return;
    overlay.render(savedMs + tracker.liveMs(Date.now()), tracker.isLive());
  }

  function onStorage(changes, area) {
    if (area !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if (key.startsWith('rec:')) remember(key, change.newValue);
    }
    render();
  }

  chrome.storage.local.get(null).then((all) => {
    // A record written while this read was in flight is newer than the stored copy.
    for (const key of Object.keys(all)) if (key.startsWith('rec:') && !records.has(key)) records.set(key, all[key]);
    recompute();
    render();
  });
  chrome.storage.onChanged.addListener(onStorage);
  const clock = setInterval(render, 1000);

  function stop() {
    window.removeEventListener('message', onMessage);
    chrome.storage.onChanged.removeListener(onStorage);
    observer.disconnect();
    clearInterval(ticker);
    clearInterval(clock);
    overlay.remove();
    if (ns.stopContent === stop) delete ns.stopContent;
  }
  ns.stopContent = stop;
})();
