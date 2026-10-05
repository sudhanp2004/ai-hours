# AI Hours: Privacy Policy

Last updated: 5 October 2026

AI Hours is a browser extension that measures how long AI chat assistants spend working on
your replies, and shows you the total. This policy explains what it reads, what it keeps, and
where that goes.

## The short version

- AI Hours records **when** an AI worked for you, never **what** was said. Your prompts and the
  AI's replies are never stored, copied or sent anywhere.
- What it records stays **in your own browser**, and its totals are also backed up through
  **Chrome sync**, Chrome's own feature for keeping your data across your devices. AI Hours
  has no server and no account, and it sends nothing to the developer or to anyone else.
- There is no analytics, no tracking and no advertising.

## Where it runs

AI Hours runs only on these sites, and only to measure replies there:

- chatgpt.com
- www.perplexity.ai
- claude.ai
- gemini.google.com
- chat.deepseek.com

It does not run on any other website.

## What it reads on those sites

To time a reply, AI Hours watches the page's own network requests and its Stop button. From
those it reads only:

- when a reply starts and ends, and whether you stopped it;
- technical identifiers the site attaches to a message (such as a message or conversation id),
  used to match a reply whose tab you closed with the site's saved copy;
- the name of the AI model that answered (for example "Opus 5.5" or "GPT-5"), so the panel can
  show time per model.

The text of your prompts and of the AI's replies passes through the same requests. AI Hours
does not record it, store it or send it anywhere.

## What it stores

For each reply, AI Hours stores a small record in your browser's extension storage
(`chrome.storage.local`): which site, the model's name, start and end times, the identifiers
above, and a few technical flags about how the reply was measured. Your total is calculated
from these records.

The individual records never leave your browser, and the developer cannot see them.

## Backup through Chrome sync

So that your totals survive reinstalling the extension and appear on your other computers,
AI Hours keeps a small summary in Chrome's sync storage (`chrome.storage.sync`): for this
browser, the total time per assistant and per model, under a random identifier for this
installation. No prompts, replies, conversation ids, timestamps of individual replies or account
details are in it.

Chrome stores and syncs this summary through your Google account, the same way it syncs your
bookmarks and settings, and only if you are signed into Chrome with sync turned on. It is held
by Google under your account, not by the developer, who has no access to it. If Chrome sync is
off, the summary stays on this computer only.

## Sharing and selling

AI Hours does not sell, share, rent or transfer any data. It does not use data for advertising,
for creditworthiness or lending decisions, or for any purpose other than showing you your own
totals.

## Deleting your data

Removing the extension deletes everything it stored in your browser. The Chrome sync summary
stays in your Google account (so a reinstall can restore your totals) until you clear it: in
Chrome, open Settings → You and Google → Sync → "Review your synced data", and choose
**Delete data**, or reset sync at https://chrome.google.com/sync. Note that this clears all of
your Chrome sync data, not only AI Hours'.

## Changes to this policy

If AI Hours ever starts sending data anywhere else (for example, an optional sign-in that backs
up every reply), this policy will be updated before that version is released, and the feature
will say plainly what it sends.

## Contact

Questions about this policy: open an issue at https://github.com/sudhanp2004/ai-hours/issues.
