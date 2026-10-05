// Port of gen1recomp src/core/game3/palette.lua (GPLv3 + additional terms; see LICENSE.md).
// Pret-faithful FRLG map palette system (13 BG slots x 16 BGR555).
//
// Palettes keep the importer's shape (NativePack.decodePalettes /
// palsToRgb8): pals[slot][colour], both 0-based, which is the Lua's
// [0]-keyed tables indexed the same way.

import { Tileset } from "../../../import/gen3/tileset.ts";
import { NativePack, type DecodedPalettes } from "../../../import/gen3/native_pack.ts";
import { format } from "../../../import/gen3/lua.ts";

type Rgb = [number, number, number];

const MD5_K: number[] = [];
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
for (let i = 0; i <= 63; i++) {
  // Lua: MD5_K[i + 1]; kept 0-based here (MD5_K[i]) with MD5_S[i] alike
  MD5_K[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) % 4294967296) | 0;
}

// bit.rol on a 32-bit value
function rol(x: number, n: number): number {
  return (x << n) | (x >>> (32 - n));
}

// Lua: palette.lua:38
function md5hex(msgIn: string): string {
  const len = msgIn.length;
  const padLen = (((55 - len) % 64) + 64) % 64;
  const msg = msgIn + "\x80" + "\0".repeat(padLen)
    + String.fromCharCode(
      (len * 8) % 256, Math.floor(len * 8 / 256) % 256,
      Math.floor(len * 8 / 65536) % 256, Math.floor(len * 8 / 16777216) % 256,
      0, 0, 0, 0);
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < msg.length; off += 64) {
    for (let j = 0; j <= 15; j++) {
      const k = off + j * 4;
      M[j] = msg.charCodeAt(k) | (msg.charCodeAt(k + 1) << 8) | (msg.charCodeAt(k + 2) << 16) | (msg.charCodeAt(k + 3) << 24);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i <= 63; i++) {
      let F: number, g: number;
      if (i < 16) {
        F = (B & C) | (~B & D); g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C); g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D; g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D); g = (7 * i) % 16;
      }
      F = (F + A + MD5_K[i]! + M[g]!) | 0;
      A = D; D = C; C = B;
      B = (B + rol(F, MD5_S[i]!)) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out: string[] = [];
  for (const v of [a0, b0, c0, d0]) {
    for (let k = 0; k <= 3; k++) out.push(format("%02x", (v >>> (k * 8)) & 255));
  }
  return out.join("");
}

export const Palette = {
  NUM_PALS_IN_PRIMARY: Tileset.NUM_PALS_IN_PRIMARY as number, // 7
  NUM_PALS_TOTAL: Tileset.NUM_PALS_TOTAL as number,           // 13

  // Lua: palette.lua:12
  /** Load palettes.bin -> BGR555 map (0..15): [pals] or [undefined, err]. */
  loadBgr555(blob: unknown): [DecodedPalettes?, string?] {
    return NativePack.decodePalettes(blob);
  },

  // Lua: palette.lua:17
  /** Load -> RGB8 tables [slot][c] = [r, g, b]: [rgb, bgr] or [undefined, err]. */
  load(blob: unknown): [Rgb[][] | undefined, DecodedPalettes | string | undefined] {
    const [bgr, err] = Palette.loadBgr555(blob);
    if (!bgr) return [undefined, err];
    if (((bgr[0] && bgr[0][0]) ?? -1) !== 0) throw new Error("pret: mapPals[0][0] must be black");
    return [NativePack.palsToRgb8(bgr), bgr];
  },

  _md5hex: md5hex,

  // Lua: palette.lua:81
  /** Stable hash of BGR555 pals (+ optional extraBlob) for RGBA disk cache keys. */
  hash(bgrPals: Record<number, ArrayLike<number> | undefined>, extraBlob?: unknown): string {
    const parts: string[] = [];
    for (let p = 0; p <= Palette.NUM_PALS_TOTAL - 1; p++) {
      const colors = bgrPals[p] ?? bgrPals[0] ?? [];
      for (let c = 0; c <= 15; c++) {
        parts.push(format("%04x", (colors[c] ?? 0) % 65536));
      }
    }
    if (extraBlob && typeof extraBlob === "string") {
      parts.push(extraBlob);
    }
    const s = parts.join("");
    // NOT FAITHFUL: no love.data here, so always the Lua's own md5hex (same digest)
    return md5hex(s).slice(0, 16);
  },

  // Lua: palette.lua:100
  /** Identity tint hook (weather / time later). */
  tint<T>(rgbPals: T, _kind?: unknown): T {
    return rgbPals;
  },
};

export default Palette;
