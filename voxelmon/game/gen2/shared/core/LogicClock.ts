// gen1recomp src/core/LogicClock.lua (bdfac727): the logic tick rate option,
// 60 Hz or the Game Boy's 59.73 Hz.
//
// The Lua hands the rate to FixedStep, LÖVE's frame pacer. On the 3DS the
// host paces the frames, so `apply` records the mode and nothing else.

// FixedStep.lua GB_HZ: 4194304 / 70224
const GB_HZ = 4194304 / 70224;

export const LogicClock = {
  MODES: ["60", "gb"],
  DEFAULT: "60",
  HZ: { "60": 60, gb: GB_HZ } as Record<string, number>,
  current: "60",

  /** LogicClock.lua:10 */
  normalize(mode: unknown): string {
    if (mode === "gb" || mode === "60") return mode;
    return LogicClock.DEFAULT;
  },

  /** LogicClock.lua:15 */
  hz(mode: unknown): number {
    return LogicClock.HZ[LogicClock.normalize(mode)]!;
  },

  /** LogicClock.lua:19 */
  label(mode: unknown): string {
    if (LogicClock.normalize(mode) === "gb") return "59.73HZ";
    return "60HZ";
  },

  /** LogicClock.lua:24 */
  cycle(mode: unknown, dir?: number): string {
    const ring = LogicClock.MODES;
    const cur = LogicClock.normalize(mode);
    let at = 1;
    for (let i = 0; i < ring.length; i++) {
      if (ring[i] === cur) {
        at = i + 1;
        break;
      }
    }
    const n = ring.length;
    return ring[(((at - 1 + (dir ?? 1)) % n) + n) % n]!;
  },

  /** LogicClock.lua:34 -- FixedStep.setHz dropped: the host paces frames. */
  apply(mode: unknown): string {
    LogicClock.current = LogicClock.normalize(mode);
    return LogicClock.current;
  },

  /** LogicClock.lua:40 */
  applyOptions(opts?: { logicClock?: unknown } | null): string {
    return LogicClock.apply(opts?.logicClock);
  },
};

export default LogicClock;
