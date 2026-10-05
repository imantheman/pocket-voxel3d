// Port of gen1recomp src/import/gba/heal_locations_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/heal_location.c:28, pokefirered/src/region_map.c:828
// Whiteout respawn points and Fly destinations -> region_map/heal_locations.lua
// + region_map/fly_destinations.lua. The heal_row model (buildHealRow,
// sMapHealLocations) is the RSE layout; FRLG builds with build().
// Lua differences: plan lists are 0-based arrays of what the Lua builds as
// sequences (heal[i + 1] is heal[i] here; heal ids keep their game values).

import { Versions } from "./versions.ts";
import { MapCatalog } from "./map_catalog.ts";
import { MapSectionsExtract } from "./map_sections_extract.ts";
import { GameVersion } from "./game_version.ts";
import { Constants } from "../../game/gen3/core/constants.ts";
import { Plans } from "./plans.ts";
import { format, tostring } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

export interface HealRow {
  id: number; map: string; x: number; y: number;
  healerLocalId?: number; flyMap?: string; flyX?: number; flyY?: number; name?: string;
}
export interface FlyRow {
  mapsec: number; id: string; map: string; x: number; y: number; healLocation: number; townMap?: string;
}
export interface HealPlan {
  model?: string;
  heal: HealRow[];
  fly: FlyRow[];
  mapWarps?: { mapsec: number; id: string; map: string }[];
}

export interface HealOpts {
  cacheRoot?: string; force?: boolean; strict?: boolean;
  healBase?: number; respawnBase?: number; npcBase?: number; flyBase?: number;
  healCount?: number; flyCount?: number; mapHealBase?: number; mapHealCount?: number;
}

// pokefirered/src/heal_location.c:89
const RESPAWN_TILE: Record<string, { x: number; y: number }> = {
  FR_PLAYERS_HOUSE_1F: { x: 8, y: 5 },
  FR_INDIGO_PLATEAU_POKEMON_CENTER_1F: { x: 13, y: 12 },
  SEVII_ONE_ISLAND_POKECENTER: { x: 5, y: 4 },
  FR_TRAINER_TOWER_LOBBY: { x: 4, y: 11 },
};

// pokefirered/src/heal_location.c:110
const RESPAWN_TILE_DEFAULT = { x: 7, y: 4 };

// Lua: heal_locations_extract.lua:42 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: heal_locations_extract.lua:50
function s16(v: number): number {
  v = v % 65536;
  if (v >= 32768) return v - 65536;
  return v;
}

// Lua: heal_locations_extract.lua:133
function constantName(kind: string, id: number, prefix: string): string | undefined {
  const C = Constants.of(GameVersion.get());
  if (!C[kind]) return undefined;
  return C.name(kind, id, prefix);
}

// Lua: heal_locations_extract.lua:139
function s8(v: number): number {
  if (v >= 128) return v - 256;
  return v;
}

// Lua: heal_locations_extract.lua:199
function formatHealRow(plan: HealPlan): string {
  const lines = [
    "-- Generated heal locations (sHealLocations). Sourced from pret/pokeemerald",
    "-- src/data/heal_locations.h.",
    "local heal = {",
  ];
  for (const row of plan.heal) {
    const name = row.name !== undefined ? format(", name = %q", row.name) : "";
    lines.push(format("  [%d] = { map = %q, x = %d, y = %d%s },", row.id, row.map, row.x, row.y, name));
  }
  lines.push("}");
  lines.push("");
  lines.push("return {");
  lines.push(format("  version = %d,", HealLocationsExtract.FORMAT_VERSION));
  lines.push(format("  model = %q,", plan.model));
  lines.push("  whiteout = heal,");
  lines.push("  heal_locations = heal,");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: heal_locations_extract.lua:222
function secKey(row: { id?: string; mapsec: number }): string {
  if (row.id !== undefined) return row.id;
  return format("[%d]", row.mapsec);
}

// Lua: heal_locations_extract.lua:227
function formatFlyHealRow(plan: HealPlan): string {
  const lines = [
    "-- Generated Fly destinations (sMapHealLocations resolved through",
    "-- sHealLocations). Sourced from pret/pokeemerald src/region_map.c.",
    "return {",
    format("  version = %d,", HealLocationsExtract.FORMAT_VERSION),
    format("  model = %q,", plan.model),
    "  fly_destinations = {",
  ];
  for (const row of plan.fly) {
    lines.push(format("    %s = { mapsec = %d, map = %q, x = %d, y = %d, healLocation = %d, townMap = %q },",
      secKey(row), row.mapsec, row.map, row.x, row.y, row.healLocation, row.townMap));
  }
  lines.push("  },");
  lines.push("  map_warps = {");
  for (const row of plan.mapWarps ?? []) {
    lines.push(format("    %s = { mapsec = %d, map = %q },", secKey(row), row.mapsec, row.map));
  }
  lines.push("  },");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: heal_locations_extract.lua:254
function formatHealLocations(plan: HealPlan): string {
  const lines = [
    "-- Generated whiteout respawn points (sWhiteoutRespawnHealCenterMapIdxs,",
    "-- sWhiteoutRespawnHealerNpcIds). Sourced from pret/pokefirered",
    "-- src/heal_location.c SetWhiteoutRespawnWarpAndHealerNpc.",
    "local whiteout = {",
  ];
  for (const row of plan.heal) {
    lines.push(format("  [%d] = { map = %q, x = %d, y = %d, healerLocalId = %d },",
      row.id, row.map, row.x, row.y, row.healerLocalId));
  }
  lines.push("}");
  lines.push("");
  lines.push("return {");
  lines.push(format("  version = %d,", HealLocationsExtract.FORMAT_VERSION));
  lines.push("  whiteout = whiteout,");
  lines.push("  heal_locations = whiteout,");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: heal_locations_extract.lua:276
function formatFlyDestinations(plan: HealPlan): string {
  const lines = [
    "-- Generated Fly destinations (sMapFlyDestinations resolved through",
    "-- sHealLocations). Sourced from pret/pokefirered src/region_map.c",
    "-- SetFlyWarpDestination and src/heal_location.c.",
    "return {",
    format("  version = %d,", HealLocationsExtract.FORMAT_VERSION),
    "  fly_destinations = {",
  ];
  for (const row of plan.fly) {
    lines.push(format("    %s = { mapsec = %d, map = %q, x = %d, y = %d, healLocation = %d },",
      row.id, row.mapsec, row.map, row.x, row.y, row.healLocation));
  }
  lines.push("  },");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: heal_locations_extract.lua:298
function baked(cache: Cache | undefined, rel: string): boolean {
  if (cache && cache.exists) return cache.exists(rel) ? true : false;
  if (cache && cache.read) {
    const d = cache.read(rel);
    return typeof d === "string" && d.length > 8;
  }
  return false;
}

export const HealLocationsExtract = {
  CACHE_SUB: "region_map",
  FORMAT_VERSION: 1,
  FILES: ["heal_locations.lua", "fly_destinations.lua"],
  REQUIRED: ["region_map/heal_locations.lua", "region_map/fly_destinations.lua"],
  HEAL_STRIDE: 8,
  RESPAWN_STRIDE: 4,
  FLY_STRIDE: 3,
  RESPAWN_TILE,
  RESPAWN_TILE_DEFAULT,
  formatHealRow,
  formatFlyHealRow,
  formatHealLocations,
  formatFlyDestinations,

  // Lua: heal_locations_extract.lua:56 -- [plan] or [undefined, err]
  build(rom: Rom | undefined, opts: HealOpts = {}): [HealPlan | undefined, string?] {
    if (!(rom && rom.get)) return [undefined, "missing ROM handle"];
    MapCatalog.rebuildIndex();

    const healBase = opts.healBase ?? Versions.S_HEAL_LOCATIONS;
    const respawnBase = opts.respawnBase ?? Versions.S_WHITEOUT_RESPAWN_MAP_IDXS;
    const npcBase = opts.npcBase ?? Versions.S_WHITEOUT_RESPAWN_HEALER_NPC_IDS;
    const flyBase = opts.flyBase ?? Versions.S_MAP_FLY_DESTINATIONS;
    const healCount = opts.healCount ?? Versions.NUM_HEAL_LOCATIONS;
    const flyCount = opts.flyCount ?? Versions.NUM_MAP_FLY_DESTINATIONS;
    const firstSec = MapSectionsExtract.KANTO_MAPSEC_START;
    if (!(healBase !== undefined && respawnBase !== undefined && npcBase !== undefined && flyBase !== undefined
        && healCount !== undefined && flyCount !== undefined)) {
      return [undefined, "heal location table addresses are not pinned for this ROM"];
    }

    // heal[i] here is the Lua's heal[i + 1] (heal location id i + 1)
    const heal: HealRow[] = [], fly: FlyRow[] = [];
    for (let i = 0; i <= healCount - 1; i++) {
      const o = healBase + i * HealLocationsExtract.HEAL_STRIDE;
      const flyMap = MapCatalog.mapIdFor(rom.get(o), rom.get(o + 1));
      if (!flyMap) {
        return [undefined, format("sHealLocations[%d] map %d:%d is not a known map", i, rom.get(o), rom.get(o + 1))];
      }
      const ro = respawnBase + i * HealLocationsExtract.RESPAWN_STRIDE;
      const respawnMap = MapCatalog.mapIdFor(rom.u16(ro), rom.u16(ro + 2));
      if (!respawnMap) {
        return [undefined, format("sWhiteoutRespawnHealCenterMapIdxs[%d] map %d:%d is not a known map",
          i, rom.u16(ro), rom.u16(ro + 2))];
      }
      const tile = RESPAWN_TILE[respawnMap] ?? RESPAWN_TILE_DEFAULT;
      heal[i] = {
        id: i + 1,
        map: respawnMap,
        x: tile.x,
        y: tile.y,
        healerLocalId: rom.get(npcBase + i),
        flyMap,
        flyX: s16(rom.u16(o + 2)),
        flyY: s16(rom.u16(o + 4)),
      };
    }

    for (let i = 0; i <= flyCount - 1; i++) {
      const o = flyBase + i * HealLocationsExtract.FLY_STRIDE;
      const healId = rom.get(o + 2);
      if (healId !== 0) {
        const row = heal[healId - 1];
        if (!row) {
          return [undefined, format("sMapFlyDestinations[%d] names heal location %d", i, healId)];
        }
        const sec = firstSec + i;
        const info = MapSectionsExtract.SECTIONS[sec];
        if (!(info && info.id)) {
          return [undefined, format("mapsec %d has no symbolic id", sec)];
        }
        const mapId = MapCatalog.mapIdFor(rom.get(o), rom.get(o + 1));
        if (mapId !== row.flyMap) {
          return [undefined, format("mapsec %d flies to %s but heal location %d is %s",
            sec, tostring(mapId), healId, tostring(row.flyMap))];
        }
        fly.push({
          mapsec: sec,
          id: info.id,
          map: row.flyMap!,
          x: row.flyX!,
          y: row.flyY!,
          healLocation: healId,
        });
      }
    }

    if (fly.length === 0) return [undefined, "no Fly destination names a heal location"];

    return [{ heal, fly }];
  },

  // Lua: heal_locations_extract.lua:145 (pokeemerald/src/data/heal_locations.h:6, pokeemerald/src/region_map.c:1981)
  buildHealRow(rom: Rom | undefined, opts: HealOpts = {}): [HealPlan | undefined, string?] {
    if (!(rom && rom.get)) return [undefined, "missing ROM handle"];
    MapCatalog.rebuildIndex();
    const healBase = opts.healBase ?? Versions.S_HEAL_LOCATIONS;
    const healCount = opts.healCount ?? Versions.NUM_HEAL_LOCATIONS;
    const secBase = opts.mapHealBase ?? Versions.MAP_HEAL_LOCATIONS;
    const secCount = opts.mapHealCount ?? Versions.MAP_HEAL_LOCATION_COUNT;

    const heal: HealRow[] = [];
    for (let i = 0; i <= healCount - 1; i++) {
      const o = healBase + i * HealLocationsExtract.HEAL_STRIDE;
      const g = s8(rom.get(o)), n = s8(rom.get(o + 1));
      const map = MapCatalog.mapIdFor(g, n);
      if (!map) {
        return [undefined, format("sHealLocations[%d] map %d:%d is not a known map", i, g, n)];
      }
      heal[i] = {
        id: i + 1,
        name: constantName("heal_locations", i + 1, "HEAL_LOCATION_"),
        map,
        x: rom.u16(o + 2),
        y: rom.u16(o + 4),
      };
    }

    const fly: FlyRow[] = [], warps: { mapsec: number; id: string; map: string }[] = [];
    for (let sec = 0; sec <= secCount - 1; sec++) {
      const o = secBase + sec * HealLocationsExtract.FLY_STRIDE;
      const healId = rom.get(o + 2);
      const townMap = MapCatalog.mapIdFor(rom.get(o), rom.get(o + 1));
      if (!townMap) {
        return [undefined, format("sMapHealLocations[%d] map %d:%d is not a known map",
          sec, rom.get(o), rom.get(o + 1))];
      }
      const id = constantName("region_map_sections", sec, "MAPSEC_")!;
      if (healId !== 0) {
        const row = heal[healId - 1];
        if (!row) {
          return [undefined, format("sMapHealLocations[%d] names heal location %d", sec, healId)];
        }
        fly.push({
          mapsec: sec, id, map: row.map, x: row.x, y: row.y,
          healLocation: healId, townMap,
        });
      } else {
        warps.push({ mapsec: sec, id, map: townMap });
      }
    }
    if (fly.length === 0) return [undefined, "no mapsec names a heal location"];

    return [{ model: "heal_row", heal, fly, mapWarps: warps }];
  },

  // Lua: heal_locations_extract.lua:307
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + HealLocationsExtract.CACHE_SUB;
    for (const name of HealLocationsExtract.FILES) {
      if (!baked(cache, root + "/" + name)) return false;
    }
    return true;
  },

  // Lua: heal_locations_extract.lua:315 -- [ok, detail]
  run(rom: Rom, cache: Cache | undefined, opts: HealOpts = {}): [boolean, any] {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + HealLocationsExtract.CACHE_SUB;
    if (!(cache && cache.write)) return [false, "missing cache handle"];
    if (!opts.force && HealLocationsExtract.ready(cache, cacheRoot)) {
      return [true, { skipped: true }];
    }

    const healRow = Versions.MAP_HEAL_LOCATIONS !== undefined && Versions.MAP_HEAL_LOCATIONS !== null;
    const [plan, err] = healRow ? HealLocationsExtract.buildHealRow(rom, opts) : HealLocationsExtract.build(rom, opts);
    if (!plan) {
      if (opts.strict) throw new Error("heal_locations: " + tostring(err));
      return [false, err];
    }

    if (healRow) {
      cache.write(root + "/heal_locations.lua", formatHealRow(plan));
      cache.write(root + "/fly_destinations.lua", formatFlyHealRow(plan));
    } else {
      cache.write(root + "/heal_locations.lua", formatHealLocations(plan));
      cache.write(root + "/fly_destinations.lua", formatFlyDestinations(plan));
    }

    console.log(format("[heal_locations] %d respawn points + %d Fly destinations -> %s",
      plan.heal.length, plan.fly.length, root));

    return [true, { healLocations: plan.heal.length, flyDestinations: plan.fly.length }];
  },
};

Plans.register("heal_locations_extract", HealLocationsExtract as unknown as Record<string, unknown>);

export default HealLocationsExtract;
