# AI Hours v1: Design Spec

Date: 2026-09-30. Builds on the planning handoff (product principles, rejected ideas) and the ChatGPT spike (`spike/chatgpt-probe.js`, run 2026-09-30).

## 1. Goal

A Chrome MV3 extension that measures, honestly, how long AI has worked for the user on **chatgpt.com**, and shows one number: total AI-hours.

Product principles (unchanged from handoff): one number · honest (unknown is shown as unknown, never guessed) · zero pressure · near-invisible · privacy-first (record *when*, never *what*).

## 2. Decisions

### Already decided
| Topic | Decision |
|---|---|
| Timing definition | **Option D.** The displayed number uses the client clock: `start` = the chat `fetch` call, `end` = `[DONE]`. Server timestamps from the stream are stored alongside for validation and future background-agent reconstruction. They never feed the displayed number in v1. |
| Primary detection | MAIN-world `fetch` wrapper on the chat stream |
| Secondary detection | DOM stop-button observer, used as a health check and a low-confidence fallback, **not as a clock** (spike: the UI typewriter-animates, so DOM end lags network end by up to 2.7 s) |
| Multiple tabs | Sum durations |
| Storage format | Raw per-response records, never just a running total |

### v1 scope defaults: ⚑ confirm or change on review
| # | Topic | Proposed default | Why |
|---|---|---|---|
| ⚑1 | Sites | ChatGPT only | Handoff suggestion; the spike only verified ChatGPT |
| ⚑2 | Local vs server | Local only (`chrome.storage.local`) | No feature in v1 needs a server |
| ⚑3 | Live counter | **Changed 2026-09-30 (user decision):** a pill on chatgpt.com shows the total and counts up live while this tab's responses stream | The user wants to see AI working; a stopped stream freezes at the stop time |
| ⚑4 | Background agents (handoff §9.1) | Not reconstructed in v1. Server ids + timestamps are stored so v2 can reconcile without a data migration | Needs its own spike (a real deep-research run) |
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
 │    tracker.js           per-tab state machine: signals + DOM → records (pure)
 │    total.js + overlay.js live counter pill (shadow DOM, pointer-events: none)
 │    content.js           wiring: message listener, DOM observer, storage writes, counter
 │
 ├─ service worker        background.js: ONLY re-injects scripts into open tabs on install/update
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
  stopButton: 'button[data-testid="stop-button"]',
  parseEvent(sse) → Signal | null
}
```
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
  start,         // ms, client clock, at fetch call
  firstByte,     // ms | null
  finished,      // ms | null, client time the 'finished' signal arrived
  end,           // ms | null; [DONE] time, or stop time (⚑5), or lastChunk on error
  outcome,       // 'completed' | 'stopped' | 'error' | 'unknown'
  source, confidence, flags: [],
  dom: { start, end } | null,
  server: {      // server clock, seconds; any field may be missing
    turnExchangeId, requestId, messageId, msgCreate, reasoningStart, reasoningEnd
  }
}
```
Idempotency (v1): the key is `localId`, so a stream is recorded once. v2's background reconciliation dedups on `server.turnExchangeId` (handoff §9.7 resolved this way *if* task 1 confirms that the stream carries it; otherwise it's revisited).

Storage size: ~580 B/record (measured in review) → the default 10 MB quota would fill after ~17k responses, so the extension requests `unlimitedStorage`. A failed write is logged, never fatal.

## 7. Edge cases

| Case | Handling |
|---|---|
| Stop pressed | `outcome: 'stopped'`, `end` = stop request time (⚑5) |
| Stream error / laptop sleep | `outcome: 'error'`, `end` = last chunk time (loses at most one silence gap, ~6 s) |
| Tab closed mid-stream | Record stays `end: null, outcome: 'unknown'` → counted in the footnote only |
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

- **Unit (Node `node --test`):** `sse.js` (split chunks, `\r\n`, multi-line data), `adapter-chatgpt.parseEvent` (fixtures modelled on spike event shapes with placeholder text; assert that no fixture text appears in any signal), `verify.js` (every row of §5, pairing windows).
- **Manual E2E on chatgpt.com** (a checklist in the plan): rerun spike tests A–D. Records and outcomes must match expectations, the popup total must be within ±1 s of the sum of `end − start`, and a closed-tab test must produce one unknown record.

## 10. Out of scope for v1
Other sites · background-agent reconstruction · share card · server/sync · live ticking for streams in *other* tabs (they appear when they finish) · WebSocket capture · anti-cheat.
