// Port of gen1recomp src/import/gba/league_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/field_specials.c:2133, src/diploma.c:119
// LZ77 output and ROM byte runs are 0-based Uint8Arrays here (the Lua's
// 1-based tables); RGBA results are byte strings, as the Lua's.

import { Versions } from "./versions.ts";
import { BgBake, type Bytes, type PalBank } from "./bg_bake.ts";
import { Lz77 } from "./lz77.ts";
import { format, fromBytes, tostring } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

const SCREEN_W = 240, SCREEN_H = 160;

// Lua: league_extract.lua:24 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: league_extract.lua:32
function rom_bytes(rom: Rom, off: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = rom.get(off + i);
  return out;
}

// Lua: league_extract.lua:39
function lz(rom: Rom, off: number): Uint8Array {
  return Lz77.decompress((i: number) => rom.get(i), off)[0];
}

// Lua: league_extract.lua:45
function pal_list(rom: Rom, off: number, count: number): string {
  const rows: string[] = [];
  for (let p = 0; p < count; p++) {
    const cols: string[] = [];
    for (let c = 0; c <= 15; c++) cols.push(format("0x%04X", rom.u16(off + p * 32 + c * 2)));
    rows.push("      { " + cols.join(", ") + " },");
  }
  return rows.join("\n");
}

// Lua: league_extract.lua:55
function byte_list(rom: Rom, off: number, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(tostring(rom.get(off + i)));
  return out.join(", ");
}

// Lua: league_extract.lua:62 -- src/field_specials.c:2133
function lighting(rom: Rom): string {
  const L = Versions.LEAGUE_LIGHTING;
  return [
    "return {",
    format("  format_version = %d,", LeagueExtract.FORMAT_VERSION),
    "  palette_slot = 7,",
    "  e4 = {",
    "    pals = {",
    pal_list(rom, L.e4_pals, L.e4_pal_count),
    "    },",
    "    timers = { " + byte_list(rom, L.e4_timers, L.e4_steps) + " },",
    "  },",
    "  champion = {",
    "    pals = {",
    pal_list(rom, L.champ_pals, L.champ_pal_count),
    "    },",
    "    timers = { " + byte_list(rom, L.champ_timers, L.champ_steps) + " },",
    "  },",
    "}",
    "",
  ].join("\n");
}

// Lua: league_extract.lua:86 -- src/diploma.c:137
function diploma_screen(gfx: Bytes, banks: PalBank[], map: Bytes, block: number): string {
  const sub = new Uint8Array(2048);
  const base = block * 2048;
  for (let i = 0; i < 2048; i++) sub[i] = map[base + i] ?? 0;
  const top = BgBake.bakeRegionRgba(gfx, banks, sub, SCREEN_W, SCREEN_H, { mapW: 32, alpha0: true });
  const [r, g, b] = BgBake.bgr555ToRgb8(banks[0]![0]!);
  const out = new Uint8Array(SCREEN_W * SCREEN_H * 4);
  for (let i = 0; i < SCREEN_W * SCREEN_H; i++) {
    const o = i * 4;
    if (top.charCodeAt(o + 3) > 0) {
      for (let k = 0; k < 4; k++) out[o + k] = top.charCodeAt(o + k);
    } else {
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
  }
  return fromBytes(out);
}

// Lua: league_extract.lua:106 -- a 32x32 tilemap whose rows r.y .. r.y+h-1 hold tile r.tile
function fill_map(rows: { y: number; h: number; tile: number }[]): Uint8Array {
  const map = new Uint8Array(32 * 32 * 2);
  for (const r of rows) {
    for (let y = r.y; y <= r.y + r.h - 1; y++) {
      for (let x = 0; x <= 31; x++) map[(y * 32 + x) * 2] = r.tile;
    }
  }
  return map;
}

// Lua: league_extract.lua:121 -- src/hall_of_fame.c:1181, :1163
function hall_of_fame(rom: Rom, put: (name: string, body: string) => void): void {
  const H = Versions.HALL_OF_FAME;
  const gfx = lz(rom, H.gfx);
  const banks = BgBake.loadPalBanks(rom_bytes(rom, H.pal, 32), 1);
  put("hall_of_fame/bands.rgba", BgBake.bakeRegionRgba(gfx, banks, fill_map([
    { y: 0, h: 2, tile: 1 },
    { y: 3, h: 11, tile: 0 },
    { y: 14, h: 6, tile: 1 },
  ]), SCREEN_W, SCREEN_H, { alpha0: true }));
  put("hall_of_fame/stripes.rgba", BgBake.bakeRegionRgba(gfx, banks,
    fill_map([{ y: 0, h: 32, tile: 2 }]), SCREEN_W, SCREEN_H, {}));
  const sheet = lz(rom, H.confetti_sheet);
  if (BgBake.byteLen(sheet) !== H.confetti_frames * 32) throw new Error("confetti sheet is not 17 8x8 tiles");
  const pal = BgBake.loadPalBanks(lz(rom, H.confetti_pal), 1)[0];
  const frames: string[] = [];
  for (let f = 0; f < H.confetti_frames; f++) frames.push(BgBake.bakeSpriteRgba(sheet, pal, f, 8, 8, false, false));
  put("hall_of_fame/confetti.rgba", frames.join(""));
  put("hall_of_fame/manifest.lua", format(`return {
  format_version = %d,
  width = %d,
  height = %d,
  confetti = { w = 8, h = 8, frames = %d },
}
`, LeagueExtract.FORMAT_VERSION, SCREEN_W, SCREEN_H, H.confetti_frames));
}

export const LeagueExtract = {
  FORMAT_VERSION: 1,
  LIGHTING: "league/lighting.lua",
  FILES: [
    "league/lighting.lua",
    "diploma/manifest.lua",
    "diploma/kanto.rgba",
    "diploma/national.rgba",
    "hall_of_fame/manifest.lua",
    "hall_of_fame/bands.rgba",
    "hall_of_fame/stripes.rgba",
    "hall_of_fame/confetti.rgba",
  ],

  // Lua: league_extract.lua:150
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): { root: string } {
    const root = opts.cacheRoot ?? default_cache_root();
    const put = (name: string, body: string): void => {
      if (!cache.write(root + "/" + name, body)) throw new Error("assertion failed!");
    };
    put(LeagueExtract.LIGHTING, lighting(rom));

    const D = Versions.DIPLOMA;
    const gfx = lz(rom, D.gfx);
    const map = lz(rom, D.tilemap);
    if (BgBake.byteLen(map) !== 4096) throw new Error("diploma tilemap is not 64x32");
    const banks = BgBake.loadPalBanks(rom_bytes(rom, D.pal, 64), 2);
    put("diploma/kanto.rgba", diploma_screen(gfx, banks, map, 0));
    put("diploma/national.rgba", diploma_screen(gfx, banks, map, 1));
    put("diploma/manifest.lua", format(`return {
  format_version = %d,
  width = %d,
  height = %d,
}
`, LeagueExtract.FORMAT_VERSION, SCREEN_W, SCREEN_H));
    hall_of_fame(rom, put);
    console.log(format("[league_extract] league lighting palettes, diploma and hall of fame screens -> %s", root));
    return { root };
  },

  // Lua: league_extract.lua:175
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = cacheRoot ?? default_cache_root();
    if (!(cache && cache.exists)) return false;
    for (const rel of LeagueExtract.FILES) {
      if (!cache.exists(root + "/" + rel)) return false;
    }
    return true;
  },
};

export default LeagueExtract;
