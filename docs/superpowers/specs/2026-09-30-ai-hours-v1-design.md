# AI Hours v1: Design Spec

Date: 2026-09-30. Builds on the planning handoff (product principles, rejected ideas) and the ChatGPT spike (`spike/chatgpt-probe.js`, run 2026-09-30).

## 1. Goal

A Chrome MV3 extension that measures, honestly, how long AI has worked for the user on **chatgpt.com**, and shows one number: total AI-hours.

Product principles (unchanged from handoff): one number · honest (unknown is shown as unknown, never guessed) · zero pressure · near-invisible · privacy-first (record *when*, never *what*).

## 2. Decisions

### Already decided
| Topic | Decision |
|---|---|
| Timing definition | **Option D.** The displayed number uses the client clock: `start` = the chat `fetch` call, `end` = `[DONE]`. Server timestamps from the stream are stored alongside for validation and for completing records whose tab closed (handoff §9.1, option 2). |
| Primary detection | MAIN-world `fetch` wrapper on the chat stream |
| Secondary detection | DOM stop-button observer, used as a health check and a low-confidence fallback, **not as a clock** (spike: the UI typewriter-animates, so DOM end lags network end by up to 2.7 s) |
| Third detection path | **Added 2026-10-01:** MAIN-world read of `GET /backend-api/conversations/{id}`, used **only** to finish a record whose tab was closed mid-reply. Timestamps and ids only, never text. |
| Multiple tabs | Sum durations (overlapping tabs sum, they never merge). **Added 2026-10-01:** the live counter also sums every tab's open replies, so 2 tabs thinking gains 2 s per second and the pill shows `×2`. |
| Storage format | Raw per-response records, never just a running total |

### v1 scope defaults: ⚑ confirm or change on review
| # | Topic | Proposed default | Why |
|---|---|---|---|
| ⚑1 | Sites | ChatGPT only | Handoff suggestion; the spike only verified ChatGPT |
| ⚑2 | Local vs server | Local only (`chrome.storage.local`) | No feature in v1 needs a server |
| ⚑3 | Live counter | **Changed 2026-09-30 (user decision):** a pill on chatgpt.com shows the total and counts up live while responses stream. **Changed again 2026-10-01:** it counts *every* tab's open replies, not just its own, and shows `×N` while N replies are running | The user wants to see AI working; a stopped stream freezes at the stop time. Cross-tab because the total jumped in one lump when a second tab finished, which hid the point of the product |
| ⚑4 | Background agents (handoff §9.1) | **Changed 2026-10-01 (user decision):** in scope. Closing the tab only stops us *watching*; ChatGPT keeps generating and saves the reply. A record whose tab closed becomes `pending` and is finished later from `GET /backend-api/conversations/{id}` (option 2 of the handoff's list, reached from a new direction) | The user pointed out that AI still infers after a close, so "stop counting at close" would undercount |
| ⚑5 | Stopped responses | `end` = time of the `stop_conversation` request, not `[DONE]` | Spike: `[DONE]` arrives ~5.5 s after the stop press; the user stopped the AI at the press |
| ⚑6 | Unknown durations | Popup shows a small footnote: "+ N responses with unknown duration" | Honest principle: unknown is shown as unknown, not hidden |
| ⚑7 | Build tooling | None: plain JS files loaded directly, Node's built-in test runner for tests | Nothing yet needs a bundler |

## 3. Spike findings this design relies on (ChatGPT, verified 2026-09-30)

- Chat stream: `POST /backend-api/f/conversation`, `content-type: text/event-stream`. Anonymous variant assumed to be `/backend-anon/f/conversation` (**unverified**). `/f/conversation/prepare` is pre-warming, **not** a send.
- Stream ends with `data: [DONE]`, including after the user presses Stop.
- Stop = a separate `POST /backend-api/stop_conversation`. The chat stream does not abort.
- Stream events use a delta encoding. The first event is `type: resume_conversation_token`. Messages appear as `{v: {message: {...}}}` with `author.role`, `content.content_type`, `status`, `create_time`. `type: message_stream_complete` precedes `[DONE]`.
- `send → headers`: 2.9–5.9 s. Silences of 2.5–6 s between chunks are normal (not only while thinking).
- Background tab: no effect on stream reading.
- DOM: `button[data-testid="stop-button"]` (aria-label "Stop answering") appears 50–70 ms after the send `fetch`.
- Conversation load: `GET /backend-api/conversations/{id}` → `messages[]`. User `create_time` = the send time on the client clock. All other timestamps are on the server clock. Per-turn grouping key: `metadata.turn_exchange_id` (also `request_id`). `finish_details.type` is `"stop"` or `"interrupted"`. Thinking has `reasoning_start_time`, `reasoning_end_time`, `finished_duration_sec`.
- **Verified in v1 end-to-end run (2026-09-30):** stream message objects carry `turn_exchange_id` (present on every live record), so it can serve as the idempotency key for v2 reconciliation. The same run gave 5 `fetch+dom` records with no flags (completed and stopped), including a ~66 s response, and one `unknown` record for a request that produced no stream data.

### ⚑7 Built but unverified on the wire (2026-10-01)

Closed-tab recovery reads two payloads the v1 spike never looked at. The field names come
from how ChatGPT's API has historically worked, not from an observation, so they are
assumptions until the first run on the real site:

| # | Assumption | If it is wrong | Fix |
|---|---|---|---|
| ⚑7a | The send body is JSON with `conversation_id` and a `messages[]` array whose last `author.role === 'user'` entry is the new message, with an `id` | `sent` is `{null, null}` on every record. Recovery still works, but only by the send-time fallback (±2 s), which needs the reply to be the one at that moment | one line in `sendIds` |
| ⚑7b | The request passes the body as `init.body` (a string), not as a `Request` object or a stream | same as above: no ids, and the prompt is never read | read `input.clone().text()` when `init.body` is absent |
| ⚑7c | A loaded conversation is fetched as `GET /backend-api/conversations/{id}` (plural) with `application/json` | no `conversation` signal, so a closed-tab record stays `pending` → counted as unknown. Nothing is invented | check the network tab; ChatGPT may load a chat from its own in-memory state instead of refetching |

`spike/conversation-probe.js` is a throwaway DevTools snippet that prints the key names of
both payloads (and nothing else) so ⚑7a–c can be confirmed in one paste. Until it is run,
the honest description of this feature is: *recovery is implemented and unit-tested against
the documented shape, but unproven against the live site.*

## 4. Architecture

```
chatgpt.com page
 ├─ MAIN world  (document_start)
 │    chatgpt-network.js   endpoints + structural stream parser (pure)
 │    sse.js               SSE framing (pure)
 │    main-world.js        wraps fetch → emits signals via window.postMessage
 │
 ├─ ISOLATED world (document_start)
 │    chatgpt-page.js      site name + stop-button selector (a file can't be listed in both worlds: Chrome injects it only once)
 │    verify.js            fetch-vs-DOM cross-verification (pure)
 │    reconcile.js         closed-tab recovery: pending → recovered (pure)
 │    tracker.js           per-tab state machine: signals + DOM → records (pure)
 │    total.js + overlay.js live counter pill (shadow DOM, pointer-events: none)
 │    content.js           wiring: message listener, DOM observer, storage writes, counter
 │
 ├─ service worker        background.js: re-injects scripts on install/update; marks a
 │                         closed tab’s records pending; answers "which tab am I?"
 └─ popup                 total.js (pure summary/format) + popup.html/js: reads records, shows total
```

### Why no stateful service worker
Content scripts can write `chrome.storage.local` directly, and the popup can read it directly. Each record gets **its own storage key** (`rec:<id>`), so concurrent tabs never read-modify-write a shared value, and no coordinator is needed. The MV3 "worker dies after 30 s" problem disappears because the worker holds nothing.

### Units

**`sse.js`**: `createSseParser(onEvent)` returns `push(textChunk)`. It splits on blank lines, normalises `\r\n`, and emits `{event, data}`. Pure; no site knowledge.

**`chatgpt-network.js` + `chatgpt-page.js`**: together they build one data object plus one pure function, each world loading only its half:
```js
{
  site: 'chatgpt',
  streamUrl: /\/backend-(api|anon)\/f\/conversation$/,
  stopUrl: /\/backend-(api|anon)\/stop_conversation$/,
  conversationUrl: /\/backend-(api|anon)\/conversations\/[0-9a-f-]{36}$/,
  stopButton: 'button[data-testid="stop-button"]',
  parseEvent(sse) → Signal | null,
  parseConversation(json) → Turn[],
  sendIds(body) → {conversationId, messageId}   // ids only, never the prompt
}
```
(`conversationUrl` is network-side, the other two page-side; each world loads only its half.)
`parseEvent` returns only structural signals: `{kind: 'done'}`, `{kind: 'message', role, contentType, status, createTime, turnExchangeId?, requestId?, messageId?}`, `{kind: 'finished'}` (a patch setting `/message/status`). It never returns strings from `content`/`parts`/`text`, and never returns `v` values other than those listed.

**`main-world.js`**: wraps `window.fetch` once (guarded by a `Symbol` flag, so re-injection doesn't double-wrap). For requests matching `streamUrl`: assigns `localId = crypto.randomUUID()`, records `start = Date.now()`, posts `start`, then reads a `clone()` of the body through `sse.js` → `parseEvent`, and posts `firstByte`, `message` (the structural message signal, as messages appear), `finished` and `end {t, lastChunk, outcome}` (`t` = arrival of `[DONE]`, or stream close if there was none). For `stopUrl`: posts `stop {t}`, which applies to the most recent still-open stream in the same tab. On a read error: `outcome: 'error'`, `end = lastChunk`. Everything crosses the world boundary as `{__aih: 1, type, localId, ...}` via `window.postMessage`. No text, ever.

**`verify.js`**: pure. `withinPairWindow(fetchStart, domStart)` is true when the stop button appears between 0.5 s before and 2 s after the fetch start. `classify({fetch, dom})` → `{source, confidence, flags}` using the table in §5.

**`tracker.js` + `content.js`**: the tracker holds all per-tab logic as a pure state machine (times passed in, `write(rec)` injected), so it can be unit-tested. `content.js` only wires it to `window` messages, the `MutationObserver`, timers and `chrome.storage`. Together they:
- Listen for `__aih` messages. On `start`, write `rec:<localId>` immediately with `end: null, outcome: 'unknown'`, so a tab closed mid-stream leaves an honest "unknown" record. Update the same key on later signals.
- Run a `MutationObserver` for `stopButton` with a 300 ms debounce and keep recent DOM intervals.
- If a DOM interval has no matching fetch within 10 s, write a `dom-only` record.

**`background.js`**: `chrome.runtime.onInstalled` → `chrome.scripting.executeScript` into open `chatgpt.com` tabs (MAIN and ISOLATED files). Stateless.

**`popup`**: `chrome.storage.local.get(null)` → filter `rec:` → total = Σ (`end − start`) over records with `end` → display `Xh Ym` (`Xm Ys` / `Xs` below an hour/minute), plus the ⚑6 footnote. The footnote only counts `end: null` records started more than 1 h ago; younger ones are treated as still in progress. Shows a one-line notice if any record from the last 7 days carries a health flag.

## 5. Cross-verification

| Fetch | DOM | Result |
|---|---|---|
| seen | seen | fetch times; `source: 'fetch+dom'`, `confidence: 'high'` |
| seen | none | fetch times; `fetch-only`, `high`; flag `dom-missing` |
| none | seen | DOM times; `dom-only`, `low`; flag `fetch-missing` |
| seen | seen, \|fetch end − DOM end\| > 10 s | fetch times; flag `large-gap` |

## 6. Record

```js
{
  id,            // localId (UUID generated at send)
  site: 'chatgpt',
  tabId,         // Chrome tab id, so a close can be matched to this record
  start,         // ms, client clock, at fetch call
  firstByte,     // ms | null
  finished,      // ms | null, client time the 'finished' signal arrived
  end,           // ms | null; [DONE] time, or stop time (⚑5), or lastChunk on error
  lastSeen,      // ms | null, client time of the most recent chunk (the "sign of life")
  outcome,       // 'completed' | 'stopped' | 'error' | 'unknown' | 'pending' | 'recovered'
  source, confidence, flags: [],
  dom: { start, end } | null,
  sent: {        // ids captured from the send request body; ids only, never the prompt
    conversationId, messageId
  },
  recovered: {   // set only when a closed-tab record was finished from conversation data
    at, durationMs, matchedBy, serverStart, serverEnd
  } | null,
  server: {      // server clock, seconds; any field may be missing
    turnExchangeId, requestId, messageId, msgCreate, reasoningStart, reasoningEnd
  }
}
```
Idempotency: the key is `localId`, so a stream is recorded once. A recovered record is *updated in place* under its original `localId`, so a turn seen live and later completed from conversation data still counts once. Conversation reconciliation additionally skips any record that already has `end` or `recovered`, so a reply that completed live is never touched (handoff §9.7).

A recovered record's duration is stored as `recovered.durationMs` and summed directly, **not** as `end − start`: the observed part is on the client clock and the reconstructed part on the server clock, and the spike showed those two clocks can disagree by minutes on some devices. Never subtract one from the other.

Storage size: ~580 B/record (measured in review) → the default 10 MB quota would fill after ~17k responses, so the extension requests `unlimitedStorage`. A failed write is logged, never fatal.

## 6b. Closed-tab recovery (⚑4, added 2026-10-01)

ChatGPT keeps generating after the tab is gone and saves the finished reply. So a close must not discard the work, and must not invent it either.

| Stage | What happens |
|---|---|
| Chunk arrives | `main-world.js` posts `alive {t}`, throttled to once per 2 s. The tracker stores `lastSeen` and re-writes the record. This is the only extra storage write per reply. |
| Tab closed | `background.js` `chrome.tabs.onRemoved` → any record with that `tabId` and `end === null` becomes `outcome: 'pending'`. It stops contributing to every pill immediately: `liveTotal` counts no `pending` record. Nothing is subtracted — the seconds already watched are still in the record. |
| Tab reloaded / navigated mid-reply | The new page's content script finds records with its own `tabId` and `end === null` (left by the previous document) and marks them pending at their `lastSeen`. Same path as a close, at most ~2 s early. |
| Chat reopened | The page fetches `GET /backend-api/conversations/{id}`. `main-world.js` reads only ids, statuses and timestamps from it and posts a `conversation` signal. The adapter groups messages into turns by `metadata.turn_exchange_id`. |
| Matching | 1. the record's `server.turnExchangeId`; 2. else `sent.messageId` == the user message's id; 3. else the record's `start` within 2 s of the user message's `create_time` (client clock, verified to match the send within 10 ms). All are known at send time, so this works even if the tab closed 1 s after send. |
| Duration | `recovered.durationMs = serverEnd − serverStart`, from the assistant message's `create_time` → `update_time`, plus the already-observed `min(closedAt, lastSeen) − start` if the record was watched before the close. Outcome `recovered`. |
| Reply still running when reopened | Stays `pending`; finished on a later conversation load. |
| Never reopened | Stays `pending` → the popup's ⚑6 footnote counts it as unknown. Not guessed. |

**The single clock rule.** The observed part is client-clock, the reconstructed part server-clock, and they are added as two separate spans. `start` (client) is never subtracted from a server timestamp. This leaves one honest undercount: if the tab closed during the 3–6 s queue *before* generation started, that queue is not counted.

**Live cutoff.** An `end: null` record whose `lastSeen` is older than 30 s stops counting live (a crashed or quit browser can't be observed further). 30 s, because normal inter-chunk silences are up to ~6 s (spike).

**Cross-tab live.** The pill is computed from *all* records in storage, not just this tab's: `liveTotal(records, now) → {ms, working}`. `working` is the number of records currently gaining time, shown as `×N` when above 1. A Stop in another tab saves its `end` immediately, so every pill freezes that reply at the press rather than ~5 s later at `[DONE]`.

## 7. Edge cases

| Case | Handling |
|---|---|
| Stop pressed | `outcome: 'stopped'`, `end` = stop request time (⚑5) |
| Stream error / laptop sleep | `outcome: 'error'`, `end` = last chunk time (loses at most one silence gap, ~6 s) |
| Tab closed mid-stream | `pending`; stops counting live everywhere at once; finished later from conversation data (§6b), otherwise the footnote only |
| Tab closed in the 3–6 s queue, before generation starts | The queue time is not counted (server start is unknown). Honest undercount, recorded as `recovered` with no server span |
| Regenerate / edit | New fetch → new record |
| Extension updated | background re-injects; the wrapper guard prevents double-wrapping |
| Wrapper installed late (re-injection) | The spike showed a late wrap still catches streams |
| Tokens over WebSocket | Not observed in the spike; out of scope. `fetch-missing` flags would reveal it |
| Voice mode | Out of scope |

## 8. Privacy & permissions

- `host_permissions`: `https://chatgpt.com/*` only. `permissions`: `storage`, `unlimitedStorage` (no install warning), `scripting`.
- Stream text necessarily passes through the decoder in memory. Only the structural signals listed in §4 leave `parseEvent`. Nothing leaves the device.
- `window.postMessage` is visible to the page, so the page could forge signals. That's acceptable for local-only v1. It becomes the anti-cheat problem (handoff §9.6) if a server is added.

## 9. Testing

- **Unit (Node `node --test`):** `sse.js` (split chunks, `\r\n`, multi-line data), `adapter-chatgpt.parseEvent` and `parseConversation` (fixtures modelled on spike event shapes with placeholder text; assert that no fixture text appears in any signal), `verify.js` (every row of §5, pairing windows), `reconcile.js` (matching by turn id, by message id, by send time; recovered duration = observed + server span; never double-completes), `total.js` (`liveTotal` across tabs, `×N`, stale cutoff, pending excluded), `tracker.js` (`alive` → `lastSeen`, `sent` ids), `background.js`'s `markPending`.
- **Manual E2E on chatgpt.com** (a checklist in the plan): rerun spike tests A–D; the popup total must match the sum of the records; two tabs thinking must gain 2 s per second with `×2`; a close mid-reply must stop the pill instantly, then jump when the chat is reopened.

## 10. Out of scope
Other sites · share card · server/sync · WebSocket capture · anti-cheat · background tasks the page never re-fetches (deep research, long "background mode" replies) · reconciling a turn that was never watched at all (a chat opened cold contributes nothing, since nothing was watched) · collapsing overlapping records into wall-clock time (that stays a product decision: durations are summed, §2).

**Moved out of "out of scope" on 2026-10-01:** background-agent reconstruction, now ⚑4, limited to finishing a record whose own tab was closed (§6b).
