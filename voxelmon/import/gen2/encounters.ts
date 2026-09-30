// Port of gen1recomp RomExtractorGen2.lua:4617-5055 (bdfac727): the wild
// encounter readers (readGrassTable, readWaterTable, readTreeMonMaps,
// readRoamMaps, readRoamMons, readContestMons, readTreeMons) and
// extractEncounters, which writes encounters.lua -> the "encounters" JSON.
//
// Gold only: readAsleepTreeMons (:4863, ../pokecrystal
// data/wild/treemons_asleep.asm) is Crystal-only -- pokegold has no
// AsleepTreeMons* labels, so Brian's gate leaves treeMonsAsleep nil and the
// field is omitted here. roamMons is ported but gated on InitRoamMons the
// way Brian gates it; Gold's manifest does not carry that symbol, so on the
// real ROM roamMons is omitted too (Brian's output is the same).
//
// Conventions: every species byte goes through speciesName (1-based dex id,
// a miss keeps the number) except readTreeMons, which indexes speciesOrder
// directly (a miss OMITS the field, as Lua's nil does). Encounter rates and
// chance bytes are the raw ROM bytes (RGBDS `percent`, 0-255), as Brian keeps
// them.

import type { Gen2Ctx } from "./ctx.ts";
import { lua, speciesName } from "./helpers.ts";
import { mapNameByIds } from "./maps.ts";

/** RomExtractorGen2.lua:45 DAYTIMES (Lua 1-based; DARK is never a grass key). */
export const DAYTIMES = ["MORN", "DAY", "NITE", "DARK"] as const;

/** :4620-4623 — NUM_GRASSMON / NUM_WATERMON and the record lengths
 * (GRASS_WILDDATA_LENGTH 47, WATER_WILDDATA_LENGTH 9). */
export const GRASS_SLOTS = 7;
export const WATER_SLOTS = 3;
export const GRASS_RECORD = 2 + 3 + GRASS_SLOTS * 2 * 3;
export const WATER_RECORD = 2 + 1 + WATER_SLOTS * 2;

/** :3091 romAddrOk — a banked address inside its window (bank 0 below $4000,
 * every other bank $4000-$7FFF). */
export function romAddrOk(bank: number, address: number): boolean {
  if (!Number.isFinite(bank) || !Number.isFinite(address)) return false;
  if (bank < 0 || bank > 0x7f) return false;
  if (bank === 0) return address >= 0 && address < 0x4000;
  return address >= 0x4000 && address < 0x8000;
}

export interface WildSlot {
  level: number;
  species: string | number;
}

/** One grass record: `rates` and `slots` keyed MORN / DAY / NITE; each slot
 * list is a 7-entry array (Lua [1..7]). */
export interface GrassEntry {
  map: string;
  rates: Record<string, number>;
  slots: Record<string, WildSlot[]>;
}

export interface WaterEntry {
  map: string;
  rate: number;
  slots: WildSlot[];
}

/** :4625 readGrassTable — map-keyed; rows whose (group, map) is unknown are
 * skipped, a repeated map keeps the later row. */
export function readGrassTable(ctx: Gen2Ctx, symbolName: string): Record<string, GrassEntry> {
  const { bank, address } = ctx.symbol(symbolName);
  const rom = ctx.rom;
  const out: Record<string, GrassEntry> = {};
  let offset = 0;
  // Terminator-driven but bounded (:4631).
  for (let n = 0; n < 512; n++) {
    const group = rom.byte(bank, address + offset);
    if (group === 0xff) break;
    const mapNum = rom.byte(bank, address + offset + 1);
    const mapId = mapNameByIds(ctx, group, mapNum);
    const rates: Record<string, number> = {};
    for (let i = 0; i < 3; i++) rates[DAYTIMES[i]!] = rom.byte(bank, address + offset + 2 + i);
    const slots: Record<string, WildSlot[]> = {};
    for (let day = 0; day < 3; day++) {
      const list: WildSlot[] = [];
      for (let slot = 0; slot < GRASS_SLOTS; slot++) {
        const base = address + offset + 5 + (day * GRASS_SLOTS + slot) * 2;
        list.push({ level: rom.byte(bank, base), species: speciesName(ctx, rom.byte(bank, base + 1)) });
      }
      slots[DAYTIMES[day]!] = list;
    }
    if (mapId) out[mapId] = { map: mapId, rates, slots };
    offset += GRASS_RECORD;
  }
  return out;
}

/** :4662 readWaterTable. */
export function readWaterTable(ctx: Gen2Ctx, symbolName: string): Record<string, WaterEntry> {
  const { bank, address } = ctx.symbol(symbolName);
  const rom = ctx.rom;
  const out: Record<string, WaterEntry> = {};
  let offset = 0;
  for (let n = 0; n < 512; n++) {
    const group = rom.byte(bank, address + offset);
    if (group === 0xff) break;
    const mapNum = rom.byte(bank, address + offset + 1);
    const mapId = mapNameByIds(ctx, group, mapNum);
    const rate = rom.byte(bank, address + offset + 2);
    const slots: WildSlot[] = [];
    for (let slot = 0; slot < WATER_SLOTS; slot++) {
      const base = address + offset + 3 + slot * 2;
      slots.push({ level: rom.byte(bank, base), species: speciesName(ctx, rom.byte(bank, base + 1)) });
    }
    if (mapId) out[mapId] = { map: mapId, rate, slots };
    offset += WATER_RECORD;
  }
  return out;
}

/** :4698 readTreeMonMaps — map -> TREEMON_SET_* name (or the raw set byte
 * when the manifest has no name for it). TreeMonMaps and RockMonMaps share
 * the shape. */
export function readTreeMonMaps(ctx: Gen2Ctx, symbolName: string): Record<string, string | number> {
  const { bank, address } = ctx.symbol(symbolName);
  const setOrder = ctx.manifest.constants.treeMonSetOrder as string[] | undefined;
  const out: Record<string, string | number> = {};
  for (let offset = 0; offset < 0x200; offset += 3) {
    const group = ctx.rom.byte(bank, address + offset);
    if (group === 0xff) break;
    const mapNum = ctx.rom.byte(bank, address + offset + 1);
    const set = ctx.rom.byte(bank, address + offset + 2);
    const mapId = mapNameByIds(ctx, group, mapNum);
    if (mapId) out[mapId] = lua(setOrder, set + 1) ?? set;
  }
  return out;
}

export interface RoamMapRow {
  map: string;
  to: string[];
}

/** :4724 readRoamMaps — ORDER IS BEHAVIOUR (see Brian's comment :4717), so
 * this stays an array in ROM order. Unknown destination maps are dropped
 * from `to`; a row whose own map is unknown is dropped. */
export function readRoamMaps(ctx: Gen2Ctx): RoamMapRow[] {
  const { bank, address } = ctx.symbol("RoamMaps");
  const rom = ctx.rom;
  const out: RoamMapRow[] = [];
  let at = address;
  for (let n = 0; n < 64; n++) {
    const group = rom.byte(bank, at);
    if (group === 0xff) break;
    const mapNum = rom.byte(bank, at + 1);
    const count = rom.byte(bank, at + 2);
    const to: string[] = [];
    for (let i = 0; i < count; i++) {
      const toId = mapNameByIds(ctx, rom.byte(bank, at + 3 + i * 2), rom.byte(bank, at + 4 + i * 2));
      if (toId) to.push(toId);
    }
    const mapId = mapNameByIds(ctx, group, mapNum);
    if (mapId) out.push({ map: mapId, to });
    at += 3 + count * 2 + 1;
  }
  return out;
}

/** :4757-4758 — roam_struct stride and the four opcodes InitRoamMons uses. */
const ROAMMON_STRUCT_LENGTH = 7;
const LD_A_N = 0x3e;
const LD_NN_A = 0xea;
const XOR_A = 0xaf;
const RET = 0xc9;

export interface RoamMon {
  species: string | number;
  level?: number;
  mapGroup?: number;
  mapNumber?: number;
  map?: string;
}

/** :4760 readRoamMons — the roster read out of InitRoamMons' straight-line
 * `ld a, n` / `ld [nn], a` code. Undefined (Lua nil) on any other opcode or
 * an empty roster. */
export function readRoamMons(ctx: Gen2Ctx): RoamMon[] | undefined {
  const { bank, address } = ctx.symbol("InitRoamMons");
  const rom = ctx.rom;
  const writes = new Map<number, number>();
  const order: number[] = [];
  let at = address;
  let acc = 0;
  for (let n = 0; n < 128; n++) {
    if (!romAddrOk(bank, at + 2)) return undefined;
    const op = rom.byte(bank, at);
    if (op === RET) break;
    if (op === XOR_A) {
      acc = 0;
      at += 1;
    } else if (op === LD_A_N) {
      acc = rom.byte(bank, at + 1);
      at += 2;
    } else if (op === LD_NN_A) {
      const dest = rom.word(bank, at + 1);
      if (!writes.has(dest)) order.push(dest);
      writes.set(dest, acc);
      at += 3;
    } else {
      return undefined;
    }
  }
  // :4781 — the first destination written is wRoamMon1Species.
  const base = order[0];
  if (base === undefined) return undefined;
  const roamers: RoamMon[] = [];
  for (let slot = 0; slot < 3; slot++) {
    const at2 = base + slot * ROAMMON_STRUCT_LENGTH;
    const species = writes.get(at2);
    if (!species) break;
    const mon: RoamMon = { species: speciesName(ctx, species) };
    const level = writes.get(at2 + 1);
    const group = writes.get(at2 + 2);
    const number = writes.get(at2 + 3);
    if (level !== undefined) mon.level = level;
    if (group !== undefined) mon.mapGroup = group;
    if (number !== undefined) mon.mapNumber = number;
    const map = mapNameByIds(ctx, group ?? 0, number ?? 0);
    if (map) mon.map = map;
    roamers.push(mon);
  }
  return roamers.length > 0 ? roamers : undefined;
}

export interface ContestMon {
  chance: number;
  species: string | number;
  min: number;
  max: number;
}

const CONTEST_MON_RECORD = 4;

/** :4809 readContestMons — `db %, species, min, max` rows, no terminator;
 * the chance-$ff "always" row ends the read and is kept (:4797-4805). */
export function readContestMons(ctx: Gen2Ctx): ContestMon[] {
  const { bank, address } = ctx.symbol("ContestMons");
  const out: ContestMon[] = [];
  for (let row = 0; row < 32; row++) {
    const base = address + row * CONTEST_MON_RECORD;
    if (!romAddrOk(bank, base + CONTEST_MON_RECORD - 1)) break;
    const raw = ctx.rom.bytes(bank, base, CONTEST_MON_RECORD);
    out.push({ chance: raw[0]!, species: speciesName(ctx, raw[1]!), min: raw[2]!, max: raw[3]! });
    if (raw[0] === 0xff) break;
  }
  return out;
}

export interface TreeMon {
  chance: number;
  /** Omitted when the byte is not a speciesOrder id (Lua nil). */
  species?: string;
  level: number;
}

export interface TreeMonSet {
  common: TreeMon[];
  rare?: TreeMon[];
}

/** :4832 readTreeMons — each TREEMON_SET_* (in treeMonSetOrder, NONE
 * included) is a pointer to its common list then its rare list, each ended
 * by -1; TREEMON_SET_ROCK has only the one list. */
export function readTreeMons(ctx: Gen2Ctx): Record<string, TreeMonSet> {
  const { bank, address } = ctx.symbol("TreeMons");
  const setOrder = (ctx.manifest.constants.treeMonSetOrder as string[] | undefined) ?? [];
  const speciesOrder = ctx.manifest.constants.speciesOrder ?? [];
  const out: Record<string, TreeMonSet> = {};
  setOrder.forEach((name, i) => {
    let at = ctx.rom.word(bank, address + i * 2);
    const list = (): TreeMon[] => {
      const rows: TreeMon[] = [];
      for (let n = 0; n < 16; n++) {
        if (!romAddrOk(bank, at + 2)) break;
        const chance = ctx.rom.byte(bank, at);
        if (chance === 0xff) {
          at += 1;
          break;
        }
        const row: TreeMon = { chance, level: ctx.rom.byte(bank, at + 2) };
        const species = lua(speciesOrder, ctx.rom.byte(bank, at + 1));
        if (species !== undefined) row.species = species;
        rows.push(row);
        at += 3;
      }
      return rows;
    };
    // :4855 RockMonEncounter reads one list.
    if (name === "TREEMON_SET_ROCK") {
      out[name] = { common: list() };
    } else {
      const common = list();
      out[name] = { common, rare: list() };
    }
  });
  return out;
}

export interface FishEntry {
  chance: number;
  species: string | number;
  level: number;
  /** Present on a time_group row (species byte 0): the TimeFishGroups index. */
  timeGroup?: number;
  day?: WildSlot;
  nite?: WildSlot;
}

export interface FishGroup {
  id: string;
  /** The FISHGROUP_* constant value (1-based: FISHGROUP_NONE = 0 has no row). */
  index: number;
  chance: number;
  old: FishEntry[];
  good: FishEntry[];
  super: FishEntry[];
}

export interface TimeFishGroup {
  day: WildSlot;
  nite: WildSlot;
}

/**
 * :4889 extractEncounters -> `{ encounters }`. Shape (Brian's encounters.lua):
 * grass / water / swarmGrass / swarmWater: map id -> entry;
 * fishGroups: FISHGROUP_* -> FishGroup; timeFishGroups: an OBJECT keyed
 * "0".."n-1" (Lua key 0 = TimeFishGroups row 0); trees / rocks: map id ->
 * TREEMON_SET_*; treeSets: TREEMON_SET_* -> {common, rare?}; bugContest and
 * roamMaps: arrays (Lua [1..n]). rocks / bugContest / swarm* / roamMaps /
 * roamMons are omitted when their symbol is absent; treeMonsAsleep is always
 * omitted (Crystal-only, see the file comment).
 */
export function extractEncounters(ctx: Gen2Ctx): Record<string, unknown> {
  const rom = ctx.rom;
  const grass: Record<string, GrassEntry> = {};
  for (const name of ["JohtoGrassWildMons", "KantoGrassWildMons"]) Object.assign(grass, readGrassTable(ctx, name));
  const water: Record<string, WaterEntry> = {};
  for (const name of ["JohtoWaterWildMons", "KantoWaterWildMons"]) Object.assign(water, readWaterTable(ctx, name));

  // :4910 FishGroups / TimeFishGroups. Brian's fallback address (0x6BDE in
  // the FishGroups bank) only applies when the manifest lacks the symbol.
  const fish = ctx.symbol("FishGroups");
  const timeFishLoc = ctx.location("TimeFishGroups");
  const timeFishBank = timeFishLoc ? timeFishLoc[0] : fish.bank;
  const timeFishAddr = timeFishLoc ? timeFishLoc[1] : 0x6bde;
  const timeFishGroups: Record<string, TimeFishGroup> = {};
  for (let idx = 0; idx < 32; idx++) {
    const base = timeFishAddr + idx * 4;
    if (!romAddrOk(timeFishBank, base + 3)) break;
    const daySp = rom.byte(timeFishBank, base);
    const dayLv = rom.byte(timeFishBank, base + 1);
    const niteSp = rom.byte(timeFishBank, base + 2);
    const niteLv = rom.byte(timeFishBank, base + 3);
    if (daySp === 0 || daySp > 251 || niteSp === 0 || niteSp > 251) break;
    timeFishGroups[String(idx)] = {
      day: { species: speciesName(ctx, daySp), level: dayLv },
      nite: { species: speciesName(ctx, niteSp), level: niteLv },
    };
  }

  // :4935 readRod — cumulative-chance rows, ended by the 100% ($ff) row.
  const readRod = (address: number): FishEntry[] => {
    const list: FishEntry[] = [];
    for (let i = 0; i < 8; i++) {
      if (!romAddrOk(fish.bank, address + i * 3 + 2)) break;
      const chance = rom.byte(fish.bank, address + i * 3);
      const species = rom.byte(fish.bank, address + i * 3 + 1);
      const level = rom.byte(fish.bank, address + i * 3 + 2);
      let entry: FishEntry;
      if (species === 0) {
        const tg = timeFishGroups[String(level)];
        entry = tg
          ? { chance, timeGroup: level, day: tg.day, nite: tg.nite, species: tg.day.species, level: tg.day.level }
          : { chance, timeGroup: level, species: 0, level };
      } else {
        entry = { chance, species: speciesName(ctx, species), level };
      }
      list.push(entry);
      if (chance >= 0xfe) break;
    }
    return list;
  };

  // :4975 — row for a group is its id minus one (FISHGROUP_NONE has no row).
  const fishOrder = ctx.manifest.constants.fishGroupOrder ?? [];
  const fishGroups: Record<string, FishGroup> = {};
  for (let i = 1; i < fishOrder.length; i++) {
    const groupId = fishOrder[i]!;
    const base = fish.address + (i - 1) * 7;
    fishGroups[groupId] = {
      id: groupId,
      index: i,
      chance: rom.byte(fish.bank, base),
      old: readRod(rom.word(fish.bank, base + 1)),
      good: readRod(rom.word(fish.bank, base + 3)),
      super: readRod(rom.word(fish.bank, base + 5)),
    };
  }

  // :4990-5004 — headbutt / rock smash / bug contest.
  const trees = readTreeMonMaps(ctx, "TreeMonMaps");
  const rocks = ctx.location("RockMonMaps") ? readTreeMonMaps(ctx, "RockMonMaps") : undefined;
  const treeSets = ctx.location("TreeMons") ? readTreeMons(ctx) : {};
  // :5000 treeMonsAsleep — readAsleepTreeMons dropped (Crystal-only).
  const bugContest = ctx.location("ContestMons") ? readContestMons(ctx) : undefined;

  // :5022-5034 — swarms, roam maps, roamers (pcall'd: any error -> nil).
  const swarmGrass = ctx.location("SwarmGrassWildMons") ? readGrassTable(ctx, "SwarmGrassWildMons") : undefined;
  const swarmWater = ctx.location("SwarmWaterWildMons") ? readWaterTable(ctx, "SwarmWaterWildMons") : undefined;
  const roamMaps = ctx.location("RoamMaps") ? readRoamMaps(ctx) : undefined;
  let roamMons: RoamMon[] | undefined;
  if (ctx.location("InitRoamMons")) {
    try {
      roamMons = readRoamMons(ctx);
    } catch {
      roamMons = undefined;
    }
  }

  const data: Record<string, unknown> = {
    generation: 2,
    source: "ROM:JohtoGrassWildMons/KantoGrassWildMons/*WaterWildMons/FishGroups",
    grass,
    water,
    fishGroups,
    timeFishGroups,
    trees,
  };
  if (rocks) data.rocks = rocks;
  data.treeSets = treeSets;
  if (bugContest) data.bugContest = bugContest;
  if (swarmGrass) data.swarmGrass = swarmGrass;
  if (swarmWater) data.swarmWater = swarmWater;
  if (roamMaps) data.roamMaps = roamMaps;
  if (roamMons) data.roamMons = roamMons;
  return { encounters: data };
}
