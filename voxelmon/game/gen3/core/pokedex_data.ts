// Port of gen1recomp src/core/game3/pokedex_data.lua (GPLv3 + additional terms; see LICENSE.md).
// Core Pokédex Data Query Layer for FRLG Pokédex system.
// Provides access to entries, habitat categories, sorting orders, area markers, and statistics.
//
// NOT FAITHFUL (module): src.import.gba.extract_island1 is not ported (no
// voxelmon/import/gen3/extract_island1.ts). The only member this module reads
// is Extract.CACHE_ROOT, which extract_island1.lua:21 forwards to
// CachePaths.CACHE_ROOT; that is read directly.
// NOT FAITHFUL (scope): the Lua probes package.loaded for runtime /
// scripting.space / scripting.flags / map_sections_extract; here they are
// always imported, so a probe of a loaded module is what runs.

import { format, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { Family } from "../../../import/gen3/family.ts";
import { MapSectionsExtract } from "../../../import/gen3/map_sections_extract.ts";
import { pairs, ipairs, insert, len, seq, type LuaTable } from "../platform/lt.ts";
import { gsub, matchAll } from "../platform/lpattern.ts";
import { luaLoad } from "../platform/luadata.ts";
import { Fs } from "../platform/fs.ts";
import { CachePaths } from "./cache_paths.ts";
import { Dataset } from "./dataset.ts";
import { Dex } from "./dex.ts";
import { Pokemon } from "./pokemon.ts";
import { RomText } from "./rom_text.ts";
import { Profile } from "./profile.ts";
import { Runtime } from "./runtime.ts";
import { Space } from "./scripting/space.ts";
import { Flags } from "./scripting/flags.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";

const isTable = (v: unknown): v is LuaTable => v !== null && typeof v === "object";

/** What PokedexData.getEntry returns. */
export interface DexEntry {
  category: string;
  categoryName: string;
  heightDm: number;
  weightHg: number;
  heightFormatted: string;
  weightFormatted: string;
  description: string;
  description2: string;
  pokemonScale: number;
  pokemonOffset: number;
  trainerScale: number;
  trainerOffset: number;
}

// Lua: pokedex_data.lua:17
function cache_root(): string {
  // Lua: pcall(require, "src.core.game3.dataset") -- always loads here
  if (Dataset && Dataset.mountExtractRoots) {
    Dataset.mountExtractRoots();
  }
  // Lua: Extract.CACHE_ROOT or "data/generated/gba" (see the header note)
  return CachePaths.CACHE_ROOT || "data/generated/gba";
}

// Lua: pokedex_data.lua:25
function read_bytes(rel: string): string | undefined {
  if (Dataset && Dataset.cache) {
    const d = Dataset.cache().read(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  // Lua: pcall(require, "src.import.CacheFs")
  if (CacheFs && CacheFs.readActive) {
    const d = CacheFs.readActive(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  const candidates = seq(
    rel,
    "data/generated/gba/" + gsub(rel, "^data/generated/gba/", "")[0],
  );
  for (const [, p] of ipairs<string>(candidates)) {
    // NOT FAITHFUL: io.open(p, "rb") -- there is no stdio on the 3DS; the
    // platform filesystem (Fs.read) reads the same relative path.
    const d = Fs.read(p);
    if (d !== undefined && d.length > 0) return d;
  }
  return undefined;
}

// Lua: pokedex_data.lua:51
function load_lua(rel: string): any {
  const src = read_bytes(rel);
  if (!truthy(src)) return undefined;
  const [chunk] = luaLoad(src, "@" + rel);
  if (!chunk) return undefined;
  try {
    return chunk();
  } catch {
    return undefined;
  }
}

// Lua: pokedex_data.lua:72
const AREA_TO_MAP: Record<string, string> = {
  DEX_AREA_ONE_ISLAND: "one_island",
  DEX_AREA_KINDLE_ROAD: "one_island",
  DEX_AREA_TREASURE_BEACH: "one_island",
  DEX_AREA_MT_EMBER: "one_island",

  DEX_AREA_TWO_ISLAND: "two_island",
  DEX_AREA_CAPE_BRINK: "two_island",

  DEX_AREA_THREE_ISLAND: "three_island",
  DEX_AREA_BOND_BRIDGE: "three_island",
  DEX_AREA_THREE_ISLE_PATH: "three_island",
  DEX_AREA_BERRY_FOREST: "three_island",

  DEX_AREA_FOUR_ISLAND: "four_island",
  DEX_AREA_ICEFALL_CAVE: "four_island",

  DEX_AREA_FIVE_ISLAND: "five_island",
  DEX_AREA_RESORT_GORGEOUS: "five_island",
  DEX_AREA_WATER_LABYRINTH: "five_island",
  DEX_AREA_FIVE_ISLE_MEADOW: "five_island",
  DEX_AREA_MEMORIAL_PILLAR: "five_island",
  DEX_AREA_LOST_CAVE: "five_island",

  DEX_AREA_SIX_ISLAND: "six_island",
  DEX_AREA_OUTCAST_ISLAND: "six_island",
  DEX_AREA_GREEN_PATH: "six_island",
  DEX_AREA_WATER_PATH: "six_island",
  DEX_AREA_RUIN_VALLEY: "six_island",
  DEX_AREA_DOTTED_HOLE: "six_island",
  DEX_AREA_PATTERN_BUSH: "six_island",
  DEX_AREA_ALTERING_CAVE: "six_island",

  DEX_AREA_SEVEN_ISLAND: "seven_island",
  DEX_AREA_TRAINER_TOWER: "seven_island",
  DEX_AREA_CANYON_ENTRANCE: "seven_island",
  DEX_AREA_SEVAULT_CANYON: "seven_island",
  DEX_AREA_TANOBY_RUINS: "seven_island",
  DEX_AREA_TANOBY_CHAMBER: "seven_island",
};

export const PokedexData = {
  _entries: undefined as any,
  _categories: undefined as any,
  _orders: undefined as any,
  _areaData: undefined as any,
  _speciesWildAreas: undefined as Record<number, LuaTable> | undefined,

  // Lua: pokedex_data.lua:61
  init(): boolean {
    if (truthy(PokedexData._entries)) return true;
    const root = cache_root() + "/pokemon/pokedex";
    PokedexData._entries = load_lua(root + "/entries.lua") ?? {};
    PokedexData._categories = load_lua(root + "/categories.lua") ?? {};
    PokedexData._orders = load_lua(root + "/orders.lua") ?? {};
    PokedexData._areaData = load_lua(root + "/area_markers.lua") ?? { markers: {}, mapsecToArea: {} };
    PokedexData._buildSpeciesWildAreas();
    return true;
  },

  // Lua: pokedex_data.lua:113
  getAreaMapKey(dexAreaKey: string | undefined): string {
    if (!truthy(dexAreaKey)) return "kanto";
    return AREA_TO_MAP[dexAreaKey as string] ?? "kanto";
  },

  /** Map wild encounter tables to species DEX_AREA locations */
  // Lua: pokedex_data.lua:119
  // NOT FAITHFUL (order): pairs(encounters) runs in JS key order, not
  // LuaJIT's hash order, so a species' area list may come out in another order.
  _buildSpeciesWildAreas(): void {
    const areas: Record<number, LuaTable> = {};
    PokedexData._speciesWildAreas = areas;
    const encounters = load_lua(cache_root() + "/encounters.lua")
      ?? load_lua("data/generated/gba/encounters.lua")
      ?? load_lua("data/generated/encounters.lua");
    const family = Family.active();
    const mapGroups = family.groups();
    const mapsecToArea = (PokedexData._areaData && PokedexData._areaData.mapsecToArea) ?? {};
    const markers = (PokedexData._areaData && PokedexData._areaData.markers) ?? {};
    // Lua: package.loaded / pcall(require, "src.import.gba.map_sections_extract")
    const MSE = MapSectionsExtract;

    if (truthy(encounters) && truthy(mapGroups) && truthy(mapGroups.groups)) {
      for (const [key, header] of pairs<any>(encounters)) {
        let gIdx: number | undefined = header.mapGroup, mIdx: number | undefined = header.mapNum;
        if (gIdx == null || mIdx == null) {
          const caps = matchAll(tostring(key), "^(%d+):(%d+)$");
          if (caps) {
            gIdx = tonumber(caps[0]);
            mIdx = tonumber(caps[1]);
          }
        }
        if (gIdx != null && mIdx != null) {
          const gTable = mapGroups.groups[gIdx] ?? mapGroups.groups[gIdx + 1];
          const pretName: string | undefined = gTable && gTable.maps
            ? (gTable.maps[mIdx + 1] ?? gTable.maps[mIdx]) : undefined;
          let secIdStr: string | undefined;
          if (truthy(family.aliases) && MSE && MSE.getInfo) {
            const info = MSE.getInfo(undefined, pretName);
            secIdStr = info ? info.id : undefined;
          }

          let dexArea: string | undefined = secIdStr != null ? mapsecToArea[secIdStr] : undefined;
          if (!truthy(dexArea) && truthy(pretName)) {
            let s = gsub(tostring(pretName), "^FR_", "")[0];
            s = gsub(s, "^SEVII_", "")[0];
            s = gsub(s, "([a-z])([A-Z])", "%1_%2")[0];
            const norm = "DEX_AREA_" + s.toUpperCase();
            if (truthy(markers[norm])) dexArea = norm;
          }

          if (truthy(dexArea) && (truthy(markers[dexArea as string]) || (secIdStr != null && truthy(mapsecToArea[secIdStr])))) {
            const area = dexArea as string;
            const addSpecies = (sp: any): void => {
              if (!truthy(sp) || sp === 0) return;
              areas[sp] = areas[sp] ?? seq();
              let exists = false;
              for (const [, a] of ipairs(areas[sp])) {
                if (a === area) { exists = true; break; }
              }
              if (!exists) {
                insert(areas[sp], area);
              }
            };

            for (const [, tableKey] of ipairs<string>(seq("land", "water", "rockSmash", "fishing"))) {
              const t = header[tableKey];
              if (truthy(t) && truthy(t.slots)) {
                for (const [, slot] of ipairs<any>(t.slots)) {
                  addSpecies(slot.species);
                }
              }
            }
          }
        }
      }
    }
  },

  // Lua: pokedex_data.lua:185
  getEntry(speciesId: unknown): DexEntry {
    PokedexData.init();
    const sp = tonumber(speciesId) ?? 1;
    // src/data/pokemon/pokedex_entries.h:3 NATIONAL_DEX_NONE
    let raw = PokedexData._entries[sp];
    if (!truthy(raw)) {
      raw = PokedexData._entries[0];
      if (!truthy(raw)) throw new Error("pokemon/pokedex/entries.lua has no NATIONAL_DEX_NONE entry");
    }

    const dm: number = raw.height ?? 0;
    let inchesTenths = Math.floor(10000 * dm / 254);
    if (inchesTenths % 10 >= 5) {
      inchesTenths = inchesTenths + 10;
    }
    const feet = Math.floor(inchesTenths / 120);
    const inches = Math.floor((inchesTenths - feet * 120) / 10);
    const heightFormatted = format("%2d'%02d\"", feet, inches);

    const hg: number = raw.weight ?? 0;
    let lbsHund = Math.floor((hg * 100000) / 4536);
    if (lbsHund % 10 >= 5) {
      lbsHund = lbsHund + 10;
    }
    const wholeLbs = Math.floor(lbsHund / 100);
    const fracLbs = Math.floor((lbsHund % 100) / 10);
    // src/pokedex_screen.c:2846
    const weightFormatted = format("%4d.%d ", wholeLbs, fracLbs) + RomText.plain("gText_Lbs");

    const cat = raw.category;
    // src/pokedex_screen.c:2703
    const categoryName = cat + RomText.plain("gText_PokedexPokemon");

    return {
      category: cat,
      categoryName,
      heightDm: dm,
      weightHg: hg,
      heightFormatted,
      weightFormatted,
      description: raw.description ?? "",
      description2: (truthy(raw.description2) && raw.description2.length > 0) ? raw.description2 : (raw.description ?? ""),
      pokemonScale: raw.pokemonScale ?? 256,
      pokemonOffset: raw.pokemonOffset ?? 0,
      trainerScale: raw.trainerScale ?? 256,
      trainerOffset: raw.trainerOffset ?? 0,
    };
  },

  // Lua: pokedex_data.lua:231
  getCategoryPages(categoryKey: string): LuaTable {
    PokedexData.init();
    return (PokedexData._categories && PokedexData._categories[categoryKey]) ?? {};
  },

  // Lua: pokedex_data.lua:236
  getUnlockedCategoryPages(categoryKey: string, dex: any): LuaTable {
    PokedexData.init();
    const allPages = PokedexData.getCategoryPages(categoryKey);
    const unlocked: LuaTable = seq();
    for (const [pageIdx, page] of ipairs(allPages)) {
      const seenMons: LuaTable = seq();
      for (const [, sp] of ipairs(page)) {
        if (Dex.isSeen(dex, sp)) {
          insert(seenMons, sp);
        }
      }
      if (len(seenMons) > 0) {
        insert(unlocked, {
          rawPage: pageIdx,
          mons: seenMons,
        });
      }
    }
    return unlocked;
  },

  // Lua: pokedex_data.lua:257
  getOrderList(orderKey: string, dex?: any): LuaTable {
    PokedexData.init();
    const rawList = (PokedexData._orders && PokedexData._orders[orderKey]) ?? {};
    if (!truthy(dex)) {
      return rawList;
    }

    const isNat = PokedexData.isNationalUnlocked(undefined, dex);
    const maxN = isNat ? (Dex.NATIONAL_MAX ?? 386) : (Dex.KANTO_MAX ?? 151);

    if (orderKey === "numerical_kanto") {
      const maxKanto = Dex.KANTO_MAX ?? 151;
      let highestSeen = 0;
      for (let i = 1; i <= maxKanto; i++) {
        if (Dex.isSeen(dex, i)) {
          highestSeen = i;
        }
      }
      const result: LuaTable = seq();
      for (let i = 1; i <= highestSeen; i++) {
        insert(result, i);
      }
      return result;
    } else if (orderKey === "numerical_national") {
      const maxNat = Dex.NATIONAL_MAX ?? 386;
      let highestSeen = 0;
      for (let nat = 1; nat <= maxNat; nat++) {
        if (Dex.isSeen(dex, Pokemon.speciesFromNational(nat))) {
          highestSeen = nat;
        }
      }
      const result: LuaTable = seq();
      for (let nat = 1; nat <= highestSeen; nat++) {
        insert(result, Pokemon.speciesFromNational(nat));
      }
      return result;
    } else if (orderKey === "atoz") {
      // pokefirered/src/pokedex_screen.c:1404
      const result: LuaTable = seq();
      for (const [, nat] of ipairs<number>(rawList)) {
        const sp = Pokemon.speciesFromNational(nat);
        if (nat <= maxN && truthy(sp) && Dex.isSeen(dex, sp)) {
          insert(result, sp);
        }
      }
      return result;
    } else if (orderKey === "lightest" || orderKey === "smallest") {
      // pokefirered/src/pokedex_screen.c:1438
      const result: LuaTable = seq();
      for (const [, nat] of ipairs<number>(rawList)) {
        const sp = Pokemon.speciesFromNational(nat);
        if (nat <= maxN && truthy(sp) && Dex.isCaught(dex, sp)) {
          insert(result, sp);
        }
      }
      return result;
    } else if (orderKey === "type") {
      // pokefirered/src/pokedex_screen.c:1421
      const result: LuaTable = seq();
      for (const [, sp] of ipairs<number>(rawList)) {
        const nat = Pokemon.national(sp);
        if (nat != null && nat <= maxN && Dex.isCaught(dex, sp)) {
          insert(result, sp);
        }
      }
      return result;
    }

    return rawList;
  },

  // Lua: pokedex_data.lua:328
  getWildAreasForSpecies(speciesId: unknown): LuaTable {
    PokedexData.init();
    const sp = tonumber(speciesId) ?? 1;
    const dynamic = PokedexData._speciesWildAreas && PokedexData._speciesWildAreas[sp];
    if (truthy(dynamic) && len(dynamic) > 0) return dynamic;
    return (PokedexData._areaData && PokedexData._areaData.speciesAreas && PokedexData._areaData.speciesAreas[sp])
      ?? {};
  },

  // Lua: pokedex_data.lua:337
  getAreaMarker(dexAreaKey: string): any {
    PokedexData.init();
    return PokedexData._areaData && PokedexData._areaData.markers ? PokedexData._areaData.markers[dexAreaKey] : undefined;
  },

  // Lua: pokedex_data.lua:342
  isNationalUnlocked(session?: any, dex?: any): boolean {
    const P = Profile.forSession(session);
    if ((P.family ?? "frlg") !== "frlg") {
      const cur = session ?? (Runtime && Runtime.getSession ? Runtime.getSession() : undefined);
      const store = (cur && cur.store) ?? (Space && Space.store) ?? cur;
      return Dex.nationalEnabled({
        version: P.id, dex: dex ?? (cur ? cur.dex : undefined),
        flags: store ? store.flags : undefined, vars: store ? store.vars : undefined,
      });
    }
    if (truthy(dex) && (truthy(dex.nationalUnlocked) || truthy(dex.isNationalUnlocked))) {
      return true;
    }
    if (truthy(session) && (truthy(session.national_dex_unlocked) || (truthy(session.save) && truthy(session.save.national_dex_unlocked)))) {
      return true;
    }
    const curSession = session ?? (Runtime && Runtime.getSession ? Runtime.getSession() : undefined);
    if (truthy(curSession) && (truthy(curSession.national_dex_unlocked) || (truthy(curSession.dex) && truthy(curSession.dex.nationalUnlocked)))) {
      return true;
    }
    const store = (curSession ? curSession.store : undefined) ?? (Space ? Space.store : undefined);
    if (truthy(store) && Flags && Flags.getFlag) {
      if (Flags.getFlag(store, undefined, 0x840) === true) { // FLAG_SYS_NATIONAL_DEX
        return true;
      }
      if (Flags.getVar && Flags.getVar(store, undefined, 0x404E) === 0x6258) { // VAR_NATIONAL_DEX
        return true;
      }
    }
    return false;
  },

  // Lua: pokedex_data.lua:379
  isCategoryUnlocked(dex: any, categoryKey: string): boolean {
    PokedexData.init();
    const pages = PokedexData.getCategoryPages(categoryKey);
    if (!truthy(pages) || len(pages) === 0) return false;
    for (const [, page] of ipairs(pages)) {
      for (const [, sp] of ipairs(page)) {
        if (Dex.isSeen(dex, sp)) {
          return true;
        }
      }
    }
    return false;
  },

  // Lua: pokedex_data.lua:393 -- returns seen, caught, total
  countCategory(dex: any, categoryKey: string): [number, number, number] {
    const pages = PokedexData.getCategoryPages(categoryKey);
    let seen = 0, caught = 0, total = 0;
    for (const [, p] of ipairs(pages)) {
      for (const [, sp] of ipairs(p)) {
        total = total + 1;
        if (Dex.isSeen(dex, sp)) seen = seen + 1;
        if (Dex.isCaught(dex, sp)) caught = caught + 1;
      }
    }
    return [seen, caught, total];
  },

  // Lua: pokedex_data.lua:406 -- returns seen, caught, total
  countOrder(dex: any, orderKey: string): [number, number, number] {
    const list = PokedexData.getOrderList(orderKey);
    let seen = 0, caught = 0;
    const total = len(list);
    for (const [, sp] of ipairs(list)) {
      if (Dex.isSeen(dex, sp)) seen = seen + 1;
      if (Dex.isCaught(dex, sp)) caught = caught + 1;
    }
    return [seen, caught, total];
  },
};

export default PokedexData;
