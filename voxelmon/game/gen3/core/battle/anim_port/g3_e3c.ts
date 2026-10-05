// Port of gen1recomp src/core/game3/battle/anim_port/g3_e3c.lua (GPLv3 + additional terms; see LICENSE.md).
// battle_anim_effects_3.c, part C: roar, glare, assist, barrage, smelling salts,
// helping hand, foresight, meteor mash, substitute, block, odor sleuth, return,
// snatch, teeter dance, knock off, recycle, weather, slack off.

import { tonumber } from "../../../../../import/gen3/lua.ts";
import { Pokemon } from "../../pokemon.ts";
import { AnimCoords } from "../anim_coords.ts";
import { PicCoords } from "../pic_coords.ts";
import { Ui } from "../ui.ts";
import { Rules } from "../rules.ts";
import { Battle } from "../init.ts";
import { P } from "./g3_pret.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type S = Record<string, any>;
type Task = Record<string, any>;

const C: Record<string, any> = {};
const T: Record<string, any> = {};
const H: Record<string, any> = {};
// local band = P.band: JS & (no top-level read of an import).

const DISPLAY_WIDTH = 240;

// P.cb(fn) / P.task(fn) at require time: the wrap is made on first call instead
// (no top-level call into an import inside the import cycle). P.cb / P.task
// return stateless closures over fn, so this is the same function.
function cbOf(entry: (s: S, vm: any) => void): (s: S) => void {
  let w: ((s: S) => void) | null = null;
  return (s: S) => (w ??= P.cb(entry))(s);
}
function taskOf(entry: (t: Task, vm: any) => void): (t: Task, vm: any) => void {
  let w: ((t: Task, vm: any) => void) | null = null;
  return (t: Task, vm: any) => (w ??= P.task(entry))(t, vm);
}

// Lua: g3_e3c.lua:9
H.sine = function (i: number): number {
  return P.SINE[(((Math.floor(i) % 256) + 256) % 256) + 1];
};

// Lua: g3_e3c.lua:13
H.bgPriority = function (vm: any, side: any): number {
  const bp = vm ? vm._bgPrio : null;
  // require("src.core.game3.battle.anim_coords").bgPriorityRank(side)
  return (bp ? bp[AnimCoords.bgPriorityRank(side)] : null) ?? 2;
};

// Lua: g3_e3c.lua:18
H.monX = function (vm: any, side: any): number {
  return P.coord(vm, side, P.COORD_X);
};

// Lua: g3_e3c.lua:22
H.monY = function (vm: any, side: any): number {
  return P.coord(vm, side, P.COORD_Y_PIC_DEF);
};

// Lua: g3_e3c.lua:26
H.battleSt = function (): any {
  // package.loaded["src.core.game3.battle"] or package.loaded["src.core.game3.battle.init"]
  const B: any = Battle;
  return B ? B._st : null;
};

// Lua: g3_e3c.lua:31
H.prepAffine = function (t: Task, side: any, cmds: any): void {
  const d = t.data;
  d[7] = 0; d[8] = 0; d[9] = 0;
  d[10] = 0x100; d[11] = 0x100; d[12] = 0;
  t._aSide = side;
  t._aP = side != null ? P.monPresent(side) : null;
  t._aCmds = cmds ?? {};
};

// Lua: g3_e3c.lua:40
H.runAffine = function (t: Task, vm: any): boolean {
  const d = t.data;
  const cmds = t._aCmds;
  const p = t._aP;
  let c = cmds[d[7] + 1];
  if (c == null || c.e) {
    if (p) {
      p.oy = 0;
      P.monResetRotScale(p);
    }
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
        const prev = cmds[d[7] + 1];
        if (prev && prev.l != null) {
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
      d[12] = c.r ?? 0;
      d[7] = d[7] + 1;
      c = cmds[d[7] + 1] ?? {};
    }
    d[10] = P.s16(d[10] + (c.x ?? 0));
    d[11] = P.s16(d[11] + (c.y ?? 0));
    d[12] = P.s16(d[12] + (c.r ?? 0));
    if (p) {
      P.monRotScale(p, d[10], d[11], P.u16(d[12]));
      P.monYOffsetFromYScale(vm, t._aSide);
    }
    d[8] = d[8] + 1;
    if (d[8] >= (c.d ?? 0)) {
      d[8] = 0;
      d[7] = d[7] + 1;
    }
  }
  return true;
};

// Lua: g3_e3c.lua:100
H.roarStep = function (s: S): void {
  const d = s.data;
  d[6] = P.s16(d[6] + d[0]);
  d[7] = P.s16(d[7] + d[1]);
  s.ox = P.shr(d[6], 8);
  s.oy = P.shr(d[7], 8);
  d[5] = d[5] + 1;
  if (d[5] === 14) P.DestroyAnimSprite(s);
};

// Lua: g3_e3c.lua:111 -- pokefirered/src/battle_anim_effects_3.c:3839
C.RoarNoiseLine = cbOf(function (s: S, vm: any): void {
  const d = s.data;
  if (!P.atkIsPlayer(vm)) s.ga[0] = -s.ga[0];
  s.x = P.coordAtk(vm, P.COORD_X) + s.ga[0];
  s.y = P.coordAtk(vm, P.COORD_Y) + s.ga[1];
  if (s.ga[2] === 0) {
    d[0] = 0x280;
    d[1] = -0x280;
  } else if (s.ga[2] === 1) {
    s._vFlipBase = true;
    d[0] = 0x280;
    d[1] = 0x280;
  } else {
    P.StartSpriteAnim(s, 1);
    d[0] = 0x280;
  }
  if (!P.atkIsPlayer(vm)) {
    d[0] = -d[0];
    s._hFlipBase = true;
  }
  s.callbackFn = H.roarStep;
});

// Lua: g3_e3c.lua:134 (returns [x, y])
H.glareDotCoords = function (startX: number, startY: number, endX: number, endY: number, pairMax: number, pairNum: number): [number, number] {
  if (pairNum === 0) return [startX, startY];
  if (pairNum >= pairMax) return [endX, endY];
  pairMax = pairMax - 1;
  const x2 = startX * 256 + pairNum * P.div((endX - startX) * 256, pairMax);
  const y2 = startY * 256 + pairNum * P.div((endY - startY) * 256, pairMax);
  return [P.s16(P.shr(x2, 8)), P.s16(P.shr(y2, 8))];
};

// Lua: g3_e3c.lua:143
H.glareDotStep = function (s: S): void {
  s.data[0] = s.data[0] + 1;
  if (s.data[0] > 36) {
    if (s.task) {
      const idx = s._activeIdx ?? 10;
      s.task.data[idx] = s.task.data[idx] - 1;
    }
    P.DestroyAnimSprite(s);
  }
};

// Lua: g3_e3c.lua:155 -- pokefirered/src/battle_anim_effects_3.c:4020
C.GlareEyeDot = cbOf(H.glareDotStep);

// Lua: g3_e3c.lua:157
H.glareStep = function (t: Task, vm: any): void {
  const d = t.data;
  if (d[0] === 0) {
    d[1] = d[1] + 1;
    if (d[1] > 3) {
      d[1] = 0;
      const [x, y] = H.glareDotCoords(d[11], d[12], d[13], d[14], P.u8(d[5]), P.u8(d[2]));
      for (let i = 0; i <= 1; i++) {
        const s = P.CreateSprite(vm, "gGlareEyeDotSpriteTemplate", x, y, 35, H.glareDotStep);
        if (s) {
          if (d[7] === 0) {
            if (i === 0) {
              s.ox = -d[6]; s.oy = -d[6];
            } else {
              s.ox = d[6]; s.oy = d[6];
            }
          } else {
            if (i === 0) {
              s.ox = -d[6]; s.oy = d[6];
            } else {
              s.ox = d[6]; s.oy = -d[6];
            }
          }
          s.data[0] = 0;
          s.task = t;
          s._activeIdx = 10;
          d[10] = d[10] + 1;
        }
      }
      if (d[2] === d[5]) d[0] = d[0] + 1;
      d[2] = d[2] + 1;
    }
  } else if (d[0] === 1) {
    if (d[10] === 0) P.DestroyAnimVisualTask(t);
  }
};

// Lua: g3_e3c.lua:195 -- pokefirered/src/battle_anim_effects_3.c:3904
T.GlareEyeDots = taskOf(function (t: Task, vm: any): void {
  const d = t.data;
  const atk = P.atk(vm), tgt = P.tgt(vm);
  d[5] = 12;
  d[6] = 3;
  d[7] = 0;
  const q = P.div(P.coordAttr(vm, atk, P.ATTR_HEIGHT), 4);
  if (P.atkIsPlayer(vm)) {
    d[11] = P.coord(vm, atk, P.COORD_X_2) + q;
  } else {
    d[11] = P.coord(vm, atk, P.COORD_X_2) - q;
  }
  d[12] = P.coord(vm, atk, P.COORD_Y_PIC) - q;
  d[13] = P.coord(vm, tgt, P.COORD_X_2);
  d[14] = P.coord(vm, tgt, P.COORD_Y_PIC);
  t.fn = H.glareStep;
});

// Lua: g3_e3c.lua:214 -- pokefirered/src/battle_anim_effects_3.c:4051
C.AssistPawprint = cbOf(function (s: S, _vm: any): void {
  s.x = s.ga[0];
  s.y = s.ga[1];
  s.data[2] = s.ga[2];
  s.data[4] = s.ga[3];
  s.data[0] = s.ga[4];
  P.StoreSpriteCallbackInData6(s, P.DestroyAnimSprite);
  s.callbackFn = P.InitAndRunAnimFastLinearTranslation;
});

// Lua: g3_e3c.lua:224
H.barrageStep = function (t: Task, _vm: any): void {
  const d = t.data;
  const s = t._ball;
  if (d[0] === 0) {
    d[1] = d[1] + 1;
    if (d[1] > 1) {
      d[1] = 0;
      if (s && s.active) P.TranslateAnimHorizontalArc(s);
      d[2] = d[2] + 1;
      if (d[2] > 7) d[0] = d[0] + 1;
    }
  } else if (d[0] === 1) {
    if (!(s && s.active) || P.TranslateAnimHorizontalArc(s)) {
      d[1] = 0;
      d[2] = 0;
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 2) {
    d[1] = d[1] + 1;
    if (d[1] > 1) {
      d[1] = 0;
      d[2] = d[2] + 1;
      if (s && s.active) s.invisible = (d[2] & 1) !== 0;
      if (d[2] === 16) {
        if (s && s.active) P.DestroyAnimSprite(s);
        t._ball = null;
        d[0] = d[0] + 1;
      }
    }
  } else if (d[0] === 3) {
    P.DestroyAnimVisualTask(t);
  }
};

// Lua: g3_e3c.lua:259 -- pokefirered/src/battle_anim_effects_3.c:4064
T.BarrageBall = taskOf(function (t: Task, vm: any): void {
  const d = t.data;
  const atk = P.atk(vm), tgt = P.tgt(vm);
  d[11] = P.coord(vm, atk, P.COORD_X_2);
  d[12] = P.coord(vm, atk, P.COORD_Y_PIC);
  d[13] = P.coord(vm, tgt, P.COORD_X_2);
  d[14] = P.coord(vm, tgt, P.COORD_Y_PIC) + P.div(P.coordAttr(vm, tgt, P.ATTR_HEIGHT), 4);
  const s = P.CreateSprite(vm, "gBarrageBallSpriteTemplate", d[11], d[12], P.subpriorityOf(tgt) - 5, function (): void {});
  if (s) {
    t._ball = s;
    s.data[0] = 16;
    s.data[2] = d[13];
    s.data[4] = d[14];
    s.data[5] = -32;
    P.InitAnimArcTranslation(s);
    if (!P.atkIsPlayer(vm)) P.StartSpriteAffineAnim(s, 1);
    t.fn = H.barrageStep;
  } else {
    P.DestroyAnimVisualTask(t);
  }
});

// Lua: g3_e3c.lua:281
H.saltsHandStep = function (s: S): void {
  const d = s.data;
  if (d[0] === 0) {
    d[1] = d[1] + 1;
    if (d[1] > 1) {
      d[1] = 0;
      s.ox = s.ox + d[7];
      d[2] = d[2] + 1;
      if (d[2] === 12) d[0] = d[0] + 1;
    }
  } else if (d[0] === 1) {
    d[1] = d[1] + 1;
    if (d[1] === 8) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 2) {
    s.ox = s.ox - d[7] * 4;
    d[1] = d[1] + 1;
    if (d[1] === 6) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 3) {
    s.ox = s.ox + d[7] * 3;
    d[1] = d[1] + 1;
    if (d[1] === 8) {
      d[6] = d[6] - 1;
      if (d[6] !== 0) {
        d[1] = 0;
        d[0] = d[0] - 1;
      } else {
        P.DestroyAnimSprite(s);
      }
    }
  }
};

// Lua: g3_e3c.lua:320 -- pokefirered/src/battle_anim_effects_3.c:4138
C.SmellingSaltsHand = cbOf(function (s: S, vm: any): void {
  const side = (s.ga[0] === P.ANIM_ATTACKER) ? P.atk(vm) : P.tgt(vm);
  s.imageValue = s.imageValue + 16;
  s.data[6] = s.ga[2];
  s.data[7] = (s.ga[1] === 0) ? -1 : 1;
  s.y = P.coord(vm, side, P.COORD_Y_PIC);
  if (s.ga[1] === 0) {
    s._hFlipBase = true;
    s.x = P.coordAttr(vm, side, P.ATTR_LEFT) - 8;
  } else {
    s.x = P.coordAttr(vm, side, P.ATTR_RIGHT) + 8;
  }
  s.callbackFn = H.saltsHandStep;
});

// Lua: g3_e3c.lua:335
H.saltsSquishStep = function (t: Task, vm: any): void {
  const d = t.data;
  const p = t._aP;
  d[1] = d[1] + 1;
  if (d[1] > 1) {
    d[1] = 0;
    if (p) {
      if ((d[2] & 1) === 0) p.ox = 2; else p.ox = -2;
    }
  }
  if (!H.runAffine(t, vm)) {
    if (p) p.ox = 0;
    d[0] = d[0] - 1;
    if (d[0] !== 0) {
      H.prepAffine(t, t._aSide, P.data().affine.sSmellingSaltsSquishAffineAnimCmds);
      d[1] = 0;
      d[2] = 0;
    } else {
      P.DestroyAnimVisualTask(t);
    }
  }
};

// Lua: g3_e3c.lua:359 -- pokefirered/src/battle_anim_effects_3.c:4213
T.SmellingSaltsSquish = taskOf(function (t: Task, vm: any): void {
  if (t.ga[0] === P.ANIM_ATTACKER) {
    P.DestroyAnimVisualTask(t);
    return;
  }
  t.data[0] = t.ga[1];
  H.prepAffine(t, P.side(vm, t.ga[0]), P.data().affine.sSmellingSaltsSquishAffineAnimCmds);
  t.fn = H.saltsSquishStep;
});

// Lua: g3_e3c.lua:369
H.exclamationStep = function (s: S): void {
  const d = s.data;
  d[0] = d[0] + 1;
  if (d[0] >= d[1]) {
    d[0] = 0;
    d[2] = (d[2] + 1) & 1;
    s.invisible = d[2] !== 0;
    if (d[2] !== 0) {
      d[3] = d[3] - 1;
      if (d[3] === 0) P.DestroyAnimSprite(s);
    }
  }
};

// Lua: g3_e3c.lua:384 -- pokefirered/src/battle_anim_effects_3.c:4261
C.SmellingSaltExclamation = cbOf(function (s: S, vm: any): void {
  const side = (s.ga[0] === P.ANIM_ATTACKER) ? P.atk(vm) : P.tgt(vm);
  s.x = P.coord(vm, side, P.COORD_X_2);
  s.y = P.coordAttr(vm, side, P.ATTR_TOP);
  if (s.y < 8) s.y = 8;
  s.data[0] = 0;
  s.data[1] = s.ga[1];
  s.data[2] = 0;
  s.data[3] = s.ga[2];
  s.callbackFn = H.exclamationStep;
});

// Lua: g3_e3c.lua:396
H.clapStep = function (s: S): void {
  const d = s.data;
  const k = d[0];
  if (k === 0) {
    s.y = s.y - d[7] * 2;
    if ((d[1] & 1) !== 0) s.x = s.x - d[7] * 2;
    d[1] = d[1] + 1;
    if (d[1] === 9) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 1) {
    d[1] = d[1] + 1;
    if (d[1] === 4) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 2) {
    d[1] = d[1] + 1;
    s.y = s.y + d[7] * 3;
    s.ox = d[7] * P.shr(H.sine(d[1] * 10), 3);
    if (d[1] === 12) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 3) {
    d[1] = d[1] + 1;
    if (d[1] === 2) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 4) {
    d[1] = d[1] + 1;
    s.y = s.y - d[7] * 3;
    s.ox = d[7] * P.shr(H.sine(d[1] * 10), 3);
    if (d[1] === 12) d[0] = d[0] + 1;
  } else if (k === 5) {
    d[1] = d[1] + 1;
    s.y = s.y + d[7] * 3;
    s.ox = d[7] * P.shr(H.sine(d[1] * 10), 3);
    if (d[1] === 15) s.imageValue = s.imageValue + 16;
    if (d[1] === 18) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 6) {
    s.x = s.x + d[7] * 6;
    d[1] = d[1] + 1;
    if (d[1] === 9) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 7) {
    s.x = s.x + d[7] * 2;
    d[1] = d[1] + 1;
    if (d[1] === 1) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 8) {
    s.x = s.x - d[7] * 3;
    d[1] = d[1] + 1;
    if (d[1] === 5) P.DestroyAnimSprite(s);
  }
};

// Lua: g3_e3c.lua:463 -- pokefirered/src/battle_anim_effects_3.c:4299
C.HelpingHandClap = cbOf(function (s: S): void {
  if (s.ga[0] === 0) {
    s._hFlipBase = true;
    s.x = 100;
    s.data[7] = 1;
  } else {
    s.x = 140;
    s.data[7] = -1;
  }
  s.y = 56;
  s.callbackFn = H.clapStep;
});

// Lua: g3_e3c.lua:476
H.helpingHandStep = function (t: Task, _vm: any): void {
  const d = t.data;
  const p = t._p;
  const k = d[0];
  const addX = (v: number): void => { if (p) p.ox = p.ox + v; };
  if (k === 0) {
    d[1] = d[1] + 1;
    if (d[1] === 13) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 1) {
    addX(-d[14] * 3);
    d[1] = d[1] + 1;
    if (d[1] === 6) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 2) {
    addX(d[14] * 3);
    d[1] = d[1] + 1;
    if (d[1] === 6) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 3) {
    d[1] = d[1] + 1;
    if (d[1] === 2) {
      d[1] = 0;
      if (d[2] === 0) {
        d[2] = d[2] + 1;
        d[0] = 1;
      } else {
        d[0] = d[0] + 1;
      }
    }
  } else if (k === 4) {
    addX(d[14]);
    d[1] = d[1] + 1;
    if (d[1] === 3) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 5) {
    d[1] = d[1] + 1;
    if (d[1] === 6) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 6) {
    addX(-d[14] * 4);
    d[1] = d[1] + 1;
    if (d[1] === 5) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 7) {
    addX(d[14] * 4);
    d[1] = d[1] + 1;
    if (d[1] === 5) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 8) {
    if (p) p.ox = 0;
    P.DestroyAnimVisualTask(t);
  }
};

// Lua: g3_e3c.lua:546 -- pokefirered/src/battle_anim_effects_3.c:4402
T.HelpingHandAttackerMovement = taskOf(function (t: Task, vm: any): void {
  t._p = P.monPresent(P.atk(vm));
  if (P.atkIsPlayer(vm)) t.data[14] = -1; else t.data[14] = 1;
  t.fn = H.helpingHandStep;
});

// Lua: g3_e3c.lua:552
H.foresightStep = function (s: S, vm: any): void {
  const d = s.data;
  const side = s._battler;
  if (d[5] === 0) {
    let x: number, y: number;
    let k = d[6];
    if (k < 0 || k > 5) {
      d[6] = 0;
      k = 0;
    }
    if (k === 0 || k === 4) {
      x = P.coordAttr(vm, side, P.ATTR_RIGHT) - 4;
      y = P.coordAttr(vm, side, P.ATTR_BOTTOM) - 4;
    } else if (k === 1) {
      x = P.coordAttr(vm, side, P.ATTR_RIGHT) - 4;
      y = P.coordAttr(vm, side, P.ATTR_TOP) + 4;
    } else if (k === 2) {
      x = P.coordAttr(vm, side, P.ATTR_LEFT) + 4;
      y = P.coordAttr(vm, side, P.ATTR_BOTTOM) - 4;
    } else if (k === 3) {
      x = P.coordAttr(vm, side, P.ATTR_LEFT) + 4;
      y = P.coordAttr(vm, side, P.ATTR_TOP) - 4;
    } else {
      x = P.coord(vm, side, P.COORD_X_2);
      y = P.coord(vm, side, P.COORD_Y_PIC);
    }
    x = P.s16(P.u16(x));
    y = P.s16(P.u16(y));
    if (d[6] === 4) {
      d[0] = 24;
    } else if (d[6] === 5) {
      d[0] = 6;
    } else {
      d[0] = 12;
    }
    d[1] = s.x;
    d[2] = x;
    d[3] = s.y;
    d[4] = y;
    P.InitAnimLinearTranslation(s);
    d[5] = d[5] + 1;
  } else if (d[5] === 1) {
    if (P.AnimTranslateLinear(s)) {
      if (d[6] === 4) {
        s.x = s.x + s.ox;
        s.y = s.y + s.oy;
        s.oy = 0;
        s.ox = 0;
        d[5] = 0;
        d[6] = d[6] + 1;
      } else if (d[6] === 5) {
        d[0] = 0;
        d[1] = 16;
        d[2] = 0;
        d[5] = 3;
      } else {
        s.x = s.x + s.ox;
        s.y = s.y + s.oy;
        s.oy = 0;
        s.ox = 0;
        d[0] = 0;
        d[5] = d[5] + 1;
        d[6] = d[6] + 1;
      }
    }
  } else if (d[5] === 2) {
    d[0] = d[0] + 1;
    if (d[0] === 4) d[5] = 0;
  } else if (d[5] === 3) {
    if ((d[0] & 1) === 0) {
      d[1] = d[1] - 1;
    } else {
      d[2] = d[2] + 1;
    }
    P.setBld(vm, d[1], d[2]);
    d[0] = d[0] + 1;
    if (d[0] === 32) {
      s.invisible = true;
      d[5] = d[5] + 1;
    }
  } else if (d[5] === 4) {
    P.DestroyAnimSprite(s);
  }
};

// Lua: g3_e3c.lua:638 -- pokefirered/src/battle_anim_effects_3.c:4511
C.ForesightMagnifyingGlass = cbOf(function (s: S, vm: any): void {
  if (s.ga[0] === P.ANIM_ATTACKER) {
    P.InitSpritePosToAnimAttacker(s, vm, true);
    s._battler = P.atk(vm);
  } else {
    s._battler = P.tgt(vm);
  }
  if (s._battler !== "player") s._hFlipBase = true;
  s.pri = H.bgPriority(vm, s._battler);
  s._objBlend = true;
  s.callbackFn = H.foresightStep;
});

// Lua: g3_e3c.lua:651
H.miniStarStep = function (s: S): void {
  const d = s.data;
  d[0] = d[0] + 1;
  if (d[0] < 30) {
    d[1] = d[1] + 1;
    if (d[1] === 2) {
      s.invisible = !s.invisible;
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

// Lua: g3_e3c.lua:671
H.miniStar = function (s: S): void {
  const rand = P.Random() & 3;
  if (rand === 0) {
    s.imageValue = s.imageValue + 4;
  } else {
    s.imageValue = s.imageValue + 5;
  }
  let y = P.Random() & 7;
  if (y > 3) y = -y;
  s.oy = y;
  s.callbackFn = H.miniStarStep;
};

// Lua: g3_e3c.lua:684
H.meteorStep = function (s: S, vm: any): void {
  const d = s.data;
  s.ox = P.div((d[2] - d[0]) * d[5], d[4]);
  s.oy = P.div((d[3] - d[1]) * d[5], d[4]);
  if ((d[5] & 1) === 0) {
    P.CreateSprite(vm, "gMiniTwinklingStarSpriteTemplate", s.x + s.ox, s.y + s.oy, 5, H.miniStar);
  }
  if (d[5] === d[4]) {
    P.DestroyAnimSprite(s);
    return;
  }
  d[5] = d[5] + 1;
};

// Lua: g3_e3c.lua:699 -- pokefirered/src/battle_anim_effects_3.c:4657
C.MeteorMashStar = cbOf(function (s: S, vm: any): void {
  const d = s.data;
  if (P.tgtIsPlayer(vm)) {
    d[0] = s.x - s.ga[0];
    d[2] = s.x - s.ga[2];
  } else {
    d[0] = s.x + s.ga[0];
    d[2] = s.x + s.ga[2];
  }
  d[1] = s.y + s.ga[1];
  d[3] = s.y + s.ga[3];
  d[4] = s.ga[4];
  s.x = d[0];
  s.y = d[1];
  s.callbackFn = H.meteorStep;
});

// Lua: g3_e3c.lua:716
H.subDollStep = function (t: Task, vm: any): void {
  const d = t.data;
  const p = t._p;
  if (!p) {
    P.DestroyAnimVisualTask(t);
    return;
  }
  const k = d[0];
  if (k === 0) {
    p.oy = -200;
    p.ox = 200;
    p.visible = true;
    d[10] = 0;
    d[0] = d[0] + 1;
  } else if (k === 1) {
    d[10] = P.s16(d[10] + 112);
    p.oy = P.s16(p.oy + P.shr(d[10], 8));
    if (t._y + p.oy >= -32) p.ox = 0;
    if (p.oy > 0) p.oy = 0;
    if (p.oy === 0) {
      P.playSEPan(vm, "SE_M_BUBBLE2", -64);
      d[10] = P.s16(d[10] - 0x800);
      d[0] = d[0] + 1;
    }
  } else if (k === 2) {
    d[10] = P.s16(d[10] - 112);
    if (d[10] < 0) d[10] = 0;
    p.oy = P.s16(p.oy - P.shr(d[10], 8));
    if (d[10] === 0) d[0] = d[0] + 1;
  } else if (k === 3) {
    d[10] = P.s16(d[10] + 112);
    p.oy = P.s16(p.oy + P.shr(d[10], 8));
    if (p.oy > 0) p.oy = 0;
    if (p.oy === 0) {
      P.playSEPan(vm, "SE_M_BUBBLE2", -64);
      P.DestroyAnimVisualTask(t);
    }
  }
};

// Lua: g3_e3c.lua:757 -- pokefirered/src/battle_anim_effects_3.c:4681
T.MonToSubstitute = taskOf(function (t: Task, vm: any): void {
  const d = t.data;
  const side = P.atk(vm);
  const p = P.monPresent(side);
  t._p = p;
  if (d[0] === 0) {
    d[1] = 0x100;
    d[2] = 0x100;
    d[0] = d[0] + 1;
  } else if (d[0] === 1) {
    d[1] = P.s16(d[1] + 0x60);
    d[2] = P.s16(d[2] - 0xD);
    P.monRotScale(p, d[1], d[2], 0);
    d[3] = d[3] + 1;
    if (d[3] === 9) {
      d[3] = 0;
      P.monResetRotScale(p);
      if (p) p.visible = false;
      d[0] = d[0] + 1;
    }
  } else {
    const A = P.Anim();
    if (A.setSubstitute) A.setSubstitute(side, true);
    for (let i = 0; i <= 15; i++) d[i] = 0;
    t._y = (A.substituteY ? A.substituteY(side) : null) ?? H.monY(vm, side);
    t.fn = H.subDollStep;
  }
});

// Lua: g3_e3c.lua:786
H.blockXStep = function (s: S, vm: any): void {
  const d = s.data;
  const k = d[0];
  if (k === 0) {
    s.oy = s.oy + 10;
    if (s.oy >= 0) {
      P.playSEPan(vm, "SE_M_SKETCH", 63);
      s.oy = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 1) {
    d[1] = d[1] + 4;
    s.oy = -P.shr(H.sine(d[1]), 3);
    if (d[1] > 0x7F) {
      P.playSEPan(vm, "SE_M_SKETCH", 63);
      d[1] = 0;
      s.oy = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 2) {
    d[1] = d[1] + 6;
    s.oy = -P.shr(H.sine(d[1]), 4);
    if (d[1] > 0x7F) {
      d[1] = 0;
      s.oy = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 3) {
    d[1] = d[1] + 1;
    if (d[1] > 8) {
      P.playSEPan(vm, "SE_M_LEER", 63);
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 4) {
    d[1] = d[1] + 1;
    if (d[1] > 8) {
      d[1] = 0;
      d[2] = d[2] + 1;
      s.invisible = (d[2] & 1) !== 0;
      if (d[2] === 7) P.DestroyAnimSprite(s);
    }
  }
};

// Lua: g3_e3c.lua:832 -- pokefirered/src/battle_anim_effects_3.c:4771
C.BlockX = cbOf(function (s: S, vm: any): void {
  const tgt = P.tgt(vm);
  let y: number;
  if (P.tgtIsPlayer(vm)) {
    s.sub = P.subpriorityOf(tgt) - 2;
    y = -144;
  } else {
    s.sub = P.subpriorityOf(tgt) + 2;
    y = -96;
  }
  s.y = P.coord(vm, tgt, P.COORD_Y_PIC);
  s.oy = y;
  s.callbackFn = H.blockXStep;
});

// Lua: g3_e3c.lua:847
H.odorCloneStep = function (s: S, vm: any): void {
  const d = s.data;
  const hidden = P.monHidden(vm, P.tgt(vm));
  d[1] = d[1] + 1;
  if (d[1] > 1) {
    d[1] = 0;
    if (!hidden) s.invisible = !s.invisible;
  }
  d[4] = (d[4] + d[3]) & 0xFF;
  s.ox = P.Cos(d[4], d[5]);
  if (d[0] === 0) {
    d[2] = d[2] + 1;
    if (d[2] === 60) {
      d[2] = 0;
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 1) {
    d[2] = d[2] + 1;
    if (d[2] > 0) {
      d[2] = 0;
      d[5] = d[5] - 2;
      if (d[5] < 0) {
        if (s.task) s.task.data[d[7]] = s.task.data[d[7]] - 1;
        P.DestroyAnimSprite(s);
      }
    }
  }
};

// Lua: g3_e3c.lua:876
H.odorWait = function (t: Task): void {
  if (t.data[0] === 0) P.DestroyAnimVisualTask(t);
};

// Lua: g3_e3c.lua:881 -- pokefirered/src/battle_anim_effects_3.c:4848
T.OdorSleuthMovement = taskOf(function (t: Task, vm: any): void {
  const side = P.tgt(vm);
  const s1 = P.CloneMon(vm, side);
  if (!s1) {
    P.DestroyAnimVisualTask(t);
    return;
  }
  const s2 = P.CloneMon(vm, side);
  if (!s2) {
    P.DestroyAnimSprite(s1);
    P.DestroyAnimVisualTask(t);
    return;
  }
  s2.ox = s2.ox + 24;
  s1.ox = s1.ox - 24;
  for (let i = 0; i <= 7; i++) {
    s1.data[i] = 0;
    s2.data[i] = 0;
  }
  s2.data[3] = 16;
  s1.data[3] = -16;
  s2.data[4] = 0;
  s1.data[4] = 128;
  s2.data[5] = 24;
  s1.data[5] = 24;
  s1.task = t; s2.task = t;
  t.data[0] = 2;
  if (!P.monHidden(vm, side)) {
    s2.invisible = false;
    s1.invisible = true;
  } else {
    s2.invisible = true;
    s1.invisible = true;
  }
  s1._objBlend = false;
  s2._objBlend = false;
  s1.callbackFn = H.odorCloneStep;
  s2.callbackFn = H.odorCloneStep;
  t.fn = H.odorWait;
});

// Lua: g3_e3c.lua:923 -- pokefirered/src/battle_anim_effects_3.c:4949
T.GetReturnPowerLevel = taskOf(function (t: Task, vm: any): void {
  let f = tonumber(vm && vm.ctx ? (vm.ctx.friendship ?? vm.ctx.animFriendship) : null);
  if (f == null) {
    const st = H.battleSt();
    const b = st ? st[P.atk(vm)] : null;
    const mon = (b != null && typeof b === "object") ? b.mon : null;
    if (mon) f = tonumber(mon.friendship ?? mon.happiness);
  }
  f = P.u8(f ?? 0);
  P.setRet(vm, 0);
  if ((f as number) < 60) P.setRet(vm, 0);
  if ((f as number) > 60 && (f as number) < 92) P.setRet(vm, 1);
  if ((f as number) > 91 && (f as number) < 201) P.setRet(vm, 2);
  if ((f as number) > 200) P.setRet(vm, 3);
  P.DestroyAnimVisualTask(t);
});

// Lua: g3_e3c.lua:940
H.monPicSprite = function (vm: any, species: any, isBack: boolean, x: number, y: number, z: number, side: any): S | null {
  // pcall(require, "src.core.game3.pokemon"): a real module, the ok path.
  let img: any = null;
  if (species != null && species !== false) {
    const [picSp, shiny, personality] = Ui.sidePicArgs(side, species);
    let e: any = null;
    if (isBack && Pokemon.backPic) e = Pokemon.backPic(picSp, null, shiny);
    if (!isBack && Pokemon.frontPic) e = Pokemon.frontPic(picSp, null, shiny, personality);
    img = e ? e.image : null;
  }
  // pcall(require, "src.core.game3.battle.pic_coords"): a real module, the ok path.
  let yOff = 0;
  if (species != null && species !== false) {
    const tbl = isBack ? PicCoords.back : PicCoords.front;
    yOff = (tbl ? tbl[species] : null) ?? 0;
  }
  const s = P.CloneMon(vm, P.atk(vm));
  if (!s) return null;
  if (img) s.image = img;
  s.x = x;
  s.y = y + yOff;
  s.ox = 0; s.oy = 0;
  s._mat = null;
  s._objBlend = false;
  s.invisible = false;
  s.zOverride = z;
  s.callbackFn = function (): void {};
  P.sync(s, vm);
  return s;
};

// Lua: g3_e3c.lua:971
H.snatchStep = function (t: Task, vm: any): void {
  const d = t.data;
  const atk = P.atk(vm), tgt = P.tgt(vm);
  const p = t._p;
  const k = d[0];
  if (k === 0) {
    d[1] = d[1] + 0x800;
    if (p) {
      if (P.atkIsPlayer(vm)) {
        p.ox = p.ox + P.shr(d[1], 8);
      } else {
        p.ox = p.ox - P.shr(d[1], 8);
      }
    }
    d[1] = d[1] & 0xFF;
    const x = t._x + (p ? p.ox : 0);
    if (x < -32 || x > DISPLAY_WIDTH + 32) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 1) {
    const species = P.species(vm, atk);
    let isBack: boolean, x: number, z: number;
    if (P.atkIsPlayer(vm)) {
      isBack = false;
      x = DISPLAY_WIDTH + 32;
      z = 95;
    } else {
      isBack = true;
      x = -32;
      z = 205;
    }
    t._s2 = H.monPicSprite(vm, species, isBack, x, P.coord(vm, tgt, P.COORD_Y), z, atk);
    d[0] = d[0] + 1;
  } else if (k === 2) {
    const s2 = t._s2;
    d[1] = d[1] + 0x800;
    if (s2) {
      if (P.atkIsPlayer(vm)) {
        s2.ox = s2.ox - P.shr(d[1], 8);
      } else {
        s2.ox = s2.ox + P.shr(d[1], 8);
      }
    }
    d[1] = d[1] & 0xFF;
    const x = s2 ? (s2.x + s2.ox) : -1000;
    if (d[14] === 0) {
      if (P.atkIsPlayer(vm)) {
        if (x < P.coord(vm, tgt, P.COORD_X)) {
          d[14] = d[14] + 1;
          P.setRet(vm, -1);
        }
      } else {
        if (x > P.coord(vm, tgt, P.COORD_X)) {
          d[14] = d[14] + 1;
          P.setRet(vm, -1);
        }
      }
    }
    if (x < -32 || x > DISPLAY_WIDTH + 32) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 3) {
    if (t._s2 && t._s2.active) P.DestroyAnimSprite(t._s2);
    t._s2 = null;
    if (p) {
      if (P.atkIsPlayer(vm)) {
        p.ox = -t._x - 32;
      } else {
        p.ox = DISPLAY_WIDTH + 32 - t._x;
      }
    }
    d[0] = d[0] + 1;
  } else if (k === 4) {
    d[1] = d[1] + 0x800;
    const ax = P.coord(vm, atk, P.COORD_X);
    if (p) {
      if (P.atkIsPlayer(vm)) {
        p.ox = p.ox + P.shr(d[1], 8);
        if (p.ox + t._x >= ax) p.ox = 0;
      } else {
        p.ox = p.ox - P.shr(d[1], 8);
        if (p.ox + t._x <= ax) p.ox = 0;
      }
    }
    d[1] = P.u8(d[1]);
    if (!p || p.ox === 0) P.DestroyAnimVisualTask(t);
  }
};

// Lua: g3_e3c.lua:1063 -- pokefirered/src/battle_anim_effects_3.c:4966
T.SnatchOpposingMonMove = taskOf(function (t: Task, vm: any): void {
  const atk = P.atk(vm);
  t._p = P.monPresent(atk);
  t._x = H.monX(vm, atk);
  t.fn = H.snatchStep;
  H.snatchStep(t, vm);
});

// Lua: g3_e3c.lua:1071
H.snatchPartnerStep = function (t: Task, vm: any): void {
  const d = t.data;
  const p = t._p;
  const k = d[15];
  if (k === 0) {
    const attackerX = P.coord(vm, P.atk(vm), P.COORD_X);
    const targetX = P.coord(vm, P.tgt(vm), P.COORD_X);
    d[0] = 6;
    if (attackerX > targetX) d[0] = -d[0];
    d[1] = attackerX;
    d[2] = targetX;
    d[15] = d[15] + 1;
  } else if (k === 1) {
    if (p) p.ox = p.ox + d[0];
    const x = t._x + (p ? p.ox : 0);
    if (d[0] > 0) {
      if (x >= d[2]) d[15] = d[15] + 1;
    } else {
      if (x <= d[2]) d[15] = d[15] + 1;
    }
  } else if (k === 2) {
    d[0] = -d[0];
    d[15] = d[15] + 1;
  } else if (k === 3) {
    if (p) p.ox = p.ox + d[0];
    const x = t._x + (p ? p.ox : 0);
    if (d[0] < 0) {
      if (x <= d[1]) d[15] = d[15] + 1;
    } else {
      if (x >= d[1]) d[15] = d[15] + 1;
    }
  } else {
    if (p) p.ox = 0;
    P.DestroyAnimVisualTask(t);
  }
};

// Lua: g3_e3c.lua:1109 -- pokefirered/src/battle_anim_effects_3.c:5147
T.SnatchPartnerMove = taskOf(function (t: Task, vm: any): void {
  const atk = P.atk(vm);
  t._p = P.monPresent(atk);
  t._x = H.monX(vm, atk);
  t.fn = H.snatchPartnerStep;
  H.snatchPartnerStep(t, vm);
});

// Lua: g3_e3c.lua:1117
H.teeterApply = function (t: Task): void {
  const p = t._p;
  if (p) p.ox = t._xd + t._x2;
};

// Lua: g3_e3c.lua:1122
H.teeterStep = function (t: Task, _vm: any): void {
  const d = t.data;
  if (d[0] === 0) {
    d[11] = (d[11] + 8) & 0xFF;
    t._x2 = P.shr(H.sine(d[11]), 5);
    d[9] = (d[9] + 2) & 0xFF;
    t._xd = P.shr(H.sine(d[9]), 3) * d[4];
    if (d[9] === 0) {
      t._xd = 0;
      d[0] = d[0] + 1;
    }
    H.teeterApply(t);
  } else if (d[0] === 1) {
    d[11] = (d[11] + 8) & 0xFF;
    t._x2 = P.shr(H.sine(d[11]), 5);
    if (d[11] === 0) {
      t._x2 = 0;
      d[0] = d[0] + 1;
    }
    H.teeterApply(t);
  } else if (d[0] === 2) {
    P.DestroyAnimVisualTask(t);
  }
};

// Lua: g3_e3c.lua:1148 -- pokefirered/src/battle_anim_effects_3.c:5208
T.TeeterDanceMovement = taskOf(function (t: Task, vm: any): void {
  const d = t.data;
  const atk = P.atk(vm);
  t._p = P.monPresent(atk);
  d[4] = P.atkIsPlayer(vm) ? 1 : -1;
  d[6] = H.monY(vm, atk);
  d[5] = H.monX(vm, atk);
  d[9] = 0;
  d[11] = 0;
  d[10] = 1;
  d[12] = 0;
  t._xd = 0;
  t._x2 = (t._p ? t._p.ox : null) ?? 0;
  t.fn = H.teeterStep;
});

// Lua: g3_e3c.lua:1164
H.knockOffStep = function (s: S): void {
  const d = s.data;
  d[1] = (d[1] + d[0]) & 0xFF;
  s.ox = P.Cos(d[1], 20);
  s.oy = P.Sin(d[1], 20);
  if (s.animEnded) {
    P.DestroyAnimSprite(s);
    return;
  }
  d[2] = d[2] + 1;
};

// Lua: g3_e3c.lua:1177 -- pokefirered/src/battle_anim_effects_3.c:5283
C.KnockOffStrike = cbOf(function (s: S, vm: any): void {
  const d = s.data;
  if (P.tgtIsPlayer(vm)) {
    s.x = s.x - s.ga[0];
    s.y = s.y + s.ga[1];
    d[0] = -11;
    d[1] = 192;
    P.StartSpriteAffineAnim(s, 1);
  } else {
    d[0] = 11;
    d[1] = 192;
    s.x = s.x + s.ga[0];
    s.y = s.y + s.ga[1];
  }
  s.callbackFn = H.knockOffStep;
});

// Lua: g3_e3c.lua:1194
H.recycleStep = function (s: S, vm: any): void {
  const d = s.data;
  const k = d[2];
  if (k === 0) {
    d[0] = d[0] + 1;
    if (d[0] > 1) {
      d[0] = 0;
      if ((d[1] & 1) === 0) {
        if (d[6] < 16) d[6] = d[6] + 1;
      } else {
        if (d[7] !== 0) d[7] = d[7] - 1;
      }
      d[1] = d[1] + 1;
      P.setBld(vm, d[6], d[7]);
      if (d[7] === 0) d[2] = d[2] + 1;
    }
  } else if (k === 1) {
    d[0] = d[0] + 1;
    if (d[0] === 10) {
      d[0] = 0;
      d[1] = 0;
      d[2] = d[2] + 1;
    }
  } else if (k === 2) {
    d[0] = d[0] + 1;
    if (d[0] > 1) {
      d[0] = 0;
      if ((d[1] & 1) === 0) {
        if (d[6] !== 0) d[6] = d[6] - 1;
      } else {
        if (d[7] < 16) d[7] = d[7] + 1;
      }
      d[1] = d[1] + 1;
      P.setBld(vm, d[6], d[7]);
      if (d[7] === 16) d[2] = d[2] + 1;
    }
  } else if (k === 3) {
    P.DestroySpriteAndMatrix(s);
  }
};

// Lua: g3_e3c.lua:1236 -- pokefirered/src/battle_anim_effects_3.c:5306
C.Recycle = cbOf(function (s: S, vm: any): void {
  const atk = P.atk(vm);
  s.x = P.coord(vm, atk, P.COORD_X_2);
  s.y = P.coordAttr(vm, atk, P.ATTR_TOP);
  if (s.y < 16) s.y = 16;
  s.data[6] = 0;
  s.data[7] = 16;
  s.callbackFn = H.recycleStep;
  P.setBld(vm, s.data[6], s.data[7]);
});

// Lua: g3_e3c.lua:1247
H.weatherCode = function (w: any): number {
  if (w == null) return 0;
  if (typeof w === "number") {
    if ((w & 0x60) !== 0) return 1;
    if ((w & 0x07) !== 0) return 2;
    if ((w & 0x18) !== 0) return 3;
    if ((w & 0x80) !== 0) return 4;
    return 0;
  }
  // pcall(require, "src.core.game3.battle.rules"): a real module, the ok path.
  const kind = (Rules.weather ? Rules.weather.kind(w) : null) ?? null;
  if (kind === "SUN") return 1;
  if (kind === "RAIN") return 2;
  if (kind === "SAND") return 3;
  if (kind === "HAIL") return 4;
  return 0;
};

// Lua: g3_e3c.lua:1266 -- pokefirered/src/battle_anim_effects_3.c:5379
T.GetWeather = taskOf(function (t: Task, vm: any): void {
  let w = (vm && vm.ctx) ? (vm.ctx.weatherMoveAnim ?? vm.ctx.weather) : null;
  if (w == null) {
    const st = H.battleSt();
    w = st ? st.weather : null;
  }
  P.setRet(vm, H.weatherCode(w));
  P.DestroyAnimVisualTask(t);
});

// Lua: g3_e3c.lua:1276
H.slackOffStep = function (t: Task, vm: any): void {
  const d = t.data;
  const p = t._aP;
  d[0] = d[0] + 1;
  if (d[0] > 16 && d[0] < 40) {
    d[1] = d[1] + 1;
    if (d[1] > 2) {
      d[1] = 0;
      d[2] = d[2] + 1;
      if (p) {
        if ((d[2] & 1) === 0) p.ox = -1; else p.ox = 1;
      }
    }
  } else {
    if (p) p.ox = 0;
  }
  if (!H.runAffine(t, vm)) P.DestroyAnimVisualTask(t);
};

// Lua: g3_e3c.lua:1296 -- pokefirered/src/battle_anim_effects_3.c:5396
T.SlackOffSquish = taskOf(function (t: Task, vm: any): void {
  t.data[0] = 0;
  H.prepAffine(t, P.side(vm, t.ga[0]), P.data().affine.sSlackOffSquishAffineAnimCmds);
  t.fn = H.slackOffStep;
});

const M = { callbacks: C, tasks: T };
export default M;
