// Port of gen1recomp src/core/LogicClock.lua (GPLv3 + additional terms; see LICENSE.md).
// The logic step rate: 60 Hz or the Game Boy's 59.73 Hz.

import { FixedStep } from "./FixedStep.ts";
import { ipairs, len } from "../../platform/lt.ts";
import { mod } from "../../../../import/gen3/lua.ts";

export const LogicClock = {
  // Lua: LogicClock.lua:5
  MODES: [null, "60", "gb"] as (string | null)[],
  DEFAULT: "60",
  HZ: { "60": 60, gb: FixedStep.GB_HZ } as Record<string, number>,
  current: "60",

  // Lua: LogicClock.lua:10
  normalize(mode: unknown): string {
    if (mode === "gb" || mode === "60") return mode;
    return LogicClock.DEFAULT;
  },

  // Lua: LogicClock.lua:15
  hz(mode: unknown): number {
    return LogicClock.HZ[LogicClock.normalize(mode)]!;
  },

  // Lua: LogicClock.lua:19
  label(mode: unknown): string {
    if (LogicClock.normalize(mode) === "gb") return "59.73HZ";
    return "60HZ";
  },

  // Lua: LogicClock.lua:24
  cycle(mode: unknown, dir?: number): string {
    const ring = LogicClock.MODES;
    const cur = LogicClock.normalize(mode);
    let at = 1;
    for (const [i, m] of ipairs<string>(ring)) {
      if (m === cur) { at = i; break; }
    }
    return ring[mod(at - 1 + (dir ?? 1), len(ring)) + 1]!;
  },

  // Lua: LogicClock.lua:34
  apply(mode: unknown): string {
    LogicClock.current = LogicClock.normalize(mode);
    FixedStep.setHz(LogicClock.hz(LogicClock.current));
    return LogicClock.current;
  },

  // Lua: LogicClock.lua:40
  applyOptions(opts: any): string {
    return LogicClock.apply(opts ? opts.logicClock : undefined);
  },
};

export default LogicClock;
