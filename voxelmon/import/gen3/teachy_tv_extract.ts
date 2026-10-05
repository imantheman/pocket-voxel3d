// Port of gen1recomp src/import/gba/teachy_tv_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/teachy_tv.c:526 TeachyTvLoadGraphic, src/graphics.c:1117
// LZ77 output and tilemaps are 0-based Uint8Arrays here (the Lua's 1-based
// tables); palette banks are keyed from 0 as the Lua keys them.

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { BgBake, type Bytes, type PalBank } from "./bg_bake.ts";
import { MapTree } from "./map_tree.ts";
import { MapCatalog } from "./map_catalog.ts";
import { Tileset } from "./tileset.ts";
import { Metatile } from "./metatile.ts";
import { NativePack } from "./native_pack.ts";
import { format, fromBytes } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

const W = 240, H = 160;

// src/teachy_tv.c:1026
const END_X = 20, END_Y = 10, END_W = 8, END_H = 2;

// src/teachy_tv.c:637 tilemapBuffer[32 * i + j] = ((Random() & 3) << 10) + 0x301F
const STATIC_TILE = 0x1F;
const STATIC_BANK = 3;
const STATIC_FRAMES = 4;

// src/teachy_tv.c:1218 TeachyTvLoadBg3Map, Route1_Layout blocks (6..14, 8..23)
const BG3_W = 256, BG3_H = 256;
const BG3_LAYOUT = 89; // include/constants/layouts.h:79 LAYOUT_ROUTE1
const BG3_COL0 = 8, BG3_ROW0 = 6;
const BG3_COLS = 16, BG3_ROWS = 9;

// Lua: teachy_tv_extract.lua:28 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: teachy_tv_extract.lua:36 -- the four flip variants of the static tile, side by side
function static_rgba(gfx: Bytes, banks: PalBank[]): string {
  const parts: string[] = [];
  for (let f = 0; f < STATIC_FRAMES; f++) {
    parts.push(BgBake.bakeSpriteRgba(gfx, banks[STATIC_BANK], STATIC_TILE, 8, 8, f % 2 === 1, Math.floor(f / 2) % 2 === 1));
  }
  const out: string[] = [];
  for (let y = 0; y <= 7; y++) {
    for (let f = 0; f < STATIC_FRAMES; f++) out.push(parts[f]!.slice(y * 8 * 4, (y + 1) * 8 * 4));
  }
  return out.join("");
}

// Lua: teachy_tv_extract.lua:52
function bg3_rgba(rom: Rom): string {
  const base = Versions.G_MAP_LAYOUTS;
  const layoutOff = rom.ptrOffset(rom.u32(base + (BG3_LAYOUT - 1) * 4));
  const layout = layoutOff !== undefined ? MapTree.parseLayout(rom, layoutOff) : undefined;
  const mapOff = layout ? rom.ptrOffset(layout.mapPtr) : undefined;
  if (mapOff === undefined) throw new Error("teachy_tv: no Route 1 layout at id " + BG3_LAYOUT);
  const pairName = MapCatalog.pairForLayout(rom, layout!);
  const [bundle, err] = Tileset.loadPair(rom, {}, pairName);
  if (!bundle) throw new Error(err ?? "assertion failed!");
  const rgb = NativePack.palsToRgb8(bundle.mapPals);

  const px = new Uint8Array(BG3_W * BG3_H * 4);
  for (let i = 0; i < BG3_ROWS; i++) {
    for (let j = 0; j < BG3_COLS; j++) {
      const cell = BG3_COL0 + (i + BG3_ROW0) * layout!.width + j;
      const mid = rom.u16(mapOff + cell * 2) % 1024;
      const idx = Metatile.compositeIndexed(bundle, mid);
      for (let y = 0; y <= 15; y++) {
        for (let x = 0; x <= 15; x++) {
          const v = idx[y * 16 + x] ?? 0;
          const ci = v % 16;
          if (ci !== 0) {
            const bank = rgb[Math.floor(v / 16) % 16] ?? rgb[0]!;
            const c = bank[ci]!;
            const o = ((i * 16 + y) * BG3_W + (j * 16 + x)) * 4;
            px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
          }
        }
      }
    }
  }
  return fromBytes(px);
}

// Lua: teachy_tv_extract.lua:98 -- src/bg.c:1151
function end_tilemap(rom: Rom): Uint8Array {
  const map = new Uint8Array(2048);
  for (let row = 0; row < END_H; row++) {
    for (let col = 0; col < END_W; col++) {
      // src/teachy_tv.c:869
      const entry = rom.u16(Versions.TEACHY_TV_END_TILES + (row * END_W + col) * 2);
      const mi = ((END_Y + row) * 32 + (END_X + col)) * 2;
      map[mi] = entry % 256;
      map[mi + 1] = Math.floor(entry / 256);
    }
  }
  return map;
}

export const TeachyTvExtract = {
  CACHE_SUB: "teachy_tv",
  MANIFEST_VERSION: 1,

  // Lua: teachy_tv_extract.lua:114
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): { root: string; width: number; height: number } {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + TeachyTvExtract.CACHE_SUB;
    const get = (i: number): number => rom.get(i);

    const [gfx] = Lz77.decompress(get, Versions.TEACHY_TV_GFX);
    const [screen] = Lz77.decompress(get, Versions.TEACHY_TV_SCREEN_TILEMAP);
    const [title] = Lz77.decompress(get, Versions.TEACHY_TV_TITLE_TILEMAP);
    const [pal] = Lz77.decompress(get, Versions.TEACHY_TV_PAL);
    const banks = BgBake.loadPalBanks(pal, 4);
    // src/teachy_tv.c:534 LoadPalette(&src, BG_PLTT_ID(0), sizeof(src)), src = RGB_BLACK
    if (banks[0]) banks[0][0] = 0;

    // src/teachy_tv.c:118 sBgTemplates, BG1 and BG2 sit over BG3 and the backdrop
    cache.write(root + "/screen.rgba", BgBake.bakeRegionRgba(gfx, banks, screen, W, H, { alpha0: true }));
    cache.write(root + "/title.rgba", BgBake.bakeRegionRgba(gfx, banks, title, W, H, { alpha0: true }));
    cache.write(root + "/end.rgba", BgBake.bakeRegionRgba(gfx, banks, end_tilemap(rom), W, H, { alpha0: true }));
    cache.write(root + "/static.rgba", static_rgba(gfx, banks));
    cache.write(root + "/bg3.rgba", bg3_rgba(rom));

    cache.write(root + "/manifest.lua", format(`return {
  format_version = %d,
  width = %d,
  height = %d,
  endRect = { x = %d, y = %d, w = %d, h = %d },
  tiles = %d,
  staticWidth = %d,
  staticHeight = %d,
  staticFrames = %d,
  bg3Width = %d,
  bg3Height = %d,
}
`, TeachyTvExtract.MANIFEST_VERSION, W, H,
    END_X * 8, END_Y * 8, END_W * 8, END_H * 8,
    Math.floor(BgBake.byteLen(gfx) / 32),
    STATIC_FRAMES * 8, 8, STATIC_FRAMES, BG3_W, BG3_H));

    console.log(format("[teachy_tv_extract] screen %dx%d, title, end plate %dx%d, static %dx8, bg3 %dx%d -> %s",
      W, H, END_W * 8, END_H * 8, STATIC_FRAMES * 8, BG3_W, BG3_H, root));
    return { root, width: W, height: H };
  },

  // Lua: teachy_tv_extract.lua:162
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + TeachyTvExtract.CACHE_SUB;
    if (!(cache && cache.exists)) return false;
    for (const rel of ["screen.rgba", "title.rgba", "end.rgba", "static.rgba", "bg3.rgba", "manifest.lua"]) {
      if (!cache.exists(root + "/" + rel)) return false;
    }
    return true;
  },
};

export default TeachyTvExtract;
