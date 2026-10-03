const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/total.js');
require('../extension/src/models.js');
require('../extension/src/breakdown-view.js');
require('../extension/src/overlay.js');
const ns = globalThis.__aiHours;

// A document just real enough for the overlay: a tag-named element, a shadow root, and a
// body that reports whether it is connected.
function fakeDoc() {
  const make = (tag) => {
    const el = {
      // The DOM upper-cases tag names, and the stale-pill sweep matches on that.
      tagName: tag.toUpperCase(), isConnected: false, textContent: '', className: '',
      classList: {
        toggle(c, on) { el.className = on ? c : ''; },
        add(c) { el.className = `${el.className} ${c}`.trim(); },
        contains: (c) => el.className.split(/\s+/).includes(c),
      },
      style: {}, dataset: {},
      attrs: {}, handlers: {}, hidden: false,
      setAttribute(k, v) { el.attrs[k] = v; }, getAttribute: (k) => el.attrs[k] ?? null, remove() {},
      addEventListener(type, fn) { el.handlers[type] = fn; }, focus() { el.focused = true; },
      querySelectorAll: () => [],
      appendChild(c) { c.isConnected = this.isConnected; return c; },
      querySelector: () => null,
    };
    return el;
  };
  const parts = {};
  const doc = {
    existing: [], // elements the page already had before we got here
    body: make('body'),
    createElement: (tag) => {
      const el = make(tag);
      el.attachShadow = () => ({
        set innerHTML(_) {},
        querySelector: (sel) => (parts[sel] ??= make(sel)),
      });
      return el;
    },
    querySelectorAll: (sel) => doc.existing.filter((e) => e.tagName === sel.toUpperCase()),
    handlers: {},
    addEventListener(type, fn) { doc.handlers[type] = fn; },
    removeEventListener(type, fn) { if (doc.handlers[type] === fn) delete doc.handlers[type]; },
  };
  doc.parts = parts;
  // The host is the first element createOverlay makes; the test needs it to read the
  // `shown` class, because that lands on the host, not on the pill inside the shadow root.
  doc.hostOf = (created) => created[0];
  const origCreate = doc.createElement;
  const created = [];
  doc.createElement = (tag) => {
    const el = origCreate(tag);
    created.push(el);
    return el;
  };
  doc.created = created;
  return doc;
}

test('a pill left over from the previous extension is removed, not left beside the new one', () => {
  const doc = fakeDoc();
  const stale = doc.createElement('ai-hours-counter');
  const other = doc.createElement('ai-hours-unrelated');
  let removed = false;
  stale.remove = () => (removed = true);
  doc.existing = [stale, other];
  ns.createOverlay(doc);
  assert.equal(removed, true, 'the stale pill is swept');
});

test('nothing is shown until the page body exists, then it fades in', () => {
  const doc = fakeDoc();
  doc.body.isConnected = false;
  ns.createOverlay(doc);
  const host = doc.created[0];
  assert.equal(host.classList.contains('shown'), false, 'hidden while the page is empty');

  doc.body.isConnected = true;
  const overlay = ns.createOverlay(doc); // second copy; the first host is swept
  overlay.render(5000, 1);
  assert.equal(doc.created[1].classList.contains('shown'), true, 'revealed once the page is up');
  assert.equal(doc.parts['.time'].textContent, '5s');
});

test('the reveal happens once, not on every redraw', () => {
  const doc = fakeDoc();
  doc.body.isConnected = true;
  const overlay = ns.createOverlay(doc);
  let frames = 0;
  globalThis.requestAnimationFrame = (fn) => { frames++; fn(); };
  overlay.render(1000, 0);
  overlay.render(2000, 0);
  overlay.render(3000, 1);
  assert.equal(frames, 1);
});

test('the pill still says the time and the tab count', () => {
  const doc = fakeDoc();
  doc.body.isConnected = true;
  const overlay = ns.createOverlay(doc);
  overlay.render(90000, 2);
  assert.equal(doc.parts['.time'].textContent, '1m 30s');
  assert.equal(doc.parts['.width'].textContent, '×2');
  overlay.render(90000, 1);
  assert.equal(doc.parts['.width'].textContent, '', 'no multiplier for a single reply');
});
// ---- the breakdown panel
function opened() {
  const doc = fakeDoc();
  doc.body.isConnected = true;
  const overlay = ns.createOverlay(doc);
  let calls = 0;
  const data = () => (calls++, ns.breakdown([{ site: 'claude', start: 0, end: 61000, server: { model: 'claude-opus-5-5' } }], 61000));
  overlay.render(61000, 0, data);
  return { doc, overlay, pill: doc.parts['.pill'], panel: doc.parts['.panel'], calls: () => calls };
}

test('the breakdown is not computed while the panel is closed', () => {
  const { calls, panel } = opened();
  assert.equal(calls(), 0);
  assert.equal(panel.hidden, true);
});

test('clicking the pill opens the panel with the total and one row per LLM', () => {
  const { pill, panel, doc, calls } = opened();
  pill.handlers.click();
  assert.equal(panel.hidden, false);
  assert.equal(pill.attrs['aria-expanded'], 'true');
  assert.equal(doc.parts['.total'].textContent, '1m 1s');
  assert.match(doc.parts['.body'].innerHTML, /Claude/);
  assert.ok(calls() > 0);
  pill.handlers.click();
  assert.equal(panel.hidden, true, 'a second click closes it');
});

test('Enter on the focused pill opens it; Escape closes it and returns focus', () => {
  const { pill, panel, doc } = opened();
  pill.handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(panel.hidden, false);
  doc.handlers.keydown({ key: 'Escape' });
  assert.equal(panel.hidden, true);
  assert.equal(pill.focused, true);
});

test('a press outside closes it; a press inside does not', () => {
  const { pill, panel, doc } = opened();
  const host = doc.created.at(-1);
  pill.handlers.click();
  doc.handlers.pointerdown({ composedPath: () => [host, doc.body] });
  assert.equal(panel.hidden, false);
  doc.handlers.pointerdown({ composedPath: () => [doc.body] });
  assert.equal(panel.hidden, true);
});

test('removing the overlay takes its page listeners with it', () => {
  const { overlay, doc } = opened();
  overlay.remove();
  assert.deepEqual(Object.keys(doc.handlers), []);
});
