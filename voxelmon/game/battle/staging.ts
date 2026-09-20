// Voxel staging for a battle: which arena cells the fight is shot on, which
// camera rig frames it, and which atlas pages the two mon cards draw
// (docs/VOXEL.md §4 battle ops). Nothing here moves the player — the camera
// goes to the arena, exactly as upstream (DramaticShapeVoxelMod
// BattleArena.lua:32-36).

import type { VoxelmonData } from "../data.ts";
import type { GameMap } from "../world/map.ts";
import { cardFx, SIDE_ENEMY, SIDE_PLAYER, towardCell } from "./anim.ts";
import { search, type Arena } from "./arena.ts";
import type { WildBattle } from "./battle.ts";

export interface BattleStaging {
  /** The map's pak index (the arena op's mapId arg). */
  mapIndex: number;
  arena: Arena;
  /** RIG index: 0 tele, 1 wide (voxel-spec). */
  rig: number;
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
}

/**
 * A page the cook named, or -1.
 *
 * `which` is "picTrainer" for a portrait ("prof.oak", "red", "rival1") or
 * "picTitle" for the title art ("logo", "player"). A dataset cooked before
 * the cook named them has neither, and the caller falls back to whatever it
 * used to hardcode -- which is right for exactly those old paks.
 */
export function namedPage(
  data: VoxelmonData,
  which: "picTrainer" | "picTitle",
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
  return {
    mapIndex: map.def.index,
    arena,
    rig: indoor ? 1 : 0, // RIG.tele / RIG.wide order in the spec
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
    const pic = picPageFor(data, battle.enemy.mon.species);
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
