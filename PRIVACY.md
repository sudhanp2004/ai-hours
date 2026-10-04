# AI Hours: Privacy Policy

Last updated: 4 October 2026

AI Hours is a browser extension that measures how long AI chat assistants spend working on
your replies, and shows you the total. This policy explains what it reads, what it keeps, and
where that goes.

## The short version

- AI Hours records **when** an AI worked for you, never **what** was said. Your prompts and the
  AI's replies are never stored, copied or sent anywhere.
- Everything it records stays **in your own browser**. AI Hours has no server and no account,
  and it sends no data to the developer or to anyone else.
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

This data never leaves your browser. It is not synced to other devices, and the developer
cannot see it.

## Sharing and selling

AI Hours does not sell, share, rent or transfer any data. It does not use data for advertising,
for creditworthiness or lending decisions, or for any purpose other than showing you your own
totals.

## Deleting your data

Removing the extension from your browser deletes everything it stored.

## Changes to this policy

If AI Hours ever starts sending data anywhere (for example, an optional sync between your own
devices), this policy will be updated before that version is released, and the feature will say
plainly what it sends.

## Contact

Questions about this policy: open an issue at https://github.com/sudhanp2004/ai-hours/issues.
