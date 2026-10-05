// Port of gen1recomp src/core/game3/battle/rules.lua (GPLv3 + additional terms; see LICENSE.md).
// Game3 battle rules (owned). Crit / weather mods / residual phase labels.
//
// Port notes:
// - The lazy requires (link_guard, dataset, kinds) are static imports.
// - `load(src, "@" .. rel, "t", {})` on the RSE safari tables is luaLoad.
// - error(msg) / assert become thrown Errors.

import { mod, tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { ipairs, seq } from "../../platform/lt.ts";
import { luaLoad } from "../../platform/luadata.ts";
import { Capabilities } from "./capabilities.ts";
import { Oak } from "./oak_advice.ts";
import { Guard } from "./link_guard.ts";
import { Kinds } from "./kinds.ts";
import { Dataset } from "../dataset.ts";

type RngFn = (lo: number, hi: number) => unknown;

// Lua: rules.lua:59
function fallback_rng(lo: number, hi: number): number {
  return Guard.fallback("rules.roll", lo, hi);
}

/** pcall(rng, lo, hi) -> [ok, value] */
function pcall_rng(rng: any, lo: number, hi: number): [boolean, unknown] {
  try {
    return [true, rng(lo, hi)];
  } catch (e) {
    return [false, e];
  }
}

// Lua: rules.lua:116
function throw_counter(rng?: RngFn | null): number {
  let [ok, n] = pcall_rng(rng ?? fallback_rng, 0, 4);
  if (!(ok && typeof n === "number")) n = fallback_rng(0, 4);
  return mod(Math.floor(n as number), 5) + 2;
}

const HIGH_CRIT_EFFECTS: Record<number, boolean> = {
  43: true,
  75: true,
  200: true,
  209: true,
};

// Lua: rules.lua:328
function rollZeroTo(rng: any, den: number): number {
  if (den <= 1) return 0;
  if (typeof rng !== "function") {
    return fallback_rng(0, den - 1);
  }
  const [ok, a] = pcall_rng(rng, 0, den - 1);
  if (ok && typeof a === "number") return mod(a, den);
  return fallback_rng(0, den - 1);
}

export interface SafariState {
  [k: string]: any;
  balls?: number;
  catchFactor?: number;
  escapeFactor?: number;
  baseCatchRate?: number;
  rockCounter?: number;
  baitCounter?: number;
  rse?: boolean;
}

export const Rules = {
  // pokefirered/src/battle_util.c:453
  FIELD_PHASES_ORDER: seq(
    "reflect",
    "light_screen",
    "mist",
    "safeguard",
    "wish",
    "weather_continue",
  ),

  // pokefirered/src/battle_util.c:722
  BATTLER_PHASES_ORDER: seq(
    "ingrain",
    "abilities_eot",
    "held_items",
    "leech_seed",
    "status_chip",
    "nightmare",
    "curse",
    "partial_trap_chip",
    "uproar",
    "thrash",
    "disable",
    "encore",
    "lock_on",
    "charge",
    "taunt",
    "yawn",
    "volatiles",
  ),

  // pokefirered/src/battle_util.c:1064
  POST_PHASES_ORDER: seq(
    "fainted_actions",
    "future_sight",
    "perish_song",
  ),

  FAINT_HALT_PHASES: {
    ingrain: true,
    leech_seed: true,
    status_chip: true,
    nightmare: true,
    curse: true,
    partial_trap_chip: true,
  } as Record<string, boolean>,

  // Lua: rules.lua:55
  shouldHaltBattlerOnFaint(phase: string): boolean {
    return Rules.FAINT_HALT_PHASES[phase] === true;
  },

  // Partial trap (Gen3)
  partialTrap: {
    // Lua: rules.lua:67 -- pokefirered/src/battle_util.c:886
    chipAmount(maxHp?: number | null): number {
      return Math.max(1, Math.floor((maxHp ?? 16) / Capabilities.partialTrapChipDenom));
    },

    // Lua: rules.lua:72 -- pokefirered/src/battle_script_commands.c:2490
    rollTurns(rng?: RngFn | null): number {
      rng = rng ?? fallback_rng;
      let [ok, n] = pcall_rng(rng, 0, 3);
      if (!(ok && typeof n === "number")) n = fallback_rng(0, 3);
      return mod(Math.floor(n as number), 4) + 3;
    },

    // Lua: rules.lua:79
    active(): boolean {
      return Capabilities.gen3PartialTrap;
    },

    // pokefirered/src/battle_message.c:1263
    MOVES: seq(20, 35, 83, 128, 250, 328),
  },

  safari: {
    // pokefirered/src/safari_zone.c:31
    BALLS: 30,
    STEPS: 600,

    // Lua: rules.lua:93 -- pokefirered/src/battle_main.c:2284
    catchFactor(catchRate: unknown): number {
      return Math.floor((tonumber(catchRate) ?? 0) * 100 / 1275);
    },

    // Lua: rules.lua:98 -- pokefirered/src/battle_main.c:2285
    escapeFactor(fleeRate: unknown): number {
      let f = Math.floor((tonumber(fleeRate) ?? 0) * 100 / 1275);
      if (f <= 1) f = 2;
      return f;
    },

    // Lua: rules.lua:105 -- pokefirered/src/battle_main.c:2282
    newState(catchRate: unknown, fleeRate: unknown): SafariState {
      return {
        balls: Rules.safari.BALLS,
        catchFactor: Rules.safari.catchFactor(catchRate),
        escapeFactor: Rules.safari.escapeFactor(fleeRate),
        baseCatchRate: tonumber(catchRate) ?? 0,
        rockCounter: 0,
        baitCounter: 0,
      };
    },

    // Lua: rules.lua:123 -- pokefirered/src/battle_main.c:4382
    throwBait(sf: SafariState | null | undefined, rng?: RngFn | null): void {
      if (!truthy(sf)) return;
      const s = sf as SafariState;
      s.baitCounter = Math.min(6, (s.baitCounter ?? 0) + throw_counter(rng));
      s.rockCounter = 0;
      s.catchFactor = Math.floor((s.catchFactor ?? 0) / 2);
      if (s.catchFactor <= 2) s.catchFactor = 3;
    },

    // Lua: rules.lua:132 -- pokefirered/src/battle_main.c:4398
    throwRock(sf: SafariState | null | undefined, rng?: RngFn | null): void {
      if (!truthy(sf)) return;
      const s = sf as SafariState;
      s.rockCounter = Math.min(6, (s.rockCounter ?? 0) + throw_counter(rng));
      s.baitCounter = 0;
      s.catchFactor = (s.catchFactor ?? 0) * 2;
      if (s.catchFactor > 20) s.catchFactor = 20;
    },

    // Lua: rules.lua:141 -- pokefirered/src/battle_main.c:4334
    watchStep(sf: SafariState | null | undefined): string {
      if (!truthy(sf)) return "watching";
      const s = sf as SafariState;
      if ((s.rockCounter ?? 0) !== 0) {
        s.rockCounter = (s.rockCounter as number) - 1;
        if (s.rockCounter === 0) {
          s.catchFactor = Rules.safari.catchFactor(s.baseCatchRate);
          return "watching";
        }
        return "angry";
      }
      if ((s.baitCounter ?? 0) !== 0) {
        s.baitCounter = (s.baitCounter as number) - 1;
        if (s.baitCounter === 0) return "watching";
        return "eating";
      }
      return "watching";
    },

    // Lua: rules.lua:160 -- pokefirered/src/battle_ai_script_commands.c:1713
    fleeRate(sf: SafariState | null | undefined): number {
      if (!truthy(sf)) return 0;
      const s = sf as SafariState;
      // pokeemerald/src/battle_ai_script_commands.c:2031
      if (truthy(s.rse)) return (s.escapeFactor ?? 0) * 5;
      let rate: number;
      if ((s.rockCounter ?? 0) !== 0) {
        rate = Math.min(20, (s.escapeFactor ?? 0) * 2);
      } else if ((s.baitCounter ?? 0) !== 0) {
        rate = Math.max(1, Math.floor((s.escapeFactor ?? 0) / 4));
      } else {
        rate = s.escapeFactor ?? 0;
      }
      return rate * 5;
    },

    // Lua: rules.lua:176 -- pokefirered/src/battle_script_commands.c:9497
    ballCatchRate(sf: SafariState | null | undefined): number {
      return Math.floor(((truthy(sf) ? (sf as SafariState).catchFactor : null) ?? 0) * 1275 / 100);
    },

    _rseTables: {} as Record<string, any>,

    // Lua: rules.lua:182
    rseTables(cfg: any): any {
      const rel = truthy(cfg) ? cfg.tables : null;
      if (!truthy(rel)) throw new Error("battle profile safari row has no tables path");
      const hit = Rules.safari._rseTables[rel];
      if (truthy(hit)) return hit;
      const src = Dataset.cache().read(rel);
      if (typeof src !== "string") throw new Error(rel + " is missing from the cache");
      const [chunk, err] = luaLoad(src, "@" + rel);
      if (!chunk) throw new Error(err ?? "assertion failed!");
      const t = chunk();
      Rules.safari._rseTables[rel] = t;
      return t;
    },

    // Lua: rules.lua:195 -- pokeemerald/src/battle_main.c:3113
    newStateRse(catchRate: unknown, cfg: any): SafariState {
      return {
        rse: true,
        balls: cfg.balls,
        catchFactor: Rules.safari.catchFactor(catchRate),
        escapeFactor: cfg.escapeFactor,
        baseCatchRate: tonumber(catchRate) ?? 0,
        goNearCounter: 0,
        pkblThrowCounter: 0,
        pokeblockThrows: 0,
      };
    },

    // Lua: rules.lua:209 -- pokeemerald/src/battle_util.c:589
    goNear(sf: SafariState, tables: any): string {
      const n = sf.goNearCounter ?? 0;
      sf.catchFactor = Math.min(20, (sf.catchFactor ?? 0) + tables.goNearCounterToCatchFactor[n + 1]);
      sf.escapeFactor = Math.min(20, (sf.escapeFactor ?? 0) + tables.goNearCounterToEscapeFactor[n + 1]);
      if (n < 3) {
        sf.goNearCounter = n + 1;
        return "STRINGID_CREPTCLOSER";
      }
      return "STRINGID_CANTGETCLOSER";
    },

    // Lua: rules.lua:221 -- pokeemerald/src/pokeblock.c:1407
    pokeblockGain(tables: any, nature: unknown, flavors: any): number {
      let total = 0;
      for (let f = 1; f <= 5; f++) {
        const v = tonumber(truthy(flavors) ? flavors[f] : null) ?? 0;
        if (v > 0) total = total + v * (tables.flavorCompatibility[(tonumber(nature) ?? 0) * 5 + f - 1] ?? 0);
      }
      return total;
    },

    // pokeemerald/src/battle_message.c:1191
    POKEBLOCK_RESULT: ["STRINGID_PKMNCURIOUSABOUTX", "STRINGID_PKMNENTHRALLEDBYX",
      "STRINGID_PKMNIGNOREDX"] as (string | null)[],

    // Lua: rules.lua:235 -- pokeemerald/src/battle_util.c:561
    throwPokeblock(sf: SafariState, tables: any, gain: number): number {
      const result = (gain === 0) ? 0 : ((gain > 0) ? 1 : 2);
      sf.pokeblockThrows = Math.min(255, (sf.pokeblockThrows ?? 0) + 1);
      if ((sf.pkblThrowCounter ?? 0) < 3) sf.pkblThrowCounter = (sf.pkblThrowCounter ?? 0) + 1;
      if ((sf.escapeFactor ?? 0) > 1) {
        const d = tables.pkblToEscapeFactor[sf.pkblThrowCounter][result + 1];
        // pokeemerald/src/battle_util.c:579
        if ((sf.escapeFactor as number) < d) {
          sf.escapeFactor = 1;
        } else {
          sf.escapeFactor = (sf.escapeFactor as number) - d;
        }
      }
      return result;
    },
  },

  weather: {
    // Lua: rules.lua:253
    kind(weather: unknown): string | null {
      if (!truthy(weather)) return null;
      const w = tostring(weather).toUpperCase();
      if (w === "SUN" || w === "SUNNY" || w === "HARSH_SUN") return "SUN";
      if (w === "RAIN" || w === "RAINY" || w === "DOWNPOUR") return "RAIN";
      if (w === "SAND" || w === "SANDSTORM") return "SAND";
      if (w === "HAIL" || w === "SNOWY") return "HAIL";
      return null;
    },

    // Lua: rules.lua:264 -- pokefirered/include/battle_util.h:49
    effective(st: any, adapter?: any): string | null {
      const kind = Rules.weather.kind(truthy(st) ? st.weather : null);
      if (!truthy(kind)) return null;
      if (truthy(adapter) && truthy(adapter.activeBattlers)) {
        for (const [, b] of ipairs(adapter.activeBattlers())) {
          const ab = adapter.abilityOf(b);
          if (ab === "CLOUD_NINE" || ab === "AIR_LOCK") return null;
        }
      }
      return kind;
    },

    // Lua: rules.lua:276
    typeModifier(weather: unknown, moveTypeName?: string | null): number {
      const kind = Rules.weather.kind(weather);
      const mods: Record<string, Record<string, number>> = {
        SUN: { FIRE: 1.5, WATER: 0.5 },
        RAIN: { WATER: 1.5, FIRE: 0.5 },
      };
      const row = truthy(kind) ? mods[kind as string] : null;
      if (truthy(row) && truthy(moveTypeName) && truthy(row![moveTypeName as string])) return row![moveTypeName as string]!;
      return 1;
    },

    // Lua: rules.lua:287
    chipAmount(maxHp?: number | null): number {
      return Math.max(1, Math.floor((maxHp ?? 16) / Capabilities.weatherChipDenom));
    },

    SAND_IMMUNE: { ROCK: true, GROUND: true, STEEL: true } as Record<string, boolean>,
    HAIL_IMMUNE: { ICE: true } as Record<string, boolean>,

    // Lua: rules.lua:359
    hits(types: any, kind: unknown): boolean {
      const k = Rules.weather.kind(kind) ?? "SAND";
      const immune = (k === "HAIL") ? Rules.weather.HAIL_IMMUNE : Rules.weather.SAND_IMMUNE;
      for (const [, t] of ipairs<string>(types ?? {})) {
        if (immune[t]) return false;
      }
      return true;
    },
  },

  // Critical hit (Gen3)
  crit: {
    CHANCE: [16, 8, 4, 3, 2] as number[],

    // Lua: rules.lua:304 -- pokefirered/src/battle_script_commands.c:1170
    stage(attacker: any, moveOrId: any, highCrit?: boolean | null): number {
      if (!Capabilities.gen3Crit) return 0;
      let stage = 0;
      if (truthy(attacker) && (truthy(attacker.focusEnergy) || truthy(attacker.expFocusEnergy))) {
        stage = stage + 2;
      }
      if (highCrit == null && moveOrId !== null && typeof moveOrId === "object") {
        highCrit = HIGH_CRIT_EFFECTS[tonumber(moveOrId.effect) ?? -1] ?? false;
      }
      if (highCrit) stage = stage + 1;
      let item: any = null;
      if (truthy(attacker)) {
        item = attacker.item;
        if (!truthy(item)) {
          const m = attacker.mon;
          item = truthy(m) ? (truthy(m.item) ? m.item : m.heldItem) : m;
        }
      }
      const itemN = tonumber(item) ?? 0;
      if (itemN === 198) stage = stage + 1;
      let species: number | undefined;
      if (truthy(attacker)) {
        let sp = attacker.species;
        if (!truthy(sp)) sp = truthy(attacker.mon) ? attacker.mon.species : attacker.mon;
        species = tonumber(sp);
      }
      if (itemN === 222 && species === 113) stage = stage + 2;
      if (itemN === 225 && species === 83) stage = stage + 2;
      if (stage > 4) stage = 4;
      return stage;
    },

    // Lua: rules.lua:324
    isHighCritEffect(effect: unknown): boolean {
      return HIGH_CRIT_EFFECTS[tonumber(effect) ?? -1] === true;
    },

    // Lua: rules.lua:339 -- pokefirered/src/battle_script_commands.c:1199
    roll(attacker: any, moveOrId: any, highCrit: boolean | null | undefined, rng: any, st: any): boolean {
      // pokefirered/src/battle_script_commands.c:1200
      if (truthy(Oak.active(st)) && !truthy(Oak.testFlag(st, Oak.FLAG_INFLICT_DMG))) return false;
      // pokeemerald/src/battle_script_commands.c:1281
      if (truthy(st) && truthy(st.kinds) && Kinds.noCrit(st)) return false;
      const stage = Rules.crit.stage(attacker, moveOrId, highCrit);
      const den = Rules.crit.CHANCE[stage] ?? 2;
      const hit = rollZeroTo(rng, den) === 0;
      // pokefirered/src/battle_script_commands.c:1201
      if (truthy(st) && truthy(st.pokedude)) return false;
      return hit;
    },

    // Lua: rules.lua:352
    multiplier(): number {
      return Capabilities.critMultiplier ?? 2;
    },
  },

  // pokefirered/src/battle_script_commands.c:570
  ACCURACY_STAGE: {
    [-6]: seq(33, 100), [-5]: seq(36, 100), [-4]: seq(43, 100), [-3]: seq(50, 100),
    [-2]: seq(60, 100), [-1]: seq(75, 100), 0: seq(1, 1), 1: seq(133, 100),
    2: seq(166, 100), 3: seq(2, 1), 4: seq(233, 100), 5: seq(133, 50), 6: seq(3, 1),
  } as Record<number, (number | null)[]>,

  // Substitute guard
  substitute: {
    // Lua: rules.lua:378
    hasSubstitute(battler: any, adapter?: any): boolean {
      if (!truthy(battler)) return false;
      if (truthy(adapter) && typeof adapter.hasSubstitute === "function") {
        return adapter.hasSubstitute(battler);
      }
      return (battler.substituteHP ?? 0) > 0;
    },

    // Lua: rules.lua:386
    blocks(effectKind: string, target: any, adapter?: any): boolean {
      if (!Rules.substitute.hasSubstitute(target, adapter)) return false;
      const blocked: Record<string, boolean> = {
        status: true, stat_drop: true, taunt: true, yawn: true,
        burn: true, attract: true, pain_split: true,
      };
      return blocked[effectKind] === true;
    },
  },
};

export default Rules;
