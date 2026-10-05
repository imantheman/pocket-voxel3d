// Port of gen1recomp src/import/gba/weather_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Weather graphics and palette extraction (Fog, Rain, default weather palette)
// pokefirered/src/field_weather.c
// Lua differences: byte arrays (bytes_to_array, the decoded tile) are
// 0-based here (the Lua's are 1-based); palettes keep keys 0..15.
// NOT FAITHFUL: runRse (reached only when Versions.FAMILY == "rse") throws;
// Emerald is not ported.

import { Versions } from "./versions.ts";
import { Plans } from "./plans.ts";
import { format, tonumber, char } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

interface Blob { key: string; rel: string; offset: number; size: number }

// Lua: weather_extract.lua:17
function bgr555_to_rgb8(cIn: unknown): [number, number, number] {
  const c = (tonumber(cIn) ?? 0) % 32768;
  const r5 = c % 32;
  const g5 = Math.floor(c / 32) % 32;
  const b5 = Math.floor(c / 1024) % 32;
  return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
}

// Lua: weather_extract.lua:27 -- 0-based here
function bytes_to_array(v: unknown): ArrayLike<number> {
  if (v instanceof Uint8Array || Array.isArray(v)) return v as ArrayLike<number>;
  const out: number[] = [];
  if (typeof v === "string") {
    for (let i = 0; i < v.length; i++) out[i] = v.charCodeAt(i);
  }
  return out;
}

// Lua: weather_extract.lua:36 -- keys 0..count-1
function load_pal(bytesIn: unknown, count: number): number[] {
  const bytes = bytes_to_array(bytesIn);
  const pal: number[] = [];
  for (let i = 0; i <= count - 1; i++) {
    pal[i] = (bytes[i * 2] ?? 0) + (bytes[i * 2 + 1] ?? 0) * 256;
  }
  return pal;
}

// Lua: weather_extract.lua:45 -- gfx and out 0-based here
function decode_tile_4bpp(gfx: ArrayLike<number>, base: number, out: number[]): void {
  for (let row = 0; row <= 7; row++) {
    for (let col = 0; col <= 7; col++) {
      const b = gfx[base + row * 4 + Math.floor(col / 2)] ?? 0;
      let idx: number;
      if (col % 2 === 0) idx = b % 16; else idx = Math.floor(b / 16);
      out[row * 8 + col] = idx;
    }
  }
}

// Lua: weather_extract.lua:95
function write_cache(cache: Cache | undefined, rel: string, data: string): boolean | undefined {
  if (!cache || typeof cache.write !== "function") return undefined;
  // The Lua pcalls cache:write and falls back to cache.write(rel, data)
  // when that fails or returns nil; a Cache here always returns a boolean.
  let res: boolean | undefined;
  try { res = cache.write(rel, data); } catch { res = undefined; }
  if (res === undefined) res = cache.write(rel, data);
  return res;
}

// Lua: weather_extract.lua:102 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

export const WeatherExtract = {
  CACHE_SUB: "weather",
  FORMAT_VERSION: 1,
  RSE_FORMAT: 1,

  BLOBS: [
    { key: "default_pal", rel: "default.gbapal", offset: 0x3C2CE0, size: 32 },
    { key: "fog_h_gfx", rel: "fog_horizontal.4bpp", offset: 0x3C3540, size: 2048 },
    { key: "rain_gfx", rel: "rain.4bpp", offset: 0x3C55C0, size: 1536 },
  ] as Blob[],

  REQUIRED: [
    "weather/manifest.lua",
    "weather/fog_horizontal.rgba",
    "weather/rain.rgba",
    "weather/drought_colors.bin",
  ],

  // Lua: weather_extract.lua:56 -- [rgba, W, H, tileCount]
  bakeSheet(gfxBytes: unknown, palBytes: unknown, cols?: number): [string, number, number, number] {
    const gfx = bytes_to_array(gfxBytes);
    const pal = load_pal(palBytes, 16);
    const tileCount = Math.floor(gfx.length / 32);
    cols = Math.max(1, cols ?? 8);
    const rows = Math.ceil(tileCount / cols);
    const W = cols * 8, H = rows * 8;
    const chunks: string[] = [];
    for (let i = 0; i < W * H; i++) chunks[i] = "\x00\x00\x00\x00";
    const tmp: number[] = [];
    for (let t = 0; t <= tileCount - 1; t++) {
      decode_tile_4bpp(gfx, t * 32, tmp);
      const ox = (t % cols) * 8, oy = Math.floor(t / cols) * 8;
      for (let row = 0; row <= 7; row++) {
        for (let col = 0; col <= 7; col++) {
          const idx = tmp[row * 8 + col] ?? 0;
          if (idx !== 0) {
            const [r, g, b] = bgr555_to_rgb8(pal[idx] ?? 0);
            chunks[(oy + row) * W + ox + col] = char(r, g, b, 255);
          }
        }
      }
    }
    return [chunks.join(""), W, H, tileCount];
  },

  // Lua: weather_extract.lua:82 -- key -> byte string
  readBlobs(rom: Rom, cfg?: Record<string, number>): Record<string, string> {
    cfg = cfg ?? {};
    const out: Record<string, string> = {};
    for (const blob of WeatherExtract.BLOBS) {
      const off = cfg[blob.key] ?? Versions.address(blob.offset);
      const bytes = rom.readBytes(off, blob.size);
      const chars: string[] = [];
      for (let i = 0; i < blob.size; i++) chars[i] = char(bytes[i] ?? 0);
      out[blob.key] = chars.join("");
    }
    return out;
  },

  /**
   * Lua: weather_extract.lua:116
   * NOT FAITHFUL: Emerald only (Versions.WEATHER_GFX and Versions.SYMS are
   * RSE tables, not ported).
   */
  runRse(_rom: Rom, _cache: Cache, _root: string): never {
    throw new Error("NOT FAITHFUL: Emerald only");
  },

  // Lua: weather_extract.lua:187
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + WeatherExtract.CACHE_SUB;
    if (!(cache && cache.read)) return false;
    if (Versions.FAMILY === "rse") {
      // NOT FAITHFUL: the RSE branch load()s manifest.lua; Emerald is not ported.
      throw new Error("NOT FAITHFUL: Emerald only");
    }
    const fog = cache.read(root + "/fog_horizontal.rgba");
    return typeof fog === "string" && fog.length === 64 * 64 * 4;
  },

  // Lua: weather_extract.lua:200
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string; offsets?: Record<string, number> } = {}): { format: number } {
    const root = (opts.cacheRoot ?? default_cache_root()) + "/" + WeatherExtract.CACHE_SUB;
    if (Versions.FAMILY === "rse") return WeatherExtract.runRse(rom, cache, root);
    const cfg = opts.offsets ?? {};
    const blobs = WeatherExtract.readBlobs(rom, cfg);

    for (const blob of WeatherExtract.BLOBS) {
      write_cache(cache, root + "/" + blob.rel, blobs[blob.key]!);
    }

    const [fogRgba, fogW, fogH] = WeatherExtract.bakeSheet(blobs.fog_h_gfx, blobs.default_pal, 8);
    write_cache(cache, root + "/fog_horizontal.rgba", fogRgba);

    const [rainRgba, rainW, rainH] = WeatherExtract.bakeSheet(blobs.rain_gfx, blobs.default_pal, 2);
    write_cache(cache, root + "/rain.rgba", rainRgba);

    write_cache(cache, root + "/manifest.lua", format(
      "return {\n"
      + "  format = %d,\n"
      + "  fog_h = { file = \"fog_horizontal.rgba\", w = %d, h = %d },\n"
      + "  rain = { file = \"rain.rgba\", w = %d, h = %d },\n"
      + "}\n", WeatherExtract.FORMAT_VERSION, fogW, fogH, rainW, rainH));

    return { format: WeatherExtract.FORMAT_VERSION };
  },
};

Plans.register("weather_extract", WeatherExtract as unknown as Record<string, unknown>);

export default WeatherExtract;
