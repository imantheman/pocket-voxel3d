// Port of gen1recomp src/core/game3/encounters.lua (GPLv3 + additional terms; see LICENSE.md).
// Wild encounter tables + step rolls. Feeds battle_bridge.
// Tables come from ROM extract (cache encounters.lua via gWildMonHeaders).
// RNG: pret wild_encounter.c — Random() for gate/slot/level, WildEncounterRandom for rate.
//
// Lua differences: the loaded tables are readLuaLiteral shapes (sequences
// are 0-based arrays); weights are 0-based arrays and pick_slot_index still
// returns the Lua's 1-based slot index.
// NOT FAITHFUL (plumbing): the runtime modules this one requires are not
// ported yet (src.core.game3.rng, src.mods.Runtime, dataset, collision,
// encounter_rules.<family>, pokemon, runtime, player, scripting.space/flags,
// encounters_data_stub). They are bound late through `Encounters.deps`; a
// hard require that is still unbound throws, an optional one (the Lua's
// pcall(require) / package.loaded) reads as absent.
// NOT FAITHFUL: the cache is read via deps.Dataset / CacheFs only (no
// love.filesystem fallback), and chunks are read with readLuaLiteral.

import { format, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { CacheFs, type Cache } from "../../../import/gen3/cache.ts";
import { readLuaLiteral } from "../../../import/gen3/asset_pack.ts";
import { luaGet, luaKeys, luaLen } from "../../../import/gen3/luatable.ts";
import { MapCatalog } from "../../../import/gen3/map_catalog.ts";
import { Profile } from "./profile.ts";
import { Constants } from "./constants.ts";
import { CachePaths } from "./cache_paths.ts";

type Tbl = Record<string, any>;

/** The runtime modules encounters.lua requires (bound by their ports). */
export interface EncounterDeps {
  /** src.core.game3.rng (required) */
  Rng?: { Random(): number };
  /** src.mods.Runtime (required) */
  ModRuntime?: { wantsHook(name: string): boolean; call(name: string, fallback: (...a: any[]) => any, ...args: any[]): any };
  /** src.core.game3.dataset (optional) */
  Dataset?: { cache(): Cache | undefined };
  /** package.loaded["src.core.game3.collision"] (optional) */
  Collision?: Tbl;
  /** src.core.game3.encounter_rules.<family> (required per family) */
  rules?: Record<string, { bind(E: typeof Encounters, H: Tbl): Tbl }>;
  /** src.core.game3.pokemon (required where used) */
  Pokemon?: { keyName(id: number): string | undefined; speciesFromName(name: unknown): number | undefined };
  /** src.core.game3.runtime (optional) */
  Runtime?: { getSession?(): any };
  /** src.core.game3.player (optional) */
  Player?: { biking?: unknown };
  /** package.loaded scripting.space / scripting.flags (optional) */
  Space?: Tbl;
  Flags?: Tbl;
  /** src.core.game3.encounters_data_stub (optional) */
  stub?: Tbl;
}

const deps: EncounterDeps = {};

function need<K extends keyof EncounterDeps>(k: K): NonNullable<EncounterDeps[K]> {
  const v = deps[k];
  if (!v) throw new Error(`game3 encounters: ${k} is not ported/bound yet`);
  return v as NonNullable<EncounterDeps[K]>;
}

// pret ENCOUNTER_CHANCE_LAND_MONS_* cumulative weights (total 100).
const LAND_WEIGHTS = [20, 20, 10, 10, 10, 10, 5, 5, 4, 4, 1, 1];
const WATER_WEIGHTS = [60, 30, 5, 4, 1];

// pokefirered/include/global.fieldmap.h:40
const TILE_ENCOUNTER_NONE = 0;
const TILE_ENCOUNTER_LAND = 1;
const TILE_ENCOUNTER_WATER = 2;

// Lua: encounters.lua:33
function game_constants() {
  return Constants.of(Profile.forSession(undefined).id);
}

// Lua: encounters.lua:37
function log(msg: unknown): void {
  console.log("[game3/encounters] " + tostring(msg));
}

// Lua: encounters.lua:41
function merge_tables(dst: Tbl, src: unknown): void {
  if (src === null || typeof src !== "object") return;
  for (const k of luaKeys(src)) dst[k] = luaGet(src, k);
}

// Lua: encounters.lua:48
function load_lua_blob(src: string | undefined, _label?: string): Tbl | undefined {
  if (src === undefined || src === "") return undefined;
  let data: unknown;
  try {
    data = readLuaLiteral(src);
  } catch {
    return undefined;
  }
  if (data !== null && typeof data === "object") return data as Tbl;
  return undefined;
}

/** Same cache path Dataset / NativeTileset use (firered/ + CacheFs.readActive). */
// Lua: encounters.lua:58
function load_from_cache(file?: string): Tbl | undefined {
  // The Lua reads extract_island1's CACHE_ROOT; the runtime's is CachePaths'.
  const root = CachePaths.CACHE_ROOT || "data/generated/gba";
  const path = root + "/" + (file ?? "encounters.lua");

  const Dataset = deps.Dataset;
  if (Dataset && Dataset.cache) {
    const c = Dataset.cache();
    const src = c ? c.read(path) : undefined;
    const data = load_lua_blob(src, "@" + path);
    if (data) return data;
  }

  // Fallback: CacheFs directly (version prefix).
  let src: string | undefined;
  try {
    src = CacheFs.readActive(path);
  } catch {
    src = undefined;
  }
  const data = load_lua_blob(src, "@" + path);
  if (data) return data;
  return undefined;
}

// Lua: encounters.lua:131
function collision_mod(): Tbl | undefined {
  return deps.Collision;
}

// Lua: encounters.lua:149
function fallback_encounter_type(cx: number, cy: number): number {
  const Collision = collision_mod();
  if (!Collision) return TILE_ENCOUNTER_NONE;
  if (Collision.isWater && Collision.isWater(cx, cy)) return TILE_ENCOUNTER_WATER;
  if (Collision.isGrass && Collision.isGrass(cx, cy)) return TILE_ENCOUNTER_LAND;
  return TILE_ENCOUNTER_NONE;
}

// pokefirered/src/fieldmap.c:391
function behavior_at(cx: number, cy: number): number | undefined {
  const Collision = collision_mod();
  if (!(Collision && Collision.behavior)) return undefined;
  return Collision.behavior(cx, cy) ?? 0;
}

const TERRAIN_FOR_TYPE: Record<number, string> = {
  [TILE_ENCOUNTER_LAND]: "land",
  [TILE_ENCOUNTER_WATER]: "water",
};

/** pret ChooseWildMonIndex_Land / WaterRock: Random() % total, cumulative slots (1-based result). */
// Lua: encounters.lua:191
function pick_slot_index(weights: number[]): number {
  let total = 0;
  for (let i = 0; i < weights.length; i++) {
    total = total + (weights[i] ?? 0);
  }
  if (total < 1) return 1;
  const rand = need("Rng").Random() % total;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc = acc + (weights[i] ?? 0);
    if (rand < acc) return i + 1;
  }
  return weights.length;
}

// Lua: encounters.lua:206
function pick_slot(slots: unknown, weights: number[]): unknown {
  if (slots === null || typeof slots !== "object" || luaLen(slots) === 0) return undefined;
  const n = luaLen(slots);
  const w: number[] = [];
  for (let i = 1; i <= n; i++) {
    w[i - 1] = weights[i - 1] ?? 1;
  }
  let idx = pick_slot_index(w);
  if (idx < 1) idx = 1;
  if (idx > n) idx = n;
  return luaGet(slots, idx);
}

/** pret ChooseWildMonLevel: lo + Random() % (hi - lo + 1). */
// Lua: encounters.lua:220
function level_of(entry: Tbl | undefined): number {
  if (!entry) return 5;
  const minLevel = tonumber(entry.minLevel ?? entry.level ?? luaGet(entry, 2)) ?? 5;
  const maxLevel = tonumber(entry.maxLevel ?? entry.level ?? luaGet(entry, 2)) ?? minLevel;
  let lo = minLevel, hi = maxLevel;
  if (maxLevel < minLevel) { lo = maxLevel; hi = minLevel; }
  const m = hi - lo + 1;
  const r = need("Rng").Random();
  return lo + (((r % m) + m) % m);
}

// Lua: encounters.lua:230
function normalize_area(area: unknown, fallbackRate?: number): { rate: unknown; slots: unknown } | undefined {
  if (area === null || typeof area !== "object") return undefined;
  const a = area as Tbl;
  if (a.slots || a.mons) {
    return {
      rate: a.rate ?? fallbackRate ?? 21,
      slots: a.slots ?? a.mons,
    };
  }
  if (luaLen(a) > 0) {
    return { rate: fallbackRate ?? 21, slots: a };
  }
  return undefined;
}

// Lua: encounters.lua:244
function wild_set_var(): number {
  const VAR_ALTERING_CAVE_WILD_SET = game_constants().require("vars", "VAR_ALTERING_CAVE_WILD_SET");
  const Sp = deps.Space;
  const Flags = deps.Flags;
  if (Sp && Sp.store && Flags && Flags.getVar) {
    return tonumber(Flags.getVar(Sp.store, undefined, VAR_ALTERING_CAVE_WILD_SET)) ?? 0;
  }
  const Runtime = deps.Runtime;
  const session = Runtime && Runtime.getSession && Runtime.getSession();
  const vars = session !== null && typeof session === "object" ? session.vars : undefined;
  return (vars !== null && typeof vars === "object" && tonumber(vars[VAR_ALTERING_CAVE_WILD_SET])) || 0;
}

// pokefirered/src/wild_encounter.c:192
function pick_variant(t: Tbl | undefined): Tbl | undefined {
  if (t === null || typeof t !== "object" || t.variants === null || typeof t.variants !== "object") return t;
  let id = wild_set_var();
  if (id >= luaLen(t.variants)) id = 0;
  return (luaGet(t.variants, id + 1) as Tbl | undefined) ?? t;
}

// Lua: encounters.lua:265
function resolve_table(mapId: unknown): Tbl | undefined {
  if (mapId === undefined || mapId === null || mapId === false) return undefined;
  const tables = Encounters._tables;
  let t = tables[mapId as string];
  if (t) return t;
  const s = tostring(mapId);
  t = tables[s];
  if (t) return t;

  // MapCatalog resolution (e.g. pret name or group:num)
  {
    const res = MapCatalog.resolve(s);
    if (res && tables[res]) {
      return tables[res];
    }
    const slot = MapCatalog.slotKeyFor(s);
    if (slot) {
      const colonSlot = slot.replace(/_/g, ":");
      if (tables[colonSlot]) return tables[colonSlot];
      if (tables[slot]) return tables[slot];
    }
  }

  // Prefix stripping / addition
  if (s.substring(0, 3) === "FR_") {
    t = tables[s.substring(3)];
    if (t) return t;
  } else {
    t = tables["FR_" + s];
    if (t) return t;
  }

  // Route underscore normalization (ROUTE_22 <-> ROUTE22)
  const rm = /ROUTE_?(\d+)/.exec(s);
  if (rm) {
    const routeNum = rm[1]!;
    t = tables["FR_ROUTE_" + routeNum]
      ?? tables["FR_ROUTE" + routeNum]
      ?? tables["ROUTE_" + routeNum]
      ?? tables["ROUTE" + routeNum];
    if (t) return t;
  }

  return undefined;
}

// Lua: encounters.lua:310
function table_for(mapId: unknown): Tbl | undefined {
  return pick_variant(resolve_table(mapId));
}

/** The area `terrain` rolls on, resolved the same way rollLand/rollWater do. */
// Lua: encounters.lua:323
function area_for(mapId: unknown, terrain: unknown) {
  const t = table_for(mapId);
  if (terrain === "water") {
    return normalize_area(t && t.water, 15);
  }
  return normalize_area(t && t.land) ?? normalize_area(t && t.grass);
}

/** pret TestPlayerAvatarFlags(PLAYER_AVATAR_FLAG_MACH_BIKE | ..._ACRO_BIKE). */
// Lua: encounters.lua:332
function bike_active(): boolean {
  const Player = deps.Player;
  return (Player && Player.biking) === true;
}

/** pret VarGet(VAR_REPEL_STEP_COUNT) != 0. */
// Lua: encounters.lua:338
function repel_active(): boolean {
  const VAR_REPEL_STEP_COUNT = game_constants().require("vars", "VAR_REPEL_STEP_COUNT");
  const Runtime = deps.Runtime;
  const session = Runtime && Runtime.getSession && Runtime.getSession();
  if (session === null || typeof session !== "object") return false;
  const vars = session.vars;
  const steps = tonumber(session.repelSteps)
    ?? ((vars !== null && typeof vars === "object") ? tonumber(vars[VAR_REPEL_STEP_COUNT]) : undefined)
    ?? 0;
  return steps > 0;
}

// pokefirered/src/wild_encounter.c:601
function wild_level_allowed_by_repel(wildLevel: unknown): boolean {
  if (!repel_active()) return true;
  const Runtime = deps.Runtime;
  const session = Runtime && Runtime.getSession && Runtime.getSession();
  const party = session && session.party;
  if (party === null || typeof party !== "object") return false;
  for (let i = 1; i <= 6; i++) {
    const mon = luaGet(party, i) as Tbl | undefined;
    if (mon !== null && typeof mon === "object" && (tonumber(mon.hp) ?? tonumber(mon.currentHp) ?? 1) > 0
      && !mon.isEgg && !mon.egg) {
      return !((tonumber(wildLevel) ?? 0) < (tonumber(mon.level) ?? 0));
    }
  }
  return false;
}

const H: Tbl = {
  LAND_WEIGHTS,
  WATER_WEIGHTS,
  TILE_ENCOUNTER_LAND,
  TILE_ENCOUNTER_WATER,
  normalize_area,
  table_for,
  area_for,
  pick_slot,
  pick_slot_index,
  level_of,
  bike_active,
  repel_active,
  wild_level_allowed_by_repel,
  constants: game_constants,
};

const bound: Record<string, Tbl> = {};

// Lua: encounters.lua:387
function rules(): Tbl {
  const family = Profile.family();
  let r = bound[family];
  if (!r) {
    const mod = (deps.rules ?? {})[family];
    if (!mod) throw new Error(`module 'src.core.game3.encounter_rules.${family}' not found (not ported/bound yet)`);
    r = mod.bind(Encounters, H);
    bound[family] = r;
  }
  return r;
}

// Lua: encounters.lua:398-409
function delegate(name: string): (...args: any[]) => any {
  return (...args: any[]) => {
    const f = rules()[name];
    if (!f) {
      throw new Error("game3 encounters: " + Profile.family() + " rules have no " + name);
    }
    return f(...args);
  };
}

// Lua: encounters.lua:411
function vanilla_step(mapId: unknown, terrain: unknown, opts: unknown): any {
  return rules().step(mapId, terrain, opts);
}

// Lua: encounters.lua:415
function mod_encounter(enc: any): any {
  if (enc === null || typeof enc !== "object") return enc;
  const Pokemon = need("Pokemon");
  const id = tonumber(enc.species);
  return {
    species: (id !== undefined ? Pokemon.keyName(id) : undefined) ?? enc.species,
    speciesId: id ?? Pokemon.speciesFromName(enc.species),
    level: enc.level,
    item: enc.item,
    roamer: enc.roamer,
    foe: enc.foe,
    personality: enc.personality,
    moves: enc.moves,
  };
}

// Lua: encounters.lua:431
function engine_encounter(enc: any): any {
  if (enc === null || typeof enc !== "object") return undefined;
  let id = tonumber(enc.species);
  if (id === undefined && enc.species !== undefined && enc.species !== null) {
    id = need("Pokemon").speciesFromName(enc.species);
  }
  id = id ?? tonumber(enc.speciesId);
  if (id === undefined) return undefined;
  return {
    species: id,
    level: tonumber(enc.level) ?? 5,
    item: enc.item,
    roamer: enc.roamer,
    foe: enc.foe,
    personality: enc.personality,
    moves: enc.moves,
  };
}

// Lua: encounters.lua:451
function same_encounter(enc: any): any { return enc; }

export const Encounters = {
  deps,

  _tables: {} as Tbl, // mapId or "group:num" → { land = { rate, slots }, ... }
  _pendingWild: undefined as { species: unknown; level: unknown; item: unknown } | undefined,
  _prevGrass: false, // pret first-step-into-grass gate
  _prevMetatileBehavior: 0 as unknown, // pokefirered/src/wild_encounter.c:27
  _encounterTypes: undefined as Tbl | undefined, // pokefirered/src/fieldmap.c:68
  _stepsSinceLastEncounter: 0, // pret sWildEncounterData.stepsSinceLastEncounter
  _encounterRateBuff: 0, // pret sWildEncounterData.encounterRateBuff
  _immunitySteps: 0, // pokeemerald/src/field_control_avatar.c:38
  _rsePrevBehavior: 0, // pokeemerald/src/field_control_avatar.c:39
  _logged: false,
  _loaded: false,
  _h: H,

  // Lua: encounters.lua:86
  loadCacheFile(file?: string): Tbl | undefined {
    return load_from_cache(file);
  },

  // Lua: encounters.lua:90
  loadFromMod(_mod?: unknown): void {
    Encounters._tables = {};
    Encounters._loaded = false;

    const data = load_from_cache();
    if (data) {
      merge_tables(Encounters._tables, data);
      Encounters._loaded = true;
    }

    const stub = deps.stub;
    if (stub !== null && typeof stub === "object") {
      if (stub.TABLES) merge_tables(Encounters._tables, stub.TABLES);
      else merge_tables(Encounters._tables, stub);
    }

    const n = Object.keys(Encounters._tables).length;
    if (!Encounters._logged || n > 0) {
      log(format("loaded %d map tables%s",
        n, data ? " (ROM extract)" : " (no extract — re-run gba extract)"));
      Encounters._logged = true;
    }
  },

  /** Lazy reload if install ran before the firered cache was mounted. */
  // Lua: encounters.lua:116
  ensureLoaded(): boolean {
    if (Encounters._loaded) {
      const n = Object.keys(Encounters._tables).length;
      if (n > 0) return true;
    }
    Encounters.loadFromMod(undefined);
    return Encounters._loaded;
  },

  // pokefirered/src/fieldmap.c:68
  installEncounterTypes(tbl: unknown): void {
    Encounters._encounterTypes = (tbl !== null && typeof tbl === "object" && luaKeys(tbl).length > 0)
      ? (tbl as Tbl) : undefined;
  },

  // pokefirered/src/fieldmap.c:385
  encounterTypeAt(cx: number, cy: number): number | undefined {
    const types = Encounters._encounterTypes;
    if (!types) return undefined;
    const Collision = collision_mod();
    const mapDef = Collision && Collision._mapDef;
    const layout = mapDef && mapDef.midLayout;
    if (!layout) return undefined;
    const pair = mapDef.pair ?? layout.pair;
    const forPair = pair && types[pair];
    if (!forPair) return undefined;
    return luaGet(forPair, layout.midAt(cx, cy)) as number | undefined ?? TILE_ENCOUNTER_NONE;
  },

  // pokefirered/src/wild_encounter.c:366,404
  terrainAt(cx: number, cy: number): string | undefined {
    let t = Encounters.encounterTypeAt(cx, cy);
    if (t === undefined) t = fallback_encounter_type(cx, cy);
    return TERRAIN_FOR_TYPE[t];
  },

  // Lua: encounters.lua:176
  setWildBattle(species: unknown, level: unknown, item: unknown): void {
    Encounters._pendingWild = { species, level, item };
  },

  // Lua: encounters.lua:184
  takePendingWild() {
    const p = Encounters._pendingWild;
    Encounters._pendingWild = undefined;
    return p;
  },

  // Lua: encounters.lua:314
  tableFor(mapId: unknown): Tbl | undefined {
    Encounters.ensureLoaded();
    return table_for(mapId);
  },
  table_for(mapId: unknown): Tbl | undefined {
    return Encounters.tableFor(mapId);
  },

  rules,

  mapBaseCooldown: delegate("mapBaseCooldown"),
  cooldownMinSteps: delegate("cooldownMinSteps"),
  handleCooldown: delegate("handleCooldown"),
  resetRateModifiers: delegate("resetRateModifiers"),
  encounterRate: delegate("encounterRate"),
  rollLand: delegate("rollLand"),
  rollWater: delegate("rollWater"),
  rollRocks: delegate("rollRocks"),
  rollSweetScent: delegate("rollSweetScent"),
  sweetScentFacility: delegate("sweetScentFacility"),
  hasFishingMons: delegate("hasFishingMons"),
  rollFishing: delegate("rollFishing"),

  // pokefirered/src/wild_encounter.c:757
  onStep(mapId: unknown, terrain: unknown, optsIn?: Tbl): any {
    let opts: Tbl = optsIn ?? {};
    const x = opts.x, y = opts.y;
    let behavior = opts.behavior;
    if (behavior === undefined && x != null && y != null) behavior = behavior_at(x, y);
    if (terrain === undefined && x != null && y != null) terrain = Encounters.terrainAt(x, y);

    const prevBehavior = Encounters._prevMetatileBehavior;
    if (behavior !== undefined) Encounters._prevMetatileBehavior = behavior;
    if (rules().everyStep) {
      opts = { x, y, behavior, terrain };
    } else {
      if (x != null && y != null && terrain === undefined) return undefined;

      if (opts.enterFromOther === undefined && behavior !== undefined) {
        opts = {
          enterFromOther: behavior !== prevBehavior,
          x, y, behavior,
        };
      }
    }

    const ModRuntime = need("ModRuntime");
    const wantsRoll = ModRuntime.wantsHook("encounter.roll");
    const wantsSpecies = ModRuntime.wantsHook("encounter.species");
    if (!(wantsRoll || wantsSpecies)) {
      return vanilla_step(mapId, terrain, opts);
    }
    Encounters.ensureLoaded();
    const ctx = { mapId, terrain, rng: need("Rng").Random, opts };
    let enc: any;
    if (wantsRoll) {
      enc = ModRuntime.call("encounter.roll", () => {
        return mod_encounter(vanilla_step(mapId, terrain, opts));
      }, table_for(mapId), ctx);
    } else {
      enc = mod_encounter(vanilla_step(mapId, terrain, opts));
    }
    if (enc && wantsSpecies) {
      enc = ModRuntime.call("encounter.species", same_encounter, enc, ctx);
    }
    enc = engine_encounter(enc);
    if (enc) Encounters.resetRateModifiers();
    return enc;
  },

  // Lua: encounters.lua:499
  noteGrass(onGrass: unknown): void {
    Encounters._prevGrass = !!onGrass;
  },
};

export default Encounters;
