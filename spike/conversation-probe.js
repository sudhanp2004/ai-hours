// THROWAWAY SPIKE: AI Hours, closed-tab recovery probe. Not extension code; delete after.
//
// Purpose: confirm spec ⚑7a–c, the three field names the recovery code assumes but has
// never seen on the wire. It prints KEY NAMES AND TIMESTAMPS ONLY. Any string longer than
// 24 characters is replaced with <text>, so a prompt or a reply cannot end up in the log.
//
//   1. paste this into the DevTools console on chatgpt.com
//   2. send a short message
//   3. copy(__aiProbe.report())  and paste the output back
//
// Nothing here is stored; the log lives in this page's memory until you reload.
(() => {
  if (window.__aiProbe) { console.warn('[probe] already running'); return; }
  const FLAG = Symbol.for('aiHours.conversationProbe');
  if (window[FLAG]) { console.warn('[probe] already installed'); return; }
  Object.defineProperty(window, FLAG, { value: true });

  const journal = [];
  const log = (msg) => { journal.push(msg); console.log('%c[probe]', 'color:#c60;font-weight:bold', msg); };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Anything that could be text becomes <text>. Numbers, booleans, null and ids survive.
  const safe = (v, depth = 0) => {
    if (depth > 3) return '<deep>';
    if (v === null || typeof v === 'boolean' || typeof v === 'number') return v;
    if (typeof v === 'string') return UUID.test(v) || v.length <= 24 ? v : '<text>';
    if (Array.isArray(v)) return v.slice(0, 3).map((x) => safe(x, depth + 1));
    if (typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).map((k) => [k, safe(v[k], depth + 1)]));
    }
    return typeof v;
  };

  const origFetch = window.fetch;
  window.fetch = async function probeFetch(input, init) {
    let path = '';
    try { path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname; } catch {}
    const t = Math.round(performance.now());

    // ⚑7a / ⚑7b: the send request. We only ever look at the body's key names and ids.
    if (/\/backend-(api|anon)\/f\/conversation$/.test(path)) {
      const how = init?.body === undefined
        ? (input instanceof Request ? 'Request object (body unread unless cloned)' : 'no init.body')
        : init.body?.constructor?.name || 'unknown';
      let body = null;
      try { body = typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch { body = '<not a string>'; }
      log(`SEND t=${t}ms bodyVia=${how} topLevelKeys=${JSON.stringify(body ? Object.keys(body) : null)}`);
      if (body?.messages?.length) {
        const last = body.messages[body.messages.length - 1];
        log(`SEND lastMessageKeys=${JSON.stringify(Object.keys(last))} lastAuthorRole=${last?.author?.role} lastHasId=${!!last?.id}`);
      }
    }

    // ⚑7c: which endpoint loads a chat, and with what content type.
    if (/\/backend-(api|anon)\/conver/.test(path)) {
      log(`CONVERSATION REQ t=${t}ms path=${path} method=${init?.method || (input instanceof Request ? input.method : 'GET')}`);
    }

    const res = await origFetch.apply(window, arguments);
    if (/\/backend-(api|anon)\/conversations\//.test(path)) {
      const ct = res.headers.get('content-type') || '';
      log(`CONVERSATION RES t=${Math.round(performance.now())}ms ok=${res.ok} contentType=${ct}`);
      res.clone()
        .json()
        .then((json) => {
          log(`CONVERSATION topLevelKeys=${JSON.stringify(Object.keys(json))} messageCount=${json.messages?.length ?? 'none'}`);
          for (const m of (json.messages || []).slice(0, 4)) {
            log(`  msg role=${m.author?.role} keys=${JSON.stringify(Object.keys(m))}`);
            log(`    metadata=${JSON.stringify(safe(m.metadata))}`);
            log(`    create_time=${m.create_time} update_time=${m.update_time} status=${m.status}`);
          }
        })
        .catch((e) => log(`CONVERSATION body not JSON: ${e.message}`));
    }
    return res;
  };

  window.__aiProbe = {
    report: () => journal.join('\n'),
    stop: () => { window.fetch = origFetch; delete window.__aiProbe; },
  };
  log('installed: send one short message, then copy(__aiProbe.report())');
})();
