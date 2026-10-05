// Port of gen1recomp src/import/gba/pokedex_chrome_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Pokedex Chrome & Data Extractor from FRLG ROM.
// 100% pure ROM reader: 0 external pret / python dependencies.
// Extracts:
// 1. Full species Dex entries from gPokedexEntries (Category, Height, Weight, flavor text, scales/offsets).
// 2. 9 Habitat category pages from gDexCategories (Grassland, Forest, Waters-edge, Sea, Cave, Mountain, Rough-terrain, Urban, Rare).
// 3. 6 Sorting Orders from gPokedexOrder_* and sSpeciesTo* tables (Numerical Kanto/National, A-Z, Type, Weight, Height).
// Byte tables (LZ77 output, raw tiles) are 0-based here (the Lua's 1-based);
// palettes keyed from 0 as the Lua keys them; images are byte strings.
// Versions sequences (POKEDEX_CHROME_GFX, ...) keep the Lua's 1-based keys.

import { Versions } from "./versions.ts";
import { TextIR } from "../../game/gen3/core/scripting/text_ir.ts";
import { Lz77 } from "./lz77.ts";
import { Layouts } from "./layouts.ts";
import { Constants } from "../../game/gen3/core/constants.ts";
import { MapSectionsExtract } from "./map_sections_extract.ts";
import { CacheFs, type Cache } from "./cache.ts";
import { format, fromBytes, tostring } from "./lua.ts";
import { luaGet } from "./luatable.ts";
import type { Rom } from "./rom.ts";

type Bytes = ArrayLike<number>;
type Pal = Record<number, number>;

/** ipairs over a Versions sequence (integer-keyed object or array). */
function ipairs<T = any>(t: unknown): T[] {
  if (t === undefined || t === null || typeof t !== "object") return [];
  const out: T[] = [];
  for (let i = 1; ; i++) {
    const v = luaGet(t as object, i);
    if (v === undefined || v === null) break;
    out.push(v as T);
  }
  return out;
}

const charmapAt = (b: number): string | undefined =>
  Object.prototype.hasOwnProperty.call(TextIR.CHARMAP, b) ? TextIR.CHARMAP[b] : undefined;

// Lua: pokedex_chrome_extract.lua:40 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: pokedex_chrome_extract.lua:48
function get_byte(rom: Rom, off: number): number {
  return rom.get(off);
}

// Lua: pokedex_chrome_extract.lua:54
function get_u16(rom: Rom, off: number): number {
  return rom.u16(off);
}

// Lua: pokedex_chrome_extract.lua:59
function get_s16(rom: Rom, off: number): number {
  const v = get_u16(rom, off);
  return v >= 32768 ? v - 65536 : v;
}

// Lua: pokedex_chrome_extract.lua:65
function get_u32(rom: Rom, off: number): number {
  return rom.u32(off);
}

// Lua: pokedex_chrome_extract.lua:73
function decode_category(rom: Rom, off: number, maxLen = 12): string {
  let out = "";
  for (let i = 0; i <= maxLen - 1; i++) {
    const b = get_byte(rom, off + i);
    if (b === 0xff) break;
    const ch = charmapAt(b);
    if (ch !== undefined) out += ch;
    else if (b >= 0xbb && b <= 0xd4) out += String.fromCharCode(65 + (b - 0xbb));
    else if (b >= 0xd5 && b <= 0xee) out += String.fromCharCode(97 + (b - 0xd5));
  }
  return out;
}

// Lua: pokedex_chrome_extract.lua:90
function decode_text(rom: Rom, gbaPtr: number | undefined, maxLen = 256): string {
  if (gbaPtr === undefined || gbaPtr < 0x08000000 || gbaPtr >= 0x0a000000) return "";
  const off = gbaPtr - 0x08000000;
  let out = "";
  for (let i = 0; i <= maxLen - 1; i++) {
    const b = get_byte(rom, off + i);
    if (b === 0xff) break;
    const ch = charmapAt(b);
    if (b === 0xfe || b === 0xfa || b === 0xfb) out += "\n";
    else if (ch !== undefined) out += ch;
    else if (b >= 0xbb && b <= 0xd4) out += String.fromCharCode(65 + (b - 0xbb));
    else if (b >= 0xd5 && b <= 0xee) out += String.fromCharCode(97 + (b - 0xd5));
  }
  return out;
}

// Lua: pokedex_chrome_extract.lua:111
function escape_lua(s: unknown): string {
  return tostring(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Lua: pokedex_chrome_extract.lua:115
 * NOT FAITHFUL: the Lua also writes every file straight to disk with io.open
 * (relative to the working directory) after the cache write; only the cache
 * write is ported.
 */
function write_file(cache: Cache | undefined, relPath: string, content: string): void {
  let wrote = false;
  if (cache && cache.write) {
    cache.write(relPath, content);
    wrote = true;
  }
  if (!wrote) {
    try { CacheFs.write(relPath, content); } catch { /* pcall */ }
  }
}

// Lua: pokedex_chrome_extract.lua:540
function gba_rgb(cIn: number | undefined): [number, number, number] {
  const c = (cIn ?? 0) % 32768;
  return [
    Math.floor(((c % 32) * 255) / 31 + 0.5),
    Math.floor(((Math.floor(c / 32) % 32) * 255) / 31 + 0.5),
    Math.floor(((Math.floor(c / 1024) % 32) * 255) / 31 + 0.5),
  ];
}

// Lua: pokedex_chrome_extract.lua:547
function read_palette(rom: Rom, off: number): Pal {
  const pal: Pal = {};
  for (let i = 0; i <= 15; i++) pal[i] = get_u16(rom, off + i * 2);
  return pal;
}

// Lua: pokedex_chrome_extract.lua:553
function raw_tiles(rom: Rom, off: number, byteCount: number): Uint8Array {
  const out = new Uint8Array(byteCount);
  for (let i = 1; i <= byteCount; i++) out[i - 1] = get_byte(rom, off + i - 1);
  return out;
}

// Lua: pokedex_chrome_extract.lua:559
function tile_source(rom: Rom, src: { lz?: boolean; gfx: number; w: number; h: number }): Uint8Array {
  if (src.lz) return Lz77.decompress((i) => get_byte(rom, i), src.gfx)[0];
  return raw_tiles(rom, src.gfx, Math.floor((src.w * src.h) / 2));
}

// Lua: pokedex_chrome_extract.lua:662
function read_palette_block(rom: Rom, off: number, count: number): Pal {
  const pal: Pal = {};
  for (let i = 0; i <= count - 1; i++) pal[i] = get_u16(rom, off + i * 2);
  return pal;
}

// Lua: pokedex_chrome_extract.lua:668 -- 4-byte RGBA strings, keys 0..15
function palette_colors(pal: Pal | undefined, base: number): string[] {
  const out: string[] = [];
  for (let i = 0; i <= 15; i++) {
    const [r, g, b] = gba_rgb(pal ? pal[base + i] : undefined);
    out[i] = String.fromCharCode(r, g, b, 255);
  }
  return out;
}

// Lua: pokedex_chrome_extract.lua:755
function footprint_name_keys(rom: Rom): Record<number, string> {
  const base = Versions.SPECIES_NAMES;
  const stride: number = Versions.SPECIES_NAME_LENGTH ?? 11;
  const count: number = Versions.NUM_SPECIES ?? 412;
  if (base === undefined) return {};
  const lowered: Record<number, string> = {}, seen: Record<string, number> = {};
  const lower = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  const strip = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, "");
  for (let sp = 0; sp <= count - 1; sp++) {
    const name = decode_category(rom, base + sp * stride, stride - 1);
    if (name !== "" && !/^\?+$/.test(name) && !/[/\\]/.test(name)) {
      const low = lower(name);
      lowered[sp] = low;
      const stripped = strip(low);
      seen[stripped] = (seen[stripped] ?? 0) + 1;
    }
  }
  const keys: Record<number, string> = {};
  for (const k of Object.keys(lowered)) {
    const sp = Number(k), low = lowered[sp]!;
    const stripped = strip(low);
    if (stripped !== "" && seen[stripped] === 1) keys[sp] = stripped;
    else keys[sp] = low;
  }
  return keys;
}

// Lua: pokedex_chrome_extract.lua:782
function footprint_bytes(rom: Rom, off: number): string {
  let out = "";
  for (let i = 1; i <= PokedexChromeExtract.FOOTPRINT_BYTES; i++) out += String.fromCharCode(get_byte(rom, off + i - 1));
  return out;
}

export const PokedexChromeExtract = {
  CACHE_SUB: "pokemon/pokedex",
  FORMAT_VERSION: 5,
  TILE_SHEET_COLS: 8,
  TILE_SHEETS: {
    kanto: "dex_tiles_kanto.rgba",
    national: "dex_tiles_national.rgba",
  } as Record<string, string>,
  CHROME_FILE: "chrome.lua",
  PAPER_BG_FILE: "paper_bg.rgba",
  PAPER_BG_W: 240,
  PAPER_BG_H: 160,
  // src/pokedex_screen.c:930
  PAPER_TILE: 0x001,
  // src/pokedex_screen.c:933
  PAPER_BAR_PAL: 15,
  PAPER_BAR_COLOR: 15,
  PAPER_BAR_ROWS: 2,
  FOOTPRINT_TABLE: 0x43fab0,
  FOOTPRINT_SUB: "footprints",
  FOOTPRINT_BYTES: 32,
  FOOTPRINT_W: 16,
  FOOTPRINT_H: 16,
  // src/data/pokemon_graphics/footprint_table.h:255
  FOOTPRINT_QUESTION_MARK_SPECIES: 252,
  FOOTPRINT_QUESTION_MARK_FILE: "question_mark.rgba",

  // Lua: pokedex_chrome_extract.lua:139 -- entries.lua from the ROM's gPokedexEntries table
  extractEntries(rom: Rom, cache: Cache | undefined, root: string): boolean {
    const L = Layouts.active();
    const E = L.pokedexEntry;
    const entriesBase = Versions.POKEDEX_ENTRIES;
    if (entriesBase === undefined) throw new Error("pokedex entries: no POKEDEX_ENTRIES key");
    const spToNatBase = Versions.SPECIES_TO_NATIONAL;
    if (spToNatBase === undefined) throw new Error("pokedex entries: no SPECIES_TO_NATIONAL key");
    const numSpecies: number = Versions.NUM_SPECIES;
    if (numSpecies === undefined) throw new Error("pokedex entries: no NUM_SPECIES key");
    const natDexCount: number = Versions.NATIONAL_DEX_COUNT;
    if (natDexCount === undefined) throw new Error("pokedex entries: no NATIONAL_DEX_COUNT key");

    const natToSpecies: Record<number, number> = {};
    for (let sp = 1; sp <= numSpecies - 1; sp++) {
      const nat = get_u16(rom, spToNatBase + (sp - 1) * 2);
      if (nat >= 1 && nat <= natDexCount && natToSpecies[nat] === undefined) natToSpecies[nat] = sp;
    }

    type Entry = { category: string; height: number; weight: number; description: string; description2: string;
      pokemonScale: number; pokemonOffset: number; trainerScale: number; trainerOffset: number };
    const entries: Record<number, Entry> = {};
    // src/data/pokemon/pokedex_entries.h:3
    for (let nat = 0; nat <= natDexCount; nat++) {
      const sp = natToSpecies[nat] ?? nat;
      const off = entriesBase + nat * E.size!;
      const category = decode_category(rom, off + E.category!, E.categoryLen);
      const height = get_u16(rom, off + E.height!);
      const weight = get_u16(rom, off + E.weight!);
      const descPtr1 = get_u32(rom, off + E.desc!);
      const descPtr2 = E.desc2 !== undefined ? get_u32(rom, off + E.desc2) : 0;
      const pokemonScale = get_u16(rom, off + E.pokemonScale!);
      const pokemonOffset = get_s16(rom, off + E.pokemonOffset!);
      const trainerScale = get_u16(rom, off + E.trainerScale!);
      const trainerOffset = get_s16(rom, off + E.trainerOffset!);

      const desc1 = decode_text(rom, descPtr1, 256);
      const desc2 = descPtr2 >= 0x08000000 && descPtr2 < 0x0a000000 ? decode_text(rom, descPtr2, 256) : desc1;

      entries[sp] = {
        category: category !== "" ? category : "UNKNOWN",
        height, weight,
        description: desc1,
        description2: desc2,
        pokemonScale, pokemonOffset, trainerScale, trainerOffset,
      };
    }

    const lines = [
      "-- Auto-generated FRLG Pok\xc3\xa9dex Entries from ROM gPokedexEntries. DO NOT EDIT DIRECTLY.",
      "return {",
    ];
    const ids = Object.keys(entries).map(Number).sort((a, b) => a - b);
    for (const id of ids) {
      const e = entries[id]!;
      lines.push(format(
        '  [%d] = { category = "%s", height = %d, weight = %d, description = "%s", description2 = "%s", pokemonScale = %d, pokemonOffset = %d, trainerScale = %d, trainerOffset = %d },',
        id,
        escape_lua(e.category),
        e.height ?? 0,
        e.weight ?? 0,
        escape_lua(e.description),
        escape_lua(e.description2),
        e.pokemonScale ?? 256,
        e.pokemonOffset ?? 0,
        e.trainerScale ?? 256,
        e.trainerOffset ?? 0,
      ));
    }
    lines.push("}");
    lines.push("");
    write_file(cache, root + "/entries.lua", lines.join("\n"));

    const R = L.regionalDex as { countConstant: string; name: string } | undefined;
    if (R) {
      const C = Constants.of(L.constantsGame);
      const regionalCount: number = C.require("species", R.countConstant);
      const toNational = Versions.HOENN_TO_NATIONAL;
      if (toNational === undefined) throw new Error("pokedex entries: no HOENN_TO_NATIONAL key");
      const numerical: number[] = [], natToRegional: Record<number, number> = {};
      // pokeemerald/src/pokemon.c:940
      for (let i = 1; i <= numSpecies - 1; i++) {
        const nat = get_u16(rom, toNational + (i - 1) * 2);
        if (nat >= 1 && nat <= natDexCount && natToRegional[nat] === undefined) {
          natToRegional[nat] = i;
          if (i <= regionalCount) numerical.push(nat);
        }
      }
      const natIds = Object.keys(natToRegional).map(Number).sort((a, b) => a - b);
      const map = natIds.map((nat) => format("[%d] = %d", nat, natToRegional[nat]));
      write_file(cache, root + "/regional.lua", [
        "return {",
        format('  region = "%s",', R.name),
        format("  count = %d,", regionalCount),
        "  numerical = { " + numerical.join(", ") + " },",
        "  nationalToRegional = { " + map.join(", ") + " },",
        "}",
        "",
      ].join("\n"));
    }
    return true;
  },

  // Lua: pokedex_chrome_extract.lua:250 -- categories.lua from the ROM's gDexCategories table
  extractCategories(rom: Rom, cache: Cache | undefined, root: string): boolean {
    const gDexBase: number = Versions.DEX_CATEGORIES ?? 0x452c4c;
    const catKeys = ["grassland", "forest", "waters_edge", "sea", "cave", "mountain", "rough_terrain", "urban", "rare"];
    const numSpecies: number = Versions.NUM_SPECIES ?? 412;

    // pages[k] is the Lua's 1-based page table: 0-based array here (holes kept)
    const categories: Record<string, number[][]> = {};
    for (let catIdx = 1; catIdx <= 9; catIdx++) {
      const k = catKeys[catIdx - 1]!;
      categories[k] = [];
      const catOff = gDexBase + (catIdx - 1) * 8;
      const pagesPtr = get_u32(rom, catOff);
      const pageCount = get_byte(rom, catOff + 4);
      if (pagesPtr >= 0x08000000 && pagesPtr < 0x0a000000) {
        const pagesOff = pagesPtr - 0x08000000;
        for (let p = 0; p <= pageCount - 1; p++) {
          const pEntryOff = pagesOff + p * 8;
          const monListPtr = get_u32(rom, pEntryOff);
          const monCount = get_byte(rom, pEntryOff + 4);
          if (monListPtr >= 0x08000000 && monListPtr < 0x0a000000) {
            const monListOff = monListPtr - 0x08000000;
            const mons: number[] = [];
            for (let m = 0; m <= monCount - 1; m++) {
              const sp = get_u16(rom, monListOff + m * 2);
              if (sp >= 1 && sp <= numSpecies - 1) mons.push(sp);
            }
            categories[k]![p] = mons;
          }
        }
      }
    }

    const lines = [
      "-- Auto-generated FRLG Habitat Categories from ROM gDexCategories. DO NOT EDIT DIRECTLY.",
      "return {",
    ];
    for (const k of catKeys) {
      const pages = categories[k] ?? [];
      lines.push(format('  ["%s"] = {', k));
      // #pages: the Lua border; pages are filled densely from 1 when present
      let n = 0;
      while (pages[n] !== undefined) n++;
      for (let pIdx = 1; pIdx <= n; pIdx++) {
        const p = pages[pIdx - 1] ?? [];
        lines.push(format("    [%d] = { %s },", pIdx, p.join(", ")));
      }
      lines.push("  },");
    }
    lines.push("}");
    lines.push("");
    write_file(cache, root + "/categories.lua", lines.join("\n"));
    return true;
  },

  // Lua: pokedex_chrome_extract.lua:306 -- orders.lua from the ROM's gPokedexOrder_* tables
  extractOrders(rom: Rom, cache: Cache | undefined, root: string): boolean {
    const natDexCount: number = Versions.NATIONAL_DEX_COUNT;
    if (natDexCount === undefined) throw new Error("pokedex orders: no NATIONAL_DEX_COUNT key");
    const numSpecies: number = Versions.NUM_SPECIES;
    if (numSpecies === undefined) throw new Error("pokedex orders: no NUM_SPECIES key");
    const ordersBase = Versions.POKEDEX_ORDERS;
    if (ordersBase === undefined) throw new Error("pokedex orders: no POKEDEX_ORDERS key");
    const L = Layouts.active();
    const R = L.regionalDex as { countConstant: string; name: string } | undefined;
    const regionalKey = R ? "numerical_" + R.name : "numerical_kanto";
    const orders: Record<string, number[]> = {
      [regionalKey]: [],
      numerical_national: [],
      atoz: [],
      lightest: [],
      smallest: [],
    };
    const keys = [regionalKey, "numerical_national", "atoz"];
    if (ordersBase.type !== undefined) {
      orders.type = [];
      keys.push("type");
    }
    keys.push("lightest");
    keys.push("smallest");

    if (R) {
      const C = Constants.of(L.constantsGame);
      const regionalCount: number = C.require("species", R.countConstant);
      const toNational = Versions.HOENN_TO_NATIONAL;
      if (toNational === undefined) throw new Error("pokedex orders: no HOENN_TO_NATIONAL key");
      const seen: Record<number, boolean> = {};
      // pokeemerald/src/pokemon.c:940
      for (let i = 1; i <= regionalCount; i++) {
        const nat = get_u16(rom, toNational + (i - 1) * 2);
        if (nat >= 1 && nat <= natDexCount && !seen[nat]) {
          seen[nat] = true;
          orders[regionalKey]!.push(nat);
        }
      }
    } else {
      for (let i = 1; i <= 151; i++) orders.numerical_kanto![i - 1] = i;
    }
    for (let i = 1; i <= natDexCount; i++) orders.numerical_national![i - 1] = i;

    // pokeemerald/src/pokedex.c:2246
    const alphaCount = R ? numSpecies - 1 : natDexCount;
    for (let i = 0; i <= alphaCount - 1; i++) {
      const idA = get_u16(rom, ordersBase.alphabetical + i * 2);
      if (idA >= 1 && idA <= natDexCount) orders.atoz!.push(idA);
    }
    for (let i = 0; i <= natDexCount - 1; i++) {
      const idW = get_u16(rom, ordersBase.weight + i * 2);
      if (idW >= 1 && idW <= natDexCount) orders.lightest!.push(idW);
      const idH = get_u16(rom, ordersBase.height + i * 2);
      if (idH >= 1 && idH <= natDexCount) orders.smallest!.push(idH);
      if (orders.type) {
        const idT = get_u16(rom, ordersBase.type + i * 2);
        if (idT >= 1 && idT <= numSpecies - 1) orders.type.push(idT);
      }
    }

    const lines = [
      "-- Auto-generated FRLG Pok\xc3\xa9dex Sorting Orders from ROM. DO NOT EDIT DIRECTLY.",
      "return {",
    ];
    for (const k of keys) {
      const list = orders[k] ?? [];
      lines.push(format('  ["%s"] = {', k));
      lines.push("    " + list.join(", "));
      lines.push("  },");
    }
    lines.push("}");
    lines.push("");
    write_file(cache, root + "/orders.lua", lines.join("\n"));
    return true;
  },

  // include/pokedex.h:19
  // Lua: pokedex_chrome_extract.lua:382 (keys 0..)
  DEX_AREA_NAMES: [
    "DEX_AREA_NONE",
    "DEX_AREA_PALLET_TOWN", "DEX_AREA_VIRIDIAN_CITY", "DEX_AREA_PEWTER_CITY",
    "DEX_AREA_CERULEAN_CITY", "DEX_AREA_LAVENDER_TOWN", "DEX_AREA_VERMILION_CITY",
    "DEX_AREA_CELADON_CITY", "DEX_AREA_FUCHSIA_CITY", "DEX_AREA_CINNABAR_ISLAND",
    "DEX_AREA_INDIGO_PLATEAU", "DEX_AREA_SAFFRON_CITY",
    "DEX_AREA_ROUTE_1", "DEX_AREA_ROUTE_2", "DEX_AREA_ROUTE_3", "DEX_AREA_ROUTE_4",
    "DEX_AREA_ROUTE_5", "DEX_AREA_ROUTE_6", "DEX_AREA_ROUTE_7", "DEX_AREA_ROUTE_8",
    "DEX_AREA_ROUTE_9", "DEX_AREA_ROUTE_10", "DEX_AREA_ROUTE_11", "DEX_AREA_ROUTE_12",
    "DEX_AREA_ROUTE_13", "DEX_AREA_ROUTE_14", "DEX_AREA_ROUTE_15", "DEX_AREA_ROUTE_16",
    "DEX_AREA_ROUTE_17", "DEX_AREA_ROUTE_18", "DEX_AREA_ROUTE_19", "DEX_AREA_ROUTE_20",
    "DEX_AREA_ROUTE_21", "DEX_AREA_ROUTE_22", "DEX_AREA_ROUTE_23", "DEX_AREA_ROUTE_24",
    "DEX_AREA_ROUTE_25",
    "DEX_AREA_VIRIDIAN_FOREST", "DEX_AREA_DIGLETTS_CAVE", "DEX_AREA_MT_MOON",
    "DEX_AREA_CERULEAN_CAVE", "DEX_AREA_ROCK_TUNNEL", "DEX_AREA_POWER_PLANT",
    "DEX_AREA_POKEMON_TOWER", "DEX_AREA_SAFARI_ZONE", "DEX_AREA_SEAFOAM_ISLANDS",
    "DEX_AREA_POKEMON_MANSION", "DEX_AREA_VICTORY_ROAD",
    "DEX_AREA_ONE_ISLAND", "DEX_AREA_TWO_ISLAND", "DEX_AREA_THREE_ISLAND",
    "DEX_AREA_FOUR_ISLAND", "DEX_AREA_FIVE_ISLAND", "DEX_AREA_SIX_ISLAND",
    "DEX_AREA_SEVEN_ISLAND",
    "DEX_AREA_KINDLE_ROAD", "DEX_AREA_TREASURE_BEACH", "DEX_AREA_CAPE_BRINK",
    "DEX_AREA_BOND_BRIDGE", "DEX_AREA_THREE_ISLE_PATH", "DEX_AREA_RESORT_GORGEOUS",
    "DEX_AREA_WATER_LABYRINTH", "DEX_AREA_FIVE_ISLE_MEADOW", "DEX_AREA_MEMORIAL_PILLAR",
    "DEX_AREA_OUTCAST_ISLAND", "DEX_AREA_GREEN_PATH", "DEX_AREA_WATER_PATH",
    "DEX_AREA_RUIN_VALLEY", "DEX_AREA_TRAINER_TOWER", "DEX_AREA_CANYON_ENTRANCE",
    "DEX_AREA_SEVAULT_CANYON", "DEX_AREA_TANOBY_RUINS", "DEX_AREA_MT_EMBER",
    "DEX_AREA_BERRY_FOREST", "DEX_AREA_ICEFALL_CAVE", "DEX_AREA_LOST_CAVE",
    "DEX_AREA_ALTERING_CAVE", "DEX_AREA_PATTERN_BUSH", "DEX_AREA_DOTTED_HOLE",
    "DEX_AREA_TANOBY_CHAMBER",
  ] as string[],

  // src/pokedex_area_markers.c:28
  MARKER_SHAPES: {
    0: "MARKER_CIRCULAR",
    1: "MARKER_SMALL_H",
    2: "MARKER_SMALL_V",
    3: "MARKER_MED_H",
    4: "MARKER_MED_V",
    5: "MARKER_LARGE_H",
    6: "MARKER_LARGE_V",
  } as Record<number, string>,

  // Lua: pokedex_chrome_extract.lua:425 (src/pokedex_area_markers.c:101, src/wild_pokemon_area.c:25)
  extractAreaMarkers(rom: Rom, cache: Cache | undefined, root: string): boolean {
    const MapSections = MapSectionsExtract;
    const base = Versions.DEX_AREA_MARKERS;
    const stride: number = Versions.DEX_AREA_MARKER_ENTRY_SIZE ?? 4;
    const count: number = Versions.DEX_AREA_COUNT ?? 80;
    if (base === undefined) return false;

    const names = PokedexChromeExtract.DEX_AREA_NAMES;
    const shapes = PokedexChromeExtract.MARKER_SHAPES;

    const markers: Record<string, { x: number; y: number; shape: string }> = {};
    const order: string[] = [];
    for (let id = 1; id <= count - 1; id++) {
      const key = names[id];
      if (key !== undefined) {
        const off = base + id * stride;
        const shapeId = get_byte(rom, off);
        let x = get_byte(rom, off + 1);
        let y = get_byte(rom, off + 2);
        if (x >= 128) x -= 256;
        if (y >= 128) y -= 256;
        const shape = shapes[shapeId];
        if (shape !== undefined && !(x === 0 && y === 0 && shapeId === 0)) {
          markers[key] = { x, y, shape };
          order.push(key);
        }
      }
    }

    const mapsecToArea: Record<string, string> = {};
    const secOrder: string[] = [];
    for (const tbl of ipairs<{ count?: number; off: number }>(Versions.DEX_AREA_MAPSEC_TABLES)) {
      for (let i = 0; i <= (tbl.count ?? 0) - 1; i++) {
        const secId = get_u16(rom, tbl.off + i * 4);
        const areaId = get_u16(rom, tbl.off + i * 4 + 2);
        const section = MapSections.SECTIONS ? MapSections.SECTIONS[secId] : undefined;
        const areaKey = names[areaId];
        if (section && section.id && areaKey !== undefined && markers[areaKey] && mapsecToArea[section.id] === undefined) {
          mapsecToArea[section.id] = areaKey;
          secOrder.push(section.id);
        }
      }
    }

    order.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    secOrder.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const lines = [
      "-- Auto-generated FRLG Pok\xc3\xa9dex area markers from ROM. DO NOT EDIT DIRECTLY.",
      "return {",
      "  markers = {",
    ];
    for (const key of order) {
      const m = markers[key]!;
      lines.push(format('    ["%s"] = { x = %d, y = %d, shape = "%s" },', key, m.x, m.y, m.shape));
    }
    lines.push("  },");
    lines.push("  mapsecToArea = {");
    for (const secId of secOrder) lines.push(format('    ["%s"] = "%s",', secId, mapsecToArea[secId]));
    lines.push("  },");
    lines.push("}");
    lines.push("");

    write_file(cache, root + "/area_markers.lua", lines.join("\n"));
    return true;
  },

  // Lua: pokedex_chrome_extract.lua:492 -- [rgba, w, h]
  bakeTileSheet(gfx: Bytes, palette: Pal): [string, number, number] {
    const cols = PokedexChromeExtract.TILE_SHEET_COLS;
    const tileCount = Math.floor(gfx.length / 32);
    const rows = Math.ceil(tileCount / cols);
    const w = cols * 8, h = rows * 8;
    const rgb: number[][] = [];
    for (let i = 0; i <= 15; i++) {
      const c = (palette[i] ?? 0) % 32768;
      rgb[i] = [
        Math.floor(((c % 32) * 255) / 31 + 0.5),
        Math.floor(((Math.floor(c / 32) % 32) * 255) / 31 + 0.5),
        Math.floor(((Math.floor(c / 1024) % 32) * 255) / 31 + 0.5),
        255,
      ];
    }
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) out.set(rgb[0]!, i * 4);
    for (let t = 0; t <= tileCount - 1; t++) {
      const baseX = (t % cols) * 8;
      const baseY = Math.floor(t / cols) * 8;
      for (let row = 0; row <= 7; row++) {
        for (let bx = 0; bx <= 3; bx++) {
          const byte = gfx[t * 32 + row * 4 + bx] ?? 0;
          const o = (baseY + row) * w + baseX + bx * 2;
          out.set(rgb[byte % 16]!, o * 4);
          out.set(rgb[Math.floor(byte / 16) % 16]!, (o + 1) * 4);
        }
      }
    }
    return [fromBytes(out), w, h];
  },

  // Lua: pokedex_chrome_extract.lua:524 (src/pokedex_screen.c:897)
  extractTileSheets(rom: Rom, cache: Cache | undefined, root: string): boolean {
    const get = (i: number): number => get_byte(rom, i);
    for (const variant of Object.keys(PokedexChromeExtract.TILE_SHEETS)) {
      const file = PokedexChromeExtract.TILE_SHEETS[variant]!;
      const src = Versions.POKEDEX_BG_TILES ? Versions.POKEDEX_BG_TILES[variant] : undefined;
      if (src) {
        const [gfx] = Lz77.decompress(get, src.gfx);
        const palette: Pal = {};
        for (let i = 0; i <= 15; i++) palette[i] = get_u16(rom, src.pal + i * 2);
        write_file(cache, root + "/" + file, PokedexChromeExtract.bakeTileSheet(gfx, palette)[0]);
      }
    }
    return true;
  },

  // Lua: pokedex_chrome_extract.lua:566
  bakeImage(gfx: Bytes, palette: Pal | undefined, w: number, h: number,
    opts: { tile0?: number; opaqueZero?: boolean; mask?: boolean } = {}): string {
    const cols = Math.floor(w / 8);
    const rows = Math.floor(h / 8);
    const tile0 = opts.tile0 ?? 0;
    const rgb: number[][] = [];
    for (let i = 0; i <= 15; i++) {
      let [r, g, b] = gba_rgb(palette ? palette[i] : undefined);
      let a = 255;
      if (i === 0 && !opts.opaqueZero) { a = 0; r = 0; g = 0; b = 0; }
      if (opts.mask) {
        if (i === 0) { r = 0; g = 0; b = 0; a = 0; } else { r = 255; g = 255; b = 255; a = 255; }
      }
      rgb[i] = [r, g, b, a];
    }
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) out.set(rgb[0]!, i * 4);
    for (let t = 0; t <= cols * rows - 1; t++) {
      const baseX = (t % cols) * 8;
      const baseY = Math.floor(t / cols) * 8;
      for (let row = 0; row <= 7; row++) {
        for (let bx = 0; bx <= 3; bx++) {
          const byte = gfx[(tile0 + t) * 32 + row * 4 + bx] ?? 0;
          const o = (baseY + row) * w + baseX + bx * 2;
          out.set(rgb[byte % 16]!, o * 4);
          out.set(rgb[Math.floor(byte / 16) % 16]!, (o + 1) * 4);
        }
      }
    }
    return fromBytes(out);
  },

  // Lua: pokedex_chrome_extract.lua:599 (src/pokedex_screen.c:143)
  extractChromeGfx(rom: Rom, cache: Cache | undefined, root: string): boolean {
    const src = Versions.POKEDEX_BG_TILES ? Versions.POKEDEX_BG_TILES.kanto : undefined;
    if (!src) return false;
    const palette = read_palette(rom, src.pal);
    for (const g of ipairs(Versions.POKEDEX_CHROME_GFX ?? {})) {
      const gfx = tile_source(rom, g);
      write_file(cache, root + "/" + g.file, PokedexChromeExtract.bakeImage(gfx, palette, g.w, g.h));
    }
    return true;
  },

  // Lua: pokedex_chrome_extract.lua:612 (src/pokedex_screen.c:158)
  extractCategoryIcons(rom: Rom, cache: Cache | undefined, root: string): boolean {
    const w: number = Versions.POKEDEX_CATEGORY_ICON_W ?? 64;
    const h: number = Versions.POKEDEX_CATEGORY_ICON_H ?? 48;
    for (const icon of ipairs(Versions.POKEDEX_CATEGORY_ICONS ?? {})) {
      const [gfx] = Lz77.decompress((i) => get_byte(rom, i), icon.gfx);
      const palette = read_palette(rom, icon.pal);
      write_file(cache, root + "/" + icon.file, PokedexChromeExtract.bakeImage(gfx, palette, w, h));
    }
    return true;
  },

  // Lua: pokedex_chrome_extract.lua:625 (src/pokedex_area_markers.c:203)
  extractAreaMarkerGfx(rom: Rom, cache: Cache | undefined, root: string): boolean {
    const base = Versions.POKEDEX_AREA_MARKER_GFX;
    if (base === undefined) return false;
    const [gfx] = Lz77.decompress((i) => get_byte(rom, i), base);
    for (const shape of ipairs(Versions.POKEDEX_AREA_MARKER_SHAPES ?? {})) {
      write_file(cache, root + "/" + shape.file,
        PokedexChromeExtract.bakeImage(gfx, undefined, shape.w, shape.h, { tile0: shape.tile, mask: true }));
    }
    return true;
  },

  // Lua: pokedex_chrome_extract.lua:637 (src/pokedex_area_markers.c:237, src/pokedex_screen.c:3103)
  extractChromeColors(rom: Rom, cache: Cache | undefined, root: string): boolean {
    const src = Versions.POKEDEX_BG_TILES ? Versions.POKEDEX_BG_TILES.kanto : undefined;
    if (!src) return false;
    const palette = read_palette(rom, src.pal);
    const [gfx] = Lz77.decompress((i) => get_byte(rom, i), src.gfx);
    const blendTile: number = Versions.POKEDEX_MARKER_BLEND_TILE ?? 15;
    const eva: number = Versions.POKEDEX_MARKER_BLEND_EVA ?? 12;
    const evb: number = Versions.POKEDEX_MARKER_BLEND_EVB ?? 8;
    const [mr, mg, mb] = gba_rgb(palette[(gfx[blendTile * 32] ?? 0) % 16]);
    const [sr, sg, sb] = gba_rgb(get_u16(rom, (Versions.POKEDEX_SILHOUETTE_PAL ?? 0) + 2));
    // src/pokedex_screen.c:245 sWindowTemplates[0..1], :1161 FillWindowPixelBuffer(0, PIXEL_FILL(15))
    const barIndex = PokedexChromeExtract.PAPER_BAR_PAL * 16 + PokedexChromeExtract.PAPER_BAR_COLOR;
    const [kr, kg, kb] = gba_rgb(get_u16(rom, src.pal + barIndex * 2));
    const nat = Versions.POKEDEX_BG_TILES.national;
    const [nr, ng, nb] = gba_rgb(get_u16(rom, nat.pal + barIndex * 2));
    const text = format(
      "-- Auto-generated FRLG Pok\xc3\xa9dex chrome colors from ROM. DO NOT EDIT DIRECTLY.\nreturn {\n"
        + "  marker = { %d, %d, %d, %d },\n  marker_blend = { %d, %d },\n"
        + "  silhouette = { %d, %d, %d },\n"
        + "  bar_kanto = { %d, %d, %d },\n  bar_national = { %d, %d, %d },\n}\n",
      mr, mg, mb, Math.floor((eva * 255) / 16 + 0.5), eva, evb, sr, sg, sb, kr, kg, kb, nr, ng, nb);
    write_file(cache, root + "/" + PokedexChromeExtract.CHROME_FILE, text);
    return true;
  },

  // Lua: pokedex_chrome_extract.lua:678 (src/pokedex_screen.c:930)
  bakePaperBg(gfx: Bytes, pal: Pal): string {
    const w = PokedexChromeExtract.PAPER_BG_W, h = PokedexChromeExtract.PAPER_BG_H;
    const cols = Math.floor(w / 8), rows = Math.floor(h / 8);
    const bars = PokedexChromeExtract.PAPER_BAR_ROWS;
    const pagePal = palette_colors(pal, 0);
    const barColor = palette_colors(pal, PokedexChromeExtract.PAPER_BAR_PAL * 16)[PokedexChromeExtract.PAPER_BAR_COLOR]!;
    const px: string[] = new Array(w * h).fill(pagePal[0]);
    const blit = (tile: number, colors: string[], tx: number, ty: number, keepZero: boolean): void => {
      for (let row = 0; row <= 7; row++) {
        for (let bx = 0; bx <= 3; bx++) {
          const byte = gfx[tile * 32 + row * 4 + bx] ?? 0;
          const o = (ty * 8 + row) * w + tx * 8 + bx * 2;
          const lo = byte % 16, hi = Math.floor(byte / 16) % 16;
          if (keepZero || lo !== 0) px[o] = colors[lo]!;
          if (keepZero || hi !== 0) px[o + 1] = colors[hi]!;
        }
      }
    };
    for (let ty = 0; ty <= rows - 1; ty++) {
      for (let tx = 0; tx <= cols - 1; tx++) blit(PokedexChromeExtract.PAPER_TILE, pagePal, tx, ty, true);
    }
    for (let py = 0; py <= h - 1; py++) {
      if (py < bars * 8 || py >= h - bars * 8) {
        for (let x = 0; x <= w - 1; x++) px[py * w + x] = barColor;
      }
    }
    return px.join("");
  },

  // Lua: pokedex_chrome_extract.lua:711 (src/pokedex_screen.c:896, :930)
  extractPaperBg(rom: Rom, cache: Cache | undefined, root: string): boolean {
    const src = Versions.POKEDEX_BG_TILES ? Versions.POKEDEX_BG_TILES.kanto : undefined;
    if (!src) return false;
    const [gfx] = Lz77.decompress((i) => get_byte(rom, i), src.gfx);
    const pal = read_palette_block(rom, src.pal, 256);
    write_file(cache, root + "/" + PokedexChromeExtract.PAPER_BG_FILE, PokedexChromeExtract.bakePaperBg(gfx, pal));
    return true;
  },

  // Lua: pokedex_chrome_extract.lua:722 (src/pokedex_screen.c:2901); bytes a byte string
  bakeFootprint(bytes: string, r?: number, g?: number, b?: number): string {
    const w = PokedexChromeExtract.FOOTPRINT_W, h = PokedexChromeExtract.FOOTPRINT_H;
    const on = String.fromCharCode(r ?? 0, g ?? 0, b ?? 0, 255);
    const off = "\x00\x00\x00\x00";
    let out = "";
    for (let y = 0; y <= h - 1; y++) {
      for (let x = 0; x <= w - 1; x++) {
        const tile = Math.floor(x / 8) + 2 * Math.floor(y / 8);
        const k = tile * 8 + (y % 8);
        const byte = k < bytes.length ? bytes.charCodeAt(k) : 0;
        out += Math.floor(byte / 2 ** (x % 8)) % 2 === 1 ? on : off;
      }
    }
    return out;
  },

  // Lua: pokedex_chrome_extract.lua:738 (src/data/pokemon_graphics/footprint_table.h:3) -- [offsets, base]
  footprintTable(rom: Rom, cfg?: { footprint_table?: number }): [Record<number, number | undefined> | undefined, number] {
    const base: number = (cfg && cfg.footprint_table)
      ?? Versions.MON_FOOTPRINT_TABLE
      ?? Versions.address(PokedexChromeExtract.FOOTPRINT_TABLE);
    const count: number = Versions.NUM_SPECIES ?? 412;
    const entry = (sp: number): number | undefined => {
      const ptr = get_u32(rom, base + sp * 4);
      if (ptr < 0x08000000 || ptr >= 0x0a000000) return undefined;
      return ptr - 0x08000000;
    };
    const none = entry(0), bulbasaur = entry(1);
    if (none === undefined || none !== bulbasaur) return [undefined, base];
    const out: Record<number, number | undefined> = {};
    for (let sp = 0; sp <= count - 1; sp++) out[sp] = entry(sp);
    return [out, base];
  },

  // Lua: pokedex_chrome_extract.lua:791 (src/pokedex_screen.c:2901, :608)
  extractFootprints(rom: Rom, cache: Cache | undefined, root: string, cfg?: { footprint_table?: number }): boolean {
    const [offsets] = PokedexChromeExtract.footprintTable(rom, cfg);
    if (!offsets) return false;
    const src = Versions.POKEDEX_BG_TILES ? Versions.POKEDEX_BG_TILES.kanto : undefined;
    const palette = src ? read_palette(rom, src.pal) : undefined;
    const [r, g, b] = gba_rgb(palette ? palette[1] : undefined);
    const dir = root + "/" + PokedexChromeExtract.FOOTPRINT_SUB;
    const keys = footprint_name_keys(rom);
    const count: number = Versions.NUM_SPECIES ?? 412;
    let written = 0;
    for (let sp = 0; sp <= count - 1; sp++) {
      const off = offsets[sp];
      if (off !== undefined) {
        const rgba = PokedexChromeExtract.bakeFootprint(footprint_bytes(rom, off), r, g, b);
        write_file(cache, dir + "/" + sp + ".rgba", rgba);
        if (keys[sp] !== undefined) write_file(cache, dir + "/" + keys[sp] + ".rgba", rgba);
        written++;
      }
    }
    const qm = offsets[PokedexChromeExtract.FOOTPRINT_QUESTION_MARK_SPECIES];
    if (qm !== undefined) {
      write_file(cache, dir + "/" + PokedexChromeExtract.FOOTPRINT_QUESTION_MARK_FILE,
        PokedexChromeExtract.bakeFootprint(footprint_bytes(rom, qm), r, g, b));
    }
    return written > 0;
  },

  // Lua: pokedex_chrome_extract.lua:818
  run(rom: Rom, cache: Cache | undefined, opts: {
    cacheRoot?: string; force?: boolean; footprint_table?: number;
    progress?: (name: string, cur: number, total: number) => void;
  } = {}): boolean {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + PokedexChromeExtract.CACHE_SUB;

    if (!opts.force && PokedexChromeExtract.ready(cache, cacheRoot)) return true;

    if (opts.progress) opts.progress("pokedex_entries", 0, 3);
    PokedexChromeExtract.extractEntries(rom, cache, root);

    if (opts.progress) opts.progress("pokedex_categories", 1, 3);
    PokedexChromeExtract.extractCategories(rom, cache, root);

    if (opts.progress) opts.progress("pokedex_orders", 2, 3);
    PokedexChromeExtract.extractOrders(rom, cache, root);
    PokedexChromeExtract.extractAreaMarkers(rom, cache, root);
    PokedexChromeExtract.extractTileSheets(rom, cache, root);
    PokedexChromeExtract.extractChromeGfx(rom, cache, root);
    PokedexChromeExtract.extractCategoryIcons(rom, cache, root);
    PokedexChromeExtract.extractAreaMarkerGfx(rom, cache, root);
    PokedexChromeExtract.extractChromeColors(rom, cache, root);
    PokedexChromeExtract.extractPaperBg(rom, cache, root);
    PokedexChromeExtract.extractFootprints(rom, cache, root, opts);

    const manifest = format(
      "return { format = %d, count = %d, version = 2 }\n",
      PokedexChromeExtract.FORMAT_VERSION,
      Versions.NATIONAL_DEX_COUNT ?? 386,
    );
    write_file(cache, root + "/manifest.lua", manifest);
    write_file(cache, cacheRoot + "/pokedex/manifest.lua", manifest);

    if (opts.progress) opts.progress("pokedex_done", 3, 3);
    return true;
  },

  // Lua: pokedex_chrome_extract.lua:856
  // NOT FAITHFUL: the no-cache fallbacks (CacheFs / love.filesystem / io.open) read CacheFs only.
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    cacheRoot = cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + PokedexChromeExtract.CACHE_SUB;
    const valid_file = (rel: string, minSize = 1): boolean => {
      if (cache) {
        if (cache.read) {
          const data = cache.read(rel);
          return (data !== undefined && data.length >= minSize) || false;
        } else if (cache.exists) {
          return cache.exists(rel) || false;
        }
        return false;
      }
      try {
        const data = CacheFs.readActive(rel);
        if (data !== undefined && data.length >= minSize) return true;
      } catch { /* no cache bound */ }
      return false;
    };

    const P = PokedexChromeExtract;
    return valid_file(root + "/manifest.lua", 20)
      && valid_file(root + "/entries.lua", 20)
      && valid_file(root + "/categories.lua", 20)
      && valid_file(root + "/orders.lua", 20)
      && valid_file(root + "/area_markers.lua", 20)
      && valid_file(root + "/" + P.TILE_SHEETS.kanto, 64)
      && valid_file(root + "/" + P.TILE_SHEETS.national, 64)
      && valid_file(root + "/" + P.CHROME_FILE, 20)
      && valid_file(root + "/map_kanto.rgba", 64)
      && valid_file(root + "/mini_page.rgba", 64)
      && valid_file(root + "/blit_wide_ellipse.rgba", 64)
      && valid_file(root + "/marker_0.rgba", 64)
      && valid_file(root + "/cat_icon_grassland.rgba", 64)
      && valid_file(root + "/" + P.PAPER_BG_FILE, P.PAPER_BG_W * P.PAPER_BG_H * 4)
      && valid_file(root + "/" + P.FOOTPRINT_SUB + "/1.rgba", P.FOOTPRINT_W * P.FOOTPRINT_H * 4)
      && valid_file(root + "/" + P.FOOTPRINT_SUB + "/bulbasaur.rgba", 64)
      && valid_file(root + "/" + P.FOOTPRINT_SUB + "/" + P.FOOTPRINT_QUESTION_MARK_FILE, 64);
  },
};

export default PokedexChromeExtract;
