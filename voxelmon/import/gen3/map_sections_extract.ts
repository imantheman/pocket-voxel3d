// Port of gen1recomp src/import/gba/map_sections_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Map Sections & Location Name Popup Theme Extractor / Registry for Game3.
// Maps GBA regionMapSectionId (0x58 = PALLET_TOWN ...) to names & themes.
// SECTIONS is module state, as in the Lua: the extractor and the generated
// names overlay `name` onto it.

import { Versions } from "./versions.ts";
import { TextIR } from "../../game/gen3/core/scripting/text_ir.ts";
import { MapPreviewExtract } from "./map_preview_extract.ts";
import { CacheFs, type Cache } from "./cache.ts";
import { Json } from "./json.ts";
import { Plans } from "./plans.ts";
import { format, tonumber } from "./lua.ts";
import type { Rom } from "./rom.ts";

export interface MapSection { id: string; theme: string; name?: string }
export interface MapSectionInfo {
  secId: number; id: string; name: string; rawName: string | undefined; theme: string; floorNum: number; resolved: boolean;
}

// Lua: map_sections_extract.lua:8
const SECTIONS: Record<number, MapSection> = {
  88: { id: "MAPSEC_PALLET_TOWN", theme: "marble" },
  89: { id: "MAPSEC_VIRIDIAN_CITY", theme: "marble" },
  90: { id: "MAPSEC_PEWTER_CITY", theme: "stone" },
  91: { id: "MAPSEC_CERULEAN_CITY", theme: "marble" },
  92: { id: "MAPSEC_LAVENDER_TOWN", theme: "marble" },
  93: { id: "MAPSEC_VERMILION_CITY", theme: "marble" },
  94: { id: "MAPSEC_CELADON_CITY", theme: "brick" },
  95: { id: "MAPSEC_FUCHSIA_CITY", theme: "wood" },
  96: { id: "MAPSEC_CINNABAR_ISLAND", theme: "stone" },
  97: { id: "MAPSEC_INDIGO_PLATEAU", theme: "marble" },
  98: { id: "MAPSEC_SAFFRON_CITY", theme: "brick" },
  99: { id: "MAPSEC_ROUTE_4_POKECENTER", theme: "stone" },
  100: { id: "MAPSEC_ROUTE_10_POKECENTER", theme: "stone" },
  101: { id: "MAPSEC_ROUTE_1", theme: "marble" },
  102: { id: "MAPSEC_ROUTE_2", theme: "marble" },
  103: { id: "MAPSEC_ROUTE_3", theme: "stone" },
  104: { id: "MAPSEC_ROUTE_4", theme: "stone" },
  105: { id: "MAPSEC_ROUTE_5", theme: "marble" },
  106: { id: "MAPSEC_ROUTE_6", theme: "marble" },
  107: { id: "MAPSEC_ROUTE_7", theme: "brick" },
  108: { id: "MAPSEC_ROUTE_8", theme: "brick" },
  109: { id: "MAPSEC_ROUTE_9", theme: "stone" },
  110: { id: "MAPSEC_ROUTE_10", theme: "stone" },
  111: { id: "MAPSEC_ROUTE_11", theme: "marble" },
  112: { id: "MAPSEC_ROUTE_12", theme: "wood" },
  113: { id: "MAPSEC_ROUTE_13", theme: "wood" },
  114: { id: "MAPSEC_ROUTE_14", theme: "wood" },
  115: { id: "MAPSEC_ROUTE_15", theme: "wood" },
  116: { id: "MAPSEC_ROUTE_16", theme: "marble" },
  117: { id: "MAPSEC_ROUTE_17", theme: "marble" },
  118: { id: "MAPSEC_ROUTE_18", theme: "marble" },
  119: { id: "MAPSEC_ROUTE_19", theme: "marble" },
  120: { id: "MAPSEC_ROUTE_20", theme: "stone" },
  121: { id: "MAPSEC_ROUTE_21", theme: "marble" },
  122: { id: "MAPSEC_ROUTE_22", theme: "marble" },
  123: { id: "MAPSEC_ROUTE_23", theme: "marble" },
  124: { id: "MAPSEC_ROUTE_24", theme: "marble" },
  125: { id: "MAPSEC_ROUTE_25", theme: "marble" },
  126: { id: "MAPSEC_VIRIDIAN_FOREST", theme: "wood" },
  127: { id: "MAPSEC_MT_MOON", theme: "stone" },
  128: { id: "MAPSEC_S_S_ANNE", theme: "wood" },
  129: { id: "MAPSEC_UNDERGROUND_PATH", theme: "stone" },
  130: { id: "MAPSEC_UNDERGROUND_PATH_2", theme: "stone" },
  131: { id: "MAPSEC_DIGLETTS_CAVE", theme: "stone" },
  132: { id: "MAPSEC_KANTO_VICTORY_ROAD", theme: "stone" },
  133: { id: "MAPSEC_ROCKET_HIDEOUT", theme: "brick" },
  134: { id: "MAPSEC_SILPH_CO", theme: "brick" },
  135: { id: "MAPSEC_POKEMON_MANSION", theme: "brick" },
  136: { id: "MAPSEC_KANTO_SAFARI_ZONE", theme: "wood" },
  137: { id: "MAPSEC_POKEMON_LEAGUE", theme: "marble" },
  138: { id: "MAPSEC_ROCK_TUNNEL", theme: "stone" },
  139: { id: "MAPSEC_SEAFOAM_ISLANDS", theme: "stone" },
  140: { id: "MAPSEC_POKEMON_TOWER", theme: "brick" },
  141: { id: "MAPSEC_CERULEAN_CAVE", theme: "stone" },
  142: { id: "MAPSEC_POWER_PLANT", theme: "brick" },
  143: { id: "MAPSEC_ONE_ISLAND", theme: "marble" },
  144: { id: "MAPSEC_TWO_ISLAND", theme: "marble" },
  145: { id: "MAPSEC_THREE_ISLAND", theme: "marble" },
  146: { id: "MAPSEC_FOUR_ISLAND", theme: "marble" },
  147: { id: "MAPSEC_FIVE_ISLAND", theme: "marble" },
  148: { id: "MAPSEC_SEVEN_ISLAND", theme: "marble" },
  149: { id: "MAPSEC_SIX_ISLAND", theme: "marble" },
  150: { id: "MAPSEC_KINDLE_ROAD", theme: "stone" },
  151: { id: "MAPSEC_TREASURE_BEACH", theme: "marble" },
  152: { id: "MAPSEC_CAPE_BRINK", theme: "wood" },
  153: { id: "MAPSEC_BOND_BRIDGE", theme: "wood" },
  154: { id: "MAPSEC_THREE_ISLE_PORT", theme: "wood" },
  155: { id: "MAPSEC_SEVII_ISLE_6", theme: "marble" },
  156: { id: "MAPSEC_SEVII_ISLE_7", theme: "marble" },
  157: { id: "MAPSEC_SEVII_ISLE_8", theme: "marble" },
  158: { id: "MAPSEC_SEVII_ISLE_9", theme: "marble" },
  159: { id: "MAPSEC_RESORT_GORGEOUS", theme: "marble" },
  160: { id: "MAPSEC_WATER_LABYRINTH", theme: "marble" },
  161: { id: "MAPSEC_FIVE_ISLE_MEADOW", theme: "wood" },
  162: { id: "MAPSEC_MEMORIAL_PILLAR", theme: "stone" },
  163: { id: "MAPSEC_OUTCAST_ISLAND", theme: "marble" },
  164: { id: "MAPSEC_GREEN_PATH", theme: "wood" },
  165: { id: "MAPSEC_WATER_PATH", theme: "marble" },
  166: { id: "MAPSEC_RUIN_VALLEY", theme: "stone" },
  167: { id: "MAPSEC_TRAINER_TOWER", theme: "brick" },
  168: { id: "MAPSEC_CANYON_ENTRANCE", theme: "stone" },
  169: { id: "MAPSEC_SEVAULT_CANYON", theme: "stone" },
  170: { id: "MAPSEC_TANOBY_RUINS", theme: "stone" },
  171: { id: "MAPSEC_SEVII_ISLE_22", theme: "marble" },
  172: { id: "MAPSEC_SEVII_ISLE_23", theme: "marble" },
  173: { id: "MAPSEC_SEVII_ISLE_24", theme: "marble" },
  174: { id: "MAPSEC_NAVEL_ROCK", theme: "stone" },
  175: { id: "MAPSEC_MT_EMBER", theme: "stone" },
  176: { id: "MAPSEC_BERRY_FOREST", theme: "wood" },
  177: { id: "MAPSEC_ICEFALL_CAVE", theme: "stone" },
  178: { id: "MAPSEC_ROCKET_WAREHOUSE", theme: "brick" },
  179: { id: "MAPSEC_TRAINER_TOWER_2", theme: "brick" },
  180: { id: "MAPSEC_DOTTED_HOLE", theme: "stone" },
  181: { id: "MAPSEC_LOST_CAVE", theme: "stone" },
  182: { id: "MAPSEC_PATTERN_BUSH", theme: "wood" },
  183: { id: "MAPSEC_ALTERING_CAVE", theme: "stone" },
  184: { id: "MAPSEC_TANOBY_CHAMBERS", theme: "stone" },
  185: { id: "MAPSEC_THREE_ISLE_PATH", theme: "wood" },
  186: { id: "MAPSEC_TANOBY_KEY", theme: "stone" },
  187: { id: "MAPSEC_BIRTH_ISLAND", theme: "stone" },
  188: { id: "MAPSEC_MONEAN_CHAMBER", theme: "stone" },
  189: { id: "MAPSEC_LIPTOO_CHAMBER", theme: "stone" },
  190: { id: "MAPSEC_WEEPTH_CHAMBER", theme: "stone" },
  191: { id: "MAPSEC_DILFORD_CHAMBER", theme: "stone" },
  192: { id: "MAPSEC_SCUFIB_CHAMBER", theme: "stone" },
  193: { id: "MAPSEC_RIXY_CHAMBER", theme: "stone" },
  194: { id: "MAPSEC_VIAPOIS_CHAMBER", theme: "stone" },
  195: { id: "MAPSEC_EMBER_SPA", theme: "stone" },
  196: { id: "MAPSEC_SPECIAL_AREA", theme: "brick" },
};

// Reverse index: symbolic MAPSEC_* name -> numeric mapsec.  Built once; only
// `name` is ever overlaid from the ROM, so `id` stays a stable key.
// Lua: map_sections_extract.lua:125
const ID_TO_SECTION: Record<string, number> = {};
for (const k of Object.keys(SECTIONS)) ID_TO_SECTION[SECTIONS[Number(k)]!.id] = Number(k);

let _mapToSecCache: Record<string, number> | undefined;
let generatedLoaded = false;

// Lua: map_sections_extract.lua:133
function decode_name_from_rom(rom: Rom, off: number, maxLen = 32): string {
  let out = "";
  for (let i = 0; i <= maxLen - 1; i++) {
    const b = rom.get(off + i);
    if (b === 0xff) break;
    const ch = Object.prototype.hasOwnProperty.call(TextIR.CHARMAP, b) ? TextIR.CHARMAP[b] : undefined;
    if (ch !== undefined) out += ch;
    else if (b >= 0xbb && b <= 0xd4) out += String.fromCharCode(65 + (b - 0xbb));
    else if (b >= 0xd5 && b <= 0xee) out += String.fromCharCode(97 + (b - 0xd5));
  }
  return out;
}

// Lua: map_sections_extract.lua:190
function normalize_map_name(mapId: unknown): string {
  if (typeof mapId !== "string") return "";
  let s = mapId.replace(/^FR_/, "").replace(/^SEVII_/, "");
  s = s.replace(/([a-z])([A-Z])/g, "$1_$2");
  s = s.replace(/([A-Za-z])(\d)/g, "$1_$2");
  s = s.replace(/(\d)([A-Za-z])/g, "$1_$2");
  s = s.replace(/-/g, "_").replace(/[a-z]+/g, (m) => m.toUpperCase());
  return s;
}

/**
 * Lua: map_sections_extract.lua:210
 * NOT FAITHFUL: the Lua also tries love.filesystem and io.open, and mounts
 * Dataset's extract roots first; here CacheFs (the bound cache) is the store.
 */
function load_map_tree_cache(): Record<string, number> {
  if (_mapToSecCache) return _mapToSecCache;
  _mapToSecCache = {};
  const read = (rel: string): string | undefined => {
    try { return CacheFs.read(rel); } catch { return undefined; }
  };

  const rawCensus = read("data/generated/gba/map_tree/census.json") ?? read("map_tree/census.json");
  if (rawCensus !== undefined) {
    let census: any;
    try { census = Json.decode(rawCensus); } catch { census = undefined; }
    if (census && census.groups) {
      for (const g of census.groups as any[]) {
        for (const m of (g.maps ?? []) as any[]) {
          const slot = m.slot;
          const rawH = read("data/generated/gba/map_tree/maps/" + slot + "/header.json")
            ?? read("map_tree/maps/" + slot + "/header.json");
          if (rawH !== undefined) {
            let h: any;
            try { h = Json.decode(rawH); } catch { h = undefined; }
            if (h && h.regionMapSectionId !== undefined && h.regionMapSectionId !== null && h.regionMapSectionId !== false) {
              const sid = h.regionMapSectionId;
              _mapToSecCache[m.id] = sid;
              _mapToSecCache[slot] = sid;
              _mapToSecCache[String(m.id).replace(/[a-z]+/g, (x) => x.toUpperCase())] = sid;
              const norm = normalize_map_name(m.id);
              _mapToSecCache[norm] = sid;
              _mapToSecCache["FR_" + norm] = sid;
            }
          }
        }
      }
    }
  }
  return _mapToSecCache;
}

const upper = (s: string): string => s.replace(/[a-z]+/g, (m) => m.toUpperCase());

export const MapSectionsExtract = {
  KANTO_MAPSEC_START: 88, // 0x58 = MAPSEC_PALLET_TOWN
  SECTIONS,
  ID_TO_SECTION,

  // Lua: map_sections_extract.lua:151 -- authentic place names from the ROM's sMapNames pointer table
  extractNamesFromRom(rom: Rom | undefined): void {
    if (!rom || !rom.u32) return;
    const base: number = Versions.MAPSEC_NAME_POINTERS;
    const count: number = Versions.KANTO_MAPSEC_COUNT;
    const start: number = Versions.KANTO_MAPSEC_START;
    for (let i = 0; i <= count - 1; i++) {
      const secId = start + i;
      const ptr = rom.u32(base + i * 4);
      const off = rom.ptrOffset(ptr);
      if (off !== undefined) {
        const name = decode_name_from_rom(rom, off);
        if (name !== "") {
          if (!SECTIONS[secId]) SECTIONS[secId] = { id: format("MAPSEC_%d", secId), theme: "marble" };
          SECTIONS[secId]!.name = name;
        }
      }
    }
  },

  // Lua: map_sections_extract.lua:176 -- overlay ROM-derived section names onto SECTIONS, once
  installNames(names: Record<number, string>): void {
    for (const k of Object.keys(names)) {
      const sec = SECTIONS[Number(k)];
      if (!sec) throw new Error("no map section " + k);
      sec.name = names[Number(k)];
    }
    generatedLoaded = true;
  },

  /**
   * Lua: map_sections_extract.lua:183
   * NOT FAITHFUL: src/core/game3/dataset is not ported yet; the run's bound
   * cache (CacheFs) stands in for Dataset.cache().
   */
  ensureGenerated(): void {
    if (generatedLoaded) return;
    const cache: Cache = CacheFs.bound();
    const names = MapPreviewExtract.loadNames(cache);
    if (!names) throw new Error("region_map/names.lua is not in the cache");
    MapSectionsExtract.installNames(names);
  },

  // Lua: map_sections_extract.lua:274 -- section info for a mapsec, with the Celadon Dept Store override
  getInfo(secIdIn: unknown, mapId?: string, floorNum?: unknown): MapSectionInfo {
    MapSectionsExtract.ensureGenerated();
    let secId = tonumber(secIdIn);

    if ((secId === undefined || secId < 88) && mapId) {
      const cache = load_map_tree_cache();
      if (cache && cache[mapId] !== undefined) secId = cache[mapId];
      else if (cache && cache[upper(mapId)] !== undefined) secId = cache[upper(mapId)];
    }

    if ((secId === undefined || secId < 88) && mapId) {
      const norm = normalize_map_name(mapId);
      if (norm !== "") {
        const cache = load_map_tree_cache();
        if (cache && cache[norm] !== undefined) secId = cache[norm];
        else if (cache && cache["FR_" + norm] !== undefined) secId = cache["FR_" + norm];
      }
      if (secId === undefined || secId < 88) {
        // Match against SECTIONS.  pairs() order is arbitrary, so a plain
        // substring test let "ROUTE_22" land on MAPSEC_ROUTE_2 (name "ROUTE 2").
        // Pick the exact match, else the longest match, so the result is stable.
        // NOT FAITHFUL (order): ascending mapsec order stands in for pairs().
        let bestId: number | undefined, bestLen: number | undefined;
        for (const k of Object.keys(SECTIONS).map(Number).sort((a, b) => a - b)) {
          const info = SECTIONS[k]!;
          const secKey = info.id.slice(7);
          if (norm === secKey) {
            bestId = k; bestLen = secKey.length;
            break;
          }
          if (norm.includes(secKey) && (bestLen === undefined || secKey.length > bestLen)) {
            bestId = k; bestLen = secKey.length;
          }
        }
        if (bestId !== undefined) secId = bestId;
      }
    }

    // `resolved` tells callers whether the map was actually identified; the
    // Pallet Town table below is the historical default for anything unknown.
    const found = secId !== undefined ? SECTIONS[secId] : undefined;
    const info = found ?? SECTIONS[MapSectionsExtract.KANTO_MAPSEC_START]!;

    let name = info.name as string;
    let theme = info.theme ?? "marble";

    // pokefirered/src/region_map.c:3782 IsCeladonDeptStoreMapsec
    if (mapId && typeof mapId === "string") {
      const up = upper(mapId);
      if (up.includes("CELADON") && (up.includes("DEPARTMENT") || up.includes("DEPT"))) {
        name = SECTIONS[196]!.name as string;
        theme = SECTIONS[196]!.theme;
      }
    }

    const rawName = name;

    // Append floor suffix (pokefirered/src/map_name_popup.c:205)
    const floor = tonumber(floorNum) ?? 0;
    if (floor === 127) name = name + " ROOFTOP";
    else if (floor < 0) name = format("%s B%dF", name, -floor);
    else if (floor > 0) name = format("%s %dF", name, floor);

    return {
      secId: secId ?? 88,
      id: info.id,
      name,
      rawName,
      theme,
      floorNum: floor,
      resolved: found !== undefined,
    };
  },

  // Lua: map_sections_extract.lua:358 -- a clean place name (no floor suffix)
  getPlaceName(mapId?: string, secId?: unknown): string | undefined {
    const info = MapSectionsExtract.getInfo(secId, mapId, 0);
    return info ? (info.rawName ?? info.name) : undefined;
  },

  // Lua: map_sections_extract.lua:364
  formatLua(): string {
    const lines = [
      "-- Generated map section definitions and popup themes.",
      "-- Extracted directly from ROM sMapNames table.",
      "return {",
      "  KANTO_MAPSEC_START = " + MapSectionsExtract.KANTO_MAPSEC_START + ",",
      "  sections = {",
    ];
    for (let secId = 88; secId <= 196; secId++) {
      const s = SECTIONS[secId];
      if (s) {
        if (s.name === undefined) throw new Error("bad argument #4 to 'format' (string expected, got nil)");
        lines.push(format("    [%d] = { id = %q, name = %q, theme = %q },", secId, s.id, s.name, s.theme));
      }
    }
    lines.push("  },");
    lines.push("}");
    lines.push("");
    return lines.join("\n");
  },

  // Lua: map_sections_extract.lua:388 -- extract from ROM and write to the cache root
  // NOT FAITHFUL: the Lua's last-resort io.open writes are not ported.
  run(rom: Rom | undefined, cache: Cache | undefined, opts: { cacheRoot?: string } = {}): boolean {
    if (rom) MapSectionsExtract.extractNamesFromRom(rom);
    const root = opts.cacheRoot ?? "data/generated/gba";
    const content = MapSectionsExtract.formatLua();
    if (cache && cache.write) {
      cache.write(root + "/region_map/map_sections.lua", content);
      cache.write(root + "/map_sections.lua", content);
    } else {
      try { CacheFs.write(root + "/region_map/map_sections.lua", content); } catch { /* pcall */ }
      try { CacheFs.write(root + "/map_sections.lua", content); } catch { /* pcall */ }
    }
    return true;
  },
};

Plans.register("map_sections_extract", MapSectionsExtract as unknown as Record<string, unknown>);

export default MapSectionsExtract;
