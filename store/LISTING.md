# Chrome Web Store submission: AI Hours 1.0.0

Everything the developer dashboard asks for, in the order it asks. Copy each block into the
matching field.

## Package

Upload `dist/ai-hours-1.0.0.zip` (build it with `npm run package`; it contains only the files
the extension uses, and `npm run e2e -- <unzipped dir>` checks it works).

## Store listing tab

**Name** (from the manifest): AI Hours

**Summary** (132 characters max, from the manifest):
Counts how long AI has worked for you. Records when AI works, never what was said.

**Description:**

```
AI Hours shows you one number: how long AI has spent working for you.

Every time you send a message to ChatGPT, Claude, Gemini, Perplexity or DeepSeek, the AI spends
seconds or minutes thinking and writing. AI Hours times each reply, from the moment you press
Enter to the moment it finishes, and adds them up. Think of it as "minutes listened", but for AI.

• A small counter on each chat site ticks live while a reply is being written.
• Click it to see your time per assistant, and per model (Opus 5.5, GPT-5 Thinking, 3.6 Flash…).
• Stopped a reply? It counts until the moment you pressed Stop.
• Refreshed the page or closed the tab mid-reply? The time you watched is kept, and on ChatGPT
  and Perplexity the rest is recovered when you reopen the chat.

Private by design
• AI Hours records when the AI worked, never what was said. Your prompts and the replies are
  never stored or sent anywhere.
• Everything stays in your browser. No account, no server, no analytics, no tracking.
• It runs only on the five chat sites above.

Honest by design
• Each reply is measured from the site's own network activity and cross-checked against the
  page's Stop button.
• When something can't be measured, it's shown as partly counted, never guessed.

Open source: https://github.com/sudhanp2004/ai-hours
```

**Category:** Productivity → Tools (or "Workflow & Planning")

**Language:** English

**Graphic assets:**
- Store icon: `extension/icons/icon128.png`
- Screenshots (1280×800): `store/screenshot-1.png`, `store/screenshot-2.png`
- Small promo tile (440×280): `store/promo-tile-440x280.png`

**Official URL / homepage:** https://github.com/sudhanp2004/ai-hours
**Support URL:** https://github.com/sudhanp2004/ai-hours/issues

## Privacy practices tab

**Single purpose description:**

```
AI Hours measures how long AI chat assistants (ChatGPT, Claude, Gemini, Perplexity, DeepSeek)
spend generating replies for the user, and shows the total time, overall and per assistant and
model. It records only timing and the model's name, never the content of conversations.
```

**Permission justifications:**

- **storage**
  ```
  Saves the user's reply-timing records (site, model name, start and end times) locally in the
  browser, so the total survives restarts. Nothing is synced or sent anywhere.
  ```
- **unlimitedStorage**
  ```
  Timing records accumulate over months of use. Without this the 10 MB local quota could fill
  and the oldest history would be lost. Records hold only timing data, never conversation text.
  ```
- **scripting**
  ```
  On install and update, starts measuring in chat tabs that are already open, by running the
  extension's own bundled content scripts in them (chrome.scripting.executeScript with files
  from the package). No remote or dynamically built code is ever executed.
  ```
- **Host permissions** (chatgpt.com, www.perplexity.ai, claude.ai, gemini.google.com,
  chat.deepseek.com)
  ```
  The extension measures AI replies on exactly these five chat sites and nowhere else. On them
  it observes when the page's own request for a reply starts and ends, whether the user pressed
  Stop, and the name of the model that answered, in order to time each reply. It does not read,
  store or transmit prompts or replies.
  ```

**Are you using remote code?** No, I am not using remote code.

**Data usage**, what user data the extension collects. Tick:
- **Website content**: it reads timing, status and model-name fields from the chat sites' own
  network traffic. (Leave everything else unticked: no personally identifiable information,
  health, financial, authentication, personal communications, location, web history or user
  activity data is collected. Conversation text passes through the observed requests but is
  never recorded.)

Then certify all three:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/sudhanp2004/ai-hours/blob/main/PRIVACY.md

## Distribution tab

- **Visibility:** Public (or Unlisted for a soft launch: same review, link-only install)
- **Regions:** All regions

## After approval

- The store version has a **different extension id** from a "Load unpacked" copy, so its
  history starts empty. Remove the unpacked copy once the store one is installed, or you'll
  count every reply twice.
- Updates: bump `version` in `extension/manifest.json`, `npm run package`, upload the new ZIP
  in the dashboard. Users get it automatically, usually within a day. Remind them in the
  release notes to refresh open chat tabs.
