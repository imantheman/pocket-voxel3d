// An ENGINE_* flag's id on the cart being played, for the modules that have
// no World to ask (World.engineFlagId is the same lookup). Crystal numbers
// its engine flags one higher than pokegold from id 16 on
// (../pokecrystal/constants/engine_flags.asm), so a pokegold id written in
// code is the wrong bit there; the import's constants.engineFlagOrder (only
// Crystal's manifest carries one) names every id. Without it, the pokegold
// id stands.

import { loadGenerated } from "../platform/data.ts";

let order: unknown = undefined;
let ids: Record<string, number> = {};

/** `name`'s id in this cart's engine flags, or `goldId` when it has no order. */
export function engineFlagIdFor(name: string, goldId: number): number {
  let current: unknown;
  try {
    current = loadGenerated<{ engineFlagOrder?: unknown }>("constants")?.engineFlagOrder;
  } catch {
    return goldId;
  }
  if (current === null || typeof current !== "object") return goldId;
  if (current !== order) {
    order = current;
    ids = {};
    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) if (typeof current[i] === "string") ids[current[i]] = i;
    } else {
      // a Lua-shaped 1-based table, as World.engineFlagId reads it
      for (const [k, v] of Object.entries(current as Record<string, unknown>)) {
        const index = Number(k);
        if (Number.isInteger(index) && typeof v === "string") ids[v] = index - 1;
      }
    }
  }
  return ids[name] ?? goldId;
}
