// Port of gen1recomp src/core/game3/battle/anim_port/g1_pret.lua (GPLv3 + additional terms; see LICENSE.md).
// Group 1 of the FRLG battle-animation port: pret helpers shared by g1_sprite,
// g1_task_base, g1_tasks(_b), g1_callbacks(_b) -- coords, palettes (gPlttBuffer
// stand-in) and palette fades.
//
// Port notes:
// - bit.* -> JS ops (LuaJIT's are 32-bit signed, as JS's; rshift by a constant
//   n >= 1 is `>>>`, P.rshift keeps LuaJIT's signed result with `| 0`).
// - package.loaded[...] / require / pcall(require) of anim, anim_vm, anim_tasks,
//   pic_coords, audio, se_ids, g1_pic_sizes and g1_templates are static imports,
//   used only inside functions (all of them are ported: Brian's "ok" path).
// - NOT FAITHFUL (ES module order): Brian runs `P.coord = P.bySide(P.coord)`
//   (AnimCoords.sideArg) and `Pal.faded = AnimCoords.idTable()` at require
//   time. Here no module-scope code reads an import: the bySide wrappers are
//   made on first call (lazyBySide) and Pal.faded / Pal.unfaded are created on
//   first read (getters). Same functions, same tables.
// - AnimVm is a class: hookVmReset patches AnimVm.prototype.reset (Brian's
//   AnimVm.reset is the method table entry the instances inherit).
// - Lua multiple returns are tuples: P.rgb555 -> [r, g, b], Pal.toLerp ->
//   [k, r, g, b], pic_tables -> [PicCoords, PicSizes].

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, truthy } from "../../../../../import/gen3/lua.ts";
import { ipairs, len, pairs, type LuaTable } from "../../../platform/lt.ts";
import { match } from "../../../platform/lpattern.ts";
import { Trig } from "../../trig.ts";
import { Audio } from "../../audio.ts";
import { SE } from "../../se_ids.ts";
import { AnimCoords } from "../anim_coords.ts";
import { Anim } from "../anim.ts";
import { AnimVm } from "../anim_vm.ts";
import { AnimTasks } from "../anim_tasks.ts";
import PicCoordsMod from "../pic_coords.ts";
import G1PicSizes from "./g1_pic_sizes.ts";
import G1Templates from "./g1_templates.ts";

// (Brian also requires anim_sprites here; g1_pret never uses it.)

const floor = Math.floor;

export const P: Record<string, any> = {};

P.ANIM_ATTACKER = 0;
P.ANIM_TARGET = 1;
P.X = 0;
P.Y = 1;
P.X_2 = 2;
P.Y_PIC_OFFSET = 3;
P.Y_PIC_OFFSET_DEFAULT = 4;
P.ATTR_HEIGHT = 0;
P.ATTR_WIDTH = 1;
P.ATTR_TOP = 2;
P.ATTR_BOTTOM = 3;
P.ATTR_LEFT = 4;
P.ATTR_RIGHT = 5;
P.ATTR_RAW_BOTTOM = 6;
P.DISPLAY_WIDTH = 240;
P.DISPLAY_HEIGHT = 160;
P.SOUND_PAN_ATTACKER = -64;
P.SOUND_PAN_TARGET = 63;

// Proxy keys arrive as strings: battler ids ("0".."3") back to numbers.
function proxyKey(k: string | symbol): any {
  if (typeof k === "string" && /^-?\d+$/.test(k)) return Number(k);
  return k;
}

// pokefirered/src/battle_anim_mons.c:31
P.COORDS = new Proxy({}, { get: (_t, k) => AnimCoords.coords(null, proxyKey(k)) ?? undefined });

// Lua: g1_pret.lua:33
P.s16 = function (vIn: unknown): number {
  let v = floor(tonumber(vIn) ?? 0) & 0xFFFF;
  if (v >= 0x8000) v = v - 0x10000;
  return v;
};

// Lua: g1_pret.lua:39
P.u16 = function (v: unknown): number {
  return floor(tonumber(v) ?? 0) & 0xFFFF;
};

// Lua: g1_pret.lua:43
P.u8 = function (v: unknown): number {
  return floor(tonumber(v) ?? 0) & 0xFF;
};

// Lua: g1_pret.lua:47
P.s8 = function (vIn: unknown): number {
  let v = floor(tonumber(vIn) ?? 0) & 0xFF;
  if (v >= 0x80) v = v - 0x100;
  return v;
};

// Lua: g1_pret.lua:53
P.asr = function (v: number, n: number): number {
  return floor(v) >> n;
};

// Lua: g1_pret.lua:57
P.cdiv = function (a: number, b: number): number {
  if (b === 0) return 0;
  const q = a / b;
  if (q >= 0) return floor(q);
  return -floor(-q);
};

// Lua: g1_pret.lua:64
P.cmod = function (a: number, b: number): number {
  if (b === 0) return 0;
  return a - P.cdiv(a, b) * b;
};

// Lua: g1_pret.lua:69 (bit.band, bor, bxor, rshift, lshift, arshift)
P.band = (a: number, b: number): number => a & b;
P.bor = (...xs: number[]): number => xs.reduce((acc, x) => acc | x, 0);
P.bxor = (a: number, b: number): number => a ^ b;
P.rshift = (a: number, n: number): number => (a >>> n) | 0;
P.lshift = (a: number, n: number): number => a << n;
P.arshift = (a: number, n: number): number => a >> n;

// Lua: g1_pret.lua:72 -- pokefirered/src/trig.c:514
P.Sin = function (index: number, amp: number): number {
  const v = Trig.SINE[(floor(index) & 0xFF) + 1]!;
  return P.s16((v * floor(amp)) >> 8);
};

// Lua: g1_pret.lua:77
P.Cos = function (index: number, amp: number): number {
  const v = Trig.SINE[(floor(index) & 0xFF) + 65]!;
  return P.s16((v * floor(amp)) >> 8);
};

// Lua: g1_pret.lua:82
P.gSine = function (i: number): number {
  return Trig.SINE[(floor(i) & 0xFF) + 1]!;
};

// Lua: g1_pret.lua:86
P.anim = function (): any {
  return Anim;
};

// Lua: g1_pret.lua:90
P.hookVmReset = function (): void {
  const V: any = AnimVm;
  const proto = V != null ? V.prototype : null;
  if (V == null || V._g1ResetHooked || proto == null || typeof proto.reset !== "function") return;
  V._g1ResetHooked = true;
  const orig = proto.reset;
  proto.reset = function (this: any, ...rest: any[]) {
    const r = orig.apply(this, rest);
    P.Pal.reset();
    P.Fade.active = false;
    P.Fade.mode = null;
    this.hwFade = null;
    P.Pal.flush();
    return r;
  };
};

// Lua: g1_pret.lua:106
P.vm = function (): any {
  const A = P.anim();
  P.hookVmReset();
  return A ? A._vm : null;
};

// Lua: g1_pret.lua:112
P.atk = function (vm?: any): any {
  vm = vm ?? P.vm();
  if (vm && vm.allyPair && vm.allyPair()) return vm.attackerId();
  const r = vm && vm.attackerSide ? vm.attackerSide() : null;
  return truthy(r) ? r : "player";
};

// Lua: g1_pret.lua:118
P.tgt = function (vm?: any): any {
  vm = vm ?? P.vm();
  if (vm && vm.allyPair && vm.allyPair()) return vm.targetId();
  const r = vm && vm.targetSide ? vm.targetSide() : null;
  return truthy(r) ? r : "enemy";
};

// Lua: g1_pret.lua:124
P.other = function (side: unknown): string {
  return side === "player" ? "enemy" : "player";
};

// Lua: g1_pret.lua:128
P.sideOf = function (vm: any, animBattler: unknown): any {
  if (tonumber(animBattler) === 0) return P.atk(vm);
  return P.tgt(vm);
};

// Lua: g1_pret.lua:134 -- pokefirered/src/battle_anim_mons.c:821
P.isOpponent = function (side: unknown): boolean {
  if (typeof side === "number") return AnimCoords.sideOf(side) !== "player";
  return side !== "player";
};

// Lua: g1_pret.lua:139
P.atkId = function (vm?: any): number {
  vm = vm ?? P.vm();
  const r = vm && vm.attackerId ? vm.attackerId() : null;
  return truthy(r) ? r : 0;
};

// Lua: g1_pret.lua:144
P.tgtId = function (vm?: any): number {
  vm = vm ?? P.vm();
  const r = vm && vm.targetId ? vm.targetId() : null;
  return truthy(r) ? r : 1;
};

// Lua: g1_pret.lua:150 -- pokefirered/src/battle_anim.c:617
P.spriteVisible = function (id: number): boolean {
  if (!AnimCoords.spritePresent(null, id)) return false;
  const p = P.anim().present(id);
  return p != null;
};

// Lua: g1_pret.lua:156
P.visibleIds = function (except1?: number | null, except2?: number | null): LuaTable {
  const out: LuaTable = [null];
  for (const [, id] of ipairs<number>(AnimCoords.ids())) {
    if (id !== except1 && id !== except2 && (id < 2 || P.spriteVisible(id))) out[len(out) + 1] = id;
  }
  return out;
};

// Lua: g1_pret.lua:164
P.species = function (vm: any, side: any): number | null {
  vm = vm ?? P.vm();
  if (!vm) return null;
  if (vm._speciesBySide && vm._speciesBySide[side] != null) return tonumber(vm._speciesBySide[side]) ?? null;
  if (vm.speciesForSide) return tonumber(vm.speciesForSide(side)) ?? null;
  return null;
};

let PicCoords: any = null;
let PicSizes: any = null;

// Lua: g1_pret.lua:173 -- returns [PicCoords, PicSizes] (false when absent)
function pic_tables(): [any, any] {
  if (PicCoords == null) {
    // pcall(require, "src.core.game3.battle.pic_coords") / g1_pic_sizes: both ported (ok path).
    const t: any = PicCoordsMod;
    PicCoords = (t != null && typeof t === "object") ? t : false;
    const t2: any = G1PicSizes;
    PicSizes = (t2 != null && typeof t2 === "object") ? t2 : false;
  }
  return [PicCoords, PicSizes];
}

// Lua: g1_pret.lua:184 -- pokefirered/src/battle_anim_mons.c:148
function y_delta(side: any, sp: number | null): number {
  const [pc] = pic_tables();
  if (!pc || sp == null) return 0;
  if (side === "player") return (pc.back && pc.back[sp]) ?? 0;
  return (pc.front && pc.front[sp]) ?? 0;
}

// Lua: g1_pret.lua:191
P.yDelta = function (vm: any, side: any): number {
  return y_delta(side, P.species(vm, side));
};

// Lua: g1_pret.lua:196 -- pokefirered/src/battle_anim_mons.c:217
function elevation(side: any, sp: number | null): number {
  const [pc] = pic_tables();
  if (side === "player" || !pc || sp == null) return 0;
  return (pc.elev && pc.elev[sp]) ?? 0;
}

// Lua: g1_pret.lua:203 -- pokefirered/src/battle_anim_mons.c:233
function final_y(side: any, sp: number | null, withOffset: boolean): number {
  let offset = y_delta(side, sp);
  if (side !== "player") offset = offset - elevation(side, sp);
  let y = (offset + P.COORDS[side].y) & 0xFF;
  if (withOffset) {
    if (side === "player") y = (y + 8) & 0xFF;
    if (y > P.DISPLAY_HEIGHT - 64 + 8) y = P.DISPLAY_HEIGHT - 64 + 8;
  }
  return y;
}

// Lua: g1_pret.lua:215 -- pokefirered/src/battle_anim_mons.c:105
P.coord = function (vm: any, side: any, coordType: number): number {
  const base = P.COORDS[side] ?? P.COORDS.enemy;
  if (coordType === P.X || coordType === P.X_2) return base.x;
  if (coordType === P.Y) return base.y;
  const sp = P.species(vm, side);
  return final_y(side, sp, coordType === P.Y_PIC_OFFSET);
};

P.coord2 = P.coord;

// Lua: g1_pret.lua:226 -- pokefirered/src/battle_anim_mons.c:305
P.yWithElevation = function (vm: any, side: any): number {
  let y = P.coord(vm, side, P.Y);
  if (side !== "player") {
    y = (y - elevation(side, P.species(vm, side))) & 0xFF;
  }
  return y;
};

// Lua: g1_pret.lua:235 -- pokefirered/src/battle_anim_mons.c:1999
P.attr = function (vm: any, side: any, attr: number): number {
  const sp = P.species(vm, side);
  const [, ps] = pic_tables();
  let packed: number | null = null;
  // Lua: ps and sp and (side == "player" and ps.back[sp] or ps.front[sp]) or (64 * 256 + 64)
  if (ps && sp != null) packed = ((side === "player" ? ps.back[sp] : null) ?? ps.front[sp]) ?? null;
  if (packed == null) packed = 64 * 256 + 64;
  const w = floor(packed / 256);
  const h = packed % 256;
  if (attr === P.ATTR_HEIGHT) return h;
  if (attr === P.ATTR_WIDTH) return w;
  if (attr === P.ATTR_LEFT) return P.coord(vm, side, P.X_2) - floor(w / 2);
  if (attr === P.ATTR_RIGHT) return P.coord(vm, side, P.X_2) + floor(w / 2);
  if (attr === P.ATTR_TOP) return P.coord(vm, side, P.Y_PIC_OFFSET) - floor(h / 2);
  if (attr === P.ATTR_BOTTOM) return P.coord(vm, side, P.Y_PIC_OFFSET) + floor(h / 2);
  if (attr === P.ATTR_RAW_BOTTOM) return P.coord(vm, side, P.Y) + 31 - y_delta(side, sp);
  return 0;
};

// Lua: g1_pret.lua:251
P.bySide = function (fn: (...a: any[]) => any): (...a: any[]) => any {
  return AnimCoords.sideArg(fn, 2);
};

// NOT FAITHFUL (ES module order): Brian wraps at require time; the wrapper is
// made on the first call here (see the header).
function lazyBySide(fn: (...a: any[]) => any): (...a: any[]) => any {
  let w: ((...a: any[]) => any) | null = null;
  return (...a: any[]) => (w ??= P.bySide(fn))(...a);
}
// Lua: g1_pret.lua:254
P.coord = lazyBySide(P.coord);
P.coord2 = P.coord;
P.yDelta = lazyBySide(P.yDelta);
P.yWithElevation = lazyBySide(P.yWithElevation);
P.attr = lazyBySide(P.attr);

// Lua: g1_pret.lua:261 -- pokefirered/src/battle_anim_mons.c:1908
P.subpriorityOf = function (side: any): number {
  return AnimCoords.subpriority(side);
};

// Lua: g1_pret.lua:266 -- pokefirered/src/battle_anim_mons.c:1924
P.bgPriorityOf = function (_side: any): number {
  return 2;
};

// Lua: g1_pret.lua:271 -- pokefirered/src/battle_anim.c:1160
P.adjustPanning = function (vm: any, pan: number): number {
  vm = vm ?? P.vm();
  if (vm && vm.adjustPanning) return vm.adjustPanning(pan);
  return pan;
};

// Lua: g1_pret.lua:277
P.playSe = function (se: unknown, pan?: number): void {
  if (se == null || se === false) return;
  // pcall(require, "src.core.game3.audio"): ported (ok path).
  const A: any = Audio;
  if (A && A.playSe) {
    try { A.playSe(se, { pan }); } catch { /* pcall */ }
  }
};

// Lua: g1_pret.lua:283
P.seId = function (name: string): any {
  // pcall(require, "src.core.game3.se_ids"): ported (ok path).
  const S: any = SE;
  return (S && S[name]) ?? null;
};

// Lua: g1_pret.lua:288
P.present = function (side: any): any {
  return P.anim().present(side);
};

// Lua: g1_pret.lua:292
function mon_in_bg(side: any): boolean {
  const p = P.present(side);
  return !!(p && p.z === 10);
}

// Lua: g1_pret.lua:297
function in_front_of(pri: number, sub: number, side: any): boolean {
  if (pri < 2) return true;
  if (pri > 2) return false;
  if (mon_in_bg(side)) return true;
  return sub < P.subpriorityOf(side);
}

// Lua: g1_pret.lua:304
P.zFor = function (priIn: unknown, subIn: unknown): number {
  const pri = tonumber(priIn) ?? 2;
  const sub = tonumber(subIn) ?? 0;
  if (AnimCoords.isDouble()) return AnimCoords.zFor(pri, sub, P.anim()._vm);
  const key = (3 - Math.max(0, Math.min(3, pri))) * 100 + (99 - Math.max(0, Math.min(99, sub)));
  const off = floor(key * 97 / 400);
  const fp = in_front_of(pri, sub, "player");
  const fe = in_front_of(pri, sub, "enemy");
  if (fp && fe) return 201 + off;
  if (fe) return 101 + off;
  return 1 + off;
};

// Lua: g1_pret.lua:317
P.updateZ = function (s: any): void {
  s.z = P.zFor(s._pri ?? 2, s.subpriority ?? 0);
};

// Lua: g1_pret.lua:322 -- pokefirered/src/battle_anim.c:349 (unused by Brian; kept)
function op_subpriority(vm: any, op: any): number {
  const raw = tonumber(op.subpriority) ?? 0;
  const side = (op.animBattler === "target") ? P.tgtId(vm) : P.atkId(vm);
  let sub: number;
  if (raw >= 64) sub = P.subpriorityOf(side) + (raw - 64); else sub = P.subpriorityOf(side) - raw;
  if (sub < 3) sub = 3;
  return sub;
}
P._opSubpriority = op_subpriority;

let Templates: any = null;
// Lua: g1_pret.lua:332
P.templates = function (): any {
  if (!Templates) Templates = G1Templates;
  return Templates;
};

// Lua: g1_pret.lua:337
P.tagInfo = function (vm: any, tag: any): any {
  vm = vm ?? P.vm();
  const pack = vm ? vm._pack : null;
  return (pack && pack.tags && tag != null && tag !== false) ? (pack.tags[tag] ?? null) : null;
};

// Lua: g1_pret.lua:343
P.tagIdToName = function (vm: any, idIn: unknown): string | null {
  const id = tonumber(idIn);
  if (id == null) return null;
  vm = vm ?? P.vm();
  const pack = vm ? vm._pack : null;
  if (!pack) return null;
  if (!pack._g1TagById) {
    const map: Record<number, string> = {};
    const scan = (s: any): void => {
      if (s == null || typeof s !== "object") return;
      for (const [, op] of ipairs<any>(s)) {
        if (op != null && typeof op === "object" && op.op === "loadspritegfx" && op.tag != null && op.tag_idx != null) {
          map[10000 + op.tag_idx] = op.tag;
        }
      }
    };
    for (const k of ["moves", "general", "special", "status", "labels"]) {
      const t = pack[k];
      if (t != null && typeof t === "object") {
        for (const [, s] of pairs(t)) scan(s);
      }
    }
    pack._g1TagById = map;
  }
  return pack._g1TagById[id] ?? null;
};

// NOT FAITHFUL (ES module order): Pal.faded / Pal.unfaded are created on first
// read (Brian: AnimCoords.idTable() at require time).
let _faded: LuaTable = null;
let _unfaded: LuaTable = null;
P.Pal = {
  get faded() { return (_faded ??= AnimCoords.idTable()); },
  set faded(v: LuaTable) { _faded = v; },
  get unfaded() { return (_unfaded ??= AnimCoords.idTable()); },
  set unfaded(v: LuaTable) { _unfaded = v; },
  remap: {} as Record<string, any>,
  backup: {} as Record<number, any>,
  tagsTouched: {} as Record<string, boolean>,
  dirty: false,
} as Record<string, any>;
const Pal = P.Pal;

const IDENT = { m: 1, r: 0, g: 0, b: 0 };

// Lua: g1_pret.lua:378 -- returns [r, g, b] (0..1)
P.rgb555 = function (cIn: unknown): [number, number, number] {
  const c = tonumber(cIn) ?? 0;
  return [(c & 31) / 31, ((c >>> 5) & 31) / 31, ((c >>> 10) & 31) / 31];
};

// Lua: g1_pret.lua:383
P.RGB = function (r: number, g: number, b: number): number {
  return r | (g << 5) | (b << 10);
};

// Lua: g1_pret.lua:387
Pal.get = function (key: any): any {
  return Pal.faded[key] ?? Pal.unfaded[key] ?? IDENT;
};

// Lua: g1_pret.lua:391
Pal.getUnfaded = function (key: any): any {
  return Pal.unfaded[key] ?? IDENT;
};

// Lua: g1_pret.lua:395
function lerp_state(u: any, coeff: number, color: number): any {
  const k = Math.max(0, Math.min(16, coeff)) / 16;
  const [r, g, b] = P.rgb555(color);
  return {
    m: u.m * (1 - k),
    r: u.r * (1 - k) + r * k,
    g: u.g * (1 - k) + g * k,
    b: u.b * (1 - k) + b * k,
  };
}

// Lua: g1_pret.lua:407 -- pokefirered/src/palette.c:779
Pal.blend = function (key: any, coeff: number, color: number): void {
  Pal.faded[key] = lerp_state(Pal.getUnfaded(key), coeff, color);
  Pal.dirty = true;
};

// Lua: g1_pret.lua:412
Pal.setFaded = function (key: any, st: any): void {
  Pal.faded[key] = st;
  Pal.dirty = true;
};

// Lua: g1_pret.lua:417
Pal.invert = function (key: any): void {
  const u = Pal.get(key);
  Pal.faded[key] = { m: -u.m, r: 1 - u.r, g: 1 - u.g, b: 1 - u.b };
  Pal.dirty = true;
};

// Lua: g1_pret.lua:423
Pal.restore = function (key: any): void {
  Pal.faded[key] = undefined;
  Pal.dirty = true;
};

// Lua: g1_pret.lua:428
Pal.copyFadedToUnfaded = function (key: any): void {
  Pal.unfaded[key] = Pal.get(key);
  Pal.dirty = true;
};

// Lua: g1_pret.lua:433
Pal.toBackup = function (slot: number, key: any): void {
  Pal.backup[slot] = Pal.getUnfaded(key);
};

// Lua: g1_pret.lua:437
Pal.fromBackup = function (slot: number, key: any): void {
  let st = Pal.backup[slot];
  if (st === IDENT) st = undefined;
  Pal.unfaded[key] = st;
  Pal.dirty = true;
};

// Lua: g1_pret.lua:444
Pal.reset = function (): void {
  Pal.faded = AnimCoords.idTable();
  Pal.unfaded = AnimCoords.idTable();
  Pal.remap = {};
  Pal.backup = {};
  Pal.dirty = true;
};

// Lua: g1_pret.lua:452 -- returns [k, r, g, b]
function to_lerp(st: any): [number, number, number, number] {
  if (!st || (st.m === 1 && st.r === 0 && st.g === 0 && st.b === 0)) return [0, 0, 0, 0];
  const k = 1 - st.m;
  if (k <= 0.0001) return [0, 0, 0, 0];
  return [k, Math.max(0, Math.min(1, st.r / k)), Math.max(0, Math.min(1, st.g / k)), Math.max(0, Math.min(1, st.b / k))];
}
Pal.toLerp = to_lerp;

// Lua: g1_pret.lua:460
Pal.flush = function (): void {
  if (!Pal.dirty) return;
  Pal.dirty = false;
  const A = P.anim();
  for (let id = 0; id <= 3; id++) {
    // Lua: (id < 2) and Anim.present(id) or rawget(Anim._present, id)
    let p = id < 2 ? A.present(id) : null;
    if (!p) p = A._present[id];
    const st = Pal.faded[id] ?? Pal.unfaded[id];
    if (p && (st || p._g1Blend)) {
      const [k, r, g, b] = to_lerp(st);
      p.blendCoeff = k;
      p.blendColor = [null, r, g, b];
      p._g1Blend = st ? true : undefined;
      p.palAffine = (st && st.m < 0) ? st : undefined;
      if (p.palAffine) p.blendCoeff = 0;
    }
  }
  const bst = Pal.faded.bg ?? Pal.unfaded.bg;
  A._bgPalAffine = (bst && bst.m < 0) ? bst : null;
  if (A._bgPalAffine) {
    A._bgBlend = null;
    A._g1BgBlend = null;
  } else if (bst || A._g1BgBlend) {
    const [k, r, g, b] = to_lerp(bst);
    if (k > 0) {
      A._bgBlend = { coeff: floor(k * 16 + 0.5), color: P.RGB(floor(r * 31 + 0.5), floor(g * 31 + 0.5), floor(b * 31 + 0.5)) };
      A._g1BgBlend = true;
    } else {
      A._bgBlend = null;
      A._g1BgBlend = null;
    }
  }
  A._tagBlend = A._tagBlend ?? {};
  const vm = A._vm;
  for (const [key, st] of pairs<any>(Pal.faded)) {
    if (st == null) continue; // (a nil'd field is absent in Lua)
    const tag = typeof key === "string" ? match(key, "^tag:(.+)$") : undefined;
    if (tag != null) {
      const [k, r, g, b] = to_lerp(st);
      const coeff = floor(k * 16 + 0.5);
      const color = P.RGB(floor(r * 31 + 0.5), floor(g * 31 + 0.5), floor(b * 31 + 0.5));
      if (coeff > 0) {
        A._tagBlend[tag] = { coeff, color };
      } else {
        A._tagBlend[tag] = undefined;
      }
      if (vm && vm.setTagBlend) vm.setTagBlend(tag, coeff, color);
      Pal.tagsTouched[tag as string] = true;
    }
  }
  for (const tag of Object.keys(Pal.tagsTouched)) {
    if (!Pal.faded["tag:" + tag]) {
      A._tagBlend[tag] = undefined;
      if (vm && vm.setTagBlend) vm.setTagBlend(tag, 0, 0);
      delete Pal.tagsTouched[tag];
    }
  }
};

// Lua: g1_pret.lua:518 -- pokefirered/src/battle_anim_mons.c:1315
P.palettesMask = function (vm: any, bg: boolean, atk: boolean, tgt: boolean, atkPartner: boolean, tgtPartner: boolean,
  anim1: boolean, anim2: boolean): LuaTable {
  const keys: LuaTable = [null];
  if (bg) keys[len(keys) + 1] = "bg";
  if (atk) keys[len(keys) + 1] = P.atkId(vm);
  if (tgt) keys[len(keys) + 1] = P.tgtId(vm);
  if (atkPartner) {
    const id = AnimCoords.partner(P.atkId(vm));
    if (P.spriteVisible(id)) keys[len(keys) + 1] = id;
  }
  if (tgtPartner) {
    const id = AnimCoords.partner(P.tgtId(vm));
    if (P.spriteVisible(id)) keys[len(keys) + 1] = id;
  }
  if (anim1) keys[len(keys) + 1] = "anim1";
  if (anim2) keys[len(keys) + 1] = "anim2";
  return keys;
};

// Lua: g1_pret.lua:537 -- pokefirered/src/battle_anim_normal.c:302
P.unpackSelected = function (vm: any, selectorIn: unknown): LuaTable {
  const selector = floor(tonumber(selectorIn) ?? 0);
  return P.palettesMask(vm, (selector & 1) !== 0, (selector & 2) !== 0, (selector & 4) !== 0,
    (selector & 8) !== 0, (selector & 16) !== 0, (selector & 32) !== 0, (selector & 64) !== 0);
};

// Lua: g1_pret.lua:543
P.blendPalettes = function (keys: LuaTable, coeff: number, color: number): void {
  for (const [, key] of ipairs(keys)) Pal.blend(key, coeff, color);
  Pal.flush();
};

P.Fade = { active: false } as Record<string, any>;
const Fade = P.Fade;

// Lua: g1_pret.lua:552 -- pokefirered/src/palette.c:151
P.beginNormalPaletteFade = function (keys: LuaTable, delayIn: number, startY: number, targetY: number, color: number): boolean {
  if (Fade.active) return false;
  Fade.mode = null;
  let delay = P.s8(delayIn);
  Fade.deltaY = 2;
  if (delay < 0) {
    Fade.deltaY = 2 + (-delay);
    delay = 0;
  }
  Fade.keys = keys;
  Fade.delayCounter = delay;
  Fade.delay = delay;
  Fade.y = startY;
  Fade.targetY = targetY;
  Fade.color = color;
  Fade.active = true;
  Fade.finishing = false;
  Fade.finishCounter = 0;
  Fade.toggle = 0;
  Fade.yDec = startY >= targetY;
  P.ensureFadeTicker();
  P.updatePaletteFade();
  return true;
};

// Lua: g1_pret.lua:578 -- pokefirered/src/palette.c:684
P.beginHardwarePaletteFade = function (blendCnt: number, delay: number, y: number, targetY: number, shouldReset: unknown): void {
  Fade.mode = "hw";
  Fade.blendCnt = P.u8(blendCnt);
  Fade.delayCounter = P.u8(delay);
  Fade.delay = P.u8(delay);
  Fade.y = P.u8(y);
  Fade.targetY = P.u8(targetY);
  Fade.active = true;
  Fade.shouldReset = ((tonumber(shouldReset) ?? 0) & 1) !== 0;
  Fade.hwFinishing = false;
  Fade.yDec = !(Fade.y < Fade.targetY);
  const vm = P.vm();
  if (vm) vm.hwFade = { cnt: Fade.blendCnt, y: Fade.y };
  P.ensureFadeTicker();
};

// Lua: g1_pret.lua:595 -- pokefirered/src/palette.c:701
function update_hw_fade(): void {
  if (Fade.delayCounter < Fade.delay) {
    Fade.delayCounter = Fade.delayCounter + 1;
  } else {
    Fade.delayCounter = 0;
    if (!Fade.yDec) {
      Fade.y = Fade.y + 1;
      if (Fade.y > Fade.targetY) {
        Fade.hwFinishing = true;
        Fade.y = Fade.y - 1;
      }
    } else {
      Fade.y = Fade.y - 1;
      if (Fade.y < Fade.targetY) {
        Fade.hwFinishing = true;
        Fade.y = Fade.y + 1;
      }
    }
    if (Fade.hwFinishing) {
      if (Fade.shouldReset) {
        Fade.blendCnt = 0;
        Fade.y = 0;
      }
      Fade.shouldReset = false;
    }
  }
  const vm = P.vm();
  if (vm) vm.hwFade = { cnt: Fade.blendCnt, y: Fade.y };
  if (Fade.hwFinishing) {
    Fade.hwFinishing = false;
    Fade.mode = null;
    Fade.blendCnt = 0;
    Fade.y = 0;
    Fade.active = false;
  }
}

// Lua: g1_pret.lua:633 -- pokefirered/src/palette.c:393
P.updatePaletteFade = function (): void {
  if (!Fade.active) return;
  if (Fade.mode === "hw") return update_hw_fade();
  if (Fade.finishing) {
    if (Fade.finishCounter === 4) {
      Fade.active = false;
      Fade.finishing = false;
      Fade.finishCounter = 0;
    } else {
      Fade.finishCounter = Fade.finishCounter + 1;
    }
    return;
  }
  if (Fade.toggle === 0) {
    if (Fade.delayCounter < Fade.delay) {
      Fade.delayCounter = Fade.delayCounter + 1;
      return;
    }
    Fade.delayCounter = 0;
  }
  for (const [, key] of ipairs(Fade.keys ?? [null])) {
    const isObj = key !== "bg" && key !== "anim1" && key !== "anim2";
    if (isObj === (Fade.toggle === 1)) Pal.blend(key, Fade.y, Fade.color);
  }
  Pal.flush();
  Fade.toggle = 1 - Fade.toggle;
  if (Fade.toggle === 0) {
    if (Fade.y === Fade.targetY) {
      Fade.keys = [null];
      Fade.finishing = true;
    } else {
      let v: number;
      if (!Fade.yDec) {
        v = Fade.y + Fade.deltaY;
        if (v > Fade.targetY) v = Fade.targetY;
      } else {
        v = Fade.y - Fade.deltaY;
        if (v < Fade.targetY) v = Fade.targetY;
      }
      Fade.y = v;
    }
  }
};

// Lua: g1_pret.lua:677
P.fadeActive = function (): boolean {
  return Fade.active === true;
};

// Lua: g1_pret.lua:681
function fade_ticker(t: any): void {
  P.updatePaletteFade();
  if (!Fade.active) P.destroyTask(t);
}

// Lua: g1_pret.lua:686
P.ensureFadeTicker = function (): void {
  // package.loaded["src.core.game3.battle.anim_tasks"]
  const T: any = AnimTasks;
  if (!T || !T._pool) return;
  for (let i = 1; i <= T.MAX; i++) {
    const t = T._pool[i];
    if (t.active && t._g1FadeTicker) return;
  }
  for (let i = 1; i <= T.MAX; i++) {
    const t = T._pool[i];
    if (!t.active) {
      if (T._clear) T._clear(t);
      t.active = true;
      t.name = "G1PaletteFade";
      t.priority = 0;
      t.func = fade_ticker;
      t._g1FadeTicker = true;
      t._uncounted = true;
      t._g1Skip = true;
      return;
    }
  }
};

// Lua: g1_pret.lua:709
P.destroyTask = function (t: any): void {
  const T: any = AnimTasks;
  if (T && (T.destroy || T._destroy)) {
    (T.destroy || T._destroy)(t);
  } else {
    t.active = false;
  }
};

// Lua: g1_pret.lua:718
P.setBldAlpha = function (vm: any, eva: number, evb: number): void {
  vm = vm ?? P.vm();
  if (vm) vm.bldAlpha = { eva, evb };
};

// Lua: g1_pret.lua:723
P.clearBld = function (vm: any): void {
  vm = vm ?? P.vm();
  if (vm) vm.bldAlpha = null;
};

export default P;
