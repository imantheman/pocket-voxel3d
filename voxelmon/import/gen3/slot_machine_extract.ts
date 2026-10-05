// Port of gen1recomp src/import/gba/slot_machine_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/slot_machine.c:399, :739
// LZ77 output and ROM byte runs are 0-based Uint8Arrays here (the Lua's
// 1-based tables); palette banks are keyed from 0 as the Lua keys them.

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { BgBake, type Bytes, type PalBank } from "./bg_bake.ts";
import { format } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

const ICON_SIZE = 32;
const ICON_FRAMES = 7;
const CLEFAIRY_SIZE = 32;
const CLEFAIRY_FRAMES = 6;
const DIGIT_W = 8, DIGIT_H = 16;
const DIGIT_FRAMES = 10;
const SCREEN_W = 240, SCREEN_H = 160;

// src/slot_machine.c:2402
const LIGHTS_TILE_X = 1, LIGHTS_TILE_Y = 2, LIGHTS_TILES_W = 28, LIGHTS_TILES_H = 2;
// src/slot_machine.c:30
const LINES_TILE_X = 4, LINES_TILE_Y = 5, LINES_TILES_W = 22, LINES_TILES_H = 13;
const BUTTON_W = 16, BUTTON_H = 16;

// Lua: slot_machine_extract.lua:26 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: slot_machine_extract.lua:34
function raw_bytes(rom: Rom, off: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rom.get(off + i);
  return out;
}

// Lua: slot_machine_extract.lua:40
function pal_banks(rom: Rom, off: number, count: number): PalBank[] {
  return BgBake.loadPalBanks(raw_bytes(rom, off, count * 32), count);
}

// Lua: slot_machine_extract.lua:45 -- src/slot_machine.c:429 (0-based: the Lua's out[f + 1] is out[f])
function icon_pal_banks(rom: Rom): number[] {
  const out: number[] = [];
  for (let i = 0; i < ICON_FRAMES; i++) out[i] = rom.u16(Versions.SLOT_REEL_ICON_PAL_TAGS + i * 2);
  return out;
}

// Lua: slot_machine_extract.lua:52 -- src/slot_machine.c:857
function button_tile_xy(rom: Rom): [number, number][] {
  const out: [number, number][] = [];
  for (let r = 1; r <= Versions.SLOT_REELS; r++) {
    const idx = rom.u16(Versions.SLOT_REEL_BUTTON_MAP_IDXS + (r - 1) * Versions.SLOT_BUTTON_TILES * 2);
    out.push([idx % 32, Math.floor(idx / 32)]);
  }
  return out;
}

// Lua: slot_machine_extract.lua:62
function frames_rgba(gfx: Bytes, bankFor: (f: number) => PalBank | undefined, tilesPerFrame: number, fw: number, fh: number, frames: number): string {
  const parts: string[] = [];
  for (let f = 0; f < frames; f++) parts.push(BgBake.bakeSpriteRgba(gfx, bankFor(f), f * tilesPerFrame, fw, fh, false, false));
  return parts.join("");
}

// Lua: slot_machine_extract.lua:71 -- banks 0..#banks (every bank: keys run 0..n-1)
function pal_bytes(banks: (PalBank | undefined)[]): string {
  let s = "";
  for (let b = 0; b < banks.length; b++) {
    const bank = banks[b];
    if (bank) {
      for (let c = 0; c <= 15; c++) s += String.fromCharCode(...BgBake.bgr555ToRgb8(bank[c] ?? 0));
    }
  }
  return s;
}

export const SlotMachineExtract = {
  CACHE_SUB: "slot_machine",
  FORMAT_VERSION: 1,

  // Lua: slot_machine_extract.lua:85
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): { root: string; icons: number; digits: number } {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + SlotMachineExtract.CACHE_SUB;
    const get = (i: number): number => rom.get(i);

    const [iconGfx] = Lz77.decompress(get, Versions.SLOT_REEL_ICONS_GFX);
    const iconBanks = pal_banks(rom, Versions.SLOT_REEL_ICONS_PAL, 5);
    const iconPalBank = icon_pal_banks(rom);
    cache.write(root + "/reel_icons.rgba", frames_rgba(iconGfx, (f) => iconBanks[iconPalBank[f] ?? 0],
      16, ICON_SIZE, ICON_SIZE, ICON_FRAMES));

    const [clefGfx] = Lz77.decompress(get, Versions.SLOT_CLEFAIRY_GFX);
    const clefBank = pal_banks(rom, Versions.SLOT_CLEFAIRY_PAL, 1)[0];
    cache.write(root + "/clefairy.rgba", frames_rgba(clefGfx, () => clefBank, 16, CLEFAIRY_SIZE, CLEFAIRY_SIZE, CLEFAIRY_FRAMES));

    const [digitGfx] = Lz77.decompress(get, Versions.SLOT_DIGITS_GFX);
    const digitBank = pal_banks(rom, Versions.SLOT_DIGITS_PAL, 1)[0];
    cache.write(root + "/digits.rgba", frames_rgba(digitGfx, () => digitBank, 2, DIGIT_W, DIGIT_H, DIGIT_FRAMES));

    const [bgGfx] = Lz77.decompress(get, Versions.SLOT_BG_GFX);
    const [bgMap] = Lz77.decompress(get, Versions.SLOT_BG_TILEMAP);
    const bgBanks = pal_banks(rom, Versions.SLOT_BG_PAL, 5);
    cache.write(root + "/bg.rgba", BgBake.bakeBgRgba(bgGfx, bgBanks, bgMap, SCREEN_W, SCREEN_H));

    const lightBanks = pal_banks(rom, Versions.SLOT_PAYOUT_LIGHTS_PAL, 3);
    const lightsW = LIGHTS_TILES_W * 8, lightsH = LIGHTS_TILES_H * 8;
    const lightParts: string[] = [];
    for (let b = 0; b <= 2; b++) {
      const banks: PalBank[] = [];
      for (let i = 0; i <= 4; i++) banks[i] = bgBanks[i]!;
      banks[1] = lightBanks[b]!;
      lightParts.push(BgBake.bakeRegionRgba(bgGfx, banks, bgMap, lightsW, lightsH,
        { x0: LIGHTS_TILE_X * 8, y0: LIGHTS_TILE_Y * 8, alpha0: true }));
    }
    cache.write(root + "/payout_lights.rgba", lightParts.join(""));

    const matchBank = pal_banks(rom, Versions.SLOT_MATCH_LINES_PAL, 1)[0]!;
    const lineBanks: PalBank[] = [];
    for (let i = 0; i <= 4; i++) lineBanks[i] = bgBanks[i]!;
    lineBanks[4] = matchBank;
    cache.write(root + "/match_lines.rgba", BgBake.bakeRegionRgba(bgGfx, lineBanks, bgMap,
      LINES_TILES_W * 8, LINES_TILES_H * 8,
      { x0: LINES_TILE_X * 8, y0: LINES_TILE_Y * 8, alpha0: true }));

    const [buttonGfx] = Lz77.decompress(get, Versions.SLOT_BUTTON_PRESSED_GFX);
    cache.write(root + "/button_pressed.rgba", BgBake.bakeSpriteRgba(buttonGfx, bgBanks[0], 0, BUTTON_W, BUTTON_H, false, false));

    const [combosGfx] = Lz77.decompress(get, Versions.SLOT_COMBOS_WINDOW_GFX);
    const [combosMap] = Lz77.decompress(get, Versions.SLOT_COMBOS_WINDOW_TILEMAP);
    const combosBanks = pal_banks(rom, Versions.SLOT_COMBOS_WINDOW_PAL, 3);
    cache.write(root + "/combos_window.rgba", BgBake.bakeRegionRgba(combosGfx, combosBanks,
      combosMap, SCREEN_W, SCREEN_H, { bankOffset: 7, alpha0: true }));

    cache.write(root + "/payout_lights.pal", pal_bytes(lightBanks));
    cache.write(root + "/match_lines.pal", pal_bytes([matchBank]));

    const buttons: string[] = [];
    for (const xy of button_tile_xy(rom)) buttons.push(format("{ x = %d, y = %d }", xy[0] * 8, xy[1] * 8));

    const manifest = format(`return {
  format_version = %d,
  reel_icons = { width = %d, height = %d, frames = %d, frame_h = %d },
  clefairy = { width = %d, height = %d, frames = %d, frame_h = %d },
  digits = { width = %d, height = %d, frames = %d, frame_h = %d },
  bg = { width = %d, height = %d },
  combos_window = { width = %d, height = %d },
  payout_lights = { width = %d, height = %d, frames = %d, frame_h = %d, x = %d, y = %d },
  match_lines = { width = %d, height = %d, x = %d, y = %d },
  button_pressed = { width = %d, height = %d, at = { %s } },
}
`,
      SlotMachineExtract.FORMAT_VERSION,
      ICON_SIZE, ICON_SIZE * ICON_FRAMES, ICON_FRAMES, ICON_SIZE,
      CLEFAIRY_SIZE, CLEFAIRY_SIZE * CLEFAIRY_FRAMES, CLEFAIRY_FRAMES, CLEFAIRY_SIZE,
      DIGIT_W, DIGIT_H * DIGIT_FRAMES, DIGIT_FRAMES, DIGIT_H,
      SCREEN_W, SCREEN_H,
      SCREEN_W, SCREEN_H,
      lightsW, lightsH * 3, 3, lightsH, LIGHTS_TILE_X * 8, LIGHTS_TILE_Y * 8,
      LINES_TILES_W * 8, LINES_TILES_H * 8, LINES_TILE_X * 8, LINES_TILE_Y * 8,
      BUTTON_W, BUTTON_H, buttons.join(", "));
    cache.write(root + "/manifest.lua", manifest);

    console.log(format("[slot_machine_extract] %d reel icons, %d clefairy frames, %d digits, bg %dx%d -> %s",
      ICON_FRAMES, CLEFAIRY_FRAMES, DIGIT_FRAMES, SCREEN_W, SCREEN_H, root));
    return { root, icons: ICON_FRAMES, digits: DIGIT_FRAMES };
  },

  /**
   * Lua: slot_machine_extract.lua:185
   * NOT FAITHFUL: the Lua load()s manifest.lua in an empty environment and
   * reads format_version; here the format_version field is matched in the
   * text (the file is this module's own output).
   */
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + SlotMachineExtract.CACHE_SUB;
    if (!cache) return false;
    if (!cache.exists(root + "/manifest.lua")) return false;
    const body = cache.read(root + "/manifest.lua");
    if (typeof body !== "string") return false;
    const m = /^return \{\n\s*format_version = (\d+),/.exec(body);
    if (!m || Number(m[1]) !== SlotMachineExtract.FORMAT_VERSION) return false;
    const icons = cache.read(root + "/reel_icons.rgba");
    if (typeof icons !== "string" || icons.length !== ICON_SIZE * ICON_SIZE * 4 * ICON_FRAMES) return false;
    const bg = cache.read(root + "/bg.rgba");
    return typeof bg === "string" && bg.length === SCREEN_W * SCREEN_H * 4;
  },
};

export default SlotMachineExtract;
