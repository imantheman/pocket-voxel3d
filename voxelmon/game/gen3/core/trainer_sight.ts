// Port of gen1recomp src/core/game3/trainer_sight.lua (GPLv3 + additional terms; see LICENSE.md).
// Game3 Trainer Line of Sight Engine (FRLG authentic).
// Handles directional raycast vision, elevation & ledge masking, exclamation bubble,
// walk-up approach tracking, zero-distance skips, and battle script engagement.
//
// Return shapes (Lua multiple returns -> 0-based tuples):
//   checkLineOfSight -> [spotted, dist, facing?]. Everything else returns one value.
// The buried / disguised trainer reveals use src.core.game3.field_effects_rse,
// which is Emerald only (no port); isRse() is false for FireRed.

import { Logger } from "../shared/core/Logger.ts";
import { tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { Flags } from "./scripting/flags.ts";
import { Ctx } from "./scripting/ctx.ts";
import { Runtime as ModRuntime } from "../shared/mods/Runtime.ts";
import { Player as PlayerMod } from "./player.ts";
import { Objects as ObjectsMod } from "./objects.ts";
import { Collision as CollisionMod } from "./collision.ts";
import { Field as FieldMod } from "./field.ts";
import { Space as SpaceMod } from "./scripting/space.ts";
import { FieldEffects as FieldEffectsMod } from "./field_effects.ts";
import { Party } from "./party.ts";
import { Runtime } from "./runtime.ts";
import { Task } from "./task.ts";
import { Profile } from "./profile.ts";
import { Trainers as TrainersMod } from "./scripting/trainers.ts";
import { Constants } from "./constants.ts";
import { Map as MapMod } from "./map.ts";
import { Audio as AudioMod } from "./audio.ts";
import { BattleProfile } from "./battle/profile.ts";
import { Hud } from "../ui/hud.ts";
import { BattleBridge } from "./battle_bridge.ts";
import { Warp as WarpMod } from "./warp.ts";
import { Message as MessageMod } from "../ui/message.ts";
import { Battle as BattleMod } from "./battle.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Lua: trainer_sight.lua:11 (Lua sequences: d[1], d[2])
const DELTA: Record<string, [null, number, number]> = {
  up: [null, 0, -1],
  down: [null, 0, 1],
  left: [null, -1, 0],
  right: [null, 1, 0],
};

// Lua: trainer_sight.lua:18
const OPPOSITE_FACING: Record<string, string> = {
  down: "up",
  up: "down",
  left: "right",
  right: "left",
};

// Lua: trainer_sight.lua:26 -- pret MetatileBehavior ledge jump bytes (MB_JUMP_*)
const LEDGE_BEHAVIORS: Record<number, boolean> = {
  [0x38]: true, // MB_JUMP_SOUTH
  [0x39]: true, // MB_JUMP_NORTH
  [0x3A]: true, // MB_JUMP_WEST
  [0x3B]: true, // MB_JUMP_EAST
  [0xA0]: true, // MB_JUMP_EAST_IGNORE_SLOPE
  [0xA1]: true, // MB_JUMP_WEST_IGNORE_SLOPE
  [0xA2]: true, // MB_JUMP_NORTH_IGNORE_SLOPE
  [0xA3]: true, // MB_JUMP_SOUTH_IGNORE_SLOPE
};

// Lua: trainer_sight.lua:37
function Player(): any { return PlayerMod; }
// Lua: trainer_sight.lua:42
function Objects(): any { return ObjectsMod; }
// Lua: trainer_sight.lua:47
function Collision(): any { return CollisionMod; }
// Lua: trainer_sight.lua:52
function Field(): any { return FieldMod; }
// Lua: trainer_sight.lua:57
function Space(): any { return SpaceMod; }
// Lua: trainer_sight.lua:62
function FieldEffects(): any { return FieldEffectsMod; }

// pcall(require, "src.core.game3.scripting.trainers"): always loaded here.
function trainers(): [boolean, any] {
  return [true, TrainersMod];
}

// Lua: trainer_sight.lua:153
function is_ledge_tile(_game: any, cx: number, cy: number): boolean {
  const Coll = Collision();
  if (Coll.isLedge && Coll.isLedge(cx, cy)) {
    return true;
  }
  const cellByte = Coll.cell ? Coll.cell(cx, cy) : null;
  if (cellByte != null && LEDGE_BEHAVIORS[cellByte]) {
    return true;
  }
  return false;
}

// Lua: trainer_sight.lua:165
function isRse(): boolean {
  const O = Objects();
  return O.isRse != null && truthy(O.isRse());
}

// Lua: trainer_sight.lua:171 -- pokeemerald/src/trainer_see.c:301
const SEE_ALL_ORDER = seq("down", "up", "left", "right");

// Lua: trainer_sight.lua:262
function faceMovementType(facing: string): number {
  return ({ down: 0x08, up: 0x07, left: 0x09, right: 0x0A } as Record<string, number>)[facing] ?? 0x08;
}

// Lua: trainer_sight.lua:335
const EMPTY: any = {};

// Lua: trainer_sight.lua:337 -- [block, row]
function fieldBlock(): [any, any] {
  let row: any;
  let ok = true;
  try { row = Profile.forSession(); } catch { ok = false; }
  return [(ok && row && row.field) || EMPTY, ok ? row ?? null : null];
}

// Lua: trainer_sight.lua:469
function battleRow(eo: any): any {
  const Sp = Space();
  const scriptKey = eo.scriptKey ?? (eo.def ? eo.def.scriptKey : undefined);
  const list = scriptKey && Sp && Sp.bundle && Sp.bundle.scripts ? Sp.bundle.scripts[scriptKey] : null;
  for (const [, row] of ipairs<any>(list != null && typeof list === "object" ? list : {})) {
    if (row.op === "trainerbattle") return row;
  }
  return null;
}

// Lua: trainer_sight.lua:479
function twoTrainerApproach(): boolean {
  try {
    const bp: any = (BattleProfile as any).get();
    return !!(bp && bp.kinds && bp.kinds.twoOpponents === true);
  } catch {
    return false;
  }
}

// Lua: trainer_sight.lua:485
function canDouble(): boolean {
  const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
  return Party.monsStateToDoubles(session ? session.party : undefined) === Party.PLAYER_HAS_TWO_USABLE_MONS;
}

// Lua: trainer_sight.lua:492
const DOUBLE_TYPES: Record<number, boolean> = { [4]: true, [6]: true, [7]: true, [8]: true };

// Lua: trainer_sight.lua:494
function playEncounterMusic(tid: any, row: any): void {
  // pokeemerald/src/battle_setup.c:1440
  const mode = tonumber(row ? row.type : undefined) ?? 0;
  if (mode === 1 || mode === 8) return;
  let musicId: any = TrainerSight.encounterMusic(tid);
  if (musicId == null) {
    const [okT, Trainers] = trainers();
    musicId = okT && Trainers && Trainers.getEncounterMusic ? Trainers.getEncounterMusic(tid) : null;
  }
  const Audio: any = AudioMod;
  if (truthy(musicId) && Audio && Audio.playSong) Audio.playSong(musicId);
}

// Lua: trainer_sight.lua:508 -- pokeemerald/src/trainer_see.c:422
function approach(eo: any, dist: number, facing: string | undefined, done: () => void): void {
  const P = Player();
  const Objs = Objects();
  eo.frozen = true;
  eo.scriptBusy = true;
  FieldEffects().startExclamation(eo, () => {
    const arrive = (): void => {
      // pokeemerald/src/trainer_see.c:509
      const faceMt = faceMovementType(eo.facing);
      if (Objs.setTrainerMovementType) Objs.setTrainerMovementType(eo, faceMt);
      if (Objs.overrideTemplateMovementType) Objs.overrideTemplateMovementType(eo.localId, faceMt);
      eo.homeX = eo.cellX; eo.homeY = eo.cellY;
      if (eo.def) {
        eo.def.movementType = faceMt;
        eo.def.movement = "STAY";
        eo.def.x = eo.cellX; eo.def.y = eo.cellY;
        eo.def.range = (eo.facing ?? "down").toUpperCase();
      }
      if (Objs.rememberPerm && Objs._mapId) {
        Objs.rememberPerm(Objs._mapId, eo.localId, { x: eo.cellX, y: eo.cellY, movementType: faceMt, facing: eo.facing });
      }
      P.facing = OPPOSITE_FACING[eo.facing] ?? P.facing;
      eo.frozen = false;
      eo.scriptBusy = false;
      done();
    };
    TrainerSight.revealThen(eo, facing, () => {
      if (dist - 1 <= 0) return arrive();
      const actions: any[] = [null];
      for (let n = 1; n <= dist - 1; n++) actions[len(actions) + 1] = { kind: "step", dir: eo.facing };
      Objs.startTrack(eo.localId, actions, arrive);
    });
  });
}

// Lua: trainer_sight.lua:543
function introSpeech(_eo: any, tid: any, row: any, done: () => void): void {
  const Sp = Space();
  let text: any;
  if (row && row.introText && Sp && Sp.vm && Sp.vm.getText) {
    text = Sp.vm.getText(row.introText);
  }
  if (!truthy(text)) {
    const [okT, Trainers] = trainers();
    text = okT ? Trainers.dialogs(tid).intro ?? "" : "";
  }
  // pokeemerald/src/battle_setup.c:1378
  Hud.openMessage(null, text, { done });
}

// Lua: trainer_sight.lua:640
const approachFound: any[] = [null];

export interface SightHit { eo: any; dist: number; facing?: string }

export const TrainerSight = {
  _pair: null as { a: any; b: any } | null,
  _approached: null as any,
  retScriptCount: undefined as number | undefined,
  checkTrainerB: undefined as boolean | undefined,
  trainerBRet: undefined as any,

  // Lua: trainer_sight.lua:68
  getTrainerId(eo: any): number | null | undefined {
    if (!eo) return null;
    if (eo.trainerId) return eo.trainerId;
    if (eo.def && eo.def.trainerId) {
      eo.trainerId = tonumber(eo.def.trainerId);
      return eo.trainerId;
    }
    const scriptKey = eo.scriptKey ?? (eo.def ? eo.def.scriptKey : undefined);
    if (!truthy(scriptKey)) return null;
    const Sp = Space();
    const scripts = Sp && Sp.bundle ? Sp.bundle.scripts : null;
    const list = scripts ? scripts[scriptKey] : null;
    if (list != null && typeof list === "object") {
      // negative cache: this exact script list was already scanned without a
      // trainerbattle (a script swapped in under the key rescans)
      if (eo._trainerIdMiss === list) return null;
      for (const [, row] of ipairs<any>(list)) {
        if (row.op === "trainerbattle" || row.op === "dotrainerbattle") {
          const tid = tonumber(row.trainer ?? row[1]);
          if (tid != null) {
            eo.trainerId = tid;
            eo.trainerBattleType = tonumber(row.type) ?? 0;
            return tid;
          }
        }
      }
      eo._trainerIdMiss = list;
    }
    return null;
  },

  // Lua: trainer_sight.lua:100 -- pokefirered/src/trainer_see.c:97
  isTrainerType(eo: any): boolean {
    if (!eo) return false;
    const tt = tonumber(eo.trainerType ?? (eo.def ? eo.def.trainerType : undefined)) ?? 0;
    return tt === 1 || tt === 3;
  },

  // Lua: trainer_sight.lua:107
  isDefeated(eo: any, store: any, ctx: any): boolean {
    if (!eo) return true;
    const tid = TrainerSight.getTrainerId(eo);
    if (tid != null) {
      const fid = Flags.trainerFlagId(tid);
      if (Flags.getFlag(store, ctx, fid)) {
        return true;
      }
    }
    // Check template defeat flag if present
    const flag = eo.flag ?? (eo.def ? (eo.def.flag ?? eo.def.flagId) : undefined);
    if (flag != null && flag !== 0 && flag !== 0xFFFF && flag !== 65535) {
      if (Flags.getFlag(store, ctx, flag)) {
        return true;
      }
    }
    return false;
  },

  // Lua: trainer_sight.lua:126
  battleType(eo: any): number | null {
    if (!eo) return null;
    if (eo.trainerBattleType == null) {
      const Sp = Space();
      const scriptKey = eo.scriptKey ?? (eo.def ? eo.def.scriptKey : undefined);
      const list = scriptKey && Sp && Sp.bundle && Sp.bundle.scripts ? Sp.bundle.scripts[scriptKey] : null;
      eo.trainerBattleType = false;
      for (const [, row] of ipairs<any>(list != null && typeof list === "object" ? list : {})) {
        if (row.op === "trainerbattle" || row.op === "dotrainerbattle") {
          eo.trainerBattleType = tonumber(row.type) ?? 0;
          break;
        }
      }
    }
    return eo.trainerBattleType === false ? null : eo.trainerBattleType;
  },

  // Lua: trainer_sight.lua:144 -- pokefirered/src/trainer_see.c:114
  blockedByDoubles(eo: any): boolean {
    if (TrainerSight.battleType(eo) !== 4) return false;
    const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
    return Party.monsStateToDoubles(session ? session.party : undefined) !== Party.PLAYER_HAS_TWO_USABLE_MONS;
  },

  // Lua: trainer_sight.lua:175
  checkLineOfSight(eo: any, P: any, game: any, facingOverride?: string): [boolean, number, string?] {
    if (!eo || !P) return [false, 0];
    if (!facingOverride && isRse() && tonumber(eo.trainerType ?? (eo.def ? eo.def.trainerType : undefined)) === 3) {
      for (const [, dir] of ipairs<string>(SEE_ALL_ORDER)) {
        const [spotted, dist] = TrainerSight.checkLineOfSight(eo, P, game, dir);
        if (spotted) return [true, dist, dir];
      }
      return [false, 0];
    }
    const facing: string = facingOverride ?? eo.facing ?? "down";
    const d = DELTA[facing];
    if (!d) return [false, 0];

    // src/trainer_see.c:151
    const ex = truthy(eo.moving) && eo.targetX != null ? eo.targetX : eo.cellX;
    const ey = truthy(eo.moving) && eo.targetY != null ? eo.targetY : eo.cellY;
    const px = P.cellX, py = P.cellY;
    const dx = d[1], dy = d[2];
    let dist = 0;

    if (dx !== 0) {
      if (py !== ey) return [false, 0];
      if ((px - ex) * dx <= 0) return [false, 0];
      dist = Math.abs(px - ex);
    } else if (dy !== 0) {
      if (px !== ex) return [false, 0];
      if ((py - ey) * dy <= 0) return [false, 0];
      dist = Math.abs(py - ey);
    }

    const sight = tonumber(eo.sight ?? (eo.def ? (eo.def.sight ?? eo.def.trainerRange) : undefined)) ?? 0;
    if (dist < 1 || dist > sight) {
      return [false, 0];
    }

    const Coll = Collision();
    const Objs = Objects();
    const eoElev = tonumber(eo.currentElevation) ?? 0;
    const mapDef = eo.mapDef ?? Coll._mapDef;

    // pokefirered/src/trainer_see.c:225
    if (Objs.elevationsCompatible && !Objs.elevationsCompatible(eoElev, P.currentElevation)) {
      return [false, 0];
    }
    if (Coll.elevationMismatchOn && Coll.elevationMismatchOn(mapDef, eoElev, px, py)) {
      return [false, 0];
    }

    // Raycast intermediate tiles strictly between trainer and player
    for (let step = 1; step <= dist - 1; step++) {
      const cx = ex + dx * step;
      const cy = ey + dy * step;
      const fromX = ex + dx * (step - 1);
      const fromY = ey + dy * (step - 1);

      // 1. Collision check: must be passable along raycast direction
      if (Coll.canEnter && !Coll.canEnter(game, cx, cy, { fromX, fromY, dir: facing, elevation: eoElev })[0]) {
        return [false, 0];
      }
      // pokefirered/src/trainer_see.c:214
      if (Coll.elevationMismatchOn && Coll.elevationMismatchOn(mapDef, eoElev, cx, cy)) {
        return [false, 0];
      }

      // 2. Ledge masking: line of sight cannot penetrate one-way ledge boundaries
      if (is_ledge_tile(game, cx, cy)) {
        return [false, 0];
      }

      // 3. Intermediary NPCs block vision
      if (Objs.blocks && Objs.blocks(cx, cy, eo.localId, eoElev)) {
        return [false, 0];
      }
      const other = Objs.at ? Objs.at(cx, cy) : null;
      if (other && (!Objs.elevationsCompatible || Objs.elevationsCompatible(eoElev, other.currentElevation))) {
        return [false, 0];
      }
    }

    // Check player tile for ledge boundary
    if (is_ledge_tile(game, px, py)) {
      return [false, 0];
    }

    return [true, dist, facing];
  },

  // Lua: trainer_sight.lua:267 -- pokeemerald/src/trainer_see.c:564
  revealBuried(_eo: any, _done?: () => void, _facing?: string): void {
    // NOT FAITHFUL: Emerald only -- src.core.game3.field_effects_rse (the ash
    // puff) is not ported; only reached when Objects.isRse() is true.
    throw new Error("NOT FAITHFUL: Emerald only: src.core.game3.field_effects_rse (revealBuried)");
  },

  // Lua: trainer_sight.lua:310 -- pokeemerald/src/trainer_see.c:543
  revealDisguise(eo: any, done?: () => void): void {
    const d = eo.disguise;
    if (!d) {
      if (done) done();
      return;
    }
    // NOT FAITHFUL: Emerald only -- src.core.game3.field_effects_rse is not ported.
    throw new Error("NOT FAITHFUL: Emerald only: src.core.game3.field_effects_rse (revealDisguise)");
  },

  // Lua: trainer_sight.lua:328 -- pokeemerald/src/trainer_see.c:472
  revealThen(eo: any, facing: string | undefined, cont: () => void): void {
    if (!isRse()) return cont();
    if (eo.buried) return TrainerSight.revealBuried(eo, cont, facing);
    if (eo.disguise) return TrainerSight.revealDisguise(eo, cont);
    return cont();
  },

  // Lua: trainer_sight.lua:344 -- pokeemerald/src/battle_setup.c:1440
  encounterMusic(tid: any): any {
    const [block, row] = fieldBlock();
    const rule = block.encounterMusic;
    if (!(rule && row)) return null;
    const [okT, Trainers] = trainers();
    const t = okT && Trainers && tid != null && Trainers.get ? Trainers.get(tid) : null;
    const code = t ? (tonumber(t.encounterMusic) ?? 0) % 128 : -1;
    const C = Constants.of(row.id);
    const name = C.name("trainer_classes", code, rule.prefix);
    const song = name ? C.song(rule.song + String(name).substring(rule.prefix.length)) : null;
    return song ?? C.song(rule.default);
  },

  // Lua: trainer_sight.lua:358
  engage(game: any, eo: any, dist: number, facing?: string): void {
    const F = Field();
    const P = Player();
    const Objs = Objects();
    const Sp = Space();
    const Fx = FieldEffects();

    // 1. Strictly lock overworld state immediately
    F.locked = true;
    eo.frozen = true;
    eo.scriptBusy = true;

    // 2. Turn trainer to face player directly
    let playerFacing = OPPOSITE_FACING[eo.facing] ?? "up";

    // 3. Play encounter music immediately when trainer spots player
    const tid = TrainerSight.getTrainerId(eo);
    const [okT, Trainers] = trainers();
    // pokefirered/src/trainer_see.c:105
    if (ModRuntime.wants("world.trainer_engaged")) {
      const info = okT && Trainers && tid != null && Trainers.info ? Trainers.info(tid) : null;
      ModRuntime.emit("world.trainer_engaged", {
        npc: eo, trainerClass: info ? info.class : undefined, partyIndex: tid, trainerId: tid,
        mapId: MapMod ? MapMod.current : undefined, sight: { distance: dist, facing: eo.facing },
      });
    }
    let musicId: any = TrainerSight.encounterMusic(tid);
    if (musicId == null) {
      musicId = okT && Trainers && Trainers.getEncounterMusic ? Trainers.getEncounterMusic(tid) : null;
    }
    if (!truthy(musicId)) {
      musicId = 285; // MUS_ENCOUNTER_BOY fallback
    }
    const Audio: any = AudioMod;
    if (Audio && Audio.playSong) {
      Audio.playSong(musicId);
    }

    // 4. Play exclamation animation and sound effect SE_PIN (21)
    Fx.startExclamation(eo, () => {
      const scriptKey = eo.scriptKey ?? (eo.def ? eo.def.scriptKey : undefined);

      const finishEngagement = (): void => {
        P.facing = playerFacing;
        // pokefirered/src/trainer_see.c:349-351
        const faceMt = faceMovementType(eo.facing);
        if (Objs.setTrainerMovementType) {
          Objs.setTrainerMovementType(eo, faceMt);
        } else {
          eo.movementType = faceMt;
          eo.movement = "STAY";
          eo.range = (eo.facing ?? "down").toUpperCase();
        }
        if (Objs.overrideTemplateMovementType) {
          Objs.overrideTemplateMovementType(eo.localId, faceMt);
        }
        eo.homeX = eo.cellX;
        eo.homeY = eo.cellY;
        if (eo.def) {
          eo.def.movementType = faceMt;
          eo.def.movement = "STAY";
          eo.def.x = eo.cellX;
          eo.def.y = eo.cellY;
          eo.def.range = (eo.facing ?? "down").toUpperCase();
        }
        if (Objs.rememberPerm && Objs._mapId) {
          Objs.rememberPerm(Objs._mapId, eo.localId, {
            x: eo.cellX,
            y: eo.cellY,
            movementType: faceMt,
            facing: eo.facing,
          });
        }
        eo.frozen = false;
        eo.scriptBusy = false;
        F.locked = false;
        if (truthy(scriptKey)) {
          const dirs: Record<string, number> = { down: 1, up: 2, left: 3, right: 4 };
          const facingDir = dirs[P.facing] ?? 1;
          if (Sp && Sp.startScript) {
            Sp.startScript(scriptKey, eo.localId, facingDir);
          } else if (Sp && Sp.runScript) {
            const mod = Runtime ? Runtime._mod : undefined;
            const g = game ?? (Runtime ? Runtime._game : undefined);
            const world = g ? (g.overworld ?? g.world) : undefined;
            Sp.runScript(mod, scriptKey, g, world, eo.localId);
          }
        }
      };

      // Walk-up Approach Tracking: walk dist - 1 steps toward player, or skip if adjacent (dist == 1)
      TrainerSight.revealThen(eo, facing, () => {
        playerFacing = OPPOSITE_FACING[eo.facing] ?? playerFacing;
        const walkSteps = dist - 1;
        if (walkSteps <= 0) {
          finishEngagement();
        } else {
          const actions: any[] = [null];
          for (let n = 1; n <= walkSteps; n++) {
            actions[len(actions) + 1] = { kind: "step", dir: eo.facing };
          }
          Objs.startTrack(eo.localId, actions, () => {
            finishEngagement();
          });
        }
      });
    });
  },

  // Lua: trainer_sight.lua:483
  twoTrainerApproach,

  // Lua: trainer_sight.lua:558 -- pokeemerald/data/scripts/trainer_battle.inc:1
  engagePair(game: any, a: SightHit, b: SightHit): void {
    const F = Field();
    const Sp = Space();
    F.locked = true;
    a.eo.frozen = true; b.eo.frozen = true;
    const tidA = TrainerSight.getTrainerId(a.eo), tidB = TrainerSight.getTrainerId(b.eo);
    const rowA = battleRow(a.eo), rowB = battleRow(b.eo);
    TrainerSight._pair = { a: tidA, b: tidB };
    const finishBattle = (result: any): void => {
      const store = Sp ? Sp.store : undefined;
      const ctx = Sp && Sp.vm ? Sp.vm.ctx : undefined;
      TrainerSight._pair = null;
      F.locked = false;
      if (result === "lose" || result === "whiteout" || result === "blackout") return;
      // pokeemerald/src/battle_setup.c:1245
      for (const [, tid] of ipairs(seq(tidB, tidA))) {
        const fid = Flags.trainerFlagId(tid);
        if (store) Flags.setFlag(store, ctx, fid, true);
        const a2 = Sp && Sp.vm ? Sp.vm.adapters : undefined;
        if (a2 && a2.onFlagChanged) a2.onFlagChanged(fid, true);
      }
      // pokeemerald/src/battle_setup.c:1313
      TrainerSight.retScriptCount = 2;
      TrainerSight.checkTrainerB = false;
      const modeB = tonumber(rowB ? rowB.type : undefined) ?? 0;
      TrainerSight.trainerBRet = rowB && (modeB === 1 || modeB === 2) ? rowB.eventScript ?? null : null;
      // pokeemerald/src/battle_setup.c:1412
      for (const [i, pick] of ipairs<any>(seq(seq(rowA, a.eo), seq(rowB, b.eo)))) {
        const row = pick[1], eo = pick[2];
        const mode = tonumber(row ? row.type : undefined) ?? 0;
        if (row && row.eventScript && (mode === 1 || mode === 2) && Sp && Sp.startScript) {
          // pokeemerald/data/scripts/trainer_script.inc:13
          if (i === 2) TrainerSight.retScriptCount = 0;
          Sp.startScript(row.eventScript, eo.localId);
          return;
        }
      }
    };
    const startBattle = (): void => {
      const [okT, Trainers] = trainers();
      const foe = okT && Trainers.foeFromId(tidA);
      const dlgA = Trainers.dialogs(tidA) ?? {}, dlgB = Trainers.dialogs(tidB) ?? {};
      const text = (row: any, key: string, dlg: any): any => {
        if (row && row[key] && Sp && Sp.vm && Sp.vm.getText) {
          const t = Sp.vm.getText(row[key]);
          if (truthy(t)) return t;
        }
        return dlg;
      };
      // pokeemerald/src/battle_setup.c:1272
      const [ok, err] = BattleBridge.start(Runtime._mod, game ?? Runtime._game, foe, {
        wild: false,
        trainerId: tidA,
        trainerIdB: tidB,
        twoOpponents: true,
        double: true,
        defeatText: text(rowA, "defeatText", dlgA.defeat),
        defeatTextB: text(rowB, "defeatText", dlgB.defeat),
        done: finishBattle,
      }) as [any, any];
      if (!truthy(ok)) {
        Logger.info("%s", "[game3/trainer_sight] two-trainer battle did not start: " + tostring(err));
        finishBattle("lose");
      }
    };
    playEncounterMusic(tidA, rowA);
    approach(a.eo, a.dist, a.facing, () => {
      introSpeech(a.eo, tidA, rowA, () => {
        // pokeemerald/src/trainer_see.c:666
        playEncounterMusic(tidB, rowB);
        approach(b.eo, b.dist, b.facing, () => {
          introSpeech(b.eo, tidB, rowB, startBattle);
        });
      });
    });
  },

  // Lua: trainer_sight.lua:642
  check(game: any, specificTrainer?: any): boolean {
    const F = Field();
    if (truthy(F.locked)) return false;

    const P = Player();
    if (truthy(P.moving)) return false;

    const Warp: any = WarpMod;
    if (Warp && Warp.isBusy && Warp.isBusy()) return false;

    if (Runtime && Runtime.uiBusy && Runtime.uiBusy()) return false;

    const Sp = Space();
    if (Sp && Sp.vm && Sp.vm.isRunning && Sp.vm.isRunning()) return false;

    const Message: any = MessageMod;
    if (Message && Message.isOpen && Message.isOpen()) return false;

    const Battle: any = BattleMod;
    if (Battle && Battle.isActive && Battle.isActive()) return false;

    const store = (Sp && Sp.store) || Flags.newStore();
    const ctx = (Sp && Sp.vm && Sp.vm.ctx) || Ctx.new();

    const Objs = Objects();

    if (specificTrainer) {
      const eo = specificTrainer;
      // src/trainer_see.c:94
      if (Objs.find(eo.localId) !== eo) return false;
      if (truthy(eo.visible) && !truthy(eo.hidden) && !truthy(eo.scriptBusy) && !truthy(eo.frozen)) {
        const sight = tonumber(eo.sight ?? (eo.def ? (eo.def.sight ?? eo.def.trainerRange) : undefined)) ?? 0;
        if (sight > 0 && TrainerSight.isTrainerType(eo)
          && !TrainerSight.isDefeated(eo, store, ctx)) {
          const [spotted, dist] = TrainerSight.checkLineOfSight(eo, P, game);
          if (spotted && !TrainerSight.blockedByDoubles(eo)) {
            TrainerSight.engage(game, eo, dist);
            return true;
          }
        }
      }
      return false;
    }

    const order = Objs._order ?? {};
    if (twoTrainerApproach()) {
      // pokeemerald/src/trainer_see.c:191
      const found = approachFound;
      for (let i = len(found); i >= 1; i--) found[i] = null;
      found.length = 1;
      const doubles = canDouble();
      for (const [, lid] of ipairs(order)) {
        const eo = Objs.find(lid);
        if (eo && eo !== P && truthy(eo.visible) && !truthy(eo.hidden) && !truthy(eo.scriptBusy) && !truthy(eo.frozen)) {
          const sight = tonumber(eo.sight ?? (eo.def ? (eo.def.sight ?? eo.def.trainerRange) : undefined)) ?? 0;
          if (sight > 0 && TrainerSight.isTrainerType(eo) && !TrainerSight.isDefeated(eo, store, ctx)) {
            const [spotted, dist, facing] = TrainerSight.checkLineOfSight(eo, P, game);
            const isDouble = spotted && DOUBLE_TYPES[TrainerSight.battleType(eo) ?? 0];
            if (spotted && !(isDouble && !doubles)) {
              found[len(found) + 1] = { eo, dist, facing };
              if (isDouble || len(found) > 1 || !doubles) break;
            }
          }
        }
      }
      // pokeemerald/src/trainer_see.c:225
      TrainerSight._approached = found[1] ? found[1].eo : null;
      if (len(found) === 1) {
        TrainerSight.engage(game, found[1].eo, found[1].dist, found[1].facing);
        return true;
      } else if (len(found) === 2) {
        TrainerSight.engagePair(game, found[1], found[2]);
        return true;
      }
      return false;
    }

    // Simultaneous Spot Prioritization: iterate candidates in strict ascending localId order
    for (const [, lid] of ipairs(order as LuaTable)) {
      const eo = Objs.find(lid);
      if (eo && eo !== P && truthy(eo.visible) && !truthy(eo.hidden) && !truthy(eo.scriptBusy) && !truthy(eo.frozen)) {
        const sight = tonumber(eo.sight ?? (eo.def ? (eo.def.sight ?? eo.def.trainerRange) : undefined)) ?? 0;
        if (sight > 0 && TrainerSight.isTrainerType(eo)
          && !TrainerSight.isDefeated(eo, store, ctx)) {
          const [spotted, dist] = TrainerSight.checkLineOfSight(eo, P, game);
          if (spotted && !TrainerSight.blockedByDoubles(eo)) {
            // Immediately engage and break iterator to suppress any other simultaneous spots
            TrainerSight.engage(game, eo, dist);
            return true;
          }
        }
      }
    }

    return false;
  },
};

export default TrainerSight;
