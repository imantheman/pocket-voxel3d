// VISIBLE WILD (OPTION's ENHANCEMENTS page and the bottom screen's
// ENHANCEMENTS tab; options.visibleWild "off" / "some" / "many"). Not the
// cart's: the port's own, built from the cart's parts. While it is on, wild
// mons stand in the overworld wherever a step could meet one, and walking
// into one is that battle.
//
// WHERE. A cell a mon may stand on is one the cart would roll an encounter
// on (FieldMoves.canEncounterWildMon: the grass and water collisions, or
// every floor of a CAVE / DUNGEON map; never ice), on a map whose table for
// that cell has a rate now -- the land table's rate for the time of day,
// or the water table's. Land mons stand on walkable cells (no ledge, warp,
// door or stair collision); water mons on water that is not a current or a
// whirlpool. Never on a warp or the four cells beside one, never on a coord
// event, never on or next to the player, never on a person or where one is
// stepping. A town without grass has no such cell, so it has no mons.
//
// WHAT. Each mon is rolled when it appears, the way TryWildEncounter rolls
// one: the swarm-substituted table (World.wildTables), the land list for
// the time of day (morning, day, night) or the water list, the cart's slot
// odds (Encounter.grassSlot / waterSlot, through World.rollEncounter so a
// mod's encounter hooks see it), the Unown arm (an UNOWN slot with no
// chamber solved is no mon; a solved one only shows unlocked letters), and
// its DVs (Mon.randomDVs, so SHINY ODDS applies at spawn). With a REPEL
// going, a mon below the lead's level does not appear (CheckRepelEffect's
// own test). Water mons appear whenever water encounter cells are in view,
// surfing or not -- the cart rolls the water list only for a surfer, so one
// can be touched only from the water.
//
// HOW MANY. SOME aims at three on screen, MANY at six (the spawn window is
// the screen round the player: RX cells either side, RY above and below).
// CHEATS' WILD ENCOUNTERS scales that: LESS halves it (rounded up), MORE
// takes half again (rounded up, at most MAX_MONS); NONE shows no ordinary
// mon at all. A small patch holds fewer: one mon for every four cells of it
// in the window (the count is estimated from the cells each spawn try looks
// at, so no step scans the whole window). On a new map up to half the aim
// appear at once and the rest arrive one at a time, every second or so;
// stepping the aim down (MANY to SOME) flickers the extras out.
//
// LIFE. A mon wanders slowly (a cell per WALK_FRAMES, a pause of a second or
// three between moves, sometimes only a turn), only onto cells of its own
// kind (land, water) that it may stand on, and never into the player. Each
// lives LIFE_MIN..LIFE_MAX steps, flickering out over its last ones (and in
// over its first); one left far behind the player, or that a person walks
// into, goes at once. Nothing here is saved: a map change, a warp or turning
// the option off takes them all.
//
// BATTLE. Walking into one -- the player standing still on (or, walking
// free, within twelve pixels of) a mon -- starts the ordinary wild battle
// (World.startBattle) with exactly that species, level and DVs; whatever
// happens in it, that mon is gone after.
//
// ROAMERS. A roaming beast on the player's map shows as one of the mons: on
// each spawn tick that one is not already showing, the cart's own
// CheckEncounterRoamMon roll (Roamers.checkEncounter, which also refuses
// water) decides whether it appears, on a land cell; walking into it is the
// roaming battle with the beast's stored HP and DVs (a fresh one takes the
// DVs it was shown with). This happens under WILD ENCOUNTERS NONE too, the
// rule NONE already keeps for the step encounters (core/Cheats.ts).
//
// WHAT STAYS. Random step encounters stop entirely while this is on
// (World.tryWildEncounter). Fishing, HEADBUTT, ROCK SMASH, SWEET SCENT and
// every scripted or static battle are untouched. The Bug-Catching Contest
// keeps its own rules: during it no mon shows here and the park's own step
// encounters run as on the cart. Over a link (the CABLE CLUB) it is off,
// and random encounters are the cart's.
//
// LOOK. The cart draws a mon in the overworld as its party-menu icon
// (GetMonSprite: SpriteMons ids show the species' ICON_* sheet, two frames,
// OBJECT_ACTION_BOUNCE), and that is what a mon here is: an NPC with the
// species' icon sheet, bouncing between the two frames, mirrored when it
// faces right. Its colours are the species' own pic colours (Palettes.
// monColors) -- the shiny set for a shiny one, so a shiny is told from the
// rest of its kind at a glance.

import { BugContest } from "../core/BugContest.ts";
import { Cheats, type WildRate } from "../core/Cheats.ts";
import { Roamers } from "../core/Roamers.ts";
import { Unown } from "../core/Unown.ts";
import { Encounter } from "../battle/Encounter.ts";
import { Mon } from "../battle/Mon.ts";
import { Sprites } from "../shared/pokemon/Sprites.ts";
import { random } from "../platform/rng.ts";
import { FieldMoves } from "./FieldMoves.ts";
import { Map } from "./Map.ts";
import { NPC } from "./Npc.ts";
import { Palettes } from "./Palettes.ts";
import { Permissions } from "./Permissions.ts";
import type { ActorView, Facing } from "./Player.ts";

/** Most mons at once (the 3D view's art slots: worldview.ts ENT_ART_MAX). */
export const MAX_MONS = 8;
/** The aim per mode, before WILD ENCOUNTERS. */
export const AIM: Record<string, number> = { off: 0, some: 3, many: 6 };
/** The spawn window, in cells either side of the player. */
export const RX = 6;
export const RY = 5;
const WINDOW_CELLS = (2 * RX + 1) * (2 * RY + 1);
/** A mon farther than this from the player (cells, either axis) goes. */
const GONE_RX = RX + 3;
const GONE_RY = RY + 3;
/** Steps a mon lives (60 a second). */
export const LIFE_MIN = 1200;
export const LIFE_MAX = 2400;
/** Steps it flickers in for, and out for at the end. */
const FLICKER_IN = 24;
const FLICKER_OUT = 48;
/** Steps between spawn tries. */
const SPAWN_MIN = 40;
const SPAWN_MAX = 100;
/** Window cells one spawn try looks at (a first one on a new map, more). */
const SAMPLES = 24;
const SAMPLES_FRESH = 64;
/** A wander step's frames (a walk is 16), and the pause between moves. */
export const WALK_FRAMES = 32;
const PAUSE_MIN = 48;
const PAUSE_MAX = 160;
/** How near (px, either axis) the player's body is to a mon to touch it. */
const TOUCH_PX = 12;
const DIRS: Facing[] = ["up", "down", "left", "right"];
const BESIDE: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];

type Kind = "land" | "water";
type Dvs = { attack?: number; defense?: number; speed?: number; special?: number; hp?: number };
type Colors4 = number[][];
type Cell = { x: number; y: number; kind: Kind };

/** What the renderers draw a mon with (worldview.ts, map2d.ts). */
export interface WildArt {
  gfx: string;
  colors: Colors4;
  /** gfx and colours as one string: the 3D view's art slot key. */
  key: string;
}

/** One mon on show. */
export interface WildSpawn {
  npc: WildNpc;
  species: string;
  level: number;
  dvs: Dvs;
  shiny: boolean;
  kind: Kind;
  /** Steps left to live, and steps since it appeared. */
  life: number;
  age: number;
  /** Steps until it next decides to move. */
  pause: number;
  /** The roaming beast's slot (1-3), for a roamer. */
  roaming?: number;
  /** The icon sheet's gfx key and the four colours it is drawn in. */
  gfx: string;
  colors: Colors4;
  art: WildArt;
}

type WildView = ActorView & { wildArt: WildArt; extra: Record<string, unknown> };

/**
 * The mon's NPC: the icon sheet, bouncing, its own colours. Its view is
 * built straight into one object it keeps (an overworld frame reads it and
 * is done with it), the bounce frame NPC.viewState would pick, mirrored
 * when it faces right -- the icons face left.
 */
export class WildNpc extends NPC {
  wild!: WildSpawn;
  private view: WildView | undefined;

  viewState(_camTurns = 0): ActorView {
    const w = this.wild;
    let v = this.view;
    if (!v) {
      v = this.view = {
        px: 0, py: 0, cellX: 0, cellY: 0, facing: "down", phase: 0, flip: false, frame: 0, mirror: false,
        spriteId: "VISIBLE_WILD", gfx: w.gfx, visible: true, palette: 0, wildArt: w.art,
        extra: { inGrass: false, moving: false, bounce: 0 },
      };
    }
    const frame = this.bounceFrame() ?? 0;
    v.px = this.px;
    v.py = this.py + (this.spriteYOffset ?? 0);
    v.cellX = this.cellX;
    v.cellY = this.cellY;
    v.facing = this.facing;
    v.frame = frame;
    v.mirror = this.facing === "right";
    const flicker = w.life <= FLICKER_OUT ? w.life : w.age < FLICKER_IN ? w.age : -1;
    v.visible = flicker < 0 || (flicker >> 2) % 2 === 1;
    v.extra.inGrass = this.inGrass;
    v.extra.moving = this.moving;
    v.extra.bounce = frame;
    return v;
  }
}

function rand(lo: number, hi: number): number {
  return random(lo, hi);
}

function grassVanilla(tables: any, ctx: any): any {
  return Encounter.grassSlot(tables, ctx.mapId, ctx.daytime, undefined);
}

function waterVanilla(tables: any, ctx: any): any {
  return Encounter.waterSlot(tables, ctx.mapId, undefined);
}

/** The aim for a mode under WILD ENCOUNTERS (before a patch's own cap). */
export function aimFor(mode: string, rate: WildRate): number {
  const base = AIM[mode] ?? 0;
  if (base <= 0 || rate === "none") return 0;
  if (rate === "less") return Math.ceil(base / 2);
  if (rate === "more") return Math.min(MAX_MONS, Math.ceil(base * 1.5));
  return Math.min(MAX_MONS, base);
}

export class VisibleWild {
  list: WildSpawn[] = [];
  /** The map the list belongs to. */
  mapId: string | undefined = undefined;
  /** Steps until the next spawn try. */
  wait = 0;
  /** A new map: spawn a first handful at once. */
  fresh = true;
  /** How much of the spawn window mons may stand on, as a running estimate
   *  from the cells the spawn tries look at (-1: none looked at yet). */
  share = -1;
  /** Spawned so far, for each one's NPC index; steps run (staggers checks). */
  private made = 0;
  private tick = 0;

  /** Whether the option is on and may run here (not over a link). The step
   *  encounters are off whenever this says yes. */
  static active(world: any): boolean {
    if (Cheats.visibleWild() === "off") return false;
    const game = world ? world.game : undefined;
    if (game && typeof game.linked === "function" && game.linked()) return false;
    return true;
  }

  clear(): void {
    this.list.length = 0;
    this.fresh = true;
    this.wait = 0;
    this.share = -1;
  }

  /** Whether mons may show on this map now. */
  private allowed(world: any): boolean {
    if (!VisibleWild.active(world)) return false;
    const game = world.game;
    const save = game ? game.save : undefined;
    if (!(world.map && world.player && world.encounters && save)) return false;
    if (!(save.party && save.party.length > 0)) return false;
    if (world.noWildEncounters) return false;
    if (BugContest.isActive(save)) return false;
    return true;
  }

  /** Ordinary mons (not the roaming beast) that are not on their way out. */
  private staying(): number {
    let n = 0;
    for (const w of this.list) if (w.roaming == null && w.life > FLICKER_OUT) n++;
    return n;
  }

  /** Ordinary mons on show, those flickering out included. */
  private ordinary(): number {
    let n = 0;
    for (const w of this.list) if (w.roaming == null) n++;
    return n;
  }

  /**
   * Once a logic step (World.stepBody). `free` is the overworld having the
   * frame: mons wander, appear and go only then; under a script or a text
   * box they finish the step they are on and wait.
   */
  step(world: any, free: boolean): void {
    const map = world.map;
    if (!map) return;
    if (map.id !== this.mapId) {
      this.clear();
      this.mapId = map.id;
    }
    if (!this.allowed(world)) {
      if (this.list.length) this.clear();
      return;
    }
    this.tick++;
    const p = world.player;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const w = this.list[i]!;
      if (free) {
        w.life--;
        w.age++;
      }
      const npc = w.npc;
      let gone = w.life <= 0
        || Math.abs(npc.cellX - p.cellX) > GONE_RX || Math.abs(npc.cellY - p.cellY) > GONE_RY;
      // a person on it, or stepping onto it: it goes (a person never waits
      // on a wild mon) -- looked at every fourth step, a mon at a time
      if (!gone && ((this.tick + i) & 3) === 0) {
        gone = this.personAt(world, npc.cellX, npc.cellY)
          || (npc.moving && this.personAt(world, npc.targetX!, npc.targetY!));
      }
      if (gone && !npc.moving) {
        this.list.splice(i, 1);
        continue;
      }
      if (free && !npc.moving) this.wander(world, w);
      npc.frozen = !free;
      npc.update(map, undefined);
    }
    if (!free) return;
    // more than the aim (MANY turned to SOME, a cheat stepped down): the
    // extras flicker out, the oldest first
    const aim = this.aim(world);
    let over = this.list.length > aim ? this.staying() - aim : 0;
    for (let i = 0; over > 0 && i < this.list.length; i++) {
      const w = this.list[i]!;
      if (w.roaming == null && w.life > FLICKER_OUT) {
        w.life = FLICKER_OUT;
        over--;
      }
    }
    if (--this.wait > 0) return;
    this.wait = rand(SPAWN_MIN, SPAWN_MAX);
    const burst = this.fresh ? Math.max(1, Math.ceil(aimFor(Cheats.visibleWild(), Cheats.wildRate()) / 2)) : 1;
    this.fresh = false;
    for (let k = 0; k < burst; k++) this.spawnOne(world);
  }

  /** The aim on this map now: the mode's, capped by the patch in view
   *  (one mon for every four cells, from the running estimate). */
  aim(_world: any): number {
    let n = aimFor(Cheats.visibleWild(), Cheats.wildRate());
    if (this.share >= 0) n = Math.min(n, Math.max(1, Math.floor((this.share * WINDOW_CELLS) / 4)));
    return n;
  }

  /** Is anyone (a person) on or stepping onto cell (cx, cy)? */
  private personAt(world: any, cx: number, cy: number): boolean {
    const npcs = world.npcs;
    if (!npcs) return false;
    for (let i = 0; i < npcs.length; i++) {
      const e = npcs[i];
      if (e.cellX === cx && e.cellY === cy) return true;
      if (e.moving && e.targetX === cx && e.targetY === cy) return true;
      if (e.bigObject && NPC.prototype.covers.call(e, cx, cy)) return true;
    }
    return false;
  }

  /** Near the player: their cell, the one they step to, or under the free body. */
  private nearPlayer(world: any, cx: number, cy: number, margin: number): boolean {
    const p = world.player;
    if (Math.max(Math.abs(cx - p.cellX), Math.abs(cy - p.cellY)) <= margin) return true;
    if (p.moving && p.targetX != null
        && Math.max(Math.abs(cx - p.targetX), Math.abs(cy - p.targetY)) <= margin) return true;
    return Math.abs(cx * 16 - p.px) < 16 + margin * 16 && Math.abs(cy * 16 - p.py) < 16 + margin * 16;
  }

  /** What may stand on cell (cx, cy): "land", "water" or nothing (see the header). */
  kindAt(world: any, cx: number, cy: number): Kind | undefined {
    const map = world.map;
    if (!map.inBounds(cx, cy)) return undefined;
    const coll = map.cellCollision(cx, cy);
    const environment = map.def ? map.def.environment : undefined;
    if (!FieldMoves.canEncounterWildMon(environment, coll, world.noWildEncounters)) return undefined;
    let kind: Kind;
    if (Permissions.isWater(coll)) {
      if (Permissions.isWhirlpool(coll) || Permissions.currentDirection(coll) != null) return undefined;
      kind = "water";
    } else {
      if (!map.isWalkable(cx, cy)) return undefined;
      if (Permissions.ledgeFacings(coll) || Permissions.isWarpCollision(coll)) return undefined;
      kind = "land";
    }
    for (const [dx, dy] of BESIDE) {
      if (map.warpAt(cx + dx, cy + dy)) return undefined;
    }
    const coords = map.def ? map.def.coordEvents : undefined;
    if (coords) {
      for (const ev of coords) if (ev && ev.x === cx && ev.y === cy) return undefined;
    }
    return kind;
  }

  /** Which tables have a rate now: [land, water]. */
  private tablesNow(world: any): [boolean, boolean] {
    const tables = world.wildTables();
    return [Encounter.grassRate(tables, world.map.id, world.tod) > 0, Encounter.waterRate(tables, world.map.id) > 0];
  }

  private occupied(cx: number, cy: number, self?: WildSpawn): boolean {
    for (const w of this.list) {
      if (w === self) continue;
      if (w.npc.cellX === cx && w.npc.cellY === cy) return true;
      if (w.npc.moving && w.npc.targetX === cx && w.npc.targetY === cy) return true;
    }
    return false;
  }

  /** Whether a mon of a table that has a rate may appear on (cx, cy) now. */
  private open(world: any, cx: number, cy: number, land: boolean, water: boolean): Kind | undefined {
    if (this.nearPlayer(world, cx, cy, 1)) return undefined;
    const kind = this.kindAt(world, cx, cy);
    if (!kind || (kind === "land" ? !land : !water)) return undefined;
    return kind;
  }

  /** Every cell in the window a mon could appear on now (tests, benches). */
  candidates(world: any): Cell[] {
    const p = world.player;
    const [land, water] = this.tablesNow(world);
    const out: Cell[] = [];
    if (!land && !water) return out;
    for (let cy = p.cellY - RY; cy <= p.cellY + RY; cy++) {
      for (let cx = p.cellX - RX; cx <= p.cellX + RX; cx++) {
        const kind = this.open(world, cx, cy, land, water);
        if (!kind || this.occupied(cx, cy) || this.personAt(world, cx, cy)) continue;
        out.push({ x: cx, y: cy, kind });
      }
    }
    return out;
  }

  /** `n` random window cells looked at: the open ones (and the share estimate updated). */
  private sample(world: any, n: number): Cell[] {
    const p = world.player;
    const [land, water] = this.tablesNow(world);
    const out: Cell[] = [];
    if (!land && !water) {
      this.share = 0;
      return out;
    }
    let open = 0;
    for (let k = 0; k < n; k++) {
      const cx = p.cellX + rand(-RX, RX);
      const cy = p.cellY + rand(-RY, RY);
      const kind = this.open(world, cx, cy, land, water);
      if (!kind) continue;
      open++;
      if (this.occupied(cx, cy) || this.personAt(world, cx, cy)) continue;
      out.push({ x: cx, y: cy, kind });
    }
    const seen = open / n;
    this.share = this.share < 0 ? seen : this.share * 0.75 + seen * 0.25;
    return out;
  }

  /** Is a roaming beast on this map that is not showing yet? */
  private roamerHere(world: any): boolean {
    if (this.list.some((w) => w.roaming != null)) return false;
    const list = Roamers.list(world.game.save);
    if (!list) return false;
    for (const slot of list) if (slot && Roamers.active(slot) && slot.map === world.map.id) return true;
    return false;
  }

  /** One spawn try: the roaming beast first, then an ordinary mon. */
  spawnOne(world: any): WildSpawn | undefined {
    if (this.list.length >= MAX_MONS) return undefined;
    const roamer = this.roamerHere(world);
    const short = this.ordinary() < aimFor(Cheats.visibleWild(), Cheats.wildRate());
    if (!roamer && !short) return undefined;
    const cells = this.sample(world, this.share < 0 ? SAMPLES_FRESH : SAMPLES);
    if (cells.length === 0) return undefined;
    const game = world.game;
    const save = game.save;
    const pick = (kind?: Kind): Cell | undefined => {
      const pool = kind ? cells.filter((c) => c.kind === kind) : cells;
      return pool.length ? pool[rand(1, pool.length) - 1] : undefined;
    };
    // the beast: CheckEncounterRoamMon's roll, on land
    if (roamer) {
      const at = pick("land");
      if (at) {
        const met: any = Roamers.checkEncounter(save, world.map.id, false, world.roamRandom());
        if (met && !world.repelSuppresses(met.level)) {
          const slot = met.slot ?? {};
          const known = (slot.hp ?? 0) !== 0 && slot.dvs;
          const dvs: Dvs = known ? { ...slot.dvs } : Mon.randomDVs();
          return this.add(world, at.x, at.y, "land", met.species, met.level, dvs, met.index);
        }
      }
    }
    if (this.ordinary() >= this.aim(world)) return undefined;
    const at = pick();
    if (!at) return undefined;
    const tables = world.wildTables();
    const roll = world.rollEncounter("wild", at.kind === "water" ? "water" : "grass", tables,
      at.kind === "water" ? waterVanilla : grassVanilla);
    if (!roll || !roll.species) return undefined;
    let dvs: Dvs;
    if (roll.species === Unown.SPECIES) {
      const flags = world.unownUnlockFlags();
      if (!Unown.anyUnlocked(flags)) return undefined;
      dvs = Unown.wildDVs(flags, Mon.randomDVs as any);
    } else {
      dvs = Mon.randomDVs();
    }
    if (world.repelSuppresses(roll.level)) return undefined;
    return this.add(world, at.x, at.y, at.kind, roll.species, roll.level, dvs);
  }

  /** The species' icon sheet (ReadMonMenuIcon, through the pokemon.icon hook). */
  static iconGfx(data: any, species: string): string | undefined {
    const icons = data ? data.gen2Icons : undefined;
    const id = icons && icons.species ? icons.species[species] : undefined;
    const entry = id && icons.icons ? icons.icons[id] : undefined;
    const [path] = Sprites.iconPath(data, { species }, entry ? entry.image : undefined, { name: id });
    return path;
  }

  /** The four colours a mon is drawn in: its pic's (shiny or not). */
  static colorsFor(world: any, species: string, shiny: boolean): Colors4 | undefined {
    const c = Palettes.monColors(world.palettes, species, shiny);
    if (c) return c as unknown as Colors4;
    return Palettes.spritePalette(world.palettes, world.daytime ?? "DAY", { paletteId: 0 }) as unknown as Colors4 | undefined;
  }

  add(world: any, cx: number, cy: number, kind: Kind, species: string, level: number, dvs: Dvs, roaming?: number): WildSpawn | undefined {
    const data = world.game ? world.game.data : undefined;
    const gfx = VisibleWild.iconGfx(data, species);
    if (!gfx) return undefined;
    const shiny = !!Mon.isShiny(dvs as any, { species, level } as any);
    const colors = VisibleWild.colorsFor(world, species, shiny);
    if (!colors) return undefined;
    this.made++;
    const def = { id: "VISIBLE_WILD", source: "visible-wild", image: gfx, frames: 2, walker: false, paletteId: 0 };
    const npc = new WildNpc(world.map.id, { index: 1000 + this.made, movement: NPC.MOVE.STILL, x: cx, y: cy }, def);
    npc.kind = "stand";
    npc.bouncing = true;
    npc.passable = true;
    npc.stepFrames = WALK_FRAMES;
    npc.facing = DIRS[rand(1, 4) - 1]!;
    const art: WildArt = { gfx, colors, key: `${gfx}|${colors.map((c) => c.join(",")).join("|")}` };
    const w: WildSpawn = {
      npc, species, level, dvs, shiny, kind,
      life: rand(LIFE_MIN, LIFE_MAX), age: 0, pause: rand(PAUSE_MIN, PAUSE_MAX),
      roaming, gfx, colors, art,
    };
    npc.wild = w;
    this.list.push(w);
    return w;
  }

  /** A still mon's next move: a pause, then a turn and maybe a step. */
  private wander(world: any, w: WildSpawn): void {
    if (--w.pause > 0) return;
    w.pause = rand(PAUSE_MIN, PAUSE_MAX);
    const npc = w.npc;
    const p = world.player;
    // the cell the player is stepping into holds it: it never dodges a touch
    if (p.moving && p.targetX === npc.cellX && p.targetY === npc.cellY) return;
    const dir = DIRS[rand(1, 4) - 1]!;
    npc.facing = dir;
    if (rand(1, 3) === 1) return;
    const d = Map.DELTA[dir]!;
    const tx = npc.cellX + d[0];
    const ty = npc.cellY + d[1];
    if (this.kindAt(world, tx, ty) !== w.kind) return;
    if (this.nearPlayer(world, tx, ty, 0) || this.occupied(tx, ty, w) || this.personAt(world, tx, ty)) return;
    npc.targetX = tx;
    npc.targetY = ty;
    npc.moving = true;
    npc.progress = 0;
  }

  /** The mon the player's body is on, if any (see the header's BATTLE). */
  touched(world: any): WildSpawn | undefined {
    const p = world.player;
    if (!p || p.moving) return undefined;
    for (const w of this.list) {
      if (Math.abs(p.px - w.npc.px) < TOUCH_PX && Math.abs(p.py - w.npc.py) < TOUCH_PX) return w;
    }
    return undefined;
  }

  /** Once a free step, after the people move: walking into a mon is its
   *  battle. True when one started. */
  touch(world: any): boolean {
    if (this.list.length === 0) return false;
    const w = this.touched(world);
    if (!w) return false;
    return this.battle(world, w);
  }

  /** The wild battle with exactly that mon; it is gone either way. */
  battle(world: any, w: WildSpawn): boolean {
    const game = world.game;
    const save = game ? game.save : undefined;
    if (!(save && save.party && save.party.length > 0)) return false;
    const i = this.list.indexOf(w);
    if (i >= 0) this.list.splice(i, 1);
    let wild: any;
    if (w.roaming != null) {
      wild = Roamers.beginBattle(save, w.roaming, game.data, w.dvs);
    } else {
      wild = Mon.new(game.data, w.species, w.level, { dvs: { ...w.dvs } });
    }
    if (!wild) return false;
    save.pokedex = save.pokedex ?? { seen: {}, caught: {} };
    save.pokedex.seen[wild.species] = true;
    console.log(`[pv] visible wild: battle ${wild.species} L${wild.level}${wild.shiny ? " shiny" : ""}${w.roaming != null ? " roaming" : ""}`);
    world.startBattle(w.roaming != null ? { wild, roaming: w.roaming } : { wild });
    return true;
  }
}

export default VisibleWild;
