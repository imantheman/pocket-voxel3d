// Port of gen1recomp src/core/game3/scripting/vm.lua (GPLv3 + additional terms; see LICENSE.md).
// Game3 script VM (FRLG dialect).
//
// Port notes:
// - package.loaded["src.core.game3.field"] is a static import, guarded the
//   way Brian guards it.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { seq, pairs, type LuaTable } from "../../platform/lt.ts";
import { tostring, tonumber, truthy } from "../../../../import/gen3/lua.ts";
import { Ctx, type ScriptCtx } from "./ctx.ts";
import Flags from "./flags.ts";
import Ops from "./ops_a.ts";
import Adapters from "./adapters.ts";
import ModRuntime from "../../shared/mods/Runtime.ts";
import Field from "../field.ts";

export class Vm {
  ctx!: ScriptCtx;
  store: any;
  scripts: LuaTable;
  text: LuaTable;
  movements: LuaTable;
  adapters: any;
  _scriptKey: any;
  _presetSpecial: Record<number, any> | null | undefined;
  [key: string]: any;

  constructor() {
    this.scripts = {};
    this.text = {};
    this.movements = {};
  }

  // Lua: vm.lua:12
  static new(opts?: any): Vm {
    opts = opts ?? {};
    const self = new Vm();
    self.ctx = Ctx.new(opts);
    self.store = opts.store ?? Flags.newStore();
    self.scripts = opts.scripts ?? {};
    self.text = opts.text ?? {};
    self.movements = opts.movements ?? {};
    self.adapters = opts.adapters ?? Adapters.stub(opts);
    for (const [k, rows] of pairs(opts.stdscripts ?? {})) {
      if (self.scripts[k] == null) {
        self.scripts[k] = rows;
      }
    }
    return self;
  }

  // Lua: vm.lua:29
  getText(key: any): any {
    let t = this.text[key];
    if (t == null && this.adapters.lookupText) {
      t = this.adapters.lookupText(key);
    }
    return t;
  }

  // Lua: vm.lua:37
  setPc(listKey: any, index?: number | null): void {
    this.ctx.pc = { listKey, index: index ?? 1 };
  }

  // Lua: vm.lua:41
  _scriptEnded(completed?: any): void {
    if (this._scriptKey == null) return;
    const key = this._scriptKey;
    this._scriptKey = null;
    if (ModRuntime.wants("script.ended")) {
      ModRuntime.emit("script.ended", { ctx: Ctx.modCtx(this), completed: truthy(completed) ? true : false, key });
    }
  }

  // Lua: vm.lua:50
  halt(aborted?: any): void {
    const a = this.adapters;
    const ctx = this.ctx;
    if (a && a.unfreezeLocal) {
      for (const [lid, snap] of pairs(ctx.lockSnapshots ?? {})) {
        a.unfreezeLocal(lid, snap);
      }
    }
    const wasLocked = ctx.lockKind != null && !truthy(aborted);
    Ctx.haltCleanup(this.ctx);
    if (wasLocked) {
      // pokeemerald/src/script.c:233
      // package.loaded["src.core.game3.field"]
      if (Field && Field.unlock) Field.unlock();
    }
    this._scriptEnded(!truthy(aborted));
  }

  // Lua: vm.lua:68
  isRunning(): boolean {
    return this.ctx.status === "running" || this.ctx.status === "waiting";
  }

  /** Stamp LAST_TALKED and VAR_FACING then start script. */
  // Lua: vm.lua:73
  startTalk(scriptKey: any, localId?: any, facing?: any): boolean {
    Flags.setVar(this.store, this.ctx, Ctx.VAR_LAST_TALKED, localId ?? 0);
    Ctx.selectObject(this.ctx, localId); // src/field_control_avatar.c:426
    if (truthy(facing)) {
      Flags.setVar(this.store, this.ctx, Ctx.VAR_FACING, facing);
    }
    return this.start(scriptKey, facing);
  }

  // Lua: vm.lua:82
  start(scriptKey: any, facing?: any): boolean {
    if (this.scripts[scriptKey] == null) {
      if (this.adapters.log) {
        this.adapters.log("[game3] missing script " + tostring(scriptKey));
      }
      return false;
    }
    if (this._scriptKey != null) this._scriptEnded(false);
    this.ctx.mode = "bytecode";
    this.ctx.status = "running";
    this.ctx.stack = seq();
    this.ctx.stringVars = seq("", "", "");
    // specialVars wiped at halt; fresh talk starts clean for RESULT etc. but
    // LAST_TALKED already stamped by startTalk, and VAR_FACING passed or read from adapters.
    const keptLast = this.ctx.specialVars[Ctx.VAR_LAST_TALKED];
    let keptFacing = truthy(facing) ? facing : this.ctx.specialVars[Ctx.VAR_FACING];
    if (!truthy(keptFacing) && this.adapters && this.adapters.getPlayerFacing) {
      const f = this.adapters.getPlayerFacing();
      if (truthy(f)) {
        const dirs: Record<string, number> = { down: 1, up: 2, left: 3, right: 4 };
        keptFacing = dirs[f] ?? tonumber(f);
      }
    }
    Ctx.wipeSpecial(this.ctx);
    if (this._presetSpecial) {
      for (const [id, v] of pairs(this._presetSpecial)) this.ctx.specialVars[id as number] = v;
      this._presetSpecial = null;
    }
    if (truthy(keptLast)) {
      this.ctx.specialVars[Ctx.VAR_LAST_TALKED] = keptLast;
    }
    if (truthy(keptFacing)) {
      this.ctx.specialVars[Ctx.VAR_FACING] = keptFacing;
    }
    this.setPc(scriptKey, 1);
    this._scriptKey = scriptKey;
    if (ModRuntime.wants("script.started")) {
      ModRuntime.emit("script.started", { ctx: Ctx.modCtx(this), key: scriptKey });
    }
    this.resume();
    return true;
  }

  // Lua: vm.lua:125
  resume(): void {
    const ctx = this.ctx;
    let guard = 0;
    while (ctx.status === "running" || ctx.status === "waiting") {
      guard = guard + 1;
      if (guard > 10000) {
        this.adapters.log("[game3] runaway script");
        this.halt(true);
        return;
      }
      if (ctx.mode === "native") {
        if (ctx.nativePoll && ctx.nativePoll()) {
          ctx.mode = "bytecode";
          ctx.status = "running";
          ctx.nativePoll = null;
        } else {
          return; // yield frame
        }
      }
      const pc = ctx.pc;
      if (!pc) {
        this.halt();
        return;
      }
      const list = this.scripts[pc.listKey];
      if (list == null) {
        this.adapters.log("[game3] bad list " + tostring(pc.listKey));
        this.halt(true);
        return;
      }
      const row = list[pc.index];
      if (row == null) {
        this.halt();
        return;
      }
      // Advance PC before op (unless op jumps).
      pc.index = pc.index + 1;
      const yld = Ops.dispatch(this, row);
      if (truthy(yld)) {
        if ((ctx.status as string) === "shutdown") return;
        if ((ctx.mode as string) === "native") return;
        // end/halt already cleaned
        if (!this.isRunning()) return;
      }
    }
  }

  // Lua: vm.lua:172
  tick(): void {
    if (this.ctx.status === "waiting" || this.ctx.status === "running") {
      this.resume();
    }
  }
}

export default Vm;
