// Port of gen1recomp src/import/gba/ball_open_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Poke Ball open particles, the 12 ball sprite sheets, fade colours and the
// sine table -> pokemon/battle/ball_open/. Byte tables are 0-based here (the
// Lua's 1-based); RGBA results are byte strings, as the Lua returns.

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { format, fromBytes, tostring } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

type Bytes = ArrayLike<number>;

// Lua: ball_open_extract.lua:20 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: ball_open_extract.lua:28 -- strings to byte arrays; tables pass through
function bytes_to_array(tbl: string | Bytes): Bytes {
  if (typeof tbl === "string") {
    const t: number[] = [];
    for (let i = 0; i < tbl.length; i++) t[i] = tbl.charCodeAt(i);
    return t;
  }
  return tbl;
}

// Lua: ball_open_extract.lua:42
function rgb555(c: number): [number, number, number] {
  return [c % 32, Math.floor(c / 32) % 32, Math.floor(c / 1024) % 32];
}

// Lua: ball_open_extract.lua:46
function to8(v5: number): number {
  return Math.floor((v5 * 255) / 31 + 0.5);
}

// Lua: ball_open_extract.lua:75
function s16(v: number): number {
  if (v >= 32768) return v - 65536;
  return v;
}

export const BallOpenExtract = {
  FORMAT_VERSION: 2,
  CACHE_SUB: "pokemon/battle/ball_open",
  REQUIRED: ["pokemon/battle/ball_open/manifest.lua"],
  BALL_COUNT: 12,
  TAG_PARTICLES_POKEBALL: 55020,
  TAG_POKE_BALL: 55000,
  SINE_COUNT: 320,
  BALL_SHEET_BYTES: 384,
  BALL_SHEET: "balls.rgba",
  BALL_SHEET_W: 16 * 12,
  BALL_SHEET_H: 48,
  // pokefirered/src/pokeball.c:1310
  NO_OPEN_SPLICE: { 6: true, 10: true, 11: true } as Record<number, boolean>,

  // Lua: ball_open_extract.lua:50 -- [rgba, w, h]
  bakeSheet(gfxIn: string | Bytes, palIn: string | Bytes): [string, number, number] {
    const gfx = bytes_to_array(gfxIn);
    const palBytes = bytes_to_array(palIn);
    const tiles = Math.floor(gfx.length / 32);
    const w = tiles * 8, h = 8;
    const out = new Uint8Array(w * h * 4);
    for (let ti = 0; ti <= tiles - 1; ti++) {
      for (let row = 0; row <= 7; row++) {
        for (let bx = 0; bx <= 3; bx++) {
          const byte = gfx[ti * 32 + row * 4 + bx] ?? 0;
          for (let n = 0; n <= 1; n++) {
            const idx = n === 0 ? byte % 16 : Math.floor(byte / 16);
            if (idx !== 0) {
              const c = (palBytes[idx * 2] ?? 0) + (palBytes[idx * 2 + 1] ?? 0) * 256;
              const [r, g, b] = rgb555(c);
              const o = (row * w + ti * 8 + bx * 2 + n) * 4;
              out[o] = to8(r); out[o + 1] = to8(g); out[o + 2] = to8(b); out[o + 3] = 255;
            }
          }
        }
      }
    }
    return [fromBytes(out), w, h];
  },

  // Lua: ball_open_extract.lua:80 -- the open frame over tiles 8..11 (bytes 256..383, 0-based)
  spliceOpenFrame(gfx: Bytes, openGfx: Bytes): number[] {
    const out: number[] = [];
    for (let i = 0; i < BallOpenExtract.BALL_SHEET_BYTES; i++) out[i] = gfx[i] ?? 0;
    for (let i = 0; i < 128; i++) out[256 + i] = openGfx[i] ?? 0;
    return out;
  },

  // Lua: ball_open_extract.lua:87 -- sheets/pals keyed by ball 0..11
  bakeBallStrip(sheets: Bytes[], pals: Bytes[]): [string, number, number] {
    const W = BallOpenExtract.BALL_SHEET_W, H = BallOpenExtract.BALL_SHEET_H;
    const out = new Uint8Array(W * H * 4);
    for (let ball = 0; ball <= BallOpenExtract.BALL_COUNT - 1; ball++) {
      const gfx = sheets[ball]!, pal = pals[ball]!;
      for (let ti = 0; ti <= 11; ti++) {
        const frame = Math.floor(ti / 4), sub = ti % 4;
        const ox = ball * 16 + (sub % 2) * 8;
        const oy = frame * 16 + Math.floor(sub / 2) * 8;
        for (let row = 0; row <= 7; row++) {
          for (let bx = 0; bx <= 3; bx++) {
            const byte = gfx[ti * 32 + row * 4 + bx] ?? 0;
            for (let n = 0; n <= 1; n++) {
              const idx = n === 0 ? byte % 16 : Math.floor(byte / 16);
              if (idx !== 0) {
                const c = (pal[idx * 2] ?? 0) + (pal[idx * 2 + 1] ?? 0) * 256;
                const [r, g, b] = rgb555(c);
                const o = ((oy + row) * W + ox + bx * 2 + n) * 4;
                out[o] = to8(r); out[o + 1] = to8(g); out[o + 2] = to8(b); out[o + 3] = 255;
              }
            }
          }
        }
      }
    }
    return [fromBytes(out), W, H];
  },

  // Lua: ball_open_extract.lua:116 -- [sheets, pals]
  extractBalls(rom: Rom): [Bytes[], Bytes[]] {
    const cfg = Versions.BALL_OPEN;
    const get = (i: number): number => rom.get(i);
    // pokefirered/src/pokeball.c:1316
    const openGfx = bytes_to_array(Lz77.decompress(get, cfg.open_ball_gfx)[0]);
    if (openGfx.length !== 128) throw new Error("ball_open: gOpenPokeballGfx size " + tostring(openGfx.length));
    const sheets: Bytes[] = [], pals: Bytes[] = [];
    for (let i = 0; i <= BallOpenExtract.BALL_COUNT - 1; i++) {
      // pokefirered/src/pokeball.c:59
      const sbase = cfg.sprite_sheets + i * 8;
      if (rom.u16(sbase + 4) !== BallOpenExtract.BALL_SHEET_BYTES
        || rom.u16(sbase + 6) !== BallOpenExtract.TAG_POKE_BALL + i) {
        throw new Error("ball_open: gBallSpriteSheets mismatch at entry " + tostring(i));
      }
      // pokefirered/src/pokeball.c:75
      const pbase = cfg.sprite_palettes + i * 8;
      if (rom.u16(pbase + 4) !== BallOpenExtract.TAG_POKE_BALL + i) {
        throw new Error("ball_open: gBallSpritePalettes mismatch at entry " + tostring(i));
      }
      let gfx: Bytes = bytes_to_array(Lz77.decompress(get, rom.ptrOffset(rom.u32(sbase))!)[0]);
      if (gfx.length !== BallOpenExtract.BALL_SHEET_BYTES) {
        throw new Error("ball_open: ball sheet " + tostring(i) + " size " + tostring(gfx.length));
      }
      if (!BallOpenExtract.NO_OPEN_SPLICE[i]) gfx = BallOpenExtract.spliceOpenFrame(gfx, openGfx);
      sheets[i] = gfx;
      pals[i] = bytes_to_array(Lz77.decompress(get, rom.ptrOffset(rom.u32(pbase))!)[0]);
    }
    return [sheets, pals];
  },

  // Lua: ball_open_extract.lua:148
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): { root: string; w: number; h: number } {
    const cfg = Versions.BALL_OPEN;
    const root = (opts.cacheRoot ?? default_cache_root()) + "/" + BallOpenExtract.CACHE_SUB;
    const get = (i: number): number => rom.get(i);

    // pokefirered/src/battle_anim_special.c:117
    const sheetPtr = rom.u32(cfg.particle_sheets);
    for (let i = 0; i <= BallOpenExtract.BALL_COUNT - 1; i++) {
      const base = cfg.particle_sheets + i * 8;
      if (rom.u32(base) !== sheetPtr || rom.u16(base + 4) !== 0x100
        || rom.u16(base + 6) !== BallOpenExtract.TAG_PARTICLES_POKEBALL + i) {
        throw new Error("ball_open: gBallParticleSpritesheets mismatch at entry " + tostring(i));
      }
    }
    // pokefirered/src/battle_anim_special.c:133
    const palPtr = rom.u32(cfg.particle_palettes);
    if (rom.u16(cfg.particle_palettes + 4) !== BallOpenExtract.TAG_PARTICLES_POKEBALL) {
      throw new Error("ball_open: gBallParticlePalettes mismatch");
    }
    const [gfx] = Lz77.decompress(get, rom.ptrOffset(sheetPtr)!);
    const [pal] = Lz77.decompress(get, rom.ptrOffset(palPtr)!);
    const [rgba, w, h] = BallOpenExtract.bakeSheet(gfx, pal);
    cache.write(root + "/particles.rgba", rgba);

    const [ballSheets, ballPals] = BallOpenExtract.extractBalls(rom);
    const [ballRgba, ballW, ballH] = BallOpenExtract.bakeBallStrip(ballSheets, ballPals);
    cache.write(root + "/" + BallOpenExtract.BALL_SHEET, ballRgba);

    // pokefirered/src/battle_anim_special.c:345
    const colors: string[] = [];
    for (let i = 0; i <= BallOpenExtract.BALL_COUNT - 1; i++) {
      const [r, g, b] = rgb555(rom.u16(cfg.fade_colors + i * 2));
      colors.push(format("{ %d, %d, %d }", r, g, b));
    }

    // pokefirered/src/trig.c:4
    const sine: string[] = [];
    for (let i = 0; i <= BallOpenExtract.SINE_COUNT - 1; i++) {
      sine.push(tostring(s16(rom.u16(cfg.sine_table + i * 2))));
    }

    const manifest = format(`return {
  format = %d,
  sheet = "particles.rgba",
  sheetW = %d, sheetH = %d,
  frameW = 8, frameH = 8,
  ballSheet = %q,
  ballSheetW = %d, ballSheetH = %d,
  fadeColors = { %s },
  sine = { %s },
}
`, BallOpenExtract.FORMAT_VERSION, w, h, BallOpenExtract.BALL_SHEET, ballW, ballH,
      colors.join(", "), sine.join(", "));
    cache.write(root + "/manifest.lua", manifest);
    return { root, w, h };
  },
};

export default BallOpenExtract;
