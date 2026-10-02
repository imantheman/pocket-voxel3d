// Gold's 3D battles: while the battle screen is up and the world is behind
// it, the fight is staged in the voxel world the way the Kanto games stage
// theirs (voxelmon/game/battle/staging.ts) -- an arena found near the
// player, a camera rig that sees both sides, and each active mon standing
// in it as a card in its own battle colours. The battle screen then leaves
// its field open (BattleState.staged3d) and draws only the HUDs, the text
// box and the menus over the arena.
//
// The arena search and the camera choice are the Kanto ones: Gold's Map
// answers the same per-cell questions (inBounds, isWalkableCell, ...).
// Not the cart's: the Game Boy had no world to stand a battle in.

import type { VoxelHost } from "../../host.ts";
import { search, type Arena } from "../../battle/arena.ts";
import { chooseView } from "../../battle/staging.ts";
import type { GameMap } from "../../world/map.ts";
import { Map as GoldMap } from "../world/Map.ts";
import { FieldMoves } from "../world/FieldMoves.ts";
import { is2d } from "../../viewmode.ts";

const SIDE_PLAYER = 0;
const SIDE_ENEMY = 1;
const Q8 = 256;
// The text box and the menus are on the bottom screen (ui/Companion.ts's
// battle page), as in the Kanto games' 3D battles, so the shot is centred
// as the Kanto rig centres it -- no lift to clear a box over the bottom.
const BATTLE_ZOOM = Q8;
const BATTLE_LIFT = 0;
// and, under a roof, stood further off (the 3DS host draws at a fixed fov,
// so the rig's zoom does not widen the shot; distance does). The outdoor
// rig already stands well back.
const BATTLE_DIST = [Q8, Math.round(Q8 * 1.7)] as const; // by rig: tele, wide
// An eighth of a turn round from straight over the shoulder: the mons then
// stand diagonally -- the enemy far and high, the player nearer and lower --
// as the cart's layout has them, instead of one in front of the other.
// (A preference: chooseView turns away from whatever blocks the sightlines,
// so either side can come up; the HUDs keep to the top and bottom edges,
// clear of the cards, whichever it is -- BattleState.drawHud.)
const BATTLE_ORBIT = 32;

export interface StageData {
  maps?: Record<string, { index: number }>;
  atlas?: { picFront?: Record<string, number>; picBack?: Record<string, number>; picTrainer?: Record<string, number> };
}

type Rgb = readonly number[];

function rgb555(c: Rgb | undefined): number {
  const [r = 0, g = 0, b = 0] = c ?? [];
  return ((r >> 3) & 31) | (((g >> 3) & 31) << 5) | (((b >> 3) & 31) << 10);
}

export class BattleStage {
  private active = false;
  /** The battle screen the log last named (one line a battle). */
  private logged: unknown = null;
  private arena: Arena | null = null;
  private shown: (string | null)[] = [null, null];
  private palShown: (string | null)[] = [null, null];

  constructor(
    private readonly host: VoxelHost,
    private readonly data: StageData | null | undefined,
  ) {}

  /** The battle screen on the stack, if any. */
  private battleState(game: any): any {
    const states: any[] = game?.stack?.states ?? [];
    for (let i = states.length - 1; i >= 0; i--) {
      if (states[i] && states[i].screenId === "Gen2BattleState") return states[i];
    }
    return null;
  }

  /**
   * Stage (or keep staging, or take down) the battle for this frame. True
   * while a battle is staged: the world view then leaves the camera and the
   * field actors to the battle.
   */
  /** Would this frame stage a battle in 3D (one is up, BATTLES is 3D, a world is behind it)? */
  wanted(game: any): boolean {
    return !is2d(game?.options?.battleView) && !!this.battleState(game) && !!game?.world?.map;
  }

  emit(game: any, palettes: any): boolean {
    const st = this.battleState(game);
    const world = game?.world;
    if (st && st !== this.logged) {
      // one line a battle, to the card's log: what the options said as it
      // began (Isaac's BATTLES 2D came up staged in 3D on hardware only)
      this.logged = st;
      const o = game?.options ?? {};
      console.log(`[pv] gold battle: view ${String(o.view)} battles ${String(o.battleView)} options ${o === game?.save?.options ? "same" : "apart"} -> ${is2d(o.battleView) ? "2D" : "3D stage"}`);
    }
    if (!st || !world?.map || !world.player || is2d(game?.options?.battleView)) {
      this.end();
      return false;
    }
    if (!this.active) {
      this.active = true;
      this.arena = this.stage(world);
      st.staged3d = this.arena !== null;
    }
    if (!this.arena) return false;
    this.emitCard(st, SIDE_ENEMY, palettes, this.arena.enemyCell);
    this.emitCard(st, SIDE_PLAYER, palettes, this.arena.playerCell);
    return true;
  }

  private stage(world: any): Arena | null {
    const map = world.map;
    const mapIndex = this.data?.maps?.[map.id]?.index;
    if (mapIndex === undefined) return null;
    const surfing = !!FieldMoves.isSurfing(world.playerState);
    const arena = search(map as unknown as GameMap, world.player.cellX, world.player.cellY, surfing);
    if (!arena) return null;
    const rig = GoldMap.isOutside(map.def) ? 0 : 1; // RIG tele outdoors, wide under a roof
    const view = chooseView(map as unknown as GameMap, arena, rig, BATTLE_ORBIT);
    console.log(`[pv] gold battle cam: orbit ${view.orbit} pitch ${view.pitch} rig ${rig} (prefer ${BATTLE_ORBIT}) enemy ${arena.enemyCell} player ${arena.playerCell}`);
    this.host.arena(mapIndex, arena.x, arena.y, arena.shape, rig);
    this.host.battleCam(view.orbit, view.pitch, BATTLE_ZOOM, BATTLE_LIFT, BATTLE_DIST[rig]);
    return arena;
  }

  /** The side's mon as a card, or nothing while the battle screen hides its pic. */
  private emitCard(st: any, side: number, palettes: any, cell: [number, number]): void {
    const name = side === SIDE_ENEMY ? "enemy" : "player";
    let mon: any;
    try {
      mon = st.activeMon(name);
    } catch {
      mon = null;
    }
    // The trainers' own pics while the battle screen shows them (the enemy's
    // frontpic until EnemySwitch slides it out, the player's until the
    // send-out), each through its class's palette, as Kanto's 3D battles
    // stand them: the player is CAL, the class pokegold draws with the
    // player's own pic.
    const trainerKey = side === SIDE_ENEMY
      ? (st.showEnemyTrainer ? picKey(st.enemyTrainerPath) : undefined)
      : (st.showPlayerTrainer ? "cal" : undefined);
    if (trainerKey !== undefined && !st.picBoxCleared?.(name)) {
      const tpage = this.data?.atlas?.picTrainer?.[trainerKey];
      if (tpage !== undefined) {
        const cls = side === SIDE_ENEMY ? st.enemyTrainerClass : "PLAYER";
        this.showCard(side, tpage, cell, palettes?.trainers?.[cls], `trainer:${cls}`);
        return;
      }
    }
    const hidden =
      !mon ||
      !mon.species ||
      (side === SIDE_ENEMY && st.showEnemyTrainer) ||
      (side === SIDE_PLAYER && st.showPlayerTrainer) ||
      st.picBoxCleared?.(name) ||
      st.isUnderground?.(name, mon) ||
      (side === SIDE_PLAYER && st.showPlayerHud === undefined && !st.playerSentOut && st.slidingBackpic);
    // Front pics on both sides, as the Kanto battles stand them: a card
    // faces the camera, and a back sprite read as a mon facing away.
    const page = hidden ? undefined : this.data?.atlas?.picFront?.[mon.species];
    if (page === undefined) {
      if (this.shown[side] !== null) {
        this.host.cardHide(side);
        this.shown[side] = null;
      }
      return;
    }
    const pal = palettes?.pokemon?.[mon.species]?.[mon.shiny ? "shiny" : "normal"];
    this.showCard(side, page, cell, pal, `${mon.species}:${mon.shiny ? 1 : 0}`);
  }

  /** A card on `side`: `page` at `cell`, its two middle colours `pal` (white and black around them). */
  private showCard(side: number, page: number, cell: [number, number], pal: any, palId: string): void {
    const palKey = pal ? palId : "none";
    if (palKey !== this.palShown[side]) {
      if (pal) this.host.cardPal?.(side, rgb555([255, 255, 255]), rgb555(pal[0]), rgb555(pal[1]), rgb555([0, 0, 0]));
      else this.host.cardPal?.(side, -1, 0, 0, 0);
      this.palShown[side] = palKey;
    }
    const key = `${page},${cell[0]},${cell[1]}`;
    if (key !== this.shown[side]) {
      this.host.card(side, page, cell[0], cell[1], 0, 0, 0);
      this.shown[side] = key;
    }
  }

  /** The battle is over: take the stage down. */
  end(): void {
    if (!this.active) return;
    this.active = false;
    for (const side of [SIDE_PLAYER, SIDE_ENEMY]) {
      if (this.shown[side] !== null) this.host.cardHide(side);
      this.shown[side] = null;
      this.palShown[side] = null;
    }
    if (this.arena) this.host.arenaEnd();
    this.arena = null;
  }
}

/** A trainer pic's atlas key out of its asset path: battle/trainers/falkner(.png) -> falkner. */
function picKey(path: unknown): string | undefined {
  if (typeof path !== "string" || path === "") return undefined;
  return path.replace(/\.png$/, "").replace(/^.*\//, "");
}
