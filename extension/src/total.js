// Turns stored records into the one number. Pure.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});
  const IN_PROGRESS_MS = 60 * 60 * 1000;
  const HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  // Normal inter-chunk silences are up to ~6 s (spike), so 30 s is generous but finite:
  // a browser that quit or crashed announces nothing, so liveness has to expire.
  const LIVE_STALE_MS = 30 * 1000;
  // Tamper resistance (spec §12): the longest single reply that counts. Deep research runs
  // for tens of minutes; nothing real runs for hours. Applied to every record however it
  // was stored, so a forged or broken record cannot add more than this.
  const MAX_REPLY_MS = 3 * 60 * 60 * 1000;
  ns.MAX_REPLY_MS = MAX_REPLY_MS;
  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const cap = (ms) => Math.min(Math.max(0, ms), MAX_REPLY_MS);
  // A record that can't be real counts nothing: non-numbers, a start in the future, an end
  // before its start, or a recovered duration that isn't a number.
  const valid = (r, now) =>
    !!r && typeof r === 'object' && num(r.start) && r.start <= now + 60 * 1000 &&
    (r.end == null || (num(r.end) && r.end >= r.start)) &&
    (!r.recovered || num(r.recovered.durationMs)) &&
    (r.lastSeen == null || num(r.lastSeen));

  // The time a reply was seen working, up to its last sign of life. A reply that lost its tab
  // (refresh, close, quit) keeps this much: measured, never guessed (changed 2026-10-03).
  const watched = (r) => Math.max(0, (r.lastSeen ?? r.start) - r.start);

  ns.summarize = function summarize(records, now) {
    let totalMs = 0;
    let partial = 0;
    for (const r of records) {
      if (!valid(r, now)) continue;
      // A recovered record's duration is a span of two clocks, so it can't be end - start.
      if (r.recovered) totalMs += cap(r.recovered.durationMs);
      else if (r.end != null) totalMs += cap(r.end - r.start);
      else {
        totalMs += cap(watched(r));
        // Past an hour it is not still running: only the watched part of it was counted.
        if (now - r.start > IN_PROGRESS_MS) partial++;
      }
    }
    return { totalMs, partial };
  };

  // What one record adds to the live count right now: null if nothing, else its ms and
  // whether it is still gaining time.
  function liveShare(r, now) {
    if (!valid(r, now)) return null;
    if (r.recovered) return { ms: cap(r.recovered.durationMs), live: false };
    if (r.end != null) return { ms: cap(r.end - r.start), live: false };
    // A pending record's tab is gone, and a silent one's browser may be: neither can be
    // watched any further, so each keeps what was watched and gains nothing more.
    if (r.outcome === 'pending' || now - (r.lastSeen ?? r.start) > LIVE_STALE_MS) return { ms: cap(watched(r)), live: false };
    return { ms: cap(now - r.start), live: true };
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
      if (!s || (!s.ms && !s.live)) continue; // nothing to show for it
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

  // The same count as liveTotal and breakdown, kept incrementally for the pill, which asks
  // every second. A finished record's share never changes, so it is added once when stored
  // and taken back out only if the record is rewritten. Each tick then looks only at the few
  // records that can still be gaining time ("active"); one that has gone stale is settled
  // at its watched time, since only a new write (set) can bring it back.
  ns.createLedger = function createLedger() {
    const settled = new Map(); // key -> {site, model, ms}, for records whose share is final
    const active = new Map(); // key -> record that may still be live
    const sums = new Map(); // site -> {ms, n, models: Map(model -> {ms, n})}
    let total = 0;

    function addSettled(key, site, model, ms) {
      if (!ms) return; // nothing to show for it, the same rule breakdown applies
      settled.set(key, { site, model, ms });
      total += ms;
      let row = sums.get(site);
      if (!row) sums.set(site, (row = { ms: 0, n: 0, models: new Map() }));
      let m = row.models.get(model);
      if (!m) row.models.set(model, (m = { ms: 0, n: 0 }));
      row.ms += ms, row.n++, m.ms += ms, m.n++;
    }

    function removeSettled(key) {
      const s = settled.get(key);
      if (!s) return;
      settled.delete(key);
      total -= s.ms;
      const row = sums.get(s.site);
      const m = row.models.get(s.model);
      row.ms -= s.ms, row.n--, m.ms -= s.ms, m.n--;
      if (!m.n) row.models.delete(s.model);
      if (!row.n) sums.delete(s.site);
    }

    // Where a record belongs right now: settled at a final share, active, or nowhere.
    function place(key, r, now) {
      const share = liveShare(r, now);
      if (!share) {
        // Invalid only because it starts in the future: time may make it valid.
        if (r && typeof r === 'object' && num(r.start) && r.start > now + 60 * 1000) active.set(key, r);
        return;
      }
      if (share.live || (r.end == null && !r.recovered && r.outcome !== 'pending' && r.start > now)) active.set(key, r);
      else addSettled(key, r.site || 'chatgpt', r.server?.model ?? null, share.ms);
    }

    function set(key, r, now) {
      removeSettled(key);
      active.delete(key);
      place(key, r, now);
    }

    function remove(key) {
      removeSettled(key);
      active.delete(key);
    }

    // Shares of the active records at `now`; any that turned final are settled as we go.
    function activeShares(now) {
      const out = [];
      for (const [key, r] of active) {
        const s = liveShare(r, now);
        if (s && s.live) out.push({ r, s });
        else if (s || !(num(r.start) && r.start > now + 60 * 1000)) (active.delete(key), place(key, r, now));
      }
      return out;
    }

    // activeShares runs first: it may settle records, which changes the settled sums.
    function live(now) {
      const shares = activeShares(now);
      let ms = total;
      for (const { s } of shares) ms += s.ms;
      return { ms, working: shares.length };
    }

    function breakdown(now) {
      const shares = activeShares(now);
      const sites = new Map();
      for (const [site, row] of sums) {
        const models = new Map();
        for (const [model, m] of row.models) models.set(model, { model, ms: m.ms, working: 0 });
        sites.set(site, { site, ms: row.ms, working: 0, models });
      }
      let ms = total;
      let working = 0;
      for (const { r, s } of shares) {
        const site = r.site || 'chatgpt';
        const model = r.server?.model ?? null;
        let row = sites.get(site);
        if (!row) sites.set(site, (row = { site, ms: 0, working: 0, models: new Map() }));
        let m = row.models.get(model);
        if (!m) row.models.set(model, (m = { model, ms: 0, working: 0 }));
        ms += s.ms, working++, row.ms += s.ms, row.working++, m.ms += s.ms, m.working++;
      }
      const byMs = (a, b) => b.ms - a.ms;
      return {
        ms,
        working,
        sites: [...sites.values()].map((row) => ({ ...row, models: [...row.models.values()].sort(byMs) })).sort(byMs),
      };
    }

    return { set, delete: remove, live, breakdown, activeCount: () => active.size };
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
