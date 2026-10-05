// Port of gen1recomp src/core/game3/scripting/collision.lua (GPLv3 + additional terms; see LICENSE.md).
// Family dispatch for metatile collision. The Lua requires
// collision_<family>; only "frlg" is ported (collision_rse is Emerald, out
// of scope) -- another family name throws like a failed require.

import { Family } from "../../../../import/gen3/family.ts";
import { CollisionFrlg } from "./collision_frlg.ts";

export interface CollisionImpl {
  classify(mid: number, mapColl: number | undefined, behavior: number | undefined, kind?: string): [string, string | undefined];
  seed(category: string, ledgeDir?: string, kind?: string): number;
  fromCell(mid: number, mapColl: number | undefined, behavior: number | undefined, kind?: string): [number, string, string | undefined];
  setTileBits?(bits: unknown): void;
}

const MODULES: Record<string, CollisionImpl> = { frlg: CollisionFrlg };
const impls: Record<string, CollisionImpl> = {};

export const Collision = {
  // Lua: collision.lua:7
  impl(familyName?: string): CollisionImpl {
    const name = familyName ?? Family.active().name;
    let m = impls[name];
    if (!m) {
      m = MODULES[name];
      if (!m) throw new Error(`module 'src.core.game3.scripting.collision_${name}' not found`);
      impls[name] = m;
    }
    return m;
  },

  // Lua: collision.lua:17 -- [category, ledgeDir]
  classify(mid: number, mapColl: number | undefined, behavior: number | undefined, kind?: string): [string, string | undefined] {
    return Collision.impl().classify(mid, mapColl, behavior, kind);
  },

  // Lua: collision.lua:21
  seed(category: string, ledgeDir?: string, kind?: string): number {
    return Collision.impl().seed(category, ledgeDir, kind);
  },

  // Lua: collision.lua:25 -- [collByte, category, ledgeDir]
  fromCell(mid: number, mapColl: number | undefined, behavior: number | undefined, kind?: string): [number, string, string | undefined] {
    return Collision.impl().fromCell(mid, mapColl, behavior, kind);
  },
};

export default Collision;
