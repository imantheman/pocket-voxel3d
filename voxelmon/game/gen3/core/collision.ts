// Port of gen1recomp src/core/game3/collision.lua (GPLv3 + additional terms; see LICENSE.md).
// Game3-owned field collision grid.
// Built from mapDef.blocks + tileset.collision (Gen2 COLL_* quads baked from
// FRLG metatile attrs at extract). Does not call World:step / Player:tryMove.
//
// Return shapes (Lua multiple returns -> 0-based tuples):
//   canEnter -> [ok, reason]; ledgeLanding / connectionLanding /
//   scriptConnection -> [x, y] or []; stairSpeeds -> [dx, dy];
//   nextElevation -> [elevation, committed]. Everything else returns one value.
//
// Plumbing: src.world.gen2.Permissions has no gen3 port. collision.lua reads
// five of its members; `GenPermissions` below carries exactly those (three are
// CollPermissions' own, two are ported from Permissions.lua), so the
// behaviour is Brian's.

import { ipairs, len, type LuaTable } from "../platform/lt.ts";
import { find } from "../platform/lpattern.ts";
import { format, mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { MapCatalog } from "../../../import/gen3/map_catalog.ts";
import { Versions } from "../../../import/gen3/versions.ts";
import { CollPermissions } from "../shared/core/CollPermissions.ts";
import { Connections } from "./connections.ts";
import { MB } from "./mb.ts";
import { InteractionScripts } from "./scripting/interaction_scripts.ts";
import { Collision as ScriptColl } from "./scripting/collision.ts";
import { Space as SpaceMod } from "./scripting/space.ts";
import { Map as MapMod } from "./map.ts";
import { Warp as WarpMod } from "./warp.ts";
import { Player as PlayerMod } from "./player.ts";
import { Audio as AudioMod } from "./audio.ts";
import { FieldEffects as FieldEffectsMod } from "./field_effects.ts";
import { Ghosts as GhostsMod } from "./ghosts.ts";
import { Runtime as RuntimeMod } from "./runtime.ts";
import { Objects as ObjectsMod } from "./objects.ts";
import { Field as FieldMod } from "./field.ts";
import { Doors as DoorsMod } from "./doors.ts";
import { MapIds as MapIdsMod } from "./map_ids.ts";
import { Bridge as BridgeMod } from "./bridge.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Beh = number | null | undefined;
type DirSet = Record<string, boolean>;

/** A warp hit returned by isDoorWarp / isExitWarp / isEscalatorWarp / isArrowWarp / isStairWarp. */
export interface WarpHit {
  warp: any;
  destMap: string;
  destX: number;
  destY: number;
  x: number;
  y: number;
  doorEntry?: any;
  escDir?: string;
  behavior?: Beh;
}

export interface CanEnterOpts {
  surfing?: boolean;
  fromX?: number;
  fromY?: number;
  dir?: string;
  elevation?: number;
}

// Lua: collision.lua:5 lazyReq -- requires become static imports (see header
// of each use); circular imports are fine because nothing runs at top level.

function isTable(v: unknown): boolean {
  return v !== null && typeof v === "object";
}

// Lua: collision.lua:16
function mbSet(names: string[]): Record<number, boolean> {
  const out: Record<number, boolean> = {};
  for (const name of names) out[MB.require(name)] = true;
  return out;
}

// Lua: collision.lua:22 (Lua sequences: d[1], d[2])
const DELTA: Record<string, [null, number, number] | undefined> = {
  up: [null, 0, -1],
  down: [null, 0, 1],
  left: [null, -1, 0],
  right: [null, 1, 0],
};

// Lua: collision.lua:37
function log(msg: unknown): void {
  console.log("[game3/collision] " + tostring(msg));
}

// src/world/gen2/Permissions.lua -- the members collision.lua reads.
interface GenPermissions {
  isWater(coll: number | null | undefined): boolean;
  isWalkable(coll: number | null | undefined): boolean;
  isLedge(coll: number | null | undefined): boolean;
  isGrass(coll: number | null | undefined): boolean;
  ledgeFacings(coll: number | null | undefined): DirSet | undefined;
}

// Lua: Permissions.lua:34
const GRASS: Record<number, boolean> = {
  [0x10]: true, // COLL_TALL_GRASS_10 (unused)
  [0x14]: true, // COLL_LONG_GRASS
  [0x18]: true, // COLL_TALL_GRASS
  [0x1c]: true, // COLL_LONG_GRASS_1C (unused)
};

// Lua: Permissions.lua:179
const LEDGE_FACINGS: Record<number, DirSet> = {
  [0x0]: { right: true },              // COLL_HOP_RIGHT
  [0x1]: { left: true },               // COLL_HOP_LEFT
  [0x2]: { up: true },                 // COLL_HOP_UP (unused)
  [0x3]: { down: true },               // COLL_HOP_DOWN
  [0x4]: { down: true, right: true },  // COLL_HOP_DOWN_RIGHT
  [0x5]: { down: true, left: true },   // COLL_HOP_DOWN_LEFT
  [0x6]: { up: true, right: true },    // COLL_HOP_UP_RIGHT (unused)
  [0x7]: { up: true, left: true },     // COLL_HOP_UP_LEFT (unused)
};

const GenPermissionsMod: GenPermissions = {
  // Lua: Permissions.lua:12-15 (aliases of CollPermissions)
  isWater: CollPermissions.isWater,
  isWalkable: CollPermissions.isWalkable,
  isLedge: CollPermissions.isLedge,

  // Lua: Permissions.lua:41
  isGrass(coll: number | null | undefined): boolean {
    if (coll == null) return false;
    return GRASS[mod(coll, 256)] === true;
  },

  // Lua: Permissions.lua:191
  ledgeFacings(coll: number | null | undefined): DirSet | undefined {
    if (!CollPermissions.isLedge(coll)) return undefined;
    return LEDGE_FACINGS[mod(coll as number, 8)];
  },
};

// Lua: collision.lua:41
let permsLoaded = false;
let permsMod: GenPermissions | undefined;
function permissions(): GenPermissions | undefined {
  if (!permsLoaded) {
    // pcall(lazyReq, "src.world.gen2.Permissions"): no gen3 port of that
    // module; GenPermissionsMod carries the members used here.
    permsMod = GenPermissionsMod;
    permsLoaded = true;
  }
  return permsMod;
}

// Lua: collision.lua:51 -- [tileset, tsId] or []
function resolveTileset(game: any, mapDef: any): [any?, any?] {
  if (!mapDef) return [];
  const tsId = mapDef.tileset;
  const data = game ? game.data : undefined;
  const sets = data ? (data.tilesets ?? data.gen2Tilesets) : undefined;
  return [tsId != null && sets ? sets[tsId] : undefined, tsId];
}

// Lua: collision.lua:59
function hostWorld(game: any): any {
  return game ? (game.overworld ?? game.world) : undefined;
}

// Lua: collision.lua:137
function isWarpBehavior(coll: number | null | undefined): boolean {
  if (coll == null) return false;
  return (coll >= 0x60 && coll <= 0x7F);
}

// pokefirered/src/field_control_avatar.c: a map-header warp event only fires
// when the metatile behavior is a live warp behavior. That is the arrow warps
// 0x62-0x65 (TryArrowWarp), the directional stair warps 0x6C-0x6F
// (IsDirectionalStairWarpMetatileBehavior), and everything IsWarpMetatileBehavior
// accepts: MB_CAVE_DOOR 0x60, MB_LADDER 0x61, MB_FALL_WARP 0x66,
// MB_REGULAR_WARP 0x67, MB_LAVARIDGE_1F_WARP 0x68, MB_WARP_DOOR 0x69,
// escalators 0x6A-0x6B, MB_UNION_ROOM_WARP 0x71. Together: 0x60-0x6F plus 0x71.
// pokeemerald/src/field_control_avatar.c:751
// Lua: collision.lua:150
const RSE_WARP = mbSet([
  "WATER_DOOR", "DEEP_SOUTH_WARP", "LAVARIDGE_GYM_B1F_WARP", "LAVARIDGE_GYM_1F_WARP",
  "AQUA_HIDEOUT_WARP", "MT_PYRE_HOLE", "MOSSDEEP_GYM_WARP", "BRIDGE_OVER_OCEAN",
  "WATER_SOUTH_ARROW_WARP", "SHOAL_CAVE_ENTRANCE", "STAIRS_OUTSIDE_ABANDONED_SHIP",
]);

// Index warps and force door/warp cells walkable. Extract can leave outdoor
// MB_WARP_DOOR tiles as solid when tileset attrs were read past EOF -- there the
// behavior is unknown (nil) and the repair still applies. A *readable* non-warp
// behavior means the cell is a real wall that merely happens to carry a (dead)
// warp event, e.g. PalletTown_PlayersHouse_1F (3,9): pret never lets the player
// stand on it, so opening it would let the player walk out through the wall.
// Lua: collision.lua:166
const COLL_DOOR = 0x71;

// pokefirered/include/constants/metatile_behaviors.h:39
// Lua: collision.lua:272
const MB_IMPASSABLE_EAST = 0x30;
const MB_IMPASSABLE_WEST = 0x31;
const MB_IMPASSABLE_NORTH = 0x32;
const MB_IMPASSABLE_SOUTH = 0x33;
const MB_IMPASSABLE_NORTHEAST = 0x34;
const MB_IMPASSABLE_NORTHWEST = 0x35;
const MB_IMPASSABLE_SOUTHEAST = 0x36;
const MB_IMPASSABLE_SOUTHWEST = 0x37;

// pokefirered/src/metatile_behavior.c:5 sBehaviorSurfable
// Lua: collision.lua:338
const SURFABLE_BEH: Record<number, boolean> = {
  [0x10]: true, [0x11]: true, [0x12]: true, [0x13]: true, [0x15]: true,
  [0x1A]: true, [0x1B]: true,
  [0x50]: true, [0x51]: true, [0x52]: true, [0x53]: true,
};

// pokefirered/include/constants/metatile_behaviors.h:17
// Lua: collision.lua:350
const MB_WATERFALL = 0x13;
// pokefirered/include/constants/metatile_behaviors.h:20
const MB_PUDDLE = 0x16;
const MB_SHALLOW_WATER = 0x17;
// pokefirered/include/constants/metatile_behaviors.h:27
const MB_STRENGTH_BUTTON = 0x20;
const MB_ICE = 0x23;
const MB_THIN_ICE = 0x26;
const MB_CRACKED_ICE = 0x27;
const MB_HOT_SPRINGS = 0x28;
// pokefirered/include/constants/metatile_behaviors.h:62
const MB_EASTWARD_CURRENT = 0x50;
const MB_WESTWARD_CURRENT = 0x51;
const MB_NORTHWARD_CURRENT = 0x52;
const MB_SOUTHWARD_CURRENT = 0x53;
const MB_SPIN_RIGHT = 0x54;
const MB_SPIN_LEFT = 0x55;
const MB_SPIN_UP = 0x56;
const MB_SPIN_DOWN = 0x57;
const MB_STOP_SPINNING = 0x58;
// pokefirered/include/constants/metatile_behaviors.h:52
const MB_WALK_EAST = 0x40;
const MB_WALK_WEST = 0x41;
const MB_WALK_NORTH = 0x42;
const MB_WALK_SOUTH = 0x43;
const MB_SLIDE_EAST = 0x44;
const MB_SLIDE_WEST = 0x45;
const MB_SLIDE_NORTH = 0x46;
const MB_SLIDE_SOUTH = 0x47;
const MB_TRICK_HOUSE_PUZZLE_8_FLOOR = 0x48;
// pokefirered/include/constants/metatile_behaviors.h:128
const MB_CYCLING_ROAD_PULL_DOWN = 0xD0;
const MB_CYCLING_ROAD_PULL_DOWN_GRASS = 0xD1;

// Lua: collision.lua:474
const MB_MUDDY_SLOPE = MB.require("MUDDY_SLOPE");
const MB_BUMPY_SLOPE = MB.require("BUMPY_SLOPE");
const MB_CRACKED_FLOOR = MB.require("CRACKED_FLOOR");
const MB_CRACKED_FLOOR_HOLE = MB.require("CRACKED_FLOOR_HOLE");
const MB_ISOLATED_VERTICAL_RAIL = MB.require("ISOLATED_VERTICAL_RAIL");
const MB_ISOLATED_HORIZONTAL_RAIL = MB.require("ISOLATED_HORIZONTAL_RAIL");
const MB_VERTICAL_RAIL = MB.require("VERTICAL_RAIL");
const MB_HORIZONTAL_RAIL = MB.require("HORIZONTAL_RAIL");
const MB_ASHGRASS = MB.require("ASHGRASS");
const MB_FORTREE_BRIDGE = MB.require("FORTREE_BRIDGE");
const MB_PACIFIDLOG_VERTICAL_LOG_TOP = MB.require("PACIFIDLOG_VERTICAL_LOG_TOP");
const MB_PACIFIDLOG_VERTICAL_LOG_BOTTOM = MB.require("PACIFIDLOG_VERTICAL_LOG_BOTTOM");
const MB_PACIFIDLOG_HORIZONTAL_LOG_LEFT = MB.require("PACIFIDLOG_HORIZONTAL_LOG_LEFT");
const MB_PACIFIDLOG_HORIZONTAL_LOG_RIGHT = MB.require("PACIFIDLOG_HORIZONTAL_LOG_RIGHT");
const MB_SECRET_BASE_JUMP_MAT = MB.require("SECRET_BASE_JUMP_MAT");
const MB_SECRET_BASE_SPIN_MAT = MB.require("SECRET_BASE_SPIN_MAT");

// pokefirered/include/constants/metatile_behaviors.h:72
// Lua: collision.lua:546
const MB_CAVE_DOOR = 0x60;
const MB_LADDER = 0x61;
const MB_EAST_ARROW_WARP = 0x62;
const MB_WEST_ARROW_WARP = 0x63;
const MB_NORTH_ARROW_WARP = 0x64;
const MB_SOUTH_ARROW_WARP = 0x65;
const MB_FALL_WARP = 0x66;
const MB_REGULAR_WARP = 0x67;
const MB_LAVARIDGE_1F_WARP = 0x68;
const MB_WARP_DOOR = 0x69;
// pokefirered/include/constants/metatile_behaviors.h:82
const MB_UP_ESCALATOR = 0x6A;
const MB_DOWN_ESCALATOR = 0x6B;
const MB_UP_RIGHT_STAIR_WARP = 0x6C;
const MB_UP_LEFT_STAIR_WARP = 0x6D;
const MB_DOWN_RIGHT_STAIR_WARP = 0x6E;
const MB_DOWN_LEFT_STAIR_WARP = 0x6F;
// pokefirered/include/constants/metatile_behaviors.h:89
const MB_UNION_ROOM_WARP = 0x71;

// pokeemerald/src/metatile_behavior.c:264
// Lua: collision.lua:567
const RSE_NON_ANIM_DOOR = mbSet(["WATER_DOOR", "DEEP_SOUTH_WARP"]);
const MB_DEEP_SOUTH_WARP = MB.require("DEEP_SOUTH_WARP");
const MB_LAVARIDGE_GYM_1F_WARP = MB.require("LAVARIDGE_GYM_1F_WARP");
const MB_LAVARIDGE_GYM_B1F_WARP = MB.require("LAVARIDGE_GYM_B1F_WARP");
const MB_AQUA_HIDEOUT_WARP = MB.require("AQUA_HIDEOUT_WARP");
const MB_MOSSDEEP_GYM_WARP = MB.require("MOSSDEEP_GYM_WARP");
const MB_MT_PYRE_HOLE = MB.require("MT_PYRE_HOLE");
const MB_BRIDGE_OVER_OCEAN = MB.require("BRIDGE_OVER_OCEAN");
const MB_PETALBURG_GYM_DOOR = MB.require("PETALBURG_GYM_DOOR");

// pokefirered/src/field_control_avatar.c:944
// Lua: collision.lua:616
const ARROW_WARP_DIR: Record<number, string> = {
  [MB_EAST_ARROW_WARP]: "right",
  [MB_WEST_ARROW_WARP]: "left",
  [MB_NORTH_ARROW_WARP]: "up",
  [MB_SOUTH_ARROW_WARP]: "down",
  // pokeemerald/src/metatile_behavior.c:306
  [MB.require("STAIRS_OUTSIDE_ABANDONED_SHIP")]: "up",
  // pokeemerald/src/metatile_behavior.c:315
  [MB.require("WATER_SOUTH_ARROW_WARP")]: "down",
  [MB.require("SHOAL_CAVE_ENTRANCE")]: "down",
};

// pokefirered/src/overworld.c:910
// Lua: collision.lua:676
const ARRIVAL_FACING: Record<number, string> = {
  [MB_CAVE_DOOR]: "down",
  [MB_WARP_DOOR]: "down",
  [MB_SOUTH_ARROW_WARP]: "up",
  [MB_NORTH_ARROW_WARP]: "down",
  [MB_WEST_ARROW_WARP]: "right",
  [MB_EAST_ARROW_WARP]: "left",
  [MB_UP_RIGHT_STAIR_WARP]: "left",
  [MB_DOWN_RIGHT_STAIR_WARP]: "left",
  [MB_UP_LEFT_STAIR_WARP]: "right",
  [MB_DOWN_LEFT_STAIR_WARP]: "right",
  // pokeemerald/src/overworld.c:933
  [MB_DEEP_SOUTH_WARP]: "up",
  [MB.require("WATER_DOOR")]: "down",
  [MB_PETALBURG_GYM_DOOR]: "down",
  [MB.require("WATER_SOUTH_ARROW_WARP")]: "up",
  [MB.require("SHOAL_CAVE_ENTRANCE")]: "up",
  [MB.require("STAIRS_OUTSIDE_ABANDONED_SHIP")]: "down",
};

// Player dirs <-> mapDef.connections keys (Dataset / pret use cardinal names).
// Lua: collision.lua:721
const DIR_CONN: Record<string, string> = {
  up: "north",
  down: "south",
  left: "west",
  right: "east",
};

// Lua: collision.lua:728 -- [w, h]
function mapCellSize(def: any): [number, number] {
  if (!def) return [0, 0];
  const L = def.midLayout;
  if (L && L.width != null && L.height != null) {
    return [L.width, L.height];
  }
  return [tonumber(def.width) ?? 0, tonumber(def.height) ?? 0];
}

// Lua: collision.lua:759
function collWalkable(coll: number | null | undefined): boolean {
  const P = permissions();
  // FRLG ledge metatiles carry map collision=1 (impassable). Extract encodes
  // hop facing as Gen2 0xA0-0xA7, which Permissions treats as LAND -- reject
  // them here so you cannot climb from below; only ledgeLanding may clear them.
  if (P && P.isLedge && P.isLedge(coll)) return false;
  if (P && P.isWalkable) return P.isWalkable(coll);
  return coll !== 0x07 && coll !== 0xff && coll !== 0x29;
}

// Lua: collision.lua:259
let worldMap: any;

export const Collision = {
  // Lua: collision.lua:29
  _grid: undefined as LuaTable | undefined, // 1-based flat COLL_* bytes, widthCells * heightCells
  _widthCells: 0,
  _heightCells: 0,
  _mapId: undefined as string | undefined,
  _mapDef: undefined as any,
  _warps: {} as Record<number, any>, // [cy*1024+cx] = warp def
  _logged: false,

  // Lua: collision.lua:65
  /** Expand mapDef blocks x tileset.collision into a per-cell COLL_* grid.
   *  Prefer native midLayout when present (already 16px COLL_* bytes). */
  bindMap(game: any, mapId: any, mapDef: any): boolean {
    Collision._grid = undefined;
    Collision._mapId = mapId;
    Collision._mapDef = mapDef;
    Collision._warps = {};
    Collision._widthCells = 0;
    Collision._heightCells = 0;

    if (mapDef && mapDef.midLayout) {
      const layout = mapDef.midLayout;
      Collision._grid = layout.collArray();
      Collision._widthCells = layout.width;
      Collision._heightCells = layout.height;
      Collision.installWarps(mapDef);
      if (!Collision._logged) {
        log(format("grid ready (native) map=%s cells=%dx%d warps=%d",
          tostring(mapId), layout.width, layout.height, len(mapDef.warps ?? {})));
        Collision._logged = true;
      }
      return true;
    }

    if (!mapDef || !isTable(mapDef.blocks)) {
      log("bindMap failed \xE2\x80\x94 no blocks for " + tostring(mapId));
      return false;
    }

    const tileset = resolveTileset(game, mapDef)[0];
    const collTbl = tileset ? tileset.collision : undefined;
    if (!collTbl) {
      log("bindMap failed \xE2\x80\x94 no tileset.collision for " + tostring(mapDef.tileset));
      return false;
    }

    const bw = mapDef.width ?? 0;
    const bh = mapDef.height ?? 0;
    const wc = bw * 2;
    const hc = bh * 2;
    const grid: LuaTable = [null];
    const border = mapDef.borderBlock ?? 0;

    for (let cy = 0; cy <= hc - 1; cy++) {
      for (let cx = 0; cx <= wc - 1; cx++) {
        const bx = Math.floor(cx / 2), by = Math.floor(cy / 2);
        let bid = border;
        if (bx >= 0 && by >= 0 && bx < bw && by < bh) {
          bid = mapDef.blocks[by * bw + bx + 1] ?? border;
        }
        const quad = collTbl[(bid ?? 0) + 1];
        const lx = mod(cx, 2), ly = mod(cy, 2);
        let byte = 0xff;
        if (isTable(quad)) {
          byte = quad[ly * 2 + lx + 1] ?? 0xff;
        }
        grid[cy * wc + cx + 1] = byte;
      }
    }

    Collision._grid = grid;
    Collision._widthCells = wc;
    Collision._heightCells = hc;

    Collision.installWarps(mapDef);

    if (!Collision._logged) {
      log(format("grid ready map=%s cells=%dx%d warps=%d",
        tostring(mapId), wc, hc, len(mapDef.warps ?? {})));
      Collision._logged = true;
    }
    return true;
  },

  // Lua: collision.lua:155
  isWarpMetatileBehavior(beh: Beh): boolean {
    if (beh == null) return false;
    return (beh >= 0x60 && beh <= 0x6F) || beh === 0x71 || RSE_WARP[beh] === true;
  },

  // Lua: collision.lua:167
  installWarps(mapDef: any): void {
    Collision._warps = Collision._warps ?? {};
    const layout = mapDef ? mapDef.midLayout : undefined;
    for (const [, w] of ipairs<any>(mapDef ? mapDef.warps : undefined)) {
      const x = tonumber(w.x), y = tonumber(w.y);
      if (x != null && y != null) {
        let cur: number | null | undefined = undefined;
        let beh: Beh;
        if (Collision._grid && Collision._widthCells > 0) {
          const i = y * Collision._widthCells + x + 1;
          cur = Collision._grid[i];
          beh = Collision.behavior(x, y);
          const repair = beh == null || Collision.isWarpMetatileBehavior(beh);
          // pokefirered/src/field_control_avatar.c:860
          if (beh != null && repair && cur === 0x00) {
            const seeded = ScriptColl.fromCell((layout ? layout.midAt(x, y) : undefined) ?? 0, 0, beh, mapDef.kind)[0];
            if (isWarpBehavior(seeded)) {
              Collision._grid[i] = seeded;
              cur = seeded;
            }
          } else if (repair && (cur == null || cur === 0x07 || cur === 0xff)) {
            Collision._grid[i] = COLL_DOOR;
            cur = COLL_DOOR;
            if (layout && layout.applyOverride) {
              const mid = layout.midAt ? layout.midAt(x, y) : undefined;
              const elev = layout.elevAt ? layout.elevAt(x, y) : undefined;
              layout.applyOverride(x, y, mid, COLL_DOOR, elev);
            }
          }
        }
        // In pret, a warp in map header is only active if the metatile behavior is a warp behavior
        // pokeemerald/src/field_control_avatar.c:751
        if (isWarpBehavior(cur) || (beh != null && RSE_WARP[beh] === true)) {
          Collision._warps[y * 1024 + x] = w;
        }
      }
    }
  },

  // Lua: collision.lua:212
  /** Patch one cell of the bound native grid after a metatile write (what a
   *  full bindMap would rebuild for it) without re-deriving the whole map.
   *  Returns false when the caller must bindMap instead: another map is bound,
   *  the cell is off the grid, or a warp sits on it (installWarps derives warp
   *  activity and door repairs from the cell). */
  patchCell(mapId: any, mapDef: any, xIn: unknown, yIn: unknown): boolean {
    if (!(Collision._grid && mapDef && mapDef.midLayout)) return false;
    if (Collision._mapId !== mapId || Collision._mapDef !== mapDef) return false;
    const layout = mapDef.midLayout;
    const x = tonumber(xIn), y = tonumber(yIn);
    if (!(x != null && y != null) || x !== Math.floor(x) || y !== Math.floor(y)) return false;
    const w = Collision._widthCells, h = Collision._heightCells;
    if (w !== layout.width || h !== layout.height) return false;
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    if (x >= (layout.trueWidth ?? w) || y >= (layout.trueHeight ?? h)) return false;
    for (const [, warp] of ipairs<any>(mapDef.warps)) {
      if (tonumber(warp.x) === x && tonumber(warp.y) === y) return false;
    }
    // same value LayoutNative:collArray yields for this cell
    const ov = layout.overrides ? layout.overrides[y * 1024 + x] : undefined;
    const c = layout.cells ? layout.cells[y * w + x + 1] : undefined;
    Collision._grid[y * w + x + 1] = (ov ? ov.coll : undefined) ?? (c ? c.coll : undefined) ?? 0xff;
    return true;
  },

  // Lua: collision.lua:232
  clear(): void {
    Collision._grid = undefined;
    Collision._mapId = undefined;
    Collision._mapDef = undefined;
    Collision._warps = {};
    Collision._widthCells = 0;
    Collision._heightCells = 0;
  },

  // Lua: collision.lua:241
  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0
      && cx < Collision._widthCells && cy < Collision._heightCells;
  },

  // Lua: collision.lua:247
  /** Preserve original MB semantics independently of the walkability COLL grid. */
  behaviorOn(mapDef: any, cx: number, cy: number): Beh {
    const layout = mapDef ? mapDef.midLayout : undefined;
    if (!layout || cx < 0 || cy < 0 || cx >= layout.width || cy >= layout.height) return undefined;
    const pair = mapDef.pair ?? layout.pair;
    const behaviors = (InteractionScripts.behaviors as Record<string, any>)[pair];
    return behaviors ? behaviors[layout.midAt(cx, cy)] : undefined;
  },

  // Lua: collision.lua:255
  behavior(cx: number, cy: number): Beh {
    return Collision.behaviorOn(Collision._mapDef, cx, cy);
  },

  // Lua: collision.lua:262 -- pokefirered/src/fieldmap.c:129
  worldBehavior(cx: number, cy: number): Beh {
    const def = Collision._mapDef;
    if (!(def && def.midLayout)) return undefined;
    worldMap = worldMap ?? MapMod;
    const [mid, pair] = worldMap.worldMidAt(cx, cy, def);
    const behaviors = (InteractionScripts.behaviors as Record<string, any>)[pair];
    return behaviors ? behaviors[mid] : undefined;
  },

  // Lua: collision.lua:282 -- pokefirered/src/metatile_behavior.c:546
  isEastBlocked(beh: Beh): boolean {
    return beh === MB_IMPASSABLE_EAST || beh === MB_IMPASSABLE_NORTHEAST
      || beh === MB_IMPASSABLE_SOUTHEAST;
  },

  // Lua: collision.lua:288 -- pokefirered/src/metatile_behavior.c:556
  isWestBlocked(beh: Beh): boolean {
    return beh === MB_IMPASSABLE_WEST || beh === MB_IMPASSABLE_NORTHWEST
      || beh === MB_IMPASSABLE_SOUTHWEST;
  },

  // Lua: collision.lua:294 -- pokefirered/src/metatile_behavior.c:566
  isNorthBlocked(beh: Beh): boolean {
    return beh === MB_IMPASSABLE_NORTH || beh === MB_IMPASSABLE_NORTHEAST
      || beh === MB_IMPASSABLE_NORTHWEST;
  },

  // Lua: collision.lua:300 -- pokefirered/src/metatile_behavior.c:576
  isSouthBlocked(beh: Beh): boolean {
    return beh === MB_IMPASSABLE_SOUTH || beh === MB_IMPASSABLE_SOUTHEAST
      || beh === MB_IMPASSABLE_SOUTHWEST;
  },

  // Lua: collision.lua:321 -- pokefirered/src/event_object_movement.c:4889 IsMetatileDirectionallyImpassable
  directionallyImpassableOn(mapDef: any, fromX: number | null | undefined, fromY: number | null | undefined,
    tx: number, ty: number, dir: string | null | undefined): boolean {
    const leave = dir != null ? LEAVE_BLOCKED[dir] : undefined;
    if (!leave) return false;
    if (fromX != null && fromY != null && leave(Collision.behaviorOn(mapDef, fromX, fromY))) {
      return true;
    }
    return ENTER_BLOCKED[dir!]!(Collision.behaviorOn(mapDef, tx, ty)) === true;
  },

  // Lua: collision.lua:330
  directionallyImpassable(fromX: number | null | undefined, fromY: number | null | undefined,
    tx: number, ty: number, dir: string | null | undefined): boolean {
    const leave = dir != null ? LEAVE_BLOCKED[dir] : undefined;
    if (!leave) return false;
    if (fromX != null && fromY != null && leave(Collision.behavior(fromX, fromY))) return true;
    return ENTER_BLOCKED[dir!]!(Collision.behavior(tx, ty)) === true;
  },

  // Lua: collision.lua:345 -- pokefirered/src/metatile_behavior.c:204
  isSurfable(beh: Beh): boolean {
    return beh != null && SURFABLE_BEH[beh] === true;
  },

  // Lua: collision.lua:385 -- pokefirered/src/metatile_behavior.c:846
  isStrengthButton(beh: Beh): boolean { return beh === MB_STRENGTH_BUTTON; },

  // Lua: collision.lua:388 -- pokefirered/src/metatile_behavior.c:102
  isIce(beh: Beh): boolean { return beh === MB_ICE; },

  // Lua: collision.lua:391 -- pokefirered/src/metatile_behavior.c:502
  isThinIce(beh: Beh): boolean { return beh === MB_THIN_ICE; },

  // Lua: collision.lua:394 -- pokefirered/src/metatile_behavior.c:510
  isCrackedIce(beh: Beh): boolean { return beh === MB_CRACKED_ICE; },

  // Lua: collision.lua:397 -- pokefirered/src/metatile_behavior.c:586
  isHotSprings(beh: Beh): boolean { return beh === MB_HOT_SPRINGS; },

  // Lua: collision.lua:400 -- pokefirered/src/metatile_behavior.c:350
  isEastwardCurrent(beh: Beh): boolean { return beh === MB_EASTWARD_CURRENT; },

  // Lua: collision.lua:403 -- pokefirered/src/metatile_behavior.c:342
  isWestwardCurrent(beh: Beh): boolean { return beh === MB_WESTWARD_CURRENT; },

  // Lua: collision.lua:406 -- pokefirered/src/metatile_behavior.c:326
  isNorthwardCurrent(beh: Beh): boolean { return beh === MB_NORTHWARD_CURRENT; },

  // Lua: collision.lua:409 -- pokefirered/src/metatile_behavior.c:334
  isSouthwardCurrent(beh: Beh): boolean { return beh === MB_SOUTHWARD_CURRENT; },

  // Lua: collision.lua:412 -- pokefirered/src/metatile_behavior.c:754
  isSpinRight(beh: Beh): boolean { return beh === MB_SPIN_RIGHT; },

  // Lua: collision.lua:415 -- pokefirered/src/metatile_behavior.c:762
  isSpinLeft(beh: Beh): boolean { return beh === MB_SPIN_LEFT; },

  // Lua: collision.lua:418 -- pokefirered/src/metatile_behavior.c:770
  isSpinUp(beh: Beh): boolean { return beh === MB_SPIN_UP; },

  // Lua: collision.lua:421 -- pokefirered/src/metatile_behavior.c:778
  isSpinDown(beh: Beh): boolean { return beh === MB_SPIN_DOWN; },

  // Lua: collision.lua:424 -- pokefirered/src/metatile_behavior.c:786
  isStopSpinning(beh: Beh): boolean { return beh === MB_STOP_SPINNING; },

  // Lua: collision.lua:427 -- pokefirered/src/metatile_behavior.c:794
  isSpinTile(beh: Beh): boolean {
    return beh != null && beh >= MB_SPIN_RIGHT && beh <= MB_SPIN_DOWN;
  },

  // Lua: collision.lua:432 -- pokefirered/src/metatile_behavior.c:668
  isCyclingRoadPullDown(beh: Beh): boolean {
    return beh != null && beh >= MB_CYCLING_ROAD_PULL_DOWN
      && beh <= MB_CYCLING_ROAD_PULL_DOWN_GRASS;
  },

  // Lua: collision.lua:438 -- pokefirered/src/metatile_behavior.c:676
  isCyclingRoadPullDownGrass(beh: Beh): boolean {
    return beh === MB_CYCLING_ROAD_PULL_DOWN_GRASS;
  },

  // Lua: collision.lua:443 -- pokefirered/src/metatile_behavior.c:318
  isWalkEast(beh: Beh): boolean { return beh === MB_WALK_EAST; },

  // Lua: collision.lua:446 -- pokefirered/src/metatile_behavior.c:310
  isWalkWest(beh: Beh): boolean { return beh === MB_WALK_WEST; },

  // Lua: collision.lua:449 -- pokefirered/src/metatile_behavior.c:294
  isWalkNorth(beh: Beh): boolean { return beh === MB_WALK_NORTH; },

  // Lua: collision.lua:452 -- pokefirered/src/metatile_behavior.c:302
  isWalkSouth(beh: Beh): boolean { return beh === MB_WALK_SOUTH; },

  // Lua: collision.lua:455 -- pokefirered/src/metatile_behavior.c:382
  isSlideEast(beh: Beh): boolean { return beh === MB_SLIDE_EAST; },

  // Lua: collision.lua:458 -- pokefirered/src/metatile_behavior.c:374
  isSlideWest(beh: Beh): boolean { return beh === MB_SLIDE_WEST; },

  // Lua: collision.lua:461 -- pokefirered/src/metatile_behavior.c:358
  isSlideNorth(beh: Beh): boolean { return beh === MB_SLIDE_NORTH; },

  // Lua: collision.lua:464 -- pokefirered/src/metatile_behavior.c:366
  isSlideSouth(beh: Beh): boolean { return beh === MB_SLIDE_SOUTH; },

  // Lua: collision.lua:467 -- pokefirered/src/metatile_behavior.c:286
  isTrickHouseSlipperyFloor(beh: Beh): boolean {
    return beh === MB_TRICK_HOUSE_PUZZLE_8_FLOOR;
  },

  // Lua: collision.lua:472 -- pokefirered/src/metatile_behavior.c:594
  isWaterfall(beh: Beh): boolean { return beh === MB_WATERFALL; },

  // Lua: collision.lua:492 -- pokeemerald/src/metatile_behavior.c:1202
  isMuddySlope(beh: Beh): boolean { return beh === MB_MUDDY_SLOPE; },

  // Lua: collision.lua:495 -- pokeemerald/src/metatile_behavior.c:1210
  isBumpySlope(beh: Beh): boolean { return beh === MB_BUMPY_SLOPE; },

  // Lua: collision.lua:498 -- pokeemerald/src/metatile_behavior.c:1194
  isCrackedFloor(beh: Beh): boolean { return beh === MB_CRACKED_FLOOR; },

  // Lua: collision.lua:501 -- pokeemerald/src/metatile_behavior.c:1186
  isCrackedFloorHole(beh: Beh): boolean { return beh === MB_CRACKED_FLOOR_HOLE; },

  // Lua: collision.lua:504 -- pokeemerald/src/metatile_behavior.c:1218
  isIsolatedVerticalRail(beh: Beh): boolean { return beh === MB_ISOLATED_VERTICAL_RAIL; },

  // Lua: collision.lua:507 -- pokeemerald/src/metatile_behavior.c:1226
  isIsolatedHorizontalRail(beh: Beh): boolean { return beh === MB_ISOLATED_HORIZONTAL_RAIL; },

  // Lua: collision.lua:510 -- pokeemerald/src/metatile_behavior.c:1234
  isVerticalRail(beh: Beh): boolean { return beh === MB_VERTICAL_RAIL; },

  // Lua: collision.lua:513 -- pokeemerald/src/metatile_behavior.c:1242
  isHorizontalRail(beh: Beh): boolean { return beh === MB_HORIZONTAL_RAIL; },

  // Lua: collision.lua:516 -- pokeemerald/src/metatile_behavior.c:753
  isAshGrass(beh: Beh): boolean { return beh === MB_ASHGRASS; },

  // Lua: collision.lua:519 -- pokeemerald/src/metatile_behavior.c:1003
  isFortreeBridge(beh: Beh): boolean { return beh === MB_FORTREE_BRIDGE; },

  // Lua: collision.lua:522 -- pokeemerald/src/metatile_behavior.c:1011
  isPacifidlogVerticalLogTop(beh: Beh): boolean { return beh === MB_PACIFIDLOG_VERTICAL_LOG_TOP; },

  // Lua: collision.lua:525 -- pokeemerald/src/metatile_behavior.c:1019
  isPacifidlogVerticalLogBottom(beh: Beh): boolean { return beh === MB_PACIFIDLOG_VERTICAL_LOG_BOTTOM; },

  // Lua: collision.lua:528 -- pokeemerald/src/metatile_behavior.c:1027
  isPacifidlogHorizontalLogLeft(beh: Beh): boolean { return beh === MB_PACIFIDLOG_HORIZONTAL_LOG_LEFT; },

  // Lua: collision.lua:531 -- pokeemerald/src/metatile_behavior.c:1035
  isPacifidlogHorizontalLogRight(beh: Beh): boolean { return beh === MB_PACIFIDLOG_HORIZONTAL_LOG_RIGHT; },

  // Lua: collision.lua:534 -- pokeemerald/src/metatile_behavior.c:1043
  isPacifidlogLog(beh: Beh): boolean {
    return beh === MB_PACIFIDLOG_VERTICAL_LOG_TOP || beh === MB_PACIFIDLOG_VERTICAL_LOG_BOTTOM
      || beh === MB_PACIFIDLOG_HORIZONTAL_LOG_LEFT || beh === MB_PACIFIDLOG_HORIZONTAL_LOG_RIGHT;
  },

  // Lua: collision.lua:540 -- pokeemerald/src/metatile_behavior.c:1102
  isSecretBaseJumpMat(beh: Beh): boolean { return beh === MB_SECRET_BASE_JUMP_MAT; },

  // Lua: collision.lua:543 -- pokeemerald/src/metatile_behavior.c:1110
  isSecretBaseSpinMat(beh: Beh): boolean { return beh === MB_SECRET_BASE_SPIN_MAT; },

  // Lua: collision.lua:578 -- pokefirered/src/metatile_behavior.c:110
  isWarpDoor(beh: Beh): boolean { return beh === MB_WARP_DOOR; },

  // Lua: collision.lua:581 -- pokefirered/src/metatile_behavior.c:186
  isLadder(beh: Beh): boolean { return beh === MB_LADDER; },

  // Lua: collision.lua:584 -- pokefirered/src/metatile_behavior.c:194
  isNonAnimDoor(beh: Beh): boolean {
    return beh === MB_CAVE_DOOR || (beh != null && RSE_NON_ANIM_DOOR[beh] === true);
  },

  // Lua: collision.lua:587 -- pokeemerald/src/metatile_behavior.c:274
  isDeepSouthWarp(beh: Beh): boolean { return beh === MB_DEEP_SOUTH_WARP; },

  // Lua: collision.lua:590 -- pokefirered/src/metatile_behavior.c:624
  isLavaridge1FWarp(beh: Beh): boolean { return beh === MB_LAVARIDGE_1F_WARP || beh === MB_LAVARIDGE_GYM_1F_WARP; },

  // Lua: collision.lua:593 -- pokeemerald/src/metatile_behavior.c:1120
  isLavaridgeB1FWarp(beh: Beh): boolean { return beh === MB_LAVARIDGE_GYM_B1F_WARP; },

  // Lua: collision.lua:596 -- pokeemerald/src/metatile_behavior.c:1155
  isMossdeepGymWarp(beh: Beh): boolean { return beh === MB_MOSSDEEP_GYM_WARP; },

  // Lua: collision.lua:599 -- pokeemerald/src/metatile_behavior.c:1180
  isMtPyreHole(beh: Beh): boolean { return beh === MB_MT_PYRE_HOLE; },

  // Lua: collision.lua:602 -- pokefirered/src/metatile_behavior.c:632
  isWarpPad(beh: Beh): boolean { return beh === MB_REGULAR_WARP || beh === MB_AQUA_HIDEOUT_WARP; },

  // Lua: collision.lua:605 -- pokefirered/src/metatile_behavior.c:640
  isUnionRoomWarp(beh: Beh): boolean { return beh === MB_UNION_ROOM_WARP || beh === MB_BRIDGE_OVER_OCEAN; },

  // Lua: collision.lua:608 -- pokefirered/src/metatile_behavior.c:658
  isFallWarp(beh: Beh): boolean { return beh === MB_FALL_WARP; },

  // Lua: collision.lua:611 -- pokefirered/src/metatile_behavior.c:126
  isEscalator(beh: Beh): boolean {
    return beh === MB_UP_ESCALATOR || beh === MB_DOWN_ESCALATOR;
  },

  // Lua: collision.lua:629 -- pokefirered/src/metatile_behavior.c:253
  isArrowWarpBehavior(beh: Beh): boolean {
    return beh != null && ARROW_WARP_DIR[beh] != null;
  },

  // Lua: collision.lua:634 -- pokefirered/src/field_control_avatar.c:944
  arrowWarpDir(beh: Beh): string | undefined { return beh != null ? ARROW_WARP_DIR[beh] : undefined; },

  // Lua: collision.lua:637 -- pokefirered/src/field_control_avatar.c:901
  isStepWarpBehavior(beh: Beh): boolean {
    if (beh == null) return false;
    return Collision.isWarpDoor(beh) || Collision.isLadder(beh)
      || Collision.isEscalator(beh) || Collision.isNonAnimDoor(beh)
      || Collision.isLavaridge1FWarp(beh) || Collision.isWarpPad(beh)
      || Collision.isFallWarp(beh) || Collision.isUnionRoomWarp(beh)
      || Collision.isLavaridgeB1FWarp(beh) || Collision.isMossdeepGymWarp(beh)
      || Collision.isMtPyreHole(beh);
  },

  // Lua: collision.lua:648 -- pokefirered/src/metatile_behavior.c:174
  isStairWarpBehavior(beh: Beh): boolean {
    return beh === MB_UP_RIGHT_STAIR_WARP || beh === MB_UP_LEFT_STAIR_WARP
      || beh === MB_DOWN_RIGHT_STAIR_WARP || beh === MB_DOWN_LEFT_STAIR_WARP;
  },

  // Lua: collision.lua:654 -- pokefirered/src/field_control_avatar.c:924
  stairWarpDir(beh: Beh): string | undefined {
    if (beh === MB_UP_LEFT_STAIR_WARP || beh === MB_DOWN_LEFT_STAIR_WARP) {
      return "left";
    }
    if (beh === MB_UP_RIGHT_STAIR_WARP || beh === MB_DOWN_RIGHT_STAIR_WARP) {
      return "right";
    }
    return undefined;
  },

  // Lua: collision.lua:665 -- pokefirered/src/overworld.c:921
  stairArrivalFacing(beh: Beh): string | undefined {
    if (beh === MB_UP_RIGHT_STAIR_WARP || beh === MB_DOWN_RIGHT_STAIR_WARP) {
      return "left";
    }
    if (beh === MB_UP_LEFT_STAIR_WARP || beh === MB_DOWN_LEFT_STAIR_WARP) {
      return "right";
    }
    return undefined;
  },

  // Lua: collision.lua:696
  arrivalFacing(destBeh: Beh, storedDir?: string | null): string {
    const f = destBeh != null ? ARRIVAL_FACING[destBeh] : undefined;
    if (f) return f;
    // pokefirered/src/overworld.c:933
    if (destBeh === MB_LADDER) return storedDir ?? "down";
    return "down";
  },

  // Lua: collision.lua:705 -- pokefirered/src/field_fadetransition.c:866; [dx, dy]
  stairSpeeds(beh: Beh): [number, number] {
    if (beh === MB_UP_RIGHT_STAIR_WARP) return [16, -10];
    if (beh === MB_UP_LEFT_STAIR_WARP) return [-17, -10];
    if (beh === MB_DOWN_RIGHT_STAIR_WARP) return [17, 3];
    if (beh === MB_DOWN_LEFT_STAIR_WARP) return [-17, 3];
    return [0, 0];
  },

  // Lua: collision.lua:713
  cell(cx: number, cy: number): number {
    if (!Collision._grid || !Collision.inBounds(cx, cy)) {
      return 0xff;
    }
    return Collision._grid[cy * Collision._widthCells + cx + 1] ?? 0xff;
  },

  // Lua: collision.lua:738
  /** Landing cell on dest after stepping off `dir` edge (FRLG metatile = one cell). [x, y] or []. */
  connectionLanding(destDef: any, conn: any, dir: string, fromCx: number, fromCy: number): [number?, number?] {
    if (!(destDef && conn)) return [];
    const [destW, destH] = mapCellSize(destDef);
    if (destW < 1 || destH < 1) return [];
    const offset = tonumber(conn.offset) ?? 0;
    let x: number, y: number;
    if (dir === "up") {
      x = fromCx - offset; y = destH - 1;
    } else if (dir === "down") {
      x = fromCx - offset; y = 0;
    } else if (dir === "left") {
      x = destW - 1; y = fromCy - offset;
    } else if (dir === "right") {
      x = 0; y = fromCy - offset;
    } else {
      return [];
    }
    if (x < 0 || y < 0 || x >= destW || y >= destH) return [];
    return [x, y];
  },

  // Lua: collision.lua:772
  /** Outdoor edge transition (Pallet<->Route 1). Seamless remap mid-step like
   *  pret CameraMove -> LoadMapFromCameraTransition / Gen2 World:tryConnection.
   *  Returns true if the crossing was accepted. */
  tryConnection(game: any, fromX: number, fromY: number, dir: string, run?: boolean): boolean {
    const d = DELTA[dir];
    if (!d) return false;
    const Space: any = SpaceMod; // package.loaded["src.core.game3.scripting.space"]
    if (Space && Space.vm && Space.vm.isRunning && Space.vm.isRunning()) {
      return false;
    }
    const WarpM: any = WarpMod; // package.loaded["src.core.game3.warp"]
    if (WarpM && WarpM.isBusy && WarpM.isBusy()) {
      return false;
    }

    const mapDef = Collision._mapDef;
    if (!mapDef || !isTable(mapDef.connections)) return false;
    const data = game && game.data ? game.data.maps : undefined;
    if (!data) return false;
    const Map: any = MapMod;
    // pokefirered/src/fieldmap.c:673
    const [conn, destDef] = Connections.incoming(mapDef, DIR_CONN[dir], fromX, fromY, (id: string) => {
      const def = data[id];
      if (def && Map.ensureMidLayout) Map.ensureMidLayout(game, id, def);
      return def;
    });
    if (!conn) return false;
    const destMap = conn.map;

    const [lx, ly] = Collision.connectionLanding(destDef, conn, dir, fromX, fromY);
    if (lx == null || ly == null) return false;

    const Player: any = PlayerMod;
    const L = destDef.midLayout;
    const landingWater = Collision.isWaterOn(destDef, lx, ly);
    if (L && L.collAt) {
      const coll = L.collAt(lx, ly);
      const P = permissions();
      if (!collWalkable(coll) && !(P && P.isWater && P.isWater(coll))) {
        return false;
      }
      if (landingWater && !Player.surfing) return false;
    }
    // pokefirered/src/event_object_movement.c:4889
    if (LEAVE_BLOCKED[dir]!(Collision.behaviorOn(mapDef, fromX, fromY))
        || ENTER_BLOCKED[dir]!(Collision.behaviorOn(destDef, lx, ly))) {
      return false;
    }
    if (Player.surfing && L && L.elevAt) {
      const elevation = L.elevAt(lx, ly);
      // pokefirered/src/field_player_avatar.c:597
      if (!landingWater) {
        if (elevation !== 3) return false;
      // pokefirered/src/event_object_movement.c:8346
      } else if (elevation !== 0 && elevation !== 15 && Player.elevation !== 0
          && elevation !== Player.elevation) {
        return false;
      }
    }
    const Ghosts: any = GhostsMod;
    if (truthy(Ghosts.blocksOn(destMap, destDef, lx, ly))) return false;

    const Runtime: any = RuntimeMod; // package.loaded["src.core.game3.runtime"]
    const modv = Runtime ? Runtime._mod : undefined;
    const g = game || (Runtime ? Runtime._game : undefined);

    Map.load(modv, g, destMap, {
      x: lx,
      y: ly,
      facing: dir,
      seamless: true,
      depth1Connections: true,
    });

    // Park one cell before landing and keep the step running so the seam does
    // not hitch (same world pixels the neighbor strip already showed).
    const CELL = 16;
    const WALK_FRAMES = 16;
    const RUN_FRAMES = 8;
    Player.cellX = lx - d[1]; Player.cellY = ly - d[2];
    Player.px = Player.cellX * CELL; Player.py = Player.cellY * CELL;
    Player.facing = dir;
    Player.targetX = lx; Player.targetY = ly;
    Player.moving = true;
    Player.progress = 0;
    Player.animClock = 0;
    Player.running = run ? true : false;
    Player.jumping = false;
    Player.dismounting = (Player.surfing && !landingWater) || false;
    if (Player.dismounting) (AudioMod as any).stopSurfMusic();
    Player.spriteYOffset = 0;
    Player.stepFrames = run ? RUN_FRAMES : WALK_FRAMES;
    Player.syncSavePosition(g);

    if (Collision.isGrass && Collision.isGrass(lx, ly)) {
      // pcall(lazyReq, "src.core.game3.field_effects"): a static import
      const FieldEffects: any = FieldEffectsMod;
      if (FieldEffects && FieldEffects.tallGrassAt) {
        FieldEffects.tallGrassAt(lx, ly, false);
      }
    }

    return true;
  },

  // Lua: collision.lua:874 -- pokeemerald/src/fieldmap.c:603 CameraMove; [lx, ly] or []
  scriptConnection(game: any, fromX: number, fromY: number, dir: string): [number?, number?] {
    const d = DELTA[dir];
    const mapDef = Collision._mapDef;
    if (!d || !mapDef || !isTable(mapDef.connections)) return [];
    const Runtime: any = RuntimeMod; // package.loaded["src.core.game3.runtime"]
    game = game || (Runtime ? Runtime._game : undefined);
    const data = game && game.data ? game.data.maps : undefined;
    if (!data) return [];
    const Map: any = MapMod;
    const [conn, destDef] = Connections.incoming(mapDef, DIR_CONN[dir], fromX, fromY, (id: string) => {
      const def = data[id];
      if (def && Map.ensureMidLayout) Map.ensureMidLayout(game, id, def);
      return def;
    });
    if (!conn) return [];
    const [lx, ly] = Collision.connectionLanding(destDef, conn, dir, fromX, fromY);
    if (lx == null || ly == null) return [];
    const dx = lx - (fromX + d[1]), dy = ly - (fromY + d[2]);
    const Objects: any = ObjectsMod;
    const carry = Objects.carryOut(dx, dy);
    const Player: any = PlayerMod;
    const facing = Player.facing;
    Map.load(Runtime ? Runtime._mod : undefined, game, conn.map, {
      x: lx, y: ly, facing, seamless: true, depth1Connections: true, keepScript: true, carry,
    });
    Player.cellX = lx - d[1]; Player.cellY = ly - d[2];
    Player.px = Player.cellX * 16; Player.py = Player.cellY * 16;
    Player.targetX = Player.cellX; Player.targetY = Player.cellY;
    Player.facing = facing;
    return [lx, ly];
  },

  // Lua: collision.lua:906
  isWalkable(cx: number, cy: number): boolean {
    const P = permissions();
    const coll = Collision.cell(cx, cy);
    if (P && P.isLedge && P.isLedge(coll)) {
      return false;
    }
    if (P && P.isWalkable) {
      return P.isWalkable(coll);
    }
    // Fallback: treat 0x07 / 0xff as solid, water 0x29 as solid on foot.
    return coll !== 0x07 && coll !== 0xff && coll !== 0x29;
  },

  // Lua: collision.lua:919
  isGrass(cx: number, cy: number): boolean {
    const P = permissions();
    const coll = Collision.cell(cx, cy);
    if (P && P.isGrass) return P.isGrass(coll);
    return coll === 0x18 || coll === 0x14;
  },

  // Lua: collision.lua:927 -- pokefirered/src/event_object_movement.c:8346 IsElevationMismatchAt
  elevationOn(mapDef: any, cx: number | null | undefined, cy: number | null | undefined): number | undefined {
    const layout = mapDef ? mapDef.midLayout : undefined;
    if (!(layout && layout.elevAt) || cx == null || cy == null) return undefined;
    if (cx < 0 || cy < 0 || cx >= layout.width || cy >= layout.height) return undefined;
    return layout.elevAt(cx, cy);
  },

  // Lua: collision.lua:934
  elevationAt(cx: number, cy: number): number | undefined {
    return Collision.elevationOn(Collision._mapDef, cx, cy);
  },

  // Lua: collision.lua:939 -- pokefirered/src/event_object_movement.c:8346
  elevationMismatchOn(mapDef: any, elevation: number | null | undefined, cx: number, cy: number): boolean {
    if (elevation == null || elevation === 0) return false;
    const m = Collision.elevationOn(mapDef, cx, cy);
    if (m == null || m === 0 || m === 15) return false;
    return m !== elevation;
  },

  // Lua: collision.lua:947 -- pokefirered/src/event_object_movement.c:8400; [elevation, committed]
  nextElevation(mapDef: any, current: number | undefined, curX: number, curY: number,
    prevX: number | null | undefined, prevY: number | null | undefined): [number | undefined, number | undefined] {
    const cur = Collision.elevationOn(mapDef, curX, curY);
    const prev = Collision.elevationOn(mapDef, prevX, prevY);
    if (cur == null || cur === 15 || prev === 15) return [current, undefined];
    return [cur, (cur !== 0) ? cur : undefined];
  },

  // Lua: collision.lua:955 -- pokefirered/src/field_player_avatar.c:597 CanStopSurfing
  isWaterOn(mapDef: any, cx: number, cy: number, coll?: number | null): boolean {
    const layout = mapDef ? mapDef.midLayout : undefined;
    if (layout && (cx < 0 || cy < 0 || cx >= layout.width || cy >= layout.height)) {
      return false;
    }
    if (coll == null) {
      if (!layout) return false;
      coll = layout.collAt(cx, cy) as number;
    }
    const P = permissions();
    if (P && P.isWater) {
      if (P.isWater(coll)) return true;
    } else if (coll === 0x29) {
      return true;
    }
    if (!(layout && layout.elevAt) || layout.elevAt(cx, cy) !== 1) return false;
    const beh = Collision.behaviorOn(mapDef, cx, cy);
    return beh === MB_PUDDLE || beh === MB_SHALLOW_WATER;
  },

  // Lua: collision.lua:975
  isWater(cx: number, cy: number): boolean {
    return Collision.isWaterOn(Collision._mapDef, cx, cy, Collision.cell(cx, cy));
  },

  // Lua: collision.lua:981 -- pokeemerald/src/field_player_avatar.c:693, pokefirered/src/field_player_avatar.c:568
  isSurfDismount(cx: number, cy: number, elevation: number | null | undefined): boolean {
    return Collision.elevationAt(cx, cy) === 3
      && Collision.elevationMismatchOn(Collision._mapDef, elevation, cx, cy);
  },

  // Lua: collision.lua:987 -- pokeemerald/src/rotating_gate.c:961
  rotatingGateCollision(_game: any, dir: string, x: number, y: number): boolean {
    // package.loaded["src.core.game3.rotating_gate"]: no such module in the port
    const RG: any = undefined;
    return RG != null && RG.active() && RG.checkCollision(dir, x, y) === true;
  },

  // Lua: collision.lua:1027
  /** Can the avatar enter cell (tx, ty) on foot?
   *  Returns [ok, reason] ("bounds"|"tile"|"elevation"|"entity"|"water"|undefined). */
  canEnter(game: any, tx: number, ty: number, opts?: CanEnterOpts | null): [boolean, string | undefined] {
    opts = opts || {};
    let surfing: boolean | undefined = opts.surfing;
    if (surfing == null) {
      const P: any = PlayerMod; // package.loaded["src.core.game3.player"]
      surfing = P ? P.surfing === true : undefined;
    }

    if (Collision._grid && Collision._grid[1] != null) {
      if (!Collision.inBounds(tx, ty)) return [false, "bounds"];
      if (overrideBlocks(tx, ty)) return [false, "tile"];
      // pokefirered/src/event_object_movement.c:4835 GetCollisionAtCoords
      if (Collision.directionallyImpassable(opts.fromX, opts.fromY, tx, ty, opts.dir)) {
        return [false, "tile"];
      }
      // pokefirered/src/event_object_movement.c:4839
      const mismatch = Collision.elevationMismatchOn(Collision._mapDef, opts.elevation, tx, ty);
      if (mismatch && !surfing) return [false, "elevation"];
      const isW = Collision.isWater(tx, ty);
      let entElevation = opts.elevation;
      if (mismatch) {
        if (isW) return [false, "elevation"];
        if (!Collision.isWalkable(tx, ty)) return [false, "tile"];
        // pokefirered/src/field_player_avatar.c:597
        if (Collision.elevationAt(tx, ty) !== 3) return [false, "elevation"];
        entElevation = 3;
      }
      if (entityBlocks(game, tx, ty, entElevation)) return [false, "entity"];
      if (surfing) {
        if (isW) {
          return [true, undefined];
        } else {
          // Dismount onto land: verify land tile is walkable
          if (!Collision.isWalkable(tx, ty)) return [false, "tile"];
          return [true, undefined];
        }
      } else {
        if (isW) return [false, "water"];
        if (!Collision.isWalkable(tx, ty)) return [false, "tile"];
        return [true, undefined];
      }
    }

    const world = hostWorld(game);
    const map = world ? world.map : undefined;
    if (!map) return [false, "bounds"];
    if (map.inBounds && !map.inBounds(tx, ty)) return [false, "bounds"];
    if (overrideBlocks(tx, ty)) return [false, "tile"];
    if (entityBlocks(game, tx, ty)) return [false, "entity"];
    if (map.isWalkable && !map.isWalkable(tx, ty)) return [false, "tile"];
    return [true, undefined];
  },

  // Lua: collision.lua:1084
  /** pret GetLedgeJumpDirection / ShouldJumpLedge: the DESTINATION cell (one
   *  step along `dir`) is an impassable hop metatile whose facing matches `dir`.
   *  Landing is two cells from `from` (Jump2). Wrong-facing approaches bump on
   *  the ledge (isWalkable false); only the matching direction hops over it.
   *  [tx, ty] or []. */
  ledgeLanding(game: any, fromX: number, fromY: number, dir: string): [number?, number?] {
    const P = permissions();
    if (!(P && P.ledgeFacings)) return [];
    const d = DELTA[dir];
    if (!d) return [];
    const destX = fromX + d[1], destY = fromY + d[2];
    let coll: number | undefined;
    if (Collision._grid && Collision._grid[1] != null) {
      if (!Collision.inBounds(destX, destY)) return [];
      coll = Collision.cell(destX, destY);
    } else {
      const map = hostWorld(game) ? hostWorld(game).map : undefined;
      if (!map) return [];
      if (map.inBounds && !map.inBounds(destX, destY)) return [];
      if (map.cellCollision) {
        coll = map.cellCollision(destX, destY);
      }
    }
    const facings = P.ledgeFacings(coll);
    if (!(facings && facings[dir])) return [];
    const tx = fromX + d[1] * 2, ty = fromY + d[2] * 2;
    // pokefirered/src/field_player_avatar.c:613 ShouldJumpLedge
    if (Collision._grid && Collision._grid[1] != null) {
      if (!Collision.inBounds(tx, ty)) return [];
    } else {
      const map = hostWorld(game) ? hostWorld(game).map : undefined;
      if (map && map.inBounds && !map.inBounds(tx, ty)) return [];
    }
    return [tx, ty];
  },

  // Lua: collision.lua:1198
  warpAt(cx: number, cy: number): any {
    return Collision._warps[cy * 1024 + cx];
  },

  // Lua: collision.lua:1216 -- pokefirered/src/field_control_avatar.c:982 SetupWarp
  noteDynamicWarpEntry(game: any, destMap: any, destX: unknown, destY: unknown, srcX?: unknown, srcY?: unknown): boolean {
    const destDef = game && game.data && game.data.maps ? game.data.maps[destMap] : undefined;
    let hit = false;
    for (const [, w] of ipairs<any>(destDef ? destDef.warps : undefined)) {
      if (tonumber(w.mapNum) === MAP_DYNAMIC_NUM
          && tonumber(w.x) === tonumber(destX) && tonumber(w.y) === tonumber(destY)) {
        hit = true;
        break;
      }
    }
    if (!hit) return false;
    const session = sessionOf();
    if (!session) return false;
    const from = (srcX != null && srcY != null ? Collision.warpAt(tonumber(srcX)!, tonumber(srcY)!) : undefined)
      || triggeringWarp();
    const P: any = PlayerMod; // package.loaded["src.core.game3.player"]
    // pokefirered/src/overworld.c:600 SetDynamicWarp
    session.dynamicWarp = {
      map: (game ? game.currentMap : undefined) ?? Collision._mapId ?? session.map,
      warpId: WARP_ID_NONE,
      x: (from ? tonumber(from.x) : undefined) ?? (P ? tonumber(P.cellX) : undefined) ?? session.x,
      y: (from ? tonumber(from.y) : undefined) ?? (P ? tonumber(P.cellY) : undefined) ?? session.y,
    };
    return true;
  },

  // Lua: collision.lua:1258
  /** Check if cell (cx, cy) is an entrance door warp */
  isDoorWarp(game: any, cx: number, cy: number): WarpHit | undefined {
    let w = Collision.warpAt(cx, cy);
    if (!w) {
      const map = hostWorld(game) ? hostWorld(game).map : undefined;
      if (map && map.warpAt) {
        const hit = map.warpAt(cx, cy);
        w = hit ? hit.def : undefined;
      }
    }
    if (!w) return undefined;

    const [destMap, destX, destY] = resolveDest(game, w);
    if (!destMap) return undefined;

    const curMap = (game ? game.currentMap : undefined) ?? Collision._mapId;
    // pcall(lazyReq, "src.core.game3.doors"): a static import
    const Doors: any = DoorsMod;
    if (Doors && Doors.getDoorEntryAt) {
      const entry = Doors.getDoorEntryAt(curMap, cx, cy);
      if (entry) {
        return {
          warp: w,
          destMap,
          destX: destX!,
          destY: destY!,
          x: cx,
          y: cy,
          doorEntry: entry,
        };
      }
    }

    return undefined;
  },

  // Lua: collision.lua:1293
  /** Check if cell (cx, cy) is an indoor exit mat warp leading to an outdoor animated door */
  isExitWarp(game: any, cx: number, cy: number): WarpHit | undefined {
    let w = Collision.warpAt(cx, cy);
    if (!w) {
      const map = hostWorld(game) ? hostWorld(game).map : undefined;
      if (map && map.warpAt) {
        const hit = map.warpAt(cx, cy);
        w = hit ? hit.def : undefined;
      }
    }
    if (!w) return undefined;

    const [destMap, destX, destY] = resolveDest(game, w);
    if (!destMap) return undefined;

    // pcall(lazyReq, "src.core.game3.doors"): a static import
    const Doors: any = DoorsMod;
    if (Doors && Doors.getDoorEntryAt) {
      const entry = Doors.getDoorEntryAt(destMap, destX, destY);
      if (entry) {
        return {
          warp: w,
          destMap,
          destX: destX!,
          destY: destY!,
          x: cx,
          y: cy,
          doorEntry: entry,
        };
      }
    }

    return undefined;
  },

  // Lua: collision.lua:1327
  /** Check if cell (cx, cy) is an escalator warp */
  isEscalatorWarp(game: any, cx: number, cy: number, _dir?: string | null): WarpHit | undefined {
    let w = Collision.warpAt(cx, cy);
    if (!w) {
      const map = hostWorld(game) ? hostWorld(game).map : undefined;
      if (map && map.warpAt) {
        const hit = map.warpAt(cx, cy);
        w = hit ? hit.def : undefined;
      }
    }
    if (!w) return undefined;

    const [destMap, destX, destY] = resolveDest(game, w);
    if (!destMap) return undefined;

    const coll = Collision.cell(cx, cy);
    const curMap = (game ? game.currentMap : undefined) ?? Collision._mapId;
    const curUpper = tostring(curMap ?? "").toUpperCase();
    const destUpper = tostring(destMap ?? "").toUpperCase();

    // pokefirered/src/metatile_behavior.c:126
    const beh = Collision.behavior(cx, cy);
    if (beh != null) {
      if (beh !== MB_UP_ESCALATOR && beh !== MB_DOWN_ESCALATOR) return undefined;
      return {
        warp: w,
        destMap,
        destX: destX!,
        destY: destY!,
        escDir: (beh === MB_DOWN_ESCALATOR) ? "down" : "up",
        x: cx,
        y: cy,
      };
    }

    const isEscalator = (has(curUpper, "POKECENTER") || has(curUpper, "POKEMON_CENTER") || has(curUpper, "DEPT_STORE"))
      && (has(destUpper, "POKECENTER") || has(destUpper, "POKEMON_CENTER") || has(destUpper, "DEPT_STORE"));

    if (isEscalator) {
      let escDir = "up";
      if (has(curUpper, "2F") && (has(destUpper, "1F") || !has(destUpper, "2F"))) {
        escDir = "down";
      } else if (has(curUpper, "3F") && (has(destUpper, "2F") || has(destUpper, "1F"))) {
        escDir = "down";
      } else if (has(curUpper, "4F") && (has(destUpper, "3F") || has(destUpper, "2F") || has(destUpper, "1F"))) {
        escDir = "down";
      } else if (has(curUpper, "5F") && (has(destUpper, "4F") || has(destUpper, "3F") || has(destUpper, "2F") || has(destUpper, "1F"))) {
        escDir = "down";
      } else if (coll === 0x6B) {
        escDir = "down";
      }
      return {
        warp: w,
        destMap,
        destX: destX!,
        destY: destY!,
        escDir,
        x: cx,
        y: cy,
      };
    }
    return undefined;
  },

  // Lua: collision.lua:1391 -- pokefirered/src/field_control_avatar.c:832
  isArrowWarp(game: any, cx: number, cy: number, dir: string | null | undefined): WarpHit | undefined {
    const beh = Collision.behavior(cx, cy);
    if (!Collision.isArrowWarpBehavior(beh)) return undefined;
    if (Collision.arrowWarpDir(beh) !== dir) return undefined;

    let w = Collision.warpAt(cx, cy);
    if (!w) {
      const map = hostWorld(game) ? hostWorld(game).map : undefined;
      if (map && map.warpAt) {
        const hit = map.warpAt(cx, cy);
        w = hit ? hit.def : undefined;
      }
    }
    if (!w) return undefined;

    const [destMap, destX, destY] = resolveDest(game, w);
    if (!destMap) return undefined;

    return {
      warp: w,
      destMap,
      destX: destX!,
      destY: destY!,
      behavior: beh,
      x: cx,
      y: cy,
    };
  },

  // Lua: collision.lua:1421 -- pokefirered/src/field_control_avatar.c:839
  isStairWarp(game: any, cx: number, cy: number, dir?: string | null): WarpHit | undefined {
    const beh = Collision.behavior(cx, cy);
    if (!Collision.isStairWarpBehavior(beh)) return undefined;
    if (dir && Collision.stairWarpDir(beh) !== dir) return undefined;

    let w = Collision.warpAt(cx, cy);
    if (!w) {
      const map = hostWorld(game) ? hostWorld(game).map : undefined;
      if (map && map.warpAt) {
        const hit = map.warpAt(cx, cy);
        w = hit ? hit.def : undefined;
      }
    }
    if (!w) return undefined;

    const [destMap, destX, destY] = resolveDest(game, w);
    if (!destMap) return undefined;

    return {
      warp: w,
      destMap,
      destX: destX!,
      destY: destY!,
      behavior: beh,
      x: cx,
      y: cy,
    };
  },

  // Lua: collision.lua:1451 -- pokefirered/src/overworld.c:910
  destArrivalFacing(game: any, destMap: any, destX: number, destY: number, storedDir?: string | null): string {
    const data = game && game.data ? game.data.maps : undefined;
    const destDef = data ? data[destMap] : undefined;
    if (destDef) {
      const Map: any = MapMod; // package.loaded["src.core.game3.map"] or lazyReq(...)
      if (Map.ensureMidLayout) {
        // pcall(Map.ensureMidLayout, game, destMap, destDef)
        try { Map.ensureMidLayout(game, destMap, destDef); } catch { /* pcall */ }
      }
    }
    const destBeh = Collision.behaviorOn(destDef, destX, destY);
    if (destBeh == null) return storedDir ?? "down";
    return Collision.arrivalFacing(destBeh, storedDir);
  },

  // Lua: collision.lua:1467
  /** If standing on a warp cell, trigger game3 map load / host warp.
   *  Door entrances (pressing UP in front of door), exit mats (pressing DOWN on mat),
   *  and escalators (moving into escalator from adjacent cell) are triggered explicitly
   *  via Player.tryMove, not on initial step landing. */
  tryWarpAt(game: any, cx: number, cy: number, facing?: string | null, opts?: { arrow?: boolean } | null): boolean {
    const arrowPress = opts != null && opts.arrow === true;
    const Space: any = SpaceMod; // package.loaded["src.core.game3.scripting.space"]
    if (Space && Space.vm && Space.vm.isRunning && Space.vm.isRunning()) {
      return false;
    }

    let w = Collision.warpAt(cx, cy);
    if (!w) {
      const map = hostWorld(game) ? hostWorld(game).map : undefined;
      if (map && map.warpAt) {
        const hit = map.warpAt(cx, cy);
        w = hit ? hit.def : undefined;
      }
    }
    if (!w) return false;

    const [destMap, destX, destY] = resolveDest(game, w);
    if (!destMap) return false;

    const curMap = (game ? game.currentMap : undefined) ?? Collision._mapId;
    const curUpper = tostring(curMap ?? "").toUpperCase();
    const destUpper = tostring(destMap ?? "").toUpperCase();
    const coll = Collision.cell(cx, cy);

    const beh = Collision.behavior(cx, cy);

    // pokefirered/src/field_control_avatar.c:825
    if (!arrowPress) {
      if (Collision.isDoorWarp && Collision.isDoorWarp(game, cx, cy)) {
        return false;
      }
      if (Collision.isExitWarp && Collision.isExitWarp(game, cx, cy)) {
        return false;
      }
      if (Collision.isEscalatorWarp && Collision.isEscalatorWarp(game, cx, cy, facing)) {
        return false;
      }
      // pokefirered/src/field_control_avatar.c:944
      if (Collision.isStairWarpBehavior(beh) || Collision.isArrowWarpBehavior(beh)) {
        return false;
      }
      // pokefirered/src/field_control_avatar.c:856
      if (beh != null && !Collision.isStepWarpBehavior(beh)) {
        return false;
      }
    }

    const Runtime: any = RuntimeMod; // package.loaded["src.core.game3.runtime"]
    const modv = Runtime ? Runtime._mod : undefined;
    const g = game || (Runtime ? Runtime._game : undefined);

    const MapIds: any = MapIdsMod;
    if (truthy(MapIds.isGame3Map(destMap))) {
      const Warp: any = WarpMod;

      // pokefirered/src/field_control_avatar.c:879
      let isTeleport: boolean;
      if (beh != null) {
        isTeleport = Collision.isWarpPad(beh);
      } else {
        isTeleport = (has(curUpper, "SILPH_CO") || has(curUpper, "SAFFRON_GYM") || has(curUpper, "ROCKET_HIDEOUT") || has(curUpper, "POKEMON_MANSION"))
          && !(has(destUpper, "ELEVATOR") || has(destUpper, "1F") || has(destUpper, "PLAYERS_HOUSE"))
          && (coll === 0x75 || coll === 0x72);
      }

      // pokefirered/src/field_control_avatar.c:889
      const isFallHole = ((beh != null) && Collision.isFallWarp(beh)) || (beh == null && coll === 0x76);

      if (isTeleport) {
        return Warp.startTeleport(modv, g, destMap, destX, destY, cx, cy);
      }

      if (isFallHole) {
        return Warp.startFall(modv, g, destMap, destX, destY, cx, cy);
      }

      Warp.request(modv, g, destMap, destX, destY,
        Collision.destArrivalFacing(g, destMap, destX!, destY!, facing), {
          fade: true,
          door: false,
          doorX: cx,
          doorY: cy,
        });
      return true;
    }

    if (!modv) return false;

    // Leaving Sevii -- hand back to host.
    if (Runtime && Runtime.isActive && Runtime.isActive()) {
      const Bridge: any = BridgeMod;
      if (Bridge.persistSessionOnly) {
        Bridge.persistSessionOnly(modv, g);
      }
      Runtime.stop(modv, g);
    }

    const world = hostWorld(g);
    if (world && world.warpToMapId) {
      world.warpToMapId(destMap, destX, destY, facing ?? "down");
      return true;
    }
    return false;
  },
};

// pokefirered/src/event_object_movement.c:888 gOppositeDirectionBlockedMetatileFuncs
// Lua: collision.lua:306
const LEAVE_BLOCKED: Record<string, ((beh: Beh) => boolean) | undefined> = {
  down: Collision.isSouthBlocked,
  up: Collision.isNorthBlocked,
  left: Collision.isWestBlocked,
  right: Collision.isEastBlocked,
};
// pokefirered/src/event_object_movement.c:895 gDirectionBlockedMetatileFuncs
// Lua: collision.lua:313
const ENTER_BLOCKED: Record<string, ((beh: Beh) => boolean) | undefined> = {
  down: Collision.isNorthBlocked,
  up: Collision.isSouthBlocked,
  left: Collision.isEastBlocked,
  right: Collision.isWestBlocked,
};

// Lua `s:find(p)` as a condition (patterns here have no magic characters).
function has(s: string, p: string): boolean {
  return find(s, p) != null;
}

// Lua: collision.lua:992
function entityBlocks(game: any, tx: number, ty: number, elevation?: number): boolean {
  // pcall(lazyReq, "src.core.game3.objects"): a static import
  const Objects: any = ObjectsMod;
  if (Objects && Objects.hasMap && Objects.hasMap()) {
    if (Objects.blocks(tx, ty, undefined, elevation)) return true;
    return false;
  }
  const world = hostWorld(game);
  if (!(world && world.npcs)) return false;
  for (const [, npc] of ipairs<any>(world.npcs)) {
    if (!npc.passable) {
      const nx = npc.cellX ?? (npc.def ? npc.def.x : undefined);
      const ny = npc.cellY ?? (npc.def ? npc.def.y : undefined);
      if (nx === tx && ny === ty) return true;
      if (npc.moving && npc.targetX === tx && npc.targetY === ty) {
        return true;
      }
    }
  }
  return false;
}

// Lua: collision.lua:1013
function overrideBlocks(tx: number, ty: number): boolean {
  const Field: any = FieldMod; // package.loaded["src.core.game3.field"]
  if (!(Field && Field.metatileOverrideAt)) return false;
  let mapId: any = Collision._mapId;
  if (mapId == null) {
    const session = Field._session;
    mapId = session ? session.map : undefined;
  }
  const o = Field.metatileOverrideAt(mapId, tx, ty);
  return o != null && o.impassable === true;
}

// pokefirered/include/constants/maps.h:9
// Lua: collision.lua:1116
const MAP_DYNAMIC_NUM = 0x7F;
// pokefirered/include/constants/maps.h:26
const WARP_ID_NONE = 0xFF;

// Lua: collision.lua:1120
function sessionOf(): any {
  const Runtime: any = RuntimeMod; // package.loaded["src.core.game3.runtime"]
  return (Runtime && Runtime.getSession && Runtime.getSession()) || undefined;
}

// Lua: collision.lua:1125
function catalogMapId(mapId: any, group: any, num: any): string | undefined {
  // pcall(lazyReq, "src.import.gba.map_catalog"): a static import
  const okC = true;
  if (typeof mapId === "string" && mapId !== "") {
    if (okC && MapCatalog && MapCatalog.resolve) {
      return MapCatalog.resolve(mapId) ?? mapId;
    }
    return mapId;
  }
  if (okC && MapCatalog && group != null) {
    return MapCatalog.mapIdFor(group, num);
  }
  return undefined;
}

// Lua: collision.lua:1140 -- pokefirered/src/overworld.c:610 SetWarpDestinationToDynamicWarp; [destMap, x, y] or []
function resolveDynamicDest(game: any): [string?, number?, number?] {
  const session = sessionOf();
  let dw = session ? session.dynamicWarp : undefined;
  if (typeof dw === "string") dw = { map: dw };
  if (!isTable(dw)) return [];
  const destMap = catalogMapId(dw.map ?? dw.mapId ?? dw.destMap, dw.mapGroup, dw.mapNum);
  if (typeof destMap !== "string") return [];
  const destDef = game && game.data && game.data.maps ? game.data.maps[destMap] : undefined;
  // pokefirered/src/overworld.c:564 SetPlayerCoordsFromWarp
  const warps = destDef ? destDef.warps : undefined;
  const id = tonumber(dw.warpId);
  const landing = id != null && id >= 0 && id < WARP_ID_NONE && warps ? warps[id + 1] : undefined;
  if (landing) {
    return [destMap, tonumber(landing.x) ?? 0, tonumber(landing.y) ?? 0];
  }
  const x = tonumber(dw.x), y = tonumber(dw.y);
  if (x != null && y != null && x >= 0 && y >= 0) return [destMap, x, y];
  const [w, h] = mapCellSize(destDef);
  return [destMap, Math.floor(w / 2), Math.floor(h / 2)];
}

// Lua: collision.lua:1161 -- [destMap, x, y] or []
function resolveDest(game: any, warp: any): [string?, number?, number?] {
  // pokefirered/src/field_control_avatar.c:971 SetupWarp
  if (tonumber(warp.mapNum) === MAP_DYNAMIC_NUM) {
    return resolveDynamicDest(game);
  }
  let destMap: any = warp.destMap ?? warp.map;
  if (typeof destMap !== "string" || destMap === "") {
    // pcall(lazyReq, "src.import.gba.map_catalog"): a static import
    if (MapCatalog && warp.mapGroup != null) {
      destMap = MapCatalog.mapIdFor(warp.mapGroup, warp.mapNum);
    }
    if (typeof destMap !== "string") {
      destMap = Versions.mapIdFor && Versions.mapIdFor(warp.mapGroup, warp.mapNum);
    }
  } else {
    // pcall(lazyReq, "src.import.gba.map_catalog"): a static import
    if (MapCatalog && MapCatalog.resolve) {
      destMap = MapCatalog.resolve(destMap) ?? destMap;
    }
  }
  const destWarp = tonumber(warp.destWarp) ?? 1;
  if (typeof destMap !== "string") return [];
  const data = game && game.data ? game.data.maps : undefined;
  const destDef = data ? data[destMap] : undefined;
  const warps = destDef ? destDef.warps : undefined;
  const landing = warps ? warps[destWarp] : undefined;
  if (landing) {
    return [destMap, tonumber(landing.x) ?? 0, tonumber(landing.y) ?? 0];
  }
  // Fallback: use warp's own destX/destY if present.
  if (warp.destX != null) {
    return [destMap, tonumber(warp.destX) ?? 0, tonumber(warp.destY) ?? 0];
  }
  return [destMap, 0, 0];
}

// Lua: collision.lua:1203 -- pokefirered/src/field_control_avatar.c:960 GetWarpEventAtMapPosition
function triggeringWarp(): any {
  const P: any = PlayerMod; // package.loaded["src.core.game3.player"]
  if (!P) return undefined;
  const cx = tonumber(P.cellX), cy = tonumber(P.cellY);
  if (!(cx != null && cy != null)) return undefined;
  const w = Collision.warpAt(cx, cy);
  if (w) return w;
  const d = P.facing != null ? DELTA[P.facing] : undefined;
  if (!d) return undefined;
  return Collision.warpAt(cx + d[1], cy + d[2]);
}

// Lua: collision.lua:1242 (unused in Brian's module; kept)
function isBuilding(name: unknown): boolean {
  const n = tostring(name ?? "").toUpperCase();
  return has(n, "POKECENTER") || has(n, "POKEMON_CENTER") || has(n, "CENTER")
    || has(n, "MART") || has(n, "DEPT_STORE")
    || has(n, "SILPH_CO") || has(n, "HOUSE")
    || has(n, "LAB") || has(n, "GYM")
    || has(n, "SAFARI_ZONE") || has(n, "GAME_CORNER")
    || has(n, "FAN_CLUB") || has(n, "MUSEUM")
    || has(n, "DAYCARE") || has(n, "DAY_CARE")
    || has(n, "CABLE_CLUB") || has(n, "SCHOOL")
    || has(n, "GATE") || has(n, "BUILDING")
    || has(n, "_1F") || has(n, "_2F") || has(n, "_3F")
    || has(n, "_4F") || has(n, "_5F");
}

export default Collision;
