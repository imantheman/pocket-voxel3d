// Port of gen1recomp src/core/game3/battle/link_guard.lua (GPLv3 + additional terms; see LICENSE.md).
// Link battles must never fall back to an unsynchronised RNG: while armed, any
// fallback trips the guard and raises.
//
// Port notes:
// - pcall(require, "src.core.game3.rng") always succeeds here (core/rng.ts is
//   linked in), so the math.random fallback is unreachable; it is kept as
//   platform random() with Lua's argument rules.
// - error(msg, 2) becomes a thrown Error (no level/position prefix).

import { tostring } from "../../../../import/gen3/lua.ts";
import { Rng } from "../rng.ts";
import { random } from "../../platform/rng.ts";

export interface LinkGuard {
  active: boolean;
  tripped: string | null | undefined;
  arm(): void;
  disarm(): void;
  trip(where?: unknown): never;
  fallback(where: unknown, lo?: number | null, hi?: number | null): number;
  source<F extends (...a: any[]) => any>(where: unknown, fallback: F): F;
}

export const Guard = {} as LinkGuard;

Guard.active = false;
Guard.tripped = null;

// Lua: link_guard.lua:6
Guard.arm = function (): void {
  Guard.active = true;
  Guard.tripped = null;
};

// Lua: link_guard.lua:11
Guard.disarm = function (): void {
  Guard.active = false;
};

// Lua: link_guard.lua:15
Guard.trip = function (where?: unknown): never {
  Guard.tripped = Guard.tripped ?? tostring(where ?? "rng");
  throw new Error("link battle rng fallback: " + tostring(where ?? "rng"));
};

// Lua: link_guard.lua:20
Guard.fallback = function (where: unknown, lo?: number | null, hi?: number | null): number {
  if (Guard.active) Guard.trip(where);
  // Lua: pcall(require, "src.core.game3.rng") -- always loads here
  if (Rng && Rng.compat) {
    if (lo == null) return Rng.compat();
    return Rng.compat(lo, hi);
  }
  if (lo == null) return random();
  return random(lo, hi as number);
};

// Lua: link_guard.lua:31
Guard.source = function <F extends (...a: any[]) => any>(where: unknown, fallback: F): F {
  if (!Guard.active) return fallback;
  return ((...args: any[]) => {
    if (Guard.active) Guard.trip(where);
    return fallback(...args);
  }) as F;
};

export default Guard;
