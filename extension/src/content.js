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
  // The running totals, kept incrementally so a tick costs the replies in flight, not the
  // whole history. `loaded` stays false until storage has been read, so we never show a
  // partial total.
  const ledger = ns.createLedger();
  let loaded = false;
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

  // Ids of the records the previous page left unfinished, newest first once sorted. One of
  // them may still be running on the server, and this page can take it over (onResume).
  let resumable = [];
  const RESUME_WITHIN_MS = 10 * 60 * 1000;

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
    resumable = orphans.map((r) => r.id);
    const update = {};
    for (const r of orphans) update['rec:' + r.id] = { ...r, outcome: 'pending', closedAt: Date.now(), updatedMs: Date.now() };
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
        rec.updatedMs = Date.now(); // sync: the newest copy of a record wins (spec §13)
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

  // Signals arrive only on the private channel main-world.js hands us at document_start
  // (spec §12): never from window messages, which any page script could post.
  function onSignalEvent(e) {
    let msg;
    try {
      msg = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (msg?.__aih !== 1 || typeof msg.type !== 'string') return;
    msg = sane(msg, Date.now());
    if (!msg) return;
    if (ready) handle(msg);
    else inbox.push(msg);
  }

  // A signal's times must be recent and not in the future: the hook sends them as it sees
  // them, so anything else is a forgery or a broken clock, and is dropped or clamped.
  const RECENT_MS = 10 * 60 * 1000;
  function sane(msg, now) {
    for (const k of ['t', 'lastChunk']) {
      if (msg[k] == null) continue;
      if (typeof msg[k] !== 'number' || !Number.isFinite(msg[k])) return null;
      if (msg[k] > now) msg[k] = now;
    }
    if (msg.t != null && msg.t < now - RECENT_MS) return null;
    return msg;
  }

  // The handshake: main-world.js fires a bubbling hello from its channel element; we keep the
  // element. Whichever script runs second completes it, synchronously, before any page script.
  // A copy injected later (an extension update) finds the page already loading scripts and
  // does not pair, since a page could answer in the hook's place; that tab counts again after
  // a refresh.
  let channel = null;
  const onHello = (e) => {
    if (channel || !e.target || e.target === document) return;
    channel = e.target;
    channel.addEventListener('aihours:signal', onSignalEvent);
    channel.dispatchEvent(new CustomEvent('aihours:ack'));
    unpair();
  };
  const unpair = () => document.removeEventListener('aihours:hello', onHello, true);

  function handle(msg) {
    if (msg.type === 'conversation') return onConversation(msg);
    if (msg.type === 'resume') return onResume(msg);
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

  // This page sees a reply running that it did not send: the refresh happened mid-reply.
  // Hand it the newest record the previous page left, if that one is recent and still open.
  // No orphan means the reply was sent from elsewhere, and it is not ours to count.
  function onResume({ localId, t }) {
    const candidates = resumable
      .map((id) => records.get('rec:' + id))
      .filter((r) => r && r.end == null && !r.recovered && t - (r.lastSeen ?? r.start) < RESUME_WITHIN_MS)
      .sort((a, b) => b.start - a.start);
    const rec = candidates[0];
    if (!rec) return;
    resumable = resumable.filter((id) => id !== rec.id);
    tracker.adopt(localId, rec, t);
  }

  // Chat pages change the DOM many times a second while a reply streams, so the stop-button
  // lookup runs at most once per CHECK_MS, not once per change. A change is stamped with the
  // time of the first mutation in its batch, so batching delays the check, never the time.
  const CHECK_MS = 100;
  let lastVisible = false;
  let pendingSince = null;
  function checkStopButton() {
    const since = pendingSince;
    pendingSince = null;
    const visible = !!document.querySelector(site.stopButton);
    if (visible === lastVisible) return;
    lastVisible = visible;
    tracker?.domRaw(visible, since);
    // Times come from domRaw, so throttled timers in background tabs only delay, never skew.
    setTimeout(() => tracker?.confirm(Date.now()), 350);
  }
  const observer = new MutationObserver(() => {
    if (pendingSince !== null) return;
    pendingSince = Date.now();
    setTimeout(checkStopButton, CHECK_MS);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('aihours:hello', onHello, true);
    document.addEventListener('DOMContentLoaded', unpair, { once: true });
    document.dispatchEvent(new CustomEvent('aihours:ready'));
  }
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['data-testid'],
  });

  const overlay = ns.createOverlay(document);
  // Unpaired once the page is past document_start means this tab cannot count new replies
  // (usually: injected by an extension update into an open tab). Say so on the pill.
  const checkPaired = () => overlay.setStale(!channel);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkPaired, { once: true });
  else checkPaired();
  let ticker = null;

  function remember(key, rec) {
    if (rec) records.set(key, rec), ledger.set(key, rec, Date.now());
    else records.delete(key), ledger.delete(key);
  }

  // Other installs' totals (other computers, earlier installs), from Chrome sync (spec §13).
  // Until this install knows its own device id it can't tell its own summary apart from the
  // others, so it counts none rather than itself twice.
  let synced = { me: null, summaries: [], extraMs: 0 };
  const EMPTY = { ms: 0, working: 0, sites: [] };
  async function loadSynced() {
    try {
      const [l, sy] = await Promise.all([chrome.storage.local.get(['device:id', 'auth:user']), chrome.storage.sync.get(null)]);
      const me = l['device:id'] ? { device: l['device:id'], sub: l['auth:user']?.sub ?? null } : null;
      const summaries = me ? Object.entries(sy).filter(([k]) => k.startsWith('sum:')).map(([, v]) => v) : [];
      synced = { me, summaries, extraMs: me ? ns.combine(EMPTY, summaries, me).ms : 0 };
    } catch {
      synced = { me: null, summaries: [], extraMs: 0 }; // no sync storage: this install's own totals only
    }
    render();
  }

  function render() {
    if (!loaded) return;
    // Every tab's open replies, not just this one's: two tabs working means the count
    // genuinely moves twice as fast, and ×N says so (spec §6b).
    const { ms, working } = ledger.live(Date.now());
    const { me, summaries, extraMs } = synced;
    overlay.render(ms + extraMs, working, () =>
      me ? ns.combine(ledger.breakdown(Date.now()), summaries, me) : ledger.breakdown(Date.now()));
  }

  function onStorage(changes, area) {
    if (area === 'sync' || (area === 'local' && ('device:id' in changes || 'auth:user' in changes))) loadSynced();
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
    for (const key of Object.keys(all)) if (key.startsWith('rec:') && !records.has(key)) remember(key, all[key]);
    loaded = true;
    render();
    loadSynced();

    tracker = buildTracker();
    ticker = setInterval(() => tracker.tick(Date.now()), 5000);
    await closeOrphans(Object.values(all));
    ready = true;
    for (const msg of inbox.splice(0)) handle(msg);
    clock = setInterval(render, 1000);
  });

  function stop() {
    channel?.removeEventListener('aihours:signal', onSignalEvent);
    unpair();
    chrome.storage.onChanged.removeListener(onStorage);
    observer.disconnect();
    clearInterval(ticker);
    clearInterval(clock);
    overlay.remove();
    if (ns.stopContent === stop) delete ns.stopContent;
  }
  ns.stopContent = stop;
})();
