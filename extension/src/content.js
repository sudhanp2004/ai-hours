// ISOLATED world. Wires the tracker to main-world signals, the stop button and storage.
(function () {
  const ns = globalThis.__aiHours;
  ns.stopContent?.(); // an older copy may still be running after an extension update
  const site = ns.chatgpt;

  const tracker = ns.createTracker({
    site: site.site,
    newId: () => crypto.randomUUID(),
    write(rec) {
      try {
        chrome.storage.local.set({ ['rec:' + rec.id]: rec }).catch(stop);
      } catch {
        stop(); // extension context invalidated; the re-injected copy takes over
      }
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

  function stop() {
    window.removeEventListener('message', onMessage);
    observer.disconnect();
    clearInterval(ticker);
    if (ns.stopContent === stop) delete ns.stopContent;
  }
  ns.stopContent = stop;
})();
