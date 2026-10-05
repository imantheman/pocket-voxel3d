// Port of gen1recomp src/core/game3/battle/anim_port/g3_dark.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered battle_anim_dark.c on the g3_pret kit.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, truthy } from "../../../../../import/gen3/lua.ts";
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

// Lua: g3_dark.lua:4 -- local band, rshift = P.band, P.rshift
const band = (a: number, b: number): number => P.band(a, b);
const rshift = (a: number, n: number): number => P.rshift(a, n);

// Lua: g3_dark.lua:6
function attackerFadeToInvisibleStep(t: Tk, vm: any): void {
  const d = t.data;
  let blendA = P.u8(rshift(P.u16(d[1]), 8));
  let blendB = P.u8(d[1]);
  if (d[2] === P.u8(d[0])) {
    blendA = P.u8(blendA + 1);
    blendB = P.u8(blendB - 1);
    d[1] = P.s16(blendB + blendA * 256);
    P.setBld(vm, blendB, blendA);
    const p = t._p;
    if (p && P.isMonBg(t._side)) p.alpha = P.bldAlphaValue(vm);
    d[2] = 0;
    if (blendA === 16) {
      if (p) {
        p.visible = false;
        p.alpha = 1;
      }
      P.DestroyAnimVisualTask(t);
    }
  } else {
    d[2] = d[2] + 1;
  }
}

// Lua: g3_dark.lua:31 -- pokefirered/src/battle_anim_dark.c:187
T.AttackerFadeToInvisible = task(function (t: Tk, vm: any): void {
  const d = t.data;
  d[0] = t.ga[0];
  t._side = P.atk(vm);
  t._p = P.monPresent(t._side);
  d[1] = 16;
  P.setBld(vm, 16, 0);
  if (t._p && P.isMonBg(t._side)) t._p.alpha = P.bldAlphaValue(vm);
  t.fn = attackerFadeToInvisibleStep;
});

// Lua: g3_dark.lua:42
function attackerFadeFromInvisibleStep(t: Tk, vm: any): void {
  const d = t.data;
  let blendA = P.u8(rshift(P.u16(d[1]), 8));
  let blendB = P.u8(d[1]);
  if (d[2] === P.u8(d[0])) {
    blendA = P.u8(blendA - 1);
    blendB = P.u8(blendB + 1);
    d[1] = P.s16(blendA * 256 + blendB);
    P.setBld(vm, blendB, blendA);
    const p = t._p;
    if (p) p.alpha = P.bldAlphaValue(vm);
    d[2] = 0;
    if (blendA === 0) {
      P.setBld(vm, null);
      if (p) {
        p.visible = true;
        p.alpha = 1;
      }
      P.DestroyAnimVisualTask(t);
    }
  } else {
    d[2] = d[2] + 1;
  }
}

// Lua: g3_dark.lua:68 -- pokefirered/src/battle_anim_dark.c:226
T.AttackerFadeFromInvisible = task(function (t: Tk, vm: any): void {
  const d = t.data;
  d[0] = t.ga[0];
  d[1] = 0x1000;
  t._side = P.atk(vm);
  t._p = P.monPresent(t._side);
  t.fn = attackerFadeFromInvisibleStep;
  P.setBld(vm, 0, 16);
  if (t._p) {
    t._p.visible = true;
    t._p.alpha = P.bldAlphaValue(vm);
  }
});

// Lua: g3_dark.lua:83 -- pokefirered/src/battle_anim_dark.c:259
T.InitAttackerFadeFromInvisible = task(function (t: Tk, vm: any): void {
  P.setBld(vm, 0, 16);
  const p = P.monPresent(P.atk(vm));
  if (p) {
    p.visible = true;
    p.alpha = P.bldAlphaValue(vm);
  }
  P.DestroyAnimVisualTask(t);
});

// Lua: g3_dark.lua:93
function biteStep2(s: S): void {
  const d = s.data;
  d[4] = P.s16(d[4] - d[0]);
  d[5] = P.s16(d[5] - d[1]);
  s.ox = P.shr(d[4], 8);
  s.oy = P.shr(d[5], 8);
  d[3] = d[3] - 1;
  if (d[3] === 0) P.DestroySpriteAndMatrix(s);
}

// Lua: g3_dark.lua:103
function biteStep1(s: S): void {
  const d = s.data;
  d[4] = P.s16(d[4] + d[0]);
  d[5] = P.s16(d[5] + d[1]);
  s.ox = P.shr(d[4], 8);
  s.oy = P.shr(d[5], 8);
  d[3] = d[3] + 1;
  if (d[3] === d[2]) s.callbackFn = biteStep2;
}

// Lua: g3_dark.lua:114 -- pokefirered/src/battle_anim_dark.c:311
C.Bite = cb(function (s: S, _vm: any): void {
  s.x = s.x + s.ga[0];
  s.y = s.y + s.ga[1];
  P.StartSpriteAffineAnim(s, s.ga[2]);
  s.data[0] = s.ga[3];
  s.data[1] = s.ga[4];
  s.data[2] = s.ga[5];
  s.callbackFn = biteStep1;
});

// Lua: g3_dark.lua:124
function tearDropStep(s: S): void {
  if (P.TranslateAnimHorizontalArc(s)) P.DestroySpriteAndMatrix(s);
}

// Lua: g3_dark.lua:129 -- pokefirered/src/battle_anim_dark.c:343
C.TearDrop = cb(function (s: S, vm: any): void {
  const side = (s.ga[0] === P.ANIM_ATTACKER) ? P.atk(vm) : P.tgt(vm);
  let xOffset = 20;
  s.imageValue = s.imageValue + 4;
  const a = s.ga[1];
  if (a === 0) {
    s.x = P.coordAttr(vm, side, P.ATTR_RIGHT) - 8;
    s.y = P.coordAttr(vm, side, P.ATTR_TOP) + 8;
  } else if (a === 1) {
    s.x = P.coordAttr(vm, side, P.ATTR_RIGHT) - 14;
    s.y = P.coordAttr(vm, side, P.ATTR_TOP) + 16;
  } else if (a === 2) {
    s.x = P.coordAttr(vm, side, P.ATTR_LEFT) + 8;
    s.y = P.coordAttr(vm, side, P.ATTR_TOP) + 8;
    P.StartSpriteAffineAnim(s, 1);
    xOffset = -20;
  } else if (a === 3) {
    s.x = P.coordAttr(vm, side, P.ATTR_LEFT) + 14;
    s.y = P.coordAttr(vm, side, P.ATTR_TOP) + 16;
    P.StartSpriteAffineAnim(s, 1);
    xOffset = -20;
  }
  s.data[0] = 32;
  s.data[2] = s.x + xOffset;
  s.data[4] = s.y + 12;
  s.data[5] = -12;
  P.InitAnimArcTranslation(s);
  s.callbackFn = tearDropStep;
});

// Lua: g3_dark.lua:159
let rowQuad: any = null;

// Lua: g3_dark.lua:161
function mementoDraw(t: Tk): void {
  // (Brian's `if not (love and love.graphics) then return end`: the platform always has graphics.)
  const d = t.data;
  const img = t._img;
  if (!img || !t._map) return;
  const wl = d[14], wr = d[15];
  if (wr <= wl) return;
  const b = t._vm ? t._vm.bldAlpha : null;
  let evb = b ? (b.evb ?? b[2]) ?? 0 : 0;
  if (evb > 16) evb = 16;
  const a = 1 - evb / 16;
  if (a <= 0) return;
  const [iw, ih] = img.getDimensions();
  const left = t._picLeft;
  const xa = Math.max(left, wl, 0);
  const xb = Math.min(left + iw, wr, 240);
  if (xb <= xa) return;
  if (!rowQuad) rowQuad = G.newQuad(0, 0, 1, 1, iw, ih);
  const flip = t._flip;
  G.setColor(0, 0, 0, a);
  for (let i = 0; i <= 111; i++) {
    const src = t._map[i];
    if (src != null && src !== false) {
      const r = src - t._picTop;
      if (r >= 0 && r < ih) {
        if (flip) {
          rowQuad.setViewport(iw - (xb - left), r, xb - xa, 1, iw, ih);
          G.draw(img, rowQuad, xb, i, 0, -1, 1);
        } else {
          rowQuad.setViewport(xa - left, r, xb - xa, 1, iw, ih);
          G.draw(img, rowQuad, xa, i);
        }
      }
    }
  }
  G.setColor(1, 1, 1, 1);
}

// Lua: g3_dark.lua:199
function doMementoShadowEffect(t: Tk): void {
  const d = t.data;
  const map = t._map;
  const var2 = P.s16(d[5] - d[4]);
  if (var2 !== 0) {
    const var0 = P.div(d[13], var2);
    let var1 = d[6] * 256;
    let i = 0;
    while (i < d[4]) {
      if (map) map[i] = false;
      i = i + 1;
    }
    i = d[4];
    while (i <= d[5]) {
      if (i >= 0 && map) map[i] = P.s16(P.shr(var1, 8));
      var1 = var1 + var0;
      i = i + 1;
    }
    while (i < d[7]) {
      if (i >= 0 && map) map[i] = false;
      i = i + 1;
    }
  } else if (map) {
    for (let i = 0; i <= 111; i++) map[i] = false;
  }
}

// Lua: g3_dark.lua:226
function mementoSetup(t: Tk, vm: any, side: any): void {
  t._vm = vm;
  t._img = P.monImage(vm, side);
  const p = P.monPresent(side);
  const [cx, cy] = P.monCenter(vm, side);
  t._picLeft = Math.floor(cx + 0.5) - 32;
  t._picTop = Math.floor(cy + 0.5) - 32;
  t._flip = (p && truthy(p.hFlip)) ? true : false;
}

// Lua: g3_dark.lua:236
function moveAttackerMementoShadowStep(t: Tk, vm: any): void {
  const d = t.data;
  const k = d[0];
  if (k === 0) {
    d[1] = d[1] + 1;
    if (d[1] > 1) {
      d[1] = 0;
      d[2] = d[2] + 1;
      if (band(d[2], 1) !== 0) {
        if (d[11] !== 12) d[11] = d[11] + 1;
      } else if (d[12] !== 8) {
        d[12] = d[12] - 1;
      }
      P.setBld(vm, d[11], d[12]);
      if (d[11] === 12 && d[12] === 8) d[0] = d[0] + 1;
    }
  } else if (k === 1) {
    d[4] = d[4] - 8;
    doMementoShadowEffect(t);
    if (d[4] < d[8]) d[0] = d[0] + 1;
  } else if (k === 2) {
    d[4] = d[4] - 8;
    doMementoShadowEffect(t);
    d[14] = d[14] + 4;
    d[15] = d[15] - 4;
    if (d[14] >= d[15]) d[14] = d[15];
    if (d[14] === d[15]) d[0] = d[0] + 1;
  } else if (k === 3) {
    t._map = null;
    d[0] = d[0] + 1;
  } else if (k === 4) {
    t.draw = null;
    P.DestroyAnimVisualTask(t);
  }
}

// Lua: g3_dark.lua:273 -- pokefirered/src/battle_anim_dark.c:391
T.MoveAttackerMementoShadow = task(function (t: Tk, vm: any): void {
  const d = t.data;
  const side = P.atk(vm);
  d[7] = P.coord(vm, side, P.COORD_Y) + 31;
  d[6] = P.coordAttr(vm, side, P.ATTR_TOP) - 7;
  d[5] = d[7];
  d[4] = d[6];
  d[13] = P.s16((d[7] - d[6]) * 256);
  const pos = P.u8(P.coord(vm, side, P.COORD_X));
  d[14] = pos - 32;
  d[15] = pos + 32;
  if (P.isPlayer(side)) d[8] = -12; else d[8] = -64;
  d[3] = P.isPlayer(side) ? 2 : 1;
  d[10] = 0;
  d[11] = 0;
  d[12] = 16;
  d[0] = 0;
  d[1] = 0;
  d[2] = 0;
  mementoSetup(t, vm, side);
  t._map = [] as any[];
  for (let i = 0; i <= 111; i++) t._map[i] = i;
  t.z = 205;
  t.draw = mementoDraw;
  t.fn = moveAttackerMementoShadowStep;
});

// Lua: g3_dark.lua:300
function moveTargetMementoShadowStep(t: Tk, vm: any): void {
  const d = t.data;
  const k = d[0];
  if (k === 0) {
    d[5] = d[5] + 8;
    if (d[5] >= d[7]) d[5] = d[7];
    doMementoShadowEffect(t);
    if (d[5] === d[7]) d[0] = d[0] + 1;
  } else if (k === 1) {
    if (d[15] - d[14] < 0x40) {
      d[14] = d[14] - 4;
      d[15] = d[15] + 4;
    } else {
      d[1] = 1;
    }
    d[4] = d[4] + 8;
    if (d[4] >= d[6]) d[4] = d[6];
    doMementoShadowEffect(t);
    if (d[4] === d[6] && d[1] !== 0) {
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (k === 2) {
    d[1] = d[1] + 1;
    if (d[1] > 1) {
      d[1] = 0;
      d[2] = d[2] + 1;
      if (band(d[2], 1) !== 0) {
        if (d[11] !== 0) d[11] = d[11] - 1;
      } else if (d[12] < 16) {
        d[12] = d[12] + 1;
      }
      P.setBld(vm, d[11], d[12]);
      if (d[11] === 0 && d[12] === 16) d[0] = d[0] + 1;
    }
  } else if (k === 3) {
    t._map = null;
    d[0] = d[0] + 1;
  } else if (k === 4) {
    t.draw = null;
    P.DestroyAnimVisualTask(t);
  }
}

// Lua: g3_dark.lua:345 -- pokefirered/src/battle_anim_dark.c:508
T.MoveTargetMementoShadow = task(function (t: Tk, vm: any): void {
  const d = t.data;
  const side = P.tgt(vm);
  const k = d[0];
  if (k === 0) {
    d[3] = P.isPlayer(side) ? 2 : 1;
    d[0] = d[0] + 1;
  } else if (k === 1) {
    d[10] = 0;
    d[0] = d[0] + 1;
  } else if (k === 2) {
    d[7] = P.coord(vm, side, P.COORD_Y) + 31;
    d[6] = P.coordAttr(vm, side, P.ATTR_TOP) - 7;
    d[13] = P.s16((d[7] - d[6]) * 256);
    const x = P.u8(P.coord(vm, side, P.COORD_X));
    d[14] = x - 4;
    d[15] = x + 4;
    if (P.isPlayer(side)) d[8] = -12; else d[8] = -64;
    d[4] = d[8];
    d[5] = d[8];
    d[11] = 12;
    d[12] = 8;
    d[0] = d[0] + 1;
  } else if (k === 3) {
    d[0] = d[0] + 1;
  } else if (k === 4) {
    d[0] = 0;
    d[1] = 0;
    d[2] = 0;
    P.setBld(vm, 12, 8);
    t.fn = moveTargetMementoShadowStep;
  }
});

// Lua: g3_dark.lua:380 -- pokefirered/src/battle_anim_dark.c:729
T.InitMementoShadow = task(function (t: Tk, vm: any): void {
  const p = P.monPresent(P.atk(vm));
  if (p) p.visible = true;
  P.DestroyAnimVisualTask(t);
});

// Lua: g3_dark.lua:387 -- pokefirered/src/battle_anim_dark.c:743
T.MementoHandleBg = task(function (t: Tk, _vm: any): void {
  P.DestroyAnimVisualTask(t);
});

// Lua: g3_dark.lua:392 -- pokefirered/src/battle_anim_dark.c:754
C.ClawSlash = cb(function (s: S, _vm: any): void {
  s.x = s.x + s.ga[0];
  s.y = s.y + s.ga[1];
  P.StartSpriteAnim(s, s.ga[2]);
  s.callbackFn = P.RunStoredCallbackWhenAnimEnds;
  P.StoreSpriteCallbackInData6(s, P.DestroyAnimSprite);
});

// Lua: g3_dark.lua:400
function setGreyscaleOrOriginal(p: any, restore: boolean): void {
  if (!p) return;
  if (restore) {
    p.grayscale = false;
    P.monBlend(p, 0, 0);
  } else {
    p.grayscale = true;
  }
}

// Lua: g3_dark.lua:410 -- { [4] = 0, [5] = 2, [6] = 1, [7] = 3 }
const POSITION_ID: Record<number, number> = { 4: 0, 5: 2, 6: 1, 7: 3 };

// Lua: g3_dark.lua:413 -- pokefirered/src/battle_anim_dark.c:869
T.SetGrayscaleOrOriginalPal = task(function (t: Tk, vm: any): void {
  const a = t.ga[0];
  let p: any = null;
  if (a >= 0 && a <= 3) {
    p = P.monSprite(vm, a)[0];
  } else if (a >= 4 && a <= 7) {
    const id = POSITION_ID[a];
    // require("src.core.game3.battle.anim_coords"): a static import
    const ok = id != null && (id < 2 || AnimCoords.spritePresent(null, id));
    if (ok && !P.monHidden(vm, id)) p = P.monPresent(id);
  }
  if (p) setGreyscaleOrOriginal(p, t.ga[1] !== 0);
  P.DestroyAnimVisualTask(t);
});

// Lua: g3_dark.lua:428 -- pokefirered/src/battle_anim_dark.c:916
T.GetIsDoomDesireHitTurn = task(function (t: Tk, vm: any): void {
  const turn = tonumber(vm ? vm._turn : null) ?? 0;
  if (turn < 2) P.setRet(vm, 0);
  if (turn === 2) P.setRet(vm, 1);
  P.DestroyAnimVisualTask(t);
});

// Lua: g3_dark.lua:435
export const G3Dark = { callbacks: C, tasks: T };
export default G3Dark;
