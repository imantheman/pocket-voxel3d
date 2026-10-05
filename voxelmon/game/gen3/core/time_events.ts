// Port of gen1recomp src/core/game3/time_events.lua (GPLv3 + additional terms; see LICENSE.md).
// The RTC's per-day and per-minute event pump (pokeemerald/src/clock.c).
//
// Return shapes (Lua multiple returns -> 0-based tuples):
//   handlers -> [perDay, perMinute]; run / tick -> [ok, daysSince, minutes]
//   ([false] when nothing ran).

import { mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { ipairs, pairs, len, sort, seq } from "../platform/lt.ts";
import { luaLoad } from "../platform/luadata.ts";
import { Rtc, type RtcTime } from "./rtc.ts";
import { Constants } from "./constants.ts";
import { Space } from "./scripting/space.ts";
import { Runtime } from "./runtime.ts";
import { Flags } from "./scripting/flags.ts";
import { Pokemon } from "./pokemon.ts";
import { Capabilities } from "./capabilities.ts";
import { Dataset } from "./dataset.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Handler = (...args: any[]) => void;
type HandlerSet = Record<string, Handler>;

// Lua: time_events.lua:26
let perDay: HandlerSet = {};
let perMinute: HandlerSet = {};
let inPokemonCenter: ((session: any) => unknown) | null = null;

// Lua: time_events.lua:54
function storeOf(session: any, opts: any): any {
  if (opts && opts.store) return opts.store;
  const live = Runtime && Runtime.getSession ? Runtime.getSession() ?? null : null;
  if (Space && Space.store && (live == null || live === session)) return Space.store;
  if (session != null && typeof session === "object") {
    session.store = session.store ?? { flags: {}, vars: {} };
    session.store.flags = session.store.flags ?? {};
    session.store.vars = session.store.vars ?? {};
    return session.store;
  }
  return null;
}

// Lua: time_events.lua:69
function flags(): typeof Flags {
  return Flags;
}

// Lua: time_events.lua:73
function consts(session: any): any {
  return Constants.of(Constants.versionOf(session));
}

// Lua: time_events.lua:77
function orderedCall(order: any, handlers: HandlerSet, ...args: any[]): void {
  const seen: Record<string, boolean> = {};
  for (const [, name] of ipairs<string>(order)) {
    seen[name] = true;
    const fn = handlers[name];
    if (fn) fn(...args);
  }
  const extra: (string | null)[] = [null];
  for (const [name] of pairs(handlers)) {
    if (!seen[name as string]) extra[len(extra) + 1] = name as string;
  }
  sort(extra);
  for (const [, name] of ipairs<string>(extra)) handlers[name](...args);
}

// Lua: time_events.lua:93 -- pokeemerald/src/event_data.c:50
function clearDailyFlags(session: any, _daysSince: number, _localTime: RtcTime, store: any): void {
  const C = consts(session);
  const lo = C.require("flags", "DAILY_FLAGS_START");
  const hi = C.require("flags", "DAILY_FLAGS_END");
  const F = flags();
  for (let id = lo; id <= hi; id++) F.setFlag(store, null, id, false);
}

// Lua: time_events.lua:102 -- pokeemerald/src/pokemon.c:6170
function updatePartyPokerusTime(session: any, daysSince: number): void {
  const P: any = Pokemon;
  if (P.updatePartyPokerusTime) P.updatePartyPokerusTime(daysSince, session);
}

// Lua: time_events.lua:133 -- pokeemerald/src/clock.c:36
function updatePerDay(session: any, lt: RtcTime, store: any): number | null {
  const C = consts(session);
  const F = flags();
  const varDays = C.require("vars", "VAR_DAYS");
  const days = Rtc.u16(tonumber(F.getVar(store, null, varDays)) ?? 0);
  if (days !== lt.days && days <= lt.days) {
    const daysSince = Rtc.u16(lt.days - days);
    orderedCall(TimeEvents.PER_DAY_ORDER, perDay, session, daysSince, lt, store);
    F.setVar(store, null, varDays, lt.days);
    return daysSince;
  }
  return null;
}

// Lua: time_events.lua:148 -- pokeemerald/src/clock.c:59
function updatePerMinute(session: any, lt: RtcTime, store: any): number | null {
  const last = session != null && typeof session === "object" ? session.lastBerryTreeUpdate ?? null : null;
  const diff = Rtc.calcTimeDifference(last ?? Rtc.newTime(0, 0, 0, 0), lt);
  const minutes = Rtc.timeMinutes(diff);
  if (minutes !== 0 && minutes >= 0) {
    orderedCall(TimeEvents.PER_MINUTE_ORDER, perMinute, session, minutes, lt, store);
    if (session != null && typeof session === "object") session.lastBerryTreeUpdate = Rtc.copyTime(lt);
    return minutes;
  }
  return null;
}

// Lua: time_events.lua:160
const CENTERS_PACK = "data/generated/gba/field_specials/manifest.lua";
const centerSets: Record<string, Record<string | number, boolean>> = {};

// Lua: time_events.lua:164 -- pokeemerald/src/field_specials.c:3887
function cachedPokemonCenter(session: any): boolean {
  const key = GameVersion.get() + ":" + tostring(GameVersion.cachePrefix());
  let set = centerSets[key];
  if (!set) {
    const src = Dataset.cache().read(CENTERS_PACK);
    if (typeof src !== "string") throw new Error("time_events: " + CENTERS_PACK + " missing from the cache");
    const [chunk, err] = luaLoad(src, "@" + CENTERS_PACK);
    if (!truthy(chunk)) throw new Error(err ?? "assertion failed!");
    const man: any = chunk!();
    set = {};
    for (const [, id] of ipairs(man.pokemonCenters ?? {})) set[id] = true;
    centerSets[key] = set;
  }
  const map = session != null && typeof session === "object" ? session.map ?? null : null;
  return map != null && set[map] === true;
}

export const TimeEvents = {
  // Lua: time_events.lua:7 -- pokeemerald/src/clock.c:44
  PER_DAY_ORDER: seq(
    "ClearDailyFlags",
    "UpdateDewfordTrendPerDay",
    "UpdateTVShowsPerDay",
    "UpdateWeatherPerDay",
    "UpdatePartyPokerusTime",
    "UpdateMirageRnd",
    "UpdateBirchState",
    "UpdateFrontierManiac",
    "UpdateFrontierGambler",
    "SetShoalItemFlag",
    "SetRandomLotteryNumber",
  ),

  // Lua: time_events.lua:22 -- pokeemerald/src/clock.c:70
  PER_MINUTE_ORDER: seq("BerryTreeTimeUpdate"),

  // Lua: time_events.lua:29
  onDay(name: string, fn: Handler): void {
    if (!(typeof name === "string" && name !== "")) throw new Error("TimeEvents.onDay needs a name");
    perDay[name] = fn;
  },

  // Lua: time_events.lua:34
  onMinute(name: string, fn: Handler): void {
    if (!(typeof name === "string" && name !== "")) throw new Error("TimeEvents.onMinute needs a name");
    perMinute[name] = fn;
  },

  // Lua: time_events.lua:39
  setPokemonCenterCheck(fn: ((session: any) => unknown) | null): void {
    inPokemonCenter = fn;
  },

  // Lua: time_events.lua:43
  handlers(): [HandlerSet, HandlerSet] {
    return [perDay, perMinute];
  },

  // Lua: time_events.lua:47
  reset(): void {
    perDay = {};
    perMinute = {};
    inPokemonCenter = null;
    TimeEvents._tickState = 0;
    TimeEvents.installDefaults();
  },

  // Lua: time_events.lua:107
  installDefaults(): void {
    if (perDay.ClearDailyFlags == null) perDay.ClearDailyFlags = clearDailyFlags;
    if (perDay.UpdatePartyPokerusTime == null) perDay.UpdatePartyPokerusTime = updatePartyPokerusTime;
    if (perMinute.BerryTreeTimeUpdate == null) {
      // pokeemerald/src/clock.c:70
      perMinute.BerryTreeTimeUpdate = (s: any, _m: any) => {
        if (Capabilities.gate(s, "berry_trees")) {
          // NOT FAITHFUL: Emerald only -- src.core.game3.rse.berry_trees is not ported.
          throw new Error("NOT FAITHFUL: Emerald only: src.core.game3.rse.berry_trees");
        }
      };
    }
  },

  // Lua: time_events.lua:121 -- pokeemerald/src/clock.c:18
  init(session: any, opts?: any): RtcTime {
    const store = storeOf(session, opts);
    const C = consts(session);
    const F = flags();
    F.setFlag(store, null, C.require("flags", "FLAG_SYS_CLOCK_SET"), true);
    const lt = Rtc.calcLocalTime(session);
    if (session != null && typeof session === "object") session.lastBerryTreeUpdate = Rtc.copyTime(lt);
    F.setVar(store, null, C.require("vars", "VAR_DAYS"), lt.days);
    return lt;
  },

  // Lua: time_events.lua:180
  inPokemonCenter(session: any): boolean {
    if (inPokemonCenter) return inPokemonCenter(session) === true;
    return cachedPokemonCenter(session);
  },

  // Lua: time_events.lua:186 -- pokeemerald/src/clock.c:26
  run(session: any, opts?: any): [boolean, (number | null)?, (number | null)?] {
    opts = opts ?? {};
    if (!Rtc.enabled(session)) return [false];
    const store = storeOf(session, opts);
    const C = consts(session);
    if (!flags().getFlag(store, null, C.require("flags", "FLAG_SYS_CLOCK_SET"))) return [false];
    let inPc = opts.inPokemonCenter;
    if (inPc == null) inPc = TimeEvents.inPokemonCenter(session);
    if (truthy(inPc)) return [false];
    const lt = Rtc.calcLocalTime(session);
    const daysSince = updatePerDay(session, lt, store);
    const minutes = updatePerMinute(session, lt, store);
    return [true, daysSince, minutes];
  },

  // Lua: time_events.lua:202 -- pokeemerald/src/field_tasks.c:148
  UPDATE_INTERVAL_BIT: 4096,
  _tickState: 0,

  // Lua: time_events.lua:206 -- pokeemerald/src/field_tasks.c:150
  tick(session: any, vblankCounter: unknown, opts?: any): [boolean, (number | null)?, (number | null)?] {
    const on = mod(Math.floor((tonumber(vblankCounter) ?? 0) / TimeEvents.UPDATE_INTERVAL_BIT), 2) === 1;
    if (TimeEvents._tickState === 0) {
      if (on) {
        TimeEvents._tickState = 1;
        return TimeEvents.run(session, opts);
      }
    } else if (!on) {
      TimeEvents._tickState = 0;
    }
    return [false];
  },
};

// Lua: time_events.lua:219
TimeEvents.installDefaults();

export default TimeEvents;
