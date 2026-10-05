// Port of gen1recomp src/import/gba/trade_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/trade_scene.c:151
// ROM byte runs are 0-based Uint8Arrays here (the Lua's 1-based tables);
// RGBA results are byte strings, as the Lua's.

import { Versions } from "./versions.ts";
import { BgBake, type Bytes, type PalBank } from "./bg_bake.ts";
import { format, fromBytes } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

const GBA_W = 240;
// src/trade_scene.c:1128
const GBA_CENTER_Y = 0x15C + 80;
// src/trade_scene.c:1465
const GBA_MIN_VOFS = 166;
const GBA_H = (GBA_CENTER_Y - GBA_MIN_VOFS) * 2;
const SCREEN_W = 240, SCREEN_H = 160;
const FLASH_W = 64, FLASH_H = 32;
const CABLE_END_W = 16, CABLE_END_H = 32;
const GLOW_SIZE = 32;
const SHADOW_W = 16, SHADOW_H = 32;
// src/trade_scene.c:1121 BGCNT_TXT512x256
const MON_SHADOW_BG_W = 256;
const BALL_SIZE = 16;
const BALL_FRAMES = 12;
// src/trade.c:1376
const MENU_TILES = 0x1280 / 32;
const STRIPES_W = 256;
// src/trade.c:2281
const BOX_COLS = 15, BOX_ROWS = 17;
// src/trade.c:2404
const MON_BOX_COLS = 6, MON_BOX_ROWS = 3;
// src/trade.c:236, :246
const CURSOR_W = 64, CURSOR_H = 32, CURSOR_FRAMES = 2;
const TILE_SHEET_COLS = 16;
const TILE_SHEET_ROWS = Math.ceil(MENU_TILES / TILE_SHEET_COLS);

// Lua: trade_extract.lua:38 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: trade_extract.lua:46
function raw_bytes(rom: Rom, off: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rom.get(off + i);
  return out;
}

// Lua: trade_extract.lua:52
function pal_banks(rom: Rom, off: number, count: number): PalBank[] {
  return BgBake.loadPalBanks(raw_bytes(rom, off, count * 32), count);
}

// Lua: trade_extract.lua:57 -- src/trade_scene.c:398, include/sprite.h:82
function anim_frame_tiles(rom: Rom, off: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= 63; i++) {
    const v = rom.u16(off + i * 4);
    // include/sprite.h:84-88
    if (v === 0xFFFF) break;
    if (v !== 0xFFFE && v !== 0xFFFD) out.push(v);
  }
  return out;
}

// Lua: trade_extract.lua:70
function bake_console(gfx: Bytes, banks: PalBank[], map: Bytes): string {
  return BgBake.bakeRegionRgba(gfx, banks, map, GBA_W, GBA_H,
    { x0: 0, y0: GBA_CENTER_Y - GBA_H / 2, bankOffset: 1, alpha0: true });
}

// Lua: trade_extract.lua:75 -- transparent pixels become the backdrop colour
function over_backdrop(rgba: string, color: number | undefined): string {
  const [r, g, b] = BgBake.bgr555ToRgb8(color ?? 0);
  const n = Math.floor(rgba.length / 4);
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (rgba.charCodeAt(o + 3) === 0) {
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    } else {
      for (let k = 0; k < 4; k++) out[o + k] = rgba.charCodeAt(o + k);
    }
  }
  for (let o = n * 4; o < rgba.length; o++) out[o] = rgba.charCodeAt(o);
  return fromBytes(out);
}

// Lua: trade_extract.lua:85 -- src/trade.c:1368 LoadTradeBgGfx
function bake_menu(rom: Rom, cache: Cache, root: string): void {
  const banks = pal_banks(rom, Versions.TRADE_MENU_PAL, 3);
  const gfx = raw_bytes(rom, Versions.TRADE_MENU_GFX, MENU_TILES * 32);

  const menuMap = raw_bytes(rom, Versions.TRADE_MENU_MAP, 32 * 32 * 2);
  cache.write(root + "/menu_bg1.rgba", BgBake.bakeRegionRgba(gfx, banks, menuMap, SCREEN_W, SCREEN_H, { alpha0: true }));

  const bg2Map = raw_bytes(rom, Versions.TRADE_STRIPES_BG2_MAP, 32 * 32 * 2);
  cache.write(root + "/stripes_bg2.rgba", BgBake.bakeRegionRgba(gfx, banks, bg2Map, STRIPES_W, SCREEN_H, { alpha0: true }));
  const bg3Map = raw_bytes(rom, Versions.TRADE_STRIPES_BG3_MAP, 32 * 32 * 2);
  cache.write(root + "/stripes_bg3.rgba", over_backdrop(
    BgBake.bakeRegionRgba(gfx, banks, bg3Map, STRIPES_W, SCREEN_H, { alpha0: true }),
    banks[0]![0]));

  const boxBytes = BOX_COLS * BOX_ROWS * 2;
  const partyMap = raw_bytes(rom, Versions.TRADE_PARTY_BOX_MAP, boxBytes);
  cache.write(root + "/party_box.rgba", BgBake.bakeRegionRgba(gfx, banks, partyMap,
    BOX_COLS * 8, BOX_ROWS * 8, { mapW: BOX_COLS, alpha0: true }));
  const movesMap = raw_bytes(rom, Versions.TRADE_MOVES_BOX_MAP, boxBytes);
  cache.write(root + "/moves_box.rgba", BgBake.bakeRegionRgba(gfx, banks, movesMap,
    BOX_COLS * 8, BOX_ROWS * 8, { mapW: BOX_COLS, alpha0: true }));

  const monBoxMap = raw_bytes(rom, Versions.TRADE_MENU_MON_BOX_MAP, MON_BOX_COLS * MON_BOX_ROWS * 2);
  cache.write(root + "/mon_box.rgba", BgBake.bakeRegionRgba(gfx, banks, monBoxMap,
    MON_BOX_COLS * 8, MON_BOX_ROWS * 8, { mapW: MON_BOX_COLS, alpha0: true }));

  const sheetMap = new Uint8Array(TILE_SHEET_COLS * TILE_SHEET_ROWS * 2);
  for (let i = 0; i < TILE_SHEET_COLS * TILE_SHEET_ROWS; i++) {
    const entry = i < MENU_TILES ? i : 0x3FF;
    sheetMap[i * 2] = entry % 256;
    sheetMap[i * 2 + 1] = Math.floor(entry / 256);
  }
  cache.write(root + "/menu_tiles.rgba", BgBake.bakeRegionRgba(gfx, banks, sheetMap,
    TILE_SHEET_COLS * 8, TILE_SHEET_ROWS * 8, { mapW: TILE_SHEET_COLS, alpha0: true }));

  const cursorBank = pal_banks(rom, Versions.TRADE_CURSOR_PAL, 1)[0];
  const cursorGfx = raw_bytes(rom, Versions.TRADE_CURSOR_GFX, 0x800);
  const frames: string[] = [];
  for (let f = 0; f < CURSOR_FRAMES; f++) {
    frames.push(BgBake.bakeSpriteRgba(cursorGfx, cursorBank, f * (CURSOR_W / 8) * (CURSOR_H / 8), CURSOR_W, CURSOR_H, false, false));
  }
  cache.write(root + "/cursor.rgba", frames.join(""));
}

export const TradeExtract = {
  CACHE_SUB: "trade",
  FORMAT_VERSION: 3,

  // Lua: trade_extract.lua:132
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): { root: string; width: number; height: number } {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + TradeExtract.CACHE_SUB;

    const gbaGfx = raw_bytes(rom, Versions.TRADE_GBA_GFX, 160 * 32);
    const gbaBanks = pal_banks(rom, Versions.TRADE_GBA_PAL2, 3);
    const cableMap = raw_bytes(rom, Versions.TRADE_GBA_MAP_CABLE, 32 * 64 * 2);
    const wirelessMap = raw_bytes(rom, Versions.TRADE_GBA_MAP_WIRELESS, 32 * 64 * 2);
    cache.write(root + "/gba_screen.rgba", bake_console(gbaGfx, gbaBanks, cableMap));
    cache.write(root + "/gba_screen_wireless.rgba", bake_console(gbaGfx, gbaBanks, wirelessMap));

    // src/trade_scene.c:1121
    const monShadowMap = raw_bytes(rom, Versions.TRADE_MON_SHADOW_MAP, 32 * 32 * 2);
    cache.write(root + "/mon_shadow_bg.rgba", BgBake.bakeRegionRgba(gbaGfx, gbaBanks,
      monShadowMap, MON_SHADOW_BG_W, SCREEN_H, { bankOffset: 1, alpha0: true }));

    const closeupMap = raw_bytes(rom, Versions.TRADE_CABLE_CLOSEUP_MAP, 32 * 32 * 2);
    cache.write(root + "/cable_closeup.rgba", BgBake.bakeRegionRgba(gbaGfx, gbaBanks,
      closeupMap, SCREEN_W, SCREEN_H, { bankOffset: 1, alpha0: true }));

    const objBank = pal_banks(rom, Versions.TRADE_GBA_PAL, 1)[0];
    const flashGfx = raw_bytes(rom, Versions.TRADE_GBA_SCREEN_GFX, 128 * 32);
    const flashFrameTiles = anim_frame_tiles(rom, Versions.TRADE_GBA_SCREEN_ANIM);
    // frames side by side: row r of the sheet is row r of every frame in order
    const flashRows: string[][] = [];
    for (let row = 0; row < FLASH_H; row++) flashRows[row] = [];
    flashFrameTiles.forEach((tile, i) => {
      const frame = BgBake.bakeSpriteRgba(flashGfx, objBank, tile, FLASH_W, FLASH_H, true, true);
      for (let row = 0; row < FLASH_H; row++) {
        flashRows[row]![i] = frame.slice(row * FLASH_W * 4, (row + 1) * FLASH_W * 4);
      }
    });
    const flashParts: string[] = [];
    for (let row = 0; row < FLASH_H; row++) flashParts.push(flashRows[row]!.join(""));
    cache.write(root + "/gba_screen_flash.rgba", flashParts.join(""));

    const cableEndGfx = raw_bytes(rom, Versions.TRADE_CABLE_END_GFX, 16 * 32);
    cache.write(root + "/cable_end.rgba", BgBake.bakeSpriteRgba(cableEndGfx, objBank, 0, CABLE_END_W, CABLE_END_H, false, false));

    const monBank = pal_banks(rom, Versions.TRADE_LINK_MON_PAL, 1)[0];
    const glowGfx = raw_bytes(rom, Versions.TRADE_LINK_MON_GLOW_GFX, 16 * 32);
    cache.write(root + "/link_mon_glow.rgba", BgBake.bakeSpriteRgba(glowGfx, monBank, 0, GLOW_SIZE, GLOW_SIZE, true, true));

    const shadowGfx = raw_bytes(rom, Versions.TRADE_LINK_MON_SHADOW_GFX, 16 * 32);
    cache.write(root + "/link_mon_shadow.rgba", BgBake.bakeSpriteRgba(shadowGfx, monBank, 0, SHADOW_W, SHADOW_H, true, true));
    cache.write(root + "/link_mon_shadow_small.rgba", BgBake.bakeSpriteRgba(shadowGfx, monBank, 8, SHADOW_W, SHADOW_H, true, true));

    const ballBank = pal_banks(rom, Versions.TRADE_POKEBALL_PAL, 1)[0];
    const ballGfx = raw_bytes(rom, Versions.TRADE_POKEBALL_GFX, 48 * 32);
    cache.write(root + "/ball.rgba", BgBake.bakeSpriteRgba(ballGfx, ballBank, 0, BALL_SIZE, BALL_SIZE, false, false));
    const spin: string[] = [];
    for (let f = 0; f < BALL_FRAMES; f++) spin.push(BgBake.bakeSpriteRgba(ballGfx, ballBank, f * 4, BALL_SIZE, BALL_SIZE, false, false));
    cache.write(root + "/ball_spin.rgba", spin.join(""));

    bake_menu(rom, cache, root);

    const manifest = format(`return {
  format_version = %d,
  gba_screen = { width = %d, height = %d, center_y = %d },
  gba_screen_wireless = { width = %d, height = %d, center_y = %d },
  cable_closeup = { width = %d, height = %d },
  gba_screen_flash = { width = %d, height = %d, frames = %d, frame_w = %d },
  cable_end = { width = %d, height = %d },
  link_mon_glow = { width = %d, height = %d },
  link_mon_shadow = { width = %d, height = %d },
  link_mon_shadow_small = { width = %d, height = %d },
  mon_shadow_bg = { width = %d, height = %d },
  ball ={ width = %d, height = %d },
  ball_spin = { width = %d, height = %d, frames = %d, frame_h = %d },
  menu_bg1 = { width = %d, height = %d },
  stripes_bg2 = { width = %d, height = %d },
  stripes_bg3 = { width = %d, height = %d },
  party_box = { width = %d, height = %d },
  moves_box = { width = %d, height = %d },
  mon_box = { width = %d, height = %d },
  menu_tiles = { width = %d, height = %d, tiles = %d, columns = %d,
    level_tens = %d, level_ones = %d, gender_none = %d, gender_male = %d,
    gender_female = %d, egg_symbol = %d, egg_symbol_hflip = true },
  cursor = { width = %d, height = %d, frames = %d, frame_h = %d },
}
`,
      TradeExtract.FORMAT_VERSION,
      GBA_W, GBA_H, GBA_CENTER_Y,
      GBA_W, GBA_H, GBA_CENTER_Y,
      SCREEN_W, SCREEN_H,
      FLASH_W * flashFrameTiles.length, FLASH_H, flashFrameTiles.length, FLASH_W,
      CABLE_END_W, CABLE_END_H,
      GLOW_SIZE, GLOW_SIZE,
      SHADOW_W, SHADOW_H,
      SHADOW_W, SHADOW_H,
      MON_SHADOW_BG_W, SCREEN_H,
      BALL_SIZE, BALL_SIZE,
      BALL_SIZE, BALL_SIZE * BALL_FRAMES, BALL_FRAMES, BALL_SIZE,
      SCREEN_W, SCREEN_H,
      STRIPES_W, SCREEN_H,
      STRIPES_W, SCREEN_H,
      BOX_COLS * 8, BOX_ROWS * 8,
      BOX_COLS * 8, BOX_ROWS * 8,
      MON_BOX_COLS * 8, MON_BOX_ROWS * 8,
      TILE_SHEET_COLS * 8, TILE_SHEET_ROWS * 8, MENU_TILES, TILE_SHEET_COLS,
      // src/trade.c:2415, :2427, :2445
      0x60, 0x70, 0x83, 0x84, 0x85, 0x80,
      CURSOR_W, CURSOR_H * CURSOR_FRAMES, CURSOR_FRAMES, CURSOR_H);
    cache.write(root + "/manifest.lua", manifest);

    console.log(format("[trade_extract] console %dx%d, %d flash frames, %d ball frames -> %s",
      GBA_W, GBA_H, flashFrameTiles.length, BALL_FRAMES, root));
    return { root, width: GBA_W, height: GBA_H };
  },

  /**
   * Lua: trade_extract.lua:253
   * NOT FAITHFUL: the Lua load()s manifest.lua in an empty environment and
   * reads format_version; here the format_version field is matched in the
   * text (the file is this module's own output).
   */
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + TradeExtract.CACHE_SUB;
    if (!cache) return false;
    const body = cache.exists(root + "/manifest.lua") ? cache.read(root + "/manifest.lua") : undefined;
    if (typeof body !== "string") return false;
    const m = /^return \{\n\s*format_version = (\d+),/.exec(body);
    if (!m || Number(m[1]) !== TradeExtract.FORMAT_VERSION) return false;
    const screen = cache.read(root + "/gba_screen.rgba");
    if (typeof screen !== "string" || screen.length !== GBA_W * GBA_H * 4) return false;
    const ball = cache.read(root + "/ball.rgba");
    if (typeof ball !== "string" || ball.length !== BALL_SIZE * BALL_SIZE * 4) return false;
    const menu = cache.exists(root + "/menu_bg1.rgba") ? cache.read(root + "/menu_bg1.rgba") : undefined;
    if (typeof menu !== "string" || menu.length !== SCREEN_W * SCREEN_H * 4) return false;
    const shadowBg = cache.exists(root + "/mon_shadow_bg.rgba") ? cache.read(root + "/mon_shadow_bg.rgba") : undefined;
    if (typeof shadowBg !== "string" || shadowBg.length !== MON_SHADOW_BG_W * SCREEN_H * 4) return false;
    const cursor = cache.exists(root + "/cursor.rgba") ? cache.read(root + "/cursor.rgba") : undefined;
    return typeof cursor === "string" && cursor.length === CURSOR_W * CURSOR_H * CURSOR_FRAMES * 4;
  },
};

export default TradeExtract;
