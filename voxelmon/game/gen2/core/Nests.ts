// gen1recomp src/core/gen2/Nests.lua at bdfac727 (MIT): where does this
// species live? engine/overworld/wildmons.asm FindNest, behind the Pokedex
// AREA page and the Pokegear MAP card's "<MON>'S NEST" overlay.
//
// FindNest reads exactly three sources: the grass tables (all three times of
// day), the water tables, and the three roamers' CURRENT map (Johto only).
// Headbutt, fishing, the Bug Contest and swarms are absent, so a
// HEADBUTT-only species has no nest -- the cart's answer. Region is decided
// by LANDMARK INDEX (Johto below LANDMARK_PALLET_TOWN, Kanto from it).
//
// `data` is Game2's data table (gen2Landmarks, gen2Maps, gen2Encounters).
// landmarks.order is a 0-based JS array (Lua order[index + 1] -> order[index]).

import { Roamers } from "./Roamers.ts";
import { sortedKeys, tonumber, truthy } from "../platform/lua.ts";

type DataLike = Record<string, any> | null | undefined;

// Lua: Nests.lua:156-158 -- constants/landmark_constants.asm
const LANDMARK_PALLET_TOWN = 0x2e;
const LANDMARK_FAST_SHIP = 0x5e;

// Lua: Nests.lua:160-166
function landmarkIndexOf(data: DataLike, id: string, fallback: number): number {
  const landmarks = data ? data.gen2Landmarks : undefined;
  const records = landmarks ? landmarks.landmarks : undefined;
  const record = records ? records[`LANDMARK_${id}`] : undefined;
  const index = record !== null && typeof record === "object" ? tonumber(record.index) : undefined;
  return index ?? fallback;
}

// Lua: Nests.lua:195-198 -- memoized per landmark table (weak keys).
const byIndex = new WeakMap<object, Record<number, string>>();

// Lua: Nests.lua:200-222 -- index -> LANDMARK_* id. The cache's own row wins
// its own slot; between two newcomers the lower id wins.
function indexTable(landmarks: Record<string, any>): Record<number, string> {
  const hit = byIndex.get(landmarks);
  if (hit) return hit;
  const map: Record<number, string> = {};
  const order: string[] = landmarks.order ?? [];
  const records: Record<string, any> = landmarks.landmarks ?? {};
  for (const id of sortedKeys(records)) {
    const record = records[id];
    const index = record !== null && typeof record === "object" ? record.index : undefined;
    if (index != null && index !== false) {
      const held = map[index];
      if (held === undefined || order[index] === id
          || (order[index] !== held && id < held)) {
        map[index] = id;
      }
    }
  }
  byIndex.set(landmarks, map);
  return map;
}

// Lua: Nests.lua:240-243
function landmarkOfMap(data: DataLike, mapId: string | undefined): number | undefined {
  const def = data && data.gen2Maps && mapId != null ? data.gen2Maps[mapId] : undefined;
  return def ? def.landmark : undefined;
}

// Lua: Nests.lua:245-259 -- every slot list of one entry, all times of day.
// (`ipairs` over each value: a water entry's `slots` is a flat list of slot
// records, whose values are not lists, so -- as in the Lua -- water entries
// never match.)
function tableHasSpecies(entry: unknown, species: unknown): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const slots = (entry as Record<string, any>).slots;
  if (slots === null || typeof slots !== "object") return false;
  for (const key of Object.keys(slots)) {
    const list = slots[key];
    if (Array.isArray(list)) {
      for (const slot of list) {
        if (slot == null) break;
        if (slot && slot.species === species) return true;
      }
    }
  }
  return false;
}

export const Nests = {
  LANDMARK_PALLET_TOWN,
  LANDMARK_FAST_SHIP,

  // Lua: Nests.lua:168-175 -- "johto" / "kanto", or undefined (0, or the
  // FAST_SHIP-and-after specials).
  regionOf(landmark: number | undefined | null, data?: DataLike): "johto" | "kanto" | undefined {
    if (landmark == null || landmark <= 0) return undefined;
    if (landmark >= landmarkIndexOf(data, "FAST_SHIP", LANDMARK_FAST_SHIP)) return undefined;
    const kanto = landmarkIndexOf(data, "PALLET_TOWN", LANDMARK_PALLET_TOWN);
    return landmark < kanto ? "johto" : "kanto";
  },

  // Lua: Nests.lua:224-231 -- the LANDMARK_* id at a map header's landmark
  // byte.
  landmarkId(data: DataLike, index: number | undefined | null): string | undefined {
    const landmarks = data ? data.gen2Landmarks : undefined;
    if (!(truthy(landmarks) && index != null)) return undefined;
    const hit = indexTable(landmarks)[index];
    if (hit !== undefined) return hit;
    return landmarks.order ? landmarks.order[index] ?? undefined : undefined;
  },

  // Lua: Nests.lua:233-238 -- the record behind that byte.
  landmark(data: DataLike, index: number | undefined | null): any {
    const landmarks = data ? data.gen2Landmarks : undefined;
    const id = Nests.landmarkId(data, index);
    return id !== undefined && landmarks.landmarks ? landmarks.landmarks[id] ?? undefined : undefined;
  },

  // Lua: Nests.lua:261-302 -- landmark indices where `species` can be met,
  // ascending. `region` "johto" / "kanto", or undefined for both. Roamers
  // count while Roamers.active (not "has HP": a roamer starts at hp 0).
  find(data: DataLike, species: string, region?: string, save?: Record<string, any> | null): number[] {
    const out: number[] = [];
    const seen: Record<number, boolean> = {};
    const add = (landmark: number | undefined): void => {
      if (landmark == null || landmark <= 0 || seen[landmark]) return;
      const where = Nests.regionOf(landmark, data);
      if (!where) return;
      if (region != null && where !== region) return;
      seen[landmark] = true;
      out.push(landmark);
    };

    const enc = data ? data.gen2Encounters : undefined;
    for (const key of ["grass", "water"]) {
      const tables: Record<string, any> = (enc && enc[key]) ?? {};
      for (const mapId of Object.keys(tables)) {
        if (tableHasSpecies(tables[mapId], species)) add(landmarkOfMap(data, mapId));
      }
    }

    const roamers: any[] = (save && save.roamers) ?? [];
    for (const slot of roamers) {
      if (slot == null) break;
      if (Roamers.active(slot) && slot.species === species) add(landmarkOfMap(data, slot.map));
    }

    out.sort((a, b) => a - b);
    return out;
  },
};

export default Nests;
