// gen1recomp src/core/gen2/Apricorns.lua at bdfac727 (MIT): Kurt, the
// apricorns, the trees they grow on, and the day he takes to turn one into a
// ball (Kurt_SelectApricorn, data/items/apricorn_balls.asm, the
// SelectApricornForKurt special, engine/events/fruit_trees.asm's lookups, and
// the daily reset of engine/overworld/time.asm).
//
// THE DAY-LONG WAIT: Kurt runs no timer. ENGINE_KURT_MAKING_BALLS is a
// wDailyFlags1 bit and only CheckDailyResetTimer's once-a-day wipe clears it,
// so "tomorrow" is "after the next rollover" (and winding the clock back
// rolls over at once, as on the cart).
//
// Indexing: bagList's `choice`/`cancel` and FRUITTREE_* tree ids stay 1-based
// as the Lua passes them (FRUIT_TREES[tree - 1] in storage). save.events
// (byte index -> byte), save.engineFlags (ENGINE_* id -> true) and
// save.fruitTrees (FRUITTREE_* id -> true) are objects with numeric keys.
// `pending` and `updateTimeRemaining` return tuples (their callers read both
// values); `give` and `collect` return their first value only.

import { BugContest } from "./BugContest.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { tostring, truthy } from "../platform/lua.ts";

/** One apricorn_balls.asm row; `index` is its 1-based table position. */
export interface ApricornRow {
  apricorn: string;
  ball: string;
  event: number;
  index?: number;
  [k: string]: unknown;
}

/** bagList's answer: the apricorns in table order, plus the CANCEL row's 1-based position. */
export type ApricornBagList = string[] & { cancel: number; empty: boolean };

type SaveLike = Record<string, any> | null | undefined;
type ResolveId = ((name: string, id: number | undefined) => number | string | false | undefined | null) | null | undefined;

// Lua: Apricorns.lua:55-63 -- data/items/apricorn_balls.asm, in table order.
let BALLS: ApricornRow[] = [
  { apricorn: "RED_APRICORN", ball: "LEVEL_BALL", event: 600 },
  { apricorn: "BLU_APRICORN", ball: "LURE_BALL", event: 601 },
  { apricorn: "YLW_APRICORN", ball: "MOON_BALL", event: 602 },
  { apricorn: "GRN_APRICORN", ball: "FRIEND_BALL", event: 603 },
  { apricorn: "WHT_APRICORN", ball: "FAST_BALL", event: 604 },
  { apricorn: "BLK_APRICORN", ball: "HEAVY_BALL", event: 605 },
  { apricorn: "PNK_APRICORN", ball: "LOVE_BALL", event: 606 },
];

// Lua: Apricorns.lua:99-104
let BY_APRICORN: Record<string, ApricornRow> = {};
let BY_BALL: Record<string, ApricornRow> = {};
BALLS.forEach((row, i) => {
  row.index = i + 1;
  BY_APRICORN[row.apricorn] = row;
  BY_BALL[row.ball] = row;
});

// Lua: Apricorns.lua:119-138 -- rebuild the three lookups from the merged registry.
function rebuildLookups(rows: Record<string, any>): number {
  const ordered: ApricornRow[] = [];
  for (const k of Object.keys(rows)) {
    const row = rows[k];
    if (row !== null && typeof row === "object" && row.apricorn && row.ball) {
      ordered.push(row);
    }
  }
  ordered.sort((a, b) => {
    if ((a.index || 0) !== (b.index || 0)) {
      return (a.index || 0) - (b.index || 0);
    }
    const sa = tostring(a.apricorn);
    const sb = tostring(b.apricorn);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  BALLS = ordered;
  Apricorns.BALLS = ordered;
  BY_APRICORN = {};
  BY_BALL = {};
  for (const row of ordered) {
    BY_APRICORN[row.apricorn] = row;
    BY_BALL[row.ball] = row;
  }
  return ordered.length;
}

// Lua: Apricorns.lua:193 -- save.events is the serialized wEventFlags bitfield.
const FLAGS_PER_BYTE = 8;

// Lua: Apricorns.lua:195-199
function events(save: SaveLike): Record<string, number> | undefined {
  if (save === null || typeof save !== "object") return undefined;
  save.events = save.events || {};
  return save.events;
}

// Lua: Apricorns.lua:201-205
function engineFlags(save: SaveLike): Record<string, any> | undefined {
  if (save === null || typeof save !== "object") return undefined;
  save.engineFlags = save.engineFlags || {};
  return save.engineFlags;
}

// Lua: Apricorns.lua:361-366 -- UpdateTimeRemaining: [left, expired].
function updateTimeRemaining(remaining: number, elapsed: number): [number, boolean] {
  if (elapsed === -1) return [0, true];
  let left = remaining - elapsed;
  if (left < 0) left = 0;
  return [left, left === 0];
}

// Lua: Apricorns.lua:466-470
function treeFlags(save: SaveLike): Record<string, boolean> | undefined {
  if (save === null || typeof save !== "object") return undefined;
  save.fruitTrees = save.fruitTrees || {};
  return save.fruitTrees;
}

// Lua: Apricorns.lua:426-457 -- data/items/fruit_trees.asm, FRUITTREE_* order
// (the enum is 1-based: tree t is FRUIT_TREES[t - 1]).
const FRUIT_TREES: string[] = [
  "BERRY", // 01 FRUITTREE_ROUTE_29
  "BERRY", // 02 FRUITTREE_ROUTE_30_1
  "BERRY", // 03 FRUITTREE_ROUTE_38
  "BERRY", // 04 FRUITTREE_ROUTE_46_1
  "PSNCUREBERRY", // 05 FRUITTREE_ROUTE_30_2
  "PSNCUREBERRY", // 06 FRUITTREE_ROUTE_33
  "BITTER_BERRY", // 07 FRUITTREE_ROUTE_31
  "BITTER_BERRY", // 08 FRUITTREE_ROUTE_43
  "PRZCUREBERRY", // 09 FRUITTREE_VIOLET_CITY
  "PRZCUREBERRY", // 0a FRUITTREE_ROUTE_46_2
  "MYSTERYBERRY", // 0b FRUITTREE_ROUTE_35
  "MYSTERYBERRY", // 0c FRUITTREE_ROUTE_45
  "ICE_BERRY", // 0d FRUITTREE_ROUTE_36
  "ICE_BERRY", // 0e FRUITTREE_ROUTE_26
  "MINT_BERRY", // 0f FRUITTREE_ROUTE_39
  "BURNT_BERRY", // 10 FRUITTREE_ROUTE_44
  "RED_APRICORN", // 11 FRUITTREE_ROUTE_37_1
  "BLU_APRICORN", // 12 FRUITTREE_ROUTE_37_2
  "BLK_APRICORN", // 13 FRUITTREE_ROUTE_37_3
  "WHT_APRICORN", // 14 FRUITTREE_AZALEA_TOWN
  "PNK_APRICORN", // 15 FRUITTREE_ROUTE_42_1
  "GRN_APRICORN", // 16 FRUITTREE_ROUTE_42_2
  "YLW_APRICORN", // 17 FRUITTREE_ROUTE_42_3
  "BERRY", // 18 FRUITTREE_ROUTE_11
  "PSNCUREBERRY", // 19 FRUITTREE_ROUTE_2
  "BITTER_BERRY", // 1a FRUITTREE_ROUTE_1
  "PRZCUREBERRY", // 1b FRUITTREE_ROUTE_8
  "ICE_BERRY", // 1c FRUITTREE_PEWTER_CITY_1
  "MINT_BERRY", // 1d FRUITTREE_PEWTER_CITY_2
  "BURNT_BERRY", // 1e FRUITTREE_FUCHSIA_CITY
];

export const Apricorns = {
  BALLS,

  // Lua: Apricorns.lua:67 -- ENGINE_KURT_MAKING_BALLS (wDailyFlags1 bit 0).
  ENGINE_KURT_MAKING_BALLS: 79,

  // Lua: Apricorns.lua:75-93 -- every ENGINE_* id in wDailyFlags1/2, in order.
  DAILY_ENGINE_FLAGS: [
    { id: 79, name: "ENGINE_KURT_MAKING_BALLS" },
    { id: 80, name: "ENGINE_DAILY_BUG_CONTEST" },
    { id: 81, name: "ENGINE_SWARM" },
    { id: 82, name: "ENGINE_TIME_CAPSULE" },
    { id: 83, name: "ENGINE_ALL_FRUIT_TREES" },
    { id: 84, name: "ENGINE_GOT_SHUCKIE_TODAY" },
    { id: 85, name: "ENGINE_GOLDENROD_UNDERGROUND_MERCHANT_CLOSED" },
    { id: 86, name: "ENGINE_FOUGHT_IN_TRAINER_HALL_TODAY" },
    { id: 87, name: "ENGINE_MT_MOON_SQUARE_CLEFAIRY" },
    { id: 88, name: "ENGINE_UNION_CAVE_LAPRAS" },
    { id: 89, name: "ENGINE_GOLDENROD_UNDERGROUND_GOT_HAIRCUT" },
    { id: 90, name: "ENGINE_GOLDENROD_DEPT_STORE_TM27_RETURN" },
    { id: 91, name: "ENGINE_DAISYS_GROOMING" },
    { id: 92, name: "ENGINE_INDIGO_PLATEAU_RIVAL_FIGHT" },
    // ../pokecrystal/constants/engine_flags.asm:113-114
    { name: "ENGINE_DAILY_MOVE_TUTOR" },
    { name: "ENGINE_BUENAS_PASSWORD" },
  ] as { id?: number; name: string }[],

  // Lua: Apricorns.lua:97 -- what TryResetFruitTrees tests.
  ENGINE_ALL_FRUIT_TREES: 83,

  /** Lua: Apricorns.lua:141 -- vanilla registrations, engine-owned. */
  registerInto(registry: any, _unused: unknown, owner: unknown): number {
    for (const row of Apricorns.BALLS) {
      registry.register(row.apricorn, row, owner);
    }
    return Apricorns.BALLS.length;
  },

  /** Lua: Apricorns.lua:150 -- fold data.gen2Apricorns into the lookups. */
  useRegistry(data: any): number {
    const rows = data && data.gen2Apricorns;
    if (rows === null || typeof rows !== "object") return 0;
    return rebuildLookups(rows);
  },

  /** Lua: Apricorns.lua:156 */
  row(apricorn: string): ApricornRow | undefined {
    return BY_APRICORN[apricorn];
  },

  /** Lua: Apricorns.lua:157 */
  isApricorn(item: string): boolean {
    return BY_APRICORN[item] !== undefined;
  },

  /** Lua: Apricorns.lua:159 */
  ballFor(apricorn: string): string | undefined {
    const row = BY_APRICORN[apricorn];
    return row ? row.ball : undefined;
  },

  /** Lua: Apricorns.lua:164 */
  apricornFor(ball: string): string | undefined {
    const row = BY_BALL[ball];
    return row ? row.apricorn : undefined;
  },

  /** Lua: Apricorns.lua:207 -- one wEventFlags bit of a save at rest. */
  event(save: SaveLike, id: number | null | undefined): boolean {
    const flags = events(save);
    if (!(flags && id != null)) return false;
    const byte = flags[Math.floor(id / FLAGS_PER_BYTE)] || 0;
    return Math.floor(byte / 2 ** (id % FLAGS_PER_BYTE)) % 2 === 1;
  },

  /** Lua: Apricorns.lua:214 */
  setEvent(save: SaveLike, id: number | null | undefined, value: boolean): void {
    const flags = events(save);
    if (!(flags && id != null)) return;
    const index = Math.floor(id / FLAGS_PER_BYTE);
    const mask = 2 ** (id % FLAGS_PER_BYTE);
    const byte = flags[index] || 0;
    const set = Math.floor(byte / mask) % 2 === 1;
    if (value && !set) {
      flags[index] = byte + mask;
    } else if (!value && set) {
      flags[index] = byte - mask;
    }
  },

  /**
   * Lua: Apricorns.lua:237 -- FindApricornsInBag over the item -> count
   * map: apricorns held, in table order; `cancel` is the CANCEL row's
   * 1-based position, `empty` when there are none.
   */
  bagList(inventory: Record<string, number> | null | undefined): ApricornBagList {
    inventory = inventory || {};
    const list = [] as unknown as ApricornBagList;
    for (const row of Apricorns.BALLS) {
      if ((inventory[row.apricorn] || 0) > 0) {
        list.push(row.apricorn);
      }
    }
    // The CANCEL row is part of the cart's list (wKurtApricornCount counts it).
    list.cancel = list.length + 1;
    list.empty = list.length === 0;
    return list;
  },

  /** Lua: Apricorns.lua:255 -- SelectApricornForKurt's wScriptVar; `choice` 1-based. */
  select(inventory: Record<string, number> | null | undefined, choice: number | null | undefined): string | undefined {
    const list = Apricorns.bagList(inventory);
    if (list.empty) return undefined;
    if (choice == null || choice >= list.cancel) return undefined;
    return list[choice - 1];
  },

  /** Lua: Apricorns.lua:269 -- the special's own TossItem of one apricorn. */
  takeApricorn(save: SaveLike, apricorn: string): boolean {
    if (!(save && BY_APRICORN[apricorn])) return false;
    const inventory = save.inventory || {};
    save.inventory = inventory;
    let have = inventory[apricorn] || 0;
    if (have <= 0) return false;
    have = have - 1;
    if (have > 0) inventory[apricorn] = have;
    else delete inventory[apricorn];
    return true;
  },

  /**
   * Lua: Apricorns.lua:284 -- the whole handover: take, setevent, setflag.
   * (The Lua also returns the ball second; nothing reads it -- ballFor has it.)
   */
  give(save: SaveLike, apricorn: string): boolean {
    const row = BY_APRICORN[apricorn];
    if (!row) return false;
    if (!Apricorns.takeApricorn(save, apricorn)) return false;
    Apricorns.setEvent(save, row.event, true);
    const flags = engineFlags(save);
    if (flags) flags[Apricorns.ENGINE_KURT_MAKING_BALLS] = true;
    return true;
  },

  /** Lua: Apricorns.lua:297 -- [apricorn, ball] Kurt holds, in Kurt1's order, or undefined. */
  pending(save: SaveLike): [string, string] | undefined {
    for (const row of Apricorns.BALLS) {
      if (Apricorns.event(save, row.event)) {
        return [row.apricorn, row.ball];
      }
    }
    return undefined;
  },

  /** Lua: Apricorns.lua:306 */
  isWorking(save: SaveLike): boolean {
    const flags = engineFlags(save);
    return (flags && flags[Apricorns.ENGINE_KURT_MAKING_BALLS]) === true;
  },

  /** Lua: Apricorns.lua:315 -- the ball, once he has an apricorn and the day rolled over. */
  readyBall(save: SaveLike): string | undefined {
    if (Apricorns.isWorking(save)) return undefined;
    const p = Apricorns.pending(save);
    return p ? p[1] : undefined;
  },

  /**
   * Lua: Apricorns.lua:325 -- the handover's clearevent. Returns the ball
   * (the Lua also returns the apricorn second; apricornFor has it).
   */
  collect(save: SaveLike): string | undefined {
    const ball = Apricorns.readyBall(save);
    if (!ball) return undefined;
    const apricorn = Apricorns.apricornFor(ball)!;
    const row = BY_APRICORN[apricorn]!;
    Apricorns.setEvent(save, row.event, false);
    // apricorn.converted (a Gen 2 invention), raised on the handover.
    if (Runtime.wants("apricorn.converted")) {
      Runtime.emit("apricorn.converted",
        { apricorn, ball, event: row.event });
    }
    return ball;
  },

  /** Lua: Apricorns.lua:350 -- RestartDailyResetTimer: {remaining: 1, day}. */
  startDailyResetTimer(save: SaveLike, now?: any): { remaining: number; day: number } | undefined {
    if (save === null || typeof save !== "object") return undefined;
    const stamp = now || BugContest.now();
    save.dailyReset = { remaining: 1, day: stamp.day };
    return save.dailyReset;
  },

  updateTimeRemaining,

  /**
   * Lua: Apricorns.lua:378 -- CheckDailyResetTimer: advances the stored day
   * to today, and on expiry wipes wDailyFlags1/2 and restarts the timer.
   * True on the call the rollover happened. `now` is a BugContest.now() stamp.
   */
  checkDailyResetTimer(save: SaveLike, now?: any, resolveId?: ResolveId): boolean {
    if (save === null || typeof save !== "object") return false;
    if (!save.dailyReset) {
      Apricorns.startDailyResetTimer(save, now);
      return false;
    }
    const timer = save.dailyReset;
    const stamp: Record<string, any> = { day: timer.day };
    const since = BugContest.elapsedSince(stamp, now, "day");
    timer.day = stamp.day;
    const [remaining, expired] = updateTimeRemaining(timer.remaining || 1,
      since.days);
    timer.remaining = remaining;
    if (!expired) return false;
    Apricorns.dailyReset(save, resolveId);
    Apricorns.startDailyResetTimer(save, now);
    return true;
  },

  /**
   * Lua: Apricorns.lua:403 -- clear every daily engine flag (by id, and by
   * `resolveId(name, id)` when given), and save.dailyFlags.
   */
  dailyReset(save: SaveLike, resolveId?: ResolveId): void {
    const flags = engineFlags(save);
    if (!flags) return;
    for (const row of Apricorns.DAILY_ENGINE_FLAGS) {
      if (row.id != null) delete flags[row.id];
      if (resolveId) {
        const id = resolveId(row.name, row.id);
        if (truthy(id)) delete flags[id as string | number];
      }
    }
    // Specials' ActivateFishingSwarm keeps some under names (save.dailyFlags).
    save!.dailyFlags = {};
  },

  FRUIT_TREES,
  NUM_FRUIT_TREES: FRUIT_TREES.length,

  /** Lua: Apricorns.lua:462 -- GetCurTreeFruit (tree is the 1-based FRUITTREE_*). */
  treeFruit(tree: number): string | undefined {
    return FRUIT_TREES[tree - 1];
  },

  /** Lua: Apricorns.lua:476 -- TryResetFruitTrees: refill all once a day. */
  tryResetFruitTrees(save: SaveLike): boolean {
    const flags = engineFlags(save);
    if (!flags) return false;
    if (flags[Apricorns.ENGINE_ALL_FRUIT_TREES]) return false;
    save!.fruitTrees = {};
    flags[Apricorns.ENGINE_ALL_FRUIT_TREES] = true;
    return true;
  },

  /** Lua: Apricorns.lua:488 -- CheckFruitTree: true for a tree already picked. */
  treePicked(save: SaveLike, tree: number): boolean {
    const flags = treeFlags(save);
    return (flags && flags[tree]) === true;
  },

  /** Lua: Apricorns.lua:494 -- PickedFruitTree: the fruit, or undefined if picked/unknown. */
  pickTree(save: SaveLike, tree: number): string | undefined {
    const flags = treeFlags(save);
    if (!(flags && FRUIT_TREES[tree - 1])) return undefined;
    if (flags[tree]) return undefined;
    flags[tree] = true;
    return FRUIT_TREES[tree - 1];
  },
};

export default Apricorns;
