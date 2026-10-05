// Port of gen1recomp src/core/game3/tileset_anim.lua (GPLv3 + additional terms; see LICENSE.md).
// Pret General tileset animations (water / sand edge / flower) for native FieldView.
//
// Shapes: `cache` is Brian's cache object (`cache.read(rel)` -> bytes or
// undefined), as Dataset.cache() gives it; `prepared` (bindPair) is a table
// keyed by cache path. `_pairs` and `_visible` are keyed by tileset pair
// name; per-frame loops walk them with for...in (no allocation, as Brian's
// pairs()). Anim manifests come through luaLoad, so `mids` are Lua sequences.
// The atlas is NativeTileset's ts: midToSlot[mid] -> 0-based slot.
// RSE (Emerald) tileset animations are not ported: the points where Brian's
// code commits to the RSE family throw `NOT FAITHFUL: Emerald only`.

import { Versions } from "../../../import/gen3/versions.ts";
import { CachePaths } from "./cache_paths.ts";
import { NativeTileset as NativeTilesetMod } from "./tileset_native.ts";
import { FieldView } from "./field_view.ts";
import { tostring, sub, mod, truthy } from "../../../import/gen3/lua.ts";
import { len, type LuaTable } from "../platform/lt.ts";
import { luaLoad } from "../platform/luadata.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type ImageData } from "../platform/image.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AnimCache { read(rel: string): string | undefined | null }

export interface AnimBank {
  mids: LuaTable; // Lua sequence of metatile ids
  frames: number;
  rgba: string;
  midIndex: Record<number, number>; // [mid] = 0-based index
  pieces?: Record<number, ImageData>; // [frame * 1000 + mi]
}

export interface AnimAtlas {
  cols?: number;
  midToSlot: Record<number, number>;
  image?: any;
  imageData?: ImageData;
  overImageData?: ImageData;
  quads?: any;
  [k: string]: any;
}

export interface AnimEntry {
  atlas: AnimAtlas;
  frames: Record<string, number>;
  banks: Record<string, AnimBank | undefined>;
  rse?: boolean;
  [k: string]: any;
}

export interface RseRow {
  period: number;
  frames?: number;
  fn?: string;
  slot?: number;
  framesA?: number;
  framesB?: number;
  [k: string]: any;
}

const MID_RGBA = 16 * 16 * 4; // 1024

// Lua: tileset_anim.lua:21
function log(msg: unknown): void {
  console.log("[game3/anim] " + tostring(msg));
}

// Lua: tileset_anim.lua:41
function native_root(): string {
  // Extract.CACHE_ROOT (src.import.gba.extract_island1) is a proxy onto
  // CachePaths (extract_island1.lua:21)
  return (CachePaths.CACHE_ROOT ?? "data/generated/gba") + "/native/";
}

// Lua: tileset_anim.lua:45
function read_manifest(cache: AnimCache, pair: string): LuaTable {
  let memo = TilesetAnim._manifests;
  if (!memo) {
    memo = {};
    TilesetAnim._manifests = memo;
  }
  const hit = memo[pair];
  if (hit != null) return hit || undefined;
  const src = cache.read(native_root() + pair + "/anim_manifest.lua");
  const chunk = src != null ? luaLoad(src, "@anim_manifest.lua")[0] : undefined;
  const man = chunk ? (chunk() ?? undefined) : undefined;
  memo[pair] = man ?? false;
  return man;
}

// Lua: tileset_anim.lua:60
function rse_luts(_cache: AnimCache, _pair: string): never {
  throw new Error("NOT FAITHFUL: Emerald only (tileset_anim rse_luts)");
}

// Lua: tileset_anim.lua:74
function rse_bank(_cache: AnimCache, _pair: string, _row: LuaTable): never {
  throw new Error("NOT FAITHFUL: Emerald only (tileset_anim rse_bank)");
}

// Lua: tileset_anim.lua:97
function rse_entry(_cache: AnimCache, _pair: string, _atlas: AnimAtlas, _man: LuaTable): never {
  void rse_luts; void rse_bank;
  throw new Error("NOT FAITHFUL: Emerald only (tileset_anim rse_entry)");
}

// Lua: tileset_anim.lua:123
function rse_piece(): never {
  throw new Error("NOT FAITHFUL: Emerald only (tileset_anim rse_piece)");
}

// Lua: tileset_anim.lua:155 (QUAD_XY) and :157
function rse_paste(): never {
  void rse_piece;
  throw new Error("NOT FAITHFUL: Emerald only (tileset_anim rse_paste)");
}

// pokeemerald/src/tileset_anims.c:1168
// Lua: tileset_anim.lua:188
function rse_apply(): never {
  void rse_paste;
  throw new Error("NOT FAITHFUL: Emerald only (tileset_anim rse_apply)");
}

// Lua: tileset_anim.lua:207
function rse_counters(): never {
  throw new Error("NOT FAITHFUL: Emerald only (tileset_anim rse_counters)");
}

// Lua: tileset_anim.lua:235 (rseDirty: Emerald only, not kept)

// Lua: tileset_anim.lua:238 (the lazy require is a static import)
function NativeTileset(): any {
  return NativeTilesetMod;
}

// Lua: tileset_anim.lua:274
function load_bank(cache: AnimCache, pair: string, kind: string, info: LuaTable): AnimBank | undefined {
  if (!info || !info.mids || len(info.mids) < 1) return undefined;
  const rgba = cache.read(
    (CachePaths.CACHE_ROOT ?? "data/generated/gba") + "/native/" + pair + "/anim_" + kind + ".rgba");
  if (rgba == null) return undefined;
  const nMids = len(info.mids);
  const nFrames: number = info.frames ?? 0;
  const need = nMids * nFrames * MID_RGBA;
  if (rgba.length < need) {
    log("short anim bank " + kind + " for " + pair);
    return undefined;
  }
  const midIndex: Record<number, number> = {};
  for (let i = 1; info.mids[i] != null; i++) {
    midIndex[info.mids[i]] = i - 1; // 0-based
  }
  return {
    mids: info.mids,
    frames: nFrames,
    rgba,
    midIndex,
  };
}

// Lua: tileset_anim.lua:359
function get_frame_piece(bank: AnimBank, frame: number, mi: number, srcOff: number): ImageData | undefined {
  // `love and love.image and love.image.newImageData`: always here
  let pieces = bank.pieces;
  if (!pieces) {
    pieces = {};
    bank.pieces = pieces;
  }
  const pKey = frame * 1000 + mi;
  const piece = pieces[pKey];
  if (piece) return piece;
  let imgData: ImageData | undefined;
  try {
    imgData = newImageData(16, 16, "rgba8", sub(bank.rgba, srcOff + 1, srcOff + MID_RGBA));
  } catch {
    imgData = undefined;
  }
  if (imgData) {
    pieces[pKey] = imgData;
    return imgData;
  }
  return undefined;
}

export const TilesetAnim = {
  _cache: undefined as AnimCache | undefined,
  _pairs: {} as Record<string, AnimEntry | false>,
  _visible: {} as Record<string, true>,
  counter: 0,
  counterMax: 640,
  _waterFrame: 0,
  _sandFrame: 0,
  _flowerFrame: 0,
  _enabled: true,
  _manifests: undefined as Record<string, LuaTable> | undefined,
  _rse: undefined as LuaTable,

  // Lua: tileset_anim.lua:25
  install(cache: AnimCache | undefined): void {
    TilesetAnim._cache = cache;
    TilesetAnim.invalidate();
  },

  // Lua: tileset_anim.lua:30
  invalidate(): void {
    TilesetAnim._manifests = undefined;
    TilesetAnim._pairs = {};
    TilesetAnim._visible = {};
    TilesetAnim.counter = 0;
    TilesetAnim._waterFrame = 0;
    TilesetAnim._sandFrame = 0;
    TilesetAnim._flowerFrame = 0;
    TilesetAnim._rse = undefined;
  },

  // pokeemerald/src/tileset_anims.c:991
  // Lua: tileset_anim.lua:108
  rseFrame(row: RseRow, timer: number): number | undefined {
    const t = Math.floor(timer / row.period);
    const frames = row.frames ?? 1;
    if (frames < 1) return undefined;
    if (row.fn === "slot") {
      return mod(mod(t - (row.slot ?? 0), 65536), frames);
    } else if (row.fn === "mauville") {
      const d = mod(t - (row.slot ?? 0), 65536);
      const a = row.framesA ?? frames, b = row.framesB ?? 1;
      if (d < a) return d;
      return a + mod(d, b);
    }
    return mod(t, frames);
  },

  // pokeemerald/src/tileset_anims.c:574
  // Lua: tileset_anim.lua:213
  enterMap(pair: string | undefined, _seamless?: boolean): boolean {
    const cache = TilesetAnim._cache;
    if (!cache || pair == null) return false;
    const man = read_manifest(cache, pair);
    if (!man || man.family !== "rse") return false;
    void rse_counters;
    throw new Error("NOT FAITHFUL: Emerald only (TilesetAnim.enterMap on an RSE tileset)");
  },

  // pokeemerald/src/tileset_anims.c:586
  // Lua: tileset_anim.lua:244
  stepRse(): void {
    const st = TilesetAnim._rse;
    if (!st) return;
    void rse_apply;
    throw new Error("NOT FAITHFUL: Emerald only (TilesetAnim.stepRse)");
  },

  // pokefirered/src/tileset_anims.c:223
  // Lua: tileset_anim.lua:299
  bindPair(pair: string | undefined, atlas: AnimAtlas | undefined, prepared?: Record<string, string>): boolean {
    if (!Versions.NATIVE_RENDER || Versions.TILESET_ANIM === false) {
      return false;
    }
    const cache: AnimCache | undefined = prepared ? { read: (rel: string) => prepared[rel] } : TilesetAnim._cache;
    if (!cache || pair == null || !atlas) return false;
    let entry = TilesetAnim._pairs[pair];
    if (entry === false) return false;
    if (!entry) {
      const man = read_manifest(cache, pair);
      if (!man) {
        TilesetAnim._pairs[pair] = false;
        return false;
      }
      if (man.family === "rse") {
        void rse_entry;
        throw new Error("NOT FAITHFUL: Emerald only (TilesetAnim.bindPair on an RSE tileset)");
      }
      entry = {
        atlas, frames: {}, banks: {
          water: load_bank(cache, pair, "water", man.water),
          sand: load_bank(cache, pair, "sand", man.sand),
          flower: load_bank(cache, pair, "flower", man.flower),
        },
      };
      TilesetAnim._pairs[pair] = entry;
    }
    TilesetAnim._visible[pair] = true;
    if (entry.rse) return true;
    let dirty = false;
    if (TilesetAnim._applyKind(entry, "water", TilesetAnim._waterFrame, true)) dirty = true;
    if (TilesetAnim._applyKind(entry, "sand", TilesetAnim._sandFrame, true)) dirty = true;
    if (TilesetAnim._applyKind(entry, "flower", TilesetAnim._flowerFrame, true)) dirty = true;
    // Initial/catch-up preparation uploads once after all CPU patches. This
    // also keeps a warming pair's final step within one texture submission.
    if (dirty) NativeTileset().flush(atlas, true, false);
    return true;
  },

  // Lua: tileset_anim.lua:340
  setVisiblePairs(visible: Record<string, unknown>): void {
    const set = TilesetAnim._visible;
    for (const pair in set) {
      if (!truthy(visible[pair])) delete set[pair];
    }
    for (const pair in visible) {
      if (visible[pair] == null) continue; // pairs() skips nil values
      if (!set[pair]) {
        set[pair] = true;
        // a General atlas coming back into view catches up before it is drawn
        const entry = TilesetAnim._pairs[pair];
        if (entry && !entry.rse) {
          TilesetAnim._applyKind(entry, "water", TilesetAnim._waterFrame);
          TilesetAnim._applyKind(entry, "sand", TilesetAnim._sandFrame);
          TilesetAnim._applyKind(entry, "flower", TilesetAnim._flowerFrame);
        }
      }
    }
  },

  // Lua: tileset_anim.lua:378
  _applyKind(entry: AnimEntry, kind: string, frame: number, deferUpload?: boolean): boolean | undefined {
    const bank = entry.banks[kind];
    if (!bank || bank.frames < 1) return undefined;
    frame = mod(frame, bank.frames);
    if (entry.frames[kind] === frame) return undefined;
    const ts = entry.atlas;
    if (!ts || !ts.imageData) return undefined;
    entry.frames[kind] = frame;

    const nMids = len(bank.mids);
    const cols = ts.cols ?? 16;
    const image = ts.image;
    const partial = image != null && image.replacePixels != null;
    const mids = bank.mids;
    for (let mi = 1; mids[mi] != null; mi++) { // ipairs(bank.mids)
      const mid = mids[mi];
      const slot = ts.midToSlot[mid];
      if (slot != null) {
        const srcOff = (frame * nMids + (mi - 1)) * MID_RGBA;
        const ax = (slot % cols) * 16;
        const ay = Math.floor(slot / cols) * 16;
        const piece = get_frame_piece(bank, frame, mi, srcOff);
        let pasted = false;
        if (piece && ts.imageData.paste) {
          ts.imageData.paste(piece, ax, ay);
          pasted = true;
        }
        if (!pasted) {
          const frameRgba = sub(bank.rgba, srcOff + 1, srcOff + MID_RGBA);
          let i = 0; // Lua's i = 1 (frameRgba:byte(i)); charCodeAt is 0-based
          for (let y = 0; y <= 15; y++) {
            for (let x = 0; x <= 15; x++) {
              const r = (frameRgba.charCodeAt(i) || 0) / 255;
              const g = (frameRgba.charCodeAt(i + 1) || 0) / 255;
              const b = (frameRgba.charCodeAt(i + 2) || 0) / 255;
              const c3 = frameRgba.charCodeAt(i + 3);
              const a = (c3 === c3 ? c3 : 255) / 255; // byte or 255 (NaN past the end)
              ts.imageData.setPixel(ax + x, ay + y, r, g, b, a);
              i = i + 4;
            }
          }
        }
      }
    }
    if (deferUpload) return true;
    if (partial) {
      NativeTileset().flush(ts, true, false);
    } else if (ts.image) {
      ts.image = G.newImage(ts.imageData);
      if (ts.image.setFilter) ts.image.setFilter("nearest", "nearest");
      ts.quads = {};
      // package.loaded["src.core.game3.field_view"]: imported
      if (FieldView) {
        FieldView._nativeBatch = undefined;
        FieldView._nativeBatches = undefined;
        FieldView._nativeDirty = true;
      }
    }
    return undefined;
  },

  /** Pret TilesetAnim_General schedule (UpdateTilesetAnimations increments first). */
  // Lua: tileset_anim.lua:436
  step(): void {
    if (!TilesetAnim._enabled || !Versions.NATIVE_RENDER
      || Versions.TILESET_ANIM === false) return;
    if (TilesetAnim._rse) return TilesetAnim.stepRse();
    TilesetAnim.counter = TilesetAnim.counter + 1;
    if (TilesetAnim.counter >= TilesetAnim.counterMax) {
      TilesetAnim.counter = 0;
    }
    const timer = TilesetAnim.counter;

    if (timer % 8 === 0) {
      const frame = Math.floor(timer / 8) % 8;
      if (frame !== TilesetAnim._sandFrame) {
        TilesetAnim._sandFrame = frame;
      }
    }
    if (timer % 16 === 1) {
      const frame = Math.floor(timer / 16) % 8;
      if (frame !== TilesetAnim._waterFrame) {
        TilesetAnim._waterFrame = frame;
      }
    }
    if (timer % 16 === 2) {
      const frame = Math.floor(timer / 16) % 5;
      if (frame !== TilesetAnim._flowerFrame) {
        TilesetAnim._flowerFrame = frame;
      }
    }
    const visible = TilesetAnim._visible;
    for (const pair in visible) {
      const entry = TilesetAnim._pairs[pair];
      if (entry) {
        TilesetAnim._applyKind(entry, "sand", TilesetAnim._sandFrame);
        TilesetAnim._applyKind(entry, "water", TilesetAnim._waterFrame);
        TilesetAnim._applyKind(entry, "flower", TilesetAnim._flowerFrame);
      }
    }
  },
};

export default TilesetAnim;
