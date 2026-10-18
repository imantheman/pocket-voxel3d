// Voxel staging for a battle: which arena cells the fight is shot on, which
// camera rig frames it, and which atlas pages the two mon cards draw
// (docs/VOXEL.md §4 battle ops). Nothing here moves the player — the camera
// goes to the arena, exactly as upstream (DramaticShapeVoxelMod
// BattleArena.lua:32-36).

import type { VoxelmonData } from "../data.ts";
import type { GameMap } from "../world/map.ts";
import { cardFx, SIDE_ENEMY, SIDE_PLAYER, towardCell } from "./anim.ts";
import { CELL_PX, RIG, RIG_PITCH_MAX_DEG } from "../../../contracts/spec/voxel-spec.ts";
import { search, type Arena } from "./arena.ts";
import type { WildBattle } from "./battle.ts";

export interface BattleStaging {
  /** The map's pak index (the arena op's mapId arg). */
  mapIndex: number;
  arena: Arena;
  /** RIG index: 0 tele, 1 wide (voxel-spec). */
  rig: number;
  /** Where to stand the camera: a Q8 turn around the arena (battleCam). */
  orbit: number;
  /** How high: battleCam's pitch, Q8 of RIG_PITCH_MAX_DEG (0 = the rig's own). */
  pitch: number;
}

export interface CardDesire {
  /** 0 player, 1 enemy (voxel-spec card op). */
  side: number;
  pic: number;
  x: number;
  y: number;
  /** Animation offset from the cell centre, Q4 px (battle/anim.ts). */
  dx: number;
  dy: number;
  dz: number;
}

/**
 * Pic-page accessors against the cooked atlas directory the cooker adds to
 * gamedata (`atlas.picFront` / `atlas.picBack`, keyed by species id).
 * -1 = the page is not cooked (older pak): the caller SKIPS the card op —
 * the ui battle screen must stay fully playable without cards.
 */
interface AtlasDir {
  picFront?: Record<string, number>;
  picBack?: Record<string, number>;
  picTrainer?: Record<string, number>;
  picTitle?: Record<string, number>;
  picIntro?: Record<string, number>;
  picTitleMon?: Record<string, number>;
  picMinigame?: Record<string, number>;
  picPikapic?: Record<string, number>;
}

/**
 * A page the cook named, or -1.
 *
 * `which` is "picTrainer" for a portrait ("prof.oak", "red", "rival1"),
 * "picTitle" for the title art ("logo", "player") or "picIntro" for the
 * boot movie ("gengar1", "flap0", "fist"). A dataset cooked before
 * the cook named them has neither, and the caller falls back to whatever it
 * used to hardcode -- which is right for exactly those old paks.
 */
export function namedPage(
  data: VoxelmonData,
  which: "picTrainer" | "picTitle" | "picIntro" | "picTitleMon" | "picMinigame" | "picPikapic",
  key: string,
): number {
  return atlasOf(data)?.[which]?.[key] ?? -1;
}

function atlasOf(data: VoxelmonData): AtlasDir | undefined {
  return (data as VoxelmonData & { atlas?: AtlasDir }).atlas;
}

export function picPageFor(data: VoxelmonData, speciesId: string): number {
  return atlasOf(data)?.picFront?.[speciesId] ?? -1;
}

export function backPageFor(data: VoxelmonData, speciesId: string): number {
  return atlasOf(data)?.picBack?.[speciesId] ?? -1;
}

/**
 * Where the camera stands for an orbit: the unit direction from the arena
 * midpoint to the eye, in CELLS (the rig's own offset, turned).
 */
export function orbitDir(arena: Arena, rig: number, q8: number): [number, number] {
  const [ex, ey] = arena.enemyCell;
  const [px, py] = arena.playerCell;
  // The mon axis, player -> enemy, in cells; the rig's own frame.
  const axis = Math.atan2(ex - px, -(ey - py));
  const f = [Math.sin(axis), -Math.cos(axis)];
  const s = [-f[1], f[0]];
  const r = rig === 1 ? RIG.wide : RIG.tele;
  // The eye's horizontal offset before the orbit turns it (cam.rs `base`).
  const base = [s[0] * r.side - f[0] * r.back, s[1] * r.side - f[1] * r.back];
  const ang = (q8 / 256) * Math.PI * 2;
  // rotate_y, the core's own sign convention
  const dir = [
    base[0] * Math.cos(ang) + base[1] * Math.sin(ang),
    -base[0] * Math.sin(ang) + base[1] * Math.cos(ang),
  ];
  const len = Math.hypot(dir[0], dir[1]) || 1;
  return [dir[0] / len, dir[1] / len];
}

/**
 * Where the battle camera should look in from, and how high.
 *
 * The rig hangs its eye off the arena midpoint in the mon-axis frame and
 * the orbit turns that offset around (core cam.rs `battle`). From the
 * solved framing the eye can stand behind a house, a stand of trees -- or,
 * indoors, where the wide rig's eye is under two cells off the floor, a
 * bookshelf right in front of a mon -- and the fight opens on the back of
 * it. So every orbit, and a few camera heights, are tried: the sightline
 * from each mon's card up to the eye is walked, and a cell the player
 * cannot walk through (and is not water) that stands taller than the line
 * at that point hides the card. The enemy's card counts double: it is what
 * the opening frame is for. An eye stood low inside the border fill past
 * an edge with no connection (eyeInFill; Gold's maps, whose cook tiles the
 * border block out round them) sees nothing but the fill, so that view is
 * costed out -- the first Gold route's south edge took the solved
 * framing's eye five cells out and opened on its border, not the fight.
 *
 * The guest has no voxel heights (arena.ts), so a blocker is taken to be
 * as tall as the tallest thing the cook stands up off a floor plan: a
 * bookshelf or wall indoors, a house or tree outside. Ties go toward
 * orbit 0 at the rig's own height, so a map with room everywhere still
 * opens on the framing the rig was solved for.
 */
export function chooseView(
  map: GameMap,
  arena: Arena,
  rig: number,
  /** The orbit (Q8 turn) a change is costed from; Gold prefers a three-quarter view. */
  preferQ8 = 0,
): { orbit: number; pitch: number } {
  const preferStep = Math.round(((((preferQ8 % 256) + 256) % 256) * ORBIT_STEPS) / 256) % ORBIT_STEPS;
  const solid = solidGrid(map);
  // The same arena on the same map (its blocks unchanged: the solid grid is
  // held per block version) gets the same view: asked again, answered again.
  const memoKey = `${arena.x},${arena.y},${arena.shape},${arena.enemyCell},${arena.playerCell}|${rig}|${preferQ8}`;
  const memo = solid !== null && typeof solid === "object" ? VIEW_MEMO.get(solid as object) : undefined;
  const held = memo?.get(memoKey);
  if (held) return { orbit: held.orbit, pitch: held.pitch };
  let best = { orbit: Math.round((preferStep * 256) / ORBIT_STEPS), pitch: 0 };
  let bestScore = Number.POSITIVE_INFINITY;
  let bestIdx = Number.POSITIVE_INFINITY;
  const blockerH = rig === 1 ? VIEW_BLOCKER_INDOOR_PX : VIEW_BLOCKER_OUTDOOR_PX;
  // The answer is the lowest score, the first in pitch-then-orbit order on a
  // tie -- the order the views were always tried in. The views are walked
  // cheapest turn-and-lift first instead, so a good one is found early and
  // the rest can be ruled out: hidden cards and the fill only add to a
  // view's turn and lift, so one that cannot beat the best (lower, or equal
  // and earlier) is not walked at all, and its walk stops once it is over.
  // (Every term is a multiple of 1/16, so the sums are exact.)
  for (const c of viewOrder(preferStep)) {
    const { idx, q8, pitchQ8, base } = c;
    const earlier = idx < bestIdx;
    if (base > bestScore || (base === bestScore && !earlier)) continue;
    const eye = eyeOf(arena, rig, q8, pitchQ8);
    const room = bestScore - base;
    // (hits that lose: past the room, or up to it for a later view)
    const enemy = cardHits(map, solid, arena.enemyCell, eye, blockerH, earlier ? Math.floor(room / 2) + 1 : room / 2);
    if (earlier ? enemy * 2 > room : enemy * 2 >= room) continue;
    const left = room - enemy * 2;
    const player = cardHits(map, solid, arena.playerCell, eye, blockerH, earlier ? Math.floor(left) + 1 : left);
    let score = enemy * 2 + player + base;
    if (!(score < bestScore || (score === bestScore && earlier))) continue;
    if (eyeInFill(map, arena, rig, q8, pitchQ8)) score += VIEW_EYE_IN_FILL_COST;
    if (score < bestScore || (score === bestScore && earlier)) {
      bestScore = score;
      bestIdx = idx;
      best = { orbit: q8, pitch: pitchQ8 };
    }
  }
  if (solid !== null && typeof solid === "object") {
    let m = VIEW_MEMO.get(solid as object);
    if (!m) {
      m = new Map();
      VIEW_MEMO.set(solid as object, m);
    }
    m.set(memoKey, best);
  }
  return { orbit: best.orbit, pitch: best.pitch };
}

/**
 * Every (pitch, orbit) chooseView tries, with its place in the old order
 * (`idx`: pitch by pitch, orbit by orbit) and its turn-and-lift cost
 * (`base`), cheapest first (then by idx) -- per preferred orbit, made once.
 */
function viewOrder(preferStep: number): { idx: number; q8: number; pitchQ8: number; base: number }[] {
  let order = VIEW_ORDERS.get(preferStep);
  if (order) return order;
  order = [];
  let idx = 0;
  for (const pitchQ8 of VIEW_PITCHES) {
    for (let step = 0; step < ORBIT_STEPS; step++) {
      const q8 = Math.round((step * 256) / ORBIT_STEPS);
      // The rig was solved at orbit 0 and its own height; changes earn themselves.
      const d = (step - preferStep + ORBIT_STEPS) % ORBIT_STEPS;
      const turn = Math.min(d, ORBIT_STEPS - d) / ORBIT_STEPS;
      order.push({ idx: idx++, q8, pitchQ8, base: turn * ORBIT_TURN_COST + (pitchQ8 / 256) * VIEW_PITCH_COST });
    }
  }
  order.sort((a, b) => a.base - b.base || a.idx - b.idx);
  VIEW_ORDERS.set(preferStep, order);
  return order;
}
const VIEW_ORDERS = new Map<number, { idx: number; q8: number; pitchQ8: number; base: number }[]>();

/** chooseView's answers, per solid grid (a map at one block version), per arena. */
const VIEW_MEMO = new WeakMap<object, Map<string, { orbit: number; pitch: number }>>();

/**
 * sightlineHits' count for one card, written out for chooseView: the same
 * samples, the same cells, the same blocking test -- stopping once the line
 * stands taller than any blocker (it only climbs, from the card's middle up
 * to an eye above it) or once `stopAt` hits are counted (enough to lose).
 */
function cardHits(
  map: GameMap,
  solid: ArrayLike<number> | null,
  mon: readonly [number, number] | number[],
  at: { x: number; y: number; h: number },
  blockerH: number,
  stopAt: number,
): number {
  const sw = map.widthCells;
  const sh = map.heightCells;
  // a map that answers the grid is Gold's, whose inBounds is the rectangle
  const fast = solid !== null && solid.length === sw * sh;
  const cx0 = mon[0]! + 0.5;
  const cy0 = mon[1]! + 0.5;
  const dx = at.x + 0.5 - cx0;
  const dy = at.y + 0.5 - cy0;
  const eyeH = at.h;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / VIEW_SAMPLE_CELLS));
  const climbs = eyeH > VIEW_CARD_PX;
  let last = NaN;
  let hits = 0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const qx = cx0 + dx * t;
    const qy = cy0 + dy * t;
    const x = Math.floor(qx);
    const y = Math.floor(qy);
    const key = x * 4096 + y;
    if (key === last) continue;
    last = key;
    const lineH = VIEW_CARD_PX + (eyeH - VIEW_CARD_PX) * t;
    if (!(lineH < blockerH)) {
      // climbing, it never comes back under
      if (climbs) break;
      continue;
    }
    let blocked: boolean;
    if (fast) blocked = x >= 0 && y >= 0 && x < sw && y < sh && solid![y * sw + x] === 1;
    else if (!map.inBounds(x, y)) blocked = false;
    else if (solid) blocked = solid[y * sw + x] === 1;
    else blocked = !map.isWalkableCell(x, y) && !map.isWaterCell(x, y);
    if (blocked) {
      hits++;
      if (hits >= stopAt) return hits;
    }
  }
  return hits;
}

/**
 * Where the battle camera's eye stands for an orbit and pitch: its cell
 * (fractional, from the arena midpoint along orbitDir) and its height in px
 * -- cam.rs `battle`, extra elevation on the same eye distance.
 */
export function eyeOf(arena: Arena, rig: number, orbitQ8: number, pitchQ8: number): { x: number; y: number; h: number } {
  const [ex, ey] = arena.enemyCell;
  const [px, py] = arena.playerCell;
  const r = rig === 1 ? RIG.wide : RIG.tele;
  const hLen = Math.hypot(r.side, r.back);
  const len = Math.hypot(hLen, r.height);
  const e = Math.min(
    Math.atan2(r.height, hLen) + (pitchQ8 / 256) * ((RIG_PITCH_MAX_DEG * Math.PI) / 180),
    0.49 * Math.PI,
  );
  const eyeD = (len * Math.cos(e)) / CELL_PX; // cells out from the midpoint
  const [ux, uy] = orbitDir(arena, rig, orbitQ8);
  return { x: (ex + px) / 2 + ux * eyeD, y: (ey + py) / 2 + uy * eyeD, h: len * Math.sin(e) };
}

/**
 * Whether the eye stands low inside the fill the voxel world builds past an
 * edge of the map with no connection: `map.borderFillCells()` cells of the
 * map's border block (Gold's cook tiles it out round every map; a Kanto map
 * answers nothing -- its cook stands only a tree hull there, which the host
 * culls in front of the camera). Low is under a blocker's height. The fill
 * is missing only alongside a connected neighbour (the map's
 * connectionCovers), and a corner is filled unless a neighbour on either
 * side reaches it.
 */
export function eyeInFill(map: GameMap, arena: Arena, rig: number, orbitQ8: number, pitchQ8: number): boolean {
  const fillOf = (map as unknown as { borderFillCells?: () => number }).borderFillCells;
  const fill = typeof fillOf === "function" ? fillOf.call(map) : 0;
  if (!(fill > 0)) return false;
  const eye = eyeOf(arena, rig, orbitQ8, pitchQ8);
  if (eye.h >= (rig === 1 ? VIEW_BLOCKER_INDOOR_PX : VIEW_BLOCKER_OUTDOOR_PX)) return false;
  const x = Math.floor(eye.x);
  const y = Math.floor(eye.y);
  if (map.inBounds(x, y)) return false;
  // Whether a connected map stands past `dir` at cell `along` of that side
  // (a row for west/east, a column for north/south): the host drops the
  // fill only alongside the neighbour, and keeps it on the rest of a side
  // a shorter connection leaves open (main.rs RingClip).
  const m = map as unknown as {
    connection?: (d: string) => unknown;
    connectionCovers?: (d: string, along: number) => boolean;
  };
  const covered = (dir: string, along: number): boolean => {
    if (typeof m.connectionCovers === "function") return m.connectionCovers.call(map, dir, along);
    return typeof m.connection === "function" ? !!m.connection.call(map, dir) : false;
  };
  // the far edges by inBounds along the arena's row and column
  const [ax, ay] = arena.enemyCell;
  const past = (inside: (d: number) => boolean): number => {
    for (let d = 1; d <= fill + 1; d++) if (inside(d)) return d;
    return fill + 1;
  };
  const north = y < 0 && -y <= fill;
  const south = y >= 0 && !map.inBounds(ax, y) && past((d) => map.inBounds(ax, y - d)) <= fill;
  const west = x < 0 && -x <= fill;
  const east = x >= 0 && !map.inBounds(x, ay) && past((d) => map.inBounds(x - d, ay)) <= fill;
  if (!(north || south || west || east)) return false;
  // a corner is the neighbour's if either side's neighbour reaches it
  return !((north && covered("north", x)) || (south && covered("south", x))
    || (west && covered("west", y)) || (east && covered("east", y)));
}

/**
 * How many blocking cells stand taller than the sightline from each mon's
 * card up to the battle camera's eye, for this orbit and pitch (see
 * chooseView for the model).
 */
export function sightlineHits(
  map: GameMap,
  arena: Arena,
  rig: number,
  orbitQ8: number,
  pitchQ8: number,
  /** solidGrid(map), when the caller asks many lines of one map. */
  solid: ArrayLike<number> | null = solidGrid(map),
): { enemy: number; player: number } {
  const blockerH = rig === 1 ? VIEW_BLOCKER_INDOOR_PX : VIEW_BLOCKER_OUTDOOR_PX;
  const sw = map.widthCells;
  const blocked = (cx: number, cy: number): boolean => {
    const x = Math.floor(cx);
    const y = Math.floor(cy);
    if (!map.inBounds(x, y)) return false; // off the map: nothing to block
    if (solid) return solid[y * sw + x] === 1;
    return !map.isWalkableCell(x, y) && !map.isWaterCell(x, y);
  };
  const at = eyeOf(arena, rig, orbitQ8, pitchQ8);
  const eye = [at.x, at.y];
  const eyeH = at.h;
  const count = (mon: readonly [number, number] | number[]): number => {
    const cx0 = mon[0]! + 0.5;
    const cy0 = mon[1]! + 0.5;
    const dx = eye[0]! + 0.5 - cx0;
    const dy = eye[1]! + 0.5 - cy0;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / VIEW_SAMPLE_CELLS));
    // Each cell counts once. Along a straight line both cell coordinates
    // only ever move one way, so a cell once left is never met again: the
    // last cell is all there is to remember.
    let last = NaN;
    let hits = 0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const qx = cx0 + dx * t;
      const qy = cy0 + dy * t;
      const key = Math.floor(qx) * 4096 + Math.floor(qy);
      if (key === last) continue;
      last = key;
      // the line's height over this cell, from the card's middle up to the eye
      const lineH = VIEW_CARD_PX + (eyeH - VIEW_CARD_PX) * t;
      if (lineH < blockerH && blocked(qx, qy)) hits++;
    }
    return hits;
  };
  return { enemy: count(arena.enemyCell), player: count(arena.playerCell) };
}

/** "Blocks a sightline" for every cell, from a map that can answer it in
 *  one pass (Gold's, gen2/world/Map.ts solidCells); null asks cell by cell. */
function solidGrid(map: GameMap): ArrayLike<number> | null {
  const solidOf = (map as unknown as { solidCells?: () => ArrayLike<number> }).solidCells;
  return typeof solidOf === "function" ? solidOf.call(map) : null;
}

/** chooseView's orbit, for callers that only turn. */
export function chooseOrbit(map: GameMap, arena: Arena, rig: number): number {
  return chooseView(map, arena, rig).orbit;
}

/** How many ways round the arena the camera may be stood. */
const ORBIT_STEPS = 8;
/** What a half-turn away from the solved framing is worth putting up with. */
const ORBIT_TURN_COST = 1.5;
/** Camera heights tried (battleCam pitch, Q8 of RIG_PITCH_MAX_DEG). */
const VIEW_PITCHES = [0, 64, 128, 192];
/** What lifting the camera all the way is worth putting up with. */
const VIEW_PITCH_COST = 1.0;
/** Sightline sampling step, in cells. */
const VIEW_SAMPLE_CELLS = 0.25;
/** Where on a card the line is aimed: its middle, px off the floor. */
const VIEW_CARD_PX = 14;
/** How tall a blocking cell is taken to be (two voxel blocks; a house/tree). */
const VIEW_BLOCKER_INDOOR_PX = 40;
const VIEW_BLOCKER_OUTDOOR_PX = 56;
/** What an eye stood low in the border fill costs (eyeInFill): more than a
 *  card hidden behind a few blockers, since it sees nothing at all. */
const VIEW_EYE_IN_FILL_COST = 8;

/**
 * Stage a wild battle on the current map: BattleArena.search from the
 * player's cell (v1: no authored table, no clearance walk — arena.ts), rig
 * tele by default, wide when the map is indoor. The v1 indoor test is
 * `tileset != OVERWORLD` (the dataset's field/darkMaps hints are a later
 * refinement).
 */
export function computeStaging(
  map: GameMap,
  playerCellX: number,
  playerCellY: number,
  surfing: boolean,
): BattleStaging | null {
  const arena = search(map, playerCellX, playerCellY, surfing);
  if (!arena) return null;
  const indoor = map.def.tileset !== "OVERWORLD";
  const rig = indoor ? 1 : 0; // RIG.tele / RIG.wide order in the spec
  const view = chooseView(map, arena, rig);
  return {
    mapIndex: map.def.index,
    arena,
    rig,
    orbit: view.orbit,
    pitch: view.pitch,
  };
}

/**
 * The cards the staging wants THIS tick: the enemy's front pic from battle
 * start (the wild mon is already on the field — pokered's wild intro), the
 * player mon's back pic once sent out, each dropped on faint/catch. A -1
 * page skips the card (accessor contract above).
 */
export function desiredCards(
  data: VoxelmonData,
  battle: WildBattle,
  staging: BattleStaging,
): CardDesire[] {
  const out: CardDesire[] = [];
  const [ex, ey] = staging.arena.enemyCell;
  const [px, py] = staging.arena.playerCell;
  const anims = battle.anims;
  // A card sinking through its faint slide has to keep drawing past the
  // `fainted` gate below until the slide finishes (battle/anim.ts).
  const fainting = (side: number) =>
    anims.some((a) => a.side === side && a.kind === "faint");
  const [towardPlayerX, towardPlayerZ] = towardCell([ex, ey], [px, py]);
  // BattleState.lua:5283 — the draw gate reads enemyHidden too, so the ball
  // chain's HIDEPIC row takes the wild mon off the field while it shakes
  if (
    battle.enemy &&
    (!battle.enemy.fainted || fainting(SIDE_ENEMY)) &&
    !battle.enemyHidden &&
    battle.result !== "caught"
  ) {
    // The disguise swaps the pic with the name: battle/front/ghost, cooked
    // into every pak alongside the species pics and named GHOST by the cook.
    const pic = picPageFor(data, battle.disguised ? "GHOST" : battle.enemy.mon.species);
    const fx = cardFx(anims, SIDE_ENEMY, towardPlayerX, towardPlayerZ);
    if (pic >= 0 && !fx.hidden) {
      out.push({ side: SIDE_ENEMY, pic, x: ex, y: ey, dx: fx.dx, dy: fx.dy, dz: fx.dz });
    }
  }
  if (
    battle.player &&
    (!battle.player.fainted || fainting(SIDE_PLAYER)) &&
    !battle.showPlayerBack &&
    !battle.sendingOut
  ) {
    // Front-facing sprites on both sides for now (was backPageFor).
    const pic = picPageFor(data, battle.player.mon.species);
    const fx = cardFx(anims, SIDE_PLAYER, -towardPlayerX, -towardPlayerZ);
    if (pic >= 0 && !fx.hidden) {
      out.push({ side: SIDE_PLAYER, pic, x: px, y: py, dx: fx.dx, dy: fx.dy, dz: fx.dz });
    }
  }
  return out;
}
