// Port of gen1recomp src/import/gba/region_map_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/region_map.c:393-427 -- the Town Map: region maps, frames, switch menu,
// sprites, layouts, section geometry and manifest under region_map/.
// Lua differences:
// - byte tables (LZ77 output, read_bytes, tile bytes, pixel buffers) are
//   0-based here (the Lua's are 1-based); every index is adjusted;
// - tables the Lua keys from 0 (palette banks and colours, grids, layouts)
//   are objects with integer keys, so serialize_lua sees the Lua's keys;
// - section_geometry's topLeft/dimensions are keyed MAPSEC_FIRST.. (88..196);
//   LuaJIT gives those tables an array part (#t == 196), so serialize_lua
//   prints them as sequences with leading nils. They are JS arrays with holes
//   here (index m - 1 holds key m), which luatable reads the same way.
// NOT FAITHFUL: ensureGenerated reads the run's bound cache (CacheFs) in
// place of src.core.game3.dataset's cache (not ported), and read_lua uses
// readLuaLiteral for the Lua's load().

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { serialize_lua } from "./extract_scripts.ts";
import { BattleAnimExtract } from "./battle_anim_extract.ts";
import { MapPreviewExtract } from "./map_preview_extract.ts";
import { MapSectionsExtract } from "./map_sections_extract.ts";
import { CacheFs, type Cache } from "./cache.ts";
import { readLuaLiteral } from "./asset_pack.ts";
import { Plans } from "./plans.ts";
import { tonumber, tostring, fromBytes } from "./lua.ts";
import { luaGet, luaLen } from "./luatable.ts";
import type { Rom } from "./rom.ts";

type Bytes = Uint8Array | number[];
/** A palette bank: colours keyed 0..15 (an object, as the Lua keys it). */
type Bank = Record<number, number>;
type Banks = Record<number, Bank>;
type Grid = Record<number, Record<number, number>>;

// Lua: region_map_extract.lua:40 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: region_map_extract.lua:48
function bgr555_to_rgb8(cIn: unknown): [number, number, number] {
  const c = (tonumber(cIn) ?? 0) % 32768;
  const r5 = c % 32;
  const g5 = Math.floor(c / 32) % 32;
  const b5 = Math.floor(c / 1024) % 32;
  return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
}

// Lua: region_map_extract.lua:91
function read_lua(cache: Cache, rel: string): any {
  const src = cache.read(rel);
  if (src === undefined) throw new Error(rel + " is not in the cache");
  return readLuaLiteral(src);
}

// Lua: region_map_extract.lua:106
function symbolic_grid(layer: any, sections: Record<number, { id: string }>): Record<number, Record<number, string>> {
  const grid: Record<number, Record<number, string>> = {};
  for (let y = 0; y <= RegionMapExtract.MAP_HEIGHT - 1; y++) {
    const row: Record<number, string> = {};
    for (let x = 0; x <= RegionMapExtract.MAP_WIDTH - 1; x++) {
      const mapsec = layer[y][x];
      if (mapsec !== RegionMapExtract.MAPSEC_NONE) {
        const sec = sections[mapsec];
        if (!sec) throw new Error("no map section " + tostring(mapsec));
        row[x] = sec.id;
      }
    }
    grid[y] = row;
  }
  return grid;
}

// Lua: region_map_extract.lua:140 -- tileBytes and out 0-based here
function decode_tile_4bpp(tileBytes: ArrayLike<number | undefined>, out: number[], baseX: number, baseY: number, stride: number, hflip: boolean, vflip: boolean): void {
  for (let row = 0; row <= 7; row++) {
    const srcRow = vflip ? 7 - row : row;
    for (let bx = 0; bx <= 3; bx++) {
      const byte = tileBytes[srcRow * 4 + bx] ?? 0;
      const p0 = byte % 16;
      const p1 = Math.floor(byte / 16) % 16;
      let x0 = bx * 2;
      let x1 = x0 + 1;
      if (hflip) { x0 = 7 - x0; x1 = 7 - x1; }
      out[(baseY + row) * stride + (baseX + x0)] = p0;
      out[(baseY + row) * stride + (baseX + x1)] = p1;
    }
  }
}

// Lua: region_map_extract.lua:156 -- bytes 0-based; banks and colours keyed from 0
function load_pal_banks(bytes: Bytes, count?: number): Banks {
  const banks: Banks = {};
  const n = count ?? Math.floor(bytes.length / 32);
  for (let b = 0; b <= n - 1; b++) {
    const colors: Bank = {};
    const off = b * 32;
    for (let c = 0; c <= 15; c++) {
      const i = off + c * 2;
      colors[c] = (bytes[i] ?? 0) + (bytes[i + 1] ?? 0) * 256;
    }
    banks[b] = colors;
  }
  return banks;
}

// Lua: region_map_extract.lua:171 / :214 -- one 16x16 (4 tiles) or 8x8 sprite -> [rgba, png, W, H]
function bake_sprite(gfx: Bytes, palBytes: Bytes, tiles: [number, number, number][], W: number, H: number): [string, string | undefined, number, number] {
  const pal: Bank = {};
  for (let c = 0; c <= 15; c++) {
    const i = c * 2;
    pal[c] = (palBytes[i] ?? 0) + (palBytes[i + 1] ?? 0) * 256;
  }
  const pixels: number[] = [];
  for (let i = 0; i < W * H; i++) pixels[i] = 0;
  for (const t of tiles) {
    const tileNum = t[0], ox = t[1], oy = t[2];
    const base = tileNum * 32;
    const tile: number[] = [];
    for (let i = 0; i < 32; i++) tile[i] = gfx[base + i] ?? 0;
    decode_tile_4bpp(tile, pixels, ox, oy, W, false, false);
  }
  const px: number[] = [];
  const chunks = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const idx = pixels[i] ?? 0;
    const o = i * 4;
    if (idx === 0) {
      px[o] = 0; px[o + 1] = 0; px[o + 2] = 0; px[o + 3] = 0;
    } else {
      const [r, g, b] = bgr555_to_rgb8(pal[idx] ?? 0);
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
    chunks[o] = px[o]!; chunks[o + 1] = px[o + 1]!; chunks[o + 2] = px[o + 2]!; chunks[o + 3] = px[o + 3]!;
  }
  const rgbaStr = fromBytes(chunks);
  const pngStr = BattleAnimExtract.encodePng ? BattleAnimExtract.encodePng(px, W, H) : undefined;
  return [rgbaStr, pngStr, W, H];
}

// Lua: region_map_extract.lua:171
function bake_sprite_16x16(gfx: Bytes, palBytes: Bytes, tileOffset?: number): [string, string | undefined, number, number] {
  tileOffset = tileOffset ?? 0;
  return bake_sprite(gfx, palBytes, [
    [tileOffset + 0, 0, 0],
    [tileOffset + 1, 8, 0],
    [tileOffset + 2, 0, 8],
    [tileOffset + 3, 8, 8],
  ], 16, 16);
}

// Lua: region_map_extract.lua:214
function bake_sprite_8x8(gfx: Bytes, palBytes: Bytes, tileOffset?: number): [string, string | undefined, number, number] {
  tileOffset = tileOffset ?? 0;
  return bake_sprite(gfx, palBytes, [[tileOffset, 0, 0]], 8, 8);
}

// Lua: region_map_extract.lua:248
function write_file(cache: Cache | undefined, path: string, bytes: string | undefined): boolean {
  if (!(bytes !== undefined && bytes.length > 0)) return false;
  if (cache && cache.write) {
    return cache.write(path, bytes);
  }
  // The Lua then tries CacheFs, love.filesystem and io.open; only CacheFs exists here.
  try {
    const [ok] = CacheFs.write(path, bytes);
    if (ok) return true;
  } catch { /* pcall */ }
  return false;
}

// Lua: region_map_extract.lua:272 (src/region_map.c:939)
function darken(c: number, tint: number): number {
  const r = c % 32, g = Math.floor(c / 32) % 32, b = Math.floor(c / 1024) % 32;
  const ch = (v: number): number => Math.floor(Math.floor(Math.floor((v * 256) / 100) * tint) / 256);
  return ch(r) + ch(g) * 32 + ch(b) * 1024;
}

// Lua: region_map_extract.lua:279 (src/region_map.c:959, :1108) -- [banks, raw]
function build_banks(mapPalBytes: Bytes, topBarBytes: Bytes): [Banks, Banks] {
  const banks = load_pal_banks(mapPalBytes, 5);
  const topBar = load_pal_banks(topBarBytes, 1)[0]!;
  banks[12] = topBar;
  // src/region_map.c:2572
  const raw = load_pal_banks(mapPalBytes, 5);
  raw[12] = topBar;
  const edge = banks[2]!, tinted: Bank = {};
  for (let c = 0; c <= 15; c++) tinted[c] = darken(edge[c]!, 95);
  tinted[15] = edge[15]!;
  banks[2] = tinted;
  return [banks, raw];
}

// Lua: region_map_extract.lua:293 -- px 0-based -> [rgba, png]
function encode(px: number[], W: number, H: number): [string, string] {
  const chunks = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H * 4; i++) chunks[i] = px[i]!;
  const png = BattleAnimExtract.encodePng(px, W, H);
  if (!png) throw new Error("assertion failed!");
  return [fromBytes(chunks), png];
}

// Lua: region_map_extract.lua:300
function bake_bg(gfx: Bytes, banks: Banks, map: Bytes, mapW: number, cols: number, rows: number): [string, string] {
  const W = cols * 8, H = rows * 8;
  const tileCount = Math.floor(gfx.length / 32);
  const px: number[] = [], tmp: number[] = [];
  for (let i = 0; i < W * H * 4; i++) px[i] = 0;
  for (let ty = 0; ty <= rows - 1; ty++) {
    for (let tx = 0; tx <= cols - 1; tx++) {
      const mi = (ty * mapW + tx) * 2;
      const lo = map[mi], hi = map[mi + 1];
      if (lo === undefined || hi === undefined) throw new Error("attempt to perform arithmetic on a nil value");
      const entry = lo + hi * 256;
      const tileId = entry % 1024;
      const bank = banks[Math.floor(entry / 4096) % 16];
      if (!bank) throw new Error("tilemap names a palette bank the ROM does not load");
      if (tileId < tileCount) {
        const tile: (number | undefined)[] = [];
        for (let i = 0; i < 32; i++) tile[i] = gfx[tileId * 32 + i];
        decode_tile_4bpp(tile, tmp, 0, 0, 8, Math.floor(entry / 1024) % 2 === 1, Math.floor(entry / 2048) % 2 === 1);
        for (let row = 0; row <= 7; row++) {
          for (let col = 0; col <= 7; col++) {
            const idx = tmp[row * 8 + col]!;
            if (idx !== 0) {
              const [r, g, b] = bgr555_to_rgb8(bank[idx]);
              const o = ((ty * 8 + row) * W + (tx * 8 + col)) * 4;
              px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
            }
          }
        }
      }
    }
  }
  return encode(px, W, H);
}

// Lua: region_map_extract.lua:331 -- a tilemap byte table (0-based here) from entries
// (the Lua also returns cols, which every caller drops)
function entries(list: number[]): number[] {
  const map: number[] = [];
  list.forEach((entry, i) => {
    map[i * 2] = entry % 256;
    map[i * 2 + 1] = Math.floor(entry / 256);
  });
  return map;
}

// Lua: region_map_extract.lua:340 -- [rgba, png, H]
function bake_strip(gfx: Bytes, palBytes: Bytes, widthPx: number): [string, string, number] {
  const pal = load_pal_banks(palBytes, 1)[0]!;
  const tilesPerRow = widthPx / 8;
  const tileCount = Math.floor(gfx.length / 32);
  const H = Math.ceil(tileCount / tilesPerRow) * 8;
  const pixels: number[] = [], px: number[] = [];
  for (let i = 0; i < widthPx * H; i++) pixels[i] = 0;
  for (let t = 0; t <= tileCount - 1; t++) {
    const tile: (number | undefined)[] = [];
    for (let i = 0; i < 32; i++) tile[i] = gfx[t * 32 + i];
    decode_tile_4bpp(tile, pixels, (t % tilesPerRow) * 8, Math.floor(t / tilesPerRow) * 8, widthPx, false, false);
  }
  for (let i = 0; i < widthPx * H; i++) {
    const idx = pixels[i]!;
    const o = i * 4;
    if (idx === 0) {
      px[o] = 0; px[o + 1] = 0; px[o + 2] = 0; px[o + 3] = 0;
    } else {
      const [r, g, b] = bgr555_to_rgb8(pal[idx]);
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
  }
  const [rgba, png] = encode(px, widthPx, H);
  return [rgba, png, H];
}

// Lua: region_map_extract.lua:366 -- layers/rows/cols keyed from 0
function u8_grid(rom: Rom, off: number, layers: number, rows: number, cols: number): Record<number, Grid> {
  const out: Record<number, Grid> = {};
  for (let l = 0; l <= layers - 1; l++) {
    const layer: Grid = {};
    for (let y = 0; y <= rows - 1; y++) {
      const row: Record<number, number> = {};
      for (let x = 0; x <= cols - 1; x++) row[x] = rom.get(off + (l * rows + y) * cols + x);
      layer[y] = row;
    }
    out[l] = layer;
  }
  return out;
}

let generatedLoaded = false;

export const RegionMapExtract = {
  CACHE_SUB: "region_map",
  FORMAT_VERSION: 3,

  FILES: [
    "kanto_map.png",
    "sevii123_map.png",
    "sevii45_map.png",
    "sevii67_map.png",
    "switch_button.png",
    "navel_rock_patch.png",
    "birth_island_patch.png",
    "frame_normal.png",
    "frame_normal_untinted.png",
    "frame_fly.png",
    "switch_menu_123.png",
    "switch_menu_all.png",
    "switch_cursor_left.png",
    "switch_cursor_right.png",
    "edge_top_left.png",
    "edge_top_right.png",
    "edge_mid_left.png",
    "edge_mid_right.png",
    "edge_bottom_left.png",
    "edge_bottom_right.png",
    "cursor.png",
    "fly_icon.png",
    "dungeon_icon.png",
    "dungeon_icon_visited.png",
    "player_red.png",
    "player_leaf.png",
    "layouts.lua",
    "section_geometry.lua",
    "manifest.lua",
  ],

  // src/region_map.c:3354-3369
  MAP_WIDTH: 22,
  MAP_HEIGHT: 15,
  MAPSEC_NONE: 197,
  REGIONS: ["kanto", "sevii123", "sevii45", "sevii67"],

  SECTION_NAMES: {} as Record<string, string>,
  DUNGEON_DESCRIPTIONS: {} as Record<string, string>,
  KANTO_GRID: {} as Record<number, Record<number, string>>,
  DUNGEON_GRID: {} as Record<number, Record<number, string>>,
  LAYOUTS: undefined as any,
  GEOMETRY: undefined as any,

  // Lua: region_map_extract.lua:73
  applyGeneratedText(names: Record<number, string>, dungeonInfo: any, sections: Record<number, { id: string }>): number {
    let updated = 0;
    for (const k of Object.keys(names)) {
      const info = sections[Number(k)];
      if (!info) throw new Error("no map section " + k);
      RegionMapExtract.SECTION_NAMES[info.id] = names[Number(k)]!;
      updated = updated + 1;
    }
    for (const k of Object.keys(dungeonInfo)) {
      const entry = dungeonInfo[k];
      const info = sections[Number(k)];
      if (info) {
        RegionMapExtract.SECTION_NAMES[info.id] = entry.name;
        RegionMapExtract.DUNGEON_DESCRIPTIONS[info.id] = entry.desc;
        updated = updated + 1;
      }
    }
    return updated;
  },

  // Lua: region_map_extract.lua:96
  loadLayouts(cache: Cache, cacheRoot?: string): any {
    const root = (cacheRoot ?? default_cache_root()) + "/" + RegionMapExtract.CACHE_SUB;
    return read_lua(cache, root + "/layouts.lua");
  },

  // Lua: region_map_extract.lua:101
  loadGeometry(cache: Cache, cacheRoot?: string): any {
    const root = (cacheRoot ?? default_cache_root()) + "/" + RegionMapExtract.CACHE_SUB;
    return read_lua(cache, root + "/section_geometry.lua");
  },

  // Lua: region_map_extract.lua:121 (NOT FAITHFUL: CacheFs.bound() for Dataset.cache())
  ensureGenerated(): boolean {
    if (generatedLoaded) return true;
    const cache = CacheFs.bound();
    const names = MapPreviewExtract.loadNames(cache);
    if (!names) throw new Error("region_map/names.lua is not in the cache");
    const dungeonInfo = MapPreviewExtract.loadDungeonInfo(cache);
    if (!dungeonInfo) throw new Error("region_map/dungeon_info.lua is not in the cache");
    const sections = MapSectionsExtract.SECTIONS;
    RegionMapExtract.applyGeneratedText(names, dungeonInfo, sections);
    RegionMapExtract.LAYOUTS = RegionMapExtract.loadLayouts(cache);
    RegionMapExtract.GEOMETRY = RegionMapExtract.loadGeometry(cache);
    const kanto = RegionMapExtract.LAYOUTS[0];
    RegionMapExtract.KANTO_GRID = symbolic_grid(kanto.map, sections);
    RegionMapExtract.DUNGEON_GRID = symbolic_grid(kanto.dungeon, sections);
    generatedLoaded = true;
    return true;
  },

  // Lua: region_map_extract.lua:380
  run(rom: Rom, cache: Cache | undefined, opts: { cacheRoot?: string } = {}): { ok: boolean; root: string } {
    const root = (opts.cacheRoot ?? default_cache_root()) + "/" + RegionMapExtract.CACHE_SUB;
    if (!rom) throw new Error("region map extract needs a ROM");

    const get = (i: number): number => rom.get(i);
    const read_bytes = (off: number, len: number): number[] => {
      const t: number[] = [];
      for (let i = 0; i < len; i++) t[i] = get(off + i);
      return t;
    };
    const lz = (off: number, what: string): Uint8Array => {
      const [buf] = Lz77.decompress(get, off);
      if (!buf) throw new Error(what + " did not decompress");
      return buf;
    };
    const put = (name: string, bytes: string | undefined): void => {
      if (!write_file(cache, root + "/" + name, bytes)) throw new Error("could not write region_map/" + name);
    };
    const put_image = (base: string, rgba: string, png: string | undefined): void => {
      put(base + ".rgba", rgba);
      put(base + ".png", png);
    };
    const map_width = (map: Bytes): number => {
      if (map.length >= 32 * 20 * 2) return 32;
      if (!(map.length >= 30 * 20 * 2)) throw new Error("region map tilemap is shorter than one screen");
      return 30;
    };

    const topBarBytes = read_bytes(Versions.REGION_MAP_TOP_BAR_PAL, 32);
    const [banks, rawBanks] = build_banks(read_bytes(Versions.REGION_MAP_BG_PAL, 160), topBarBytes);
    const mapGfx = lz(Versions.REGION_MAP_BG_GFX, "sRegionMap_Gfx");

    // src/region_map.c:1127-1147, :1505-1524
    const tilemaps: Record<string, number> = {
      kanto: Versions.REGION_MAP_KANTO_TILEMAP,
      sevii123: Versions.REGION_MAP_SEVII123_TILEMAP,
      sevii45: Versions.REGION_MAP_SEVII45_TILEMAP,
      sevii67: Versions.REGION_MAP_SEVII67_TILEMAP,
    };
    for (const name of RegionMapExtract.REGIONS) {
      const map = lz(tilemaps[name]!, name + " tilemap");
      put_image(name + "_map", ...bake_bg(mapGfx, banks, map, map_width(map), 30, 20));
    }
    {
      const list: number[] = [];
      for (let i = 0; i <= 2; i++) {
        for (let j = 0; j <= 2; j++) list.push((0xF0 + 16 * i + j) + 3 * 4096);
      }
      put_image("switch_button", ...bake_bg(mapGfx, banks, entries(list), 3, 3, 3));
      const navel: number[] = [], birth: number[] = [];
      for (let i = 0; i < 6; i++) navel[i] = 0x003;
      for (let i = 0; i < 9; i++) birth[i] = 0x003;
      put_image("navel_rock_patch", ...bake_bg(mapGfx, banks, entries(navel), 3, 3, 2));
      put_image("birth_island_patch", ...bake_bg(mapGfx, banks, entries(birth), 3, 3, 3));
    }

    // src/region_map.c:2281-2284, :2419-2431
    {
      const gfx = lz(Versions.REGION_MAP_EDGE_GFX, "sMapEdge_Gfx");
      const map = lz(Versions.REGION_MAP_EDGE_TILEMAP, "sMapEdge_Tilemap");
      const w = map_width(map);
      const bar = [0x002, 0x003];
      for (let k = 0; k < 26; k++) bar.push(0x03D);
      bar.push(0x03E);
      bar.push(0x03F);
      for (let x = 0; x <= 29; x++) {
        const entry = bar[x]! + 2 * 4096;
        const mi = (1 * w + x) * 2;
        map[mi] = entry % 256;
        map[mi + 1] = Math.floor(entry / 256);
      }
      put_image("frame_normal", ...bake_bg(gfx, banks, map, w, 30, 20));
      put_image("frame_normal_untinted", ...bake_bg(gfx, rawBanks, map, w, 30, 20));
    }
    {
      const gfx = lz(Versions.REGION_MAP_BG_SECONDARY_GFX, "sBackground_Gfx");
      const map = lz(Versions.REGION_MAP_BG_SECONDARY_TILEMAP, "sBackground_Tilemap");
      put_image("frame_fly", ...bake_bg(gfx, banks, map, map_width(map), 30, 20));
    }

    // src/region_map.c:1566-1581, :1740
    {
      const gfx = lz(Versions.REGION_MAP_SWITCH_MENU_GFX, "sSwitchMapMenu_Gfx");
      const m123 = lz(Versions.REGION_MAP_SWITCH_123_TILEMAP, "sSwitchMap_KantoSevii123_Tilemap");
      const mAll = lz(Versions.REGION_MAP_SWITCH_ALL_TILEMAP, "sSwitchMap_KantoSeviiAll_Tilemap");
      put_image("switch_menu_123", ...bake_bg(gfx, banks, m123, 30, 30, 20));
      put_image("switch_menu_all", ...bake_bg(gfx, banks, mAll, 30, 30, 20));
    }

    const sizes: Record<string, number[]> = {};
    const sprite = (name: string, off: number, palOff: number, width: number): void => {
      const [rgba, png, h] = bake_strip(lz(off, name), read_bytes(palOff, 32), width);
      put_image(name, rgba, png);
      sizes[name] = [width, h];
    };
    // src/region_map.c:747, :784, :1850-1881, :2195, :2257-2277
    sprite("cursor", Versions.REGION_MAP_CURSOR_GFX, Versions.REGION_MAP_CURSOR_PAL, 16);
    sprite("fly_icon", Versions.REGION_MAP_FLY_ICON_GFX, Versions.REGION_MAP_MISC_ICON_PAL, 16);
    sprite("switch_cursor_left", Versions.REGION_MAP_SWITCH_CURSOR_LEFT_GFX, Versions.REGION_MAP_SWITCH_CURSOR_PAL, 32);
    sprite("switch_cursor_right", Versions.REGION_MAP_SWITCH_CURSOR_RIGHT_GFX, Versions.REGION_MAP_SWITCH_CURSOR_PAL, 32);
    const edgeSprites: Record<string, number> = Versions.REGION_MAP_EDGE_SPRITES;
    for (const key of Object.keys(edgeSprites)) {
      sprite("edge_" + key, edgeSprites[key]!, Versions.REGION_MAP_EDGE_PAL, 32);
    }

    {
      const redGfx = lz(Versions.REGION_MAP_PLAYER_RED_GFX, "sPlayerIcon_Red");
      const [redRgba, redPng] = bake_sprite_16x16(redGfx, read_bytes(Versions.REGION_MAP_PLAYER_RED_PAL, 32), 0);
      put_image("player_red", redRgba, redPng);
      const leafGfx = lz(Versions.REGION_MAP_PLAYER_LEAF_GFX, "sPlayerIcon_Leaf");
      const [leafRgba, leafPng] = bake_sprite_16x16(leafGfx, read_bytes(Versions.REGION_MAP_PLAYER_LEAF_PAL, 32), 0);
      put_image("player_leaf", leafRgba, leafPng);
      const dungGfx = lz(Versions.REGION_MAP_DUNGEON_ICON_GFX, "sDungeonIcon");
      const miscPal = read_bytes(Versions.REGION_MAP_MISC_ICON_PAL, 32);
      // src/region_map.c:795 sAnim_DungeonIconNotVisited, :790 sAnim_DungeonIconVisited
      const [dRgba, dPng] = bake_sprite_8x8(dungGfx, miscPal, 0);
      put_image("dungeon_icon", dRgba, dPng);
      const [vRgba, vPng] = bake_sprite_8x8(dungGfx, miscPal, 1);
      put_image("dungeon_icon_visited", vRgba, vPng);
    }

    // src/region_map.c:527, :3158-3171, :3359
    const seviiMapsecs: Record<number, number[]> = {};
    const layouts: Record<string | number, unknown> = { seviiMapsecs };
    const layoutOffs = Versions.REGION_MAP_LAYOUTS;
    for (let i = 1; i <= luaLen(layoutOffs); i++) {
      const off = luaGet(layoutOffs, i) as number;
      const grid = u8_grid(rom, off, 2, RegionMapExtract.MAP_HEIGHT, RegionMapExtract.MAP_WIDTH);
      layouts[i - 1] = { name: RegionMapExtract.REGIONS[i - 1], map: grid[0], dungeon: grid[1] };
    }
    {
      const sevii = u8_grid(rom, Versions.REGION_MAP_SEVII_MAPSECS, 1, 3, 30)[0]!;
      for (let r = 0; r <= 2; r++) {
        const list: number[] = [];
        for (let i = 0; i <= 29; i++) {
          if (sevii[r]![i] === RegionMapExtract.MAPSEC_NONE) break;
          list.push(sevii[r]![i]!);
        }
        seviiMapsecs[r] = list;
      }
    }
    put("layouts.lua", "return " + serialize_lua(layouts) + "\n");
    // JS arrays with holes: index m - 1 is the Lua key m (see the header)
    const geometry: { topLeft: number[][]; dimensions: number[][] } = { topLeft: [], dimensions: [] };
    for (let i = 0; i <= Versions.MAPSEC_COUNT - 1; i++) {
      const m: number = Versions.MAPSEC_FIRST + i;
      geometry.topLeft[m - 1] = [rom.u16(Versions.REGION_MAP_SECTION_TOP_LEFT + i * 4),
        rom.u16(Versions.REGION_MAP_SECTION_TOP_LEFT + i * 4 + 2)];
      geometry.dimensions[m - 1] = [rom.u16(Versions.REGION_MAP_SECTION_DIMENSIONS + i * 4),
        rom.u16(Versions.REGION_MAP_SECTION_DIMENSIONS + i * 4 + 2)];
    }
    put("section_geometry.lua", "return " + serialize_lua(geometry) + "\n");

    const topBar = load_pal_banks(topBarBytes, 1)[0]!;
    put("manifest.lua", "return " + serialize_lua({
      version: RegionMapExtract.FORMAT_VERSION,
      width: 240,
      height: 160,
      backdrop: topBar[15],
      topBarPal: topBar,
      sprites: sizes,
      playerIconSize: 16,
      dungeonIconSize: 8,
    }) + "\n");

    return { ok: true, root };
  },

  // Lua: region_map_extract.lua:568
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + RegionMapExtract.CACHE_SUB;
    for (const name of RegionMapExtract.FILES) {
      if (!baked(cache, root + "/" + name)) return false;
    }
    return true;
  },

  // Lua: region_map_extract.lua:576
  extract(rom: Rom, opts?: { cache?: Cache; cacheRoot?: string }): { ok: boolean; root: string } {
    return RegionMapExtract.run(rom, opts && opts.cache, opts);
  },
};

// Lua: region_map_extract.lua:540
function baked(cache: Cache | undefined, rel: string): boolean {
  if (cache) {
    if (cache.read) {
      const d = cache.read(rel);
      return d !== undefined && d.length > 8;
    } else if (cache.exists) {
      return cache.exists(rel) ? true : false;
    }
    return false;
  }
  // The Lua then tries CacheFs.readActive, love.filesystem and io.open; only CacheFs exists here.
  try {
    const d = CacheFs.readActive(rel);
    if (d !== undefined && d.length > 8) return true;
  } catch { /* pcall(require) / no bound cache */ }
  return false;
}

Plans.register("region_map_extract", RegionMapExtract as unknown as Record<string, unknown>);

export default RegionMapExtract;
