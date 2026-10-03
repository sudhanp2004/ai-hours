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

  // What one record adds to the live count right now: null if nothing, else its ms and
  // whether it is still gaining time.
  function liveShare(r, now) {
    if (r.recovered) return { ms: Math.max(0, r.recovered.durationMs), live: false };
    if (r.end != null) return { ms: Math.max(0, r.end - r.start), live: false };
    // A pending record's tab is gone: we can no longer see the work, so we don't count it.
    if (r.outcome === 'pending') return null;
    if (now - (r.lastSeen ?? r.start) > LIVE_STALE_MS) return null;
    return { ms: Math.max(0, now - r.start), live: true };
  }

  // Saved total plus every reply still gaining time, in any tab. `working` is how many
  // replies that is, so the pill can show ×N (spec §6b).
  ns.liveTotal = function liveTotal(records, now) {
    let ms = 0;
    let working = 0;
    for (const r of records) {
      const s = liveShare(r, now);
      if (s) (ms += s.ms), (working += s.live ? 1 : 0);
    }
    return { ms, working };
  };

  // The same count as liveTotal, split by site and then by model (spec §11, Breakdown).
  // Records from before sites existed were all ChatGPT; before models were recorded, the
  // model is null.
  ns.breakdown = function breakdown(records, now) {
    const sites = new Map();
    let ms = 0;
    let working = 0;
    for (const r of records) {
      const s = liveShare(r, now);
      if (!s) continue;
      const site = r.site || 'chatgpt';
      const model = r.server?.model ?? null;
      let row = sites.get(site);
      if (!row) sites.set(site, (row = { site, ms: 0, working: 0, models: new Map() }));
      let m = row.models.get(model);
      if (!m) row.models.set(model, (m = { model, ms: 0, working: 0 }));
      const w = s.live ? 1 : 0;
      ms += s.ms, working += w;
      row.ms += s.ms, row.working += w;
      m.ms += s.ms, m.working += w;
    }
    const byMs = (a, b) => b.ms - a.ms;
    return {
      ms,
      working,
      sites: [...sites.values()].map((row) => ({ ...row, models: [...row.models.values()].sort(byMs) })).sort(byMs),
    };
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
