// Minimal Gen 2 overworld player: tile-grid steps at 16 frames/cell.
// A port of gen1recomp src/world/gen2/Player.lua at bdfac727 (MIT).
//
// The Lua draws through the shared SpriteRenderer; here the voxel renderer
// (platform/worldview.ts) draws, reading `viewState()` -- the ActorView the
// Lua's Player:draw would have painted: position, facing, walk phase, flip,
// sheet, visibility. The SpriteRenderer object the Lua keeps on
// `self.sprite` becomes a SpriteHandle: the def, the frame geometry the pose
// math needs, and the OBJ palette World hands it (setObjPalette).

import { Map } from "./Map.ts";
import { Movement } from "../script/Movement.ts";
import { Runtime } from "../shared/mods/Runtime.ts";

export type Facing = "down" | "up" | "left" | "right";

/**
 * What a renderer needs to draw one overworld actor this frame (the agreed
 * shape platform/worldview.ts reads; World:viewState() returns these).
 */
export interface ActorView {
  /** Map-local pixel position of the sprite cell's top-left exactly as draw()
   * passes it to sprite:draw (py INCLUDES spriteYOffset, jump arc, bounce). */
  px: number;
  py: number;
  cellX: number;
  cellY: number;
  /** Facing as drawn this frame (spin-adjusted). */
  facing: Facing;
  /** Walk/anim phase drawn (walkPhase(), bounce, ...). */
  phase: number;
  /** The stepFlip handed to sprite:draw (drawFlip()). */
  flip: boolean;
  /** Sheet frame index SpriteRenderer's pose() picks (STAND/WALK tables). */
  frame: number;
  /** Final horizontal mirror SpriteRenderer's pose() applies. */
  mirror: boolean;
  /** sprites.json key (e.g. "SPRITE_CHRIS"). */
  spriteId: string | undefined;
  /** The sheet's gfx key from the sprite def. */
  gfx: string | undefined;
  /** False when hidden, off-map, or a flicker-off frame. */
  visible: boolean;
  /** OBJ palette index if the Lua picks one. */
  palette?: number;
  /** Kind-specific extras (fishing rod/bob, big object, tree shake, ...). */
  extra?: Record<string, unknown>;
}

// SpriteRenderer.lua:77-78 -- the pose tables (exported there so a render
// pipeline's own geometry picks frames by the same tables).
const STAND: Record<string, number> = { down: 0, up: 1, left: 2, right: 2 };
const WALK: Record<string, number> = { down: 3, up: 4, left: 5, right: 5 };

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) return Math.floor(value);
  return fallback;
}

/**
 * The part of SpriteRenderer (src/render/SpriteRenderer.lua:137-165) the
 * overworld logic reads: the def, frame geometry, and the OBJ palette. No
 * image, no quads -- the renderer owns those.
 */
export class SpriteHandle {
  def: any;
  seed: unknown;
  frameCount: number;
  frameWidth: number;
  frameHeight: number;
  objColors: unknown = undefined;
  objGroup: string | undefined = undefined;

  constructor(def: any, seed: unknown) {
    this.def = def;
    this.seed = seed;
    this.frameCount = positiveInteger(def.frames, 1);
    this.frameWidth = positiveInteger(def.frameWidth, 16);
    this.frameHeight = positiveInteger(def.frameHeight, 16);
  }

  static new(def: any, seed: unknown): SpriteHandle {
    if (!def || typeof def !== "object") throw new Error("sprite def missing");
    return new SpriteHandle(def, seed);
  }

  // SpriteRenderer.lua:262 -- Gen 2 hands its OBJ palette over explicitly.
  setObjPalette(colors: unknown, group?: string): void {
    this.objColors = colors;
    this.objGroup = group ?? "gen2";
  }
}

/**
 * SpriteRenderer.lua:112-129 pose(): the sheet frame and mirror for a facing,
 * walk phase and step flip. Single-frame sprites have one fixed pose.
 */
export function spritePose(sprite: SpriteHandle | undefined, facing: string, walkPhase: number, stepFlip: boolean): [number, boolean] {
  if (!sprite || sprite.frameCount <= 1) return [0, false];
  let frame = (sprite.def.walker && walkPhase === 1) ? WALK[facing] : STAND[facing];
  frame = frame ?? 0;
  // the old fallback for a short custom sheet
  if (frame >= sprite.frameCount) frame = 0;
  let flip = false;
  if (facing === "right") {
    flip = true;
  } else if ((facing === "down" || facing === "up") && walkPhase === 1 && stepFlip) {
    flip = true;
  }
  return [frame, flip];
}

/** The gfx key a sprite def names (sprites.json `image`). */
export function spriteGfx(def: any): string | undefined {
  if (!def) return undefined;
  return def.image ?? def.gfx ?? def.key;
}

// Lua: Player.lua:12-13
const STEP_FRAMES = 16;
const TURN_FRAMES = 4;

// Lua: Player.lua:21-28 -- FacingFish*'s loose rod OAM, offset from the
// sprite's top-left, and which 8x8 of the sheet's rod row it draws
// (data/sprites/facings.asm:122-152). Kept for the renderer (viewState extra).
export const ROD_OAM: Record<string, { dx: number; dy: number; tile: number; flip?: boolean }> = {
  down: { dx: 0, dy: 16, tile: 0 },
  up: { dx: 0, dy: -8, tile: 0 },
  left: { dx: -8, dy: 5, tile: 1, flip: true },
  right: { dx: 16, dy: 5, tile: 1 },
};

// Lua: Player.lua:30-32 -- the sheet row LoadFishingGFX lays over each
// standing frame's bottom tiles (engine/events/fishing_gfx.asm:2-20).
export const FISH_ROW: Record<string, number> = { down: 0, up: 1, left: 2, right: 2 };

// Lua: Player.lua:69-73 -- the movement.collision chain's vanilla link.
function passthrough(allowed: boolean, _ctx?: unknown): boolean { return allowed; }

// Lua: Player.lua:75-95 -- the verdict on one step. World:movePlayer has
// already vetoed a side-wall direction by handing a refusingMap, so that veto
// arrives here as "tile" exactly like a wall does.
function verdict(self: Player, map: any, entities: any[] | undefined, tx: number, ty: number): [boolean, string?] {
  if (!map.inBounds(tx, ty)) return [false, "bounds"];
  if (!map.isWalkable(tx, ty)) return [false, "tile"];
  if (entities) {
    for (const e of entities) {
      // `passable` is the follower's escape: the player walks through it.
      if (e !== self && !e.passable) {
        if (e.cellX === tx && e.cellY === ty) return [false, "entity"];
        if (e.moving && e.targetX === tx && e.targetY === ty) {
          return [false, "entity"];
        }
      }
    }
  }
  return [true];
}

// Lua: Player.lua:178-181 -- CounterclockwiseSpinAction's .facings, seeded
// from the current direction by Movement_step_dig
// (map_object_action.asm:96-152, movement.asm:113-116).
const SPIN_FACINGS: Facing[] = ["down", "right", "up", "left"];
const SPIN_START: Record<string, number> = { down: 0, right: 1, up: 2, left: 3 };

export class Player {
  // Lua: Player.lua:15-19 -- the walking duration, exported so World can
  // halve it for a bike step. The leg cadence does NOT scale with it.
  static STEP_FRAMES = STEP_FRAMES;

  // Fields other modules set on the player as the Lua does (fishing,
  // fixedFacing, spriteYOffset, grassShake, hidden, ...) stay open.
  [key: string]: any;

  cellX: number;
  cellY: number;
  px: number;
  py: number;
  facing: Facing;
  moving = false;
  progress = 0;
  turnTimer = 0;
  turnArmed = true;
  stepFlip = false;
  /** OBJECT_FLAGS2's IN_GRASS_F (engine/overworld/map_objects.asm:247). */
  inGrass = false;
  animClock = 0;
  /** Frames this cell takes; World rewrites it per step from the STEP_* the
   * player's state picks, and a step under way keeps the one it started with. */
  stepFrames = STEP_FRAMES;
  sprite: SpriteHandle | undefined = undefined;
  spriteDef: any;
  targetX: number | undefined = undefined;
  targetY: number | undefined = undefined;
  bumpFrames: number | undefined = undefined;
  jumping: boolean | undefined = undefined;
  spriteYOffset: number | undefined = undefined;
  spinFrames: number | undefined = undefined;
  spinFlicker: unknown = undefined;
  spinTimer: number | undefined = undefined;

  // Lua: Player.lua:34-58
  constructor(cx: number, cy: number, facing?: Facing, spriteDef?: any) {
    this.cellX = cx;
    this.cellY = cy;
    this.px = cx * 16;
    this.py = cy * 16;
    this.facing = facing ?? "down";
    this.spriteDef = spriteDef;
    if (spriteDef) {
      this.sprite = SpriteHandle.new(spriteDef, "player");
    }
  }

  static new(cx: number, cy: number, facing?: Facing, spriteDef?: any): Player {
    return new Player(cx, cy, facing, spriteDef);
  }

  // Lua: Player.lua:60-67 -- pokegold engine/overworld/overworld.asm:55-64
  setSprite(spriteDef: any): void {
    if (!spriteDef) return;
    let sprite: SpriteHandle;
    try {
      sprite = SpriteHandle.new(spriteDef, "player");
    } catch {
      return;
    }
    this.spriteDef = spriteDef;
    this.sprite = sprite;
  }

  // Lua: Player.lua:97-135 -- "turned", "moved", "edge", "blocked" or nil.
  tryMove(dir: Facing, map: any, entities?: any[]): string | undefined {
    if (this.moving) return undefined;
    if (this.facing !== dir) {
      this.facing = dir;
      this.bumpFrames = undefined;
      if (this.turnArmed) {
        this.turnArmed = false;
        this.turnTimer = TURN_FRAMES;
        return "turned";
      }
    }
    if (this.turnTimer > 0) return undefined;

    const d = Map.DELTA[dir]!;
    const tx = this.cellX + d[0];
    const ty = this.cellY + d[1];
    let [allowed, why] = verdict(this, map, entities, tx, ty);
    // Per-step hot path: with an empty chain this costs one lookup.
    if (Runtime.wantsHook("movement.collision")) {
      const ctx = { map, mover: this, dir,
                    fromX: this.cellX, fromY: this.cellY,
                    toX: tx, toY: ty, reason: why };
      allowed = Runtime.call("movement.collision", passthrough, allowed, ctx as any);
      why = ctx.reason;
    }
    if (!allowed) {
      // World:movePlayer tells the two refusals apart: "edge" asks the
      // connection table, "blocked" is a bump
      // (engine/overworld/player_movement.asm:93-106, :525-531).
      // engine/overworld/movement.asm:315
      this.bumpFrames = 1;
      return why === "bounds" ? "edge" : "blocked";
    }
    this.targetX = tx;
    this.targetY = ty;
    this.moving = true;
    this.bumpFrames = undefined;
    this.progress = 0;
    return "moved";
  }

  // Lua: Player.lua:137-140 -- engine/overworld/player_movement.asm:807
  stopForEvent(): void {
    this.bumpFrames = undefined;
  }

  // Lua: Player.lua:142-145 -- cutscene step: ignores collision.
  scriptFace(dir?: Facing): void {
    if (dir) this.facing = dir;
  }

  // Lua: Player.lua:147-161
  scriptStep(dir?: Facing): boolean {
    if (this.moving) return false;
    // A scripted step names its own STEP_* (SurfStartStep is a slow step),
    // so it never inherits the bike's shorter one.
    this.stepFrames = STEP_FRAMES;
    // engine/overworld/map_objects.asm:284-294
    if (!this.fixedFacing) this.facing = dir ?? this.facing;
    const d = Map.DELTA[dir ?? this.facing];
    if (!d) return false;
    this.targetX = this.cellX + d[0];
    this.targetY = this.cellY + d[1];
    this.moving = true;
    this.bumpFrames = undefined;
    this.progress = 0;
    return true;
  }

  // Lua: Player.lua:163-176 -- engine/overworld/movement.asm:741
  scriptJump(dir?: Facing): boolean {
    if (this.moving) return false;
    if (!this.fixedFacing) this.facing = dir ?? this.facing;
    const d = Map.DELTA[dir ?? this.facing];
    if (!d) return false;
    this.targetX = this.cellX + d[0] * 2;
    this.targetY = this.cellY + d[1] * 2;
    this.moving = true;
    this.jumping = true;
    this.bumpFrames = undefined;
    this.inGrass = false;
    this.grassShake = undefined;
    this.progress = 0;
    this.stepFrames = STEP_FRAMES * 2;
    return true;
  }

  // Lua: Player.lua:183-189 -- map_objects.asm:1481-1493,
  // map_object_action.asm:133
  scriptSpin(frames?: number, flicker?: unknown): void {
    if (!frames || frames <= 0) return;
    this.spinFrames = frames;
    this.spinFlicker = flicker || undefined;
    this.spinTimer = (SPIN_START[this.facing] ?? 0) * 4;
  }

  // Lua: Player.lua:191-196 -- Gen 1's name for the cell being faced.
  // Returns [x, y].
  facingCell(): [number, number] {
    const d = Map.DELTA[this.facing] ?? Map.DELTA.down!;
    return [this.cellX + d[0], this.cellY + d[1]];
  }

  // Lua: Player.lua:198-210
  walkPhase(): number {
    // StepFunction_Turn forces the walking leg frame for the whole 4-frame
    // turn-in-place.
    if (this.turnTimer > 0) return 1;
    if (!this.moving) {
      // map_object_action.asm:45-69
      if ((this.bumpFrames ?? 0) <= 0) return 0;
      // map_object_action.asm:98-119
      return (Math.floor(this.animClock / STEP_FRAMES) % 2 === 1) ? 1 : 0;
    }
    const p = this.animClock % STEP_FRAMES;
    return (p >= 4 && p < 12) ? 1 : 0;
  }

  // Lua: Player.lua:212-217 -- map_object_action.asm:71-94
  drawFlip(): boolean {
    if (this.moving || (this.bumpFrames ?? 0) <= 0) return this.stepFlip;
    const mirrored = Math.floor(this.animClock / (STEP_FRAMES * 2)) % 2 === 1;
    return this.stepFlip !== mirrored;
  }

  // Lua: Player.lua:219-272 -- true on the frame a step lands.
  update(): boolean {
    if (this.turnTimer > 0) {
      this.turnTimer = this.turnTimer - 1;
    }
    if (this.spinFrames != null) {
      this.spinTimer = (this.spinTimer ?? 0) + 1;
      this.spinFrames = this.spinFrames - 1;
      if (this.spinFrames <= 0) {
        this.spinFrames = undefined;
        this.spinFlicker = undefined;
      }
    }
    if (!this.moving) {
      // map_objects.asm:1517-1525
      if ((this.bumpFrames ?? 0) > 0) {
        this.bumpFrames = this.bumpFrames! - 1;
        this.animClock = this.animClock + 1;
      }
      // Re-arm turn-in-place once a poll finds no held direction (caller
      // clears this while a dir is held; we only set it from idle).
      return false;
    }
    this.progress = this.progress + 1;
    this.animClock = this.animClock + 1;
    // Interpolate toward the TARGET cell: a ledge hop is a two-cell move.
    const frames = this.stepFrames ?? STEP_FRAMES;
    const dx = (this.targetX ?? this.cellX) - this.cellX;
    const dy = (this.targetY ?? this.cellY) - this.cellY;
    // engine/overworld/map_objects.asm:331 -- AddStepVector moves the object
    // every frame, so the span is the whole move.
    const span = Math.max(Math.abs(dx), Math.abs(dy), 1);
    const adv = Math.floor(this.progress * 16 * span / frames);
    this.px = this.cellX * 16 + (dx / span) * adv;
    this.py = this.cellY * 16 + (dy / span) * adv;
    if (this.jumping) {
      // engine/overworld/map_objects.asm:1796 -- one table entry per cart
      // frame, tweened across our doubled step (#1713)
      this.spriteYOffset = Movement.jumpYOffset(this.progress, frames);
    }
    if (this.progress >= frames) {
      this.cellX = this.targetX!;
      this.cellY = this.targetY!;
      this.targetX = undefined;
      this.targetY = undefined;
      this.px = this.cellX * 16;
      this.py = this.cellY * 16;
      this.moving = false;
      this.jumping = undefined;
      this.spriteYOffset = 0;
      this.stepFlip = !this.stepFlip;
      return true;
    }
    return false;
  }

  // Lua: Player.lua:274-297 drawFishing and :299-353 draw: drawing, replaced
  // by viewState(). The state they read is reported below.

  /**
   * Lua: Player.lua:299-353 (Player:draw) -- what it would paint this frame.
   * OBJECT_SPRITE_Y_OFFSET (spriteYOffset) moves the sprite without moving the
   * player off the tile; StepFunction_GotBite's `xor 1` rod bob rides it.
   * While fishing (self.fishing and self.fishSheet), the standing frame is
   * drawn with the fishing sheet's FISH_ROW over its bottom tiles plus the
   * loose rod tile at ROD_OAM[facing] (facings.asm:122-152) -- reported in
   * `extra.fishing`. During OBJECT_ACTION_SPIN (step_dig) the facing cycles
   * SPIN_FACINGS every 4 frames with phase 0, and a flickering spin hides the
   * sprite on odd frames (map_objects.asm:1481-1493).
   */
  viewState(): ActorView {
    const yOffset = this.spriteYOffset ?? 0;
    let facing: Facing = this.facing;
    let phase = this.walkPhase();
    const flip = this.drawFlip();
    let visible = !this.hidden;
    const extra: Record<string, unknown> = { inGrass: this.inGrass, moving: this.moving };
    if (this.fishing && this.fishSheet) {
      // drawFishing: standing frame, phase 0, no step flip
      phase = 0;
      extra.fishing = {
        sheet: this.fishSheet,
        poseRow: FISH_ROW[facing] ?? 0,
        rod: ROD_OAM[facing] ?? ROD_OAM.down,
      };
      const [frame] = spritePose(this.sprite, facing, 0, false);
      return {
        px: this.px, py: this.py + yOffset, cellX: this.cellX, cellY: this.cellY,
        facing, phase, flip: false, frame, mirror: false,
        spriteId: this.spriteDef ? this.spriteDef.id : undefined,
        gfx: spriteGfx(this.spriteDef), visible: visible && !!this.sprite,
        palette: this.spriteDef ? this.spriteDef.paletteId : undefined, extra,
      };
    }
    if (this.spinFrames != null) {
      // map_objects.asm:1481-1493
      if (this.spinFlicker && this.spinFrames % 2 === 1) visible = false;
      facing = SPIN_FACINGS[Math.floor((this.spinTimer ?? 0) / 4) % 4]!;
      phase = 0;
      extra.spinning = true;
    }
    if (this.jumping) extra.jumping = true;
    if (this.grassShake != null) extra.grassShake = this.grassShake;
    const [frame, mirror] = spritePose(this.sprite, facing, phase, flip);
    return {
      px: this.px, py: this.py + yOffset, cellX: this.cellX, cellY: this.cellY,
      facing, phase, flip, frame, mirror,
      spriteId: this.spriteDef ? this.spriteDef.id : undefined,
      gfx: spriteGfx(this.spriteDef),
      // No sheet: the Lua draws a fallback rectangle (an old cache); the
      // renderer decides what a sheetless actor looks like.
      visible,
      palette: this.spriteDef ? this.spriteDef.paletteId : undefined,
      extra,
    };
  }
}

export default Player;
