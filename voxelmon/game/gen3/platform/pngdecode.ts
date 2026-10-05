// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). PNG decoding without Node or zlib (the 3DS guest has
// neither): a small RFC 1951 inflate and the PNG filters, for the runtime's
// love.image.newImageData(FileData) sites. 8-bit RGBA / RGB / palette /
// gray / gray+alpha, non-interlaced -- what the importer writes.

class BitReader {
  pos = 0;
  bit = 0;
  bitCount = 0;
  constructor(readonly d: Uint8Array) {}
  bits(n: number): number {
    while (this.bitCount < n) {
      if (this.pos >= this.d.length) throw new Error("inflate: unexpected end");
      this.bit |= this.d[this.pos++]! << this.bitCount;
      this.bitCount += 8;
    }
    const v = this.bit & ((1 << n) - 1);
    this.bit >>>= n;
    this.bitCount -= n;
    return v;
  }
  align(): void { this.bit = 0; this.bitCount = 0; }
}

interface Huff { counts: Uint16Array; symbols: Uint16Array }

function buildHuff(lengths: ArrayLike<number>, n: number): Huff {
  const counts = new Uint16Array(16);
  for (let i = 0; i < n; i++) counts[lengths[i]!]!++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1]! + counts[i - 1]!;
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]!]!++] = i;
  return { counts, symbols };
}

function decodeSym(br: BitReader, h: Huff): number {
  let code = 0, first = 0, index = 0;
  for (let len = 1; len < 16; len++) {
    code |= br.bits(1);
    const count = h.counts[len]!;
    if (code - count < first) return h.symbols[index + (code - first)]!;
    index += count;
    first += count;
    first <<= 1;
    code <<= 1;
  }
  throw new Error("inflate: bad code");
}

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

let fixedL: Huff | undefined, fixedD: Huff | undefined;
function fixed(): [Huff, Huff] {
  if (!fixedL) {
    const l = new Uint8Array(288);
    for (let i = 0; i < 144; i++) l[i] = 8;
    for (let i = 144; i < 256; i++) l[i] = 9;
    for (let i = 256; i < 280; i++) l[i] = 7;
    for (let i = 280; i < 288; i++) l[i] = 8;
    fixedL = buildHuff(l, 288);
    fixedD = buildHuff(new Uint8Array(30).fill(5), 30);
  }
  return [fixedL!, fixedD!];
}

/** zlib stream -> bytes. */
export function inflateZlib(data: Uint8Array, sizeHint = 1 << 16): Uint8Array {
  const br = new BitReader(data);
  br.pos = 2; // CMF, FLG
  let out = new Uint8Array(sizeHint);
  let n = 0;
  const grow = (need: number): void => {
    if (n + need <= out.length) return;
    let cap = out.length * 2;
    while (cap < n + need) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(out.subarray(0, n));
    out = nb;
  };
  for (;;) {
    const final = br.bits(1);
    const type = br.bits(2);
    if (type === 0) {
      br.align();
      const len = data[br.pos]! | (data[br.pos + 1]! << 8);
      br.pos += 4;
      grow(len);
      out.set(data.subarray(br.pos, br.pos + len), n);
      n += len;
      br.pos += len;
    } else {
      let lh: Huff, dh: Huff;
      if (type === 1) [lh, dh] = fixed();
      else if (type === 2) {
        const hlit = br.bits(5) + 257, hdist = br.bits(5) + 1, hclen = br.bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[ORDER[i]!] = br.bits(3);
        const ch = buildHuff(cl, 19);
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const sym = decodeSym(br, ch);
          if (sym < 16) lens[i++] = sym;
          else {
            let rep = 0, val = 0;
            if (sym === 16) { val = lens[i - 1]!; rep = 3 + br.bits(2); }
            else if (sym === 17) rep = 3 + br.bits(3);
            else rep = 11 + br.bits(7);
            while (rep-- > 0) lens[i++] = val;
          }
        }
        lh = buildHuff(lens, hlit);
        dh = buildHuff(lens.subarray(hlit), hdist);
      } else throw new Error("inflate: bad block type");
      for (;;) {
        const sym = decodeSym(br, lh);
        if (sym < 256) { grow(1); out[n++] = sym; }
        else if (sym === 256) break;
        else {
          const li = sym - 257;
          const len = LBASE[li]! + br.bits(LEXT[li]!);
          const ds = decodeSym(br, dh);
          const dist = DBASE[ds]! + br.bits(DEXT[ds]!);
          grow(len);
          for (let k = 0; k < len; k++) { out[n] = out[n - dist]!; n++; }
        }
      }
    }
    if (final) break;
  }
  return out.subarray(0, n);
}

/** PNG bytes -> {w, h, rgba}. */
export function decodePngBytes(png: Uint8Array): { w: number; h: number; rgba: Uint8Array } {
  const be = (i: number): number => ((png[i]! << 24) | (png[i + 1]! << 16) | (png[i + 2]! << 8) | png[i + 3]!) >>> 0;
  if (png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) throw new Error("not a png");
  let pos = 8, w = 0, h = 0, depth = 8, ctype = 6, total = 0;
  const idat: Uint8Array[] = [];
  let plte: Uint8Array | undefined, trns: Uint8Array | undefined;
  while (pos + 8 <= png.length) {
    const len = be(pos);
    const kind = String.fromCharCode(png[pos + 4]!, png[pos + 5]!, png[pos + 6]!, png[pos + 7]!);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (kind === "IHDR") { w = be(pos + 8); h = be(pos + 12); depth = data[8]!; ctype = data[9]!; if (data[12]) throw new Error("png: interlaced"); }
    else if (kind === "PLTE") plte = data;
    else if (kind === "tRNS") trns = data;
    else if (kind === "IDAT") { idat.push(data); total += len; }
    else if (kind === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error(`png: bit depth ${depth}`);
  const z = new Uint8Array(total);
  let o = 0;
  for (const d of idat) { z.set(d, o); o += d.length; }
  const bpp = ctype === 6 ? 4 : ctype === 2 ? 3 : ctype === 4 ? 2 : 1;
  const stride = w * bpp;
  const raw = inflateZlib(z, h * (stride + 1));
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= bpp ? px[dst + x - bpp]! : 0;
      const b = y > 0 ? px[dst - stride + x]! : 0;
      const c = x >= bpp && y > 0 ? px[dst - stride + x - bpp]! : 0;
      let p: number;
      if (f === 0) p = v;
      else if (f === 1) p = v + a;
      else if (f === 2) p = v + b;
      else if (f === 3) p = v + ((a + b) >> 1);
      else {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[dst + x] = p & 255;
    }
  }
  if (ctype === 6) return { w, h, rgba: px };
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (ctype === 2) { rgba[i * 4] = px[i * 3]!; rgba[i * 4 + 1] = px[i * 3 + 1]!; rgba[i * 4 + 2] = px[i * 3 + 2]!; rgba[i * 4 + 3] = 255; }
    else if (ctype === 3) {
      const k = px[i]!;
      rgba[i * 4] = plte![k * 3]!; rgba[i * 4 + 1] = plte![k * 3 + 1]!; rgba[i * 4 + 2] = plte![k * 3 + 2]!;
      rgba[i * 4 + 3] = trns && k < trns.length ? trns[k]! : 255;
    } else if (ctype === 0) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[i]!; rgba[i * 4 + 3] = 255; }
    else { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[i * 2]!; rgba[i * 4 + 3] = px[i * 2 + 1]!; }
  }
  return { w, h, rgba };
}
