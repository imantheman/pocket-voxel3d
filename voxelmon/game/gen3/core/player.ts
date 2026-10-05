// Port of gen1recomp src/core/game3/player.lua (GPLv3 + additional terms; see LICENSE.md).
// Game3 independent player avatar (walk / run with B / facing / ledge hop).
// Owns cell + pixel motion; does not call World:step or Player:tryMove.
// Collision via game3.collision (owned COLL_* grid from extract bake).
//
// Port notes:
// - lazyReq / package.loaded / pcall(lazyReq, X): every module is in the
//   bundle, so each is a static import used exactly as Brian guards it
//   ("is it loaded" is always yes). Modules with no file in the port read as
//   nil (package.loaded) or throw (require): src.core.game3.bike.rse,
//   src.core.game3.flags, src.core.game3.space, src.core.game3.rse.init.
// - Brian's Player is an open table other modules add fields to, so the
//   module type keeps an index signature next to its declared fields.
// - Multiple returns are 0-based tuples: tryMove -> [result, why].
// - Lua's `a or b` where `a` may be 0 uses lor() (0 is true in Lua).

import { seq, len, ipairs, type LuaTable } from "../platform/lt.ts";
import { tonumber, tostring, format, truthy, mod } from "../../../import/gen3/lua.ts";
import { notPorted } from "../notported.ts";
import Collision from "./collision.ts";
import ModRuntime from "../shared/mods/Runtime.ts";
import WarpArrow from "./warp_arrow.ts";
import Bike from "./bike.ts";
import Profile from "./profile.ts";
import Flags from "./scripting/flags.ts";
import Runtime from "./runtime.ts";
import Warp from "./warp.ts";
import FieldMoves from "./field_moves.ts";
import Field from "./field.ts";
import Space from "./scripting/space.ts";
import Objects from "./objects.ts";
import FieldEffects from "./field_effects.ts";
import Audio from "./audio.ts";
import SE from "./se_ids.ts";
import MapMod from "./map.ts";
import RotatingGate from "./rotating_gate.ts";
import ForcedMovement from "./forced_movement.ts";
import StepEvents from "./step_events.ts";
import TrainerSight from "./trainer_sight.ts";
import Encounters from "./encounters.ts";
import Battle from "./battle.ts";
import BattleBridge from "./battle_bridge.ts";
import MB from "./mb.ts";
import Fade from "../ui/fade.ts";

/** What the player reads of an input. */
export interface PlayerInput {
  wasPressed?(k: string): unknown;
  isDown?(k: string): unknown;
  [k: string]: any;
}

export interface PlayerAction {
  frames: number;
  t: number;
  jump?: string;
  turnTo?: string;
  walk?: unknown;
  done?: () => void;
}

export interface AcroAnim { kind: string; clock?: number; paused?: boolean; [k: string]: any }

export interface PlayerForcedStepOpts { keepFacing?: boolean; ledgeX?: number; ledgeY?: number }
export interface PlayerBikeStepOpts { jump?: string; acroAnim?: AcroAnim }
export interface PlayerStartActionOpts {
  frames?: number; jump?: string; turnTo?: string; walk?: unknown; done?: () => void; acroAnim?: AcroAnim;
}

const CELL = 16;
const WALK_FRAMES = 16;
const RUN_FRAMES = 8;
// pokefirered/src/event_object_movement.c:9029 UpdateRunSlowAnim
const RUN_SLOW_FRAMES = 11;
const BIKE_FRAMES = 4;
const TURN_FRAMES = 4;
// pokefirered/include/constants/metatile_behaviors.h:128
const MB_CYCLING_ROAD_PULL_DOWN = 0xD0;
const MB_CYCLING_ROAD_PULL_DOWN_GRASS = 0xD1;
// pokefirered/src/event_object_movement.c:8905 sSpeedFasterStepFuncs
const FASTER_FRAMES = 4;
// pret Jump2 / DoJumpSpriteMovement: JUMP_DISTANCE_FAR = 32 frames.
const JUMP_FRAMES = 32;
// pret sJumpY_High (event_object_movement.c). Jump2 indexes with sTimer >> 1.
const JUMP_Y_HIGH: LuaTable = seq(
  -4, -6, -8, -10, -11, -12, -12, -12,
  -11, -10, -9, -8, -6, -4, 0, 0,
);

const DELTA: Record<string, LuaTable> = {
  up: seq(0, -1),
  down: seq(0, 1),
  left: seq(-1, 0),
  right: seq(1, 0),
};

/** DELTA[dir] (own keys only, as a Lua table lookup). */
function delta(dir: unknown): LuaTable | undefined {
  return typeof dir === "string" && Object.prototype.hasOwnProperty.call(DELTA, dir) ? DELTA[dir] : undefined;
}

/** Lua `a or b`: b only when a is nil or false. */
function lor<A, B>(a: A, b: B): NonNullable<A> | B {
  return a != null && (a as unknown) !== false ? a as NonNullable<A> : b;
}

// pokefirered/src/data/object_events/object_event_anims.h:556
const SPIN_CYCLE: LuaTable = seq("down", "right", "up", "left");
const SPIN_PHASE: Record<string, number> = { down: 1, right: 4, up: 3, left: 2 };

// pokeemerald/src/event_object_movement.c:8424
const JUMP_Y: Record<string, LuaTable> = {
  high: JUMP_Y_HIGH,
  low: seq(0, -2, -3, -4, -5, -6, -6, -6, -5, -5, -4, -3, -2, 0, 0, 0),
  normal: seq(-2, -4, -6, -8, -9, -10, -10, -10, -9, -8, -6, -5, -3, -2, 0, 0),
};

// Lua: player.lua:103
function rseBike(): any {
  // package.loaded["src.core.game3.bike"] or lazyReq("src.core.game3.bike")
  return Bike.rse(undefined);
}

// Lua: player.lua:123
function log(msg: unknown): void {
  console.log("[game3/player] " + tostring(msg));
}

const EMPTY: Record<string, any> = {};

// Lua: player.lua:130
function sessionFlags(session?: any): any {
  const row = Profile.forSession((session != null && typeof session === "object" && session.version) ? session : undefined);
  return Flags.forVersion(row.id);
}

// Lua: player.lua:137
function fieldBlock(): Record<string, any> {
  let row: any;
  try { row = Profile.forSession(); } catch { return EMPTY; }
  return (row && row.field) || EMPTY;
}

// Prefer last-pressed feel: check wasPressed first, else held.
const INPUT_ORDER = ["down", "up", "left", "right"];

// Lua: player.lua:143
function dirs_from_input(input: PlayerInput | undefined | null): string | undefined {
  if (!input) return undefined;
  for (const d of INPUT_ORDER) {
    if (input.wasPressed && truthy(input.wasPressed(d))) return d;
  }
  for (const d of INPUT_ORDER) {
    if (input.isDown && truthy(input.isDown(d))) return d;
  }
  return undefined;
}

// Lua: player.lua:291
function walkInPlaceFrames(): number {
  return Player.walkInPlaceFast ? RUN_FRAMES : WALK_FRAMES;
}

// Lua: player.lua:296
// pokefirered/src/field_effect.c:1215 FallWarpEffect_4
function warp_owns_sprite(): boolean {
  // package.loaded["src.core.game3.warp"]
  return (Warp && Warp.isBusy && Warp.isBusy()) === true;
}

const SURF_HOP_Y: LuaTable = seq(
  -2, -4, -6, -8, -9, -10, -10, -9, -8, -6, -4, -2, 0, 0, 0, 0,
);

// Lua: player.lua:366
function beginStep(tx: number, ty: number, run: unknown, ledge: unknown): void {
  const mdx = tx - Player.cellX, mdy = ty - Player.cellY;
  if (mdx !== 0 || mdy !== 0) {
    Player.moveDir = (mdx > 0 && "right") || (mdx < 0 && "left") || (mdy > 0 && "down") || "up";
  }
  Player.jumpType = undefined;
  Player.acroAnim = undefined;
  Player.updateElevation(tx, ty, Player.cellX, Player.cellY);
  Player.prevCellX = Player.cellX;
  Player.prevCellY = Player.cellY;
  Player.moving = true;
  Player.progress = 0;
  Player.targetX = tx;
  Player.targetY = ty;
  Player.running = !truthy(ledge) && truthy(run);
  Player.jumping = truthy(ledge);
  Player.spriteYOffset = 0;
  if (Player.surfHopping || Player.dismounting) {
    Player.stepFrames = 16;
    Player.jumping = true;
  } else if (truthy(ledge)) {
    Player.stepFrames = JUMP_FRAMES;
  } else if (Player.biking) {
    Player.stepFrames = BIKE_FRAMES;
    Player.running = true;
  } else {
    Player.stepFrames = truthy(run) ? RUN_FRAMES : WALK_FRAMES;
  }
  Player.animClock = 0;

  // pret GroundEffect_StepOnTallGrass when entering a grass cell.
  // pcall(lazyReq, "src.core.game3.field_effects"): always present
  if (FieldEffects) {
    if (Collision.isGrass && Collision.isGrass(tx, ty)) {
      FieldEffects.tallGrassAt(tx, ty, false);
    } else {
      FieldEffects.leaveTallGrass();
    }
  }
}

// Lua: player.lua:407
function stairTrigger(game: any, dir: string): string | undefined {
  // pokefirered/src/field_player_avatar.c:556
  const stair = Collision.isStairWarp
    && Collision.isStairWarp(game, Player.cellX, Player.cellY, dir);
  if (stair) {
    if (Warp.isBusy()) return "stair_busy";
    // package.loaded["src.core.game3.runtime"]
    const md = Runtime && Runtime._mod;
    const g = game || (Runtime && Runtime._game);
    Warp.startStairWarp(md, g, stair.destMap, stair.destX, stair.destY, stair.behavior);
    return "stair";
  }
  return undefined;
}

// lazyReq("src.core.game3.rse.init").call("secretBase", "tryDoorWarp", ...):
// no such module in the port.
function rseInitCall(..._a: unknown[]): any {
  return notPorted("NOT FAITHFUL: Emerald only (src.core.game3.rse.init)");
}

// Lua: player.lua:423
function stepTriggers(game: any, dir: string, wasFacing: string, tx: number, ty: number): string | undefined {
  if (dir === "up") {
    // pokeemerald/src/field_control_avatar.c:837
    if (truthy(FieldMoves.isRse())
        && truthy(rseInitCall("secretBase", "tryDoorWarp", undefined, undefined, game, tx, ty))) {
      return "secret_base_door";
    }
    const doorWarp = Collision.isDoorWarp && Collision.isDoorWarp(game, tx, ty);
    if (doorWarp) {
      if (!Warp.isBusy()) {
        const md = Runtime && Runtime._mod;
        const g = game || (Runtime && Runtime._game);
        Warp.startDoorEntrance(md, g, doorWarp.destMap, doorWarp.destX, doorWarp.destY, tx, ty);
        return "door";
      }
      return "door_busy";
    }
  }

  if (dir === "down") {
    const exitWarp = Collision.isExitWarp && Collision.isExitWarp(game, Player.cellX, Player.cellY);
    if (exitWarp) {
      if (!Warp.isBusy()) {
        const md = Runtime && Runtime._mod;
        const g = game || (Runtime && Runtime._game);
        Warp.startDoorExit(md, g, exitWarp.destMap, exitWarp.destX, exitWarp.destY, Player.cellX, Player.cellY);
        return "exit_door";
      }
      return "door_busy";
    }
  }

  const escWarp = Collision.isEscalatorWarp && Collision.isEscalatorWarp(game, tx, ty, dir);
  if (escWarp) {
    if (!Warp.isBusy()) {
      const md = Runtime && Runtime._mod;
      const g = game || (Runtime && Runtime._game);
      Warp.startEscalator(md, g, escWarp.destMap, escWarp.destX, escWarp.destY, escWarp.escDir, dir, tx, ty);
      return "escalator";
    }
    return "escalator_busy";
  }

  // pokefirered/src/field_control_avatar.c:825 TryArrowWarp
  if (Collision.isArrowWarp
      && Collision.isArrowWarp(game, Player.cellX, Player.cellY, dir)) {
    if (Warp.isBusy()) return "arrow_busy";
    if (Collision.tryWarpAt(game, Player.cellX, Player.cellY, dir, { arrow: true })) {
      return "arrow_warp";
    }
  }

  // pokefirered/src/field_control_avatar.c:262
  // package.loaded["src.core.game3.field"]
  if (Field && Field.tryWalkIntoSign) {
    // pokefirered/src/field_control_avatar.c:260
    if (wasFacing !== dir) {
      if (Field.tryWalkIntoSign(game, dir, true)) return "sign_turn";
    } else if (Field.tryWalkIntoSign(game, dir)) {
      return "sign";
    }
  }
  return undefined;
}

// Lua: player.lua:620
// pokefirered/src/metatile_behavior.c:668 MetatileBehavior_IsCyclingRoadPullDownTile
function isCyclingRoadPullDown(beh: number | null | undefined): boolean {
  if (Collision.isCyclingRoadPullDown) {
    return Collision.isCyclingRoadPullDown(beh) === true;
  }
  return beh != null && beh >= MB_CYCLING_ROAD_PULL_DOWN
    && beh <= MB_CYCLING_ROAD_PULL_DOWN_GRASS;
}

// Lua: player.lua:671
// pokefirered/src/bike.c:215 GetBikeCollision
function bikeCanMove(game: any, dir: string): boolean {
  const d = delta(dir);
  if (!d) return false;
  const x = Player.cellX + d[1], y = Player.cellY + d[2];
  // package.loaded["src.core.game3.rotating_gate"]
  const RG = RotatingGate;
  // pokeemerald/src/field_player_avatar.c:722
  if (RG && truthy(RG.active()) && truthy(RG.checkCollision(dir, x, y, true))) return false;
  return Collision.canEnter(game, x, y, {
    fromX: Player.cellX, fromY: Player.cellY, dir, surfing: Player.surfing,
    elevation: Player.currentElevation,
  })[0] === true;
}

// Lua: player.lua:685
// pokefirered/src/bike.c:199 BikeTransition_Downhill
function bikeDownhill(game: any): boolean {
  const [lx, ly] = Collision.ledgeLanding(game, Player.cellX, Player.cellY, "down");
  if (lx != null) {
    Player.facing = "down";
    beginStep(lx, ly!, false, true);
    return true;
  }
  if (!bikeCanMove(game, "down")) return false;
  Player.facing = "down";
  beginStep(Player.cellX, Player.cellY + 1, false, false);
  Player.stepFrames = FASTER_FRAMES;
  return true;
}

// Lua: player.lua:700
// pokefirered/src/bike.c:209 BikeTransition_Uphill
function bikeUphill(game: any, dir: string): boolean {
  const d = delta(dir);
  if (!d) return false;
  if (!bikeCanMove(game, dir)) return false;
  Player.facing = dir;
  beginStep(Player.cellX + d[1], Player.cellY + d[2], false, false);
  Player.stepFrames = WALK_FRAMES;
  return true;
}

// Lua: player.lua:845
function tickAction(): boolean {
  const a = Player.action!;
  a.t = a.t + 1;
  if (a.jump != null) {
    const t = lor(JUMP_Y[a.jump], JUMP_Y_HIGH);
    Player.spriteYOffset = t[a.t] ?? 0;
    // pokeemerald/src/event_object_movement.c:5517
    if (a.turnTo != null && a.t === 8) Player.facing = a.turnTo;
  }
  if (a.t >= a.frames) {
    Player.action = undefined;
    Player.spriteYOffset = 0;
    if (truthy(a.walk)) {
      Player.walkInPlace = false;
      Player.walkInPlaceFast = false;
    }
    if (a.done) a.done();
  }
  return false;
}

// pokeemerald/src/data/object_events/object_event_anims.h:416
const ACRO_FRAMES: Record<string, Record<string, LuaTable>> = {
  back: { down: seq(9, 10), up: seq(13, 14), left: seq(17, 18), right: seq(17, 18) },
  standBack: { down: seq(9, 0), up: seq(13, 1), left: seq(17, 2), right: seq(17, 2) },
  pedal: { down: seq(21, 10, 22, 10), up: seq(23, 14, 24, 14), left: seq(25, 18, 26, 18), right: seq(25, 18, 26, 18) },
};

// Lua: player.lua:909
function finishStep(game: any): void {
  // pokefirered/src/event_object_movement.c:7741
  if (Player.spinning) Player.facing = lor(Player.spinStart, Player.facing);
  Player.cellX = Player.targetX;
  Player.cellY = Player.targetY;
  Player.px = Player.cellX * CELL;
  Player.py = Player.cellY * CELL;
  Player.moving = false;
  Player.progress = 0;
  Player.stepFlip = !Player.stepFlip;
  Player.running = false;
  Player.jumping = false;
  Player.jumpType = undefined;
  Player.spriteYOffset = 0;
  Player.updateElevation(Player.cellX, Player.cellY);
  Player.syncSavePosition(game);

  // Surf landing / dismount state transitions
  const wasSurfing = Player.surfing || Player.dismounting;
  if (Player.surfHopping) {
    Player.surfHopping = false;
    Player.surfing = true;
  } else if (Player.dismounting) {
    Player.dismounting = false;
    Player.surfing = false;
  }

  // package.loaded["src.core.game3.runtime"]
  const session: any = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
  if (session) {
    session.x = Player.cellX; session.y = Player.cellY; session.facing = Player.facing;
  }

  if (wasSurfing && !Player.surfing && !Player.surfHopping) {
    if (Player.isOnCyclingRoad(session, Player.cellX, Player.cellY)) {
      Player.biking = true;
      try {
        Audio.bikeMusic(true, true);
      } catch { /* pcall */ }
    }
  }

  if (ModRuntime.wants("world.stepped")) {
    // package.loaded["src.core.game3.map"]
    const Map = MapMod;
    ModRuntime.emit("world.stepped", {
      mapId: (session && session.map) || (Map && Map.current),
      x: Player.cellX, y: Player.cellY,
      tile: Collision.behavior && Collision.behavior(Player.cellX, Player.cellY),
      facing: Player.facing,
    });
  }

  const onDoneCb = Player._onStepDone;
  Player._onStepDone = undefined;
  if (onDoneCb) {
    onDoneCb();
    return;
  }
  const scripted = Player._scriptedStep;
  Player._scriptedStep = undefined;
  if (scripted) {
    const mapBlock = session && Profile.forSession(session).map;
    // pokeemerald/src/field_control_avatar.c:159
    if (mapBlock && mapBlock.scriptStepEvents === false) return;
  }

  // package.loaded["src.core.game3.forced_movement"] or lazyReq(...)
  // pokefirered/src/field_control_avatar.c:136
  const onForcedTile = truthy(
    ForcedMovement.isForcedMovementTile(Collision.behavior(Player.cellX, Player.cellY)));

  // package.loaded["src.core.game3.field"] or lazyReq(...)

  if (!onForcedTile) {
    // Evaluate Overworld Step Events (Happiness, VS Seeker, Poison, Egg/Daycare, Repel)
    if (StepEvents && StepEvents.onStepTaken) {
      StepEvents.onStepTaken(session, game);
    }

    // Land-on-warp via owned warp table (mapDef.warps).
    Collision.tryWarpAt(game, Player.cellX, Player.cellY, Player.facing);

    // Coord events (Oak leave-block, triggers) after landing on the cell.
    if (Field.tryCoordEvents) {
      Field.tryCoordEvents(game, Player.cellX, Player.cellY);
    }
  }

  // pokefirered/src/field_control_avatar.c:209
  if (!Field.locked) {
    // pcall(lazyReq, "src.core.game3.trainer_sight"): always present
    if (TrainerSight && TrainerSight.check) {
      TrainerSight.check(game);
    }
  }

  // pokefirered/src/field_player_avatar.c:136
  const warping = Warp && Warp.isBusy && Warp.isBusy();
  if (!warping && truthy(ForcedMovement.onStepFinished(game))) return;

  // pokefirered/src/wild_encounter.c:757
  const onGrass = Collision.isGrass && Collision.isGrass(Player.cellX, Player.cellY);
  const onWater = Player.surfing && (Collision.isWater && Collision.isWater(Player.cellX, Player.cellY));
  // pcall(lazyReq, "src.core.game3.encounters"): always present
  if (Encounters && Encounters.onStep && !onForcedTile) {
    // package.loaded["src.core.game3.battle"]
    let busy = truthy((Battle && Battle.isActive && Battle.isActive()) || Field.locked);
    // package.loaded["src.core.game3.scripting.space"]
    if (Space && Space.vm && Space.vm.isRunning && truthy(Space.vm.isRunning())) {
      busy = true;
    }
    if (!busy) {
      let mapId = session && session.map;
      if (!mapId) {
        const Map = MapMod;
        mapId = Map && Map.current;
      }
      const enc = Encounters.onStep(mapId, undefined, { x: Player.cellX, y: Player.cellY });
      if (enc) {
        const md = Runtime && Runtime._mod;
        const g = game || (Runtime && Runtime._game);
        const [okB, errB] = BattleBridge.startWild(md, g, enc, {});
        if (!okB) {
          console.log("[game3/encounters] startWild failed: " + tostring(errB));
        }
      }
    }
  }
  if (Encounters && Encounters.noteGrass) {
    Encounters.noteGrass(onGrass || onWater);
  }
  if (onGrass) {
    if (FieldEffects && FieldEffects.tallGrassAt) {
      FieldEffects.tallGrassAt(Player.cellX, Player.cellY, true);
    }
  }
}

export interface PlayerModule {
  cellX: number;
  cellY: number;
  px: number;
  py: number;
  facing: string;
  moving: boolean;
  progress: number;
  stepFrames: number;
  targetX: number;
  targetY: number;
  turnTimer: number;
  turnArmed: boolean;
  stepFlip: boolean;
  animClock: number;
  running: boolean;
  jumping: boolean;
  surfHopping: boolean;
  dismounting: boolean;
  fieldMoveAnim: number;
  spriteXOffset: number;
  spriteYOffset: number;
  biking: boolean;
  surfing: boolean;
  fishing: boolean;
  prevCellX: number;
  prevCellY: number;
  animDisabled: boolean;
  spinning: boolean;
  spinStart: string;
  walkInPlace: boolean;
  walkInPlaceFast: boolean;
  visible: boolean;
  elevation: number;
  currentElevation: number;
  _logged: boolean;
  bikeType: string | undefined;
  moveDir: string;
  facingLocked: boolean;
  action: PlayerAction | undefined;
  jumpType: string | undefined;
  acroAnim: AcroAnim | undefined;
  // Set by player.lua outside its module header, or by other modules.
  underwater?: boolean;
  flyRide?: boolean;
  watering?: boolean;
  boulderPush?: { obj: any };
  fixedPriority?: any;
  subpriority?: any;
  fieldMoveTotal?: number;
  fieldMoveKind?: string;
  _scriptedStep?: boolean;
  _onStepDone?: () => void;
  [k: string]: any;

  setVisible(vis?: unknown): void;
  isVisible(): boolean;
  reset(x: unknown, y: unknown, facing?: string | null): void;
  syncFromSession(session: any): void;
  syncFromHost(game: any): void;
  syncSavePosition(game: any): void;
  syncToHost(game: any): void;
  walkPhase(): number;
  runPose(): number | undefined;
  drawFlip(): boolean;
  jumpSpriteY(): number;
  updateElevation(curX: number, curY: number, prevX?: number, prevY?: number): void;
  fieldTriggers(game: any, dir: string): string | undefined;
  tryMove(dir: string, game: any, run?: unknown): [string | undefined, string?];
  isOnCyclingRoad(session: any, x?: number, y?: number, mapDef?: any): boolean;
  cyclingRoadPull(game: any, input: PlayerInput | undefined | null, dir: string | undefined): boolean;
  forceStep(dir: string | undefined, onDone?: () => void): boolean;
  forcedStep(dir: string, frames?: number, opts?: PlayerForcedStepOpts): boolean;
  scriptStep(dir?: string, run?: unknown, slow?: unknown, fast?: unknown): boolean;
  scriptJump(dir?: string, distance?: number): boolean;
  scriptFace(dir: string): void;
  bikeStep(tx: number, ty: number, dir: string, frames: number, opts?: PlayerBikeStepOpts): boolean;
  startAction(opts: PlayerStartActionOpts): boolean;
  acroFrame(): number | undefined;
  startSurfing(game: any, onDone?: () => void): boolean;
  startFieldMove(duration?: number, kind?: string): void;
  tick(game: any): boolean;
  canDash(): boolean;
  runningDisallowed(cx: number, cy: number): boolean;
  update(game: any, input?: PlayerInput | null): unknown;
}

export const Player: PlayerModule = {
  cellX: 0,
  cellY: 0,
  px: 0,
  py: 0,
  facing: "down",
  moving: false,
  progress: 0,
  stepFrames: WALK_FRAMES,
  targetX: 0,
  targetY: 0,
  turnTimer: 0,
  turnArmed: true,
  stepFlip: false,
  animClock: 0,
  running: false,
  jumping: false,
  surfHopping: false,
  dismounting: false,
  fieldMoveAnim: 0,
  spriteXOffset: 0,
  spriteYOffset: 0,
  biking: false,
  surfing: false,
  // pokefirered/src/field_player_avatar.c:1679
  fishing: false,
  prevCellX: 0,
  prevCellY: 0,
  // pokefirered/src/field_player_avatar.c:325
  animDisabled: false,
  // pokefirered/src/event_object_movement.c:7741
  spinning: false,
  spinStart: "down",
  // pokefirered/src/field_fadetransition.c:860
  walkInPlace: false,
  walkInPlaceFast: false,
  visible: true,
  elevation: 3,
  // pokefirered/src/field_player_avatar.c:1296
  currentElevation: 0,
  _logged: false,
  // pokeemerald/include/global.fieldmap.h:288
  bikeType: undefined,
  moveDir: "down",
  facingLocked: false,
  action: undefined,
  jumpType: undefined,
  acroAnim: undefined,

  // Lua: player.lua:108
  setVisible(vis?: unknown): void {
    Player.visible = (vis !== false);
    // package.loaded["src.core.game3.runtime"]
    const g = Runtime && (Runtime._game || (Runtime.getGame && Runtime.getGame()));
    const world = g && (g.overworld || g.world);
    if (world && world.player) {
      world.player.visible = Player.visible;
      world.player.hidden = !Player.visible;
    }
  },

  // Lua: player.lua:119
  isVisible(): boolean {
    return Player.visible !== false;
  },

  // Lua: player.lua:156
  reset(x: unknown, y: unknown, facing?: string | null): void {
    // Callers pass the destination facing (Map.load, warp, fly, syncFromSession).
    // An absent or invalid direction keeps the current facing.
    if (facing != null && delta(facing)) {
      Player.facing = facing;
    }
    Player.cellX = tonumber(x) ?? 0;
    Player.cellY = tonumber(y) ?? 0;
    Player._scriptedStep = undefined;
    // pokeemerald/src/field_player_avatar.c:1402
    WarpArrow.hide();
    Player.px = Player.cellX * CELL;
    Player.py = Player.cellY * CELL;
    // package.loaded["src.core.game3.collision"]
    const curElev = Collision && Collision.elevationAt && Collision.elevationAt(Player.cellX, Player.cellY);
    if (curElev != null && curElev !== 0 && curElev !== 15) {
      Player.elevation = curElev;
    } else {
      Player.elevation = 3;
    }
    Player.moving = false;
    Player.progress = 0;
    Player.stepFrames = WALK_FRAMES;
    Player.targetX = Player.cellX;
    Player.targetY = Player.cellY;
    Player.turnTimer = 0;
    Player.turnArmed = true;
    Player.stepFlip = false;
    Player.animClock = 0;
    Player.running = false;
    Player.jumping = false;
    Player.spriteXOffset = 0;
    Player.spriteYOffset = 0;
    Player.biking = false;
    // Transient surf state: a reset lands the avatar on its feet, so a warp or
    // whiteout out of the water must not leave surfing set -- Collision.canEnter
    // reads Player.surfing and would treat water as walkable on land.
    Player.surfing = false;
    Player.surfHopping = false;
    Player.dismounting = false;
    Player.prevCellX = Player.cellX;
    Player.prevCellY = Player.cellY;
    Player.animDisabled = false;
    Player.spinning = false;
    Player.walkInPlace = false;
    Player.walkInPlaceFast = false;
    Player.boulderPush = undefined;
    Player.currentElevation = 0;
    Player.moveDir = Player.facing;
    Player.facingLocked = false;
    Player.fixedPriority = undefined;
    Player.subpriority = undefined;
    Player.action = undefined;
    Player.jumpType = undefined;
    Player.acroAnim = undefined;
    // package.loaded["src.core.game3.bike.rse"]: no such module in the port
    // (FRLG never loads it: Bike.rse returns nil without machAcroBike).
    const BikeRse: any = undefined;
    if (BikeRse) BikeRse.clearState(0, 0);
    if (!Player._logged) {
      log(format("avatar ready @ %d,%d %s",
        Player.cellX, Player.cellY, Player.facing));
      Player._logged = true;
    }
  },

  // Lua: player.lua:220
  syncFromSession(session: any): void {
    if (!session) return;
    Player.reset(session.x, session.y, session.facing);
    if (session.elevation != null) {
      Player.elevation = tonumber(session.elevation) ?? 3;
    }
    if (session.biking != null) {
      Player.biking = (session.biking === true);
    }
    if (session.bikeType != null) {
      Player.bikeType = session.bikeType;
    }
  },

  // Lua: player.lua:234
  syncFromHost(game: any): void {
    const world = game && (game.overworld || game.world);
    const p = world && world.player;
    if (!p) return;
    Player.reset(lor(p.cellX, p.x), lor(p.cellY, p.y), lor(p.facing, "down"));
    if (p.elevation != null) {
      Player.elevation = tonumber(p.elevation) ?? 3;
    }
    const save = game && game.save;
    if (save && save.biking != null) {
      Player.biking = (save.biking === true);
    }
  },

  // Lua: player.lua:249
  /** Write avatar coords into save.position (ferry / host save). No host entity mirror. */
  syncSavePosition(game: any): void {
    const save = game && game.save;
    if (!(save && save.position)) return;
    save.position.x = Player.cellX;
    save.position.y = Player.cellY;
    save.position.facing = Player.facing;
    save.position.biking = (Player.biking === true);
    save.biking = (Player.biking === true);
    // package.loaded["src.core.game3.runtime"]
    const session: any = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
    if (session) {
      session.biking = (Player.biking === true);
      if (session.map) {
        save.position.map = session.map;
      }
    }
  },

  // Lua: player.lua:269
  /** Optional: mirror onto host player for heal-machine anim / leftover host reads.
   *  Prefer syncSavePosition; full mirror is not required for talk/field. */
  syncToHost(game: any): void {
    Player.syncSavePosition(game);
    const world = game && (game.overworld || game.world);
    const p = world && world.player;
    if (!p) return;
    p.cellX = Player.cellX;
    p.cellY = Player.cellY;
    p.px = Player.px;
    p.py = Player.py;
    p.facing = Player.facing;
    p.moving = Player.moving;
    p.stepFlip = Player.stepFlip;
    p.animClock = Player.animClock;
    p.turnTimer = Player.turnTimer;
    if (p.stepFrames != null) p.stepFrames = Player.stepFrames;
    if (p.progress != null) p.progress = Player.progress;
    if (p.targetX != null) p.targetX = Player.targetX;
    if (p.targetY != null) p.targetY = Player.targetY;
    p.jumping = Player.jumping;
    p.spriteYOffset = lor(Player.spriteYOffset, 0);
  },

  // Lua: player.lua:301
  walkPhase(): number {
    // pokefirered/src/field_player_avatar.c:325
    if (Player.animDisabled) return 0;
    if (Player.turnTimer > 0) return 1;
    if (!Player.moving) {
      if (!Player.walkInPlace) return 0;
      const wf = walkInPlaceFrames();
      const wp = mod(Player.animClock, wf);
      const wmid = Math.floor(wf / 2);
      return (wp >= Math.floor(wf / 4) && wp < wmid + Math.floor(wf / 4)) ? 1 : 0;
    }
    const frames = lor(Player.stepFrames, WALK_FRAMES);
    const p = mod(Player.animClock, frames);
    const mid = Math.floor(frames / 2);
    return (p >= Math.floor(frames / 4) && p < mid + Math.floor(frames / 4)) ? 1 : 0;
  },

  // Lua: player.lua:319
  // src/event_object_movement.c:5333
  runPose(): number | undefined {
    if (!(Player.moving && Player.running) || Player.biking || Player.jumping
        || Player.surfing || Player.animDisabled) {
      return undefined;
    }
    // src/data/object_events/object_event_anims.h:601
    return mod(lor(Player.animClock, 0) - 1, 8) >= 5 ? 1 : 0;
  },

  // Lua: player.lua:328
  drawFlip(): boolean {
    return Player.stepFlip ? true : false;
  },

  // Lua: player.lua:337
  /** pret DoJumpSpriteMovement y2 for JUMP_DISTANCE_FAR + JUMP_TYPE_HIGH. */
  jumpSpriteY(): number {
    if (!Player.jumping) return 0;
    const progress = lor(Player.progress, 0);
    if (progress < 1) return 0;
    if (Player.jumpType != null) {
      // pokeemerald/src/event_object_movement.c:8462 DoJumpSpriteMovement
      const idx = lor(Player.stepFrames, 16) >= 32 ? Math.floor((progress - 1) / 2) : (progress - 1);
      const t = lor(JUMP_Y[Player.jumpType], JUMP_Y_HIGH);
      return t[idx + 1] ?? 0;
    }
    if (Player.surfHopping || Player.dismounting) {
      const idx = Math.min(progress, len(SURF_HOP_Y));
      return SURF_HOP_Y[idx] ?? 0;
    }
    // After frame N's Step1, sTimer == N; y2 = sJumpY_High[sTimer >> 1].
    const idx = Math.floor((progress - 1) / 2);
    if (idx < 0) return 0;
    if (idx >= len(JUMP_Y_HIGH)) return 0;
    return JUMP_Y_HIGH[idx + 1];
  },

  // Lua: player.lua:359
  // pokefirered/src/event_object_movement.c:8400
  updateElevation(curX: number, curY: number, prevX?: number, prevY?: number): void {
    const [cur, prev] = Collision.nextElevation(Collision._mapDef, lor(Player.currentElevation, 0),
      curX, curY, lor(prevX, curX), lor(prevY, curY));
    Player.currentElevation = cur as number;
    if (prev != null) Player.elevation = prev;
  },

  // Lua: player.lua:495
  fieldTriggers(game: any, dir: string): string | undefined {
    const d = delta(dir);
    if (!d) return undefined;
    return stairTrigger(game, dir)
      ?? stepTriggers(game, dir, Player.facing, Player.cellX + d[1], Player.cellY + d[2]);
  },

  // Lua: player.lua:502 -- [result, why]
  tryMove(dir: string, game: any, run?: unknown): [string | undefined, string?] {
    if (Player.moving || Player.boulderPush) return [undefined];
    if (!delta(dir)) return [undefined];

    const wasFacing = Player.facing;
    if (Player.facing !== dir) {
      Player.facing = dir;
      if (Player.turnArmed) {
        Player.turnArmed = false;
        Player.turnTimer = TURN_FRAMES;
        return ["turned"];
      }
    }
    if (Player.turnTimer > 0) return [undefined];

    let trig = stairTrigger(game, dir);
    if (trig) return [trig];

    const d = delta(dir)!;
    const tx = Player.cellX + d[1];
    const ty = Player.cellY + d[2];

    // pret CheckForPlayerAvatarCollision → ShouldJumpLedge(dest): hop over the
    // impassable ledge tile when facing matches; otherwise canEnter bumps.
    const [lx, ly] = Collision.ledgeLanding(game, Player.cellX, Player.cellY, dir);
    if (lx != null) {
      beginStep(lx, ly!, false, true);
      try {
        if (Audio.playSe && SE.SE_LEDGE) Audio.playSe(SE.SE_LEDGE);
      } catch { /* pcall */ }
      return ["ledge"];
    }

    trig = stepTriggers(game, dir, wasFacing, tx, ty);
    if (trig) return [trig];

    const [ok, why] = Collision.canEnter(game, tx, ty, {
      fromX: Player.cellX,
      fromY: Player.cellY,
      dir,
      surfing: Player.surfing || Player.underwater,
      elevation: Player.currentElevation,
    });

    if (!ok) {
      if (why === "entity") {
        // package.loaded["src.core.game3.scripting.space"]
        const isStrengthActive = Space && Space.store
          && Flags.getFlag(Space.store, null, FieldMoves.SYS_FLAGS.USE_STRENGTH);
        if (isStrengthActive) {
          const obj = Objects.at(tx, ty);
          if (obj && (obj.def && (obj.def.graphicsId === FieldMoves.GFX_IDS.PUSHABLE_BOULDER
              || obj.def.gfx === FieldMoves.GFX_IDS.PUSHABLE_BOULDER))) {
            // pokefirered/src/field_player_avatar.c:638
            const [canPush, destBx, destBy] = FieldMoves.canPushBoulder(obj, dir, (bx: number, by: number) => {
              const beh = Collision.behavior(bx, by);
              if (Collision.isFallWarp(beh)) return true;
              return Collision.canEnter(game, bx, by,
                { fromX: tx, fromY: ty, dir, elevation: obj.currentElevation })[0] === true
                && !Collision.isNonAnimDoor(beh);
            });
            if (truthy(canPush) && !obj.moving) {
              // pokefirered/src/field_player_avatar.c:1417 DoBoulderInit
              Player.boulderPush = { obj };
              // pokefirered/src/field_player_avatar.c:1425 DoBoulderDust
              Player.facing = dir;
              Player.walkInPlace = true;
              Player.walkInPlaceFast = false;
              Player.animClock = 0;
              Objects.pushStep(obj, dir, WALK_FRAMES * 2);
              FieldEffects.startDust(tx, ty);
              Audio.playSe(SE.SE_M_STRENGTH);
              if (ModRuntime.wants("world.boulder_moved")) {
                // package.loaded["src.core.game3.map"]
                const Map = MapMod;
                ModRuntime.emit("world.boulder_moved", {
                  mapId: Map && Map.current, npcId: obj.localId, x: destBx, y: destBy,
                });
              }
              return ["push"];
            }
          }
        }
      }
      // Outdoor map connection (Pallet north → Route 1, etc.).
      if (why === "bounds" && Collision.tryConnection
          && Collision.tryConnection(game, Player.cellX, Player.cellY, dir, truthy(run))) {
        return ["connection"];
      }
      return ["blocked", why];
    }
    // package.loaded["src.core.game3.rotating_gate"]
    const RG = RotatingGate;
    if (RG && truthy(RG.active()) && truthy(RG.checkCollision(dir, tx, ty))) {
      // pokeemerald/src/field_player_avatar.c:709
      return ["blocked", "rotating_gate"];
    }
    const BikeRse = rseBike();
    if (BikeRse && BikeRse.acroCollision(Collision.behavior(tx, ty)) !== 0) {
      // pokeemerald/src/field_player_avatar.c:711
      return ["blocked", "acro"];
    }
    const isDismount = Player.surfing && !Player.underwater
      && Collision.isSurfDismount(tx, ty, Player.currentElevation);
    if (isDismount) {
      Player.dismounting = true;
      Audio.stopSurfMusic();
    } else {
      Player.dismounting = false;
    }

    beginStep(tx, ty, run, false);
    return ["step"];
  },

  // Lua: player.lua:628
  isOnCyclingRoad(session: any, x?: number, y?: number, mapDef?: any): boolean {
    const cx = lor(x, Player.cellX);
    const cy = lor(y, Player.cellY);
    let beh: number | null | undefined;
    if (mapDef) {
      beh = Collision.behaviorOn ? Collision.behaviorOn(mapDef, cx, cy) : undefined;
    } else {
      beh = Collision.behavior ? Collision.behavior(cx, cy) : undefined;
    }
    if (isCyclingRoadPullDown(beh)) return true;
    // package.loaded["src.core.game3.scripting.flags"] (src.core.game3.flags: no such module)
    const cf = Flags && (Flags as any).forVersion && sessionFlags(session).IDS.FLAG_SYS_ON_CYCLING_ROAD;
    if (cf != null && cf !== false && Flags.getFlag) {
      const cfKey = tostring(cf);
      // package.loaded["src.core.game3.scripting.space"]
      const Live: any = Space;
      if (Live && Live.active === true && Live.store) {
        return Flags.getFlag(Live.store, null, cf) === true;
      }
      if (session && (session.store || session.flags)) {
        const st = session.store || session;
        if (Flags.getFlag(st, null, cf) === true
            || (session.flags && (session.flags[cf] === true || session.flags[cfKey] === true))) {
          return true;
        }
      }
      // package.loaded["src.core.game3.scripting.space"] (src.core.game3.space: no such module)
      const Sp: any = Space;
      if (Sp && Sp.store && Flags.getFlag(Sp.store, null, cf) === true) {
        return true;
      }
      // package.loaded["src.core.game3.runtime"]
      const s: any = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
      if (s && (s.store || s.flags)) {
        const st = s.store || s;
        if (Flags.getFlag(st, null, cf) === true
            || (s.flags && (s.flags[cf] === true || s.flags[cfKey] === true))) {
          return true;
        }
      }
    }
    return false;
  },

  // Lua: player.lua:711
  // pokefirered/src/bike.c:53 BikeInputHandler_Normal
  cyclingRoadPull(game: any, input: PlayerInput | undefined | null, dir: string | undefined): boolean {
    if (!Player.biking) return false;
    if (Player.moving) return false;
    const beh = Collision.behavior ? Collision.behavior(Player.cellX, Player.cellY) : undefined;
    if (!isCyclingRoadPullDown(beh)) return false;
    const braking = !!(input && input.isDown && truthy(input.isDown("b")));
    if (!braking) {
      // pokefirered/src/bike.c:65
      if (dir == null || dir === "down") return bikeDownhill(game);
      return bikeUphill(game, dir);
    }
    // pokefirered/src/bike.c:72
    if (dir != null) return bikeUphill(game, dir);
    return false;
  },

  // Lua: player.lua:728
  /** Forced step along dir with onDone callback (e.g. exiting door). */
  forceStep(dir: string | undefined, onDone?: () => void): boolean {
    if (Player.moving) return false;
    const d = delta(lor(dir, Player.facing));
    if (!d) return false;
    Player.facing = lor(dir, Player.facing);
    Player._onStepDone = onDone;
    beginStep(Player.cellX + d[1], Player.cellY + d[2], false, false);
    return true;
  },

  // Lua: player.lua:739
  // pokefirered/src/field_player_avatar.c:292
  forcedStep(dir: string, frames?: number, optsIn?: PlayerForcedStepOpts): boolean {
    if (Player.moving) return false;
    const d = delta(dir);
    if (!d) return false;
    const opts = optsIn || {};
    if (!opts.keepFacing) Player.facing = dir;
    Player._onStepDone = undefined;
    if (opts.ledgeX != null) {
      beginStep(opts.ledgeX, opts.ledgeY!, false, true);
    } else {
      const tx = Player.cellX + d[1], ty = Player.cellY + d[2];
      Player.dismounting = (Player.surfing && !Player.underwater
        && Collision.isSurfDismount(tx, ty, Player.currentElevation)) || false;
      // pokefirered/src/field_player_avatar.c:1609
      if (Player.dismounting) Audio.stopSurfMusic();
      beginStep(tx, ty, false, false);
    }
    if (frames != null && opts.ledgeX == null && !Player.dismounting) {
      Player.stepFrames = frames;
    }
    if (Player.spinning) Player.spinStart = dir;
    return true;
  },

  // Lua: player.lua:764
  /** Forced script step (applymovement localId 0xFF) — skips collision. */
  scriptStep(dir?: string, run?: unknown, slow?: unknown, fast?: unknown): boolean {
    if (Player.moving) return false;
    const d = delta(lor(dir, Player.facing));
    if (!d) return false;
    Player.facing = lor(dir, Player.facing);
    let tx = Player.cellX + d[1], ty = Player.cellY + d[2];
    // package.loaded["src.core.game3.collision"]
    if (Collision && Collision._grid && Collision._grid[1] != null && !Collision.inBounds(tx, ty)) {
      // package.loaded["src.core.game3.runtime"]
      const session: any = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
      const mapBlock = session && Profile.forSession(session).map;
      if (mapBlock && mapBlock.scriptConnections) {
        // pokeemerald/src/fieldmap.c:603
        const [lx, ly] = Collision.scriptConnection(undefined, Player.cellX, Player.cellY, Player.facing);
        if (lx != null) { tx = lx; ty = ly!; }
      }
    }
    beginStep(tx, ty, truthy(run), false);
    Player._scriptedStep = true;
    // pokefirered/src/event_object_movement.c:9029 UpdateRunSlowAnim
    if (truthy(run) && truthy(slow)) Player.stepFrames = RUN_SLOW_FRAMES;
    if (truthy(fast)) Player.stepFrames = RUN_FRAMES;
    return true;
  },

  // Lua: player.lua:790
  /** Forced script jump (applymovement localId 0xFF) — hops over ledges / gaps. */
  scriptJump(dir?: string, distanceIn?: number): boolean {
    if (Player.moving) return false;
    const distance = lor(distanceIn, 1);
    const d = delta(lor(dir, Player.facing));
    if (!d) return false;
    Player.facing = lor(dir, Player.facing);
    try {
      if (Audio.playSe && SE.SE_LEDGE) Audio.playSe(SE.SE_LEDGE);
    } catch { /* pcall */ }
    beginStep(Player.cellX + d[1] * distance, Player.cellY + d[2] * distance, false, true);
    Player._scriptedStep = true;
    return true;
  },

  // Lua: player.lua:806
  scriptFace(dir: string): void {
    if (delta(dir)) Player.facing = dir;
  },

  // Lua: player.lua:811
  // pokeemerald/src/field_player_avatar.c:966 PlayerSetAnimId
  bikeStep(tx: number, ty: number, dir: string, frames: number, optsIn?: PlayerBikeStepOpts): boolean {
    if (Player.moving) return false;
    const opts = optsIn || {};
    const face = Player.facing;
    beginStep(tx, ty, false, opts.jump != null);
    Player.facing = Player.facingLocked ? face : dir;
    Player.moveDir = dir;
    Player.stepFrames = frames;
    Player.running = false;
    Player.jumping = opts.jump != null;
    Player.jumpType = opts.jump;
    Player.acroAnim = opts.acroAnim;
    return true;
  },

  // Lua: player.lua:827
  // pokeemerald/src/event_object_movement.c:5704 InitMoveInPlace
  startAction(opts: PlayerStartActionOpts): boolean {
    Player.action = {
      frames: lor(opts.frames, 1),
      t: 0,
      jump: opts.jump,
      turnTo: opts.turnTo,
      walk: opts.walk,
      done: opts.done,
    };
    Player.acroAnim = opts.acroAnim;
    if (truthy(opts.walk)) {
      Player.walkInPlace = true;
      Player.walkInPlaceFast = opts.walk === "fast";
      Player.animClock = 0;
    }
    return true;
  },

  // Lua: player.lua:873
  acroFrame(): number | undefined {
    const a = Player.acroAnim;
    if (!(a && Player.biking)) return undefined;
    const sq = ACRO_FRAMES[a.kind] && ACRO_FRAMES[a.kind][Player.facing];
    if (!sq) return undefined;
    if (a.paused) return sq[1];
    let i = Math.floor(lor(a.clock, 0) / 4);
    if (a.kind === "pedal") i = mod(i, len(sq)); else i = Math.min(i, len(sq) - 1);
    return sq[i + 1];
  },

  // Lua: player.lua:885
  /** Parabolic hop into water when initiating Surf. */
  startSurfing(_game: any, onDone?: () => void): boolean {
    Player.biking = false; // Bike override: clear bike state when using Surf
    Player.running = false;
    Player.surfHopping = true;
    Player.surfing = false;
    Player.dismounting = false;
    try {
      if (Audio.playSe && SE.SE_LEDGE) Audio.playSe(SE.SE_LEDGE);
    } catch { /* pcall */ }
    if (!Player.forceStep(Player.facing, onDone)) {
      Player.surfHopping = false;
      return false;
    }
    return true;
  },

  // Lua: player.lua:903
  startFieldMove(duration?: number, kind?: string): void {
    Player.fieldMoveAnim = lor(duration, 28);
    Player.fieldMoveTotal = Player.fieldMoveAnim;
    Player.fieldMoveKind = kind;
  },

  // Lua: player.lua:1056
  tick(game: any): boolean {
    if (Player.acroAnim) Player.acroAnim.clock = lor(Player.acroAnim.clock, 0) + 1;
    if (Player.moving) {
      Player.updateElevation(Player.targetX, Player.targetY, Player.cellX, Player.cellY);
    } else {
      Player.updateElevation(Player.cellX, Player.cellY);
    }
    if (Player.fieldMoveAnim && Player.fieldMoveAnim > 0) {
      Player.fieldMoveAnim = Player.fieldMoveAnim - 1;
    }
    if (Player.turnTimer > 0) {
      Player.turnTimer = Player.turnTimer - 1;
    }
    if (!Player.moving) {
      // pokefirered/src/field_fadetransition.c:846
      if (Player.walkInPlace) {
        Player.animClock = Player.animClock + 1;
        if (Player.animClock % walkInPlaceFrames() === 0) {
          Player.stepFlip = !Player.stepFlip;
        }
      }
      if (Player.action) return tickAction();
      if (Player.surfing && !Player.jumping) {
        // pcall(lazyReq, "src.core.game3.field_effects"): always present
        const clock = lor(FieldEffects && FieldEffects._surfClock, 0);
        Player.spriteYOffset = (mod(Math.floor(clock / 48), 2) === 1) ? -1 : 0;
      } else if (!Player.walkInPlace && !warp_owns_sprite()) {
        Player.spriteYOffset = 0;
      }
      return false;
    }
    Player.progress = Player.progress + 1;
    Player.animClock = Player.animClock + 1;
    const frames = lor(Player.stepFrames, WALK_FRAMES);
    const dx = Player.targetX - Player.cellX;
    const dy = Player.targetY - Player.cellY;
    // pret Step1: 1px/frame along the move. Ledge Jump2 is 32px over 32 frames.
    const span = Math.max(Math.abs(dx), Math.abs(dy), 1);
    const adv = Math.floor(Player.progress * CELL * span / frames);
    Player.px = Player.cellX * CELL + (dx / span) * adv;
    Player.py = Player.cellY * CELL + (dy / span) * adv;
    if (Player.jumping) {
      Player.spriteYOffset = Player.jumpSpriteY();
    } else {
      Player.spriteYOffset = 0;
    }
    // pokefirered/src/data/object_events/object_event_anims.h:556
    if (Player.spinning) {
      const base = SPIN_PHASE[Player.spinStart] ?? 1;
      const idx = mod(base - 1 + Math.floor((Player.progress - 1) / 2), len(SPIN_CYCLE));
      Player.facing = SPIN_CYCLE[idx + 1];
    }
    if (Player.progress >= frames) {
      finishStep(game);
      return true;
    }
    return false;
  },

  // Lua: player.lua:1116
  /** pret field_player_avatar: B-dash only with FLAG_SYS_B_DASH (Running Shoes). */
  canDash(): boolean {
    // package.loaded["src.core.game3.scripting.space"]
    const store = Space && Space.getStore && Space.getStore();
    if (!store) {
      // Field not scripted yet — deny dash (shoes not granted).
      return false;
    }
    const rules = fieldBlock().running;
    if (!rules) {
      return Flags.getFlag(store, null, Flags.IDS.SYS_B_DASH) === true;
    }
    if (Flags.getFlag(store, null, sessionFlags().IDS[rules.flag]) !== true) return false;
    if (Player.underwater) return false;
    return !Player.runningDisallowed(Player.cellX, Player.cellY);
  },

  // Lua: player.lua:1134
  // pokeemerald/src/bike.c:1056
  runningDisallowed(cx: number, cy: number): boolean {
    const rules = fieldBlock().running;
    if (!rules) return false;
    if (rules.mapHeader) {
      const def = Collision._mapDef;
      if (def && tonumber(def.allowRunning) === 0) return true;
    }
    const beh = Collision.behavior ? Collision.behavior(cx, cy) : undefined;
    if (beh == null) return false;
    for (const [, name] of ipairs(rules.behaviors || [null])) {
      if (beh === MB.id(name)) return true;
    }
    // pokeemerald/src/bike.c:905
    for (const [, name] of ipairs(rules.evenElevation || [null])) {
      if (beh === MB.id(name) && mod(tonumber(Player.currentElevation) ?? 0, 2) === 0) return true;
    }
    return false;
  },

  // Lua: player.lua:1155
  /** Poll D-pad + B-run when field is free. */
  update(game: any, input?: PlayerInput | null): unknown {
    Player.tick(game);
    // pokeemerald/src/field_player_avatar.c:336
    if (!Player._scriptedStep) WarpArrow.update(Player);
    if (Player.biking && Player.bikeType === "acro") {
      const BikeRse = rseBike();
      // pokeemerald/src/field_player_avatar.c:339
      if (BikeRse) BikeRse.historyUpdate(input);
    }
    if (Player.moving) return;
    if (Player.action) return;
    if (Player.biking) {
      const BikeRse = rseBike();
      // pokeemerald/src/field_player_avatar.c:393 MovePlayerAvatarUsingKeypadInput
      if (BikeRse) return BikeRse.update(game, input);
    }
    const push = Player.boulderPush;
    if (push) {
      if (Player.walkInPlace && Player.animClock >= WALK_FRAMES) {
        Player.walkInPlace = false;
      }
      // pokefirered/src/field_player_avatar.c:1445 DoBoulderFinish
      if (Player.walkInPlace || push.obj.moving) return;
      Player.boulderPush = undefined;
      Field.onBoulderMoved(game, push.obj, push.obj.cellX, push.obj.cellY);
      return;
    }
    if (Player.fieldMoveAnim && Player.fieldMoveAnim > 0) return;

    // package.loaded["src.core.game3.field"]
    if (Field && Field.locked) return;
    // package.loaded["src.ui.game3.fade"]
    if (Fade && truthy(Fade.lockInput)) return;
    // package.loaded["src.core.game3.warp"]
    if (Warp && Warp.isBusy && Warp.isBusy()) return;
    // package.loaded["src.core.game3.runtime"]
    if (Runtime && Runtime.uiBusy && Runtime.uiBusy()) return;
    // package.loaded["src.core.game3.step_events"]
    if (StepEvents && StepEvents.busy && truthy(StepEvents.busy())) return;
    // package.loaded["src.core.game3.scripting.space"]
    if (Space && Space.vm && Space.vm.isRunning && truthy(Space.vm.isRunning())) {
      return;
    }

    // Menu Dismissal Frame Trap & Idle Sight Check: check sight before D-pad input polling
    // pcall(lazyReq, "src.core.game3.trainer_sight"): always present
    if (TrainerSight && TrainerSight.check) {
      if (truthy(TrainerSight.check(game))) {
        return;
      }
    }

    const dir = dirs_from_input(input);
    // pokefirered/src/bike.c:43 MovePlayerOnBike
    if (Player.cyclingRoadPull(game, input, dir)) return;
    if (!dir) {
      Player.turnArmed = true;
      return;
    }
    const wantRun = input && input.isDown && truthy(input.isDown("b"));
    const run = Player.biking || (wantRun && Player.canDash());
    Player.tryMove(dir, game, run);
  },
};

export default Player;
