(async function () {
  const ns = globalThis.__aiHours;
  const all = await chrome.storage.local.get(null);
  const records = Object.keys(all).filter((k) => k.startsWith('rec:')).map((k) => all[k]);
  const now = Date.now();
  const { totalMs, unknown } = ns.summarize(records, now);

  document.getElementById('total').textContent = ns.formatDuration(totalMs);
  if (unknown) show('unknown', `+ ${unknown} response${unknown === 1 ? '' : 's'} with unknown duration`);
  if (ns.hasRecentHealthFlags(records, now)) show('health');

  function show(id, text) {
    const el = document.getElementById(id);
    if (text) el.textContent = text;
    el.hidden = false;
  }
})();
