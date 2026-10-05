// Port of gen1recomp src/core/game3/scripting/gfx_ids.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG OBJ_EVENT_GFX_* numeric ids -> Gen2 host SPRITE_* names, and movement
// types -> host movement specs. Sourced from pret pokefirered
// include/constants/event_objects.h. Lua sequences (dirs, route, delays) are
// 0-based JS arrays here.

import { tonumber } from "../../../../import/gen3/lua.ts";

export interface MovementSpec {
  movement: string;
  range?: string;
  dirs?: string[];
  delays?: string;
  follow?: number;
  face: string;
  slow?: boolean;
  next?: Record<string, string>;
  route?: string[];
  skipFrom?: number;
  skipAxis?: string;
}

export interface HostMovement extends MovementSpec {
  rangeX: number;
  rangeY: number;
  radius?: { x: number; y: number };
}

const S = "down", N = "up", W = "left", E = "right";

const TO_SPRITE: Record<number, string> = {
  [0]: "SPRITE_CHRIS",            // RED (player male)
  [7]: "SPRITE_KRIS",             // GREEN / Leaf (player female)
  [16]: "SPRITE_YOUNGSTER",       // LITTLE_BOY
  [17]: "SPRITE_LASS",            // LITTLE_GIRL
  [18]: "SPRITE_YOUNGSTER",
  [19]: "SPRITE_YOUNGSTER",       // BOY
  [22]: "SPRITE_LASS",
  [23]: "SPRITE_TEACHER",         // WOMAN_1
  [24]: "SPRITE_COOLTRAINER_F",   // CRUSH_GIRL
  [25]: "SPRITE_POKEFAN_M",       // MAN
  [26]: "SPRITE_ROCKER",
  [27]: "SPRITE_FISHER",          // FAT_MAN
  [29]: "SPRITE_BEAUTY",
  [30]: "SPRITE_POKEFAN_M",       // BALDING_MAN
  [31]: "SPRITE_TEACHER",         // WOMAN_3
  [32]: "SPRITE_GRAMPS",          // OLD_MAN_1
  [33]: "SPRITE_GRAMPS",
  [35]: "SPRITE_GRANNY",
  [39]: "SPRITE_YOUNGSTER",       // CAMPER
  [40]: "SPRITE_LASS",            // PICNICKER
  [41]: "SPRITE_COOLTRAINER_M",
  [42]: "SPRITE_COOLTRAINER_F",
  // include/constants/event_objects.h:54, event_objects.h:61
  [54]: "SPRITE_BLACK_BELT",
  [55]: "SPRITE_SCIENTIST",
  [56]: "SPRITE_POKEFAN_M",       // HIKER
  [57]: "SPRITE_FISHER",
  [61]: "SPRITE_GENTLEMAN",
  [62]: "SPRITE_SAILOR",
  [64]: "SPRITE_NURSE",
  [65]: "SPRITE_LINK_RECEPTIONIST",
  [68]: "SPRITE_CLERK",
  [69]: "SPRITE_OFFICER",         // MG_DELIVERYMAN fallback
  [71]: "SPRITE_OAK",
  [72]: "SPRITE_BLUE",
  [73]: "SPRITE_BILL",
  [76]: "SPRITE_MOM",             // rival's sister / Daisy-ish
  [88]: "SPRITE_MOM",             // player's PC / mom-adjacent
  [89]: "SPRITE_SUPER_NERD",      // CELIO
  [92]: "SPRITE_POKE_BALL",
};

// src/event_object_movement.c:679
const DELAYS: Record<string, number[]> = {
  MEDIUM: [32, 64, 96, 128],
  LONG: [32, 64, 128, 192],
  SHORT: [32, 48, 64, 80],
};

// include/constants/event_object_movement.h:5
// src/event_object_movement.c:359
// src/data/object_events/movement_type_func_tables.h:183
const MOVEMENT: Record<number, MovementSpec> = {
  [0x01]: { movement: "LOOK", dirs: [S, N, W, E], delays: "MEDIUM", follow: 0, face: S },
  [0x02]: { movement: "WALK", range: "ANY_DIR", dirs: [S, N, W, E], face: S },
  [0x03]: { movement: "WALK", range: "UP_DOWN", dirs: [S, N], face: N },
  [0x04]: { movement: "WALK", range: "UP_DOWN", dirs: [S, N], face: S },
  [0x05]: { movement: "WALK", range: "LEFT_RIGHT", dirs: [W, E], face: W },
  [0x06]: { movement: "WALK", range: "LEFT_RIGHT", dirs: [W, E], face: E },
  [0x07]: { movement: "STAY", face: N },
  [0x08]: { movement: "STAY", face: S },
  [0x09]: { movement: "STAY", face: W },
  [0x0A]: { movement: "STAY", face: E },
  [0x0D]: { movement: "LOOK", dirs: [S, N], delays: "MEDIUM", follow: 1, face: S },
  [0x0E]: { movement: "LOOK", dirs: [W, E], delays: "MEDIUM", follow: 2, face: W },
  [0x0F]: { movement: "LOOK", dirs: [N, W], delays: "SHORT", follow: 3, face: N },
  [0x10]: { movement: "LOOK", dirs: [N, E], delays: "SHORT", follow: 4, face: N },
  [0x11]: { movement: "LOOK", dirs: [S, W], delays: "SHORT", follow: 5, face: S },
  [0x12]: { movement: "LOOK", dirs: [S, E], delays: "SHORT", follow: 6, face: S },
  [0x13]: { movement: "LOOK", dirs: [N, S, W, S], delays: "SHORT", follow: 7, face: S },
  [0x14]: { movement: "LOOK", dirs: [S, N, E, S], delays: "SHORT", follow: 8, face: S },
  [0x15]: { movement: "LOOK", dirs: [N, W, E, N], delays: "SHORT", follow: 9, face: N },
  [0x16]: { movement: "LOOK", dirs: [W, E, S, S], delays: "SHORT", follow: 10, face: S },
  [0x17]: { movement: "ROTATE", next: { [S]: E, [E]: N, [N]: W, [W]: S }, follow: 0, face: S },
  [0x18]: { movement: "ROTATE", next: { [S]: W, [W]: N, [N]: E, [E]: S }, follow: 0, face: S },
  [0x19]: { movement: "BACK_FORTH", face: N },
  [0x1A]: { movement: "BACK_FORTH", face: S },
  [0x1B]: { movement: "BACK_FORTH", face: W },
  [0x1C]: { movement: "BACK_FORTH", face: E },
  [0x4D]: { movement: "RAISE_HAND", face: S },
  [0x4E]: { movement: "RAISE_HAND", face: S },
  [0x4F]: { movement: "RAISE_HAND", face: S },
  [0x50]: { movement: "WALK", range: "ANY_DIR", dirs: [S, N, W, E], slow: true, face: S },
};

// src/event_object_movement.c:3949 -- [route, skipFrom, skipAxis]
const SEQUENCES: Record<number, [string[], number, string]> = {
  [0x1D]: [[N, E, W, S], 2, "x"],
  [0x1E]: [[E, W, S, N], 1, "x"],
  [0x1F]: [[S, N, E, W], 1, "y"],
  [0x20]: [[W, S, N, E], 2, "y"],
  [0x21]: [[N, W, E, S], 2, "x"],
  [0x22]: [[W, E, S, N], 1, "x"],
  [0x23]: [[S, N, W, E], 1, "y"],
  [0x24]: [[E, S, N, W], 2, "y"],
  [0x25]: [[W, N, S, E], 2, "y"],
  [0x26]: [[N, S, E, W], 1, "y"],
  [0x27]: [[E, W, N, S], 1, "x"],
  [0x28]: [[S, E, W, N], 2, "x"],
  [0x29]: [[E, N, S, W], 2, "y"],
  [0x2A]: [[N, S, W, E], 1, "y"],
  [0x2B]: [[W, E, N, S], 1, "x"],
  [0x2C]: [[S, W, E, N], 2, "x"],
  [0x2D]: [[N, W, S, E], 2, "y"],
  [0x2E]: [[S, E, N, W], 2, "y"],
  [0x2F]: [[W, S, E, N], 2, "x"],
  [0x30]: [[E, N, W, S], 2, "x"],
  [0x31]: [[N, E, S, W], 2, "y"],
  [0x32]: [[S, W, N, E], 2, "y"],
  [0x33]: [[W, N, E, S], 2, "x"],
  [0x34]: [[E, S, W, N], 2, "x"],
};
for (const k of Object.keys(SEQUENCES)) {
  const s = SEQUENCES[Number(k)]!;
  MOVEMENT[Number(k)] = {
    movement: "SEQUENCE", route: s[0], skipFrom: s[1], skipAxis: s[2], face: s[0][0]!,
  };
}

export const GfxIds = {
  TO_SPRITE,
  DELAYS,
  MOVEMENT,

  // Lua: gfx_ids.lua:127
  spriteFor(graphicsId: unknown): string {
    return TO_SPRITE[tonumber(graphicsId) ?? -1] ?? "SPRITE_YOUNGSTER";
  },

  // Lua: gfx_ids.lua:131
  initialFacing(movementType: unknown): string {
    const spec = MOVEMENT[tonumber(movementType) ?? 0];
    return spec ? spec.face : S;
  },

  // Lua: gfx_ids.lua:136
  hostMovement(movementType: unknown, rangeX: unknown, rangeY: unknown): HostMovement {
    const mt = tonumber(movementType) ?? 0;
    const spec: MovementSpec = MOVEMENT[mt] ?? { movement: "STAY", face: S };
    const out = { ...spec } as HostMovement;
    out.range = spec.range ?? spec.face.toUpperCase();
    out.rangeX = tonumber(rangeX) ?? 0;
    out.rangeY = tonumber(rangeY) ?? 0;
    if (out.movement === "WALK" || out.movement === "BACK_FORTH" || out.movement === "SEQUENCE") {
      // src/event_object_movement.c:1381
      out.rangeX = Math.max(1, out.rangeX);
      out.rangeY = Math.max(1, out.rangeY);
      out.radius = { x: out.rangeX, y: out.rangeY };
    }
    return out;
  },
};

export default GfxIds;
