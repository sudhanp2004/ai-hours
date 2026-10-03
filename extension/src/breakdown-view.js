// The per-LLM panel, shared by the on-page pill and the toolbar popup. Pure: data in, HTML
// out. Everything that came from a site (model slugs) is escaped before it reaches markup.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Names a time cell, so a tick can update it in place instead of rebuilding the panel.
  const key = (site, model) => (model === undefined ? site : `${site}|${model ?? ''}`);

  const MARK_TITLE = 'May be a little low: a reply in a tab closed mid-way can’t be recovered on this site';

  // `expanded` is the set of sites whose models are showing.
  ns.breakdownHtml = function breakdownHtml(data, expanded) {
    if (!data.sites.length) return '<div class="bd"><p class="bd-empty">No AI time recorded yet.</p></div>';
    let marked = false;
    const rows = data.sites.map((s) => {
      const info = ns.siteInfo(s.site);
      const open = expanded.has(s.site);
      if (!info.recovers) marked = true;
      const mark = info.recovers ? '' : `<span class="mark" title="${esc(MARK_TITLE)}">*</span>`;
      const models = open
        ? `<ul class="bd-models">${s.models
            .map((m) => {
              const name = m.model == null ? '<span class="muted">Model not recorded</span>' : esc(ns.modelName(m.model));
              return `<li class="${m.working ? 'live' : ''}"><span class="name">${name}</span><span class="t" data-k="${esc(key(s.site, m.model))}">${esc(ns.formatClock(m.ms))}</span></li>`;
            })
            .join('')}</ul>`
        : '';
      return (
        `<li class="bd-site${s.working ? ' live' : ''}">` +
        `<button type="button" class="bd-row" data-site="${esc(s.site)}" aria-expanded="${open}">` +
        `<span class="chev" aria-hidden="true"></span><span class="name">${esc(info.name)}${mark}</span>` +
        `<span class="t" data-k="${esc(key(s.site))}">${esc(ns.formatClock(s.ms))}</span></button>${models}</li>`
      );
    });
    const note = marked
      ? '<p class="bd-note"><span class="mark">*</span> Replies in a tab closed mid-reply can’t be recovered on these sites, so their time may be a little low.</p>'
      : '';
    return `<div class="bd"><ul class="bd-sites">${rows.join('')}</ul>${note}</div>`;
  };

  // A live panel in `container`: rows toggle open on click, and update(data) redraws only
  // when the rows themselves change. Between those, a tick just rewrites the times, so a
  // click is never lost to a rebuild and keyboard focus stays where it was.
  ns.createBreakdownPanel = function createBreakdownPanel(container) {
    const expanded = new Set();
    let shape = null;
    let last = null;

    const shapeOf = (data) =>
      JSON.stringify(data.sites.map((s) => [s.site, s.working > 0, expanded.has(s.site) ? s.models.map((m) => [m.model, m.working > 0]) : 0]));

    function update(data) {
      last = data;
      const next = shapeOf(data);
      if (next !== shape) {
        const focused = container.getRootNode?.().activeElement?.dataset?.site;
        container.innerHTML = ns.breakdownHtml(data, expanded);
        shape = next;
        if (focused) rowFor(focused)?.focus();
        return;
      }
      const times = new Map();
      for (const s of data.sites) {
        times.set(key(s.site), ns.formatClock(s.ms));
        for (const m of s.models) times.set(key(s.site, m.model), ns.formatClock(m.ms));
      }
      for (const el of container.querySelectorAll('[data-k]')) {
        const t = times.get(el.dataset.k);
        if (t != null && el.textContent !== t) el.textContent = t;
      }
    }

    const rowFor = (site) => [...container.querySelectorAll('.bd-row')].find((b) => b.dataset.site === site);

    container.addEventListener('click', (e) => {
      const row = e.target.closest?.('.bd-row');
      if (!row || !last) return;
      const site = row.dataset.site;
      if (expanded.has(site)) expanded.delete(site);
      else expanded.add(site);
      update(last); // restores focus to the row if it had it (keyboard), never forces it
    });

    return { update, expanded };
  };

  // Scoped under .bd so it can sit in the popup's page and in the pill's shadow root alike.
  ns.BREAKDOWN_CSS = `
    .bd { --bd-fg: #1a1a1a; --bd-muted: #6b6b6b; --bd-line: rgba(0,0,0,0.08); --bd-hover: rgba(0,0,0,0.05); --bd-live: #10a37f;
          font: 13px/1.35 system-ui, sans-serif; color: var(--bd-fg); font-variant-numeric: tabular-nums; }
    @media (prefers-color-scheme: dark) {
      .bd { --bd-fg: #f2f2f2; --bd-muted: #a0a0a0; --bd-line: rgba(255,255,255,0.1); --bd-hover: rgba(255,255,255,0.07); }
    }
    .bd ul { list-style: none; margin: 0; padding: 0; }
    .bd-site + .bd-site { border-top: 1px solid var(--bd-line); }
    .bd-row { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%;
              padding: 8px 6px; border-radius: 6px; cursor: pointer; font-weight: 600; }
    .bd-row:hover { background: var(--bd-hover); }
    .bd-row:focus-visible { outline: 2px solid var(--bd-live); outline-offset: -2px; }
    .chev { width: 0; height: 0; border-left: 5px solid var(--bd-muted); border-top: 4px solid transparent;
            border-bottom: 4px solid transparent; transition: transform 150ms ease; }
    .bd-row[aria-expanded="true"] .chev { transform: rotate(90deg); }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .t { white-space: nowrap; }
    .live > .bd-row .t, .bd-models .live .t { color: var(--bd-live); }
    .bd-models { padding: 0 6px 8px 19px !important; }
    .bd-models li { display: flex; gap: 8px; padding: 3px 0; color: var(--bd-muted); }
    .muted { font-style: italic; }
    .mark { color: var(--bd-muted); font-weight: 400; margin-left: 2px; cursor: help; }
    .bd-note { margin: 8px 0 0; font-size: 11px; color: var(--bd-muted); }
    .bd-empty { margin: 4px 0; color: var(--bd-muted); }
    @media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
  `;
})(globalThis);
