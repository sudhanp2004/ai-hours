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
      const [l, sy] = await Promise.all([chrome.storage.local.get(['device:id']), chrome.storage.sync.get(null)]);
      const me = l['device:id'] ? { device: l['device:id'], sub: null } : null;
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
    if (area === 'sync' || (area === 'local' && 'device:id' in changes)) loadSynced();
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

})();
