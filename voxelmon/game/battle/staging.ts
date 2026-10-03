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
 * the opening frame is for.
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
  let best = { orbit: Math.round((preferStep * 256) / ORBIT_STEPS), pitch: 0 };
  let bestScore = Number.POSITIVE_INFINITY;
  const solid = solidGrid(map);
  for (const pitchQ8 of VIEW_PITCHES) {
    for (let step = 0; step < ORBIT_STEPS; step++) {
      const q8 = Math.round((step * 256) / ORBIT_STEPS);
      const hits = sightlineHits(map, arena, rig, q8, pitchQ8, solid);
      // The rig was solved at orbit 0 and its own height; changes earn themselves.
      const d = (step - preferStep + ORBIT_STEPS) % ORBIT_STEPS;
      const turn = Math.min(d, ORBIT_STEPS - d) / ORBIT_STEPS;
      const score = hits.enemy * 2 + hits.player + turn * ORBIT_TURN_COST + (pitchQ8 / 256) * VIEW_PITCH_COST;
      if (score < bestScore) {
        bestScore = score;
        best = { orbit: q8, pitch: pitchQ8 };
      }
    }
  }
  return best;
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
  const [ex, ey] = arena.enemyCell;
  const [px, py] = arena.playerCell;
  const mid = [(ex + px) / 2, (ey + py) / 2];
  const blockerH = rig === 1 ? VIEW_BLOCKER_INDOOR_PX : VIEW_BLOCKER_OUTDOOR_PX;
  const sw = map.widthCells;
  const blocked = (cx: number, cy: number): boolean => {
    const x = Math.floor(cx);
    const y = Math.floor(cy);
    if (!map.inBounds(x, y)) return false; // off the map: nothing to block
    if (solid) return solid[y * sw + x] === 1;
    return !map.isWalkableCell(x, y) && !map.isWaterCell(x, y);
  };
  const r = rig === 1 ? RIG.wide : RIG.tele;
  const hLen = Math.hypot(r.side, r.back);
  const len = Math.hypot(hLen, r.height);
  // cam.rs: extra elevation on the same eye distance
  const e = Math.min(
    Math.atan2(r.height, hLen) + (pitchQ8 / 256) * ((RIG_PITCH_MAX_DEG * Math.PI) / 180),
    0.49 * Math.PI,
  );
  const eyeD = (len * Math.cos(e)) / CELL_PX; // cells out from the midpoint
  const eyeH = len * Math.sin(e); // px up
  const [ux, uy] = orbitDir(arena, rig, orbitQ8);
  const eye = [mid[0] + ux * eyeD, mid[1] + uy * eyeD];
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
