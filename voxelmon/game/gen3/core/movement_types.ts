// Port of gen1recomp src/core/game3/movement_types.lua (GPLv3 + additional terms; see LICENSE.md).
// Object movement types in FireRed's numbering (the canonical one); RSE-only
// types are moved above RSE_BASE.

import { tonumber } from "../../../import/gen3/lua.ts";
import { Constants } from "./constants.ts";

interface MovementTable {
  game: string;
  toCanon: Record<number, number>;
  nameOf: Record<number, string>;
}

const tables: Record<string, MovementTable> = {};

// Lua: movement_types.lua:26
function names(game: string): Record<string, string> {
  const t = Constants.of(game).movement;
  const r = t.byId && t.byId[MovementTypes.PREFIX];
  if (!r) throw new Error("movement constants have no types for " + game);
  return r;
}

// Lua: movement_types.lua:31
function build(game: string): MovementTable {
  const key = Constants.gameKey(game);
  let hit = tables[key];
  if (hit) return hit;
  const fr = Constants.of(MovementTypes.CANON_GAME);
  const toCanon: Record<number, number> = {};
  const nameOf: Record<number, string> = {};
  const byRaw = names(key);
  for (const rawKey of Object.keys(byRaw)) {
    const raw = Number(rawKey);
    const name = byRaw[rawKey]!;
    let v: number;
    if (key === MovementTypes.CANON_GAME) {
      v = raw;
    } else {
      v = fr.id("movement", MovementTypes.ALIASES[name] ?? name);
      if (v === undefined || v === null) v = MovementTypes.RSE_BASE + raw;
    }
    toCanon[raw] = v;
    nameOf[v] = name;
  }
  hit = { game: key, toCanon, nameOf };
  tables[key] = hit;
  return hit;
}

export const MovementTypes = {
  RSE_BASE: 0x100,
  PREFIX: "MOVEMENT_TYPE_",
  CANON_GAME: "firered",

  // pokeemerald/src/event_object_movement.c:4442
  // pokefirered/src/event_object_movement.c:4521
  ALIASES: {
    MOVEMENT_TYPE_JOG_IN_PLACE_DOWN: "MOVEMENT_TYPE_WALK_IN_PLACE_FAST_DOWN",
    MOVEMENT_TYPE_JOG_IN_PLACE_UP: "MOVEMENT_TYPE_WALK_IN_PLACE_FAST_UP",
    MOVEMENT_TYPE_JOG_IN_PLACE_LEFT: "MOVEMENT_TYPE_WALK_IN_PLACE_FAST_LEFT",
    MOVEMENT_TYPE_JOG_IN_PLACE_RIGHT: "MOVEMENT_TYPE_WALK_IN_PLACE_FAST_RIGHT",
    // pokeemerald/src/event_object_movement.c:4452
    // pokefirered/src/event_object_movement.c:4531
    MOVEMENT_TYPE_RUN_IN_PLACE_DOWN: "MOVEMENT_TYPE_JOG_IN_PLACE_DOWN",
    MOVEMENT_TYPE_RUN_IN_PLACE_UP: "MOVEMENT_TYPE_JOG_IN_PLACE_UP",
    MOVEMENT_TYPE_RUN_IN_PLACE_LEFT: "MOVEMENT_TYPE_JOG_IN_PLACE_LEFT",
    MOVEMENT_TYPE_RUN_IN_PLACE_RIGHT: "MOVEMENT_TYPE_JOG_IN_PLACE_RIGHT",
  } as Record<string, string>,

  // Lua: movement_types.lua:53
  canon(game: string, rawIn: unknown): number | undefined {
    const raw = tonumber(rawIn);
    if (raw === undefined) return undefined;
    if (raw >= MovementTypes.RSE_BASE) return raw;
    const v = build(game).toCanon[raw];
    if (v === undefined) return raw;
    return v;
  },

  // Lua: movement_types.lua:62
  nameOf(game: string, canonId: unknown): string | undefined {
    return build(game).nameOf[tonumber(canonId) ?? -1];
  },

  // Lua: movement_types.lua:66
  canonOf(game: string, name: string): number | undefined {
    const raw = Constants.of(game).id("movement", name);
    if (raw === undefined || raw === null) return undefined;
    return MovementTypes.canon(game, raw);
  },

  // Lua: movement_types.lua:72
  isRseOnly(idIn: unknown): boolean {
    const id = tonumber(idIn);
    return id !== undefined && id >= MovementTypes.RSE_BASE;
  },
};

export default MovementTypes;
