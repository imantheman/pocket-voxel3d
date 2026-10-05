// Port of gen1recomp src/core/game3/battle/anim_port/g3_pret.lua (GPLv3 + additional terms; see LICENSE.md).
// The gen-3 helper kit of the anim_port groups (g3_dark, g3_ghost, g3_psychic, g3_e3*, g5_tasks):
// pret sprite.c anims/affine anims, battle_anim_mons.c coords + translations, scanline waves,
// blend/window colour effects (mask_write / mask_overlay).
//
// NO TOP-LEVEL READS OF IMPORTS (runtime brief): Brian's require-time
// `P.SINE = Trig.SINE` and `P.x = AnimCoords.sideArg(P.x, n)` become getters on
// P that resolve on first read (same values, same wrapping).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, tonumber, tostring, truthy } from "../../../../../import/gen3/lua.ts";
import { ipairs, len, pairs, remove, seq, type LuaTable } from "../../../platform/lt.ts";
import { find, gsub } from "../../../platform/lpattern.ts";
import { random } from "../../../platform/rng.ts";
import { G } from "../../../platform/graphics.ts";
import { Trig } from "../../trig.ts";
import { Audio } from "../../audio.ts";
import { AnimPal } from "../anim_pal.ts";
import { AnimCoords } from "../anim_coords.ts";
import { Anim as AnimModule } from "../anim.ts";
import { AnimSprites as AnimSpritesModule } from "../anim_sprites.ts";
import { AnimTasks as AnimTasksModule } from "../anim_tasks.ts";
import { PicCoords as PicCoordsModule } from "../pic_coords.ts";
import { Ui } from "../ui.ts";
import G3Data from "./g3_data.ts";
import PicSizesModule from "./g1_pic_sizes.ts";

type S = Record<string, any>;

export const P: Record<string, any> = {};

// Lua: g3_pret.lua:7 -- bit.band/bor/bxor/lshift/rshift (LuaJIT: signed 32-bit results)
P.band = (a: number, b: number): number => a & b;
P.bor = (a: number, b: number): number => a | b;
P.bxor = (a: number, b: number): number => a ^ b;
P.lshift = (a: number, n: number): number => a << n;
P.rshift = (a: number, n: number): number => (a >>> n) | 0;

// Lua: g3_pret.lua:9 -- P.SINE = Trig.SINE (read on first use: no top-level read of an import)
Object.defineProperty(P, "SINE", { enumerable: true, configurable: true, get: () => Trig.SINE });

const floor = Math.floor;

// Lua: g3_pret.lua:14
P.s16 = function (v: number): number {
  v = mod(floor(v), 65536);
  if (v >= 32768) v = v - 65536;
  return v;
};
// Lua: g3_pret.lua:19
P.u16 = function (v: number): number { return mod(floor(v), 65536); };
// Lua: g3_pret.lua:20
P.u8 = function (v: number): number { return mod(floor(v), 256); };
// Lua: g3_pret.lua:21
P.s8 = function (v: number): number {
  v = mod(floor(v), 256);
  if (v >= 128) v = v - 256;
  return v;
};
// Lua: g3_pret.lua:26
P.shr = function (v: number, n: number): number { return floor(v / (2 ** n)); };
// Lua: g3_pret.lua:27
P.div = function (a: number, b: number): number {
  if (b === 0) return 0;
  const q = a / b;
  if (q >= 0) return floor(q);
  return -floor(-q);
};
// Lua: g3_pret.lua:33
P.mod = function (a: number, b: number): number {
  if (b === 0) return 0;
  return a - P.div(a, b) * b;
};
// Lua: g3_pret.lua:37
P.abs = function (v: number): number { return v < 0 ? -v : v; };

// Lua: g3_pret.lua:40 -- pokefirered/src/trig.c:514
P.Sin = function (index: number, amp: number): number {
  return P.s16(floor(Trig.SINE[mod(floor(index), 256) + 1]! * amp / 256));
};
// Lua: g3_pret.lua:43
P.Cos = function (index: number, amp: number): number {
  return P.s16(floor(Trig.SINE[mod(floor(index) + 64, 256) + 1]! * amp / 256));
};
const SINE_DEG = seq(0, 71, 143, 214, 286, 357, 428, 499, 570, 641, 711, 782, 852, 921, 991, 1060, 1129, 1198, 1266, 1334, 1401, 1468, 1534, 1600, 1666, 1731, 1796, 1860, 1923, 1986, 2048, 2110, 2171, 2231, 2290, 2349, 2408, 2465, 2522, 2578, 2633, 2687, 2741, 2793, 2845, 2896, 2946, 2996, 3044, 3091, 3138, 3183, 3228, 3271, 3314, 3355, 3396, 3435, 3474, 3511, 3547, 3582, 3617, 3650, 3681, 3712, 3742, 3770, 3798, 3824, 3849, 3873, 3896, 3917, 3937, 3956, 3974, 3991, 4006, 4021, 4034, 4046, 4056, 4065, 4073, 4080, 4086, 4090, 4093, 4095, 4096, 4095, 4093, 4090, 4086, 4080, 4073, 4065, 4056, 4046, 4034, 4021, 4006, 3991, 3974, 3956, 3937, 3917, 3896, 3873, 3849, 3824, 3798, 3770, 3742, 3712, 3681, 3650, 3617, 3582, 3547, 3511, 3474, 3435, 3396, 3355, 3314, 3271, 3228, 3183, 3138, 3091, 3044, 2996, 2946, 2896, 2845, 2793, 2741, 2687, 2633, 2578, 2522, 2465, 2408, 2349, 2290, 2231, 2171, 2110, 2048, 1986, 1923, 1860, 1796, 1731, 1666, 1600, 1534, 1468, 1401, 1334, 1266, 1198, 1129, 1060, 991, 921, 852, 782, 711, 641, 570, 499, 428, 357, 286, 214, 143, 71);

// Lua: g3_pret.lua:49 -- pokefirered/src/trig.c:526
P.Sin2 = function (angle: number): number {
  angle = P.u16(angle);
  const v = SINE_DEG[mod(angle, 180) + 1] ?? 0;
  if (mod(floor(angle / 180), 2) === 1) return -v;
  return v;
};
// pokefirered/src/trig.c:539-541

// Lua: g3_pret.lua:57
P.ArcTan2 = function (x: number, y: number): number {
  return Trig.arcTan2(x, y);
};
// Lua: g3_pret.lua:61 -- pokefirered/src/battle_anim_mons.c:1281
P.ArcTan2Neg = function (x: number, y: number): number {
  return mod(-P.ArcTan2(x, y), 65536);
};

// Lua: g3_pret.lua:65
P.Random = function (): number { return random(0, 65535); };

// Lua: g3_pret.lua:67
P.ANIM_ATTACKER = 0; P.ANIM_TARGET = 1; P.ANIM_ATK_PARTNER = 2; P.ANIM_DEF_PARTNER = 3;
P.COORD_X = 0; P.COORD_Y = 1; P.COORD_X_2 = 2; P.COORD_Y_PIC = 3; P.COORD_Y_PIC_DEF = 4;
P.ARG_RET_ID = 7;

// Lua: g3_pret.lua:75 -- the lazy requires of anim / anim_sprites / anim_tasks are static imports.
function Anim(): any {
  return AnimModule;
}
P.Anim = Anim;
// Lua: g3_pret.lua:80
P.vm = function (): any { return Anim()._vm; };
// Lua: g3_pret.lua:81
P.AnimSprites = function (): any {
  return AnimSpritesModule;
};
// Lua: g3_pret.lua:85
P.AnimTasks = function (): any {
  // package.loaded["src.core.game3.battle.anim_tasks"] or require(...)
  return AnimTasksModule;
};

// Lua: g3_pret.lua:92
P.atk = function (vm: any): any {
  if (vm.allyPair && vm.allyPair()) return vm.attackerId();
  return vm.attackerSide();
};
// Lua: g3_pret.lua:96
P.tgt = function (vm: any): any {
  if (vm.allyPair && vm.allyPair()) return vm.targetId();
  return vm.targetSide();
};
// Lua: g3_pret.lua:100
P.side = function (vm: any, animBattler: unknown): any {
  const ab = tonumber(animBattler) ?? 0;
  if (ab === 0) return vm.attackerSide();
  if (ab === 1) return vm.targetSide();
  return null;
};
// Lua: g3_pret.lua:106
P.isPlayer = function (side: unknown): boolean { return side === "player"; };
// Lua: g3_pret.lua:107
P.atkIsPlayer = function (vm: any): boolean { return vm.attackerSide() === "player"; };
// Lua: g3_pret.lua:108
P.tgtIsPlayer = function (vm: any): boolean { return vm.targetSide() === "player"; };

// Lua: g3_pret.lua:111 -- pcall(require, "src.core.game3.battle.pic_coords"): ported, the ok branch.
let PicCoords: any = null;
function picCoords(): any {
  if (PicCoords == null) {
    PicCoords = PicCoordsModule ?? false;
  }
  return PicCoords || null;
}

// Lua: g3_pret.lua:119 -- setmetatable({}, { __index = function(_, k) return AnimCoords.coords(nil, k) end })
const BASE: any = new Proxy({}, {
  get(_t, k) {
    if (typeof k !== "string") return undefined;
    const key = /^-?\d+$/.test(k) ? Number(k) : k;
    return AnimCoords.coords(null, key);
  },
});

// Lua: g3_pret.lua:121
P.species = function (vm: any, side: unknown): number | undefined {
  const sp = vm && vm.speciesForSide && vm.speciesForSide(side);
  return tonumber(sp);
};

// Lua: g3_pret.lua:127 -- pokefirered/src/battle_anim_mons.c:148
function yDelta(vm: any, side: unknown): number {
  const pc = picCoords();
  const sp = P.species(vm, side);
  if (!pc || sp == null) return 0;
  if (side === "player") return (pc.back ? pc.back[sp] : null) ?? 0;
  return (pc.front ? pc.front[sp] : null) ?? 0;
}

// Lua: g3_pret.lua:135
function elevation(vm: any, side: unknown): number {
  const pc = picCoords();
  const sp = P.species(vm, side);
  if (side === "player" || !pc || sp == null) return 0;
  return (pc.elev ? pc.elev[sp] : null) ?? 0;
}

// Lua: g3_pret.lua:143 -- pokefirered/src/battle_anim_mons.c:105
function coord(vm: any, side: any, kind: number): number {
  const b = BASE[side] ?? BASE.enemy;
  if (kind === P.COORD_X || kind === P.COORD_X_2) return b[1];
  if (kind === P.COORD_Y) return b[2];
  let y = P.yDelta(vm, side);
  if (side !== "player") y = y - P.elevation(vm, side);
  y = P.u8(y + b[2]);
  if (kind === P.COORD_Y_PIC) {
    if (side === "player") y = P.u8(y + 8);
    if (y > 104) y = 104;
  }
  return y;
}

// Lua: g3_pret.lua:157
P.coordAtk = function (vm: any, kind: number): number { return P.coord(vm, vm.attackerSide(), kind); };
// Lua: g3_pret.lua:158
P.coordTgt = function (vm: any, kind: number): number { return P.coord(vm, vm.targetSide(), kind); };

// Lua: g3_pret.lua:161 -- pokefirered/src/battle_anim_mons.c:305
function yWithElevation(vm: any, side: unknown): number {
  let y = P.coord(vm, side, P.COORD_Y);
  if (side !== "player") y = y - P.elevation(vm, side);
  return y;
}

// Brian's `P.x = AnimCoords.sideArg(P.x, n)` at require time: the wrap is made on
// the first read of P.x (a getter), so nothing calls into anim_coords while the
// import cycle loads. A later assignment to P.x replaces it, as in Lua.
function sideArgLazy(name: string, fn: (...a: any[]) => any, idx: number): void {
  let w: any = null;
  Object.defineProperty(P, name, {
    enumerable: true, configurable: true,
    get: () => (w ??= AnimCoords.sideArg(fn, idx)),
    set: (v) => { w = v; },
  });
}

// Lua: g3_pret.lua:167
sideArgLazy("yDelta", yDelta, 2);
sideArgLazy("elevation", elevation, 2);
sideArgLazy("coord", coord, 2);
sideArgLazy("yWithElevation", yWithElevation, 2);

// Lua: g3_pret.lua:173 -- pokefirered/src/battle_anim_mons.c:1908
P.subpriorityOf = function (side: unknown): number {
  return AnimCoords.subpriority(side);
};

// Lua: g3_pret.lua:177
P.atkId = function (vm: any): number { return vm.attackerId(); };
// Lua: g3_pret.lua:178
P.tgtId = function (vm: any): number { return vm.targetId(); };

// Lua: g3_pret.lua:180
P.monPresent = function (side: unknown): any {
  return Anim().present(side);
};

// Lua: g3_pret.lua:184
function monCenter(vm: any, side: any): [number, number] {
  const p = Anim().present(side);
  // package.loaded["src.core.game3.battle.ui"]
  const UiM: any = Ui;
  const b = BASE[side] ?? BASE.enemy;
  let cx: number, cy: number;
  if (UiM && UiM.battlerSpriteCenter) {
    [cx, cy] = UiM.battlerSpriteCenter(side, P.species(vm, side), { x: b[1], y: b[2] });
  } else {
    cx = b[1]; cy = P.coord(vm, side, P.COORD_Y_PIC_DEF);
  }
  return [cx + ((p ? p.ox : null) ?? 0), cy + ((p ? p.oy : null) ?? 0)];
}

// Lua: g3_pret.lua:197
function monImage(vm: any, side: any): any {
  const sp = P.species(vm, side);
  if (sp == null) return null;
  let e: any = null;
  // pcall(require, "src.core.game3.battle.ui"): ported, the ok branch.
  const UiM: any = Ui;
  if (UiM && UiM.battlerPic) e = UiM.battlerPic(side, null, sp)[0];
  return e ? e.image : e;
}

// Lua: g3_pret.lua:207 -- pokefirered/src/battle_anim_mons.c:1174
P.monRotScale = function (p: any, xs: number, ys: number, rot?: number | null): void {
  if (!p) return;
  xs = (xs === 0) ? 1 : xs;
  ys = (ys === 0) ? 1 : ys;
  p.sx = 256 / xs;
  p.sy = 256 / ys;
  p.rotation = -mod(rot ?? 0, 65536) / 65536 * 2 * Math.PI;
  p._g3mat = seq(xs, ys, mod(rot ?? 0, 65536));
};

// Lua: g3_pret.lua:217
P.monResetRotScale = function (p: any): void {
  if (!p) return;
  p.sx = 1; p.sy = 1; p.rotation = 0;
  p._g3mat = null;
};

// Lua: g3_pret.lua:223
function matrixD(p: any): number {
  const m = p ? p._g3mat : null;
  if (!m) return 256;
  const c = Trig.SINE[mod(floor(m[3] / 256) + 64, 256) + 1]!;
  return floor(m[2] * c / 256);
}

// Lua: g3_pret.lua:230
function matrixC(p: any): number {
  const m = p ? p._g3mat : null;
  if (!m) return 0;
  const s = Trig.SINE[mod(floor(m[3] / 256), 256) + 1]!;
  return floor(m[2] * s / 256);
}

// Lua: g3_pret.lua:238 -- pokefirered/src/battle_anim_mons.c:1762
P.monYOffsetFromYScale = function (vm: any, side: unknown, otherSide?: unknown): void {
  const p = Anim().present(side);
  if (!p) return;
  const v = 64 - P.yDelta(vm, otherSide ?? side) * 2;
  const d = matrixD(p);
  let var2 = (d === 0) ? 0 : P.div(v * 256, d);
  if (var2 > 128) var2 = 128;
  p.oy = P.div(v - var2, 2);
};

// Lua: g3_pret.lua:249 -- pokefirered/src/battle_anim_mons.c:1233
P.monYOffsetFromRotation = function (side: unknown): void {
  const p = Anim().present(side);
  if (!p) return;
  let c = matrixC(p);
  if (c < 0) c = -c;
  p.oy = P.shr(c, 3);
};

// Lua: g3_pret.lua:257
P.setBld = function (vm: any, eva?: number | null, evb?: number | null): void {
  if (!vm) return;
  if (eva == null) {
    vm.bldAlpha = null;
  } else {
    vm.bldAlpha = { 1: eva, 2: evb ?? 0, eva, evb: evb ?? 0 };
  }
};

// Lua: g3_pret.lua:266
P.bldAlphaValue = function (vm: any): number {
  const b = vm ? vm.bldAlpha : null;
  if (!b) return 1;
  let a = (b.eva ?? b[1] ?? 16) / 16;
  if (a > 1) a = 1;
  if (a < 0) a = 0;
  return a;
};

// Lua: g3_pret.lua:275
P.playSE = function (_vm: any, se: unknown, pan?: unknown): void {
  // pcall(require, "src.core.game3.audio"): ported, the ok branch.
  if (se == null || se === false) return;
  if (pan != null) {
    try { Audio.playSe(se, { pan }); } catch { /* pcall */ }
  } else {
    try { Audio.playSe(se); } catch { /* pcall */ }
  }
};

// Lua: g3_pret.lua:286 -- pokefirered/src/battle_anim.c:1160
P.adjustPan = function (vm: any, pan: number): number {
  return vm.adjustPanning(pan);
};

// Lua: g3_pret.lua:290
P.playSEPan = function (vm: any, se: unknown, pan: number): void {
  P.playSE(vm, se, vm.adjustPanning(pan));
};

// Lua: g3_pret.lua:294
function tagInfo(vm: any, tagIn: unknown): any {
  if (tagIn == null || tagIn === false) return null;
  const tag = gsub(tostring(tagIn).toUpperCase(), "^ANIM_TAG_", "")[0];
  const pack = vm ? vm._pack : null;
  return pack && pack.tags && pack.tags[tag];
}

// Lua: g3_pret.lua:301 -- setmetatable({}, { __mode = "k" })
const sheetCache = new WeakMap<object, Record<string, any>>();

// Lua: g3_pret.lua:303
P.sheet = function (vm: any, tag: unknown, w: number, h: number): [any, number] {
  const info = tagInfo(vm, tag);
  const img = info ? info.image : null;
  if (!img || !img.getDimensions) return [img, 1];
  let per = sheetCache.get(img);
  if (!per) { per = {}; sheetCache.set(img, per); }
  const key = tostring(w) + "x" + tostring(h);
  if (per[key]) return [per[key].image, per[key].frames];
  const [iw, ih] = img.getDimensions();
  // (Brian's `or not (love and love.graphics and love.graphics.newCanvas)`: the platform always has canvases.)
  if (iw === w) {
    per[key] = { image: img, frames: Math.max(1, floor(ih / h)) };
    return [img, per[key].frames];
  }
  const tw = floor(iw / 8);
  const total = tw * floor(ih / 8);
  const cw = Math.max(1, floor(w / 8));
  const perFrame = cw * Math.max(1, floor(h / 8));
  const nframes = Math.max(1, floor(total / perFrame));
  let canvas: any;
  try { canvas = G.newCanvas(w, h * nframes); } catch { canvas = null; }
  if (!canvas) {
    per[key] = { image: img, frames: 1 };
    return [img, 1];
  }
  canvas.setFilter("nearest", "nearest");
  const relay = (src: any, dstCanvas: any): void => {
    G.push("all");
    G.setCanvas(dstCanvas);
    G.clear(0, 0, 0, 0);
    G.origin();
    G.setShader();
    G.setColor(1, 1, 1, 1);
    G.setBlendMode("replace", "premultiplied");
    for (let t = 0; t <= nframes * perFrame - 1; t++) {
      const f = floor(t / perFrame);
      const r = t % perFrame;
      const dx = (r % cw) * 8;
      const dy = f * h + floor(r / cw) * 8;
      const q = G.newQuad((t % tw) * 8, floor(t / tw) * 8, 8, 8, iw, ih);
      G.draw(src, q, dx, dy);
    }
    G.pop();
  };
  relay(img, canvas);
  const [idxImg, idxTag] = AnimPal.indexImage(img);
  if (idxImg) {
    let ic: any;
    try { ic = G.newCanvas(w, h * nframes); } catch { ic = null; }
    if (ic) {
      ic.setFilter("nearest", "nearest");
      relay(idxImg, ic);
      AnimPal.register(canvas, ic, idxTag);
    }
  }
  per[key] = { image: canvas, frames: nframes };
  return [canvas, nframes];
};

// Lua: g3_pret.lua:360 -- require("...g3_data") on first use: a static import (g3_data imports nothing).
let DATA: any = null;
P.data = function (): any {
  if (!DATA) DATA = G3Data;
  return DATA;
};

// Lua: g3_pret.lua:365
P.template = function (name: unknown): any {
  return (name != null && name !== false) ? P.data().templates[tostring(name)] : null;
};

// Lua: g3_pret.lua:369
function destroy(s: S): void {
  P.AnimSprites().release(s);
}
P.DestroyAnimSprite = destroy;
P.DestroySpriteAndMatrix = destroy;

// Lua: g3_pret.lua:376 -- pokefirered/src/battle_anim.c:630
P.zFor = function (pri?: number | null, sub?: number | null, vm?: any): number {
  pri = pri ?? 2;
  sub = sub ?? 0;
  if (pri <= 1) {
    let z = 900 + (2 - pri) * 40 + (100 - sub) * 0.1;
    if (z > 998) z = 998;
    return z;
  } else if (pri >= 3) {
    return 2 + (100 - sub) * 0.01;
  }
  return AnimCoords.layerZ(sub, vm && vm._monbg, vm && vm._bgPrio);
};

// Lua: g3_pret.lua:390 -- pokefirered/src/sprite.c:905
function beginAnim(s: S): void {
  const A = s._anims;
  const cmds = A ? A[(s.animNum ?? 0) + 1] : null;
  s.animCmdIndex = 0;
  s.animEnded = false;
  s.animLoopCounter = 0;
  s.animBeginning = false;
  if (!cmds) return;
  const c = cmds[1];
  if (c && c.f != null) {
    let d = c.d ?? 0;
    if (d > 0) d = d - 1;
    s.animDelayCounter = d;
    s.animH = c.h === 1; s.animV = c.v === 1;
    s.imageValue = c.f;
  }
}

// Lua: g3_pret.lua:410
function jumpToTopOfAnimLoop(s: S, cmds: LuaTable): void {
  if (s.animLoopCounter !== 0) {
    s.animCmdIndex = s.animCmdIndex - 1;
    while (true) {
      const prev = cmds[s.animCmdIndex];
      if (prev && prev.l != null) break;
      if (s.animCmdIndex === 0) break;
      s.animCmdIndex = s.animCmdIndex - 1;
    }
    s.animCmdIndex = s.animCmdIndex - 1;
  }
}

// Lua: g3_pret.lua:423
function continueAnim(s: S): void {
  const A = s._anims;
  const cmds = A ? A[(s.animNum ?? 0) + 1] : null;
  if (!cmds) return;
  if ((s.animDelayCounter ?? 0) > 0) {
    if (!s.animPaused) s.animDelayCounter = s.animDelayCounter - 1;
    const c = cmds[s.animCmdIndex + 1];
    if (c && c.f != null) { s.animH = c.h === 1; s.animV = c.v === 1; }
  } else if (!s.animPaused) {
    s.animCmdIndex = s.animCmdIndex + 1;
    const c = cmds[s.animCmdIndex + 1];
    if (!c || c.e != null) {
      s.animCmdIndex = s.animCmdIndex - 1;
      s.animEnded = true;
    } else if (c.j != null) {
      s.animCmdIndex = c.j;
      const f = cmds[s.animCmdIndex + 1];
      if (f && f.f != null) {
        let d = f.d ?? 0;
        if (d > 0) d = d - 1;
        s.animDelayCounter = d;
        s.animH = f.h === 1; s.animV = f.v === 1;
        s.imageValue = f.f;
      }
    } else if (c.l != null) {
      if ((s.animLoopCounter ?? 0) !== 0) {
        s.animLoopCounter = s.animLoopCounter - 1;
      } else {
        s.animLoopCounter = c.l;
      }
      jumpToTopOfAnimLoop(s, cmds);
      continueAnim(s);
    } else if (c.f != null) {
      let d = c.d ?? 0;
      if (d > 0) d = d - 1;
      s.animDelayCounter = d;
      s.animH = c.h === 1; s.animV = c.v === 1;
      s.imageValue = c.f;
    }
  }
}

// Lua: g3_pret.lua:465
function affCmds(s: S): LuaTable {
  const F = s._affine;
  return F ? F[(s.affAnimNum ?? 0) + 1] : null;
}

// Lua: g3_pret.lua:470
function affApplyRelative(s: S, x: number, y: number, r: number): void {
  s.affX = P.s16((s.affX ?? 256) + x);
  s.affY = P.s16((s.affY ?? 256) + y);
  s.affRot = P.band(P.u16((s.affRot ?? 0) + P.lshift(r, 8)), 0xFF00);
}

// Lua: g3_pret.lua:476
function affApplyFrame(s: S, c: any): number {
  let d = c.d ?? 0;
  if (d > 0) {
    d = d - 1;
    affApplyRelative(s, c.x, c.y, c.r);
  } else {
    s.affX = c.x; s.affY = c.y; s.affRot = P.u16(P.lshift(c.r, 8));
    affApplyRelative(s, 0, 0, 0);
  }
  return d;
}

// Lua: g3_pret.lua:489 -- pokefirered/src/sprite.c:1063
function beginAffineAnim(s: S): void {
  const cmds = affCmds(s);
  if (!(s._aff != null && s._aff !== 0) || !cmds) return;
  s.affCmdIndex = 0; s.affDelay = 0; s.affLoop = 0;
  s.affineAnimBeginning = false;
  s.affineAnimEnded = false;
  const c = cmds[1];
  if (c && c.x != null) {
    s.affDelay = affApplyFrame(s, c);
  } else if (c && c.e != null) {
    s.affineAnimEnded = true;
  }
}

// Lua: g3_pret.lua:504
function continueAffineAnim(s: S): void {
  if (!(s._aff != null && s._aff !== 0)) return;
  const cmds = affCmds(s);
  if (!cmds) return;
  if ((s.affDelay ?? 0) > 0) {
    if (!s.affineAnimPaused) {
      s.affDelay = s.affDelay - 1;
      const c = cmds[s.affCmdIndex + 1];
      if (c && c.x != null) affApplyRelative(s, c.x, c.y, c.r);
    }
  } else if (s.affineAnimPaused) {
    return;
  } else {
    s.affCmdIndex = s.affCmdIndex + 1;
    const c = cmds[s.affCmdIndex + 1];
    if (!c || c.e != null) {
      s.affineAnimEnded = true;
      s.affCmdIndex = s.affCmdIndex - 1;
    } else if (c.j != null) {
      s.affCmdIndex = c.j;
      const f = cmds[s.affCmdIndex + 1];
      if (f && f.x != null) s.affDelay = affApplyFrame(s, f);
    } else if (c.l != null) {
      if ((s.affLoop ?? 0) !== 0) {
        s.affLoop = s.affLoop - 1;
      } else {
        s.affLoop = c.l;
      }
      if (s.affLoop !== 0) {
        s.affCmdIndex = s.affCmdIndex - 1;
        while (true) {
          const prev = cmds[s.affCmdIndex];
          if (prev && prev.l != null) break;
          if (s.affCmdIndex === 0) break;
          s.affCmdIndex = s.affCmdIndex - 1;
        }
        s.affCmdIndex = s.affCmdIndex - 1;
      }
      continueAffineAnim(s);
    } else if (c.x != null) {
      s.affDelay = affApplyFrame(s, c);
    }
  }
}

// Lua: g3_pret.lua:550 -- pokefirered/src/sprite.c:897
P.animate = function (s: S): void {
  if (s._anims) {
    if (s.animBeginning) beginAnim(s); else continueAnim(s);
  }
  if (s._aff != null && s._aff !== 0 && s._affine) {
    if (s.affineAnimBeginning) beginAffineAnim(s); else continueAffineAnim(s);
  }
};

// Lua: g3_pret.lua:559
P.StartSpriteAnim = function (s: S, n: number): void {
  s.animNum = n;
  s.animBeginning = true;
  s.animEnded = false;
};

// Lua: g3_pret.lua:566 -- pokefirered/src/sprite.c:1349
P.SeekSpriteAnim = function (s: S, idx: number): void {
  const paused = s.animPaused;
  s.animCmdIndex = idx - 1;
  s.animDelayCounter = 0;
  s.animBeginning = false;
  s.animEnded = false;
  s.animPaused = false;
  continueAnim(s);
  if ((s.animDelayCounter ?? 0) > 0) s.animDelayCounter = s.animDelayCounter + 1;
  s.animPaused = paused;
};

// Lua: g3_pret.lua:578
P.StartSpriteAffineAnim = function (s: S, n: number): void {
  s.affAnimNum = n;
  s.affCmdIndex = 0; s.affDelay = 0; s.affLoop = 0;
  s.affX = 256; s.affY = 256; s.affRot = 0;
  s.affineAnimBeginning = true;
  s.affineAnimEnded = false;
};

// Lua: g3_pret.lua:586
P.ChangeSpriteAffineAnim = function (s: S, n: number): void {
  s.affAnimNum = n;
  s.affineAnimBeginning = true;
  s.affineAnimEnded = false;
};

// Lua: g3_pret.lua:593 -- pokefirered/src/battle_anim_mons.c:1244
P.TrySetSpriteRotScale = function (s: S, _recalc: unknown, xs: number, ys: number, rot?: number | null): void {
  if (s._aff != null && mod(s._aff, 2) === 1) {
    s.affineAnimPaused = true;
    s._mat = seq(xs, ys, P.u16(rot ?? 0));
  }
};

// Lua: g3_pret.lua:600
P.TryResetSpriteAffineState = function (s: S): void {
  P.TrySetSpriteRotScale(s, true, 256, 256, 0);
  s._mat = null;
  s.affX = 256; s.affY = 256; s.affRot = 0;
  s.affineAnimPaused = false;
};

// Lua: g3_pret.lua:607
P.sync = function (s: S, vm?: any): void {
  const cellH = s._baseH ?? s.h ?? 32;
  const per = Math.max(1, floor((s._baseW ?? 32) / 8) * floor(cellH / 8));
  let frame = floor((s.imageValue ?? 0) / per);
  if (s._frames != null && frame >= s._frames) frame = s._frames - 1;
  s.quadX = 0;
  s.quadY = frame * cellH;
  const affOn = s._aff != null && s._aff !== 0;
  if (affOn) {
    s.hFlip = truthy(s._hFlipBase);
    s.vFlip = truthy(s._vFlipBase);
    if (s._mat) {
      const m = s._mat;
      s.scaleX = 256 / ((m[1] === 0) ? 1 : m[1]);
      s.scaleY = 256 / ((m[2] === 0) ? 1 : m[2]);
      s.rotation = -(m[3] / 65536) * 2 * Math.PI;
    } else {
      s.scaleX = (s.affX ?? 256) / 256;
      s.scaleY = (s.affY ?? 256) / 256;
      s.rotation = -((s.affRot ?? 0) / 65536) * 2 * Math.PI;
    }
  } else {
    s.hFlip = truthy(s.animH) !== truthy(s._hFlipBase);
    s.vFlip = truthy(s.animV) !== truthy(s._vFlipBase);
    s.scaleX = 1; s.scaleY = 1; s.rotation = 0;
  }
  s.visible = !truthy(s.invisible) && !truthy(s._objWindow);
  if (truthy(s.zOverride)) {
    s.z = s.zOverride;
  } else {
    s.z = P.zFor(s.pri, s.sub, vm);
  }
  s.subpriority = 0;
  s.objBlend = truthy(s._objBlend) ? true : null;
  s.alpha = s.alphaMul ?? 1;
};

// Lua: g3_pret.lua:644
function setup(s: S, vm: any, tmplName: unknown): void {
  for (let i = 0; i <= 7; i++) s.data[i] = 0;
  const T = P.template(truthy(tmplName) ? tmplName : s.template) ?? {};
  s._tmpl = T;
  s._anims = T.anims;
  s._affine = T.affine;
  s._aff = T.aff ?? 0;
  s._objBlend = T.blend === 1;
  s._g3 = true;
  s.palBlend = null;
  const w = T.w ?? s._baseW ?? s.w ?? 32;
  const h = T.h ?? s._baseH ?? s.h ?? 32;
  s._baseW = w; s._baseH = h;
  s.w = w; s.h = h;
  s.originX = null; s.originY = null;
  s.ox = 0; s.oy = 0;
  s.invisible = false;
  s.alphaMul = null;
  s.zOverride = null;
  s.blendMode = "alpha";
  s._hFlipBase = false; s._vFlipBase = false;
  s.hFlip = false; s.vFlip = false;
  s.animNum = 0; s.animCmdIndex = 0; s.animDelayCounter = 0; s.animLoopCounter = 0;
  s.animBeginning = true; s.animEnded = false; s.animPaused = false;
  s.animH = false; s.animV = false;
  s.imageValue = 0;
  s.affAnimNum = 0; s.affCmdIndex = 0; s.affDelay = 0; s.affLoop = 0;
  s.affX = 256; s.affY = 256; s.affRot = 0;
  s.affineAnimBeginning = s._aff !== 0 && s._affine != null;
  s.affineAnimEnded = false;
  s.affineAnimPaused = false;
  s._mat = null;
  let tag = T.tag ?? s.tag;
  const opTag = s._op ? s._op.tag : null;
  if (typeof T.tag === "string" && opTag != null && vm && vm._pack && vm._pack.tags && !vm._pack.tags[T.tag]
      && vm._pack.tags[opTag]) {
    tag = opTag;
  }
  if (tag != null && vm) {
    const [img, frames] = P.sheet(vm, tag, w, h);
    if (img) s.image = img;
    s._frames = frames;
    s.quad = null;
  }
  s.pri = 2;
  s.callbackData = null;
}

// Lua: g3_pret.lua:692
function argsOf(list: LuaTable): Record<number, number> {
  const ga: Record<number, number> = {};
  for (let i = 0; i <= 7; i++) ga[i] = 0;
  if (list) {
    for (const [k, v] of ipairs(list)) {
      if (k <= 8) ga[k - 1] = tonumber(v) ?? 0;
    }
  }
  return ga;
}
P.argsOf = argsOf;

// Lua: g3_pret.lua:704
function vmSubpriority(s: S, vm: any): number {
  const op = s._op;
  const off = tonumber(op ? op.subpriority : null) ?? tonumber(s.subpriority) ?? 2;
  const ab = op ? op.animBattler : null;
  let side: any;
  if (ab == null) {
    side = s._anchorSide ?? vm.targetSide();
  } else {
    side = vm.resolveBattlerSide(ab);
  }
  side = side ?? vm.targetSide();
  const base = P.subpriorityOf(side);
  let sub: number;
  if (off >= 64) sub = base + (off - 64); else sub = base - off;
  if (sub < 3) sub = 3;
  return sub;
}

// Lua: g3_pret.lua:722
let tokN = 0;
function newTok(): number {
  tokN = tokN + 1;
  return tokN;
}

// Lua: g3_pret.lua:728
function runStep(s: S, vm: any): void {
  const fn = s.callbackFn;
  if (fn) fn(s, vm);
}

// Lua: g3_pret.lua:734 -- pokefirered/src/sprite.c:583
P.cb = function (entry: (s: S, vm: any) => void): (s: S) => void {
  return function (s: S): void {
    const vm = s._vm ?? P.vm();
    if (!vm) return;
    if (!s._inited) {
      s._inited = true;
      s._vm = vm;
      setup(s, vm, s.template);
      s.x = P.coordTgt(vm, P.COORD_X_2);
      s.y = P.coordTgt(vm, P.COORD_Y_PIC);
      if (s._args) {
        s.ga = argsOf(s._args);
      } else {
        s.ga = {};
        for (let i = 0; i <= 7; i++) s.ga[i] = tonumber(vm.args ? vm.args[i] : null) ?? 0;
      }
      s.sub = vmSubpriority(s, vm);
      s.callbackFn = entry;
      s._g3tok = newTok();
    }
    const tok = s._g3tok;
    runStep(s, vm);
    if (!(s.active && s._inited && s._g3tok === tok)) return;
    P.animate(s);
    P.sync(s, vm);
  };
};

// Lua: g3_pret.lua:762
P.setCallback = function (s: S, fn: any): void {
  s.callbackFn = fn;
};

// Lua: g3_pret.lua:766
function genericCallback(s: S): void {
  const vm = s._vm ?? P.vm();
  if (!vm) return;
  s._inited = true;
  const tok = s._g3tok;
  runStep(s, vm);
  if (!(s.active && s._inited && s._g3tok === tok)) return;
  P.animate(s);
  P.sync(s, vm);
}
P.genericCallback = genericCallback;

// Lua: g3_pret.lua:778
P.CreateSprite = function (vm: any, tmplName: unknown, x: number, y: number, sub?: number | null,
  fn?: any, opts?: Record<string, any> | null): S | null {
  opts = opts ?? {};
  const AnimSprites = P.AnimSprites();
  const T = P.template(tmplName) ?? {};
  const s = AnimSprites.acquire({
    x, y, z: 150, template: tmplName, tag: T.tag,
    w: T.w ?? 32, h: T.h ?? 32, hostId: opts.hostId,
    callback: genericCallback,
  });
  if (!s) return null;
  s._args = null;
  s._op = null;
  s._vm = vm;
  s._baseW = T.w ?? 32; s._baseH = T.h ?? 32;
  if (opts.counted) s._g4counted = true;
  setup(s, vm, tmplName);
  s.x = x; s.y = y;
  s.sub = sub ?? 2;
  s.ga = opts.ga ?? argsOf(null);
  s.callbackFn = fn;
  s._g3tok = newTok();
  s._inited = false;
  if (opts.animate) {
    s._inited = true;
    runStep(s, vm);
    if (s.active) {
      P.animate(s);
      P.sync(s, vm);
    }
  } else {
    P.sync(s, vm);
  }
  return s;
};

// Lua: g3_pret.lua:813
P.spriteReady = function (s: S | null | undefined): void {
  if (s && !s._g3tok) s._g3tok = newTok();
};

// Lua: g3_pret.lua:818 -- pokefirered/src/battle_anim_mons.c:1517
P.CloneMon = function (vm: any, side: any): S | null {
  const AnimSprites = P.AnimSprites();
  const p = Anim().present(side);
  if (!p) return null;
  const [cx, cy] = P.monCenter(vm, side);
  const img = P.monImage(vm, side);
  const s = AnimSprites.acquire({
    x: cx, y: cy, z: AnimCoords.monBehindZ(side), hostId: side,
    w: 64, h: 64, image: img, callback: genericCallback,
  });
  if (!s) return null;
  s._args = null; s._op = null;
  s._vm = vm;
  s._baseW = 64; s._baseH = 64;
  s.template = null;
  setup(s, vm, "__clone");
  s.image = img;
  s._frames = 1;
  s.x = cx; s.y = cy;
  s.ox = 0; s.oy = 0;
  s._aff = 3;
  s._objBlend = true;
  s.zOverride = (side === "player") ? 195 : 95;
  s.isClone = side;
  s.ga = argsOf(null);
  s.callbackFn = null;
  s._g3tok = newTok();
  s._inited = true;
  if (p) {
    s._mat = seq(Math.floor(256 / ((p.sx !== 0 && p.sx != null) ? p.sx : 1)),
      Math.floor(256 / ((p.sy !== 0 && p.sy != null) ? p.sy : 1)), 0);
    if (s._mat[1] === 256 && s._mat[2] === 256) s._mat = null;
  }
  P.sync(s, vm);
  return s;
};

// Lua: g3_pret.lua:854
P.task = function (entry: (t: any, vm: any) => void): (t: any, vm: any) => void {
  return function (t: any, vm: any): void {
    if (!t._inited) {
      t._inited = true;
      const ga: Record<number, number> = {};
      for (let i = 0; i <= 7; i++) {
        let v: any = t.data[i];
        if (typeof v === "string") {
          const s = v.toLowerCase();
          if (find(s, "target") != null) v = 1; else if (find(s, "attacker") != null) v = 0; else v = tonumber(v) ?? 0;
        }
        ga[i] = tonumber(v) ?? 0;
      }
      t.ga = ga;
      for (let i = 0; i <= 15; i++) t.data[i] = 0;
      t.fn = entry;
      t._g3 = {};
    }
    t.fn(t, vm);
  };
};

// Lua: g3_pret.lua:876
P.DestroyAnimVisualTask = function (t: any): void {
  P.AnimTasks()._destroy(t);
};

// Lua: g3_pret.lua:880 -- { [0] = 999, [1] = 850, [2] = 3, [3] = 2 }
const BG_PRIO_Z = [999, 850, 3, 2];
// Lua: g3_pret.lua:881
P.bgZ = function (prio: number): number { return BG_PRIO_Z[prio] ?? 2; };

// Lua: g3_pret.lua:884 -- pokefirered/src/battle_anim_mons.c:926
P.bg1Layer = function (t: any, vm: any, key: unknown, prio: number, palOverride?: LuaTable): void {
  AnimPal.bgLoad("bg1", key, palOverride);
  t.z = P.bgZ(prio);
  t._bg1key = key;
  t.draw = function (tt: any, v: any): void {
    AnimPal.bgLayerDraw(tt._bg1key, "bg1", tt._bg1x ?? 0, tt._bg1y ?? 0, v ?? vm);
  };
};

// Lua: g3_pret.lua:893
P.bg1Clear = function (t: any): void {
  t.draw = null;
  t._bg1key = null;
};

// Lua: g3_pret.lua:898
P.setRet = function (vm: any, v: unknown): void {
  if (vm && vm.args) vm.args[P.ARG_RET_ID] = v;
};

// Lua: g3_pret.lua:902
P.retVal = function (vm: any): number {
  return (vm && vm.args ? tonumber(vm.args[P.ARG_RET_ID]) : null) ?? 0;
};

// Lua: g3_pret.lua:907
P.StoreSpriteCallbackInData6 = function (s: S, fn: any): void {
  s._stored = fn;
};

// Lua: g3_pret.lua:911
P.SetCallbackToStoredInData6 = function (s: S): void {
  s.callbackFn = s._stored;
};

// Lua: g3_pret.lua:916 -- pokefirered/src/battle_anim_mons.c:521
P.WaitAnimForDuration = function (s: S): void {
  if (s.data[0] > 0) {
    s.data[0] = s.data[0] - 1;
  } else {
    P.SetCallbackToStoredInData6(s);
  }
};

// Lua: g3_pret.lua:924
P.RunStoredCallbackWhenAnimEnds = function (s: S): void {
  if (s.animEnded) P.SetCallbackToStoredInData6(s);
};

// Lua: g3_pret.lua:928
P.RunStoredCallbackWhenAffineAnimEnds = function (s: S): void {
  if (s.affineAnimEnded) P.SetCallbackToStoredInData6(s);
};

// Lua: g3_pret.lua:932
P.DestroyAnimSpriteAndDisableBlend = function (s: S, vm?: any): void {
  P.setBld(vm ?? s._vm, null);
  destroy(s);
};

// Lua: g3_pret.lua:937
P.DestroyAnimVisualTaskAndDisableBlend = function (t: any, vm: any): void {
  P.setBld(vm, null);
  P.DestroyAnimVisualTask(t);
};

// Lua: g3_pret.lua:943 -- pokefirered/src/battle_anim_mons.c:412
P.TranslateSpriteInCircle = function (s: S): void {
  const d = s.data;
  if (d[3] !== 0) {
    s.ox = P.Sin(d[0], d[1]);
    s.oy = P.Cos(d[0], d[1]);
    d[0] = d[0] + d[2];
    if (d[0] >= 256) d[0] = d[0] - 256; else if (d[0] < 0) d[0] = d[0] + 256;
    d[3] = d[3] - 1;
  } else {
    P.SetCallbackToStoredInData6(s);
  }
};

// Lua: g3_pret.lua:956
P.TranslateSpriteInGrowingCircle = function (s: S): void {
  const d = s.data;
  if (d[3] !== 0) {
    s.ox = P.Sin(d[0], P.shr(d[5], 8) + d[1]);
    s.oy = P.Cos(d[0], P.shr(d[5], 8) + d[1]);
    d[0] = d[0] + d[2];
    d[5] = P.s16(d[5] + d[4]);
    if (d[0] >= 256) d[0] = d[0] - 256; else if (d[0] < 0) d[0] = d[0] + 256;
    d[3] = d[3] - 1;
  } else {
    P.SetCallbackToStoredInData6(s);
  }
};

// Lua: g3_pret.lua:970
P.TranslateSpriteInEllipse = function (s: S): void {
  const d = s.data;
  if (d[3] !== 0) {
    s.ox = P.Sin(d[0], d[1]);
    s.oy = P.Cos(d[0], d[4]);
    d[0] = d[0] + d[2];
    if (d[0] >= 256) d[0] = d[0] - 256; else if (d[0] < 0) d[0] = d[0] + 256;
    d[3] = d[3] - 1;
  } else {
    P.SetCallbackToStoredInData6(s);
  }
};

// Lua: g3_pret.lua:984 -- pokefirered/src/battle_anim_mons.c:548
P.ConvertPosDataToTranslateLinearData = function (s: S): void {
  const d = s.data;
  if (d[1] > d[2]) d[0] = -d[0];
  const xDiff = d[2] - d[1];
  const old = d[0];
  d[0] = P.abs(P.div(xDiff, d[0]));
  d[2] = P.s16(P.div(d[4] - d[3], d[0]));
  d[1] = old;
};

// Lua: g3_pret.lua:994
P.TranslateSpriteLinear = function (s: S): void {
  const d = s.data;
  if (d[0] > 0) {
    d[0] = d[0] - 1;
    s.ox = s.ox + d[1];
    s.oy = s.oy + d[2];
  } else {
    P.SetCallbackToStoredInData6(s);
  }
};

// Lua: g3_pret.lua:1005
P.TranslateSpriteLinearFixedPoint = function (s: S): void {
  const d = s.data;
  if (d[0] > 0) {
    d[0] = d[0] - 1;
    d[3] = P.s16(d[3] + d[1]);
    d[4] = P.s16(d[4] + d[2]);
    s.ox = P.shr(d[3], 8);
    s.oy = P.shr(d[4], 8);
  } else {
    P.SetCallbackToStoredInData6(s);
  }
};

// Lua: g3_pret.lua:1019 -- pokefirered/src/battle_anim_mons.c:977
P.InitSpriteDataForLinearTranslation = function (s: S): void {
  const d = s.data;
  const x = P.s16((d[2] - d[1]) * 256);
  const y = P.s16((d[4] - d[3]) * 256);
  d[1] = P.s16(P.div(x, d[0]));
  d[2] = P.s16(P.div(y, d[0]));
  d[4] = 0;
  d[3] = 0;
};

// Lua: g3_pret.lua:1030 -- pokefirered/src/battle_anim_mons.c:988
P.InitAnimLinearTranslation = function (s: S): void {
  const d = s.data;
  const x = d[2] - d[1];
  const y = d[4] - d[3];
  const movingLeft = x < 0;
  const movingUp = y < 0;
  let xDelta = P.u16(P.abs(x) * 256);
  let yDelta = P.u16(P.abs(y) * 256);
  const sp = d[0];
  xDelta = P.u16(P.div(xDelta, sp));
  yDelta = P.u16(P.div(yDelta, sp));
  if (movingLeft) xDelta = P.bor(xDelta, 1); else xDelta = P.band(xDelta, 0xFFFE);
  if (movingUp) yDelta = P.bor(yDelta, 1); else yDelta = P.band(yDelta, 0xFFFE);
  d[1] = P.s16(xDelta);
  d[2] = P.s16(yDelta);
  d[4] = 0;
  d[3] = 0;
};

// Lua: g3_pret.lua:1050 -- pokefirered/src/battle_anim_mons.c:1034
P.AnimTranslateLinear = function (s: S): boolean {
  const d = s.data;
  if (d[0] === 0) return true;
  const v1 = P.u16(d[1]);
  const v2 = P.u16(d[2]);
  const x = P.u16(P.u16(d[3]) + v1);
  const y = P.u16(P.u16(d[4]) + v2);
  if (P.band(v1, 1) !== 0) s.ox = -P.rshift(x, 8); else s.ox = P.rshift(x, 8);
  if (P.band(v2, 1) !== 0) s.oy = -P.rshift(y, 8); else s.oy = P.rshift(y, 8);
  d[3] = P.s16(x);
  d[4] = P.s16(y);
  d[0] = d[0] - 1;
  return false;
};

// Lua: g3_pret.lua:1065
P.AnimTranslateLinear_WithFollowup = function (s: S): void {
  if (P.AnimTranslateLinear(s)) P.SetCallbackToStoredInData6(s);
};

// Lua: g3_pret.lua:1069
P.StartAnimLinearTranslation = function (s: S, vm: any): void {
  s.data[1] = s.x;
  s.data[3] = s.y;
  P.InitAnimLinearTranslation(s);
  s.callbackFn = P.AnimTranslateLinear_WithFollowup;
  s.callbackFn(s, vm);
};

// Lua: g3_pret.lua:1078 -- pokefirered/src/battle_anim_mons.c:1074
P.InitAnimLinearTranslationWithSpeed = function (s: S): void {
  const d = s.data;
  const v1 = P.abs(d[2] - d[1]) * 256;
  d[0] = P.s16(P.div(v1, d[0]));
  P.InitAnimLinearTranslation(s);
};

// Lua: g3_pret.lua:1085
P.InitAnimLinearTranslationWithSpeedAndPos = function (s: S, vm: any): void {
  s.data[1] = s.x;
  s.data[3] = s.y;
  P.InitAnimLinearTranslationWithSpeed(s);
  s.callbackFn = P.AnimTranslateLinear_WithFollowup;
  s.callbackFn(s, vm);
};

// Lua: g3_pret.lua:1094 -- pokefirered/src/battle_anim_mons.c:1091
P.InitAnimFastLinearTranslation = function (s: S): void {
  const d = s.data;
  const xDiff = d[2] - d[1];
  const yDiff = d[4] - d[3];
  let x2 = P.u16(P.abs(xDiff) * 16);
  let y2 = P.u16(P.abs(yDiff) * 16);
  x2 = P.u16(P.div(x2, d[0]));
  y2 = P.u16(P.div(y2, d[0]));
  if (xDiff < 0) x2 = P.bor(x2, 1); else x2 = P.band(x2, 0xFFFE);
  if (yDiff < 0) y2 = P.bor(y2, 1); else y2 = P.band(y2, 0xFFFE);
  d[1] = P.s16(x2);
  d[2] = P.s16(y2);
  d[4] = 0;
  d[3] = 0;
};

// Lua: g3_pret.lua:1110
P.AnimFastTranslateLinear = function (s: S): boolean {
  const d = s.data;
  if (d[0] === 0) return true;
  const v1 = P.u16(d[1]);
  const v2 = P.u16(d[2]);
  const x = P.u16(P.u16(d[3]) + v1);
  const y = P.u16(P.u16(d[4]) + v2);
  if (P.band(v1, 1) !== 0) s.ox = -P.rshift(x, 4); else s.ox = P.rshift(x, 4);
  if (P.band(v2, 1) !== 0) s.oy = -P.rshift(y, 4); else s.oy = P.rshift(y, 4);
  d[3] = P.s16(x);
  d[4] = P.s16(y);
  d[0] = d[0] - 1;
  return false;
};

// Lua: g3_pret.lua:1125
P.AnimFastTranslateLinearWaitEnd = function (s: S): void {
  if (P.AnimFastTranslateLinear(s)) P.SetCallbackToStoredInData6(s);
};

// Lua: g3_pret.lua:1129
P.InitAndRunAnimFastLinearTranslation = function (s: S, vm: any): void {
  s.data[1] = s.x;
  s.data[3] = s.y;
  P.InitAnimFastLinearTranslation(s);
  s.callbackFn = P.AnimFastTranslateLinearWaitEnd;
  s.callbackFn(s, vm);
};

// Lua: g3_pret.lua:1138 -- pokefirered/src/battle_anim_mons.c:757
P.InitAnimArcTranslation = function (s: S): void {
  s.data[1] = s.x;
  s.data[3] = s.y;
  P.InitAnimLinearTranslation(s);
  s.data[6] = P.s16(P.div(0x8000, s.data[0]));
  s.data[7] = 0;
};

// Lua: g3_pret.lua:1146
P.TranslateAnimHorizontalArc = function (s: S): boolean {
  if (P.AnimTranslateLinear(s)) return true;
  s.data[7] = P.s16(s.data[7] + s.data[6]);
  s.oy = s.oy + P.Sin(P.band(P.rshift(P.u16(s.data[7]), 8), 0xFF), s.data[5]);
  return false;
};

// Lua: g3_pret.lua:1153
P.TranslateAnimVerticalArc = function (s: S): boolean {
  if (P.AnimTranslateLinear(s)) return true;
  s.data[7] = P.s16(s.data[7] + s.data[6]);
  s.ox = s.ox + P.Sin(P.band(P.rshift(P.u16(s.data[7]), 8), 0xFF), s.data[5]);
  return false;
};

// Lua: g3_pret.lua:1160
P.SetSpritePrimaryCoordsFromSecondaryCoords = function (s: S): void {
  s.x = s.x + s.ox;
  s.y = s.y + s.oy;
  s.ox = 0;
  s.oy = 0;
};

// Lua: g3_pret.lua:1168 -- pokefirered/src/battle_anim_mons.c:735
P.SetAnimSpriteInitialXOffset = function (s: S, vm: any, xOffset: number): void {
  const ax = P.coordAtk(vm, P.COORD_X);
  const tx = P.coordTgt(vm, P.COORD_X);
  if (ax > tx) {
    s.x = s.x - xOffset;
  } else if (ax < tx) {
    s.x = s.x + xOffset;
  } else if (!P.atkIsPlayer(vm)) {
    s.x = s.x - xOffset;
  } else {
    s.x = s.x + xOffset;
  }
};

// Lua: g3_pret.lua:1183 -- pokefirered/src/battle_anim_mons.c:792
P.InitSpritePosToAnimTarget = function (s: S, vm: any, respect?: boolean): void {
  if (!respect) {
    s.x = P.coordTgt(vm, P.COORD_X);
    s.y = P.coordTgt(vm, P.COORD_Y);
  }
  P.SetAnimSpriteInitialXOffset(s, vm, s.ga[0]);
  s.y = s.y + s.ga[1];
};

// Lua: g3_pret.lua:1192
P.InitSpritePosToAnimAttacker = function (s: S, vm: any, respect?: boolean): void {
  if (!respect) {
    s.x = P.coordAtk(vm, P.COORD_X);
    s.y = P.coordAtk(vm, P.COORD_Y);
  } else {
    s.x = P.coordAtk(vm, P.COORD_X_2);
    s.y = P.coordAtk(vm, P.COORD_Y_PIC);
  }
  P.SetAnimSpriteInitialXOffset(s, vm, s.ga[0]);
  s.y = s.y + s.ga[1];
};

// Lua: g3_pret.lua:1204
P.SetSpriteCoordsToAnimAttackerCoords = function (s: S, vm: any): void {
  s.x = P.coordAtk(vm, P.COORD_X_2);
  s.y = P.coordAtk(vm, P.COORD_Y_PIC);
};

// Lua: g3_pret.lua:1210 -- pokefirered/src/battle_anim_mons.c:1409
P.AnimSpriteOnMonPos = function (s: S, vm: any): void {
  if (s.data[0] === 0) {
    const respect = s.ga[3] === 0;
    if (s.ga[2] === 0) {
      P.InitSpritePosToAnimAttacker(s, vm, respect);
    } else {
      P.InitSpritePosToAnimTarget(s, vm, respect);
    }
    s.data[0] = s.data[0] + 1;
  } else if (s.animEnded || s.affineAnimEnded) {
    destroy(s);
  }
};

// Lua: g3_pret.lua:1225 -- pokefirered/src/battle_anim_mons.c:1440
P.TranslateAnimSpriteToTargetMonLocation = function (s: S, vm: any): void {
  const respect = P.band(s.ga[5], 0xFF00) === 0;
  const coordType = (P.band(s.ga[5], 0xFF) === 0) ? P.COORD_Y_PIC : P.COORD_Y;
  P.InitSpritePosToAnimAttacker(s, vm, respect);
  if (!P.atkIsPlayer(vm)) s.ga[2] = -s.ga[2];
  s.data[0] = s.ga[4];
  s.data[2] = P.coordTgt(vm, P.COORD_X_2) + s.ga[2];
  s.data[4] = P.coordTgt(vm, coordType) + s.ga[3];
  s.callbackFn = P.StartAnimLinearTranslation;
  P.StoreSpriteCallbackInData6(s, destroy);
};

// Lua: g3_pret.lua:1238 -- pokefirered/src/battle_anim_mons.c:1463
P.AnimThrowProjectile = function (s: S, vm: any): void {
  P.InitSpritePosToAnimAttacker(s, vm, true);
  if (!P.atkIsPlayer(vm)) s.ga[2] = -s.ga[2];
  s.data[0] = s.ga[4];
  s.data[2] = P.coordTgt(vm, P.COORD_X_2) + s.ga[2];
  s.data[4] = P.coordTgt(vm, P.COORD_Y_PIC) + s.ga[3];
  s.data[5] = s.ga[5];
  P.InitAnimArcTranslation(s);
  s.callbackFn = function (sp: S): void {
    if (P.TranslateAnimHorizontalArc(sp)) destroy(sp);
  };
};

// Lua: g3_pret.lua:1251
P.monSprite = function (vm: any, animBattler: unknown): [any, any] {
  const side = P.side(vm, animBattler);
  if (side == null) return [null, null];
  return [Anim().present(side), side];
};

// Lua: g3_pret.lua:1258 -- pokefirered/src/scanline_effect.c:221
P.Wave = function (startLine: number, endLine: number, frequency: number, amplitude: number,
  delayInterval: number): Record<string, any> {
  const w: Record<string, any> = {
    startLine, endLine,
    waveLength: floor(256 / frequency), offset: 0,
    framesUntilMove: delayInterval, delay: delayInterval, buf: [] as number[],
  };
  let theta = 0;
  for (let i = 0; i <= 255; i++) {
    w.buf[i] = P.div(Trig.SINE[theta + 1]! * amplitude, 256);
    theta = mod(theta + frequency, 256);
  }
  // Lua: g3_pret.lua:1269 -- function w.step(self, base) (called w:step(base))
  w.step = function (self: Record<string, any>, base?: number | null): number[] {
    base = base ?? 0;
    const out: number[] = [];
    let off = self.offset;
    for (let i = self.startLine; i <= self.endLine - 1; i++) {
      out[i] = (self.buf[off] ?? 0) + base;
      off = off + 1;
    }
    if (self.framesUntilMove !== 0) {
      self.framesUntilMove = self.framesUntilMove - 1;
    } else {
      self.framesUntilMove = self.delay;
      self.offset = self.offset + 1;
      if (self.offset === self.waveLength) self.offset = 0;
    }
    return out;
  };
  return w;
};

// Lua: g3_pret.lua:1289
P.hShiftFromHofs = function (hofs: LuaTable): number[] {
  const out: number[] = [];
  for (const [k, v] of pairs<number>(hofs)) out[k as number] = -v;
  return out;
};

// Lua: g3_pret.lua:1295
P.rgb555 = function (cIn: unknown): LuaTable {
  const c = tonumber(cIn) ?? 0;
  return seq(mod(c, 32) / 31, mod(floor(c / 32), 32) / 31, mod(floor(c / 1024), 32) / 31);
};

// Lua: g3_pret.lua:1301 -- pokefirered/src/blend_palette.c:5
P.monBlend = function (p: any, coeff?: number | null, color?: unknown): void {
  if (!p) return;
  if ((coeff ?? 0) <= 0) {
    p.blendCoeff = 0;
    p.blendColor = null;
    return;
  }
  p.blendColor = (color != null && typeof color === "object") ? color : P.rgb555(color);
  p.blendCoeff = coeff! / 16;
};

// Lua: g3_pret.lua:1312
P.bgBlend = function (coeff?: number | null, color?: unknown): void {
  const A = Anim();
  if ((coeff ?? 0) <= 0) {
    A._bgBlend = null;
  } else {
    A._bgBlend = { coeff, color: color ?? 0 };
  }
};

// Lua: g3_pret.lua:1322
P.ATTR_HEIGHT = 0; P.ATTR_WIDTH = 1; P.ATTR_TOP = 2; P.ATTR_BOTTOM = 3; P.ATTR_LEFT = 4; P.ATTR_RIGHT = 5; P.ATTR_RAW_BOTTOM = 6;

// Lua: g3_pret.lua:1326 -- pokefirered/src/battle_anim_mons.c:1999
let PicSize: any = null;
function coordAttr(vm: any, side: any, attr: number): number {
  if (PicSize == null) {
    // pcall(require, "src.core.game3.battle.anim_port.g1_pic_sizes"): a static import, the ok branch.
    PicSize = PicSizesModule ?? false;
  }
  const sp = P.species(vm, side) ?? 0;
  const packed = PicSize ? ((side === "player") ? PicSize.back[sp] : PicSize.front[sp]) : null;
  const w = packed != null ? floor(packed / 256) : 64;
  const h = packed != null ? mod(packed, 256) : 64;
  if (attr === P.ATTR_HEIGHT) return h;
  if (attr === P.ATTR_WIDTH) return w;
  if (attr === P.ATTR_LEFT) return P.coord(vm, side, P.COORD_X_2) - P.div(w, 2);
  if (attr === P.ATTR_RIGHT) return P.coord(vm, side, P.COORD_X_2) + P.div(w, 2);
  if (attr === P.ATTR_TOP) return P.coord(vm, side, P.COORD_Y_PIC) - P.div(h, 2);
  if (attr === P.ATTR_BOTTOM) return P.coord(vm, side, P.COORD_Y_PIC) + P.div(h, 2);
  if (attr === P.ATTR_RAW_BOTTOM) return P.coord(vm, side, P.COORD_Y) + 31 - P.yDelta(vm, side);
  return 0;
}

// Lua: g3_pret.lua:1345
P.monHidden = function (_vm: any, side: unknown): boolean {
  const p = Anim().present(side);
  return (!p) || p.visible === false;
};

// Lua: g3_pret.lua:1351
P.isMonBg = function (side: unknown): boolean {
  const p = Anim().present(side);
  if (!p) return false;
  if (p.monbg != null) return truthy(p.monbg);
  return p.z === 10;
};

// Lua: g3_pret.lua:1359
P.setBg3 = function (vm: any, x?: number | null, y?: number | null): void {
  const A = Anim();
  A._bg3Scroll = { x: x ?? 0, y: y ?? 0 };
  if (vm) {
    vm.bg3 = vm.bg3 ?? {};
    vm.bg3.x = x ?? 0;
    vm.bg3.y = y ?? 0;
  }
};

// Lua: g3_pret.lua:1370
P.WININ_WIN0_CLR = 0x20; P.WININ_WIN1_CLR = 0x2000;
P.WINOUT_OUT_CLR = 0x20; P.WINOUT_OBJ_CLR = 0x2000;

// Lua: g3_pret.lua:1373
P.win = function (vm: any): any {
  if (!vm) return null;
  let w = vm._g3win;
  if (!w) {
    w = { winin: 0x3F3F, winout: 0x3F3F, win0: null, win1: null, objwin: false };
    vm._g3win = w;
  }
  return w;
};

// Lua: g3_pret.lua:1383 -- MASK_SHADER_SRC: effect "mask_write"; OVERLAY_SHADER_SRC: effect "mask_overlay".
let overlayRes: any = null;

// Lua: g3_pret.lua:1401
function overlayResources(): any {
  if (overlayRes != null) return overlayRes || null;
  // (Brian's `if not (love and love.graphics and ...newCanvas and ...newShader)`: the platform always has them.)
  let canvas: any, mask: any, over: any;
  try {
    canvas = G.newCanvas(240, 160);
    mask = G.newShader("mask_write");
    over = G.newShader("mask_overlay");
  } catch {
    overlayRes = false;
    return null;
  }
  canvas.setFilter("nearest", "nearest");
  overlayRes = { canvas, mask, over, quad: G.newQuad(0, 0, 240, 112, 240, 160) };
  return overlayRes;
}

// One quad re-pointed per draw (draw reads the viewport immediately).
let windowSpriteQuad: any = null;

// Lua: g3_pret.lua:1422
function drawWindowSprite(sp: S): void {
  const img = sp.image;
  if (!img || sp.invisible || !sp.active) return;
  const bw = sp._baseW ?? sp.w ?? 32;
  const bh = sp._baseH ?? sp.h ?? 32;
  const [iw, ih] = img.getDimensions();
  let q = windowSpriteQuad;
  if (q) {
    q.setViewport(sp.quadX ?? 0, sp.quadY ?? 0, bw, bh, iw, ih);
  } else {
    q = G.newQuad(sp.quadX ?? 0, sp.quadY ?? 0, bw, bh, iw, ih);
    windowSpriteQuad = q;
  }
  const sx = (sp.scaleX ?? 1) * (sp.hFlip ? -1 : 1);
  const sy = (sp.scaleY ?? 1) * (sp.vFlip ? -1 : 1);
  G.draw(img, q, Math.floor(sp.x + (sp.ox ?? 0) + 0.5), Math.floor(sp.y + (sp.oy ?? 0) + 0.5),
    sp.rotation ?? 0, sx, sy, bw / 2, bh / 2);
}

// Lua: g3_pret.lua:1441
function clrOf(bits: number | null | undefined, m: number): number { return (P.band(bits ?? 0, m) !== 0) ? 1 : 0; }

// Lua: g3_pret.lua:1444 -- pokefirered/src/palette.c:701
P.drawColorEffect = function (vm: any, effect: number, yIn: unknown): void {
  // (Brian's `if not (love and love.graphics) then return end`: the platform always has graphics.)
  let y = tonumber(yIn) ?? 0;
  if (y <= 0) return;
  if (y > 16) y = 16;
  let col: LuaTable;
  if (effect === 2) col = seq(1, 1, 1); else if (effect === 3) col = seq(0, 0, 0); else return;
  const w = P.win(vm);
  const windowed = w && (w.win0 || w.win1 || w.objwin);
  if (!windowed) {
    G.setColor(col[1], col[2], col[3], y / 16);
    G.rectangle("fill", 0, 0, 240, 112);
    G.setColor(1, 1, 1, 1);
    return;
  }
  const R = overlayResources();
  if (!R) return;
  G.push("all");
  G.setCanvas(R.canvas);
  G.origin();
  G.setBlendMode("replace", "premultiplied");
  G.setColor(1, 1, 1, 1);
  const outV = clrOf(w.winout, P.WINOUT_OUT_CLR);
  G.clear(outV, 0, 0, 1);
  if (w.objwin) {
    G.setShader(R.mask);
    R.mask.send("value", clrOf(w.winout, P.WINOUT_OBJ_CLR));
    for (const [, sp] of ipairs<S>(w.objSprites ?? seq())) drawWindowSprite(sp);
    G.setShader();
  }
  if (w.win1) {
    const v = clrOf(w.winin, P.WININ_WIN1_CLR);
    G.setColor(v, 0, 0, 1);
    G.rectangle("fill", w.win1[1], w.win1[3], w.win1[2] - w.win1[1], w.win1[4] - w.win1[3]);
  }
  if (w.win0) {
    const v = clrOf(w.winin, P.WININ_WIN0_CLR);
    G.setColor(v, 0, 0, 1);
    G.rectangle("fill", w.win0[1], w.win0[3], w.win0[2] - w.win0[1], w.win0[4] - w.win0[3]);
  }
  G.pop();
  G.push("all");
  G.setShader(R.over);
  R.over.send("fx", col);
  R.over.send("amount", y / 16);
  G.setColor(1, 1, 1, 1);
  G.draw(R.canvas, R.quad, 0, 0);
  G.pop();
};

// Lua: g3_pret.lua:1494
P.registerObjWindow = function (vm: any, s: S): void {
  const w = P.win(vm);
  if (!w) return;
  w.objSprites = w.objSprites ?? seq();
  for (let i = len(w.objSprites); i >= 1; i--) {
    const o = w.objSprites[i];
    if (!o.active || !o._objWindow) remove(w.objSprites, i);
  }
  s._objWindow = true;
  w.objSprites[len(w.objSprites) + 1] = s;
};

// Lua: g3_pret.lua:1506
function overlayStep(s: S, vm: any): void {
  const w = vm._g3win;
  const live = vm.hwFade != null || (w && (w.objwin || w.win0 || w.win1));
  if (!live) P.DestroyAnimSprite(s);
}

// Lua: g3_pret.lua:1512
function overlayDraw(s: S, vmIn: any): void {
  const vm = vmIn ?? s._vm;
  const hw = vm ? vm.hwFade : null;
  if (!hw) return;
  const cnt = tonumber(hw.cnt ?? hw[1]) ?? 0;
  const y = tonumber(hw.y ?? hw[2]) ?? 0;
  P.drawColorEffect(vm, P.band(P.rshift(cnt, 6), 3), y);
}

// Lua: g3_pret.lua:1521
P.ensureColorOverlay = function (vm: any): S | null | undefined {
  if (!vm) return undefined;
  const cur = vm._g3overlay;
  if (cur && cur.active && cur._g3overlayTok === cur._g3tok) return cur;
  const AnimSprites = P.AnimSprites();
  const s = AnimSprites.acquire({ x: 0, y: 0, z: 997, callback: genericCallback, w: 8, h: 8 });
  if (!s) return null;
  s._args = null; s._op = null; s._vm = vm;
  s.template = null;
  s.image = null;
  s._g3 = true;
  s._g3tok = newTok();
  s._g3overlayTok = s._g3tok;
  s._inited = true;
  s.callbackFn = overlayStep;
  s.customDraw = overlayDraw;
  s.zOverride = 997;
  s.pri = 0; s.sub = 0;
  vm._g3overlay = s;
  return s;
};

// Lua: g3_pret.lua:1543
sideArgLazy("coordAttr", coordAttr, 2);
sideArgLazy("monCenter", monCenter, 2);
sideArgLazy("monImage", monImage, 2);

export default P;
