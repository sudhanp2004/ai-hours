// ISOLATED world. Wires the tracker to main-world signals, the stop button, storage, the
// on-page counter, and closed-tab recovery.
(function () {
  const ns = globalThis.__aiHours;
  ns.stopContent?.(); // an older copy may still be running after an extension update
  const site = ns.site;

  // The manifest decides which adapter loads here, so this is belt-and-braces: if the
  // adapter and the domain ever disagree, do nothing rather than misattribute a reply.
  // Silence is recoverable; a wrong number is not.
  if (!site?.hosts?.some((h) => location.hostname === h || location.hostname.endsWith('.' + h))) {
    return;
  }

  let tabId = null;
  const records = new Map(); // storage key -> record
  let savedMs = null; // null until storage has been read, so we never show a partial total
  let tracker = null;

  // The worker replies with sender.tab.id, so it has to be asked once per page.
  function askTabId() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ __aih: 1, type: 'tabId' }, (r) => {
          if (chrome.runtime.lastError || !r?.tabId) resolve(null);
          else resolve(r.tabId);
        });
      } catch {
        resolve(null);
      }
    });
  }

  // A page that loads mid-reply (reload, or ChatGPT's own navigation) leaves records from
  // the previous document behind. They can no longer be watched, so treat them as a close:
  // at most ~2 s early, because a streaming reply refreshes its sign of life every 2 s.
  // `before` is the snapshot taken before this page's tracker existed, so a record this
  // page creates can never be mistaken for a leftover.
  async function closeOrphans(before) {
    if (tabId === null) return;
    const orphans = before.filter(
      (r) => r.tabId === tabId && r.end == null && !r.recovered && r.outcome !== 'pending',
    );
    if (!orphans.length) return;
    const update = {};
    for (const r of orphans) update['rec:' + r.id] = { ...r, outcome: 'pending', closedAt: Date.now() };
    try {
      await chrome.storage.local.set(update);
    } catch (e) {
      console.warn('AI Hours: could not close orphaned records', e);
    }
  }

  function buildTracker() {
    const t = ns.createTracker({
      site: site.site,
      tabId,
      newId: () => crypto.randomUUID(),
      write(rec) {
        // Orphaned by an extension update: the re-injected copy takes over.
        if (!chrome.runtime?.id) return stop();
        // Count it immediately, so the counter never dips between the stream ending and the
        // storage change event arriving.
        remember('rec:' + rec.id, structuredClone(rec));
        // Any other failure is logged, never fatal: stopping would silently freeze the count.
        chrome.storage.local.set({ ['rec:' + rec.id]: rec }).catch((e) =>
          console.warn('AI Hours: could not save record', e));
      },
    });
    return t;
  }

  // Nothing is measured until the tab id is known and the leftovers are settled, so signals
  // that arrive in that window are held rather than dropped or miscounted.
  let ready = false;
  const inbox = [];

  function onMessage(e) {
    if (e.source !== window || e.data?.__aih !== 1) return;
    if (ready) handle(e.data);
    else inbox.push(e.data);
  }

  function handle(msg) {
    if (msg.type === 'conversation') return onConversation(msg);
    tracker.onSignal(msg);
  }

  // Opening a chat loads its conversation. If one of our records lost its tab (closed,
  // reloaded, or the browser quit), finish it now from the server's own timestamps (spec §6b).
  function onConversation({ turns }) {
    if (!Array.isArray(turns)) return;
    const done = [];
    const now = Date.now();
    for (const rec of records.values()) {
      // Only records no tab is measuring. A reply still streaming in another tab is that
      // tab's to finish, and matching it here would rewrite a record still being measured.
      if (!ns.isRecoverable(rec, now)) continue;
      const turn = ns.matchTurn(rec, turns);
      if (turn) done.push(ns.recover(rec, turn, now));
    }
    if (!done.length) return;
    const update = {};
    for (const r of done) {
      remember('rec:' + r.id, structuredClone(r));
      update['rec:' + r.id] = r;
    }
    chrome.storage.local.set(update).catch((e) => console.warn('AI Hours: could not save recovered record', e));
  }

  let lastVisible = false;
  const observer = new MutationObserver(() => {
    const visible = !!document.querySelector(site.stopButton);
    if (visible === lastVisible) return;
    lastVisible = visible;
    tracker?.domRaw(visible, Date.now());
    // Times come from domRaw, so throttled timers in background tabs only delay, never skew.
    setTimeout(() => tracker?.confirm(Date.now()), 350);
  });

  window.addEventListener('message', onMessage);
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['data-testid'],
  });

  const overlay = ns.createOverlay(document);
  let ticker = null;

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
    // Every tab's open replies, not just this one's: two tabs working means the count
    // genuinely moves twice as fast, and ×N says so (spec §6b).
    const { ms, working } = ns.liveTotal([...records.values()], Date.now());
    overlay.render(ms, working, () => ns.breakdown([...records.values()], Date.now()));
  }

  function onStorage(changes, area) {
    if (area !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if (key.startsWith('rec:')) remember(key, change.newValue);
    }
    render();
  }

  chrome.storage.onChanged.addListener(onStorage);
  let clock = null;

  // Start order matters: read what is stored, settle the previous document's leftovers,
  // and only then let this page's signals through. In that order nothing this page creates
  // can be mistaken for a leftover, and no signal is measured against the wrong tab id.
  askTabId().then(async (id) => {
    tabId = id;
    const all = await chrome.storage.local.get(null);
    // A record written while this read was in flight is newer than the stored copy.
    for (const key of Object.keys(all)) if (key.startsWith('rec:') && !records.has(key)) records.set(key, all[key]);
    recompute();
    render();

    tracker = buildTracker();
    ticker = setInterval(() => tracker.tick(Date.now()), 5000);
    await closeOrphans(Object.values(all));
    ready = true;
    for (const msg of inbox.splice(0)) handle(msg);
    clock = setInterval(render, 1000);
  });

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
