// Port of gen1recomp src/core/game3/rng.lua (GPLv3 + additional terms; see LICENSE.md).
// Pret FireRed LCRNG (include/random.h + src/random.c + wild_encounter.c).
// ISO C rand-style: state = state * 1103515245 + C; return state >> 16.
//
// The `love and love.timer and love.timer.getTime` entropy branches always
// hold under LÖVE, so only that branch is ported (platform Timer).

import { mod, tonumber } from "../../../import/gen3/lua.ts";
import { Timer } from "../platform/timer.ts";

const U32 = 4294967296;
const RAND_MULT = 1103515245;
const ADD1 = 24691; // ISO_RANDOMIZE1
const ADD2 = 12345; // ISO_RANDOMIZE2

export interface RngState { value: number; value2: number; wild: number }

// Lua: rng.lua:20
function u32(n: unknown): number {
  return mod(Math.floor(tonumber(n) ?? 0), U32);
}

// Lua: rng.lua:24
function u16(n: unknown): number {
  return mod(Math.floor(tonumber(n) ?? 0), 65536);
}

// Lua: rng.lua:32
function iso1(val: number): number {
  return mod(Rng.mulU32(val, RAND_MULT) + ADD1, U32);
}

// Lua: rng.lua:36
function iso2(val: number): number {
  return mod(Rng.mulU32(val, RAND_MULT) + ADD2, U32);
}

export const Rng = {
  _value: 0, // gRngValue
  _value2: 0, // gRng2Value
  _wild: 0, // sWildEncounterData.rngState

  /** Exact u32 multiply via 16x16 split (doubles lose low bits above 2^53). */
  // Lua: rng.lua:12
  mulU32(a: unknown, b: unknown): number {
    const x = mod(Math.floor(tonumber(a) ?? 0), U32);
    const y = mod(Math.floor(tonumber(b) ?? 0), U32);
    const aL = mod(x, 65536), aH = mod(Math.floor(x / 65536), 65536);
    const bL = mod(y, 65536), bH = mod(Math.floor(y / 65536), 65536);
    return mod(aL * bL + mod(aL * bH + aH * bL, 65536) * 65536, U32);
  },

  /** Pret Random(): advance gRngValue with ISO_RANDOMIZE1, return high 16 bits. */
  // Lua: rng.lua:41
  Random(): number {
    Rng._value = iso1(Rng._value);
    return mod(Math.floor(Rng._value / 65536), 65536);
  },

  /** Step RNG state once per frame (matching GBA VBlank / main loop UpdateRng). */
  // Lua: rng.lua:47
  step(): number {
    return Rng.Random();
  },

  /** Perturb the RNG state with hardware timer entropy (on boot, continue, or key presses). */
  // Lua: rng.lua:52
  perturb(entropy?: number | null): number {
    if (entropy == null) {
      entropy = mod(Math.floor(Timer.getTime() * 1000000), 65536);
    }
    Rng._value = mod(Rng._value + u16(entropy), U32);
    return Rng.Random();
  },

  /** Pret SeedRng(u16): gRngValue = seed (zero-extended). */
  // Lua: rng.lua:67
  SeedRng(seed: unknown): void {
    Rng._value = u16(seed);
  },

  /** Pret Random32(): (Random() | (Random() << 16)). */
  // Lua: rng.lua:72
  Random32(): number {
    const lo = Rng.Random();
    const hi = Rng.Random();
    return lo + hi * 65536;
  },

  /** Pret Random2() (emerald-shaped; FR header declares it). */
  // Lua: rng.lua:79
  Random2(): number {
    Rng._value2 = iso1(Rng._value2);
    return mod(Math.floor(Rng._value2 / 65536), 65536);
  },

  // Lua: rng.lua:84
  SeedRng2(seed: unknown): void {
    Rng._value2 = u16(seed);
  },

  /** pret WildEncounterRandom / SeedWildEncounterRng (ISO_RANDOMIZE2). */
  // Lua: rng.lua:89
  WildEncounterRandom(): number {
    Rng._wild = iso2(Rng._wild);
    return mod(Math.floor(Rng._wild / 65536), 65536);
  },

  // Lua: rng.lua:94
  SeedWildEncounterRng(seed: unknown): void {
    Rng._wild = u16(seed);
  },

  /** Random() % n (pret style). n <= 0 -> 0. */
  // Lua: rng.lua:99
  mod(n: unknown): number {
    const k = Math.floor(tonumber(n) ?? 0);
    if (k <= 0) return 0;
    return mod(Rng.Random(), k);
  },

  /**
   * Drop-in for math.random used by battle adapter:
   * compat() -> [0,1), compat(n) -> 1..n, compat(lo,hi) -> lo..hi inclusive.
   */
  // Lua: rng.lua:107
  compat(lo?: unknown, hi?: unknown): number {
    if (lo == null && hi == null) {
      return Rng.Random() / 65536;
    }
    if (hi == null) {
      const n = Math.floor(tonumber(lo) ?? 1);
      if (n <= 0) return 0;
      return 1 + mod(Rng.Random(), n);
    }
    let l = Math.floor(tonumber(lo) ?? 0);
    let h = Math.floor(tonumber(hi) ?? l);
    if (h < l) [l, h] = [h, l];
    const span = h - l + 1;
    if (span <= 0) return l;
    return l + mod(Rng.Random(), span);
  },

  // Lua: rng.lua:124
  getState(): RngState {
    return {
      value: Rng._value,
      value2: Rng._value2,
      wild: Rng._wild,
    };
  },

  // Lua: rng.lua:132
  setState(st: unknown): boolean {
    if (st == null || typeof st !== "object") return false;
    const s = st as Record<string, unknown>;
    const v1 = tonumber(s.value), v2 = tonumber(s.value2), wild = tonumber(s.wild);
    if (v1 == null || v2 == null || wild == null) return false;
    Rng._value = u32(v1);
    Rng._value2 = u32(v2);
    Rng._wild = u32(wild);
    return true;
  },

  /**
   * pret SeedRngAndSetTrainerId analogue: seed from a 16-bit timer-ish value.
   * Returns the seed used (trainer id lower).
   */
  // Lua: rng.lua:142
  seedFromTimer(opts?: { seed?: number } | null): number {
    const o = opts ?? {};
    let val: number | undefined = o.seed;
    if (val == null) {
      val = mod(Math.floor(Timer.getTime() * 1000000), 65536);
    }
    val = u16(val);
    Rng.SeedRng(val);
    return val;
  },

  /** New-game / post-title init: timer seed + wild stream from Random(). */
  // Lua: rng.lua:160
  seedNewGame(opts?: { seed?: number } | null): number {
    const trainerId = Rng.seedFromTimer(opts);
    Rng.SeedWildEncounterRng(Rng.Random());
    return trainerId;
  },

  /** Sync module state into a game3 session table for save. */
  // Lua: rng.lua:167
  captureToSession(session: any): void {
    if (session == null || typeof session !== "object") return;
    session.rng = Rng.getState();
  },

  /** Restore from session (Continue). Missing fields leave current state. */
  // Lua: rng.lua:173
  restoreFromSession(session: any): boolean {
    if (session == null || typeof session !== "object" || session.rng == null || typeof session.rng !== "object") {
      return false;
    }
    return Rng.setState(session.rng) === true;
  },
};

export default Rng;
