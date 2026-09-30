// gen1recomp src/core/gen2/Clock.lua at bdfac727 (MIT): the game clock, as
// the cart keeps it (home/time.asm, engine/rtc/timeset.asm).
//
// Gold stores wStartHour / wStartMinute / wStartDay -- the RTC reading at the
// moment the player answered Oak -- and every read is the RTC now, minus that
// base, plus what the player said it was. Brian's `now` is the OS clock; ours
// is platform/clock.ts (the host's wall clock, or a test's fixed one). The
// stored pair is the pair the cart stores, so the arithmetic is InitTime's.

import { osDate } from "../platform/clock.ts";
import { tonumber, mod } from "../platform/lua.ts";
import { Palettes } from "../world/Palettes.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Strings } from "../shared/core/Strings.ts";

/** save.rtc as Clock reads and writes it (plus Save.newGame's day/hour/minute). */
export interface Rtc {
  startMinute?: number;
  startDay?: number;
  dayOfWeek?: number;
  day?: number;
  hour?: number;
  minute?: number;
  [k: string]: unknown;
}

type SaveLike = { rtc?: Rtc; [k: string]: unknown } | null | undefined;

const MINUTES_PER_DAY = 24 * 60;
const DAYS = 7;

// Lua: Clock.lua:36-40 -- data/text/day_of_week.asm order (SUNDAY is 0, so
// index 1 is SUNDAY in the Lua; here DAY_NAMES[day - 1]).
const DAY_NAMES = [
  Strings.source("SUNDAY"), Strings.source("MONDAY"), Strings.source("TUESDAY"),
  Strings.source("WEDNESDAY"), Strings.source("THURSDAY"), Strings.source("FRIDAY"),
  Strings.source("SATURDAY"),
];

// Lua: Clock.lua:56-59
const DAYTIME_LABEL: Record<string, string> = {
  MORN: Strings.source("MORN"), DAY: Strings.source("DAY"),
  NITE: Strings.source("NITE"),
};

// Lua: Clock.lua:74-78
function hostMinutes(): number {
  const hour = tonumber(osDate("%H")) ?? 0;
  const minute = tonumber(osDate("%M")) ?? 0;
  return mod(hour * 60 + minute, MINUTES_PER_DAY);
}

// Lua: Clock.lua:80-84 -- os.date("%w") is Sunday 0, as is SUNDAY.
function hostWeekday(): number {
  return mod(tonumber(osDate("%w")) ?? 0, DAYS);
}

// Lua: Clock.lua:89-91
function rtc(save: SaveLike): Rtc | undefined {
  return save !== null && typeof save === "object" ? save.rtc : undefined;
}

// Lua: Clock.lua:109-123 -- clock.day_changed, raised off the GetWeekday read.
let lastDay: number | undefined;

function noteDay(day: number, reason: string): number {
  if (!Runtime.wants("clock.day_changed")) {
    lastDay = undefined;
    return day;
  }
  const previous = lastDay;
  lastDay = day;
  if (previous !== undefined && previous !== day) {
    Runtime.emit("clock.day_changed", { day, previous, reason });
  }
  return day;
}

export const Clock = {
  MINUTES_PER_DAY,
  DAYS,
  DAY_NAMES,

  // Lua: Clock.lua:44-47 -- the translated name for a 1-based weekday.
  weekdayName(day: number): string | undefined {
    const name = DAY_NAMES[day - 1];
    return name !== undefined ? Strings.get(name) : undefined;
  },

  // Lua: Clock.lua:64-67 -- DisplayHourOClock / Pokegear_UpdateClock's word.
  daytimeLabel(hour?: number): string {
    const daytime: string = Palettes.clockDaytime(hour);
    return Strings.get(DAYTIME_LABEL[daytime] ?? daytime);
  },

  // Lua: Clock.lua:71-72 -- InitClock: `ld a, 10 ; default hour = 10 AM`.
  DEFAULT_HOUR: 10,
  DEFAULT_MINUTE: 0,

  hostMinutes,
  hostWeekday,

  // Lua: Clock.lua:126-133 -- _InitTime.
  setTime(save: SaveLike, hour?: number, minute?: number): boolean {
    if (save === null || typeof save !== "object") return false;
    save.rtc = save.rtc ?? {};
    const wanted = mod(Math.floor(hour ?? 0), 24) * 60 + mod(Math.floor(minute ?? 0), 60);
    save.rtc.startMinute = mod(wanted - hostMinutes(), MINUTES_PER_DAY);
    return true;
  },

  // Lua: Clock.lua:136-143 -- InitDayOfWeek.
  setWeekday(save: SaveLike, day?: number): boolean {
    if (save === null || typeof save !== "object") return false;
    save.rtc = save.rtc ?? {};
    save.rtc.startDay = mod(Math.floor(day ?? 0) - hostWeekday(), DAYS);
    save.rtc.dayOfWeek = mod(Math.floor(day ?? 0), DAYS);
    noteDay(save.rtc.dayOfWeek, "set");
    return true;
  },

  // Lua: Clock.lua:146-150 -- the host clock through the stored offset.
  minutes(save?: SaveLike): number {
    const r = rtc(save);
    const offset = (r && tonumber(r.startMinute)) ?? 0;
    return mod(hostMinutes() + offset, MINUTES_PER_DAY);
  },

  // Lua: Clock.lua:152-154
  hour(save?: SaveLike): number {
    return Math.floor(Clock.minutes(save) / 60);
  },

  // Lua: Clock.lua:156-158
  minute(save?: SaveLike): number {
    return mod(Clock.minutes(save), 60);
  },

  // Lua: Clock.lua:161-165 -- GetWeekday (SUNDAY 0 .. SATURDAY 6).
  weekday(save?: SaveLike): number {
    const r = rtc(save);
    const offset = (r && tonumber(r.startDay)) ?? 0;
    return noteDay(mod(hostWeekday() + offset, DAYS), "rollover");
  },

  // Lua: Clock.lua:169-172 -- has the player answered Oak?
  isSet(save?: SaveLike): boolean {
    const r = rtc(save);
    return r !== undefined && r !== null && r.startMinute != null;
  },
};

export default Clock;
