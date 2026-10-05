// Port of gen1recomp src/core/game3/truck_sequence.lua (GPLv3 + additional terms; see LICENSE.md).
// The moving-truck intro (pokeemerald/src/field_special_scene.c).
//
// Port notes:
// - Lazily required (Game3 FIELD_CALLBACKS "truck", soft reset): registers as
//   G3Lazy["src.core.game3.truck_sequence"].
// - NOT FAITHFUL: Emerald only. Truck.METATILE reads Emerald's
//   metatile_labels at load, a table core/constants.ts does not convert (it
//   throws for that kind). The read is caught and METATILE stays empty;
//   execute() then throws "NOT FAITHFUL: Emerald only" before touching the
//   map. FireRed never runs this sequence.
// - package.loaded / require of field, field_view, objects, se_ids, audio,
//   fade, task, forced_movement: in the bundle (static imports, loaded).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ipairs, len, seq as luaSeq, type LuaTable } from "../platform/lt.ts";
import { mod, tostring } from "../../../import/gen3/lua.ts";
import { Constants } from "./constants.ts";
import { Field } from "./field.ts";
import { FieldView } from "./field_view.ts";
import { Objects } from "./objects.ts";
import { SE } from "./se_ids.ts";
import { Audio } from "./audio.ts";
import { Fade } from "../ui/fade.ts";
import { Task } from "./task.ts";
import { M as ForcedMovement } from "./forced_movement.ts";
import { G3Lazy } from "./lazy_registry.ts";

export interface TruckHost {
  setMetatile(x: number, y: number, id: any): void;
  drawWholeMapView(): void;
  lock(on: boolean): void;
  setCameraPanning(x: number, y: number): void;
  setBoxOffset(localId: number, x: number, y: number): void;
  playSe(name: string): void;
  blackout(): void;
  fadeInFromBlack(): void;
  fadeActive(): boolean;
  installPanAhead(): void;
}

interface Sub1 { timer: number }
interface Sub2 { horiz: number; step: number; vert: number; phase: number }

export interface TruckSeq {
  host: TruckHost;
  state: number;
  timer: number;
  frames: number;
  events: LuaTable;
  sub1: Sub1 | undefined;
  sub2: Sub2 | undefined;
  done: boolean;
  onEvent?: (name: string, frame: number) => void;
}

// pokeemerald/src/field_special_scene.c:27
const BOX1_X = 3, BOX1_Y = 3;
const BOX2_X = 0, BOX2_Y = -3;
const BOX3_X = -3, BOX3_Y = 0;

// Lua: truck_sequence.lua:39
function defaultHost(): TruckHost {
  const H = {} as TruckHost;
  // Lua: truck_sequence.lua:41
  H.setMetatile = (x, y, id) => {
    Field.setMetatile(x, y, id, false);
  };
  // Lua: truck_sequence.lua:45
  H.drawWholeMapView = () => {
    // package.loaded["src.core.game3.field_view"]
    const FV: any = FieldView;
    if (FV) FV._nativeDirty = true;
  };
  // Lua: truck_sequence.lua:49
  H.lock = (on) => {
    if (on) {
      Field.lock("truck");
    } else {
      Field.unlock("truck");
    }
  };
  // Lua: truck_sequence.lua:57
  H.setCameraPanning = (x, y) => {
    FieldView.setCameraPanning(x, y);
  };
  // Lua: truck_sequence.lua:60
  H.setBoxOffset = (localId, x, y) => {
    // package.loaded["src.core.game3.objects"]
    const O: any = Objects;
    const eo = O && O.find && O.find(localId);
    if (eo) {
      eo.raiseX = x;
      eo.raiseY = y;
    }
  };
  // Lua: truck_sequence.lua:68
  H.playSe = (name) => {
    const id = (SE as any)[name];
    if (id == null) throw new Error("truck: unknown SE " + tostring(name));
    Audio.playSe(id);
  };
  // Lua: truck_sequence.lua:74
  H.blackout = () => {
    const F: any = Fade;
    F.clear();
    F.mode = F.MODE.TO_BLACK;
    F.t = 16;
  };
  // Lua: truck_sequence.lua:80
  H.fadeInFromBlack = () => {
    const F: any = Fade;
    F.clear();
    F.begin(F.MODE.FROM_BLACK, 1);
  };
  // Lua: truck_sequence.lua:85
  H.fadeActive = () => {
    // package.loaded["src.ui.game3.fade"]
    const F: any = Fade;
    return (F != null && F.isActive && F.isActive()) || false;
  };
  // Lua: truck_sequence.lua:89
  H.installPanAhead = () => {
    FieldView.setCameraPanning(0, 0);
  };
  return H;
}

const state: { running: boolean; seq?: TruckSeq } = { running: false };

// Lua: truck_sequence.lua:100
function setBoxes(host: TruckHost, camX: number, y1: number, y2: number, y3: number): void {
  host.setBoxOffset(Truck.LOCALID_BOX_TOP, BOX1_X - camX, BOX1_Y + y1);
  host.setBoxOffset(Truck.LOCALID_BOX_BOTTOM_L, BOX2_X - camX, BOX2_Y + y2);
  host.setBoxOffset(Truck.LOCALID_BOX_BOTTOM_R, BOX3_X - camX, BOX3_Y + y3);
}

// Lua: truck_sequence.lua:107
// pokeemerald/src/field_special_scene.c:89
function truck1(host: TruckHost, d: Sub1): void {
  const y1 = Truck.boxYMovement(d.timer + 30) * 4;
  const y2 = Truck.boxYMovement(d.timer) * 2;
  const y3 = Truck.boxYMovement(d.timer) * 4;
  setBoxes(host, 0, y1, y2, y3);
  d.timer = d.timer + 1;
  if (d.timer === 30000) d.timer = 0;
  host.setCameraPanning(0, Truck.cameraBobY(d.timer));
}

// Lua: truck_sequence.lua:118
// pokeemerald/src/field_special_scene.c:116
function truck2(host: TruckHost, d: Sub2): boolean {
  d.horiz = d.horiz + 1;
  d.vert = d.vert + 1;
  if (d.horiz > 5) {
    d.horiz = 0;
    d.step = d.step + 1;
  }
  if (d.step === len(Truck.HORIZONTAL)) return true;
  const camX = Truck.HORIZONTAL[d.step + 1]!;
  if (camX === 2) d.phase = 3;
  host.setCameraPanning(camX, Truck.cameraBobY(d.vert));
  setBoxes(host, camX, Truck.boxYMovement(d.vert + 30) * 4, Truck.boxYMovement(d.vert) * 2,
    Truck.boxYMovement(d.vert) * 4);
  return false;
}

// Lua: truck_sequence.lua:135
// pokeemerald/src/field_special_scene.c:59
function truck3(host: TruckHost, d: Sub2): boolean {
  d.horiz = d.horiz + 1;
  if (d.horiz > 5) {
    d.horiz = 0;
    d.step = d.step + 1;
  }
  if (d.step === len(Truck.HORIZONTAL)) return true;
  const camX = Truck.HORIZONTAL[d.step + 1]!;
  host.setCameraPanning(camX, 0);
  setBoxes(host, camX, 0, 0, 0);
  return false;
}

// Lua: truck_sequence.lua:161
function event(seq: TruckSeq, name: string): void {
  seq.events[len(seq.events) + 1] = { frame: seq.frames, name };
  if (seq.onEvent) seq.onEvent(name, seq.frames);
}

// Lua: truck_sequence.lua:10 (Truck.METATILE) and :300 (registerStepCallback)
// NOT FAITHFUL: both ran at module load in Lua. Module scope must not call
// into the import cycle here, so they run on the first execute(); the "truck"
// step callback only matters once a sequence has run. Emerald only: the
// metatile_labels read throws (see the port notes) and leaves METATILE empty.
let loaded = false;
function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  try {
    const labels: any = Constants.of("emerald");
    for (const [, k] of ipairs(luaSeq("DoorClosedFloor_Bottom", "DoorClosedFloor_Mid", "DoorClosedFloor_Top",
      "ExitLight_Bottom", "ExitLight_Mid", "ExitLight_Top"))) {
      Truck.METATILE[k as string] = labels.require("metatile_labels", "METATILE_InsideOfTruck_" + k);
    }
  } catch {
    Truck.METATILE = {};
  }
  Truck.registerStepCallback();
}

export const Truck = {
  // pokeemerald/include/constants/map_event_ids.h:267
  LOCALID_BOX_TOP: 1,
  LOCALID_BOX_BOTTOM_L: 2,
  LOCALID_BOX_BOTTOM_R: 3,

  // pokeemerald/include/constants/metatile_labels.h:253
  METATILE: {} as Record<string, any>,

  // pokeemerald/src/field_special_scene.c:45
  HORIZONTAL: luaSeq(0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 2, 2, 2, 2, -1, -1, -1, 0) as LuaTable,

  // Lua: truck_sequence.lua:27
  // pokeemerald/src/field_special_scene.c:61
  cameraBobY(time: number): number {
    if (mod(time, 120) === 0) return -1;
    if (mod(time, 10) <= 4) return 1;
    return 0;
  },

  // Lua: truck_sequence.lua:34
  // pokeemerald/src/field_special_scene.c:79
  boxYMovement(time: number): number {
    if (mod(time + 120, 180) === 0) return -1;
    return 0;
  },

  defaultHost,
  _state: state,

  // Lua: truck_sequence.lua:148
  new(host?: TruckHost): TruckSeq {
    return {
      host: host || defaultHost(),
      state: 0,
      timer: 0,
      frames: 0,
      events: luaSeq(),
      sub1: undefined,
      sub2: undefined,
      done: false,
    };
  },

  // Lua: truck_sequence.lua:167
  // pokeemerald/src/field_special_scene.c:189
  step(seq: TruckSeq): boolean {
    if (seq.done) return true;
    seq.frames = seq.frames + 1;
    const host = seq.host;
    const st = seq.state;
    if (st === 0) {
      seq.timer = seq.timer + 1;
      if (seq.timer === 90) {
        seq.timer = 0;
        seq.sub1 = { timer: 0 };
        seq.state = 1;
        host.playSe("SE_TRUCK_MOVE");
        event(seq, "se_truck_move");
      }
    } else if (st === 1) {
      seq.timer = seq.timer + 1;
      if (seq.timer === 150) {
        host.fadeInFromBlack();
        seq.timer = 0;
        seq.state = 2;
        event(seq, "fade_in");
      }
    } else if (st === 2) {
      seq.timer = seq.timer + 1;
      if (!host.fadeActive() && seq.timer > 300) {
        seq.timer = 0;
        seq.sub1 = undefined;
        seq.sub2 = { horiz: 0, step: 0, vert: 0, phase: 2 };
        seq.state = 3;
        host.playSe("SE_TRUCK_STOP");
        event(seq, "se_truck_stop");
      }
    } else if (st === 3) {
      if (seq.sub2 == null) {
        host.installPanAhead();
        seq.timer = 0;
        seq.state = 4;
      }
    } else if (st === 4) {
      seq.timer = seq.timer + 1;
      if (seq.timer === 90) {
        host.playSe("SE_TRUCK_UNLOAD");
        event(seq, "se_truck_unload");
        seq.timer = 0;
        seq.state = 5;
      }
    } else if (st === 5) {
      seq.timer = seq.timer + 1;
      if (seq.timer === 120) {
        const M = Truck.METATILE;
        host.setMetatile(4, 1, M.ExitLight_Top);
        host.setMetatile(4, 2, M.ExitLight_Mid);
        host.setMetatile(4, 3, M.ExitLight_Bottom);
        host.drawWholeMapView();
        host.playSe("SE_TRUCK_DOOR");
        event(seq, "se_truck_door");
        host.lock(false);
        seq.done = true;
      }
    }
    if (seq.sub1) truck1(host, seq.sub1);
    if (seq.sub2) {
      let fin: boolean;
      if (seq.sub2.phase === 3) fin = truck3(host, seq.sub2); else fin = truck2(host, seq.sub2);
      if (fin) seq.sub2 = undefined;
    }
    return seq.done;
  },

  // Lua: truck_sequence.lua:237
  // pokeemerald/src/field_special_scene.c:260
  execute(host?: TruckHost, opts?: { onEvent?: (name: string, frame: number) => void; spawn?: boolean; onDone?: (seq: TruckSeq) => void }): TruckSeq {
    opts = opts || {};
    loadOnce();
    // NOT FAITHFUL: Emerald only (see the port notes): no METATILE ids here.
    if (Truck.METATILE.DoorClosedFloor_Top == null) {
      throw new Error("NOT FAITHFUL: Emerald only: truck_sequence needs Emerald's metatile_labels");
    }
    const seq = Truck.new(host);
    seq.onEvent = opts.onEvent;
    const h = seq.host;
    const M = Truck.METATILE;
    h.setMetatile(4, 1, M.DoorClosedFloor_Top);
    h.setMetatile(4, 2, M.DoorClosedFloor_Mid);
    h.setMetatile(4, 3, M.DoorClosedFloor_Bottom);
    h.drawWholeMapView();
    h.lock(true);
    h.blackout();
    state.running = true;
    state.seq = seq;
    if (opts.spawn !== false) {
      const onDone = opts.onDone;
      Task.spawn(() => {
        const fin = Truck.step(seq);
        if (fin) {
          state.running = false;
          if (onDone) onDone(seq);
        }
        return fin;
      });
    }
    event(seq, "execute");
    return seq;
  },

  // Lua: truck_sequence.lua:266
  isRunning(): boolean {
    return state.running === true;
  },

  // Lua: truck_sequence.lua:271
  // pokeemerald/src/field_special_scene.c:271
  endSequence(host?: TruckHost): boolean {
    if (Truck.isRunning()) return false;
    host = host || defaultHost();
    host.setBoxOffset(Truck.LOCALID_BOX_TOP, BOX1_X, BOX1_Y);
    host.setBoxOffset(Truck.LOCALID_BOX_BOTTOM_L, BOX2_X, BOX2_Y);
    host.setBoxOffset(Truck.LOCALID_BOX_BOTTOM_R, BOX3_X, BOX3_Y);
    return true;
  },

  // Lua: truck_sequence.lua:280
  reset(): void {
    state.running = false;
    state.seq = undefined;
    // package.loaded["src.core.game3.field"]
    const F: any = Field;
    if (F && F.unlock) F.unlock("truck");
  },

  // Lua: truck_sequence.lua:287
  registerStepCallback(): boolean {
    // pcall(require, "src.core.game3.forced_movement"); a module still
    // initialising in an import cycle reads as a failed require.
    let FM: any;
    try { FM = ForcedMovement; } catch { return false; }
    if (FM && FM.registerStepCallback) {
      // pokeemerald/src/field_tasks.c:66
      FM.registerStepCallback("truck", () => {
        Truck.endSequence();
        return false;
      });
      return true;
    }
    return false;
  },
};

G3Lazy["src.core.game3.truck_sequence"] = Truck;

export default Truck;
