(async function () {
  const ns = globalThis.__aiHours;
  const style = document.createElement('style');
  style.textContent = ns.BREAKDOWN_CSS;
  document.head.appendChild(style);

  const records = new Map();
  const all = await chrome.storage.local.get(null);
  for (const k of Object.keys(all)) if (k.startsWith('rec:')) records.set(k, all[k]);

  const panel = ns.createBreakdownPanel(document.getElementById('breakdown'));
  // The same live count as the pill, so the two never disagree, ticking while it is open.
  function render() {
    const data = ns.breakdown([...records.values()], Date.now());
    document.getElementById('total').textContent = ns.formatClock(data.ms);
    panel.update(data);
  }
  render();
  setInterval(render, 1000);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, c] of Object.entries(changes)) {
      if (!k.startsWith('rec:')) continue;
      if (c.newValue) records.set(k, c.newValue);
      else records.delete(k);
    }
    render();
  });

  const now = Date.now();
  const { unknown } = ns.summarize([...records.values()], now);
  if (unknown) show('unknown', `+ ${unknown} response${unknown === 1 ? '' : 's'} with unknown duration`);
  if (ns.hasRecentHealthFlags([...records.values()], now)) show('health');

  function show(id, text) {
    const el = document.getElementById(id);
    if (text) el.textContent = text;
    el.hidden = false;
  }
})();
