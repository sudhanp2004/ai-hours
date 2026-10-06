// Per-tab state machine: turns main-world signals and stop-button changes into work
// records (spec §6). Pure: callers pass times in and supply write(record).
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});
  const DEBOUNCE_MS = 300;
  const DOM_ONLY_AFTER_MS = 10000;
  const FORGET_AFTER_MS = 60000;
  // Tamper resistance (spec §12): no chat UI runs more than a few replies at once in a tab,
  // and no single reply runs for hours. Past these, a signal is not trusted.
  const MAX_OPEN = 4;
  const MAX_REPLY_MS = 3 * 60 * 60 * 1000;
  // A stop button nothing on this page sent, held this long (past the pair window, so a send
  // can't still claim it), may be the previous page's reply still running: see resume.
  const RESUME_AFTER_MS = 1000;
  const ALIVE_MS = 2000; // how often a reply measured by its stop button alone says "still here"

  // Server-clock facts, kept for validation and v2 background reconciliation.
  function mergeServer(s, sig) {
    if (sig.turnExchangeId && !s.turnExchangeId) s.turnExchangeId = sig.turnExchangeId;
    if (sig.requestId && !s.requestId) s.requestId = sig.requestId;
    if (sig.role !== 'assistant' || sig.contentType === 'model_editable_context') return;
    if (sig.messageId) s.messageId = sig.messageId;
    if (sig.model) s.model = sig.model; // the latest named model answered last
    if (sig.createTime != null && s.msgCreate == null) s.msgCreate = sig.createTime;
    if (sig.reasoningStart != null && s.reasoningStart == null) s.reasoningStart = sig.reasoningStart;
    if (sig.reasoningEnd != null) s.reasoningEnd = sig.reasoningEnd;
  }

  // resume(t): the record the previous page in this tab left open, if a stop button that
  // showed at t can still be its reply, else null. Taking it is the caller's to decide.
  ns.createTracker = function createTracker({ site, tabId, tabKey = null, pairAfterMs, newId, write, resume = null }) {
    const pairs = (fetchStart, domStart) => ns.withinPairWindow(fetchStart, domStart, pairAfterMs);
    const open = new Map(); // localId -> record whose stream is still running
    const closed = new Map(); // localId -> {rec, at}; kept so a late stop-button change can update it
    let dom = []; // confirmed stop-button intervals {start, end, recId}
    let shown = false; // confirmed stop-button state
    let candidate = { visible: false, since: 0 };
    const byDom = new Set(); // ids of open records that only their stop button can end

    function onSignal(msg) {
      const r = open.get(msg.localId);
      switch (msg.type) {
        case 'start': return onStart(msg);
        case 'stop': return onStop(msg);
        case 'end': return r && onEnd(r, msg);
        case 'firstByte': if (r) r.firstByte = r.lastSeen = msg.t, write(r); return;
        // A throttled sign of life: every other tab counts this reply from it (spec §6b).
        case 'alive': if (r) r.lastSeen = msg.t, write(r); return;
        case 'finished': if (r) r.finished = msg.t; return;
        case 'message': if (r) mergeServer(r.server, msg.sig); return;
      }
    }

    function blank(over) {
      return {
        site, tabId, tabKey, firstByte: null, finished: null, end: null, lastSeen: null, outcome: 'unknown',
        source: 'fetch-only', confidence: 'high', flags: [], dom: null,
        sent: { conversationId: null, messageId: null }, recovered: null, server: {}, ...over,
      };
    }

    function onStart({ localId, t, sent }) {
      if (open.size >= MAX_OPEN) return;
      const r = blank({
        id: localId, start: t,
        sent: { conversationId: sent?.conversationId ?? null, messageId: sent?.messageId ?? null },
      });
      open.set(localId, r);
      const d = dom.find((x) => !x.recId && pairs(t, x.start));
      if (d) attach(r, d);
      write(r);
    }

    // Stop does not cut the stream, so [DONE] still arrives seconds later. The record is
    // finished here instead, at the press, so no other tab keeps counting work the user
    // already cancelled. It moves to `closed`, so the later end signal finds nothing to do.
    function onStop({ t }) {
      const id = [...open.keys()].at(-1);
      const r = id && open.get(id);
      if (!r) return;
      open.delete(r.id);
      finish(r, t, 'stopped');
      closed.set(r.id, { rec: r, at: t });
      write(r);
    }

    function onEnd(r, { t, lastChunk, outcome }) {
      open.delete(r.id);
      if (r.end !== null) return; // already final: the Stop press
      if (outcome === 'completed') finish(r, t, 'completed');
      else finish(r, lastChunk ?? t, 'error');
      closed.set(r.id, { rec: r, at: t });
      write(r);
    }

    function finish(r, end, outcome) {
      if (end - r.start > MAX_REPLY_MS) (end = r.start + MAX_REPLY_MS), (r.capped = true);
      r.end = end;
      r.outcome = outcome;
      r.lastSeen = end;
      classifyInto(r);
    }

    // classify() rewrites the flags, so a cap or resume noted earlier is put back each time.
    function classifyInto(r) {
      const resumed = r.flags?.includes('resumed');
      Object.assign(r, ns.classify({ fetch: { end: r.end }, dom: r.dom }));
      if (r.capped) r.flags = [...r.flags, 'capped'];
      if (resumed) r.flags = [...r.flags, 'resumed'];
    }

    // This page never saw the resumed reply's request, so its end is the stop button's.
    function endByDom(r, t) {
      open.delete(r.id);
      finish(r, t, 'completed');
      closed.set(r.id, { rec: r, at: t });
      write(r);
    }

    function attach(r, d) {
      d.recId = r.id;
      r.dom = { start: d.start, end: d.end };
    }

    function domRaw(visible, t) {
      if (visible !== candidate.visible) candidate = { visible, since: t };
    }

    // A stop-button state counts once it has held for DEBOUNCE_MS; it is timed from when it began.
    function confirm(t) {
      if (candidate.visible === shown || t - candidate.since < DEBOUNCE_MS) return;
      shown = candidate.visible;
      if (shown) domShown(candidate.since);
      else domHidden(candidate.since);
    }

    function domShown(t) {
      const d = { start: t, end: null, recId: null };
      dom.push(d);
      // A fast failure (e.g. HTTP 429) can end before the debounce confirms the button, so look in closed too.
      const recs = [...open.values(), ...[...closed.values()].map((c) => c.rec)];
      const r = recs.find((x) => !x.dom && pairs(x.pairAt ?? x.start, t));
      if (!r) return;
      attach(r, d);
      if (r.end !== null) reclassify(r);
    }

    function domHidden(t) {
      const d = dom.findLast((x) => x.end === null);
      if (!d) return;
      d.end = t;
      const r = d.recId && (open.get(d.recId) || closed.get(d.recId)?.rec);
      if (!r) return;
      r.dom.end = t;
      if (r.end === null && byDom.delete(r.id)) return endByDom(r, t);
      if (r.end !== null) reclassify(r);
    }

    function reclassify(r) {
      classifyInto(r);
      write(r);
    }

    function tick(t) {
      confirm(t);
      for (const d of dom) {
        if (d.recId) continue;
        // A reload aborts the reply's request but not the reply: the server goes on writing,
        // and the reloaded page shows its stop button with nothing sent from here. It is the
        // previous page's record, measured on, not a second record (seen live on Perplexity,
        // ChatGPT and DeepSeek, 2026-10-06).
        if (resume && t - d.start >= RESUME_AFTER_MS && !overlaps(d, t)) {
          const rec = resume(d.start);
          if (rec) {
            takeOver(rec, d, t);
            continue;
          }
        }
        if (d.end === null || t - d.start < DOM_ONLY_AFTER_MS) continue;
        // A button that showed while a measured reply was running is that reply's, however late
        // it appeared: counting it again as its own record would count the same work twice
        // (seen live on Perplexity, 2026-10-06).
        const overlapping = overlaps(d, t);
        if (overlapping) {
          d.recId = overlapping.id;
          if (!overlapping.dom) attach(overlapping, d), overlapping.end !== null && reclassify(overlapping);
          continue;
        }
        // The same shape as a fetch record, so the total adds them without special-casing.
        // Its sign of life is the moment the stop button went away.
        const r = blank({
          id: newId(), start: d.start, end: d.end, lastSeen: d.end,
          ...ns.classify({ fetch: null, dom: d }), dom: { start: d.start, end: d.end },
        });
        d.recId = r.id;
        write(r);
      }
      // Its stop button is all that shows this reply is still running.
      for (const id of byDom) {
        const r = open.get(id);
        if (r && t - r.lastSeen >= ALIVE_MS) (r.lastSeen = t), write(r);
      }
      dom = dom.filter((d) => d.end === null || t - d.end < FORGET_AFTER_MS);
      for (const [id, c] of closed) if (t - c.at > FORGET_AFTER_MS) closed.delete(id);
    }

    const overlaps = (d, t) =>
      [...open.values(), ...[...closed.values()].map((c) => c.rec)].find(
        (r) => r.start <= (d.end ?? t) && (r.end ?? t) >= d.start,
      );

    function revive(rec, t) {
      const r = { ...structuredClone(rec), outcome: 'unknown', lastSeen: t };
      delete r.closedAt;
      if (!r.flags.includes('resumed')) r.flags = [...r.flags, 'resumed'];
      return r;
    }

    // The stop button's interval d is the resumed reply's, from the moment it showed. One that
    // has already gone ended the reply then.
    function takeOver(rec, d, t) {
      const r = revive(rec, d.end ?? t);
      r.dom = null;
      r.pairAt = d.start;
      attach(r, d);
      open.set(r.id, r);
      if (d.end !== null) return endByDom(r, d.end);
      byDom.add(r.id);
      write(r);
    }

    // A record the previous page in this tab left unfinished, whose reply this page can still
    // see running (spec §11, refresh). It is measured on from here under the new localId. With
    // no record (the stop button took it over first), the reply it took is handed to localId,
    // whose stream then ends it.
    function adopt(localId, rec, t) {
      if (!rec) {
        const id = [...byDom].at(-1);
        const r = id && open.get(id);
        if (!r) return;
        byDom.delete(id);
        open.delete(id);
        open.set(localId, r);
        return;
      }
      const r = revive(rec, t);
      // The old page's stop-button interval died with it. On this page the running reply's
      // button is paired from the moment of adoption, not from the reply's original start, and
      // one already showing is this reply's: otherwise it would become a second, DOM-only
      // record of the same work (seen live on Claude, 2026-10-06).
      r.dom = null;
      r.pairAt = t;
      const d = dom.find((x) => !x.recId && (x.end === null || pairs(t, x.start)));
      if (d) attach(r, d);
      open.set(localId, r);
      write(r);
    }

    return { onSignal, domRaw, confirm, tick, adopt };
  };
})(globalThis);
