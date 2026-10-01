# Plan: multiple sites (spec §11)

Adds every major chat LLM as a supported site. The adapter shape already exists from
v1; this work generalises the hardcoded `ns.chatgpt` slot into `ns.site`, splits sites
into per-site adapter pairs, makes the service worker inject only the entries a tab
actually matches, and scaffolds seven unverified sites that stay out of the manifest
until their wire behaviour is confirmed.

Rules that must not be broken:

- **Nothing is measured on a site that was not probed.** A stub is `verified: false` and
  absent from the manifest, so it cannot run.
- **The manifest is the switch.** A site is enabled by adding both its halves to the
  manifest in the same commit that sets `verified: true`.
- **One number, no breakdown.** Totals keep summing across sites; nothing in `total.js`
  learns about sites.
- **No text ever.** New adapters reuse the structural-signal shape, never message text.

## Task order

| # | Task | Files |
|---|---|---|
| 1 | Rename the single adapter slot `ns.chatgpt` → `ns.site`, add `verified` + `hosts` | `src/sites/chatgpt-{network,page}.js`, `main-world.js`, `content.js` |
| 2 | Move adapters into `src/sites/` | `git mv` + test paths |
| 3 | `manifest-match.js` (pure): which content_scripts entries fit a tab | new, `test/manifest-match.test.js` |
| 4 | `background.js`: inject only the entries matching each tab's URL | `background.js`, `test/background.test.js` |
| 5 | `content.js` hosts guard: refuse a page whose domain the adapter doesn't claim | `content.js`, `test/content.test.js` |
| 6 | Rewrite `test/manifest.test.js` for multiple entries per world | `test/manifest.test.js` |
| 7 | Scaffold seven `verified: false` adapters, out of the manifest | `src/sites/*` |
| 8 | `spike/site-probe.js`: one paste that prints the six facts per site | `spike/site-probe.js` |
| 9 | Spec §11 and the "verify per site" checklist the user runs | spec |

## Design details worth stating before coding

### The single slot, not a registry

Exactly one adapter file is ever loaded per page, because the manifest matches are
disjoint domains. So `ns.site` is a single object each world writes half of
(`Object.assign`), and `main-world.js` reads `ns().site` at call time (so a re-injected
adapter takes effect) while `content.js` reads `ns.site` once. A keyed registry would be
code that never runs.

### The hosts guard is the honest failure

`content.js` returns before touching anything unless `ns.site.hosts` covers
`location.hostname`. If the manifest and the adapter ever disagree, the page records
nothing rather than recording against the wrong stop-button selector. Silence is
recoverable; wrong numbers are not.

### Re-injection must pick the right entries

The v1 worker injected *every* content_scripts entry into every open tab. With one site
that is fine; with two, a Claude tab would be given ChatGPT's stop-button selector and
flag every reply `dom-missing`. `manifest-match.js` compiles each match pattern and the
worker filters by `tab.url`. With no readable `tab.url`, every entry is offered and the
page's hosts guard is the backstop.

### Full parity's ceiling

A site whose chats load from memory (no JSON conversation-load fetch) gets live counting
and the pill, but no closed-tab recovery — its closed-tab records stay `pending` and are
reported unknown. That is structural parity with an honest gap, not a reduced feature set
hand-built per site.

## Verification you run, per site (Task 9)

1. Load `spike/site-probe.js` in the site's DevTools, reload, send a long prompt.
2. Type `REPORT` and paste the output back. The probe prints the six facts of spec §11.
3. For each site, we fill the adapter, set `verified: true`, add both entries to the
   manifest, and run the same manual checks as the ChatGPT E2E: a streamed reply counts,
   Stop freezes at the press, and a close then reopen recovers (if the site supports it).
