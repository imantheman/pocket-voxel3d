// The wall clock for the Gen 2 port: every os.time / os.date gen1recomp's
// Gen 2 engine makes lands here (Clock.lua:74-84, BugContest.lua:102-107,
// Phone.lua:812-814, Save.lua:299-302/964, SaveData.lua:184/1957).
//
// Gold has an RTC; gen1recomp reads the OS clock in its place, and we read
// whatever the host hands us. By default that is `Date` (local time); a
// host that keeps its own time (the 3DS RTC through the entry) or a test
// that wants 6:59 PM on a Tuesday installs a source with `setClockSource`.
//
// The API is Lua's, so a ported line stays close to the line it cites:
//   osTime()          os.time()            seconds since the epoch
//   osTime(t)         os.time(t)           a local-time table back to seconds
//   osDate("*t", s)   os.date("*t", s)     the local-time breakdown
//   osDate("%H", s)   os.date("%H", s)     the strftime subset the engine uses
// The breakdown keeps Lua's field meanings: month 1..12, wday 1..7 with
// SUNDAY = 1, yday 1..366 (os.date("%w") is the 0-based weekday).
//
// This module must stay free of Node imports: it is in the device bundle.

/** os.date("*t"): a local-time breakdown, Lua's field names and ranges. */
export interface LocalTime {
  year: number;
  /** 1..12 */
  month: number;
  /** 1..31 */
  day: number;
  hour: number;
  min: number;
  sec: number;
  /** 1..7, SUNDAY = 1 (Lua's *t; %w is this minus one) */
  wday: number;
  /** 1..366 */
  yday: number;
  isdst: boolean;
}

/** What a host supplies: the time now, and optionally its own local breakdown. */
export interface ClockSource {
  /** Seconds since the epoch (may be fractional; os.time floors it). */
  now(): number;
  /** Local time at `seconds`. Default: JS Date in the local zone. */
  local?(seconds: number): LocalTime;
  /** os.time(t): a local-time table back to seconds. Default: JS Date. */
  mktime?(t: Partial<LocalTime>): number;
}

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.floor((d.getTime() - start.getTime()) / 86400000 + 0.5) + 1;
}

function dateLocal(seconds: number): LocalTime {
  const d = new Date(seconds * 1000);
  const jan = new Date(d.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(d.getFullYear(), 6, 1).getTimezoneOffset();
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    min: d.getMinutes(),
    sec: d.getSeconds(),
    wday: d.getDay() + 1,
    yday: dayOfYear(new Date(d.getFullYear(), d.getMonth(), d.getDate())),
    isdst: d.getTimezoneOffset() < Math.max(jan, jul),
  };
}

function dateMktime(t: Partial<LocalTime>): number {
  // os.time(t): year/month/day are required, hour defaults to 12 (Lua).
  const d = new Date(t.year ?? 1970, (t.month ?? 1) - 1, t.day ?? 1, t.hour ?? 12, t.min ?? 0, t.sec ?? 0);
  return Math.floor(d.getTime() / 1000);
}

export const DATE_SOURCE: ClockSource = {
  now: () => Date.now() / 1000,
  local: dateLocal,
  mktime: dateMktime,
};

let source: ClockSource = DATE_SOURCE;

/** Install a host or test clock; `undefined` restores the default (`Date`). */
export function setClockSource(s: ClockSource | undefined): void {
  source = s ?? DATE_SOURCE;
}

/** The source in use (tests save and restore it). */
export function clockSource(): ClockSource {
  return source;
}

/**
 * A fixed-time source for tests and replays: local time is the given
 * breakdown, advancing with `advance(seconds)`. The zone is UTC, so the
 * breakdown and the seconds agree on every machine.
 */
export function fixedClock(t: { year: number; month: number; day: number; hour?: number; min?: number; sec?: number }): ClockSource & { advance(s: number): void; set(seconds: number): void } {
  let secs = Date.UTC(t.year, t.month - 1, t.day, t.hour ?? 0, t.min ?? 0, t.sec ?? 0) / 1000;
  const local = (s: number): LocalTime => {
    const d = new Date(Math.floor(s) * 1000);
    const start = Date.UTC(d.getUTCFullYear(), 0, 1);
    const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      min: d.getUTCMinutes(),
      sec: d.getUTCSeconds(),
      wday: d.getUTCDay() + 1,
      yday: Math.round((midnight - start) / 86400000) + 1,
      isdst: false,
    };
  };
  return {
    now: () => secs,
    local,
    mktime: (lt) => Date.UTC(lt.year ?? 1970, (lt.month ?? 1) - 1, lt.day ?? 1, lt.hour ?? 12, lt.min ?? 0, lt.sec ?? 0) / 1000,
    advance(s: number) {
      secs += s;
    },
    set(seconds: number) {
      secs = seconds;
    },
  };
}

/** now(): seconds since the epoch, unfloored. */
export function now(): number {
  return source.now();
}

// The engine asks the clock several times a step (the phone's call delay,
// the daily reset, Pokerus, the swarms -- each through BugContest.now()),
// and a local-time breakdown is a handful of Date objects and a libc
// localtime each: most of an overworld step on the 3DS. Both directions are
// remembered for the last second / table asked, per source; a caller gets
// its own copy of the breakdown, so writing into it changes nothing here.
let lastLocalSource: ClockSource | null = null;
let lastLocalSec = Number.NaN;
let lastLocal: LocalTime | null = null;
let lastMkSource: ClockSource | null = null;
let lastMkKey = "";
let lastMk = 0;

/** The local-time breakdown at `seconds` (default: now). */
export function localTime(seconds?: number): LocalTime {
  const s = Math.floor(seconds ?? source.now());
  if (lastLocal === null || lastLocalSource !== source || lastLocalSec !== s) {
    lastLocal = (source.local ?? dateLocal)(s);
    lastLocalSource = source;
    lastLocalSec = s;
  }
  return { ...lastLocal };
}

/** os.time([t]) */
export function osTime(t?: Partial<LocalTime>): number {
  if (t === undefined) return Math.floor(source.now());
  const key = `${t.year},${t.month},${t.day},${t.hour},${t.min},${t.sec}`;
  if (lastMkSource !== source || lastMkKey !== key) {
    lastMk = Math.floor((source.mktime ?? dateMktime)(t));
    lastMkSource = source;
    lastMkKey = key;
  }
  return lastMk;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * os.date(fmt[, seconds]): "*t" for the table, otherwise the strftime
 * conversions the engine uses (%Y %m %d %H %M %S %w %j %p %I %y %%).
 * A leading "!" (UTC in Lua) is accepted and ignored: the source defines
 * the one zone the game sees.
 */
export function osDate(fmt: "*t" | "!*t", seconds?: number): LocalTime;
export function osDate(fmt?: string, seconds?: number): string;
export function osDate(fmt = "%c", seconds?: number): LocalTime | string {
  const f = fmt.startsWith("!") ? fmt.slice(1) : fmt;
  const t = localTime(seconds);
  if (f === "*t") return t;
  return f.replace(/%([a-zA-Z%])/g, (_m, c: string) => {
    switch (c) {
      case "Y": return String(t.year);
      case "y": return pad2(t.year % 100);
      case "m": return pad2(t.month);
      case "d": return pad2(t.day);
      case "H": return pad2(t.hour);
      case "I": return pad2(((t.hour + 11) % 12) + 1);
      case "M": return pad2(t.min);
      case "S": return pad2(t.sec);
      case "p": return t.hour < 12 ? "AM" : "PM";
      case "w": return String(t.wday - 1);
      case "j": return String(t.yday).padStart(3, "0");
      case "c": return `${t.year}-${pad2(t.month)}-${pad2(t.day)} ${pad2(t.hour)}:${pad2(t.min)}:${pad2(t.sec)}`;
      case "%": return "%";
      default: return `%${c}`;
    }
  });
}

export const WallClock = { now, localTime, osTime, osDate, setClockSource, clockSource, fixedClock };
export default WallClock;
