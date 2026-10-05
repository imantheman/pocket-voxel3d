// Port of gen1recomp src/core/game3/tileset_native.lua (GPLv3 + additional terms; see LICENSE.md).
// Per-pair native FRLG mid atlas (indexed -> RGBA) for game3 FieldView.
// Layered packs: mids.idx = under sprites (BG3/BG1), mids_over.idx = over (BG2).
//
// Extract.CACHE_ROOT / NATIVE_ROOT (src.import.gba.extract_island1) are a
// proxy onto CachePaths (extract_island1.lua:21), read here directly.
// A pair's atlas `ts` keeps Brian's fields; `bgr` is the importer's palette
// shape (bgr[slot][c], 0-based like the Lua's [0]-keyed tables), quads /
// overQuads / slotPix are keyed by slot. The upload is a generator (see
// asset_stream.ts).

import { CachePaths } from "./cache_paths.ts";
import { NativePack } from "../../../import/gen3/native_pack.ts";
import { Stream, type AssetStream } from "./asset_stream.ts";
import { Versions } from "../../../import/gen3/versions.ts";
import { TilesetAnim } from "./tileset_anim.ts";
import { FieldView } from "./field_view.ts";
import { G } from "../platform/graphics.ts";
import type { Image, ImageData, Quad } from "../platform/image.ts";
import { ipairs, len, pairs, type LuaTable } from "../platform/lt.ts";
import { format, tonumber, tostring } from "../../../import/gen3/lua.ts";
import type { PairData } from "./asset_decode.ts";

export interface NativeAtlas {
  pair: string;
  midToSlot: Record<number, number>;
  cols: number;
  rows: number;
  midCount: number;
  layered: boolean;
  idxBlob: string;
  overBlob?: string;
  bgr: any;
  quads: Record<number, Quad>;
  overQuads: Record<number, Quad>;
  slotPix: Record<number, { under: LuaTable; over: LuaTable }>;
  preparedAnim?: Record<string, string | undefined>;
  image?: Image;
  imageData?: ImageData;
  imageAlt?: Image;
  overImage?: Image;
  overImageData?: ImageData;
  overImageAlt?: Image;
  midImage?: Image;
  midImageData?: ImageData;
  patchedSlots?: Record<number, boolean | null>;
  [k: string]: any;
}

// Lua: tileset_native.lua:17
function nativeRoot(): string { return CachePaths.NATIVE_ROOT ?? (CachePaths.CACHE_ROOT + "/native"); }

// Lua: tileset_native.lua:18
function resetStream(): void {
  if (NativeTileset._stream) NativeTileset._stream.cancel();
  NativeTileset._stream = NativeTileset._cache ? makeStream() : undefined;
}

// Lua: tileset_native.lua:23
function log(msg: unknown): void {
  console.log("[game3/native] " + tostring(msg));
}

// Lua: tileset_native.lua:63 (pcall(require, tileset_anim) once)
function tilesetAnim(): typeof TilesetAnim | undefined {
  return TilesetAnim || undefined;
}

// Lua: tileset_native.lua:71
function bind_anim(pair: string, atlas: NativeAtlas, prepared?: Record<string, string | undefined>): void {
  const A = tilesetAnim();
  if (A && A.bindPair) {
    A.bindPair(pair, atlas, prepared as Record<string, string> | undefined);
  }
}

// Lua: tileset_native.lua:78
function* uploadPair(data: PairData & { layered?: boolean; overBlob?: string; animFiles?: Record<string, string | undefined> }): Generator<string, NativeAtlas, unknown> {
  const ts: NativeAtlas = {
    pair: data.pair, midToSlot: data.midToSlot, cols: data.cols, rows: data.rows,
    midCount: data.midCount, layered: data.layered || false, idxBlob: data.idxBlob,
    overBlob: data.overBlob, bgr: data.bgr, quads: {}, overQuads: {}, slotPix: {}, preparedAnim: data.animFiles,
  };
  for (const [, layer] of ipairs<any>(data.layers)) {
    const image = G.newImage(layer.data);
    image.setFilter("nearest", "nearest");
    ts[layer.imageKey] = image; ts[layer.dataKey] = layer.data;
    yield "texture";
  }
  return ts;
}

// Lua: tileset_native.lua:90
function makeStream(): AssetStream {
  return Stream.new("pair", NativeTileset._cache, nativeRoot(), uploadPair, (pair: string, ts: NativeAtlas) => {
    NativeTileset._pairs[pair] = ts;
    bind_anim(pair, ts, ts.preparedAnim);
    ts.preparedAnim = undefined;
    if (!NativeTileset._logged[pair]) {
      log(format("atlas ready pair=%s mids=%d %dx%d layered=%s", pair,
        ts.midCount, ts.cols * 16, ts.rows * 16, tostring(ts.layered)));
      NativeTileset._logged[pair] = true;
    }
  });
}

// Lua: tileset_native.lua:162 -- Lua sequence of [null, x, y, colourIndex]
function scan_slot(blob: string | undefined, cols: number, slot: number, skipZero: boolean): LuaTable {
  const out: LuaTable = [null];
  if (typeof blob !== "string" || blob.length < 12) return out;
  const midCount = blob.charCodeAt(6) + blob.charCodeAt(7) * 256;
  const base = 13 + midCount * 2;
  const lo = slot * 16, hi = slot * 16 + 15;
  let n = 0;
  for (let i = 0; i <= midCount * 256 - 1; i++) {
    const k = base + i - 1; // blob:byte(base + i)
    const b = k < blob.length ? blob.charCodeAt(k) : undefined;
    if (b != null && b >= lo && b <= hi && !(skipZero && b === 0)) {
      const mid = Math.floor(i / 256);
      const within = i % 256;
      n = n + 1;
      out[n] = [
        null,
        (mid % cols) * 16 + within % 16,
        Math.floor(mid / cols) * 16 + Math.floor(within / 16),
        b - lo,
      ];
    }
  }
  return out;
}

// Lua: tileset_native.lua:185
function retarget(old: Image, neu: Image): void {
  // package.loaded["src.core.game3.field_view"]
  if (!FieldView) return;
  const each = (store: any): void => {
    if (!store) return;
    for (const [, b] of pairs<any>(store)) {
      if (b.getTexture && b.getTexture() === old) b.setTexture(neu);
    }
  };
  each(FieldView._nativeBatches);
  each(FieldView._nativeOverBatches);
  const from = FieldView._voidFrom;
  if (from) {
    each(from.under);
    each(from.over);
  }
}

// Lua: tileset_native.lua:203
function flip(ts: NativeAtlas, imgKey: string, dataKey: string, altKey: string): void {
  const img: Image | undefined = ts[imgKey], data: ImageData | undefined = ts[dataKey];
  if (!(img && data && img.replacePixels)) return;
  let alt: Image | undefined = ts[altKey];
  if (alt && alt.replacePixels) {
    alt.replacePixels(data);
  } else {
    // love.graphics.newImage is always present here
    alt = G.newImage(data);
    if (alt.setFilter) alt.setFilter("nearest", "nearest");
  }
  ts[imgKey] = alt; ts[altKey] = img;
  retarget(img, alt);
}

// Lua: tileset_native.lua:225
function paint(imageData: ImageData | undefined, list: LuaTable, colors: [number, number, number][]): boolean {
  if (!(imageData && len(list) > 0)) return false;
  for (let i = 1; i <= len(list); i++) {
    const p = list[i];
    // colours are the importer's [r, g, b] triples (0-based): the Lua's c[1..3]
    const c = colors[p[3]]!;
    imageData.setPixel(p[1], p[2], c[0] / 255, c[1] / 255, c[2] / 255, 1);
  }
  return true;
}

export const NativeTileset = {
  _pairs: {} as Record<string, NativeAtlas>, // [pair] = { image, overImage?, quads, overQuads, ... }
  _cache: undefined as any,
  _logged: {} as Record<string, boolean>,
  _ready: {} as Record<string, boolean>,
  _stream: undefined as AssetStream | undefined,

  // Lua: tileset_native.lua:27
  install(cache: any, _bundle?: unknown): void {
    NativeTileset._cache = cache;
    NativeTileset._pairs = {};
    NativeTileset._logged = {};
    NativeTileset._ready = {};
    resetStream();
    if (TilesetAnim && TilesetAnim.install) {
      TilesetAnim.install(cache);
    }
  },

  // Lua: tileset_native.lua:39
  invalidate(): void {
    NativeTileset._pairs = {};
    NativeTileset._logged = {};
    NativeTileset._ready = {};
    resetStream();
    if (TilesetAnim && TilesetAnim.invalidate) {
      TilesetAnim.invalidate();
    }
  },

  // Lua: tileset_native.lua:50
  ready(pair: unknown): boolean {
    if (!Versions.NATIVE_RENDER) return false;
    if (typeof pair !== "string") return false;
    if (NativeTileset._pairs[pair] || NativeTileset._ready[pair]) return true;
    const cache = NativeTileset._cache;
    if (!cache) return false;
    const ok = cache.exists(nativeRoot() + "/" + pair + "/mids.idx")
      && cache.exists(nativeRoot() + "/" + pair + "/palettes.bin");
    if (ok) NativeTileset._ready[pair] = true;
    return ok;
  },

  // Lua: tileset_native.lua:103
  prefetch(pair: unknown, priority?: number): void {
    if (typeof pair === "string" && !NativeTileset._pairs[pair] && NativeTileset._stream) {
      NativeTileset._stream.prefetch(pair, priority);
    }
  },

  // Lua: tileset_native.lua:109
  get(pair: unknown): NativeAtlas | undefined {
    if (pair == null) return undefined;
    const key = pair as string;
    const cached = NativeTileset._pairs[key];
    if (cached) { bind_anim(key, cached); return cached; }
    const stream = NativeTileset._stream;
    if (!stream) return undefined;
    const [ts, err] = stream.get(key);
    if (!ts && !NativeTileset._logged[key]) {
      log("load failed " + tostring(pair) + ": " + tostring(err));
      NativeTileset._logged[key] = true;
    }
    return ts;
  },

  // Lua: tileset_native.lua:123
  slotFor(pairOrTs: string | NativeAtlas, mid: number): number {
    const ts = typeof pairOrTs === "object" ? pairOrTs : NativeTileset.get(pairOrTs);
    if (!ts) return 0;
    return ts.midToSlot[mid] ?? ts.midToSlot[0] ?? 0;
  },

  // Lua: tileset_native.lua:129
  hasMid(pairOrTs: string | NativeAtlas, mid: number): boolean {
    const ts = typeof pairOrTs === "object" ? pairOrTs : NativeTileset.get(pairOrTs);
    return !!(ts && ts.midToSlot && ts.midToSlot[mid] != null);
  },

  // Lua: tileset_native.lua:134
  quad(pairOrTs: string | NativeAtlas, slotIn: unknown): Quad | undefined {
    const ts = typeof pairOrTs === "object" ? pairOrTs : NativeTileset.get(pairOrTs);
    if (!ts || !ts.image) return undefined;
    const slot = tonumber(slotIn) ?? 0;
    let q = ts.quads[slot];
    if (q) return q;
    const cols = ts.cols;
    const sx = (slot % cols) * 16;
    const sy = Math.floor(slot / cols) * 16;
    const [iw, ih] = ts.image.getDimensions();
    q = G.newQuad(sx, sy, 16, 16, iw, ih);
    ts.quads[slot] = q;
    return q;
  },

  // Lua: tileset_native.lua:148
  overQuad(pairOrTs: string | NativeAtlas, slotIn: unknown): Quad | undefined {
    const ts = typeof pairOrTs === "object" ? pairOrTs : NativeTileset.get(pairOrTs);
    if (!ts || !ts.overImage) return undefined;
    const slot = tonumber(slotIn) ?? 0;
    let q = ts.overQuads[slot];
    if (q) return q;
    const cols = ts.cols;
    const sx = (slot % cols) * 16;
    const sy = Math.floor(slot / cols) * 16;
    const [iw, ih] = ts.overImage.getDimensions();
    q = G.newQuad(sx, sy, 16, 16, iw, ih);
    ts.overQuads[slot] = q;
    return q;
  },

  // Lua: tileset_native.lua:220
  flush(ts: NativeAtlas, under: boolean, over: boolean): void {
    if (under) flip(ts, "image", "imageData", "imageAlt");
    if (over) flip(ts, "overImage", "overImageData", "overImageAlt");
  },

  // Lua: tileset_native.lua:236 -- pokefirered/src/palette.c:88
  // bgr16: a Lua sequence of 16 BGR555 colours.
  setSlotPalette(pairOrTs: string | NativeAtlas, slotIn: unknown, bgr16: LuaTable): boolean {
    const ts = typeof pairOrTs === "object" ? pairOrTs : NativeTileset.get(pairOrTs);
    if (!(ts && ts.imageData && bgr16 !== null && typeof bgr16 === "object")) return false;
    const slot = tonumber(slotIn) ?? 0;
    let pix = ts.slotPix[slot];
    if (!pix) {
      pix = {
        under: scan_slot(ts.idxBlob, ts.cols, slot, false),
        over: ts.overImageData ? scan_slot(ts.overBlob, ts.cols, slot, true) : [null],
      };
      ts.slotPix[slot] = pix;
    }
    // Lua: src[c] = bgr16[c + 1] (a [0]-keyed palette: the importer's 0-based shape)
    const src: number[] = [];
    for (let c = 0; c <= 15; c++) src[c] = bgr16[c + 1] ?? 0;
    const colors = NativePack.palsToRgb8({ 0: src })[0]!;
    NativeTileset.flush(ts, paint(ts.imageData, pix.under, colors), paint(ts.overImageData, pix.over, colors));
    ts.patchedSlots = ts.patchedSlots ?? {};
    ts.patchedSlots[slot] = true;
    return true;
  },

  // Lua: tileset_native.lua:257
  resetSlotPalette(pairOrTs: string | NativeAtlas, slot: number): boolean {
    const ts = typeof pairOrTs === "object" ? pairOrTs : NativeTileset._pairs[pairOrTs];
    if (!(ts && ts.patchedSlots && ts.patchedSlots[slot])) return false;
    const base = ts.bgr && ts.bgr[slot];
    if (!base) return false;
    const list: LuaTable = [null];
    for (let c = 0; c <= 15; c++) list[c + 1] = base[c] ?? 0;
    NativeTileset.setSlotPalette(ts, slot, list);
    ts.patchedSlots[slot] = null;
    return true;
  },
};

export default NativeTileset;
