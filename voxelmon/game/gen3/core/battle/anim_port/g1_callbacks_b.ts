// Port of gen1recomp src/core/game3/battle/anim_port/g1_callbacks_b.lua (GPLv3 + additional terms; see LICENSE.md).
// Group 1 sprite callbacks, part B (battle_anim_effects_1.c: item steal, trick,
// lock-on, protect, music notes, finger sprites, ...). Brian's module returns
// `function(C, F)`, which g1_callbacks calls with its tables.
//
// Port notes:
// - NOT FAITHFUL (ES module order): Brian's module-scope code adds
//   P.PAL_PROTECT / PAL_LOCK_ON / PAL_MUSIC_NOTES / PARTICLES_COLOR_BLEND /
//   musicNotesRemap to g1_pret's P when the module is required. Writing to an
//   imported table at load is a module-scope read of the import, so that code
//   is `ensureTop()`, run (once) by the returned function and by every place
//   Brian requires this module for that side effect (g1_tasks).
// - Brian's module-scope aliases (s16, u16, Sin, ...) are not taken at load;
//   the functions call P.s16 / P.Sin ... directly.
// - math.random -> random() (platform/rng.ts).
// - Tables keyed [0] = ... (TRICK_BAG_COORDS, INCLINE_MON_COORDS,
//   PARTICLES_COLOR_BLEND, AnimPal.load's colours) are JS arrays (keys 0..n);
//   their rows are Lua sequences ([null, ...]).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod } from "../../../../../import/gen3/lua.ts";
import { random } from "../../../platform/rng.ts";
import { AnimPal } from "../anim_pal.ts";
import { P } from "./g1_pret.ts";
import { S } from "./g1_sprite.ts";

const floor = Math.floor;

// Lua: g1_callbacks_b.lua:11
function random16(): number {
  return random(0, 0xFFFF);
}

// Lua: g1_callbacks_b.lua:15
function atk_opp(s: any): boolean {
  return P.isOpponent(P.atk(s._vm));
}

// Lua: g1_callbacks_b.lua:19
function c8(r: number, g: number, b: number): any[] {
  return [null, r * 8 / 255, g * 8 / 255, b * 8 / 255];
}

// Lua: g1_callbacks_b.lua:23
function c555(c: number): any[] {
  return [null, (c & 31) / 31, ((c >>> 5) & 31) / 31, ((c >>> 10) & 31) / 31];
}

let topDone = false;
// Lua: g1_callbacks_b.lua:27..58 (module-scope code; see the header)
export function ensureTop(): void {
  if (topDone) return;
  topDone = true;
  // pokefirered/graphics/battle_anims/sprites/protect.png
  P.PAL_PROTECT = [null, c8(31, 31, 31), c8(23, 31, 27), c8(15, 31, 23), c8(7, 31, 19), c8(7, 26, 16), c8(7, 22, 14), c8(7, 17, 11)];
  // pokefirered/graphics/battle_anims/sprites/lock_on.png
  P.PAL_LOCK_ON = [null, c8(0, 29, 0), c8(0, 19, 0), c8(0, 9, 0), false, false, false, false, c8(31, 0, 0), c8(20, 0, 0)];
  // pokefirered/graphics/battle_anims/sprites/music_notes.png
  P.PAL_MUSIC_NOTES = [null, c8(31, 31, 31), c8(27, 25, 25), c8(27, 22, 23), c8(31, 13, 22), c8(31, 7, 19)];

  // pokefirered/src/battle_anim_effects_1.c:1999
  P.PARTICLES_COLOR_BLEND = [
    [null, "MUSIC_NOTES", 0x7FFF, P.RGB(31, 26, 28), P.RGB(31, 22, 26), P.RGB(31, 17, 24), P.RGB(31, 13, 22)],
    [null, "BENT_SPOON", 0x7FFF, P.RGB(25, 31, 26), P.RGB(20, 31, 21), P.RGB(15, 31, 16), P.RGB(10, 31, 12)],
    [null, "SPHERE_TO_CUBE", 0x7FFF, P.RGB(31, 31, 24), P.RGB(31, 31, 17), P.RGB(31, 31, 10), P.RGB(31, 31, 3)],
    [null, "LARGE_FRESH_EGG", 0x7FFF, P.RGB(26, 28, 31), P.RGB(21, 26, 31), P.RGB(16, 24, 31), P.RGB(12, 22, 31)],
  ];

  // Lua: g1_callbacks_b.lua:42
  P.musicNotesRemap = function (row: any): any {
    const src: any[] = [null], dst: any[] = [null];
    for (let i = 1; i <= 5; i++) {
      src[i] = P.PAL_MUSIC_NOTES[i];
      dst[i] = c555(row[i + 1]);
    }
    return { src, dst };
  };
}

// pokefirered/src/battle_anim_effects_1.c:882
const TRICK_BAG_COORDS: any[] = [
  [null, 5, 24, 1], [null, 0, 4, 0], [null, 8, 16, -1], [null, 0, 2, 0], [null, 8, 16, 1], [null, 0, 2, 0],
  [null, 8, 16, 1], [null, 0, 2, 0], [null, 8, 16, 1], [null, 0, 16, 0], [null, 0, 0, 127],
];

// pokefirered/src/battle_anim_effects_1.c:1571
const INCLINE_MON_COORDS: any[] = [[null, 64, 64], [null, 0, -64], [null, -64, 64], [null, 32, -32]];

// Lua: g1_callbacks_b.lua:60
export default function G1CallbacksB(C: Record<string, any>, F: Record<string, any>): void {
  ensureTop();

  // Lua: g1_callbacks_b.lua:63 -- pokefirered/src/battle_anim_effects_1.c:3009
  function init_item_bag(s: any, c: number): void {
    const a = (s.x << 8) | (s.y & 0xFF);
    const b = (s.data[6] << 8) | (s.data[7] & 0xFF);
    s.data[5] = P.s16(a);
    s.data[6] = P.s16(b);
    s.data[7] = P.s16(c << 8);
  }

  // Lua: g1_callbacks_b.lua:72 -- pokefirered/src/battle_anim_effects_1.c:3019
  F.MoveAlongLinearPath = function (s: any): boolean {
    const d = s.data;
    const xStart = P.u8(d[5] >> 8);
    const yStart = P.u8(d[5]);
    let xEnd = P.u8(d[6] >> 8);
    const yEnd = P.u8(d[6]);
    const total = d[7] >> 8;
    let cur = d[7] & 0xFF;
    if (xEnd === 0) xEnd = -32; else if (xEnd === 255) xEnd = P.DISPLAY_WIDTH + 32;
    const dy = P.s16(yEnd - yStart);
    const r0 = P.s16(xEnd - xStart);
    s.x = P.cdiv(r0 * cur, total) + xStart;
    s.y = P.cdiv(dy * cur, total) + yStart;
    cur = cur + 1;
    if (cur === total) return true;
    d[7] = P.s16((total << 8) | cur);
    return false;
  };

  // Lua: g1_callbacks_b.lua:92 -- pokefirered/src/battle_anim_effects_1.c:3050
  F.ItemStealStep2 = function (s: any): void {
    if (s.data[0] === 10) S.startAffineAnim(s, 1);
    s.data[0] = s.data[0] + 1;
    if (s.data[0] > 50) S.destroy(s);
  };

  // Lua: g1_callbacks_b.lua:99 -- pokefirered/src/battle_anim_effects_1.c:3060
  F.ItemStealStep1 = function (s: any): void {
    const d = s.data;
    d[0] = d[0] + P.cdiv(d[3] * 128, d[4]);
    if (d[0] >= 128) {
      d[1] = d[1] + 1;
      d[0] = 0;
    }
    s.oy = P.Sin(d[0] + 128, 30 - d[1] * 8);
    if (F.MoveAlongLinearPath(s)) {
      s.oy = 0;
      d[0] = 0;
      s._cb = F.ItemStealStep2;
    }
  };

  // Lua: g1_callbacks_b.lua:115 -- pokefirered/src/battle_anim_effects_1.c:3078
  C.Present = S.wrap(function (s: any): void {
    const vm = s._vm;
    S.initPosToAttacker(s, false);
    const tx = P.coord(vm, P.tgt(vm), P.X);
    const ty = P.coord(vm, P.tgt(vm), P.Y);
    s.data[6] = tx;
    s.data[7] = ty + 10;
    init_item_bag(s, 60);
    s.data[3] = 3;
    s.data[4] = 60;
    s._cb = F.ItemStealStep1;
  });

  // Lua: g1_callbacks_b.lua:129 -- pokefirered/src/battle_anim_effects_1.c:3105
  F.KnockOffOpponentsItem = function (s: any): void {
    const d = s.data;
    d[0] = d[0] + P.cdiv(d[3] * 128, d[4]);
    if (d[0] > 0x7F) {
      d[1] = d[1] + 1;
      d[0] = 0;
    }
    s.oy = P.Sin(d[0] + 0x80, 30 - d[1] * 8);
    if (F.MoveAlongLinearPath(s)) {
      s.oy = 0;
      d[0] = 0;
      S.destroy(s);
    }
  };

  // Lua: g1_callbacks_b.lua:145 -- pokefirered/src/battle_anim_effects_1.c:3126
  C.KnockOffItem = S.wrap(function (s: any): void {
    const vm = s._vm;
    const ty = P.coord(vm, P.tgt(vm), P.Y);
    if (!P.isOpponent(P.tgt(vm))) {
      s.data[6] = 0;
      s.data[7] = ty + 10;
      init_item_bag(s, 40);
      s.data[3] = 3;
      s.data[4] = 60;
      s._cb = F.ItemStealStep1;
    } else {
      s.data[6] = 255;
      s.data[7] = ty + 10;
      init_item_bag(s, 40);
      s.data[3] = 3;
      s.data[4] = 60;
      s._cb = F.KnockOffOpponentsItem;
    }
  });

  // Lua: g1_callbacks_b.lua:166 -- pokefirered/src/battle_anim_effects_1.c:3158
  C.PresentHealParticle = S.wrap(function (s: any): void {
    s._cb = function (sp: any): void {
      const d = sp.data;
      if (d[0] === 0) {
        S.initPosToTarget(sp, false);
        d[1] = sp._A[2];
      }
      d[0] = d[0] + 1;
      sp.oy = d[1] * d[0];
      if (sp.animEnded) S.destroy(sp);
    };
    s._cb(s);
  });

  // Lua: g1_callbacks_b.lua:181 -- pokefirered/src/battle_anim_effects_1.c:3199
  F.ItemStealStep3 = function (s: any): void {
    const d = s.data, vm = s._vm;
    d[0] = d[0] + P.cdiv(d[3] * 128, d[4]);
    if (d[0] > 127) {
      d[1] = d[1] + 1;
      d[0] = 0;
    }
    s.oy = P.Sin(d[0] + 0x80, 30 - d[1] * 8);
    if (s.oy === 0) P.playSe(P.seId("SE_M_BUBBLE2"), P.adjustPanning(vm, P.SOUND_PAN_TARGET));
    if (F.MoveAlongLinearPath(s)) {
      s.oy = 0;
      d[0] = 0;
      s._cb = F.ItemStealStep2;
      P.playSe(P.seId("SE_M_BUBBLE2"), P.adjustPanning(vm, P.SOUND_PAN_ATTACKER));
    }
  };

  // Lua: g1_callbacks_b.lua:199 -- pokefirered/src/battle_anim_effects_1.c:3172
  C.ItemSteal = S.wrap(function (s: any): void {
    const vm = s._vm;
    S.initPosToTarget(s, false);
    const ax = P.coord(vm, P.atk(vm), P.X);
    const ay = P.coord(vm, P.atk(vm), P.Y);
    s.data[6] = ax;
    s.data[7] = ay + 10;
    init_item_bag(s, 60);
    s.data[3] = 3;
    s.data[4] = 60;
    s._cb = F.ItemStealStep3;
  });

  // Lua: g1_callbacks_b.lua:213 -- pokefirered/src/battle_anim_effects_1.c:3324
  F.TrickBagStep3 = function (s: any): void {
    if (s.data[0] > 20) { S.destroy(s); return; }
    s.visible = mod(s.data[0], 2) === 0;
    s.data[0] = s.data[0] + 1;
  };

  // Lua: g1_callbacks_b.lua:220 -- pokefirered/src/battle_anim_effects_1.c:3294
  F.TrickBagStep2 = function (s: any): void {
    const d = s.data;
    const row = TRICK_BAG_COORDS[d[0]];
    if (!row) { S.destroy(s); return; }
    if (d[2] === row[2]) {
      if (row[3] === 127) {
        d[0] = 0;
        s._cb = F.TrickBagStep3;
      }
      d[2] = 0;
      d[0] = d[0] + 1;
    } else {
      d[2] = d[2] + 1;
      d[1] = (row[1] * row[3] + d[1]) & 0xFF;
      if (P.u16(d[1] - 1) < 191) s.subpriority = 31; else s.subpriority = 29;
      s.ox = P.Cos(d[1], 60);
      s.oy = P.Sin(d[1], 20);
    }
  };

  // Lua: g1_callbacks_b.lua:241 -- pokefirered/src/battle_anim_effects_1.c:3264
  F.TrickBagStep1 = function (s: any): void {
    const d = s.data;
    if (d[3] === 0) {
      if (d[2] > 78) {
        d[3] = 1;
        S.startAffineAnim(s, 1);
      } else {
        d[2] = d[2] + P.cdiv(d[4], 10);
        d[4] = d[4] + 3;
        s.y = d[2];
      }
    } else if (d[3] === 1) {
      if (s.affineAnimEnded) {
        d[0] = 0;
        d[2] = 0;
        s._cb = F.TrickBagStep2;
      }
    }
  };

  // Lua: g1_callbacks_b.lua:262 -- pokefirered/src/battle_anim_effects_1.c:3227
  C.TrickBag = S.wrap(function (s: any): void {
    const A = s._A, d = s.data;
    if (d[0] === 0) {
      d[1] = A[1];
      s.x = 120;
      s.y = A[0];
      d[2] = A[0];
      d[4] = 20;
      s.ox = P.Cos(d[1], 60);
      s.oy = P.Sin(d[1], 20);
      s._cb = F.TrickBagStep1;
      if (d[1] > 0 && d[1] < 192) s.subpriority = 31; else s.subpriority = 29;
    }
  });

  // Lua: g1_callbacks_b.lua:278 -- pokefirered/src/battle_anim_effects_1.c:3646
  F.FlyingParticleStep = function (s: any): void {
    const d = s.data;
    const a = d[7];
    d[7] = d[7] + 1;
    s.oy = (d[1] * P.gSine(d[0])) >> 8;
    s.ox = d[2] * a;
    d[0] = (d[3] * a) & 0xFF;
    if (d[4] === 0) {
      if (s.ox + s.x <= 0xF7) return;
    } else {
      if (s.ox + s.x > -16) return;
    }
    S.destroy(s);
  };

  // Lua: g1_callbacks_b.lua:294 -- pokefirered/src/battle_anim_effects_1.c:3597
  C.FlyingParticle = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm, d = s.data;
    const side = (A[6] === 0) ? P.atk(vm) : P.tgt(vm);
    if (P.isOpponent(side)) {
      d[4] = 0;
      d[2] = A[3];
      s.x = -16;
    } else {
      d[4] = 1;
      d[2] = -A[3];
      s.x = 0x100;
    }
    d[1] = A[1];
    d[0] = A[2];
    d[3] = A[4];
    const sel = A[5];
    if (sel === 0) {
      s.y = A[0];
      s._pri = P.bgPriorityOf(side);
    } else if (sel === 1) {
      s.y = A[0];
      s._pri = P.bgPriorityOf(side) + 1;
    } else if (sel === 2) {
      s.y = P.coord(vm, side, P.Y_PIC_OFFSET) + A[0];
      s._pri = P.bgPriorityOf(side);
    } else if (sel === 3) {
      s.y = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + A[0];
      s._pri = P.bgPriorityOf(side) + 1;
    }
    s._cb = F.FlyingParticleStep;
  });

  // Lua: g1_callbacks_b.lua:327 -- pokefirered/src/battle_anim_effects_1.c:3755
  F.NeedleArmSpikeStep = function (s: any): void {
    const d = s.data;
    if (d[0] !== 0) {
      d[1] = P.s16(d[1] + d[3]);
      d[2] = P.s16(d[2] + d[4]);
      s.x = d[1] >> 4;
      s.y = d[2] >> 4;
      d[0] = d[0] - 1;
    } else {
      S.destroy(s);
    }
  };

  // Lua: g1_callbacks_b.lua:341 -- pokefirered/src/battle_anim_mons.c:1281
  function arctan2neg(x: number, y: number): number {
    const a = Math.atan2(y, x);
    const v = floor(a * 65536 / (2 * Math.PI) + 0.5) & 0xFFFF;
    return (-v) & 0xFFFF;
  }
  F.ArcTan2Neg = arctan2neg;

  // Lua: g1_callbacks_b.lua:349 -- pokefirered/src/battle_anim_effects_1.c:3699
  C.NeedleArmSpike = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm, d = s.data;
    if (A[4] === 0) {
      S.destroy(s);
      return;
    }
    let a: number, b: number;
    if (A[0] === 0) {
      a = P.u8(P.coord(vm, P.atk(vm), P.X_2));
      b = P.u8(P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET));
    } else {
      a = P.u8(P.coord(vm, P.tgt(vm), P.X_2));
      b = P.u8(P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET));
    }
    d[0] = A[4];
    if (A[1] === 0) {
      s.x = A[2] + a;
      s.y = A[3] + b;
      d[5] = a;
      d[6] = b;
    } else {
      s.x = a;
      s.y = b;
      d[5] = A[2] + a;
      d[6] = A[3] + b;
    }
    const x = P.u16(s.x);
    d[1] = P.s16(x * 16);
    const y = P.u16(s.y);
    d[2] = P.s16(y * 16);
    d[3] = P.s16(P.cdiv((d[5] - s.x) * 16, A[4]));
    d[4] = P.s16(P.cdiv((d[6] - s.y) * 16, A[4]));
    const c = arctan2neg(P.s16(d[5] - x), P.s16(d[6] - y));
    S.trySetRotScale(s, false, 0x100, 0x100, c);
    s._cb = F.NeedleArmSpikeStep;
  });

  // Lua: g1_callbacks_b.lua:387 -- pokefirered/src/battle_anim_effects_1.c:3771
  F.WhipHitWaitEnd = function (s: any): void {
    if (s.animEnded) S.destroy(s);
  };

  // Lua: g1_callbacks_b.lua:392 -- pokefirered/src/battle_anim_effects_1.c:3794
  C.WhipHit = S.wrap(function (s: any): void {
    const A = s._A;
    if (!atk_opp(s)) S.startAnim(s, 1);
    s._cb = F.WhipHitWaitEnd;
    S.setInitialXOffset(s, A[0]);
    s.y = s.y + A[1];
  });

  // Lua: g1_callbacks_b.lua:401 -- pokefirered/src/battle_anim_effects_1.c:3899
  F.SliceStep = function (s: any): void {
    const d = s.data;
    d[3] = P.s16(d[3] + d[1]);
    d[4] = P.s16(d[4] + d[2]);
    if (d[5] === 0) d[1] = P.s16(d[1] + 0x18); else d[1] = P.s16(d[1] - 0x18);
    d[2] = P.s16(d[2] - 0x18);
    s.ox = d[3] >> 8;
    s.oy = d[4] >> 8;
    d[0] = d[0] + 1;
    if (d[0] === 20) {
      S.store(s, S.destroy);
      d[0] = 3;
      s._cb = S.waitAnimForDuration;
    }
  };

  // Lua: g1_callbacks_b.lua:417
  function slice_setup(s: any, a: number, b: number): void {
    const A = s._A, vm = s._vm, d = s.data;
    s.x = a;
    s.y = b;
    if (!P.isOpponent(P.tgt(vm))) s.y = s.y + 8;
    s._cb = F.SliceStep;
    if (A[2] === 0) {
      s.x = s.x + A[0];
    } else {
      s.x = s.x - A[0];
      s._hFlip = true;
    }
    s.y = s.y + A[1];
    d[1] = P.s16(d[1] - 0x400);
    d[2] = P.s16(d[2] + 0x400);
    d[5] = A[2];
    if (d[5] === 1) d[1] = -d[1];
  }

  // Lua: g1_callbacks_b.lua:437 -- pokefirered/src/battle_anim_effects_1.c:3822
  C.CuttingSlice = S.wrap(function (s: any): void {
    const vm = s._vm;
    slice_setup(s, P.coord(vm, P.tgt(vm), P.X), P.coord(vm, P.tgt(vm), P.Y));
  });

  // Lua: g1_callbacks_b.lua:443 -- pokefirered/src/battle_anim_effects_1.c:3848
  C.AirCutterSlice = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    const tgt = P.tgt(vm);
    let a: number, b: number;
    if (A[3] === 1) {
      const partner = P.isOpponent(tgt) ? [null, 112, 80] : [null, 48, 40];
      a = partner[1]!;
      b = partner[2]!;
    } else {
      a = P.u8(P.coord(vm, tgt, P.X));
      b = P.u8(P.coord(vm, tgt, P.Y));
    }
    slice_setup(s, a, b);
  });

  // Lua: g1_callbacks_b.lua:458 -- pokefirered/src/battle_anim_effects_1.c:4006
  F.ProtectStep = function (s: any): void {
    const d = s.data, vm = s._vm;
    d[5] = P.s16(d[5] + 96);
    s.ox = -(d[5] >> 8);
    d[1] = d[1] + 1;
    if (d[1] > 1) {
      d[1] = 0;
      const f = AnimPal.writeFaded("PROTECT");
      if (f) {
        const saved = f[1];
        for (let i = 1; i <= 6; i++) f[i] = f[i + 1];
        f[7] = saved;
      }
    }
    if (d[7] > 6 && d[0] > 0) {
      d[6] = d[6] + 1;
      if (d[6] > 1) {
        d[6] = 0;
        d[7] = d[7] - 1;
        P.setBldAlpha(vm, 16 - d[7], d[7]);
      }
    }
    if (d[0] > 0) {
      d[0] = d[0] - 1;
    } else {
      d[6] = d[6] + 1;
      if (d[6] > 1) {
        d[6] = 0;
        d[7] = d[7] + 1;
        P.setBldAlpha(vm, 16 - d[7], d[7]);
        if (d[7] === 16) {
          s.visible = false;
          s._cb = function (sp: any): void {
            P.clearBld(sp._vm);
            S.destroy(sp);
          };
        }
      }
    }
  };

  // Lua: g1_callbacks_b.lua:500 -- pokefirered/src/battle_anim_effects_1.c:3986
  C.Protect = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    s.x = P.coord(vm, P.atk(vm), P.X) + A[0];
    s.y = P.coord(vm, P.atk(vm), P.Y) + A[1];
    if (!atk_opp(s)) {
      s._pri = P.bgPriorityOf(P.atk(vm)) + 1;
    } else {
      s._pri = P.bgPriorityOf(P.atk(vm));
    }
    s.data[0] = A[2];
    s.data[7] = 16;
    P.setBldAlpha(vm, 16 - s.data[7], s.data[7]);
    s._cb = F.ProtectStep;
  });

  // Lua: g1_callbacks_b.lua:516 -- pokefirered/src/battle_anim_effects_1.c:4138
  F.MilkBottleStep2 = function (s: any): void {
    const d = s.data;
    if (d[3] <= 11) d[4] = d[4] + 2;
    if (P.u16(d[3] - 0x12) <= 0x17) d[4] = d[4] - 2;
    if (d[3] > 0x2F) d[4] = d[4] + 2;
    s.ox = P.cdiv(d[4], 9);
    s.oy = P.cdiv(d[4], 14);
    if (s.oy < 0) s.oy = -s.oy;
    d[3] = d[3] + 1;
    if (d[3] > 0x3B) d[3] = 0;
  };

  // Lua: g1_callbacks_b.lua:529 -- pokefirered/src/battle_anim_effects_1.c:4065
  F.MilkBottleStep1 = function (s: any): void {
    const d = s.data, vm = s._vm;
    const st = d[0];
    if (st === 0) {
      d[2] = d[2] + 1;
      if (d[2] > 0) {
        d[2] = 0;
        d[1] = d[1] + 1;
        if ((d[1] & 1) !== 0) {
          if (d[6] <= 15) d[6] = d[6] + 1;
        } else if (d[7] > 0) {
          d[7] = d[7] - 1;
        }
        P.setBldAlpha(vm, d[6], d[7]);
        if (d[6] === 16 && d[7] === 0) {
          d[1] = 0;
          d[0] = d[0] + 1;
        }
      }
    } else if (st === 1) {
      d[1] = d[1] + 1;
      if (d[1] > 8) {
        d[1] = 0;
        S.startAffineAnim(s, 1);
        d[0] = d[0] + 1;
      }
    } else if (st === 2) {
      F.MilkBottleStep2(s);
      d[1] = d[1] + 1;
      if (d[1] > 2) {
        d[1] = 0;
        s.y = s.y + 1;
      }
      d[2] = d[2] + 1;
      if (d[2] <= 29) return;
      if ((d[2] & 1) !== 0) {
        if (d[6] > 0) d[6] = d[6] - 1;
      } else if (d[7] <= 15) {
        d[7] = d[7] + 1;
      }
      P.setBldAlpha(vm, d[6], d[7]);
      if (d[6] === 0 && d[7] === 16) {
        d[1] = 0;
        d[2] = 0;
        d[0] = d[0] + 1;
      }
    } else if (st === 3) {
      s.visible = false;
      d[0] = d[0] + 1;
    } else if (st === 4) {
      P.clearBld(vm);
      S.destroy(s);
    }
  };

  // Lua: g1_callbacks_b.lua:585 -- pokefirered/src/battle_anim_effects_1.c:4049
  C.MilkBottle = S.wrap(function (s: any): void {
    const vm = s._vm;
    s.x = P.coord(vm, P.tgt(vm), P.X_2);
    s.y = P.s16(P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + 0xFFE8);
    for (let i = 0; i <= 7; i++) s.data[i] = 0;
    s.data[7] = 16;
    P.setBldAlpha(vm, s.data[6], s.data[7]);
    s._cb = F.MilkBottleStep1;
  });

  // Lua: g1_callbacks_b.lua:596 -- pokefirered/src/battle_anim_effects_1.c:4159
  C.GrantingStars = S.wrap(function (s: any): void {
    const A = s._A;
    if (A[2] === 0) S.setToAttackerCoords(s);
    S.setInitialXOffset(s, A[0]);
    s.y = s.y + A[1];
    s.data[0] = A[5];
    s.data[1] = A[3];
    s.data[2] = A[4];
    S.store(s, S.destroy);
    s._cb = S.translateSpriteLinearFixedPoint;
  });

  // Lua: g1_callbacks_b.lua:609 -- pokefirered/src/battle_anim_effects_1.c:4173
  C.SparklingStars = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    const side = (A[2] === 0) ? P.atk(vm) : P.tgt(vm);
    if (A[6] === 0) {
      s.x = P.coord(vm, side, P.X);
      s.y = P.coord(vm, side, P.Y) + A[1];
    } else {
      s.x = P.coord(vm, side, P.X_2);
      s.y = P.coord(vm, side, P.Y_PIC_OFFSET) + A[1];
    }
    S.setInitialXOffset(s, A[0]);
    s.data[0] = A[5];
    s.data[1] = A[3];
    s.data[2] = A[4];
    S.store(s, S.destroy);
    s._cb = S.translateSpriteLinearFixedPoint;
  });

  // Lua: g1_callbacks_b.lua:628 -- pokefirered/src/battle_anim_effects_1.c:4262
  F.SleepLetterZStep = function (s: any): void {
    const d = s.data;
    s.oy = -P.cdiv(d[0], 0x28);
    s.ox = P.cdiv(d[4], 10);
    d[4] = P.s16(d[4] + d[3] * 2);
    d[0] = P.s16(d[0] + d[1]);
    d[1] = d[1] + 1;
    if (d[1] > 60) S.destroy(s);
  };

  // Lua: g1_callbacks_b.lua:639 -- pokefirered/src/battle_anim_effects_1.c:4242
  C.SleepLetterZ = S.wrap(function (s: any): void {
    const A = s._A;
    S.setToAttackerCoords(s);
    if (!atk_opp(s)) {
      s.x = s.x + A[0];
      s.y = s.y + A[1];
      s.data[3] = 1;
    } else {
      s.x = s.x - A[0];
      s.y = s.y + A[1];
      s.data[3] = -1;
      S.startAffineAnim(s, 1);
    }
    s._cb = F.SleepLetterZStep;
  });

  // Lua: g1_callbacks_b.lua:656 -- pokefirered/src/battle_anim_effects_1.c:4406
  F.LockOnStep6 = function (s: any): void {
    const d = s.data;
    if (mod(d[0], 3) === 0) {
      d[1] = d[1] + 1;
      s.visible = !s.visible;
    }
    d[0] = d[0] + 1;
    if (d[1] === 8) S.destroy(s);
  };

  // Lua: g1_callbacks_b.lua:667 -- pokefirered/src/battle_anim_effects_1.c:4396
  F.LockOnStep5 = function (s: any): void {
    const vm = s._vm;
    if (vm && vm.args && P.u16(vm.args[7] ?? 0) === 0xFFFF) {
      s.data[1] = 0;
      s.data[0] = 0;
      s._cb = F.LockOnStep6;
    }
  };

  // Lua: g1_callbacks_b.lua:677 -- pokefirered/src/battle_anim_effects_1.c:4369
  F.LockOnStep4 = function (s: any): void {
    const d = s.data, vm = s._vm;
    if (d[2] === 0) {
      d[1] = d[1] + 3;
      if (d[1] > 16) d[1] = 16;
    } else {
      d[1] = d[1] - 3;
      if (d[1] < 0) d[1] = 0;
    }
    P.blendPalettes(P.palettesMask(vm, true, true, true, true, true, false, false), d[1], 0x7FFF);
    if (d[1] === 16) {
      d[2] = d[2] + 1;
      const ptag = AnimPal.spriteTag(s, "LOCK_ON");
      const u = AnimPal.unfadedOf(ptag);
      if (u) AnimPal.load(ptag, [u[8], u[9]], 1, 2);
      P.playSe(P.seId("SE_M_LEER"), P.adjustPanning(vm, P.SOUND_PAN_TARGET));
    } else if (d[1] === 0) {
      s._cb = F.LockOnStep5;
    }
  };

  // Lua: g1_callbacks_b.lua:699 -- pokefirered/src/battle_anim_effects_1.c:4322
  F.LockOnStep3 = function (s: any): void {
    const vm = s._vm;
    const ap = s._affParam ?? 0;
    if (ap === 0) {
      s.data[0] = 3;
      s.data[1] = 0;
      s.data[2] = 0;
      s._cb = S.waitAnimForDuration;
      S.store(s, F.LockOnStep4);
    } else {
      let a: number, b: number;
      if (ap === 1) { a = -8; b = -8; }
      else if (ap === 2) { a = -8; b = 8; }
      else if (ap === 3) { a = 8; b = -8; }
      else { a = 8; b = 8; }
      s.x = s.x + s.ox;
      s.y = s.y + s.oy;
      s.oy = 0;
      s.ox = 0;
      s.data[0] = 6;
      s.data[2] = P.coord(vm, P.tgt(vm), P.X_2) + a;
      s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + b;
      s._cb = S.startLinear;
      S.store(s, F.LockOnStep5);
    }
  };

  // Lua: g1_callbacks_b.lua:727 -- pokefirered/src/battle_anim_effects_1.c:4308
  F.LockOnStep2 = function (s: any): void {
    if ((s.data[5] >> 8) === 4) {
      s.data[0] = 10;
      s._cb = S.waitAnimForDuration;
      S.store(s, F.LockOnStep3);
    } else {
      s._cb = F.LockOnStep1;
    }
  };

  // Lua: g1_callbacks_b.lua:738 -- pokefirered/src/battle_anim_effects_1.c:4281
  F.LockOnStep1 = function (s: any): void {
    const d = s.data, vm = s._vm;
    if ((d[5] & 1) === 0) {
      d[0] = 1;
      s._cb = S.waitAnimForDuration;
      S.store(s, F.LockOnStep1);
    } else {
      s.x = s.x + s.ox;
      s.y = s.y + s.oy;
      s.oy = 0;
      s.ox = 0;
      d[0] = 8;
      const row = INCLINE_MON_COORDS[d[5] >> 8] ?? INCLINE_MON_COORDS[0];
      d[2] = s.x + row[1];
      d[4] = s.y + row[2];
      s._cb = S.startLinear;
      S.store(s, F.LockOnStep2);
      d[5] = d[5] + 0x100;
      P.playSe(P.seId("SE_M_LOCK_ON"), P.adjustPanning(vm, P.SOUND_PAN_TARGET));
    }
    d[5] = d[5] ^ 1;
  };

  // Lua: g1_callbacks_b.lua:762 -- pokefirered/src/battle_anim_effects_1.c:4272
  function lock_on_target(s: any): void {
    s.x = s.x - 32;
    s.y = s.y - 32;
    s.data[0] = 20;
    s._cb = S.waitAnimForDuration;
    S.store(s, F.LockOnStep1);
  }
  C.LockOnTarget = S.wrap(lock_on_target);

  // Lua: g1_callbacks_b.lua:772 -- pokefirered/src/battle_anim_effects_1.c:4419
  C.LockOnMoveTarget = S.wrap(function (s: any): void {
    const ap = s._A[0];
    s._affParam = ap;
    if (ap === 1) {
      s.x = s.x - 0x18;
      s.y = s.y - 0x18;
    } else if (ap === 2) {
      s.x = s.x - 0x18;
      s.y = s.y + 0x18;
      S.setOamFlip(s, false, true);
    } else if (ap === 3) {
      s.x = s.x + 0x18;
      s.y = s.y - 0x18;
      S.setOamFlip(s, true, false);
    } else {
      s.x = s.x + 0x18;
      s.y = s.y + 0x18;
      S.setOamFlip(s, true, true);
    }
    s._tile = (s._tile ?? 0) + 16;
    s._cb = lock_on_target;
    s._cb(s);
  });

  // Lua: g1_callbacks_b.lua:797 -- pokefirered/src/battle_anim_effects_1.c:4801
  F.FalseSwipeSliceStep3 = function (s: any): void {
    const d = s.data;
    d[0] = d[0] + 1;
    if (d[0] > 1) {
      d[0] = 0;
      s.visible = !s.visible;
      d[1] = d[1] + 1;
      if (d[1] > 8) S.destroy(s);
    }
  };

  // Lua: g1_callbacks_b.lua:809 -- pokefirered/src/battle_anim_effects_1.c:4794
  F.FalseSwipeSliceStep2 = function (s: any): void {
    s.data[0] = 0;
    s.data[1] = 0;
    s._cb = F.FalseSwipeSliceStep3;
  };

  // Lua: g1_callbacks_b.lua:816 -- pokefirered/src/battle_anim_effects_1.c:4782
  F.FalseSwipeSliceStep1 = function (s: any): void {
    const d = s.data;
    d[0] = d[0] + 1;
    if (d[0] > 8) {
      d[0] = 12;
      d[1] = 8;
      d[2] = 0;
      S.store(s, F.FalseSwipeSliceStep2);
      s._cb = S.translateSpriteLinear;
    }
  };

  // Lua: g1_callbacks_b.lua:829 -- pokefirered/src/battle_anim_effects_1.c:4745
  C.SlashSlice = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    const side = (A[0] === 0) ? P.atk(vm) : P.tgt(vm);
    s.x = P.coord(vm, side, P.X_2) + A[1];
    s.y = P.coord(vm, side, P.Y_PIC_OFFSET) + A[2];
    s.data[0] = 0;
    s.data[1] = 0;
    S.store(s, F.FalseSwipeSliceStep3);
    s._cb = S.runStoredWhenAnimEnds;
  });

  // Lua: g1_callbacks_b.lua:841 -- pokefirered/src/battle_anim_effects_1.c:4764
  C.FalseSwipeSlice = S.wrap(function (s: any): void {
    const vm = s._vm;
    s.x = P.coord(vm, P.tgt(vm), P.X_2) - 48;
    s.y = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET);
    S.store(s, F.FalseSwipeSliceStep1);
    s._cb = S.runStoredWhenAnimEnds;
  });

  // Lua: g1_callbacks_b.lua:850 -- pokefirered/src/battle_anim_effects_1.c:4772
  C.FalseSwipePositionedSlice = S.wrap(function (s: any): void {
    const vm = s._vm;
    s.x = P.coord(vm, P.tgt(vm), P.X_2) - 48 + s._A[0];
    s.y = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET);
    S.startAnim(s, 1);
    s.data[0] = 0;
    s.data[1] = 0;
    s._cb = F.FalseSwipeSliceStep3;
  });

  // Lua: g1_callbacks_b.lua:861 -- pokefirered/src/battle_anim_effects_1.c:4830
  F.EndureEnergyStep = function (s: any): void {
    const d = s.data;
    d[0] = d[0] + 1;
    if (d[0] > d[1]) {
      d[0] = 0;
      s.y = s.y - 1;
    }
    s.y = s.y - d[0];
    if (s.animEnded) S.destroy(s);
  };

  // Lua: g1_callbacks_b.lua:873 -- pokefirered/src/battle_anim_effects_1.c:4812
  C.EndureEnergy = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    const side = (A[0] === 0) ? P.atk(vm) : P.tgt(vm);
    s.x = P.coord(vm, side, P.X) + A[1];
    s.y = P.coord(vm, side, P.Y) + A[2];
    s.data[0] = 0;
    s.data[1] = A[3];
    s._cb = F.EndureEnergyStep;
  });

  // Lua: g1_callbacks_b.lua:884 -- pokefirered/src/battle_anim_effects_1.c:4856
  F.SharpenSphereStep = function (s: any): void {
    const d = s.data;
    d[0] = d[0] + 1;
    if (d[0] >= d[1]) {
      s.visible = !s.visible;
      if (s.visible) {
        d[4] = d[4] + 1;
        if ((d[4] & 1) === 0) P.playSe(P.seId("SE_M_SWAGGER2"), d[5]);
      }
      d[0] = 0;
      d[2] = d[2] + 1;
      if (d[2] > 1) {
        d[2] = 0;
        d[1] = d[1] + 1;
      }
    }
    if (s.animEnded && d[1] > 16 && !s.visible) S.destroy(s);
  };

  // Lua: g1_callbacks_b.lua:904 -- pokefirered/src/battle_anim_effects_1.c:4843
  C.SharpenSphere = S.wrap(function (s: any): void {
    const vm = s._vm;
    s.x = P.coord(vm, P.atk(vm), P.X_2);
    s.y = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET) - 12;
    s.data[0] = 0;
    s.data[1] = 2;
    s.data[2] = 0;
    s.data[3] = 0;
    s.data[4] = 0;
    s.data[5] = P.adjustPanning(vm, P.SOUND_PAN_ATTACKER);
    s._cb = F.SharpenSphereStep;
  });

  // Lua: g1_callbacks_b.lua:918 -- pokefirered/src/battle_anim_effects_1.c:4880
  C.Conversion = S.wrap(function (s: any): void {
    s._cb = function (sp: any): void {
      const vm = sp._vm;
      if (sp.data[0] === 0) {
        sp.x = P.coord(vm, P.atk(vm), P.X) + sp._A[0];
        sp.y = P.coord(vm, P.atk(vm), P.Y) + sp._A[1];
        sp.data[0] = sp.data[0] + 1;
      }
      if (vm && vm.args && P.u16(vm.args[7] ?? 0) === 0xFFFF) S.destroy(sp);
    };
    s._cb(s);
  });

  // Lua: g1_callbacks_b.lua:932 -- pokefirered/src/battle_anim_effects_1.c:4928
  F.Conversion2Step = function (s: any): void {
    const vm = s._vm;
    if (s.data[0] !== 0) {
      s.data[0] = s.data[0] - 1;
    } else {
      s.animPaused = false;
      s.data[0] = 30;
      s.data[2] = P.coord(vm, P.atk(vm), P.X_2);
      s.data[4] = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
      s._cb = S.startLinear;
      S.store(s, S.destroy);
    }
  };

  // Lua: g1_callbacks_b.lua:947 -- pokefirered/src/battle_anim_effects_1.c:4920
  C.Conversion2 = S.wrap(function (s: any): void {
    S.initPosToTarget(s, false);
    s.animPaused = true;
    s.data[0] = s._A[2];
    s._cb = F.Conversion2Step;
  });

  // Lua: g1_callbacks_b.lua:955 -- pokefirered/src/battle_anim_effects_1.c:4984
  C.Moon = S.wrap(function (s: any): void {
    s.x = s._A[0];
    s.y = s._A[1];
    s._w = 64;
    s._h = 64;
    s.data[0] = 0;
    s._cb = function (sp: any): void {
      if (sp.data[0] !== 0) S.destroy(sp);
    };
  });

  // Lua: g1_callbacks_b.lua:966 -- pokefirered/src/battle_anim_effects_1.c:5021
  F.MoonlightSparkleStep = function (s: any): void {
    const d = s.data;
    d[1] = d[1] + 1;
    if (d[1] > 1) {
      d[1] = 0;
      if (d[2] < 120) {
        s.y = s.y + 1;
        d[2] = d[2] + 1;
      }
    }
    if (d[0] !== 0) S.destroy(s);
  };

  // Lua: g1_callbacks_b.lua:980 -- pokefirered/src/battle_anim_effects_1.c:5009
  C.MoonlightSparkle = S.wrap(function (s: any): void {
    const vm = s._vm;
    s.x = P.coord(vm, P.atk(vm), P.X_2) + s._A[0];
    s.y = s._A[1];
    for (let i = 0; i <= 3; i++) s.data[i] = 0;
    s.data[4] = 1;
    s._cb = F.MoonlightSparkleStep;
  });

  // Lua: g1_callbacks_b.lua:990 -- pokefirered/src/battle_anim_effects_1.c:5193
  F.HornHitStep = function (s: any): void {
    const d = s.data;
    d[2] = P.s16(d[2] + d[3]);
    d[4] = P.s16(d[4] + d[5]);
    s.x = d[2] >> 7;
    s.y = d[4] >> 7;
    d[1] = d[1] - 1;
    if (d[1] === 1) {
      s.x = d[6];
      s.y = d[7];
    }
    if (d[1] === 0) S.destroy(s);
  };

  // Lua: g1_callbacks_b.lua:1005 -- pokefirered/src/battle_anim_effects_1.c:5146
  C.HornHit = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm, d = s.data;
    if (A[2] < 2) A[2] = 2;
    if (A[2] > 0x7F) A[2] = 0x7F;
    d[0] = 0;
    d[1] = A[2];
    s.x = P.coord(vm, P.tgt(vm), P.X_2) + A[0];
    s.y = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + A[1];
    d[6] = s.x;
    d[7] = s.y;
    if (!atk_opp(s)) {
      s.x = s.x - 40;
      s.y = s.y + 20;
      d[2] = P.s16(s.x << 7);
      d[3] = P.cdiv(0x1400, d[1]);
      d[4] = P.s16(s.y << 7);
      d[5] = P.cdiv(-0xA00, d[1]);
    } else {
      s.x = s.x + 40;
      s.y = s.y - 20;
      d[2] = P.s16(s.x << 7);
      d[3] = P.cdiv(-0x1400, d[1]);
      d[4] = P.s16(s.y << 7);
      d[5] = P.cdiv(0xA00, d[1]);
      S.setOamFlip(s, true, true);
    }
    s._cb = F.HornHitStep;
  });

  // Lua: g1_callbacks_b.lua:1035 -- pokefirered/src/battle_anim_effects_1.c:5283
  C.SuperFang = S.wrap(function (s: any): void {
    S.store(s, S.destroy);
    s._cb = S.runStoredWhenAnimEnds;
  });

  // Lua: g1_callbacks_b.lua:1041 -- pokefirered/src/battle_anim_effects_1.c:5365 -- returns [vx, vy]
  function wavy_velocity(x: number, y: number, f: number): [number, number] {
    if (x < 0) f = -f;
    const x2 = x * 256;
    let time = P.cdiv(x2, f);
    if (time === 0) time = 1;
    return [P.s16(P.cdiv(x2, time)), P.s16(P.cdiv(y * 256, time))];
  }

  // Lua: g1_callbacks_b.lua:1049
  function palette_tag_loaded(tag: unknown): boolean {
    return AnimPal.isLoaded(tag);
  }

  // Lua: g1_callbacks_b.lua:1054 -- pokefirered/src/battle_anim_effects_1.c:5381
  F.WavyMusicNotesStep = function (s: any): void {
    const d = s.data;
    d[0] = d[0] + 1;
    const trig = d[0] * 5 - (P.cdiv(d[0] * 5, 256) << 8);
    d[4] = P.s16(d[4] + d[6]);
    d[5] = P.s16(d[5] + d[7]);
    s.x = d[4] >> 4;
    s.y = d[5] >> 4;
    s.oy = P.Sin(trig, 15);
    const y = s.y;
    if (s.x < -16 || s.x > P.DISPLAY_WIDTH + 16 || y < -16 || y > P.DISPLAY_HEIGHT - 32) {
      S.destroy(s);
    } else if (d[3] !== 0) {
      d[2] = d[2] + 1;
      if (d[2] > d[3]) {
        d[2] = 0;
        d[1] = d[1] + 1;
        if (d[1] > 3) d[1] = 0;
        const tag = P.PARTICLES_COLOR_BLEND[d[1]][1];
        if (palette_tag_loaded(tag)) s._palTag = tag;
      }
    }
  };

  // Lua: g1_callbacks_b.lua:1079 -- pokefirered/src/battle_anim_effects_1.c:5336
  C.WavyMusicNotes = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm, d = s.data;
    S.setToAttackerCoords(s);
    S.startAnim(s, A[0]);
    const row = P.PARTICLES_COLOR_BLEND[A[1]];
    if (row && palette_tag_loaded(row[1])) s._palTag = row[1];
    d[1] = A[1];
    d[2] = 0;
    d[3] = A[2];
    const x = P.u8(P.coord(vm, P.tgt(vm), P.X_2));
    const y = P.u8(P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET));
    d[4] = P.s16(s.x << 4);
    d[5] = P.s16(s.y << 4);
    [d[6], d[7]] = wavy_velocity(x - s.x, y - s.y, 40);
    s._cb = F.WavyMusicNotesStep;
  });

  // Lua: g1_callbacks_b.lua:1097 -- pokefirered/src/battle_anim_effects_1.c:5431
  F.FlyingMusicNotesStep = function (s: any): void {
    const d = s.data;
    d[4] = P.s16(d[4] + d[6]);
    d[5] = P.s16(d[5] + d[7]);
    s.x = d[4] >> 4;
    s.y = d[5] >> 4;
    if (d[0] > 5 && d[3] === 0) {
      d[2] = (d[2] + 16) & 0xFF;
      s.ox = P.Cos(d[2], 18);
      s.oy = P.Sin(d[2], 18);
      if (d[2] === 0) d[3] = 1;
    }
    d[0] = d[0] + 1;
    if (d[0] === 48) S.destroy(s);
  };

  // Lua: g1_callbacks_b.lua:1114 -- pokefirered/src/battle_anim_effects_1.c:5414
  C.FlyingMusicNotes = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm, d = s.data;
    if (atk_opp(s)) A[1] = -A[1];
    s.x = P.coord(vm, P.atk(vm), P.X_2) + A[1];
    s.y = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET) + A[2];
    S.startAnim(s, A[0]);
    d[2] = 0;
    d[3] = 0;
    d[4] = P.s16(s.x << 4);
    d[5] = P.s16(s.y << 4);
    d[6] = P.cdiv(A[1] << 4, 5);
    d[7] = P.cdiv(A[2] << 7, 5);
    s._cb = F.FlyingMusicNotesStep;
  });

  // Lua: g1_callbacks_b.lua:1130 -- pokefirered/src/battle_anim_effects_1.c:5450
  C.BellyDrumHand = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    let a: number;
    if (A[0] === 1) {
      S.setOamFlip(s, true, false);
      a = 16;
    } else {
      a = -16;
    }
    s.x = P.coord(vm, P.atk(vm), P.X_2) + a;
    s.y = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET) + 8;
    s.data[0] = 8;
    s._cb = S.waitAnimForDuration;
    S.store(s, S.destroy);
  });

  // Lua: g1_callbacks_b.lua:1147 -- pokefirered/src/battle_anim_effects_1.c:5494
  F.SlowFlyingMusicNotesStep = function (s: any): void {
    const d = s.data;
    if (!S.translateLinear(s)) {
      let xDiff = P.Sin(d[5], 8);
      if (s.ox < 0) xDiff = -xDiff;
      s.ox = s.ox + xDiff;
      s.oy = s.oy + P.Sin(d[5], 4);
      d[5] = (d[5] + 8) & 0xFF;
    } else {
      S.destroy(s);
    }
  };

  // Lua: g1_callbacks_b.lua:1161 -- pokefirered/src/battle_anim_effects_1.c:5471
  C.SlowFlyingMusicNotes = S.wrap(function (s: any): void {
    const A = s._A, d = s.data;
    S.setToAttackerCoords(s);
    s.y = s.y + 8;
    S.startAnim(s, A[1]);
    const row = P.PARTICLES_COLOR_BLEND[A[2]];
    if (row && palette_tag_loaded(row[1])) s._palTag = row[1];
    const xDiff = (A[0] === 0) ? -32 : 32;
    d[0] = 40;
    d[1] = s.x;
    d[2] = xDiff + d[1];
    d[3] = s.y;
    d[4] = d[3] - 40;
    S.initLinear(s);
    d[5] = A[3];
    s._cb = F.SlowFlyingMusicNotesStep;
  });

  // Lua: g1_callbacks_b.lua:1180 -- pokefirered/src/battle_anim_effects_1.c:5514
  function next_to_mon_head(s: any, side: any): void {
    const vm = s._vm;
    if (!P.isOpponent(side)) {
      s.x = P.attr(vm, side, P.ATTR_RIGHT) + 8;
    } else {
      s.x = P.attr(vm, side, P.ATTR_LEFT) - 8;
    }
    s.y = P.coord(vm, side, P.Y_PIC_OFFSET) - P.cdiv(P.attr(vm, side, P.ATTR_HEIGHT), 4);
  }
  F.SetSpriteNextToMonHead = next_to_mon_head;

  // Lua: g1_callbacks_b.lua:1192 -- pokefirered/src/battle_anim_effects_1.c:5543
  F.ThoughtBubbleStep = function (s: any): void {
    s.data[0] = s.data[0] - 1;
    if (s.data[0] === 0) {
      S.store(s, S.destroy);
      S.startAnim(s, s.data[1]);
      s._cb = S.runStoredWhenAnimEnds;
    }
  };

  // Lua: g1_callbacks_b.lua:1202 -- pokefirered/src/battle_anim_effects_1.c:5524
  C.ThoughtBubble = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    const side = (A[0] === 0) ? P.atk(vm) : P.tgt(vm);
    next_to_mon_head(s, side);
    const animNum = P.isOpponent(side) ? 1 : 0;
    s.data[0] = A[1];
    s.data[1] = animNum + 2;
    S.startAnim(s, animNum);
    S.store(s, F.ThoughtBubbleStep);
    s._cb = S.runStoredWhenAnimEnds;
  });

  // Lua: g1_callbacks_b.lua:1215 -- pokefirered/src/battle_anim_effects_1.c:5568
  F.MetronomeFingerStep = function (s: any): void {
    s.data[0] = s.data[0] + 1;
    if (s.data[0] > 16) {
      S.startAffineAnim(s, 1);
      S.store(s, S.destroy);
      s._cb = S.runStoredWhenAffineEnds;
    }
  };

  // Lua: g1_callbacks_b.lua:1225 -- pokefirered/src/battle_anim_effects_1.c:5553
  C.MetronomeFinger = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    const side = (A[0] === 0) ? P.atk(vm) : P.tgt(vm);
    next_to_mon_head(s, side);
    s.data[0] = 0;
    S.store(s, F.MetronomeFingerStep);
    s._cb = S.runStoredWhenAffineEnds;
  });

  // Lua: g1_callbacks_b.lua:1235 -- pokefirered/src/battle_anim_effects_1.c:5607
  F.FollowMeFingerStep2 = function (s: any): void {
    const d = s.data;
    d[1] = d[1] + 4;
    if (d[1] > 254) {
      d[0] = d[0] - 1;
      if (d[0] === 0) {
        s.ox = 0;
        s._cb = F.MetronomeFingerStep;
        return;
      } else {
        d[1] = d[1] & 0xFF;
      }
    }
    if (d[1] > 0x4F) s.subpriority = d[3];
    if (d[1] > 0x9F) s.subpriority = d[2];
    const x1 = P.gSine(d[1]);
    const x2 = x1 >> 3;
    s.ox = (x1 >> 3) + (x2 >> 1);
  };

  // Lua: g1_callbacks_b.lua:1256 -- pokefirered/src/battle_anim_effects_1.c:5601
  F.FollowMeFingerStep1 = function (s: any): void {
    s.data[4] = s.data[4] + 1;
    if (s.data[4] > 12) s._cb = F.FollowMeFingerStep2;
  };

  // Lua: g1_callbacks_b.lua:1262 -- pokefirered/src/battle_anim_effects_1.c:5578
  C.FollowMeFinger = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm, d = s.data;
    const side = (A[0] === 0) ? P.atk(vm) : P.tgt(vm);
    s.x = P.coord(vm, side, P.X);
    s.y = P.attr(vm, side, P.ATTR_TOP);
    if (s.y <= 9) s.y = 10;
    d[0] = 1;
    d[1] = 0;
    d[2] = s.subpriority;
    d[3] = s.subpriority + 4;
    d[4] = 0;
    S.store(s, F.FollowMeFingerStep1);
    s._cb = S.runStoredWhenAffineEnds;
  });

  // Lua: g1_callbacks_b.lua:1278 -- pokefirered/src/battle_anim_effects_1.c:5672
  F.TauntFingerStep2 = function (s: any): void {
    s.data[1] = s.data[1] + 1;
    if (s.data[1] > 5) S.destroy(s);
  };

  // Lua: g1_callbacks_b.lua:1284 -- pokefirered/src/battle_anim_effects_1.c:5661
  F.TauntFingerStep1 = function (s: any): void {
    s.data[1] = s.data[1] + 1;
    if (s.data[1] > 10) {
      s.data[1] = 0;
      S.startAnim(s, s.data[0]);
      S.store(s, F.TauntFingerStep2);
      s._cb = S.runStoredWhenAnimEnds;
    }
  };

  // Lua: g1_callbacks_b.lua:1295 -- pokefirered/src/battle_anim_effects_1.c:5637
  C.TauntFinger = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    const side = (A[0] === 0) ? P.atk(vm) : P.tgt(vm);
    next_to_mon_head(s, side);
    if (!P.isOpponent(side)) {
      S.startAnim(s, 0);
      s.data[0] = 2;
    } else {
      S.startAnim(s, 1);
      s.data[0] = 3;
    }
    s._cb = F.TauntFingerStep1;
  });
}
