// Port of gen1recomp src/import/gba/lz77.lua (GPLv3 + additional terms; see LICENSE.md).
// GBA BIOS LZ77. The Lua returns a 1-based byte table (`decompress`) or a
// binary string (`decompressString`); here a Uint8Array and a byte string.

import { format } from "./lua.ts";
import { fromBytes } from "./lua.ts";

/** A byte source: a 0-based getter, a byte string, a Uint8Array, or a Rom-like `get`. */
export type ByteSource = ((i: number) => number) | string | Uint8Array | { get(i: number): number };

function getter(src: ByteSource): (i: number) => number {
  if (typeof src === "function") return src;
  if (typeof src === "string") return (i) => src.charCodeAt(i) || 0;
  if (src instanceof Uint8Array) return (i) => src[i] ?? 0;
  if (typeof (src as { get?: unknown }).get === "function") return (i) => (src as { get(i: number): number }).get(i) ?? 0;
  throw new Error("LZ77: invalid byte source");
}

export const Lz77 = {
  // Lua: lz77.lua:43 -- [bytes, consumed]
  decompress(src: ByteSource, offset = 0): [Uint8Array, number] {
    const get = getter(src);
    const typ = get(offset);
    if (typ !== 0x10) throw new Error(format("LZ77: expected type 0x10 at 0x%X, got 0x%02X", offset, typ ?? 0));
    const size = get(offset + 1) + get(offset + 2) * 256 + get(offset + 3) * 65536;
    if (size <= 0 || size > 8 * 1024 * 1024) throw new Error(format("LZ77: unreasonable size %d", size));
    let s = offset + 4;
    const buf = new Uint8Array(size);
    let produced = 0;
    while (produced < size) {
      const flags = get(s);
      s += 1;
      for (let bi = 7; bi >= 0; bi--) {
        if (produced >= size) break;
        if (((flags >> bi) & 1) === 1) {
          const b1 = get(s), b2 = get(s + 1);
          s += 2;
          const length = (b1 >> 4) + 3;
          const disp = ((b1 & 0x0f) << 8) | b2;
          for (let k = 0; k < length; k++) {
            if (produced >= size) break;
            const readPos = produced - 1 - disp;
            buf[produced] = readPos >= 0 ? buf[readPos]! : 0;
            produced++;
          }
        } else {
          buf[produced] = get(s) || 0;
          s += 1;
          produced++;
        }
      }
    }
    return [buf, s - offset];
  },

  // Lua: lz77.lua:171
  decompressString(src: ByteSource, offset = 0): [string, number] {
    const [buf, consumed] = Lz77.decompress(src, offset);
    return [fromBytes(buf), consumed];
  },

  // Lua: lz77.lua:241
  decompressFromBytes(bytes: Uint8Array | string, offset0 = 0): [Uint8Array, number] {
    const get = (i: number): number => {
      const v = typeof bytes === "string" ? (i < bytes.length ? bytes.charCodeAt(i) : undefined) : bytes[i];
      if (v === undefined) throw new Error(format("LZ77: OOB read at 0x%X", i));
      return v;
    };
    return Lz77.decompress(get, offset0);
  },

  // Lua: lz77.lua:254
  toString(arr: Uint8Array | string): string {
    return typeof arr === "string" ? arr : fromBytes(arr);
  },

  // Lua: lz77.lua:281 -- store-only blocks, for tests
  compressStore(payload: Uint8Array | string): number[] {
    const at = (i: number): number => (typeof payload === "string" ? payload.charCodeAt(i) : payload[i]!);
    const size = payload.length;
    const out = [0x10, size % 256, Math.floor(size / 256) % 256, Math.floor(size / 65536) % 256];
    let i = 0;
    while (i < size) {
      out.push(0);
      for (let b = 0; b < 8; b++) {
        if (i < size) { out.push(at(i)); i++; }
      }
    }
    return out;
  },
};

export default Lz77;
