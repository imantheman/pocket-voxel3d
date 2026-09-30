// voxelmon/cook/classify.ts — the tile classifier.
//
// Port of VoxelMod lib/TileShape.lua: resolve every tile of a tileset to an
// extrusion shape. Resolution order (TileShape.lua:5-24):
//   per tile   1. hand-authored profile pin (conditional pins first — they
//                 need the position)
//   per CELL   2. the cell is water  -> water
//              3. the cell is walkable -> ground
//   per tile   4. tile-level fallback: water set -> water, walkable -> ground,
//                 else wall
// Cell semantics judge by the cell's bottom-left tile (data.ts GameMap).

import { CLASS_HEIGHT } from "../../contracts/spec/voxel-spec.ts";
import type { GameMap, Profile } from "./data.ts";

// Class heights: the spec pins the classes the runtime states facts about
// (CLASS_HEIGHT, imported never re-declared); the profile's extra interior
// classes extend it — VoxelMod TileShape.lua:48-120 FALLBACK_HEIGHTS.
const EXTRA_HEIGHTS: Record<string, number> = {
  can: 9,
  planter: 32,
  billboard: 16,
  signpost: 16,
  post: 16,
  bed: 7,
  stool: 8,
  backrest: 12,
  cutout: 16,
  bike: 16,
  console: 16,
  relief: 3,
  bookcase: 32,
  stair_e: 16,
  stair_w: 16,
  stair_down_e: 16,
  stair_down_w: 16,
};

export const FALLBACK_HEIGHTS: Record<string, number> = {
  ...CLASS_HEIGHT,
  ...EXTRA_HEIGHTS,
};

// VoxelMod TileShape.lua:135-209 ART — how the mesher draws each class.
export const ART: Record<string, string> = {
  ground: "flat",
  water: "flat",
  void: "flat",
  ledge: "top",
  roof: "top",
  wall: "upright",
  cliff: "upright",
  tree: "upright",
  fence: "upright",
  sign: "upright",
  cylinder: "cylinder",
  canopy: "canopy",
  stump: "cylinder",
  can: "cylinder",
  planter: "planter",
  billboard: "billboard",
  signpost: "billboard",
  post: "post",
  grass: "grass",
  flower: "flower",
  bed: "top",
  backrest: "top",
  stool: "billboard",
  counter: "upright",
  table: "upright",
  desk: "upright",
  prop: "billboard",
  cutout: "billboard",
  bike: "billboard",
  console: "billboard",
  relief: "relief",
  bookcase: "bookcase",
  stair_e: "stair",
  stair_w: "stair",
  stair_down_e: "stair",
  stair_down_w: "stair",
};

export interface Shape {
  class: string;
  h: number;
  art: string;
  flat: boolean;
  authored: boolean;
}

interface CondRule {
  side: "above" | "below" | "cell";
  set: Set<number>;
  class: string;
  /** Gen 2 only: tile rows away to look (Gen2Recomped TileShape.lua:502). */
  rows?: number;
  /** Gen 2 only: a `when_cell` rule's walkability test (TileShape.lua:534). */
  walkable?: boolean;
}

export interface TileShapes {
  /** Per tile id (0..count-1). */
  tiles: (Shape | undefined)[];
  /** One canonical shape per class, for the cell-level overrides. */
  classes: Record<string, Shape>;
  /** Conditional pins: tile id -> ordered rules (TileShape.lua:279). */
  cond: Map<number, CondRule[]> | null;
  /** A conditional pin's own AUTHORED shape per class (TileShape.lua:383). */
  condShape: Record<string, Shape>;
  count: number;
  /** Gen 2: the resolution runs through shapeAtGen2 (absent for Gen 1). */
  gen2?: boolean;
  /** Gen 2: COLL_* class -> authored shape (Gen2Recomped TileShape.lua:729). */
  coll?: Map<number, Shape> | null;
  /** Gen 2: the tileset entry opts into hop lips indoors (`hop_lips`). */
  hopLips?: boolean;
}

// TileShape.lua:311 shapeFor.
function shapeFor(cls: string, heights: Record<string, number>, authored = false): Shape {
  const art = ART[cls] ?? "upright";
  return {
    class: cls,
    h: heights[cls] ?? 0,
    art,
    flat: art === "flat" || cls === "grass" || cls === "flower",
    authored,
  };
}

// TileShape.lua:230 heights + per-tileset overrides (forMap:333-351).
export function classHeights(profile: Profile | null, tilesetId: string): Record<string, number> {
  const out: Record<string, number> = { ...FALLBACK_HEIGHTS };
  for (const [cls, h] of Object.entries(profile?.heights ?? {})) {
    if (typeof h === "number" && cls in FALLBACK_HEIGHTS) out[cls] = h;
  }
  const over = profile?.tilesets?.[tilesetId]?.heights;
  for (const [cls, h] of Object.entries(over ?? {})) {
    if (typeof h === "number" && cls in FALLBACK_HEIGHTS) out[cls] = h;
  }
  return out;
}

// TileShape.lua:243 authoredGroups — unknown class names are dropped.
function authoredGroups(
  profile: Profile | null,
  tilesetId: string,
  heights: Record<string, number>,
): Map<number, string> {
  const out = new Map<number, string>();
  const entry = profile?.tilesets?.[tilesetId];
  if (!entry) return out;
  for (const cls of Object.keys(entry).sort()) {
    const tiles = entry[cls];
    if (heights[cls] !== undefined && Array.isArray(tiles)) {
      for (const t of tiles) {
        if (typeof t === "number") out.set(t, cls);
      }
    }
  }
  return out;
}

// TileShape.lua:279 authoredConditions.
function authoredConditions(
  profile: Profile | null,
  tilesetId: string,
  heights: Record<string, number>,
): Map<number, CondRule[]> | null {
  const entry = profile?.tilesets?.[tilesetId];
  if (!entry) return null;
  const out = new Map<number, CondRule[]>();

  const collect = (spec: unknown, side: "above" | "below"): void => {
    if (typeof spec !== "object" || spec === null) return;
    for (const key of Object.keys(spec as Record<string, unknown>).sort((a, b) => +a - +b)) {
      const tile = Number(key);
      const rules = (spec as Record<string, unknown>)[key];
      if (!Number.isFinite(tile) || !Array.isArray(rules)) continue;
      const list = out.get(tile) ?? [];
      for (const rule of rules) {
        const r = rule as { class?: string } & Record<string, unknown>;
        const sideList = r[side];
        if (r.class && heights[r.class] !== undefined && Array.isArray(sideList)) {
          list.push({ side, set: new Set(sideList as number[]), class: r.class });
        }
      }
      if (list.length > 0) out.set(tile, list);
    }
  };
  collect(entry.when_above, "above");
  collect(entry.when_below, "below");
  return out.size > 0 ? out : null;
}

const shapesCache = new Map<string, TileShapes>();

/**
 * Resolved TILE-LEVEL shapes for the tileset `map` uses
 * (TileShape.lua:328 forMap). Cached per tileset id.
 */
export function tileShapesFor(map: GameMap, profile: Profile | null): TileShapes {
  const tileset = map.tileset;
  const hit = shapesCache.get(tileset.id);
  if (hit) return hit;
  // Gen 2 carries a collision class per cell and resolves through the fork's
  // own branch (Gen2Recomped TileShape.lua:709-767); Gen 1 is untouched.
  if (tileset.collision) {
    const g2 = tileShapesForGen2(map, profile);
    shapesCache.set(tileset.id, g2);
    return g2;
  }

  const heights = classHeights(profile, tileset.id);
  const authored = authoredGroups(profile, tileset.id, heights);
  const count =
    Math.floor((tileset.imageWidth || 128) / 8) * Math.floor((tileset.imageHeight || 48) / 8);

  // Derived pin (TileShape.lua:357-376): a tile the tileset animates by
  // FRAME REWRITE is the flower; grassTile is the tall grass.
  const flowerTiles = new Set<number>();
  for (const spec of defaultAnimatedTiles(tileset.animation)) {
    if (spec.kind === "frames") flowerTiles.add(spec.tile);
  }

  const classes: Record<string, Shape> = {};
  for (const cls of Object.keys(FALLBACK_HEIGHTS)) classes[cls] = shapeFor(cls, heights);

  const cond = authoredConditions(profile, tileset.id, heights);
  const condShape: Record<string, Shape> = {};
  if (cond) {
    for (const rules of cond.values()) {
      for (const rule of rules) {
        condShape[rule.class] ??= shapeFor(rule.class, heights, true);
      }
    }
  }

  const tiles: (Shape | undefined)[] = [];
  for (let t = 0; t < count; t++) {
    const cls = authored.get(t);
    if (cls) {
      tiles[t] = shapeFor(cls, heights, true);
    } else if (t === tileset.grassTile) {
      tiles[t] = shapeFor("grass", heights, true);
    } else if (flowerTiles.has(t)) {
      tiles[t] = shapeFor("flower", heights, true);
    } else if (map.waterTiles.has(t)) {
      tiles[t] = classes.water;
    } else if (map.walkable.has(t)) {
      tiles[t] = classes.ground;
    } else {
      tiles[t] = classes.wall;
    }
  }

  const shapes: TileShapes = { tiles, classes, cond, condShape, count };
  shapesCache.set(tileset.id, shapes);
  return shapes;
}

/**
 * The shape of the tile at TILE coordinates (TileShape.lua:420 at) —
 * conditional pins outrank the flat pin and the cell rules; authored tiles
 * bypass the cell rules.
 */
export function shapeAt(
  map: GameMap,
  shapes: TileShapes,
  tile: number,
  tx: number,
  ty: number,
): Shape | undefined {
  if (shapes.gen2) return shapeAtGen2(map, shapes, tile, tx, ty);
  const rules = shapes.cond?.get(tile);
  if (rules) {
    for (const rule of rules) {
      // NOTE map.tileAt border-EXTENDS (TileShape.lua:429).
      const n = map.tileAt(tx, rule.side === "above" ? ty - 1 : ty + 1);
      if (rule.set.has(n)) return shapes.condShape[rule.class];
    }
  }
  const s = shapes.tiles[tile];
  if (!s || s.authored) return s;
  const cx = Math.floor(tx / 2);
  const cy = Math.floor(ty / 2);
  if (map.isWaterCell(cx, cy)) return shapes.classes.water;
  if (map.isWalkableCell(cx, cy)) return shapes.classes.ground;
  return s;
}

// ---------------------------------------------------------------------------
// Gen 2 (Gold): port of Gen2Recomped-DramaticShapes lib/TileShape.lua (MIT,
// DramaticShape, modified by UNDERdecodedHD 2026 for Generation II), the
// collision-class branch. Reached only for a tileset carrying `collision`,
// so nothing below runs for Red, Blue or Yellow.
// ---------------------------------------------------------------------------

// TileShape.lua:53 FALLBACK_HEIGHTS -- the classes the fork adds that a
// Gold profile entry names: `terrace` (:90, raised ground drawn on top of a
// cliff), `shell` (:75, a room's outer wall mass), `waterfall` (:83, a fall
// band) and `column` (:130, a structural post). The Gen 3 classes are not
// reachable from a Gold map and are left out.
export const GEN2_EXTRA_HEIGHTS: Record<string, number> = {
  terrace: 16,
  shell: 32,
  waterfall: 32,
  column: 32,
};

// TileShape.lua:276 ART for the same four: a terrace rides its TOP face
// like a ledge (:284), waterfall and shell fold upright (:288-289), a
// column is a post (:304).
export const GEN2_ART: Record<string, string> = {
  terrace: "top",
  shell: "upright",
  waterfall: "upright",
  column: "post",
};

export const GEN2_FALLBACK_HEIGHTS: Record<string, number> = {
  ...FALLBACK_HEIGHTS,
  ...GEN2_EXTRA_HEIGHTS,
};

// TileShape.lua:555 shapeFor, over the Gen 2 art table.
function shapeForGen2(cls: string, heights: Record<string, number>, authored = false): Shape {
  let art = ART[cls] ?? GEN2_ART[cls] ?? "upright";
  // The fork collapses a `bookcase` rank onto a one-cell-deep box at its
  // drawn height (Structures.lua:22026 buildBookcases), which this cook does
  // not port. Its stand-in is the authored upright fold -- the same box at
  // the class's 32px, the drawing folded up its front band by band -- rather
  // than the unported art mode's plain box tiling one tile up every face.
  // Gen 1 keeps its own `bookcase` art (never reaches this function).
  if (art === "bookcase") art = "upright";
  return {
    class: cls,
    h: heights[cls] ?? 0,
    art,
    flat: art === "flat" || cls === "grass" || cls === "flower",
    authored,
  };
}

// TileShape.lua:427 TileShape.heights + the per-tileset overrides
// (forMap:611-630), gated on the Gen 2 class vocabulary.
export function classHeightsGen2(profile: Profile | null, tilesetId: string): Record<string, number> {
  const out: Record<string, number> = { ...GEN2_FALLBACK_HEIGHTS };
  for (const [cls, h] of Object.entries(profile?.heights ?? {})) {
    if (typeof h === "number" && cls in GEN2_FALLBACK_HEIGHTS) out[cls] = h;
  }
  const over = profile?.tilesets?.[tilesetId]?.heights;
  for (const [cls, h] of Object.entries(over ?? {})) {
    if (typeof h === "number" && cls in GEN2_FALLBACK_HEIGHTS) out[cls] = h;
  }
  return out;
}

// TileShape.lua:476 authoredConditions: when_above / when_below with the
// `rows` look-distance (:502), and `when_cell` (:534), which asks whether
// the tile's own CELL is walkable.
function authoredConditionsGen2(
  profile: Profile | null,
  tilesetId: string,
  heights: Record<string, number>,
): Map<number, CondRule[]> | null {
  const entry = profile?.tilesets?.[tilesetId];
  if (!entry) return null;
  const out = new Map<number, CondRule[]>();
  const collect = (spec: unknown, side: "above" | "below"): void => {
    if (typeof spec !== "object" || spec === null) return;
    for (const key of Object.keys(spec as Record<string, unknown>).sort((a, b) => +a - +b)) {
      const tile = Number(key);
      const rules = (spec as Record<string, unknown>)[key];
      if (!Number.isFinite(tile) || !Array.isArray(rules)) continue;
      const list = out.get(tile) ?? [];
      for (const rule of rules) {
        const r = rule as { class?: string; rows?: unknown } & Record<string, unknown>;
        const sideList = r[side];
        if (r.class && heights[r.class] !== undefined && Array.isArray(sideList)) {
          const rows = Math.max(1, Number(r.rows) || 1);
          list.push({ side, set: new Set(sideList as number[]), class: r.class, rows });
        }
      }
      if (list.length > 0) out.set(tile, list);
    }
  };
  collect(entry.when_above, "above");
  collect(entry.when_below, "below");
  const cell = entry.when_cell as Record<string, unknown> | undefined;
  if (cell && typeof cell === "object") {
    for (const key of Object.keys(cell).sort((a, b) => +a - +b)) {
      const tile = Number(key);
      const rules = cell[key];
      if (!Number.isFinite(tile) || !Array.isArray(rules)) continue;
      const list = out.get(tile) ?? [];
      for (const rule of rules as { class?: string; walkable?: unknown }[]) {
        if (rule.class && heights[rule.class] !== undefined && typeof rule.walkable === "boolean") {
          list.push({ side: "cell", set: new Set(), class: rule.class, walkable: rule.walkable });
        }
      }
      if (list.length > 0) out.set(tile, list);
    }
  }
  return out.size > 0 ? out : null;
}

// TileShape.lua:606 forMap, the Gen 2 path.
function tileShapesForGen2(map: GameMap, profile: Profile | null): TileShapes {
  const tileset = map.tileset;
  const heights = classHeightsGen2(profile, tileset.id);
  const authored = authoredGroups(profile, tileset.id, heights);
  const count =
    Math.floor((tileset.imageWidth || 128) / 8) * Math.floor((tileset.imageHeight || 48) / 8);

  const flowerTiles = new Set<number>();
  for (const spec of defaultAnimatedTiles(tileset.animation)) {
    if (spec.kind === "frames") flowerTiles.add(spec.tile);
  }

  const classes: Record<string, Shape> = {};
  for (const cls of Object.keys(GEN2_FALLBACK_HEIGHTS)) classes[cls] = shapeForGen2(cls, heights);

  const cond = authoredConditionsGen2(profile, tileset.id, heights);
  const condShape: Record<string, Shape> = {};
  if (cond) {
    for (const rules of cond.values()) {
      for (const rule of rules) condShape[rule.class] ??= shapeForGen2(rule.class, heights, true);
    }
  }

  // TileShape.lua:709-731: the collision-class pins, AUTHORED, for every Gen
  // 2 tileset at once. Unknown class names are dropped (`heights[name]`).
  let coll: Map<number, Shape> | null = null;
  for (const [key, name] of Object.entries(profile?.collision ?? {})) {
    const cls = Number(key);
    if (Number.isFinite(cls) && typeof name === "string" && heights[name] !== undefined) {
      coll ??= new Map();
      coll.set(cls, shapeForGen2(name, heights, true));
    }
  }

  // TileShape.lua:740-767: Gen 2 names water and floor by collision class,
  // so the derived per-tile pins (grassTile, the water and walkable lists)
  // are Gen 1's alone -- a solid tile here is `wall` until a cell rule says
  // otherwise.
  const tiles: (Shape | undefined)[] = [];
  for (let t = 0; t < count; t++) {
    const cls = authored.get(t);
    if (cls) tiles[t] = shapeForGen2(cls, heights, true);
    else if (flowerTiles.has(t)) tiles[t] = shapeForGen2("flower", heights, true);
    else tiles[t] = classes.wall;
  }

  const entry = profile?.tilesets?.[tileset.id];
  return {
    tiles,
    classes,
    cond,
    condShape,
    count,
    gen2: true,
    coll,
    hopLips: entry?.hop_lips === true,
  };
}

// TileShape.lua:794-878 sealedCells -- THE INSIDE OF A MOUNTAIN. Flood the
// open cells in from the map's edge; whatever the flood never reaches is
// not somewhere the game can put the player, so it fills solid -- unless a
// warp or an object stands in it (a walled yard, a locked room). Keyed by
// map (the answer is a property of one map's block layout).
const sealCache = new WeakMap<GameMap, Set<number> | null>();

export function sealedCells(map: GameMap): Set<number> | null {
  const hit = sealCache.get(map);
  if (hit !== undefined) return hit;
  const w = map.def.width * 2;
  const h = map.def.height * 2;
  const sealed = new Set<number>();
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      if (map.isWalkableCell(cx, cy) || map.isWaterCell(cx, cy)) sealed.add(cy * w + cx);
    }
  }
  const queue: number[] = [];
  const seed = (cx: number, cy: number): void => {
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return;
    const k = cy * w + cx;
    if (sealed.has(k)) {
      sealed.delete(k);
      queue.push(k);
    }
  };
  const drain = (): void => {
    while (queue.length > 0) {
      const k = queue.shift()!;
      const cx = k % w;
      const cy = Math.floor(k / w);
      seed(cx - 1, cy);
      seed(cx + 1, cy);
      seed(cx, cy - 1);
      seed(cx, cy + 1);
    }
  };
  for (let cx = 0; cx < w; cx++) {
    seed(cx, 0);
    seed(cx, h - 1);
  }
  for (let cy = 0; cy < h; cy++) {
    seed(0, cy);
    seed(w - 1, cy);
  }
  drain();
  // :846-858 a pocket with a door, or with somebody STANDING in it
  const seeds: number[] = [];
  for (const wp of map.def.warps ?? []) seeds.push(wp.y * w + wp.x);
  for (const obj of (map.def.objects ?? []) as { x?: number; y?: number }[]) {
    const cx = Number(obj.x);
    const cy = Number(obj.y);
    if (Number.isFinite(cx) && Number.isFinite(cy) && cx >= 0 && cy >= 0 && cx < w && cy < h) {
      seeds.push(cy * w + cx);
    }
  }
  for (const k of seeds) {
    if (sealed.has(k)) {
      sealed.delete(k);
      queue.push(k);
    }
  }
  drain();
  const out = sealed.size > 0 ? sealed : null;
  sealCache.set(map, out);
  return out;
}

// TileShape.lua:890 HOP_LIP: which cell a hop class DROPS into, as an
// offset from the lip back to the hop cell. $A0 hops east (the lip is its
// east neighbour), $A1 west, $A3 south; $A4/$A5 are the corners.
const HOP_LIP: [number, number, Set<number>][] = [
  [-1, 0, new Set([0xa0, 0xa4])],
  [1, 0, new Set([0xa1, 0xa5])],
  [0, -1, new Set([0xa3, 0xa4, 0xa5])],
];

// TileShape.lua:1169 THIN: a cell drawn as a thin obstacle is not a block.
const THIN = new Set(["fence", "sign", "post", "billboard"]);

/**
 * TileShape.lua:923 TileShape.at, the Gen 1/Gen 2 tail (:1081-1181):
 * conditional pins, then the hop lip, then authored pins, then the
 * collision-class pin, water, the sealed-pocket fill, walkable ground and
 * the outdoor thin-obstacle rule. (The map editor's overrides and the Gen 3
 * arm above it in the fork have no counterpart in a cook.)
 */
export function shapeAtGen2(
  map: GameMap,
  shapes: TileShapes,
  tile: number,
  tx: number,
  ty: number,
): Shape | undefined {
  const s = shapes.tiles[tile];
  const rules = shapes.cond?.get(tile);
  if (rules) {
    for (const rule of rules) {
      let hit: boolean;
      if (rule.side === "cell") {
        hit = map.isWalkableCell(Math.floor(tx / 2), Math.floor(ty / 2)) === rule.walkable;
      } else {
        const rows = rule.rows ?? 1;
        // NOTE map.tileAt border-EXTENDS (TileShape.lua:1088).
        hit = rule.set.has(map.tileAt(tx, rule.side === "above" ? ty - rows : ty + rows));
      }
      if (hit) return shapes.condShape[rule.class];
    }
  }
  if (!s) return s;
  const cx = Math.floor(tx / 2);
  const cy = Math.floor(ty / 2);
  // :1114-1127 A HOP LIP outranks the tile's own pin: the lip is drawn from
  // the same tiles as the cliff face, so only the neighbour's class knows.
  if (
    shapes.coll &&
    shapes.classes.ledge &&
    (shapes.hopLips || map.outdoor) &&
    !map.isWalkableCell(cx, cy) &&
    !map.isWaterCell(cx, cy)
  ) {
    for (const [dx, dy, set] of HOP_LIP) {
      const c = map.cellCollision(cx + dx, cy + dy);
      if (c !== undefined && set.has(c)) return shapes.classes.ledge;
    }
  }
  if (s.authored) return s;
  // :1129-1152 a stated answer beats a guess: the class pin and water run
  // before the sealed-pocket fill.
  if (shapes.coll) {
    const c = map.cellCollision(cx, cy);
    const cs = c === undefined ? undefined : shapes.coll.get(c);
    if (cs) return cs;
  }
  if (map.isWaterCell(cx, cy)) return shapes.classes.water;
  // (bounds-checked here: the fork indexes cy*w+cx unguarded, which aliases
  // a ring cell west of the map onto the previous row's east edge)
  const sealed = sealedCells(map);
  if (sealed && map.inBounds(cx, cy) && sealed.has(cy * map.def.width * 2 + cx)) {
    return shapes.classes.wall;
  }
  if (map.isWalkableCell(cx, cy)) return shapes.classes.ground;
  // :1158-1180 outdoors, a cell holding an authored fence/sign/post/billboard
  // tile is the ground that thing stands in, not a raised block.
  if (map.outdoor) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const n = shapes.tiles[map.tileAt(cx * 2 + dx, cy * 2 + dy)];
        if (n && n.authored && THIN.has(n.class)) return shapes.classes.ground;
      }
    }
  }
  return s;
}

/** Drop the per-tileset shape cache (tests build synthetic tilesets). */
export function resetTileShapeCache(): void {
  shapesCache.clear();
}

// ---------------------------------------------------------------------------
// tile animation defaults (gen1recomp src/render/TileRenderer.lua:74-328)
// ---------------------------------------------------------------------------

export const WATER_TILE = 0x14;
export const FLOWER_TILE = 0x03;
/** Cumulative pixel offset per animation step (the rrca/rlca sequence). */
export const WATER_OFFSETS = [1, 2, 3, 2, 1, 0, 7, 0];
/** Flower frame per step (wMovingBGTilesCounter2 & 3: <2 -> 1, 2, 3). */
export const FLOWER_FRAMES = [1, 2, 3, 1, 1, 2, 3, 1];
export const ANIM_STEPS = 8;

export type AnimSpec =
  | { kind: "hshift"; tile: number; offsets: number[] }
  | { kind: "frames"; tile: number; sequence: number[] };

// TileRenderer.lua:309 defaultAnimatedTiles (spinner toggles are contextual
// VRAM patches, not ambient animation — not baked).
export function defaultAnimatedTiles(animation: string | undefined): AnimSpec[] {
  const out: AnimSpec[] = [];
  if (animation === "TILEANIM_WATER" || animation === "TILEANIM_WATER_FLOWER") {
    out.push({ kind: "hshift", tile: WATER_TILE, offsets: WATER_OFFSETS });
  }
  if (animation === "TILEANIM_WATER_FLOWER") {
    out.push({ kind: "frames", tile: FLOWER_TILE, sequence: FLOWER_FRAMES });
  }
  return out;
}
