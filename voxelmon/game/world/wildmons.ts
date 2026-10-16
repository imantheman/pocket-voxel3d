// VISIBLE WILD's runtime (the rules are ../visiblewild.ts): the wild mons
// standing about a map, spawned from its encounter tables, wandering, and
// touched into battle.
//
//   spawning     round the player (the WINDOW), never within NEAR cells of
//                them, never in a cell anyone stands in or is stepping into,
//                never beside a person. A map's cells are worked out a few
//                rows a tick once it is entered (under a second for the
//                biggest), then up to the count at once, and one every
//                second or two while under it.
//   wandering    a step (24 frames, slower than a person) every second or
//                three, onto cells of their own kind only -- grass stays on
//                grass, water on water -- with a small lean towards a
//                player close by; never onto a warp, a lane or the edge row
//                (classifyCells keeps those out of the set). People do not
//                walk into them (the NPCs' entity list has them); the player
//                can, and that is the touch.
//   the touch    the player's body and a mon's within 12 px either way --
//                walking into one, it walking into the player, or a free
//                walk brushing it -- or A pressed facing one. It starts the
//                ordinary wild battle with that species and level
//                (shell.pushStubBattle, the step roll's own hand-off: the
//                SAFARI ZONE's battle inside a safari game) and the mon is
//                gone, whatever the battle's end.
//   going        past FAR cells from the player; or, its time up (30-60 s),
//                once four or more cells away. A map change clears them all;
//                nothing is saved, so a loaded game starts with a new set.
//   frozen       while a script, a scripted walk, an emote, a trainer's
//                walk-up or a warp is under way: no step, no spawn, no touch.
//   off          the setting OFF, WILD ENCOUNTERS NONE, or a link up: none.
//
// The mons are not NPCs: they are drawn into the entity slots the map's own
// people leave free (scene.ts, view2d.ts), so no script, sight line or talk
// ever finds one.

import { ENTS_MAX } from "../../../contracts/spec/voxel-spec.ts";
import type { EncounterDef, VoxelmonData } from "../data.ts";
import { wildMode } from "../extras.ts";
import { seededRng, type Rng } from "../rng.ts";
import { repelled } from "../rules/items.ts";
import {
  CELL_LAND, CELL_WATER, CellClassifier, FAR, NEAR, WILD_STEP_FRAMES, WINDOW_X, WINDOW_Y, landTable,
  lifetime, pickSlot, respawnDelay, visibleWildMode, wanderDelay, waterTable, wildSprite, wildTarget,
  type IndoorRule,
} from "../visiblewild.ts";
import { canMove, DELTA, type Dir, type Mover, type TilePairs } from "./collision.ts";
import type { GameMap } from "./map.ts";

const DIRS: readonly Dir[] = ["up", "down", "left", "right"];

/** One wild mon on the map. */
export class WildMon implements Mover {
  cellX: number;
  cellY: number;
  px: number;
  py: number;
  facing: Dir;
  moving = false;
  progress = 0;
  stepFlip = false;
  targetX?: number;
  targetY?: number;
  /** A water mon rides the water cells (collision.ts canMove's rule). */
  readonly surfing: boolean;
  /** Frames to the next wander decision, and left to live. */
  timer: number;
  life: number;
  /** The idle hop's clock, started at a random phase so they bob apart. */
  private clock: number;

  constructor(
    readonly species: string,
    readonly level: number,
    readonly sprite: string,
    readonly kind: number,
    cx: number,
    cy: number,
    facing: Dir,
    timer: number,
    life: number,
    clock: number,
  ) {
    this.cellX = cx;
    this.cellY = cy;
    this.px = cx * 16;
    this.py = cy * 16;
    this.facing = facing;
    this.surfing = kind === CELL_WATER;
    this.timer = timer;
    this.life = life;
    this.clock = clock;
  }

  /** The walk cycle's half, as NPC.walkPhase. */
  walkPhase(): 0 | 1 {
    if (!this.moving) return 0;
    const p = (this.progress * 16 / WILD_STEP_FRAMES) % 16;
    return p >= 4 && p < 12 ? 1 : 0;
  }

  /** Pixels off the ground: a little hop with every step, and a one-pixel
   *  bob now and then standing (the party menu's icons never stand still
   *  either). */
  get lift(): number {
    if (this.moving) return Math.round(2 * Math.sin((Math.PI * this.progress) / WILD_STEP_FRAMES));
    return this.clock % 64 < 8 ? 1 : 0;
  }

  /** One frame of a step under way (and the idle clock). */
  advance(): void {
    this.clock = (this.clock + 1) & 0xffff;
    if (!this.moving) return;
    this.progress += 1;
    const d = DELTA[this.facing];
    const moved = Math.floor((this.progress * 16) / WILD_STEP_FRAMES);
    this.px = this.cellX * 16 + d[0] * moved;
    this.py = this.cellY * 16 + d[1] * moved;
    if (this.progress >= WILD_STEP_FRAMES) {
      this.cellX = this.targetX!;
      this.cellY = this.targetY!;
      this.targetX = this.targetY = undefined;
      this.px = this.cellX * 16;
      this.py = this.cellY * 16;
      this.moving = false;
      this.progress = 0;
      this.stepFlip = !this.stepFlip;
    }
  }
}

/** What the mons need of the overworld (world/overworld.ts has it all). */
export interface WildWorld {
  map: GameMap;
  player: Mover & { px: number; py: number; facing: Dir; surfing?: boolean };
  npcs: readonly (Mover & { hidden?: boolean })[];
  entities: readonly Mover[];
  tilePairs: TilePairs;
  link: unknown;
  shell: {
    data: VoxelmonData;
    save: unknown;
    pushStubBattle(species: string, level: number): void;
  };
}

/** Touching distance, px either way: a body two-thirds into the cell. */
export const TOUCH_PX = 12;

/** Cells classified a tick after a map's entry (whole rows): the forest's
 *  1632 cells take about half a second, no frame more than a sliver. The
 *  whole map at once was half a second in ONE frame on the console. */
export const CLASSIFY_CELLS = 48;

export class VisibleWild {
  mons: WildMon[] = [];
  /** Battles a touch has started (the tests and the benches count them). */
  battles = 0;
  /** The last mon touched into a battle. */
  lastBattle?: { species: string; level: number };
  private classifier: CellClassifier | null = null;
  private cellsMap: GameMap | null = null;
  /** Per-cell marks for a spawn's pick (someone there, or a person beside
   *  it), set and cleared around each pick; and its candidate list. */
  private marks: Uint8Array | null = null;
  private readonly cands: number[] = [];
  private spawnTimer = 0;
  /** The map has had its first fill. */
  private filled = false;
  readonly rng: Rng;

  constructor(private readonly ow: WildWorld, seed = 0x5157_4c44) {
    // a stream of its own: the mons never move an encounter, battle or NPC roll
    this.rng = seededRng(seed);
  }

  private get save(): { options?: Record<string, unknown> | null } {
    return this.ow.shell.save as never;
  }

  /** The setting is SOME or MANY and no link is up: the step roll stands
   *  down (world/overworld.ts onStepComplete). */
  suppressesRoll(): boolean {
    return visibleWildMode(this.save) !== "off" && !this.ow.link;
  }

  /** Mons may be about: the setting on, the cheat not NONE, no link. */
  active(): boolean {
    return this.suppressesRoll() && wildMode(this.save as never) !== "none";
  }

  /** A new map (setMap, after the map is built): none of the old map's
   *  mons come along. */
  onMap(): void {
    this.mons.length = 0;
    this.classifier = null;
    this.cellsMap = null;
    this.marks = null;
    this.forMap = this.ow.map ?? null;
    this.filled = false;
    this.spawnTimer = 0;
  }
  /** The map the mons belong to (onMap's). */
  private forMap: GameMap | null = null;

  /** The map's classifier, made on first use after a map load. */
  private classify(): CellClassifier {
    const map = this.ow.map;
    if (!this.classifier || this.cellsMap !== map) {
      const data = this.ow.shell.data;
      const enc = data.encounters?.[map.id] as EncounterDef | undefined;
      const indoor = (data.field as { indoorEncounters?: IndoorRule } | undefined)?.indoorEncounters;
      this.classifier = new CellClassifier(map, enc, indoor);
      this.cellsMap = map;
    }
    return this.classifier;
  }

  /** The map's cell kinds, all of them worked out now (the tests' and the
   *  benches' view; the tick works them out CLASSIFY_CELLS at a time). */
  cellKinds(): Uint8Array {
    const c = this.classify();
    c.step(Infinity);
    return c.out;
  }

  /** The mon in or stepping into a cell. */
  monAt(cx: number, cy: number): WildMon | undefined {
    return this.mons.find((m) => (m.cellX === cx && m.cellY === cy) || (m.targetX === cx && m.targetY === cy));
  }

  /**
   * One logic tick. `frozen` while the world is held (a script, a walk-up,
   * a warp). Returns true when a touch started a battle: the rest of the
   * overworld's tick stands down.
   */
  update(frozen: boolean): boolean {
    if (!this.active()) {
      if (this.mons.length) this.mons.length = 0;
      return false;
    }
    if (frozen) return false;
    const ow = this.ow;
    const p = ow.player;
    // a map built without setMap's call (never, but cheap to be sure)
    if (this.forMap !== ow.map) this.onMap();
    // the cells, a few rows a tick: a map's entry is no long frame
    const cls = this.classify();
    if (!cls.done) cls.step(CLASSIFY_CELLS);
    for (const m of this.mons) {
      m.advance();
      if (!m.moving && --m.timer <= 0) this.wander(m);
    }
    // the touch
    for (const m of this.mons) {
      if (Math.abs(m.px - p.px) < TOUCH_PX && Math.abs(m.py - p.py) < TOUCH_PX) {
        this.battle(m);
        return true;
      }
    }
    // going
    for (let i = this.mons.length - 1; i >= 0; i--) {
      const m = this.mons[i]!;
      const far = Math.max(Math.abs(m.cellX - p.cellX), Math.abs(m.cellY - p.cellY));
      m.life -= 1;
      if (far > FAR || (m.life <= 0 && far >= 4 && !m.moving)) this.mons.splice(i, 1);
    }
    // coming: the first fill once every cell is known
    if (!cls.done) return false;
    if (!this.filled) {
      this.filled = true;
      this.spawn(true);
      this.spawnTimer = respawnDelay(this.rng);
    } else if (--this.spawnTimer <= 0) {
      this.spawnTimer = respawnDelay(this.rng);
      this.spawn(false);
    }
    return false;
  }

  /** A touch, or A facing one: the battle, and the mon is gone. */
  battle(m: WildMon): void {
    const i = this.mons.indexOf(m);
    if (i >= 0) this.mons.splice(i, 1);
    // a breather before the next one walks up
    this.spawnTimer = Math.max(this.spawnTimer, 180);
    this.battles += 1;
    this.lastBattle = { species: m.species, level: m.level };
    this.ow.shell.pushStubBattle(m.species, m.level);
  }

  /** A press of A facing (cx, cy): a mon there is a battle. */
  tryTalk(cx: number, cy: number): boolean {
    if (!this.active() || this.mons.length === 0) return false;
    const m = this.monAt(cx, cy);
    if (!m) return false;
    this.battle(m);
    return true;
  }

  /** Entity slots the map's own people leave free (scene.ts draws the
   *  mons into them): slot 0 is the player, slot i + 1 NPC i. */
  freeSlots(): number {
    const npcs = this.ow.npcs;
    let taken = 0;
    for (let i = 0; i < npcs.length && i < ENTS_MAX - 1; i++) if (!npcs[i]!.hidden) taken += 1;
    return ENTS_MAX - 1 - taken;
  }

  private wander(m: WildMon): void {
    const rng = this.rng;
    m.timer = wanderDelay(rng);
    const p = this.ow.player;
    const dx = p.cellX - m.cellX;
    const dy = p.cellY - m.cellY;
    let dir: Dir;
    if (Math.max(Math.abs(dx), Math.abs(dy)) <= 4 && rng.int(4) === 0) {
      dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
    } else {
      dir = DIRS[rng.int(4)]!;
    }
    m.facing = dir;
    // sometimes only a look round, as people do
    if (rng.byte() < 96) return;
    const d = DELTA[dir];
    const tx = m.cellX + d[0];
    const ty = m.cellY + d[1];
    const map = this.ow.map;
    if (!map.inBounds(tx, ty) || this.classify().out[ty * map.widthCells + tx] !== m.kind) return;
    // the people and the other mons block; the player does not (that is a touch)
    const ents: Mover[] = [];
    for (const e of this.ow.entities) if (e !== p) ents.push(e);
    for (const o of this.mons) if (o !== m) ents.push(o);
    if (!canMove(map, ents, m, dir, this.ow.tilePairs).ok) return;
    m.targetX = tx;
    m.targetY = ty;
    m.moving = true;
    m.progress = 0;
  }

  /** Spawn one (or, on a map's first look, up to the count). */
  private spawn(fill: boolean): void {
    const ow = this.ow;
    const map = ow.map;
    const data = ow.shell.data;
    const enc = data.encounters?.[map.id] as EncounterDef | undefined;
    const land = landTable(enc);
    const water = waterTable(enc);
    if (!land && !water) return;
    const kinds = this.classify().out;
    const p = ow.player;
    const surfing = !!p.surfing;
    const w = map.widthCells;
    const x0 = Math.max(1, p.cellX - WINDOW_X), x1 = Math.min(w - 2, p.cellX + WINDOW_X);
    const y0 = Math.max(1, p.cellY - WINDOW_Y), y1 = Math.min(map.heightCells - 2, p.cellY + WINDOW_Y);
    const allowed = (k: number) => (k === CELL_LAND && !!land) || (k === CELL_WATER && !!water && surfing);
    // the window's cells of the kinds on offer: the count to keep
    let cells = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (allowed(kinds[y * w + x]!)) cells += 1;
    const target = wildTarget(visibleWildMode(this.save), wildMode(this.save as never), cells, this.freeSlots());
    let tries = fill ? target : 1;
    while (tries-- > 0 && this.mons.length < target) {
      const at = this.pickCell(kinds, allowed, x0, x1, y0, y1);
      if (!at) return;
      const k = kinds[at[1] * w + at[0]]!;
      const slot = pickSlot(k === CELL_WATER ? water : land, this.rng);
      // a REPEL keeps the weaker ones away, as it does the roll
      if (!slot || repelled(ow.shell.save as never, slot.level)) continue;
      const rng = this.rng;
      this.mons.push(new WildMon(
        slot.species, slot.level, wildSprite(data as never, slot.species), k, at[0], at[1],
        DIRS[rng.int(4)]!, wanderDelay(rng), lifetime(rng), rng.int(64),
      ));
    }
  }

  /** A free cell of an allowed kind in the window, NEAR or more from the
   *  player, nobody in or entering it, no person beside it: one at random. */
  private pickCell(
    kinds: Uint8Array, allowed: (k: number) => boolean, x0: number, x1: number, y0: number, y1: number,
  ): [number, number] | null {
    const ow = this.ow;
    const p = ow.player;
    const map = ow.map;
    const w = map.widthCells;
    const size = w * map.heightCells;
    if (!this.marks || this.marks.length !== size) this.marks = new Uint8Array(size);
    const marks = this.marks;
    // mark what rules a cell out -- someone in it or stepping into it, a
    // person in it or next to it -- once, rather than asking every cell
    const marked: number[] = [];
    const mark = (x: number, y: number | undefined): void => {
      if (y === undefined || x < 0 || y < 0 || x >= w || y >= map.heightCells) return;
      const i = y * w + x;
      if (!marks[i]) { marks[i] = 1; marked.push(i); }
    };
    for (const e of ow.entities) {
      if ((e as { hidden?: boolean }).hidden) continue;
      mark(e.cellX, e.cellY);
      if (e.targetX !== undefined) mark(e.targetX, e.targetY);
    }
    for (const m of this.mons) {
      mark(m.cellX, m.cellY);
      if (m.targetX !== undefined) mark(m.targetX, m.targetY);
    }
    for (const n of ow.npcs) {
      if (n.hidden) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mark(n.cellX + dx, n.cellY + dy);
    }
    const cands = this.cands;
    cands.length = 0;
    for (let y = y0; y <= y1; y++) {
      const row = y * w;
      const ny = Math.abs(y - p.cellY) < NEAR;
      for (let x = x0; x <= x1; x++) {
        const i = row + x;
        if (marks[i] || !allowed(kinds[i]!)) continue;
        if (ny && Math.abs(x - p.cellX) < NEAR) continue;
        cands.push(i);
      }
    }
    for (const i of marked) marks[i] = 0;
    if (cands.length === 0) return null;
    const i = cands[this.rng.int(cands.length)]!;
    return [i % w, Math.floor(i / w)];
  }
}
