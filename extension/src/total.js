// Turns stored records into the one number. Pure.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});
  const IN_PROGRESS_MS = 60 * 60 * 1000;
  const HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

  ns.summarize = function summarize(records, now) {
    let totalMs = 0;
    let unknown = 0;
    for (const r of records) {
      if (r.end != null) totalMs += Math.max(0, r.end - r.start);
      else if (now - r.start > IN_PROGRESS_MS) unknown++;
    }
    return { totalMs, unknown };
  };

  ns.hasRecentHealthFlags = (records, now) =>
    records.some((r) => r.flags?.length > 0 && now - r.start < HEALTH_WINDOW_MS);

  ns.formatDuration = function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s % 60}s`;
    return `${s}s`;
  };
})(globalThis);
