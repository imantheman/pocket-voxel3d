// Port of gen1recomp src/core/game3/battle/anim_port/g3_ghost.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered battle_anim_ghost.c on the g3_pret kit.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, truthy } from "../../../../../import/gen3/lua.ts";
import { ipairs, len, seq } from "../../../platform/lt.ts";
import { G } from "../../../platform/graphics.ts";
import { AnimCoords } from "../anim_coords.ts";
import P from "./g3_pret.ts";

type S = Record<string, any>;
type Tk = Record<string, any>;

const C: Record<string, any> = {};
const T: Record<string, any> = {};

// Brian's `P.task(fn)` / `P.cb(fn)` run at require time; here each wrap is made on
// the first call (no top-level read of g3_pret inside the import cycle).
function task(entry: (t: Tk, vm: any) => void): (t: Tk, vm: any) => void {
  let w: any = null;
  return (t: Tk, vm: any): void => { (w ??= P.task(entry))(t, vm); };
}
function cb(entry: (s: S, vm: any) => void): (s: S) => void {
  let w: any = null;
  return (s: S): void => { (w ??= P.cb(entry))(s); };
}

// Lua: g3_ghost.lua:4 -- local band = P.band
const band = (a: number, b: number): number => P.band(a, b);

// Lua: g3_ghost.lua:6
function updateConfuseRayBallBlend(s: S, vm: any): void {
  const d = s.data;
  if (d[6] > 0xFF) {
    d[6] = d[6] + 1;
    if (d[6] === 0x10d) d[6] = 0;
    return;
  }
  const r0 = d[7];
  d[7] = d[7] + 1;
  if (band(r0, 0xFF) === 0) {
    d[7] = band(d[7], 0xff00);
    if (band(d[7], 0x100) !== 0) {
      d[6] = d[6] + 1;
    } else {
      d[6] = d[6] - 1;
    }
    P.setBld(vm, d[6], 16 - d[6]);
    if (d[6] === 0 || d[6] === 16) d[7] = P.bxor(d[7], 0x100);
    if (d[6] === 0) d[6] = 0x100;
  }
}

// Lua: g3_ghost.lua:28
function confuseRayStep2(s: S, vm: any): void {
  const d = s.data;
  d[0] = 1;
  P.AnimTranslateLinear(s);
  s.ox = s.ox + P.Sin(d[5], 10);
  s.oy = s.oy + P.Cos(d[5], 15);
  const r2 = d[5];
  d[5] = band(d[5] + 5, 0xFF);
  const r0 = d[5];
  if ((r2 === 0 || r2 > 196) && r0 > 0) {
    P.playSE(vm, "SE_M_CONFUSE_RAY");
  }
  if (d[6] === 0) {
    s.invisible = true;
    s.callbackFn = P.DestroyAnimSpriteAndDisableBlend;
  } else {
    updateConfuseRayBallBlend(s, vm);
  }
}

// Lua: g3_ghost.lua:48
function confuseRayStep1(s: S, vm: any): void {
  const d = s.data;
  updateConfuseRayBallBlend(s, vm);
  if (P.AnimTranslateLinear(s)) {
    s.callbackFn = confuseRayStep2;
    return;
  }
  s.ox = s.ox + P.Sin(d[5], 10);
  s.oy = s.oy + P.Cos(d[5], 15);
  const r2 = d[5];
  d[5] = band(d[5] + 5, 0xFF);
  const r0 = d[5];
  if (r2 !== 0 && r2 <= 196) return;
  if (r0 <= 0) return;
  P.playSE(vm, "SE_M_CONFUSE_RAY", vm.animCustomPanning ?? 0);
}

// Lua: g3_ghost.lua:66 -- pokefirered/src/battle_anim_ghost.c:220
C.ConfuseRayBallBounce = cb(function (s: S, vm: any): void {
  const d = s.data;
  P.InitSpritePosToAnimAttacker(s, vm, true);
  d[0] = s.ga[2];
  d[1] = s.x;
  d[2] = P.coordTgt(vm, P.COORD_X_2);
  d[3] = s.y;
  d[4] = P.coordTgt(vm, P.COORD_Y_PIC);
  P.InitAnimLinearTranslationWithSpeed(s);
  s.callbackFn = confuseRayStep1;
  d[6] = 16;
  P.setBld(vm, 16, 0);
});

// Lua: g3_ghost.lua:80
function confuseRaySpiralStep(s: S, _vm?: any): void {
  const d = s.data;
  s.ox = P.Sin(d[0], 32);
  s.oy = P.Cos(d[0], 8);
  const temp1 = P.u16(d[0] - 65);
  if (temp1 <= 130) s.pri = 2; else s.pri = 1;
  d[0] = band(d[0] + 19, 0xFF);
  d[2] = P.s16(d[2] + 80);
  s.oy = s.oy + P.shr(d[2], 8);
  d[7] = d[7] + 1;
  if (d[7] === 61) P.DestroyAnimSprite(s);
}

// Lua: g3_ghost.lua:94 -- pokefirered/src/battle_anim_ghost.c:308
C.ConfuseRayBallSpiral = cb(function (s: S, vm: any): void {
  P.InitSpritePosToAnimTarget(s, vm, true);
  s.callbackFn = confuseRaySpiralStep;
  confuseRaySpiralStep(s, vm);
});

// Lua: g3_ghost.lua:100
function shadowBallStep(s: S, vm: any): void {
  const d = s.data;
  if (d[0] === 0) {
    d[4] = P.s16(d[4] + d[6]);
    d[5] = P.s16(d[5] + d[7]);
    s.x = P.shr(d[4], 4);
    s.y = P.shr(d[5], 4);
    d[1] = d[1] - 1;
    if (d[1] > 0) return;
    d[0] = d[0] + 1;
  } else if (d[0] === 1) {
    d[2] = d[2] - 1;
    if (d[2] > 0) return;
    d[1] = P.coordTgt(vm, P.COORD_X_2);
    d[2] = P.coordTgt(vm, P.COORD_Y_PIC);
    d[4] = P.s16(s.x * 16);
    d[5] = P.s16(s.y * 16);
    d[6] = P.s16(P.div((d[1] - s.x) * 16, d[3]));
    d[7] = P.s16(P.div((d[2] - s.y) * 16, d[3]));
    d[0] = d[0] + 1;
  } else if (d[0] === 2) {
    d[4] = P.s16(d[4] + d[6]);
    d[5] = P.s16(d[5] + d[7]);
    s.x = P.shr(d[4], 4);
    s.y = P.shr(d[5], 4);
    d[3] = d[3] - 1;
    if (d[3] > 0) return;
    s.x = P.coordTgt(vm, P.COORD_X_2);
    s.y = P.coordTgt(vm, P.COORD_Y_PIC);
    d[0] = d[0] + 1;
  } else if (d[0] === 3) {
    P.DestroySpriteAndMatrix(s);
  }
}

// Lua: g3_ghost.lua:136 -- pokefirered/src/battle_anim_ghost.c:396
C.ShadowBall = cb(function (s: S, vm: any): void {
  const d = s.data;
  const oldX = s.x, oldY = s.y;
  s.x = P.coordAtk(vm, P.COORD_X_2);
  s.y = P.coordAtk(vm, P.COORD_Y_PIC);
  d[0] = 0;
  d[1] = s.ga[0];
  d[2] = s.ga[1];
  d[3] = s.ga[2];
  d[4] = P.s16(s.x * 16);
  d[5] = P.s16(s.y * 16);
  d[6] = P.s16(P.div((oldX - s.x) * 16, s.ga[0] * 2));
  d[7] = P.s16(P.div((oldY - s.y) * 16, s.ga[0] * 2));
  s.callbackFn = shadowBallStep;
});

// Lua: g3_ghost.lua:152
function lickStep(s: S): void {
  const d = s.data;
  let r5 = false, r6 = false;
  if (s.animEnded) {
    if (!s.invisible) s.invisible = true;
    if (d[0] === 0) {
      if (d[1] === 2) r5 = true;
    } else if (d[0] === 1) {
      if (d[1] === 4) r5 = true;
    } else {
      r6 = true;
    }
    if (r5) {
      s.invisible = !truthy(s.invisible);
      d[2] = d[2] + 1;
      d[1] = 0;
      if (d[2] === 5) {
        d[2] = 0;
        d[0] = d[0] + 1;
      }
    } else if (r6) {
      P.DestroyAnimSprite(s);
    } else {
      d[1] = d[1] + 1;
    }
  }
}

// Lua: g3_ghost.lua:181 -- pokefirered/src/battle_anim_ghost.c:458
C.Lick = cb(function (s: S, vm: any): void {
  P.InitSpritePosToAnimTarget(s, vm, true);
  s.callbackFn = lickStep;
});

// Lua: g3_ghost.lua:186
function destinyBondShadowStep(s: S): void {
  const d = s.data;
  if (d[4] !== 0) {
    d[0] = P.s16(d[0] + d[2]);
    d[1] = P.s16(d[1] + d[3]);
    s.x = P.shr(d[0], 4);
    s.y = P.shr(d[1], 4);
    d[4] = d[4] - 1;
    if (d[4] === 0) d[0] = 0;
  }
}

// Lua: g3_ghost.lua:199 -- pokefirered/src/battle_anim_ghost.c:737
C.DestinyBondWhiteShadow = cb(function (s: S, vm: any): void {
  const d = s.data;
  let b1x: number, b1y: number, b2x: number, b2y: number;
  if (s.ga[0] === 0) {
    b1x = P.coordAtk(vm, P.COORD_X);
    b1y = P.coordAtk(vm, P.COORD_Y) + 28;
    b2x = P.coordTgt(vm, P.COORD_X);
    b2y = P.coordTgt(vm, P.COORD_Y) + 28;
  } else {
    b1x = P.coordTgt(vm, P.COORD_X);
    b1y = P.coordTgt(vm, P.COORD_Y) + 28;
    b2x = P.coordAtk(vm, P.COORD_X);
    b2y = P.coordAtk(vm, P.COORD_Y) + 28;
  }
  const yDiff = b2y - b1y;
  d[0] = b1x * 16;
  d[1] = b1y * 16;
  d[2] = P.s16(P.div((b2x - b1x) * 16, s.ga[1]));
  d[3] = P.s16(P.div(yDiff * 16, s.ga[1]));
  d[4] = s.ga[1];
  d[5] = b2x;
  d[6] = b2y;
  d[7] = P.div(d[4], 2);
  s.pri = 2;
  s.x = b1x;
  s.y = b1y;
  s.callbackFn = destinyBondShadowStep;
  s.invisible = true;
});

// Lua: g3_ghost.lua:229
function curseNailEnd(s: S, vm: any): void {
  P.setBld(vm, null);
  P.DestroyAnimSprite(s);
}

// Lua: g3_ghost.lua:234
function curseNailStep2(s: S, vm: any): void {
  const d = s.data;
  if (d[0] === 0) {
    P.setBld(vm, 16, 0);
    d[0] = d[0] + 1;
    d[1] = 0;
    d[2] = 0;
  } else if (d[1] < 2) {
    d[1] = d[1] + 1;
  } else {
    d[1] = 0;
    d[2] = d[2] + 1;
    P.setBld(vm, 16 - d[2], d[2]);
    if (d[2] === 16) {
      s.invisible = true;
      s.callbackFn = curseNailEnd;
    }
  }
}

// Lua: g3_ghost.lua:254
function curseNailStep1(s: S): void {
  const d = s.data;
  if (d[0] > 0) {
    d[0] = d[0] - 1;
  } else {
    s.ox = s.ox + d[1];
    const var0 = P.u16(s.ox + 7);
    if (var0 > 14) {
      s.x = s.x + s.ox;
      s.ox = 0;
      s.imageValue = s.imageValue + 8;
      d[2] = d[2] + 1;
      if (d[2] === 3) {
        d[0] = 30;
        s.callbackFn = P.WaitAnimForDuration;
        P.StoreSpriteCallbackInData6(s, curseNailStep2);
      } else {
        d[0] = 40;
      }
    }
  }
}

// Lua: g3_ghost.lua:278 -- pokefirered/src/battle_anim_ghost.c:1009
C.CurseNail = cb(function (s: S, vm: any): void {
  let xDelta: number, xDelta2: number;
  P.InitSpritePosToAnimAttacker(s, vm, true);
  if (P.atkIsPlayer(vm)) {
    xDelta = 24;
    xDelta2 = -2;
    s._hFlipBase = true;
  } else {
    xDelta = -24;
    xDelta2 = 2;
  }
  s.x = s.x + xDelta;
  s.data[1] = xDelta2;
  s.data[0] = 60;
  s.callbackFn = curseNailStep1;
});

// Lua: g3_ghost.lua:295
function ghostStatusEnd(s: S, vm: any): void {
  P.setBld(vm, null);
  P.DestroyAnimSprite(s);
}

// Lua: g3_ghost.lua:300
function ghostStatusStep(s: S, vm: any): void {
  const d = s.data;
  s.ox = P.Sin(d[0], 12);
  if (!P.atkIsPlayer(vm)) s.ox = -s.ox;
  d[0] = band(d[0] + 6, 0xFF);
  d[1] = P.s16(d[1] + 0x100);
  s.oy = -P.shr(d[1], 8);
  d[7] = d[7] + 1;
  if (d[7] === 1) {
    d[6] = 0x050B;
    P.setBld(vm, 0x0B, 0x05);
  } else if (d[7] > 30) {
    d[2] = d[2] + 1;
    let coeffB = P.rshift(P.u16(d[6]), 8);
    let coeffA = band(d[6], 0xFF);
    coeffB = coeffB + 1;
    if (coeffB > 16) coeffB = 16;
    coeffA = P.u16(coeffA - 1);
    if (P.s16(coeffA) < 0) coeffA = 0;
    P.setBld(vm, coeffA, coeffB);
    d[6] = P.s16(coeffA + coeffB * 256);
    if (coeffB === 16 && coeffA === 0) {
      s.invisible = true;
      s.callbackFn = ghostStatusEnd;
    }
  }
}

// Lua: g3_ghost.lua:329 -- pokefirered/src/battle_anim_ghost.c:1098
C.GhostStatusSprite = cb(ghostStatusStep);

// Lua: g3_ghost.lua:331
function grudgeFlame(s: S): void {
  const d = s.data;
  const tk = s.task;
  if (d[1] === 0) d[2] = d[2] + 2; else d[2] = d[2] - 2;
  d[2] = band(d[2], 0xFF);
  s.ox = P.Sin(d[2], d[3]);
  const index = P.u16(d[2] - 65);
  const tp = tk ? (tk.data[5] ?? 1) : 1;
  if (index < 127) s.pri = tp + 1; else s.pri = tp;
  d[5] = d[5] + 1;
  d[6] = band(d[5] * 8, 0xFF);
  s.oy = P.Sin(d[6], 7);
  if (tk && tk.data[8] !== 0) {
    tk.data[7] = tk.data[7] - 1;
    P.DestroyAnimSprite(s);
  }
}

// Lua: g3_ghost.lua:349
function grudgeStep(t: Tk, vm: any): void {
  const d = t.data;
  if (d[0] === 0) {
    for (let i = 0; i <= 5; i++) {
      const s = P.CreateSprite(vm, "gGrudgeFlameSpriteTemplate", d[9], d[10], d[6], grudgeFlame);
      if (s) {
        s.task = t;
        s.data[0] = 0;
        s.data[1] = P.atkIsPlayer(vm) ? 1 : 0;
        s.data[2] = band(i * 42, 0xFF);
        s.data[3] = d[11];
        s.data[5] = i * 6;
        d[7] = d[7] + 1;
      }
    }
    d[0] = d[0] + 1;
  } else if (d[0] === 1) {
    d[1] = d[1] + 1;
    if (band(d[1], 1) !== 0) {
      if (d[3] < 14) d[3] = d[3] + 1;
    } else if (d[4] > 4) {
      d[4] = d[4] - 1;
    }
    if (d[3] === 14 && d[4] === 4) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
    P.setBld(vm, d[3], d[4]);
  } else if (d[0] === 2) {
    d[1] = d[1] + 1;
    if (d[1] > 30) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 3) {
    d[1] = d[1] + 1;
    if (band(d[1], 1) !== 0) {
      if (d[3] > 0) d[3] = d[3] - 1;
    } else if (d[4] < 16) {
      d[4] = d[4] + 1;
    }
    if (d[3] === 0 && d[4] === 16) {
      d[8] = 1;
      d[0] = d[0] + 1;
    }
    P.setBld(vm, d[3], d[4]);
  } else if (d[0] === 4) {
    if (d[7] <= 0) d[0] = d[0] + 1;
  } else if (d[0] === 5) {
    P.setBld(vm, null);
    P.DestroyAnimVisualTask(t);
  }
}

// Lua: g3_ghost.lua:404 -- pokefirered/src/battle_anim_ghost.c:1142
T.GrudgeFlames = task(function (t: Tk, vm: any): void {
  const d = t.data;
  const atk = P.atk(vm);
  d[0] = 0;
  d[1] = 16;
  d[9] = P.coord(vm, atk, P.COORD_X_2);
  d[10] = P.yWithElevation(vm, atk);
  d[11] = P.div(P.coordAttr(vm, atk, P.ATTR_WIDTH), 2) + 8;
  d[7] = 0;
  const bp = vm._bgPrio;
  // require("src.core.game3.battle.anim_coords"): a static import
  d[5] = (bp ? bp[AnimCoords.bgPriorityRank(atk)] : null) ?? 2;
  d[6] = P.subpriorityOf(atk) - 2;
  d[3] = 0;
  d[4] = 16;
  P.setBld(vm, 0, 16);
  d[8] = 0;
  t.fn = grudgeStep;
});

// Lua: g3_ghost.lua:423
function nightShadeTarget(t: Tk): any {
  return t._clone ?? t._p;
}

// Lua: g3_ghost.lua:427
function nightShadeApplyAlpha(t: Tk): void {
  const obj = nightShadeTarget(t);
  if (!obj) return;
  let a = t.data[2] / 16;
  if (a > 1) a = 1;
  if (t._clone) t._clone.alphaMul = null; else t._p.alpha = a;
}

// Lua: g3_ghost.lua:435
function nightShadeRotScale(t: Tk, v: number): void {
  if (t._clone) {
    t._clone._mat = seq(v, v, 0);
    P.sync(t._clone, t._vm);
  } else {
    P.monRotScale(t._p, v, v, 0);
  }
}

// Lua: g3_ghost.lua:444
function nightShadeStep2(t: Tk, vm: any): void {
  const d = t.data;
  if (d[1] > 0) {
    d[1] = d[1] - 1;
    return;
  }
  d[0] = d[0] + 8;
  if (d[0] <= 0xFF) {
    nightShadeRotScale(t, d[0]);
  } else {
    if (t._clone) {
      P.DestroyAnimSprite(t._clone);
    } else {
      P.monResetRotScale(t._p);
      t._p.alpha = 1;
    }
    P.DestroyAnimVisualTask(t);
    P.setBld(vm, null);
  }
}

// Lua: g3_ghost.lua:465
function nightShadeStep1(t: Tk, vm: any): void {
  const d = t.data;
  d[10] = d[10] + 1;
  if (d[10] === 3) {
    d[10] = 0;
    d[2] = d[2] + 1;
    d[3] = d[3] - 1;
    P.setBld(vm, d[2], d[3]);
    nightShadeApplyAlpha(t);
    if (d[2] !== 9) return;
    t.fn = nightShadeStep2;
  }
}

// Lua: g3_ghost.lua:480 -- pokefirered/src/battle_anim_ghost.c:335
T.NightShadeClone = task(function (t: Tk, vm: any): void {
  const d = t.data;
  const side = P.atk(vm);
  P.setBld(vm, 0, 16);
  t._vm = vm;
  t._p = P.monPresent(side);
  if (!t._p) {
    P.DestroyAnimVisualTask(t);
    return;
  }
  if (P.isMonBg(side)) {
    t._clone = P.CloneMon(vm, side);
    if (t._clone) {
      t._clone.zOverride = (side === "player") ? 195 : 105;
    }
  }
  nightShadeRotScale(t, 128);
  if (!t._clone) {
    t._p.visible = true;
    t._p.alpha = 0;
  }
  d[0] = 128;
  d[1] = t.ga[0];
  d[2] = 0;
  d[3] = 16;
  t.fn = nightShadeStep1;
});

// Lua: g3_ghost.lua:508
function nightmareStep(t: Tk, vm: any): void {
  const d = t.data;
  if (d[4] === 0) {
    d[1] = d[1] + 1;
    d[5] = band(d[1], 3);
    if (d[5] === 1 && d[2] > 0) d[2] = d[2] - 1;
    if (d[5] === 3 && d[3] <= 15) d[3] = d[3] + 1;
    P.setBld(vm, d[2], d[3]);
    if (d[3] !== 16 || d[2] !== 0) return;
    if (d[1] <= 80) return;
    if (t._clone) P.DestroyAnimSprite(t._clone);
    t._clone = null;
    d[4] = 1;
  } else if (d[4] === 1) {
    d[6] = d[6] + 1;
    if (d[6] <= 1) return;
    P.setBld(vm, null);
    d[4] = d[4] + 1;
  } else if (d[4] === 2) {
    P.DestroyAnimVisualTask(t);
  }
}

// Lua: g3_ghost.lua:532 -- pokefirered/src/battle_anim_ghost.c:511
T.NightmareClone = task(function (t: Tk, vm: any): void {
  const d = t.data;
  const side = P.tgt(vm);
  const c = P.CloneMon(vm, side);
  if (!c) {
    P.DestroyAnimVisualTask(t);
    return;
  }
  t._clone = c;
  d[1] = 0;
  d[2] = 15;
  d[3] = 2;
  d[4] = 0;
  P.setBld(vm, d[2], d[3]);
  c.data[0] = 80;
  if (side === "player") {
    c.data[1] = -144;
    c.data[2] = 112;
  } else {
    c.data[1] = 144;
    c.data[2] = -112;
  }
  c.data[3] = 0;
  c.data[4] = 0;
  P.StoreSpriteCallbackInData6(c, function (): void { /* empty */ });
  c.callbackFn = P.TranslateSpriteLinearFixedPoint;
  t.fn = nightmareStep;
});

// Lua: g3_ghost.lua:561
function spiteStep3(t: Tk, vm: any): void {
  const d = t.data;
  const k = d[15];
  if (k === 0) {
    t._wave = null;
    if (t._p) t._p.hShift = null;
  } else if (k === 1) {
    if (!P.isMonBg(t._side)) P.monBlend(t._p, 0, 0);
  } else if (k === 2) {
    if (t._clone) P.DestroyAnimSprite(t._clone);
    t._clone = null;
    if (t._p) t._p.alpha = 1;
    P.setBld(vm, null);
    P.DestroyAnimVisualTask(t);
  }
  d[15] = d[15] + 1;
}

// Lua: g3_ghost.lua:579
function spiteApplyWave(t: Tk): void {
  if (t._wave && t._p && P.isMonBg(t._side)) {
    t._p.hShift = P.hShiftFromHofs(t._wave.step(t._wave, 0));
  } else if (t._wave) {
    t._wave.step(t._wave, 0);
  }
}

// Lua: g3_ghost.lua:587
function spiteApplyAlpha(t: Tk, vm: any): void {
  if (t._p && P.isMonBg(t._side)) {
    t._p.alpha = P.bldAlphaValue(vm);
  }
}

// Lua: g3_ghost.lua:593
function spiteStep2(t: Tk, vm: any): void {
  const d = t.data;
  d[1] = d[1] + 1;
  d[5] = band(d[1], 1);
  const sine = P.SINE[mod(d[1], 256) + 1];
  if (d[5] === 0) d[2] = P.div(sine, 18);
  if (d[5] === 1) d[3] = 16 - P.div(sine, 18);
  P.setBld(vm, d[2], d[3]);
  spiteApplyAlpha(t, vm);
  spiteApplyWave(t);
  if (d[1] === 128) {
    d[15] = 0;
    t.fn = spiteStep3;
    spiteStep3(t, vm);
  }
}

// Lua: g3_ghost.lua:610
function spiteStep1(t: Tk, vm: any): void {
  const d = t.data;
  const k = d[15];
  if (k === 0) {
    const c = P.CloneMon(vm, t._side);
    if (!c) {
      P.DestroyAnimVisualTask(t);
      return;
    }
    t._clone = c;
    c.objBlend = null;
    c._objBlend = false;
    c.zOverride = 2;
    c.invisible = P.monHidden(vm, t._side);
    d[1] = 0;
    d[2] = 0;
    d[3] = 16;
    d[15] = d[15] + 1;
  } else if (k === 1) {
    if (!P.isMonBg(t._side)) P.monBlend(t._p, 10, 13 + 15 * 1024);
    d[15] = d[15] + 1;
  } else if (k === 2) {
    const [, my] = P.monCenter(vm, t._side);
    let startLine = Math.floor(my) - 32;
    if (startLine < 0) startLine = 0;
    t._wave = P.Wave(startLine, startLine + 64, 2, 6, 0);
    d[15] = d[15] + 1;
  } else if (k === 3) {
    P.setBld(vm, 0, 16);
    spiteApplyAlpha(t, vm);
    d[15] = d[15] + 1;
  } else if (k === 4) {
    t.fn = spiteStep2;
    d[15] = d[15] + 1;
  } else {
    d[15] = d[15] + 1;
  }
  spiteApplyWave(t);
}

// Lua: g3_ghost.lua:651 -- pokefirered/src/battle_anim_ghost.c:584
T.SpiteTargetShadow = task(function (t: Tk, vm: any): void {
  t._side = P.tgt(vm);
  t._p = P.monPresent(t._side);
  t.data[15] = 0;
  t.fn = spiteStep1;
  spiteStep1(t, vm);
});

// Lua: g3_ghost.lua:659
function dbwsTaskStep(t: Tk, vm: any): void {
  const d = t.data;
  if (d[0] === 0) {
    if (d[6] === 0) {
      d[5] = d[5] + 1;
      if (d[5] > 1) {
        d[5] = 0;
        d[7] = d[7] + 1;
        if (band(d[7], 1) !== 0) {
          if (d[8] < 16) d[8] = d[8] + 1;
        } else {
          if (d[9] !== 0) d[9] = d[9] - 1;
        }
        P.setBld(vm, d[8], d[9]);
        if (d[7] >= 24) {
          d[7] = 0;
          d[6] = 1;
        }
      }
    }
    if (d[10] !== 0) {
      d[10] = d[10] - 1;
    } else if (d[6] !== 0) {
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 1) {
    d[5] = d[5] + 1;
    if (d[5] > 1) {
      d[5] = 0;
      d[7] = d[7] + 1;
      if (band(d[7], 1) !== 0) {
        if (d[8] !== 0) d[8] = d[8] - 1;
      } else if (d[9] < 16) {
        d[9] = d[9] + 1;
      }
      P.setBld(vm, d[8], d[9]);
      if (d[8] === 0 && d[9] === 16) {
        for (const [, s] of ipairs<S>(t._sprites ?? seq())) {
          if (s.active) P.DestroyAnimSprite(s);
        }
        d[0] = d[0] + 1;
      }
    }
  } else if (d[0] === 2) {
    d[5] = d[5] + 1;
    if (d[5] > 0) d[0] = d[0] + 1;
  } else if (d[0] === 3) {
    P.setBld(vm, null);
    P.DestroyAnimVisualTask(t);
  }
}

// Lua: g3_ghost.lua:712 -- pokefirered/src/battle_anim_ghost.c:786
T.DestinyBondWhiteShadow = task(function (t: Tk, vm: any): void {
  const d = t.data;
  P.setBld(vm, 0, 16);
  d[5] = 0; d[6] = 0; d[7] = 0; d[8] = 0;
  d[9] = 16;
  d[10] = t.ga[0];
  const atk = P.atkId(vm);
  const baseX = P.coord(vm, atk, P.COORD_X_2);
  const baseY = P.coordAttr(vm, atk, P.ATTR_BOTTOM);
  t._sprites = seq();
  for (let other = 0; other <= 3; other++) {
    if (other !== atk && other !== P.bxor(atk, 2) && !P.monHidden(vm, other)) {
      const s = P.CreateSprite(vm, "gDestinyBondWhiteShadowSpriteTemplate", baseX, baseY, 55, destinyBondShadowStep);
      if (s) {
        const x = P.coord(vm, other, P.COORD_X_2);
        const y = P.coordAttr(vm, other, P.ATTR_BOTTOM);
        s.data[0] = P.s16(baseX * 16);
        s.data[1] = P.s16(baseY * 16);
        s.data[2] = P.s16(P.div((x - baseX) * 16, t.ga[1]));
        s.data[3] = P.s16(P.div((y - baseY) * 16, t.ga[1]));
        s.data[4] = t.ga[1];
        s.data[5] = x;
        s.data[6] = y;
        t._sprites[len(t._sprites) + 1] = s;
        d[12] = d[12] + 1;
      }
    }
  }
  t.fn = dbwsTaskStep;
});

// Lua: g3_ghost.lua:743
function curseDraw(t: Tk): void {
  // (Brian's `if not (love and love.graphics) then return end`: the platform always has graphics.)
  const w = t._win;
  if (!w) return;
  const l = w[1], r = w[2], tp = w[3], b = w[4];
  if (r > l && b > tp) {
    G.setColor(0, 0, 0, 1);
    G.rectangle("fill", l, tp, r - l, b - tp);
    G.setColor(1, 1, 1, 1);
  }
}

// Lua: g3_ghost.lua:755
function curseStep2(t: Tk, _vm: any): void {
  t._win = null;
  t.draw = null;
  P.DestroyAnimVisualTask(t);
}

// Lua: g3_ghost.lua:761
function trunc(v: number): number {
  if (v >= 0) return Math.floor(v);
  return -Math.floor(-v);
}

// Lua: g3_ghost.lua:766
function curseStep1(t: Tk, _vm: any): void {
  const d = t.data;
  const step = d[0];
  d[0] = d[0] + 1;
  let left: number, right: number, top: number, bottom: number;
  if (step < 16) {
    left = P.u16(trunc(d[5] - (d[1] * 0.0625) * step));
    right = P.u16(trunc(d[5] + (d[2] * 0.0625) * step));
    top = P.u16(trunc(d[6] - (d[3] * 0.0625) * step));
    bottom = P.u16(trunc(d[6] + (d[4] * 0.0625) * step));
  } else {
    left = 0; right = 240; top = 0; bottom = 112;
    P.bgBlend(16, 0);
    t.fn = curseStep2;
  }
  t._win = seq(left, Math.min(right, 240), top, Math.min(bottom, 160));
}

// Lua: g3_ghost.lua:785 -- pokefirered/src/battle_anim_ghost.c:926
T.CurseStretchingBlackBg = task(function (t: Tk, vm: any): void {
  const d = t.data;
  let startX: number;
  if (!P.atkIsPlayer(vm)) startX = 40; else startX = 200;
  const startY = 40;
  d[1] = startX;
  d[2] = 240 - startX;
  d[3] = startY;
  d[4] = 72;
  d[5] = startX;
  d[6] = startY;
  t._win = seq(startX, startX, startY, startY);
  t.z = 1;
  t.draw = curseDraw;
  t.fn = curseStep1;
});

// Lua: g3_ghost.lua:802
export const G3Ghost = { callbacks: C, tasks: T };
export default G3Ghost;
