// Per-tab state machine: turns main-world signals and stop-button changes into work
// records (spec §6). Pure: callers pass times in and supply write(record).
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});
  const DEBOUNCE_MS = 300;
  const DOM_ONLY_AFTER_MS = 10000;
  const FORGET_AFTER_MS = 60000;

  // Server-clock facts, kept for validation and v2 background reconciliation.
  function mergeServer(s, sig) {
    if (sig.turnExchangeId && !s.turnExchangeId) s.turnExchangeId = sig.turnExchangeId;
    if (sig.requestId && !s.requestId) s.requestId = sig.requestId;
    if (sig.role !== 'assistant' || sig.contentType === 'model_editable_context') return;
    if (sig.messageId) s.messageId = sig.messageId;
    if (sig.createTime != null && s.msgCreate == null) s.msgCreate = sig.createTime;
    if (sig.reasoningStart != null && s.reasoningStart == null) s.reasoningStart = sig.reasoningStart;
    if (sig.reasoningEnd != null) s.reasoningEnd = sig.reasoningEnd;
  }

  ns.createTracker = function createTracker({ site, newId, write }) {
    const open = new Map(); // localId -> record whose stream is still running
    const closed = new Map(); // localId -> {rec, at}; kept so a late stop-button change can update it
    const stopAt = new Map(); // localId -> ms the user pressed Stop
    let dom = []; // confirmed stop-button intervals {start, end, recId}
    let shown = false; // confirmed stop-button state
    let candidate = { visible: false, since: 0 };

    function onSignal(msg) {
      const r = open.get(msg.localId);
      switch (msg.type) {
        case 'start': return onStart(msg);
        case 'stop': return onStop(msg);
        case 'end': return r && onEnd(r, msg);
        case 'firstByte': if (r) r.firstByte = msg.t; return;
        case 'finished': if (r) r.finished = msg.t; return;
        case 'message': if (r) mergeServer(r.server, msg.sig); return;
      }
    }

    function onStart({ localId, t }) {
      const r = {
        id: localId, site, start: t, firstByte: null, finished: null, end: null, outcome: 'unknown',
        source: 'fetch-only', confidence: 'high', flags: [], dom: null, server: {},
      };
      open.set(localId, r);
      const d = dom.find((x) => !x.recId && ns.withinPairWindow(t, x.start));
      if (d) attach(r, d);
      write(r);
    }

    function onStop({ t }) {
      const ids = [...open.keys()];
      if (ids.length) stopAt.set(ids[ids.length - 1], t);
    }

    function onEnd(r, { t, lastChunk, outcome }) {
      open.delete(r.id);
      if (stopAt.has(r.id)) {
        r.outcome = 'stopped';
        r.end = Math.min(stopAt.get(r.id), t);
        stopAt.delete(r.id);
      } else if (outcome === 'completed') {
        r.outcome = 'completed';
        r.end = t;
      } else {
        r.outcome = 'error';
        r.end = lastChunk ?? t;
      }
      Object.assign(r, ns.classify({ fetch: { end: r.end }, dom: r.dom }));
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
      const r = [...open.values()].find((x) => !x.dom && ns.withinPairWindow(x.start, t));
      if (r) attach(r, d);
    }

    function domHidden(t) {
      const d = dom.findLast((x) => x.end === null);
      if (!d) return;
      d.end = t;
      const r = d.recId && (open.get(d.recId) || closed.get(d.recId)?.rec);
      if (!r) return;
      r.dom.end = t;
      if (r.end === null) return;
      Object.assign(r, ns.classify({ fetch: { end: r.end }, dom: r.dom }));
      write(r);
    }

    function tick(t) {
      confirm(t);
      for (const d of dom) {
        if (d.recId || d.end === null || t - d.start < DOM_ONLY_AFTER_MS) continue;
        const r = {
          id: newId(), site, start: d.start, firstByte: null, finished: null, end: d.end, outcome: 'unknown',
          ...ns.classify({ fetch: null, dom: d }), dom: { start: d.start, end: d.end }, server: {},
        };
        d.recId = r.id;
        write(r);
      }
      dom = dom.filter((d) => d.end === null || t - d.end < FORGET_AFTER_MS);
      for (const [id, c] of closed) if (t - c.at > FORGET_AFTER_MS) closed.delete(id);
    }

    return { onSignal, domRaw, confirm, tick };
  };
})(globalThis);
