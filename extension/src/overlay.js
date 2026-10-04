// The on-page counter pill (ISOLATED world). A closed shadow root keeps the site's styles
// and ours apart. Clicking the pill opens a panel with the time per LLM and per model
// (spec §11, Breakdown); it is the only part of the page we take clicks from.
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
      cursor: pointer; user-select: none;
      /* Arrives like a popup rather than already being there: hidden on the first frame,
         faded in once the document is up, so the eye follows it in instead of finding it. */
      opacity: 0; transform: translateY(-6px) scale(0.96);
      transition: opacity 260ms ease-out, transform 260ms cubic-bezier(0.2, 0.9, 0.3, 1);
    }
    @media (prefers-color-scheme: dark) {
      .pill { --bg: rgba(40, 40, 40, 0.92); --fg: #f2f2f2; --idle: #6b6b6b; }
    }
    :host(.shown) .pill { opacity: 1; transform: none; }
    .pill:focus-visible { outline: 2px solid var(--live); outline-offset: 2px; }
    .panel {
      --bg: rgba(255, 255, 255, 0.98); --fg: #1a1a1a; --muted: #6b6b6b;
      position: fixed; right: 16px; top: 94px; z-index: 2147483647; box-sizing: border-box;
      width: 280px; max-height: min(70vh, 480px); overflow: auto; padding: 12px 10px 10px;
      border-radius: 12px; background: var(--bg); color: var(--fg);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18), 0 1px 3px rgba(0, 0, 0, 0.1);
      font: 13px/1.35 system-ui, sans-serif; animation: drop 160ms cubic-bezier(0.2, 0.9, 0.3, 1);
    }
    .panel[hidden] { display: none; }
    @media (prefers-color-scheme: dark) {
      .panel { --bg: rgba(36, 36, 36, 0.98); --fg: #f2f2f2; --muted: #a0a0a0; }
    }
    .head { display: flex; justify-content: space-between; align-items: baseline; padding: 0 6px 8px; }
    .label { color: var(--muted); }
    .total { font-weight: 700; font-size: 15px; font-variant-numeric: tabular-nums; }
    @keyframes drop { from { opacity: 0; transform: translateY(-4px); } }
    .width { color: var(--live); font-weight: 700; }
    .stale { color: #c47f00; font-weight: 700; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--idle); }
    .live .dot { background: var(--live); animation: pulse 1s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.35; } }
    @media (prefers-reduced-motion: reduce) {
      .pill { transition: none; transform: none; }
      .live .dot { animation: none; }
      .panel { animation: none; }
    }
  `;

  ns.createOverlay = function createOverlay(doc) {
    // Reloading the extension gives the new copy a different isolated world, so the old
    // content script's cleanup is invisible to us and its pill would sit in the page for
    // good. Sweeping by tag name is the only check that crosses that boundary.
    for (const stale of doc.querySelectorAll('ai-hours-counter')) stale.remove();

    const host = doc.createElement('ai-hours-counter');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML =
      `<style>${CSS}${ns.BREAKDOWN_CSS}</style>` +
      '<div class="pill" role="button" tabindex="0" aria-haspopup="dialog" aria-expanded="false">' +
      '<span class="dot"></span><span class="time"></span><span class="width"></span><span class="stale"></span></div>' +
      '<div class="panel" role="dialog" aria-label="AI time by assistant" hidden>' +
      '<div class="head"><span class="label">AI has worked for you</span><span class="total"></span></div>' +
      '<div class="body"></div></div>';
    const pill = shadow.querySelector('.pill');
    const time = shadow.querySelector('.time');
    const width = shadow.querySelector('.width');
    const staleMark = shadow.querySelector('.stale');
    let stale = false;
    const panel = shadow.querySelector('.panel');
    const total = shadow.querySelector('.total');
    panel.hidden = true; // also set in the markup; said here too so no state can show it early
    const view = ns.createBreakdownPanel(shadow.querySelector('.body'));
    let revealed = false;
    let open = false;
    let getData = null; // the breakdown is only computed while the panel is open

    function paint() {
      if (!open || !getData) return;
      const data = getData();
      total.textContent = ns.formatClock(data.ms);
      view.update(data);
    }

    function setOpen(next) {
      open = next;
      panel.hidden = !next;
      pill.setAttribute('aria-expanded', String(next));
      paint();
    }

    pill.addEventListener('click', () => setOpen(!open));
    pill.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      setOpen(!open);
    });
    // A press anywhere else, or Escape, closes it, like any popover.
    const onPress = (e) => {
      if (open && !e.composedPath().includes(host)) setOpen(false);
    };
    const onKey = (e) => {
      if (open && e.key === 'Escape') setOpen(false), pill.focus();
    };
    doc.addEventListener('pointerdown', onPress, true);
    doc.addEventListener('keydown', onKey, true);

    return {
      // `working` is how many replies are gaining time across every tab. Shown when above 1,
      // because otherwise the seconds appear to move faster than they should, which looks
      // like a bug rather than two tabs both working.
      // `breakdown` returns the per-LLM data; it is called only while the panel is open.
      render(ms, working, breakdown) {
        if (breakdown) getData = breakdown;
        // Re-attach if the page's own re-rendering ever removes us; body is null at document_start.
        if (!host.isConnected && doc.body) doc.body.appendChild(host);
        time.textContent = ns.formatClock(ms);
        width.textContent = working > 1 ? `×${working}` : '';
        staleMark.textContent = stale ? '↻' : '';
        pill.classList.toggle('live', working > 0);
        pill.title = stale
          ? 'Refresh this tab to resume counting: AI Hours was updated, and an open tab only reconnects on a refresh'
          : working > 1
            ? `AI is working ${working} times over for you`
            : working === 1
              ? 'AI is working for you'
              : 'Time AI has worked for you. Click for each assistant';
        // Once the page has been up long enough to be read, fade in. Waiting for a paint
        // matters: body is empty at document_start, so this is the first moment we can.
        if (!revealed && doc.body && doc.body.isConnected) {
          revealed = true;
          const show = () => host.classList.add('shown');
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(show);
          else show();
        }
        paint();
      },
      // This tab could not pair with the page hook, so new replies here are not counted.
      setStale(next) {
        stale = next;
      },
      remove() {
        doc.removeEventListener('pointerdown', onPress, true);
        doc.removeEventListener('keydown', onKey, true);
        host.remove();
      },
    };
  };
})(globalThis);
