# Plan: cross-tab live counting and closed-tab recovery

Implements spec §6b (2026-10-01), the work approved at the end of the v1 session. Two
features, one shared mechanism (the record carries its tab and its sign of life):

1. **Cross-tab live pill.** The counter counts every tab's open replies, not just its
   own, and shows `×N` while N replies run.
2. **Closed-tab recovery.** A tab closed mid-reply stops counting immediately and
   everywhere, then the record is finished from ChatGPT's own conversation data the
   next time that chat is opened.

Rules that must not be broken:

- **Two clocks are never subtracted.** Observed time is client-clock; reconstructed
  time is server-clock. They are added as two spans. The spike found a device whose
  clock was 2 minutes fast, which produced `update_time < create_time`.
- **Nothing is estimated.** A pending record we can never match stays unknown.
- **No message text** crosses either world boundary or reaches storage.

## Task order

TDD per task: failing test, implementation, green, commit.

| # | Task | Files |
|---|---|---|
| 1 | `sendIds` + `parseConversation` (adapter, pure) | `extension/src/chatgpt-network.js`, `test/chatgpt.test.js` |
| 2 | `reconcile.js` (pure): matching + recovered duration | `extension/src/reconcile.js`, `test/reconcile.test.js` |
| 3 | `liveTotal` + ×N in `total.js` | `extension/src/total.js`, `test/total.test.js` |
| 4 | tracker: `sent` ids, `tabId`, `alive` → `lastSeen`, `pending` | `extension/src/tracker.js`, `test/tracker.test.js` |
| 5 | `main-world.js`: throttled `alive`, read conversation loads | `extension/src/main-world.js`, `test/main-world.test.js` |
| 6 | `overlay.js`: ×N badge | `extension/src/overlay.js` |
| 7 | `background.js`: `markPending` (pure) + `tabs.onRemoved` + tab-id query | `extension/src/background.js`, `test/background.test.js` |
| 8 | `content.js` + `manifest.json` wiring; the manifest self-sufficiency test | `extension/src/content.js`, `extension/manifest.json`, `test/manifest.test.js` |
| 9 | Spec results, manual E2E checklist (the user runs it) | spec |

Each task commits on `feat/ai-hours-v1`, so it lands in PR #1.

## Design details worth stating before coding

### Where each piece lives

- `chatgpt-network.js` (MAIN): `sendIds(body)` pulls `conversation_id` and the last
  user message id out of the send request body. `parseConversation(json)` turns
  `messages[]` into turns keyed by `metadata.turn_exchange_id`, exposing only ids,
  roles, statuses and timestamps.
- `main-world.js` (MAIN): posts `alive {localId, t}` at most once per 2 s while chunks
  arrive. For a URL matching `conversationUrl`, reads a `clone()` of the JSON and posts
  `conversation {turns}`.
- `reconcile.js` (ISOLATED, pure): `matchTurn(record, turns) → Turn | null` and
  `recover(record, turn, now) → record`. No DOM, no storage, no clock of its own.
- `tracker.js` (ISOLATED, pure): learns `tabId` from content.js; stores `sent` ids from
  the `start` payload; turns `alive` into `lastSeen` and rewrites the record (throttled
  by the caller); `markPending(tabId)` is on the worker, not here.
- `background.js`: exports a pure `markPending(records, tabId, at)` so it is testable
  outside Chrome; `tabs.onRemoved` reads storage, calls it, writes back.
- `total.js` (ISOLATED, pure): `liveTotal(records, now) → {ms, working}` — saved totals
  plus every non-pending `end: null` record whose `lastSeen` is within 30 s.

### The recovered duration

```
observed = min(closedAt, lastSeen) - start        // client clock, may be 0
serverMs = (turn.endSec - turn.startSec) * 1000   // server clock, may be absent
durationMs = observed + serverMs
```

`observed` is kept because the part we watched live is the most accurate measurement we
will ever have for it. `serverMs` covers only what we could not see. Neither is ever
derived from the other.

### Cross-tab liveness without a coordinator

Every tab keeps the full record set in memory, fed by `chrome.storage.onChanged`. So
`liveTotal` over that set is already cross-tab: no worker round-trip, nothing to keep in
sync, and a tab that dies simply stops writing. The 30 s stale cutoff covers a browser
that quit, which no event announces.

### Why the service worker stays stateless

It still holds nothing between events. `tabs.onRemoved` is an event, not state: the
handler reads storage, computes the new values and writes them. It answers "which tab
am I?" by reading `sender.tab.id` off the message, which Chrome supplies.

## Verification you run at the end (Task 9)

1. Reload the extension, reload the ChatGPT tab.
2. Send a long prompt in tab A, switch to tab B, send another. Both pills must gain
   ~2 s per second and show `×2`.
3. Press Stop in tab A. Every pill freezes that reply immediately.
4. Send a long prompt in a tab and close the tab ~5 s in. The other tabs' pill must
   stop instantly (no step back).
5. Wait ~1 minute, reopen that chat. The pill must jump up by roughly the full reply
   time, and the record's `outcome` must read `recovered` with a `recovered.durationMs`.
6. Send a message and close the tab, then never reopen the chat: the popup footnote
   must count it as unknown. Nothing is invented.