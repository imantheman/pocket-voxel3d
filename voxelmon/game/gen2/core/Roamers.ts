// gen1recomp src/core/gen2/Roamers.lua at bdfac727 (MIT): the two pieces of
// world state that override where a wild mon comes from -- the roaming
// legendaries and swarms. ChooseWildEncounter consults both in one breath.
//
//   Roamers  engine/overworld/wildmons.asm InitRoamMons, CheckEncounterRoamMon,
//            UpdateRoamMons, JumpRoamMons, _BackUpMapIndices;
//            engine/battle/core.asm BattleEnd_HandleRoamMons;
//            data/wild/roammon_maps.asm RoamMaps
//   Swarms   engine/events/specials.asm StoreSwarmMapIndices, SetSwarmFlag,
//            CheckSwarmFlag, ActivateFishingSwarm; wildmons.asm
//            _SwarmWildmonCheck; data/wild/swarm_grass.asm, swarm_water.asm
//
// Map identity is the map id string ("ROUTE_42"); GROUP_N_A / MAP_N_A is
// undefined.
//
// Indexing: save.roamers is a 0-based JS array (slot i at roamers[i - 1]);
// the roamer slot numbers this API takes and reports (index 1 Raikou,
// 2 Entei, 3 Suicune) stay 1-based as in the Lua. An injected `random(n)`
// returns 0..n-1 (the Encounter convention).

import { GameVersion } from "../shared/core/GameVersion.ts";
import { Mon } from "../battle/Mon.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { random as rngRandom } from "../platform/rng.ts";
import { mod, truthy } from "../platform/lua.ts";

type SaveLike = Record<string, any> | null | undefined;
/** An injected random: n -> 0..n-1. */
export type RoamRandom = ((n: number) => number) | null | undefined;

export interface RoamerRow {
  species: string;
  level: number;
  map: string | undefined;
}

export interface RoamMapRow {
  map: string;
  to: string[];
}

/** One save.roamers slot (the seven-byte roam_struct). */
export interface RoamerSlot {
  /** undefined once caught or beaten */
  species?: string;
  level?: number;
  /** undefined for GROUP_N_A / MAP_N_A */
  map?: string;
  /** one byte on the cart; 0 = not yet rolled */
  hp?: number;
  dvs?: any;
  [k: string]: unknown;
}

export interface RoamerHit {
  index: number;
  slot: RoamerSlot;
  species: string | undefined;
  level: number | undefined;
}

// Lua: Roamers.lua:35-57 -- roamer.moved (a Gen 2 invention), one event per
// beast that actually changed route.
function emitMoved(index: number, slot: RoamerSlot, from: string | undefined, reason: string): void {
  if (from === slot.map) return;
  if (!Runtime.wants("roamer.moved")) return;
  Runtime.emit("roamer.moved", {
    index, slot, species: slot.species,
    from, to: slot.map, reason,
  });
}

// Lua: Roamers.lua:63-71 -- InitRoamMons written out; species order IS slot
// order.
const SPECIES: RoamerRow[] = [
  { species: "RAIKOU", level: 40, map: "ROUTE_42" },
  { species: "ENTEI", level: 40, map: "ROUTE_37" },
  { species: "SUICUNE", level: 40, map: "ROUTE_38" },
];
const LEVEL = 40;

// Lua: Roamers.lua:74-81
function startMapFor(species: string): string | undefined {
  for (const row of SPECIES) {
    if (row.species === species) return row.map;
  }
  return undefined;
}

// Lua: Roamers.lua:97-123 -- data/wild/roammon_maps.asm, in order (order is
// behaviour: `.Update` indexes connections, JumpRoamMon indexes entries).
// Routes 40 and 41 are absent (water).
const NUM_MAPS = 16;
const MAPS: RoamMapRow[] = [
  { map: "ROUTE_29", to: ["ROUTE_30", "ROUTE_46"] },
  { map: "ROUTE_30", to: ["ROUTE_29", "ROUTE_31"] },
  { map: "ROUTE_31", to: ["ROUTE_30", "ROUTE_32", "ROUTE_36"] },
  { map: "ROUTE_32", to: ["ROUTE_36", "ROUTE_31", "ROUTE_33"] },
  { map: "ROUTE_33", to: ["ROUTE_32", "ROUTE_34"] },
  { map: "ROUTE_34", to: ["ROUTE_33", "ROUTE_35"] },
  { map: "ROUTE_35", to: ["ROUTE_34", "ROUTE_36"] },
  { map: "ROUTE_36", to: ["ROUTE_35", "ROUTE_31", "ROUTE_32", "ROUTE_37"] },
  { map: "ROUTE_37", to: ["ROUTE_36", "ROUTE_38", "ROUTE_42"] },
  { map: "ROUTE_38", to: ["ROUTE_37", "ROUTE_39", "ROUTE_42"] },
  { map: "ROUTE_39", to: ["ROUTE_38"] },
  { map: "ROUTE_42", to: ["ROUTE_43", "ROUTE_44", "ROUTE_37", "ROUTE_38"] },
  { map: "ROUTE_43", to: ["ROUTE_42", "ROUTE_44"] },
  { map: "ROUTE_44", to: ["ROUTE_42", "ROUTE_43", "ROUTE_45"] },
  { map: "ROUTE_45", to: ["ROUTE_44", "ROUTE_46"] },
  { map: "ROUTE_46", to: ["ROUTE_45", "ROUTE_29"] },
];

// Lua: Roamers.lua:145-153 -- 0 .. n-1.
function rand(random: RoamRandom, n: number): number {
  if (random) return random(n);
  return rngRandom(n) - 1;
}

// Lua: Roamers.lua:229 -- the roam struct's HP is one byte.
const MAX_STORED_HP = 255;

// Lua: Roamers.lua:436-451 -- data/wild/flee_mons.asm AlwaysFleeMons per
// engine (pokegold lists Suicune; pokecrystal ends at Entei).
const ALWAYS_FLEE_BY_ENGINE: Record<string, Record<string, boolean>> = {
  gs: { RAIKOU: true, ENTEI: true, SUICUNE: true },
  crystal: { RAIKOU: true, ENTEI: true },
};

// ---------------------------------------------------------------- Swarms

// Lua: Roamers.lua:469-498 -- state on the save: save.swarmMaps (by kind),
// save.swarmMap (the Gold single pair, legacy alias), save.dailyFlags.swarm,
// save.dailyFlags.fishingSwarm, save.dailyResetDay.
const KIND_ORDER = ["DUNSPARCE", "YANMA"];
const KINDS: string[] = ["DUNSPARCE", "YANMA"]; // [0], [1]
const DEFAULT_KIND = "DUNSPARCE";
const KIND_NAMES: Record<string, boolean> = { DUNSPARCE: true, YANMA: true };

// Lua: Roamers.lua:500-504
function kindName(kind: unknown): string {
  if (typeof kind === "number") return KINDS[kind] ?? DEFAULT_KIND;
  if (typeof kind === "string" && KIND_NAMES[kind]) return kind;
  return DEFAULT_KIND;
}

// Lua: Roamers.lua:506-510 -- pokegold has the one pair.
function goldShape(maps: Record<string, any>): boolean {
  return maps.YANMA == null;
}

// Lua: Roamers.lua:525-534
function anyMap(save: SaveLike): boolean {
  if (save === null || typeof save !== "object") return false;
  if (save.swarmMap != null) return true;
  const maps = save.swarmMaps;
  if (maps === null || typeof maps !== "object") return false;
  for (const name of KIND_ORDER) {
    if (maps[name] != null) return true;
  }
  return false;
}

function copyTable(t: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of Object.keys(t)) out[key] = t[key];
  return out;
}

export const Swarm = {
  // Lua: Roamers.lua:487-490 -- ActivateFishingSwarm setval arguments.
  FISH_NONE: 0,
  FISH_QWILFISH: 1,
  FISH_REMORAID: 2,
  // Lua: Roamers.lua:492-496
  KIND_ORDER,
  KINDS,
  DEFAULT_KIND,

  // Lua: Roamers.lua:512-523
  maps(save: SaveLike): Record<string, any> | undefined {
    if (save === null || typeof save !== "object") return undefined;
    let maps = save.swarmMaps;
    if (maps === null || typeof maps !== "object") {
      maps = {};
      save.swarmMaps = maps;
    }
    if (save.swarmMap != null && goldShape(maps)) maps[DEFAULT_KIND] = save.swarmMap;
    return maps;
  },

  // Lua: Roamers.lua:536-551 -- StoreSwarmMapIndices falls through into
  // SetSwarmFlag: one command writes the pair AND the daily flag.
  set(save: SaveLike, mapId: string | undefined, kind?: unknown): boolean {
    if (save === null || typeof save !== "object") return false;
    save.dailyFlags = save.dailyFlags ?? {};
    save.dailyFlags.swarm = true;
    const name = kindName(kind);
    const maps = Swarm.maps(save)!;
    maps[name] = mapId;
    if (name === DEFAULT_KIND) save.swarmMap = mapId;
    return true;
  },

  // Lua: Roamers.lua:553-562 -- ActivateFishingSwarm; the map pair is untouched.
  setFishing(save: SaveLike, kind?: number): boolean {
    if (save === null || typeof save !== "object") return false;
    save.dailyFlags = save.dailyFlags ?? {};
    save.dailyFlags.fishingSwarm = kind ?? Swarm.FISH_NONE;
    save.dailyFlags.swarm = true;
    return true;
  },

  // Lua: Roamers.lua:564-567
  active(save: SaveLike): boolean {
    return save !== null && typeof save === "object" && save.dailyFlags != null
      && save.dailyFlags.swarm === true;
  },

  // Lua: Roamers.lua:569-573
  mapId(save: SaveLike, kind?: unknown): string | undefined {
    if (!Swarm.active(save)) return undefined;
    const maps = Swarm.maps(save);
    return maps ? maps[kindName(kind)] ?? undefined : undefined;
  },

  // Lua: Roamers.lua:575-585 -- Dunsparce first, then Yanma.
  onMap(save: SaveLike, mapId: string | undefined): string | undefined {
    if (mapId == null || !Swarm.active(save)) return undefined;
    const maps = Swarm.maps(save);
    if (!maps) return undefined;
    for (const name of KIND_ORDER) {
      if (maps[name] === mapId) return name;
    }
    return undefined;
  },

  // Lua: Roamers.lua:587-590
  fishing(save: SaveLike): number {
    if (!Swarm.active(save)) return Swarm.FISH_NONE;
    return (save!.dailyFlags ? save!.dailyFlags.fishingSwarm : undefined) ?? Swarm.FISH_NONE;
  },

  // Lua: Roamers.lua:592-608 -- CheckSwarmFlag: 0 while the flag is up; on 1
  // it clears the fishing flag and the map pairs (the only thing that ends a
  // swarm).
  check(save: SaveLike): number {
    if (save === null || typeof save !== "object") return 1;
    if (Swarm.active(save)) return 0;
    if (save.dailyFlags) delete save.dailyFlags.fishingSwarm;
    const maps = save.swarmMaps;
    if (maps !== null && typeof maps === "object") {
      for (const name of KIND_ORDER) delete maps[name];
    }
    delete save.swarmMap;
    return 1;
  },

  // Lua: Roamers.lua:610-624 -- CheckDailyResetTimer: zero the daily flags
  // when the day changes.
  checkDailyReset(save: SaveLike, day: unknown): boolean {
    if (save === null || typeof save !== "object" || day == null || day === false) return false;
    if (save.dailyResetDay == null) {
      save.dailyResetDay = day;
      return false;
    }
    if (save.dailyResetDay === day) return false;
    save.dailyFlags = {};
    save.dailyResetDay = day;
    return true;
  },

  // Lua: Roamers.lua:626-635 -- CheckTimeEvents' `.do_daily`: true when the
  // swarm ended on this call.
  timeEvents(save: SaveLike, day: unknown): boolean {
    const hadMap = anyMap(save);
    const reset = Swarm.checkDailyReset(save, day);
    Swarm.check(save);
    return reset && hadMap && !anyMap(save);
  },

  // Lua: Roamers.lua:637-655 -- _SwarmWildmonCheck's table, only on the
  // swarm's own map. (The Lua's `and/or` falls back to swarmGrass when a
  // water lookup finds no swarmWater table; kept.)
  entry(save: SaveLike, encounters: any, mapId: string, kind?: string): any {
    if (!truthy(encounters)) return undefined;
    if (!Swarm.onMap(save, mapId)) return undefined;
    const table = (kind === "water" && truthy(encounters.swarmWater))
      ? encounters.swarmWater : encounters.swarmGrass;
    return table ? table[mapId] ?? undefined : undefined;
  },

  // Lua: Roamers.lua:657-681 -- an `encounters` view with the swarm's rows in
  // front; the original table when no swarm applies.
  tables(save: SaveLike, encounters: any, mapId: string): any {
    if (!truthy(encounters)) return encounters;
    const grass = Swarm.entry(save, encounters, mapId, "grass");
    const water = Swarm.entry(save, encounters, mapId, "water");
    if (!(truthy(grass) || truthy(water))) return encounters;
    const view = copyTable(encounters);
    if (truthy(grass)) {
      const rows = copyTable(encounters.grass ?? {});
      rows[mapId] = grass;
      view.grass = rows;
    }
    if (truthy(water)) {
      const rows = copyTable(encounters.water ?? {});
      rows[mapId] = water;
      view.water = rows;
    }
    return view;
  },
};

export const Roamers = {
  SPECIES,
  LEVEL,
  NUM_MAPS,
  MAPS,
  MAX_STORED_HP,
  ALWAYS_FLEE_BY_ENGINE,
  // Lua: Roamers.lua:453-456 -- AlwaysFleeMons by species name, resolved
  // against the active engine on every read (the Lua's __index).
  ALWAYS_FLEE: new Proxy({} as Record<string, boolean | undefined>, {
    get: (_t, species) => (typeof species === "string" ? Roamers.alwaysFleeMons()[species] : undefined),
  }),
  // Lua: Roamers.lua:458-467 -- the 50% and 10% flee lists.
  OFTEN_FLEE: {
    CUBONE: true, ARTICUNO: true, ZAPDOS: true, MOLTRES: true,
    QUAGSIRE: true, DELIBIRD: true, PHANPY: true, TEDDIURSA: true,
  } as Record<string, boolean>,
  SOMETIMES_FLEE: {
    MAGNEMITE: true, GRIMER: true, TANGELA: true, MR__MIME: true,
    EEVEE: true, PORYGON: true, DRATINI: true, DRAGONAIR: true,
    TOGETIC: true, UMBREON: true, UNOWN: true, SNUBBULL: true,
    HERACROSS: true,
  } as Record<string, boolean>,
  Swarm,

  // Lua: Roamers.lua:83-95 -- the cache's roster (encounters.roamMons) when
  // it carries one.
  roster(encounters: any): RoamerRow[] {
    const extracted = encounters ? encounters.roamMons : undefined;
    if (!Array.isArray(extracted) || extracted.length === 0) return SPECIES;
    const rows: RoamerRow[] = [];
    for (const row of extracted) {
      if (row == null) break;
      rows.push({
        species: row.species,
        level: row.level ?? LEVEL,
        map: row.map ?? startMapFor(row.species),
      });
    }
    return rows;
  },

  // Lua: Roamers.lua:125-132 -- encounters.roamMaps, else MAPS.
  mapTable(encounters: any): RoamMapRow[] {
    const extracted = encounters ? encounters.roamMaps : undefined;
    if (Array.isArray(extracted) && extracted.length > 0) return extracted;
    return MAPS;
  },

  // Lua: Roamers.lua:134-143 -- `.Update`'s search; unlisted maps do not move.
  entryFor(mapId: string | undefined, encounters?: any): RoamMapRow | undefined {
    if (mapId == null) return undefined;
    for (const row of Roamers.mapTable(encounters)) {
      if (row == null) break;
      if (row.map === mapId) return row;
    }
    return undefined;
  },

  // Lua: Roamers.lua:155-173 -- JumpRoamMon: a random entry, re-rolled while
  // it is the player's map (capped at 32 tries).
  jumpOne(playerMapId: string | undefined, random?: RoamRandom, encounters?: any): string | undefined {
    const table = Roamers.mapTable(encounters);
    const count = table.length;
    if (count === 0) return undefined;
    for (let n = 1; n <= 32; n++) {
      const row = table[rand(random, count)];
      if (row && row.map !== playerMapId) return row.map;
    }
    return undefined;
  },

  // Lua: Roamers.lua:175-205 -- `.Update`: one byte does double duty: & 31 ==
  // 0 jumps; otherwise its low two bits index the connection. Re-rolls past
  // the list and onto the player's previous map.
  moveOne(mapId: string | undefined, lastMapId: string | undefined, playerMapId: string | undefined, random?: RoamRandom, encounters?: any): string | undefined {
    const entry = Roamers.entryFor(mapId, encounters);
    if (!entry) return mapId;
    const list = entry.to ?? [];
    for (let n = 1; n <= 64; n++) {
      const value = mod(rand(random, 256), 32);
      if (value === 0) return Roamers.jumpOne(playerMapId, random, encounters) ?? mapId;
      const index = mod(value, 4);
      if (index < list.length) {
        const candidate = list[index];
        if (candidate !== lastMapId) return candidate;
      }
    }
    return mapId;
  },

  // Lua: Roamers.lua:231-233
  list(save: SaveLike): RoamerSlot[] | undefined {
    return (save !== null && typeof save === "object" && truthy(save.roamers)) ? save.roamers : undefined;
  },

  // Lua: Roamers.lua:235-238 -- `index` is the 1-based roamer slot.
  slot(save: SaveLike, index: number): RoamerSlot | undefined {
    const list = Roamers.list(save);
    return list ? list[index - 1] ?? undefined : undefined;
  },

  // Lua: Roamers.lua:240-260 -- InitRoamMons; writes only when empty (or
  // opts.force).
  init(save: SaveLike, opts?: { force?: boolean; encounters?: any; data?: any }): RoamerSlot[] | undefined {
    if (save === null || typeof save !== "object") return undefined;
    if (truthy(save.roamers) && !(opts && opts.force)) return save.roamers;
    const encounters = opts ? (opts.encounters ?? (opts.data ? opts.data.gen2Encounters : undefined)) : undefined;
    const list: RoamerSlot[] = [];
    for (const row of Roamers.roster(encounters)) {
      list.push({
        species: row.species,
        level: row.level,
        map: row.map,
        // `xor a ; generate new stats`
        hp: 0,
      });
    }
    save.roamers = list;
    return list;
  },

  // Lua: Roamers.lua:262-266 -- still out there (species AND map).
  active(slot: unknown): boolean {
    return slot !== null && typeof slot === "object"
      && (slot as RoamerSlot).species != null && (slot as RoamerSlot).map != null;
  },

  // Lua: Roamers.lua:268-278 -- _BackUpMapIndices: Cur -> Last, player -> Cur.
  backUpMapIndices(save: SaveLike, playerMapId: string | undefined): void {
    if (save === null || typeof save !== "object") return;
    const marks = save.roamerMaps ?? {};
    marks.last = marks.current;
    marks.current = playerMapId;
    save.roamerMaps = marks;
  },

  // Lua: Roamers.lua:280-283
  lastMap(save: SaveLike): string | undefined {
    return (save !== null && typeof save === "object" && save.roamerMaps ? save.roamerMaps.last : undefined) ?? undefined;
  },

  // Lua: Roamers.lua:285-303 -- UpdateRoamMons (connection / door warp).
  update(save: SaveLike, playerMapId: string | undefined, random?: RoamRandom, encounters?: any): boolean {
    const list = Roamers.list(save);
    if (!list) return false;
    const lastMapId = Roamers.lastMap(save);
    for (let i = 0; i < list.length; i++) {
      const slot = list[i];
      if (slot == null) break;
      if (Roamers.active(slot)) {
        const from = slot.map;
        slot.map = Roamers.moveOne(from, lastMapId, playerMapId, random, encounters);
        emitMoved(i + 1, slot, from, "connection");
      }
    }
    Roamers.backUpMapIndices(save, playerMapId);
    return true;
  },

  // Lua: Roamers.lua:305-320 -- JumpRoamMons (fly / teleport).
  jumpAll(save: SaveLike, playerMapId: string | undefined, random?: RoamRandom, encounters?: any): boolean {
    const list = Roamers.list(save);
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      const slot = list[i];
      if (slot == null) break;
      if (Roamers.active(slot)) {
        const from = slot.map;
        slot.map = Roamers.jumpOne(playerMapId, random, encounters) ?? slot.map;
        emitMoved(i + 1, slot, from, "jump");
      }
    }
    Roamers.backUpMapIndices(save, playerMapId);
    return true;
  },

  // Lua: Roamers.lua:326-372 -- CheckEncounterRoamMon: one byte, < 100, & 3
  // nonzero, -> slot 1..3; that beast must be on the player's map (no
  // re-roll). Surfing refuses first.
  checkEncounter(save: SaveLike, mapId: string | undefined, onWater?: unknown, random?: RoamRandom): RoamerHit | undefined {
    if (truthy(onWater)) return undefined;
    const list = Roamers.list(save);
    if (!list) return undefined;
    const value = rand(random, 256);
    if (value >= 100) return undefined;
    const index = mod(value, 4);
    if (index === 0) return undefined;
    const slot = list[index - 1];
    if (!Roamers.active(slot)) return undefined;
    if (slot!.map !== mapId) return undefined;
    const hit: RoamerHit = { index, slot: slot!, species: slot!.species, level: slot!.level };
    if (Runtime.wants("roamer.encountered")) {
      Runtime.emit("roamer.encountered", {
        index, slot, species: slot!.species,
        level: slot!.level, mapId,
      });
    }
    return hit;
  },

  // Lua: Roamers.lua:374-399 -- the enemy for a roaming battle, from Mon.new.
  // Stored HP 0 means fresh: roll DVs and bank full HP now (.InitRoamHP);
  // otherwise reuse DVs and HP. The Lua also returns the slot; its callers
  // take only the mon.
  beginBattle(save: SaveLike, index: number, data: any): any {
    const slot = Roamers.slot(save, index);
    if (!Roamers.active(slot)) return undefined;
    const s = slot!;
    const fresh = (s.hp ?? 0) === 0;
    const mon = Mon.new(data, s.species!, s.level ?? LEVEL, {
      dvs: !fresh ? s.dvs : undefined,
    });
    if (!mon) return undefined;
    s.dvs = mon.dvs;
    if (fresh) {
      s.hp = Math.min(MAX_STORED_HP, mon.maxHp ?? 0);
    } else {
      mon.hp = Math.min(s.hp!, mon.maxHp ?? s.hp);
    }
    return mon;
  },

  // Lua: Roamers.lua:401-425 -- BattleEnd_HandleRoamMons: "win"/"caught"
  // clear the beast for good; anything else banks its HP and moves it.
  endBattle(save: SaveLike, index: number, outcome: string, hp: number | undefined, playerMapId: string | undefined, random?: RoamRandom, encounters?: any): boolean {
    const slot = Roamers.slot(save, index);
    if (!Roamers.active(slot)) return false;
    const s = slot!;
    if (outcome === "win" || outcome === "caught") {
      delete s.species;
      delete s.map;
      s.hp = 0;
      return true;
    }
    s.hp = Math.max(0, Math.min(MAX_STORED_HP, hp ?? 0));
    Roamers.update(save, playerMapId, random, encounters);
    return true;
  },

  // Lua: Roamers.lua:427-434 -- `.not_roaming`: 1 in 16 after any other wild
  // battle.
  afterWildBattle(save: SaveLike, playerMapId: string | undefined, random?: RoamRandom, encounters?: any): boolean {
    if (!Roamers.list(save)) return false;
    if (mod(rand(random, 256), 16) !== 0) return false;
    return Roamers.update(save, playerMapId, random, encounters);
  },

  // Lua: Roamers.lua:448-451
  alwaysFleeMons(versionId?: string): Record<string, boolean> {
    return ALWAYS_FLEE_BY_ENGINE[GameVersion.engine(versionId)] ?? ALWAYS_FLEE_BY_ENGINE.gs!;
  },
};

export default Roamers;
