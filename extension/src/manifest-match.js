// Which manifest content_scripts entries belong in a given tab (spec §11). Pure.
// The worker needs this because a tab must only be given the adapter for its own site:
// injecting ChatGPT's scripts into a Claude tab is pointless, and injecting a *page-side*
// adapter there would install the wrong stop-button selector.
(function (root) {
  const ns = (root.__aiHours = root.__aiHours || {});
  const cache = new Map();

  // A Chrome match pattern: <scheme>://<host><path>, where the path is a glob.
  function compile(pattern) {
    const hit = cache.get(pattern);
    if (hit !== undefined) return hit;
    const m = /^(\*|[a-z]+):\/\/([^/]*)(\/.*)$/.exec(pattern);
    const re = m
      ? new RegExp(
          '^' +
            (m[1] === '*' ? '[a-z]+' : m[1]) +
            '://' +
            // `*` in a host is a subdomain wildcard; everything else is literal.
            m[2].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') +
            m[3].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') +
            '$',
        )
      : null;
    cache.set(pattern, re);
    return re;
  }

  function matchesAny(patterns, url) {
    if (!url || !Array.isArray(patterns)) return false;
    return patterns.some((p) => {
      const re = compile(p);
      return re ? re.test(url) : false;
    });
  }

  // With no url (Chrome withholds it without a matching host permission) every entry is
  // returned. That is the safe direction: an adapter for the wrong site finds no matching
  // URL to react to, and content.js refuses on its hosts check, so nothing is miscounted.
  ns.scriptsFor = function scriptsFor(entries, url) {
    if (!url) return entries;
    return entries.filter((e) => matchesAny(e.matches, url));
  };
  ns.matchesAny = matchesAny;
})(globalThis);
