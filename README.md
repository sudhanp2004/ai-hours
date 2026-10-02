# AI Hours

A Chrome extension that measures how long AI has worked for you: the time from pressing
Enter until the reply finishes, added up across every chat. One number, like Spotify's
minutes listened, but for AI.

**Private by design.** AI Hours records *when* an AI worked, never *what* was said. It never
reads or stores your prompts or the replies. Everything stays in your browser's local
storage: there is no server, no account and no analytics.

## Supported sites

| Site | Live counting | Reply finished in a closed tab |
|---|---|---|
| chatgpt.com | yes | recovered when you reopen the chat |
| perplexity.ai | yes (new, not yet tested end to end) | recovered when you reopen the thread |

A site is only added once its network behaviour has been checked by hand, so the number stays
honest. Claude, Gemini, Copilot, Grok, DeepSeek and You.com have placeholder adapters but are
**not** enabled.

## Install (no Chrome Web Store)

1. Download this repository: **Code → Download ZIP**, then unzip it. Or clone it:
   `git clone https://github.com/sudhanp2004/ai-hours.git`
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `extension` folder inside the download (the one that
   contains `manifest.json`).
5. Open ChatGPT or Perplexity and send a message. A small counter appears at the top right,
   and clicking the AI Hours toolbar icon (pin it from the puzzle-piece menu) shows your total.

Chrome may show a "Disable developer mode extensions" notice when it starts. That is normal for
extensions installed this way; click the × to dismiss it.

### Updating

Extensions loaded this way do not update themselves. Download the new version (or `git pull`),
then click the ↻ reload icon on the AI Hours card in `chrome://extensions`. Your total is kept.

## How it works

- A script in the chat page notices the request that streams the reply, and times it from
  send to the reply's end marker. It reads only ids, status fields and timestamps.
- The page's Stop button is watched as a second, independent check. A reply seen only one way
  is still counted, but flagged.
- If you close a tab mid-reply, the record waits. When you reopen that chat, the site's own
  saved timestamps finish it. If they can't, it is reported as unknown, never guessed.

The design, and what was verified on each site, is in
[`docs/superpowers/specs/2026-09-30-ai-hours-v1-design.md`](docs/superpowers/specs/2026-09-30-ai-hours-v1-design.md).

## Development

No build step: the `extension` folder is loaded as is.

```sh
npm test   # Node's built-in test runner, no dependencies
```
