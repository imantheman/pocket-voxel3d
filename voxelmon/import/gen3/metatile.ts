// Port of gen1recomp src/import/gba/metatile.lua (GPLv3 + additional terms; see LICENSE.md).
// Dual-layer GBA metatile composite (indexed + BGR555).
// pret DrawMetatile (field_camera.c): bottom entries 0–3, top 4–7.
// Layer type picks which BG gets each half:
//   NORMAL  → bottom BG1 (under sprites), top BG2 (covers sprites)
//   COVERED → bottom BG3, top BG1 (both under sprites)
//   SPLIT   → bottom BG3, top BG2 (covers sprites)
// Pixel buffers are 0-based (buf[i] is the Lua's buf[i + 1]); the 16×16
// indexed buffers are Uint8Arrays (every value is a byte).

import { Tileset, type BundleLike } from "./tileset.ts";
import { Family } from "./family.ts";

export type IdxBuf = Uint8Array;

// Lua: metatile.lua:17
function flip_coords(x: number, y: number, hflip: boolean, vflip: boolean): [number, number] {
  if (hflip) x = 7 - x;
  if (vflip) y = 7 - y;
  return [x, y];
}

// Lua: metatile.lua:40 -- blit one metatile half (layer 0=bottom, 1=top) into
// idxBuf. Top: colorIndex 0 leaves dest unchanged. Bottom: colorIndex 0 writes 0.
function blit_layer(bundle: BundleLike, entries: number[], layer: number, idxBuf: IdxBuf): void {
  const isTop = layer === 1;
  const nPriTiles = Family.active().numPrimaryTiles;
  for (let slot = 0; slot <= 3; slot++) {
    const e = entries[layer * 4 + slot]!;
    const tid = e % 1024;
    const hflip = Math.floor(e / 1024) % 2 === 1;
    const vflip = Math.floor(e / 2048) % 2 === 1;
    const palSlot = Math.floor(e / 4096) % 16;
    let tiles;
    let localTid = tid;
    if (tid < nPriTiles) {
      tiles = bundle.primaryTiles;
    } else {
      tiles = bundle.secondaryTiles;
      localTid = tid - nPriTiles;
    }
    if (localTid >= 0 && localTid < (tiles.count ?? 0)) {
      const ox = (slot % 2) * 8;
      const oy = Math.floor(slot / 2) * 8;
      for (let y = 0; y <= 7; y++) {
        for (let x = 0; x <= 7; x++) {
          const [sx, sy] = flip_coords(x, y, hflip, vflip);
          const colorIndex = Tileset.tileIndex(tiles, localTid, sx, sy);
          const di = (oy + y) * 16 + (ox + x);
          if (isTop) {
            if (colorIndex !== 0) {
              idxBuf[di] = (palSlot % 16) * 16 + (colorIndex % 16);
            }
          } else if (colorIndex === 0) {
            idxBuf[di] = 0;
          } else {
            idxBuf[di] = (palSlot % 16) * 16 + (colorIndex % 16);
          }
        }
      }
    }
  }
}

// Lua: metatile.lua:80
function empty_idx(): IdxBuf {
  return new Uint8Array(256);
}

export const Metatile = {
  LAYER_NORMAL: 0,
  LAYER_COVERED: 1,
  LAYER_SPLIT: 2,

  // Lua: metatile.lua:24
  // pokefirered/include/global.fieldmap.h:32, pokeemerald/include/global.fieldmap.h:40
  layerType(bundle: BundleLike, mid: number): number {
    const F = Family.active();
    const nPri = F.numPrimaryMetatiles;
    let attrs;
    if (mid < nPri) {
      attrs = bundle.primaryAttr;
    } else {
      attrs = bundle.secondaryAttr;
    }
    if (!attrs) return Metatile.LAYER_NORMAL;
    const [, w] = Tileset.attrOf(attrs, mid, mid < nPri ? undefined : nPri);
    return F.layerOf(w);
  },

  // Lua: metatile.lua:87 -- bottom half only (entries 0–3)
  compositeIndexedBottom(bundle: BundleLike, mid: number): IdxBuf {
    const entries = Tileset.metatileEntries(bundle.primaryMt, bundle.secondaryMt, mid);
    const idxBuf = empty_idx();
    if (!entries) return idxBuf;
    blit_layer(bundle, entries, 0, idxBuf);
    return idxBuf;
  },

  // Lua: metatile.lua:96 -- top half only (entries 4–7); transparent (0)
  // where colorIndex 0
  compositeIndexedTop(bundle: BundleLike, mid: number): IdxBuf {
    const entries = Tileset.metatileEntries(bundle.primaryMt, bundle.secondaryMt, mid);
    const idxBuf = empty_idx();
    if (!entries) return idxBuf;
    blit_layer(bundle, entries, 1, idxBuf);
    return idxBuf;
  },

  // Lua: metatile.lua:106 -- pixels drawn under object sprites (BG3 + BG1).
  // COVERED: bottom+top. NORMAL/SPLIT: bottom only.
  compositeIndexedUnder(bundle: BundleLike, mid: number): IdxBuf {
    const idxBuf = Metatile.compositeIndexedBottom(bundle, mid);
    if (Metatile.layerType(bundle, mid) === Metatile.LAYER_COVERED) {
      const top = Metatile.compositeIndexedTop(bundle, mid);
      for (let i = 0; i < 256; i++) {
        const t = top[i]!;
        if (t !== 0) idxBuf[i] = t;
      }
    }
    return idxBuf;
  },

  // Lua: metatile.lua:119 -- pixels drawn over object sprites (BG2).
  // NORMAL/SPLIT top; COVERED empty.
  compositeIndexedOver(bundle: BundleLike, mid: number): IdxBuf {
    const lt = Metatile.layerType(bundle, mid);
    if (lt === Metatile.LAYER_COVERED) {
      return empty_idx();
    }
    return Metatile.compositeIndexedTop(bundle, mid);
  },

  // Lua: metatile.lua:128 -- pokeemerald/src/field_camera.c:245
  compositeIndexedMiddle(bundle: BundleLike, mid: number): IdxBuf {
    const lt = Metatile.layerType(bundle, mid);
    if (lt === Metatile.LAYER_NORMAL) {
      return Metatile.compositeIndexedBottom(bundle, mid);
    } else if (lt === Metatile.LAYER_COVERED) {
      return Metatile.compositeIndexedTop(bundle, mid);
    }
    return empty_idx();
  },

  // Lua: metatile.lua:139 -- flat composite (bottom then top). Used by
  // demake/quantize paths.
  compositeIndexed(bundle: BundleLike, mid: number): IdxBuf {
    const entries = Tileset.metatileEntries(bundle.primaryMt, bundle.secondaryMt, mid);
    const idxBuf = empty_idx();
    if (!entries) return idxBuf;
    blit_layer(bundle, entries, 0, idxBuf);
    blit_layer(bundle, entries, 1, idxBuf);
    return idxBuf;
  },

  // Lua: metatile.lua:151 -- composite mid → 256 BGR555 colours (0..0x7FFF);
  // index 0 top = keep bottom. Also returns palBuf[i] = FRLG map palette slot
  // that last wrote that pixel. [buf, palBuf]
  compositeBgr555(bundle: BundleLike, mid: number): [number[], number[]] {
    const idxBuf = Metatile.compositeIndexed(bundle, mid);
    const buf: number[] = [], palBuf: number[] = [];
    const mapPals = bundle.mapPals ?? [];
    for (let i = 0; i < 256; i++) {
      const byte = idxBuf[i] ?? 0;
      const palSlot = Math.floor(byte / 16) % 16;
      const colorIndex = byte % 16;
      const pal = mapPals[palSlot] ?? mapPals[0];
      const c = (pal && pal[colorIndex]) || 0;
      buf[i] = c % 32768;
      palBuf[i] = palSlot;
    }
    return [buf, palBuf];
  },

  // Lua: metatile.lua:168 -- crop one 8×8 quadrant (0=TL,1=TR,2=BL,3=BR)
  // from a 16×16 buffer
  quadrant<T>(buf16: ArrayLike<T>, q: number): T[] {
    const ox = (q % 2) * 8;
    const oy = Math.floor(q / 2) * 8;
    const out: T[] = [];
    for (let y = 0; y <= 7; y++) {
      for (let x = 0; x <= 7; x++) {
        out[y * 8 + x] = buf16[(oy + y) * 16 + (ox + x)]!;
      }
    }
    return out;
  },

  // Lua: metatile.lua:181 -- true when every pixel is BGR555 0 (FRLG in-map
  // void / solid black)
  isExactBlackBuf(buf: ArrayLike<number> | undefined, n?: number): boolean {
    n = n ?? (buf ? buf.length : 0);
    if (n < 1) return false;
    for (let i = 0; i < n; i++) {
      const c = (buf && buf[i]) || 0;
      if ((c % 0x8000) !== 0) return false;
    }
    return true;
  },

  // Lua: metatile.lua:192 -- majority FRLG palette slot among an 8×8 palBuf quadrant
  quadrantPal(palBuf16: ArrayLike<number>, q: number): number {
    const ox = (q % 2) * 8;
    const oy = Math.floor(q / 2) * 8;
    const counts: Record<number, number> = {};
    let best = 0, bestN = 0;
    for (let y = 0; y <= 7; y++) {
      for (let x = 0; x <= 7; x++) {
        const p = palBuf16[(oy + y) * 16 + (ox + x)] ?? 0;
        const n = (counts[p] ?? 0) + 1;
        counts[p] = n;
        if (n > bestN) { best = p; bestN = n; }
      }
    }
    return best;
  },
};

export default Metatile;
