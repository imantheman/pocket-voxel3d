// Port of gen1recomp src/core/game3/battle/anim_port/g2_dragon.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered battle_anim_dragon.c on the g2_pret kit.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod } from "../../../../../import/gen3/lua.ts";
import P from "./g2_pret.ts";

type S = Record<string, any>;
type T = Record<string, any>;

const CB: Record<string, any> = {};
const TASKS: Record<string, any> = {};

// Brian's `TASKS.X = P.task(fn)` runs at require time; here the wrap is made on
// the first call (no top-level read of g2_pret inside the import cycle).
function task(entry: (t: T, vm: any) => void): (t: T, vm: any) => void {
  let w: any = null;
  return (t: T, vm: any): void => { (w ??= P.task(entry))(t, vm); };
}

// Lua: g2_dragon.lua:7 -- pokefirered/src/battle_anim_dragon.c:189
CB.OutrageFlame = function (s: S): void {
  const atk = P.atk();
  s.x = P.coord(atk, 2);
  s.y = P.coord(atk, 3);
  if (atk !== "player") {
    s.x = s.x - P.arg(0);
    P.setArg(3, -P.arg(3));
    P.setArg(4, -P.arg(4));
  } else {
    s.x = s.x + P.arg(0);
  }
  s.y = s.y + P.arg(1);
  s.data[0] = P.arg(2);
  s.data[1] = P.arg(3);
  s.data[3] = P.arg(4);
  s.data[5] = P.arg(5);
  s.invisible = true;
  P.storeCallback(s, P.DestroySpriteAndMatrix);
  s.pcb = P.TranslateSpriteLinearAndFlicker;
};

// Lua: g2_dragon.lua:29 -- pokefirered/src/battle_anim_dragon.c:213
function start_dragon_fire_translation(s: S): void {
  P.SetSpriteCoordsToAnimAttackerCoords(s);
  s.data[2] = P.coord(P.tgt(), 2);
  s.data[4] = P.coord(P.tgt(), 3);
  if (P.atk() !== "player") {
    s.x = s.x - P.arg(1);
    s.y = s.y + P.arg(1);
    s.data[2] = s.data[2] - P.arg(2);
    s.data[4] = s.data[4] + P.arg(3);
  } else {
    s.x = s.x + P.arg(0);
    s.y = s.y + P.arg(1);
    s.data[2] = s.data[2] + P.arg(2);
    s.data[4] = s.data[4] + P.arg(3);
    P.startAnim(s, 1);
  }
  s.data[0] = P.arg(4);
  s.pcb = P.StartAnimLinearTranslation;
  P.storeCallback(s, P.DestroySpriteAndMatrix);
}

// Lua: g2_dragon.lua:51 -- pokefirered/src/battle_anim_dragon.c:238
CB.DragonRageFirePlume = function (s: S): void {
  if (P.arg(0) === 0) {
    s.x = P.coord(P.atk(), 0);
    s.y = P.coord(P.atk(), 1);
  } else {
    s.x = P.coord(P.tgt(), 0);
    s.y = P.coord(P.tgt(), 1);
  }
  P.SetAnimSpriteInitialXOffset(s, P.arg(1));
  s.y = s.y + P.arg(2);
  s.pcb = P.RunStoredCallbackWhenAnimEnds;
  P.storeCallback(s, P.DestroySpriteAndMatrix);
};

// Lua: g2_dragon.lua:66 -- pokefirered/src/battle_anim_dragon.c:257
CB.DragonFireToTarget = function (s: S): void {
  if (P.atk() !== "player") P.startAffineAnim(s, 1);
  start_dragon_fire_translation(s);
};

// Lua: g2_dragon.lua:71
function dragon_dance_orb_step(s: S): void {
  const d = s.data;
  if (d[0] === 0) {
    d[6] = mod(d[6] - d[5], 256);
    s.x2 = P.Cos(d[6], d[7]);
    s.y2 = P.Sin(d[6], d[7]);
    d[4] = d[4] + 1;
    if (d[4] > 5) {
      d[4] = 0;
      if (d[5] <= 15) {
        d[5] = d[5] + 1;
        if (d[5] > 15) d[5] = 16;
      }
    }
    d[3] = d[3] + 1;
    if (d[3] > 0x3C) {
      d[3] = 0;
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 1) {
    d[6] = mod(d[6] - d[5], 256);
    if (d[7] <= 0x95) {
      d[7] = d[7] + 8;
      if (d[7] > 0x95) d[7] = 0x96;
    }
    s.x2 = P.Cos(d[6], d[7]);
    s.y2 = P.Sin(d[6], d[7]);
    d[4] = d[4] + 1;
    if (d[4] > 5) {
      d[4] = 0;
      if (d[5] <= 15) {
        d[5] = d[5] + 1;
        if (d[5] > 15) d[5] = 16;
      }
    }
    d[3] = d[3] + 1;
    if (d[3] > 20) P.destroy(s);
  }
}

// Lua: g2_dragon.lua:112 -- pokefirered/src/battle_anim_dragon.c:264
CB.DragonDanceOrb = function (s: S): void {
  const atk = P.atk();
  s.x = P.coord(atk, 2);
  s.y = P.coord(atk, 3);
  s.data[4] = 0;
  s.data[5] = 1;
  s.data[6] = P.arg(0);
  const r5 = P.coordAttr(atk, P.ATTR_HEIGHT);
  const r0 = P.coordAttr(atk, P.ATTR_WIDTH);
  if (r5 > r0) {
    s.data[7] = P.div(r5, 2);
  } else {
    s.data[7] = P.div(r0, 2);
  }
  s.x2 = P.Cos(s.data[6], s.data[7]);
  s.y2 = P.Sin(s.data[6], s.data[7]);
  s.pcb = dragon_dance_orb_step;
};

// Lua: g2_dragon.lua:132 -- pokefirered/src/battle_anim_dragon.c:398
function update_dragon_dance_scanline(t: T): void {
  const g2 = t.g2;
  let r3 = t.data[5];
  const shift = g2.shift;
  for (let i = t.data[3]; i <= t.data[4]; i++) {
    shift[i] = -(P.asr(P.sine(r3) * t.data[6], 7) + t.data[2]);
    r3 = mod(r3 + 8, 256);
  }
  t.data[5] = mod(t.data[5] + 9, 256);
}

// Lua: g2_dragon.lua:143
function dragon_dance_waver_step(t: T): void {
  const d = t.data;
  if (d[0] === 0) {
    d[7] = d[7] + 1;
    if (d[7] > 1) {
      d[7] = 0;
      d[6] = d[6] + 1;
      if (d[6] === 3) d[0] = d[0] + 1;
    }
    update_dragon_dance_scanline(t);
  } else if (d[0] === 1) {
    d[1] = d[1] + 1;
    if (d[1] > 0x3C) d[0] = d[0] + 1;
    update_dragon_dance_scanline(t);
  } else if (d[0] === 2) {
    d[7] = d[7] + 1;
    if (d[7] > 1) {
      d[7] = 0;
      d[6] = d[6] - 1;
      if (d[6] === 0) d[0] = d[0] + 1;
    }
    update_dragon_dance_scanline(t);
  } else if (d[0] === 3) {
    const p = t.g2.p;
    if (p && p.hShift === t.g2.shift) p.hShift = null;
    d[0] = d[0] + 1;
  } else if (d[0] === 4) {
    P.destroyTask(t);
  }
}

// Lua: g2_dragon.lua:175 -- pokefirered/src/battle_anim_dragon.c:325
TASKS.DragonDanceWaver = task(function (t: T): void {
  const atk = P.atk();
  t.data[2] = 0;
  const r1 = P.yWithElevation(atk);
  t.data[3] = r1 - 32;
  t.data[4] = r1 + 32;
  if (t.data[3] < 0) t.data[3] = 0;
  const shift: number[] = [];
  for (let i = t.data[3]; i <= t.data[4]; i++) shift[i] = t.data[2];
  t.g2.shift = shift;
  const p = P.present(atk);
  t.g2.p = p;
  if (p) p.hShift = shift;
  t.func = dragon_dance_waver_step;
});

// Lua: g2_dragon.lua:191
function overheat_flame_step(s: S): void {
  const d = s.data;
  d[4] = d[4] + d[1];
  d[5] = d[5] + d[2];
  s.x2 = P.div(d[4], 10);
  s.y2 = P.div(d[5], 10);
  d[0] = d[0] + 1;
  if (d[0] > d[3]) P.destroy(s);
}

// Lua: g2_dragon.lua:202 -- pokefirered/src/battle_anim_dragon.c:410
CB.OverheatFlame = function (s: S): void {
  const yAmplitude = P.div(P.arg(2) * 3, 5);
  const atk = P.atk();
  s.x = P.coord(atk, 2);
  s.y = P.coord(atk, 3) + P.arg(4);
  s.data[1] = P.Cos(P.arg(1), P.arg(2));
  s.data[2] = P.Sin(P.arg(1), yAmplitude);
  s.x = s.x + s.data[1] * P.arg(0);
  s.y = s.y + s.data[2] * P.arg(0);
  s.data[3] = P.arg(3);
  s.pcb = overheat_flame_step;
};

// Lua: g2_dragon.lua:215
export const G2Dragon = { cb: CB, tasks: TASKS };
export default G2Dragon;
