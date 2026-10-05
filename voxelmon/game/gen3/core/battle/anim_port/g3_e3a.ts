// Port of gen1recomp src/core/game3/battle/anim_port/g3_e3a.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered battle_anim_effects_3.c (first part) on the g3_pret kit.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, truthy } from "../../../../../import/gen3/lua.ts";
import { ipairs, len, pairs, seq } from "../../../platform/lt.ts";
import P from "./g3_pret.ts";

type S = Record<string, any>;
type Tk = Record<string, any>;

const C: Record<string, any> = {};
const T: Record<string, any> = {};
const H: Record<string, any> = {};

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

// Lua: g3_e3a.lua:5 -- local band = P.band
const band = (a: number, b: number): number => P.band(a, b);

// Lua: g3_e3a.lua:7
H.affineTable = function (name: string): any {
  return P.data().affine[name];
};

// Lua: g3_e3a.lua:11
H.PrepareAffineAnimInTaskData = function (t: Tk, side: any, cmds: any): void {
  const d = t.data;
  d[7] = 0;
  d[8] = 0;
  d[9] = 0;
  d[10] = 0x100;
  d[11] = 0x100;
  d[12] = 0;
  t._affSide = side;
  t._affCmds = cmds ?? seq();
};

// Lua: g3_e3a.lua:23
H.RunAffineAnimFromTaskData = function (t: Tk, vm: any): boolean {
  const d = t.data;
  const cmds = t._affCmds;
  const side = t._affSide;
  const p = P.monPresent(side);
  let c = cmds[d[7] + 1];
  if (c == null || c.e != null) {
    if (p) {
      p.oy = 0;
      P.monResetRotScale(p);
    }
    return false;
  }
  if (c.j != null) {
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
        const q = cmds[d[7] + 1];
        if (q && q.l != null) {
          d[7] = d[7] + 1;
          return true;
        }
        if (d[7] === 0) return true;
      }
    }
    d[7] = d[7] + 1;
  } else {
    if ((c.d ?? 0) === 0) {
      d[10] = c.x ?? 0;
      d[11] = c.y ?? 0;
      d[12] = P.u8(c.r ?? 0);
      d[7] = d[7] + 1;
      c = cmds[d[7] + 1] ?? c;
    }
    d[10] = P.s16(d[10] + (c.x ?? 0));
    d[11] = P.s16(d[11] + (c.y ?? 0));
    d[12] = P.s16(d[12] + P.u8(c.r ?? 0));
    if (p) {
      P.monRotScale(p, d[10], d[11], P.u16(d[12]));
      P.monYOffsetFromYScale(vm, side);
    }
    d[8] = d[8] + 1;
    if (d[8] >= (c.d ?? 0)) {
      d[8] = 0;
      d[7] = d[7] + 1;
    }
  }
  return true;
};

// Lua: g3_e3a.lua:85 -- returns P.task(fn); the wrap is made on first call (see task()).
H.deformTask = function (tableName: string): (t: Tk, vm: any) => void {
  return task(function (t: Tk, vm: any): void {
    if (t.data[0] === 0) {
      H.PrepareAffineAnimInTaskData(t, P.atk(vm), H.affineTable(tableName));
      t.data[0] = t.data[0] + 1;
    } else if (!H.RunAffineAnimFromTaskData(t, vm)) {
      P.DestroyAnimVisualTask(t);
    }
  });
};

// Lua: g3_e3a.lua:96
H.blackSmokeStep = function (s: S): void {
  const d = s.data;
  if (d[1] > 0) {
    s.ox = P.shr(d[2], 8);
    d[2] = P.s16(d[2] + d[0]);
    s.invisible = !truthy(s.invisible);
    d[1] = d[1] - 1;
  } else {
    P.DestroyAnimSprite(s);
  }
};

// Lua: g3_e3a.lua:109 -- pokefirered/src/battle_anim_effects_3.c:1171
C.BlackSmoke = cb(function (s: S, _vm: any): void {
  s.x = s.x + s.ga[0];
  s.y = s.y + s.ga[1];
  if (s.ga[3] === 0) {
    s.data[0] = s.ga[2];
  } else {
    s.data[0] = -s.ga[2];
  }
  s.data[1] = s.ga[4];
  s.callbackFn = H.blackSmokeStep;
});

// Lua: g3_e3a.lua:121
H.smokescreenImpactPart = function (s: S): void {
  if (s.animEnded) {
    P.DestroyAnimSprite(s);
  }
};

// Lua: g3_e3a.lua:127
H.SmokescreenImpact = function (vm: any, x: number, y: number): void {
  const spots = seq(seq(x - 16, y - 16), seq(x, y - 16), seq(x - 16, y), seq(x, y));
  for (let i = 1; i <= 4; i++) {
    const s = P.CreateSprite(vm, "sSmokescreenImpactSpriteTemplate", spots[i]![1], spots[i]![2], 2, H.smokescreenImpactPart);
    if (s) {
      s._baseW = 16; s._baseH = 16; s.w = 16; s.h = 16;
      s.pri = 1;
      if (i > 1) P.StartSpriteAnim(s, i - 1);
      P.animate(s);
      P.sync(s, vm);
    }
  }
};

// Lua: g3_e3a.lua:142 -- pokefirered/src/battle_anim_effects_3.c:1199
T.SmokescreenImpact = task(function (t: Tk, vm: any): void {
  H.SmokescreenImpact(vm, P.coordTgt(vm, P.COORD_X_2) + 8, P.coordTgt(vm, P.COORD_Y_PIC) + 8);
  P.DestroyAnimVisualTask(t);
});

// Lua: g3_e3a.lua:147
H.whiteHaloStep2 = function (s: S, vm: any): void {
  P.setBld(vm, null);
  P.DestroyAnimSprite(s);
};

// Lua: g3_e3a.lua:152
H.whiteHaloStep1 = function (s: S, vm: any): void {
  P.setBld(vm, s.data[1], 16 - s.data[1]);
  s.data[1] = s.data[1] - 1;
  if (s.data[1] < 0) {
    s.invisible = true;
    s.callbackFn = H.whiteHaloStep2;
  }
};

// Lua: g3_e3a.lua:162 -- pokefirered/src/battle_anim_effects_3.c:1208
C.WhiteHalo = cb(function (s: S, vm: any): void {
  s.data[0] = 90;
  s.callbackFn = P.WaitAnimForDuration;
  s.data[1] = 7;
  P.StoreSpriteCallbackInData6(s, H.whiteHaloStep1);
  P.setBld(vm, s.data[1], 16 - s.data[1]);
});

// Lua: g3_e3a.lua:171 -- pokefirered/src/battle_anim_effects_3.c:1235
C.TealAlert = cb(function (s: S, vm: any): void {
  const x = P.u8(P.coordTgt(vm, P.COORD_X_2));
  const y = P.u8(P.coordTgt(vm, P.COORD_Y_PIC));
  P.InitSpritePosToAnimTarget(s, vm, true);
  let rotation = P.ArcTan2Neg(P.s16(s.x - x), P.s16(s.y - y));
  rotation = P.u16(rotation + 0x6000);
  P.TrySetSpriteRotScale(s, false, 0x100, 0x100, rotation);
  s.data[0] = s.ga[2];
  s.data[2] = x;
  s.data[4] = y;
  s.callbackFn = P.StartAnimLinearTranslation;
  P.StoreSpriteCallbackInData6(s, P.DestroyAnimSprite);
});

// Lua: g3_e3a.lua:185
H.meanLookStep4 = function (s: S, vm: any): void {
  const d = s.data;
  P.setBld(vm, d[0], 16 - d[0]);
  const r = d[1];
  d[1] = d[1] + 1;
  if (r > 1) {
    d[0] = d[0] - 1;
    d[1] = 0;
  }
  if (d[0] === 0) s.invisible = true;
  if (d[0] < 0) {
    P.setBld(vm, null);
    P.DestroyAnimSprite(s);
  }
};

// Lua: g3_e3a.lua:201
H.meanLookStep3 = function (s: S, vm: any): void {
  const d = s.data;
  const k = d[3];
  if (k === 0 || k === 1) {
    s.ox = 1; s.oy = 0;
  } else if (k === 2 || k === 3) {
    s.ox = -1; s.oy = 0;
  } else if (k === 4 || k === 5) {
    s.ox = 0; s.oy = 1;
  } else {
    s.ox = 0; s.oy = -1;
  }
  d[3] = d[3] + 1;
  if (d[3] > 7) d[3] = 0;
  const r = d[4];
  d[4] = d[4] + 1;
  if (r > 15) {
    d[0] = 16;
    d[1] = 0;
    P.setBld(vm, d[0], 0);
    s.callbackFn = H.meanLookStep4;
  }
};

// Lua: g3_e3a.lua:225
H.meanLookStep2 = function (s: S): void {
  const r = s.data[2];
  s.data[2] = s.data[2] + 1;
  if (r > 9) {
    s.invisible = false;
    s.affineAnimPaused = false;
    if (s.affineAnimEnded) s.callbackFn = H.meanLookStep3;
  }
};

// Lua: g3_e3a.lua:235
H.meanLookStep1 = function (s: S, vm: any): void {
  const d = s.data;
  P.setBld(vm, d[0], 16 - d[0]);
  if (d[1] !== 0) d[0] = d[0] - 1; else d[0] = d[0] + 1;
  if (d[0] === 15 || d[0] === 4) d[1] = P.bxor(d[1], 1);
  const r = d[2];
  d[2] = d[2] + 1;
  if (r > 70) {
    P.setBld(vm, null);
    P.StartSpriteAffineAnim(s, 1);
    d[2] = 0;
    s.invisible = true;
    s.affineAnimPaused = true;
    s.callbackFn = H.meanLookStep2;
  }
};

// Lua: g3_e3a.lua:253 -- pokefirered/src/battle_anim_effects_3.c:1255
C.MeanLookEye = cb(function (s: S, vm: any): void {
  P.setBld(vm, 0, 16);
  s.data[0] = 4;
  s.callbackFn = H.meanLookStep1;
});

// Lua: g3_e3a.lua:259
H.spikesStep2 = function (s: S): void {
  if (band(s.data[1], 1) !== 0) s.invisible = !truthy(s.invisible);
  s.data[1] = s.data[1] + 1;
  if (s.data[1] === 16) P.DestroyAnimSprite(s);
};

// Lua: g3_e3a.lua:265
H.spikesStep1 = function (s: S): void {
  if (P.TranslateAnimHorizontalArc(s)) {
    s.data[0] = 30;
    s.data[1] = 0;
    s.callbackFn = P.WaitAnimForDuration;
    P.StoreSpriteCallbackInData6(s, H.spikesStep2);
  }
};

// Lua: g3_e3a.lua:275 -- pokefirered/src/battle_anim_effects_3.c:1413
C.Spikes = cb(function (s: S, vm: any): void {
  P.InitSpritePosToAnimAttacker(s, vm, true);
  const tx = P.coordTgt(vm, P.COORD_X);
  const ty = P.coordTgt(vm, P.COORD_Y);
  const x = P.u16(P.div(tx + tx, 2));
  const y = P.u16(P.div(ty + ty, 2));
  if (!P.atkIsPlayer(vm)) s.ga[2] = -s.ga[2];
  s.data[0] = s.ga[4];
  s.data[2] = x + s.ga[2];
  s.data[4] = y + s.ga[3];
  s.data[5] = -50;
  P.InitAnimArcTranslation(s);
  s.callbackFn = H.spikesStep1;
});

// Lua: g3_e3a.lua:291 -- pokefirered/src/battle_anim_effects_3.c:1451
C.Leer = cb(function (s: S, vm: any): void {
  P.SetSpriteCoordsToAnimAttackerCoords(s, vm);
  P.SetAnimSpriteInitialXOffset(s, vm, s.ga[0]);
  s.y = s.y + s.ga[1];
  s.callbackFn = P.RunStoredCallbackWhenAnimEnds;
  P.StoreSpriteCallbackInData6(s, P.DestroyAnimSprite);
});

// Lua: g3_e3a.lua:299
H.letterZ = function (s: S, vm: any): void {
  const d = s.data;
  if (d[0] === 0) {
    P.SetSpriteCoordsToAnimAttackerCoords(s, vm);
    P.SetAnimSpriteInitialXOffset(s, vm, s.ga[0]);
    if (P.atkIsPlayer(vm)) {
      d[1] = s.ga[2];
      d[2] = s.ga[3];
    } else {
      d[1] = P.s16(-1 * s.ga[2]);
      d[2] = P.s16(-1 * s.ga[3]);
    }
  }
  d[0] = P.s16(d[0] + 1);
  const var0 = band(d[0] * 20, 0xFF);
  d[3] = P.s16(d[3] + d[1]);
  d[4] = P.s16(d[4] + d[2]);
  s.ox = P.s16(P.div(d[3], 2));
  s.oy = P.s16(P.Sin(band(var0, 0xFF), 5) + P.div(d[4], 2));
  if (P.u16(s.x + s.ox) > 240) P.DestroyAnimSprite(s);
};

// Lua: g3_e3a.lua:322 -- pokefirered/src/battle_anim_effects_3.c:1460
C.LetterZ = cb(H.letterZ);

// Lua: g3_e3a.lua:325 -- pokefirered/src/battle_anim_effects_3.c:1498
C.Fang = cb(function (s: S): void {
  if (s.animEnded) P.DestroyAnimSprite(s);
});

// Lua: g3_e3a.lua:330 -- pokefirered/src/battle_anim_effects_3.c:1504
T.IsTargetPlayerSide = task(function (t: Tk, vm: any): void {
  if (P.tgtIsPlayer(vm)) P.setRet(vm, 1); else P.setRet(vm, 0);
  P.DestroyAnimVisualTask(t);
});

// Lua: g3_e3a.lua:335
H.animMoveDmg = function (vm: any): number {
  let v: any = vm ? vm.moveDmg : null;
  if (v == null && vm && vm.ctx) {
    const c = vm.ctx;
    v = truthy(c.moveDmg) ? c.moveDmg : truthy(c.animMoveDmg) ? c.animMoveDmg : c.damage;
  }
  if (v == null) return 1;
  return tonumber(v) ?? 1;
};

// Lua: g3_e3a.lua:343 -- pokefirered/src/battle_anim_effects_3.c:1514
T.IsHealingMove = task(function (t: Tk, vm: any): void {
  if (H.animMoveDmg(vm) > 0) P.setRet(vm, 0); else P.setRet(vm, 1);
  P.DestroyAnimVisualTask(t);
});

// Lua: g3_e3a.lua:348
H.spotlightStep2 = function (s: S, vm: any): void {
  const w = P.win(vm);
  w.winout = 0x3F3F;
  w.objwin = !truthy(w.objwin);
  P.DestroyAnimSprite(s);
};

// Lua: g3_e3a.lua:355
H.spotlightStep1 = function (s: S): void {
  const d = s.data;
  const k = d[0];
  if (k === 0) {
    s.invisible = false;
    if (s.affineAnimEnded) d[0] = d[0] + 1;
  } else if (k === 1 || k === 3) {
    d[1] = P.s16(d[1] + 117);
    s.ox = P.shr(d[1], 8);
    d[2] = d[2] + 1;
    if (d[2] === 21) {
      d[2] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 2) {
    d[1] = P.s16(d[1] - 117);
    s.ox = P.shr(d[1], 8);
    d[2] = d[2] + 1;
    if (d[2] === 41) {
      d[2] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 4) {
    P.ChangeSpriteAffineAnim(s, 1);
    d[0] = d[0] + 1;
  } else if (k === 5) {
    if (s.affineAnimEnded) {
      s.invisible = true;
      s.callbackFn = H.spotlightStep2;
    }
  }
};

// Lua: g3_e3a.lua:389 -- pokefirered/src/battle_anim_effects_3.c:1524
C.Spotlight = cb(function (s: S, vm: any): void {
  const w = P.win(vm);
  w.winout = 0x1F3F;
  w.objwin = true;
  w.win0 = null;
  P.InitSpritePosToAnimTarget(s, vm, false);
  P.registerObjWindow(vm, s);
  P.ensureColorOverlay(vm);
  s.invisible = true;
  s.callbackFn = H.spotlightStep1;
});

// Lua: g3_e3a.lua:401
H.clappingHandStep = function (s: S, vm: any): void {
  const d = s.data;
  if (d[2] === 0) {
    s.ox = s.ox + d[1];
    if (s.ox === 0) {
      d[2] = d[2] + 1;
      if (d[3] === 0) P.playSEPan(vm, "SE_M_ENCORE", -64);
    }
  } else {
    s.ox = s.ox - d[1];
    if (P.abs(s.ox) === 12) {
      d[0] = d[0] - 1;
      d[2] = d[2] - 1;
    }
  }
  if (d[0] === 0) P.DestroyAnimSprite(s);
};

// Lua: g3_e3a.lua:419
H.clappingHand = function (s: S, vm: any): void {
  if (s.ga[3] === 0) {
    s.x = P.coordAtk(vm, P.COORD_X);
    s.y = P.coordAtk(vm, P.COORD_Y);
  }
  s.x = s.x + s.ga[0];
  s.y = s.y + s.ga[1];
  s.imageValue = s.imageValue + 16;
  if (s.ga[2] === 0) {
    s._hFlipBase = true;
    s.ox = -12;
    s.data[1] = 2;
  } else {
    s.ox = 12;
    s.data[1] = -2;
  }
  s.data[0] = s.ga[4];
  if (s.data[3] !== 255) s.data[3] = s.ga[2];
  s.callbackFn = H.clappingHandStep;
};

// Lua: g3_e3a.lua:441 -- pokefirered/src/battle_anim_effects_3.c:1587
C.ClappingHand = cb(H.clappingHand);

// Lua: g3_e3a.lua:444 -- pokefirered/src/battle_anim_effects_3.c:1646
C.ClappingHand2 = cb(function (s: S, vm: any): void {
  P.registerObjWindow(vm, s);
  s.data[3] = 255;
  H.clappingHand(s, vm);
});

// Lua: g3_e3a.lua:451 -- pokefirered/src/battle_anim_effects_3.c:1653
T.CreateSpotlight = task(function (t: Tk, vm: any): void {
  const w = P.win(vm);
  w.winin = 0x1F3F;
  w.win1 = seq(0, 240, 120, 160);
  P.ensureColorOverlay(vm);
  P.DestroyAnimVisualTask(t);
});

// Lua: g3_e3a.lua:460 -- pokefirered/src/battle_anim_effects_3.c:1676
T.RemoveSpotlight = task(function (t: Tk, vm: any): void {
  const w = P.win(vm);
  w.winin = 0x3F3F;
  w.win1 = null;
  P.DestroyAnimVisualTask(t);
});

// Lua: g3_e3a.lua:467
H.rapidSpinStep = function (s: S): void {
  const d = s.data;
  d[1] = band(d[1] + d[2], 0xFF);
  s.ox = P.shr(P.SINE[d[1] + 1], 4);
  s.oy = s.oy + d[3];
  if (d[0] !== 0) {
    if (s.oy < d[4]) P.DestroyAnimSprite(s);
  } else if (s.oy > d[4]) {
    P.DestroyAnimSprite(s);
  }
};

// Lua: g3_e3a.lua:480 -- pokefirered/src/battle_anim_effects_3.c:1687
C.RapidSpin = cb(function (s: S, vm: any): void {
  if (s.ga[0] === 0) {
    s.x = P.coordAtk(vm, P.COORD_X) + s.ga[1];
    s.y = P.coordAtk(vm, P.COORD_Y);
  } else {
    s.x = P.coordTgt(vm, P.COORD_X) + s.ga[1];
    s.y = P.coordTgt(vm, P.COORD_Y);
  }
  s.oy = s.ga[2];
  s.data[0] = (s.oy > s.ga[3]) ? 1 : 0;
  s.data[1] = 0;
  s.data[2] = s.ga[4];
  s.data[3] = s.ga[5];
  s.data[4] = s.ga[3];
  s.callbackFn = H.rapidSpinStep;
});

// Lua: g3_e3a.lua:497
H.rapidSpinApply = function (t: Tk): void {
  const p = P.monPresent(t._side);
  if (!p) return;
  if (P.isMonBg(t._side)) {
    const out: number[] = [];
    for (const [row, v] of pairs<number>(t._buf)) out[row as number] = -(v - t.data[8]);
    p.hShift = out;
  }
};

// Lua: g3_e3a.lua:507
H.rapidSpinElevStep = function (t: Tk, _vm: any): void {
  const d = t.data;
  d[0] = d[0] - d[5];
  if (d[0] < d[2]) d[0] = d[2];
  if (d[4] === 0) {
    d[1] = d[1] - d[5];
    if (d[1] < d[2]) {
      d[1] = d[2];
      d[15] = 1;
    }
  } else {
    d[4] = d[4] - 1;
  }
  d[6] = d[6] + 1;
  if (d[6] > 1) {
    d[6] = 0;
    d[7] = (d[7] === 0) ? 1 : 0;
    if (d[7] !== 0) d[12] = d[8]; else d[12] = d[9];
  }
  const buf = t._buf;
  for (let i = d[0]; i <= d[1] - 1; i++) buf[i] = d[12];
  for (let i = d[1]; i <= d[3]; i++) buf[i] = d[11];
  H.rapidSpinApply(t);
  if (d[15] !== 0) {
    if (d[10] !== 0) {
      const p = P.monPresent(t._side);
      if (p) p.hShift = null;
    }
    P.DestroyAnimVisualTask(t);
  }
};

// Lua: g3_e3a.lua:540 -- pokefirered/src/battle_anim_effects_3.c:1726
T.RapinSpinMonElevation = task(function (t: Tk, vm: any): void {
  const d = t.data;
  const side = (t.ga[0] === 0) ? P.atk(vm) : P.tgt(vm);
  t._side = side;
  const var0 = P.s16(P.yWithElevation(vm, side));
  d[0] = var0 + 36;
  d[1] = d[0];
  d[2] = var0 - 33;
  if (d[2] < 0) d[2] = 0;
  d[3] = d[0];
  d[4] = 8;
  d[5] = t.ga[1];
  d[6] = 0;
  d[7] = 0;
  const var3 = 0;
  const var4 = var3 + 240;
  d[8] = var3;
  d[9] = var4;
  d[10] = t.ga[2];
  let var2: number;
  if (t.ga[2] === 0) {
    d[11] = var4;
    var2 = d[8];
  } else {
    d[11] = var3;
    var2 = d[9];
  }
  d[15] = 0;
  t._buf = [] as number[];
  for (let i = d[2]; i <= d[3]; i++) t._buf[i] = var2;
  H.rapidSpinApply(t);
  t.fn = H.rapidSpinElevStep;
});

// Lua: g3_e3a.lua:574
H.tormentBubble = function (s: S): void {
  if (s.animEnded) {
    const tk = s.task;
    if (tk && tk.active) {
      const i = s.data[1];
      tk.data[i] = tk.data[i] - 1;
    }
    P.DestroyAnimSprite(s);
  }
};

// Lua: g3_e3a.lua:585
H.noop = function (): void { /* empty */ };

// Lua: g3_e3a.lua:587
H.tormentStep = function (t: Tk, vm: any): void {
  const d = t.data;
  const k = d[0];
  if (k === 0) {
    let x: number;
    if (band(d[1], 1) !== 0) x = d[2] - d[4]; else x = d[2] + d[4];
    const y = d[3] + d[5];
    const s = P.CreateSprite(vm, "gThoughtBubbleSpriteTemplate", P.s16(x), P.s16(y), 6 - d[1], H.noop);
    P.playSEPan(vm, "SE_M_METRONOME", -64);
    if (s) {
      s._hFlipBase = band(d[1], 1) !== 0;
      t._bubbles[len(t._bubbles) + 1] = s;
      P.sync(s, vm);
    }
    if (band(d[1], 1) !== 0) {
      d[4] = d[4] - 6;
      d[5] = d[5] - 6;
    }
    H.PrepareAffineAnimInTaskData(t, t._side, H.affineTable("sAffineAnims_Torment"));
    d[1] = d[1] + 1;
    d[0] = 1;
  } else if (k === 1) {
    if (!H.RunAffineAnimFromTaskData(t, vm)) {
      if (d[1] === 6) {
        d[6] = 8;
        d[0] = 3;
      } else {
        if (d[1] <= 2) d[6] = 10; else d[6] = 0;
        d[0] = 2;
      }
    }
  } else if (k === 2) {
    if (d[6] !== 0) d[6] = d[6] - 1; else d[0] = 0;
  } else if (k === 3) {
    if (d[6] !== 0) d[6] = d[6] - 1; else d[0] = 4;
  } else if (k === 4) {
    let j = 0;
    for (const [, s] of ipairs<S>(t._bubbles)) {
      if (s.active && s.template === "gThoughtBubbleSpriteTemplate") {
        s.task = t;
        s.data[0] = 0;
        s.data[1] = 6;
        P.StartSpriteAnim(s, 2);
        s.callbackFn = H.tormentBubble;
        j = j + 1;
        if (j === 6) break;
      }
    }
    d[6] = j;
    d[0] = 5;
  } else if (k === 5) {
    if (d[6] === 0) P.DestroyAnimVisualTask(t);
  }
};

// Lua: g3_e3a.lua:643 -- pokefirered/src/battle_anim_effects_3.c:1866
T.TormentAttacker = task(function (t: Tk, vm: any): void {
  const d = t.data;
  d[0] = 0;
  d[1] = 0;
  d[2] = P.coordAtk(vm, P.COORD_X_2);
  d[3] = P.coordAtk(vm, P.COORD_Y_PIC);
  d[4] = 32;
  d[5] = -20;
  d[6] = 0;
  t._side = P.atk(vm);
  t._bubbles = seq();
  t.fn = H.tormentStep;
});

// Lua: g3_e3a.lua:657
H.triAttackTriangle = function (s: S, vm: any): void {
  const d = s.data;
  if (d[0] === 0) P.InitSpritePosToAnimAttacker(s, vm, false);
  d[0] = d[0] + 1;
  if (d[0] < 40) {
    s.invisible = band(P.u16(d[0]), 1) === 0;
  }
  if (d[0] > 30) s.invisible = false;
  if (d[0] === 61) {
    P.StoreSpriteCallbackInData6(s, P.DestroyAnimSprite);
    s.x = s.x + s.ox;
    s.y = s.y + s.oy;
    s.ox = 0;
    s.oy = 0;
    d[0] = 20;
    d[2] = P.coordTgt(vm, P.COORD_X_2);
    d[4] = P.coordTgt(vm, P.COORD_Y_PIC);
    s.callbackFn = P.StartAnimLinearTranslation;
  }
};

// Lua: g3_e3a.lua:679 -- pokefirered/src/battle_anim_effects_3.c:1988
C.TriAttackTriangle = cb(H.triAttackTriangle);

// Lua: g3_e3a.lua:682 -- pokefirered/src/battle_anim_effects_3.c:2019
T.DefenseCurlDeformMon = H.deformTask("DefenseCurlDeformMonAffineAnimCmds");

// Lua: g3_e3a.lua:684
H.batonPass = function (s: S, vm: any): void {
  const d = s.data;
  const side = P.atk(vm);
  const p = P.monPresent(side);
  const k = d[0];
  if (k === 0) {
    s.x = P.coordAtk(vm, P.COORD_X_2);
    s.y = P.coordAtk(vm, P.COORD_Y_PIC);
    d[1] = 256;
    d[2] = 256;
    d[0] = d[0] + 1;
  } else if (k === 1 || k === 2) {
    if (k === 1) {
      d[1] = P.s16(d[1] + 96);
      d[2] = P.s16(d[2] - 26);
      P.monRotScale(p, d[1], d[2], 0);
      d[3] = d[3] + 1;
      if (d[3] === 5) d[0] = d[0] + 1;
    }
    d[1] = P.s16(d[1] + 96);
    d[2] = P.s16(d[2] + 48);
    P.monRotScale(p, d[1], d[2], 0);
    d[3] = d[3] + 1;
    if (d[3] === 9) {
      d[3] = 0;
      if (p) p.visible = false;
      P.monResetRotScale(p);
      d[0] = d[0] + 1;
    }
  } else if (k === 3) {
    s.oy = s.oy - 6;
    if (s.y + s.oy < -32) P.DestroyAnimSprite(s);
  }
};

// Lua: g3_e3a.lua:720 -- pokefirered/src/battle_anim_effects_3.c:2034
C.BatonPassPokeball = cb(H.batonPass);

// Lua: g3_e3a.lua:722
H.miniStarStep = function (s: S): void {
  const d = s.data;
  d[0] = d[0] + 1;
  if (d[0] < 30) {
    d[1] = d[1] + 1;
    if (d[1] === 2) {
      s.invisible = !truthy(s.invisible);
      d[1] = 0;
    }
  } else {
    if (d[1] === 2) s.invisible = false;
    if (d[1] === 3) {
      s.invisible = true;
      d[1] = -1;
    }
    d[1] = d[1] + 1;
  }
  if (d[0] > 60) P.DestroyAnimSprite(s);
};

// Lua: g3_e3a.lua:742
H.miniStar = function (s: S): void {
  const rand = band(P.Random(), 3);
  if (rand === 0) {
    s.imageValue = s.imageValue + 4;
  } else {
    s.imageValue = s.imageValue + 5;
  }
  let y = P.s8(band(P.Random(), 7));
  if (y > 3) y = -y;
  s.oy = y;
  s.callbackFn = H.miniStarStep;
};

// Lua: g3_e3a.lua:755
H.wishStarStep = function (s: S, vm: any): void {
  const d = s.data;
  d[0] = P.s16(d[0] + 72);
  if (!P.atkIsPlayer(vm)) {
    s.ox = P.shr(d[0], 4);
  } else {
    s.ox = -P.shr(d[0], 4);
  }
  d[1] = P.s16(d[1] + 16);
  s.oy = s.oy + P.shr(d[1], 8);
  d[2] = d[2] + 1;
  if (P.mod(d[2], 3) === 0) {
    // pokefirered/src/battle_anim_special.c:2150-2163
    P.CreateSprite(vm, "gMiniTwinklingStarSpriteTemplate", s.x + s.ox, s.y + s.oy,
      s.sub + 1, H.miniStar, { animate: true, counted: true });
  }
  const newX = s.x + s.ox + 32;
  if (newX < 0 || newX > 240 + 64) P.DestroyAnimSprite(s);
};

// Lua: g3_e3a.lua:776 -- pokefirered/src/battle_anim_effects_3.c:2077
C.WishStar = cb(function (s: S, vm: any): void {
  if (!P.atkIsPlayer(vm)) {
    s.x = -16;
  } else {
    s.x = 240 + 16;
  }
  s.y = 0;
  s.callbackFn = H.wishStarStep;
});

// Lua: g3_e3a.lua:787 -- pokefirered/src/battle_anim_effects_3.c:2162
T.StockpileDeformMon = H.deformTask("sStockpileDeformMonAffineAnimCmds");

// Lua: g3_e3a.lua:790 -- pokefirered/src/battle_anim_effects_3.c:2176
T.SpitUpDeformMon = H.deformTask("sSpitUpDeformMonAffineAnimCmds");

// Lua: g3_e3a.lua:793 -- pokefirered/src/battle_anim_effects_3.c:2190
C.SwallowBlueOrb = cb(function (s: S, vm: any): void {
  const d = s.data;
  if (d[0] === 0) {
    P.InitSpritePosToAnimAttacker(s, vm, false);
    d[1] = 0x900;
    d[2] = P.coordAtk(vm, P.COORD_Y_PIC);
    d[0] = d[0] + 1;
  } else if (d[0] === 1) {
    s.oy = s.oy - P.shr(d[1], 8);
    d[1] = P.s16(d[1] - 96);
    if (s.y + s.oy > d[2]) P.DestroyAnimSprite(s);
  }
});

// Lua: g3_e3a.lua:808 -- pokefirered/src/battle_anim_effects_3.c:2209
T.SwallowDeformMon = H.deformTask("sSwallowDeformMonAffineAnimCmds");

// Lua: g3_e3a.lua:812 -- pokefirered/src/battle_gfx_sfx_util.c:653
H.HandleSpeciesGfxDataChange = function (vm: any, transformType: unknown): void {
  const p = P.monPresent(P.atk(vm));
  const kind = P.u8(tonumber(transformType) ?? (truthy(transformType) ? 1 : 0));
  if (kind === 255) {
    if (p) p.ghostUnveiled = true;
    return;
  }
  if (kind !== 0) {
    if (p) {
      p.castformForm = tonumber(vm ? vm.animArg : null) ?? 0;
      p.pendingCastform = null;
    }
    return;
  }
  const tsp = P.species(vm, P.tgt(vm));
  if (tsp == null) return;
  vm._speciesBySide = vm._speciesBySide ?? {};
  vm._speciesBySide[P.atk(vm)] = tsp;
  if (p) {
    const tp = P.monPresent(P.tgt(vm));
    p.transformSpecies = tsp;
    p.pendingTransform = null;
    p.castformForm = (tp && truthy(tp.castformForm)) ? tp.castformForm : null;
    p.castformMon = null;
  }
};

// Lua: g3_e3a.lua:839
H.transformStep = function (t: Tk, vm: any): void {
  const d = t.data;
  const k = d[0];
  if (k === 0) {
    t._mosaic = 0;
    d[10] = t.ga[0];
    d[0] = d[0] + 1;
  } else if (k === 1) {
    const r = d[2];
    d[2] = d[2] + 1;
    if (r > 1) {
      d[2] = 0;
      d[1] = d[1] + 1;
      t._mosaic = d[1];
      const p = P.monPresent(P.atk(vm));
      if (p) p.mosaic = d[1];
      if (d[1] === 15) d[0] = d[0] + 1;
    }
  } else if (k === 2) {
    H.HandleSpeciesGfxDataChange(vm, d[10]);
    d[0] = d[0] + 1;
  } else if (k === 3) {
    const r = d[2];
    d[2] = d[2] + 1;
    if (r > 1) {
      d[2] = 0;
      d[1] = d[1] - 1;
      t._mosaic = d[1];
      const p = P.monPresent(P.atk(vm));
      if (p) p.mosaic = d[1];
      if (d[1] === 0) d[0] = d[0] + 1;
    }
  } else if (k === 4) {
    t._mosaic = 0;
    const p = P.monPresent(P.atk(vm));
    if (p) p.mosaic = null;
    P.DestroyAnimVisualTask(t);
  }
};

// Lua: g3_e3a.lua:880 -- pokefirered/src/battle_anim_effects_3.c:2223
T.TransformMon = task(H.transformStep);

// Lua: g3_e3a.lua:883 -- pokefirered/src/battle_anim_effects_3.c:2303
T.IsMonInvisible = task(function (t: Tk, vm: any): void {
  const p = P.monPresent(P.atk(vm));
  if (p && p.visible === false) P.setRet(vm, 1); else P.setRet(vm, 0);
  P.DestroyAnimVisualTask(t);
});

// Lua: g3_e3a.lua:890 -- pokefirered/src/battle_anim_effects_3.c:2309
T.CastformGfxChange = task(function (t: Tk, vm: any): void {
  H.HandleSpeciesGfxDataChange(vm, 1);
  P.DestroyAnimVisualTask(t);
});

// Lua: g3_e3a.lua:895 -- { [0] = -24, 24, -4, 0 }
H.MORNING_SUN_COORDS = [-24, 24, -4, 0];

// Lua: g3_e3a.lua:897
H.morningSunStep = function (t: Tk, vm: any): void {
  const d = t.data;
  const k = d[0];
  if (k === 0) {
    P.setBld(vm, 0, 16);
    P.bg1Layer(t, vm, "MORNING_SUN", 1);
    if (!P.atkIsPlayer(vm)) t._bg1x = -135; else t._bg1x = -10;
    t._bg1y = 0;
    d[10] = t._bg1x;
    d[11] = t._bg1y;
    d[0] = d[0] + 1;
    P.playSEPan(vm, "SE_M_MORNING_SUN", -64);
  } else if (k === 1) {
    const r = d[4];
    d[4] = d[4] + 1;
    if (r > 0) {
      d[4] = 0;
      d[1] = d[1] + 1;
      if (d[1] > 12) d[1] = 12;
      P.setBld(vm, d[1], 16 - d[1]);
      if (d[1] === 12) d[0] = d[0] + 1;
    }
  } else if (k === 2) {
    d[1] = d[1] - 1;
    if (d[1] < 0) d[1] = 0;
    P.setBld(vm, d[1], 16 - d[1]);
    if (d[1] === 0) {
      t._bg1x = H.MORNING_SUN_COORDS[d[2]] + d[10];
      d[2] = d[2] + 1;
      if (d[2] === 4) d[0] = 4; else d[0] = 3;
    }
  } else if (k === 3) {
    d[3] = d[3] + 1;
    if (d[3] === 4) {
      d[3] = 0;
      d[0] = 1;
      P.playSEPan(vm, "SE_M_MORNING_SUN", -64);
    }
  } else if (k === 4) {
    P.bg1Clear(t);
    t._bg1x = 0;
    t._bg1y = 0;
    P.setBld(vm, null);
    P.DestroyAnimVisualTask(t);
  }
};

// Lua: g3_e3a.lua:945 -- pokefirered/src/battle_anim_effects_3.c:2315
T.MorningSunLightBeam = task(H.morningSunStep);

// Lua: g3_e3a.lua:947
export const G3E3a = { callbacks: C, tasks: T };
export default G3E3a;
