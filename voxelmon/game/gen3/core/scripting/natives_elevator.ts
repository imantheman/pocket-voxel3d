// Port of gen1recomp src/core/game3/scripting/natives_elevator.lua (GPLv3 + additional terms; see LICENSE.md).
// Elevator specials (pokefirered/src/field_specials.c): floor numbers, the
// floor-select menu position, the current-floor window, the shake and the
// window-view animation; plus Emerald's department-store elevator.
//
// Port notes:
// - Handlers return Lua's multiple returns as a 0-based tuple (natives.ts).
//   menuPosFor and dynamicWarpNum / mapGroupNum return [a, b].
// - Tables keyed from 0 in Lua (`{ [0] = 8, 16, ... }`) are JS arrays: index
//   0..n is the same key set.
// - pcall(require) / package.loaded / require of rom_text, flags, space,
//   runtime, audio, field, field_view, task, se_ids, constants,
//   natives_listmenu, natives: static imports treated as loaded.
// - NOT FAITHFUL: Emerald only. The RSE handlers need src.core.game3.rse.init
//   (not ported): rse() throws "NOT FAITHFUL: Emerald only". They stay in
//   BY_NAME (Brian merges them); FireRed's special table never binds them.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ipairs, pairs, seq, type LuaTable } from "../../platform/lt.ts";
import { mod, tonumber } from "../../../../import/gen3/lua.ts";
import RomText from "../rom_text.ts";
import Std from "./stdscripts.ts";
import Flags from "./flags.ts";
import Space from "./space.ts";
import { Runtime } from "../runtime.ts";
import { G3Lazy } from "../lazy_registry.ts";
import { Audio } from "../audio.ts";
import { Field } from "../field.ts";
import { FieldView as FieldViewMod } from "../field_view.ts";
import { Task } from "../task.ts";
import { SE } from "../se_ids.ts";
import { Constants } from "../constants.ts";
import { ListMenu } from "./natives_listmenu.ts";
import Natives, { type Handler } from "./natives.ts";

const VAR_0x8005 = 0x8005; // pokefirered/include/constants/vars.h:320
const VAR_0x8006 = 0x8006; // pokefirered/include/constants/vars.h:321
const VAR_ELEVATOR_FLOOR = 0x403A; // pokefirered/include/constants/vars.h:108

// pokefirered/src/field_specials.c:836 GetElevatorFloor
const FLOOR_BY_MAP: Record<string, number> = {
  FR_ROCKET_HIDEOUT_B4F: 0,
  FR_ROCKET_HIDEOUT_B2F: 2,
  FR_ROCKET_HIDEOUT_B1F: 3,
  FR_TRAINER_TOWER_LOBBY: 3,
  FR_SILPH_CO_1F: 4,
  FR_SILPH_CO_2F: 5,
  FR_SILPH_CO_3F: 6,
  FR_SILPH_CO_4F: 7,
  FR_SILPH_CO_5F: 8,
  FR_SILPH_CO_6F: 9,
  FR_SILPH_CO_7F: 10,
  FR_SILPH_CO_8F: 11,
  FR_SILPH_CO_9F: 12,
  FR_SILPH_CO_10F: 13,
  FR_SILPH_CO_11F: 14,
  FR_CELADON_CITY_DEPARTMENT_STORE_1F: 4,
  FR_CELADON_CITY_DEPARTMENT_STORE_2F: 5,
  FR_CELADON_CITY_DEPARTMENT_STORE_3F: 6,
  FR_CELADON_CITY_DEPARTMENT_STORE_4F: 7,
  FR_CELADON_CITY_DEPARTMENT_STORE_5F: 8,
  FR_TRAINER_TOWER_1F: 15,
  FR_TRAINER_TOWER_2F: 15,
  FR_TRAINER_TOWER_3F: 15,
  FR_TRAINER_TOWER_4F: 15,
  FR_TRAINER_TOWER_5F: 15,
  FR_TRAINER_TOWER_6F: 15,
  FR_TRAINER_TOWER_7F: 15,
  FR_TRAINER_TOWER_8F: 15,
  FR_TRAINER_TOWER_ROOF: 15,
};

// pokefirered/src/field_specials.c:836
const DEFAULT_FLOOR = 4;

// pokefirered/src/field_specials.c:931 InitElevatorFloorSelectMenuPos
const MENU_POS_BY_MAP: Record<string, LuaTable> = {
  FR_SILPH_CO_11F: seq(0, 0),
  FR_SILPH_CO_10F: seq(0, 1),
  FR_SILPH_CO_9F: seq(0, 2),
  FR_SILPH_CO_8F: seq(0, 3),
  FR_SILPH_CO_7F: seq(0, 4),
  FR_SILPH_CO_6F: seq(1, 4),
  FR_SILPH_CO_5F: seq(2, 4),
  FR_SILPH_CO_4F: seq(3, 4),
  FR_SILPH_CO_3F: seq(4, 4),
  FR_SILPH_CO_2F: seq(5, 4),
  FR_SILPH_CO_1F: seq(5, 5),
  FR_ROCKET_HIDEOUT_B1F: seq(0, 0),
  FR_ROCKET_HIDEOUT_B2F: seq(0, 1),
  FR_ROCKET_HIDEOUT_B4F: seq(0, 2),
  FR_CELADON_CITY_DEPARTMENT_STORE_5F: seq(0, 0),
  FR_CELADON_CITY_DEPARTMENT_STORE_4F: seq(0, 1),
  FR_CELADON_CITY_DEPARTMENT_STORE_3F: seq(0, 2),
  FR_CELADON_CITY_DEPARTMENT_STORE_2F: seq(0, 3),
  FR_CELADON_CITY_DEPARTMENT_STORE_1F: seq(0, 4),
  FR_TRAINER_TOWER_1F: seq(0, 0),
  FR_TRAINER_TOWER_2F: seq(0, 0),
  FR_TRAINER_TOWER_3F: seq(0, 0),
  FR_TRAINER_TOWER_4F: seq(0, 0),
  FR_TRAINER_TOWER_5F: seq(0, 0),
  FR_TRAINER_TOWER_6F: seq(0, 0),
  FR_TRAINER_TOWER_7F: seq(0, 0),
  FR_TRAINER_TOWER_8F: seq(0, 0),
  FR_TRAINER_TOWER_ROOF: seq(0, 0),
  FR_TRAINER_TOWER_LOBBY: seq(0, 1),
};

// pokefirered/src/field_specials.c:812 sElevatorAnimationDuration
const ELEVATOR_ANIM_DURATION: number[] = [8, 16, 24, 32, 38, 46, 53, 56, 57];
// pokefirered/src/field_specials.c:824 sElevatorWindowAnimDuration
const WINDOW_ANIM_DURATION: number[] = [3, 6, 9, 12, 15, 18, 21, 24, 27];

// pokefirered/include/constants/metatile_labels.h:215
const WINDOW_UP = seq(
  seq(0x2E8, 0x2E9, 0x2EA),
  seq(0x2F0, 0x2F1, 0x2F2),
  seq(0x2F8, 0x2F9, 0x2FA),
);
const WINDOW_DOWN = seq(
  seq(0x2E8, 0x2EA, 0x2E9),
  seq(0x2F0, 0x2F2, 0x2F1),
  seq(0x2F8, 0x2FA, 0x2F9),
);

// Lua: natives_elevator.lua:98
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: natives_elevator.lua:102
function sessionOf(): any {
  const rt: any = Runtime;
  return (rt && rt.getSession && rt.getSession()) || undefined;
}

// Lua: natives_elevator.lua:107
function scriptStore(): any {
  const S: any = Space;
  const session = sessionOf();
  return (S && S.store) || (session && session.store) || undefined;
}

// Lua: natives_elevator.lua:113
function varGet(ctx: any, id: number): number {
  return tonumber(flagsMod().getVar(scriptStore(), ctx, id)) ?? 0;
}

// Lua: natives_elevator.lua:117
function varSet(ctx: any, id: number, value: any): void {
  flagsMod().setVar(scriptStore(), ctx, id, tonumber(value) ?? 0);
}

// Lua: natives_elevator.lua:121
function se(id: number): void {
  try { Audio.playSe(id); } catch { /* pcall */ }
}

// Lua: natives_elevator.lua:152
function fieldView(): any {
  // package.loaded["src.core.game3.field_view"]
  return FieldViewMod;
}

// Lua: natives_elevator.lua:156
function setMetatile(x: number, y: number, mid: number): void {
  // pcall(require, "src.core.game3.field")
  const F: any = Field;
  if (F && F.setMetatile) {
    try { F.setMetatile(x, y, mid, true); } catch { /* pcall */ }
  }
}

// Lua: natives_elevator.lua:164
// pokefirered/src/field_specials.c:1132 Task_AnimateElevatorWindowView
function windowViewStep(step: number, direction: number): void {
  const table3 = (direction === 0) ? WINDOW_UP : WINDOW_DOWN;
  const col = mod(step, 3) + 1;
  for (let i = 1; i <= 3; i++) {
    for (let j = 1; j <= 3; j++) {
      setMetatile(j, i - 1, table3[i]![col]!);
    }
  }
  const FieldView = fieldView();
  if (FieldView) FieldView._nativeDirty = true;
}

// Lua: natives_elevator.lua:265
function rse(): any {
  // NOT FAITHFUL: Emerald only (see the port notes).
  const R = G3Lazy["src.core.game3.rse.init"];
  if (R == null) throw new Error("NOT FAITHFUL: Emerald only: src.core.game3.rse.init is not ported");
  return R;
}

// Lua: natives_elevator.lua:269
function playSeNamed(name: string): void {
  const id = (SE as any)[name];
  if (id) se(id);
}

// pokeemerald/src/field_specials.c:1747 SetDeptStoreFloor
const DEPT_FLOORS = seq(
  seq<any>("MAP_LILYCOVE_CITY_DEPARTMENT_STORE_1F", 4),
  seq<any>("MAP_LILYCOVE_CITY_DEPARTMENT_STORE_2F", 5),
  seq<any>("MAP_LILYCOVE_CITY_DEPARTMENT_STORE_3F", 6),
  seq<any>("MAP_LILYCOVE_CITY_DEPARTMENT_STORE_4F", 7),
  seq<any>("MAP_LILYCOVE_CITY_DEPARTMENT_STORE_5F", 8),
  seq<any>("MAP_LILYCOVE_CITY_DEPARTMENT_STORE_ROOFTOP", 15),
);
// pokeemerald/src/field_specials.c:1777 GetDeptStoreDefaultFloorChoice
const DEPT_DEFAULT_CHOICE = seq(
  seq<any>("MAP_LILYCOVE_CITY_DEPARTMENT_STORE_5F", 0),
  seq<any>("MAP_LILYCOVE_CITY_DEPARTMENT_STORE_4F", 1),
  seq<any>("MAP_LILYCOVE_CITY_DEPARTMENT_STORE_3F", 2),
  seq<any>("MAP_LILYCOVE_CITY_DEPARTMENT_STORE_2F", 3),
  seq<any>("MAP_LILYCOVE_CITY_DEPARTMENT_STORE_1F", 4),
);
// pokeemerald/src/field_specials.c:1709
const RSE_WINDOW_ROWS = seq("Top", "Mid", "Bottom");
const RSE_ASCENDING = seq(0, 1, 2);
// pokeemerald/src/field_specials.c:1728
const RSE_DESCENDING = seq(0, 2, 1);

// Lua: natives_elevator.lua:308
function dynamicWarpNum(): [number | undefined, number | undefined] {
  const session = sessionOf();
  const dw = session && session.dynamicWarp;
  if (typeof dw !== "object" || dw == null) return [undefined, undefined];
  let g = tonumber(dw.mapGroup), n = tonumber(dw.mapNum);
  if ((g == null || n == null) && typeof dw.map === "string") [g, n] = rse().mapGroupNum(dw.map, session);
  return [g, n];
}

// Lua: natives_elevator.lua:317
function mapGroupNum(name: string): [number | undefined, number | undefined] {
  const e = Constants.of(Constants.versionOf(sessionOf())).require("map_groups", name);
  return [tonumber(e.group), tonumber(e.num)];
}

const BY_NAME: Record<string, Handler> = {
  // Lua: natives_elevator.lua:228
  // pokefirered/src/field_specials.c:836
  GetElevatorFloor: (ctx) => {
    varSet(ctx, VAR_ELEVATOR_FLOOR, Elevator.floorFor(Elevator.dynamicWarpMap()));
    return [false];
  },
  // Lua: natives_elevator.lua:233
  // pokefirered/src/field_specials.c:931
  InitElevatorFloorSelectMenuPos: () => {
    const [scroll, cursor] = Elevator.menuPosFor(Elevator.dynamicWarpMap());
    ListMenu.elevatorScroll = scroll;
    ListMenu.elevatorCursorPos = cursor;
    return [false, cursor];
  },
  // Lua: natives_elevator.lua:241
  // pokefirered/src/field_specials.c:1094
  DrawElevatorCurrentFloorWindow: (ctx, adapters) => {
    // pokefirered/src/field_specials.c:737
    const key = RomText.key("sFloorNamePointers", varGet(ctx, VAR_0x8005));
    if (!RomText.has(key)) return [false];
    if (adapters && adapters.elevatorWindow) {
      try { adapters.elevatorWindow(RomText.plain(key)); } catch { /* pcall */ }
    }
    return [false];
  },
  // Lua: natives_elevator.lua:251
  // pokefirered/src/field_specials.c:1113
  CloseElevatorCurrentFloorWindow: (_, adapters) => {
    if (adapters && adapters.elevatorWindowClose) {
      try { adapters.elevatorWindowClose(); } catch { /* pcall */ }
    }
    return [false];
  },
  // Lua: natives_elevator.lua:258
  // pokefirered/src/field_specials.c:1049
  AnimateElevator: (ctx) => {
    Natives.awaitState(ctx, Elevator.animationTask(varGet(ctx, VAR_0x8005), varGet(ctx, VAR_0x8006)));
    return [false];
  },
};

const RSE_BY_NAME: Record<string, Handler> = {
  // Lua: natives_elevator.lua:401
  // pokeemerald/src/field_specials.c:1747
  SetDeptStoreFloor: () => {
    rse().setVar("VAR_DEPT_STORE_FLOOR", Elevator.deptStoreFloor());
    return [false];
  },
  // Lua: natives_elevator.lua:406
  // pokeemerald/src/field_specials.c:1777
  GetDeptStoreDefaultFloorChoice: () => {
    return [false, Elevator.deptStoreDefaultFloorChoice()];
  },
  // Lua: natives_elevator.lua:410
  // pokeemerald/src/field_specials.c:1826
  MoveElevator: (ctx) => {
    const R = rse();
    Natives.awaitState(ctx, Elevator.rseMoveTask(R.specialVar(ctx, VAR_0x8005), R.specialVar(ctx, VAR_0x8006)));
    return [false];
  },
  // Lua: natives_elevator.lua:417
  // pokeemerald/src/field_specials.c:1886
  ShowDeptStoreElevatorFloorSelect: (ctx, adapters) => {
    const key = Elevator.DEPT_STORE_FLOOR_NAMES[rse().specialVar(ctx, VAR_0x8005)];
    Elevator.rseWindow = { title: RomText.plain("gText_ElevatorNowOn"), floor: key ? RomText.plain(key) : "" };
    if (adapters && adapters.elevatorWindow) { try { adapters.elevatorWindow(Elevator.rseWindow.floor); } catch { /* pcall */ } }
    return [false];
  },
  // Lua: natives_elevator.lua:424
  // pokeemerald/src/field_specials.c:1903
  CloseDeptStoreElevatorWindow: (_, adapters) => {
    Elevator.rseWindow = undefined;
    if (adapters && adapters.elevatorWindowClose) { try { adapters.elevatorWindowClose(); } catch { /* pcall */ } }
    return [false];
  },
};

export const Elevator = {
  FLOOR_BY_MAP,
  MENU_POS_BY_MAP,

  // Lua: natives_elevator.lua:126
  // pokefirered/src/overworld.c:605 SetDynamicWarpWithCoords
  dynamicWarpMap(): string | undefined {
    const session = sessionOf();
    if (!session) return undefined;
    const dw = session.dynamicWarp;
    if (typeof dw === "object" && dw != null) {
      const id = dw.map || dw.mapId || dw.destMap;
      if (typeof id === "string") return id;
    } else if (typeof dw === "string") {
      return dw;
    }
    if (typeof session.dynamicWarpMap === "string") return session.dynamicWarpMap;
    return undefined;
  },

  // Lua: natives_elevator.lua:141
  // pokefirered/src/field_specials.c:836
  floorFor(mapId?: string): number {
    return FLOOR_BY_MAP[mapId || ""] ?? DEFAULT_FLOOR;
  },

  // Lua: natives_elevator.lua:146
  // pokefirered/src/field_specials.c:931
  menuPosFor(mapId?: string): [number, number] {
    const pos = MENU_POS_BY_MAP[mapId || ""];
    if (!pos) return [0, 0];
    return [pos[1]!, pos[2]!];
  },

  // Lua: natives_elevator.lua:177
  // pokefirered/src/field_specials.c:1119 AnimateElevatorWindowView
  windowTask(nfloors: number, direction: number): () => boolean {
    const steps = WINDOW_ANIM_DURATION[nfloors] || 0;
    let frame = 0, count = 0;
    return () => {
      if (count >= steps) return true;
      frame = frame + 1;
      if (mod(frame, 7) === 0) {
        count = count + 1;
        windowViewStep(count, direction);
      }
      return count >= steps;
    };
  },

  // Lua: natives_elevator.lua:192
  // pokefirered/src/field_specials.c:1049 AnimateElevator + Task_ElevatorShake
  animationTask(from: number, to: number): () => boolean {
    let nfloors: number, direction: number;
    if (from > to) {
      nfloors = from - to; direction = 1;
    } else {
      nfloors = to - from; direction = 0;
    }
    if (nfloors > 8) nfloors = 8;
    const shakeSteps = ELEVATOR_ANIM_DURATION[nfloors]!;
    let window: (() => boolean) | undefined = Elevator.windowTask(nfloors, direction);
    let frame = 0, shakeCount = 0, pan = 1;
    se(SE.SE_ELEVATOR);
    return () => {
      frame = frame + 1;
      if (mod(frame, 3) === 0 && shakeCount < shakeSteps) {
        shakeCount = shakeCount + 1;
        pan = -pan;
        const FieldView = fieldView();
        if (FieldView) FieldView.cameraPanY = pan;
      }
      if (window && window()) window = undefined;
      if (shakeCount < shakeSteps) return false;
      const FieldView = fieldView();
      if (FieldView) FieldView.cameraPanY = 0;
      se(SE.SE_DING_DONG);
      if (window) {
        // pcall(require, "src.core.game3.task")
        const T: any = Task;
        if (T && T.spawn) T.spawn(window);
        window = undefined;
      }
      return true;
    };
  },

  BY_NAME,

  // pokeemerald/include/constants/field_specials.h:52
  DEPT_STORE_FLOORNUM_1F: 4,
  // pokeemerald/src/field_specials.c:1689 sDeptStoreFloorNames
  DEPT_STORE_FLOOR_NAMES: [
    "gText_B4F", "gText_B3F", "gText_B2F", "gText_B1F", "gText_1F", "gText_2F", "gText_3F", "gText_4F",
    "gText_5F", "gText_6F", "gText_7F", "gText_8F", "gText_9F", "gText_10F", "gText_11F", "gText_Rooftop",
  ] as string[],
  // pokeemerald/src/field_specials.c:1828 sElevatorTripLength
  RSE_TRIP_LENGTH: [8, 16, 24, 32, 38, 46, 52, 56, 57] as number[],
  // pokeemerald/src/field_specials.c:1917 sElevatorLightCycles
  RSE_LIGHT_CYCLES: [3, 6, 9, 12, 15, 18, 21, 24, 27] as number[],
  rseWindow: undefined as { title: any; floor: any } | undefined,

  // Lua: natives_elevator.lua:324
  // pokeemerald/src/field_specials.c:1747
  deptStoreFloor(): number {
    const [, num] = dynamicWarpNum();
    for (const [, row] of ipairs<any>(DEPT_FLOORS)) {
      const [, n] = mapGroupNum(row[1]);
      if (num === n) return row[2];
    }
    return Elevator.DEPT_STORE_FLOORNUM_1F;
  },

  // Lua: natives_elevator.lua:334
  // pokeemerald/src/field_specials.c:1777
  deptStoreDefaultFloorChoice(): number {
    const [group, num] = dynamicWarpNum();
    const [g1] = mapGroupNum("MAP_LILYCOVE_CITY_DEPARTMENT_STORE_1F");
    if (group !== g1) return 0;
    for (const [, row] of ipairs<any>(DEPT_DEFAULT_CHOICE)) {
      const [, n] = mapGroupNum(row[1]);
      if (num === n) return row[2];
    }
    return 0;
  },

  // Lua: natives_elevator.lua:346
  // pokeemerald/src/field_specials.c:1915 MoveElevatorWindowLights
  rseWindowLightsTask(floorDelta: number, descending: boolean): () => boolean {
    const C: any = Constants.of(Constants.versionOf(sessionOf()));
    const stages = descending ? RSE_DESCENDING : RSE_ASCENDING;
    const total = Elevator.RSE_LIGHT_CYCLES[floorDelta] || 0;
    let timer = 0, count = 0;
    return () => {
      if (timer === 6) {
        count = count + 1;
        const stage = stages[mod(count, 3) + 1];
        for (let y = 0; y <= 2; y++) {
          const mid = C.require("metatile_labels", "METATILE_BattleFrontier_Elevator_" + RSE_WINDOW_ROWS[y + 1] + stage);
          for (let x = 0; x <= 2; x++) setMetatile(x + 1, y, mid);
        }
        const FieldView = fieldView();
        if (FieldView) FieldView._nativeDirty = true;
        timer = 0;
        if (count === total) return true;
      }
      timer = timer + 1;
      return false;
    };
  },

  // Lua: natives_elevator.lua:371
  // pokeemerald/src/field_specials.c:1826 MoveElevator
  rseMoveTask(from: number, to: number): () => boolean {
    let delta: number, descending: boolean;
    if (from > to) { delta = from - to; descending = true; } else { delta = to - from; descending = false; }
    if (delta > 8) delta = 8;
    const total = Elevator.RSE_TRIP_LENGTH[delta];
    // pcall(require, "src.core.game3.task")
    const T: any = Task;
    const lights = Elevator.rseWindowLightsTask(delta, descending);
    if (T && T.spawn) T.spawn(lights);
    playSeNamed("SE_ELEVATOR");
    let timer = 0, moves = 0, pan = 1;
    return () => {
      timer = timer + 1;
      if (mod(timer, 3) === 0) {
        timer = 0;
        moves = moves + 1;
        pan = -pan;
        const FieldView = fieldView();
        if (FieldView) FieldView.cameraPanY = pan;
        if (moves === total) {
          playSeNamed("SE_DING_DONG");
          if (FieldView) FieldView.cameraPanY = 0;
          return true;
        }
      }
      return false;
    };
  },

  /** Set by Std.legacyHandlers: special id -> handler. */
  HANDLERS: undefined as Record<number, Handler> | undefined,
};
// Lua: natives_elevator.lua:430
for (const [name, fn] of pairs(RSE_BY_NAME)) Elevator.BY_NAME[name as string] = fn;

// Lua: natives_elevator.lua:432
Std.legacyHandlers(Elevator);

export default Elevator;
