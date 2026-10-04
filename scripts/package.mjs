// Builds dist/ai-hours-<version>.zip for the Chrome Web Store: exactly the files the manifest
// (and what it loads) refers to, nothing else. Unused site stubs, tests and docs stay out.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve('extension');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const files = new Set(['manifest.json']);
const add = (f) => {
  const p = path.normalize(f);
  if (!fs.existsSync(path.join(root, p))) throw new Error('missing: ' + p);
  files.add(p);
};
for (const cs of manifest.content_scripts) cs.js.forEach(add);
for (const f of Object.values(manifest.icons)) add(f);
for (const f of Object.values(manifest.action.default_icon ?? {})) add(f);
// The service worker, and the modules it imports.
const sw = manifest.background.service_worker;
add(sw);
for (const [, imp] of fs.readFileSync(path.join(root, sw), 'utf8').matchAll(/import '(\.[^']+)'/g)) add(path.join(path.dirname(sw), imp));
// The popup, and the scripts and styles it references.
const popup = manifest.action.default_popup;
add(popup);
for (const [, ref] of fs.readFileSync(path.join(root, popup), 'utf8').matchAll(/(?:src|href)="([^"]+)"/g)) add(path.join(path.dirname(popup), ref));

// A minimal ZIP writer (stored + deflate), so packaging needs no dependency.
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const local = [], central = [];
let offset = 0;
for (const name of [...files].sort()) {
  const data = fs.readFileSync(path.join(root, name));
  const comp = zlib.deflateRawSync(data);
  const nameBuf = Buffer.from(name.split(path.sep).join('/'));
  const crc = crc32(data);
  const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6); h.writeUInt16LE(8, 8);
  h.writeUInt32LE(0, 10); h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nameBuf.length, 26);
  local.push(h, nameBuf, comp);
  const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8); c.writeUInt16LE(8, 10);
  c.writeUInt32LE(0, 12); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
  central.push(c, nameBuf);
  offset += 30 + nameBuf.length + comp.length;
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
fs.mkdirSync('dist', { recursive: true });
const out = `dist/ai-hours-${manifest.version}.zip`;
fs.writeFileSync(out, Buffer.concat([...local, cd, end]));
console.log(out, files.size + ' files:\n  ' + [...files].sort().join('\n  '));
