// Port of gen1recomp src/core/game3/asset_decode.lua (GPLv3 + additional terms; see LICENSE.md).
// CPU-only preparation shared by the render thread and the asset worker.
//
// A cache here is Dataset.cache()'s shape (read/write/exists, plus the
// optional `cancelled`). Importer results keep their own shapes: decodeIdx's
// midIds is 0-based (the Lua's ipairs index i is midIds[i - 1]); palettes are
// [slot][colour]. `out.midToSlot` is keyed by mid as Brian's; `out.layers` and
// the anim manifest's lists are Lua sequences.

import { NativePack as Pack, type IdxTable } from "../../../import/gen3/native_pack.ts";
import { OwExtract } from "../../../import/gen3/ow_extract.ts";
import { Palette } from "./palette.ts";
import { newImageData, type ImageData } from "../platform/image.ts";
import { luaLoad } from "../platform/luadata.ts";
import { Fs } from "../platform/fs.ts";
import { ipairs, len, type LuaTable } from "../platform/lt.ts";
import { tostring } from "../../../import/gen3/lua.ts";

export interface DecodeCache {
  read(rel: string): string | undefined;
  write?(rel: string, bytes: string): unknown;
  exists?(rel: string): boolean;
  cancelled?: () => boolean;
  [k: string]: any;
}

export interface PairLayer { imageKey: string; dataKey: string; data: ImageData; bytes: number }

export interface PairData {
  pair: string;
  cols: number;
  rows: number;
  midCount: number;
  idxBlob: string;
  bgr: any;
  midToSlot: Record<number, number>;
  layers: LuaTable;
  overBlob?: string;
  layered?: boolean;
  animFiles?: Record<string, string | undefined>;
}

export const D = {
  // Lua: asset_decode.lua:7 -- [data] or [undefined, why]
  imageData(rgba: string, w: number, h: number): [ImageData?, string?] {
    // love.image is always present here (platform/image.ts); the Lua's
    // setPixel fallback for a failed rgba8 constructor is not needed.
    try {
      return [newImageData(w, h, "rgba8", rgba)];
    } catch (e) {
      // Lua: data = love.image.newImageData(w, h) + setPixel loop
      const data = newImageData(w, h);
      let i = 0;
      for (let y = 0; y <= h - 1; y++) {
        for (let x = 0; x <= w - 1; x++) {
          data.setPixel(x, y, (rgba.charCodeAt(i) || 0) / 255, (rgba.charCodeAt(i + 1) || 0) / 255,
            (rgba.charCodeAt(i + 2) || 0) / 255, (rgba.charCodeAt(i + 3) || 0) / 255);
          i = i + 4;
        }
      }
      return [data];
    }
  },

  // Lua: asset_decode.lua:23 -- [out] or [undefined, err]
  pair(cache: DecodeCache, root: string, pair: string): [PairData?, string?] {
    const path = root + "/" + pair;
    const blob = cache.read(path + "/mids.idx"), pals = cache.read(path + "/palettes.bin");
    if (blob == null || pals == null) return [undefined, "missing native blobs for " + pair];
    const [idx, err] = Pack.decodeIdx(blob);
    if (!idx) return [undefined, err];
    const [rgb, bgr] = Palette.load(pals);
    if (!rgb) return [undefined, bgr as string];
    const overBlob = cache.read(path + "/mids_over.idx");
    const out: PairData = {
      pair, cols: idx.atlasCols, rows: idx.atlasRows, midCount: idx.midCount,
      idxBlob: blob, bgr, midToSlot: {}, layers: [null],
    };
    // Lua: for i, mid in ipairs(idx.midIds) do out.midToSlot[mid] = i - 1 end (midIds is 0-based)
    idx.midIds.forEach((mid, i0) => { out.midToSlot[mid] = i0; });
    // Lua: asset_decode.lua:35
    const layer = (key: string, dataKey: string, indexed: IdxTable, source: string, tag: string, transparent: boolean): [boolean?, string?] => {
      const hash = Palette.hash(bgr as any, source);
      const rel = path + "/atlas_" + tag + "_" + hash + ".rgba";
      const w = indexed.atlasCols * 16, h = indexed.atlasRows * 16;
      let rgba = cache.read(rel);
      if (rgba == null || rgba.length !== w * h * 4) {
        rgba = Pack.bakeRgba(indexed, rgb, { transparentZero: transparent, cancelled: cache.cancelled })[0];
        if (rgba == null) return [undefined, "asset preparation cancelled"];
        if (cache.write) { try { cache.write(rel, rgba); } catch { /* pcall */ } }
      }
      const [data, why] = D.imageData(rgba, w, h);
      if (!data) return [undefined, why];
      out.layers[len(out.layers) + 1] = { imageKey: key, dataKey, data, bytes: w * h * 4 };
      return [true];
    };
    let [ok, why] = layer("image", "imageData", idx, blob, overBlob != null ? "u" : "flat", false);
    if (!ok) return [undefined, why];
    const over = overBlob != null ? Pack.decodeIdx(overBlob)[0] : undefined;
    if (over) {
      [ok, why] = layer("overImage", "overImageData", over, overBlob!, "o", true);
      if (!ok) return [undefined, why];
      out.overBlob = overBlob; out.layered = true;
    }
    if (overBlob != null) {
      const midBlob = cache.read(path + "/mids_mid.idx");
      const mid = midBlob != null ? Pack.decodeIdx(midBlob)[0] : undefined;
      if (mid) {
        [ok, why] = layer("midImage", "midImageData", mid, midBlob!, "m", true);
        if (!ok) return [undefined, why];
      }
    }
    out.animFiles = {};
    const manifestRel = path + "/anim_manifest.lua";
    const manifestBlob = cache.read(manifestRel);
    out.animFiles[manifestRel] = manifestBlob;
    const chunk = manifestBlob != null ? luaLoad(manifestBlob, "@anim_manifest.lua")[0] : undefined;
    const man: any = chunk && chunk();
    if (man) {
      const read = (file: unknown): void => {
        if (file != null) out.animFiles![path + "/" + file] = cache.read(path + "/" + file);
      };
      out.animFiles[path + "/palettes.bin"] = pals;
      for (const [, row] of ipairs<any>(man.banks ?? [null])) { read(row.file); read(row.overFile); }
      for (const kind of ["water", "sand", "flower"]) {
        if (man[kind]) read("anim_" + kind + ".rgba");
      }
    }
    return [out];
  },

  // Lua: asset_decode.lua:85 -- [meta] or [undefined, err]
  sprite(cache: DecodeCache, root: string, gid: unknown): [any, string?] {
    const metaBlob = cache.read(root + "/" + tostring(gid) + ".meta");
    let rgba = cache.read(root + "/" + tostring(gid) + ".rgba");
    // decodeMeta returns [meta, err]; the Lua keeps the first value
    const m: any = metaBlob != null ? OwExtract.decodeMeta(metaBlob)[0] : undefined;
    if (!m || rgba == null) return [undefined, "missing OW sheet " + tostring(gid)];
    const w = m.width, h = m.height, n = m.frameCount;
    if (w < 1 || h < 1 || n < 1 || w > 256 || h > 256 || n > 512) return [undefined, "bad OW dimensions"];
    const bytes = w * h * n * 4;
    if (rgba.length !== bytes) {
      if (rgba.length < w * h * 4) return [undefined, "truncated OW sheet"];
      rgba = rgba.slice(0, bytes) + "\0".repeat(Math.max(0, bytes - rgba.length));
    }
    const [data, err] = D.imageData(rgba, w, h * n);
    if (!data) return [undefined, err];
    m.imageData = data; m.bytes = bytes;
    return [m];
  },

  // Lua: asset_decode.lua:103
  // Snapshots never consult a later GameVersion, cache prefix, or mod mount.
  // NOT FAITHFUL: no io.open here; a spec.directory snapshot reads and writes
  // through love.filesystem (Fs) like the no-directory case. The 3DS has no
  // worker threads, so cancelSignal is a plain { getCount() } when given.
  cache(spec: { prefix?: string; directory?: string }, cancelSignal?: { getCount(): number }): DecodeCache {
    const cache: DecodeCache = {
      cancelled: cancelSignal ? () => cancelSignal.getCount() > 0 : undefined,
      read(rel: string): string | undefined {
        checkCancel();
        return Fs.read(path(rel));
      },
      write(rel: string, bytes: string): boolean {
        checkCancel();
        // No directory creation or mounting in a worker; derived caches are optional.
        return Fs.write(path(rel), bytes);
      },
    };
    function checkCancel(): void {
      if (cache.cancelled && cache.cancelled()) throw new Error("asset preparation cancelled");
    }
    function path(rel: string): string { return (spec.prefix ?? "") + rel; }
    return cache;
  },
};

export default D;
