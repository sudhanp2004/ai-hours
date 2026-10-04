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

  ns.createTracker = function createTracker({ site, tabId, newId, write }) {
    const open = new Map(); // localId -> record whose stream is still running
    const closed = new Map(); // localId -> {rec, at}; kept so a late stop-button change can update it
    let dom = []; // confirmed stop-button intervals {start, end, recId}
    let shown = false; // confirmed stop-button state
    let candidate = { visible: false, since: 0 };

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
        site, tabId, firstByte: null, finished: null, end: null, lastSeen: null, outcome: 'unknown',
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
      const d = dom.find((x) => !x.recId && ns.withinPairWindow(t, x.start));
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

    // classify() rewrites the flags, so a cap noted earlier is put back each time.
    function classifyInto(r) {
      Object.assign(r, ns.classify({ fetch: { end: r.end }, dom: r.dom }));
      if (r.capped) r.flags = [...r.flags, 'capped'];
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
      const r = recs.find((x) => !x.dom && ns.withinPairWindow(x.start, t));
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
      if (r.end !== null) reclassify(r);
    }

    function reclassify(r) {
      classifyInto(r);
      write(r);
    }

    function tick(t) {
      confirm(t);
      for (const d of dom) {
        if (d.recId || d.end === null || t - d.start < DOM_ONLY_AFTER_MS) continue;
        // The same shape as a fetch record, so the total adds them without special-casing.
        // Its sign of life is the moment the stop button went away.
        const r = blank({
          id: newId(), start: d.start, end: d.end, lastSeen: d.end,
          ...ns.classify({ fetch: null, dom: d }), dom: { start: d.start, end: d.end },
        });
        d.recId = r.id;
        write(r);
      }
      dom = dom.filter((d) => d.end === null || t - d.end < FORGET_AFTER_MS);
      for (const [id, c] of closed) if (t - c.at > FORGET_AFTER_MS) closed.delete(id);
    }

    // A record the previous page in this tab left unfinished, whose reply this page can still
    // see running (spec §11, refresh). It is measured on from here under the new localId.
    function adopt(localId, rec, t) {
      const r = { ...structuredClone(rec), outcome: 'unknown', lastSeen: t };
      delete r.closedAt;
      if (!r.flags.includes('resumed')) r.flags = [...r.flags, 'resumed'];
      open.set(localId, r);
      write(r);
    }

    return { onSignal, domRaw, confirm, tick, adopt };
  };
})(globalThis);
