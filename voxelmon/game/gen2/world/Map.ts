// Gen 2 runtime map: block grid + COLL_* quads (not Gen 1 walkable lists).
// A port of gen1recomp src/world/gen2/Map.lua at bdfac727 (MIT).
//
// Coordinates are unpadded cells (extract stores width×height blocks as-is;
// WRAM's 3-block border is not mirrored here).
//
// Data: a maps.json def (voxelmon/import/gen2/maps.ts) and a tilesets.json
// def. `def.blocks` and `tileset.collision` are 0-based JS arrays of what the
// Lua indexed from 1, so `blocks[i + 1]` reads `blocks[i]` here. Warp indices
// stay the game's 1-based warp numbers.

import { Logger } from "../shared/core/Logger.ts";
import { Permissions } from "./Permissions.ts";
import type { Dir } from "../permissions.ts";

export type { Dir };

export interface WarpDef {
  x: number;
  y: number;
  destWarp?: number;
  destGroup?: number;
  destMapNum?: number;
  destMap?: string;
  [key: string]: any;
}

export interface WarpRef {
  /** 1-based warp number, as the cart counts warps. */
  index: number;
  def: WarpDef;
}

// Lua: Map.lua:10-11
const DELTA: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

// Lua: Map.lua:82
let warnedCellTile = false;

export class Map {
  static DELTA = DELTA;

  def: any;
  id: string;
  tileset: any;
  width: number;
  height: number;
  widthCells: number;
  heightCells: number;
  blocks: number[];
  borderBlock: number;
  collision: number[][] | undefined;
  warps: WarpDef[];
  connections: Record<string, any>;
  _warpAt: Record<number, WarpRef>;

  // Lua: Map.lua:13-39
  constructor(def: any, tileset: any) {
    this.def = def;
    this.id = def.id;
    this.tileset = tileset;
    this.width = def.width;
    this.height = def.height;
    this.widthCells = def.width * 2;
    this.heightCells = def.height * 2;
    this.blocks = def.blocks;
    this.borderBlock = def.borderBlock ?? 0;
    this.collision = tileset.collision;
    this.warps = def.warps ?? [];
    this.connections = def.connections ?? {};
    // A Gen 1 mod reads conn.map; a Gold extraction may only carry conn.mapId,
    // which is why World.computeNeighbors reads both. Normalise here so one
    // read answers on either cache. (Gold's own extraction also carries a
    // numeric `map` -- the map number -- which the Lua leaves alone because it
    // is not nil; so do we.)
    for (const k of Object.keys(this.connections)) {
      const conn = this.connections[k];
      if (conn !== null && typeof conn === "object" && conn.map == null) conn.map = conn.mapId;
    }
    // Warp lookup by cell.
    this._warpAt = {};
    this.warps.forEach((w, i) => {
      this._warpAt[w.y * 1024 + w.x] = { index: i + 1, def: w };
    });
  }

  static new(def: any, tileset: any): Map {
    return new Map(def, tileset);
  }

  // Lua: Map.lua:41
  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0
       && cx < this.widthCells && cy < this.heightCells;
  }

  // Lua: Map.lua:46
  blockId(bx: number, by: number): number {
    if (bx < 0 || by < 0 || bx >= this.width || by >= this.height) {
      return this.borderBlock;
    }
    return this.blocks[by * this.width + bx] ?? 0;
  }

  // Lua: Map.lua:53-63 -- COLL_* byte for cell (cx, cy). Block id 0 is the
  // impassable sentinel (GetCoordTileCollision .nope -> $ff).
  cellCollision(cx: number, cy: number): number {
    const bx = Math.floor(cx / 2);
    const by = Math.floor(cy / 2);
    const id = this.blockId(bx, by);
    if (id === 0) return 0xff;
    const quad = this.collision ? this.collision[id] : undefined;
    if (!quad) return 0xff;
    const lx = mod2(cx);
    const ly = mod2(cy);
    return quad[ly * 2 + lx] ?? 0xff;
  }

  // Lua: Map.lua:65
  isWalkable(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return false;
    return Permissions.isWalkable(this.cellCollision(cx, cy));
  }

  // ------- the shared cell vocabulary a mod binds to (Map.lua:70-81): the
  // same names src/world/Map.lua answers; Gold answers from the COLL_* byte.

  // Lua: Map.lua:84
  cellTile(cx: number, cy: number): number {
    // Loud once, because the call SUCCEEDS and the number is plausible.
    if (!warnedCellTile) {
      warnedCellTile = true;
      Logger.warn(
        "Map:cellTile on Gold returns a COLL_* byte, not a Gen 1 tile id; the "
        + "two number spaces are unrelated -- use the cell predicates");
    }
    return this.cellCollision(cx, cy);
  }

  // Lua: Map.lua:97
  isWalkableCell(cx: number, cy: number): boolean {
    return this.isWalkable(cx, cy);
  }

  // Lua: Map.lua:101
  isWaterCell(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return false;
    return Permissions.isWater(this.cellCollision(cx, cy));
  }

  // Lua: Map.lua:106-111 -- off-map cells never count as grass.
  isGrassCell(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return false;
    return Permissions.isGrass(this.cellCollision(cx, cy));
  }

  // Lua: Map.lua:113
  warpAt(cx: number, cy: number): WarpRef | undefined {
    return this._warpAt[cy * 1024 + cx];
  }

  // Lua: Map.lua:119
  warpAtCell(cx: number, cy: number): WarpRef | undefined {
    return this.warpAt(cx, cy);
  }

  // Lua: Map.lua:123
  isCounterCell(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return false;
    return Permissions.isCounter(this.cellCollision(cx, cy));
  }

  // Lua: Map.lua:128-133 -- Gold's header says so outright.
  static isOutside(def: any, _tilesets?: unknown): boolean {
    const env = def ? def.environment : undefined;
    return env === "TOWN" || env === "ROUTE";
  }

  // Lua: Map.lua:135-140
  static isOutdoor(def: any): boolean {
    if (def && def.outdoor != null) return def.outdoor;
    return Map.isOutside(def);
  }

  // Lua: Map.lua:142-148 -- def.region, else the id prefix.
  static inRegion(def: any, region: unknown, prefix?: string): boolean {
    if (!def) return false;
    if (def.region != null) return def.region === region;
    return prefix != null && def.id != null && String(def.id).indexOf(prefix) === 0;
  }

  // Lua: Map.lua:150-157 -- on Gold a boulder is the STRENGTH_BOULDER movement
  // byte, not a sprite name.
  static isPushable(objDef: any): boolean {
    if (!objDef) return false;
    if (objDef.pushable != null) return objDef.pushable;
    return objDef.movement === 0x19;
  }

  // ------- the Gen 1 spellings that read a raw def (Map.lua:159-163)

  // Lua: Map.lua:165-182 -- the cell's COLL_* byte off a raw def, or undefined
  // when the data is missing.
  static defCellTile(def: any, tilesetDef: any, cx: number, cy: number): number | undefined {
    if (!(def && tilesetDef && tilesetDef.collision && def.blocks)) {
      return undefined;
    }
    const bx = Math.floor(cx / 2);
    const by = Math.floor(cy / 2);
    let id: number;
    if (bx < 0 || by < 0 || bx >= def.width || by >= def.height) {
      id = def.borderBlock ?? 0;
    } else {
      id = def.blocks[by * def.width + bx] ?? 0;
    }
    if (id === 0) return 0xff;
    const quad = tilesetDef.collision[id];
    if (!quad) return 0xff;
    return quad[mod2(cy) * 2 + mod2(cx)] ?? 0xff;
  }

  // Lua: Map.lua:184
  static defIsWalkableCell(def: any, tilesetDef: any, cx: number, cy: number): boolean {
    const coll = Map.defCellTile(def, tilesetDef, cx, cy);
    if (coll == null) return false;
    return Permissions.isWalkable(coll);
  }

  // Lua: Map.lua:190
  static defIsWaterCell(def: any, tilesetDef: any, cx: number, cy: number): boolean {
    const coll = Map.defCellTile(def, tilesetDef, cx, cy);
    if (coll == null) return false;
    return Permissions.isWater(coll);
  }

  // Lua: Map.lua:196-208 -- fails CLOSED on missing data.
  static defPassable(def: any, tilesetDef: any, cx: number, cy: number, surfing?: unknown): boolean {
    if (!(def && tilesetDef && tilesetDef.collision && def.blocks)) {
      return false;
    }
    if (Map.defIsWalkableCell(def, tilesetDef, cx, cy)) return true;
    if (surfing) {
      const coll = Map.defCellTile(def, tilesetDef, cx, cy);
      return coll != null && Permissions.surfable(coll) != null;
    }
    return false;
  }

  // ------- the Gen 1 instance spellings a mod calls on world.map

  // Lua: Map.lua:212
  blockAt(bx: number, by: number): number {
    return this.blockId(bx, by);
  }

  // Lua: Map.lua:217-224 -- writes the block grid in place and nothing else;
  // the VISIBLE edit is World:changeBlock.
  setBlock(bx: number, by: number, block: number): void {
    if (bx < 0 || by < 0 || bx >= this.width || by >= this.height) return;
    this.blocks[by * this.width + bx] = block;
  }

  // Lua: Map.lua:226-237 -- graphics tile id on the 8px grid, border-extended.
  tileAt(tx: number, ty: number): number | undefined {
    const blocks = this.tileset ? this.tileset.blocks : undefined;
    if (!blocks) return undefined;
    const id = this.blockId(Math.floor(tx / 4), Math.floor(ty / 4));
    const block = blocks[id];
    if (!block) return undefined;
    return block[mod4(ty) * 4 + mod4(tx)];
  }

  // Lua: Map.lua:239-244 -- a door is a warp collision kind (walked INTO).
  isDoorTileCell(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return false;
    return Permissions.isImmediateWarp(this.cellCollision(cx, cy));
  }

  // Lua: Map.lua:246-251
  isWarpTileCell(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return false;
    return Permissions.isWarpCollision(this.cellCollision(cx, cy));
  }

  // Lua: Map.lua:253-262 -- coordinate-only (no facing/event filter).
  signAtCell(cx: number, cy: number): any {
    for (const ev of (this.def && this.def.bgEvents) || []) {
      if (ev.x === cx && ev.y === cy) return ev;
    }
    return undefined;
  }

  // Lua: Map.lua:264-277 -- GetMovementPermissions (home/map.asm): may a step
  // `dir` LEAVE (cx, cy)?
  stepPermitted(cx: number, cy: number, dir: Dir): boolean {
    return Permissions.stepPermitted(
      (x: number, y: number) => this.cellCollision(x, y), cx, cy, dir);
  }

  // Lua: Map.lua:279-288 -- CanObjectMoveInDirection
  // (engine/overworld/npc_movement.asm:1); GetCoordTileCollision's .nope.
  objectStepPermitted(cx: number, cy: number, dir: Dir): boolean {
    const d = DELTA[dir];
    if (!d) return false;
    const tx = cx + d[0];
    const ty = cy + d[1];
    if (!this.inBounds(tx, ty)) return false;
    return Permissions.objectStepPermitted(
      this.cellCollision(cx, cy), this.cellCollision(tx, ty), dir);
  }

  // Lua: Map.lua:290
  connection(dir: string): any {
    return this.connections[dir];
  }

  // Lua: Map.lua:294-313 -- destination cell after stepping off this edge onto
  // a connected map. Returns [x, y], or undefined without a connection.
  static connectionLanding(def: any, conn: any, dir: string, fromCx: number, fromCy: number): [number, number] | undefined {
    if (!(def && conn)) return undefined;
    const destW = def.width * 2;
    const destH = def.height * 2;
    const offset = conn.offset ?? 0;
    let x: number;
    let y: number;
    if (dir === "up") {
      x = fromCx - offset * 2; y = destH - 1;
    } else if (dir === "down") {
      x = fromCx - offset * 2; y = 0;
    } else if (dir === "left") {
      x = destW - 1; y = fromCy - offset * 2;
    } else {
      x = 0; y = fromCy - offset * 2;
    }
    x = Math.max(0, Math.min(destW - 1, x));
    y = Math.max(0, Math.min(destH - 1, y));
    return [x, y];
  }
}

// Lua's `%` on cells (always a non-negative result).
function mod2(n: number): number {
  return n - Math.floor(n / 2) * 2;
}
function mod4(n: number): number {
  return n - Math.floor(n / 4) * 4;
}

export default Map;
