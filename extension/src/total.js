// Turns stored records into the one number. Pure.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});
  const IN_PROGRESS_MS = 60 * 60 * 1000;
  const HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  // Normal inter-chunk silences are up to ~6 s (spike), so 30 s is generous but finite:
  // a browser that quit or crashed announces nothing, so liveness has to expire.
  const LIVE_STALE_MS = 30 * 1000;

  ns.summarize = function summarize(records, now) {
    let totalMs = 0;
    let unknown = 0;
    for (const r of records) {
      // A recovered record's duration is a span of two clocks, so it can't be end - start.
      if (r.recovered) totalMs += Math.max(0, r.recovered.durationMs);
      else if (r.end != null) totalMs += Math.max(0, r.end - r.start);
      else if (now - r.start > IN_PROGRESS_MS) unknown++;
    }
    return { totalMs, unknown };
  };

  // Saved total plus every reply still gaining time, in any tab. `working` is how many
  // replies that is, so the pill can show ×N (spec §6b).
  ns.liveTotal = function liveTotal(records, now) {
    let ms = 0;
    let working = 0;
    for (const r of records) {
      if (r.recovered) ms += Math.max(0, r.recovered.durationMs);
      else if (r.end != null) ms += Math.max(0, r.end - r.start);
      // A pending record's tab is gone: we can no longer see the work, so we don't count it.
      else if (r.outcome === 'pending') continue;
      else if (now - (r.lastSeen ?? r.start) > LIVE_STALE_MS) continue;
      else ms += Math.max(0, now - r.start), working++;
    }
    return { ms, working };
  };

  ns.hasRecentHealthFlags = (records, now) =>
    records.some((r) => r.flags?.length > 0 && now - r.start < HEALTH_WINDOW_MS);

  ns.formatClock = function formatClock(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h) return `${h}h ${m}m ${s % 60}s`;
    if (m) return `${m}m ${s % 60}s`;
    return `${s}s`;
  };

  ns.formatDuration = function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s % 60}s`;
    return `${s}s`;
  };
})(globalThis);
