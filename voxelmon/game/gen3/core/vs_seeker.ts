// Port of gen1recomp src/core/game3/vs_seeker.lua (GPLv3 + additional terms; see LICENSE.md).
// The VS Seeker (pokefirered src/vs_seeker.c): battery, rematch tiers, the
// use sequence and the charged-trainer reset.
//
// Return shapes (Lua multiple returns -> 0-based tuples):
//   nextAvailable -> [j, ri]; canUse -> [code, need?];
//   computeResponse -> [response, actions, responders]; use -> [ok, code].
// Lua tables keyed by both 5 and "5" (rematches) share one JS key; Brian
// clears the string key before writing the number, so the result is the same.

import { tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { MapCatalog } from "../../../import/gen3/map_catalog.ts";
import { Data } from "./vs_seeker_data.ts";
import { Flags } from "./scripting/flags.ts";
import { Rng } from "./rng.ts";
import { RomText } from "./rom_text.ts";
import { SE } from "./se_ids.ts";
import { Audio } from "./audio.ts";
import { Runtime } from "./runtime.ts";
import { Objects as ObjectsMod } from "./objects.ts";
import { Space } from "./scripting/space.ts";
import { Bag } from "./bag.ts";
import { TrainerSight } from "./trainer_sight.ts";
import { Map as MapMod } from "./map.ts";
import { Dataset } from "./dataset.ts";
import { Field as FieldMod } from "./field.ts";
import { Hud } from "../ui/hud.ts";
import { Player as PlayerMod } from "./player.ts";
import { StepEvents } from "./step_events.ts";
import { Items } from "./items.ts";
import { R as QuestLogRecorder } from "./quest_log_recorder.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface VsSeekerState { steps: number; charging: number; rematches: Record<number | string, any> }
export interface TrainerInfo { localId: number; trainerIdx: number; x: number; y: number; graphicsId: number; sane: boolean }
export interface Responder { trainerIdx: number; behavior: number }
export interface SeekerAction { localId: number; movement: LuaTable; rematch?: boolean }

// Lua: vs_seeker.lua:31
const RESP_RAND = 0, RESP_NO = 1, RESP_YES = 2;

// Lua: vs_seeker.lua:52
const RAISE_HAND: Record<number, boolean> = {
  [0x4D]: true,
  [0x4E]: true,
  [0x4F]: true,
};

// Lua: vs_seeker.lua:59 -- src/vs_seeker.c:1132
const RAISE_HAND_AND_JUMP_GFX: Record<number, boolean> = {
  [17]: true, [18]: true, [19]: true, [20]: true, [22]: true, [23]: true,
  [24]: true, [25]: true, [26]: true, [28]: true, [29]: true, [30]: true,
  [37]: true, [39]: true, [40]: true, [41]: true, [42]: true, [45]: true,
  [46]: true, [54]: true, [56]: true, [62]: true,
};
const RAISE_HAND_AND_SWIM_GFX: Record<number, boolean> = { [36]: true, [43]: true, [44]: true };

// Lua: vs_seeker.lua:67
const FACE_TYPE_BY_FACING: Record<string, number> = { up: 0x07, down: 0x08, left: 0x09, right: 0x0A };

// Lua: vs_seeker.lua:69
function se(id: any): void {
  try {
    if (Audio && Audio.playSe) Audio.playSe(id);
  } catch { /* pcall */ }
}

// Lua: vs_seeker.lua:76
function runtimeSession(): any {
  return Runtime && Runtime.getSession ? Runtime.getSession() ?? null : null;
}

// Lua: vs_seeker.lua:81
function objectsMod(): any {
  return ObjectsMod;
}

// Lua: vs_seeker.lua:119
function getFlag(id: number, st?: any): boolean {
  return Flags.getFlag(st ?? VsSeeker.store(), null, id);
}

// Lua: vs_seeker.lua:123
function setFlag(id: number, on: boolean, st?: any): void {
  st = st ?? VsSeeker.store();
  if (st) Flags.setFlag(st, null, id, on);
}

// Lua: vs_seeker.lua:128
function fought(trainerId: any, st?: any): boolean {
  return getFlag(Flags.trainerFlagId(trainerId), st);
}

// Lua: vs_seeker.lua:137
function setRematch(s: VsSeekerState, localIdIn: any, v: any): void {
  const localId = tonumber(localIdIn) ?? 0;
  delete s.rematches[tostring(localId)];
  if (v != null && v !== false && v !== 0) s.rematches[localId] = v;
  else delete s.rematches[localId];
}

// Lua: vs_seeker.lua:191 -- src/vs_seeker.c:1002
function stepDownTier(row: LuaTable, j: number): number {
  j = j - 1;
  while (j !== 0) {
    if (row[j + 1] !== Data.SKIP) return j;
    j = j - 1;
  }
  return 0;
}

// Lua: vs_seeker.lua:248
function templateTrainerId(def: any, eo: any): number | null | undefined {
  if (def && def.trainerId) return tonumber(def.trainerId);
  let TS: any;
  try { TS = TrainerSight; } catch { return null; }
  return TS.getTrainerId(eo ?? { def, scriptKey: def ? def.scriptKey : undefined });
}

// Lua: vs_seeker.lua:255
function isSane(eo: any): boolean {
  return eo != null && eo.visible !== false && !truthy(eo.hidden);
}

// Lua: vs_seeker.lua:259
function trainerTemplates(Objects: any): any[] {
  const out: any[] = [null];
  for (const [, def] of ipairs<any>(Objects._defs ?? {})) {
    const tt = tonumber(def.trainerType) ?? 0;
    const lid = tonumber(def.localId ?? def.index) ?? 0;
    if ((tt === 1 || tt === 3) && lid > 0) {
      out[len(out) + 1] = { def, localId: lid, eo: Objects._byId ? Objects._byId[lid] : undefined };
    }
  }
  return out;
}

// Lua: vs_seeker.lua:311 -- src/vs_seeker.c:1285
function curResponse(infos: LuaTable, idx: number, trainerIdx: number, responders: LuaTable, px: number, py: number): number {
  for (let i = 1; i <= idx - 1; i++) {
    const other = infos[i];
    if (VsSeeker.isVisible(other, px, py) && other.trainerIdx === trainerIdx) {
      for (const [, r] of ipairs<Responder>(responders)) {
        if (r.trainerIdx === other.trainerIdx) return RESP_YES;
      }
      return RESP_NO;
    }
  }
  return RESP_RAND;
}

// Lua: vs_seeker.lua:486
function fieldLock(on: boolean): void {
  const Field: any = FieldMod;
  if (!Field) return;
  if (on) Field.lock(); else Field.unlock();
}

// Lua: vs_seeker.lua:492
function showMessage(game: any, text: string, done?: (...a: any[]) => void): void {
  fieldLock(true);
  Hud.openMessage(game, text, {
    done: () => {
      fieldLock(false);
      if (done) done();
    },
  });
}

// Lua: vs_seeker.lua:503
function playerCoords(): [number, number] {
  const Player: any = PlayerMod;
  if (!Player) return [0, 0];
  if (truthy(Player.moving) && Player.targetX != null) return [Player.targetX, Player.targetY];
  return [Player.cellX ?? 0, Player.cellY ?? 0];
}

// Lua: vs_seeker.lua:510
function freezeAll(Objects: any): void {
  for (const [, lid] of ipairs(Objects._order ?? {})) {
    const eo = Objects._byId[lid];
    if (eo) eo.frozen = true;
  }
}

// Lua: vs_seeker.lua:517
function unfreezeAll(Objects: any): void {
  for (const [, lid] of ipairs(Objects._order ?? {})) {
    const eo = Objects._byId[lid];
    if (eo && !truthy(eo.scriptBusy)) eo.frozen = false;
  }
}

// Lua: vs_seeker.lua:524
function queue(ev: any): void {
  StepEvents.queueEvent(ev);
}

export const VsSeeker = {
  // Lua: vs_seeker.lua:9 -- pokefirered/include/constants/items.h:434
  ITEM_VS_SEEKER: 362,
  MAX_CHARGE: 100,
  FLAG_SYS_VS_SEEKER_CHARGING: 0x801,
  // src/vs_seeker.c:973
  TIER_FLAGS: seq(0x292, 0x896, 0x897, 0x82C, 0x844) as (number | null)[],

  MOVEMENT_TYPE_FACE_UP: 0x07,
  MOVEMENT_TYPE_FACE_DOWN: 0x08,
  MOVEMENT_TYPE_FACE_LEFT: 0x09,
  MOVEMENT_TYPE_FACE_RIGHT: 0x0A,
  MOVEMENT_TYPE_RAISE_HAND_AND_STOP: 0x4D,
  MOVEMENT_TYPE_RAISE_HAND_AND_JUMP: 0x4E,
  MOVEMENT_TYPE_RAISE_HAND_AND_SWIM: 0x4F,

  NOT_CHARGED: 0,
  NO_ONE_IN_RANGE: 1,
  CAN_USE: 2,

  RESPONSE_NO_RESPONSE: 0,
  RESPONSE_UNFOUGHT_TRAINERS: 1,
  RESPONSE_FOUND_REMATCHES: 2,

  // Lua: vs_seeker.lua:34
  EFFECT_FRAMES: 89,
  WAIT_FRAMES: 48,

  // Lua: vs_seeker.lua:38 -- src/vs_seeker.c:565
  MOVEMENT_UNFOUGHT: seq(0x62, 0xFE) as LuaTable,
  MOVEMENT_NO_REMATCH: seq(0x64, 0xFE) as LuaTable,
  MOVEMENT_REMATCH: seq(0x2D, 0x65, 0xFE) as LuaTable,

  // Lua: vs_seeker.lua:43 -- data/text/trainers.inc:1
  TEXT: {
    notCharged: "VSSeeker_Text_BatteryNotChargedNeedXSteps",
    noTrainers: "VSSeeker_Text_NoTrainersWithinRange",
    notReady: "VSSeeker_Text_TrainersNotReady",
  },

  // Lua: vs_seeker.lua:50 -- src/item_use.c:712
  EXCLUDED_PRET_MAPS: seq("ViridianForest", "MtEmber_Exterior", "ThreeIsland_BerryForest", "SixIsland_PatternBush") as (string | null)[],

  // Lua: vs_seeker.lua:85
  isRaiseHand(mt: unknown): boolean {
    return RAISE_HAND[tonumber(mt) ?? -1] === true;
  },

  // Lua: vs_seeker.lua:89
  faceTypeFor(facing?: string): number {
    return FACE_TYPE_BY_FACING[facing ?? "down"] ?? VsSeeker.MOVEMENT_TYPE_FACE_DOWN;
  },

  // Lua: vs_seeker.lua:93
  state(session?: any): VsSeekerState {
    session = session ?? runtimeSession();
    if (!session) return { steps: 0, charging: 0, rematches: {} };
    let s = session.vsSeeker;
    if (s == null || typeof s !== "object") {
      s = {};
      session.vsSeeker = s;
    }
    s.steps = tonumber(s.steps) ?? 0;
    s.charging = tonumber(s.charging) ?? 0;
    if (s.rematches == null || typeof s.rematches !== "object") s.rematches = {};
    return s;
  },

  // Lua: vs_seeker.lua:107
  store(session?: any): any {
    if (Space && Space.store) return Space.store;
    session = session ?? runtimeSession();
    if (session) {
      session.flags = session.flags ?? {};
      session.vars = session.vars ?? {};
      return { flags: session.flags, vars: session.vars };
    }
    return null;
  },

  // Lua: vs_seeker.lua:132
  getRematch(s: VsSeekerState, localId: any): number {
    const v = s.rematches[tonumber(localId) ?? -1] ?? s.rematches[tostring(localId)];
    return tonumber(v) ?? 0;
  },

  // Lua: vs_seeker.lua:143
  getBattery(session?: any): number {
    return VsSeeker.state(session).steps;
  },

  // Lua: vs_seeker.lua:147
  setBattery(session: any, charge: unknown): void {
    const s = VsSeeker.state(session);
    s.steps = Math.min(VsSeeker.MAX_CHARGE, Math.max(0, Math.floor(tonumber(charge) ?? 0)));
  },

  // Lua: vs_seeker.lua:153 -- src/vs_seeker.c:1209
  clearAllRematchStates(session?: any): void {
    VsSeeker.state(session).rematches = {};
  },

  // Lua: vs_seeker.lua:158 -- src/vs_seeker.c:664
  onStep(session: any, st?: any): boolean {
    const s = VsSeeker.state(session);
    if (session && session.bag && Bag.has(session.bag, VsSeeker.ITEM_VS_SEEKER, 1)) {
      if (s.steps < VsSeeker.MAX_CHARGE) s.steps = s.steps + 1;
    }
    st = st ?? VsSeeker.store(session);
    if (getFlag(VsSeeker.FLAG_SYS_VS_SEEKER_CHARGING, st)) {
      if (s.charging < VsSeeker.MAX_CHARGE) s.charging = s.charging + 1;
      if (s.charging === VsSeeker.MAX_CHARGE) {
        setFlag(VsSeeker.FLAG_SYS_VS_SEEKER_CHARGING, false, st);
        s.charging = 0;
        s.rematches = {};
        return true;
      }
    }
    return false;
  },

  // Lua: vs_seeker.lua:178 -- src/vs_seeker.c:1235
  nextAvailable(trainerId: unknown, st?: any): [number, number | null] {
    const ri = Data.byBase[tonumber(trainerId) ?? -1];
    if (!ri) return [0, null];
    const row = Data.REMATCHES[ri]!;
    for (let j = 1; j <= Data.MAX_REMATCH_PARTIES - 1; j++) {
      const id = row[j + 1];
      if (id == null || id === Data.TRAINER_NONE) return [j - 1, ri];
      if (id !== Data.SKIP && !fought(id, st)) return [j, ri];
    }
    return [Data.MAX_REMATCH_PARTIES - 1, ri];
  },

  // Lua: vs_seeker.lua:201 -- src/vs_seeker.c:1075
  rematchTrainerId(trainerId: unknown, st?: any): number {
    let [j, ri] = VsSeeker.nextAvailable(trainerId, st);
    if (j === 0) return 0;
    const row = Data.REMATCHES[ri!]!;
    const tier = VsSeeker.TIER_FLAGS[j];
    if (tier && !getFlag(tier, st)) {
      j = stepDownTier(row, j);
    }
    return row[j + 1] ?? 0;
  },

  // Lua: vs_seeker.lua:213 -- src/vs_seeker.c:1013
  shouldTryRematchBattle(opponentA: unknown, lastTalked: unknown, st?: any, session?: any): boolean {
    const ri = Data.byBase[tonumber(opponentA) ?? -1];
    if (!ri) return false;
    if (VsSeeker.getRematch(VsSeeker.state(session), lastTalked) !== 0) return true;
    return fought(Data.REMATCHES[ri]![1], st);
  },

  // Lua: vs_seeker.lua:221 -- src/vs_seeker.c:1086
  isTrainerReadyForRematch(opponentA: unknown, lastTalked: unknown, session?: any): boolean {
    if (!Data.byAny[tonumber(opponentA) ?? -1]) return false;
    return VsSeeker.getRematch(VsSeeker.state(session), lastTalked) !== 0;
  },

  // Lua: vs_seeker.lua:227 -- src/vs_seeker.c:1047
  clearRematchStateOfLastTalked(lastTalked: unknown, opponentA: unknown, st?: any, session?: any): void {
    setRematch(VsSeeker.state(session), lastTalked, 0);
    setFlag(Flags.trainerFlagId(opponentA), true, st);
  },

  // Lua: vs_seeker.lua:233 -- src/vs_seeker.c:1113
  randomFaceType(): number {
    const r = Rng.Random() % 4;
    if (r === 0) return VsSeeker.MOVEMENT_TYPE_FACE_UP;
    if (r === 2) return VsSeeker.MOVEMENT_TYPE_FACE_LEFT;
    if (r === 3) return VsSeeker.MOVEMENT_TYPE_FACE_RIGHT;
    return VsSeeker.MOVEMENT_TYPE_FACE_DOWN;
  },

  // Lua: vs_seeker.lua:241
  runningBehavior(graphicsIdIn: unknown): number {
    const graphicsId = tonumber(graphicsIdIn) ?? -1;
    if (RAISE_HAND_AND_JUMP_GFX[graphicsId]) return VsSeeker.MOVEMENT_TYPE_RAISE_HAND_AND_JUMP;
    if (RAISE_HAND_AND_SWIM_GFX[graphicsId]) return VsSeeker.MOVEMENT_TYPE_RAISE_HAND_AND_SWIM;
    return VsSeeker.MOVEMENT_TYPE_RAISE_HAND_AND_STOP;
  },

  // Lua: vs_seeker.lua:272 -- src/vs_seeker.c:806
  gather(Objects?: any): TrainerInfo[] {
    Objects = Objects ?? objectsMod();
    const infos: any[] = [null];
    for (const [, t] of ipairs<any>(trainerTemplates(Objects))) {
      const eo = t.eo;
      infos[len(infos) + 1] = {
        localId: t.localId,
        trainerIdx: templateTrainerId(t.def, eo) ?? 0,
        x: eo ? eo.cellX ?? 0 : 0,
        y: eo ? eo.cellY ?? 0 : 0,
        graphicsId: tonumber(t.def.graphicsId ?? t.def.graphics) ?? 0,
        sane: isSane(eo),
      };
    }
    return infos;
  },

  // Lua: vs_seeker.lua:290 -- src/vs_seeker.c:1217
  isVisible(info: TrainerInfo, px: number, py: number): boolean {
    if (!info.sane) return false;
    return Math.abs((info.x ?? 0) - px) <= 7 && Math.abs((info.y ?? 0) - py) <= 5;
  },

  // Lua: vs_seeker.lua:296 -- src/vs_seeker.c:852
  canUse(infos: LuaTable, px: number, py: number, s: VsSeekerState, st?: any): [number, number?] {
    if (s.steps !== VsSeeker.MAX_CHARGE) {
      return [VsSeeker.NOT_CHARGED, VsSeeker.MAX_CHARGE - s.steps];
    }
    for (const [, info] of ipairs<TrainerInfo>(infos)) {
      if (VsSeeker.isVisible(info, px, py)) {
        if (!fought(info.trainerIdx, st) || VsSeeker.nextAvailable(info.trainerIdx, st)[0] !== 0) {
          return [VsSeeker.CAN_USE];
        }
      }
    }
    return [VsSeeker.NO_ONE_IN_RANGE];
  },

  // Lua: vs_seeker.lua:325 -- src/vs_seeker.c:869
  computeResponse(infos: LuaTable, px: number, py: number, s: VsSeekerState, st?: any): [number, SeekerAction[], Responder[]] {
    const actions: any[] = [null];
    const responders: any[] = [null];
    let unfought = false, wants = false;
    for (const [i, info] of ipairs<TrainerInfo>(infos)) {
      if (VsSeeker.isVisible(info, px, py)) {
        const tid = info.trainerIdx;
        if (!fought(tid, st)) {
          actions[len(actions) + 1] = { localId: info.localId, movement: VsSeeker.MOVEMENT_UNFOUGHT };
          unfought = true;
        } else {
          const j = VsSeeker.nextAvailable(tid, st)[0];
          if (j === 0) {
            actions[len(actions) + 1] = { localId: info.localId, movement: VsSeeker.MOVEMENT_NO_REMATCH };
          } else {
            let rval = Rng.Random() % 100;
            const resp = curResponse(infos, i, tid, responders, px, py);
            if (resp === RESP_YES) {
              rval = 100;
            } else if (resp === RESP_NO) {
              rval = 0;
            }
            if (rval < 30) {
              actions[len(actions) + 1] = { localId: info.localId, movement: VsSeeker.MOVEMENT_NO_REMATCH };
            } else {
              setRematch(s, info.localId, j);
              actions[len(actions) + 1] = { localId: info.localId, movement: VsSeeker.MOVEMENT_REMATCH, rematch: true };
              responders[len(responders) + 1] = { trainerIdx: tid, behavior: VsSeeker.runningBehavior(info.graphicsId) };
              wants = true;
            }
          }
        }
      }
    }
    if (wants) {
      se(SE.SE_PIN);
      setFlag(VsSeeker.FLAG_SYS_VS_SEEKER_CHARGING, true, st);
      s.charging = 0;
      return [VsSeeker.RESPONSE_FOUND_REMATCHES, actions, responders];
    }
    if (unfought) {
      return [VsSeeker.RESPONSE_UNFOUGHT_TRAINERS, actions, responders];
    }
    return [VsSeeker.RESPONSE_NO_RESPONSE, actions, responders];
  },

  // Lua: vs_seeker.lua:371 -- src/vs_seeker.c:1305
  startAllRespondantIdleMovements(infos: LuaTable, responders: LuaTable, s: VsSeekerState, st?: any, Objects?: any): void {
    Objects = Objects ?? objectsMod();
    for (const [, r] of ipairs<Responder>(responders)) {
      for (const [, info] of ipairs<TrainerInfo>(infos)) {
        if (info.trainerIdx === r.trainerIdx) {
          if (info.sane && Objects.setTrainerMovementType) {
            Objects.setTrainerMovementType(info.localId, r.behavior);
          }
          if (Objects.overrideTemplateMovementType) {
            Objects.overrideTemplateMovementType(info.localId, r.behavior);
          }
          setRematch(s, info.localId, VsSeeker.nextAvailable(info.trainerIdx, st)[0]);
        }
      }
    }
  },

  // Lua: vs_seeker.lua:389 -- src/vs_seeker.c:636
  resetObjectMovementAfterChargeComplete(Objects?: any): void {
    Objects = Objects ?? objectsMod();
    for (const [, t] of ipairs<any>(trainerTemplates(Objects))) {
      const mt = (Objects.templateMovementType ? Objects.templateMovementType(t.localId) : null)
        ?? tonumber(t.def.movementType);
      if (VsSeeker.isRaiseHand(mt)) {
        const face = VsSeeker.randomFaceType();
        if (isSane(t.eo) && Objects.setTrainerMovementType) {
          Objects.setTrainerMovementType(t.localId, face);
        }
        if (Objects.overrideTemplateMovementType) {
          Objects.overrideTemplateMovementType(t.localId, face);
        }
      }
    }
  },

  // Lua: vs_seeker.lua:407 -- src/vs_seeker.c:693
  mapReset(session?: any, st?: any, Objects?: any): void {
    const s = VsSeeker.state(session);
    setFlag(VsSeeker.FLAG_SYS_VS_SEEKER_CHARGING, false, st ?? VsSeeker.store(session));
    s.charging = 0;
    s.rematches = {};
    Objects = Objects ?? objectsMod();
    if (!Objects) return;
    for (const [, lid] of ipairs(Objects._order ?? {})) {
      const eo = Objects._byId ? Objects._byId[lid] : null;
      if (eo && VsSeeker.isRaiseHand(eo.movementType)) {
        const face = VsSeeker.randomFaceType();
        if (Objects.setTrainerMovementType) {
          Objects.setTrainerMovementType(lid, face);
        }
      }
    }
  },

  // Lua: vs_seeker.lua:426 -- src/vs_seeker.c:937
  clearRematchStateByTrainerId(opponentA: unknown, selectedLocalIdIn: unknown, _st?: any, session?: any, Objects?: any): void {
    const ri = Data.byAny[tonumber(opponentA) ?? -1];
    if (!ri) return;
    Objects = Objects ?? objectsMod();
    if (!Objects) return;
    const s = VsSeeker.state(session);
    const selectedLocalId = tonumber(selectedLocalIdIn) ?? -1;
    for (const [, t] of ipairs<any>(trainerTemplates(Objects))) {
      const tid = templateTrainerId(t.def, t.eo);
      if (tid != null && Data.byAny[tid] === ri) {
        Rng.Random();
        const eo = t.eo;
        const faceType = VsSeeker.faceTypeFor(eo ? eo.facing : undefined);
        if (Objects.overrideTemplateMovementType) {
          Objects.overrideTemplateMovementType(t.localId, faceType);
        }
        setRematch(s, t.localId, 0);
        if (eo && Objects.setTrainerMovementType) {
          Objects.setTrainerMovementType(t.localId,
            t.localId === selectedLocalId ? faceType : VsSeeker.MOVEMENT_TYPE_FACE_DOWN);
        }
      }
    }
  },

  // Lua: vs_seeker.lua:451
  mapAllowed(mapId: any, mapTypeIn: unknown): boolean {
    const mapType = tonumber(mapTypeIn) ?? 0;
    if (mapType !== 1 && mapType !== 2 && mapType !== 3) return false;
    for (const [, pret] of ipairs<string>(VsSeeker.EXCLUDED_PRET_MAPS)) {
      if (mapId === pret) return false;
      if (MapCatalog.pretToEngine && MapCatalog.pretToEngine(pret) === mapId) return false;
    }
    return true;
  },

  // Lua: vs_seeker.lua:462
  currentMapType(session: any): number {
    const mapId = session ? session.map : undefined;
    const M: any = MapMod;
    let def = M && M.currentDef && (M.current == null || M.current === mapId) ? M.currentDef() ?? null : null;
    if (!(def && def.mapType) && mapId) {
      const D: any = Dataset;
      if (D && D.map) {
        try {
          const d = D.map(mapId);
          if (d) def = d;
        } catch { /* pcall */ }
      }
    }
    return def ? tonumber(def.mapType) ?? 0 : 0;
  },

  // Lua: vs_seeker.lua:477 -- src/item_use.c:712
  canUseHere(session: any): boolean {
    return VsSeeker.mapAllowed(session ? session.map : undefined, VsSeeker.currentMapType(session));
  },

  // Lua: vs_seeker.lua:482 -- src/strings.c:188
  notTimeText(session: any): string {
    return RomText.ascii("gText_OakForbidsUseOfItemHere", { playerName: session.name ?? session.playerName });
  },

  // Lua: vs_seeker.lua:530 -- src/vs_seeker.c:745
  use(session: any, game: any, onDone?: (ok: boolean, response?: number) => void): [boolean, number] {
    session = session ?? runtimeSession();
    const st = VsSeeker.store(session);
    const s = VsSeeker.state(session);
    const Objects = objectsMod();
    const infos = VsSeeker.gather(Objects);
    const [px, py] = playerCoords();
    const [code, need] = VsSeeker.canUse(infos, px, py, s, st);
    if (code === VsSeeker.NOT_CHARGED) {
      // src/vs_seeker.c:864
      showMessage(game, RomText.ascii(VsSeeker.TEXT.notCharged, { stringVars: seq(tostring(need)) }), onDone as any);
      return [false, code];
    } else if (code === VsSeeker.NO_ONE_IN_RANGE) {
      showMessage(game, RomText.ascii(VsSeeker.TEXT.noTrainers), onDone as any);
      return [false, code];
    }

    try {
      QuestLogRecorder.event(session, "UsedTheItem", seq(Items.displayName(VsSeeker.ITEM_VS_SEEKER)));
    } catch { /* pcall */ }

    const sq: any = { t: 0, finished: false };
    const finish = (): void => {
      sq.finished = true;
      unfreezeAll(Objects);
      fieldLock(false);
      if (sq.evDone) sq.evDone();
      if (onDone) onDone(true, sq.response);
    };

    queue({
      type: "vs_seeker",
      run: (evDone: () => void) => {
        sq.evDone = evDone;
        fieldLock(true);
        freezeAll(Objects);
        const Player: any = PlayerMod;
        // src/field_player_avatar.c:1336
        if (Player && Player.startFieldMove) {
          Player.startFieldMove(VsSeeker.EFFECT_FRAMES, truthy(Player.biking) ? "vs_seeker_bike" : "vs_seeker");
        }
      },
      tick: () => {
        if (sq.finished || sq.waitingText) return;
        sq.t = sq.t + 1;
        const t = sq.t;
        if (t === 31 || t === 42) se(SE.SE_CONTEST_MONS_TURN);
        if (t === VsSeeker.EFFECT_FRAMES) {
          s.steps = 0;
          const [ppx, ppy] = playerCoords();
          const [response, actions, responders] = VsSeeker.computeResponse(infos, ppx, ppy, s, st);
          sq.response = response;
          sq.responders = responders;
          for (const [, a] of ipairs<SeekerAction>(actions)) {
            const eo = Objects._byId[a.localId];
            if (eo) eo.frozen = false;
            Objects.applyMovement(a.localId, a.movement, () => {
              if (sq.finished && eo && !truthy(eo.scriptBusy)) eo.frozen = false;
            });
          }
          sq.waitUntil = t + VsSeeker.WAIT_FRAMES;
        }
        if (sq.waitUntil && t >= sq.waitUntil) {
          if (sq.response === VsSeeker.RESPONSE_NO_RESPONSE) {
            sq.waitingText = true;
            Hud.openMessage(game, RomText.ascii(VsSeeker.TEXT.notReady), { done: finish });
          } else {
            if (sq.response === VsSeeker.RESPONSE_FOUND_REMATCHES) {
              VsSeeker.startAllRespondantIdleMovements(infos, sq.responders, s, st, Objects);
            }
            finish();
          }
        }
      },
    });
    return [true, code];
  },

  // Lua: vs_seeker.lua:611 -- data/event_scripts.s:1228
  chargingDoneEvent(): any {
    const Objects = objectsMod();
    const ev: any = { type: "vs_seeker_charged" };
    ev.run = (done: () => void) => {
      ev.done = done;
    };
    ev.tick = () => {
      if (!ev.done) return;
      const Player: any = PlayerMod;
      if (Player && truthy(Player.moving)) return;
      // src/vs_seeker.c:616
      let waiting = false;
      for (const [, lid] of ipairs(Objects._order ?? {})) {
        const eo = Objects._byId[lid];
        if (eo) {
          if (!truthy(eo.frozen)) {
            if ((eo.raiseY ?? 0) !== 0) waiting = true; else eo.frozen = true;
          }
          if (truthy(eo.moving)) waiting = true;
        }
      }
      if (waiting) return;
      if (Objects.hasActiveTracks && Objects.hasActiveTracks()) return;
      freezeAll(Objects);
      VsSeeker.resetObjectMovementAfterChargeComplete(Objects);
      unfreezeAll(Objects);
      const cb = ev.done;
      ev.done = null;
      cb();
    };
    return ev;
  },
};

export default VsSeeker;
