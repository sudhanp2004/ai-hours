// Builds claude.ai-shaped protobuf and Connect frames for tests, from the field numbers the
// probe saw on 2026-10-03 (spec §11, Probe results). Not a test file itself.
const vint = (n) => {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const fld = (f, v) => (typeof v === 'number' ? [...vint(f * 8), ...vint(v)] : [...vint(f * 8 + 2), ...vint(v.length), ...v]);
const msg = (...parts) => parts.flat();
const s = (str) => [...new TextEncoder().encode(str)];

// Common header of a PerformAction: conversation id plus a session id and action counter.
const header = (conv, n) => msg(fld(1, msg(fld(1, s('sess_f1bcfffbfc7e1baf')), fld(2, n))), fld(2, s(conv)), fld(3, 3));
// event.1 = conversation state, .2 = conversation, .3 = status (1 idle, 2 running).
const event = (...parts) => fld(1, msg(fld(10, msg(fld(1, s('1790975093631-0')))), fld(11, 1), ...parts));
const statusFrame = (conv, status) => event(fld(1, msg(fld(1, 1), fld(2, msg(fld(1, s(conv)), fld(3, status), fld(6, msg(fld(2, s('claude-opus-5-5')))))))));
const deltaFrame = (text) => event(fld(2, msg(fld(1, s('cblk_011Cfe69aEqHXbiUbText5RZ')), fld(2, s(text)))));
const heartbeat = () => fld(1, fld(6, []));
// Connect envelope: flag byte + 4-byte big-endian length.
const env = (flag, payload) => [flag, (payload.length >>> 24) & 255, (payload.length >>> 16) & 255, (payload.length >>> 8) & 255, payload.length & 255, ...payload];

module.exports = { vint, fld, msg, s, header, statusFrame, deltaFrame, heartbeat, env };
