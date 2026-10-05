// Port of gen1recomp src/core/game3/battle/anim_port/g3_psychic.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered battle_anim_psychic.c on the g3_pret kit.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod } from "../../../../../import/gen3/lua.ts";
import { seq } from "../../../platform/lt.ts";
import { AnimPal } from "../anim_pal.ts";
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

// Lua: g3_psychic.lua:4 -- local band = P.band
const band = (a: number, b: number): number => P.band(a, b);

// Lua: g3_psychic.lua:6
function gSine(i: number): number {
  if (i < 0) return 0;
  if (i < 320) return P.SINE[mod(i, 256) + 1];
  return P.Sin2(i - 320);
}

// Lua: g3_psychic.lua:12
function wallRestoreEnemy(s: S, vm: any): void {
  const p = s._wallEnemy;
  if (!p) return;
  s._wallEnemy = null;
  if (vm && vm._monbg && vm._monbg.enemy) return;
  if (p.z === 10) p.z = s._wallEnemyZ ?? 20;
}

// Lua: g3_psychic.lua:20
function defensiveWallStep5(s: S, vm: any): void {
  wallRestoreEnemy(s, vm);
  s.callbackFn = P.DestroyAnimSprite;
}

// Lua: g3_psychic.lua:25
function defensiveWallStep4(s: S, vm: any): void {
  P.setBld(vm, s.data[3], 16 - s.data[3]);
  s.data[3] = s.data[3] - 1;
  if (s.data[3] === -1) {
    const p = s._wallEnemy;
    if (p) p.visible = true;
    s.invisible = true;
    s.callbackFn = defensiveWallStep5;
  }
}

// Lua: g3_psychic.lua:36
function defensiveWallStep3(s: S): void {
  const d = s.data;
  d[1] = d[1] + 1;
  if (d[1] === 2) {
    d[1] = 0;
    // require("src.core.game3.battle.anim_pal"): a static import
    const f = s._wallPal != null ? AnimPal.writeFaded(s._wallPal) : null;
    if (f) {
      const color = f[8];
      for (let i = 8; i >= 1; i--) f[i] = f[i - 1];
      f[1] = color;
    }
    d[2] = d[2] + 1;
    if (d[2] === 16) s.callbackFn = defensiveWallStep4;
  }
}

// Lua: g3_psychic.lua:53
function defensiveWallStep2(s: S, vm: any): void {
  P.setBld(vm, s.data[3], 16 - s.data[3]);
  if (s.data[3] === 13) {
    s.callbackFn = defensiveWallStep3;
  } else {
    s.data[3] = s.data[3] + 1;
  }
}

// Lua: g3_psychic.lua:63 -- pokefirered/src/battle_anim_psychic.c:419
C.DefensiveWall = cb(function (s: S, vm: any): void {
  if (P.atkIsPlayer(vm)) {
    s.pri = 2;
    s.sub = 200;
    s.zOverride = 101;
  }
  const p = P.monPresent("enemy");
  if (p && p.visible !== false) {
    s._wallEnemy = p;
    if (p.z !== 10) {
      s._wallEnemyZ = p.z;
      p.z = 10;
    } else {
      s._wallEnemyZ = p._g4OrigZ ?? 20;
    }
  }
  if (!P.atkIsPlayer(vm)) s.ga[0] = -s.ga[0];
  s.x = P.coordAtk(vm, P.COORD_X) + s.ga[0];
  s.y = P.coordAtk(vm, P.COORD_Y) + s.ga[1];
  s.data[0] = s.ga[2];
  s._wallPal = AnimPal.tagName(s.ga[2]);
  s.callbackFn = defensiveWallStep2;
  defensiveWallStep2(s, vm);
});

// Lua: g3_psychic.lua:89 -- pokefirered/src/battle_anim_psychic.c:538
C.WallSparkle = cb(function (s: S, vm: any): void {
  if (s.data[0] === 0) {
    const respect = s.ga[3] === 0;
    if (s.ga[2] === 0) {
      P.InitSpritePosToAnimAttacker(s, vm, respect);
    } else {
      P.InitSpritePosToAnimTarget(s, vm, respect);
    }
    s.data[0] = s.data[0] + 1;
  } else if (s.animEnded || s.affineAnimEnded) {
    P.DestroySpriteAndMatrix(s);
  }
});

// Lua: g3_psychic.lua:104 -- pokefirered/src/battle_anim_psychic.c:575
C.BentSpoon = cb(function (s: S, vm: any): void {
  s.x = P.coordAtk(vm, P.COORD_X_2);
  s.y = P.coordAtk(vm, P.COORD_Y_PIC);
  if (!P.atkIsPlayer(vm)) {
    P.StartSpriteAnim(s, 1);
    s.x = s.x - 40;
    s.y = s.y + 10;
    s.data[1] = -1;
  } else {
    s.x = s.x + 40;
    s.y = s.y - 10;
    s.data[1] = 1;
  }
  P.StoreSpriteCallbackInData6(s, P.DestroyAnimSprite);
  s.callbackFn = P.RunStoredCallbackWhenAnimEnds;
});

// Lua: g3_psychic.lua:121
function questionMarkStep2(s: S): void {
  const d = s.data;
  if (d[0] === 0) {
    if (s.affineAnimEnded) {
      s._aff = 0;
      s._mat = null;
      d[1] = 18;
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 1) {
    d[1] = d[1] - 1;
    if (d[1] === -1) P.DestroyAnimSprite(s);
  }
}

// Lua: g3_psychic.lua:136
function questionMarkStep1(s: S): void {
  s._aff = 1;
  s._affine = seq(P.data().affine.sAffineAnim_QuestionMark);
  s.data[0] = 0;
  P.StartSpriteAffineAnim(s, 0);
  s.callbackFn = questionMarkStep2;
}

// Lua: g3_psychic.lua:145 -- pokefirered/src/battle_anim_psychic.c:597
C.QuestionMark = cb(function (s: S, vm: any): void {
  const atk = P.atk(vm);
  let x = P.s16(P.div(P.coordAttr(vm, atk, P.ATTR_WIDTH), 2));
  const y = P.s16(P.div(P.coordAttr(vm, atk, P.ATTR_HEIGHT), -2));
  if (!P.isPlayer(atk)) x = -x;
  s.x = P.coord(vm, atk, P.COORD_X_2) + x;
  s.y = P.coord(vm, atk, P.COORD_Y_PIC) + y;
  if (s.y < 16) s.y = 16;
  P.StoreSpriteCallbackInData6(s, questionMarkStep1);
  s.callbackFn = P.RunStoredCallbackWhenAnimEnds;
});

// Lua: g3_psychic.lua:157
function prepareAffineAnimInTaskData(t: Tk, _vm: any, side: any, cmds: any): void {
  const d = t.data;
  d[7] = 0;
  d[8] = 0;
  d[9] = 0;
  d[15] = 0;
  d[10] = 0x100;
  d[11] = 0x100;
  d[12] = 0;
  t._affSide = side;
  t._affP = P.monPresent(side);
  t._affCmds = cmds;
}

// Lua: g3_psychic.lua:171
function runAffineAnimFromTaskData(t: Tk, vm: any): boolean {
  const d = t.data;
  const cmds = t._affCmds;
  const p = t._affP;
  let idx = d[7];
  let c = cmds[idx + 1];
  if (!c || c.e != null) {
    if (p) p.oy = 0;
    P.monResetRotScale(p);
    return false;
  } else if (c.j != null) {
    d[7] = c.j;
  } else if (c.l != null) {
    if (c.l !== 0) {
      if (d[9] !== 0) {
        d[9] = d[9] - 1;
        if (d[9] === 0) {
          d[7] = d[7] + 1;
          return true;
        }
      } else {
        d[9] = c.l;
      }
      if (d[7] === 0) return true;
      while (true) {
        d[7] = d[7] - 1;
        idx = idx - 1;
        const prev = cmds[idx + 1];
        if (prev && prev.l != null) {
          d[7] = d[7] + 1;
          return true;
        }
        if (d[7] === 0) return true;
      }
    }
    d[7] = d[7] + 1;
  } else {
    if (P.u8(c.d ?? 0) === 0) {
      d[10] = c.x;
      d[11] = c.y;
      d[12] = P.u8(c.r ?? 0);
      d[7] = d[7] + 1;
      idx = idx + 1;
      c = cmds[idx + 1] ?? c;
    }
    d[10] = P.s16(d[10] + (c.x ?? 0));
    d[11] = P.s16(d[11] + (c.y ?? 0));
    d[12] = P.s16(d[12] + P.u8(c.r ?? 0));
    P.monRotScale(p, d[10], d[11], P.u16(d[12]));
    P.monYOffsetFromYScale(vm, t._affSide);
    d[8] = d[8] + 1;
    if (d[8] >= P.u8(c.d ?? 0)) {
      d[8] = 0;
      d[7] = d[7] + 1;
    }
  }
  return true;
}

// Lua: g3_psychic.lua:230
function meditateStep(t: Tk, vm: any): void {
  if (!runAffineAnimFromTaskData(t, vm)) P.DestroyAnimVisualTask(t);
}

// Lua: g3_psychic.lua:235 -- pokefirered/src/battle_anim_psychic.c:641
T.MeditateStretchAttacker = task(function (t: Tk, vm: any): void {
  t.data[0] = 0;
  prepareAffineAnimInTaskData(t, vm, P.atk(vm), P.data().affine.sAffineAnim_MeditateStretchAttacker);
  t.fn = meditateStep;
});

// Lua: g3_psychic.lua:241
function teleportStep(t: Tk, vm: any): void {
  const d = t.data;
  if (d[1] === 0) {
    runAffineAnimFromTaskData(t, vm);
    d[2] = d[2] + 1;
    if (d[2] > 19) d[1] = d[1] + 1;
  } else if (d[1] === 1) {
    const p = t._affP;
    if (d[3] !== 0) {
      if (p) p.oy = p.oy - 8;
      d[3] = d[3] - 1;
    } else {
      if (p) {
        p.visible = false;
        p.ox = (240 + 32) - P.coord(vm, t._affSide, P.COORD_X_2);
      }
      P.monResetRotScale(p);
      P.DestroyAnimVisualTask(t);
    }
  }
}

// Lua: g3_psychic.lua:264 -- pokefirered/src/battle_anim_psychic.c:657
T.Teleport = task(function (t: Tk, vm: any): void {
  const d = t.data;
  d[0] = 0;
  d[1] = 0;
  d[2] = 0;
  d[3] = P.atkIsPlayer(vm) ? 8 : 4;
  prepareAffineAnimInTaskData(t, vm, P.atk(vm), P.data().affine.sAffineAnim_Teleport);
  t.fn = teleportStep;
});

// Lua: g3_psychic.lua:274
function imprisonOrbsStep(t: Tk, vm: any): void {
  const d = t.data;
  const k = d[0];
  if (k === 0) {
    d[1] = d[1] + 1;
    if (d[1] > 8) {
      d[1] = 0;
      const s = P.CreateSprite(vm, "sImprisonOrbSpriteTemplate", d[13], d[14], 0, null);
      t._orbs[d[2]] = s;
      if (s) {
        const r = d[12];
        if (d[2] === 0) {
          s.ox = r; s.oy = -r;
        } else if (d[2] === 1) {
          s.ox = -r; s.oy = r;
        } else if (d[2] === 2) {
          s.ox = r; s.oy = r;
        } else if (d[2] === 3) {
          s.ox = -r; s.oy = -r;
        }
      }
      d[2] = d[2] + 1;
      if (d[2] === 5) d[0] = d[0] + 1;
    }
  } else if (k === 1) {
    if (band(d[1], 1) !== 0) {
      d[3] = d[3] - 1;
    } else {
      d[4] = d[4] + 1;
    }
    P.setBld(vm, d[3], d[4]);
    d[1] = d[1] + 1;
    if (d[1] === 32) {
      for (let i = 0; i <= 4; i++) {
        const s = t._orbs[i];
        if (s && s.active) P.DestroyAnimSprite(s);
      }
      d[0] = d[0] + 1;
    }
  } else if (k === 2) {
    d[0] = d[0] + 1;
  } else if (k === 3) {
    P.setBld(vm, null);
    P.DestroyAnimVisualTask(t);
  }
}

// Lua: g3_psychic.lua:322 -- pokefirered/src/battle_anim_psychic.c:698
T.ImprisonOrbs = task(function (t: Tk, vm: any): void {
  const d = t.data;
  const atk = P.atk(vm);
  d[3] = 16;
  d[4] = 0;
  d[13] = P.coord(vm, atk, P.COORD_X_2);
  d[14] = P.coord(vm, atk, P.COORD_Y_PIC);
  const var0 = P.u16(P.div(P.coordAttr(vm, atk, P.ATTR_WIDTH), 3));
  const var1 = P.u16(P.div(P.coordAttr(vm, atk, P.ATTR_HEIGHT), 3));
  d[12] = var0 > var1 ? var0 : var1;
  P.setBld(vm, 16, 0);
  t._orbs = [] as any[];
  t.fn = imprisonOrbsStep;
});

// Lua: g3_psychic.lua:337
function redXStep(s: S): void {
  const d = s.data;
  if (d[1] > d[0] - 10) s.invisible = band(d[1], 1) !== 0;
  if (d[1] === d[0]) {
    P.DestroyAnimSprite(s);
    return;
  }
  d[1] = d[1] + 1;
}

// Lua: g3_psychic.lua:348 -- pokefirered/src/battle_anim_psychic.c:790
C.RedX = cb(function (s: S, vm: any): void {
  if (s.ga[0] === 0) {
    s.x = P.coordAtk(vm, P.COORD_X_2);
    s.y = P.coordAtk(vm, P.COORD_Y_PIC);
  }
  s.data[0] = s.ga[1];
  s.callbackFn = redXStep;
});

// Lua: g3_psychic.lua:357
function skillSwapOrb(s: S): void {
  if (P.TranslateAnimHorizontalArc(s)) P.DestroyAnimSprite(s);
}

// Lua: g3_psychic.lua:361
function skillSwapStep(t: Tk, vm: any): void {
  const d = t.data;
  if (d[0] === 0) {
    d[1] = d[1] + 1;
    if (d[1] > 6) {
      d[1] = 0;
      const s = P.CreateSprite(vm, "sSkillSwapOrbSpriteTemplate", d[11], d[12], 0, skillSwapOrb);
      if (s) {
        s.data[0] = 16;
        s.data[2] = d[13];
        s.data[4] = d[14];
        s.data[5] = d[10];
        P.InitAnimArcTranslation(s);
        P.StartSpriteAffineAnim(s, band(d[2], 3));
      }
      d[2] = d[2] + 1;
      if (d[2] === 12) d[0] = d[0] + 1;
    }
  } else if (d[0] === 1) {
    d[1] = d[1] + 1;
    if (d[1] > 17) P.DestroyAnimVisualTask(t);
  }
}

// Lua: g3_psychic.lua:386 -- pokefirered/src/battle_anim_psychic.c:801
T.SkillSwap = task(function (t: Tk, vm: any): void {
  const d = t.data;
  const atk = P.atk(vm), tgt = P.tgt(vm);
  if (t.ga[0] === 1) {
    d[10] = -10;
    d[11] = P.coordAttr(vm, tgt, P.ATTR_LEFT) + 8;
    d[12] = P.coordAttr(vm, tgt, P.ATTR_TOP) + 8;
    d[13] = P.coordAttr(vm, atk, P.ATTR_LEFT) + 8;
    d[14] = P.coordAttr(vm, atk, P.ATTR_TOP) + 8;
  } else {
    d[10] = 10;
    d[11] = P.coordAttr(vm, atk, P.ATTR_RIGHT) - 8;
    d[12] = P.coordAttr(vm, atk, P.ATTR_BOTTOM) - 8;
    d[13] = P.coordAttr(vm, tgt, P.ATTR_RIGHT) - 8;
    d[14] = P.coordAttr(vm, tgt, P.ATTR_BOTTOM) - 8;
  }
  d[1] = 6;
  t.fn = skillSwapStep;
});

// Lua: g3_psychic.lua:406
function extrasensoryApply(t: Tk): void {
  const p = t._p;
  if (!p) return;
  if (t._rows && P.isMonBg(t._side)) {
    p.hShift = P.hShiftFromHofs(t._rows);
  } else if (p.hShift === t._shift) {
    p.hShift = null;
  }
  t._shift = p.hShift;
}

// Lua: g3_psychic.lua:417
function extrasensoryStep(t: Tk, _vm: any): void {
  const d = t.data;
  if (d[0] === 0) {
    let sineIndex = d[13];
    for (let i = d[14]; i <= d[15]; i++) {
      let var2 = P.s16(P.shr(gSine(sineIndex), d[12]));
      if (var2 > 0) {
        var2 = var2 + band(d[1], 3);
      } else if (var2 < 0) {
        var2 = var2 - band(d[1], 3);
      }
      t._rows[i] = var2;
      sineIndex = P.s16(sineIndex + d[11]);
    }
    extrasensoryApply(t);
    d[1] = d[1] + 1;
    if (d[1] > 23) d[0] = d[0] + 1;
  } else if (d[0] === 1) {
    t._rows = null;
    extrasensoryApply(t);
    d[0] = d[0] + 1;
  } else if (d[0] === 2) {
    P.DestroyAnimVisualTask(t);
  }
}

// Lua: g3_psychic.lua:444 -- pokefirered/src/battle_anim_psychic.c:891
T.ExtrasensoryDistortion = task(function (t: Tk, vm: any): void {
  const d = t.data;
  const side = P.tgt(vm);
  const yOffset = P.u8(P.yWithElevation(vm, side));
  d[14] = yOffset - 32;
  const a = t.ga[0];
  if (a === 0) {
    d[11] = 2; d[12] = 5; d[13] = 64; d[15] = yOffset + 32;
  } else if (a === 1) {
    d[11] = 2; d[12] = 5; d[13] = 192; d[15] = yOffset + 32;
  } else if (a === 2) {
    d[11] = 4; d[12] = 4; d[13] = 0; d[15] = yOffset + 32;
  }
  if (d[14] < 0) d[14] = 0;
  d[10] = 0;
  t._side = side;
  t._p = P.monPresent(side);
  t._rows = [] as number[];
  for (let i = d[14]; i <= d[14] + 64; i++) t._rows[i] = 0;
  extrasensoryApply(t);
  t.fn = extrasensoryStep;
});

// Lua: g3_psychic.lua:467
function cloneYOffset(t: Tk, vm: any): void {
  const c = t._clone;
  const v = 64 - P.yDelta(vm, t._side) * 2;
  const dd = t.data[2];
  let var2 = (dd === 0) ? 0 : P.div(v * 256, dd);
  if (var2 > 128) var2 = 128;
  c.oy = P.div(v - var2, 2);
}

// Lua: g3_psychic.lua:476
function transparentCloneStep(t: Tk, vm: any): void {
  const d = t.data;
  const c = t._clone;
  if (d[0] === 0) {
    d[1] = d[1] + 4;
    d[2] = 256 - P.shr(gSine(d[1]), 1);
    c._mat = seq(d[2], d[2], 0);
    cloneYOffset(t, vm);
    if (d[1] === 48) d[0] = d[0] + 1;
  } else if (d[0] === 1) {
    d[1] = d[1] - 4;
    d[2] = 256 - P.shr(gSine(d[1]), 1);
    c._mat = seq(d[2], d[2], 0);
    cloneYOffset(t, vm);
    if (d[1] === 0) d[0] = d[0] + 1;
  } else if (d[0] === 2) {
    if (c && c.active) P.DestroyAnimSprite(c);
    t._clone = null;
    d[0] = d[0] + 1;
  } else if (d[0] === 3) {
    P.DestroyAnimVisualTask(t);
  }
}

// Lua: g3_psychic.lua:501 -- pokefirered/src/battle_anim_psychic.c:981
T.TransparentCloneGrowAndShrink = task(function (t: Tk, vm: any): void {
  const side = P.side(vm, t.ga[0]);
  const c = side != null ? P.CloneMon(vm, side) : null;
  if (!c) {
    P.DestroyAnimVisualTask(t);
    return;
  }
  c.callbackFn = null;
  c._aff = 3;
  c.affineAnimPaused = true;
  c._mat = seq(256, 256, 0);
  t._clone = c;
  t._side = side;
  t.data[13] = 0;
  t.data[14] = 0;
  t.data[15] = 0;
  t.fn = transparentCloneStep;
});

// Lua: g3_psychic.lua:521 -- pokefirered/src/battle_anim_psychic.c:1046
C.PsychoBoost = cb(function (s: S, vm: any): void {
  const d = s.data;
  const k = d[0];
  if (k === 0) {
    s.x = P.coordAtk(vm, P.COORD_X);
    s.y = P.coordAtk(vm, P.COORD_Y);
    d[1] = 8;
    P.setBld(vm, d[1], 16 - d[1]);
    d[0] = d[0] + 1;
  } else if (k === 1) {
    if (s.affineAnimEnded) {
      P.playSEPan(vm, "SE_M_TELEPORT", -64);
      P.ChangeSpriteAffineAnim(s, 1);
      d[0] = d[0] + 1;
    }
  } else if (k === 2) {
    const old = d[2];
    d[2] = d[2] + 1;
    if (old > 1) {
      d[2] = 0;
      d[1] = d[1] - 1;
      P.setBld(vm, d[1], 16 - d[1]);
      if (d[1] === 0) {
        d[0] = d[0] + 1;
        s.invisible = true;
      }
    }
    d[3] = d[3] + 0x380;
    s.oy = s.oy - P.shr(d[3], 8);
    d[3] = band(d[3], 0xFF);
  } else if (k === 3) {
    P.setBld(vm, null);
    P.DestroyAnimSprite(s);
  }
});

// Lua: g3_psychic.lua:557
export const G3Psychic = { callbacks: C, tasks: T };
export default G3Psychic;
