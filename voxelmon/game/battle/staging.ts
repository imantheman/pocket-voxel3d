// Voxel staging for a battle: which arena cells the fight is shot on, which
// camera rig frames it, and which atlas pages the two mon cards draw
// (docs/VOXEL.md §4 battle ops). Nothing here moves the player — the camera
// goes to the arena, exactly as upstream (DramaticShapeVoxelMod
// BattleArena.lua:32-36).

import type { VoxelmonData } from "../data.ts";
import type { GameMap } from "../world/map.ts";
import { cardFx, SIDE_ENEMY, SIDE_PLAYER, towardCell } from "./anim.ts";
import { RIG } from "../../../contracts/spec/voxel-spec.ts";
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
  which: "picTrainer" | "picTitle" | "picIntro" | "picTitleMon" | "picMinigame",
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
 * Which way the battle camera should look in from.
 *
 * The rig hangs its eye off the arena midpoint in the mon-axis frame and
 * the orbit turns that offset around (core cam.rs `battle`). At orbit 0 it
 * can end up behind a house, a cliff or a stand of trees -- the fight then
 * opens on the back of a wall -- so the sides are tried and the clearest
 * one wins.
 *
 * What counts as blocking is what the player cannot walk through and is
 * not water: buildings, trees, rock faces. That is a floor plan, not the
 * voxel heights (the guest has none, arena.ts), but it is what stands up
 * off the ground on this map, which is what gets between a camera and a
 * battle. Ties go toward orbit 0, so a map with room everywhere still
 * opens on the framing the rig was solved for.
 */
export function chooseOrbit(map: GameMap, arena: Arena, rig: number): number {
  const [ex, ey] = arena.enemyCell;
  const [px, py] = arena.playerCell;
  const mid = [(ex + px) / 2, (ey + py) / 2];
  const blocked = (cx: number, cy: number): boolean => {
    const x = Math.round(cx);
    const y = Math.round(cy);
    if (!map.inBounds(x, y)) return false; // off the map: nothing to block
    return !map.isWalkableCell(x, y) && !map.isWaterCell(x, y);
  };
  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let step = 0; step < ORBIT_STEPS; step++) {
    const q8 = Math.round((step * 256) / ORBIT_STEPS);
    const [ux, uy] = orbitDir(arena, rig, q8);
    let score = 0;
    // Out along the sightline, and a cell to either side of it: the view
    // is a cone, not a thread. Near blockers cost more -- a wall against
    // the arena hides the fight, one ten cells out is scenery.
    for (let d = 1; d <= ORBIT_REACH_CELLS; d++) {
      const w = 1 + (ORBIT_REACH_CELLS - d) / ORBIT_REACH_CELLS;
      for (const side of [0, 1, -1]) {
        const cx = mid[0] + ux * d - uy * side;
        const cy = mid[1] + uy * d + ux * side;
        if (blocked(cx, cy)) score += side === 0 ? w * 2 : w;
      }
    }
    // The rig was solved at orbit 0; a turn has to earn itself.
    const turn = Math.min(step, ORBIT_STEPS - step) / ORBIT_STEPS;
    score += turn * ORBIT_TURN_COST;
    if (score < bestScore) {
      bestScore = score;
      best = q8;
    }
  }
  return best;
}

/** How many ways round the arena the camera may be stood. */
const ORBIT_STEPS = 8;
/** How far down the sightline blockers are counted, in cells. */
const ORBIT_REACH_CELLS = 8;
/** What a half-turn away from the solved framing is worth putting up with. */
const ORBIT_TURN_COST = 2.0;

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
  return {
    mapIndex: map.def.index,
    arena,
    rig,
    orbit: chooseOrbit(map, arena, rig),
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
