(async function () {
  const ns = globalThis.__aiHours;
  const style = document.createElement('style');
  style.textContent = ns.BREAKDOWN_CSS;
  document.head.appendChild(style);

  const records = new Map();
  const ledger = ns.createLedger(); // the same incremental count the pill uses
  const all = await chrome.storage.local.get(null);
  for (const k of Object.keys(all)) if (k.startsWith('rec:')) records.set(k, all[k]), ledger.set(k, all[k], Date.now());

  const panel = ns.createBreakdownPanel(document.getElementById('breakdown'));
  // Other installs' totals from Chrome sync, added the same way the pill adds them (spec §13).
  let synced = { me: null, summaries: [] };
  async function loadSynced() {
    try {
      const [l, sy] = await Promise.all([chrome.storage.local.get(['device:id', 'auth:user']), chrome.storage.sync.get(null)]);
      const me = l['device:id'] ? { device: l['device:id'], sub: l['auth:user']?.sub ?? null } : null;
      synced = { me, summaries: me ? Object.entries(sy).filter(([k]) => k.startsWith('sum:')).map(([, v]) => v) : [] };
    } catch {
      synced = { me: null, summaries: [] };
    }
    render();
  }
  // The same live count as the pill, so the two never disagree, ticking while it is open.
  function render() {
    const own = ledger.breakdown(Date.now());
    const data = synced.me ? ns.combine(own, synced.summaries, synced.me) : own;
    document.getElementById('total').textContent = ns.formatClock(data.ms);
    panel.update(data);
  }
  render();
  loadSynced();
  setInterval(render, 1000);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' || (area === 'local' && ('device:id' in changes || 'auth:user' in changes))) loadSynced();
    if (area !== 'local') return;
    for (const [k, c] of Object.entries(changes)) {
      if (!k.startsWith('rec:')) continue;
      if (c.newValue) records.set(k, c.newValue), ledger.set(k, c.newValue, Date.now());
      else records.delete(k), ledger.delete(k);
    }
    render();
  });

  const now = Date.now();
  const { partial } = ns.summarize([...records.values()], now);
  if (partial) {
    const n = `${partial} repl${partial === 1 ? 'y was' : 'ies were'}`;
    show('unknown', `${n} only counted while you watched: the tab closed mid-reply. Reopening the chat finishes them on ChatGPT and Perplexity.`);
  }
  if (ns.hasRecentHealthFlags([...records.values()], now)) show('health');

  function show(id, text) {
    const el = document.getElementById(id);
    if (text) el.textContent = text;
    el.hidden = false;
  }

  // ---- sign-in and sync (spec §13). The buttons ask the service worker, which does the work.
  const $ = (id) => document.getElementById(id);
  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  };
  async function renderAccount() {
    const got = await chrome.storage.local.get(['auth:user', 'sync:status']);
    const signedIn = !!got['auth:user'];
    const st = got['sync:status'] ?? { state: signedIn ? 'pending' : 'signed-out' };
    const waiting = st.pending ? ` · ${st.pending} waiting` : '';
    const text = !signedIn
      ? 'Keeps every reply, not just totals, even without Chrome sync. Only the times are uploaded, never what was said.'
      : st.state === 'ok' ? `Synced ${ago(st.lastSync ?? st.at)}${waiting}`
      : st.state === 'offline' ? `Offline. It will sync when you're back online${waiting}`
      : st.state === 'needs-sign-in' ? 'Sign in again to keep syncing.'
      : st.state === 'error' ? `Sync didn't go through; it will retry${waiting}`
      : 'Syncing…';
    $('acct-text').textContent =
      !signedIn && st.state === 'sign-in-failed' ? `Sign-in didn't work: ${st.error}` : text;
    // The everyday state is one quiet line: Chrome sync backs the totals up with no setup.
    // The optional full-history sign-in stays folded away until asked for, or in use.
    $('backup-line').textContent = signedIn
      ? 'Full history backed up to your Google account.'
      : 'Backed up with Chrome sync: your totals follow you to your other computers.';
    $('more').hidden = signedIn;
    if (signedIn || st.state === 'sign-in-failed') $('account').hidden = false;
    $('signin').hidden = signedIn && st.state !== 'needs-sign-in';
    for (const id of ['syncnow', 'signout', 'wipe']) $(id).hidden = !signedIn;
  }
  // Every outcome says something: a silent button is the worst kind of failure.
  async function act(type, button) {
    button.disabled = true;
    if (type === 'sync:signIn') $('acct-text').textContent = 'Opening Google sign-in…';
    let res;
    try {
      res = await chrome.runtime.sendMessage({ __aih: 1, type });
    } catch (e) {
      res = { ok: false, error: `AI Hours' background worker didn't answer (${e?.message ?? e})` };
    } finally {
      button.disabled = false;
    }
    await renderAccount();
    if (!res) res = { ok: false, error: 'no answer from the background worker' };
    if (!res.ok) $('acct-text').textContent = `That didn't work: ${res.error}`;
  }
  $('signin').addEventListener('click', (e) => act('sync:signIn', e.currentTarget));
  $('syncnow').addEventListener('click', (e) => act('sync:now', e.currentTarget));
  $('signout').addEventListener('click', (e) => act('sync:signOut', e.currentTarget));
  $('more').addEventListener('click', () => {
    $('account').hidden = !$('account').hidden;
  });
  $('wipe').addEventListener('click', () => ($('confirm').hidden = false));
  $('wipe-no').addEventListener('click', () => ($('confirm').hidden = true));
  $('wipe-yes').addEventListener('click', async (e) => {
    await act('sync:wipe', e.currentTarget);
    $('confirm').hidden = true;
  });
  chrome.storage.onChanged.addListener((c, area) => area === 'local' && ('auth:user' in c || 'sync:status' in c) && renderAccount());
  renderAccount();
  // Opening the popup is a good moment to catch up.
  chrome.storage.local.get('auth:user').then((g) => g['auth:user'] && chrome.runtime.sendMessage({ __aih: 1, type: 'sync:now' }).catch(() => {}));
})();
