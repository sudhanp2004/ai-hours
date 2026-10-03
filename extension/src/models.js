// Display names for sites and models. Pure. Model slugs come from each site's own wire
// data; known families are tidied by rule, and anything unrecognised is shown as sent, so a
// new model appears immediately, just less prettily.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});

  // `recovers`: whether a reply whose tab closed mid-way can be finished later (spec §11).
  // Where it can't, that site's number can only err low, and the panel says so.
  const SITES = {
    chatgpt: { name: 'ChatGPT', recovers: true },
    perplexity: { name: 'Perplexity', recovers: true },
    claude: { name: 'Claude', recovers: false },
    gemini: { name: 'Gemini', recovers: false },
  };
  ns.siteInfo = (site) => SITES[site] ?? { name: String(site), recovers: false };

  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

  ns.modelName = function modelName(slug) {
    if (typeof slug !== 'string' || !slug) return null;
    // claude-opus-5-5, claude-haiku-4-5-20251001, claude-opus-4
    let m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(slug);
    if (m) return `${cap(m[1])} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
    // the older claude-3-5-sonnet-20241022
    m = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/.exec(slug);
    if (m) return `${cap(m[3])} ${m[1]}${m[2] ? '.' + m[2] : ''}`;
    // gpt-5, gpt-5-thinking, gpt-4.1-mini
    m = /^gpt-([\w.]+)((?:-[a-z]+)*)$/.exec(slug);
    if (m) return `GPT-${m[1]}${m[2].split('-').filter(Boolean).map((w) => ' ' + cap(w)).join('')}`;
    return slug;
  };
})(globalThis);
