// Port of gen1recomp src/core/game3/battle/anim_port/g3_e3b.lua (GPLv3 + additional terms; see LICENSE.md).
// battle_anim_effects_3.c, part B: green star, doom desire, frustration, rock
// mon, sweet scent, flail, pain split, flatter, reversal, role play, acid armor,
// deep inhale, yawn, smoke ball, focus band, facade.

import { G } from "../../../platform/graphics.ts";
import { ipairs, seq } from "../../../platform/lt.ts";
import { Pokemon } from "../../pokemon.ts";
import { PicCoords } from "../pic_coords.ts";
import { Ui } from "../ui.ts";
import { P } from "./g3_pret.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type S = Record<string, any>;
type Task = Record<string, any>;

const C: Record<string, any> = {};
const T: Record<string, any> = {};
// local band, bor = P.band, P.bor: JS & and | (no top-level read of an import).
const floor = Math.floor;

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

const H: Record<string, any> = {};

// Lua: g3_e3b.lua:9
H.prepareAffine = function (t: Task, side: any, name: string): void {
  const d = t.data;
  d[7] = 0;
  d[8] = 0;
  d[9] = 0;
  d[10] = 0x100;
  d[11] = 0x100;
  d[12] = 0;
  t._affSide = side;
  t._affCmds = P.data().affine[name] ?? seq({ e: 1 });
};

// Lua: g3_e3b.lua:21
H.runAffine = function (t: Task, vm: any): boolean {
  const d = t.data;
  const cmds = t._affCmds;
  const side = t._affSide;
  let c = cmds[d[7] + 1] ?? { e: 1 };
  if (c.x != null) {
    if ((c.d ?? 0) === 0) {
      d[10] = c.x;
      d[11] = c.y;
      d[12] = c.r ?? 0;
      d[7] = d[7] + 1;
      c = cmds[d[7] + 1] ?? {};
    }
    d[10] = P.s16(d[10] + (c.x ?? 0));
    d[11] = P.s16(d[11] + (c.y ?? 0));
    d[12] = P.s16(d[12] + (c.r ?? 0));
    const p = side != null ? P.monPresent(side) : null;
    P.monRotScale(p, d[10], d[11], d[12]);
    if (p) P.monYOffsetFromYScale(vm, side);
    d[8] = d[8] + 1;
    if (d[8] >= (c.d ?? 0)) {
      d[8] = 0;
      d[7] = d[7] + 1;
    }
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
        const pc = cmds[d[7] + 1];
        if (pc && pc.l != null) {
          d[7] = d[7] + 1;
          return true;
        }
        if (d[7] === 0) return true;
      }
    }
    d[7] = d[7] + 1;
  } else {
    const p = side != null ? P.monPresent(side) : null;
    if (p) p.oy = 0;
    P.monResetRotScale(p);
    return false;
  }
  return true;
};

// Lua: g3_e3b.lua:79
H.rgb = function (r: number, g: number, b: number): number { return r + g * 32 + b * 1024; };

// Lua: g3_e3b.lua:81
H.greenStarChild = function (s: S): void {
  const d = s.data;
  if (!s.invisible) {
    const delta = P.s16(d[3] + d[2]);
    s.oy = s.oy - P.shr(delta, 8);
    d[3] = P.s16(d[3] + d[2]) & 0xFF;
    d[1] = d[1] - 1;
    if (d[1] === -1) {
      s.invisible = true;
      s._dummy = true;
      s.callbackFn = null;
    }
  }
};

// Lua: g3_e3b.lua:96
H.greenStarStep2 = function (s: S): void {
  const a = s._c1, b = s._c2;
  const da = (!a) || (!a.active) || a._dummy;
  const db = (!b) || (!b.active) || b._dummy;
  if (da && db) {
    if (a && a.active) P.DestroyAnimSprite(a);
    if (b && b.active) P.DestroyAnimSprite(b);
    P.DestroyAnimSprite(s);
  }
};

// Lua: g3_e3b.lua:107
H.greenStarStep1 = function (s: S): void {
  const d = s.data;
  const delta = P.s16(d[3] + d[2]);
  s.oy = s.oy - P.shr(delta, 8);
  d[3] = P.s16(d[3] + d[2]) & 0xFF;
  if (d[4] === 0 && s.oy < -8) {
    if (s._c1) s._c1.invisible = false;
    d[4] = d[4] + 1;
  }
  if (d[4] === 1 && s.oy < -16) {
    if (s._c2) s._c2.invisible = false;
    d[4] = d[4] + 1;
  }
  d[1] = d[1] - 1;
  if (d[1] === -1) {
    s.invisible = true;
    s.callbackFn = H.greenStarStep2;
  }
};

// Lua: g3_e3b.lua:128 -- pokefirered/src/battle_anim_effects_3.c:2405
C.GreenStar = cbOf(function (s: S, vm: any): void {
  const d = s.data;
  let xOffset = P.Random() & 0x3F;
  if (xOffset > 31) xOffset = 32 - xOffset;
  s.x = P.coordAtk(vm, P.COORD_X) + xOffset;
  s.y = P.coordAtk(vm, P.COORD_Y) + 32;
  d[1] = s.ga[0];
  d[2] = s.ga[1];
  const c1 = P.CreateSprite(vm, "gGreenStarSpriteTemplate", s.x, s.y, s.sub + 1, H.greenStarChild);
  const c2 = P.CreateSprite(vm, "gGreenStarSpriteTemplate", s.x, s.y, s.sub + 1, H.greenStarChild);
  for (const [i, c] of ipairs<any>(seq(c1 ?? false, c2 ?? false))) {
    if (c) {
      P.StartSpriteAnim(c, i);
      c.data[1] = s.ga[0];
      c.data[2] = s.ga[1];
      c.data[7] = -1;
      c.invisible = true;
      P.sync(c, vm);
    }
  }
  s._c1 = c1;
  s._c2 = c2;
  s.callbackFn = H.greenStarStep1;
});

H.DOOM_COORDS = [0x78, 0x50, 0x28, 0x00, 0];
H.DOOM_DELAYS = [0, 0, 0, 0, 50];

// Lua: g3_e3b.lua:156
H.doomDesireStep = function (t: Task, vm: any): void {
  const d = t.data;
  const st = d[0];
  if (st === 0) {
    P.setBld(vm, 3, 13);
    P.bg1Layer(t, vm, "MORNING_SUN", 1);
    const x = P.tgtIsPlayer(vm) ? -10 : -135;
    t._bg1x = x;
    t._bg1y = 0;
    d[10] = x;
    d[11] = 0;
    d[0] = d[0] + 1;
  } else if (st === 1) {
    d[3] = 0;
    if (!P.tgtIsPlayer(vm)) {
      t._bg1x = d[10] + H.DOOM_COORDS[d[2]];
    } else {
      t._bg1x = d[10] - H.DOOM_COORDS[d[2]];
    }
    d[2] = d[2] + 1;
    if (d[2] === 5) d[0] = 5; else d[0] = d[0] + 1;
  } else if (st === 2) {
    d[1] = d[1] - 1;
    if (d[1] <= 4) d[1] = 5;
    P.setBld(vm, 3, d[1]);
    if (d[1] === 5) d[0] = d[0] + 1;
  } else if (st === 3) {
    d[3] = d[3] + 1;
    if (d[3] > H.DOOM_DELAYS[d[2]]) d[0] = d[0] + 1;
  } else if (st === 4) {
    d[1] = d[1] + 1;
    if (d[1] > 13) d[1] = 13;
    P.setBld(vm, 3, d[1]);
    if (d[1] === 13) d[0] = 1;
  } else if (st === 5) {
    P.bg1Clear(t);
    t._bg1x = 0;
    t._bg1y = 0;
    P.setBld(vm, null);
    P.DestroyAnimVisualTask(t);
  }
};

// Lua: g3_e3b.lua:200 -- pokefirered/src/battle_anim_effects_3.c:2495
T.DoomDesireLightBeam = taskOf(function (t: Task, vm: any): void {
  t.fn = H.doomDesireStep;
  H.doomDesireStep(t, vm);
});

// Lua: g3_e3b.lua:205
H.strongFrustrationStep = function (t: Task, vm: any): void {
  if (!H.runAffine(t, vm)) P.DestroyAnimVisualTask(t);
};

// Lua: g3_e3b.lua:210 -- pokefirered/src/battle_anim_effects_3.c:2599
T.StrongFrustrationGrowAndShrink = taskOf(function (t: Task, vm: any): void {
  H.prepareAffine(t, P.atk(vm), "sStrongFrustrationAffineAnimCmds");
  t.data[0] = t.data[0] + 1;
  t.fn = H.strongFrustrationStep;
});

// Lua: g3_e3b.lua:217 -- pokefirered/src/battle_anim_effects_3.c:2616
C.WeakFrustrationAngerMark = cbOf(function (s: S, vm: any): void {
  const d = s.data;
  if (d[0] === 0) {
    P.InitSpritePosToAnimAttacker(s, vm, false);
    d[0] = d[0] + 1;
  } else {
    const old = d[0];
    d[0] = d[0] + 1;
    if (old > 20) {
      d[1] = P.s16(d[1] + 160);
      d[2] = P.s16(d[2] + 128);
      if (!P.atkIsPlayer(vm)) {
        s.ox = -P.shr(d[1], 8);
      } else {
        s.ox = P.shr(d[1], 8);
      }
      s.oy = s.oy + P.shr(d[2], 8);
      if (s.oy > 64) P.DestroyAnimSprite(s);
    }
  }
});

// Lua: g3_e3b.lua:239
H.rockMonApply = function (t: Task, _vm: any): void {
  const d = t.data;
  const p = t._p;
  P.monRotScale(p, 0x100, 0x100, d[2]);
  if (p) P.monYOffsetFromRotation(t._side);
};

// Lua: g3_e3b.lua:246
H.rockMonStep = function (t: Task, vm: any): void {
  const d = t.data;
  const p = t._p;
  const st = d[0];
  if (st === 0) {
    if (p) p.ox = p.ox + d[5];
    d[2] = P.s16(d[2] - d[4]);
    H.rockMonApply(t, vm);
    d[1] = d[1] + 1;
    if (d[1] >= d[3]) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (st === 1) {
    if (p) p.ox = p.ox - d[5];
    d[2] = P.s16(d[2] + d[4]);
    H.rockMonApply(t, vm);
    d[1] = d[1] + 1;
    if (d[1] >= d[3] * 2) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (st === 2) {
    if (p) p.ox = p.ox + d[5];
    d[2] = P.s16(d[2] - d[4]);
    H.rockMonApply(t, vm);
    d[1] = d[1] + 1;
    if (d[1] >= d[3]) {
      if (d[6] !== 0) {
        d[6] = d[6] - 1;
        d[1] = 0;
        d[0] = 0;
      } else {
        d[0] = d[0] + 1;
      }
    }
  } else if (st === 3) {
    P.monResetRotScale(p);
    P.DestroyAnimVisualTask(t);
  }
};

// Lua: g3_e3b.lua:289 -- pokefirered/src/battle_anim_effects_3.c:2643
T.RockMonBackAndForth = taskOf(function (t: Task, vm: any): void {
  const d = t.data;
  const ga = t.ga;
  if (ga[1] === 0) {
    P.DestroyAnimVisualTask(t);
    return;
  }
  if (ga[2] < 0) ga[2] = 0;
  if (ga[2] > 2) ga[2] = 2;
  d[0] = 0;
  d[1] = 0;
  d[2] = 0;
  d[3] = 8 - 2 * ga[2];
  d[4] = 0x100 + ga[2] * 128;
  d[5] = ga[2] + 2;
  d[6] = ga[1] - 1;
  [t._p, t._side] = P.monSprite(vm, ga[0]);
  const side = (ga[0] === P.ANIM_ATTACKER) ? P.atk(vm) : P.tgt(vm);
  if (side !== "player") {
    d[4] = -d[4];
    d[5] = -d[5];
  }
  t.fn = H.rockMonStep;
});

// Lua: g3_e3b.lua:314
H.sweetScentStep = function (s: S, vm: any): void {
  const d = s.data;
  d[0] = P.s16(d[0] + 3);
  if (P.atkIsPlayer(vm)) {
    s.x = s.x + 5;
    s.y = s.y - 1;
    if (s.x > 240) {
      P.DestroyAnimSprite(s);
      return;
    }
    s.oy = P.Sin(d[0] & 0xFF, 16);
  } else {
    s.x = s.x - 5;
    s.y = s.y + 1;
    if (s.x < 0) {
      P.DestroyAnimSprite(s);
      return;
    }
    s.oy = P.Cos(d[0] & 0xFF, 16);
  }
};

// Lua: g3_e3b.lua:337 -- pokefirered/src/battle_anim_effects_3.c:2741
C.SweetScentPetal = cbOf(function (s: S, vm: any): void {
  if (P.atkIsPlayer(vm)) {
    s.x = 0;
    s.y = s.ga[0];
  } else {
    s.x = 240;
    s.y = s.ga[0] - 30;
  }
  s.data[2] = s.ga[2];
  P.StartSpriteAnim(s, s.ga[1]);
  s.callbackFn = H.sweetScentStep;
});

// Lua: g3_e3b.lua:350
H.flailStep = function (t: Task, _vm: any): void {
  const d = t.data;
  const p = t._p;
  const st = d[0];
  if (st === 0) {
    d[2] = P.s16(d[2] + 0x200);
    if (d[2] >= d[14]) {
      const diff = P.s16(d[14] - d[2]);
      const dv = P.s16(P.div(diff, d[14] * 2));
      const md = P.s16(P.mod(diff, d[14] * 2));
      if ((dv & 1) === 0) {
        d[2] = P.s16(d[14] - md);
        d[0] = 1;
      } else {
        d[2] = P.s16(md - d[14]);
      }
    }
  } else if (st === 1) {
    d[2] = P.s16(d[2] - 0x200);
    if (d[2] <= -d[14]) {
      const diff = P.s16(d[14] - d[2]);
      const dv = P.s16(P.div(diff, d[14] * 2));
      const md = P.s16(P.mod(diff, d[14] * 2));
      if ((dv & 1) === 0) {
        d[2] = P.s16(md - d[14]);
        d[0] = 0;
      } else {
        d[2] = P.s16(d[14] - md);
      }
    }
  } else if (st === 2) {
    P.monResetRotScale(p);
    P.DestroyAnimVisualTask(t);
    return;
  }
  P.monRotScale(p, 0x100, 0x100, d[2]);
  if (p) {
    P.monYOffsetFromRotation(t._side);
    let v = d[2];
    if (v < 0) v = v + 63;
    p.ox = -P.shr(v, 6);
  }
  d[1] = d[1] + 1;
  if (d[1] > 8) {
    if (d[12] !== 0) {
      d[12] = d[12] - 1;
      d[14] = d[14] - d[13];
      if (d[14] < 16) d[14] = 16;
    } else {
      d[0] = 2;
    }
  }
};

// Lua: g3_e3b.lua:405 -- pokefirered/src/battle_anim_effects_3.c:2786
T.FlailMovement = taskOf(function (t: Task, vm: any): void {
  const d = t.data;
  d[0] = 0;
  d[1] = 0;
  d[2] = 0;
  d[3] = 0;
  d[12] = 0x20;
  d[13] = 0x40;
  d[14] = 0x800;
  [t._p, t._side] = P.monSprite(vm, t.ga[0]);
  t.fn = H.flailStep;
});

// Lua: g3_e3b.lua:419 -- pokefirered/src/battle_anim_effects_3.c:2877
C.PainSplitProjectile = cbOf(function (s: S, vm: any): void {
  const d = s.data;
  if (d[0] === 0) {
    if (s.ga[2] === P.ANIM_ATTACKER) {
      s.x = P.coordAtk(vm, P.COORD_X_2);
      s.y = P.coordAtk(vm, P.COORD_Y_PIC);
    }
    s.x = s.x + s.ga[0];
    s.y = s.y + s.ga[1];
    d[1] = 0x80;
    d[2] = 0x300;
    d[3] = s.ga[1];
    d[0] = d[0] + 1;
  } else {
    s.ox = P.shr(d[1], 8);
    s.oy = s.oy + P.shr(d[2], 8);
    if (d[4] === 0 && s.oy > -d[3]) {
      d[4] = 1;
      d[2] = P.s16(P.div(-d[2], 3) * 2);
    }
    d[1] = P.s16(d[1] + 192);
    d[2] = P.s16(d[2] + 128);
    if (s.animEnded) P.DestroyAnimSprite(s);
  }
});

// Lua: g3_e3b.lua:446 -- pokefirered/src/battle_anim_effects_3.c:2914
T.PainSplitMovement = taskOf(function (t: Task, vm: any): void {
  const d = t.data;
  if (d[0] === 0) {
    const [p, side] = P.monSprite(vm, t.ga[0]);
    t._p = p; t._side = side;
    if (p) {
      const mode = t.ga[1];
      if (mode === 0) {
        P.monRotScale(p, 0xE0, 0x140, 0);
        P.monYOffsetFromYScale(vm, side);
      } else if (mode === 1) {
        P.monRotScale(p, 0xD0, 0x130, 0xF00);
        P.monYOffsetFromYScale(vm, side);
        if (side === "player") p.oy = p.oy + 16;
      } else if (mode === 2) {
        P.monRotScale(p, 0xD0, 0x130, 0xF100);
        P.monYOffsetFromYScale(vm, side);
        if (side === "player") p.oy = p.oy + 16;
      }
      p.ox = 2;
    }
    d[0] = d[0] + 1;
  } else {
    const p = t._p;
    d[2] = d[2] + 1;
    if (d[2] === 3) {
      d[2] = 0;
      if (p) p.ox = -p.ox;
    }
    d[1] = d[1] + 1;
    if (d[1] === 13) {
      P.monResetRotScale(p);
      if (p) {
        p.ox = 0;
        p.oy = 0;
      }
      P.DestroyAnimVisualTask(t);
    }
  }
});

// Lua: g3_e3b.lua:487
H.flatterConfettiStep = function (s: S): void {
  const d = s.data;
  if (d[2] === 0) {
    s.ox = s.ox + P.shr(d[0], 8);
    s.oy = s.oy - P.shr(d[1], 8);
  } else {
    s.ox = s.ox - P.shr(d[0], 8);
    s.oy = s.oy - P.shr(d[1], 8);
  }
  d[0] = P.s16(d[0] - 22);
  d[1] = P.s16(d[1] - 48);
  if (d[0] < 0) d[0] = 0;
  d[3] = d[3] + 1;
  if (d[3] === 31) P.DestroyAnimSprite(s);
};

// Lua: g3_e3b.lua:504 -- pokefirered/src/battle_anim_effects_3.c:2973
C.FlatterConfetti = cbOf(function (s: S, _vm: any): void {
  const d = s.data;
  const tileOffset = P.Random() % 12;
  s.imageValue = s.imageValue + tileOffset;
  const rand1 = P.Random() & 0x1FF;
  const rand2 = P.Random() & 0xFF;
  if ((rand1 & 1) !== 0) d[0] = 0x5E0 + rand1; else d[0] = 0x5E0 - rand1;
  if ((rand2 & 1) !== 0) d[1] = 0x480 + rand2; else d[1] = 0x480 - rand2;
  d[2] = s.ga[0];
  if (d[2] === P.ANIM_ATTACKER) s.x = -8; else s.x = 248;
  s.y = 104;
  s.callbackFn = H.flatterConfettiStep;
});

// Lua: g3_e3b.lua:518
H.flatterSpotlightStep = function (s: S, vm: any): void {
  const d = s.data;
  const st = d[1];
  if (st === 0) {
    s.invisible = false;
    if (s.affineAnimEnded) d[1] = d[1] + 1;
  } else if (st === 1) {
    d[0] = d[0] - 1;
    if (d[0] === 0) {
      P.ChangeSpriteAffineAnim(s, 1);
      d[1] = d[1] + 1;
    }
  } else if (st === 2) {
    if (s.affineAnimEnded) {
      s.invisible = true;
      d[1] = d[1] + 1;
    }
  } else if (st === 3) {
    const w = P.win(vm);
    w.winout = 0x3F3F;
    w.objwin = !w.objwin;
    P.DestroyAnimSprite(s);
  }
};

// Lua: g3_e3b.lua:544 -- pokefirered/src/battle_anim_effects_3.c:3030
C.FlatterSpotlight = cbOf(function (s: S, vm: any): void {
  const w = P.win(vm);
  w.winout = 0x1F3F;
  w.objwin = true;
  w.win0 = null;
  s.data[0] = s.ga[2];
  P.InitSpritePosToAnimTarget(s, vm, false);
  P.registerObjWindow(vm, s);
  P.ensureColorOverlay(vm);
  s.invisible = true;
  s.callbackFn = H.flatterSpotlightStep;
});

// Lua: g3_e3b.lua:557
H.reversalOrbStep = function (s: S, vm: any): void {
  const d = s.data;
  s.ox = P.Sin(d[1], P.shr(d[2], 8));
  s.oy = P.Cos(d[1], P.shr(d[3], 8));
  d[1] = (d[1] + 9) & 0xFF;
  const base = P.subpriorityOf(P.atk(vm));
  if (P.u16(d[1]) < 64 || d[1] > 195) {
    s.sub = base - 1;
  } else {
    s.sub = base + 1;
  }
  if (d[5] === 0) {
    d[2] = P.s16(d[2] + 0x400);
    d[3] = P.s16(d[3] + 0x100);
    d[4] = d[4] + 1;
    if (d[4] === d[0]) {
      d[4] = 0;
      d[5] = 1;
    }
  } else if (d[5] === 1) {
    d[2] = P.s16(d[2] - 0x400);
    d[3] = P.s16(d[3] - 0x100);
    d[4] = d[4] + 1;
    if (d[4] === d[0]) P.DestroyAnimSprite(s);
  }
};

// Lua: g3_e3b.lua:585 -- pokefirered/src/battle_anim_effects_3.c:3079
C.ReversalOrb = cbOf(function (s: S, vm: any): void {
  s.x = P.coordAtk(vm, P.COORD_X_2);
  s.y = P.coordAtk(vm, P.COORD_Y_PIC);
  s.data[0] = s.ga[0];
  s.data[1] = s.ga[1];
  s.callbackFn = H.reversalOrbStep;
  H.reversalOrbStep(s, vm);
});

// Lua: g3_e3b.lua:594
H.picImage = function (species: any, back: boolean, side: any): any {
  // pcall(require, "src.core.game3.pokemon"): a real module, the ok path.
  if (species == null || species === false) return null;
  const [picSp, shiny, personality] = Ui.sidePicArgs(side, species);
  let e: any = null;
  if (back && Pokemon.backPic) e = Pokemon.backPic(picSp, null, shiny);
  if (!e && Pokemon.frontPic) e = Pokemon.frontPic(picSp, null, shiny, personality);
  return e ? e.image : null;
};

// Lua: g3_e3b.lua:604
H.picYOffset = function (species: any, back: boolean): number {
  // pcall(require, "src.core.game3.battle.pic_coords"): a real module, the ok path.
  if (species == null || species === false) return 0;
  const tbl = back ? PicCoords.back : PicCoords.front;
  return (tbl ? tbl[species] : null) ?? 0;
};

// Lua: g3_e3b.lua:611
H.rolePlayStep2 = function (t: Task, vm: any): void {
  const d = t.data;
  const c = t._clone;
  d[10] = P.s16(d[10] - 16);
  d[11] = P.s16(d[11] + 128);
  if (c && c.active) {
    P.TrySetSpriteRotScale(c, true, d[10], d[11], 0);
    P.sync(c, vm);
  }
  d[12] = d[12] + 1;
  if (d[12] === 9) {
    if (c && c.active) {
      P.TryResetSpriteAffineState(c);
      P.DestroyAnimSprite(c);
    }
    t._clone = null;
    t.fn = P.DestroyAnimVisualTaskAndDisableBlend;
  }
};

// Lua: g3_e3b.lua:631
H.rolePlayStep1 = function (t: Task, vm: any): void {
  const d = t.data;
  const old = d[10];
  d[10] = d[10] + 1;
  if (old > 1) {
    d[10] = 0;
    d[1] = d[1] + 1;
    P.setBld(vm, d[1], 16 - d[1]);
    if (d[1] === 10) {
      d[10] = 256;
      d[11] = 256;
      t.fn = H.rolePlayStep2;
    }
  }
};

// Lua: g3_e3b.lua:648 -- pokefirered/src/battle_anim_effects_3.c:3122
T.RolePlaySilhouette = taskOf(function (t: Task, vm: any): void {
  const d = t.data;
  const atk = P.atk(vm);
  const isBackPic = atk === "player";
  const xOffset = isBackPic ? -20 : 20;
  const species = P.species(vm, P.tgt(vm));
  const x = P.coordAtk(vm, P.COORD_X) + xOffset;
  const y = P.coordAtk(vm, P.COORD_Y) + H.picYOffset(species, isBackPic);
  const c = P.CloneMon(vm, atk);
  if (c) {
    const img = H.picImage(species, isBackPic, P.tgt(vm));
    if (img) c.image = img;
    c.x = x; c.y = y;
    c.ox = 0; c.oy = 0;
    c._mat = null;
    c.sub = 5;
    c.pri = 2;
    c.zOverride = isBackPic ? 205 : 105;
    c._objBlend = true;
    c.palBlend = { coeff: 16, color: 0x7FFF };
    P.sync(c, vm);
  }
  t._clone = c;
  P.setBld(vm, d[1], 16 - d[1]);
  d[0] = 0;
  t.fn = H.rolePlayStep1;
});

// setmetatable({}, { __mode = "k" }): a WeakMap keyed by image
H.rowQuads = new WeakMap<object, Record<number, any>>();

// Lua: g3_e3b.lua:678
H.rowQuad = function (img: any, r: number): any {
  let per = H.rowQuads.get(img);
  if (!per) {
    per = {};
    H.rowQuads.set(img, per);
  }
  let q = per[r];
  if (!q) {
    const [iw, ih] = img.getDimensions();
    q = G.newQuad(0, r, iw, 1, iw, ih);
    per[r] = q;
  }
  return q;
};

// Lua: g3_e3b.lua:693
H.acidArmorDraw = function (t: Task, vm: any): void {
  // if not (love and love.graphics): the platform always has graphics.
  if (!t._drawOn) return;
  const img = P.monImage(vm, t._side);
  if (!img) return;
  const [cx, cy] = P.monCenter(vm, t._side);
  const [iw, ih] = img.getDimensions();
  const top = floor(cy - ih / 2 + 0.5);
  const left = floor(cx - iw / 2 + 0.5);
  const flip = t._p ? t._p.hFlip : null;
  const buf = t._shown;
  G.setColor(1, 1, 1, P.bldAlphaValue(vm));
  for (let y = 0; y <= 159; y++) {
    const h = buf ? (buf.h[y] ?? 0) : 0;
    const v = buf ? (buf.v[y] ?? 0) : 0;
    if (h < 240) {
      const r = y + v - top;
      if (r >= 0 && r < ih) {
        if (flip) {
          G.draw(img, H.rowQuad(img, r), left - h + iw, y, 0, -1, 1);
        } else {
          G.draw(img, H.rowQuad(img, r), left - h, y);
        }
      }
    }
  }
  G.setColor(1, 1, 1, 1);
};

// Lua: g3_e3b.lua:722
H.acidArmorVblank = function (t: Task): void {
  if (t._scan === 1) {
    t._shown = t._bufs[t._src];
    t._src = 1 - t._src;
  } else if (t._scan === 3) {
    t._scan = 0;
    t._shown = null;
    if (t._drawOn) {
      t._drawOn = false;
      t.draw = null;
      if (t._p) t._p.visible = true;
    }
  }
};

// Lua: g3_e3b.lua:737
H.acidArmorStep = function (t: Task, vm: any): void {
  const d = t.data;
  H.acidArmorVblank(t);
  const p = t._p;
  const st = d[0];
  if (st === 0) {
    const buf = t._bufs[t._src];
    d[1] = (d[1] + 2) & 0xFF;
    let sineIndex = d[1];
    d[9] = P.div(0x7E0, d[6]);
    d[10] = P.s16(-P.div(d[7] * 2, d[9]));
    d[11] = d[7];
    let var3 = P.shr(d[11], 5);
    d[12] = var3;
    let var0 = d[14];
    let i = 0, var1 = 0, var2 = 0;
    while (var0 > d[13]) {
      buf.v[var0] = i - var2;
      buf.h[var0] = var3 + P.shr(P.SINE[sineIndex + 1], 5);
      sineIndex = (sineIndex + 10) & 0xFF;
      d[11] = P.s16(d[11] + d[10]);
      var3 = P.shr(d[11], 5);
      d[12] = var3;
      i = i + 1;
      var1 = P.s16(var1 + d[6]);
      var2 = P.shr(var1, 5);
      var0 = var0 - 1;
    }
    while (var0 >= 0) {
      t._bufs[0].h[var0] = 240;
      t._bufs[1].h[var0] = 240;
      var0 = var0 - 1;
    }
    d[6] = d[6] + 1;
    if (d[6] > 63) {
      d[6] = 64;
      d[2] = d[2] + 1;
      if ((d[2] & 1) !== 0) d[3] = d[3] - 1; else d[4] = d[4] + 1;
      P.setBld(vm, d[3], d[4]);
      if (d[3] === 0 && d[4] === 16) {
        d[2] = 0;
        d[3] = 0;
        d[0] = d[0] + 1;
      }
    } else {
      d[7] = P.s16(d[7] + d[8]);
    }
  } else if (st === 1) {
    d[2] = d[2] + 1;
    if (d[2] > 12) {
      t._scan = 3;
      d[2] = 0;
      d[0] = d[0] + 1;
    }
  } else if (st === 2) {
    d[2] = d[2] + 1;
    if ((d[2] & 1) !== 0) d[3] = d[3] + 1; else d[4] = d[4] - 1;
    P.setBld(vm, d[3], d[4]);
    if (d[3] === 16 && d[4] === 0) {
      d[2] = 0;
      d[3] = 0;
      d[0] = d[0] + 1;
    }
  } else if (st === 3) {
    if (p) {
      if (t._drawOn) p.visible = true;
      p.alpha = 1;
    }
    P.DestroyAnimVisualTask(t);
    return;
  }
  if (p && t._bg) p.alpha = P.bldAlphaValue(vm);
};

// Lua: g3_e3b.lua:812 -- pokefirered/src/battle_anim_effects_3.c:3222
T.AcidArmor = taskOf(function (t: Task, vm: any): void {
  const d = t.data;
  const side = (t.ga[0] === P.ANIM_ATTACKER) ? P.atk(vm) : P.tgt(vm);
  d[0] = 0;
  d[1] = 0;
  d[2] = 0;
  d[3] = 16;
  d[4] = 0;
  d[6] = 32;
  d[7] = 0;
  d[8] = 24;
  if (side !== "player") d[8] = -24;
  d[13] = P.yWithElevation(vm, side) - 34;
  if (d[13] < 0) d[13] = 0;
  d[14] = d[13] + 66;
  t._side = side;
  t._p = P.monSprite(vm, t.ga[0])[0];
  t._bufs = [{ h: {}, v: {} }, { h: {}, v: {} }];
  t._src = 0;
  t._scan = 1;
  t._bg = P.isMonBg(side);
  if (t._bg && t._p && t._p.visible !== false) {
    t._drawOn = true;
    t._p.visible = false;
    t.z = (side === "player") ? 199 : 99;
    t.draw = H.acidArmorDraw;
  }
  t.fn = H.acidArmorStep;
});

// Lua: g3_e3b.lua:842
H.deepInhaleStep = function (t: Task, vm: any): void {
  const d = t.data;
  const p = t._affSide != null ? P.monPresent(t._affSide) : null;
  let var0 = d[0];
  d[0] = d[0] + 1;
  var0 = P.u16(var0 - 20);
  if (var0 < 23) {
    d[1] = d[1] + 1;
    if (d[1] > 1) {
      d[1] = 0;
      d[2] = d[2] + 1;
      if (p) {
        if ((d[2] & 1) !== 0) p.ox = 1; else p.ox = -1;
      }
    }
  } else if (p) {
    p.ox = 0;
  }
  if (!H.runAffine(t, vm)) P.DestroyAnimVisualTask(t);
};

// Lua: g3_e3b.lua:864 -- pokefirered/src/battle_anim_effects_3.c:3400
T.DeepInhale = taskOf(function (t: Task, vm: any): void {
  t.data[0] = 0;
  const [, side] = P.monSprite(vm, t.ga[0]);
  H.prepareAffine(t, side, "sDeepInhaleAffineAnimCmds");
  t.fn = H.deepInhaleStep;
});

// Lua: g3_e3b.lua:871
H.yawnCloudStep = function (s: S): void {
  const d = s.data;
  d[0] = d[0] + 1;
  const index = (d[0] * 8) & 0xFF;
  d[4] = P.s16(d[4] + d[6]);
  d[5] = P.s16(d[5] + d[7]);
  s.x = P.shr(d[4], 4);
  s.y = P.shr(d[5], 4);
  s.oy = P.Sin(index, 8);
  if (d[0] > 58) {
    d[1] = d[1] + 1;
    if (d[1] > 1) {
      d[1] = 0;
      d[2] = d[2] + 1;
      s.invisible = (d[2] & 1) !== 0;
      if (d[2] > 3) P.DestroySpriteAndMatrix(s);
    }
  }
};

// Lua: g3_e3b.lua:892 -- pokefirered/src/battle_anim_effects_3.c:3459
C.YawnCloud = cbOf(function (s: S, vm: any): void {
  const d = s.data;
  const destX = s.x, destY = s.y;
  P.SetSpriteCoordsToAnimAttackerCoords(s, vm);
  P.StartSpriteAffineAnim(s, s.ga[0]);
  const startX = s.x, startY = s.y;
  d[4] = P.s16(startX * 16);
  d[5] = P.s16(startY * 16);
  d[6] = P.s16(P.div((destX - startX) * 16, 64));
  d[7] = P.s16(P.div((destY - startY) * 16, 64));
  d[0] = 0;
  s.callbackFn = H.yawnCloudStep;
});

// Lua: g3_e3b.lua:906
H.destroyAfterTimer = function (s: S): void {
  const old = s.data[0];
  s.data[0] = old - 1;
  if (old <= 0) P.DestroyAnimSprite(s);
};

// Lua: g3_e3b.lua:913 -- pokefirered/src/battle_anim_effects_3.c:3497
C.SmokeBallEscapeCloud = cbOf(function (s: S, vm: any): void {
  s.data[0] = s.ga[3];
  P.StartSpriteAffineAnim(s, s.ga[0]);
  if (!P.tgtIsPlayer(vm)) s.ga[1] = -s.ga[1];
  s.x = P.coordAtk(vm, P.COORD_X_2) + s.ga[1];
  s.y = P.coordAtk(vm, P.COORD_Y_PIC) + s.ga[2];
  s.callbackFn = H.destroyAfterTimer;
});

// Lua: g3_e3b.lua:922
H.focusBandToggle = function (t: Task): void {
  const d = t.data;
  if ((P.u16(d[6]) & 0x8000) !== 0) {
    d[1] = d[1] - 1;
    if (d[1] === -1) {
      if (d[9] === 0) {
        d[9] = d[4];
        d[4] = P.s16(-d[4]);
      } else {
        d[9] = 0;
      }
      if (d[10] === 0) {
        d[10] = d[5];
        d[5] = P.s16(-d[5]);
      } else {
        d[10] = 0;
      }
      d[1] = d[13];
    }
  }
};

// Lua: g3_e3b.lua:944
H.focusBandApply = function (t: Task, var0: number, var1: number): void {
  const d = t.data;
  const p = t._p;
  if (!p) return;
  if ((P.u16(d[2]) & 0x8000) !== 0) {
    p.ox = P.s16(d[9] - P.rshift(var0, 8));
  } else {
    p.ox = P.s16(d[9] + P.rshift(var0, 8));
  }
  if ((P.u16(d[3]) & 0x8000) !== 0) {
    p.oy = P.s16(d[10] - P.rshift(var1, 8));
  } else {
    p.oy = P.s16(d[10] + P.rshift(var1, 8));
  }
};

// Lua: g3_e3b.lua:960
H.focusBandStep2 = function (t: Task, _vm: any): void {
  const d = t.data;
  d[0] = d[0] - 1;
  H.focusBandToggle(t);
  H.focusBandApply(t, P.u16(d[7]), P.u16(d[8]));
  if (d[0] < 1) P.DestroyAnimVisualTask(t);
};

// Lua: g3_e3b.lua:968
H.focusBandStep1 = function (t: Task, _vm: any): void {
  const d = t.data;
  d[0] = d[0] - 1;
  H.focusBandToggle(t);
  const var0 = P.u16((P.u16(d[2]) & 0x7FFF) + d[7]);
  const var1 = P.u16((P.u16(d[3]) & 0x7FFF) + d[8]);
  H.focusBandApply(t, var0, var1);
  d[7] = P.s16(var0);
  d[8] = P.s16(var1);
  if (d[0] < 1) {
    d[0] = 30;
    d[13] = 0;
    t.fn = H.focusBandStep2;
  }
};

// Lua: g3_e3b.lua:985 -- pokefirered/src/battle_anim_effects_3.c:3612
T.SlideMonForFocusBand = taskOf(function (t: Task, vm: any): void {
  const d = t.data;
  const ga = t.ga;
  t._p = P.monPresent(P.atk(vm));
  d[14] = ga[0];
  d[0] = ga[0];
  d[13] = ga[6];
  if (ga[3] !== 0) d[6] = P.s16(P.u16(d[6]) | 0x8000);
  if (!P.atkIsPlayer(vm)) {
    d[2] = ga[1];
    d[3] = ga[2];
  } else {
    if ((P.u16(ga[1]) & 0x8000) !== 0) {
      d[2] = P.u16(ga[1]) & 0x7FFF;
    } else {
      d[2] = P.s16(P.u16(ga[1]) | 0x8000);
    }
    if ((P.u16(ga[2]) & 0x8000) !== 0) {
      d[3] = P.u16(ga[2]) & 0x7FFF;
    } else {
      d[3] = P.s16(P.u16(ga[2]) | 0x8000);
    }
  }
  d[8] = 0;
  d[7] = 0;
  d[4] = ga[4];
  d[5] = ga[5];
  t.fn = H.focusBandStep1;
});

// Lua: g3_e3b.lua:1015
H.facadeSweatDrop = function (s: S): void {
  const d = s.data;
  s.x = s.x + d[1];
  s.y = s.y + d[2];
  d[0] = d[0] + 1;
  if (d[0] > 6) {
    const task = s.task;
    if (task) task.data[d[4]] = task.data[d[4]] - 1;
    P.DestroyAnimSprite(s);
  }
};

// Lua: g3_e3b.lua:1028 -- pokefirered/src/battle_anim_effects_3.c:3773
C.FacadeSweatDrop = cbOf(H.facadeSweatDrop);

// Lua: g3_e3b.lua:1030
H.createSweatDroplets = function (t: Task, vm: any, lower: boolean): void {
  const d = t.data;
  let xOffset: number, yOffset: number;
  if (!lower) {
    xOffset = 18; yOffset = -20;
  } else {
    xOffset = 30; yOffset = 20;
  }
  const xs = [d[4] - xOffset, d[4] - xOffset - 4, d[4] + xOffset, d[4] + xOffset + 4];
  const ys = [d[5] + yOffset, d[5] + yOffset + 6];
  for (let i = 0; i <= 3; i++) {
    const s = P.CreateSprite(vm, "gFacadeSweatDropSpriteTemplate", xs[i], ys[i & 1], d[6] - 5, H.facadeSweatDrop);
    if (s) {
      s.data[0] = 0;
      s.data[1] = (i < 2) ? -2 : 2;
      s.data[2] = -1;
      s.task = t;
      s.data[4] = 2;
      d[2] = d[2] + 1;
    }
  }
};

// Lua: g3_e3b.lua:1053
H.squishStep = function (t: Task, vm: any): void {
  const d = t.data;
  if (d[0] === 0) {
    d[1] = d[1] + 1;
    if (d[1] === 6) H.createSweatDroplets(t, vm, true);
    if (d[1] === 18) H.createSweatDroplets(t, vm, false);
    if (!H.runAffine(t, vm)) {
      d[3] = d[3] - 1;
      if (d[3] === 0) {
        d[0] = d[0] + 1;
      } else {
        d[1] = 0;
        H.prepareAffine(t, t._affSide, "sFacadeSquishAffineAnimCmds");
      }
    }
  } else if (d[0] === 1) {
    if (d[2] === 0) P.DestroyAnimVisualTask(t);
  }
};

// Lua: g3_e3b.lua:1074 -- pokefirered/src/battle_anim_effects_3.c:3669
T.SquishAndSweatDroplets = taskOf(function (t: Task, vm: any): void {
  const d = t.data;
  if (t.ga[1] === 0) {
    P.DestroyAnimVisualTask(t);
    return;
  }
  d[0] = 0;
  d[1] = 0;
  d[2] = 0;
  d[3] = t.ga[1];
  const side = (t.ga[0] === P.ANIM_ATTACKER) ? P.atk(vm) : P.tgt(vm);
  d[4] = P.coord(vm, side, P.COORD_X);
  d[5] = P.coord(vm, side, P.COORD_Y);
  d[6] = P.subpriorityOf(side);
  const [, mside] = P.monSprite(vm, t.ga[0]);
  H.prepareAffine(t, mside, "sFacadeSquishAffineAnimCmds");
  t.fn = H.squishStep;
});

H.FACADE_COLORS = [
  H.rgb(28, 25, 1), H.rgb(28, 21, 5), H.rgb(27, 18, 8), H.rgb(27, 14, 11),
  H.rgb(26, 10, 15), H.rgb(26, 7, 18), H.rgb(25, 3, 21), H.rgb(25, 0, 25),
  H.rgb(25, 0, 23), H.rgb(25, 0, 20), H.rgb(25, 0, 16), H.rgb(25, 0, 13),
  H.rgb(26, 0, 10), H.rgb(26, 0, 6), H.rgb(26, 0, 3), H.rgb(27, 0, 0),
  H.rgb(27, 1, 0), H.rgb(27, 5, 0), H.rgb(27, 9, 0), H.rgb(27, 12, 0),
  H.rgb(28, 16, 0), H.rgb(28, 19, 0), H.rgb(28, 23, 0), H.rgb(29, 27, 0),
];

// Lua: g3_e3b.lua:1102
H.facadeBlendStep = function (t: Task, _vm: any): void {
  const d = t.data;
  if (d[1] !== 0) {
    P.monBlend(t._p, 8, H.FACADE_COLORS[d[0]]);
    d[0] = d[0] + 1;
    if (d[0] > 23) d[0] = 0;
    d[1] = d[1] - 1;
  } else {
    P.monBlend(t._p, 0, 0);
    P.DestroyAnimVisualTask(t);
  }
};

// Lua: g3_e3b.lua:1116 -- pokefirered/src/battle_anim_effects_3.c:3802
T.FacadeColorBlend = taskOf(function (t: Task, vm: any): void {
  t.data[0] = 0;
  t.data[1] = t.ga[1];
  t._p = P.monSprite(vm, t.ga[0])[0];
  t.fn = H.facadeBlendStep;
});

const M = { callbacks: C, tasks: T };
export default M;
