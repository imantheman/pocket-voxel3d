// Gen 2 map object: walks / spins from SPRITEMOVEDATA_* + object_event
// radius (not Gen 1's WALK/STAY + range strings).
// A port of gen1recomp src/world/gen2/Npc.lua at bdfac727 (MIT).
//
// The Lua draws via SpriteRenderer (draw, drawBig, drawBigAsym); here the
// voxel renderer draws, reading `viewState()` -- the ActorView the Lua's
// NPC:draw would have painted. All movement state and timing is the Lua's.

import { Logger } from "../shared/core/Logger.ts";
import { Map } from "./Map.ts";
import { Movement } from "../script/Movement.ts";
import { Permissions } from "./Permissions.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { random } from "../platform/rng.ts";
import { format, tostring } from "../platform/lua.ts";
import { SpriteHandle, spriteGfx, spritePose, type ActorView, type Facing } from "./Player.ts";

// Lua: Npc.lua:14
const STEP_FRAMES = 16;

// Lua: Npc.lua:16-20 -- OBJECT_ACTION_SPIN's own cadence: a quarter every
// four frames.
const SPIN_FACINGS: Facing[] = ["down", "left", "up", "right"];
const SPIN_FRAMES_PER_FACING = 4;

// Lua: Npc.lua:22-48 -- constants/map_object_constants.asm
const MOVE = {
  STILL: 1,
  WANDER: 2,
  SPINRANDOM_SLOW: 3,
  WALK_UP_DOWN: 4,
  WALK_LEFT_RIGHT: 5,
  STANDING_DOWN: 6,
  STANDING_UP: 7,
  STANDING_LEFT: 8,
  STANDING_RIGHT: 9,
  SPINRANDOM_FAST: 10,
  // data/sprites/map_objects.asm:181-187
  POKEMON: 0x16,
  SPINCOUNTERCLOCKWISE: 0x1e,
  SPINCLOCKWISE: 0x1f,
  // The three rows whose palette-flags byte is `STRENGTH_BOULDER |
  // BIG_OBJECT`: BIG_OBJECT is the bit IsNPCAtCoord tests before handing the
  // coordinate to WillObjectIntersectBigObject -- so the object is TWO cells
  // wide and two tall for collision and for an A press alike (the sleeping
  // Snorlax outside Vermilion $15, PLAYERS_HOUSE_2F's big doll $21).
  BIGDOLLSYM: 0x15,
  BIGDOLLASYM: 0x20,
  BIGDOLL: 0x21,
  SWIM_WANDER: 0x24,
};

// Lua: Npc.lua:50-54
const BIG_OBJECT: Record<number, boolean> = {
  [MOVE.BIGDOLLSYM]: true,
  [MOVE.BIGDOLLASYM]: true,
  [MOVE.BIGDOLL]: true,
};

// Lua: Npc.lua:56-68 -- every SPRITEMOVEDATA row whose flags1 carries
// FIXED_FACING. Re-seeded in NPC.new rather than latched: a scripted
// `fix_facing` dies at the next rebuildPeople, as a respawn loses it.
const FIXED_FACING_MOVE: Record<number, boolean> = {
  0x01: true, 0x15: true, 0x16: true, 0x17: true,
  0x18: true, 0x19: true, 0x1b: true, 0x1c: true,
  0x20: true, 0x21: true, 0x22: true, 0x23: true,
};

// Lua: Npc.lua:70-78 -- SetFacingBigDoll: $21 takes the symmetric table only
// for SPRITE_BIG_SNORLAX and SPRITE_BIG_LAPRAS.
const BIG_DOLL_SYM_SPRITES: Record<string, boolean> = {
  SPRITE_BIG_SNORLAX: true,
  SPRITE_BIG_LAPRAS: true,
};

// Lua: Npc.lua:87-104
const FACING_FROM_MOVE: Record<number, Facing> = {
  [MOVE.STILL]: "down",
  [MOVE.WANDER]: "down",
  [MOVE.SPINRANDOM_SLOW]: "down",
  [MOVE.WALK_UP_DOWN]: "down",
  [MOVE.WALK_LEFT_RIGHT]: "left",
  [MOVE.STANDING_DOWN]: "down",
  [MOVE.STANDING_UP]: "up",
  [MOVE.STANDING_LEFT]: "left",
  [MOVE.STANDING_RIGHT]: "right",
  [MOVE.SPINRANDOM_FAST]: "down",
  [MOVE.SWIM_WANDER]: "down",
  // The two spin rows start LEFT / RIGHT (data/sprites/map_objects.asm:245-256).
  [MOVE.SPINCOUNTERCLOCKWISE]: "left",
  [MOVE.SPINCLOCKWISE]: "right",
};

// Lua: Npc.lua:106-108
const DIRS_Y: Facing[] = ["up", "down"];
const DIRS_X: Facing[] = ["left", "right"];
const DIRS_ANY: Facing[] = ["up", "down", "left", "right"];

// Lua: Npc.lua:110-121 -- _MovementSpinTurnRight / _MovementSpinTurnLeft
// (engine/overworld/map_objects.asm:826-843), "from this facing, next this
// one". DETERMINISTIC quarter turns (the Rocket base guard puzzles).
const SPIN_NEXT: Record<string, Record<string, Facing>> = {
  clockwise: { down: "left", up: "right", left: "up", right: "down" },
  counterclockwise: { down: "right", up: "left", left: "down", right: "up" },
};

// Lua: Npc.lua:123-126 -- _MovementSpinRepeat: a fixed sixteen frames.
const SPIN_TURN_FRAMES = 16;

// Lua: Npc.lua:128-130 -- map_object_action.asm:184-201, events.asm:175-189
const BOUNCE_PERIOD = 32;
const BOUNCE_HALF = 16;

// Lua: Npc.lua:132-144 -- love.math.random / math.random.
function rand(a: number, b: number): number {
  return random(a, b);
}
function randf(): number {
  return random();
}

type Pattern = [kind: string, dirs?: any, spinLo?: number, spinHi?: number];

// Lua: Npc.lua:146-164
function patternFor(movement: number): Pattern {
  if (movement === MOVE.WALK_UP_DOWN) {
    return ["walk", DIRS_Y];
  } else if (movement === MOVE.WALK_LEFT_RIGHT) {
    return ["walk", DIRS_X];
  } else if (movement === MOVE.WANDER || movement === MOVE.SWIM_WANDER) {
    return ["walk", DIRS_ANY];
  } else if (movement === MOVE.SPINRANDOM_SLOW) {
    return ["spin", DIRS_ANY, 60, 180];
  } else if (movement === MOVE.SPINRANDOM_FAST) {
    return ["spin", DIRS_ANY, 20, 60];
  } else if (movement === MOVE.SPINCLOCKWISE) {
    return ["turn", SPIN_NEXT.clockwise, SPIN_TURN_FRAMES, SPIN_TURN_FRAMES];
  } else if (movement === MOVE.SPINCOUNTERCLOCKWISE) {
    return ["turn", SPIN_NEXT.counterclockwise,
      SPIN_TURN_FRAMES, SPIN_TURN_FRAMES];
  }
  return ["stand", undefined];
}

// Lua: Npc.lua:166-173 -- Gen 1's two behaviour strings onto the cart's
// SPRITEMOVEDATA byte. STAY is STANDING_*, never STILL.
const GEN1_STAY: Record<string, number> = {
  UP: MOVE.STANDING_UP, DOWN: MOVE.STANDING_DOWN,
  LEFT: MOVE.STANDING_LEFT, RIGHT: MOVE.STANDING_RIGHT,
};

// Lua: Npc.lua:181
const warnedGen1Sprite: Record<string, boolean> = {};

// Lua: Npc.lua:183-224 -- src/world/NPC.lua:23's shape: (data, mapId,
// objDef), sniffed so a gen2compat mod's facade IS this class.
function fromGen1(data: any, mapId: any, objDef: any): NPC {
  const movement = objDef.movement;
  const range = objDef.range;
  let mv: number;
  let radius: any;
  if (typeof movement === "number") {
    mv = movement;
    radius = objDef.radius;
  } else if (movement === "WALK") {
    if (range === "UP_DOWN") mv = MOVE.WALK_UP_DOWN;
    else if (range === "LEFT_RIGHT") mv = MOVE.WALK_LEFT_RIGHT;
    else mv = MOVE.WANDER;
    radius = objDef.radius ?? { x: 3, y: 3 };
  } else {
    mv = GEN1_STAY[range] ?? MOVE.STANDING_DOWN;
  }
  const sprites = data ? (data.gen2Sprites ?? data.sprites) : undefined;
  let def = sprites && objDef.sprite != null ? sprites[objDef.sprite] : undefined;
  if (!def) {
    const key = tostring(objDef.sprite);
    if (!warnedGen1Sprite[key]) {
      warnedGen1Sprite[key] = true;
      Logger.warn("src.world.NPC: no %s in Gold's sprite table; using the "
        + "player sheet", key);
    }
    const fallback = NPC.fallbackSpriteDef;
    def = typeof fallback === "function" ? fallback() : fallback;
  }
  if (!def) {
    throw new Error("src.world.NPC: no sprite record for " + tostring(objDef.sprite));
  }
  const npc = NPC.new(mapId, {
    index: objDef.index, name: objDef.name, sprite: objDef.sprite,
    movement: mv, radius, x: objDef.x, y: objDef.y,
  }, def);
  // the Gen 1 SPRITE_* id the caller passed in
  npc.spriteId = objDef.sprite;
  return npc;
}

// Lua: Npc.lua:494-505 -- `passable` is the follower's escape.
function occupied(entities: any[] | undefined, tx: number, ty: number, self: NPC): boolean {
  if (!entities) return false;
  for (const e of entities) {
    if (e !== self && !e.passable) {
      if (e.cellX === tx && e.cellY === ty) return true;
      if (e.moving && e.targetX === tx && e.targetY === ty) return true;
    }
  }
  return false;
}

// Lua: Npc.lua:507-510 -- the movement.collision chain's vanilla link.
function passthrough(allowed: boolean, _ctx?: unknown): boolean { return allowed; }

// Lua: Npc.lua:512-519
function wanderVerdict(self: NPC, map: any, entities: any[] | undefined, tx: number, ty: number): [boolean, string?] {
  if (!self.inRadius(tx, ty)) return [false, "radius"];
  if (!map.isWalkable(tx, ty)) return [false, "tile"];
  // don't walk out through doors
  if (map.warpAt(tx, ty)) return [false, "warp"];
  if (occupied(entities, tx, ty, self)) return [false, "entity"];
  return [true];
}

// Lua: Npc.lua:711-731 -- FacingBigDollAsymmetric (data/sprites/facings.asm)
// as `{ y, x, xflip, tile }` rows: fourteen 8x8 tiles over a 32x32 square.
const BIG_DOLL_ASYM: [number, number, boolean, number][] = [
  [0, 0, false, 0x00],
  [0, 8, false, 0x01],
  [8, 0, false, 0x04],
  [8, 8, false, 0x05],
  [16, 8, false, 0x07],
  [24, 8, false, 0x0a],
  [0, 24, false, 0x03],
  [0, 16, false, 0x02],
  [8, 24, true, 0x02],
  [8, 16, false, 0x06],
  [16, 24, false, 0x09],
  [16, 16, false, 0x08],
  [24, 24, true, 0x04],
  [24, 16, false, 0x0b],
];

export class NPC {
  static MOVE = MOVE;
  static patternFor = patternFor;
  static BIG_DOLL_ASYM = BIG_DOLL_ASYM;

  // Lua: Npc.lua:175-179 -- the sheet a Gen 1 NPC.new falls back to when its
  // SPRITE_* id is not in Gold's table (Gen2Compat points it at the player's).
  static fallbackSpriteDef: any = undefined;

  // World, Follower, the VM and mods hang more on an object as the Lua does
  // (talk flags, emote, followState, trainer bits, ...).
  [key: string]: any;

  def: any;
  id: string;
  mapId: string;
  cellX: number;
  cellY: number;
  homeX: number;
  homeY: number;
  px: number;
  py: number;
  facing: Facing;
  moving = false;
  progress = 0;
  stepFlip = false;
  /** OBJECT_FLAGS2's IN_GRASS_F, set from the spawn tile by the
   * STEP_TYPE_RESET latch in update(). */
  inGrass = false;
  spawnLatched = false;
  frozen = false;
  kind: string;
  roamDirs: any;
  radiusX: number;
  radiusY: number;
  spinLo: number | undefined;
  spinHi: number | undefined;
  bigObject: boolean;
  bigFacing: "sym" | "asym" | undefined;
  fixedFacing: true | undefined;
  bouncing: true | undefined;
  bounceStep = 0;
  timer: number;
  sprite: SpriteHandle;
  spriteDef: any;
  targetX: number | undefined = undefined;
  targetY: number | undefined = undefined;
  stepDir: Facing | undefined = undefined;
  jumping: boolean | undefined = undefined;
  spriteYOffset: number | undefined = undefined;
  teleport: { mode: "to" | "from"; frame: number; frames: number } | undefined = undefined;
  treeShake: { frame: number; frames: number } | undefined = undefined;
  rockSmash: { frame: number; frames: number } | undefined = undefined;

  // Lua: Npc.lua:226-272 (the Gold arm; the Gen 1 arm is fromGen1 above).
  constructor(mapId: string, objDef: any, spriteDef: any) {
    const movement = objDef.movement ?? MOVE.STILL;
    const [kind, dirs, spinLo, spinHi] = patternFor(movement);
    const radius = objDef.radius ?? {};
    this.def = objDef;
    this.id = format("%s_obj_%d", mapId, objDef.index ?? 0);
    this.mapId = mapId;
    this.cellX = objDef.x;
    this.cellY = objDef.y;
    this.homeX = objDef.x;
    this.homeY = objDef.y;
    this.px = objDef.x * 16;
    this.py = objDef.y * 16;
    this.facing = FACING_FROM_MOVE[movement] ?? "down";
    this.kind = kind;
    this.roamDirs = dirs;
    this.radiusX = radius.x ?? 0;
    this.radiusY = radius.y ?? 0;
    this.spinLo = spinLo;
    this.spinHi = spinHi;
    this.bigObject = BIG_OBJECT[movement] === true;
    this.bigFacing = NPC.bigFacing(movement, spriteDef ? spriteDef.id : undefined);
    this.fixedFacing = FIXED_FACING_MOVE[movement] ? true : undefined;
    this.bouncing = movement === MOVE.POKEMON ? true : undefined;
    this.timer = rand(30, 120);
    this.sprite = SpriteHandle.new(spriteDef, format("%s_obj_%d", mapId, objDef.index ?? 0));
    // The sheet is grayscale; PAL_OW_* crossed with the time of day decides
    // the real colors. World:applyPalettes pushes them into the sprite
    // handle and refreshes them when the clock rolls over.
    this.spriteDef = spriteDef;
  }

  static new(mapId: any, objDef: any, spriteDef?: any): NPC {
    // Gen 1 passes the DATA table first; Gold's first argument is always the
    // map id string.
    if (mapId !== null && typeof mapId === "object") return fromGen1(mapId, objDef, spriteDef);
    return new NPC(mapId, objDef, spriteDef);
  }

  // Lua: Npc.lua:80-85
  static bigFacing(movement: unknown, spriteId: unknown): "sym" | "asym" | undefined {
    if (movement === MOVE.BIGDOLLSYM) return "sym";
    if (movement === MOVE.BIGDOLLASYM) return "asym";
    if (movement !== MOVE.BIGDOLL) return undefined;
    return BIG_DOLL_SYM_SPRITES[spriteId as string] ? "sym" : "asym";
  }

  // Lua: Npc.lua:274-297 -- `variablesprite` on a slot this object reads
  // through: the sheet changes and NOTHING else does (the object struct is
  // never touched: coordinates, facing, FROZEN_F and wLastTalked survive).
  setSpriteDef(spriteDef: any): boolean {
    if (!spriteDef || spriteDef === this.spriteDef) return false;
    this.spriteDef = spriteDef;
    this.sprite = SpriteHandle.new(spriteDef, this.id);
    // bigFacing is derived from the SHEET, so it is recomputed with it.
    this.bigFacing = NPC.bigFacing(this.def ? this.def.movement : undefined, spriteDef.id);
    return true;
  }

  // Lua: Npc.lua:299
  inRadius(tx: number, ty: number): boolean {
    return Math.abs(tx - this.homeX) <= this.radiusX
       && Math.abs(ty - this.homeY) <= this.radiusY;
  }

  // Lua: Npc.lua:304-315 -- WillObjectIntersectBigObject: the object's own
  // coordinates are the TOP LEFT of a big object's 2x2 blob.
  covers(cx: number, cy: number): boolean {
    if (!this.bigObject) {
      return this.cellX === cx && this.cellY === cy;
    }
    const dx = cx - this.cellX;
    const dy = cy - this.cellY;
    return dx >= 0 && dx < 2 && dy >= 0 && dy < 2;
  }

  // Lua: Npc.lua:317-331 -- ApplyObjectFacing refuses a fixed-facing object,
  // and a STILL_SPRITE has only the one pose.
  facePlayer(player: { cellX: number; cellY: number }): void {
    if (this.fixedFacing) return;
    if (this.spriteDef && (this.spriteDef.frames ?? 0) <= 1) return;
    const dx = player.cellX - this.cellX;
    const dy = player.cellY - this.cellY;
    if (Math.abs(dx) > Math.abs(dy)) {
      this.facing = dx > 0 ? "right" : "left";
    } else {
      this.facing = dy > 0 ? "down" : "up";
    }
  }

  // Lua: Npc.lua:333
  scriptFace(dir?: Facing): void {
    if (this.fixedFacing) return;
    if (dir) this.facing = dir;
  }

  // Lua: Npc.lua:338-360 -- the direction the object MOVES in and the one it
  // is DRAWN facing are two bytes; FIXED_FACING_F or SLIDING_F walks it
  // across the map without turning it.
  scriptStep(dir?: Facing): boolean {
    if (this.moving) return false;
    this.stepDir = dir ?? this.facing;
    if (!this.fixedFacing && !this.sliding) {
      this.facing = this.stepDir;
    }
    const d = Map.DELTA[this.stepDir];
    if (!d) {
      this.stepDir = undefined;
      return false;
    }
    this.targetX = this.cellX + d[0];
    this.targetY = this.cellY + d[1];
    this.moving = true;
    this.progress = 0;
    this.frozen = true;
    return true;
  }

  // Lua: Npc.lua:362-380 -- engine/overworld/movement.asm:741
  scriptJump(dir?: Facing): boolean {
    if (this.moving) return false;
    this.stepDir = dir ?? this.facing;
    if (!this.fixedFacing && !this.sliding) {
      this.facing = this.stepDir;
    }
    const d = Map.DELTA[this.stepDir];
    if (!d) {
      this.stepDir = undefined;
      return false;
    }
    this.targetX = this.cellX + d[0] * 2;
    this.targetY = this.cellY + d[1] * 2;
    this.moving = true;
    this.jumping = true;
    this.inGrass = false;
    this.grassShake = undefined;
    this.progress = 0;
    this.frozen = true;
    return true;
  }

  // Lua: Npc.lua:382-401 -- StepFunction_TeleportFrom / _TeleportTo: `from` is
  // a beat spinning on the spot then a beat rising; `to` is a still wait, a
  // spinning descent and a last spin. Sets `frozen`: World:beginMovement's
  // own sleep counter waits it out.
  scriptTeleport(mode?: string, frames?: number): boolean {
    const beat = Movement.TELEPORT_BEAT_FRAMES;
    this.teleport = {
      mode: mode === "to" ? "to" : "from",
      frame: 0,
      frames: frames ?? ((mode === "to") ? 3 * beat : 2 * beat),
    };
    this.frozen = true;
    this.spriteYOffset = 0;
    return true;
  }

  // Lua: Npc.lua:403-444 -- one frame of that step type; false once the last
  // beat is over.
  updateTeleport(): boolean {
    const st = this.teleport;
    if (!st) return false;
    const beat = Movement.TELEPORT_BEAT_FRAMES;
    st.frame = st.frame + 1;
    let spinning = true;
    if (st.mode === "from") {
      if (st.frame <= beat) {
        // .DoSpin: still on its tile for the first beat.
        this.spriteYOffset = 0;
      } else {
        // .DoSpinRise: OBJECT_JUMP_HEIGHT starts at $10, +1 a frame.
        this.spriteYOffset = Movement.teleportYOffset(
          Movement.TELEPORT_RISE_HEIGHT + (st.frame - beat));
      }
    } else if (st.frame <= beat) {
      // .DoWait holds OBJECT_ACTION_00, so nothing spins.
      spinning = false;
      this.spriteYOffset = Movement.teleportYOffset(
        Movement.TELEPORT_FALL_HEIGHT);
    } else if (st.frame <= 2 * beat) {
      // .DoDescent, the rise's curve read backwards.
      this.spriteYOffset = Movement.teleportYOffset(st.frame - beat);
    } else {
      // .DoFinalSpin, back on the ground.
      this.spriteYOffset = 0;
    }
    if (spinning) {
      this.facing = SPIN_FACINGS[
        Math.floor(st.frame / SPIN_FRAMES_PER_FACING) % SPIN_FACINGS.length]!;
    }
    if (st.frame >= st.frames) {
      this.teleport = undefined;
      this.spriteYOffset = 0;
      return false;
    }
    return true;
  }

  // Lua: Npc.lua:446-458 -- Movement_tree_shake (engine/overworld/movement.asm:334):
  // OBJECT_ACTION_WEIRD_TREE on STEP_TYPE_SLEEP for 24 frames.
  scriptTreeShake(frames?: number): boolean {
    this.treeShake = {
      frame: 0,
      frames: frames ?? Movement.TREE_SHAKE_FRAMES,
    };
    this.frozen = true;
    return true;
  }

  // Lua: Npc.lua:460-471
  updateTreeShake(): boolean {
    const st = this.treeShake;
    if (!st) return false;
    st.frame = st.frame + 1;
    if (st.frame >= st.frames) {
      this.treeShake = undefined;
      return false;
    }
    return true;
  }

  // Lua: Npc.lua:473-481 -- engine/overworld/map_objects.asm:1462
  scriptRockSmash(frames?: number): boolean {
    this.rockSmash = {
      frame: 0,
      frames: frames ?? 10,
    };
    this.frozen = true;
    return true;
  }

  // Lua: Npc.lua:483-492
  updateRockSmash(): boolean {
    const st = this.rockSmash;
    if (!st) return false;
    st.frame = st.frame + 1;
    if (st.frame >= st.frames) {
      this.rockSmash = undefined;
      return false;
    }
    return true;
  }

  // Lua: Npc.lua:521-530 -- a sliding object holds its step frame as well as
  // its facing (map_object_action.asm:48): it glides.
  walkPhase(): number {
    if (this.sliding) return 0;
    if (!this.moving) return 0;
    const frames = this.stepFrames ?? STEP_FRAMES;
    const p = this.progress % frames;
    return (p >= frames / 4 && p < frames * 3 / 4) ? 1 : 0;
  }

  // Lua: Npc.lua:532-538 -- OBJECT_ACTION_BOUNCE's two columns, SetFacingBounce
  // and SetFacingFreezeBounce (map_object_action.asm:184-201). A frame
  // override, or undefined for an object that does not bounce.
  bounceFrame(): number | undefined {
    if (!this.bouncing) return undefined;
    if (this.frozen) return 0;
    return ((this.bounceStep ?? 0) >= BOUNCE_HALF) ? 1 : 0;
  }

  // Lua: Npc.lua:540-545 -- Gen 1's seven-value entity pose, as a tuple.
  pose(): [SpriteHandle, number, number, Facing, number, boolean, boolean] {
    return [this.sprite, this.px, this.py + (this.spriteYOffset ?? 0),
      this.facing, this.walkPhase(), this.stepFlip, false];
  }

  // Lua: Npc.lua:547-552 -- SetTallGrassFlags' test (map_objects.asm:247).
  static grassAt(map: any, cx: number | undefined, cy: number | undefined): boolean {
    if (!(map && map.cellCollision && cx != null && cy != null)) return false;
    const coll = map.cellCollision(cx, cy);
    return Permissions.isSuperTallGrass(coll) || Permissions.isGrass(coll);
  }

  // Lua: Npc.lua:554-685
  update(map: any, entities?: any[]): void {
    // STEP_TYPE_RESET's StepFunction_Reset reads the object's OWN tile into
    // SetTallGrassFlags (map_objects.asm:498-511, :196-208).
    if (!this.spawnLatched && map) {
      this.spawnLatched = true;
      this.inGrass = NPC.grassAt(map, this.cellX, this.cellY);
    }
    if (this.bouncing && !this.frozen) {
      this.bounceStep = ((this.bounceStep ?? 0) + 1) % BOUNCE_PERIOD;
    }
    // The teleport step type owns the object outright, so it runs above the
    // frozen gate the way the walk interpolation does.
    if (this.teleport) {
      this.updateTeleport();
      return;
    }
    // STEP_TYPE_SLEEP with OBJECT_ACTION_WEIRD_TREE owns it the same way.
    if (this.treeShake) {
      this.updateTreeShake();
      return;
    }
    if (this.rockSmash) {
      this.updateRockSmash();
      return;
    }
    // NPC_CHANGE_FACING (src/world/NPC.lua:71): one walk cycle in place, no
    // translation; above the moving arm because it has no targetX.
    if (this.marching) {
      this.moving = true;
      this.progress = this.progress + 1;
      if (this.progress >= (this.stepFrames ?? STEP_FRAMES)) {
        this.progress = 0;
        this.moving = false;
        this.marching = false;
        this.stepFlip = !this.stepFlip;
      }
      return;
    }
    if (this.moving) {
      // NormalStep's begin-of-step grass work (movement.asm:657-674);
      // UpdateTallGrassFlags only RE-tests while IN_GRASS is set
      // (map_objects.asm:226).
      if (this.progress === 0 && map && !this.jumping) {
        const grass = NPC.grassAt(map, this.targetX, this.targetY);
        if (this.inGrass) this.inGrass = grass;
        this.grassShake = grass || undefined;
      }
      this.progress = this.progress + 1;
      // Toward the TARGET: a follower's ledge hop is a two-cell move over one
      // step, and `stepFrames` lets it keep pace with a bike.
      let frames = this.stepFrames ?? STEP_FRAMES;
      // engine/overworld/map_objects.asm:1129
      if (this.jumping) frames = STEP_FRAMES * 2;
      const moved = Math.floor(this.progress * 16 / frames);
      const dx = (this.targetX ?? this.cellX) - this.cellX;
      const dy = (this.targetY ?? this.cellY) - this.cellY;
      this.px = this.cellX * 16 + dx * moved;
      this.py = this.cellY * 16 + dy * moved;
      if (this.jumping) {
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
        this.stepDir = undefined;
        if (this.jumping) {
          this.jumping = undefined;
          this.spriteYOffset = 0;
        }
        this.stepFlip = !this.stepFlip;
        // CopyCoordsTileToLastCoordsTile -> SetTallGrassFlags at the step's
        // end (map_objects.asm:196-208, :247).
        if (map) {
          this.inGrass = NPC.grassAt(map, this.cellX, this.cellY);
        }
      }
      return;
    }

    if (this.frozen || this.kind === "stand") return;

    this.timer = this.timer - 1;
    if (this.timer > 0) return;

    if (this.kind === "spin") {
      this.timer = rand(this.spinLo ?? 60, this.spinHi ?? 180);
      this.facing = this.roamDirs[rand(1, this.roamDirs.length) - 1];
      return;
    }

    // SPINCLOCKWISE / SPINCOUNTERCLOCKWISE: one quarter turn in a FIXED order
    // every sixteen frames, never a re-roll.
    if (this.kind === "turn") {
      this.timer = this.spinLo ?? SPIN_TURN_FRAMES;
      this.facing = this.roamDirs[this.facing] ?? this.facing;
      return;
    }

    // walk
    this.timer = rand(30, 180);
    const dir: Facing = this.roamDirs[rand(1, this.roamDirs.length) - 1];
    this.facing = dir;
    if (randf() < 0.5) return; // sometimes just turn, like Gen 1
    const d = Map.DELTA[dir]!;
    const tx = this.cellX + d[0];
    const ty = this.cellY + d[1];
    let [allowed, why] = wanderVerdict(this, map, entities, tx, ty);
    // movement.collision serves every mover; "radius" and "warp" are Gen 2's
    // own refusals, additions to Gen 1's bounds / tile / entity.
    if (Runtime.wantsHook("movement.collision")) {
      const ctx = { map, mover: this, dir,
                    fromX: this.cellX, fromY: this.cellY,
                    toX: tx, toY: ty, reason: why };
      allowed = Runtime.call("movement.collision", passthrough, allowed, ctx as any);
    }
    if (!allowed) return;
    this.targetX = tx;
    this.targetY = ty;
    this.moving = true;
    this.progress = 0;
  }

  // Lua: Npc.lua:687-709 drawBig, :743-771 bigDollQuads/drawBigAsym and
  // :773-818 draw: drawing, replaced by viewState().

  // Lua: Npc.lua:735-741 -- a tile index is four to a 16x16 sheet frame, row
  // major: tile t sits at ((t % 2) * 8, (t // 4) * 16 + ((t % 4) // 2) * 8).
  // Returns [sx, sy].
  static bigDollTileRect(tile: number): [number, number] {
    return [(tile % 2) * 8,
      Math.floor(tile / 4) * 16 + Math.floor((tile % 4) / 2) * 8];
  }

  /**
   * Lua: Npc.lua:773-818 (NPC:draw) -- what it would paint this frame.
   * OBJECT_SPRITE_Y_OFFSET moves the sprite without moving the object off its
   * tile. Kinds, in the Lua's order:
   *  - big object (extra.big = "sym" | "asym"): a 32x32 doll over the 2x2
   *    blob covers() describes, drawn 4 px up (the lift every OW sprite
   *    gets). "sym" is frames 0 over 1 with the right half mirrored
   *    (FacingBigDollSymmetric); "asym" is the BIG_DOLL_ASYM tile rows.
   *  - tree shake (extra.treeShake = quarter 0..3): SetFacingWeirdTree rocks
   *    right, upright, left, upright: quarters 1 and 3 draw the "up" frame,
   *    3 mirrored (data/sprites/facings.asm:46-52, :185-197).
   *  - rock smash: hidden on even frames (map_objects.asm:1462).
   *  - otherwise the walking pose, with OBJECT_ACTION_BOUNCE's frame override
   *    (bounceFrame()) for a SPRITEMOVEDATA_POKEMON object.
   */
  viewState(): ActorView {
    const yOffset = this.spriteYOffset ?? 0;
    const extra: Record<string, unknown> = { inGrass: this.inGrass, moving: this.moving };
    const base = {
      px: this.px, py: this.py + yOffset, cellX: this.cellX, cellY: this.cellY,
      spriteId: this.spriteDef ? this.spriteDef.id : undefined,
      gfx: spriteGfx(this.spriteDef),
      palette: this.def && this.def.palette ? this.def.palette : (this.spriteDef ? this.spriteDef.paletteId : undefined),
    };
    if (this.grassShake != null) extra.grassShake = this.grassShake;
    if (this.jumping) extra.jumping = true;
    if (this.teleport) extra.teleport = { ...this.teleport };
    if (this.bigObject) {
      extra.big = this.bigFacing === "asym" ? "asym" : "sym";
      return { ...base, facing: this.facing, phase: 0, flip: false, frame: 0, mirror: false,
        visible: true, extra };
    }
    if (this.treeShake) {
      const q = Movement.treeShakeIndex(this.treeShake.frame);
      const facing: Facing = (q === 1 || q === 3) ? "up" : "down";
      const [frame] = spritePose(this.sprite, facing, 0, false);
      extra.treeShake = q;
      return { ...base, facing, phase: 0, flip: false, frame, mirror: q === 3,
        visible: true, extra };
    }
    if (this.rockSmash) {
      extra.rockSmash = this.rockSmash.frame;
      const phase = this.walkPhase();
      const [frame, mirror] = spritePose(this.sprite, this.facing, phase, this.stepFlip);
      return { ...base, facing: this.facing, phase, flip: this.stepFlip, frame, mirror,
        visible: (this.rockSmash.frame % 2) !== 0, extra };
    }
    const phase = this.walkPhase();
    let [frame, mirror] = spritePose(this.sprite, this.facing, phase, this.stepFlip);
    const bounce = this.bounceFrame();
    // SpriteRenderer:draw's frameOverride: a frame the sheet has, unmirrored.
    if (bounce != null && bounce < this.sprite.frameCount) {
      frame = bounce;
      mirror = false;
      extra.bounce = bounce;
    }
    return { ...base, facing: this.facing, phase, flip: this.stepFlip, frame, mirror,
      visible: true, extra };
  }
}

export default NPC;
