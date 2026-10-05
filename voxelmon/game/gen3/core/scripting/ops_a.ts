// Port of gen1recomp src/core/game3/scripting/ops_a.lua (GPLv3 + additional terms; see LICENSE.md).
// Tier A (+ movement) opcode handlers. Return true = yield (wait).
//
// Port notes:
// - package.loaded[...] / require / pcall(require, ...): every module of the
//   closure is in the bundle, so each is a static import used exactly as
//   Brian guards it (a stub's functions throw NotPortedError when reached).
//   Lazily-required modules (src.ui.game3.coins_box,
//   src.core.game3.town_map_stub, src.ui.game3.prize_corner,
//   src.ui.game3.slot_machine) are looked up in G3Lazy (pcallReqMissing); a
//   missing entry takes Brian's failed-require path.
// - src.import.gba.extract_island1 (no file in the port) is only read for
//   NATIVE_ROOT / CACHE_ROOT, which extract_island1.lua:21 forwards to
//   cache_paths; this reads CachePaths directly (as core/dataset.ts does).
// - RSE / Emerald: ops_rse and rse/init have no file in the port; their
//   branches throw "NOT FAITHFUL: Emerald only".
// - Script rows come from the cache (luadata.ts): string-keyed tables are
//   plain objects carrying their integer keys (`row[1]`), so `row[i]` stays.
//   Rows this module builds itself ({ op = plain, lid, row[2] }) are made in
//   the same shape.
// - Lua multiple returns are 0-based tuples. Adapter functions that return
//   several values (giveMonToPlayer, giveMon, giveEggToPlayer, giveEgg,
//   modifyItem) are read through mr(): their tuple's slot, or the bare value
//   of an early `return nil` / `return false`.
// - Natives.special returns the tuple [yield, value, known];
//   Gift.runWonderCardScript returns [yield, jumped].

/* eslint-disable @typescript-eslint/no-explicit-any */
import { requireLua } from "../require_map.ts";
import { len, ipairs, pairs, remove, unpack, seq, toArray } from "../../platform/lt.ts";
import { truthy, tostring, tonumber, format, mod, sub } from "../../../../import/gen3/lua.ts";
import { gsub } from "../../platform/lpattern.ts";
import { random } from "../../platform/rng.ts";
import Opcodes from "./opcodes.ts";
import { Ctx } from "./ctx.ts";
import Flags from "./flags.ts";
import TextIR from "./text_ir.ts";
import Natives from "./natives.ts";
import Movement from "./movement.ts";
import ModRuntime from "../../shared/mods/Runtime.ts";
import type { Vm } from "./vm.ts";
import Runtime from "../runtime.ts";
import Bag from "../bag.ts";
import Message from "../../ui/message.ts";
import CachePaths from "../cache_paths.ts";
import Dataset from "../dataset.ts";
import NativePack from "../../../../import/gen3/native_pack.ts";
import Field from "../field.ts";
import Collision from "../collision.ts";
import FieldView from "../field_view.ts";
import Versions from "../../../../import/gen3/versions.ts";
import MapCatalog from "../../../../import/gen3/map_catalog.ts";
import MapMod from "../map.ts";
import Objects from "../objects.ts";
import MoneyBox from "../../ui/money_box.ts";
import MonPic from "../../ui/mon_pic.ts";
import Pokemon from "../pokemon.ts";
import Party from "../party.ts";
import MapPreviewScreen from "../../ui/map_preview_screen.ts";
import Space from "./space.ts";
import ItemsData from "../items_data.ts";
import Storage from "../storage.ts";
import Player from "../player.ts";
import FieldEffects from "../field_effects.ts";
import Warp from "../warp.ts";
import Task from "../task.ts";
import Audio from "../audio.ts";
import Braille from "../../ui/braille.ts";
import Encounters from "../encounters.ts";
import Trainers from "./trainers.ts";
import VsSeeker from "../vs_seeker.ts";
import Profile from "../profile.ts";
import TrainerSight from "../trainer_sight.ts";
import Prize from "../battle/prize.ts";
import Multichoice from "./multichoice.ts";
import Gift from "./natives_gift.ts";
import VirtualObjects from "../virtual_objects.ts";
import { G3Lazy } from "../lazy_registry.ts";
import HelpWindow from "../../ui/help_window.ts";
import MysteryGift from "../mystery_gift.ts";

type Row = any;
type DispatchFn = (vm: Vm, row: Row) => any;

// pcall(require, X) of a lazily-required module: its G3Lazy entry, or (no
// entry) the failed require, as in Lua (Brian's failed-require path).
function pcallReqMissing(name: string): [boolean, any] {
  const m = requireLua(name); // G3Lazy, or ported since this file was written
  if (m !== undefined) return [true, m];
  return [false, "module '" + name + "' not found (no such module in the port yet)"];
}

// A Lua multiple return read at a call site: slot i of the tuple, or (slot 0
// only) the bare value of an early `return nil` / `return false`.
function mr(r: any, i: number): any {
  if (Array.isArray(r)) return r[i];
  return i === 0 ? r : undefined;
}

// `a.playerName and (type(a.playerName) == "function" and a.playerName() or a.playerName) or ctx.playerName`
function adapter_name(v: any, fallback: any): any {
  let r: any = v;
  if (truthy(v) && typeof v === "function") {
    const got = v();
    r = truthy(got) ? got : v;
  }
  return truthy(r) ? r : fallback;
}

const EM_DASH = "\xE2\x80\x94"; // "—" (UTF-8 bytes of Brian's source)

// scrcmd.c
// Lua: ops_a.lua:15
const PRET_NO_OPS: Record<string, boolean> = {
  initclock: true,           // scrcmd.c:658-664
  dotimebasedevents: true,   // scrcmd.c:667-671
  adddecoration: true,       // scrcmd.c:526-532
  removedecoration: true,    // scrcmd.c:534-540
  checkdecor: true,          // scrcmd.c:550-556
  checkdecorspace: true,     // scrcmd.c:542-548
  drawbox: true,             // scrcmd.c:1464-1472
  drawboxtext: true,         // scrcmd.c:1505-1516
  showcontestpainting: true, // scrcmd.c:1543-1552
  setberrytree: true,        // scrcmd.c:1989-1999
  startcontest: true,        // scrcmd.c:2018-2024
  showcontestresults: true,  // scrcmd.c:2026-2032
  contestlinktransfer: true, // scrcmd.c:2034-2040
  getpokenewsactive: true,   // scrcmd.c:2002-2008
  addelevmenuitem: true,     // scrcmd.c:2178-2187
  showelevmenu: true,        // scrcmd.c:2189-2194
};

// Lua: ops_a.lua:34
function cond_ok(ctx: any, cond: any): boolean {
  const r = ctx.comparisonResult ?? 0;
  // FRLG: 0=lt, 1=eq, 2=gt from compare; checkflag sets 1 if set else 0
  if (cond === 0) return r === 0;      // LT / FALSE-ish
  if (cond === 1) return r === 1;      // EQ / TRUE
  if (cond === 2) return r === 2;      // GT
  if (cond === 3) return r !== 2;      // LE
  if (cond === 4) return r !== 0;      // GE
  if (cond === 5) return r !== 1;      // NE
  return false;
}

// Lua: ops_a.lua:46
function jump(vm: Vm, target: any): void {
  if (typeof target === "string") {
    vm.setPc(target, 1);
  } else if (target != null && typeof target === "object" && truthy(target.listKey)) {
    vm.setPc(target.listKey, target.index ?? 1);
  } else {
    // numeric ROM addr → key
    vm.setPc(Opcodes.key(target), 1);
  }
}

// Lua: ops_a.lua:57
// The IR this returns is a TextIR segment list: a 0-based JS array (Space
// converts the text bundle's entries at load, TextIR's convention).
function resolve_text(vm: Vm, ptr: any): any {
  if (ptr === 0 || ptr == null) {
    ptr = vm.ctx.data[0];
  }
  if (typeof ptr === "string") {
    return vm.getText(ptr);
  }
  const key = Opcodes.key(ptr);
  return vm.getText(key) ?? vm.getText(ptr);
}

// Lua: ops_a.lua:68
function var_get(store: any, ctx: any, idIn: any): any {
  const id = tonumber(idIn) ?? 0;
  // FRLG VarGet: ids ≥ VARS_START (0x4000) are variables; else literal.
  // pokefirered/include/constants/vars.h:310,313,337
  const hi = ((ctx && ctx.specialLayout) || Ctx.specialLayout()).hi;
  if ((id >= 0x4000 && id <= 0x40FF) || (id >= 0x8000 && id <= hi)) {
    return Flags.getVar(store, ctx, id);
  }
  return id;
}

// Script local scratch space: pret's ScriptContext.data[4] (include/script.h:21).
// Lua: ops_a.lua:80
function local_get(ctx: any, i: any): any {
  return ctx.data[tonumber(i) ?? 0] ?? 0;
}

// Lua: ops_a.lua:84
function local_set(ctx: any, i: any, v: any): void {
  ctx.data[tonumber(i) ?? 0] = v ?? 0;
}

// The port has no flat address space, so the *ptr family shares a synthetic
// byte store keyed by the pointer value.  Pointers a script writes then reads
// round-trip; pointers into engine structures read as 0 (they did before too).
// Lua: ops_a.lua:91
function mem_get(ctx: any, ptr: any): number {
  ctx.scriptMem = ctx.scriptMem ?? {};
  return tonumber(ctx.scriptMem[tonumber(ptr) ?? 0]) ?? 0;
}

// Lua: ops_a.lua:96
function mem_set(ctx: any, ptr: any, v: any): void {
  ctx.scriptMem = ctx.scriptMem ?? {};
  ctx.scriptMem[tonumber(ptr) ?? 0] = mod(tonumber(v) ?? 0, 256);
}

// pret src/scrcmd.c:358 Compare()
// Lua: ops_a.lua:102
function cmp(aIn: any, bIn: any): number {
  // pokefirered/src/scrcmd.c:368: local comparisons read the low byte.
  const a = mod(tonumber(aIn) ?? 0, 256), b = mod(tonumber(bIn) ?? 0, 256);
  if (a < b) return 0;
  if (a === b) return 1;
  return 2;
}

// Lua: ops_a.lua:110 -- [api, session]
function coins_api(): [any, any] {
  // package.loaded["src.core.game3.runtime"]
  const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
  // pcall(require, "src.core.game3.bag")
  const okBag = true;
  let api: any = (okBag && Bag != null && typeof Bag === "object") ? (Bag as any).Coins : null;
  if (api == null || typeof api !== "object") api = null;
  return [api, session];
}

// pokefirered/src/coins.c:11
// Lua: ops_a.lua:120
function coins_get(): number {
  const [api, session] = coins_api();
  if (api && typeof api.get === "function") {
    let ok = true, n: any;
    try { n = api.get(session); } catch (e) { ok = false; n = e; }
    if (ok && tonumber(n) != null) return tonumber(n)!;
  }
  const raw = Math.floor(tonumber(session && session.coins) ?? 0);
  return raw < 0 ? 0 : raw;
}

// pokefirered/src/coins.c:21
// Lua: ops_a.lua:131
function coins_move(add: boolean, amountIn: any): boolean {
  let amount = Math.floor(tonumber(amountIn) ?? 0);
  if (amount < 0) amount = 0;
  const [api, session] = coins_api();
  const fn = api ? (add ? api.add : api.remove) : undefined;
  if (typeof fn !== "function") return false;
  let ok = true, res: any;
  try { res = fn(session, amount); } catch (e) { ok = false; res = e; }
  return (ok && truthy(res)) ? true : false;
}

// pokefirered/src/quest_log.c:860
// Lua: ops_a.lua:142
function ql_avoid_display(): boolean {
  // package.loaded["src.core.game3.runtime"]
  const game = Runtime && Runtime._game;
  return (game && game.phase === "quest_log") ? true : false;
}

// pokefirered/src/coins.c:79
// Lua: ops_a.lua:149
function coins_box(fn: string, ...args: any[]): boolean {
  // pcall(require, "src.ui.game3.coins_box")
  const [okReq, Box] = pcallReqMissing("src.ui.game3.coins_box");
  if (!(okReq && Box != null && typeof Box === "object" && typeof Box[fn] === "function")) return false;
  try { Box[fn](...args); return true; } catch { return false; }
}

// Lua: ops_a.lua:155
function message_print_done(): boolean {
  // package.loaded["src.ui.game3.message"]
  if (!Message || !Message.isOpen || !Message.isOpen()) {
    return true;
  }
  if (Message.isWaiting && !Message.isWaiting()) {
    return false;
  }
  const pages = Message._pages;
  const page = Message._page ?? 1;
  if (pages != null && typeof pages === "object" && page < len(pages)) {
    return false;
  }
  return true;
}

// Lua: ops_a.lua:171
function show_message(vm: Vm, ptr: any, _stay?: any): boolean {
  const ir = resolve_text(vm, ptr);
  const a = vm.adapters;
  const ctx = vm.ctx;
  // Pret ShowFieldMessage: open box + start printer; do not wait for dismiss.
  // waitmessage waits for print-complete; waitbuttonpress / yesnobox follow.
  let body: string;
  if (!truthy(ir)) {
    body = "(missing text)";
  } else {
    const ctxView = {
      stringVars: ctx.stringVars,
      playerName: adapter_name(a.playerName, ctx.playerName),
      rivalName: adapter_name(a.rivalName, ctx.rivalName),
    };
    body = TextIR.toTextBox(ir, ctxView);
  }
  ctx.messageOpen = true;
  ctx.printerDone = false;
  const openStay = a.openMessageStay ?? a.openMessageAsync;
  if (truthy(openStay)) {
    // Always stay: box remains until closemessage / release (pret field box).
    openStay(body, null);
  } else if (a.openMessage) {
    a.openMessage(body);
  }
  return false;
}

// Lua: ops_a.lua:204
function text_ctx_view(vm: Vm): any {
  const ctx = vm.ctx;
  const a = vm.adapters;
  return {
    stringVars: ctx.stringVars,
    playerName: adapter_name(a.playerName, ctx.playerName),
    rivalName: adapter_name(a.rivalName, ctx.rivalName),
  };
}

// pokefirered/src/braille_text.c:209
// Lua: ops_a.lua:219
const BRAILLE_GLYPH_WIDTH = 16;

// pokefirered/src/text.c:1020
// Lua: ops_a.lua:222
function braille_width(ir: any): number {
  if (ir == null || typeof ir !== "object") return 0;
  let best = 0, line = 0;
  // `for _, seg in ipairs(ir)`: IR segment lists are 0-based JS arrays (TextIR)
  for (const seg of ir as any[]) {
    if (seg == null) break;
    if (seg.t === "text") {
      const glyphs = gsub(tostring(seg.s ?? ""), "[^\x80-\xBF]", "")[1];
      line = line + glyphs * BRAILLE_GLYPH_WIDTH;
    } else if (seg.t === "nl") {
      if (line > best) best = line;
      line = 0;
    }
  }
  if (line > best) best = line;
  return best;
}

// pokefirered/src/overworld.c:978
// Lua: ops_a.lua:239 -- [true, swapped] or [false]
function set_map_layout(layoutIdIn: any, log?: any): [boolean, number?] {
  const layoutId = tonumber(layoutIdIn);
  if (layoutId == null) return [false];
  // package.loaded["src.core.game3.runtime"]
  const game = Runtime && Runtime._game;
  const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
  const mapId = session && session.map;
  const def = mapId && game && game.data && game.data.maps && game.data.maps[mapId];
  const layout = def && def.midLayout;
  if (!truthy(layout)) return [false];
  // require("src.import.gba.extract_island1"): Extract.NATIVE_ROOT /
  // CACHE_ROOT forward to cache_paths (extract_island1.lua:21)
  const root = CachePaths.NATIVE_ROOT
    ?? ((CachePaths.CACHE_ROOT ?? "data/generated/gba") + "/native");
  const blob = Dataset.cache().read(root + "/layouts/alt_" + tostring(layoutId) + ".mid");
  if (blob == null) {
    if (log) log("[game3] setmaplayoutindex " + tostring(layoutId) + ": no baked layout");
    return [false];
  }
  const decoded = NativePack.decodeMidLayout(blob)[0];
  if (!decoded || decoded.width !== layout.width || decoded.height !== layout.height) {
    if (log) log("[game3] setmaplayoutindex " + tostring(layoutId) + ": size mismatch");
    return [false];
  }
  let swapped = 0;
  for (let i = 1; i <= decoded.width * decoded.height; i++) {
    // seam: NativePack's cells are a 0-based JS array (Lua decoded.cells[i])
    const cell = decoded.cells[i - 1];
    if (cell) {
      const x = mod(i - 1, decoded.width);
      const y = Math.floor((i - 1) / decoded.width);
      const cur = layout.cellAt(x, y);
      if (cur.mid !== cell.mid || cur.coll !== cell.coll || cur.elev !== cell.elev) {
        layout.applyOverride(x, y, cell.mid, cell.coll, cell.elev);
        swapped = swapped + 1;
      }
    }
  }
  // package.loaded["src.core.game3.field"]
  if (Field && Field._overrideLayouts) Field._overrideLayouts[mapId] = layout;
  // package.loaded["src.core.game3.collision"]
  if (Collision && Collision.bindMap) Collision.bindMap(game, mapId, def);
  // package.loaded["src.core.game3.field_view"]
  if (FieldView) FieldView._nativeDirty = true;
  return [true, swapped];
}

// pokefirered/include/constants/maps.h:11
// Lua: ops_a.lua:287
function warp_hole_dest(groupIn: any, numIn: any): any {
  const group = tonumber(groupIn) ?? 0, num = tonumber(numIn) ?? 0;
  if (group === 0xFF && num === 0xFF) return null;
  // require("src.import.gba.versions")
  if (!truthy(Versions.frMapFor)) {
    return MapCatalog.mapIdFor(group, num);
  }
  const fr = truthy(Versions.frMapFor) ? Versions.frMapFor(group, num) : undefined;
  if (truthy(fr)) return fr;
  return truthy(Versions.seviiMapFor) ? Versions.seviiMapFor(group, num) : Versions.seviiMapFor;
}

// pret's *at script commands carry an explicit (mapGroup, mapNum) so a script
// can address another map's objects (asm/macros/event.inc:597-652).  The host
// object/movement seams only address the current map, so resolve the target
// map first and skip (with a note) when it is somewhere else.
// Lua: ops_a.lua:302
function objectat_same_map(store: any, ctx: any, row: Row, groupIdx: number): boolean {
  const group = var_get(store, ctx, row[groupIdx]);
  const num = tonumber(var_get(store, ctx, row[groupIdx + 1]));
  // package.loaded["src.core.game3.map"]
  const current = MapMod && MapMod.current;
  if (group == null || num == null || !truthy(current)) return true;
  // pcall(require, "src.import.gba.map_catalog")
  const okC = true;
  let dest: any = (okC && MapCatalog) ? MapCatalog.mapIdFor(group, num) : null;
  if (typeof dest !== "string") {
    // pcall(require, "src.import.gba.versions")
    const okV = true;
    dest = (okV && Versions && truthy(Versions.mapIdFor))
      ? Versions.mapIdFor(group, num) : null;
  }
  if (typeof dest !== "string") return true;
  return dest === current;
}

// pokeemerald/src/event_object_movement.c:1234 GetObjectEventIdByLocalIdAndMap
// Lua: ops_a.lua:320
function objectat_foreign(store: any, ctx: any, row: Row, groupIdx: number): any {
  // package.loaded["src.core.game3.objects"]
  if (!(Objects && truthy(Objects.foreignKey))) return null;
  const group = var_get(store, ctx, row[groupIdx]);
  const num = tonumber(var_get(store, ctx, row[groupIdx + 1]));
  // pcall(require, "src.import.gba.map_catalog")
  const okC = true;
  const dest: any = (okC && MapCatalog && group != null && num != null) ? MapCatalog.mapIdFor(group, num) : null;
  if (typeof dest !== "string") return null;
  return Objects.foreignKey(dest, var_get(store, ctx, row.localId ?? row[1]));
}

// Lua: ops_a.lua:331 (reassigned to the RSE-aware wrapper at :2261; the
// recursive calls below go through the wrapper, as the Lua local does)
let dispatch: DispatchFn = function (vm: Vm, row: Row): any {
  const op = row.op;
  const ctx = vm.ctx;
  const store = vm.store;
  const a = vm.adapters;

  if (op === "nop" || op === "nop1") {
    return false;
  } else if (op === "end") {
    vm.halt();
    return true;
  } else if (op === "return") {
    const frame = remove(ctx.stack);
    if (!frame) {
      vm.halt();
      return true;
    }
    vm.setPc(frame.listKey, frame.index);
    return false;
  } else if (op === "call") {
    if (len(ctx.stack) >= 20) {
      a.log("[game3] call stack overflow");
      return false;
    }
    // VM advances PC before dispatch; cur.index is already the return site.
    const cur = ctx.pc!;
    ctx.stack[len(ctx.stack) + 1] = {
      listKey: cur.listKey,
      index: cur.index,
    };
    jump(vm, row.target ?? row[1]);
    return false;
  } else if (op === "goto") {
    jump(vm, row.target ?? row[1]);
    return false;
  } else if (op === "goto_if") {
    if (cond_ok(ctx, row.cond ?? row[1])) {
      jump(vm, row.target ?? row[2]);
    }
    return false;
  } else if (op === "call_if") {
    if (cond_ok(ctx, row.cond ?? row[1])) {
      if (len(ctx.stack) >= 20) {
        a.log("[game3] call stack overflow");
        return false;
      }
      const cur = ctx.pc!;
      ctx.stack[len(ctx.stack) + 1] = {
        listKey: cur.listKey,
        index: cur.index,
      };
      jump(vm, row.target ?? row[2]);
    }
    return false;
  } else if (op === "callstd") {
    const std = row.std ?? row[1];
    const key = "std:" + tostring(std);
    if (vm.scripts[key] == null) {
      a.log("[game3] missing " + key + " " + EM_DASH + " skipping");
      return false;
    }
    if (len(ctx.stack) >= 20) return false;
    const cur = ctx.pc!;
    ctx.stack[len(ctx.stack) + 1] = {
      listKey: cur.listKey,
      index: cur.index,
    };
    vm.setPc(key, 1);
    return false;
  } else if (op === "gotostd") {
    const key = "std:" + tostring(row.std ?? row[1]);
    if (vm.scripts[key] == null) {
      a.log("[game3] missing " + key + " " + EM_DASH + " skipping");
      return false;
    }
    vm.setPc(key, 1);
    return false;
  } else if (op === "callstd_if" || op === "gotostd_if") {
    // pret asm/macros/event.inc: .byte op / .byte condition / .byte std.
    // callstd_if returns to the caller; gotostd_if does not.
    if (!cond_ok(ctx, row.cond ?? row[1])) return false;
    const key = "std:" + tostring(row.std ?? row[2]);
    if (vm.scripts[key] == null) {
      a.log("[game3] missing " + key + " " + EM_DASH + " skipping");
      return false;
    }
    if (op === "callstd_if") {
      if (len(ctx.stack) >= 20) return false;
      const cur = ctx.pc!;
      ctx.stack[len(ctx.stack) + 1] = {
        listKey: cur.listKey,
        index: cur.index,
      };
    }
    vm.setPc(key, 1);
    return false;
  } else if (op === "loadword") {
    const dest = row.dest ?? row[1] ?? 0;
    const value = row.value ?? row[2];
    ctx.data[dest] = value;
    return false;
  } else if (op === "loadbyte") {
    ctx.data[row[1] ?? 0] = row[2] ?? 0;
    return false;
  } else if (op === "setvar") {
    Flags.setVar(store, ctx, row.var ?? row[1], row.value ?? row[2]);
    return false;
  } else if (op === "addvar") {
    // pokefirered/src/scrcmd.c:441
    const id = row.var ?? row[1];
    Flags.setVar(store, ctx, id, Flags.getVar(store, ctx, id) + (tonumber(row.value ?? row[2]) ?? 0));
    return false;
  } else if (op === "subvar") {
    // pokefirered/src/scrcmd.c:448
    const id = row.var ?? row[1];
    Flags.setVar(store, ctx, id, Flags.getVar(store, ctx, id) - var_get(store, ctx, row.value ?? row[2]));
    return false;
  } else if (op === "copyvar") {
    const v = Flags.getVar(store, ctx, row[2]);
    Flags.setVar(store, ctx, row[1], v);
    return false;
  } else if (op === "setorcopyvar") {
    // if src is var id in special/normal range treat as copy; else set literal — cart uses bit.
    const src = row[2] ?? 0;
    if (src >= 0x4000) {
      Flags.setVar(store, ctx, row[1], Flags.getVar(store, ctx, src));
    } else {
      Flags.setVar(store, ctx, row[1], src);
    }
    return false;
  } else if (op === "compare_var_to_value") {
    const v = Flags.getVar(store, ctx, row.var ?? row[1]);
    const n = row.value ?? row[2] ?? 0;
    if (v < n) ctx.comparisonResult = 0;
    else if (v === n) ctx.comparisonResult = 1;
    else ctx.comparisonResult = 2;
    return false;
  } else if (op === "compare_var_to_var") {
    const a1 = Flags.getVar(store, ctx, row[1]);
    const b1 = Flags.getVar(store, ctx, row[2]);
    if (a1 < b1) ctx.comparisonResult = 0;
    else if (a1 === b1) ctx.comparisonResult = 1;
    else ctx.comparisonResult = 2;
    return false;
  } else if (op === "setflag") {
    const flag = row.flag ?? row[1];
    Flags.setFlag(store, ctx, flag, true);
    if (a.onFlagChanged) a.onFlagChanged(flag, true);
    return false;
  } else if (op === "clearflag") {
    const flag = row.flag ?? row[1];
    Flags.setFlag(store, ctx, flag, false);
    // pret: clearing an object hide flag makes the template eligible; scripts
    // often removeobject then clearflag without addobject (Oak lab intro).
    if (a.onFlagChanged) a.onFlagChanged(flag, false);
    return false;
  } else if (op === "checkflag") {
    ctx.comparisonResult = truthy(Flags.getFlag(store, ctx, row.flag ?? row[1])) ? 1 : 0;
    return false;
  } else if (op === "goto_if_set") {
    // not a real op; handled via checkflag+goto_if in extract
    return false;
  } else if (op === "faceplayer") {
    const lid = Flags.getVar(store, ctx, Ctx.VAR_LAST_TALKED);
    if (a.facePlayer) a.facePlayer(lid);
    return false;
  } else if (op === "lock") {
    const lid = Flags.getVar(store, ctx, Ctx.VAR_LAST_TALKED);
    ctx.lockKind = "single";
    ctx.lockSnapshots = {};
    const snap = { facing: a.facing ? a.facing[lid] : a.facing, movementType: "idle" };
    ctx.lockSnapshots[lid] = snap;
    if (a.freezeLocal) a.freezeLocal(lid, snap);
    ctx.frozen = true;
    // pcall(require, "src.core.game3.field")
    if (Field && Field.lock) Field.lock();
    return false;
  } else if (op === "lockall") {
    ctx.lockKind = "all";
    ctx.lockSnapshots = {};
    const ids = (a.listActiveLocalIds ? a.listActiveLocalIds() : undefined) ?? seq();
    for (const [, lid] of ipairs<any>(ids)) {
      const snap = { facing: a.facing ? a.facing[lid] : a.facing, movementType: "idle" };
      ctx.lockSnapshots[lid] = snap;
      if (a.freezeLocal) a.freezeLocal(lid, snap);
    }
    ctx.frozen = true;
    // pcall(require, "src.core.game3.field")
    if (Field && Field.lock) Field.lock();
    return false;
  } else if (op === "release") {
    if (truthy(ctx.lockKind) && ctx.lockKind !== "single") {
      a.log("[game3] release after lockall " + EM_DASH + " restoring lockSnapshots only");
    }
    for (const [lid, snap] of pairs(ctx.lockSnapshots)) {
      if (a.unfreezeLocal) a.unfreezeLocal(lid, snap);
    }
    ctx.lockSnapshots = {};
    ctx.lockKind = null;
    if (ctx.messageOpen) {
      if (a.closeMessage) a.closeMessage();
      ctx.messageOpen = false;
    }
    // pcall(require, "src.ui.game3.money_box")
    if (MoneyBox && MoneyBox.hide) MoneyBox.hide();
    ctx.frozen = false;
    // pcall(require, "src.core.game3.field")
    if (Field && Field.unlock) Field.unlock();
    return false;
  } else if (op === "releaseall") {
    if (truthy(ctx.lockKind) && ctx.lockKind !== "all") {
      a.log("[game3] releaseall after lock " + EM_DASH + " clearing all snapshots");
    }
    for (const [lid, snap] of pairs(ctx.lockSnapshots)) {
      if (a.unfreezeLocal) a.unfreezeLocal(lid, snap);
    }
    ctx.lockSnapshots = {};
    ctx.lockKind = null;
    if (ctx.messageOpen) {
      if (a.closeMessage) a.closeMessage();
      ctx.messageOpen = false;
    }
    // pcall(require, "src.ui.game3.money_box")
    if (MoneyBox && MoneyBox.hide) MoneyBox.hide();
    ctx.frozen = false;
    // pcall(require, "src.core.game3.field")
    if (Field && Field.unlock) Field.unlock();
    return false;
  } else if (op === "message") {
    return show_message(vm, row.ptr ?? row[1], row.stay);
  } else if (op === "yesnobox") {
    // Host YES/NO over stayed textbox; writes VAR_RESULT (1=yes, 0=no).
    let answered = false;
    const left = tonumber(row[1] ?? row.x) ?? 20;
    const top = tonumber(row[2] ?? row.y) ?? 8;
    ctx.mode = "native";
    ctx.status = "waiting";
    ctx.nativePoll = () => answered;
    const ask = a.askYesNo;
    if (ask) {
      ask((yes: any) => {
        Flags.setVar(store, ctx, Ctx.VAR_RESULT, truthy(yes) ? 1 : 0);
        answered = true;
      }, { left, top });
    } else {
      Flags.setVar(store, ctx, Ctx.VAR_RESULT, 1);
      answered = true;
    }
    if (answered) {
      ctx.mode = "bytecode";
      ctx.status = "running";
      ctx.nativePoll = null;
      return false;
    }
    return true;
  } else if (op === "waitmessage") {
    // Pret: wait until text printer finished (box stays visible).
    if (message_print_done()) {
      ctx.printerDone = true;
      return false;
    }
    ctx.mode = "native";
    ctx.status = "waiting";
    ctx.nativePoll = () => {
      if (message_print_done()) {
        ctx.printerDone = true;
        return true;
      }
      return false;
    };
    return true;
  } else if (op === "waitbuttonpress") {
    // Pret: A/B while message box still up (after waitmessage).
    let pressed = false;
    ctx.mode = "native";
    ctx.status = "waiting";
    ctx.nativePoll = () => pressed;
    if (a.armWaitButton) {
      // pokefirered/src/scrcmd.c:1401, pokefirered/src/script.c:95
      let armed = false;
      ctx.nativePoll = () => {
        if (!armed) {
          armed = true;
          a.armWaitButton(() => {
            pressed = true;
          });
        }
        return pressed;
      };
      return true;
    } else if (a.waitButton) {
      a.waitButton(() => {
        pressed = true;
      });
    } else {
      pressed = true;
    }
    if (pressed) {
      ctx.mode = "bytecode";
      ctx.status = "running";
      ctx.nativePoll = null;
      return false;
    }
    return true;
  } else if (op === "closemessage") {
    if (a.closeMessage) a.closeMessage();
    ctx.messageOpen = false;
    return false;
  } else if (op === "showmonpic") {
    const species = var_get(store, ctx, row[1] ?? row.species);
    const x = tonumber(row[2] ?? row.x) ?? 10;
    const y = tonumber(row[3] ?? row.y) ?? 3;
    if (a.showMonPic) {
      a.showMonPic(species, x, y);
    } else {
      MonPic.show(species, x, y);
    }
    return false;
  } else if (op === "hidemonpic") {
    if (a.hideMonPic) {
      a.hideMonPic();
    } else {
      MonPic.hide();
    }
    return false;
  } else if (op === "givemon") {
    let species = var_get(store, ctx, row[1] ?? row.species);
    let level = var_get(store, ctx, row[2] ?? row.level);
    if (level < 1) level = 5;
    let nickname: any;
    if (ModRuntime.wants("pokemon.before_give")) {
      const gift: any = {
        ctx: Ctx.modCtx(vm),
        species: Pokemon.keyName(species) ?? species,
        speciesId: species,
        level,
      };
      ModRuntime.emit("pokemon.before_give", gift);
      const id = typeof gift.species === "number" ? gift.species
        : Pokemon.speciesFromName(gift.species);
      if (tonumber(id) != null && tonumber(id)! >= 1 && tonumber(id) !== species) {
        species = tonumber(id);
        const src = tonumber(row[1] ?? row.species) ?? 0;
        if (src >= 0x4000) Flags.setVar(store, ctx, src, species);
      }
      if (tonumber(gift.level) != null) {
        level = Math.max(1, Math.min(100, Math.floor(tonumber(gift.level)!)));
      }
      if (typeof gift.nickname === "string" && gift.nickname !== "") {
        nickname = gift.nickname;
      }
    }
    // pokefirered/src/script_pokemon_util.c:48
    let code: number | undefined;
    if (a.giveMonToPlayer) {
      code = tonumber(mr(a.giveMonToPlayer(species, level, row[3], nickname), 0));
    } else if (a.giveMon) {
      const r = a.giveMon(species, level, row[3], row[4], row[5], nickname);
      const ok = mr(r, 0), c = mr(r, 1);
      code = tonumber(c) ?? (truthy(ok) ? 0 : 2);
    } else {
      // package.loaded["src.core.game3.runtime"]
      const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
      if (session) {
        code = tonumber(Party.giveMonToPlayer(session, species, level, nickname)[0]);
      }
    }
    Flags.setVar(store, ctx, Ctx.VAR_RESULT, code ?? 2);
    return false;
  } else if (op === "giveegg") {
    const species = var_get(store, ctx, row[1] ?? row.species);
    // pokefirered/src/script_pokemon_util.c:75
    let code: number | undefined;
    if (a.giveEggToPlayer) {
      code = tonumber(mr(a.giveEggToPlayer(species), 0));
    } else if (a.giveEgg) {
      const r = a.giveEgg(species);
      const ok = mr(r, 0), c = mr(r, 1);
      code = tonumber(c) ?? (truthy(ok) ? 0 : 2);
    } else {
      // package.loaded["src.core.game3.runtime"]
      const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
      if (session) {
        code = tonumber(Party.giveEggToPlayer(session, species)[0]);
      }
    }
    Flags.setVar(store, ctx, Ctx.VAR_RESULT, code ?? 2);
    return false;
  } else if (op === "textcolor") {
    Flags.setVar(store, ctx, Ctx.VAR_PREV_TEXT_COLOR, Flags.getVar(store, ctx, Ctx.VAR_TEXT_COLOR)); // src/scrcmd.c:1257
    Flags.setVar(store, ctx, Ctx.VAR_TEXT_COLOR, row.color ?? row[1] ?? 0);
    return false;
  } else if (op === "signmsg" || op === "normalmsg") {
    // package.loaded / pcall(require, "src.ui.game3.message")
    if (Message && Message.setFrame) {
      Message.setFrame(op === "signmsg" ? "sign" : "dialogue");
    }
    return false;
  } else if (op === "setworldmapflag") {
    const flag = row.flag ?? row[1];
    // MapPreview_SetFlag: capture the pre-visit state for the forest preview
    // duration, then set the flag (map_preview_screen.c:605).
    {
      // pcall(require, "src.ui.game3.map_preview_screen")
      const ok = true;
      if (ok && MapPreviewScreen && MapPreviewScreen.setVisitedFlag) {
        MapPreviewScreen.setVisitedFlag(flag, Flags.getFlag(store, ctx, flag) === true);
      }
    }
    Flags.setFlag(store, ctx, flag, true);
    // Host Sevii Town Map unlock (One Island region map page).
    if (tonumber(flag) === Flags.IDS.WORLD_MAP_ONE_ISLAND
        || tonumber(flag) === Flags.IDS.SYS_SEVII_MAP_123) {
      // pcall(require, "src.core.game3.town_map_stub")
      const [ok, TownMap] = pcallReqMissing("src.core.game3.town_map_stub");
      if (ok && TownMap.unlockSeviiMap) {
        // package.loaded["src.core.game3.scripting.space"]
        TownMap.unlockSeviiMap((vm && vm._mod) || (Space && Space._mod));
      }
    }
    return false;
  } else if (op === "callnative") {
    if (truthy(Natives.callnative(ctx, row.fn ?? row[1], a))) {
      return true;
    }
    return false;
  } else if (op === "special") {
    if (truthy(mr(Natives.special(ctx, row.id ?? row[1], a), 0))) {
      return true;
    }
    return false;
  } else if (op === "specialvar") {
    // pokefirered/src/scrcmd.c:109
    const r = Natives.special(ctx, row[2], a);
    const yld = mr(r, 0), known = mr(r, 2);
    let value = mr(r, 1);
    if (value == null && !truthy(known)) value = 0;
    if (value != null) {
      Flags.setVar(store, ctx, row[1], value);
    }
    if (truthy(yld)) {
      return true;
    }
    return false;
  } else if (op === "waitstate") {
    // pokefirered/src/scrcmd.c:127
    const task = ctx.stateWait;
    ctx.stateWait = null;
    const inner = (ctx.mode === "native") ? ctx.nativePoll : null;
    if (truthy(task) || truthy(ctx.warpPending) || truthy(inner)) {
      ctx.mode = "native";
      ctx.status = "waiting";
      ctx.nativePoll = () => {
        if (truthy(ctx.warpPending)) {
          if (a.pollWarp) a.pollWarp();
          if (truthy(ctx.warpPending)) return false;
        }
        if (truthy(task) && !truthy(task())) return false;
        if (truthy(inner) && !truthy(inner!())) return false;
        return true;
      };
      if (ctx.nativePoll()) {
        ctx.mode = "bytecode";
        ctx.status = "running";
        ctx.nativePoll = null;
        return false;
      }
      return true;
    }
    return false;
  } else if (op === "applymovement") {
    const lid = var_get(store, ctx, row.localId ?? row[1]);
    const mv = row.movement ?? row[2];
    let bytes = mv;
    if (typeof mv === "string" || (typeof mv === "number" && truthy(a.lookupMovement))) {
      const looked = a.lookupMovement ? a.lookupMovement(mv) : undefined;
      bytes = truthy(looked) ? looked : mv;
    }
    // seam: lookupMovement / cache streams are 1-based lt sequences;
    // movement.ts takes 0-based byte streams (a string key or a missing
    // stream passes through unchanged, as Movement.start handles those).
    if (bytes != null && typeof bytes === "object") bytes = toArray(bytes);
    Movement.start(ctx, lid, bytes, a);
    return false; // async; do not wait
  } else if (op === "waitmovement") {
    const lid = var_get(store, ctx, row.localId ?? row[1] ?? 0);
    ctx.mode = "native";
    ctx.status = "waiting";
    ctx.nativePoll = Movement.makePoll(ctx, lid, a);
    if (ctx.nativePoll()) {
      ctx.mode = "bytecode";
      ctx.status = "running";
      ctx.nativePoll = null;
      return false;
    }
    return true;
  } else if (op === "removeobject") {
    const lid = var_get(store, ctx, row.localId ?? row[1]);
    if (a.removeObject) a.removeObject(lid);
    return false;
  } else if (op === "comparestat") {
    // pret ScrCmd_comparestat: .byte statIdx / .4byte value; sets
    // ctx.comparisonResult to 0 (lt) / 1 (eq) / 2 (gt) from the game stat.
    const statIdx = tonumber(row[1]) ?? 0;
    const value = tonumber(row[2]) ?? 0;
    // package.loaded["src.core.game3.runtime"]
    const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
    const stats = (session && session.gameStats) || {};
    const statValue = tonumber(stats[statIdx]) ?? 0;
    ctx.comparisonResult = statValue < value ? 0
      : (statValue === value ? 1 : 2);
    return false;
  } else if (op === "bufferitemnameplural") {
    // pret ScrCmd_bufferitemnameplural: the item's name pluralised the way the
    // ROM does -- "S" for a Poké Ball stack, "IES" replacing the final letter
    // for berries, and the plain name otherwise.
    const dest = (row.dest ?? row[1] ?? 0) + 1;
    const item = var_get(store, ctx, row[2]);
    const qty = tonumber(var_get(store, ctx, row[3])) ?? 1;
    let name: string = (ItemsData.displayName ? ItemsData.displayName(item) : null)
      ?? tostring(item);
    if (qty >= 2) {
      if (tonumber(item) === 4) { // ITEM_POKE_BALL (include/constants/items.h:8)
        name = name + "S";
      } else if (ItemsData.isBerry && truthy(ItemsData.isBerry(item))) {
        name = sub(name, 1, -2) + "IES";
      }
    }
    ctx.stringVars[dest] = name;
    return false;
  } else if (op === "setmonmove" || op === "setmonmetlocation"
      || op === "setmonmodernfatefulencounter"
      || op === "checkmonmodernfatefulencounter") {
    // pret ScrCmd_* (src/scrcmd.c:1767, :2239, :2248, :2256).  Party indices,
    // move slots and map-section ids are 0-based in the ROM.
    // package.loaded["src.core.game3.runtime"]
    const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
    const idx = (tonumber(var_get(store, ctx, row[1])) ?? 0) + 1;
    const mon = session && session.party && session.party[idx];
    if (op === "setmonmove") {
      const slot = (tonumber(var_get(store, ctx, row[2])) ?? 0) + 1;
      const move = tonumber(var_get(store, ctx, row[3])) ?? 0;
      if (mon && Pokemon.replaceMove) Pokemon.replaceMove(mon, slot, move);
    } else if (op === "setmonmetlocation") {
      if (mon) mon.metLocation = tonumber(row[2]) ?? 0;
    } else if (op === "setmonmodernfatefulencounter") {
      if (mon) mon.modernFatefulEncounter = true;
    } else {
      Flags.setVar(store, ctx, Ctx.VAR_RESULT,
        (mon && truthy(mon.modernFatefulEncounter)) ? 1 : 0);
    }
    return false;
  } else if (op === "copylocal") {
    // pret ScrCmd_copylocal (src/scrcmd.c:321)
    local_set(ctx, row[1], local_get(ctx, row[2]));
    return false;
  } else if (op === "setptr") {
    // pret ScrCmd_setptr (src/scrcmd.c:300): value byte, then pointer word.
    mem_set(ctx, row[2], row[1]);
    return false;
  } else if (op === "loadbytefromptr") {
    // pret ScrCmd_loadbytefromptr (src/scrcmd.c:293)
    local_set(ctx, row[1], mem_get(ctx, row[2]));
    return false;
  } else if (op === "setptrbyte") {
    // pret ScrCmd_setptrbyte (src/scrcmd.c:314)
    mem_set(ctx, row[2], local_get(ctx, row[1]));
    return false;
  } else if (op === "copybyte") {
    // pret ScrCmd_copybyte (src/scrcmd.c:329)
    mem_set(ctx, row[1], mem_get(ctx, row[2]));
    return false;
  } else if (op === "compare_local_to_local") {
    // pret ScrCmd_compare_local_to_local (src/scrcmd.c:368)
    ctx.comparisonResult = cmp(local_get(ctx, row[1]), local_get(ctx, row[2]));
    return false;
  } else if (op === "compare_local_to_value") {
    ctx.comparisonResult = cmp(local_get(ctx, row[1]), row[2]);
    return false;
  } else if (op === "compare_local_to_ptr") {
    ctx.comparisonResult = cmp(local_get(ctx, row[1]), mem_get(ctx, row[2]));
    return false;
  } else if (op === "compare_ptr_to_local") {
    ctx.comparisonResult = cmp(mem_get(ctx, row[1]), local_get(ctx, row[2]));
    return false;
  } else if (op === "compare_ptr_to_value") {
    ctx.comparisonResult = cmp(mem_get(ctx, row[1]), row[2]);
    return false;
  } else if (op === "compare_ptr_to_ptr") {
    ctx.comparisonResult = cmp(mem_get(ctx, row[1]), mem_get(ctx, row[2]));
    return false;
  } else if (op === "vgoto" || op === "vcall" || op === "vgoto_if" || op === "vcall_if") {
    // pret ScrCmd_vgoto/vcall/vgoto_if/vcall_if (src/scrcmd.c:180-209).  The
    // ROM's sAddressOffset relocation is unnecessary here: script pointers are
    // engine keys, which Opcodes.key()/jump() already resolve.
    let cond = true;
    let dest = row.target ?? row[1];
    if (op === "vgoto_if" || op === "vcall_if") {
      cond = cond_ok(ctx, row.cond ?? row[1]);
      dest = row.target ?? row[2];
    }
    if (cond) {
      if (op === "vcall" || op === "vcall_if") {
        if (len(ctx.stack) >= 20) {
          a.log("[game3] vcall stack overflow");
          return false;
        }
        const cur = ctx.pc!;
        ctx.stack[len(ctx.stack) + 1] = { listKey: cur.listKey, index: cur.index };
      }
      jump(vm, dest);
    }
    return false;
  } else if (op === "setvaddress") {
    // pret ScrCmd_setvaddress (src/scrcmd.c:171) records a ROM-address
    // relocation for the v* family; the port resolves pointers by key, so
    // there is nothing to relocate.  Kept for bookkeeping only.
    ctx.vaddress = row[1];
    return false;
  } else if (op === "vmessage") {
    // pret ScrCmd_vmessage (src/scrcmd.c:1580) shows a field message.
    return show_message(vm, row[1], false);
  } else if (op === "vbuffermessage") {
    // pret ScrCmd_vbuffermessage (src/scrcmd.c:1706) expands placeholders into
    // the field message buffer (gStringVar4 → ctx.stringVars[4]).
    const ir = resolve_text(vm, row[1]);
    ctx.stringVars[4] = truthy(ir) ? TextIR.toPlain(ir, {
      stringVars: ctx.stringVars,
      playerName: a.playerName,
      rivalName: a.rivalName,
    }) : "";
    return false;
  } else if (op === "vbufferstring") {
    // pret ScrCmd_vbufferstring (src/scrcmd.c:1714)
    const dest = (row.dest ?? row[1] ?? 0) + 1;
    const ir = resolve_text(vm, row.ptr ?? row[2]);
    ctx.stringVars[dest] = truthy(ir) ? TextIR.toPlain(ir, { stringVars: ctx.stringVars }) : "";
    return false;
  } else if (op === "endram") {
    // pret ScrCmd_endram (src/scrcmd.c:262) clears the RAM script and stops.
    vm.halt();
    return true;
  } else if (op === "returnram") {
    // pret ScrCmd_returnram (src/scrcmd.c:256) resumes the RAM script's caller.
    const frame = remove(ctx.stack);
    if (!frame) {
      vm.halt();
      return true;
    }
    vm.setPc(frame.listKey, frame.index);
    return false;
  } else if (op === "checkpcitem" || op === "addpcitem") {
    // pret ScrCmd_checkpcitem / ScrCmd_addpcitem: the Player PC item bag.
    // VAR_RESULT is 1 for success (check: enough stored; add: stored), else 0.
    const item = tostring(var_get(store, ctx, row[1]));
    const qty = Math.max(1, tonumber(var_get(store, ctx, row[2])) ?? 1);
    // package.loaded["src.core.game3.runtime"]
    const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
    const storage: any = session ? Storage.ensure(session) : null;
    let ok = false;
    if (storage) {
      storage.items = storage.items ?? seq();
      let slot: any;
      for (const [, entry] of ipairs<any>(storage.items)) {
        if (tostring(entry.id) === item) { slot = entry; break; }
      }
      if (op === "checkpcitem") {
        const have = slot ? (tonumber(slot.qty) ?? 0) : 0;
        ok = have >= qty;
      } else if (slot) {
        const room = Storage.MAX_ITEM_QTY - (tonumber(slot.qty) ?? 0);
        if (room >= qty) {
          slot.qty = (tonumber(slot.qty) ?? 0) + qty;
          ok = true;
        }
      } else if (len(storage.items) < Storage.pcItemsCount(session)) {
        storage.items[len(storage.items) + 1] = { id: item, qty: Math.min(qty, Storage.MAX_ITEM_QTY) };
        ok = true;
      }
    }
    if (op === "addpcitem" && !ok) {
      a.log("[game3] addpcitem had no PC room for " + item);
    }
    Flags.setVar(store, ctx, Ctx.VAR_RESULT, ok ? 1 : 0);
    return false;
  } else if (op === "bufferspeciesname" || op === "bufferitemname"
      || op === "buffermovename" || op === "bufferdecorationname"
      || op === "bufferstdstring" || op === "bufferpartymonnick") {
    const dest = (row.dest ?? row[1] ?? 0) + 1; // buffer index 0→STR_VAR_1
    let src = row.src ?? row[2] ?? 0;
    if (typeof src === "number" && src >= 0x4000) {
      src = Flags.getVar(store, ctx, src);
    }
    let name = tostring(src);
    if (a.bufferName) {
      const got = a.bufferName(op, src);
      name = truthy(got) ? got : name;
    }
    if (op === "buffermovename" && name === tostring(src)) {
      // pokefirered/src/scrcmd.c:1669
      // pcall(require, "src.core.game3.pokemon")
      const okP = true;
      if (okP && Pokemon && Pokemon.moveName) {
        let okN = true, moveName: any;
        try { moveName = Pokemon.moveName(tonumber(src) ?? src); } catch (e) { okN = false; moveName = e; }
        if (okN && typeof moveName === "string" && moveName.length > 0) name = moveName;
      }
    }
    ctx.stringVars[dest] = name;
    return false;
  } else if (op === "bufferleadmonspeciesname") {
    const dest = (row.dest ?? row[1] ?? 0) + 1;
    const lead = a.leadMonName ? a.leadMonName() : undefined;
    ctx.stringVars[dest] = truthy(lead) ? lead : "POK\xC3\xA9MON";
    return false;
  } else if (op === "buffernumberstring") {
    const dest = (row.dest ?? row[1] ?? 0) + 1;
    const v = Flags.getVar(store, ctx, row.src ?? row[2]);
    ctx.stringVars[dest] = tostring(v);
    return false;
  } else if (op === "bufferstring") {
    const dest = (row.dest ?? row[1] ?? 0) + 1;
    const ir = resolve_text(vm, row.src ?? row[2]);
    ctx.stringVars[dest] = truthy(ir) ? TextIR.toPlain(ir, {
      stringVars: ctx.stringVars,
      playerName: adapter_name(a.playerName, ctx.playerName),
      rivalName: adapter_name(a.rivalName, ctx.rivalName),
    }) : "";
    return false;
  } else if (op === "delay") {
    const frames = tonumber(row[1] ?? row.frames) ?? 0;
    if (frames <= 0) return false;
    // Soft per-frame wait only. Never call a.delay that completes+tick_vm
    // synchronously — that re-enters resume and clears waitmovement polls.
    ctx.delayLeft = frames;
    ctx.mode = "native";
    ctx.status = "waiting";
    ctx.nativePoll = () => {
      ctx.delayLeft = (ctx.delayLeft ?? 1) - 1;
      if (ctx.delayLeft <= 0) {
        ctx.delayLeft = null;
        return true;
      }
      return false;
    };
    return true;
  } else if (op === "turnobject") {
    const lid = var_get(store, ctx, row.localId ?? row[1]);
    const dir = row[2] ?? row.direction ?? 0;
    if (a.turnObject) a.turnObject(lid, dir);
    return false;
  } else if (op === "hideobjectat" || op === "showobjectat") {
    const lid = var_get(store, ctx, row.localId ?? row[1]);
    const group = row[2];
    const num = row[3];
    // package.loaded["src.core.game3.objects"] or require(...)
    if (op === "hideobjectat") {
      if (Objects.hideObjectAt) {
        Objects.hideObjectAt(lid, group, num);
      } else if (a.hideObject) {
        a.hideObject(lid);
      }
    } else {
      if (Objects.showObjectAt) {
        Objects.showObjectAt(lid, group, num);
      } else if (a.showObject) {
        a.showObject(lid);
      }
    }
    return false;
  } else if (op === "applymovementat" || op === "waitmovementat"
      || op === "removeobjectat" || op === "addobjectat") {
    // pret ScrCmd_applymovementat / waitmovementat / removeobjectat /
    // addobjectat (src/scrcmd.c:993, :1022, :1046, :1064).  On the current map
    // they behave exactly like the plain command, so re-dispatch to it.
    const groupIdx = (op === "applymovementat") ? 3 : 2;
    const foreign = !objectat_same_map(store, ctx, row, groupIdx) && objectat_foreign(store, ctx, row, groupIdx);
    if (truthy(foreign)) {
      const plain = ({ applymovementat: "applymovement", waitmovementat: "waitmovement",
        removeobjectat: "removeobject", addobjectat: "addobject" } as Record<string, string>)[op];
      let lid = foreign;
      if (op === "waitmovementat" && !(ctx.activeMoves && truthy(ctx.activeMoves[foreign]))) {
        lid = var_get(store, ctx, row.localId ?? row[1]);
      }
      return dispatch(vm, { op: plain, 1: lid, 2: row[2] });
    }
    if (!objectat_same_map(store, ctx, row, groupIdx)) {
      if (a.log) {
        a.log("[game3] " + op + " targets another map " + EM_DASH + " skipped");
      }
      return false;
    }
    const plain = ({
      applymovementat: "applymovement",
      waitmovementat: "waitmovement",
      removeobjectat: "removeobject",
      addobjectat: "addobject",
    } as Record<string, string>)[op];
    return dispatch(vm, { op: plain, 1: row[1], 2: row[2] });
  } else if (op === "addobject") {
    const lid = var_get(store, ctx, row.localId ?? row[1]);
    if (a.addObject) a.addObject(lid);
    return false;
  } else if (op === "opendoor" || op === "closedoor") {
    // pokeemerald/src/scrcmd.c:2053
    if (a.doorAnim) a.doorAnim(op, var_get(store, ctx, row[1]), var_get(store, ctx, row[2]));
    return false;
  } else if (op === "setdooropen" || op === "setdoorclosed") {
    // pret ScrCmd_setdooropen/setdoorclosed record a door's state (used to
    // restore doors on re-entry).  The host exposes only the door animation
    // seam, so map the stored state onto the matching action.
    if (a.doorAnim) {
      // pret ScrCmd_setdooropen/setdoorclosed read their x/y through VarGet
      // (src/scrcmd.c:2156).
      a.doorAnim(op === "setdooropen" ? "opendoor" : "closedoor",
        var_get(store, ctx, row[1]), var_get(store, ctx, row[2]));
    }
    return false;
  } else if (op === "waitdooranim") {
    // Short soft wait (no re-entrant tick_vm). Instant adapter done() was
    // skipping applymovement that follows (lab door enter).
    const frames = 8;
    ctx.delayLeft = frames;
    ctx.mode = "native";
    ctx.status = "waiting";
    ctx.nativePoll = () => {
      ctx.delayLeft = (ctx.delayLeft ?? 1) - 1;
      if (ctx.delayLeft <= 0) {
        ctx.delayLeft = null;
        return true;
      }
      return false;
    };
    return true;
  } else if (op === "fadescreen" || op === "fadescreenspeed") {
    const mode = row[1] ?? 0;
    const speed = row[2];
    if (a.fadeScreen) {
      ctx.mode = "native";
      ctx.status = "waiting";
      let done = false;
      ctx.nativePoll = () => done;
      a.fadeScreen(mode, speed, () => { done = true; });
      if (done) {
        ctx.mode = "bytecode";
        ctx.status = "running";
        ctx.nativePoll = null;
        return false;
      }
      return true;
    }
    return false;
  } else if (op === "setflashlevel") {
    // pokefirered/src/scrcmd.c:612
    // pcall(require, "src.core.game3.field_view")
    const okV = true;
    if (okV && FieldView != null && typeof FieldView === "object" && typeof FieldView.setFlashLevel === "function") {
      try { FieldView.setFlashLevel(var_get(store, ctx, row[1])); } catch { /* pcall */ }
    }
    return false;
  } else if (op === "animateflash") {
    // pokefirered/src/scrcmd.c:605
    // pcall(require, "src.core.game3.field_view") / ("src.core.game3.field_effects")
    const okV = true;
    const okFx = true;
    if (!(okV && FieldView != null && typeof FieldView === "object" && typeof FieldView.getFlashLevel === "function"
        && okFx && FieldEffects != null && typeof FieldEffects === "object"
        && typeof FieldEffects.animateFlashLevel === "function")) {
      return false;
    }
    // pokefirered/src/field_screen_effect.c:194
    let okAnim = true, anim: any;
    try {
      anim = FieldEffects.animateFlashLevel(FieldView.getFlashLevel(), tonumber(row[1]) ?? 0);
    } catch (e) { okAnim = false; anim = e; }
    if (!(okAnim && anim != null && typeof anim === "object")) return false;
    let flashDone = false;
    anim.onDone = () => { flashDone = true; };
    ctx.mode = "native";
    ctx.status = "waiting";
    ctx.nativePoll = () => flashDone;
    return true;
  } else if (op === "warp" || op === "warpsilent" || op === "warpdoor"
      || op === "warpteleport" || op === "warpspinenter" || op === "warpmossdeepgym" || op === "warpwhitefade") {
    const group = row[1], num = row[2];
    const warpId = row[3];
    // pokefirered/src/scrcmd.c:719-731
    const x = var_get(store, ctx, row[4]);
    const y = var_get(store, ctx, row[5]);
    if (a.warp) {
      // waitstate typically follows; mark pending and let waitstate poll.
      ctx.warpPending = true;
      a.warp(group, num, warpId, x, y, () => {
        ctx.warpPending = false;
        // pcall(require, "src.ui.game3.message")
        const okMsg = true;
        if (okMsg && Message && Message.isOpen && Message.isOpen()) {
          if (a.closeMessage) a.closeMessage();
          Message.close();
        }
      }, op);
    }
    return false;
  } else if (op === "warphole") {
    // pokefirered/src/scrcmd.c:761
    // package.loaded["src.core.game3.player"] or require(...)
    const destX = tonumber(Player.cellX) ?? 0, destY = tonumber(Player.cellY) ?? 0;
    let destMap = warp_hole_dest(row[1], row[2]);
    if (!truthy(destMap) && tonumber(row[1]) === 0xFF && tonumber(row[2]) === 0xFF) {
      // pokeemerald/src/scrcmd.c:790
      // package.loaded["src.core.game3.runtime"]
      const s = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
      destMap = s && s.holeWarp && s.holeWarp.map;
    }
    if (!truthy(destMap)) {
      a.log(format("[game3] warphole unknown FRLG map %s.%s",
        tostring(row[1]), tostring(row[2])));
      return false;
    }
    // package.loaded["src.core.game3.runtime"]
    const started = Warp.startFall(Runtime && Runtime._mod, Runtime && Runtime._game,
      destMap, destX, destY, null, null, { prologue: false });
    if (!started) return false;
    ctx.warpPending = true;
    Task.spawn(() => {
      if (Warp.isBusy && Warp.isBusy()) return false;
      ctx.warpPending = false;
      return true;
    });
    return false;
  } else if (op === "setwarp" || op === "setdynamicwarp" || op === "setescapewarp"
      || op === "setdivewarp" || op === "setholewarp") {
    // pokefirered/src/scrcmd.c:819
    if (a.setWarp) {
      a.setWarp(op, row[1], row[2], row[3],
        var_get(store, ctx, row[4]), var_get(store, ctx, row[5]));
    }
    return false;
  } else if (op === "playse" || op === "playfanfare" || op === "waitfanfare") {
    if (op === "waitfanfare") {
      const isFinished = (): any => {
        if (a.isFanfareFinished) return a.isFanfareFinished();
        if (Audio.isFanfareFinished) return Audio.isFanfareFinished();
        return true;
      };
      if (truthy(isFinished())) {
        return false;
      }
      ctx.mode = "native";
      ctx.status = "waiting";
      let done = false;
      ctx.nativePoll = () => done || isFinished();
      const finish = () => { done = true; };
      if (a.waitFanfare) {
        a.waitFanfare(finish);
      } else {
        Audio.waitFanfare(finish);
      }
      return true;
    } else {
      if (op === "playfanfare") {
        let songId = row[1] ?? row.song ?? row.id ?? 0;
        songId = var_get(store, ctx, songId);
        if (a.playSe) a.playSe(songId, true); else Audio.playFanfare(songId);
      } else {
        let seId = row[1] ?? row.id ?? 0;
        seId = var_get(store, ctx, seId);
        if (a.playSe) a.playSe(seId, false); else Audio.playSe(seId);
      }
    }
    return false;
  } else if (op === "playbgm" || op === "playsong" || op === "fadenewbgm") {
    // pokefirered/src/scrcmd.c:927
    if (op === "playbgm" && (row[2] === 1 || row[2] === true)) {
      Audio.setSavedSong(row[1]);
    }
    if (a.playBgm) {
      a.playBgm(row[1] ?? 0);
    } else {
      Audio.playSong(row[1] ?? 0);
    }
    return false;
  } else if (op === "fadedefaultbgm" || op === "fadeoutbgm" || op === "fadeinbgm" || op === "savebgm") {
    if (a.fadeBgm) {
      a.fadeBgm(op, row[1], row[2]);
    } else if (op === "savebgm") {
      // pokefirered/src/scrcmd.c:935
      Audio.setSavedSong(row[1]);
    } else if (op === "fadeoutbgm") {
      Audio.fadeOutBgm(row[1] ?? 4);
    } else if (op === "fadeinbgm") {
      Audio.fadeInBgm(row[1] ?? Audio._mapSong, row[2] ?? 4);
    } else {
      Audio.fadeDefaultBgm(row[1] ?? 4);
    }
    return false;
  } else if (op === "waitse") {
    ctx.mode = "native";
    ctx.status = "waiting";
    let done = false;
    ctx.nativePoll = () => done;
    Audio.waitSe(row[1], () => { done = true; });
    if (done || !Audio.isSePlaying(row[1])) {
      done = true;
      ctx.mode = "bytecode";
      ctx.status = "running";
      ctx.nativePoll = null;
      return false;
    }
    return true;
  } else if (op === "playmoncry") {
    // pokefirered/src/scrcmd.c:2088
    Audio.playCry(var_get(store, ctx, row[1]), var_get(store, ctx, row[2]));
    return false;
  } else if (op === "waitmoncry") {
    // pokefirered/src/scrcmd.c:2097
    const isFinished = (): boolean => {
      if (Audio.isCryFinished) return Audio.isCryFinished() === true;
      return true;
    };
    if (isFinished()) return false;
    ctx.mode = "native";
    ctx.status = "waiting";
    let lastClock = Audio._cryClock;
    ctx.nativePoll = () => {
      if (isFinished()) return true;
      // pokefirered/src/sound.c:502
      if (Audio._cryClock === lastClock && Audio.tickCry) Audio.tickCry(1 / 60);
      lastClock = Audio._cryClock;
      return isFinished();
    };
    return true;
  } else if (op === "braillemessage") {
    // pokefirered/src/scrcmd.c:1558
    const ptr = row.ptr ?? row[1];
    const ir = resolve_text(vm, ptr);
    if (!truthy(ir)) return show_message(vm, ptr, true);
    const body = TextIR.toPlain(ir, text_ctx_view(vm)) ?? "";
    // pcall(require, "src.ui.game3.braille")
    const okB = true;
    if (okB && Braille != null && typeof Braille === "object" && typeof Braille.show === "function") {
      let okShow = true;
      try { Braille.show(body, { width: braille_width(ir) }); } catch { okShow = false; }
      if (okShow) {
        ctx.messageOpen = true;
        return false;
      }
    }
    return show_message(vm, ptr, true);
  } else if (op === "getbraillestringwidth") {
    // pokefirered/src/scrcmd.c:1570
    const ir = resolve_text(vm, row.ptr ?? row[1]);
    let width: number | undefined;
    // pcall(require, "src.ui.game3.braille")
    const okB = true;
    if (okB && Braille != null && typeof Braille === "object" && typeof Braille.width === "function") {
      let okW = true, v: any;
      // `ir or {}`: TextIR takes its segment lists as 0-based JS arrays
      try { v = Braille.width(TextIR.toPlain(ir ?? [], text_ctx_view(vm)) ?? ""); } catch (e) { okW = false; v = e; }
      if (okW) width = tonumber(v);
    }
    Flags.setVar(store, ctx, 0x8004, width ?? braille_width(ir));
    return false;
  } else if (op === "messageautoscroll") {
    return show_message(vm, row.ptr ?? row[1], false);
  } else if (op === "setmetatile" || op === "dofieldeffect" || op === "waitfieldeffect"
      || op === "setfieldeffectargument") {
    // Field pack: no-op / instant unless host implements.
    if (op === "waitfieldeffect" && a.waitFieldEffect) {
      ctx.mode = "native";
      ctx.status = "waiting";
      let done = false;
      ctx.nativePoll = () => done;
      a.waitFieldEffect(row[1], () => { done = true; });
      if (done) {
        ctx.mode = "bytecode";
        ctx.status = "running";
        ctx.nativePoll = null;
        return false;
      }
      return true;
    }
    if (op === "setmetatile" && a.setMetatile) {
      // pokefirered/src/scrcmd.c:2103-2108
      a.setMetatile(var_get(store, ctx, row[1]), var_get(store, ctx, row[2]),
        var_get(store, ctx, row[3]), var_get(store, ctx, row[4]) !== 0);
    } else if (op === "dofieldeffect" && a.doFieldEffect) {
      // pokefirered/src/scrcmd.c:2042-2049
      a.doFieldEffect(var_get(store, ctx, row[1]));
    } else if (op === "setfieldeffectargument") {
      // pokefirered/src/scrcmd.c:2051 — the value operand is VarGet'd, which
      // passes raw constants (< 0x4000) straight through.
      const argNum = tonumber(row[1]) ?? 0;
      const value = var_get(store, ctx, row[2]);
      if (a.setFieldEffectArgument) {
        a.setFieldEffectArgument(argNum, value);
      }
    }
    return false;
  } else if (op === "setstepcallback") {
    // pokefirered/src/scrcmd.c:705
    // package.loaded["src.core.game3.runtime"]
    const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
    Ctx.setStepCallback(row[1] ?? 0, session && session.map);
    return false;
  } else if (op === "setmaplayoutindex") {
    // pokefirered/src/scrcmd.c:711
    set_map_layout(var_get(store, ctx, row[1]), a.log);
    return false;
  } else if (op === "setweather") {
    // pokefirered/src/scrcmd.c:685-691
    if (a.setWeather) a.setWeather(var_get(store, ctx, row[1] ?? row.weather ?? 0));
    return false;
  } else if (op === "doweather") {
    if (a.doWeather) a.doWeather();
    return false;
  } else if (op === "resetweather") {
    if (a.resetWeather) a.resetWeather();
    return false;
  } else if (op === "setwildbattle") {
    Encounters.setWildBattle(row[1] ?? row.species, row[2] ?? row.level, row[3] ?? row.item);
    return false;
  } else if (op === "dowildbattle") {
    const foe: any = Encounters.takePendingWild();
    if (a.startWildBattle && foe) {
      foe.wildScripted = true;
      ctx.mode = "native";
      ctx.status = "waiting";
      let done = false;
      ctx.nativePoll = () => done;
      a.startWildBattle(foe, (result: any) => {
        // require("src.core.game3.scripting.natives")
        const got = Natives.outcome_to_code ? Natives.outcome_to_code(result) : undefined;
        const code = truthy(got) ? got : 1;
        if (ctx) ctx.lastBattleOutcome = code;
        Flags.setVar(store, ctx, 0x800D, code);
        done = true;
      }, { wildScripted: true });
      if (done) {
        ctx.mode = "bytecode";
        ctx.status = "running";
        ctx.nativePoll = null;
        return false;
      }
      return true;
    }
    return false;
  } else if (op === "checktrainerflag") {
    const tid = var_get(store, ctx, row[1] ?? row.trainer);
    ctx.comparisonResult = truthy(Flags.getFlag(store, ctx, Flags.trainerFlagId(tid))) ? 1 : 0;
    return false;
  } else if (op === "settrainerflag") {
    const tid = var_get(store, ctx, row[1] ?? row.trainer);
    const fid = Flags.trainerFlagId(tid);
    Flags.setFlag(store, ctx, fid, true);
    if (a.onFlagChanged) a.onFlagChanged(fid, true);
    return false;
  } else if (op === "cleartrainerflag") {
    const tid = var_get(store, ctx, row[1] ?? row.trainer);
    const fid = Flags.trainerFlagId(tid);
    Flags.setFlag(store, ctx, fid, false);
    if (a.onFlagChanged) a.onFlagChanged(fid, false);
    return false;
  } else if (op === "gotopostbattlescript") {
    // pret: resume after the trainerbattle that configured this fight.
    if (truthy(ctx.trainerBattleEndScript)) {
      jump(vm, ctx.trainerBattleEndScript);
    }
    return false;
  } else if (op === "gotobeatenscript") {
    // pret: CONTINUE_SCRIPT event pointer (e.g. DefeatedBrock → shoes aide).
    // package.loaded["src.core.game3.trainer_sight"]
    const TS = TrainerSight;
    if (TS && truthy(TS.checkTrainerB)) {
      // pokeemerald/src/battle_setup.c:1413
      TS.checkTrainerB = false;
      if (truthy(TS.trainerBRet)) {
        jump(vm, TS.trainerBRet);
        return false;
      }
    }
    if (truthy(ctx.trainerBattleBeatenScript)) {
      jump(vm, ctx.trainerBattleBeatenScript);
    }
    return false;
  } else if (op === "trainerbattle" || op === "dotrainerbattle") {
    // pret ScrCmd_trainerbattle configures then jumps into trainer_battle.inc.
    // We inline that: skip if already fought; else battle; on win set trainer
    // flag and goto eventScript when present (CONTINUE_SCRIPT*).
    const trainerId = tonumber(row.trainer ?? row[1]) ?? 0;
    const battleType = tonumber(row.type) ?? 0;
    const rivalFlags = tonumber(row.flags ?? row.localId) ?? 0;
    // pokefirered/include/constants/battle_setup.h:13
    const earlyRival = Opcodes.active().trainerBattleType(battleType) === "EARLY_RIVAL";
    // pokefirered/src/battle_setup.c:899
    const tutorialBattle = earlyRival && mod(rivalFlags, 4) !== 0;
    const eventScript = row.eventScript;
    const trainerFlag = Flags.trainerFlagId(trainerId);
    const isRematch = op === "trainerbattle" && (battleType === 5 || battleType === 7);
    const trainerLocalId = tonumber(row.localId) ?? 0;
    if (op === "trainerbattle" && battleType !== 3 && !earlyRival && trainerLocalId !== 0) {
      // src/battle_setup.c:778
      Flags.setVar(store, ctx, Ctx.VAR_LAST_TALKED, trainerLocalId);
      Ctx.selectObject(ctx, trainerLocalId);
    }
    const lastTalked = Flags.getVar(store, ctx, Ctx.VAR_LAST_TALKED);
    let opponentA = trainerId;
    let rseSession: any, RseRematch: any;
    {
      // package.loaded["src.core.game3.runtime"]
      rseSession = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
      if (rseSession && Profile.family(rseSession) === "rse") {
        // require("src.core.game3.rse.init").system("rematch"): no rse/ in the port
        throw new Error("NOT FAITHFUL: Emerald only (rse.init rematch system)");
      }
    }
    if (op === "trainerbattle") {
      if (isRematch && RseRematch) {
        // pokeemerald/src/battle_setup.c:1137
        opponentA = RseRematch.rematchTrainerId(rseSession, trainerId);
      } else if (isRematch) {
        // pokefirered/src/battle_setup.c:814
        opponentA = VsSeeker.rematchTrainerId(trainerId, store);
      }
      ctx.trainerBattleMode = battleType;
      ctx.trainerBattleOpponentA = opponentA;
    }

    // Remember post-battle / beaten scripts for gotopost/gotobeaten.
    // VM already advanced PC past this op → current PC is post-battle addr.
    ctx.trainerBattleEndScript = {
      listKey: ctx.pc!.listKey,
      index: ctx.pc!.index,
    };
    ctx.trainerBattleBeatenScript = eventScript;

    // data/scripts/trainer_battle.inc:44
    if (op === "trainerbattle" && !earlyRival && !isRematch && battleType !== 3
        && truthy(Flags.getFlag(store, ctx, trainerFlag))) {
      // Already defeated → fall through (gotopostbattlescript).
      return false;
    }
    // pokefirered/data/scripts/trainer_battle.inc:52
    if (op === "trainerbattle" && isRematch && RseRematch) {
      // pokeemerald/data/scripts/trainer_battle.inc:52
      if (!truthy(RseRematch.isTrainerReadyForRematch(rseSession, opponentA))) return false;
    } else if (op === "trainerbattle" && isRematch && !truthy(VsSeeker.isTrainerReadyForRematch(opponentA, lastTalked))) {
      return false;
    }

    const isDouble = battleType === 4 || battleType === 6 || battleType === 7 || battleType === 8;
    if (op === "trainerbattle" && isDouble && a.startTrainerBattle) {
      // package.loaded["src.core.game3.runtime"]
      const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
      // pokefirered/data/scripts/trainer_battle.inc:30
      if (Party.monsStateToDoubles(session && session.party) !== Party.PLAYER_HAS_TWO_USABLE_MONS) {
        const dialogs = Trainers.dialogs(trainerId) ?? {};
        const cantText = (truthy(row.notEnoughText) ? resolve_text(vm, row.notEnoughText) : undefined) ?? dialogs.notEnough;
        if (truthy(cantText) && cantText !== "" && a.openMessageAsync) {
          ctx.mode = "native";
          ctx.status = "waiting";
          let shown = false;
          ctx.nativePoll = () => {
            if (!shown) return false;
            ctx.status = "halted";
            return false;
          };
          a.openMessageAsync(cantText, () => { shown = true; });
          if (shown) {
            ctx.mode = "bytecode";
            ctx.status = "halted";
            ctx.nativePoll = null;
          }
          return true;
        }
        ctx.status = "halted";
        return true;
      }
    }

    if (a.startTrainerBattle) {
      let foe: any = Trainers.foeFromId(opponentA);
      if (!truthy(foe)) {
        let sp = tonumber(row.species);
        if (sp == null || sp < 1) sp = undefined;
        foe = {
          species: sp ?? 4,
          level: tonumber(row.level) ?? 5,
          trainerId: opponentA,
        };
      }
      foe.moves = foe.moves ?? row.moves;

      const dialogs = Trainers.dialogs(opponentA) ?? Trainers.dialogs(trainerId) ?? {};
      let introText: any = null;
      if (battleType !== 3 && battleType !== 9) {
        introText = (truthy(row.introText) ? resolve_text(vm, row.introText) : undefined) ?? dialogs.intro;
      }
      const defeatText = (truthy(row.defeatText) ? resolve_text(vm, row.defeatText) : undefined) ?? dialogs.defeat;
      const victoryText = (truthy(row.victoryText) ? resolve_text(vm, row.victoryText) : undefined) ?? dialogs.victory;

      // package.loaded["src.core.game3.trainer_sight"]
      const TS = TrainerSight;
      if (TS) {
        // pokeemerald/src/battle_setup.c:1313
        TS.retScriptCount = 1; TS.checkTrainerB = false; TS.trainerBRet = null;
      }
      ctx.mode = "native";
      ctx.status = "waiting";
      let done = false;
      let pendingGoto: any = null;
      let shouldHalt = false;

      ctx.nativePoll = () => {
        if (!done) return false;
        if (shouldHalt) {
          ctx.status = "halted";
          return false;
        }
        if (truthy(pendingGoto)) {
          jump(vm, pendingGoto);
          pendingGoto = null;
        }
        return true;
      };

      // Lua: ops_a.lua:1657
      const beginBattle = (): void => {
        a.startTrainerBattle(foe, (result: any) => {
          const lost = (result === "lose" || result === "whiteout" || result === "blackout");
          // pret: gSpecialVar_Result = TRUE if player defeated (early rival).
          if (earlyRival) {
            Flags.setVar(store, ctx, Ctx.VAR_RESULT, lost ? 1 : 0);
          }
          if (!RseRematch) {
            // pokefirered/src/battle_main.c:3848
            VsSeeker.clearRematchStateByTrainerId(opponentA, lastTalked, store);
          }
          if (isRematch) {
            if (!lost) {
              // pokefirered/src/battle_setup.c:967
              const rematchFlag = Flags.trainerFlagId(opponentA);
              Flags.setFlag(store, ctx, rematchFlag, true);
              if (a.onFlagChanged) a.onFlagChanged(rematchFlag, true);
              if (RseRematch) {
                // pokeemerald/src/battle_setup.c:1351
                RseRematch.onRematchBattleWon(rseSession, opponentA);
              } else {
                VsSeeker.clearRematchStateOfLastTalked(lastTalked, opponentA, store);
              }
            }
            shouldHalt = true;
          } else if (!lost) {
            Flags.setFlag(store, ctx, trainerFlag, true);
            if (a.onFlagChanged) a.onFlagChanged(trainerFlag, true);
            if (RseRematch) {
              // pokeemerald/src/battle_setup.c:1327
              RseRematch.onTrainerBattleWon(rseSession, opponentA);
            }
            // CONTINUE_SCRIPT*: gotobeatenscript after battle.
            if (truthy(eventScript) && (battleType === 1 || battleType === 2
                || battleType === 6 || battleType === 8)) {
              pendingGoto = eventScript;
            } else if (battleType === 0 || battleType === 4) {
              // Single standard trainer: script ends after encounter
              shouldHalt = true;
            }
          }
          done = true;
        }, {
          trainerId: opponentA,
          earlyRival,
          rivalFlags,
          firstBattle: tutorialBattle,
          noWhiteout: earlyRival && (mod(rivalFlags, 2) === 1),
          defeatText,
          victoryText,
          double: (foe.doubleBattle === true) ? true : null,
        });
      };

      // pokefirered/src/battle_setup.c:848 SetUpTrainerMovement
      // package.loaded["src.core.game3.objects"]
      const eo = Objects && Objects.find ? Objects.find(lastTalked) : undefined;
      if (eo && !(Objects.isPlayer && truthy(Objects.isPlayer(lastTalked)))) {
        const faceMt = ({ down: 0x08, up: 0x07, left: 0x09, right: 0x0A } as Record<string, number>)[eo.facing] ?? 0x08;
        if (Objects.setTrainerMovementType) {
          Objects.setTrainerMovementType(eo, faceMt);
        } else {
          eo.movementType = faceMt;
          eo.movement = "STAY";
          eo.range = (truthy(eo.facing) ? eo.facing : "down").toUpperCase();
        }
        if (Objects.overrideTemplateMovementType) {
          Objects.overrideTemplateMovementType(eo.localId, faceMt);
        }
        eo.homeX = eo.cellX;
        eo.homeY = eo.cellY;
        if (eo.def) {
          eo.def.movementType = faceMt;
          eo.def.movement = "STAY";
          eo.def.x = eo.cellX;
          eo.def.y = eo.cellY;
          eo.def.range = (truthy(eo.facing) ? eo.facing : "down").toUpperCase();
        }
        if (Objects.rememberPerm && truthy(Objects._mapId)) {
          Objects.rememberPerm(Objects._mapId, eo.localId, {
            x: eo.cellX,
            y: eo.cellY,
            movementType: faceMt,
            facing: eo.facing,
          });
        }
      }

      const hasIntro = truthy(introText) && introText !== "" && truthy(a.openMessageAsync) && !truthy(ctx.trainerIntroShown);
      ctx.trainerIntroShown = null;
      // pokefirered/src/battle_setup.c:1007
      if ((hasIntro || battleType === 3 || battleType === 9) && battleType !== 1 && battleType !== 8) {
        const song = Trainers.getEncounterMusic ? Trainers.getEncounterMusic(opponentA) : undefined;
        // pcall(require, "src.core.game3.audio")
        const okA = true;
        if (okA && Audio && Audio.playSong && truthy(song)) {
          Audio.playSong(song);
        }
      }
      if (hasIntro) {
        a.openMessageAsync(introText, () => {
          beginBattle();
        });
      } else {
        beginBattle();
      }

      if (done) {
        ctx.mode = "bytecode";
        ctx.status = shouldHalt ? "halted" : "running";
        ctx.nativePoll = null;
        if (truthy(pendingGoto)) {
          jump(vm, pendingGoto);
        }
        return shouldHalt;
      }
      return true;
    }
    return false;
  } else if (op === "additem" || op === "removeitem") {
    let item = row[1] ?? row.item;
    let qty = row[2] ?? row.quantity ?? 1;
    item = tonumber(item) ?? item;
    qty = tonumber(qty) ?? 1;
    // FRLG often passes VAR_0x8000 / VAR_0x8001 (setorcopyvar before callstd).
    if (typeof item === "number" && item >= 0x4000) {
      item = Flags.getVar(store, ctx, item);
    }
    if (typeof qty === "number" && qty >= 0x4000) {
      qty = Flags.getVar(store, ctx, qty);
    }
    let ok: any = true;
    if (a.modifyItem) {
      // first value (Bag.add / Bag.remove return several)
      ok = mr(a.modifyItem(op, item, qty), 0);
    }
    // VAR_RESULT: 1 = success (bag accepted), 0 = full / failed.
    Flags.setVar(store, ctx, Ctx.VAR_RESULT, truthy(ok) ? 1 : 0);
    return false;
  } else if (op === "checkitem") {
    // pret ScrCmd_checkitem → CheckBagHasItem → VAR_RESULT
    let item = row[1] ?? row.item;
    let qty = row[2] ?? row.quantity ?? 1;
    item = tonumber(item) ?? item;
    qty = tonumber(qty) ?? 1;
    if (typeof item === "number" && item >= 0x4000) {
      item = Flags.getVar(store, ctx, item);
    }
    if (typeof qty === "number" && qty >= 0x4000) {
      qty = Flags.getVar(store, ctx, qty);
    }
    let ok = false;
    if (a.checkItem) {
      ok = truthy(a.checkItem(item, qty)) ? true : false;
    } else {
      // package.loaded["src.core.game3.runtime"]
      const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
      if (session && session.bag) {
        ok = Bag.has(session.bag, item, qty);
      }
    }
    Flags.setVar(store, ctx, Ctx.VAR_RESULT, ok ? 1 : 0);
    return false;
  } else if (op === "checkitemtype") {
    // pret ScrCmd_checkitemtype → GetPocketByItemId (1..5) → VAR_RESULT
    let item = row[1] ?? row.item;
    item = tonumber(item) ?? item;
    if (typeof item === "number" && item >= 0x4000) {
      item = Flags.getVar(store, ctx, item);
    }
    let pocket = 0;
    if (a.checkItemType) {
      pocket = tonumber(a.checkItemType(item)) ?? 0;
    } else {
      pocket = ItemsData.pocketResult(item) ?? 0;
    }
    Flags.setVar(store, ctx, Ctx.VAR_RESULT, pocket);
    return false;
  } else if (op === "checkitemspace") {
    let item = row[1] ?? row.item;
    let qty = row[2] ?? row.quantity ?? 1;
    item = tonumber(item) ?? item;
    qty = tonumber(qty) ?? 1;
    if (typeof item === "number" && item >= 0x4000) {
      item = Flags.getVar(store, ctx, item);
    }
    if (typeof qty === "number" && qty >= 0x4000) {
      qty = Flags.getVar(store, ctx, qty);
    }
    let ok = true;
    if (a.checkItemSpace) {
      ok = truthy(a.checkItemSpace(item, qty)) ? true : false;
    } else {
      // package.loaded["src.core.game3.runtime"]
      const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
      if (session && session.bag) {
        ok = Bag.canAdd(session.bag, item, qty) ? true : false;
      }
    }
    Flags.setVar(store, ctx, Ctx.VAR_RESULT, ok ? 1 : 0);
    return false;
  } else if (op === "addmoney" || op === "removemoney" || op === "checkmoney") {
    // pokefirered/src/scrcmd.c:1798-1830, asm/macros/event.inc:1166-1186
    const amount = Math.max(0, Math.floor(tonumber(row[1] ?? row.amount) ?? 0));
    const disable = tonumber(row[2] ?? row.disable) ?? 0;
    if (disable === 0) {
      // package.loaded["src.core.game3.runtime"]
      const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
      const money = tonumber(session && session.money) ?? 0;
      if (op === "checkmoney") {
        Flags.setVar(store, ctx, Ctx.VAR_RESULT, money >= amount ? 1 : 0);
      } else if (session) {
        if (op === "addmoney") {
          Prize.apply(session, amount);
        } else {
          session.money = Math.max(0, money - amount);
        }
      }
    }
    return false;
  } else if (op === "showmoneybox") {
    const x = tonumber(row[1] ?? row.x) ?? 19;
    const y = tonumber(row[2] ?? row.y) ?? 1;
    const ignore = tonumber(row[3] ?? row.ignore) ?? 0;
    // pokefirered/src/scrcmd.c:1834
    if (ignore === 0 && !ql_avoid_display()) {
      MoneyBox.show(x, y);
    }
    return false;
  } else if (op === "hidemoneybox") {
    MoneyBox.hide();
    return false;
  } else if (op === "updatemoneybox") {
    // pokefirered/src/scrcmd.c:1848-1856, event.inc:1204-1211
    const disable = tonumber(row[3]) ?? 0;
    if (disable === 0) {
      MoneyBox.update();
    }
    return false;
  } else if (op === "checkcoins") {
    // pokefirered/src/scrcmd.c:2197
    Flags.setVar(store, ctx, row[1] ?? row.dest, coins_get());
    return false;
  } else if (op === "addcoins" || op === "removecoins") {
    // pokefirered/src/scrcmd.c:2204
    const amount = var_get(store, ctx, row[1] ?? row.amount);
    const moved = coins_move(op === "addcoins", amount);
    Flags.setVar(store, ctx, Ctx.VAR_RESULT, moved ? 0 : 1);
    return false;
  } else if (op === "showcoinsbox") {
    // pokefirered/src/scrcmd.c:1864
    if (!ql_avoid_display()) {
      coins_box("show", tonumber(row[1] ?? row.x) ?? 0, tonumber(row[2] ?? row.y) ?? 0, coins_get());
    }
    return false;
  } else if (op === "hidecoinsbox") {
    // pokefirered/src/scrcmd.c:1869
    coins_box("hide");
    return false;
  } else if (op === "updatecoinsbox") {
    // pokefirered/src/scrcmd.c:1878
    coins_box("update", coins_get());
    return false;
  } else if (op === "pokemart" || ((op === "pokemartdecoration" || op === "pokemartdecoration2") && truthy(a.openShop)
      && ctx.specialLayout && ctx.specialLayout.family === "rse")) {
    // pokeemerald/src/scrcmd.c:1896
    const ptr = row[1] ?? row.ptr ?? row.items;
    if (a.openShop) {
      ctx.mode = "native";
      ctx.status = "waiting";
      let done = false;
      ctx.nativePoll = () => done;
      a.openShop(ptr, () => {
        done = true;
      });
      if (done) {
        ctx.mode = "bytecode";
        ctx.status = "running";
        ctx.nativePoll = null;
        return false;
      }
      return true;
    }
    if (a.log) a.log("[game3] pokemart skipped (no openShop)");
    return false;
  } else if (op === "pokemartdecoration" || op === "pokemartdecoration2") {
    // Decor shops are a separate item namespace; skip until decor pack exists.
    if (a.log) a.log("[game3] skip " + tostring(op));
    return false;
  } else if (op === "playslotmachine") {
    // pokefirered/src/scrcmd.c:1980
    const machineIdx = var_get(store, ctx, row[1] ?? row.id);
    // pcall(require, "src.ui.game3.slot_machine")
    const [okUi, SlotUi] = pcallReqMissing("src.ui.game3.slot_machine");
    if (!(okUi && SlotUi != null && typeof SlotUi === "object" && typeof SlotUi.show === "function")) {
      if (a.log) a.log("[game3] playslotmachine skipped (no screen)");
      return false;
    }
    if (a.closeMessage) a.closeMessage();
    // pcall(require, "src.ui.game3.message")
    const okMsg = true;
    if (okMsg && Message && Message.close) Message.close();
    // package.loaded["src.core.game3.runtime"]
    const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
    let done = false;
    // Lua: ops_a.lua:1965
    const poll = (): boolean => {
      if (done && ctx.stateWait === poll) ctx.stateWait = null;
      return done;
    };
    ctx.mode = "native";
    ctx.status = "waiting";
    ctx.nativePoll = poll;
    Natives.awaitState(ctx, poll);
    SlotUi.show({
      machineIdx,
      session,
      onClose: () => { done = true; },
    });
    if (done) {
      ctx.mode = "bytecode";
      ctx.status = "running";
      ctx.nativePoll = null;
      ctx.stateWait = null;
      return false;
    }
    return true;
  } else if (op === "setobjectxyperm" || op === "setobjectxy" || op === "setobjectmovementtype"
      || op === "copyobjectxytoperm") {
    if (a.setObjectState) a.setObjectState(op, row);
    return false;
  } else if (op === "multichoice" || op === "multichoicedefault" || op === "multichoicegrid") {
    // Economy/UI pack: pick option 0 into VAR_RESULT unless host implements.
    Flags.setVar(store, ctx, 0x800D, 0);
    if (op === "multichoice") {
      const listId = tonumber(row.listId ?? row[3]) ?? -1;
      const MultiO = Multichoice;
      const override = MultiO.OVERRIDES ? MultiO.OVERRIDES[listId] : MultiO.OVERRIDES;
      if (truthy(override)) {
        let picked = false;
        ctx.mode = "native";
        ctx.status = "waiting";
        ctx.nativePoll = () => picked;
        const took = override(ctx, row, (sel: any) => {
          Flags.setVar(store, ctx, 0x800D, tonumber(sel) ?? 0);
          picked = true;
        });
        if (truthy(took) && !picked) return true;
        ctx.mode = "bytecode";
        ctx.status = "running";
        ctx.nativePoll = null;
        if (truthy(took)) return false;
      }
      // pcall(require, "src.ui.game3.prize_corner")
      const [okP, PrizeCorner] = pcallReqMissing("src.ui.game3.prize_corner");
      if (okP && PrizeCorner != null && typeof PrizeCorner === "object" && truthy(PrizeCorner.isPrizeList(listId))) {
        const labels = Multichoice.resolve(listId);
        let done = false;
        // Lua: ops_a.lua:2017
        const poll = (): boolean => {
          if (done && ctx.stateWait === poll) ctx.stateWait = null;
          return done;
        };
        ctx.mode = "native";
        ctx.status = "waiting";
        ctx.nativePoll = poll;
        Natives.awaitState(ctx, poll);
        // pokefirered/src/script_menu.c:713
        const shown = PrizeCorner.show({
          listId,
          labels,
          left: tonumber(row.x ?? row.left ?? row[1]) ?? 0,
          top: tonumber(row.y ?? row.top ?? row[2]) ?? 0,
          ignoreBPress: (tonumber(row[4] ?? row.ignoreBPress) ?? 0) !== 0,
          onChoose: (sel: any) => {
            Flags.setVar(store, ctx, 0x800D, tonumber(sel) ?? 0);
            done = true;
          },
        });
        if (!truthy(shown)) {
          done = true;
        }
        if (done) {
          ctx.mode = "bytecode";
          ctx.status = "running";
          ctx.nativePoll = null;
          ctx.stateWait = null;
        } else {
          return true;
        }
      }
    }
    if (a.multichoice) {
      ctx.mode = "native";
      ctx.status = "waiting";
      let done = false;
      ctx.nativePoll = () => done;
      a.multichoice(row, (sel: any) => {
        Flags.setVar(store, ctx, 0x800D, tonumber(sel) ?? 0);
        done = true;
      });
      if (done) {
        ctx.mode = "bytecode";
        ctx.status = "running";
        ctx.nativePoll = null;
        return false;
      }
      return true;
    }
    return false;
  } else if (op === "random") {
    // pokefirered/src/scrcmd.c:455-461
    let maxv = var_get(store, ctx, row[1]);
    maxv = tonumber(maxv) ?? 1;
    if (maxv < 1) maxv = 1;
    Flags.setVar(store, ctx, 0x800D, random(0, maxv - 1));
    return false;
  } else if (op === "getplayerxy") {
    // pokefirered/src/scrcmd.c:867
    // package.loaded["src.core.game3.player"] or require(...)
    Flags.setVar(store, ctx, row[1], tonumber(Player.cellX) ?? 0);
    Flags.setVar(store, ctx, row[2], tonumber(Player.cellY) ?? 0);
    return false;
  } else if (op === "getpartysize") {
    // pokefirered/src/scrcmd.c:877
    // package.loaded["src.core.game3.runtime"]
    const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
    Flags.setVar(store, ctx, Ctx.VAR_RESULT, Party.size(session && session.party));
    return false;
  } else if (op === "checkplayergender") {
    // pokefirered/src/scrcmd.c:2082
    // package.loaded["src.core.game3.runtime"]
    const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
    Flags.setVar(store, ctx, Ctx.VAR_RESULT, tonumber(session && session.gender) ?? 0);
    return false;
  } else if (op === "bufferboxname") {
    // pokefirered/src/pokemon_storage_system.c:118
    const dest = (tonumber(row.dest ?? row[1]) ?? 0) + 1;
    const boxId = var_get(store, ctx, row.src ?? row[2]);
    // package.loaded["src.core.game3.runtime"]
    const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
    const storage = session ? Storage.ensure(session) : session;
    const box: any = storage ? Storage.getBox(storage, boxId + 1) : storage;
    ctx.stringVars[dest] = (box && box.name) || "";
    return false;
  } else if (op === "setrespawn") {
    // pret ScrCmd_setrespawn → SetLastHealLocationWarp(healLocationId)
    const id = var_get(store, ctx, row[1]);
    // package.loaded["src.core.game3.field"] or require(...)
    if (Field.setRespawn) {
      Field.setRespawn(id);
    }
    return false;
  } else if (op === "trywondercardscript") {
    // pokefirered/src/scrcmd.c:275 ScrCmd_trywondercardscript
    const r = Gift.runWonderCardScript(ctx, a);
    const yld = mr(r, 0), jumped = mr(r, 1);
    if (truthy(jumped)) ctx.pc = null;
    return yld;
  } else if (op === "setobjectsubpriority") {
    // src/scrcmd.c:1122-1130
    const objLid = var_get(store, ctx, row[1]);
    // package.loaded["src.core.game3.objects"] or require(...)
    Objects.setSubpriority(objLid, row[2], row[3], (tonumber(row[4]) ?? 0) + 83);
    return false;
  } else if (op === "resetobjectsubpriority") {
    // src/scrcmd.c:1133-1140
    const objLid = var_get(store, ctx, row[1]);
    // package.loaded["src.core.game3.objects"] or require(...)
    Objects.resetSubpriority(objLid, row[2], row[3]);
    return false;
  } else if (op === "gettime") {
    // pokefirered/src/scrcmd.c:673-681
    Flags.setVar(store, ctx, 0x8000, 0);
    Flags.setVar(store, ctx, 0x8001, 0);
    Flags.setVar(store, ctx, 0x8002, 0);
    return false;
  } else if (op === "setmysteryeventstatus") {
    // src/scrcmd.c:269-273, src/mystery_event_script.c:92-95
    ctx.mysteryEventStatus = row[1];
    // pcall(require, "src.core.game3.mystery_gift")
    const okMG = true;
    if (okMG && MysteryGift && MysteryGift.setStatus) MysteryGift.setStatus(row[1]);
    return false;
  } else if (op === "gotonative") {
    // src/scrcmd.c:92-97
    const gaddr = tonumber(row[1]) ?? 0;
    const gfn = Natives.resolveNative ? Natives.resolveNative(gaddr) : undefined;
    if (typeof gfn === "function") {
      return truthy(gfn(ctx, a)) ? true : false;
    }
    Natives.log_once("gotonative", gaddr, a ? a.log : a);
    return false;
  } else if (op === "createvobject") {
    // src/scrcmd.c:1171-1181
    // package.loaded["src.core.game3.virtual_objects"] or require(...)
    VirtualObjects.spawn(row[2], row[1], var_get(store, ctx, row[3]), var_get(store, ctx, row[4]),
      row[5], row[6]);
    return false;
  } else if (op === "turnvobject") {
    // src/scrcmd.c:1184-1190
    VirtualObjects.turn(row[1], row[2]);
    return false;
  } else if (op === "loadhelp") {
    // src/scrcmd.c:1274-1280, src/new_menu_helpers.c:701-705
    const ir = resolve_text(vm, row[1]);
    if (HelpWindow.show) {
      HelpWindow.show(truthy(ir) ? TextIR.toPlain(ir, text_ctx_view(vm)) : "");
    }
    return false;
  } else if (op === "unloadhelp") {
    // src/new_menu_helpers.c:707-710
    if (HelpWindow.close) HelpWindow.close();
    return false;
  } else if (op === "choosecontestmon") {
    // pokefirered/src/scrcmd.c:2010-2016
    ctx.mode = "native";
    ctx.status = "waiting";
    ctx.nativePoll = () => false;
    return true;
  } else if (op === "incrementgamestat") {
    // src/scrcmd.c:576-579, overworld.c:366-375, include/constants/game_stat.h:57
    const statId = tonumber(row[1]) ?? -1;
    if (statId >= 0 && statId < 52) {
      // package.loaded["src.core.game3.runtime"]
      const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
      if (session) {
        session.gameStats = session.gameStats ?? {};
        const cur = tonumber(session.gameStats[statId]) ?? 0;
        session.gameStats[statId] = Math.min(0xFFFFFF, cur + 1);
      }
    }
    return false;
  } else if (op === "checkpartymove") {
    // src/scrcmd.c:1777-1795
    const moveId = tonumber(row[1]) ?? 0;
    // package.loaded["src.core.game3.runtime"]
    const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
    Flags.setVar(store, ctx, Ctx.VAR_RESULT, 6);
    const party = (session && session.party) || seq();
    for (let i = 1; i <= 6; i++) {
      const mon = party[i];
      const sp = mon ? (tonumber(mon.species) ?? 0) : 0;
      if (sp === 0) break;
      if (!truthy(mon.isEgg) && !truthy(mon.egg) && Pokemon.knowsMove(mon, moveId)) {
        Flags.setVar(store, ctx, Ctx.VAR_RESULT, i - 1);
        Flags.setVar(store, ctx, 0x8004, sp);
        break;
      }
    }
    return false;
  } else if (op === "erasebox") {
    return false;
  } else {
    // package.loaded["src.core.game3.runtime"]
    const game = Runtime && Runtime._game;
    const commands = game && game.data && game.data.commands;
    const record = (commands != null && typeof commands === "object") ? commands[op] : undefined;
    const fn = (record != null && typeof record === "object" && truthy(record.fn)) ? record.fn : record;
    if (typeof fn === "function") {
      let okCall = true, res: any;
      try { res = fn(Ctx.modCtx(vm), ...unpack(row)); } catch (e) { okCall = false; res = e; }
      if (!okCall) {
        if (a.log) a.log("[game3] command " + tostring(op) + " failed: " + tostring(res));
        return false;
      }
      if (typeof res === "string" && vm.scripts && vm.scripts[res] != null) {
        jump(vm, res);
      } else if (res === "end") {
        vm.halt();
        return true;
      }
      return false;
    }
    if (PRET_NO_OPS[op]) return false;
    // Unknown / Tier C: skip
    if (a.log) a.log("[game3] skip op " + tostring(op));
    return false;
  }
};

// Lua: ops_a.lua:2249
const dispatch_base: DispatchFn = dispatch;

// Lua: ops_a.lua:2251 (the helper table handed to ops_rse handlers)
const H = {
  base: (vm: Vm, row: Row): any => dispatch_base(vm, row),
  jump,
  varGet: var_get,
  resolveText: resolve_text,
  textCtx: (vm: Vm): any => text_ctx_view(vm),
  showMessage: show_message,
  printDone: message_print_done,
};

// Lua: ops_a.lua:2261
dispatch = function (vm: Vm, row: Row): any {
  const layout = vm.ctx.specialLayout;
  if (layout && layout.family === "rse") {
    // OpsRse.HANDLERS[row.op] (src.core.game3.scripting.ops_rse) would take
    // the op with H; ops_rse has no file in the port.
    void H;
    throw new Error("NOT FAITHFUL: Emerald only (ops_rse handlers)");
  }
  return dispatch_base(vm, row);
};

// Lua: ops_a.lua:2268
function commandVanilla(vm: Vm): (_: any, name: any, hrow: any) => any {
  return (_: any, name: any, hrow: any): any => {
    if (hrow == null || typeof hrow !== "object") hrow = {};
    if (name != null && name !== hrow.op) {
      const copy: any = {};
      for (const [k, v] of pairs(hrow)) copy[k] = v;
      copy.op = name;
      hrow = copy;
    }
    return dispatch(vm, hrow);
  };
}

export const Ops = {
  // Lua: ops_a.lua:2281
  dispatch(vm: Vm, row: Row): any {
    if (!ModRuntime.wantsHook("script.command")) {
      return dispatch(vm, row);
    }
    return ModRuntime.call("script.command", commandVanilla(vm), Ctx.modCtx(vm), row.op, row);
  },

  // Lua: ops_a.lua:2288 (the RSE-aware dispatch, without the mod hook)
  dispatchUnhooked(vm: Vm, row: Row): any {
    return dispatch(vm, row);
  },

  // Lua: ops_a.lua:2290
  warpHoleDest: warp_hole_dest,
  // Lua: ops_a.lua:2291
  setMapLayout: set_map_layout,
  // Lua: ops_a.lua:2292
  brailleWidth: braille_width,
};

export default Ops;
