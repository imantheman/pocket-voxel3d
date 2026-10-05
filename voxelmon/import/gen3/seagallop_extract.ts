// Port of gen1recomp src/import/gba/seagallop_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/seagallop.c:41
// Lua differences: byte tables are 0-based (Uint8Array / number[]);
// blobs and baked images are byte strings, as in the Lua.

import { format, tonumber, tostring } from "./lua.ts";
import { Versions } from "./versions.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

type Bytes = ArrayLike<number>;

interface Blob { key: string; rel: string; offset: number; size: number }
interface Sheet { key: string; gfx: string; pal: string; cols: number; rel: string }

// Lua: seagallop_extract.lua:31
function bgr555_to_rgb8(cv: unknown): [number, number, number] {
  const c = (tonumber(cv) ?? 0) % 32768;
  const r5 = c % 32;
  const g5 = Math.floor(c / 32) % 32;
  const b5 = Math.floor(c / 1024) % 32;
  return [Math.floor(r5 * 255 / 31 + 0.5),
    Math.floor(g5 * 255 / 31 + 0.5),
    Math.floor(b5 * 255 / 31 + 0.5)];
}

// Lua: seagallop_extract.lua:42 -- 0-based
function bytes_to_array(v: unknown): Bytes {
  if (v !== null && typeof v === "object") return v as Bytes;
  const out: number[] = [];
  if (typeof v === "string") {
    for (let i = 0; i < v.length; i++) out[i] = v.charCodeAt(i);
  }
  return out;
}

// Lua: seagallop_extract.lua:50 -- pal keeps the Lua's 0-based keys
function load_pal(bytesIn: unknown, count: number): number[] {
  const bytes = bytes_to_array(bytesIn);
  const pal: number[] = [];
  for (let i = 0; i <= count - 1; i++) {
    pal[i] = (bytes[i * 2] ?? 0) + (bytes[i * 2 + 1] ?? 0) * 256;
  }
  return pal;
}

// Lua: seagallop_extract.lua:59 -- out 0-based (the Lua's out[sy * 8 + sx + 1])
function decode_tile_4bpp(gfx: Bytes, base: number, out: number[], hflip: boolean, vflip: boolean): void {
  for (let row = 0; row <= 7; row++) {
    for (let col = 0; col <= 7; col++) {
      const b = gfx[base + row * 4 + Math.floor(col / 2)] ?? 0;
      let idx: number;
      if (col % 2 === 0) idx = b % 16; else idx = Math.floor(b / 16);
      const sx = hflip ? (7 - col) : col;
      const sy = vflip ? (7 - row) : row;
      out[sy * 8 + sx] = idx;
    }
  }
}

function rgba(r: number, g: number, b: number): string {
  return String.fromCharCode(r, g, b, 255);
}

// Lua: seagallop_extract.lua:166 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: seagallop_extract.lua:154
function write_cache(cache: Cache | undefined, rel: string, data: string): boolean | undefined {
  if (cache === null || typeof cache !== "object" || typeof cache.write !== "function") return undefined;
  const res = cache.write(rel, data);
  if (res === false) {
    throw new Error("seagallop_extract: could not write " + rel + ": " + tostring(undefined));
  }
  return res;
}

export const SeagallopExtract = {
  CACHE_SUB: "seagallop",
  FORMAT_VERSION: 1,

  // src/seagallop.c:41
  BLOBS: [
    { key: "water_gfx", rel: "water.4bpp", offset: 0x468C98, size: 1312 },
    { key: "water_pal", rel: "water.gbapal", offset: 0x4691B8, size: 32 },
    { key: "wb_tilemap", rel: "wb_tilemap.bin", offset: 0x4691D8, size: 2048 },
    { key: "eb_tilemap", rel: "eb_tilemap.bin", offset: 0x4699D8, size: 2048 },
    { key: "ferry_gfx", rel: "ferry.4bpp", offset: 0x46A1D8, size: 1280 },
    { key: "ferry_wake_pal", rel: "ferry_wake.gbapal", offset: 0x46A6D8, size: 32 },
    { key: "wake_gfx", rel: "wake.4bpp", offset: 0x46A6F8, size: 2048 },
  ] as Blob[],

  // src/seagallop.c:42
  SHEETS: [
    { key: "water", gfx: "water_gfx", pal: "water_pal", cols: 8, rel: "water.rgba" },
    { key: "ferry", gfx: "ferry_gfx", pal: "ferry_wake_pal", cols: 8, rel: "ferry.rgba" },
    { key: "wake", gfx: "wake_gfx", pal: "ferry_wake_pal", cols: 4, rel: "wake.rgba" },
  ] as Sheet[],

  MAP_W: 32,
  MAP_H: 32,

  // Lua: seagallop_extract.lua:73 -- [rgba, W, H, tileCount]
  bakeSheet(gfxBytes: unknown, palBytes: unknown, cols?: number): [string, number, number, number] {
    const gfx = bytes_to_array(gfxBytes);
    const pal = load_pal(palBytes, 16);
    const tileCount = Math.floor(gfx.length / 32);
    cols = Math.max(1, cols ?? 8);
    const rows = Math.ceil(tileCount / cols);
    const W = cols * 8, H = rows * 8;
    const chunks: string[] = [];
    for (let i = 0; i < W * H; i++) chunks[i] = "\0\0\0\0";
    const tmp: number[] = [];
    for (let t = 0; t <= tileCount - 1; t++) {
      decode_tile_4bpp(gfx, t * 32, tmp, false, false);
      const ox = (t % cols) * 8, oy = Math.floor(t / cols) * 8;
      for (let row = 0; row <= 7; row++) {
        for (let col = 0; col <= 7; col++) {
          const idx = tmp[row * 8 + col] ?? 0;
          if (idx !== 0) {
            const [r, g, b] = bgr555_to_rgb8(pal[idx] ?? 0);
            chunks[(oy + row) * W + ox + col] = rgba(r, g, b);
          }
        }
      }
    }
    return [chunks.join(""), W, H, tileCount];
  },

  // Lua: seagallop_extract.lua:100 -- [rgba, W, H]
  bakeTilemap(gfxBytes: unknown, palBytes: unknown, mapBytes: unknown, mapW: number, mapH: number): [string, number, number] {
    const gfx = bytes_to_array(gfxBytes);
    const map = bytes_to_array(mapBytes);
    const pal = load_pal(palBytes, 16);
    const tileCount = Math.floor(gfx.length / 32);
    const W = mapW * 8, H = mapH * 8;
    const chunks: string[] = [];
    for (let i = 0; i < W * H; i++) chunks[i] = "\0\0\0\0";
    const tmp: number[] = [];
    for (let ty = 0; ty <= mapH - 1; ty++) {
      for (let tx = 0; tx <= mapW - 1; tx++) {
        const mi = (ty * mapW + tx) * 2;
        const entry = (map[mi] ?? 0) + (map[mi + 1] ?? 0) * 256;
        let tileId = entry % 1024;
        const hflip = Math.floor(entry / 1024) % 2 === 1;
        const vflip = Math.floor(entry / 2048) % 2 === 1;
        if (tileId >= tileCount) tileId = 0;
        decode_tile_4bpp(gfx, tileId * 32, tmp, hflip, vflip);
        for (let row = 0; row <= 7; row++) {
          for (let col = 0; col <= 7; col++) {
            const idx = tmp[row * 8 + col] ?? 0;
            const [r, g, b] = bgr555_to_rgb8(pal[idx] ?? 0);
            chunks[(ty * 8 + row) * W + tx * 8 + col] = rgba(r, g, b);
          }
        }
      }
    }
    return [chunks.join(""), W, H];
  },

  // Lua: seagallop_extract.lua:141
  readBlobs(rom: Rom, cfg?: Record<string, number>): Record<string, string> {
    cfg = cfg ?? {};
    const out: Record<string, string> = {};
    for (const blob of SeagallopExtract.BLOBS) {
      const off = cfg[blob.key] ?? Versions.address(blob.offset);
      const bytes = rom.readBytes(off, blob.size);
      const chars: string[] = [];
      for (let i = 0; i < blob.size; i++) chars[i] = String.fromCharCode(bytes[i] ?? 0);
      out[blob.key] = chars.join("");
    }
    return out;
  },

  // Lua: seagallop_extract.lua:172
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + SeagallopExtract.CACHE_SUB;
    if (!(cache && cache.read)) return false;
    const manifest = cache.read(root + "/manifest.lua");
    if (typeof manifest !== "string") return false;
    const m = /format[ \t\n\v\f\r]*=[ \t\n\v\f\r]*(\d+)/.exec(manifest);
    if ((m ? tonumber(m[1]) : undefined) !== SeagallopExtract.FORMAT_VERSION) {
      return false;
    }
    for (const blob of SeagallopExtract.BLOBS) {
      const data = cache.read(root + "/" + blob.rel);
      if (typeof data !== "string" || data.length < blob.size) return false;
    }
    const wb = cache.read(root + "/wb.rgba");
    return typeof wb === "string"
      && wb.length === SeagallopExtract.MAP_W * 8 * SeagallopExtract.MAP_H * 8 * 4;
  },

  // Lua: seagallop_extract.lua:190
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string; offsets?: Record<string, number> } = {}): { format: number; blobs: number } {
    const root = (opts.cacheRoot ?? default_cache_root()) + "/" + SeagallopExtract.CACHE_SUB;
    const cfg = opts.offsets ?? {};
    const blobs = SeagallopExtract.readBlobs(rom, cfg);

    for (const blob of SeagallopExtract.BLOBS) {
      write_cache(cache, root + "/" + blob.rel, blobs[blob.key]!);
    }

    const sheetMeta: string[] = [];
    for (const sheet of SeagallopExtract.SHEETS) {
      const [data, w, h, tiles] = SeagallopExtract.bakeSheet(blobs[sheet.gfx], blobs[sheet.pal], sheet.cols);
      write_cache(cache, root + "/" + sheet.rel, data);
      sheetMeta.push(format(
        "    %s = { file = %q, w = %d, h = %d, tiles = %d },",
        sheet.key, sheet.rel, w, h, tiles));
    }

    const mapW = SeagallopExtract.MAP_W, mapH = SeagallopExtract.MAP_H;
    const bgMeta: string[] = [];
    for (const bg of [["wb", "wb_tilemap"], ["eb", "eb_tilemap"]] as [string, string][]) {
      const [data, w, h] = SeagallopExtract.bakeTilemap(
        blobs.water_gfx, blobs.water_pal, blobs[bg[1]], mapW, mapH);
      write_cache(cache, root + "/" + bg[0] + ".rgba", data);
      bgMeta.push(format(
        "    %s = { file = %q, w = %d, h = %d },", bg[0], bg[0] + ".rgba", w, h));
    }

    write_cache(cache, root + "/manifest.lua", format(
      "return {\n  format = %d,\n  sheets = {\n%s\n  },\n  backgrounds = {\n%s\n  },\n}\n",
      SeagallopExtract.FORMAT_VERSION, sheetMeta.join("\n"), bgMeta.join("\n")));

    return { format: SeagallopExtract.FORMAT_VERSION, blobs: SeagallopExtract.BLOBS.length };
  },
};

export default SeagallopExtract;
