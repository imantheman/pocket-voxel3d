// Port of gen1recomp src/core/game3/battle/anim_port/g4_pret.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered sprite/anim helpers for the g4 group (battle_anim_mons.c, sprite.c):
// coords, linear/arc translation, OAM anim + affine anim command runners.

import { mod, tonumber, truthy } from "../../../../../import/gen3/lua.ts";
import { G } from "../../../platform/graphics.ts";
import { random } from "../../../platform/rng.ts";
import { seq } from "../../../platform/lt.ts";
import { G3Lazy } from "../../lazy_registry.ts";
import { Trig } from "../../trig.ts";
import { Rng } from "../../rng.ts";
import { Audio } from "../../audio.ts";
import { AnimSprites } from "../anim_sprites.ts";
import { AnimPal } from "../anim_pal.ts";
import { AnimCoords } from "../anim_coords.ts";
import { PicCoords } from "../pic_coords.ts";
import { Anim } from "../anim.ts";
import { AnimVm } from "../anim_vm.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type S = Record<string, any>;

const floor = Math.floor;

export const P: Record<string, any> = {};

P.ANIM_ATTACKER = 0;
P.ANIM_TARGET = 1;
P.ANIM_ATK_PARTNER = 2;
P.ANIM_DEF_PARTNER = 3;
P.ARG_RET_ID = 7;

P.SOUND_PAN_ATTACKER = -64;
P.SOUND_PAN_TARGET = 63;

P.X = 0;
P.Y = 1;
P.X_2 = 2;
P.Y_PIC_OFFSET = 3;
P.Y_PIC_OFFSET_DEFAULT = 4;

// Lua: g4_pret.lua:28 -- pokefirered/src/battle_anim_mons.c:31
// setmetatable({}, {__index = ...}): a Proxy (numeric keys arrive as strings).
P.COORDS = new Proxy({}, {
  get(_t, k) {
    if (typeof k === "symbol") return undefined;
    const n = tonumber(k);
    return AnimCoords.coords(null, n != null ? n : k);
  },
});

// Lua: g4_pret.lua:30
P.s16 = function (v: any): number {
  v = floor(tonumber(v) ?? 0) & 0xFFFF;
  if (v >= 0x8000) v = v - 0x10000;
  return v;
};

// Lua: g4_pret.lua:36
P.u16 = function (v: any): number {
  return floor(tonumber(v) ?? 0) & 0xFFFF;
};

// Lua: g4_pret.lua:40
P.u8 = function (v: any): number {
  return floor(tonumber(v) ?? 0) & 0xFF;
};

// Lua: g4_pret.lua:44
P.s8 = function (v: any): number {
  v = floor(tonumber(v) ?? 0) & 0xFF;
  if (v >= 0x80) v = v - 0x100;
  return v;
};

// Lua: g4_pret.lua:50
P.asr = function (v: number, n: number): number {
  return floor(v) >> n;
};

// Lua: g4_pret.lua:54
P.cdiv = function (a: number, b: number): number {
  if (b === 0) return 0;
  const q = a / b;
  if (q >= 0) return floor(q);
  return -floor(-q);
};

// Lua: g4_pret.lua:62 -- pokefirered/include/trig.h:8
P.Sin = function (angle: number, amp: number): number {
  const v = Trig.SINE[(floor(angle) & 0xFF) + 1] as number;
  return P.s16((v * floor(amp)) >> 8);
};

// Lua: g4_pret.lua:67
P.Cos = function (angle: number, amp: number): number {
  const v = Trig.SINE[(floor(angle) & 0xFF) + 65] as number;
  return P.s16((v * floor(amp)) >> 8);
};

// Lua: g4_pret.lua:72
P.gSine = function (i: number): number {
  return Trig.SINE[(floor(i) & 0xFF) + 1] as number;
};

// Lua: g4_pret.lua:76
P.ArcTan2 = function (x: number, y: number): number {
  return Trig.arcTan2(x, y);
};

// Lua: g4_pret.lua:81 -- pokefirered/src/battle_anim_mons.c:1281
P.ArcTan2Neg = function (x: number, y: number): number {
  return (-P.ArcTan2(x, y)) & 0xFFFF;
};

// Lua: g4_pret.lua:85
P.other = function (side: any): string {
  return side === "player" ? "enemy" : "player";
};

// Lua: g4_pret.lua:89
P.atk = function (vm: any): any {
  if (vm && vm.allyPair && vm.allyPair()) return vm.attackerId();
  return (vm && vm.attackerSide) ? vm.attackerSide() : "player";
};

// Lua: g4_pret.lua:94
P.tgt = function (vm: any): any {
  if (vm && vm.allyPair && vm.allyPair()) return vm.targetId();
  return (vm && vm.targetSide) ? vm.targetSide() : "enemy";
};

// Lua: g4_pret.lua:99
P.sideId = function (side: any): number {
  if (typeof side === "number") return mod(side, 2);
  return side === "player" ? 0 : 1;
};

// Lua: g4_pret.lua:104
P.battlerSide = function (vm: any, animBattler: any): any {
  animBattler = tonumber(animBattler) ?? 0;
  if (animBattler === 0) return P.atk(vm);
  if (animBattler === 1) return P.tgt(vm);
  if ((animBattler === 2 || animBattler === 3) && vm && vm.battlerId) return vm.battlerId(animBattler);
  return null;
};

// Lua: g4_pret.lua:112 -- returns [yOffset, elevation]
function species_offsets(side: any, species: any): [number, number] {
  // pcall(require, "src.core.game3.battle.pic_coords"): a real module, the ok path.
  const sp = tonumber(species);
  if (sp == null) return [0, 0];
  if (side === "player") {
    return [(PicCoords.back ? PicCoords.back[sp] : null) ?? 0, 0];
  }
  return [(PicCoords.front ? PicCoords.front[sp] : null) ?? 0, (PicCoords.elev ? PicCoords.elev[sp] : null) ?? 0];
}

// Lua: g4_pret.lua:123
P.species = function (vm: any, side: any): any {
  if (!vm) return null;
  if (vm._speciesBySide && vm._speciesBySide[side] != null) return vm._speciesBySide[side];
  if (vm.speciesForSide) return vm.speciesForSide(side);
  return null;
};

// Lua: g4_pret.lua:131 -- pokefirered/src/battle_anim_mons.c:105
function coord_raw(vm: any, side: any, coordType: number): number {
  const base = P.COORDS[side] ?? P.COORDS.enemy;
  if (coordType === P.X || coordType === P.X_2) return base.x;
  if (coordType === P.Y) return base.y;
  const [yoff, elev] = species_offsets(side, P.species(vm, side));
  let y = (yoff - elev + base.y) & 0xFF;
  if (coordType === P.Y_PIC_OFFSET) {
    if (side === "player") y = (y + 8) & 0xFF;
    if (y > 160 - 64 + 8) y = 160 - 64 + 8;
  }
  return y;
}

// Lua: g4_pret.lua:145 -- pokefirered/src/battle_anim_mons.c:305
function y_with_elevation_raw(vm: any, side: any): number {
  let y = P.coord(vm, side, P.Y);
  if (side !== "player") {
    const [, elev] = species_offsets(side, P.species(vm, side));
    y = (y - elev) & 0xFF;
  }
  return y;
}

// Lua: g4_pret.lua:154
// P.coord = AnimCoords.sideArg(P.coord, 2) (and yWithElevation): the wrapper is
// built on first call, not at load (no top-level call into an import).
let coordW: ((...a: any[]) => any) | null = null;
let yElevW: ((...a: any[]) => any) | null = null;
P.coord = function (vm: any, side: any, coordType: number): number {
  return (coordW ??= AnimCoords.sideArg(coord_raw, 2))(vm, side, coordType);
};
P.yWithElevation = function (vm: any, side: any): number {
  return (yElevW ??= AnimCoords.sideArg(y_with_elevation_raw, 2))(vm, side);
};

// Lua: g4_pret.lua:158 -- pokefirered/src/battle_anim_mons.c:286
P.substituteY = function (side: any): number {
  const id = AnimCoords.idOf(side) ?? 1;
  return P.COORDS[id].y + (AnimCoords.sideOf(id) !== "player" ? 16 : 17);
};

// Lua: g4_pret.lua:164 -- pokefirered/src/battle_anim_mons.c:1908
P.subpriorityOf = function (side: any): number {
  return AnimCoords.subpriority(side);
};

// Lua: g4_pret.lua:168
P.zFor = function (priority: any, subpriority: any): number {
  priority = tonumber(priority) ?? 2;
  subpriority = tonumber(subpriority) ?? 0;
  if (AnimCoords.isDouble()) {
    // package.loaded["src.core.game3.battle.anim"]
    return AnimCoords.zFor(priority, subpriority, Anim ? Anim._vm : null);
  }
  if (priority <= 1) return 900 + mod(255 - subpriority, 100);
  let z = 500 - 10 * subpriority - 1;
  if (priority >= 3) z = Math.min(z, 99);
  if (z < 0) z = 0;
  if (z > 899) z = 899;
  return z;
};

// Lua: g4_pret.lua:183
P.setPriority = function (s: S, priority: any, subpriority: any): void {
  s.oamPriority = priority ?? s.oamPriority ?? 2;
  if (subpriority != null) s.subpriority = subpriority;
  s.z = P.zFor(s.oamPriority, s.subpriority);
};

// Lua: g4_pret.lua:189
P.args = function (vm: any): any {
  return (vm && vm.args) ? vm.args : {};
};

// Lua: g4_pret.lua:194 -- pokefirered/src/battle_anim_mons.c:735
P.setInitialXOffset = function (vm: any, s: S, xOffset: number): void {
  const ax = P.coord(vm, P.atk(vm), P.X);
  const tx = P.coord(vm, P.tgt(vm), P.X);
  if (ax > tx) {
    s.x = s.x - xOffset;
  } else if (ax < tx) {
    s.x = s.x + xOffset;
  } else if (P.atk(vm) !== "player") {
    s.x = s.x - xOffset;
  } else {
    s.x = s.x + xOffset;
  }
};

// Lua: g4_pret.lua:209 -- pokefirered/src/battle_anim_mons.c:792
P.initPosToTarget = function (vm: any, s: S, respect: any): void {
  const a = P.args(vm);
  if (!truthy(respect)) {
    s.x = P.coord(vm, P.tgt(vm), P.X);
    s.y = P.coord(vm, P.tgt(vm), P.Y);
  }
  P.setInitialXOffset(vm, s, a[0] ?? 0);
  s.y = s.y + (a[1] ?? 0);
};

// Lua: g4_pret.lua:220 -- pokefirered/src/battle_anim_mons.c:805
P.initPosToAttacker = function (vm: any, s: S, respect: any): void {
  const a = P.args(vm);
  const side = P.atk(vm);
  if (!truthy(respect)) {
    s.x = P.coord(vm, side, P.X);
    s.y = P.coord(vm, side, P.Y);
  } else {
    s.x = P.coord(vm, side, P.X_2);
    s.y = P.coord(vm, side, P.Y_PIC_OFFSET);
  }
  P.setInitialXOffset(vm, s, a[0] ?? 0);
  s.y = s.y + (a[1] ?? 0);
};

// Lua: g4_pret.lua:235 -- pokefirered/src/battle_anim_mons.c:2098 (returns [x, y])
P.averagePositions = function (vm: any, side: any, respect: any): [number, number] {
  let xt = P.X, yt = P.Y;
  if (truthy(respect)) { xt = P.X_2; yt = P.Y_PIC_OFFSET; }
  const id = AnimCoords.idOf(side) ?? 1;
  const x = P.coord(vm, id, xt), y = P.coord(vm, id, yt);
  if (!AnimCoords.isDouble()) return [x, y];
  const partner = AnimCoords.partner(id);
  const px = P.coord(vm, partner, xt), py = P.coord(vm, partner, yt);
  return [P.cdiv(x + px, 2), P.cdiv(y + py, 2)];
};

// Lua: g4_pret.lua:246
P.destroy = function (s: S): void {
  AnimSprites.release(s);
};

// Lua: g4_pret.lua:250
P.storeCb = function (s: S, fn: any): void {
  s._stored = fn;
};

// Lua: g4_pret.lua:254
P.runStored = function (s: S): void {
  s.callback = s._stored ?? P.destroy;
};

// Lua: g4_pret.lua:258
P.dummy = function (): void {};

// Lua: g4_pret.lua:260
P.isInvisible = function (s: S): boolean {
  return s.visible === false;
};

// Lua: g4_pret.lua:264
P.setInvisible = function (s: S, v: any): void {
  s.visible = !truthy(v);
};

// Lua: g4_pret.lua:269 -- pokefirered/src/battle_anim_mons.c:988
P.initLinear = function (s: S): void {
  const d = s.data;
  const x = d[2] - d[1];
  const y = d[4] - d[3];
  const speed = d[0];
  let xd = (Math.abs(x) << 8) & 0xFFFF;
  let yd = (Math.abs(y) << 8) & 0xFFFF;
  if (speed !== 0) {
    xd = floor(xd / speed) & 0xFFFF;
    yd = floor(yd / speed) & 0xFFFF;
  }
  if (x < 0) xd = xd | 1; else xd = xd & 0xFFFE;
  if (y < 0) yd = yd | 1; else yd = yd & 0xFFFE;
  d[1] = P.s16(xd);
  d[2] = P.s16(yd);
  d[4] = 0;
  d[3] = 0;
};

// Lua: g4_pret.lua:289 -- pokefirered/src/battle_anim_mons.c:1034
P.translateLinear = function (s: S): boolean {
  const d = s.data;
  if (d[0] === 0) return true;
  const v1 = P.u16(d[1]);
  const v2 = P.u16(d[2]);
  const x = P.u16(P.u16(d[3]) + v1);
  const y = P.u16(P.u16(d[4]) + v2);
  if ((v1 & 1) !== 0) s.ox = -(x >>> 8); else s.ox = x >>> 8;
  if ((v2 & 1) !== 0) s.oy = -(y >>> 8); else s.oy = y >>> 8;
  d[3] = P.s16(x);
  d[4] = P.s16(y);
  d[0] = P.s16(d[0] - 1);
  return false;
};

// Lua: g4_pret.lua:304
P.translateLinearFollowup = function (s: S): void {
  if (P.translateLinear(s)) P.runStored(s);
};

// Lua: g4_pret.lua:309 -- pokefirered/src/battle_anim_mons.c:1016
P.startLinear = function (s: S): void {
  s.data[1] = s.x;
  s.data[3] = s.y;
  P.initLinear(s);
  s.callback = P.translateLinearFollowup;
  s.callback(s);
};

// Lua: g4_pret.lua:318 -- pokefirered/src/battle_anim_mons.c:1074
P.initLinearWithSpeed = function (s: S): void {
  const d = s.data;
  const v1 = Math.abs(d[2] - d[1]) << 8;
  if (d[0] !== 0) d[0] = P.s16(P.cdiv(v1, d[0]));
  P.initLinear(s);
};

// Lua: g4_pret.lua:325
P.initLinearWithSpeedAndPos = function (s: S): void {
  s.data[1] = s.x;
  s.data[3] = s.y;
  P.initLinearWithSpeed(s);
  s.callback = P.translateLinearFollowup;
  s.callback(s);
};

// Lua: g4_pret.lua:334 -- pokefirered/src/battle_anim_mons.c:757
P.initArc = function (s: S): void {
  s.data[1] = s.x;
  s.data[3] = s.y;
  P.initLinear(s);
  const speed = s.data[0];
  s.data[6] = speed !== 0 ? P.s16(P.cdiv(0x8000, speed)) : 0;
  s.data[7] = 0;
};

// Lua: g4_pret.lua:344 -- pokefirered/src/battle_anim_mons.c:766
P.translateHArc = function (s: S): boolean {
  if (P.translateLinear(s)) return true;
  s.data[7] = P.s16(s.data[7] + s.data[6]);
  s.oy = s.oy + P.Sin((P.u16(s.data[7]) >>> 8) & 0xFF, s.data[5]);
  return false;
};

// Lua: g4_pret.lua:351
P.translateVArc = function (s: S): boolean {
  if (P.translateLinear(s)) return true;
  s.data[7] = P.s16(s.data[7] + s.data[6]);
  s.ox = s.ox + P.Sin((P.u16(s.data[7]) >>> 8) & 0xFF, s.data[5]);
  return false;
};

// Lua: g4_pret.lua:359 -- pokefirered/src/battle_anim_mons.c:1091
P.initFastLinear = function (s: S): void {
  const d = s.data;
  const x = d[2] - d[1];
  const y = d[4] - d[3];
  let x2 = (Math.abs(x) << 4) & 0xFFFF;
  let y2 = (Math.abs(y) << 4) & 0xFFFF;
  if (d[0] !== 0) {
    x2 = floor(x2 / d[0]) & 0xFFFF;
    y2 = floor(y2 / d[0]) & 0xFFFF;
  }
  if (x < 0) x2 = x2 | 1; else x2 = x2 & 0xFFFE;
  if (y < 0) y2 = y2 | 1; else y2 = y2 & 0xFFFE;
  d[1] = P.s16(x2);
  d[2] = P.s16(y2);
  d[4] = 0;
  d[3] = 0;
};

// Lua: g4_pret.lua:377
P.fastTranslateLinear = function (s: S): boolean {
  const d = s.data;
  if (d[0] === 0) return true;
  const v1 = P.u16(d[1]);
  const v2 = P.u16(d[2]);
  const x = P.u16(P.u16(d[3]) + v1);
  const y = P.u16(P.u16(d[4]) + v2);
  if ((v1 & 1) !== 0) s.ox = -(x >>> 4); else s.ox = x >>> 4;
  if ((v2 & 1) !== 0) s.oy = -(y >>> 4); else s.oy = y >>> 4;
  d[3] = P.s16(x);
  d[4] = P.s16(y);
  d[0] = P.s16(d[0] - 1);
  return false;
};

// Lua: g4_pret.lua:393 -- pokefirered/src/battle_anim_mons.c:1116
P.initAndRunFastLinear = function (s: S): void {
  s.data[1] = s.x;
  s.data[3] = s.y;
  P.initFastLinear(s);
  s.callback = function (sp: S): void {
    if (P.fastTranslateLinear(sp)) P.runStored(sp);
  };
  s.callback(s);
};

// Lua: g4_pret.lua:404 -- pokefirered/src/battle_anim_mons.c:521
P.waitAnimForDuration = function (s: S): void {
  if (s.data[0] > 0) {
    s.data[0] = s.data[0] - 1;
  } else {
    P.runStored(s);
  }
};

// Lua: g4_pret.lua:413 -- pokefirered/src/battle_anim_mons.c:576
P.translateSpriteLinearFixedPoint = function (s: S): void {
  const d = s.data;
  if (d[0] > 0) {
    d[0] = d[0] - 1;
    d[3] = P.s16(d[3] + d[1]);
    d[4] = P.s16(d[4] + d[2]);
    s.ox = d[3] >> 8;
    s.oy = d[4] >> 8;
  } else {
    P.runStored(s);
  }
};

// Lua: g4_pret.lua:427 -- pokefirered/src/battle_anim_mons.c:562
P.translateSpriteLinear = function (s: S): void {
  const d = s.data;
  if (d[0] > 0) {
    d[0] = d[0] - 1;
    s.ox = s.ox + d[1];
    s.oy = s.oy + d[2];
  } else {
    P.runStored(s);
  }
};

// Lua: g4_pret.lua:439 -- pokefirered/src/battle_anim_mons.c:412
P.translateInCircle = function (s: S): void {
  const d = s.data;
  if (d[3] !== 0) {
    s.ox = P.Sin(d[0], d[1]);
    s.oy = P.Cos(d[0], d[1]);
    d[0] = d[0] + d[2];
    if (d[0] >= 0x100) d[0] = d[0] - 0x100; else if (d[0] < 0) d[0] = d[0] + 0x100;
    d[3] = d[3] - 1;
  } else {
    P.runStored(s);
  }
};

// Lua: g4_pret.lua:453 -- pokefirered/src/battle_anim_mons.c:486
P.translateInEllipse = function (s: S): void {
  const d = s.data;
  if (d[3] !== 0) {
    s.ox = P.Sin(d[0], d[1]);
    s.oy = P.Cos(d[0], d[4]);
    d[0] = d[0] + d[2];
    if (d[0] >= 0x100) d[0] = d[0] - 0x100; else if (d[0] < 0) d[0] = d[0] + 0x100;
    d[3] = d[3] - 1;
  } else {
    P.runStored(s);
  }
};

// Lua: g4_pret.lua:467 -- pokefirered/src/battle_anim_mons.c:701
P.runStoredWhenAffineEnds = function (s: S): void {
  if (s.affineAnimEnded) P.runStored(s);
};

// Lua: g4_pret.lua:471
P.runStoredWhenAnimEnds = function (s: S): void {
  if (s.animEnded) P.runStored(s);
};

// Lua: g4_pret.lua:476 -- pokefirered/src/sprite.c:897 (returns [w, h])
function frame_tiles(s: S): [number, number] {
  const bw = s._baseW ?? s.w ?? 16;
  const bh = s._baseH ?? s.h ?? 16;
  return [bw, bh];
}

// Lua: g4_pret.lua:482
P.Random = function (): number {
  // pcall(require, "src.core.game3.rng"): a real module, the ok path.
  if (Rng && Rng.Random) return Rng.Random();
  return random(0, 0xFFFF);
};

// Lua: g4_pret.lua:488
P.drawTileRun = function (s: S, vm: any): void {
  let img = s.image;
  if (!img || s.visible === false) return;
  const [bw, bh] = frame_tiles(s);
  const [iw, ih] = img.getDimensions();
  const tw = Math.max(1, floor(iw / 8));
  const cols = Math.max(1, floor(bw / 8)), rows = Math.max(1, floor(bh / 8));
  s._runQuads = s._runQuads ?? {};
  G.push();
  G.translate(floor(s.x + (s.ox ?? 0) + 0.5), floor(s.y + (s.oy ?? 0) + 0.5));
  G.rotate(s.rotation ?? 0);
  G.scale((s.scaleX ?? 1) * (s.hFlip ? -1 : 1), (s.scaleY ?? 1) * (s.vFlip ? -1 : 1));
  G.setColor(1, 1, 1, s._drawAlpha ?? s.alpha ?? 1);
  const pimg = AnimPal.beginSprite(s, img, vm);
  if (pimg) img = pimg;
  for (let r = 0; r <= rows - 1; r++) {
    for (let c = 0; c <= cols - 1; c++) {
      const idx = s._tileRun + r * cols + c;
      let q = s._runQuads[idx];
      if (!q) {
        q = G.newQuad(mod(idx, tw) * 8, floor(idx / tw) * 8, 8, 8, iw, ih);
        s._runQuads[idx] = q;
      }
      G.draw(img, q, c * 8 - bw / 2, r * 8 - bh / 2);
    }
  }
  if (pimg) AnimPal.finish();
  G.pop();
};

// Lua: g4_pret.lua:518
P.applyTile = function (s: S, tile: any): void {
  if (tile == null || tile < 0) return;
  const bw = frame_tiles(s)[0];
  let iw = s._sheetW;
  if (iw == null && s.image && s.image.getWidth) iw = s.image.getWidth();
  iw = iw ?? bw;
  const tilesWide = Math.max(1, floor(iw / 8));
  s._tile = tile;
  s.quadX = mod(tile, tilesWide) * 8;
  s.quadY = floor(tile / tilesWide) * 8;
  if (s.quadX + bw > iw) {
    s._tileRun = tile;
    s.customDraw = P.drawTileRun;
  } else if (s.customDraw === P.drawTileRun) {
    s._tileRun = null;
    s.customDraw = null;
  }
};

// Lua: g4_pret.lua:537
P.addTile = function (s: S, n: number): void {
  P.applyTile(s, (s._tile ?? 0) + n);
};

// Lua: g4_pret.lua:541
function apply_flip(s: S, cmd: any): void {
  if (s.affineMode && s.affineMode !== 0) return;
  const hf = truthy(cmd.h);
  const vf = truthy(cmd.v);
  s.hFlip = (hf !== truthy(s.pretHFlip));
  s.vFlip = (vf !== truthy(s.pretVFlip));
}

// Lua: g4_pret.lua:549
function anim_frame(s: S, cmd: any): void {
  let dur = cmd.d ?? 0;
  if (dur > 0) dur = dur - 1;
  s.animDelayCounter = dur;
  apply_flip(s, cmd);
  P.applyTile(s, cmd.f);
}

// Lua: g4_pret.lua:559
function continue_anim(s: S): void {
  const anims = s._g4a ? s._g4a[s.animNum ?? 0] : null;
  if (!anims) return;
  if ((s.animDelayCounter ?? 0) > 0) {
    if (!s.animPaused) s.animDelayCounter = s.animDelayCounter - 1;
    const c = anims[(s.animCmdIndex ?? 0) + 1];
    if (c && c.f != null) apply_flip(s, c);
  } else if (!s.animPaused) {
    s.animCmdIndex = (s.animCmdIndex ?? 0) + 1;
    const c = anims[s.animCmdIndex + 1];
    if (!c) {
      s.animCmdIndex = s.animCmdIndex - 1;
      s.animEnded = true;
      return;
    }
    ANIM_CMD(s, anims, c);
  }
}

// Lua: g4_pret.lua:578
function jump_to_loop_top(s: S, anims: any): void {
  if ((s.animLoopCounter ?? 0) !== 0) {
    s.animCmdIndex = s.animCmdIndex - 1;
    while (true) {
      const prev = anims[s.animCmdIndex];
      if (prev && prev.loop != null) break;
      if (s.animCmdIndex === 0) break;
      s.animCmdIndex = s.animCmdIndex - 1;
    }
    s.animCmdIndex = s.animCmdIndex - 1;
  }
}

// Lua: g4_pret.lua:591
function ANIM_CMD(s: S, anims: any, c: any): void {
  if (c.e) {
    s.animCmdIndex = s.animCmdIndex - 1;
    s.animEnded = true;
  } else if (c.jump != null) {
    s.animCmdIndex = c.jump;
    const f = anims[s.animCmdIndex + 1];
    if (f) anim_frame(s, f);
  } else if (c.loop != null) {
    if ((s.animLoopCounter ?? 0) !== 0) {
      s.animLoopCounter = s.animLoopCounter - 1;
    } else {
      s.animLoopCounter = c.loop;
    }
    jump_to_loop_top(s, anims);
    continue_anim(s);
  } else {
    anim_frame(s, c);
  }
}

// Lua: g4_pret.lua:612
function begin_anim(s: S): void {
  const anims = s._g4a ? s._g4a[s.animNum ?? 0] : null;
  s.animCmdIndex = 0;
  s.animEnded = false;
  s.animLoopCounter = 0;
  if (!anims) return;
  const c = anims[1];
  if (c && c.f != null && c.f !== -1) {
    s.animBeginning = false;
    anim_frame(s, c);
  }
}

// Lua: g4_pret.lua:625
P.startAnim = function (s: S, num: any): void {
  s.animNum = num;
  s.animBeginning = true;
  s.animEnded = false;
};

// Lua: g4_pret.lua:632 -- pokefirered/src/sprite.c:1360
P.seekAnim = function (s: S, idx: number): void {
  const paused = s.animPaused;
  s.animCmdIndex = idx - 1;
  s.animDelayCounter = 0;
  s.animBeginning = false;
  s.animEnded = false;
  s.animPaused = false;
  continue_anim(s);
  if ((s.animDelayCounter ?? 0) !== 0) s.animDelayCounter = s.animDelayCounter + 1;
  s.animPaused = paused;
};

// Lua: g4_pret.lua:644
function convert_scale(scale: number): number {
  if (scale === 0) return 0;
  return P.s16(P.cdiv(0x10000, scale));
}

// Lua: g4_pret.lua:649
P.setMatrix = function (s: S, sxParam: number, syParam: number, rot: number): void {
  s._mat = s._mat ?? {};
  s._mat.sx = sxParam; s._mat.sy = syParam; s._mat.rot = rot;
  s.scaleX = sxParam !== 0 ? (256 / sxParam) : 0;
  s.scaleY = syParam !== 0 ? (256 / syParam) : 0;
  s.rotation = -(P.u16(rot) / 65536) * 2 * Math.PI;
};

// Lua: g4_pret.lua:657
function aff_update_matrix(s: S): void {
  const a = s._g4as;
  P.setMatrix(s, convert_scale(a.xScale), convert_scale(a.yScale), a.rotation);
}

// Lua: g4_pret.lua:662
function aff_apply_rel(s: S, cmd: any): void {
  const a = s._g4as;
  a.xScale = P.s16(a.xScale + (cmd.xs ?? 0));
  a.yScale = P.s16(a.yScale + (cmd.ys ?? 0));
  a.rotation = (a.rotation + ((cmd.r ?? 0) << 8)) & 0xFF00;
  aff_update_matrix(s);
}

// Lua: g4_pret.lua:670
function aff_apply_frame(s: S, cmd: any): void {
  const a = s._g4as;
  const dur = cmd.d ?? 0;
  if (dur !== 0) {
    aff_apply_rel(s, cmd);
    a.delay = dur - 1;
  } else {
    a.xScale = cmd.xs ?? 0;
    a.yScale = cmd.ys ?? 0;
    a.rotation = ((cmd.r ?? 0) << 8) & 0xFFFF;
    aff_apply_rel(s, {});
    a.delay = 0;
  }
}

// Lua: g4_pret.lua:687
function continue_affine(s: S): void {
  const a = s._g4as;
  const cmds = s._g4af ? s._g4af[a.animNum ?? 0] : null;
  if (!cmds) return;
  if ((a.delay ?? 0) > 0) {
    if (!s.affineAnimPaused) {
      a.delay = a.delay - 1;
      const c = cmds[a.idx + 1];
      if (c) aff_apply_rel(s, c);
    }
  } else if (s.affineAnimPaused) {
    return;
  } else {
    a.idx = a.idx + 1;
    const c = cmds[a.idx + 1];
    if (!c) {
      a.idx = a.idx - 1;
      s.affineAnimEnded = true;
      return;
    }
    AFF_CMD(s, cmds, c);
  }
}

// Lua: g4_pret.lua:711
function AFF_CMD(s: S, cmds: any, c: any): void {
  const a = s._g4as;
  if (c.e) {
    s.affineAnimEnded = true;
    a.idx = a.idx - 1;
    aff_apply_rel(s, {});
  } else if (c.jump != null) {
    a.idx = c.jump;
    const f = cmds[a.idx + 1];
    if (f) aff_apply_frame(s, f);
  } else if (c.loop != null) {
    if ((a.loop ?? 0) !== 0) {
      a.loop = a.loop - 1;
    } else {
      a.loop = c.loop;
    }
    if (a.loop !== 0) {
      a.idx = a.idx - 1;
      while (true) {
        const prev = cmds[a.idx];
        if (prev && prev.loop != null) break;
        if (a.idx === 0) break;
        a.idx = a.idx - 1;
      }
      a.idx = a.idx - 1;
    }
    continue_affine(s);
  } else {
    aff_apply_frame(s, c);
  }
}

// Lua: g4_pret.lua:743
function begin_affine(s: S): void {
  const a = s._g4as;
  const cmds = s._g4af ? s._g4af[a.animNum ?? 0] : null;
  if (!cmds || !cmds[1]) return;
  a.idx = 0;
  a.delay = 0;
  a.loop = 0;
  s.affineAnimBeginning = false;
  s.affineAnimEnded = false;
  aff_apply_frame(s, cmds[1]);
}

// Lua: g4_pret.lua:755
function aff_state(s: S): any {
  if (!s._g4as) {
    s._g4as = { animNum: 0, idx: 0, delay: 0, loop: 0, xScale: 0x100, yScale: 0x100, rotation: 0 };
  }
  return s._g4as;
}

// Lua: g4_pret.lua:763 -- pokefirered/src/sprite.c:1363
P.startAffineAnim = function (s: S, num: any): void {
  const a = aff_state(s);
  a.animNum = num;
  a.idx = 0;
  a.delay = 0;
  a.loop = 0;
  a.xScale = 0x100;
  a.yScale = 0x100;
  a.rotation = 0;
  s.affineAnimBeginning = true;
  s.affineAnimEnded = false;
};

// Lua: g4_pret.lua:776
P.changeAffineAnim = function (s: S, num: any): void {
  const a = aff_state(s);
  a.animNum = num;
  s.affineAnimBeginning = true;
  s.affineAnimEnded = false;
};

// Lua: g4_pret.lua:784 -- pokefirered/src/battle_anim_mons.c:1244
P.trySetRotScale = function (s: S, xs: number, ys: number, rot: number): void {
  if (s.affineMode && s.affineMode !== 0) {
    s.affineAnimPaused = true;
    P.setMatrix(s, xs, ys, rot);
  }
};

// Lua: g4_pret.lua:791
P.tryResetAffine = function (s: S): void {
  P.trySetRotScale(s, 0x100, 0x100, 0);
  s.affineAnimPaused = false;
};

// Lua: g4_pret.lua:797 -- pokefirered/src/sprite.c:897
P.animate = function (s: S): void {
  if (s._g4a) {
    if (s.animBeginning) begin_anim(s); else continue_anim(s);
  }
  if (s._g4af && s.affineMode && s.affineMode !== 0) {
    aff_state(s);
    if (s.affineAnimBeginning) begin_affine(s); else continue_affine(s);
  }
};

// Lua: g4_pret.lua:807 -- AnimSprites.animate = P.animate
// The hook is installed when the first sprite gets a g4 template (setupTemplate
// below), not at load: no top-level write into an import inside the import
// cycle. AnimSprites only calls it for sprites with _g4anim, which only
// setupTemplate sets, so the effect is the same.
function hook_animate(): void {
  if (AnimSprites.animate !== P.animate) AnimSprites.animate = P.animate;
}

// Lua: g4_pret.lua:809
P.hasAnims = function (s: S): boolean {
  return s._g4anim === true;
};

// Lua: g4_pret.lua:813
P.setupTemplate = function (s: S, tpl: any): void {
  hook_animate();
  if (s._g4tpl === tpl) return;
  s._g4tpl = tpl;
  s._g4a = tpl.anims;
  s._g4af = tpl.affine;
  s._g4anim = true;
  s.affineMode = tpl.affineMode ?? 0;
  s.objBlend = truthy(tpl.objBlend);
  s.animNum = 0;
  s.animCmdIndex = 0;
  s.animDelayCounter = 0;
  s.animLoopCounter = 0;
  s.animEnded = false;
  s.animPaused = false;
  s.animBeginning = true;
  s._g4as = null;
  s.affineAnimPaused = false;
  s.affineAnimEnded = false;
  s.affineAnimBeginning = true;
  s.pretHFlip = false;
  s.pretVFlip = false;
  s.hFlip = false;
  s.vFlip = false;
  s.scaleX = 1;
  s.scaleY = 1;
  s.rotation = 0;
  if (tpl.priority != null) P.setPriority(s, tpl.priority, s.subpriority);
  if (tpl.anims && tpl.anims[0] && tpl.anims[0][1]) {
    P.applyTile(s, tpl.anims[0][1].f ?? 0);
  } else {
    P.applyTile(s, 0);
  }
};

// Lua: g4_pret.lua:847
P.setHFlip = function (s: S, v: any): void {
  s.pretHFlip = truthy(v);
  if (!(s.affineMode && s.affineMode !== 0)) s.hFlip = s.pretHFlip;
};

// Lua: g4_pret.lua:852
P.setVFlip = function (s: S, v: any): void {
  s.pretVFlip = truthy(v);
  if (!(s.affineMode && s.affineMode !== 0)) s.vFlip = s.pretVFlip;
};

// Lua: g4_pret.lua:857 -- returns [image, tagInfo]
P.tagImage = function (vm: any, tag: any): [any, any] {
  const pack = vm ? vm._pack : null;
  const t = (pack && pack.tags) ? pack.tags[tag] : null;
  return [t ? (t.image ?? null) : null, t];
};

// Lua: g4_pret.lua:863
P.createSprite = function (vm: any, tag: any, tpl: any, x: number, y: number, subpriority: any, cb: any, w?: any, h?: any): S | null {
  let [img, info] = P.tagImage(vm, tag) as [any, any];
  let sheetW = info ? info.w : null;
  const fw = w ?? (info ? info.frameW : null) ?? 16;
  if (img) {
    // package.loaded["src.core.game3.battle.anim_vm"]
    if (AnimVm && AnimVm.sheetImage) [img, sheetW] = AnimVm.sheetImage(vm, tag, fw);
  }
  const s = AnimSprites.acquire({
    x: x,
    y: y,
    image: img,
    tag: tag,
    w: w ?? (info ? info.frameW : null) ?? 16,
    h: h ?? (info ? info.frameH : null) ?? 16,
    subpriority: subpriority ?? 0,
  });
  if (!s) return null;
  s._baseW = w ?? (info ? info.frameW : null) ?? 16;
  s._baseH = h ?? (info ? info.frameH : null) ?? 16;
  s._sheetW = sheetW;
  s._vm = vm;
  s._pz = true;
  s._g4counted = null;
  s._g4tpl = null;
  s.ox = 0; s.oy = 0;
  s.subpriority = subpriority ?? 0;
  P.setPriority(s, (tpl ? tpl.priority : null) ?? 2, s.subpriority);
  if (tpl) P.setupTemplate(s, tpl);
  s.callback = cb ?? P.dummy;
  return s;
};

// Lua: g4_pret.lua:896
P.se = function (id: any, pan: any): void {
  // pcall(require, "src.core.game3.audio"): a real module, the ok path.
  if (Audio && Audio.playSe && id != null) {
    try {
      Audio.playSe(id, { pan: pan });
    } catch (_e) {
      // pcall(Audio.playSe, ...) swallows the error
    }
  }
};

// Lua: g4_pret.lua:903
P.present = function (side: any): any {
  // package.loaded["src.core.game3.battle.anim"] or require(...)
  return Anim.present(side);
};

// Lua: g4_pret.lua:908
P.stage = function (): any {
  return Anim.stage ? Anim.stage() : null;
};

// Lua: g4_pret.lua:913
P.setMonRotScale = function (p: any, xs: number, ys: number, rot: number): void {
  if (!p) return;
  p.sx = xs !== 0 ? (256 / xs) : 0;
  p.sy = ys !== 0 ? (256 / ys) : 0;
  p.rotation = -(P.u16(rot) / 65536) * 2 * Math.PI;
  p._rsX = xs; p._rsY = ys; p._rsRot = rot;
};

// Lua: g4_pret.lua:921
P.resetMonRotScale = function (p: any): void {
  if (!p) return;
  p.sx = 1; p.sy = 1; p.rotation = 0;
  p._rsX = 0x100; p._rsY = 0x100; p._rsRot = 0;
};

// Lua: g4_pret.lua:928 -- pokefirered/src/battle_anim_mons.c:1762
P.monYOffsetFromYScale = function (p: any, side: any, vm: any): void {
  if (!p) return;
  const sp = P.species(vm, side);
  // pcall(require, "src.core.game3.battle.pic_coords"): a real module, the ok path.
  let yoff = 0;
  if (sp != null && sp !== false) {
    const n = tonumber(sp) as number;
    if (side === "player") yoff = (PicCoords.back ? PicCoords.back[n] : null) ?? 0;
    else yoff = (PicCoords.front ? PicCoords.front[n] : null) ?? 0;
  }
  const v = 64 - yoff * 2;
  let d = p._rsY ?? 0x100;
  const rot = p._rsRot ?? 0;
  d = P.s16(floor(d * Math.cos(P.u16(rot) / 65536 * 2 * Math.PI)));
  let var2 = d !== 0 ? P.cdiv(v << 8, d) : 0;
  if (var2 > 128) var2 = 128;
  p.oy = P.cdiv(v - var2, 2);
};

// Lua: g4_pret.lua:947 -- pokefirered/src/palette.c
P.blend555 = function (color: number, coeff: number, target: number): number {
  let r = color & 31;
  let g = (color >>> 5) & 31;
  let b = (color >>> 10) & 31;
  const tr = target & 31;
  const tg = (target >>> 5) & 31;
  const tb = (target >>> 10) & 31;
  r = r + (((tr - r) * coeff) >> 4);
  g = g + (((tg - g) * coeff) >> 4);
  b = b + (((tb - b) * coeff) >> 4);
  return r | (g << 5) | (b << 10);
};

// Lua: g4_pret.lua:960
P.rgb = function (r: number, g: number, b: number): number {
  return r | (g << 5) | (b << 10);
};

// Lua: g4_pret.lua:964 -- returns [r, g, b]
P.rgbFloats = function (c: any): [number, number, number] {
  c = tonumber(c) ?? 0;
  return [(c & 31) / 31, ((c >>> 5) & 31) / 31, ((c >>> 10) & 31) / 31];
};

// Lua: g4_pret.lua:969
P.blendMon = function (side: any, coeff: any, color: any): void {
  const p = P.present(side);
  if (!p) return;
  const [r, g, b] = P.rgbFloats(color);
  p.blendColor = seq(r, g, b);
  p.blendCoeff = (tonumber(coeff) ?? 0) / 16;
  p.darken = (color === 0) ? p.blendCoeff : 0;
};

// Lua: g4_pret.lua:978
P.setBattlers = function (vm: any, atkSide: any, tgtSide: any): void {
  if (vm && vm.setBattlers) vm.setBattlers(atkSide, tgtSide);
};

// Lua: g4_pret.lua:982
P.ctx = function (vm: any): any {
  return (vm && vm.ctx) ? vm.ctx : {};
};

// Lua: g4_pret.lua:986
P.band = function (a: number, b: number): number { return a & b; };
P.bor = function (a: number, b: number): number { return a | b; };
P.bxor = function (a: number, b: number): number { return a ^ b; };
P.lshift = function (a: number, b: number): number { return a << b; };
P.rshift = function (a: number, b: number): number { return a >>> b; };

export default P;

// pcall(require, "src.core.game3.battle.anim_port.g4_pret") in anim_vm.lua
G3Lazy["src.core.game3.battle.anim_port.g4_pret"] = P;
