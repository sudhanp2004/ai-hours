const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/total.js');
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
      setAttribute() {}, getAttribute: () => null, remove() {},
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