// Port of gen1recomp src/core/game3/rtc.lua (GPLv3 + additional terms; see LICENSE.md).
// The cartridge real-time clock (pokeemerald/src/rtc.c) over the host clock.
// Return shapes: one value each (no Lua multiple returns here).

import { mod, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { matchAll } from "../platform/lpattern.ts";
import { osDate } from "../../gen2/platform/clock.ts";
import { Profile } from "./profile.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RtcTime { days: number; hours: number; minutes: number; seconds: number }
export interface RtcFields { year: number; month: number; day: number; hour: number; minute: number; second: number }

// Lua: rtc.lua:24 -- pokeemerald/src/rtc.c:19 (Lua sequence)
const DAYS_IN_MONTH = [null, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as (number | null)[];

// Lua: rtc.lua:26
const SECONDS_PER_DAY = 86400;

// Lua: rtc.lua:28
const state: { errorStatus: number | null; fixedBase: number | null; advanced: number; host: (() => RtcFields) | null } = {
  errorStatus: null,
  fixedBase: null,
  advanced: 0,
  host: null,
};

// Lua: rtc.lua:37
function s8(v: number): number {
  v = mod(Math.floor(v), 256);
  if (v >= 128) v = v - 256;
  return v;
}

// Lua: rtc.lua:43
function s16(v: number): number {
  v = mod(Math.floor(v), 65536);
  if (v >= 32768) v = v - 65536;
  return v;
}

// Lua: rtc.lua:49
function u16(v: number): number {
  return mod(Math.floor(v), 65536);
}

// Lua: rtc.lua:100
function parseFixed(spec: unknown): RtcFields | null {
  if (typeof spec !== "string") return null;
  let y: any, mo: any, d: any, h: any, mi: any, se: any;
  const m1 = matchAll(spec, "^(%d%d%d%d)%-(%d%d)%-(%d%d)[T ](%d%d):(%d%d):?(%d?%d?)$");
  if (m1) [y, mo, d, h, mi, se] = m1;
  if (y == null) {
    const m2 = matchAll(spec, "^(%d%d%d%d)%-(%d%d)%-(%d%d)$");
    if (m2) [y, mo, d] = m2;
    h = "0"; mi = "0"; se = "0";
  }
  if (y == null) return null;
  return {
    year: tonumber(y)!, month: tonumber(mo)!, day: tonumber(d)!,
    hour: tonumber(h)!, minute: tonumber(mi)!, second: tonumber(se) != null ? tonumber(se)! : 0,
  };
}

// Lua: rtc.lua:114
function hostFields(): RtcFields {
  if (state.host) return state.host();
  const t = osDate("*t");
  return { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.min, second: t.sec };
}

// Lua: rtc.lua:120
function linearOf(f: RtcFields): number {
  const y = f.year - 2000;
  let dc = 0;
  if (y > 0) {
    for (let i = y - 1; i >= 0; i--) {
      dc = dc + 365;
      if (Rtc.isLeapYear(i)) dc = dc + 1;
    }
  } else if (y < 0) {
    for (let i = y; i <= -1; i++) {
      dc = dc - 365;
      if (Rtc.isLeapYear(i)) dc = dc - 1;
    }
  }
  for (let i = 1; i <= f.month - 1; i++) dc = dc + (DAYS_IN_MONTH[i] ?? 0);
  if (f.month > 2 && Rtc.isLeapYear(y)) dc = dc + 1;
  dc = dc + f.day - 1;
  return dc * SECONDS_PER_DAY + f.hour * 3600 + f.minute * 60 + f.second;
}

// Lua: rtc.lua:140
function fieldsOf(total: number): RtcFields {
  let dc = Math.floor(total / SECONDS_PER_DAY);
  const rem = total - dc * SECONDS_PER_DAY;
  let y = 0;
  while (dc < 0) {
    y = y - 1;
    dc = dc + (Rtc.isLeapYear(y) ? 366 : 365);
  }
  while (true) {
    const len = Rtc.isLeapYear(y) ? 366 : 365;
    if (dc < len) break;
    dc = dc - len;
    y = y + 1;
  }
  let month = 1;
  while (true) {
    let len = DAYS_IN_MONTH[month]!;
    if (month === 2 && Rtc.isLeapYear(y)) len = len + 1;
    if (dc < len) break;
    dc = dc - len;
    month = month + 1;
  }
  return {
    year: y + 2000, month, day: dc + 1,
    hour: Math.floor(rem / 3600), minute: mod(Math.floor(rem / 60), 60), second: mod(rem, 60),
  };
}

// Lua: rtc.lua:170
function envFixed(): number | null {
  // NOT FAITHFUL: os.getenv("POKEPORT_RTC") does not exist on the 3DS; it is
  // always nil, so a fixed clock only comes from Rtc.setFixed.
  const spec: string | null = null;
  if (spec == null || spec === "") return null;
  const f = parseFixed(spec);
  if (!f) throw new Error("POKEPORT_RTC must be YYYY-MM-DD[THH:MM[:SS]], got " + tostring(spec));
  return linearOf(f);
}

// Lua: rtc.lua:178
function nowLinear(session: any): number {
  let base = state.fixedBase;
  if (base == null) {
    base = envFixed();
    if (base != null) state.fixedBase = base;
  }
  if (base == null) base = linearOf(hostFields());
  const skew = session != null && typeof session === "object" ? (tonumber(session.rtcSkew) ?? 0) : 0;
  return base + state.advanced + skew;
}

// Lua: rtc.lua:197
function checkInfo(info: RtcFields): number {
  let err = 0;
  if (info.year < 0 || info.year > 99) err = err + Rtc.ERR.INVALID_YEAR;
  return err;
}

// Lua: rtc.lua:228
function borrow(r: RtcTime): RtcTime {
  if (r.seconds < 0) {
    r.seconds = r.seconds + 60;
    r.minutes = r.minutes - 1;
  }
  if (r.minutes < 0) {
    r.minutes = r.minutes + 60;
    r.hours = r.hours - 1;
  }
  if (r.hours < 0) {
    r.hours = r.hours + 24;
    r.days = r.days - 1;
  }
  return Rtc.newTime(r.days, r.hours, r.minutes, r.seconds);
}

// Lua: rtc.lua:266
function offsetOf(session: any): RtcTime {
  if (session == null || typeof session !== "object") return Rtc.newTime(0, 0, 0, 0);
  if (session.localTimeOffset == null || typeof session.localTimeOffset !== "object") {
    session.localTimeOffset = Rtc.newTime(0, 0, 0, 0);
  }
  return session.localTimeOffset;
}

// Lua: rtc.lua:295
function toBcd(v: number): number {
  return Math.floor(v / 10) * 16 + mod(v, 10);
}

export const Rtc = {
  // Lua: rtc.lua:7 -- pokeemerald/include/rtc.h:6
  ERR: {
    INIT_ERROR: 0x0001,
    INIT_WARNING: 0x0002,
    TWELVE_HOUR_CLOCK: 0x0010,
    POWER_FAILURE: 0x0020,
    INVALID_YEAR: 0x0040,
    INVALID_MONTH: 0x0080,
    INVALID_DAY: 0x0100,
    INVALID_HOUR: 0x0200,
    INVALID_MINUTE: 0x0400,
    INVALID_SECOND: 0x0800,
    FLAG_MASK: 0x0FF0,
  },

  // Lua: rtc.lua:21
  SAVE_FIELDS: [null, "localTimeOffset", "lastBerryTreeUpdate", "rtcSkew"] as (string | null)[],

  // Lua: rtc.lua:35
  localTime: { days: 0, hours: 0, minutes: 0, seconds: 0 } as RtcTime,
  _info: null as RtcFields | null,

  // Lua: rtc.lua:53
  s8, s16, u16,

  // Lua: rtc.lua:55
  newTime(days: unknown, hours: unknown, minutes: unknown, seconds: unknown): RtcTime {
    return {
      days: s16(tonumber(days) ?? 0),
      hours: s8(tonumber(hours) ?? 0),
      minutes: s8(tonumber(minutes) ?? 0),
      seconds: s8(tonumber(seconds) ?? 0),
    };
  },

  // Lua: rtc.lua:64
  copyTime(t: any): RtcTime {
    t = t != null && typeof t === "object" ? t : {};
    return Rtc.newTime(t.days, t.hours, t.minutes, t.seconds);
  },

  // Lua: rtc.lua:69
  enabled(session: any): boolean {
    let row: any;
    try { row = Profile.forSession(session); } catch { return false; }
    if (row == null || typeof row !== "object") return false;
    return row.clock != null && typeof row.clock === "object" && row.clock.rtc === true;
  },

  // Lua: rtc.lua:76 -- pokeemerald/src/rtc.c:57
  isLeapYear(year: number): boolean {
    return (mod(year, 4) === 0 && mod(year, 100) !== 0) || mod(year, 400) === 0;
  },

  // Lua: rtc.lua:81 -- pokeemerald/src/rtc.c:65
  dayCount(year: number, month: number, day: number): number {
    let count = 0;
    for (let i = year - 1; i >= 0; i--) {
      count = count + 365;
      if (Rtc.isLeapYear(i)) count = count + 1;
    }
    for (let i = 1; i <= month - 1; i++) {
      count = count + (DAYS_IN_MONTH[i] ?? 0);
    }
    if (month > 2 && Rtc.isLeapYear(year)) count = count + 1;
    count = count + day;
    return u16(count);
  },

  // Lua: rtc.lua:96 -- pokeemerald/src/rtc.c:89
  getDayCount(info: RtcFields): number {
    return Rtc.dayCount(info.year, info.month, info.day);
  },

  // Lua: rtc.lua:168
  _linearOf: linearOf,
  _fieldsOf: fieldsOf,

  // Lua: rtc.lua:189
  hostInfo(session: any): RtcFields {
    const f = fieldsOf(nowLinear(session));
    return {
      year: f.year - 2000, month: f.month, day: f.day,
      hour: f.hour, minute: f.minute, second: f.second,
    };
  },

  // Lua: rtc.lua:204 -- pokeemerald/src/rtc.c:97
  init(): number {
    // NOT FAITHFUL: os.getenv("POKEPORT_RTC_ERROR") does not exist on the 3DS (always nil).
    state.errorStatus = checkInfo(Rtc.hostInfo(null));
    return state.errorStatus;
  },

  // Lua: rtc.lua:215 -- pokeemerald/src/rtc.c:121
  errorStatus(): number {
    if (state.errorStatus == null) Rtc.init();
    return state.errorStatus!;
  },

  // Lua: rtc.lua:221 -- pokeemerald/src/rtc.c:126
  getInfo(session: any): RtcFields {
    if ((Rtc.errorStatus() & Rtc.ERR.FLAG_MASK) !== 0) {
      return { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
    }
    return Rtc.hostInfo(session);
  },

  // Lua: rtc.lua:245 -- pokeemerald/src/rtc.c:263
  calcTimeDifferenceRtc(info: RtcFields, t?: any): RtcTime {
    t = t ?? {};
    return borrow({
      seconds: s8(info.second - (t.seconds ?? 0)),
      minutes: s8(info.minute - (t.minutes ?? 0)),
      hours: s8(info.hour - (t.hours ?? 0)),
      days: s16(Rtc.getDayCount(info) - (t.days ?? 0)),
    });
  },

  // Lua: rtc.lua:256 -- pokeemerald/src/rtc.c:311
  calcTimeDifference(t1?: any, t2?: any): RtcTime {
    t1 = t1 ?? {};
    t2 = t2 ?? {};
    return borrow({
      seconds: s8((t2.seconds ?? 0) - (t1.seconds ?? 0)),
      minutes: s8((t2.minutes ?? 0) - (t1.minutes ?? 0)),
      hours: s8((t2.hours ?? 0) - (t1.hours ?? 0)),
      days: s16((t2.days ?? 0) - (t1.days ?? 0)),
    });
  },

  // Lua: rtc.lua:275 -- pokeemerald/src/rtc.c:290
  calcLocalTime(session: any): RtcTime {
    Rtc._info = Rtc.getInfo(session);
    Rtc.localTime = Rtc.calcTimeDifferenceRtc(Rtc._info, offsetOf(session));
    return Rtc.copyTime(Rtc.localTime);
  },

  // Lua: rtc.lua:282 -- pokeemerald/src/rtc.c:301
  calcLocalTimeOffset(session: any, days: unknown, hours: unknown, minutes: unknown, seconds: unknown): RtcTime {
    Rtc.localTime = Rtc.newTime(days, hours, minutes, seconds);
    Rtc._info = Rtc.getInfo(session);
    const off = Rtc.calcTimeDifferenceRtc(Rtc._info, Rtc.localTime);
    if (session != null && typeof session === "object") session.localTimeOffset = off;
    return Rtc.copyTime(off);
  },

  // Lua: rtc.lua:291 -- pokeemerald/src/rtc.c:296
  initLocalTimeOffset(session: any, hour: unknown, minute: unknown): RtcTime {
    return Rtc.calcLocalTimeOffset(session, 0, hour, minute, 0);
  },

  // Lua: rtc.lua:300 -- pokeemerald/src/rtc.c:337
  minuteCount(session: any): number {
    const info = Rtc.getInfo(session);
    Rtc._info = info;
    return 24 * 60 * Rtc.getDayCount(info) + 60 * toBcd(info.hour) + toBcd(info.minute);
  },

  // Lua: rtc.lua:307 -- pokeemerald/src/rtc.c:343
  localDayCount(): number {
    const info = Rtc._info ?? Rtc.getInfo(null);
    return Rtc.getDayCount(info);
  },

  // Lua: rtc.lua:312
  timeMinutes(t?: any): number {
    t = t ?? {};
    return 24 * 60 * (t.days ?? 0) + 60 * (t.hours ?? 0) + (t.minutes ?? 0);
  },

  // Lua: rtc.lua:317
  anchorToLastUpdate(session: any): number {
    if (session == null || typeof session !== "object") return 0;
    const last = session.lastBerryTreeUpdate;
    if (last == null || typeof last !== "object") return tonumber(session.rtcSkew) ?? 0;
    const off = offsetOf(session);
    session.rtcSkew = 0;
    const host = Rtc.getInfo(session);
    const target = (last.days + off.days) * SECONDS_PER_DAY
      + (last.hours + off.hours) * 3600 + (last.minutes + off.minutes) * 60
      + (last.seconds + off.seconds);
    const cur = Rtc.getDayCount(host) * SECONDS_PER_DAY + host.hour * 3600 + host.minute * 60 + host.second;
    session.rtcSkew = target - cur;
    return session.rtcSkew;
  },

  // Lua: rtc.lua:332
  setFixed(spec: unknown): void {
    if (spec == null) {
      state.fixedBase = null;
      return;
    }
    const f = typeof spec === "object" ? spec as RtcFields : parseFixed(spec);
    if (!f) throw new Error("Rtc.setFixed: bad spec " + tostring(spec));
    state.fixedBase = linearOf(f);
    state.errorStatus = null;
  },

  // Lua: rtc.lua:343
  advance(minutes: unknown, seconds?: unknown): number {
    state.advanced = state.advanced + (tonumber(minutes) ?? 0) * 60 + (tonumber(seconds) ?? 0);
    return state.advanced;
  },

  // Lua: rtc.lua:348
  setHostClock(fn: (() => RtcFields) | null): void {
    state.host = fn;
    state.errorStatus = null;
  },

  // Lua: rtc.lua:353
  reset(): void {
    state.errorStatus = null;
    state.fixedBase = null;
    state.advanced = 0;
    state.host = null;
    Rtc._info = null;
    Rtc.localTime = Rtc.newTime(0, 0, 0, 0);
  },

  // Lua: rtc.lua:362
  fixedActive(): boolean {
    // (os.getenv("POKEPORT_RTC") is always nil here; see envFixed)
    return state.fixedBase != null;
  },
};

export default Rtc;
