// The on-page counter pill (ISOLATED world). A closed shadow root keeps ChatGPT's styles and
// ours apart; pointer-events: none means it can never block a click on the page.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});

  const CSS = `
    :host { all: initial; }
    .pill {
      --bg: rgba(255, 255, 255, 0.92); --fg: #1a1a1a; --idle: #b0b0b0; --live: #10a37f;
      /* Top right, below ChatGPT's own header rather than inside it: the header's right end
         holds the Share button and the account menu, and a pill on top of those reads as
         part of the page instead of as a separate thing. 60px clears the ~48px header. */
      position: fixed; right: 16px; top: 60px; z-index: 2147483647;
      display: flex; align-items: center; gap: 7px; padding: 6px 11px; border-radius: 999px;
      background: var(--bg); color: var(--fg); box-shadow: 0 1px 6px rgba(0, 0, 0, 0.18);
      font: 600 12px/1 system-ui, sans-serif; font-variant-numeric: tabular-nums;
      pointer-events: none; user-select: none;
    }
    @media (prefers-color-scheme: dark) {
      .pill { --bg: rgba(40, 40, 40, 0.92); --fg: #f2f2f2; --idle: #6b6b6b; }
    }
    .width { color: var(--live); font-weight: 700; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--idle); }
    .live .dot { background: var(--live); animation: pulse 1s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.35; } }
    @media (prefers-reduced-motion: reduce) { .live .dot { animation: none; } }
  `;

  ns.createOverlay = function createOverlay(doc) {
    const host = doc.createElement('ai-hours-counter');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${CSS}</style><div class="pill"><span class="dot"></span><span class="time"></span><span class="width"></span></div>`;
    const pill = shadow.querySelector('.pill');
    const time = shadow.querySelector('.time');
    const width = shadow.querySelector('.width');

    return {
      // `working` is how many replies are gaining time across every tab. Shown when above 1,
      // because otherwise the seconds appear to move faster than they should, which looks
      // like a bug rather than two tabs both working.
      render(ms, working) {
        // Re-attach if the page's own re-rendering ever removes us; body is null at document_start.
        if (!host.isConnected && doc.body) doc.body.appendChild(host);
        time.textContent = ns.formatClock(ms);
        width.textContent = working > 1 ? `×${working}` : '';
        pill.classList.toggle('live', working > 0);
        pill.title =
          working > 1
            ? `AI is working ${working} times over for you`
            : working === 1
              ? 'AI is working for you'
              : 'Time AI has worked for you';
      },
      remove() {
        host.remove();
      },
    };
  };
})(globalThis);
