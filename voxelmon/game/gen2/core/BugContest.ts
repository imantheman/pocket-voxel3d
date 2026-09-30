// gen1recomp src/core/gen2/BugContest.lua at bdfac727 (MIT): the Bug
// Catching Contest (engine/events/bug_contest/).
//
// A MODE: the party is masked to the lead mon, the pack is twenty PARK BALLs,
// a twenty-minute clock runs off the RTC, encounters come from the contest's
// own table, and one caught mon is kept at a time. The judge scores it
// against the five contestants in the park; placing 1st wins a SUN STONE.
//
//   ContestScore / ComputeAIContestantScores / DetermineContestWinners /
//   BugContest_GetPlayersResult     bug_contest/judging.asm
//   BugContestantPointers           data/events/bug_contest_winners.asm
//   BugCatchingContestantEventFlagTable  data/events/bug_contest_flags.asm
//   ContestMons                     data/wild/bug_contest_mons.asm
//   Choose/TryWildEncounter_BugContest  engine/overworld/events.asm
//   ContestDropOffMons / ContestReturnMons  bug_contest/contest_2.asm
//   BugContest_SetCaughtContestMon  bug_contest/caught_mon.asm
//   GiveParkBalls                   bug_contest/contest.asm
//   Start/CheckBugContestTimer      engine/overworld/time.asm
//
// Nothing here draws (ContestMenu is the STOCK-versus-THIS screen). The
// driver is the extracted script bytecode; see the module map at the bottom.
// Also carries the RTC delta helpers from engine/overworld/time.asm.
//
// Indexing: contestant slots are 1..10 in this API (winner ids 2..11, the
// player is 1), stored 0-based in CONTESTANTS / FLAGS. state.contestants is a
// sparse JS array indexed slot - 1. save.party is 0-based. Multiple returns:
// `catch` returns [kind, stock, fresh] and `collectCaughtMon` [scriptVar, mon].

import { Runtime } from "../shared/mods/Runtime.ts";
import { Mon } from "../battle/Mon.ts";
import { Boxes } from "./Boxes.ts";
import { idiv, mod, truthy } from "../platform/lua.ts";
import { random as rngRandom } from "../platform/rng.ts";
import { osDate, osTime } from "../platform/clock.ts";

type SaveLike = Record<string, any> | null | undefined;
/** A `call Random`: no arguments, 0..255. */
export type ByteRandom = (() => number) | null | undefined;

/** The host clock in the cart's shape (wCurDay 0..139). */
export interface ContestClock {
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface Elapsed {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export interface ContestMonRow {
  chance: number;
  species: string;
  min: number;
  max: number;
}

export interface Contestant {
  class: string;
  trainer: number;
  name: string;
  mons: { species: string; score: number }[];
}

export interface PodiumEntry {
  id: number;
  species: string | undefined;
  score: number;
}

export interface Podium {
  first?: PodiumEntry;
  second?: PodiumEntry;
  third?: PodiumEntry;
}

/** save.bugContest, spelled after the WRAM it stands in for. */
export interface ContestState {
  /** ENGINE_BUG_CONTEST_TIMER */
  active?: boolean;
  /** wParkBallsRemaining */
  balls?: number;
  /** wBugContestMinsRemaining / SecsRemaining */
  minutes?: number;
  seconds?: number;
  /** wBugContestStartTime */
  startTime?: Partial<ContestClock>;
  /** wContestMon */
  caught?: any;
  /** the party tail ContestDropOffMons masks off */
  stash?: any[];
  /** slot - 1 -> true for a SET flag (NOT in this contest) */
  contestants?: boolean[];
  /** wBugContestResults */
  results?: Podium;
  playerScore?: number;
  /** BugContestJudging's wScriptVar, 0..3 */
  place?: number;
  [k: string]: unknown;
}

// Lua: BugContest.lua:92-97 -- wCurDay wraps by 20 * 7; MAX_HOUR.
const DAY_WRAP = 20 * 7;
const HOUR_WRAP = 24;

// Lua: BugContest.lua:122-127 -- one `sub`/`sbc` step: [value, borrow].
function borrowed(value: number, wrap: number): [number, number] {
  if (value < 0) return [value + wrap, 1];
  return [value, 0];
}

// Lua: BugContest.lua:246-248
function byte(random: ByteRandom): number {
  return (random ?? BugContest.random)();
}

// Lua: BugContest.lua:399-401 -- a byte read, and bit 1 of a DV.
function low(value: number | undefined): number {
  return mod(Math.floor(value ?? 0), 256);
}

function bit1(value: number | undefined): number {
  return mod(Math.floor((value ?? 0) / 2), 2);
}

// Lua: BugContest.lua:420-429 -- CompareBytes carries only on STRICTLY LESS,
// so an equal score displaces the sitting entry (the player, scored last,
// wins a tie).
function beats(entry: PodiumEntry, incumbent: PodiumEntry | undefined): boolean {
  return (entry.score ?? 0) >= ((incumbent ? incumbent.score : undefined) ?? 0);
}

// Lua: BugContest.lua:431-434
function copyEntry(entry: PodiumEntry | undefined): PodiumEntry | undefined {
  if (!entry) return undefined;
  return { id: entry.id, species: entry.species, score: entry.score };
}

export const BugContest = {
  // Lua: BugContest.lua:47-57 -- constants/script_constants.asm.
  BALLS: 20,
  MINUTES: 20,
  SECONDS: 0,
  PLAYER: 1,
  NUM_CONTESTANTS: 10,
  CONTESTANT_SIZE: 4,
  CONTESTANTS_PICKED: 5,
  // Lua: BugContest.lua:59-63 -- CheckPartyFullAfterContest's wScriptVar.
  CAUGHT_MON: 0,
  BOXED_MON: 1,
  NO_CATCH: 2,
  // Lua: BugContest.lua:65-71 -- ENGINE_* indices.
  ENGINE_BUG_CONTEST_TIMER: 16,
  ENGINE_DAILY_BUG_CONTEST: 80,
  // Lua: BugContest.lua:73-80 -- GetWeekday numbers (SUNDAY == 0); the
  // contest runs Tuesday, Thursday and Saturday.
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
  CONTEST_DAYS: { 2: true, 4: true, 6: true } as Record<number, boolean>,
  // Lua: BugContest.lua:82-85 -- 1st/2nd/3rd (place p at PRIZES[p - 1]).
  PRIZES: ["SUN_STONE", "EVERSTONE", "GOLD_BERRY"] as string[],
  CONSOLATION_PRIZE: "BERRY",
  // Lua: BugContest.lua:87-90
  BALL: "PARK_BALL",
  DAY_WRAP,
  HOUR_WRAP,

  // Lua: BugContest.lua:202-223 -- data/wild/bug_contest_mons.asm; `chance`
  // is a slice of 100, and the trailing VENOMOTH (-1, "always") row is
  // unreachable but kept.
  MONS: [
    { chance: 20, species: "CATERPIE", min: 7, max: 18 },
    { chance: 20, species: "WEEDLE", min: 7, max: 18 },
    { chance: 10, species: "METAPOD", min: 9, max: 18 },
    { chance: 10, species: "KAKUNA", min: 9, max: 18 },
    { chance: 5, species: "BUTTERFREE", min: 12, max: 15 },
    { chance: 5, species: "BEEDRILL", min: 12, max: 15 },
    { chance: 10, species: "VENONAT", min: 10, max: 16 },
    { chance: 10, species: "PARAS", min: 10, max: 17 },
    { chance: 5, species: "SCYTHER", min: 13, max: 14 },
    { chance: 5, species: "PINSIR", min: 13, max: 14 },
    { chance: 255, species: "VENOMOTH", min: 30, max: 40 },
  ] as ContestMonRow[],

  // Lua: BugContest.lua:250-254 -- `percent` is `* $ff / 100`: 102 and 51.
  ENCOUNTER_RATE_SUPER_TALL: Math.floor(40 * 0xff / 100),
  ENCOUNTER_RATE_GRASS: Math.floor(20 * 0xff / 100),

  // Lua: BugContest.lua:294-348 -- BugContestantPointers slots 1..10 (slot 0,
  // the unused Don duplicate, is not kept); slot s at CONTESTANTS[s - 1].
  CONTESTANTS: [
    { class: "BUG_CATCHER", trainer: 1, name: "DON",
      mons: [{ species: "KAKUNA", score: 300 }, { species: "METAPOD", score: 285 }, { species: "CATERPIE", score: 226 }] },
    { class: "BUG_CATCHER", trainer: 3, name: "ED",
      mons: [{ species: "BUTTERFREE", score: 286 }, { species: "BUTTERFREE", score: 251 }, { species: "CATERPIE", score: 237 }] },
    { class: "COOLTRAINERM", trainer: 1, name: "NICK",
      mons: [{ species: "SCYTHER", score: 357 }, { species: "BUTTERFREE", score: 349 }, { species: "PINSIR", score: 368 }] },
    { class: "POKEFANM", trainer: 1, name: "WILLIAM",
      mons: [{ species: "PINSIR", score: 332 }, { species: "BUTTERFREE", score: 324 }, { species: "VENONAT", score: 321 }] },
    { class: "BUG_CATCHER", trainer: 5, name: "BENNY",
      mons: [{ species: "BUTTERFREE", score: 318 }, { species: "WEEDLE", score: 295 }, { species: "CATERPIE", score: 285 }] },
    { class: "CAMPER", trainer: 5, name: "BARRY",
      mons: [{ species: "PINSIR", score: 366 }, { species: "VENONAT", score: 329 }, { species: "KAKUNA", score: 314 }] },
    { class: "PICNICKER", trainer: 5, name: "CINDY",
      mons: [{ species: "BUTTERFREE", score: 341 }, { species: "METAPOD", score: 301 }, { species: "CATERPIE", score: 264 }] },
    { class: "BUG_CATCHER", trainer: 7, name: "JOSH",
      mons: [{ species: "SCYTHER", score: 326 }, { species: "BUTTERFREE", score: 292 }, { species: "METAPOD", score: 282 }] },
    { class: "YOUNGSTER", trainer: 5, name: "SAMUEL",
      mons: [{ species: "WEEDLE", score: 270 }, { species: "PINSIR", score: 282 }, { species: "CATERPIE", score: 251 }] },
    { class: "SCHOOLBOY", trainer: 2, name: "KIPP",
      mons: [{ species: "VENONAT", score: 267 }, { species: "PARAS", score: 254 }, { species: "KAKUNA", score: 259 }] },
  ] as Contestant[],

  // Lua: BugContest.lua:542-556 -- EVENT_BUG_CATCHING_CONTESTANT_1A.._10A by
  // number, slot order (slot s at FLAGS[s - 1]).
  FLAGS: [1814, 1815, 1816, 1817, 1818, 1819, 1820, 1821, 1822, 1823] as number[],

  // Lua: BugContest.lua:753-758
  KEEP_FIRST: "first",
  ASK_SWITCH: "switch",

  // Lua: BugContest.lua:834
  SCREEN_ID: "Gen2ContestMenu",

  // Lua: BugContest.lua:99-111 -- the host clock in the cart's shape; `stamp`
  // is an os.time() value. The day is local days since the epoch folded into
  // wCurDay's range.
  now(stamp?: number): ContestClock {
    const t = osDate("*t", stamp);
    const midday = osTime({ year: t.year, month: t.month, day: t.day, hour: 12, min: 0, sec: 0 });
    const day = mod(idiv(midday, 86400), DAY_WRAP);
    return { day, hour: t.hour, minute: t.min, second: t.sec };
  },

  // Lua: BugContest.lua:113-116 -- GetWeekday: wCurDay mod 7, SUNDAY == 0.
  weekday(now?: Partial<ContestClock> | null): number {
    return mod((now ?? BugContest.now()).day ?? 0, 7);
  },

  // Lua: BugContest.lua:118-120
  isContestDay(now?: Partial<ContestClock> | null): boolean {
    return BugContest.CONTEST_DAYS[BugContest.weekday(now)] === true;
  },

  // Lua: BugContest.lua:129-174 -- CalcSecsMinsHoursDaysSince. ADVANCES the
  // stamp to `now` in place (deltas are since the LAST poll) and every unit
  // wraps, so a rewound clock reads as a huge jump forward. `depth`:
  // "day" / "minute" / "second" (default).
  elapsedSince(stamp: Partial<ContestClock>, nowIn?: Partial<ContestClock> | null, depthIn?: string): Elapsed {
    const now = nowIn ?? BugContest.now();
    const depth = depthIn ?? "second";
    const out: Elapsed = { days: 0, hours: 0, minutes: 0, seconds: 0 };
    let carry = 0;
    let value: number;
    if (depth === "second") {
      [value, carry] = borrowed((now.second ?? 0) - (stamp.second ?? 0), 60);
      stamp.second = now.second ?? 0;
      out.seconds = value;
    }
    if (depth === "second" || depth === "minute") {
      [value, carry] = borrowed((now.minute ?? 0) - (stamp.minute ?? 0) - carry, 60);
      stamp.minute = now.minute ?? 0;
      out.minutes = value;
    }
    if (depth !== "day") {
      [value, carry] = borrowed((now.hour ?? 0) - (stamp.hour ?? 0) - carry, HOUR_WRAP);
      stamp.hour = now.hour ?? 0;
      out.hours = value;
    }
    let days: number;
    [days, carry] = borrowed((now.day ?? 0) - (stamp.day ?? 0) - carry, DAY_WRAP);
    stamp.day = now.day ?? 0;
    out.days = days;
    return out;
  },

  // Lua: BugContest.lua:176-195 -- save.bugContest.
  state(save: SaveLike): ContestState | undefined {
    if (save === null || typeof save !== "object") return undefined;
    if (!truthy(save.bugContest)) save.bugContest = {};
    return save.bugContest;
  },

  // Lua: BugContest.lua:197-200
  isActive(save: SaveLike): boolean {
    const state = BugContest.state(save);
    return (state ? state.active : undefined) === true;
  },

  // Lua: BugContest.lua:225-234 -- data.encounters.bugContest when present.
  contestMons(data: any): ContestMonRow[] {
    const extracted = data && data.encounters ? data.encounters.bugContest : undefined;
    if (Array.isArray(extracted) && extracted.length > 0) return extracted;
    return BugContest.MONS;
  },

  // Lua: BugContest.lua:236-244 -- one `call Random` byte, 0..255
  // (replaceable, so tests can pin every roll).
  random(): number {
    return rngRandom(0, 255);
  },

  // Lua: BugContest.lua:256-259
  encounterRate(superTallGrass?: unknown): number {
    if (truthy(superTallGrass)) return BugContest.ENCOUNTER_RATE_SUPER_TALL;
    return BugContest.ENCOUNTER_RATE_GRASS;
  },

  // Lua: BugContest.lua:261-263 -- TryWildEncounter_BugContest.
  triggers(superTallGrass?: unknown, random?: ByteRandom): boolean {
    return byte(random) < BugContest.encounterRate(superTallGrass);
  },

  // Lua: BugContest.lua:265-292 -- ChooseWildEncounter_BugContest: reject
  // >= 200, halve (uniform 0..99), subtract slices; level min + Random %
  // (max - min + 1).
  chooseWild(data: any, random?: ByteRandom): { species: string; level: number } | undefined {
    const rows = BugContest.contestMons(data);
    let roll: number;
    do {
      roll = byte(random);
    } while (!(roll < 200));
    roll = Math.floor(roll / 2);

    let row: ContestMonRow | undefined;
    for (let index = 1; index <= rows.length; index++) {
      row = rows[index - 1];
      const chance = row!.chance ?? 0;
      if (roll < chance) break;
      roll -= chance;
    }
    if (!row) return undefined;

    let level = row.min ?? 1;
    const span = (row.max ?? level) - level;
    if (span !== 0) {
      // SimpleDivide's remainder over (max - min + 1), added to min.
      level += mod(byte(random), span + 1);
    }
    return { species: row.species, level };
  },

  // Lua: BugContest.lua:350-352 -- winner id <-> slot (BUG_CONTEST_PLAYER is 1).
  contestantId(slot: number): number {
    return slot + 1;
  },
  contestantSlot(id: number): number {
    return id - 1;
  },

  // Lua: BugContest.lua:354-372 -- LoadContestantName: "BUG CATCHER DON";
  // id 1 is the player. trainers.json classes[].trainers is 0-based.
  contestantName(data: any, id: number, playerName?: string): string {
    if (id === BugContest.PLAYER) return playerName ?? "<PLAYER>";
    const row = BugContest.CONTESTANTS[BugContest.contestantSlot(id) - 1];
    if (!row) return "";
    const classes = data && data.trainers ? data.trainers.classes : undefined;
    const cls = classes ? classes[row.class] : undefined;
    const className = (cls && truthy(cls.name) ? cls.name : undefined) ?? row.class;
    const member = cls && cls.trainers ? cls.trainers[row.trainer - 1] : undefined;
    const trainerName = (member && truthy(member.name) ? member.name : undefined) ?? row.name;
    return `${className} ${trainerName}`;
  },

  // Lua: BugContest.lua:374-418 -- ContestScore: 8-bit reads (low bytes) into
  // a 16-bit total: 4 * maxHP, the five stats, the DV-bit-1 term
  // (16 def + 8 atk + 4 spc + 1 spd), HP / 8, +1 for a held item.
  score(mon: any): number {
    if (!(mon && truthy(mon.species))) return 0;
    const stats = mon.stats ?? {};
    const maxHp = mon.maxHp ?? stats.hp;
    let total = low(maxHp) * 4;
    total += low(stats.attack) + low(stats.defense) + low(stats.speed)
      + low(stats.specialAttack) + low(stats.specialDefense);
    const dvs = mon.dvs ?? {};
    total += 16 * bit1(dvs.defense) + 8 * bit1(dvs.attack)
      + 4 * bit1(dvs.special) + bit1(dvs.speed);
    total += Math.floor(low(mon.hp) / 8);
    if (truthy(mon.item)) total += 1;
    return mod(total, 65536);
  },

  // Lua: BugContest.lua:436-448 -- DetermineContestWinners for one entry.
  placeEntry(results: Podium, entry: PodiumEntry): Podium {
    if (beats(entry, results.first)) {
      results.third = copyEntry(results.second);
      results.second = copyEntry(results.first);
      results.first = copyEntry(entry);
    } else if (beats(entry, results.second)) {
      results.third = copyEntry(results.second);
      results.second = copyEntry(entry);
    } else if (beats(entry, results.third)) {
      results.third = copyEntry(entry);
    }
    return results;
  },

  // Lua: BugContest.lua:450-467 -- one AI contestant: pick a listed mon (& 3,
  // reroll 3), plus a 0..7 bump. `slot` is 1..10.
  rollContestant(slot: number, random?: ByteRandom): PodiumEntry | undefined {
    const row = BugContest.CONTESTANTS[slot - 1];
    if (!row) return undefined;
    let pick: number;
    do {
      pick = mod(byte(random), 4);
    } while (pick === 3);
    const mon = row.mons[pick]!;
    return {
      id: BugContest.contestantId(slot),
      species: mon.species,
      score: mon.score + mod(byte(random), 8),
    };
  },

  // Lua: BugContest.lua:469-493 -- BugContest_JudgeContestants: the ten AI
  // (skipping SET flags, i.e. absent), then the player last.
  judge(state: ContestState | null | undefined, playerMon: any, playerScore?: number, random?: ByteRandom): Podium {
    const absent: boolean[] = (state && truthy(state.contestants) ? state.contestants : undefined) ?? [];
    const results: Podium = { first: undefined, second: undefined, third: undefined };
    for (let slot = 1; slot <= BugContest.NUM_CONTESTANTS; slot++) {
      if (!truthy(absent[slot - 1])) {
        const entry = BugContest.rollContestant(slot, random);
        if (entry) BugContest.placeEntry(results, entry);
      }
    }
    BugContest.placeEntry(results, {
      id: BugContest.PLAYER,
      species: playerMon ? playerMon.species ?? undefined : undefined,
      score: playerScore ?? BugContest.score(playerMon),
    });
    return results;
  },

  // Lua: BugContest.lua:495-505 -- BugContest_GetPlayersResult: 1..3, or 0
  // (the consolation BERRY branch).
  playerPlace(results: Podium): number {
    const order = [results.third, results.second, results.first];
    for (let index = 1; index <= 3; index++) {
      const entry = order[index - 1];
      if (entry && entry.id === BugContest.PLAYER) return 4 - index;
    }
    return 0;
  },

  // Lua: BugContest.lua:507-535 -- _BugContestJudging end to end; the
  // placing is BugContestJudging's wScriptVar.
  runJudging(save: SaveLike, random?: ByteRandom): number {
    const state = BugContest.state(save);
    if (!state) return 0;
    const mon = state.caught;
    const score = BugContest.score(mon);
    const results = BugContest.judge(state, mon, score, random);
    state.results = results;
    state.playerScore = score;
    state.place = BugContest.playerPlace(results);
    if (Runtime.wants("bug_contest.scored")) {
      Runtime.emit("bug_contest.scored", {
        mon, score, place: state.place, results,
      });
    }
    return state.place;
  },

  // Lua: BugContest.lua:537-540
  prizeFor(place: number): string {
    return BugContest.PRIZES[place - 1] ?? BugContest.CONSOLATION_PRIZE;
  },

  // Lua: BugContest.lua:558-568 -- events.json bugContestFlags when present.
  contestantFlags(tables: any): number[] {
    const extracted = tables ? tables.bugContestFlags : undefined;
    if (Array.isArray(extracted) && extracted.length === BugContest.NUM_CONTESTANTS) return extracted;
    return BugContest.FLAGS;
  },

  // Lua: BugContest.lua:570-598 -- SelectRandomBugContestContestants' pick:
  // five of ten, bytes >= 250 rejected, / 25, duplicates rerolled. A chosen
  // slot is a SET flag: that trainer is NOT in the park.
  pickContestants(save: SaveLike, random?: ByteRandom): boolean[] | undefined {
    const state = BugContest.state(save);
    if (!state) return undefined;
    const n = BugContest.NUM_CONTESTANTS;
    const limit = Math.floor(0xff / n) * n;
    const step = Math.floor(0xff / n);
    const chosen: boolean[] = [];
    let picked = 0;
    while (picked < BugContest.CONTESTANTS_PICKED) {
      let roll: number;
      do {
        roll = byte(random);
      } while (!(roll < limit));
      const slot = Math.floor(roll / step) + 1;
      if (!chosen[slot - 1]) {
        chosen[slot - 1] = true;
        picked++;
      }
    }
    state.contestants = chosen;
    return chosen;
  },

  // Lua: BugContest.lua:600-618 -- the wEventFlags half: every one of the ten
  // is written (true for picked, false for the rest), as `.loop1`'s reset.
  applyContestantFlags(events: any, chosenIn: boolean[] | null | undefined, tables?: any): number[] | undefined {
    if (!truthy(events)) return undefined;
    const flags = BugContest.contestantFlags(tables);
    const chosen = chosenIn ?? [];
    for (let slot = 1; slot <= BugContest.NUM_CONTESTANTS; slot++) {
      const flag = flags[slot - 1];
      if (flag != null) events.set(flag, chosen[slot - 1] === true);
    }
    return flags;
  },

  // Lua: BugContest.lua:620-643 -- ContestDropOffMons: the party tail moves to
  // state.stash (on the save). 0 on success, 1 when the lead has fainted.
  dropOffMons(save: SaveLike): number {
    const state = BugContest.state(save);
    const party: any[] | undefined = save ? save.party : undefined;
    if (!(state && party)) return 1;
    const lead = party[0];
    if (!lead || (lead.hp ?? 0) <= 0) return 1;
    state.stash = party.slice(1);
    party.length = 1;
    return 0;
  },

  // Lua: BugContest.lua:645-657 -- ContestReturnMons: the tail lands BEHIND a
  // mon caught during the contest.
  returnMons(save: SaveLike): void {
    const state = BugContest.state(save);
    const party: any[] | undefined = save ? save.party : undefined;
    if (!(state && party)) return;
    for (const mon of state.stash ?? []) {
      if (mon == null) break;
      party.push(mon);
    }
    delete state.stash;
  },

  // Lua: BugContest.lua:659-677 -- GiveParkBalls + StartBugContestTimer;
  // wContestMon cleared first.
  start(save: SaveLike, now?: Partial<ContestClock> | null): ContestState | undefined {
    const state = BugContest.state(save);
    if (!state) return undefined;
    state.active = true;
    delete state.caught;
    state.balls = BugContest.BALLS;
    state.minutes = BugContest.MINUTES;
    state.seconds = BugContest.SECONDS;
    delete state.results;
    delete state.place;
    delete state.playerScore;
    const stamp = now ?? BugContest.now();
    state.startTime = { day: stamp.day, hour: stamp.hour, minute: stamp.minute, second: stamp.second };
    return state;
  },

  // Lua: BugContest.lua:679-689 -- `clearflag ENGINE_BUG_CONTEST_TIMER`; the
  // caught mon stays for CheckPartyFullAfterContest.
  stop(save: SaveLike): void {
    const state = BugContest.state(save);
    if (!state) return;
    state.active = false;
    state.minutes = 0;
    state.seconds = 0;
    delete state.startTime;
  },

  // Lua: BugContest.lua:691-718 -- CheckBugContestTimer: true = over. Any
  // whole day or hour ends it; the seconds' borrow carries into minutes.
  tickTimer(save: SaveLike, now?: Partial<ContestClock> | null): boolean {
    const state = BugContest.state(save);
    if (!(state && state.active && truthy(state.startTime))) return false;
    const since = BugContest.elapsedSince(state.startTime!, now, "second");
    if (since.days !== 0 || since.hours !== 0) {
      state.minutes = 0;
      state.seconds = 0;
      return true;
    }
    const [seconds, borrow] = borrowed((state.seconds ?? 0) - since.seconds, 60);
    state.seconds = seconds;
    const minutes = (state.minutes ?? 0) - since.minutes - borrow;
    if (minutes < 0) {
      state.minutes = 0;
      state.seconds = 0;
      return true;
    }
    state.minutes = minutes;
    return false;
  },

  // Lua: BugContest.lua:720-724 -- minutes left. (The Lua also returns the
  // seconds; its one caller reads only the minutes. state.seconds has them.)
  timeLeft(save: SaveLike): number {
    const state = BugContest.state(save);
    if (!state) return 0;
    return state.minutes ?? 0;
  },

  // Lua: BugContest.lua:726-735 -- wParkBallsRemaining.
  ballsLeft(save: SaveLike): number {
    const state = BugContest.state(save);
    return (state ? state.balls : undefined) ?? 0;
  },

  // Lua: BugContest.lua:737-742 -- `.used_park_ball`'s `dec [hl]`.
  useBall(save: SaveLike): number {
    const state = BugContest.state(save);
    if (!state) return 0;
    state.balls = Math.max(0, (state.balls ?? 0) - 1);
    return state.balls;
  },

  // Lua: BugContest.lua:744-749 -- CheckContestBattleOver.
  isOver(save: SaveLike): boolean {
    return BugContest.ballsLeft(save) <= 0;
  },

  // Lua: BugContest.lua:751-769 -- BugContest_SetCaughtContestMon:
  // [KEEP_FIRST] with no stock mon, else [ASK_SWITCH, stock, fresh] (the
  // default -- B -- keeps the stock).
  catch(save: SaveLike, mon: any): [string | undefined, any?, any?] {
    const state = BugContest.state(save);
    if (!state) return [undefined];
    BugContest.useBall(save);
    if (!truthy(state.caught)) {
      state.caught = mon;
      return [BugContest.KEEP_FIRST];
    }
    return [BugContest.ASK_SWITCH, state.caught, mon];
  },

  // Lua: BugContest.lua:771-777 -- the YES arm.
  switchCaught(save: SaveLike, mon: any): any {
    const state = BugContest.state(save);
    if (!state) return undefined;
    state.caught = mon;
    return mon;
  },

  // Lua: BugContest.lua:779-782
  caughtMon(save: SaveLike): any {
    const state = BugContest.state(save);
    return state && truthy(state.caught) ? state.caught : undefined;
  },

  // Lua: BugContest.lua:784-810 -- CheckPartyFullAfterContest: party if there
  // is room, else the current box. Returns [wScriptVar, mon] ([NO_CATCH]
  // with nothing caught).
  collectCaughtMon(save: SaveLike, partySizeIn?: number, boxesIn?: any): [number, any?] {
    const state = BugContest.state(save);
    const mon = state ? state.caught : undefined;
    if (!truthy(mon)) return [BugContest.NO_CATCH];
    const s = save as Record<string, any>;
    delete state!.caught;
    // caught_nickname.asm:34-39 copies wPlayerName when the contest mon joins.
    Mon.stampOT(s, mon);
    const party: any[] = s.party ?? [];
    s.party = party;
    const partySize = partySizeIn ?? 6;
    if (party.length < partySize) {
      party.push(mon);
      return [BugContest.CAUGHT_MON, mon];
    }
    const boxes = boxesIn ?? Boxes;
    const box = boxes.box(s, s.currentBox ?? 1);
    // .TryAddToBox tails into RestorePPOfDepositedPokemon
    // (engine/pokemon/caught_nickname.asm:72-90).
    if (box) box.push(boxes.enterBox(mon));
    return [BugContest.BOXED_MON, mon];
  },
};

// Lua: BugContest.lua:812-833 -- the module map, special -> call:
//   ContestDropOffMons          BugContest.dropOffMons(save)       -> scriptVar
//   ContestReturnMons           BugContest.returnMons(save)
//   GiveParkBalls               BugContest.start(save)
//   BugContestJudging           BugContest.runJudging(save)        -> scriptVar
//   CheckPartyFullAfterContest  BugContest.collectCaughtMon(save)  -> scriptVar
//   SelectRandomBugContestContestants  pickContestants(save), then
//                               applyContestantFlags(events, chosen, eventTables)
//   CheckTimeEvents             BugContest.tickTimer(save)         -> ended?
//   ChooseWildEncounter_BugContest  BugContest.chooseWild(data)
//   TryWildEncounter_BugContest     BugContest.triggers(superTall)
//   PokeBallEffect .used_park_ball  BugContest.catch(save, mon)

export default BugContest;
