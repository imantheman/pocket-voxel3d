// Port of gen1recomp src/import/gba/field_effect_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Extract FRLG field-effect graphics directly from ROM.
// Tall grass, Cut grass leaves, Rock smash rubble, Surf blob, Fly bird, Ripples.
// Lua differences: decoded frames are 0-based pixel arrays (the Lua's are
// 1-based); palettes keep the Lua's keys 0..15 as array indices.
// NOT FAITHFUL: runRse (the RSE family's sprite-template path, reached only
// when Versions.FAMILY == "rse") throws; Emerald is not ported.

import { Versions } from "./versions.ts";
import { format, tonumber, tostring, char } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

type Rgb = [number, number, number];

export interface FieldEffectResult { path: string; w: number; h: number; frames: number }

// Lua: field_effect_extract.lua:10
function log(msg: unknown): void {
  console.log("[gba/field_effects] " + tostring(msg));
}

// Lua: field_effect_extract.lua:14
function bgr555_to_rgb8(cIn: unknown): Rgb {
  const c = (tonumber(cIn) ?? 0) % 32768;
  const r5 = c % 32;
  const g5 = Math.floor(c / 32) % 32;
  const b5 = Math.floor(c / 1024) % 32;
  return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
}

// Lua: field_effect_extract.lua:25 -- one frame (4bpp tiles, row-major) -> 0-based indices
function decode_frame(rom: Rom, off: number, fw: number, fh: number): number[] {
  const tw = Math.floor(fw / 8);
  const th = Math.floor(fh / 8);
  const pixels: number[] = [];
  for (let i = 0; i < fw * fh; i++) pixels[i] = 0;
  for (let ty = 0; ty <= th - 1; ty++) {
    for (let tx = 0; tx <= tw - 1; tx++) {
      const tileIdx = ty * tw + tx;
      const tileOff = off + tileIdx * 32;
      const ox = tx * 8, oy = ty * 8;
      for (let y = 0; y <= 7; y++) {
        for (let x = 0; x <= 7; x++) {
          const byteIndex = tileOff + y * 4 + Math.floor(x / 2);
          const b = rom.get(byteIndex);
          const idx = x % 2 === 1 ? Math.floor(b / 16) % 16 : b % 16;
          pixels[(oy + y) * fw + (ox + x)] = idx;
        }
      }
    }
  }
  return pixels;
}

// Lua: field_effect_extract.lua:48 -- keys 0..15
function load_palette(rom: Rom, palOff: number): Rgb[] {
  const rgb: Rgb[] = [];
  for (let i = 0; i <= 15; i++) {
    const c = rom.u16(palOff + i * 2);
    rgb[i] = bgr555_to_rgb8(c);
  }
  return rgb;
}

// Lua: field_effect_extract.lua:58 -- [rgba, w, h]
function bake_rgba(rom: Rom, picOff: number, palOff: number, fw: number, fh: number, frames: number): [string, number, number] {
  const frameBytes = Math.floor(fw / 8) * Math.floor(fh / 8) * 32;
  const w = fw;
  const h = fh * frames;
  const rgb = load_palette(rom, palOff);
  const bytes: string[] = [];
  for (let f = 0; f <= frames - 1; f++) {
    const pix = decode_frame(rom, picOff + f * frameBytes, fw, fh);
    for (let i = 0; i < fw * fh; i++) {
      const idx = pix[i] ?? 0;
      const a = idx === 0 ? 0 : 255;
      const c = rgb[idx] ?? [0, 0, 0];
      bytes.push(char(c[0], c[1], c[2], a));
    }
  }
  return [bytes.join(""), w, h];
}

// Lua: field_effect_extract.lua:77 (pokefirered/src/field_effect.c:949)
function bake_indexed(rom: Rom, picOff: number, fw: number, fh: number, frames: number): string {
  const frameBytes = Math.floor(fw / 8) * Math.floor(fh / 8) * 32;
  const bytes: string[] = [];
  for (let f = 0; f <= frames - 1; f++) {
    const pix = decode_frame(rom, picOff + f * frameBytes, fw, fh);
    for (let i = 0; i < fw * fh; i++) bytes.push(char(pix[i] ?? 0));
  }
  return bytes.join("");
}

// Lua: field_effect_extract.lua:89
function bake_pal(rom: Rom, palOff: number): string {
  const rgb = load_palette(rom, palOff);
  const bytes: string[] = [];
  for (let i = 0; i <= 15; i++) {
    const c = rgb[i] ?? [0, 0, 0];
    bytes.push(char(c[0], c[1], c[2]));
  }
  return bytes.join("");
}

// Lua: field_effect_extract.lua:100 (pokefirered/src/field_effect.c:2738) -- [rgba, w, h]
function bake_streaks(rom: Rom, spec: { gfx: number; pal: number; tilemap: number; tiles?: number }): [string, number, number] {
  const cols = 32, rows = 10;
  const w = cols * 8, h = rows * 8;
  const rgb = load_palette(rom, spec.pal);
  const tiles: Record<number, number[]> = {};
  for (let t = 0; t <= (spec.tiles ?? 16) - 1; t++) {
    tiles[t] = decode_frame(rom, spec.gfx + t * 32, 8, 8);
  }
  const out: string[] = [];
  for (let i = 0; i < w * h; i++) out[i] = "\x00\x00\x00\x00";
  for (let r = 0; r <= rows - 1; r++) {
    for (let c = 0; c <= cols - 1; c++) {
      const e = rom.u16(spec.tilemap + (r * cols + c) * 2);
      const tile = tiles[e % 1024];
      const hflip = Math.floor(e / 1024) % 2 === 1;
      const vflip = Math.floor(e / 2048) % 2 === 1;
      if (tile) {
        for (let y = 0; y <= 7; y++) {
          for (let x = 0; x <= 7; x++) {
            const sx = hflip ? 7 - x : x;
            const sy = vflip ? 7 - y : y;
            const idx = tile[sy * 8 + sx] ?? 0;
            if (idx !== 0) {
              const col = rgb[idx]!;
              out[(r * 8 + y) * w + c * 8 + x] = char(col[0], col[1], col[2], 255);
            }
          }
        }
      }
    }
  }
  return [out.join(""), w, h];
}

// Lua: field_effect_extract.lua:208
function rseRoot(opts?: { cacheRoot?: string }): string {
  return ((opts && opts.cacheRoot) ?? "data/generated/gba") + "/field_effects";
}

export const FieldEffectExtract = {
  FORMAT_VERSION: 2,
  RSE_FORMAT: 1,
  REQUIRED: [
    "field_effects/objects.lua",
    "field_effects/tall_grass.rgba",
    "field_effects/surf_blob.rgba",
    "field_effects/field_move_streaks_outdoors.rgba",
  ],

  // Lua: field_effect_extract.lua:134 -- results, or [undefined, err] as the Lua's nil, err
  writeExtract(rom: Rom | undefined, cache: Cache | undefined, root?: string, version?: unknown): Record<string, FieldEffectResult> | [undefined, string] {
    root = root ?? "data/generated/gba";
    version = version ?? {};
    if (!rom || !cache) return [undefined, "rom and cache required"];

    const effects: Record<string, any> = Versions.FIELD_EFFECTS ?? {};
    const rel = root + "/field_effects";
    const results: Record<string, FieldEffectResult> = {};

    // pairs() order: only the write order (and the log) depends on it
    for (const name of Object.keys(effects)) {
      const spec = effects[name];
      const picOff = spec.pic;
      const palOff = spec.pal;
      if (picOff !== undefined && palOff !== undefined) {
        const fw: number = spec.w ?? 16;
        const fh: number = spec.h ?? 16;
        const frames: number = spec.frames ?? 1;
        const [rgba, w, h] = bake_rgba(rom, picOff, palOff, fw, fh, frames);
        cache.write(rel + "/" + name + ".rgba", rgba);
        if (spec.indexed) {
          cache.write(rel + "/" + name + ".idx", bake_indexed(rom, picOff, fw, fh, frames));
          cache.write(rel + "/" + name + ".pal", bake_pal(rom, palOff));
        }
        cache.write(rel + "/" + name + ".meta", format(
          "return { w = %d, h = %d, frames = %d, fw = %d, fh = %d, indexed = %s, format = %d }\n",
          w, h, frames, fw, fh, spec.indexed ? "true" : "false",
          FieldEffectExtract.FORMAT_VERSION));
        log(format("%s %dx%d (%d frames, %dx%d) → %s", name, w, h, frames, fw, fh, rel));
        results[name] = { path: rel + "/" + name + ".rgba", w, h, frames };
      }
    }

    const streaks: Record<string, any> = Versions.FIELD_MOVE_STREAKS ?? {};
    for (const kind of Object.keys(streaks)) {
      const spec = streaks[kind];
      const name = "field_move_streaks_" + kind;
      const [rgba, w, h] = bake_streaks(rom, spec);
      cache.write(rel + "/" + name + ".rgba", rgba);
      cache.write(rel + "/" + name + ".meta", format(
        "return { w = %d, h = %d, frames = 1, fw = %d, fh = %d, indexed = false, format = %d }\n",
        w, h, w, h, FieldEffectExtract.FORMAT_VERSION));
      log(format("%s %dx%d → %s", name, w, h, rel));
      results[name] = { path: rel + "/" + name + ".rgba", w, h, frames: 1 };
    }

    return results;
  },

  /**
   * Lua: field_effect_extract.lua:300
   * NOT FAITHFUL: Emerald only (the RSE field-effect templates need
   * Versions.SYMS and the RSE version tables, which are not ported).
   */
  runRse(_rom: Rom, _cache: Cache, _opts?: { cacheRoot?: string }): never {
    throw new Error("NOT FAITHFUL: Emerald only");
  },

  // Lua: field_effect_extract.lua:359
  run(rom: Rom, cache: Cache, opts?: { cacheRoot?: string }): Record<string, FieldEffectResult> | [undefined, string] {
    if (Versions.FAMILY !== "rse") {
      return FieldEffectExtract.writeExtract(rom, cache, opts && opts.cacheRoot);
    }
    return FieldEffectExtract.runRse(rom, cache, opts);
  },

  /**
   * Lua: field_effect_extract.lua:366
   * NOT FAITHFUL: the RSE branch load()s objects.lua; Emerald is not ported,
   * so for RSE this throws like runRse. FRLG returns false, as the Lua does.
   */
  ready(_cache: Cache | undefined, cacheRoot?: string): boolean {
    if (Versions.FAMILY !== "rse") return false;
    void rseRoot({ cacheRoot });
    throw new Error("NOT FAITHFUL: Emerald only");
  },
};

export default FieldEffectExtract;
