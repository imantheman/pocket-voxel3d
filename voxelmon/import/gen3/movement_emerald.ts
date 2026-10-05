// Port of gen1recomp src/import/gba/movement_emerald.lua (GPLv3 + additional terms; see LICENSE.md).
// Canonical movement-action ids: FireRed's MOVEMENT_ACTION_* values, plus
// Emerald-only actions numbered from RSE_BASE; and per-game raw -> canonical
// translation tables.
// NOT FAITHFUL (plumbing): constants.ts does not carry Emerald's tables, so
// Emerald's movement constants (converted mechanically into
// game/gen3/core/constants/emerald/movement.ts) are read directly here.

import { Constants } from "../../game/gen3/core/constants.ts";
import emeraldMovement from "../../game/gen3/core/constants/emerald/movement.ts";

type MovementConsts = { byId: Record<string, Record<number, string>>; byName: Record<string, number> };

/** Constants.of(game).movement (Emerald's from its converted table). */
function movementConsts(game: string): MovementConsts {
  if (Constants.gameKey(game) === "emerald") return emeraldMovement as unknown as MovementConsts;
  return Constants.of(game).movement as MovementConsts;
}

export interface Canon { byName: Record<string, number>; byId: Record<number, string>; rseCount: number }

export interface MovementTable {
  game: string;
  toCanon: Record<number, number>;
  names: Record<number, string>;
  count: number;
  stepEnd: number;
  translate(bytes: ArrayLike<number>): [number[], number[] | undefined];
}

let canon: Canon | undefined;

// Lua: movement_emerald.lua:12
function actions(game: string): Record<number, string> {
  const t = movementConsts(game);
  const a = t.byId ? t.byId[MovementEmerald.PREFIX] : undefined;
  if (!a) throw new Error("movement constants have no actions for " + game);
  return a;
}

// Lua: movement_emerald.lua:17
function build_canon(): Canon {
  if (canon) return canon;
  const fr = movementConsts(MovementEmerald.CANON_GAME);
  const byName: Record<string, number> = {};
  const byId: Record<number, string> = {};
  const canonActions = actions(MovementEmerald.CANON_GAME);
  for (const id of Object.keys(canonActions)) {
    const name = canonActions[Number(id)]!;
    const v = fr.byName[name]!;
    byName[name] = v;
    byId[v] = name;
  }
  const ref = actions(MovementEmerald.REFERENCE_GAME);
  const ids = Object.keys(ref).map(Number).sort((a, b) => a - b);
  let nextId = MovementEmerald.RSE_BASE;
  for (const id of ids) {
    const name = ref[id]!;
    if (byName[name] === undefined) {
      byName[name] = nextId;
      byId[nextId] = name;
      nextId = nextId + 1;
    }
  }
  canon = { byName, byId, rseCount: nextId - MovementEmerald.RSE_BASE };
  return canon;
}

const tables: Record<string, MovementTable> = {};

export const MovementEmerald = {
  RSE_BASE: 0x100,
  PREFIX: "MOVEMENT_ACTION_",
  REFERENCE_GAME: "emerald",
  CANON_GAME: "firered",

  // Lua: movement_emerald.lua:42
  canon(): Canon {
    return build_canon();
  },

  // Lua: movement_emerald.lua:46
  canonOf(name: string): number | undefined {
    return build_canon().byName[name];
  },

  // Lua: movement_emerald.lua:50
  nameOf(canonId: unknown): string | undefined {
    return build_canon().byId[canonId as number];
  },

  // Lua: movement_emerald.lua:56
  forGame(game?: string): MovementTable {
    game = game ?? MovementEmerald.REFERENCE_GAME;
    const key = Constants.gameKey(game);
    const hit = tables[key];
    if (hit) return hit;
    const c = build_canon();
    const toCanon: Record<number, number> = {}, names: Record<number, string> = {};
    let count = 0;
    const acts = actions(key);
    for (const rawKey of Object.keys(acts)) {
      const raw = Number(rawKey);
      const name = acts[raw]!;
      const v = c.byName[name];
      if (v !== undefined) {
        toCanon[raw] = v;
        names[raw] = name;
        count = count + 1;
      }
    }
    const stepEnd = movementConsts(key).byName.MOVEMENT_ACTION_STEP_END;
    if (stepEnd === undefined || stepEnd === null) {
      throw new Error(`game3 constants: ${key} has no movement MOVEMENT_ACTION_STEP_END`);
    }
    const T: MovementTable = {
      game: key, toCanon, names, count, stepEnd,
      // Lua: movement_emerald.lua:76 -- bytes 0-based; [out, unknown]
      translate(bytes: ArrayLike<number>): [number[], number[] | undefined] {
        const out: number[] = [];
        let unknown: number[] | undefined;
        for (let i = 0; i < bytes.length; i++) {
          const b = bytes[i]!;
          let v = toCanon[b];
          if (v === undefined) {
            unknown = unknown ?? [];
            unknown.push(b);
            v = b;
          }
          out[i] = v;
        }
        return [out, unknown];
      },
    };
    tables[key] = T;
    return T;
  },
};

export default MovementEmerald;
