// Port of gen1recomp src/import/gba/map_preview_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Bake FRLG location preview screens and region-map text from ROM.
// Source: pret/pokefirered src/map_preview_screen.c (sMapPreviewScreenData) and
// src/region_map.c (sMapsecName_*, sDungeonInfo).
//
// Output:
//   <root>/map_preview/manifest.lua      entry table + mapsec -> artwork map
//   <root>/map_preview/<mapsec>.rgba     240x160 RGBA artwork (deduplicated)
//   <root>/region_map/names.lua          mapsec 88..196 display names
//   <root>/region_map/dungeon_info.lua   sDungeonInfo name + flavour text
//
// Lua's load() of its own cache files is readLuaLiteral (asset_pack.ts):
// NOT FAITHFUL there, see that file.

import { Lz77 } from "./lz77.ts";
import { BgBake, type PalBank } from "./bg_bake.ts";
import { RegionMapTables, type DungeonInfo } from "./region_map_tables.ts";
import { readLuaLiteral } from "./asset_pack.ts";
import { Plans } from "./plans.ts";
import { format, tostring } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

type Rgb = number[];
export interface PreviewPlanEntry { mapsec: number; name: string; type: number; flagId: number; artwork: number }
export interface PreviewPlan {
  entries: PreviewPlanEntry[];
  byMapsec: Record<number, number>;
  files: Record<string, string>;
  artworkCount: number;
  nameWindow?: { fill: Rgb; bg: Rgb; fg: Rgb; shadow: Rgb };
  names: Record<number, string>;
  nameCount: number;
  namesVerified: boolean;
  dungeonInfo: DungeonInfo[];
}

const TILEMAP_WIDTH = 32;
const TILEMAP_HEIGHT = 20;
const TILEMAP_BYTES = TILEMAP_WIDTH * TILEMAP_HEIGHT * 2; // CopyToBgTilemapBufferRect(2, tilemap, 0, 0, 32, 20)

// Lua: map_preview_extract.lua:41 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: map_preview_extract.lua:49
function luaStr(sIn: unknown): string {
  const s = tostring(sIn ?? "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
  return '"' + s + '"';
}

// Lua: map_preview_extract.lua:55 -- raw bytes (0-based)
function readBgr555(get: (i: number) => number, offset: number, count: number): Uint8Array {
  const out = new Uint8Array(count * 2);
  for (let i = 1; i <= count * 2; i++) out[i - 1] = get(offset + i - 1);
  return out;
}

// Lua: map_preview_extract.lua:63
function countKeys(t: object): number {
  return Object.keys(t).length;
}

// Lua: map_preview_extract.lua:150
function formatRgb(c: Rgb): string {
  return format("{ %d, %d, %d }", c[0] ?? 0, c[1] ?? 0, c[2] ?? 0);
}

// Lua: map_preview_extract.lua:154
function formatManifest(plan: PreviewPlan): string {
  const nw: Partial<NonNullable<PreviewPlan["nameWindow"]>> = plan.nameWindow ?? {};
  const lines = [
    "-- Generated location preview screen data (sMapPreviewScreenData).",
    "-- Sourced from pret/pokefirered src/map_preview_screen.c.",
    "return {",
    "  format_version = " + MapPreviewExtract.FORMAT_VERSION + ",",
    "  width = " + MapPreviewExtract.WIDTH + ",",
    "  height = " + MapPreviewExtract.HEIGHT + ",",
    "  type_cave = " + MapPreviewExtract.TYPE_CAVE + ",",
    "  type_forest = " + MapPreviewExtract.TYPE_FOREST + ",",
    "  artwork_count = " + tostring(plan.artworkCount) + ",",
    "  entry_count = " + tostring(plan.entries.length) + ",",
    "  -- src/map_preview_screen.c:456",
    "  name_window = {",
    "    fill = " + formatRgb(nw.fill ?? []) + ",",
    "    fg = " + formatRgb(nw.fg ?? []) + ",",
    "    shadow = " + formatRgb(nw.shadow ?? []) + ",",
    "    bg = " + formatRgb(nw.bg ?? []) + ",",
    "  },",
    "  entries = {",
  ];
  for (const e of plan.entries) {
    lines.push(format("    { mapsec = %d, name = %s, type = %d, flagId = %d, artwork = %d },",
      e.mapsec, luaStr(e.name), e.type, e.flagId, e.artwork));
  }
  lines.push("  },");
  lines.push("  by_mapsec = {");
  const secs = Object.keys(plan.byMapsec).map(Number).sort((a, b) => a - b);
  for (const sec of secs) lines.push(format("    [%d] = %d,", sec, plan.byMapsec[sec]));
  lines.push("  },");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: map_preview_extract.lua:194
function formatNames(plan: PreviewPlan): string {
  const lines = [
    "-- Generated region map section names (sMapsecName_*).",
    "-- Sourced from pret/pokefirered src/region_map.c.",
    "return {",
    "  first = 88,",
    "  last = 196,",
    "  names = {",
  ];
  const secs = Object.keys(plan.names).map(Number).sort((a, b) => a - b);
  for (const sec of secs) lines.push(format("    [%d] = %s,", sec, luaStr(plan.names[sec])));
  lines.push("  },");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: map_preview_extract.lua:215
function formatDungeonInfo(plan: PreviewPlan): string {
  const lines = [
    "-- Generated dungeon map GUIDE text (sDungeonInfo).",
    "-- Sourced from pret/pokefirered src/region_map.c. Missing mapsecs show",
    '-- "No data" in-game, matching GetDungeonName/GetDungeonFlavorText.',
    "return {",
  ];
  for (const e of plan.dungeonInfo) {
    lines.push(format("  [%d] = { name = %s, desc = %s },", e.mapsec, luaStr(e.name), luaStr(e.desc)));
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: map_preview_extract.lua:236 -- a generated Lua cache file, or undefined when absent or invalid
function readLua(cache: Cache | undefined, rel: string): any {
  const src = cache && cache.read ? cache.read(rel) : undefined;
  if (src === undefined) return undefined;
  try {
    return readLuaLiteral(src);
  } catch {
    return undefined;
  }
}

export const MapPreviewExtract = {
  CACHE_SUB: "map_preview",
  REGION_MAP_SUB: "region_map",
  FORMAT_VERSION: 3,
  WIDTH: 240,
  HEIGHT: 160,

  // sMapPreviewScreenData palettes are 0x40 bytes = 32 BGR555 colours, loaded at
  // BG palette bank 13 (map_preview_screen.c: MapPreview_LoadGfx). Across the
  // visible tilemap columns 0-29 the 28 entries reference only banks 13 and 14;
  // the sole bank-0 references sit in the off-screen padding columns 30-31, so
  // bank 0 never reaches the screen (it is still mapped to bank 13's ramp so the
  // baked image is total).
  PALETTE_COLORS: 32,
  PALETTE_BANK_LO: 13,
  PALETTE_BANK_HI: 14,
  PALETTE_BANKS: 2,

  TYPE_CAVE: 0,
  TYPE_FOREST: 1,

  formatManifest,
  formatNames,
  formatDungeonInfo,

  /**
   * Lua: map_preview_extract.lua:71 -- decode every preview artwork plus the
   * region-map text tables. [plan] or [undefined, err]; no cache writes.
   */
  build(rom: Rom): [PreviewPlan | undefined, string?] {
    const [tables, err] = RegionMapTables.load(rom);
    if (!tables) return [undefined, err ?? RegionMapTables.NOT_FOUND];

    const get = (i: number): number => rom.get(i);

    const entries: PreviewPlanEntry[] = [];
    const byMapsec: Record<number, number> = {};
    const files: Record<string, string> = {};
    const canonicalByKey: Record<string, number> = {};
    let artworkCount = 0;
    let nameWindow: PreviewPlan["nameWindow"];

    for (let i = 1; i <= tables.previews.length; i++) {
      const e = tables.previews[i - 1]!;
      const key = format("%d:%d:%d", e.tilesOffset, e.tilemapOffset, e.paletteOffset);
      let artworkSec = canonicalByKey[key];
      if (artworkSec === undefined) {
        artworkSec = e.mapsec;
        canonicalByKey[key] = artworkSec;
        artworkCount++;

        const [gfx] = Lz77.decompress(get, e.tilesOffset);
        const [map] = Lz77.decompress(get, e.tilemapOffset);
        if (gfx.length === 0 || gfx.length % 32 !== 0) {
          return [undefined, format("map preview 0x%X: bad tile data (%d bytes)", e.mapsec, gfx.length)];
        }
        if (map.length !== TILEMAP_BYTES) {
          return [undefined, format("map preview 0x%X: bad tilemap (%d bytes, expected %d)", e.mapsec, map.length, TILEMAP_BYTES)];
        }

        const ramp = BgBake.loadPalBanks(
          readBgr555(get, e.paletteOffset, MapPreviewExtract.PALETTE_COLORS),
          MapPreviewExtract.PALETTE_BANKS);
        const palBanks: PalBank[] = [];
        palBanks[0] = ramp[0]!;
        palBanks[MapPreviewExtract.PALETTE_BANK_LO] = ramp[0]!;
        palBanks[MapPreviewExtract.PALETTE_BANK_HI] = ramp[1]!;
        files[artworkSec + ".rgba"] = BgBake.bakeBgRgba(gfx, palBanks, map, MapPreviewExtract.WIDTH, MapPreviewExtract.HEIGHT);

        // src/map_preview_screen.c:456
        // src/menu2.c:469
        if (!nameWindow) {
          nameWindow = {
            fill: BgBake.bgr555ToRgb8(ramp[1]![1]!),
            bg: BgBake.bgr555ToRgb8(ramp[1]![1]!),
            fg: BgBake.bgr555ToRgb8(ramp[1]![4]!),
            shadow: BgBake.bgr555ToRgb8(ramp[1]![3]!),
          };
        }
      }

      entries[i - 1] = {
        mapsec: e.mapsec,
        name: tables.names[e.mapsec] ?? "",
        type: e.type,
        flagId: e.flagId,
        artwork: artworkSec,
      };
      byMapsec[e.mapsec] = i;
    }

    return [{
      entries,
      byMapsec,
      files,
      artworkCount,
      nameWindow,
      names: tables.names,
      nameCount: countKeys(tables.names),
      namesVerified: tables.namesVerified,
      dungeonInfo: tables.dungeonInfo,
    }];
  },

  // Lua: map_preview_extract.lua:246
  loadManifest(cache: Cache | undefined, cacheRoot?: string): any {
    const root = cacheRoot ?? default_cache_root();
    return readLua(cache, root + "/" + MapPreviewExtract.CACHE_SUB + "/manifest.lua");
  },

  // Lua: map_preview_extract.lua:251
  loadNames(cache: Cache | undefined, cacheRoot?: string): Record<number, string> | undefined {
    const root = cacheRoot ?? default_cache_root();
    const data = readLua(cache, root + "/" + MapPreviewExtract.REGION_MAP_SUB + "/names.lua");
    return data ? data.names : undefined;
  },

  // Lua: map_preview_extract.lua:257
  loadDungeonInfo(cache: Cache | undefined, cacheRoot?: string): any {
    const root = cacheRoot ?? default_cache_root();
    return readLua(cache, root + "/" + MapPreviewExtract.REGION_MAP_SUB + "/dungeon_info.lua");
  },

  // Lua: map_preview_extract.lua:262
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    if (!(cache && cache.exists)) return false;
    const root = cacheRoot ?? default_cache_root();
    if (!cache.exists(root + "/" + MapPreviewExtract.CACHE_SUB + "/manifest.lua")) return false;
    if (!cache.exists(root + "/" + MapPreviewExtract.REGION_MAP_SUB + "/names.lua")) return false;
    if (!cache.exists(root + "/" + MapPreviewExtract.REGION_MAP_SUB + "/dungeon_info.lua")) return false;
    const manifest = MapPreviewExtract.loadManifest(cache, root);
    const first = manifest && manifest.entries && manifest.entries[0];
    if (!first) return false;
    return cache.exists(root + "/" + MapPreviewExtract.CACHE_SUB + "/" + tostring(first.artwork) + ".rgba");
  },

  // Lua: map_preview_extract.lua:281 -- [ok, detail]
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string; force?: boolean } = {}): [boolean, any] {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const previewRoot = cacheRoot + "/" + MapPreviewExtract.CACHE_SUB;
    const textRoot = cacheRoot + "/" + MapPreviewExtract.REGION_MAP_SUB;

    if (!opts.force && MapPreviewExtract.ready(cache, cacheRoot)) return [true, { skipped: true }];

    const [plan, err] = MapPreviewExtract.build(rom);
    if (!plan) return [false, err];

    cache.write(previewRoot + "/manifest.lua", formatManifest(plan));
    let written = 0;
    for (const name of Object.keys(plan.files)) {
      cache.write(previewRoot + "/" + name, plan.files[name]!);
      written++;
    }
    cache.write(textRoot + "/names.lua", formatNames(plan));
    cache.write(textRoot + "/dungeon_info.lua", formatDungeonInfo(plan));

    console.log(format("[map_preview_extract] %d preview artworks (%d entries) + %d mapsec names "
      + "+ %d dungeon entries -> %s",
      written, plan.entries.length, plan.nameCount, plan.dungeonInfo.length, previewRoot));

    return [true, {
      artworks: written,
      entries: plan.entries.length,
      names: plan.nameCount,
      dungeonInfo: plan.dungeonInfo.length,
      namesVerified: plan.namesVerified,
    }];
  },
};

Plans.register("map_preview_extract", MapPreviewExtract as unknown as Record<string, unknown>);

export default MapPreviewExtract;
