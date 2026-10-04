// Closed-tab recovery (spec §6b). Pure: matching a lost record to a loaded conversation
// turn, and turning the server's timestamps into an honest duration.
//
// The one rule: observed time is on the client clock, reconstructed time is on the
// server clock, and they are added as two spans. Never subtracted from each other.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});
  const SEND_TIME_WINDOW_MS = 2000;
  // Same cutoff as LIVE_STALE_MS in total.js: past it, no tab is watching the record.
  const STALE_MS = 30 * 1000;

  // Which key let us pair them, so the match can be verified later.
  function matchedBy(rec, t) {
    if (rec.server?.turnExchangeId && t.turnExchangeId === rec.server.turnExchangeId) return 'turnExchangeId';
    if (rec.sent?.messageId && t.userMessageId === rec.sent.messageId) return 'messageId';
    return 'sendTime';
  }

  // A turn is only usable once the reply was saved, i.e. it has an end.
  function matchTurn(rec, turns) {
    if (!Array.isArray(turns)) return null;
    if (rec.end != null || rec.recovered) return null; // already finished: count it once
    const usable = turns.filter((t) => t && t.endSec != null);
    const byTurn = usable.find((t) => rec.server?.turnExchangeId && t.turnExchangeId === rec.server.turnExchangeId);
    if (byTurn) return byTurn;
    const byMessage = usable.find((t) => rec.sent?.messageId && t.userMessageId === rec.sent.messageId);
    if (byMessage) return byMessage;
    // Last resort: the send time is the only fact we share, and the spike showed the user
    // message's create_time matches the browser's send within 10 ms.
    return (
      usable.find((t) => {
        if (t.userCreateTime == null) return false;
        return Math.abs(t.userCreateTime * 1000 - rec.start) <= SEND_TIME_WINDOW_MS;
      }) ?? null
    );
  }

  function recover(rec, t, now) {
    const observed = Math.max(0, (rec.lastSeen ?? rec.firstByte ?? rec.start) - rec.start);
    const serverMs =
      t.startSec != null && t.endSec != null ? Math.max(0, (t.endSec - t.startSec) * 1000) : 0;
    // A span that starts at the send (Perplexity) already contains the watched time, so the
    // two overlap and the larger one is the duration. Otherwise (ChatGPT) the server span
    // starts after the watched part, and the two add.
    const dur = t.startIsSend ? Math.max(observed, serverMs) : observed + serverMs;
    return {
      ...rec,
      // Seen live, the model came from the stream; otherwise the saved turn names it.
      server: { ...rec.server, ...(rec.server?.model == null && t.model ? { model: t.model } : {}) },
      outcome: 'recovered',
      end: null, // the duration lives in recovered.durationMs; end stays unknown
      recovered: {
        at: now,
        // Never more than the longest reply that counts at all (spec §12).
        durationMs: Math.min(dur < 0 ? 0 : dur, 3 * 60 * 60 * 1000),
        matchedBy: matchedBy(rec, t),
        serverStart: t.startSec ?? null,
        serverEnd: t.endSec ?? null,
        finishType: t.finishType ?? null,
      },
    };
  }

  // The service worker's whole job on tabs.onRemoved: an unfinished record from a tab
  // that no longer exists. No end is invented; only the outcome changes.
  function pendingByTab(records, tabId, now) {
    const out = {};
    for (const r of records) {
      if (r.tabId !== tabId || r.end != null || r.outcome === 'pending' || r.recovered) continue;
      out[r.id] = { ...r, outcome: 'pending', closedAt: now };
    }
    return out;
  }

  // Which records a conversation load may finish: those no tab is still measuring. A closed
  // tab marks its records pending, but quitting Chrome sends no tabs.onRemoved, so a record
  // that has been silent past the live cutoff is just as orphaned.
  function isRecoverable(rec, now) {
    if (rec.end != null || rec.recovered) return false;
    return rec.outcome === 'pending' || now - (rec.lastSeen ?? rec.start) > STALE_MS;
  }

  ns.matchTurn = matchTurn;
  ns.isRecoverable = isRecoverable;
  ns.recover = recover;
  ns.pendingByTab = pendingByTab;
})(globalThis);