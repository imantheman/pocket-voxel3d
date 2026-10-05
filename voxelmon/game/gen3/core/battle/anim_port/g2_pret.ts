// Port of gen1recomp src/core/game3/battle/anim_port/g2_pret.lua (GPLv3 + additional terms; see LICENSE.md).
// Group 2 of the FRLG battle-animation port: the pret kit the g2 modules are
// written on -- math, coords, mon handles, sprite.c animation / affine runners,
// the particle draw (effects blend5 / palrot / gray5 / remap_nearest), sprite
// creation, battle_anim_mons.c movers and task helpers.
//
// Port notes:
// - Lua `%` is mod() (floored) wherever an operand can be negative.
// - NOT FAITHFUL (ES module order): Brian takes `SINE = Trig.SINE` and wraps
//   P.coord / defaultY / yWithElevation / coordAttr with AnimCoords.sideArg at
//   require time; here SINE is read inside the functions and each sideArg
//   wrapper is made on its first call (lazySideArg). Same functions.
// - pcall(require, ...) of anim, pic_coords, ui, audio / se_ids, anim_tasks,
//   anim_callbacks, g1_pret: static imports (ported: Brian's ok path; his
//   pcalls around calls are kept). g2_templates and g2_mon_sizes are the
//   g2 group's own modules, imported by path.
// - P.mon's metatable (x/y/x2/y2/invisible accessors over the present, methods
//   by __index) is the class G2Mon: fixed keys become getters/setters, other
//   keys are plain fields, as rawset does.
// - Weak caches (SHEET_CACHE) are WeakMaps. Shaders are G.newShader(<effect>):
//   map -> remap_nearest, gray -> gray5, rot -> palrot, blend -> blend5; Brian's
//   send calls are unchanged (vec3s as runtime sequences). love.math.newTransform
//   is graphics.ts's Transform (the platform always has it: Brian's guard
//   dropped).
// - Lua multiple returns are tuples: rgb555 [r, g, b], current_blend [coeff,
//   r, g, b] ([0] for his lone 0), pic [PicCoords, MonSizes],
//   SetAverageBattlerPositions [x, y], mon_draw_center [cx, cy].
// - Ui.battlerPic returns [entry, form, ghost]: its first value is used.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, tonumber, tostring } from "../../../../../import/gen3/lua.ts";
import { ipairs, pairs, unpack, type LuaTable } from "../../../platform/lt.ts";
import { match } from "../../../platform/lpattern.ts";
import { random } from "../../../platform/rng.ts";
import { G, Transform, type Shader } from "../../../platform/graphics.ts";
import type { Image, Quad } from "../../../platform/image.ts";
import { Trig } from "../../trig.ts";
import { Audio } from "../../audio.ts";
import { SE } from "../../se_ids.ts";
import { AnimSprites } from "../anim_sprites.ts";
import { AnimPal } from "../anim_pal.ts";
import { AnimCoords } from "../anim_coords.ts";
import { Anim as AnimMod } from "../anim.ts";
import { AnimTasks } from "../anim_tasks.ts";
import { AnimCallbacks } from "../anim_callbacks.ts";
import PicCoordsMod from "../pic_coords.ts";
import { Ui } from "../ui.ts";
import G1Pret from "./g1_pret.ts";
import G2MonSizes from "./g2_mon_sizes.ts";
import G2Templates from "./g2_templates.ts";

const _pfxBlendOpts: Record<string, any> = { coeff: 0, color: 0 };

export const P: Record<string, any> = {};

const floor = Math.floor;

// Lua: g2_pret.lua:12
function trunc(x: number): number {
  if (x >= 0) return floor(x);
  return -floor(-x);
}
P.trunc = trunc;

// Lua: g2_pret.lua:18
P.div = function (a: number, b: number): number {
  if (b === 0) return 0;
  return trunc(a / b);
};

// Lua: g2_pret.lua:23
P.mod = function (a: number, b: number): number {
  if (b === 0) return 0;
  return a - trunc(a / b) * b;
};

// Lua: g2_pret.lua:28
P.s16 = function (vIn: number): number {
  let v = mod(floor(vIn), 65536);
  if (v >= 32768) v = v - 65536;
  return v;
};

// Lua: g2_pret.lua:34
P.u16 = function (v: number): number { return mod(floor(v), 65536); };
// Lua: g2_pret.lua:35
P.u8 = function (v: number): number { return mod(floor(v), 256); };

// Lua: g2_pret.lua:37
P.s8 = function (vIn: number): number {
  let v = mod(floor(vIn), 256);
  if (v >= 128) v = v - 256;
  return v;
};

// Lua: g2_pret.lua:43
P.asr = function (v: number, n: number): number { return floor(v / 2 ** n); };

// Lua: g2_pret.lua:46 -- pokefirered/src/math_util.c:4
P.Q88mul = function (x: number, y: number): number {
  return P.s16(P.div(P.s16(x) * P.s16(y), 256));
};

// Lua: g2_pret.lua:51 -- pokefirered/src/math_util.c:65
P.Q88inv = function (yIn: number): number {
  const y = P.s16(yIn);
  if (y === 0) return 0;
  return P.s16(P.div(0x10000, y));
};

// Lua: g2_pret.lua:58 -- pokefirered/src/trig.c:4 (SINE is read in each function; see the header)

// Lua: g2_pret.lua:60
P.sine = function (i: number): number {
  return Trig.SINE[mod(floor(i), 256) + 1]!;
};

// Lua: g2_pret.lua:64
P.Sin = function (i: number, amp: number): number {
  return P.s16(floor(amp * Trig.SINE[mod(floor(i), 256) + 1]! / 256));
};

// Lua: g2_pret.lua:68
P.Cos = function (i: number, amp: number): number {
  return P.s16(floor(amp * Trig.SINE[mod(floor(i) + 64, 256) + 1]! / 256));
};

// Lua: g2_pret.lua:72
P.ArcTan2 = function (x: number, y: number): number {
  return Trig.arcTan2(x, y);
};

// Lua: g2_pret.lua:76
P.ArcTan2Neg = function (x: number, y: number): number {
  return mod(-P.ArcTan2(x, y), 65536);
};

// Lua: g2_pret.lua:80 (love.math.random and math.random are both random())
P.Random = function (): number {
  return random(0, 65535);
};

P.ANIM_ATTACKER = 0;
P.ANIM_TARGET = 1;
P.COORD_X = 0;
P.COORD_Y = 1;
P.COORD_X_2 = 2;
P.COORD_Y_PIC_OFFSET = 3;
P.COORD_Y_PIC_OFFSET_DEFAULT = 4;
P.ATTR_HEIGHT = 0;
P.ATTR_WIDTH = 1;
P.ATTR_TOP = 2;
P.ATTR_BOTTOM = 3;
P.ATTR_LEFT = 4;
P.ATTR_RIGHT = 5;
P.ATTR_RAW_BOTTOM = 6;
P.DISPLAY_WIDTH = 240;
P.DISPLAY_HEIGHT = 160;

P.vm = null;

// Lua: g2_pret.lua:106
P.setVm = function (vm: any): any {
  if (vm) P.vm = vm;
  return P.vm;
};

// Lua: g2_pret.lua:111
P.atk = function (): any {
  const vm = P.vm;
  if (vm && vm.allyPair && vm.allyPair()) return vm.attackerId();
  const r = vm ? vm.attackerSide() : null;
  return (r != null && r !== false) ? r : "player";
};

// Lua: g2_pret.lua:117
P.tgt = function (): any {
  const vm = P.vm;
  if (vm && vm.allyPair && vm.allyPair()) return vm.targetId();
  const r = vm ? vm.targetSide() : null;
  return (r != null && r !== false) ? r : "enemy";
};

// Lua: g2_pret.lua:123
P.battler = function (which: any): any {
  if (which === 0 || which === "attacker") return P.atk();
  if (which === 1 || which === "target") return P.tgt();
  if (which === "player" || which === "enemy") return which;
  return null;
};

// Lua: g2_pret.lua:130
P.side = function (b: any): number {
  if (b === "player") return 0;
  return 1;
};

// Lua: g2_pret.lua:135
P.isPlayer = function (b: any): boolean { return b === "player"; };

// Lua: g2_pret.lua:137
P.args = function (): any {
  const vm = P.vm;
  if (vm && vm.args) return vm.args;
  P._args = P._args ?? {};
  return P._args;
};

// Lua: g2_pret.lua:144
P.arg = function (i: number): number {
  const a = P.args()[i];
  return tonumber(a) ?? 0;
};

// Lua: g2_pret.lua:149
P.setArg = function (i: number, v: any): void {
  P.args()[i] = v;
};

// Lua: g2_pret.lua:153
P.turn = function (): any {
  const vm = P.vm;
  const t = vm ? (vm._turn ?? vm.moveTurn) : null;
  return (t != null && t !== false) ? t : 0;
};

let PicCoords: any = null;
let MonSizes: any = null;

// Lua: g2_pret.lua:159 -- returns [PicCoords, MonSizes] (false when absent)
function pic(): [any, any] {
  if (PicCoords == null) {
    // pcall(require, "src.core.game3.battle.pic_coords") / g2_mon_sizes: ok path.
    PicCoords = PicCoordsMod ?? false;
    MonSizes = G2MonSizes ?? false;
  }
  return [PicCoords, MonSizes];
}

// Lua: g2_pret.lua:169
P.species = function (b: any): number | null {
  const vm = P.vm;
  if (!vm) return null;
  const sp = vm.speciesForSide ? vm.speciesForSide(b) : null;
  return tonumber(sp) ?? null;
};

// Proxy keys arrive as strings: battler ids ("0".."3") back to numbers.
function proxyKey(k: string | symbol): any {
  if (typeof k === "string" && /^-?\d+$/.test(k)) return Number(k);
  return k;
}

// Lua: g2_pret.lua:176
const BASE: any = new Proxy({}, { get: (_t, k) => AnimCoords.coords(null, proxyKey(k)) ?? undefined });
P.BASE = BASE;

// Lua: g2_pret.lua:180 -- pokefirered/src/battle_anim_mons.c:233
function final_y(b: any, sp: number | null, a3: boolean): number {
  const [pc] = pic();
  const base = BASE[b] ?? BASE.enemy;
  let offset = 0;
  if (pc && sp != null) {
    if (b === "player") {
      offset = (pc.back && pc.back[sp]) ?? 0;
    } else {
      offset = ((pc.front && pc.front[sp]) ?? 0) - ((pc.elev && pc.elev[sp]) ?? 0);
    }
  }
  let y = mod(offset + base[2], 256);
  if (a3) {
    if (b === "player") y = mod(y + 8, 256);
    if (y > P.DISPLAY_HEIGHT - 64 + 8) y = P.DISPLAY_HEIGHT - 64 + 8;
  }
  return y;
}

// Lua: g2_pret.lua:200 -- pokefirered/src/battle_anim_mons.c:105
P.coord = function (b: any, ctype: number): number {
  const base = BASE[b] ?? BASE.enemy;
  if (ctype === 0 || ctype === 2) return base[1];
  if (ctype === 1) return base[2];
  return final_y(b, P.species(b), ctype === 3);
};

// Lua: g2_pret.lua:207
P.defaultY = function (b: any): number {
  return P.coord(b, 4);
};

// Lua: g2_pret.lua:212 -- pokefirered/src/battle_anim_mons.c:305
P.yWithElevation = function (b: any): number {
  let y = P.coord(b, 1);
  if (b !== "player") {
    const [pc] = pic();
    const sp = P.species(b);
    if (pc && sp != null && pc.elev) y = y - (pc.elev[sp] ?? 0);
  }
  return mod(y, 256);
};

// Lua: g2_pret.lua:223 -- pokefirered/src/battle_anim_mons.c:1999
P.coordAttr = function (b: any, attr: number): number {
  const [pc, ms] = pic();
  const sp = P.species(b) ?? 0;
  let size = 0x88;
  let yoff = 0;
  if (ms) {
    const tbl = (b === "player") ? ms.back : ms.front;
    size = tbl[sp] ?? tbl[0] ?? 0x88;
  }
  if (pc) {
    const tbl = (b === "player") ? pc.back : pc.front;
    yoff = (tbl && tbl[sp]) ?? 0;
  }
  const w = floor(size / 16) * 8;
  const h = mod(size, 16) * 8;
  if (attr === 0) return h;
  if (attr === 1) return w;
  if (attr === 4) return P.coord(b, 2) - P.div(w, 2);
  if (attr === 5) return P.coord(b, 2) + P.div(w, 2);
  if (attr === 2) return P.coord(b, 3) - P.div(h, 2);
  if (attr === 3) return P.coord(b, 3) + P.div(h, 2);
  if (attr === 6) return P.coord(b, 1) + 31 - yoff;
  return 0;
};

// NOT FAITHFUL (ES module order): the sideArg wrapper is made on first call.
function lazySideArg(fn: (...a: any[]) => any, idx: number): (...a: any[]) => any {
  let w: ((...a: any[]) => any) | null = null;
  return (...a: any[]) => (w ??= AnimCoords.sideArg(fn, idx))(...a);
}
// Lua: g2_pret.lua:248
P.coord = lazySideArg(P.coord, 1);
P.defaultY = lazySideArg(P.defaultY, 1);
P.yWithElevation = lazySideArg(P.yWithElevation, 1);
P.coordAttr = lazySideArg(P.coordAttr, 1);

// Lua: g2_pret.lua:254 -- pokefirered/src/battle_anim_mons.c:1908
P.subpriorityOf = function (b: any): number {
  return AnimCoords.subpriority(b);
};

// Lua: g2_pret.lua:259 -- pokefirered/src/battle_anim_mons.c:1924
P.bgPriority = function (b: any): number {
  const vm = P.vm;
  const bp = vm ? vm._bgPrio : null;
  if (bp) {
    return bp[AnimCoords.bgPriorityRank(b)] ?? 2;
  }
  return 2;
};

// Lua: g2_pret.lua:269 -- pokefirered/src/battle_anim_mons.c:1934
P.bgPriorityRank = function (b: any): number {
  return AnimCoords.bgPriorityRank(b);
};

// Lua: g2_pret.lua:273
P.present = function (b: any): any {
  // pcall(require, "src.core.game3.battle.anim"): ok path.
  const A: any = AnimMod;
  if (!A) return null;
  return A.present(b);
};

// Lua: g2_pret.lua:279..311 -- MonMT (__index / __newindex) and MonMethods
export class G2Mon {
  [k: string]: any;
  _p: any;
  _side: any;
  _bxBase: number;
  _byBase: number;
  matA = 256;
  matB = 0;
  matC = 0;
  matD = 256;
  constructor(p: any, side: any, bxBase: number, byBase: number) {
    this._p = p;
    this._side = side;
    this._bxBase = bxBase;
    this._byBase = byBase;
  }
  // Lua: g2_pret.lua:282 (__index)
  get x2(): number { const p = this._p; return (p.ox ?? 0) - (p._g2bx ?? 0); }
  get y2(): number { const p = this._p; return (p.oy ?? 0) - (p._g2by ?? 0); }
  get x(): number { return this._bxBase + (this._p._g2bx ?? 0); }
  get y(): number { return this._byBase + (this._p._g2by ?? 0); }
  get invisible(): boolean { return this._p.visible === false; }
  // Lua: g2_pret.lua:292 (__newindex)
  set x2(v: number) { const p = this._p; p.ox = (p._g2bx ?? 0) + v; }
  set y2(v: number) { const p = this._p; p.oy = (p._g2by ?? 0) + v; }
  set x(v: number) {
    const p = this._p;
    const x2 = (p.ox ?? 0) - (p._g2bx ?? 0);
    p._g2bx = v - this._bxBase;
    p.ox = p._g2bx + x2;
  }
  set y(v: number) {
    const p = this._p;
    const y2 = (p.oy ?? 0) - (p._g2by ?? 0);
    p._g2by = v - this._byBase;
    p.oy = p._g2by + y2;
  }
  set invisible(v: unknown) { this._p.visible = !(v != null && v !== false); }

  // Lua: g2_pret.lua:314 -- pokefirered/src/battle_anim_mons.c:1174
  setRotScale(xScaleIn: number, yScaleIn: number, rotationIn: number): void {
    const p = this._p;
    const xScale = P.s16(xScaleIn);
    const yScale = P.s16(yScaleIn);
    const rotation = P.u16(rotationIn);
    const th = rotation / 65536 * 2 * Math.PI;
    const c = Math.cos(th), s = Math.sin(th);
    this.matA = trunc(xScale * c);
    this.matB = trunc(-xScale * s);
    this.matC = trunc(yScale * s);
    this.matD = trunc(yScale * c);
    p.sx = (xScale !== 0) ? (256 / xScale) : 0;
    p.sy = (yScale !== 0) ? (256 / yScale) : 0;
    p.rotation = -th;
    p._g2affine = true;
  }

  // Lua: g2_pret.lua:331
  resetRotScale(): void {
    const p = this._p;
    this.matA = 256; this.matB = 0; this.matC = 0; this.matD = 256;
    p.sx = 1;
    p.sy = 1;
    p.rotation = 0;
    p._g2affine = undefined;
  }

  // Lua: g2_pret.lua:340
  present(): any { return this._p; }
}

// Lua: g2_pret.lua:342
P.mon = function (b: any): G2Mon | null {
  if (b == null || b === false) return null;
  const p = P.present(b);
  if (!p) return null;
  const m = new G2Mon(p, b, P.coord(b, 0), P.defaultY(b));
  if (p._g2mat) {
    m.matA = p._g2mat[1]; m.matB = p._g2mat[2]; m.matC = p._g2mat[3]; m.matD = p._g2mat[4];
  }
  return m;
};

// Lua: g2_pret.lua:359
P.monById = function (which: any): G2Mon | null {
  return P.mon(P.battler(which));
};

// Lua: g2_pret.lua:363
P.setSpriteRotScale = function (m: G2Mon | null, xs: number, ys: number, rot: number): void {
  if (!m) return;
  m.setRotScale(xs, ys, rot);
  const p = m.present();
  p._g2mat = [null, m.matA, m.matB, m.matC, m.matD];
};

// Lua: g2_pret.lua:370
P.resetSpriteRotScale = function (m: G2Mon | null): void {
  if (!m) return;
  m.resetRotScale();
  m.present()._g2mat = undefined;
};

// Lua: g2_pret.lua:377 -- pokefirered/src/battle_anim_mons.c:1233
P.setYOffsetFromRotation = function (m: G2Mon | null): void {
  if (!m) return;
  let c = m.matC;
  if (c < 0) c = -c;
  m.y2 = P.asr(c, 3);
};

// Lua: g2_pret.lua:385 -- pokefirered/src/battle_anim_mons.c:1762
P.setYOffsetFromYScale = function (m: G2Mon | null): void {
  if (!m) return;
  const [pc] = pic();
  const sp = P.species(m._side);
  let yd = 64;
  if (pc && sp != null) {
    const tbl = (m._side === "player") ? pc.back : pc.front;
    yd = (tbl && tbl[sp]) ?? 0;
  }
  const v = 64 - yd * 2;
  const d = m.matD;
  let var2 = (d !== 0) ? P.div(v * 256, d) : 0;
  if (var2 > 128) var2 = 128;
  m.y2 = P.div(v - var2, 2);
};

// Lua: g2_pret.lua:401
function F(img: number, dur?: number, h?: unknown, v?: unknown): any {
  return { img, dur: dur ?? 0, h: h != null && h !== false, v: v != null && v !== false };
}
// Lua: g2_pret.lua:402
function J(t: number): any { return { jump: t }; }
// Lua: g2_pret.lua:403
function L(n: number): any { return { loop: n }; }
const END = { stop: true };
P.F = F; P.J = J; P.L = L; P.END = END;

// Lua: g2_pret.lua:407
function A(xs: number, ys: number, rot: number, dur: number): any { return { xs, ys, rot, dur }; }
// Lua: g2_pret.lua:408
function AJ(t: number): any { return { jump: t }; }
// Lua: g2_pret.lua:409
function AL(n: number): any { return { loop: n }; }
const AEND = { stop: true };
P.A = A; P.AJ = AJ; P.AL = AL; P.AEND = AEND;

P.DUMMY_ANIMS = [null, [null, END]];
P.DUMMY_AFFINE = [null, [null, AEND]];

P.TEMPLATES = {} as Record<string, any>;

// Lua: g2_pret.lua:418
P.affineCmds = function (name: string): any {
  P.tmpl("");
  const t = P._affineTables;
  return t ? t[name] : t;
};

// Lua: g2_pret.lua:424
P.tmpl = function (name: any): any {
  if (name == null || name === false) return null;
  if (!P._tmplLoaded) {
    P._tmplLoaded = true;
    // pcall(require, "src.core.game3.battle.anim_port.g2_templates")
    let t: any = null;
    let ok = true;
    try { t = G2Templates; } catch { ok = false; }
    if (ok && t != null && typeof t === "object") {
      for (const [k, v] of pairs(t)) {
        if (k === "_affine") {
          P._affineTables = v;
        } else if (P.TEMPLATES[k] == null) {
          P.TEMPLATES[k] = v;
        }
      }
    }
  }
  return P.TEMPLATES[name];
};

// Lua: g2_pret.lua:442
function cmd(s: any, idx: number): any {
  const a = s.anims ? s.anims[s.animNum + 1] : null;
  return (a ? a[idx + 1] : null) ?? END;
}

// Lua: g2_pret.lua:447
function flip_bits(s: any, h: unknown, v: unknown): void {
  s.fh = h != null && h !== false;
  s.fv = v != null && v !== false;
}

// Lua: g2_pret.lua:452
function set_frame(s: any, c: any): void {
  let dur = c.dur ?? 0;
  if (dur > 0) dur = dur - 1;
  s.animDelayCounter = dur;
  if (mod(s.affineMode, 2) === 0) flip_bits(s, c.h, c.v);
  s.tileNum = c.img;
}

// Lua: g2_pret.lua:461 -- pokefirered/src/sprite.c:905
function begin_anim(s: any): void {
  s.animCmdIndex = 0;
  s.animEnded = false;
  s.animLoopCounter = 0;
  const c = cmd(s, 0);
  if (c.img != null) {
    s.animBeginning = false;
    set_frame(s, c);
  }
}

// Lua: g2_pret.lua:474
function jump_to_top_of_loop(s: any): void {
  if (s.animLoopCounter !== 0) {
    s.animCmdIndex = s.animCmdIndex - 1;
    while (true) {
      const prev = cmd(s, s.animCmdIndex - 1);
      if (prev.loop != null) break;
      if (s.animCmdIndex === 0) break;
      s.animCmdIndex = s.animCmdIndex - 1;
    }
    s.animCmdIndex = s.animCmdIndex - 1;
  }
}

// Lua: g2_pret.lua:487
function run_anim_cmd(s: any): void {
  const c = cmd(s, s.animCmdIndex);
  if (c.loop != null) {
    if (s.animLoopCounter !== 0) {
      s.animLoopCounter = s.animLoopCounter - 1;
    } else {
      s.animLoopCounter = c.loop;
    }
    jump_to_top_of_loop(s);
    continue_anim(s);
  } else if (c.jump != null) {
    s.animCmdIndex = c.jump;
    set_frame(s, cmd(s, s.animCmdIndex));
  } else if (c.stop) {
    s.animCmdIndex = s.animCmdIndex - 1;
    s.animEnded = true;
  } else {
    set_frame(s, c);
  }
}

// Lua: g2_pret.lua:509 -- pokefirered/src/sprite.c:939
function continue_anim(s: any): void {
  if (s.animDelayCounter !== 0) {
    if (!s.animPaused) s.animDelayCounter = s.animDelayCounter - 1;
    const c = cmd(s, s.animCmdIndex);
    if (mod(s.affineMode, 2) === 0) flip_bits(s, c.h, c.v);
  } else if (!s.animPaused) {
    s.animCmdIndex = s.animCmdIndex + 1;
    run_anim_cmd(s);
  }
}

// Lua: g2_pret.lua:520
function acmd(s: any, idx: number): any {
  const st = s.aff;
  const a = s.affine ? s.affine[st.animNum + 1] : null;
  return (a ? a[idx + 1] : null) ?? AEND;
}

// Lua: g2_pret.lua:527 -- pokefirered/src/sprite.c:1292
function update_matrix(s: any): void {
  const st = s.aff;
  const xs = (st.xScale !== 0) ? P.div(0x10000, st.xScale) : 0;
  const ys = (st.yScale !== 0) ? P.div(0x10000, st.yScale) : 0;
  const th = st.rotation / 65536 * 2 * Math.PI;
  const c = Math.cos(th), sn = Math.sin(th);
  s.matA = trunc(xs * c);
  s.matB = trunc(-xs * sn);
  s.matC = trunc(ys * sn);
  s.matD = trunc(ys * c);
}

// Lua: g2_pret.lua:539
function apply_relative(s: any, f: any): void {
  const st = s.aff;
  st.xScale = P.s16(st.xScale + (f.xs ?? 0));
  st.yScale = P.s16(st.yScale + (f.ys ?? 0));
  const r = P.s8(f.rot ?? 0) * 256;
  st.rotation = P.u16(st.rotation + r);
  st.rotation = st.rotation - mod(st.rotation, 256);
  update_matrix(s);
}

// Lua: g2_pret.lua:549
function apply_frame(s: any, f: any): number {
  const dur = f.dur ?? 0;
  if (dur > 0) {
    apply_relative(s, f);
    return dur - 1;
  }
  const st = s.aff;
  st.xScale = P.s16(f.xs ?? 0);
  st.yScale = P.s16(f.ys ?? 0);
  st.rotation = P.u16(P.s8(f.rot ?? 0) * 256);
  apply_relative(s, { xs: 0, ys: 0, rot: 0 });
  return 0;
}

// Lua: g2_pret.lua:565
function affine_jump_to_top(s: any): void {
  const st = s.aff;
  if (st.loopCounter !== 0) {
    st.animCmdIndex = st.animCmdIndex - 1;
    while (true) {
      const prev = acmd(s, st.animCmdIndex - 1);
      if (prev.loop != null) break;
      if (st.animCmdIndex === 0) break;
      st.animCmdIndex = st.animCmdIndex - 1;
    }
    st.animCmdIndex = st.animCmdIndex - 1;
  }
}

// Lua: g2_pret.lua:580 -- pokefirered/src/sprite.c:1063
function begin_affine(s: any): void {
  if (mod(s.affineMode, 2) === 1) {
    const first = (s.affine && s.affine[1]) ? s.affine[1][1] : null;
    if (first && !first.stop) {
      const st = s.aff;
      st.animCmdIndex = 0;
      st.delayCounter = 0;
      st.loopCounter = 0;
      const f = acmd(s, 0);
      s.affineAnimBeginning = false;
      s.affineAnimEnded = false;
      st.delayCounter = apply_frame(s, f);
    }
  }
}

// Lua: g2_pret.lua:597 -- pokefirered/src/sprite.c:1080
function continue_affine(s: any): void {
  if (mod(s.affineMode, 2) !== 1) return;
  const st = s.aff;
  if (st.delayCounter !== 0) {
    if (!s.affineAnimPaused) {
      st.delayCounter = st.delayCounter - 1;
      apply_relative(s, acmd(s, st.animCmdIndex));
    }
  } else if (s.affineAnimPaused) {
    return;
  } else {
    st.animCmdIndex = st.animCmdIndex + 1;
    const c = acmd(s, st.animCmdIndex);
    if (c.loop != null) {
      if (st.loopCounter !== 0) {
        st.loopCounter = st.loopCounter - 1;
      } else {
        st.loopCounter = c.loop;
      }
      affine_jump_to_top(s);
      continue_affine(s);
    } else if (c.jump != null) {
      st.animCmdIndex = c.jump;
      st.delayCounter = apply_frame(s, acmd(s, st.animCmdIndex));
    } else if (c.stop) {
      s.affineAnimEnded = true;
      st.animCmdIndex = st.animCmdIndex - 1;
      apply_relative(s, { xs: 0, ys: 0, rot: 0 });
    } else {
      st.delayCounter = apply_frame(s, c);
    }
  }
}

// Lua: g2_pret.lua:632 -- pokefirered/src/sprite.c:897
P.animateSprite = function (s: any): void {
  if (s.animBeginning) begin_anim(s); else continue_anim(s);
  if (s.affineAnimBeginning) begin_affine(s); else continue_affine(s);
};

// Lua: g2_pret.lua:638 -- pokefirered/src/sprite.c:1336
P.startAnim = function (s: any, n?: number | null): void {
  s.animNum = floor(n ?? 0);
  s.animBeginning = true;
  s.animEnded = false;
};

// Lua: g2_pret.lua:645 -- pokefirered/src/sprite.c:1349
P.seekAnim = function (s: any, idx: number): void {
  const paused = s.animPaused;
  s.animCmdIndex = floor(idx) - 1;
  s.animDelayCounter = 0;
  s.animBeginning = false;
  s.animEnded = false;
  s.animPaused = false;
  continue_anim(s);
  if (s.animDelayCounter !== 0) s.animDelayCounter = s.animDelayCounter + 1;
  s.animPaused = paused;
};

// Lua: g2_pret.lua:657
function reset_affine_state(s: any, n?: number | null): void {
  s.aff = s.aff ?? {};
  const st = s.aff;
  st.animNum = n ?? 0;
  st.animCmdIndex = 0;
  st.delayCounter = 0;
  st.loopCounter = 0;
  st.xScale = 0x100;
  st.yScale = 0x100;
  st.rotation = 0;
}

// Lua: g2_pret.lua:670 -- pokefirered/src/sprite.c:1363
P.startAffineAnim = function (s: any, n?: number | null): void {
  reset_affine_state(s, floor(n ?? 0));
  s.affineAnimBeginning = true;
  s.affineAnimEnded = false;
};

// Lua: g2_pret.lua:676
P.changeAffineAnim = function (s: any, n?: number | null): void {
  s.aff.animNum = floor(n ?? 0);
  s.affineAnimBeginning = true;
  s.affineAnimEnded = false;
};

// Lua: g2_pret.lua:683 -- pokefirered/src/battle_anim_mons.c:1244
P.trySetRotScale = function (s: any, _recalc: unknown, xScaleIn: number, yScaleIn: number, rotation: number): void {
  if (mod(s.affineMode, 2) === 1) {
    s.affineAnimPaused = true;
    const xScale = P.s16(xScaleIn);
    const yScale = P.s16(yScaleIn);
    const th = P.u16(rotation) / 65536 * 2 * Math.PI;
    const c = Math.cos(th), sn = Math.sin(th);
    s.matA = trunc(xScale * c);
    s.matB = trunc(-xScale * sn);
    s.matC = trunc(yScale * sn);
    s.matD = trunc(yScale * c);
  }
};

// Lua: g2_pret.lua:697
P.tryResetAffine = function (s: any): void {
  P.trySetRotScale(s, true, 0x100, 0x100, 0);
  s.affineAnimPaused = false;
};

// Lua: g2_pret.lua:702
P.setMatrix = function (s: any, a: number, b: number, c: number, d: number): void {
  s.matA = a; s.matB = b; s.matC = c; s.matD = d;
};

// Lua: g2_pret.lua:706
P.zFor = function (prioIn?: number | null, subIn?: number | null): number {
  const prio = prioIn ?? 2;
  const sub = subIn ?? 0;
  if (prio < 2) {
    return 250 + (2 - prio) * 20 + (255 - sub) / 64;
  } else if (prio > 2) {
    return 2 + (255 - sub) / 64;
  }
  if (sub < 30) {
    return 201 + (30 - sub) / 2;
  } else if (sub < 40) {
    return 101 + (40 - sub) / 2;
  }
  return 10 + (255 - sub) / 4;
};

// Lua: g2_pret.lua:722
P.sync = function (s: any): void {
  s.ox = s.x2;
  s.oy = s.y2;
  s.visible = !s.invisible;
  s.z = P.zFor(s.oamPriority, s.subpriority);
  s._pz = true;
};

// Lua: g2_pret.lua:732 (a weak-keyed table)
const SHEET_CACHE = new WeakMap<Image, Map<number | string, Quad>>();

// Lua: g2_pret.lua:734
function tag_info(tag: any): any {
  const vm = P.vm;
  let pack = vm ? vm._pack : null;
  if (!pack) {
    // pcall(require, "src.core.game3.battle.anim"): ok path.
    const Am: any = AnimMod;
    pack = Am ? Am._pack : null;
  }
  const t = (pack && pack.tags) ? pack.tags[tag] : null;
  return t;
}
P.tagInfo = tag_info;

// Lua: g2_pret.lua:746
function quad_for(img: Image, sx: number, sy: number, w: number, h: number): Quad {
  const [iw, ih] = img.getDimensions();
  // Numeric key for whole-pixel rects (13+13+10+10 bits), string otherwise.
  let key: number | string;
  if (sx >= 0 && sx < 8192 && sy >= 0 && sy < 8192 && w >= 0 && w < 1024 && h >= 0 && h < 1024
      && sx % 1 === 0 && sy % 1 === 0 && w % 1 === 0 && h % 1 === 0) {
    key = ((sx * 8192 + sy) * 1024 + w) * 1024 + h;
  } else {
    key = tostring(sx) + ":" + tostring(sy) + ":" + tostring(w) + ":" + tostring(h);
  }
  let c = SHEET_CACHE.get(img);
  if (!c) { c = new Map(); SHEET_CACHE.set(img, c); }
  let q = c.get(key);
  if (!q) {
    q = G.newQuad(sx, sy, w, h, iw, ih);
    c.set(key, q);
  }
  return q;
}

const SHADERS: Record<string, Shader | false> = {};

// Lua: g2_pret.lua:768..833 -- BLEND_SRC / ROT_SRC / GRAY_SRC / MAP_SRC: effects
// blend5 / palrot / gray5 / remap_nearest (platform/effects).
const BLEND_SRC = "blend5";
const ROT_SRC = "palrot";
const GRAY_SRC = "gray5";
const MAP_SRC = "remap_nearest";

// Lua: g2_pret.lua:835
function shader(name: string, src: string): Shader | false {
  if (SHADERS[name] == null) {
    // (`love.graphics.newShader` always exists here.)
    try { SHADERS[name] = G.newShader(src); } catch { SHADERS[name] = false; }
  }
  return SHADERS[name]!;
}

// Lua: g2_pret.lua:847 -- returns [r, g, b] (5-bit)
function rgb555(cIn: unknown): [number, number, number] {
  const c = tonumber(cIn) ?? 0;
  return [mod(c, 32), mod(floor(c / 32), 32), mod(floor(c / 1024), 32)];
}
P.rgb555 = rgb555;

// Lua: g2_pret.lua:853 -- returns [coeff, r, g, b] ([0] when none)
function current_blend(s: any): [number, number?, number?, number?] {
  if (s.palBlend && (s.palBlend[1] ?? 0) > 0) {
    const [r, g, b] = rgb555(s.palBlend[2]);
    return [s.palBlend[1], r, g, b];
  }
  let tb: any = null;
  const vm = P.vm;
  if (vm && vm._tagBlend) tb = vm._tagBlend[s.tag];
  if (!tb) {
    // pcall(require, "src.core.game3.battle.anim"): ok path.
    const Am: any = AnimMod;
    tb = (Am && Am._tagBlend) ? Am._tagBlend[s.tag] : null;
  }
  if (tb && (tb.coeff ?? 0) > 0) {
    const [r, g, b] = rgb555(tb.color);
    return [tb.coeff, r, g, b];
  }
  return [0];
}

P.palRot = {} as Record<string, any>;
P.tagFx = {} as Record<string, any>;

// Lua: g2_pret.lua:875
P.tagState = function (tag: any): any {
  const vm = P.vm;
  const key = vm ? vm.loadedTags : null;
  if (P._tagKey !== key) {
    P._tagKey = key;
    P.tagFx = {};
  }
  let st = P.tagFx[tag];
  if (!st) {
    st = {};
    P.tagFx[tag] = st;
  }
  return st;
};

// Lua: g2_pret.lua:890
P.tagFxFor = function (tag: any): any {
  if (tag == null || tag === false) return null;
  const vm = P.vm;
  if (P._tagKey !== (vm ? vm.loadedTags : null)) return null;
  return P.tagFx[tag];
};

// Lua: g2_pret.lua:897
P.palRotState = function (tag: any): any {
  const vm = P.vm;
  const key = vm ? vm.loadedTags : null;
  if (P._palKey !== key) {
    P._palKey = key;
    P.palRot = {};
  }
  let st = P.palRot[tag];
  if (!st) {
    st = { rot: 0, lo: 1, hi: 8 };
    P.palRot[tag] = st;
  }
  return st;
};

// Lua: g2_pret.lua:912
P.palRotateFor = function (tag: any): any {
  if (tag == null || tag === false) return null;
  const vm = P.vm;
  if (P._palKey !== (vm ? vm.loadedTags : null)) return null;
  const st = P.palRot[tag];
  if (st && st.cols && st.rot !== 0) return st;
  return null;
};

// Lua: g2_pret.lua:921
function draw_pret(s: any, vm: any): void {
  if (s.callback !== runner) {
    s.customDraw = null;
    return;
  }
  if (s.invisible || !s.image) return;
  let img: Image = s.image;
  const w = s.w, h = s.h;
  const iw = img.getWidth();
  const tile = floor(s.tileNum ?? 0) + floor(s.tileBase ?? 0);
  const x = floor(s.x + s.x2 + 0.5);
  const y = floor(s.y + s.y2 + 0.5);
  if (s.x + s.x2 < -128 || s.x + s.x2 > 368 || s.y + s.y2 < -128 || s.y + s.y2 > 288) return;

  let alpha = s._drawAlpha;
  if (alpha == null) {
    alpha = s.alpha ?? 1;
    if (s.objBlend) {
      const ba = vm ? vm.bldAlpha : null;
      if (ba) {
        alpha = Math.min(1, (tonumber(ba.eva ?? ba[1]) ?? 16) / 16);
      }
    }
  }
  if (s.alphaOverride != null && s.alphaOverride !== false) alpha = s.alphaOverride;

  let sh: Shader | false | null = null;
  const [coeff, br, bg, bb] = current_blend(s);
  const pr = s.palRotate ?? P.palRotateFor(s.tag);
  const tfx = P.tagFxFor(s.tag);
  const pmap = s.palMap;
  _pfxBlendOpts.coeff = coeff;
  _pfxBlendOpts.color = AnimPal.pack(br ?? 0, bg ?? 0, bb ?? 0);
  _pfxBlendOpts.gray = ((tfx && tfx.gray) || s.gray) ? true : undefined;
  const pimg = AnimPal.begin(s, img, _pfxBlendOpts);
  if (pimg) {
    img = pimg;
  } else if (pmap) {
    sh = shader("map", MAP_SRC);
    if (sh) {
      const shm = sh;
      try {
        shm.send("src", ...unpack(pmap.src));
        shm.send("dst", ...unpack(pmap.dst));
      } catch { /* pcall */ }
    }
  } else if ((tfx && tfx.gray) || s.gray) {
    sh = shader("gray", GRAY_SRC);
  } else if (pr) {
    sh = shader("rot", ROT_SRC);
    if (sh) {
      const shr = sh;
      try {
        shr.send("rot", pr.rot ?? 0);
        shr.send("lo", pr.lo ?? 1);
        shr.send("hi", pr.hi ?? 8);
        shr.send("count", (pr.hi ?? 8) - (pr.lo ?? 1) + 1);
        shr.send("cols", ...unpack(pr.cols));
      } catch { /* pcall */ }
    }
  } else if (coeff != null && coeff > 0) {
    sh = shader("blend", BLEND_SRC);
    if (sh) {
      const shb = sh;
      try {
        shb.send("coeff", coeff);
        shb.send("target", [null, br, bg, bb]);
      } catch { /* pcall */ }
    }
  }

  G.push();
  G.translate(x, y);
  if (mod(s.affineMode, 2) === 1) {
    const a = (s.matA ?? 256) / 256, b = (s.matB ?? 0) / 256, c = (s.matC ?? 0) / 256, d = (s.matD ?? 256) / 256;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-6) {
      G.pop();
      return;
    }
    const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
    // (love.math.newTransform always exists here.)
    const t: Transform = s._g2xf ?? new Transform();
    s._g2xf = t;
    t.setMatrix(ia, ib, 0, 0, ic, id, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    G.applyTransform(t);
  } else {
    const fh = (s.fh && !s.pHFlip) || (!s.fh && s.pHFlip);
    const fv = (s.fv && !s.pVFlip) || (!s.fv && s.pVFlip);
    G.scale(fh ? -1 : 1, fv ? -1 : 1);
  }
  if (sh) G.setShader(sh);
  G.setColor(1, 1, 1, alpha);
  const tpr = Math.max(1, floor(iw / 8));
  const fw = floor(w / 8);
  const ih = img.getHeight();
  if (iw === w && mod(tile, fw) === 0) {
    const sy = floor(tile / fw) * 8;
    if (sy < ih) {
      G.draw(img, quad_for(img, 0, sy, w, h), -w / 2, -h / 2);
    }
  } else {
    for (let r = 0; r <= floor(h / 8) - 1; r++) {
      for (let cc = 0; cc <= fw - 1; cc++) {
        const ti = tile + r * fw + cc;
        const sx = mod(ti, tpr) * 8;
        const sy = floor(ti / tpr) * 8;
        if (sy < ih) {
          G.draw(img, quad_for(img, sx, sy, 8, 8), -w / 2 + cc * 8, -h / 2 + r * 8);
        }
      }
    }
  }
  if (sh || pimg) G.setShader();
  G.pop();
  G.setColor(1, 1, 1, 1);
}
P.drawPret = draw_pret;

// Lua: g2_pret.lua:1038
function clear_pret(s: any): void {
  s.pret = null;
  s.pcb = null;
  s.customDraw = null;
  s.stored = null;
  s.anims = null;
  s.affine = null;
  s.aff = null;
  s.palRotate = null;
  s.palBlend = null;
  s.palMap = null;
  s.gray = null;
  s.objBlend = null;
  s.alphaOverride = null;
  s.g2 = null;
  s.tileBase = null;
  s._g2xf = null;
}

// Lua: g2_pret.lua:1058 -- pokefirered/src/battle_anim.c:250
P.destroy = function (s: any): void {
  if (!s) return;
  clear_pret(s);
  AnimSprites.release(s);
};

// Lua: g2_pret.lua:1064
P.alive = function (s: any): boolean {
  return !!(s && s.active && s.callback === runner);
};

// Lua: g2_pret.lua:1068
function runner(s: any): void {
  if (s.pcb) s.pcb(s);
  if (s.active && s.callback === runner) {
    P.animateSprite(s);
    P.sync(s);
  }
}
P.runner = runner;

// Lua: g2_pret.lua:1077
function init_pret(s: any, def: any, x?: number | null, y?: number | null, sub?: number | null): void {
  s.pret = true;
  s.x = x ?? 0;
  s.y = y ?? 0;
  s.x2 = 0;
  s.y2 = 0;
  s.ox = 0;
  s.oy = 0;
  s.invisible = false;
  s.pHFlip = false;
  s.pVFlip = false;
  s.hFlip = false;
  s.vFlip = false;
  s.fh = false;
  s.fv = false;
  s.rotation = 0;
  s.scaleX = 1;
  s.scaleY = 1;
  s.alpha = 1;
  for (let i = 0; i <= 7; i++) s.data[i] = 0;
  s.g2 = {};
  s.w = (def ? def.w : null) ?? s.w ?? 32;
  s.h = (def ? def.h : null) ?? s.h ?? 32;
  s._baseW = s.w;
  s._baseH = s.h;
  s.anims = (def ? def.anims : null) ?? P.DUMMY_ANIMS;
  s.affine = (def ? def.affine : null) ?? P.DUMMY_AFFINE;
  s.affineMode = (def ? def.affineMode : null) ?? 0;
  s.objBlend = (def && def.blend) || false;
  s.oamPriority = (def ? def.priority : null) ?? 2;
  s.subpriority = sub ?? 0;
  s.tileNum = 0;
  s.tileBase = 0;
  s.animNum = 0;
  s.animCmdIndex = 0;
  s.animDelayCounter = 0;
  s.animBeginning = true;
  s.animEnded = false;
  s.animPaused = false;
  s.animLoopCounter = 0;
  reset_affine_state(s, 0);
  s.affineAnimBeginning = true;
  s.affineAnimEnded = false;
  s.affineAnimPaused = false;
  s.matA = 256; s.matB = 0; s.matC = 0; s.matD = 256;
  s.blendMode = "alpha";
  s.callback = runner;
  s.customDraw = draw_pret;
  if (def && def.tag != null && !s.image) {
    const ti = tag_info(def.tag);
    if (ti) s.image = ti.image;
  }
}

// Lua: g2_pret.lua:1131
function op_subpriority(op: any): number {
  const raw = tonumber(op ? op.subpriority : null) ?? 0;
  const b = (op && op.animBattler === "target") ? P.tgt() : P.atk();
  let v: number;
  if (raw >= 64) v = raw - 64; else v = -raw;
  let sub = P.subpriorityOf(b) + v;
  if (sub < 3) sub = 3;
  return sub;
}
P.opSubpriority = op_subpriority;

// Lua: g2_pret.lua:1143 -- pokefirered/src/battle_anim.c:349
P.enter = function (s: any, cb: (s: any) => void): void {
  const vm = s._vm ?? P.vm;
  P.setVm(vm);
  let def = P.tmpl(s.template);
  if (!def) {
    def = { w: s._baseW ?? s.w ?? 32, h: s._baseH ?? s.h ?? 32, tag: s.tag };
  }
  const op = s._op;
  const args = s._args ?? (op ? op.args : null) ?? [null];
  const ga = P.args();
  for (const [i, v] of ipairs(args)) ga[i - 1] = tonumber(v) ?? 0;
  const tb = P.tgt();
  init_pret(s, def, P.coord(tb, 2), P.coord(tb, 3), op_subpriority(op));
  s.pcb = cb;
  cb(s);
  if (s.active && s.callback === runner) {
    P.animateSprite(s);
    P.sync(s);
  }
};

// Lua: g2_pret.lua:1165 -- pokefirered/src/sprite.c:494
P.createSprite = function (name: string, x: number, y: number, sub: number | null | undefined, andAnimate?: unknown,
  counted?: unknown, cbOverride?: any): any {
  const def = P.tmpl(name);
  if (!def) return null;
  let img: any = null;
  const ti = def.tag != null ? tag_info(def.tag) : null;
  if (ti) img = ti.image;
  const s = AnimSprites.acquire({ x, y, image: img, tag: def.tag, template: name, w: def.w, h: def.h });
  if (!s) return null;
  s._vm = P.vm;
  s._g4counted = (counted != null && counted !== false) ? true : undefined;
  init_pret(s, def, x, y, sub);
  let own: any = def.cbName != null ? P.CB[def.cbName] : null;
  const hasOverride = cbOverride !== undefined && cbOverride !== null;
  if (hasOverride) own = cbOverride;
  if (!hasOverride && !own && def.cbName != null && def.cbName !== "SpriteCallbackDummy") {
    const fn = AnimCallbacks.get(def.cbName);
    const ga = P.args();
    const a: LuaTable = [null];
    for (let i = 0; i <= 7; i++) a[i + 1] = ga[i] ?? 0;
    s._args = a;
    s._cbName = def.cbName;
    s._op = { template: name, args: a, animBattler: "target", subpriority: 0, callback: def.cbName };
    s.customDraw = null;
    s.pret = null;
    s.callback = fn;
    s.ox = 0;
    s.oy = 0;
    s._baseW = def.w;
    s._baseH = def.h;
    if (andAnimate != null && andAnimate !== false && fn) fn(s);
    return s;
  }
  s.pcb = own || null;
  if (andAnimate != null && andAnimate !== false) {
    if (s.pcb) s.pcb(s);
    if (s.active && s.callback === runner) {
      P.animateSprite(s);
      P.sync(s);
    }
  } else {
    P.sync(s);
  }
  return s;
};

P.CB = {} as Record<string, any>;

// Lua: g2_pret.lua:1210
P.setCallback = function (s: any, fn: any): void {
  s.pcb = fn;
};

// Lua: g2_pret.lua:1214
P.storeCallback = function (s: any, fn: any): void {
  s.stored = fn;
};

// Lua: g2_pret.lua:1218
P.runStored = function (s: any): void {
  s.pcb = s.stored;
};

// Lua: g2_pret.lua:1223 -- pokefirered/src/battle_anim_mons.c:521
P.WaitAnimForDuration = function (s: any): void {
  if (s.data[0] > 0) {
    s.data[0] = s.data[0] - 1;
  } else {
    P.runStored(s);
  }
};

// Lua: g2_pret.lua:1231
P.DestroyAnimSprite = function (s: any): void { P.destroy(s); };
P.DestroySpriteAndMatrix = P.DestroyAnimSprite;

// Lua: g2_pret.lua:1234
P.RunStoredCallbackWhenAnimEnds = function (s: any): void {
  if (s.animEnded) P.runStored(s);
};

// Lua: g2_pret.lua:1238
P.RunStoredCallbackWhenAffineAnimEnds = function (s: any): void {
  if (s.affineAnimEnded) P.runStored(s);
};

// Lua: g2_pret.lua:1243 -- pokefirered/src/battle_anim_mons.c:412
P.TranslateSpriteInCircle = function (s: any): void {
  const d = s.data;
  if (d[3] !== 0) {
    s.x2 = P.Sin(d[0], d[1]);
    s.y2 = P.Cos(d[0], d[1]);
    d[0] = d[0] + d[2];
    if (d[0] >= 0x100) d[0] = d[0] - 0x100; else if (d[0] < 0) d[0] = d[0] + 0x100;
    d[3] = d[3] - 1;
  } else {
    P.runStored(s);
  }
};

// Lua: g2_pret.lua:1257 -- pokefirered/src/battle_anim_mons.c:433
P.TranslateSpriteInGrowingCircle = function (s: any): void {
  const d = s.data;
  if (d[3] !== 0) {
    const amp = P.asr(d[5], 8) + d[1];
    s.x2 = P.Sin(d[0], amp);
    s.y2 = P.Cos(d[0], amp);
    d[0] = d[0] + d[2];
    d[5] = P.s16(d[5] + d[4]);
    if (d[0] >= 0x100) d[0] = d[0] - 0x100; else if (d[0] < 0) d[0] = d[0] + 0x100;
    d[3] = d[3] - 1;
  } else {
    P.runStored(s);
  }
};

// Lua: g2_pret.lua:1273 -- pokefirered/src/battle_anim_mons.c:486
P.TranslateSpriteInEllipse = function (s: any): void {
  const d = s.data;
  if (d[3] !== 0) {
    s.x2 = P.Sin(d[0], d[1]);
    s.y2 = P.Cos(d[0], d[4]);
    d[0] = d[0] + d[2];
    if (d[0] >= 0x100) d[0] = d[0] - 0x100; else if (d[0] < 0) d[0] = d[0] + 0x100;
    d[3] = d[3] - 1;
  } else {
    P.runStored(s);
  }
};

// Lua: g2_pret.lua:1287 -- pokefirered/src/battle_anim_mons.c:562
P.TranslateSpriteLinear = function (s: any): void {
  const d = s.data;
  if (d[0] > 0) {
    d[0] = d[0] - 1;
    s.x2 = s.x2 + d[1];
    s.y2 = s.y2 + d[2];
  } else {
    P.runStored(s);
  }
};

// Lua: g2_pret.lua:1299 -- pokefirered/src/battle_anim_mons.c:576
P.TranslateSpriteLinearFixedPoint = function (s: any): void {
  const d = s.data;
  if (d[0] > 0) {
    d[0] = d[0] - 1;
    d[3] = P.s16(d[3] + d[1]);
    d[4] = P.s16(d[4] + d[2]);
    s.x2 = P.asr(d[3], 8);
    s.y2 = P.asr(d[4], 8);
  } else {
    P.runStored(s);
  }
};

// Lua: g2_pret.lua:1313 -- pokefirered/src/battle_anim_mons.c:651
P.TranslateSpriteLinearAndFlicker = function (s: any): void {
  const d = s.data;
  if (d[0] > 0) {
    d[0] = d[0] - 1;
    s.x2 = P.asr(d[2], 8);
    d[2] = P.s16(d[2] + d[1]);
    s.y2 = P.asr(d[4], 8);
    d[4] = P.s16(d[4] + d[3]);
    if (d[5] !== 0 && P.mod(d[0], d[5]) === 0) {
      s.invisible = !s.invisible;
    }
  } else {
    P.runStored(s);
  }
};

// Lua: g2_pret.lua:1330 -- pokefirered/src/battle_anim_mons.c:735
P.SetAnimSpriteInitialXOffset = function (s: any, xOffset: number): void {
  const ax = P.coord(P.atk(), 0);
  const tx = P.coord(P.tgt(), 0);
  if (ax > tx) {
    s.x = s.x - xOffset;
  } else if (ax < tx) {
    s.x = s.x + xOffset;
  } else {
    if (P.atk() !== "player") s.x = s.x - xOffset; else s.x = s.x + xOffset;
  }
};

// Lua: g2_pret.lua:1343 -- pokefirered/src/battle_anim_mons.c:792
P.InitSpritePosToAnimTarget = function (s: any, respect: unknown): void {
  if (respect == null || respect === false) {
    s.x = P.coord(P.tgt(), 0);
    s.y = P.coord(P.tgt(), 1);
  }
  P.SetAnimSpriteInitialXOffset(s, P.arg(0));
  s.y = s.y + P.arg(1);
};

// Lua: g2_pret.lua:1353 -- pokefirered/src/battle_anim_mons.c:805
P.InitSpritePosToAnimAttacker = function (s: any, respect: unknown): void {
  if (respect == null || respect === false) {
    s.x = P.coord(P.atk(), 0);
    s.y = P.coord(P.atk(), 1);
  } else {
    s.x = P.coord(P.atk(), 2);
    s.y = P.coord(P.atk(), 3);
  }
  P.SetAnimSpriteInitialXOffset(s, P.arg(0));
  s.y = s.y + P.arg(1);
};

// Lua: g2_pret.lua:1365
P.SetSpriteCoordsToAnimAttackerCoords = function (s: any): void {
  s.x = P.coord(P.atk(), 2);
  s.y = P.coord(P.atk(), 3);
};

// Lua: g2_pret.lua:1371 -- pokefirered/src/battle_anim_mons.c:988
P.InitAnimLinearTranslation = function (s: any): void {
  const d = s.data;
  const x = d[2] - d[1];
  const y = d[4] - d[3];
  const left = x < 0;
  const up = y < 0;
  let xd = P.u16(Math.abs(x) * 256);
  let yd = P.u16(Math.abs(y) * 256);
  const sp = d[0];
  xd = P.u16(P.div(xd, sp));
  yd = P.u16(P.div(yd, sp));
  if (left) xd = xd - mod(xd, 2) + 1; else xd = xd - mod(xd, 2);
  if (up) yd = yd - mod(yd, 2) + 1; else yd = yd - mod(yd, 2);
  d[1] = P.s16(xd);
  d[2] = P.s16(yd);
  d[4] = 0;
  d[3] = 0;
};

// Lua: g2_pret.lua:1391 -- pokefirered/src/battle_anim_mons.c:1034
P.AnimTranslateLinear = function (s: any): boolean {
  const d = s.data;
  if (d[0] === 0) return true;
  const v1 = P.u16(d[1]);
  const v2 = P.u16(d[2]);
  const x = P.u16(P.u16(d[3]) + v1);
  const y = P.u16(P.u16(d[4]) + v2);
  if (mod(v1, 2) === 1) s.x2 = -floor(x / 256); else s.x2 = floor(x / 256);
  if (mod(v2, 2) === 1) s.y2 = -floor(y / 256); else s.y2 = floor(y / 256);
  d[3] = P.s16(x);
  d[4] = P.s16(y);
  d[0] = d[0] - 1;
  return false;
};

// Lua: g2_pret.lua:1406
P.AnimTranslateLinear_WithFollowup = function (s: any): void {
  if (P.AnimTranslateLinear(s)) P.runStored(s);
};

// Lua: g2_pret.lua:1411 -- pokefirered/src/battle_anim_mons.c:1016
P.StartAnimLinearTranslation = function (s: any): void {
  s.data[1] = s.x;
  s.data[3] = s.y;
  P.InitAnimLinearTranslation(s);
  s.pcb = P.AnimTranslateLinear_WithFollowup;
  s.pcb(s);
};

// Lua: g2_pret.lua:1420 -- pokefirered/src/battle_anim_mons.c:1074
P.InitAnimLinearTranslationWithSpeed = function (s: any): void {
  const v1 = Math.abs(s.data[2] - s.data[1]) * 256;
  s.data[0] = P.div(v1, s.data[0]);
  P.InitAnimLinearTranslation(s);
};

// Lua: g2_pret.lua:1426
P.InitAnimLinearTranslationWithSpeedAndPos = function (s: any): void {
  s.data[1] = s.x;
  s.data[3] = s.y;
  P.InitAnimLinearTranslationWithSpeed(s);
  s.pcb = P.AnimTranslateLinear_WithFollowup;
  s.pcb(s);
};

// Lua: g2_pret.lua:1435 -- pokefirered/src/battle_anim_mons.c:1091
function init_fast_linear(s: any): void {
  const d = s.data;
  const xd = d[2] - d[1];
  const yd = d[4] - d[3];
  const xs = xd < 0;
  const ys = yd < 0;
  let x2 = P.u16(Math.abs(xd) * 16);
  let y2 = P.u16(Math.abs(yd) * 16);
  x2 = P.u16(P.div(x2, d[0]));
  y2 = P.u16(P.div(y2, d[0]));
  if (xs) x2 = x2 - mod(x2, 2) + 1; else x2 = x2 - mod(x2, 2);
  if (ys) y2 = y2 - mod(y2, 2) + 1; else y2 = y2 - mod(y2, 2);
  d[1] = P.s16(x2);
  d[2] = P.s16(y2);
  d[4] = 0;
  d[3] = 0;
}

// Lua: g2_pret.lua:1453
P.AnimFastTranslateLinear = function (s: any): boolean {
  const d = s.data;
  if (d[0] === 0) return true;
  const v1 = P.u16(d[1]);
  const v2 = P.u16(d[2]);
  const x = P.u16(P.u16(d[3]) + v1);
  const y = P.u16(P.u16(d[4]) + v2);
  if (mod(v1, 2) === 1) s.x2 = -floor(x / 16); else s.x2 = floor(x / 16);
  if (mod(v2, 2) === 1) s.y2 = -floor(y / 16); else s.y2 = floor(y / 16);
  d[3] = P.s16(x);
  d[4] = P.s16(y);
  d[0] = d[0] - 1;
  return false;
};

// Lua: g2_pret.lua:1468
function fast_wait_end(s: any): void {
  if (P.AnimFastTranslateLinear(s)) P.runStored(s);
}

// Lua: g2_pret.lua:1472
P.InitAndRunAnimFastLinearTranslation = function (s: any): void {
  s.data[1] = s.x;
  s.data[3] = s.y;
  init_fast_linear(s);
  s.pcb = fast_wait_end;
  s.pcb(s);
};

// Lua: g2_pret.lua:1481 -- pokefirered/src/battle_anim_mons.c:757
P.InitAnimArcTranslation = function (s: any): void {
  s.data[1] = s.x;
  s.data[3] = s.y;
  P.InitAnimLinearTranslation(s);
  s.data[6] = P.div(0x8000, s.data[0]);
  s.data[7] = 0;
};

// Lua: g2_pret.lua:1489
P.TranslateAnimHorizontalArc = function (s: any): boolean {
  if (P.AnimTranslateLinear(s)) return true;
  s.data[7] = P.s16(s.data[7] + s.data[6]);
  s.y2 = s.y2 + P.Sin(P.u8(floor(s.data[7] / 256)), s.data[5]);
  return false;
};

// Lua: g2_pret.lua:1496
P.TranslateAnimVerticalArc = function (s: any): boolean {
  if (P.AnimTranslateLinear(s)) return true;
  s.data[7] = P.s16(s.data[7] + s.data[6]);
  s.x2 = s.x2 + P.Sin(P.u8(floor(s.data[7] / 256)), s.data[5]);
  return false;
};

// Lua: g2_pret.lua:1504 -- pokefirered/src/battle_anim_mons.c:977
P.InitSpriteDataForLinearTranslation = function (s: any): void {
  const d = s.data;
  const x = P.s16((d[2] - d[1]) * 256);
  const y = P.s16((d[4] - d[3]) * 256);
  d[1] = P.div(x, d[0]);
  d[2] = P.div(y, d[0]);
  d[4] = 0;
  d[3] = 0;
};

// Lua: g2_pret.lua:1515 -- pokefirered/src/battle_anim_mons.c:2098 -- returns [x, y]
P.SetAverageBattlerPositions = function (b: any, respect: unknown): [number, number] {
  let xt = 0, yt = 1;
  if (respect != null && respect !== false) { xt = 2; yt = 3; }
  const id = AnimCoords.idOf(b) ?? 1;
  const x = P.coord(id, xt), y = P.coord(id, yt);
  if (!AnimCoords.isDouble()) return [x, y];
  const partner = AnimCoords.partner(id);
  return [P.div(x + P.coord(partner, xt), 2), P.div(y + P.coord(partner, yt), 2)];
};

// Lua: g2_pret.lua:1526 -- pokefirered/src/battle_anim_mons.c:1482
P.AnimTravelDiagonally = function (s: any): void {
  let r4 = true, ctype = 3;
  if (P.arg(6) !== 0) { r4 = false; ctype = 1; }
  let battler: any;
  if (P.arg(5) === 0) {
    P.InitSpritePosToAnimAttacker(s, r4);
    battler = P.atk();
  } else {
    P.InitSpritePosToAnimTarget(s, r4);
    battler = P.tgt();
  }
  if (P.atk() !== "player") P.setArg(2, -P.arg(2));
  P.InitSpritePosToAnimTarget(s, r4);
  s.data[0] = P.arg(4);
  s.data[2] = P.coord(battler, 2) + P.arg(2);
  s.data[4] = P.coord(battler, ctype) + P.arg(3);
  s.pcb = P.StartAnimLinearTranslation;
  P.storeCallback(s, P.DestroyAnimSprite);
};

// Lua: g2_pret.lua:1546
P.taskEnter = function (t: any, vm: any): void {
  P.setVm(vm);
  const ga = P.args();
  for (let i = 0; i <= 7; i++) {
    const v = tonumber(t.data[i]);
    if (v != null && v !== 0) ga[i] = v;
  }
  for (let i = 0; i <= 15; i++) t.data[i] = 0;
  t.g2 = {};
};

// Lua: g2_pret.lua:1557
P.destroyTask = function (t: any): void {
  t.g2 = null;
  AnimTasks._destroy(t);
};

// Lua: g2_pret.lua:1563
P.task = function (entry: (t: any, vm: any) => void): (t: any, vm: any) => void {
  return function (t: any, vm: any): void {
    P.taskEnter(t, vm);
    entry(t, vm);
  };
};

// Lua: g2_pret.lua:1570
P.cb = function (entry: (s: any) => void): (s: any) => void {
  return function (s: any): void {
    P.enter(s, entry);
  };
};

// Lua: g2_pret.lua:1577 -- pokefirered/src/battle_anim_mons.c:1677
P.PrepareAffineAnimInTaskData = function (t: any, m: any, cmds: any): void {
  t.data[7] = 0;
  t.data[8] = 0;
  t.data[9] = 0;
  t.g2.affMon = m;
  t.data[10] = 0x100;
  t.data[11] = 0x100;
  t.data[12] = 0;
  t.g2.affCmds = cmds;
};

// Lua: g2_pret.lua:1589 -- pokefirered/src/battle_anim_mons.c:1690
P.RunAffineAnimFromTaskData = function (t: any): boolean {
  const cmds = t.g2.affCmds;
  const m = t.g2.affMon;
  let c = cmds[t.data[7] + 1] ?? AEND;
  if (c.jump != null) {
    t.data[7] = c.jump;
  } else if (c.loop != null) {
    if (c.loop !== 0) {
      if (t.data[9] !== 0) {
        t.data[9] = t.data[9] - 1;
        if (t.data[9] === 0) {
          t.data[7] = t.data[7] + 1;
          return true;
        }
      } else {
        t.data[9] = c.loop;
      }
      if (t.data[7] === 0) return true;
      while (true) {
        t.data[7] = t.data[7] - 1;
        const prev = cmds[t.data[7] + 1];
        if (prev && prev.loop != null) {
          t.data[7] = t.data[7] + 1;
          return true;
        }
        if (t.data[7] === 0) return true;
      }
    }
    t.data[7] = t.data[7] + 1;
  } else if (c.stop) {
    if (m) {
      m.y2 = 0;
      P.resetSpriteRotScale(m);
    }
    return false;
  } else {
    if ((c.dur ?? 0) === 0) {
      t.data[10] = c.xs;
      t.data[11] = c.ys;
      t.data[12] = P.u8(c.rot ?? 0);
      t.data[7] = t.data[7] + 1;
      c = cmds[t.data[7] + 1] ?? AEND;
    }
    t.data[10] = P.s16(t.data[10] + (c.xs ?? 0));
    t.data[11] = P.s16(t.data[11] + (c.ys ?? 0));
    t.data[12] = P.s16(t.data[12] + P.u8(c.rot ?? 0));
    if (m) {
      P.setSpriteRotScale(m, t.data[10], t.data[11], t.data[12]);
      P.setYOffsetFromYScale(m);
    }
    t.data[8] = t.data[8] + 1;
    if (t.data[8] >= (c.dur ?? 0)) {
      t.data[8] = 0;
      t.data[7] = t.data[7] + 1;
    }
  }
  return true;
};

// Lua: g2_pret.lua:1649 -- pokefirered/src/battle_anim_mons.c:1831
P.SetSpriteSquashParams = function (t: any, m: any, xs0: number, ys0: number, xs1: number, ys1: number, dur: number): void {
  t.data[8] = dur;
  t.g2.squashMon = m;
  t.data[9] = xs0;
  t.data[10] = ys0;
  t.data[13] = xs1;
  t.data[14] = ys1;
  t.data[11] = P.div(xs1 - xs0, dur);
  t.data[12] = P.div(ys1 - ys0, dur);
};

// Lua: g2_pret.lua:1660
P.RunSpriteSquash = function (t: any): number {
  if (t.data[8] === 0) return 0;
  t.data[8] = t.data[8] - 1;
  if (t.data[8] !== 0) {
    t.data[9] = t.data[9] + t.data[11];
    t.data[10] = t.data[10] + t.data[12];
  } else {
    t.data[9] = t.data[13];
    t.data[10] = t.data[14];
  }
  const m = t.g2.squashMon;
  if (m) {
    P.setSpriteRotScale(m, t.data[9], t.data[10], 0);
    if (t.data[8] !== 0) P.setYOffsetFromYScale(m); else m.y2 = 0;
  }
  return t.data[8];
};

// Lua: g2_pret.lua:1678
P.playSE = function (name: any, pan?: number | null): void {
  try {
    const id = (SE as any)[name] ?? name;
    Audio.playSe(id, { pan: pan ?? 0 });
  } catch { /* pcall */ }
};

// Lua: g2_pret.lua:1687
P.customPanning = function (): number {
  const vm = P.vm;
  const v = vm ? tonumber(vm.animCustomPanning) : null;
  return v ?? 0;
};

// Lua: g2_pret.lua:1692
P.pal = function (): any {
  // pcall(require, "src.core.game3.battle.anim_port.g1_pret"): ok path.
  const G1: any = G1Pret;
  if (G1 != null && typeof G1 === "object" && G1.Pal != null && typeof G1.Pal === "object" && G1.Pal.blend) return G1.Pal;
  return null;
};

// Lua: g2_pret.lua:1698
P.palBlend = function (key: any, coeff: number | null | undefined, color: number): void {
  const Pal = P.pal();
  if (Pal) {
    if (coeff != null && coeff > 0) {
      Pal.blend(key, coeff, color);
    } else if (Pal.restore) {
      Pal.restore(key);
    }
    if (Pal.flush) {
      try { Pal.flush(); } catch { /* pcall */ }
    }
    return;
  }
  const Am = P.anim();
  if (!Am) return;
  const [r, g, b] = rgb555(color);
  if (key === "bg") {
    Am._bgBlend = (coeff != null && coeff > 0) ? { coeff, color } : null;
  } else if (key === "player" || key === "enemy") {
    const p = Am.present(key);
    if (p) {
      p.blendCoeff = (coeff ?? 0) / 16;
      p.blendColor = [null, r / 31, g / 31, b / 31];
    }
  } else {
    const tag = match(tostring(key), "^tag:(.+)$");
    if (tag != null) {
      Am._tagBlend = Am._tagBlend ?? {};
      Am._tagBlend[tag] = (coeff != null && coeff > 0) ? { coeff, color } : undefined;
    }
  }
};

// Lua: g2_pret.lua:1729
P.setMonGray = function (b: any, on: unknown): void {
  const p = P.present(b);
  if (p) p.grayscale = (on != null && on !== false) ? true : undefined;
};

// Lua: g2_pret.lua:1735 -- pokefirered/src/battle_anim_mons.c:1409
P.AnimSpriteOnMonPos = function (s: any): void {
  if (s.data[0] === 0) {
    const v = P.arg(3) === 0;
    if (P.arg(2) === 0) {
      P.InitSpritePosToAnimAttacker(s, v);
    } else {
      P.InitSpritePosToAnimTarget(s, v);
    }
    s.data[0] = s.data[0] + 1;
  } else if (s.animEnded || s.affineAnimEnded) {
    P.destroy(s);
  }
};

// Lua: g2_pret.lua:1749
function mon_pic(b: any): any {
  const sp = P.species(b);
  let entry: any = null;
  // pcall(require, "src.core.game3.battle.ui"): ok path.
  const U: any = Ui;
  if (U && U.battlerPic) entry = U.battlerPic(b, null, sp)[0];
  return entry ? entry.image : null;
}

// Lua: g2_pret.lua:1757 -- returns [cx, cy]
function mon_draw_center(b: any): [number, number] {
  const U: any = Ui;
  const base = BASE[b] ?? BASE.enemy;
  let cx = base[1], cy = P.defaultY(b);
  if (U && U.battlerSpriteCenter) {
    [cx, cy] = U.battlerSpriteCenter(b, P.species(b), { x: base[1], y: base[2] });
  }
  return [cx, cy];
}

// Lua: g2_pret.lua:1767
function draw_clone(s: any, vm: any): void {
  if (s.callback !== runner) {
    s.customDraw = null;
    return;
  }
  const img = s.g2 ? s.g2.monImage : null;
  if (s.invisible || !img) return;
  let alpha = s._drawAlpha;
  if (alpha == null) {
    alpha = 1;
    const ba = vm ? vm.bldAlpha : null;
    if (s.objBlend && ba) alpha = Math.min(1, (tonumber(ba.eva ?? ba[1]) ?? 16) / 16);
  }
  G.push();
  G.translate(floor(s.g2.cx + s.x2 + 0.5), floor(s.g2.cy + s.y2 + 0.5));
  if (mod(s.affineMode, 2) === 1) {
    const a = (s.matA ?? 256) / 256, b = (s.matB ?? 0) / 256, c = (s.matC ?? 0) / 256, d = (s.matD ?? 256) / 256;
    const det = a * d - b * c;
    if (Math.abs(det) > 1e-6) {
      const t: Transform = s._g2xf ?? new Transform();
      s._g2xf = t;
      t.setMatrix(d / det, -b / det, 0, 0, -c / det, a / det, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
      G.applyTransform(t);
    }
  }
  const sh = s.gray ? shader("gray", GRAY_SRC) : null;
  if (sh) G.setShader(sh);
  G.setColor(1, 1, 1, alpha);
  G.draw(img, -32, -32);
  if (sh) G.setShader();
  G.pop();
  G.setColor(1, 1, 1, 1);
}

// Lua: g2_pret.lua:1802 -- pokefirered/src/battle_anim_mons.c:1517
P.cloneMon = function (which: any, sub?: number | null): any {
  const b = P.battler(which);
  if (b == null) return null;
  const p = P.present(b);
  if (!p || p.visible === false) return null;
  const s = AnimSprites.acquire({ x: 0, y: 0 });
  if (!s) return null;
  s._vm = P.vm;
  init_pret(s, { w: 64, h: 64 }, 0, 0, sub ?? P.subpriorityOf(b));
  const [cx, cy] = mon_draw_center(b);
  s.g2.cx = cx + (p.ox ?? 0);
  s.g2.cy = cy + (p.oy ?? 0);
  s.g2.monImage = mon_pic(b);
  s.objBlend = true;
  s.customDraw = draw_clone;
  s.pcb = null;
  P.sync(s);
  return s;
};

// Lua: g2_pret.lua:1822
P.anim = function (): any {
  // pcall(require, "src.core.game3.battle.anim"): ok path.
  return AnimMod ?? null;
};

// Lua: g2_pret.lua:1827
P.monVisible = function (b: any): boolean {
  const p = P.present(b);
  return !!(p && p.visible !== false);
};

export default P;
