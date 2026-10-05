// Port support for gen1recomp's FireRed importer (GPLv3 + additional terms;
// see LICENSE.md). PNG out for the cache files Brian writes through
// love.image's encoder (and his own encode_png fallbacks). Pixels are what
// matter -- the cook reads them back -- so this writes RGBA8 with stored
// deflate blocks, exactly like tools/gen3/full_extract.lua's stand-in, and
// the import tests compare PNGs by decoded pixels.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function adler32(b: Uint8Array): number {
  let a = 1, s = 0;
  for (let i = 0; i < b.length; i++) { a = (a + b[i]!) % 65521; s = (s + a) % 65521; }
  return ((s << 16) | a) >>> 0;
}

function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2, pos = 0;
  do {
    const len = Math.min(65535, raw.length - pos);
    const final = pos + len >= raw.length ? 1 : 0;
    out[o++] = final; out[o++] = len & 255; out[o++] = len >> 8; out[o++] = ~len & 255; out[o++] = (~len >> 8) & 255;
    out.set(raw.subarray(pos, pos + len), o);
    o += len; pos += len;
  } while (pos < raw.length);
  out.set(u32be(adler32(raw)), o);
  return out.subarray(0, o + 4);
}

function chunk(kind: string, data: Uint8Array): Uint8Array[] {
  const k = new Uint8Array([kind.charCodeAt(0), kind.charCodeAt(1), kind.charCodeAt(2), kind.charCodeAt(3)]);
  return [u32be(data.length), k, data, u32be(crc32([k, data]))];
}

/** RGBA8 pixels (w*h*4) -> PNG bytes. */
export function encodePng(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(w), 0); ihdr.set(u32be(h), 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...chunk("IHDR", ihdr), ...chunk("IDAT", zlibStored(raw)), ...chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
