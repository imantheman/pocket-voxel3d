// gen1recomp src/core/gen2/Evolution.lua at bdfac727 (MIT): Gen 2 evolution
// -- which species a party member turns into, whether its condition is met
// right now, and what the party record becomes afterwards.
//
// Ported by Brian from engine/pokemon/evolve.asm (EvolveAfterBattle,
// UpdateSpeciesNameIfNotNicknamed, LearnLevelMoves) plus the frame counts of
// engine/movie/evolution_animation.asm. src/ui/gen2/EvolutionAnim.lua is the
// only half that draws. Everything a party member becomes is built by Mon.
//
// Indices: `plan`'s flags set and result `index` are 1-BASED party slots, as
// in the Lua. Lua multiple returns are tuples where a caller reads more than
// the first: METHODS[].check and rowMatches ([ok, reason, consumesHeldItem]),
// check / checkMon ([entry, consumesHeldItem]).

import { Mon } from "../battle/Mon.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { sortedKeys } from "../platform/lua.ts";

/** One `evolutions` row (voxelmon/import/gen2/pokemon.ts Evolution). */
export interface EvoEntry {
  method?: string | number;
  into?: string | number;
  level?: number;
  item?: string;
  time?: string;
  comparison?: string;
  parameter?: number;
  [k: string]: unknown;
}

/** A party record, as far as this module reads it. */
export interface EvoMon {
  species?: string;
  level?: number;
  item?: string;
  happiness?: number;
  stats?: { attack?: number; defense?: number; hp?: number; [k: string]: unknown };
  moves?: any[];
  [k: string]: any;
}

/**
 * The WRAM state EvolveAfterBattle reads:
 *   link         wLinkMode ~= 0 (a trade is in progress)
 *   timeCapsule  wLinkMode == LINK_TIMECAPSULE
 *   force        wForceEvolution ~= 0 (a stone was just used)
 *   item         wCurItem, the stone being used
 *   timeOfDay    wTimeOfDay: MORN / DAY / NITE / DARK
 */
export interface EvoCtx {
  link?: boolean;
  timeCapsule?: boolean;
  force?: boolean;
  item?: string;
  timeOfDay?: string;
  [k: string]: unknown;
}

/** [ok, reason, consumesHeldItem] */
export type EvoCheckResult = [boolean, string?, boolean?];

export interface EvoMethod {
  requiresLink?: boolean;
  requiresForce?: boolean;
  check: (entry: EvoEntry, mon: EvoMon | undefined, ctx: EvoCtx) => EvoCheckResult;
}

export interface EvoData {
  pokemon?: Record<string, any>;
  gen2EvolutionMethods?: Record<string, EvoMethod>;
  [k: string]: any;
}

export interface EvoPlanRow {
  index: number;
  mon: EvoMon;
  entry: EvoEntry;
  into: string | number | undefined;
  consumesHeldItem: boolean;
}

const LEVEL = "EVOLVE_LEVEL";
const ITEM = "EVOLVE_ITEM";
const TRADE = "EVOLVE_TRADE";
const HAPPINESS = "EVOLVE_HAPPINESS";
const STAT = "EVOLVE_STAT";

// Lua: Evolution.lua:84 -- wTimeOfDay is compared against NITE_F only.
function isNight(timeOfDay: unknown): boolean {
  return timeOfDay === Evolution.NITE || timeOfDay === "NITE_F";
}

export const Evolution = {
  // Lua: Evolution.lua:38-42 -- the EVOLVE_* names the extractor writes.
  LEVEL,
  ITEM,
  TRADE,
  HAPPINESS,
  STAT,

  // Lua: Evolution.lua:45 -- HAPPINESS_TO_EVOLVE EQU 220.
  HAPPINESS_TO_EVOLVE: 220,

  // Lua: Evolution.lua:51 -- IsMonHoldingEverstone; NOT checked on ITEM.
  EVERSTONE: "EVERSTONE",

  // Lua: Evolution.lua:55-57 -- TR_*; a row with no `time` is ANYTIME.
  ANYTIME: "ANYTIME",
  MORNDAY: "MORNDAY",
  NITE: "NITE",

  // Lua: Evolution.lua:60-62 -- EVOLVE_STAT comparisons.
  ATK_GT_DEF: "ATK_GT_DEF",
  ATK_LT_DEF: "ATK_LT_DEF",
  ATK_EQ_DEF: "ATK_EQ_DEF",

  // ---------------------------------------------------------------- conditions

  // Lua: Evolution.lua:68
  holdsEverstone(mon: EvoMon | undefined): boolean {
    return (mon && mon.item) === Evolution.EVERSTONE;
  },

  // Lua: Evolution.lua:74 -- .got_tyrogue_evo: CURRENT stats.
  statComparison(mon: EvoMon | undefined): string {
    const stats = (mon && mon.stats) || {};
    const attack = stats.attack ?? 0;
    const defense = stats.defense ?? 0;
    if (attack === defense) return Evolution.ATK_EQ_DEF;
    if (attack < defense) return Evolution.ATK_LT_DEF;
    return Evolution.ATK_GT_DEF;
  },

  // Lua: Evolution.lua:118 -- one record per EvosAttacks method, the shape
  // the `evolution_methods` registry validates. check(entry, mon, ctx) ->
  // [ok, reason, consumesHeldItem]. requiresLink: EVOLVE_TRADE is enabled by
  // a link; requiresForce: EVOLVE_ITEM fires only from a stone's use.
  METHODS: {
    [TRADE]: {
      requiresLink: true,
      check(entry, mon, ctx) {
        if (!ctx.link) return [false, "not trading"];
        if (Evolution.holdsEverstone(mon)) return [false, "everstone"];
        // $ff (written as no item) means any trade will do.
        if (entry.item) {
          if (ctx.timeCapsule) return [false, "time capsule"];
          if ((mon && mon.item) !== entry.item) return [false, "wrong item"];
          // The held item is consumed by the trade evolution.
          return [true, undefined, true];
        }
        return [true];
      },
    },
    [ITEM]: {
      requiresForce: true,
      check(entry, _mon, ctx) {
        if (entry.item && ctx.item !== entry.item) {
          return [false, "wrong item"];
        }
        // .item's `ld a, [wForceEvolution] / and a / jp z`.
        if (!ctx.force) return [false, "not forced"];
        return [true];
      },
    },
    [LEVEL]: {
      check(entry, mon, _ctx) {
        if (((mon && mon.level) ?? 1) < (entry.level ?? 0)) {
          return [false, "level"];
        }
        if (Evolution.holdsEverstone(mon)) return [false, "everstone"];
        return [true];
      },
    },
    [HAPPINESS]: {
      check(entry, mon, ctx) {
        if (((mon && mon.happiness) ?? 0) < Evolution.HAPPINESS_TO_EVOLVE) {
          return [false, "happiness"];
        }
        if (Evolution.holdsEverstone(mon)) return [false, "everstone"];
        const trigger = entry.time ?? Evolution.ANYTIME;
        if (trigger === Evolution.NITE && !isNight(ctx.timeOfDay)) {
          return [false, "daytime"];
        }
        if (trigger === Evolution.MORNDAY && isNight(ctx.timeOfDay)) {
          return [false, "night"];
        }
        return [true];
      },
    },
    [STAT]: {
      check(entry, mon, _ctx) {
        if (((mon && mon.level) ?? 1) < (entry.level ?? 0)) {
          return [false, "level"];
        }
        if (Evolution.holdsEverstone(mon)) return [false, "everstone"];
        if (entry.comparison !== Evolution.statComparison(mon)) {
          return [false, "stats"];
        }
        return [true];
      },
    },
  } as Record<string, EvoMethod>,

  // Lua: Evolution.lua:189 -- vanilla registrations, engine-owned.
  registerInto(registry: { register(id: string, record: unknown, owner: unknown): unknown }, _data: unknown, owner: unknown): void {
    for (const id of sortedKeys(Evolution.METHODS)) {
      registry.register(id, Evolution.METHODS[id], owner);
    }
  },

  // Lua: Evolution.lua:197 -- the merged record, or the module's own.
  methodFor(data: EvoData | undefined, method: unknown): EvoMethod | undefined {
    if (method == null) return undefined;
    const merged = data && data.gen2EvolutionMethods;
    return (merged && merged[method as string]) || Evolution.METHODS[method as string];
  },

  // Lua: Evolution.lua:203 -- one row against one mon, with
  // EvolveAfterBattle's two cross-cutting gates in its order. Returns
  // [ok, reason, consumesHeldItem].
  rowMatches(entry: EvoEntry | undefined, mon: EvoMon | undefined, ctx?: EvoCtx, data?: EvoData): EvoCheckResult {
    ctx = ctx || {};
    if (!(entry && entry.method != null && entry.into != null)) return [false, "empty"];
    const record = Evolution.methodFor(data, entry.method);
    const check = record && record.check;

    // .trade runs BEFORE the link check.
    if (check && record!.requiresLink) return check(entry, mon, ctx);
    // `ld a, [wLinkMode] / and a / jp nz, .dont_evolve_2`.
    if (ctx.link) return [false, "linked"];
    // .item runs before the force check.
    if (check && record!.requiresForce) return check(entry, mon, ctx);
    // Everything else is blocked once wForceEvolution is set.
    if (ctx.force) return [false, "forced"];

    if (!check) return [false, "unknown method"];
    return check(entry, mon, ctx);
  },

  // Lua: Evolution.lua:252 -- the first row of def.evolutions that fires, in
  // EvosAttacks order, each wrapped by the evolution.check hook. Returns
  // [entry, consumesHeldItem] (entry undefined when none fires).
  check(def: any, mon: EvoMon | undefined, ctx?: EvoCtx, data?: EvoData): [EvoEntry | undefined, boolean] {
    const hooked = Runtime.wantsHook("evolution.check");
    for (const entry of ((def && def.evolutions) || []) as EvoEntry[]) {
      let consumes = false;
      const vanilla = (): boolean => {
        const [matched, , eats] = Evolution.rowMatches(entry, mon, ctx, data);
        consumes = eats || false;
        return matched ? true : false;
      };
      let ok: boolean;
      if (hooked) {
        ok = Runtime.call("evolution.check", vanilla as (...a: unknown[]) => boolean, data, mon, entry, ctx);
      } else {
        ok = vanilla();
      }
      if (ok) return [entry, consumes];
    }
    return [undefined, false];
  },

  // Lua: Evolution.lua:275 -- the same, looking the species up.
  checkMon(data: EvoData | undefined, mon: EvoMon | undefined, ctx?: EvoCtx): [EvoEntry | undefined, boolean] {
    const def = data && data.pokemon && mon && data.pokemon[mon.species as string];
    if (!def) return [undefined, false];
    return Evolution.check(def, mon, ctx, data);
  },

  // Lua: Evolution.lua:283 -- ExitBattle runs the sweep only on a WIN.
  runsAfterBattle(outcome: unknown): boolean {
    return outcome !== "lose" && outcome !== "draw";
  },

  // Lua: Evolution.lua:291 -- EvolveAfterBattle_MasterLoop. `flags` is a set
  // of 1-based party indices (wEvolvableFlags), keyed by index; undefined
  // means every slot.
  plan(data: EvoData | undefined, party: EvoMon[] | undefined, flags?: Record<number, unknown> | null, ctx?: EvoCtx): EvoPlanRow[] {
    const out: EvoPlanRow[] = [];
    (party || []).forEach((mon, i) => {
      const index = i + 1;
      if (!flags || flags[index]) {
        const [entry, consumes] = Evolution.checkMon(data, mon, ctx);
        if (entry) {
          out.push({
            index,
            mon,
            entry,
            into: entry.into,
            consumesHeldItem: consumes,
          });
        }
      }
    });
    return out;
  },

  // ------------------------------------------------------------- applying it

  // Lua: Evolution.lua:315
  speciesName(data: EvoData | undefined, species: unknown): unknown {
    const def = data && data.pokemon && data.pokemon[species as string];
    return (def && def.name) ?? species;
  },

  // Lua: Evolution.lua:325 -- UpdateSpeciesNameIfNotNicknamed.
  keptNickname(data: EvoData | undefined, mon: EvoMon | undefined): string | undefined {
    const nickname = mon && mon.nickname;
    if (!nickname || nickname === "") return undefined;
    if (nickname === Evolution.speciesName(data, mon!.species)) return undefined;
    return nickname;
  },

  // Lua: Evolution.lua:337 -- LearnLevelMoves at EXACTLY the current level.
  learnedOnEvolve(data: EvoData | undefined, species: unknown, level: number, mon?: EvoMon): (string | number)[] {
    const def = data && data.pokemon && data.pokemon[species as string];
    const known = new Set<unknown>();
    for (const move of (mon && mon.moves) || []) known.add(move.id);
    const out: (string | number)[] = [];
    for (const row of (def && def.levelMoves) || []) {
      if (row.level === level && !known.has(row.move)) {
        known.add(row.move);
        out.push(row.move);
      }
    }
    return out;
  },

  // Lua: Evolution.lua:355 -- every field Mon's builder writes.
  MON_FIELDS: {
    species: true, name: true, nickname: true, level: true,
    experience: true, dvs: true, stats: true, hp: true, maxHp: true,
    types: true, moves: true, item: true, status: true, happiness: true,
    caughtLevel: true, shiny: true, gender: true,
    caughtTime: true, caughtLocation: true, caughtByGender: true,
  } as Record<string, true>,

  // Lua: Evolution.lua:377 -- turn `mon` into `entry.into`; returns the NEW
  // record. New stats at the same level/DVs, HP += the max-HP delta, the
  // trade-with-item branch eats the held item.
  apply(data: EvoData, mon: EvoMon, entry: EvoEntry): EvoMon | undefined {
    const species = entry && entry.into;
    const def = data && data.pokemon && species != null && data.pokemon[species as string];
    if (!def) return undefined;

    const level = mon.level ?? 1;
    // engine/pokemon/evolve.asm:261-264
    const statExp = mon.statExp;
    const stats = Mon.stats(def.baseStats, mon.dvs, level, statExp);
    const previousMax = mon.maxHp ?? (mon.stats && mon.stats.hp) ?? stats.hp;
    let hp = (mon.hp ?? previousMax) + (stats.hp - previousMax);
    hp = Math.max(0, Math.min(stats.hp, hp));

    // `xor a / ld [wTempMonItem], a` only on the trade row that DEMANDED it.
    let heldItem = mon.item;
    if (entry.method === Evolution.TRADE && entry.item) heldItem = undefined;

    const evolved: EvoMon | undefined = Mon.new(data, species as string, level, {
      dvs: mon.dvs,
      statExp,
      moves: mon.moves,
      hp,
      item: heldItem,
      happiness: mon.happiness,
      nickname: Evolution.keptNickname(data, mon),
    });
    if (!evolved) return undefined;

    // wTempMonExp is never touched.
    evolved.experience = mon.experience;
    evolved.status = mon.status;
    evolved.caughtLevel = mon.caughtLevel;
    // engine/pokemon/evolve.asm:291-293
    evolved.caughtTime = mon.caughtTime;
    evolved.caughtLocation = mon.caughtLocation;
    evolved.caughtByGender = mon.caughtByGender;
    // Fields Mon.new does not own ride along.
    for (const key of Object.keys(mon)) {
      if (Evolution.MON_FIELDS[key] == null) evolved[key] = mon[key];
    }
    Runtime.emit("pokemon.evolved", {
      mon: evolved, fromSpecies: mon.species, toSpecies: species,
      via: entry.method,
    });
    return evolved;
  },

  // Lua: Evolution.lua:445 -- SetSeenAndCaughtMon.
  markPokedex(save: any, species: string | undefined): boolean {
    if (!(save && species != null)) return false;
    save.pokedex = save.pokedex || {};
    save.pokedex.seen = save.pokedex.seen || {};
    save.pokedex.caught = save.pokedex.caught || {};
    save.pokedex.seen[species] = true;
    save.pokedex.caught[species] = true;
    return true;
  },

  // ------------------------------- animation schedule (evolution_animation.asm)

  // Lua: Evolution.lua:463 -- EvolvingText then `ld c, 50 / call DelayFrames`.
  EVOLVING_FRAMES: 50,
  // Lua: Evolution.lua:467 -- cry, MUSIC_EVOLUTION, then 80 frames.
  MUSIC_FRAMES: 80,
  // Lua: Evolution.lua:471 -- one WaitBGMap per pic swap.
  SWAP_FRAMES: 1,
  // Lua: Evolution.lua:475-476 -- .PlayEvolvedSFX: 32 spawning + 32 more.
  BALL_SPAWN_FRAMES: 32,
  BALL_TAIL_FRAMES: 32,
  // Lua: Evolution.lua:480 -- after the texts, `ld c, 40`.
  CONGRATS_FRAMES: 40,

  // Lua: Evolution.lua:486 -- `lb bc, 1, 16`, per round `inc b / dec c / dec c`.
  flashRounds(): { wait: number; flashes: number }[] {
    const rounds: { wait: number; flashes: number }[] = [];
    let flashes = 1;
    let wait = 16;
    while (wait > 0) {
      rounds.push({ wait, flashes });
      flashes = flashes + 1;
      wait = wait - 2;
    }
    return rounds;
  },

  // Lua: Evolution.lua:498
  flashFrames(): number {
    let total = 0;
    for (const round of Evolution.flashRounds()) {
      total = total + round.wait + round.flashes * 2 * Evolution.SWAP_FRAMES;
    }
    return total;
  },

  // Lua: Evolution.lua:509-511 -- AnimSeq_RevealNewMon radii.
  BALL_RADIUS_START: 0x10,
  BALL_RADIUS_STEP: 0x08,
  BALL_RADIUS_END: 0x80,

  // Lua: Evolution.lua:516-517 -- depixel 9, 11 minus the OAM offset.
  BALL_ORIGIN_X: 11 * 8 - 8,
  BALL_ORIGIN_Y: 9 * 8 - 16,
};

export default Evolution;
