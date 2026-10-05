// Port of gen1recomp src/core/game3/scripting/ctx.lua (GPLv3 + additional terms; see LICENSE.md).
// Game3 ScriptContext mirror.
//
// Port notes:
// - package.loaded["src.core.game3.objects" / ".runtime" / ".map"] and
//   pcall(require, "src.mods.Gen3Compat"): every module is in the bundle, so
//   each is a static import used exactly as Brian guards it.
// - Ctx.stepCallback returns a 0-based tuple [name, id] (Lua: name, id), or
//   [] for Lua's bare `return nil`.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { seq, type LuaTable } from "../../platform/lt.ts";
import { tonumber } from "../../../../import/gen3/lua.ts";
import { GameVersion } from "../../shared/core/GameVersion.ts";
import Objects from "../objects.ts";
import Runtime from "../runtime.ts";
import { Map as MapMod } from "../map.ts";
import Gen3Compat from "../../shared/mods/Gen3Compat.ts";

export interface SpecialLayout {
  family: string;
  hi: number;
  textColor?: number;
  prevTextColor?: number;
  monBoxId?: number;
  monBoxPos?: number;
  contestRank?: number;
  contestCategory?: number;
  trainerBattleOpponentA?: number;
}

export interface ScriptPc { listKey: any; index: number }

/** The table Ctx.new builds (script context). */
export interface ScriptCtx {
  specialLayout: SpecialLayout;
  mode: string;          // stopped | bytecode | native
  status: string;        // shutdown | running | waiting
  stack: LuaTable;
  comparisonResult: number;
  data: LuaTable;        // { [0]..[3] }
  stringVars: LuaTable;  // { [1] = "", [2] = "", [3] = "" }
  specialVars: Record<number, any>;
  lockSnapshots: Record<number | string, any>;
  lockKind: string | null | undefined; // "single" | "all" | nil
  activeMoves: LuaTable;
  nativePoll: (() => any) | null | undefined;
  pc: ScriptPc | null | undefined;
  messageOpen: boolean;
  frozen: boolean;
  playerName: string;
  rivalName: string;
  warnings: LuaTable;
  persistentSpecials?: any;
  selectedLocalId?: number | null;
  selectedGfx?: any;
  [key: string]: any;
}

export interface StepCallbackState { id: number; name: string; mapId: any }

function num(id: any): number {
  const n = tonumber(id);
  return n == null ? 0 : n;
}

// Lua: ctx.lua:55
function seedSpecials(layout: SpecialLayout): Record<number, any> {
  if (layout.textColor != null) {
    return { [layout.textColor]: Ctx.TEXT_COLOR_DEFAULT };
  }
  return {};
}

const STEP_CB = {
  DUMMY: 0,
  ASH: 1,
  FORTREE_BRIDGE: 2,
  PACIFIDLOG_BRIDGE: 3,
  ICE: 4,
  TRUCK: 5,
  SECRET_BASE: 6,
  CRACKED_FLOOR: 7,
};

export const Ctx = {
  SPECIAL_LO: 0x8000,
  SPECIAL_HI: 0x8014,
  TEMP_LO: 0x4000,
  TEMP_HI: 0x400F,
  GFX_VAR_LO: 0x4010,
  GFX_VAR_HI: 0x401F,

  VAR_FACING: 0x800C,
  VAR_RESULT: 0x800D,
  VAR_ITEM_ID: 0x800E,
  VAR_LAST_TALKED: 0x800F,
  VAR_TEXT_COLOR: 0x8012,
  VAR_PREV_TEXT_COLOR: 0x8013,
  TEXT_COLOR_DEFAULT: 255,

  // Lua: ctx.lua:22
  SPECIAL_LAYOUTS: {
    // pokefirered/include/constants/vars.h:313
    frlg: {
      family: "frlg",
      hi: 0x8014,
      textColor: 0x8012,
      prevTextColor: 0x8013,
      monBoxId: 0x8010,
      monBoxPos: 0x8011,
    },
    // pokeemerald/include/constants/vars.h:280
    rse: {
      family: "rse",
      hi: 0x8015,
      contestRank: 0x8010,
      contestCategory: 0x8011,
      monBoxId: 0x8012,
      monBoxPos: 0x8013,
      trainerBattleOpponentA: 0x8015,
    },
  } as Record<string, SpecialLayout>,

  // Lua: ctx.lua:44
  specialLayout(version?: string | null): SpecialLayout {
    const id = version ?? GameVersion.get();
    const family = GameVersion.layout != null ? GameVersion.layout(id) : undefined;
    return (family != null ? Ctx.SPECIAL_LAYOUTS[family] : undefined) ?? Ctx.SPECIAL_LAYOUTS.frlg;
  },

  // Lua: ctx.lua:50
  isSpecial(id: any): boolean {
    const n = num(id);
    return n >= Ctx.SPECIAL_LO && n <= Ctx.specialLayout().hi;
  },

  // Lua: ctx.lua:62
  isTemp(id: any): boolean {
    const n = num(id);
    return n >= Ctx.TEMP_LO && n <= Ctx.TEMP_HI;
  },

  // Lua: ctx.lua:67
  isGfxVar(id: any): boolean {
    const n = num(id);
    return n >= Ctx.GFX_VAR_LO && n <= Ctx.GFX_VAR_HI;
  },

  // pokefirered/include/constants/field_tasks.h:4
  STEP_CB,

  // pokefirered/src/field_tasks.c:38
  STEP_CALLBACKS: {
    [STEP_CB.ICE]: "ice",
  } as Record<number, string>,

  // pokeemerald/src/field_tasks.c:59
  STEP_CALLBACKS_RSE: {
    [STEP_CB.ASH]: "ash",
    [STEP_CB.FORTREE_BRIDGE]: "fortreeBridge",
    [STEP_CB.PACIFIDLOG_BRIDGE]: "pacifidlogBridge",
    [STEP_CB.ICE]: "sootopolisIce",
    [STEP_CB.TRUCK]: "truck",
    [STEP_CB.SECRET_BASE]: "secretBase",
    [STEP_CB.CRACKED_FLOOR]: "crackedFloor",
  } as Record<number, string>,

  // Lua: ctx.lua:100
  stepCallbackNames(layout?: SpecialLayout | null): Record<number, string> {
    layout = layout ?? Ctx.specialLayout();
    if (layout.family === "rse") return Ctx.STEP_CALLBACKS_RSE;
    return Ctx.STEP_CALLBACKS;
  },

  // Lua: ctx.lua:106
  _stepCallback: null as StepCallbackState | null,

  // pokefirered/src/field_tasks.c:96
  // Lua: ctx.lua:109
  setStepCallback(idIn: any, mapId?: any): string | null {
    let id = tonumber(idIn) ?? Ctx.STEP_CB.DUMMY;
    const names = Ctx.stepCallbackNames();
    if (names[id] == null) id = Ctx.STEP_CB.DUMMY;
    if (id === Ctx.STEP_CB.DUMMY) {
      Ctx._stepCallback = null;
      return null;
    }
    Ctx._stepCallback = { id, name: names[id], mapId };
    return Ctx._stepCallback.name;
  },

  // pokefirered/src/overworld.c:2105
  // Lua: ctx.lua:122 -- [name, id] | []
  stepCallback(mapId?: any): [string, number] | [] {
    const cb = Ctx._stepCallback;
    if (!cb) return [];
    if (mapId != null && cb.mapId != null && cb.mapId !== mapId) return [];
    return [cb.name, cb.id];
  },

  // Lua: ctx.lua:129
  resetStepCallback(): void {
    Ctx._stepCallback = null;
  },

  // Lua: ctx.lua:133
  new(opts?: any): ScriptCtx {
    opts = opts ?? {};
    const layout = Ctx.specialLayout(opts.version);
    return {
      specialLayout: layout,
      mode: "stopped",       // stopped | bytecode | native
      status: "shutdown",    // shutdown | running | waiting
      stack: seq(),
      comparisonResult: 0,
      data: [0, 0, 0, 0],    // { [0] = 0, [1] = 0, [2] = 0, [3] = 0 }
      stringVars: seq("", "", ""),
      specialVars: seedSpecials(layout),
      lockSnapshots: {},
      lockKind: null,        // "single" | "all" | nil
      activeMoves: {},
      nativePoll: null,
      pc: null,              // { listKey, index }
      messageOpen: false,
      frozen: false,
      playerName: opts.playerName ?? "PLAYER",
      rivalName: opts.rivalName ?? "RIVAL",
      warnings: seq(),
    };
  },

  // Lua: ctx.lua:158
  wipeSpecial(ctx: ScriptCtx): void {
    if (ctx.persistentSpecials) return;
    ctx.specialVars = seedSpecials(ctx.specialLayout ?? Ctx.specialLayout()); // src/field_specials.c:1542
  },

  // Lua: ctx.lua:163
  selectObject(ctx: ScriptCtx, localIdIn: any): void {
    const localId = num(localIdIn);
    ctx.selectedLocalId = localId !== 0 ? localId : null;
    ctx.selectedGfx = null;
    if (ctx.selectedLocalId != null) {
      // package.loaded["src.core.game3.objects"]
      const obj = Objects != null && Objects.find != null ? Objects.find(localId) : null;
      ctx.selectedGfx = (obj && (obj.graphicsId ?? (obj.def && (obj.def.graphicsId ?? obj.def.graphics)))) ?? null;
    }
  },

  // Lua: ctx.lua:174
  clearLocks(ctx: ScriptCtx): void {
    ctx.lockSnapshots = {};
    ctx.lockKind = null;
  },

  // Lua: ctx.lua:179
  clearMoves(ctx: ScriptCtx): void {
    ctx.activeMoves = {};
    ctx.nativePoll = null;
  },

  // Lua: ctx.lua:184
  haltCleanup(ctx: ScriptCtx): void {
    Ctx.wipeSpecial(ctx);
    Ctx.selectObject(ctx, 0);
    Ctx.clearLocks(ctx);
    Ctx.clearMoves(ctx);
    ctx.messageOpen = false;
    ctx.frozen = false;
    ctx.mode = "stopped";
    ctx.status = "shutdown";
    ctx.pc = null;
    ctx.stack = seq();
    ctx.nativePoll = null;
  },

  // Lua: ctx.lua:198
  clearTemps(store: any): void {
    if (!store) return;
    for (let id = Ctx.TEMP_LO; id <= Ctx.TEMP_HI; id++) {
      store[id] = null;
    }
  },

  // Lua: ctx.lua:205
  modCtx(vm: any): any {
    // pcall(require, "src.mods.Gen3Compat")
    if (Gen3Compat != null && typeof Gen3Compat.scriptCtx === "function") {
      let c: any;
      let okC = true;
      try { c = Gen3Compat.scriptCtx(vm); } catch { okC = false; }
      if (okC && c != null && typeof c === "object") return c;
    }
    // package.loaded["src.core.game3.runtime"] / ["src.core.game3.map"]
    const session = Runtime && Runtime.getSession != null ? Runtime.getSession() : null;
    return {
      game: Runtime && Runtime._game,
      save: session,
      session,
      overworld: { map: { id: MapMod && MapMod.current } },
      runner: vm,
    };
  },
};

export default Ctx;
