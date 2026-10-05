// Port of gen1recomp src/core/game3/battle/anim_port/g4_cb_b.lua (GPLv3 + additional terms; see LICENSE.md).
// g4 sprite callbacks, part B: ice, rock and water particles (pokefirered
// battle_anim_ice.c, _rock.c, _water.c).

import { G } from "../../../platform/graphics.ts";
import { AnimCoords } from "../anim_coords.ts";
import { AnimPal } from "../anim_pal.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type S = Record<string, any>;
type Cb = (s: S) => void;

// Lua: g4_cb_b.lua:2
export default function g4CbB(C: Record<string, any>): Record<string, any> {
  const P = C.P, T = C.T;
  const CB: Record<string, any> = {};

  // Lua: g4_cb_b.lua:6
  function args(s: S): any { return s._vm.args; }
  // Lua: g4_cb_b.lua:7
  function isOpp(side: any): boolean { return side !== "player"; }
  // Lua: g4_cb_b.lua:8
  function offscreen(s: S): boolean {
    const x = s.x + s.ox, y = s.y + s.oy;
    return x > 240 + 16 || x < -16 || y > 160 || y < -16;
  }

  // Lua: g4_cb_b.lua:14 -- pokefirered/src/battle_anim_mons.c:433
  function growingCircle(s: S): void {
    const d = s.data;
    if (d[3] !== 0) {
      const amp = P.asr(d[5], 8) + d[1];
      s.ox = P.Sin(d[0], amp);
      s.oy = P.Cos(d[0], amp);
      d[0] = d[0] + d[2];
      d[5] = P.s16(d[5] + d[4]);
      if (d[0] >= 0x100) d[0] = d[0] - 0x100; else if (d[0] < 0) d[0] = d[0] + 0x100;
      d[3] = d[3] - 1;
    } else {
      P.runStored(s);
    }
  }

  // Lua: g4_cb_b.lua:30 -- pokefirered/src/battle_anim_ice.c:578
  CB.IcePunchSwirlingParticle = function (s: S): void {
    const a = args(s);
    s.data[0] = a[0];
    s.data[1] = 60;
    s.data[2] = 9;
    s.data[3] = 30;
    s.data[4] = -512;
    P.storeCb(s, P.destroy);
    s.callback = growingCircle;
    s.callback(s);
  };

  // Lua: g4_cb_b.lua:43 -- pokefirered/src/battle_anim_ice.c:596
  CB.IceBeamParticle = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    P.initPosToAttacker(vm, s, true);
    s.data[2] = P.coord(vm, P.tgt(vm), P.X_2);
    if (isOpp(P.atk(vm))) s.data[2] = s.data[2] - a[2]; else s.data[2] = s.data[2] + a[2];
    s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + a[3];
    s.data[0] = a[4];
    P.storeCb(s, P.destroy);
    s.callback = P.startLinear;
  };

  // Lua: g4_cb_b.lua:56 -- pokefirered/src/battle_anim_ice.c:633
  function flickerIce(s: S): void {
    P.setInvisible(s, !P.isInvisible(s));
    s.data[0] = s.data[0] + 1;
    if (s.data[0] === 20) P.destroy(s);
  }

  // Lua: g4_cb_b.lua:63 -- pokefirered/src/battle_anim_ice.c:615
  CB.IceEffectParticle = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    if (a[2] === 0) {
      P.initPosToTarget(vm, s, true);
    } else {
      [s.x, s.y] = P.averagePositions(vm, P.tgt(vm), true);
      if (isOpp(P.atk(vm))) a[0] = -a[0];
      s.x = s.x + a[0];
      s.y = s.y + a[1];
    }
    P.storeCb(s, flickerIce);
    s.callback = P.runStoredWhenAffineEnds;
  };

  // Lua: g4_cb_b.lua:79 -- pokefirered/src/battle_anim_mons.c:1157
  function initFastWithSpeed(s: S): void {
    const d = s.data;
    const xDiff = P.lshift(Math.abs(d[2] - d[1]), 4);
    if (d[0] !== 0) d[0] = P.s16(P.cdiv(xDiff, d[0]));
    P.initFastLinear(s);
  }

  // Lua: g4_cb_b.lua:86
  function initFastWithSpeedAndPos(s: S): void {
    s.data[1] = s.x;
    s.data[3] = s.y;
    initFastWithSpeed(s);
    s.callback = function (sp: S): void {
      if (P.fastTranslateLinear(sp)) P.runStored(sp);
    };
    s.callback(s);
  }

  // Lua: g4_cb_b.lua:96
  function rewind_offscreen(s: S): number[] {
    const temp: number[] = [];
    for (let i = 0; i <= 7; i++) temp[i] = s.data[i];
    s.data[1] = P.bxor(P.u16(s.data[1]), 1);
    s.data[2] = P.bxor(P.u16(s.data[2]), 1);
    s.data[1] = P.s16(s.data[1]); s.data[2] = P.s16(s.data[2]);
    let guard = 0;
    while (guard < 4096) {
      guard = guard + 1;
      s.data[0] = 1;
      P.fastTranslateLinear(s);
      if (offscreen(s)) break;
    }
    s.x = s.x + s.ox;
    s.y = s.y + s.oy;
    s.ox = 0; s.oy = 0;
    return temp;
  }

  // Lua: g4_cb_b.lua:117 -- pokefirered/src/battle_anim_ice.c:647
  CB.SwirlingSnowball = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    P.initPosToAttacker(vm, s, true);
    s.data[0] = a[4];
    s.data[1] = s.x;
    s.data[3] = s.y;
    if (a[5] === 0) {
      s.data[2] = P.coord(vm, P.tgt(vm), P.X_2);
      s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + a[3];
    } else {
      const [x, y] = P.averagePositions(vm, P.tgt(vm), true);
      s.data[2] = x; s.data[4] = y;
    }
    if (isOpp(P.atk(vm))) s.data[2] = s.data[2] - a[2]; else s.data[2] = s.data[2] + a[2];
    const temp: number[] = [];
    for (let i = 0; i <= 7; i++) temp[i] = s.data[i];
    initFastWithSpeed(s);
    rewind_offscreen(s);
    for (let i = 0; i <= 7; i++) s.data[i] = temp[i];
    s.callback = initFastWithSpeedAndPos;
    P.storeCb(s, snowStep1);
  };
  // Lua: g4_cb_b.lua:139
  const snowStep1: Cb = function (s) {
    s.x = s.x + s.ox;
    s.y = s.y + s.oy;
    s.oy = 0; s.ox = 0;
    s.data[0] = 128;
    const tv = isOpp(P.atk(s._vm)) ? 20 : -20;
    s.data[3] = P.Sin(s.data[0], tv);
    s.data[4] = P.Cos(s.data[0], 0xF);
    s.data[5] = 0;
    s.callback = snowStep2;
    s.callback(s);
  };
  // Lua: g4_cb_b.lua:151
  const snowStep2: Cb = function (s) {
    const tv = isOpp(P.atk(s._vm)) ? 20 : -20;
    if (s.data[5] <= 31) {
      s.ox = P.Sin(s.data[0], tv) - s.data[3];
      s.oy = P.Cos(s.data[0], 15) - s.data[4];
      s.data[0] = (s.data[0] + 16) & 0xFF;
      s.data[5] = s.data[5] + 1;
    } else {
      s.x = s.x + s.ox;
      s.y = s.y + s.oy;
      s.ox = 0; s.oy = 0;
      s.data[3] = 0; s.data[4] = 0;
      s.callback = snowEnd;
    }
  };
  // Lua: g4_cb_b.lua:166
  const snowEnd: Cb = function (s) {
    s.data[0] = 1;
    P.fastTranslateLinear(s);
    if (P.u16(s.x + s.ox + 16) > 272 || s.y + s.oy > 256 || s.y + s.oy < -16) {
      P.destroy(s);
    }
  };

  // Lua: g4_cb_b.lua:176 -- pokefirered/src/battle_anim_ice.c:751
  CB.MoveParticleBeyondTarget = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    P.initPosToAttacker(vm, s, true);
    s.data[0] = a[4];
    s.data[1] = s.x;
    s.data[3] = s.y;
    if (a[7] === 0) {
      s.data[2] = P.coord(vm, P.tgt(vm), P.X_2);
      s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET);
    } else {
      const [x, y] = P.averagePositions(vm, P.tgt(vm), true);
      s.data[2] = x; s.data[4] = y;
    }
    if (isOpp(P.atk(vm))) s.data[2] = s.data[2] - a[2]; else s.data[2] = s.data[2] + a[2];
    s.data[4] = s.data[4] + a[3];
    initFastWithSpeed(s);
    const temp = rewind_offscreen(s);
    for (let i = 0; i <= 7; i++) s.data[i] = temp[i];
    s.data[5] = a[5];
    s.data[6] = a[6];
    s.callback = wiggleStep;
  };
  // Lua: g4_cb_b.lua:198
  const wiggleStep: Cb = function (s) {
    P.fastTranslateLinear(s);
    if (s.data[0] === 0) s.data[0] = 1;
    s.oy = s.oy + P.Sin(s.data[7], s.data[5]);
    s.data[7] = (s.data[7] + s.data[6]) & 0xFF;
    if (s.data[0] === 1 && offscreen(s)) P.destroy(s);
  };

  // Lua: g4_cb_b.lua:207 -- pokefirered/src/battle_anim_ice.c:822
  CB.WaveFromCenterOfTarget = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    if (s.data[0] === 0) {
      if (a[2] === 0) {
        P.initPosToTarget(vm, s, false);
      } else {
        [s.x, s.y] = P.averagePositions(vm, P.tgt(vm), false);
        if (isOpp(P.atk(vm))) a[0] = -a[0];
        s.x = s.x + a[0];
        s.y = s.y + a[1];
      }
      s.data[0] = s.data[0] + 1;
    } else if (s.animEnded) {
      P.destroy(s);
    }
  };

  // Lua: g4_cb_b.lua:226 -- pokefirered/src/battle_anim_ice.c:913
  function swirlingFog(s: S): void {
    if (!P.translateLinear(s)) {
      s.ox = s.ox + P.Sin(s.data[5], s.data[6]);
      s.oy = s.oy + P.Cos(s.data[5], -6);
      const side = s._fogSide;
      // require("src.core.game3.battle.anim_coords").bgPriorityRank(side)
      const bgp = (s._vm && s._vm._bgPrio ? s._vm._bgPrio[AnimCoords.bgPriorityRank(side)] : null) ?? 2;
      if (P.u16(s.data[5] - 64) <= 0x7F) {
        P.setPriority(s, bgp, s.subpriority);
      } else {
        P.setPriority(s, bgp + 1, s.subpriority);
      }
      s.data[5] = (s.data[5] + 3) & 0xFF;
    } else {
      P.destroy(s);
    }
  }

  // Lua: g4_cb_b.lua:244 -- pokefirered/src/battle_anim_ice.c:854
  CB.InitSwirlingFogAnim = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    let side: any;
    if (a[4] === 0) {
      if (a[5] === 0) {
        P.initPosToAttacker(vm, s, false);
      } else {
        [s.x, s.y] = P.averagePositions(vm, P.atk(vm), false);
        if (isOpp(P.atk(vm))) s.x = s.x - a[0]; else s.x = s.x + a[0];
        s.y = s.y + a[1];
      }
      side = P.atk(vm);
    } else {
      if (a[5] === 0) {
        P.initPosToTarget(vm, s, false);
      } else {
        [s.x, s.y] = P.averagePositions(vm, P.tgt(vm), false);
        if (isOpp(P.tgt(vm))) s.x = s.x - a[0]; else s.x = s.x + a[0];
        s.y = s.y + a[1];
      }
      side = P.tgt(vm);
    }
    s._fogSide = side;
    s.data[7] = P.sideId(side);
    s.data[6] = 0x20;
    if (P.tgt(vm) === "player") s.y = s.y + 8;
    s.data[0] = a[3];
    s.data[1] = s.x;
    s.data[2] = s.x;
    s.data[3] = s.y;
    s.data[4] = s.y + a[2];
    P.initLinear(s);
    s.data[5] = 64;
    s.callback = swirlingFog;
    s.callback(s);
  };

  // Lua: g4_cb_b.lua:283 -- pokefirered/src/battle_anim_ice.c:1022
  CB.ThrowMistBall = function (s: S): void {
    const vm = s._vm;
    s.x = P.coord(vm, P.atk(vm), P.X_2);
    s.y = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
    s.callback = C.translateToTargetMonLocation;
  };

  // Lua: g4_cb_b.lua:291 -- pokefirered/src/battle_anim_ice.c:1158
  function movePoisonGas(s: S): void {
    const vm = s._vm;
    const d = s.data;
    const st = d[7] & 0xFF;
    if (st === 0) {
      P.translateLinear(s);
      s.ox = s.ox + P.asr(P.gSine(d[5]), 4);
      if (d[6] !== 0) d[5] = (d[5] - 8) & 0xFF; else d[5] = (d[5] + 8) & 0xFF;
      if (d[0] <= 0) {
        d[0] = 80;
        s.x = P.coord(vm, P.tgt(vm), P.X);
        d[1] = s.x;
        d[2] = s.x;
        s.y = s.y + s.oy;
        d[3] = s.y;
        d[4] = s.y + 29;
        d[7] = d[7] + 1;
        d[5] = isOpp(P.tgt(vm)) ? 204 : 80;
        s.oy = 0;
        s.ox = P.asr(P.gSine(d[5]), 3);
        d[5] = (d[5] + 2) & 0xFF;
        P.initLinear(s);
      }
    } else if (st === 1) {
      P.translateLinear(s);
      s.ox = s.ox + P.asr(P.gSine(d[5]), 3);
      s.oy = s.oy + P.asr(P.gSine(d[5] + 0x40) * -3, 8);
      const pr = P.rshift(P.u16(d[7]), 8);
      if (P.u16(d[5] - 0x40) <= 0x7F) {
        P.setPriority(s, pr, s.subpriority);
      } else {
        P.setPriority(s, pr + 1, s.subpriority);
      }
      d[5] = (d[5] + 4) & 0xFF;
      if (d[0] <= 0) {
        d[0] = 0x300;
        s.x = s.x + s.ox;
        d[1] = s.x;
        s.y = s.y + s.oy;
        d[3] = s.y;
        d[4] = s.y + 4;
        d[2] = isOpp(P.tgt(vm)) ? 0x100 : -0x10;
        d[7] = d[7] + 1;
        s.ox = 0; s.oy = 0;
        P.initLinearWithSpeed(s);
      }
    } else if (st === 2) {
      if (P.translateLinear(s)) P.destroy(s);
    }
  }

  // Lua: g4_cb_b.lua:343 -- pokefirered/src/battle_anim_ice.c:1118
  CB.InitPoisonGasCloudAnim = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    s.data[0] = a[0];
    if (P.coord(vm, P.atk(vm), P.X_2) < P.coord(vm, P.tgt(vm), P.X_2)) s.data[7] = P.s16(0x8000);
    if (P.tgt(vm) === "player") {
      a[1] = -a[1];
      a[3] = -a[3];
      if ((P.u16(s.data[7]) & 0x8000) !== 0 && P.atk(vm) === "player") {
        s.subpriority = P.subpriorityOf(P.tgt(vm)) + 1;
      }
      s.data[6] = 1;
    }
    s.x = P.coord(vm, P.atk(vm), P.X_2);
    s.y = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
    // require("src.core.game3.battle.anim_coords").bgPriorityRank(P.tgt(vm))
    const bgp = (vm._bgPrio ? vm._bgPrio[AnimCoords.bgPriorityRank(P.tgt(vm))] : null) ?? 2;
    if (a[7] !== 0) {
      s.data[1] = s.x + a[1];
      s.data[2] = P.coord(vm, P.tgt(vm), P.X_2) + a[3];
      s.data[3] = s.y + a[2];
      s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + a[4];
    } else {
      s.data[1] = s.x + a[1];
      s.data[2] = P.coord(vm, P.tgt(vm), P.X) + a[3];
      s.data[3] = s.y + a[2];
      s.data[4] = P.coord(vm, P.tgt(vm), P.Y) + a[4];
    }
    s.data[7] = P.s16(P.bor(P.u16(s.data[7]), P.lshift(bgp, 8)));
    P.initLinear(s);
    P.setPriority(s, s.oamPriority ?? 2, s.subpriority);
    s.callback = movePoisonGas;
  };

  // Lua: g4_cb_b.lua:377 -- pokefirered/src/battle_anim_ice.c:1427
  function throwIceBall(s: S): void {
    if (P.translateHArc(s)) {
      P.startAnim(s, 1);
      s.callback = P.runStoredWhenAnimEnds;
      P.storeCb(s, P.destroy);
    }
  }

  // Lua: g4_cb_b.lua:386 -- pokefirered/src/battle_anim_ice.c:1408
  CB.InitIceBallAnim = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    const ctx = vm.ctx ?? {};
    let animNum = P.u8((ctx.rolloutTimerStartValue ?? 0) - (ctx.rolloutTimer ?? 0) - 1);
    if (animNum > 4) animNum = 4;
    P.startAffineAnim(s, animNum);
    P.initPosToAttacker(vm, s, true);
    s.data[0] = a[4];
    if (isOpp(P.atk(vm))) a[2] = -a[2];
    s.data[2] = P.coord(vm, P.tgt(vm), P.X_2) + a[2];
    s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + a[3];
    s.data[5] = a[5];
    P.initArc(s);
    s.callback = throwIceBall;
  };

  // Lua: g4_cb_b.lua:404 -- pokefirered/src/battle_anim_ice.c:1454
  function iceBallParticle(s: S): void {
    s.data[3] = P.s16(s.data[3] + s.data[1]);
    s.data[4] = P.s16(s.data[4] + s.data[2]);
    if ((s.data[1] & 1) !== 0) {
      s.ox = -P.asr(s.data[3], 8);
    } else {
      s.ox = P.asr(s.data[3], 8);
    }
    s.oy = P.asr(s.data[4], 8);
    s.data[0] = s.data[0] + 1;
    if (s.data[0] === 21) P.destroy(s);
  }

  // Lua: g4_cb_b.lua:418 -- pokefirered/src/battle_anim_ice.c:1438
  CB.InitIceBallParticle = function (s: S): void {
    const vm = s._vm;
    P.addTile(s, 8);
    P.initPosToTarget(vm, s, true);
    const randA = (P.Random() & 0xFF) + 256;
    let randB = P.Random() & 0x1FF;
    if (randB > 0xFF) randB = 256 - randB;
    s.data[1] = randA;
    s.data[2] = randB;
    s.callback = iceBallParticle;
  };

  // Lua: g4_cb_b.lua:431 -- pokefirered/src/battle_anim_rock.c:327
  function fallingRockStep(s: S): void {
    s.x = s.x + s.data[5];
    s.data[0] = 192;
    s.data[1] = s.data[5];
    s.data[2] = 4;
    s.data[3] = 32;
    s.data[4] = -24;
    P.storeCb(s, P.destroy);
    s.callback = P.translateInEllipse;
    s.callback(s);
  }

  // Lua: g4_cb_b.lua:444 -- pokefirered/src/battle_anim_rock.c:308
  CB.FallingRock = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    if (a[3] !== 0) [s.x, s.y] = P.averagePositions(vm, P.tgt(vm), false);
    s.x = s.x + a[0];
    s.y = s.y + 14;
    P.startAnim(s, a[1]);
    P.animate(s);
    s.data[0] = 0;
    s.data[1] = 0;
    s.data[2] = 4;
    s.data[3] = 16;
    s.data[4] = -70;
    s.data[5] = a[2];
    P.storeCb(s, fallingRockStep);
    s.callback = P.translateInEllipse;
    s.callback(s);
  };

  // Lua: g4_cb_b.lua:464 -- pokefirered/src/battle_anim_rock.c:341
  CB.RockFragment = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    P.startAnim(s, a[5]);
    P.animate(s);
    if (isOpp(P.atk(vm))) s.x = s.x - a[0]; else s.x = s.x + a[0];
    s.y = s.y + a[1];
    s.data[0] = a[4];
    s.data[1] = s.x;
    s.data[2] = s.x + a[2];
    s.data[3] = s.y;
    s.data[4] = s.y + a[3];
    C.initSpriteDataForLinearTranslation(s);
    s.data[3] = 0;
    s.data[4] = 0;
    s.callback = P.translateSpriteLinearFixedPoint;
    P.storeCb(s, P.destroy);
  };

  // Lua: g4_cb_b.lua:484 -- pokefirered/src/battle_anim_rock.c:376
  function vortexStep(s: S): void {
    s.data[4] = P.s16(s.data[4] + s.data[1]);
    s.oy = -P.asr(s.data[4], 8);
    s.ox = P.Sin(s.data[5], s.data[3]);
    s.data[5] = (s.data[5] + s.data[2]) & 0xFF;
    s.data[0] = s.data[0] - 1;
    if (s.data[0] === -1) P.destroy(s);
  }

  // Lua: g4_cb_b.lua:494 -- pokefirered/src/battle_anim_rock.c:363
  CB.ParticleInVortex = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    if (a[6] === 0) P.initPosToAttacker(vm, s, false); else P.initPosToTarget(vm, s, false);
    s.data[0] = a[3];
    s.data[1] = a[2];
    s.data[2] = a[4];
    s.data[3] = a[5];
    s.callback = vortexStep;
  };

  // Lua: g4_cb_b.lua:506 -- pokefirered/src/battle_anim_rock.c:131
  function drawSandCrescent(s: S, vm: any): void {
    const img = s.image;
    if (!img || s.visible === false) return;
    const [iw, ih] = img.getDimensions();
    s._crescentQuads = s._crescentQuads ?? [null,
      G.newQuad(0, 0, 32, 16, iw, ih),
      G.newQuad(0, 16, 32, 16, iw, ih),
    ];
    const cx = Math.floor(s.x + s.ox + 0.5);
    const cy = Math.floor(s.y + s.oy + 0.5);
    const flip = s.hFlip ? -1 : 1;
    G.setColor(1, 1, 1, s._drawAlpha ?? 1);
    // require("src.core.game3.battle.anim_pal")
    const pimg = AnimPal.beginSprite(s, img, vm);
    G.draw(pimg ?? img, s._crescentQuads[1], cx + (-16 * flip), cy, 0, flip, 1, 16, 8);
    G.draw(pimg ?? img, s._crescentQuads[2], cx + (16 * flip), cy, 0, flip, 1, 16, 8);
    if (pimg) AnimPal.finish();
  }

  // Lua: g4_cb_b.lua:526 -- pokefirered/src/battle_anim_rock.c:484
  CB.FlyingSandCrescent = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    if (s.data[0] === 0) {
      if (a[3] !== 0 && isOpp(P.atk(vm))) {
        s.x = 304;
        a[1] = -a[1];
        s.data[5] = 1;
        P.setHFlip(s, true);
      } else {
        s.x = -64;
      }
      s.y = a[0];
      s.customDraw = drawSandCrescent;
      P.setPriority(s, 1, s.subpriority);
      s.data[1] = a[1];
      s.data[2] = a[2];
      s.data[0] = s.data[0] + 1;
    } else {
      s.data[3] = s.data[3] + s.data[1];
      s.data[4] = s.data[4] + s.data[2];
      s.ox = s.ox + P.asr(s.data[3], 8);
      s.oy = s.oy + P.asr(s.data[4], 8);
      s.data[3] = s.data[3] & 0xFF;
      s.data[4] = s.data[4] & 0xFF;
      if (s.data[5] === 0) {
        if (s.x + s.ox > 240 + 32) s.callback = P.destroy;
      } else if (s.x + s.ox < -32) {
        s.callback = P.destroy;
      }
    }
  };

  // Lua: g4_cb_b.lua:560 -- pokefirered/src/battle_anim_rock.c:533
  CB.RaiseSprite = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    P.startAnim(s, a[4]);
    P.initPosToAttacker(vm, s, false);
    s.data[0] = a[3];
    s.data[2] = s.x;
    s.data[4] = s.y + a[2];
    s.callback = P.startLinear;
    P.storeCb(s, P.destroy);
  };

  // Lua: g4_cb_b.lua:573 -- pokefirered/src/battle_anim_rock.c:727
  function rockTombStep(s: S): void {
    P.setInvisible(s, false);
    if (s.data[3] !== 0) {
      s.oy = s.data[2] + s.data[3];
      s.data[3] = s.data[3] + s.data[0];
      s.data[0] = s.data[0] + 1;
      if (s.data[3] > 0) s.data[3] = 0;
    } else {
      s.data[1] = s.data[1] - 1;
      if (s.data[1] === 0) P.destroy(s);
    }
  }

  // Lua: g4_cb_b.lua:587 -- pokefirered/src/battle_anim_rock.c:715
  CB.RockTomb = function (s: S): void {
    const a = args(s);
    P.startAnim(s, a[4]);
    s.ox = a[0];
    s.data[2] = a[1];
    s.data[3] = s.data[3] - a[2];
    s.data[0] = 3;
    s.data[1] = a[3];
    s.callback = rockTombStep;
    P.setInvisible(s, true);
  };

  // Lua: g4_cb_b.lua:600 -- pokefirered/src/battle_anim_rock.c:746
  CB.RockBlastRock = function (s: S): void {
    if (P.atk(s._vm) === "enemy") P.startAffineAnim(s, 1);
    C.translateToTargetMonLocation(s);
  };

  // Lua: g4_cb_b.lua:606 -- pokefirered/src/battle_anim_rock.c:766
  function rockScatterStep(s: S): void {
    s.data[0] = s.data[0] + 8;
    s.data[3] = s.data[3] + s.data[1];
    s.data[4] = s.data[4] + s.data[2];
    s.ox = s.ox + P.cdiv(s.data[3], 40);
    s.oy = s.oy - P.Sin(s.data[0], s.data[5]);
    if (s.data[0] > 140) P.destroy(s);
  }

  // Lua: g4_cb_b.lua:616 -- pokefirered/src/battle_anim_rock.c:753
  CB.RockScatter = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    s.x = P.coord(vm, P.tgt(vm), P.X);
    s.y = P.coord(vm, P.tgt(vm), P.Y);
    s.x = s.x + a[0];
    s.y = s.y + a[1];
    s.data[1] = a[0];
    s.data[2] = a[1];
    s.data[5] = a[2];
    P.startAnim(s, a[3]);
    s.callback = rockScatterStep;
  };

  // Lua: g4_cb_b.lua:631 -- pokefirered/src/battle_anim_rock.c:693
  C.rolloutParticle = function (s: S): void {
    if (P.translateHArc(s)) {
      const t = s._task;
      if (t && t.active && t._g4rollout) t.data[11] = t.data[11] - 1;
      P.destroy(s);
    }
  };

  // Lua: g4_cb_b.lua:640 -- pokefirered/src/battle_anim_water.c:496
  function rainDropStep(s: S): void {
    s.data[0] = s.data[0] + 1;
    if (s.data[0] < 14) {
      s.ox = s.ox + 1;
      s.oy = s.oy + 4;
    }
    if (s.animEnded) P.destroy(s);
  }
  // Lua: g4_cb_b.lua:648
  C.rainDrop = function (s: S): void {
    s.callback = rainDropStep;
  };

  // Lua: g4_cb_b.lua:654 -- pokefirered/src/battle_anim_water.c:515
  CB.WaterBubbleProjectile = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    if (isOpp(P.atk(vm))) {
      s.x = P.coord(vm, P.atk(vm), P.X_2) - a[0];
    } else {
      s.x = P.coord(vm, P.atk(vm), P.X_2) + a[0];
    }
    s.y = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET) + a[1];
    s.animPaused = true;
    if (isOpp(P.atk(vm))) a[2] = -a[2];
    s.data[0] = a[6];
    s.data[1] = s.x;
    s.data[2] = P.coord(vm, P.tgt(vm), P.X_2);
    s.data[3] = s.y;
    s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET);
    P.initLinear(s);
    const o = { data: [a[2], a[3], a[5], P.s16(P.u8(a[4]) * 256), a[6]] };
    s._other = o;
    s.x = s.x - P.Sin(P.u8(a[4]), a[2]);
    s.y = s.y - P.Cos(P.u8(a[4]), a[3]);
    s.callback = bubbleProjStep1;
    s.callback(s);
  };
  // Lua: g4_cb_b.lua:678
  const bubbleProjStep1: Cb = function (s) {
    const o = s._other;
    let timer = P.u8(o.data[4]);
    const trig = P.u16(o.data[3]);
    s.data[0] = 1;
    P.translateLinear(s);
    s.ox = s.ox + P.Sin(P.rshift(trig, 8), o.data[0]);
    s.oy = s.oy + P.Cos(P.rshift(trig, 8), o.data[1]);
    o.data[3] = P.s16(trig + o.data[2]);
    timer = P.u8(timer - 1);
    if (timer !== 0) {
      o.data[4] = timer;
    } else {
      s.callback = bubbleProjStep2;
    }
  };
  // Lua: g4_cb_b.lua:694
  const bubbleProjStep2: Cb = function (s) {
    s.animPaused = false;
    s.callback = P.runStoredWhenAnimEnds;
    P.storeCb(s, bubbleProjStep3);
  };
  // Lua: g4_cb_b.lua:699
  const bubbleProjStep3: Cb = function (s) {
    s.data[0] = 10;
    s.callback = P.waitAnimForDuration;
    P.storeCb(s, P.destroy);
  };

  // Lua: g4_cb_b.lua:707 -- pokefirered/src/battle_anim_water.c:588
  CB.AuroraBeamRings = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    P.initPosToAttacker(vm, s, true);
    const unk = isOpp(P.atk(vm)) ? -a[2] : a[2];
    s.data[0] = a[4];
    s.data[1] = s.x;
    s.data[2] = P.coord(vm, P.tgt(vm), P.X_2) + unk;
    s.data[3] = s.y;
    s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + a[3];
    P.initLinear(s);
    s.callback = auroraStep;
    s.affineAnimPaused = true;
    s.callback(s);
  };
  // Lua: g4_cb_b.lua:722
  const auroraStep: Cb = function (s) {
    if (P.u16(s._vm.args[7]) === 0xFFFF) {
      P.startAnim(s, 1);
      s.affineAnimPaused = false;
    }
    if (P.translateLinear(s)) P.destroy(s);
  };

  // Lua: g4_cb_b.lua:732 -- pokefirered/src/battle_anim_water.c:646
  CB.ToTargetInSinWave = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    P.initPosToAttacker(vm, s, true);
    s.data[0] = 30;
    s.data[1] = s.x;
    s.data[2] = P.coord(vm, P.tgt(vm), P.X_2);
    s.data[3] = s.y;
    s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET);
    P.initLinear(s);
    s.data[5] = P.cdiv(0xD200, s.data[0]);
    s.data[7] = a[3];
    const retArg = P.u16(a[7]);
    if (a[7] > 127) {
      s.data[6] = P.s16((retArg - 127) * 256);
      s.data[7] = -s.data[7];
    } else {
      s.data[6] = P.s16(retArg * 256);
    }
    s.callback = sinWaveStep;
    s.callback(s);
  };
  // Lua: g4_cb_b.lua:754
  const sinWaveStep: Cb = function (s) {
    if (P.translateLinear(s)) P.destroy(s);
    s.oy = s.oy + P.Sin(P.asr(s.data[6], 8), s.data[7]);
    if (P.asr(s.data[6] + s.data[5], 8) > 127) {
      s.data[6] = 0;
      s.data[7] = -s.data[7];
    } else {
      s.data[6] = P.s16(s.data[6] + s.data[5]);
    }
  };

  // Lua: g4_cb_b.lua:766 -- pokefirered/src/battle_anim_water.c:704
  CB.HydroCannonCharge = function (s: S): void {
    const vm = s._vm;
    s.x = P.coord(vm, P.atk(vm), P.X);
    s.y = P.coord(vm, P.atk(vm), P.Y);
    s.oy = -10;
    const pr = P.subpriorityOf(P.atk(vm));
    if (P.atk(vm) === "player") {
      s.ox = 10;
      P.setPriority(s, s.oamPriority, pr + 2);
    } else {
      s.ox = -10;
      P.setPriority(s, s.oamPriority, pr - 2);
    }
    s.callback = function (sp: S): void {
      if (sp.affineAnimEnded) P.destroy(sp);
    };
  };

  // Lua: g4_cb_b.lua:785 -- pokefirered/src/battle_anim_water.c:740
  CB.HydroCannonBeam = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    if (P.atk(vm) === P.tgt(vm)) {
      a[0] = -a[0];
      a[0] = -a[0];
    }
    const animType = (P.u16(a[5]) & 0xFF00) === 0;
    const coordType = (P.u8(a[5]) === 0) ? P.Y_PIC_OFFSET : P.Y;
    P.initPosToAttacker(vm, s, animType);
    if (isOpp(P.atk(vm))) a[2] = -a[2];
    s.data[0] = a[4];
    s.data[2] = P.coord(vm, P.tgt(vm), P.X_2) + a[2];
    s.data[4] = P.coord(vm, P.tgt(vm), coordType) + a[3];
    s.callback = P.startLinear;
    P.storeCb(s, P.destroy);
  };

  // Lua: g4_cb_b.lua:804 -- pokefirered/src/battle_anim_water.c:769
  CB.WaterGunDroplet = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    P.initPosToTarget(vm, s, true);
    s.data[0] = a[4];
    s.data[2] = s.x + a[2];
    s.data[4] = s.y + a[4];
    s.callback = P.startLinear;
    P.storeCb(s, P.destroy);
  };

  // Lua: g4_cb_b.lua:817 -- pokefirered/src/battle_anim_water.c:779
  CB.SmallBubblePair = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    if (a[3] !== P.ANIM_ATTACKER) P.initPosToTarget(vm, s, true); else P.initPosToAttacker(vm, s, true);
    s.data[7] = a[2];
    s.callback = bubblePairStep;
  };
  // Lua: g4_cb_b.lua:824
  const bubblePairStep: Cb = function (s) {
    s.data[0] = (s.data[0] + 11) & 0xFF;
    s.ox = P.Sin(s.data[0], 4);
    s.data[1] = s.data[1] + 48;
    s.oy = -P.asr(s.data[1], 8);
    const v = s.data[7];
    s.data[7] = v - 1;
    if (v === 0) P.destroy(s);
  };

  // Lua: g4_cb_b.lua:836 -- pokefirered/src/battle_anim_water.c:1011
  CB.SmallDriftingBubbles = function (s: S): void {
    const vm = s._vm;
    P.addTile(s, 8);
    P.initPosToTarget(vm, s, true);
    const randData = (P.Random() & 0xFF) | 256;
    let randData2 = P.Random() & 0x1FF;
    if (randData2 > 255) randData2 = 256 - randData2;
    s.data[1] = randData;
    s.data[2] = randData2;
    s.callback = driftStep;
  };
  // Lua: g4_cb_b.lua:847
  const driftStep: Cb = function (s) {
    s.data[3] = P.s16(s.data[3] + s.data[1]);
    s.data[4] = P.s16(s.data[4] + s.data[2]);
    if ((s.data[1] & 1) !== 0) s.ox = -P.asr(s.data[3], 8); else s.ox = P.asr(s.data[3], 8);
    s.oy = P.asr(s.data[4], 8);
    s.data[0] = s.data[0] + 1;
    if (s.data[0] === 21) P.destroy(s);
  };

  // Lua: g4_cb_b.lua:858 -- pokefirered/src/battle_anim_water.c:1483
  CB.WaterPulseBubble = function (s: S): void {
    const a = args(s);
    s.x = a[0];
    s.y = a[1];
    s.data[0] = a[2];
    s.data[1] = a[3];
    s.data[2] = a[4];
    s.data[3] = a[5];
    s.callback = pulseBubbleStep;
  };
  // Lua: g4_cb_b.lua:868
  const pulseBubbleStep: Cb = function (s) {
    s.data[4] = P.s16(s.data[4] - s.data[0]);
    s.oy = P.cdiv(s.data[4], 10);
    s.data[5] = (s.data[5] + s.data[1]) & 0xFF;
    s.ox = P.Sin(s.data[5], s.data[2]);
    s.data[3] = s.data[3] - 1;
    if (s.data[3] === 0) P.destroy(s);
  };

  // Lua: g4_cb_b.lua:878 -- pokefirered/src/battle_anim_water.c:1504
  function pulseRingBubble(s: S): void {
    s.data[3] = P.s16(s.data[3] + s.data[1]);
    s.data[4] = P.s16(s.data[4] + s.data[2]);
    s.ox = P.asr(s.data[3], 7);
    s.oy = P.asr(s.data[4], 7);
    s.data[0] = s.data[0] - 1;
    if (s.data[0] === 0) P.destroy(s);
  }

  // Lua: g4_cb_b.lua:888 -- pokefirered/src/battle_anim_water.c:1544
  function createPulseRingBubbles(s: S, xDiff: number, yDiff: number): void {
    const vm = s._vm;
    const something = P.cdiv(s.data[0], 2);
    const cx = s.x + s.ox;
    const cy = s.y + s.oy;
    const ry = P.s16(yDiff + (P.Random() % 10) - 5);
    const rx = P.s16(-xDiff + (P.Random() % 10) - 5);
    const sub = P.subpriorityOf(P.atk(vm)) - 1;
    const tpl = T.gWaterPulseRingBubbleSpriteTemplate;
    const b1 = P.createSprite(vm, "SMALL_BUBBLES", tpl, cx, cy + something, sub, pulseRingBubble, 8, 8);
    if (b1) {
      b1.data[0] = 20;
      b1.data[1] = ry;
      b1.data[2] = (rx < 0) ? -rx : rx;
    }
    const b2 = P.createSprite(vm, "SMALL_BUBBLES", tpl, cx, cy - something, sub, pulseRingBubble, 8, 8);
    if (b2) {
      b2.data[0] = 20;
      b2.data[1] = ry;
      b2.data[2] = (rx > 0) ? -rx : rx;
    }
  }

  // Lua: g4_cb_b.lua:913 -- pokefirered/src/battle_anim_water.c:1517
  CB.WaterPulseRing = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    P.initPosToAttacker(vm, s, true);
    s.data[1] = P.coord(vm, P.tgt(vm), P.X_2);
    s.data[2] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET);
    s.data[3] = a[2];
    s.data[4] = a[3];
    s.callback = pulseRingStep;
  };
  // Lua: g4_cb_b.lua:923
  const pulseRingStep: Cb = function (s) {
    const xDiff = s.data[1] - s.x;
    const yDiff = s.data[2] - s.y;
    if (s.data[3] !== 0) {
      s.ox = P.cdiv(s.data[0] * xDiff, s.data[3]);
      s.oy = P.cdiv(s.data[0] * yDiff, s.data[3]);
    }
    s.data[5] = s.data[5] + 1;
    if (s.data[5] === s.data[4]) {
      s.data[5] = 0;
      createPulseRingBubbles(s, xDiff, yDiff);
    }
    if (s.data[3] === s.data[0]) P.destroy(s);
    s.data[0] = s.data[0] + 1;
  };

  return CB;
}
