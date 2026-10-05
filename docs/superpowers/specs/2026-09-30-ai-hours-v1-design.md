# AI Hours v1: Design Spec

Date: 2026-09-30. Builds on the planning handoff (product principles, rejected ideas) and the ChatGPT spike (`spike/chatgpt-probe.js`, run 2026-09-30).

## 1. Goal

A Chrome MV3 extension that measures, honestly, how long AI has worked for the user on **chatgpt.com**, and shows one number: total AI-hours.

Product principles (unchanged from handoff, except the first, changed 2026-10-03 — see §11 Breakdown): one number up front, with a per-LLM breakdown on click · honest (unknown is shown as unknown, never guessed) · zero pressure · near-invisible · privacy-first (record *when*, never *what*).

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
| ⚑1 | Sites | **Changed 2026-10-01 (user decision):** scaffold every major chat LLM, enable only the ones verified on the wire. See §11. | The ChatGPT spike is the only verified site, so anything else would be guesswork. Scaffolding the shape now costs little; enabling a site costs a probe |
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
both payloads (and nothing else) so ⚑7a–c can be confirmed in one paste.

**Probe results (2026-10-03, one new chat + one chat load):**
- ⚑7b **confirmed:** the send body is passed as `init.body`, a string.
- ⚑7a **confirmed for matching:** `messages[]`'s last entry has `author.role === 'user'` and an
  `id` (keys: `id, author, create_time, content, metadata`). `conversation_id` is **absent** for
  a new chat (none exists yet); matching never used it, only the message id. Not yet observed:
  that this id equals the user message's `id` in the later conversation load. If it does not,
  matching falls back to send time (±2 s), which the v1 spike validated.
- ⚑7c **confirmed:** `GET /backend-api/conversations/{id}`, `application/json`, with `messages[]`
  carrying `metadata.turn_exchange_id`, `create_time`, `update_time`, `status`, and
  `finish_details.type: 'stop'` on the turn's final reply.
- **New:** returning to a chat already opened in the same page is served from ChatGPT's memory,
  with no refetch. Recovery after a closed tab is unaffected (reopening is a fresh page load),
  but a chat revisited within one page session produces no `conversation` signal.

**End-to-end run 1 (2026-10-03):** the send id was captured, but the user closed the whole
window, which quit Chrome. Quitting sends no `tabs.onRemoved`, so the record stayed `unknown`
and recovery (which then required `pending`) never considered it. Fixed: a conversation load
now finishes any unfinished record that is `pending` **or** has been silent past the 30 s live
cutoff (`isRecoverable` in `reconcile.js`), so a quit, crash or missed close event recovers too.

**End-to-end run 2 (2026-10-03), passed:** after the fix, reopening the chat recovered the
record left by run 1: `outcome: recovered`, `matchedBy: messageId`, `finishType: stop`,
`durationMs` 34 565 = 665 ms watched + 33 900 ms of server generation (`serverEnd − serverStart`).
This also confirms the open half of ⚑7a: the send body's user message `id` equals that
message's `id` in the loaded conversation. Closed-tab and browser-quit recovery are verified
on the live site.

## 4. Architecture

```
chatgpt.com page (each enabled site gets this shape, with its own adapter)
 ├─ MAIN world  (document_start)
 │    <site>-network.js    endpoints + structural stream parser (pure)
 │    sse.js               SSE framing (pure)
 │    main-world.js        wraps fetch → emits signals via window.postMessage
 │
 ├─ ISOLATED world (document_start)
 │    <site>-page.js       site name + hosts + stop-button selector (a file can't be listed in both worlds: Chrome injects it only once)
 │    verify.js            fetch-vs-DOM cross-verification (pure)
 │    reconcile.js         closed-tab recovery: pending → recovered (pure)
 │    tracker.js           per-tab state machine: signals + DOM → records (pure)
 │    total.js + overlay.js live counter pill (shadow DOM, pointer-events: none)
 │    content.js           wiring: message listener, DOM observer, storage writes, counter
 │
 ├─ service worker        background.js: re-injects the scripts that match each tab on
 │                         install/update; marks a closed tab’s records pending; answers
 │                         "which tab am I?"  (manifest-match.js: which entries fit a tab)
 └─ popup                 total.js (pure summary/format) + popup.html/js: reads records, shows total
```

### Why no stateful service worker
Content scripts can write `chrome.storage.local` directly, and the popup can read it directly. Each record gets **its own storage key** (`rec:<id>`), so concurrent tabs never read-modify-write a shared value, and no coordinator is needed. The MV3 "worker dies after 30 s" problem disappears because the worker holds nothing.

### Units

**`sse.js`**: `createSseParser(onEvent)` returns `push(textChunk)`. It splits on blank lines, normalises `\r\n`, and emits `{event, data}`. Pure; no site knowledge.

**`<site>-network.js` + `<site>-page.js`**: together they build one data object plus one pure function, each world loading only its half:
```js
{
  site: 'chatgpt',
  hosts: ['chatgpt.com'],           // page-side: the domains this adapter may run on
  streamUrl: /\/backend-(api|anon)\/f\/conversation$/,
  stopUrl: /\/backend-(api|anon)\/stop_conversation$/,
  conversationUrl: /\/backend-(api|anon)\/conversations\/[0-9a-f-]{36}$/,
  stopButton: 'button[data-testid="stop-button"]',
  parseEvent(sse) → Signal | null,
  parseConversation(json) → Turn[],
  sendIds(body) → {conversationId, messageId}   // ids only, never the prompt
}
```
(`hosts`, `site` and `stopButton` are page-side, the rest network-side. Each world loads
only its half, into the single `ns.site` slot — see §11.)
`parseEvent` returns only structural signals: `{kind: 'done'}`, `{kind: 'message', role, contentType, status, createTime, turnExchangeId?, requestId?, messageId?}`, `{kind: 'finished'}` (a patch setting `/message/status`). It never returns strings from `content`/`parts`/`text`, and never returns `v` values other than those listed.

**`main-world.js`**: wraps `window.fetch` once (guarded by a `Symbol` flag, so re-injection doesn't double-wrap), and reads `ns.site` at call time so a re-injected adapter takes effect. For requests matching `streamUrl`: assigns `localId = crypto.randomUUID()`, records `start = Date.now()`, posts `start`, then reads a `clone()` of the body through `sse.js` → `parseEvent`, and posts `firstByte`, `message` (the structural message signal, as messages appear), `finished` and `end {t, lastChunk, outcome}` (`t` = arrival of `[DONE]`, or stream close if there was none). For `stopUrl`: posts `stop {t}`, which applies to the most recent still-open stream in the same tab. On a read error: `outcome: 'error'`, `end = lastChunk`. Everything crosses the world boundary as `{__aih: 1, type, localId, ...}` via `window.postMessage`. No text, ever.

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
| Never reopened | Stays `pending`. **Changed 2026-10-03 (user decision):** it counts the time that was watched (`start` → `lastSeen`), a measured lower bound, so a refresh or close never lowers the total; the popup's ⚑6 footnote now says how many replies were only partly counted. Still not guessed. |

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

- `host_permissions`: the enabled sites only (§11) — currently `https://chatgpt.com/*`, `https://www.perplexity.ai/*`, `https://claude.ai/*` and `https://gemini.google.com/*`. `permissions`: `storage`, `unlimitedStorage` (no install warning), `scripting`.
- Stream text necessarily passes through the decoder in memory. Only the structural signals listed in §4 leave `parseEvent`. Nothing leaves the device.
- `window.postMessage` is visible to the page, so the page could forge signals. That's acceptable for local-only v1. It becomes the anti-cheat problem (handoff §9.6) if a server is added.
- Adding a site is a privacy decision as much as a technical one: the install warning's site list grows with every adapter. A stub that isn't in the manifest adds nothing to it.

## 9. Testing

- **Unit (Node `node --test`):** `sse.js` (split chunks, `\r\n`, multi-line data), `adapter-chatgpt.parseEvent` and `parseConversation` (fixtures modelled on spike event shapes with placeholder text; assert that no fixture text appears in any signal), `verify.js` (every row of §5, pairing windows), `reconcile.js` (matching by turn id, by message id, by send time; recovered duration = observed + server span; never double-completes), `total.js` (`liveTotal` across tabs, `×N`, stale cutoff, pending excluded), `tracker.js` (`alive` → `lastSeen`, `sent` ids), `background.js`'s `markPending`.
- **Manual E2E on chatgpt.com** (a checklist in the plan): rerun spike tests A–D; the popup total must match the sum of the records; two tabs thinking must gain 2 s per second with `×2`; a close mid-reply must stop the pill instantly, then jump when the chat is reopened.

## 10. Out of scope
Share card · server/sync · WebSocket capture · anti-cheat · background tasks the page never re-fetches (deep research, long "background mode" replies) · reconciling a turn that was never watched at all (a chat opened cold contributes nothing, since nothing was watched) · collapsing overlapping records into wall-clock time (that stays a product decision: durations are summed, §2) · local models (Ollama, LM Studio, Open WebUI) — a different transport with no page chrome to observe, so they need their own design, not an adapter.

**Moved out of "out of scope" on 2026-10-01:** background-agent reconstruction, now ⚑4, limited to finishing a record whose own tab was closed (§6b). **Other sites**, now §11.

## 11. Multiple sites (added 2026-10-01)

### The decision

Scaffold the adapter shape for every major chat LLM; enable a site only once its wire
behaviour has been observed in DevTools. Full parity is the target — a new site gets
live counting, Stop-now, the pill and closed-tab recovery, not a reduced version.

**Changed 2026-10-03 (user decision): Breakdown.** The pill and the popup still lead with one
number, the sum over every site. Clicking the pill (or opening the popup) shows that number
split by LLM, and each LLM opens to its models (`breakdown` in `total.js`, the same count as
`liveTotal`, so the rows always add up to the pill). The concern that ruled this out before is
real: sites without closed-tab recovery (Claude, Gemini) can only err low, so their rows carry
an asterisk and a footnote saying so, rather than being compared as if equally precise.

Each record keeps the answering model as `server.model`, from the wire (never from the page's
model picker). Names are tidied by rule in `models.js` (`claude-opus-5-5` → "Opus 5.5",
`gpt-5-thinking` → "GPT-5 Thinking"); an unknown slug is shown as sent. Records from before
this change have no model and show as "Model not recorded".

| ⚑ | Source of the model | Status |
|---|---|---|
| ⚑11a | ChatGPT: stream message `metadata.model_slug` (and the same in a loaded conversation) | not yet seen on the wire; if absent, ChatGPT rows show "Model not recorded" |
| ⚑11b | Perplexity: `display_model` on every stream event and thread entry | seen (`"turbo"` for the default); the mapping of its values to product names is unknown, so they show raw |
| ⚑11c | claude.ai: the timeline's conversation field 6.2 (`claude-opus-5-5`) | seen in the probe |
| ⚑11d | Gemini: a short value such as `"3.6 Flash"` inside the StreamGenerate response's `wrb.fr` data (the request has only an opaque code in `x-goog-ext-525001261-jspb`). Read while streaming, so a stopped reply keeps it; only strings of 40 chars or fewer count, so a reply *mentioning* "2.5 Pro" is never taken for the model | seen once by the user's console probe (2026-10-03, Flash only); its exact position in the data is not yet known, so it is matched by shape, not by position |

### The adapter contract

A site is two files, because a file listed in two manifest entries loads in only one of
them (§4, and `test/manifest.test.js`):

| file | world | provides |
|---|---|---|
| `src/<site>-network.js` | MAIN | `streamUrl`, `stopUrl`, `conversationUrl`, `parseEvent`, `sendIds`, `parseConversation` |
| `src/<site>-page.js` | ISOLATED | `hosts`, `site`, `stopButton` |

Both halves write into a **single slot**, `ns.site`, by `Object.assign`, so each world
keeps its own half. Not a keyed registry: the manifest decides which adapter file loads on
which domain, so exactly one adapter is ever live per page and a hostname lookup would be
dead code. `content.js` checks `ns.site.hosts` against `location.hostname` before doing
anything, so a mis-declared `matches` produces silence rather than wrong numbers.

Everything else — `sse.js`, `main-world.js`, `tracker.js`, `verify.js`, `reconcile.js`,
`total.js`, `overlay.js`, `content.js`, `background.js` — is site-agnostic and is shared
verbatim by every site.

### What "full parity" can and cannot mean

Full parity is structural: the adapter has every slot, so no new machinery is needed per
site. It is not guaranteed per site, because a slot may have no honest value:

| Slot | If a site can't supply it honestly |
|---|---|
| `streamUrl`, `parseEvent` | No counting at all. The site stays disabled |
| `stopButton` | The DOM cross-check is lost; records become `fetch-only` with a `dom-missing` flag (§5). Still counted |
| `stopUrl` | Stop isn't seen at the press, so `end` falls back to the stream's own end (on ChatGPT that is ~5 s late, §3). A small, flagged overcount |
| `conversationUrl`, `parseConversation` | **No closed-tab recovery on that site.** Its closed-tab records stay `pending` and are reported as unknown (§6b, last row). Never guessed |

A site with no conversation-load endpoint is therefore *supported but lossy*, and that loss
is written into the spec for the site rather than left as hidden behaviour.

### ⚑8 The framing risk (the one real design unknown)

Every timing path here assumes the reply arrives as an HTTP response body readable chunk by
chunk, framed as SSE. ChatGPT is confirmed (`data:` lines, terminated by `[DONE]`). Other
sites may not be — Gemini's web app in particular is known to use a different RPC envelope
rather than a plain SSE stream. If a probe shows a non-SSE stream, `main-world.js` needs one
new seam: a frame splitter an adapter may override, defaulting to `createSseParser`. That
adapter cannot be written until the seam exists.

Deliberately **not** built speculatively: it is one function, and the probe says in one
paste whether it is needed. If every probed site is SSE, the seam is never written.

### What must be verified per site before it is enabled

Six facts, all from one DevTools paste (`spike/multisite-probe.js`):

1. **Send request** — URL and method.
2. **Stream request** — URL, and a `content-type` containing `text/event-stream`.
3. **Frame format** — SSE `data:` lines or something else, plus the marker that means "the
   reply is over" (`[DONE]`, a JSON field, or the socket simply closing).
4. **Stop request** — does pressing Stop issue its own request, and does the stream survive it?
5. **Stop button** — a CSS selector that matches, and is stable enough to trust.
6. **Conversation load** — does opening a chat refetch it over HTTP as JSON, and what are
   the top-level key names and the per-turn timestamp field names?

6 is what closed-tab recovery depends on; 2 and 3 are what live counting depends on.

### Site status

| Site | Adapter | Live counting | Closed-tab recovery | In manifest |
|---|---|---|---|---|
| chatgpt.com | written, verified 2026-09-30 | yes | yes (⚑7a–c still unconfirmed) | yes |
| gemini.google.com | written 2026-10-03 from the probe (below) | yes, verified live by the user 2026-10-04 | no: the loaded chat has no end time | yes |
| claude.ai | written 2026-10-03 from the probe (below) | yes, verified live by the user 2026-10-04 | no: no passive JSON load (decided 2026-10-03) | yes |
| perplexity.ai | written 2026-10-03 from the probe (below) | yes, verified live by the user 2026-10-04 | yes (⚑9a–c unconfirmed) | yes |
| copilot.microsoft.com | stub | not yet | not yet | no |
| grok.com | stub | not yet | not yet | no |
| you.com | stub | not yet | not yet | no |
| chat.deepseek.com | written 2026-10-04 from the probe (below) | yes, verified live by the user 2026-10-04 | no: the history load is a cache delta with no messages | yes |

### Probe results

**claude.ai (2026-10-03, two chats: one reply finished, one stopped, plus two chat loads).**
Probes: `spike/wide-probe.js`, then `spike/connect-frames.js` (schema-free protobuf field dump).
The six facts:

1. **Send:** `POST /claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction`,
   `application/proto`, binary body. The body is an envelope: field 1 is a common header
   (conversation id, plus a session id and a per-page action counter that goes up by one each
   action); then exactly one action field. **Field 2 = send** (message uuid, parent uuid, prompt).
   Field 15 = conversation settings (fired on chat create/open, not a send).
2. **Stream:** `POST .../StreamTimeline`, `application/connect+proto`. **Not SSE.** It is a
   long-lived subscription to the whole conversation's timeline, not a per-reply response.
3. **Frames:** Connect envelopes: 1 flag byte + 4-byte big-endian length + protobuf.
   Flag `0x01` = gzip-compressed message (`connect-content-encoding: gzip`), flag `0x02` = end
   of stream (JSON trailer). Each message's field 1 holds one event. Event field 1 = conversation
   state, where **`1.2.3` is a status: `2` while a reply runs, `1` when idle**. Event field 2 =
   text deltas for a content block (`cblk_…` id). Event field 14 = acknowledgement of a
   `PerformAction` (echoes the session id and counter). `1{6:<empty>}` every ~600 ms is a heartbeat.
   **The reply is over when status goes 2 → 1**: 70 ms before the stop button vanished on a
   finished reply, 80 ms before it on a stopped one. **The stream closing means nothing:** the
   server closes it every few seconds to minutes with trailer `Stream-Close-Reason: cadence`, and
   the page reopens it at once.
4. **Stop:** yes, its own request, the same millisecond as the click, **to the same
   `PerformAction` URL as a send**. The action field is **3 (empty)** instead of 2. The stream
   survives; status goes 2 → 1 about 420 ms after the press.
5. **Stop button:** `button[data-testid="chat-input-stop"]` (aria "Stop response"). Appeared
   ~500 ms after the send request, gone ~500 ms after Stop was pressed.
6. **Conversation load:** opening an old chat does **not** fetch it as JSON. The page gets a
   gzip snapshot as the first frame of a new `StreamTimeline` (messages with role, a creation time
   that is the reply's *start*, and a stop-reason code; no per-message end time). The legacy JSON
   endpoint `GET /api/organizations/{org}/chat_conversations/{id}` still answers when called, with
   `chat_messages[]` (`sender`, `created_at`, `stop_reason: end_turn | user_canceled`). On it, the
   human message's `created_at` is the send time and the **assistant's `created_at` is the reply's
   end** (within 40 ms of the status flip, finished and stopped alike). The page only calls it
   after creating a chat, not when opening one.

**What this means for the claude.ai adapter (decisions open, not taken):**
- ⚑8 is needed, and is bigger than a frame splitter: `parseEvent` must decode protobuf (by field
  number, with no schema) and gunzip flag-1 frames. Field numbers are not a public contract and
  could change without notice.
- `stopUrl` alone can't spot a Stop (same URL as send). The request body must be read too.
- Closed-tab recovery can't use the passive "page loads the conversation" signal the ChatGPT
  adapter relies on. Either the snapshot frame is parsed (start time only), or the extension
  calls the legacy JSON endpoint itself (needs the org id; the endpoint is undocumented and may
  be retired).

**gemini.google.com (2026-10-03, signed in, Gemini Flash: one reply that came back as Gemini's own
error, one finished, one stopped, one timed, plus chat loads).** Probe: `spike/wide-probe.js`.

1. **Send = stream:** one `XMLHttpRequest` (not `fetch`), `POST
   /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`, one per reply.
2. **Stream:** read by XHR `progress` events (10–46 per reply). Not SSE. ⚑8's hook must also wrap
   XHR, since `main-world.js` only wraps `fetch` today.
3. **Frames:** Google's batchexecute stream: a `)]}'` prefix, then repeated `<length>\n<JSON
   array>` chunks; reply chunks are `[["wrb.fr", null, "<JSON as a string>"]]` (double-encoded),
   and the response ends with a `[["di",…],["af.httprm",…]]` trailer. **The XHR ending is the
   reply's end** (finished reply: 26–58 ms before the stop button vanished).
4. **Stop:** its own request, the same millisecond as the click: `POST
   /_/BardChatUi/data/batchexecute?rpcids=NkpXw` (that rpc id appeared only on Stop, across ~25
   batchexecute calls). The stream survives it: the StreamGenerate XHR ended normally (status 200)
   ~610 ms after the press; the stop button was gone ~310 ms after the press, *before* the stream.
5. **Stop button:** `button[aria-label="Stop response"]` (Angular Material icon button, no test
   id; the aria label is localized, so it only holds for English UI). Appeared ~100 ms after the
   send XHR.
6. **Conversation load:** `POST /_/BardChatUi/data/batchexecute?rpcids=hNvQHb`, same chunked
   format, fired on a fresh page load and on opening a chat not already in memory (a chat
   revisited in the same page is served from memory, as on ChatGPT). Per turn: conversation id
   `c_…`, response id `r_…`, candidate ids `rc_…`, and **a single `[seconds, nanos]` timestamp**.
   That timestamp tracks the **send** (constant offset from send within ±0.2 s across three turns
   whose replies ran 3.5–11 s; against reply end it drifts by 7 s). One turn timed on the client
   clock put it 5.0 s after the send — but the Perplexity probe the same day showed this machine's
   clock running ~4.8 s behind server time, so it is most likely **the send time on the server
   clock**. **No end time and no duration** → closed-tab recovery on
   Gemini has no honest end to use: such records stay `pending` → unknown (§11 slot table).

**What this means for the Gemini adapter (decisions open):** live counting is straightforward
once the hook wraps XHR (⚑8: XHR seam + a batchexecute chunk splitter); Stop is a URL match on
`rpcids=NkpXw`; closed-tab recovery is not available from the conversation load.

**perplexity.ai (2026-10-03, signed in, free plan: one thread, three turns — two finished, one
stopped — plus a thread load).** Probe: `spike/wide-probe.js` plus an SSE event logger.

1. **Send = stream:** `fetch`, `POST /rest/sse/perplexity_ask`, one per turn (a follow-up is a
   new request on the same thread).
2. **Stream:** `content-type: text/event-stream; charset=utf-8`. **SSE**, so the existing parser
   fits; no ⚑8 seam needed.
3. **Frames:** `event: message` with a JSON `data:` holding the whole growing answer (`status:
   "PENDING"`, `text_completed`, `final_sse_message`, `message_mode: "STREAMING"`, uuids).
   **The reply is over at `event: end_of_stream`**, which follows one last `message` with
   `status: "COMPLETED"`, `final_sse_message: true`, `message_mode: "FULL"`. The page then
   **aborts the fetch itself** (1 ms later), so the response body never closes cleanly: a reader
   sees `AbortError`, not `done`. The adapter must end on `end_of_stream`, never on stream close,
   and must not treat that abort as a failure. The stop button vanished ~105 ms after
   `end_of_stream`.
4. **Stop:** its own request, 1 ms after the click: `POST /rest/sse/perplexity_terminate`, JSON
   body `{entry_uuid, context_uuid, model_preference, terminate_requested_at_ms}`. The stream
   survives and finishes the normal way (`COMPLETED` + `end_of_stream`) ~520 ms after the press;
   a stopped turn is still `status: "COMPLETED"` with no stop flag seen.
5. **Stop button:** `button[aria-label="Stop response (Esc)"]` (no test id; the label is
   localized — match the prefix `Stop response`). Appeared ~1.3 s after the send.
6. **Conversation load:** `GET /rest/thread/{slug}` (the slug is the `/search/{slug}` path
   segment), `application/json`, fetched on page load. Top level: `entries[]`, `status`,
   `thread_metadata`, cursors. Per entry: `status`, `entry_created_datetime`,
   `entry_updated_datetime` (ISO, server clock), uuids. **`entry_updated − entry_created` matched
   the reply's length** within +440, +230 and −10 ms on the three turns (for the stopped one,
   measured to the Stop press). Both are on the server clock, so the client/server skew cancels
   — the same approach as ChatGPT's `serverEnd − serverStart`.

**What this means for the Perplexity adapter:** the closest fit to the ChatGPT design of any site
so far: SSE, a dedicated stop URL, and a JSON conversation load with a usable duration. The one
new behaviour is "end on an event, ignore the page's own abort".

**Enabled 2026-10-03 (user decision), with these built but not yet seen on the live site:**

| ⚑ | Assumption | If wrong | Fix |
|---|---|---|---|
| ⚑9a | The send body has `params.frontend_uuid` and `params.frontend_context_uuid` (the probe saw its shape only as "JSON") | `sent` is `{null, null}`. Recovery still matches on the stream's `frontend_uuid` once the first event arrived; a tab closed before that falls back to send time, which this machine's ~4.8 s clock skew defeats → stays unknown, never invented | one line in `sendIds` |
| ⚑9b | The stream's `frontend_uuid` equals the thread entry's `frontend_uuid` | no id match; same fallback as above | pick the field that does match (`backend_uuid`, `uuid`) |
| ⚑9c | The page's abort never discards our copy's last chunk (on the probe our reader saw `end_of_stream` every time) | a finished reply ends as `error` at its last chunk: a few ms short, and flagged | none needed unless seen |

Shared-code changes this needed: `main-world.js` ends a stream that errors *after* its done
event as `completed`; `reconcile.js` takes `max(watched, server span)` instead of the sum when a
turn says `startIsSend` (Perplexity's span already includes the watched part). The pill's
position was tuned for ChatGPT's header and is untested on Perplexity.

**Claude and Gemini enabled 2026-10-03 (user decision), without closed-tab recovery.** ⚑8 was
built as two more reply shapes in `main-world.js` rather than a frame-splitter seam:
- **XHR** (Gemini): `XMLHttpRequest.prototype.open/send` are wrapped; a reply is timed from
  `send` to `loadend` (2xx = completed, else error), and `progress` gives first byte and alive.
  `matchQuery: true` makes URL patterns see the query, where Gemini names its rpc (`NkpXw`).
- **Timeline** (claude.ai): `requestKind(path, body)` reads the PerformAction's top-level field
  (2 = send, 3 = stop); `createTimelineDecoder` splits Connect envelopes, gunzips flag-1 frames
  and reports `running`/`idle` from status field 1.1.2.3. The reply ends on the first idle after
  running, on whichever timeline stream is open (they rotate). A reply never seen to go idle
  is closed off as `error`, with no duration, by the next send.

Built but not yet seen working end to end:

| ⚑ | Assumption | If wrong |
|---|---|---|
| ⚑10a | claude.ai's field numbers (send 2, stop 3, status 1.1.2.3) stay as observed in one session | sends go unseen (nothing counted) or never end (closed off at the next send as error; the live pill counts it at most until the 30 s staleness cutoff). An undercount in the stored total, never an overcount |
| ⚑10b | Gemini's page calls `XMLHttpRequest.prototype.send` (Closure's XhrIo does) | nothing counted on Gemini |
| ⚑10c | The pill's position (tuned for ChatGPT's header) doesn't cover controls on claude.ai or Gemini | cosmetic |

**Surviving a refresh (2026-10-03, user decision).** A refresh mid-reply used to drop that reply
from the pill (its record became `pending`, which counted nothing) and only ChatGPT and
Perplexity ever added it back. Now:
- **Every site:** an unfinished record that no tab is watching (pending, or silent past the
  30 s cutoff) counts `lastSeen − start`, in `summarize`, `liveTotal` and `breakdown` alike.
  A recovery later replaces it with the full span; it is never added twice.
- **claude.ai:** the reloaded page's timeline still reports the reply running. With no send
  from this page, `main-world.js` posts `resume`; `content.js` hands the tracker the newest
  record the previous page left in this tab (if its last sign of life is under 10 minutes
  old), which then counts live and ends on the same client clock, flagged `resumed`. A
  running reply with no such orphan (sent from another device or tab) is not counted here.
- **claude.ai liveness:** status messages come only at a reply's start and end, so a long
  reply used to go stale after 30 s. Every data frame (deltas, heartbeats) is now a sign of life.
- Not done: ChatGPT and Perplexity re-attach their stream on reload through endpoints we do
  not wrap, so their resumed tail is only counted when the conversation load recovers it.

**chat.deepseek.com (2026-10-04, signed in: one finished reply, one stopped, chat loads).**
1. **Send = stream:** one `XMLHttpRequest`, `POST /api/v0/chat/completion` (preceded by
   `create_pow_challenge`). Body: `chat_session_id, parent_message_id, model_type, prompt,
   ref_file_ids, thinking_enabled, search_enabled, action, preempt`.
2. **Stream:** `text/event-stream` over XHR; events `ready`, `update_session`, then JSON-patch-like
   `data:` lines (`{p, o: APPEND|SET|BATCH, v}`), and finally `close`.
3. **End:** `{p: "response/status", o: "SET", v: "FINISHED"}` (stopped: `"INCOMPLETE"`), then
   `update_session` and `close`; the XHR ends within ~10 ms, so the Gemini-style XHR shape
   (start to `loadend`) times it with no parsing.
4. **Stop:** its own XHR, `POST /api/v0/chat/stop_stream` (`chat_session_id, message_id`), at the
   press; the stream ended ~265 ms later with `INCOMPLETE`.
5. **Stop button:** no label or test id; the primary send button swaps its icon to a rounded
   square, matched as `.ds-button--primary path[d^="M2 4.88"]`. Fragile, but losing it only
   loses the cross-check.
6. **Conversation load:** `history_messages` on page load only (a revisit is served from
   memory), and it returned `chat_messages: []` with `cache_control: "MERGE"`: the app keeps
   messages in its own cache. No recovery; a closed tab keeps the watched time.
- **Model:** `model_type` (`"default"`) and `thinking_enabled` from the request body, stored as
  `deepseek-default[-deepthink]`, shown "DeepSeek" / "DeepSeek DeepThink". The stream's own
  `model` field was empty. (It also reports `accumulated_token_usage`, unused.)

**Live verification (2026-10-04, by the user):** all five enabled sites counted finished and
stopped replies; refresh mid-reply kept the count; Claude showed its model names (after a tab
refresh); edit-and-resend and retry/regenerate were counted on every site.

**Clock skew seen on this machine (2026-10-03):** Perplexity's server timestamps ran a steady
~4.8 s ahead of the client clock (created − send = 4.81–4.86 s on all three turns). Never mix a
client-clock time with a server-clock time in one subtraction.

**The manifest is the switch.** A stub is written but not listed, so it cannot run, cannot
half-count, and cannot quietly widen the permission list. A site moves into the manifest in
the same commit that fills in its verified values and flips `verified: true`.

### Permissions

`host_permissions` and the `matches` lists grow together, so the install warning reads
"read and change your data on N sites" and that list is exactly the set of sites being
measured. There is deliberately no wildcard: a broad grant would let an adapter file run
somewhere it was never probed.

## 12. Tamper resistance (added 2026-10-04, user decision)

**What cannot be done.** Everything runs and is stored on the user's machine, and the
extension is installed unpacked. Whoever wants a bigger number can edit the code or write to
`chrome.storage` directly; no client-side measure stops that, and none is attempted
(obfuscation was considered and rejected: it slows a determined cheater by minutes and costs a
readable public repo). The number is private today, so cheating only fools oneself. Any future
sharing feature must call a shared number *self-reported* unless a server is built.

**What is closed: cheap tricks, which are also correctness bugs.**

| Hole | Before | Now |
|---|---|---|
| Forged signals | main-world posted with `window.postMessage`, so any page script, console one-liner or other extension could post fake replies | A **private channel**: a detached element only main-world.js and content.js hold. Handed over synchronously at `document_start` (main-world fires a bubbling `aihours:hello` from it; content.js keeps `e.target` and answers `aihours:ack` on it), before any page script exists. main-world saves `dispatchEvent`, `addEventListener`, `appendChild`, `remove`, `CustomEvent` and `JSON.stringify` first, so a page patching them later sees nothing. Whichever script runs second completes the exchange (`aihours:ready` asks for the hello); after the ack, or once the page could be running scripts (`DOMContentLoaded`), neither side listens. content.js no longer reads window messages at all. Verified in headless Chrome, both orders |
| Page-supplied times | a forged end could claim any duration | content.js drops a signal whose time is non-numeric or over 10 min old, and clamps one in the future to now |
| Unbounded records | one record could be any length; any number could run at once | one reply counts at most **3 hours** (`MAX_REPLY_MS`, in `total.js`, the tracker, which flags `capped`, and recovery); at most **4** replies open per tab |
| Corrupt storage | a broken record could add NaN or negative time | `total.js` skips records with non-numbers, a start in the future, or an end before the start |

**Cost.** After an extension update, an open tab's new content script cannot pair (the page is
already running scripts, and pairing then would let the page answer in the hook's place), so
that tab stops counting new replies until it is refreshed. Totals still show. Hook changes
already needed a refresh, so this adds no new step.

**Fixed in 0.7.1:** 0.7.0 left such a tab silently not counting (the user hit it: "the timer
stopped working"). Before 0.7.0 a reload kept open tabs counting, because the old hook's window
messages reached the new content script, so the regression was invisible until then. An
unpaired tab now shows ↻ on its pill, titled "Refresh this tab to resume counting".
Re-pairing safely without a refresh would need signed messages between the halves; rejected
as too much machinery for a convenience. `npm run e2e` (test/e2e/) now checks this end to end
in headless Chrome against a local fake chatgpt.com: the real extension, loaded through CDP.


## 13. Sign-in and sync (added 2026-10-05, user decisions; design, not yet built)

**Why now.** Two features the user wants need data off the device: keep the history after
clearing browser storage or reinstalling, and see one total across devices. Decided: Google
sign-in, Neon as the backend, ship it as 1.1 after the store's 1.0.1.

**Shape.** No server code. The extension signs in with Google itself and sends its records to
Neon's Data API (PostgREST over Postgres) with Google's ID token. The Data API verifies the token
against Google's public keys (`https://www.googleapis.com/oauth2/v3/certs`, audience = our OAuth
client id) and runs every query as that user; Postgres row-level security lets a user read and
write only their own rows. Neon's Managed Better Auth was considered and rejected: it keeps
sessions in website cookies and does not yet support standalone frontends such as an extension.

```
extension ──chrome.identity──▶ Google ──ID token (JWT, ~1 h)──▶ extension
extension ──HTTPS, Bearer token──▶ Neon Data API ──RLS: user_id = token sub──▶ Postgres
```

**Sign-in.** `chrome.identity.launchWebAuthFlow` (new permission `identity`, which has no install
warning) opens Google's OpenID sign-in with `response_type=id_token`, `scope=openid`, a random
nonce, and redirect `https://<extension-id>.chromiumapp.org/`. No client secret is involved. When
the token expires, the same call with `prompt=none` renews it silently while the user is signed in
to Google; if that fails, sync pauses and the popup says "Sign in again". We ask for `openid` only:
no email, no name, no profile. Google's `sub` (a stable opaque id) is the user's whole identity
here.

**Data.** One table. Only what totals need: no conversation or message ids, no DOM details.

```sql
records (
  user_id    text   not null default auth.user_id(),  -- Google sub, from the token
  id         text   not null,                         -- the record's existing uuid
  site       text   not null,
  model      text,
  start_ms   bigint not null,
  end_ms     bigint,
  last_seen  bigint,
  outcome    text   not null,
  recovered_ms integer,
  updated_ms bigint not null,                         -- for last-writer-wins
  primary key (user_id, id)
)
```

Row-level security: `using (user_id = auth.user_id()) with check (user_id = auth.user_id())`.
The same sanity rules as §12 become CHECK constraints (end ≥ start, at most 3 h, no start in
the future, known sites only), so a forged upload can't exceed what the extension itself would
count. A shared number is still self-reported (§12).

**Sync.** Every record already has a stable id, so sync is idempotent upserts:
- Each local write stamps `updatedMs` and marks the record dirty (an outbox in storage).
- A `chrome.alarms` job every 5 minutes, plus one when the popup opens, sends dirty records in
  batches (`POST /records`, `Prefer: resolution=merge-duplicates`). A record leaves the outbox only
  after the server accepts it, so a crash or offline spell loses nothing.
- After sign-in on a new device or empty storage, it pulls all of the user's rows, paged, and keeps
  whichever copy of each record has the newer `updatedMs`. History from other devices is then
  counted like any finished record.
- Signed out, the extension works exactly as 1.0.x: local only, no network.

**User controls (popup).** Sign in with Google · Sign out (keeps local data) · Delete my synced
data (deletes every row of theirs on the server; local data stays).

**What changes outside the code.** PRIVACY.md: what is sent when signed in, where it lives
(Neon), and how to delete it. Store privacy answers: user data is transmitted, for sync only. The
README's "no server" line becomes "no server unless you sign in".

**Prerequisites only the developer can do:**
1. A fixed extension id. The store assigns one when the item is first uploaded (even as a draft);
   its public key goes into the dev manifest's `key` so an unpacked copy gets the same id.
2. A Google Cloud OAuth client, type "Web application", authorized redirect URI
   `https://<extension-id>.chromiumapp.org/`, consent screen "AI Hours". Its client id (not a
   secret) goes in the extension.

**Revised 2026-10-05 (user decision): Chrome sync first, sign-in optional.** The user found a
sign-in step too much friction for "don't lose my numbers", and lost history when an id change
reinstalled the extension (uninstalling deletes `chrome.storage.local`). Now:
- **Default, automatic:** each install writes a summary (totals per site and model) to
  `chrome.storage.sync` as `sum:<device-id>:<site>`, one item per site (8 KB item limit; past 60
  models a site folds its rarest into "not recorded", keeping the total exact), at most once a
  minute after a change and only when it changed (Chrome sync write quotas). Chrome keeps these in
  the user's Google account, restores them after a reinstall and copies them to other computers.
  Displayed total = this install's live ledger + `combine(...)` of every other install's
  summaries, skipping its own and those whose `sub` equals this install's signed-in account
  (their replies arrive as records). Without a device id an install counts no summaries.
  Covers only users signed into Chrome with sync on; others keep local-only totals.
- **Optional:** the Google sign-in + Neon full-history backup above, folded behind "Back up full
  history too…" in the popup.

**1.1 as released (2026-10-05):** Chrome-sync backup only. The optional Google sign-in + Neon
backup is not shipped: the user's first live attempt failed before the extension id was pinned,
and rather than ship an unverified feature with an extra permission (`identity`) and a privacy
policy that has to describe dormant upload code, it was taken out. `src/sync.js` and its tests
remain; the worker and popup wiring are in git at commit 2124ba6. The Neon project stays
provisioned (free tier, idle). A manifest test now fails if any loaded file names a server of
ours, so bringing it back is a deliberate change made together with PRIVACY.md and the store's
privacy answers.
