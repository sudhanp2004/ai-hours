// A page just real enough for main-world.js: a document whose elements are EventTargets, so
// the private channel works, and every signal dispatched on it is collected in `posts`.
// Not a test file itself.
class FakeNode extends EventTarget {
  appendChild(c) { c.parent = this; return c; }
  remove() { this.parent = null; }
}
const posts = [];
const channels = [];
globalThis.window = globalThis;
globalThis.Node = FakeNode;
globalThis.Element = FakeNode;
const doc = new FakeNode();
doc.readyState = 'loading';
doc.documentElement = new FakeNode();
doc.createElement = () => {
  const n = new FakeNode();
  n.hellos = 0;
  n.addEventListener('aihours:hello', () => n.hellos++);
  n.addEventListener('aihours:signal', (e) => posts.push(JSON.parse(e.detail)));
  channels.push(n);
  return n;
};
globalThis.document = doc;
// Anything still posting to the window would be a hole: make it loud.
globalThis.postMessage = () => { throw new Error('signals must not go through window.postMessage'); };
module.exports = { posts, channels, doc, FakeNode };
