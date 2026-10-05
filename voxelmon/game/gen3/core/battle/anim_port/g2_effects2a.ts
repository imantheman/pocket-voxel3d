// Port of gen1recomp src/core/game3/battle/anim_port/g2_effects2a.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered battle_anim_effects_2.c (first part) on the g2_pret kit.

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

// Lua: g2_effects2a.lua:6 -- local band, bor, bxor = bit.band, bit.bor, bit.bxor
const band = (a: number, b: number): number => a & b;
const bor = (a: number, b: number): number => a | b;
const bxor = (a: number, b: number): number => a ^ b;
const bnot = (a: number): number => ~a;

// `vm and vm.adjustPanning and vm:adjustPanning(p) or p`
function vm_pan(p: number): number {
  const vm = P.vm;
  const r = (vm && vm.adjustPanning) ? vm.adjustPanning(p) : null;
  return (r != null && r !== false) ? r : p;
}

// Lua: g2_effects2a.lua:8
function withdraw_step(t: T): void {
  const m = t.g2.mon;
  const d = t.data;
  let rotation: number;
  if (P.atk() === "player") rotation = -d[0]; else rotation = d[0];
  P.setSpriteRotScale(m, 0x100, 0x100, rotation);
  if (d[1] === 0) {
    d[0] = P.s16(d[0] + 0xB0);
    m.y2 = m.y2 + 1;
  } else if (d[1] === 1) {
    d[3] = d[3] + 1;
    if (d[3] === 30) d[1] = 2;
    return;
  } else {
    d[0] = P.s16(d[0] - 0xB0);
    m.y2 = m.y2 - 1;
  }
  P.setYOffsetFromRotation(m);
  if (d[0] === 0xF20 || d[0] === 0) {
    if (d[1] === 2) {
      P.resetSpriteRotScale(m);
      P.destroyTask(t);
    } else {
      d[1] = d[1] + 1;
    }
  }
}

// Lua: g2_effects2a.lua:37 -- pokefirered/src/battle_anim_effects_2.c:1377
TASKS.Withdraw = task(function (t: T): void {
  const m = P.mon(P.atk());
  if (!m) { P.destroyTask(t); return; }
  t.g2.mon = m;
  t.func = withdraw_step;
});

// Lua: g2_effects2a.lua:45 -- pokefirered/src/battle_anim_effects_2.c:1433
CB.KinesisZapEnergy = function (s: S): void {
  P.SetSpriteCoordsToAnimAttackerCoords(s);
  if (P.atk() !== "player") {
    s.x = s.x - P.arg(0);
  } else {
    s.x = s.x + P.arg(0);
  }
  s.y = s.y + P.arg(1);
  if (P.atk() !== "player") {
    s.pHFlip = true;
    if (P.arg(2) !== 0) s.pVFlip = true;
  } else {
    if (P.arg(2) !== 0) s.pVFlip = true;
  }
  s.pcb = P.RunStoredCallbackWhenAnimEnds;
  P.storeCallback(s, P.DestroyAnimSprite);
};

// Lua: g2_effects2a.lua:63
function swords_dance_step(s: S): void {
  s.data[0] = 6;
  s.data[2] = s.x;
  s.data[4] = s.y - 32;
  s.pcb = P.StartAnimLinearTranslation;
  P.storeCallback(s, P.DestroyAnimSprite);
}

// Lua: g2_effects2a.lua:72 -- pokefirered/src/battle_anim_effects_2.c:1461
CB.SwordsDanceBlade = function (s: S): void {
  P.InitSpritePosToAnimAttacker(s, false);
  s.pcb = P.RunStoredCallbackWhenAffineAnimEnds;
  P.storeCallback(s, swords_dance_step);
};

// Lua: g2_effects2a.lua:79 -- pokefirered/src/battle_anim_effects_2.c:1484
CB.SonicBoomProjectile = function (s: S): void {
  if (P.atk() !== "player") {
    P.setArg(2, -P.arg(2));
    P.setArg(1, -P.arg(1));
    P.setArg(3, -P.arg(3));
  }
  P.InitSpritePosToAnimAttacker(s, true);
  const tx = P.s16(P.coord(P.tgt(), 2) + P.arg(2));
  const ty = P.s16(P.coord(P.tgt(), 3) + P.arg(3));
  let rotation = P.ArcTan2Neg(tx - s.x, ty - s.y);
  rotation = P.u16(rotation + 0xF000);
  P.trySetRotScale(s, false, 0x100, 0x100, rotation);
  s.data[0] = P.arg(4);
  s.data[2] = tx;
  s.data[4] = ty;
  s.pcb = P.StartAnimLinearTranslation;
  P.storeCallback(s, P.DestroyAnimSprite);
};

// Lua: g2_effects2a.lua:98
function air_wave_pos(s: S, tk: T): void {
  if (band(tk.data[7], 1) !== 0) {
    s.x2 = -Math.floor(P.u16(s.data[1]) / 256);
  } else {
    s.x2 = Math.floor(P.u16(s.data[1]) / 256);
  }
  if (band(tk.data[8], 1) !== 0) {
    s.y2 = -Math.floor(P.u16(s.data[2]) / 256);
  } else {
    s.y2 = Math.floor(P.u16(s.data[2]) / 256);
  }
}

// Lua: g2_effects2a.lua:111
function air_wave_step2(s: S): void {
  const v = s.data[0];
  s.data[0] = v - 1;
  if (v <= 0) {
    const tk = s.g2.task;
    if (tk && tk.data) tk.data[1] = tk.data[1] - 1;
    P.destroy(s);
  }
}

// Lua: g2_effects2a.lua:121
function air_wave_step1(s: S): void {
  const tk = s.g2.task;
  const d = s.data;
  if (d[0] > tk.data[5]) {
    d[5] = P.s16(d[5] + d[3]);
    d[6] = P.s16(d[6] + d[4]);
  } else {
    d[5] = P.s16(d[5] - d[3]);
    d[6] = P.s16(d[6] - d[4]);
  }
  d[1] = P.s16(d[1] + d[5]);
  d[2] = P.s16(d[2] + d[6]);
  air_wave_pos(s, tk);
  const v = d[0];
  d[0] = v - 1;
  if (v <= 0) {
    d[0] = 30;
    s.pcb = air_wave_step2;
  }
}

// Lua: g2_effects2a.lua:143 -- pokefirered/src/battle_anim_effects_2.c:1560
CB.AirWaveProjectile = function (s: S): void {
  const tk = s.g2.task;
  const d = s.data;
  d[1] = P.s16(d[1] + band(-2, tk.data[7]));
  d[2] = P.s16(d[2] + band(-2, tk.data[8]));
  air_wave_pos(s, tk);
  const v = d[0];
  d[0] = v - 1;
  if (v <= 0) {
    d[0] = 8;
    tk.data[5] = 4;
    const a = P.Q88inv(0x1000);
    s.x = s.x + s.x2;
    s.y = s.y + s.y2;
    s.y2 = 0;
    s.x2 = 0;
    let b: number, c: number;
    if (tk.data[11] >= s.x) b = P.s16((tk.data[11] - s.x) * 256); else b = P.s16((s.x - tk.data[11]) * 256);
    if (tk.data[12] >= s.y) c = P.s16((tk.data[12] - s.y) * 256); else c = P.s16((s.y - tk.data[12]) * 256);
    d[2] = 0;
    d[1] = 0;
    d[6] = 0;
    d[5] = 0;
    d[3] = P.Q88mul(P.Q88mul(b, a), P.Q88inv(0x1C0));
    d[4] = P.Q88mul(P.Q88mul(c, a), P.Q88inv(0x1C0));
    s.pcb = air_wave_step1;
  }
};

// Lua: g2_effects2a.lua:172
function air_cutter_step2(t: T): void {
  if (t.data[1] === 0) P.destroyTask(t);
}

// Lua: g2_effects2a.lua:176
function air_cutter_step1(t: T): void {
  const d = t.data;
  const v = d[0];
  d[0] = v - 1;
  if (v <= 0) {
    const s = P.createSprite("gAirWaveProjectileSpriteTemplate", d[9], d[10], d[2] - d[1], false, false, false);
    if (s) {
      if (d[4] === 1) {
        s.pHFlip = true;
        s.pVFlip = true;
      } else if (d[4] === 2) {
        s.pHFlip = true;
        s.pVFlip = false;
      }
      s.data[0] = d[5] - d[6];
      s.g2.task = t;
      s.pcb = CB.AirWaveProjectile;
    }
    d[0] = d[3];
    d[1] = d[1] + 1;
    const pan = vm_pan(-63);
    P.playSE("SE_M_BLIZZARD2", pan);
    if (d[1] > 2) t.func = air_cutter_step2;
  }
}

// Lua: g2_effects2a.lua:204 -- pokefirered/src/battle_anim_effects_2.c:1644
TASKS.AirCutterProjectile = task(function (t: T): void {
  const d = t.data;
  if (P.tgt() === "player") {
    d[4] = 1;
    P.setArg(0, -P.arg(0));
    P.setArg(1, -P.arg(1));
    if (band(P.arg(2), 1) !== 0) {
      P.setArg(2, band(P.arg(2), bnot(1)));
    } else {
      P.setArg(2, bor(P.arg(2), 1));
    }
  }
  const ax = P.coord(P.atk(), 0);
  const ay = P.coord(P.atk(), 1);
  d[9] = ax;
  d[10] = ay;
  let tx = P.coord(P.tgt(), 0);
  let ty = P.coord(P.tgt(), 1);
  tx = P.s16(tx + P.arg(0));
  ty = P.s16(ty + P.arg(1));
  d[11] = tx;
  d[12] = ty;
  let xDiff: number;
  if (tx >= ax) xDiff = tx - ax; else xDiff = ax - tx;
  d[5] = P.Q88mul(xDiff, P.Q88inv(band(P.arg(2), bnot(1))));
  d[6] = P.Q88mul(d[5], 0x80);
  d[7] = P.arg(2);
  if (ty >= ay) {
    const yDiff = ty - ay;
    d[8] = band(P.Q88mul(yDiff, P.Q88inv(d[5])), bnot(1));
  } else {
    const yDiff = ay - ty;
    d[8] = bor(P.Q88mul(yDiff, P.Q88inv(d[5])), 1);
  }
  d[3] = P.arg(3);
  let a4 = P.arg(4);
  if (band(a4, 0x80) !== 0) {
    a4 = bxor(a4, 0x80);
    P.setArg(4, a4);
  }
  if (a4 >= 64) {
    d[2] = P.u16(P.subpriorityOf(P.tgt()) + (a4 - 64));
  } else {
    d[2] = P.u16(P.subpriorityOf(P.tgt()) - a4);
  }
  if (d[2] < 3) d[2] = 3;
  t.func = air_cutter_step1;
});

// Lua: g2_effects2a.lua:254 -- pokefirered/src/battle_anim_effects_2.c:1771
CB.CoinThrow = function (s: S): void {
  P.InitSpritePosToAnimAttacker(s, true);
  let r6 = P.coord(P.tgt(), 2);
  const r7 = P.s16(P.coord(P.tgt(), 3) + P.arg(3));
  if (P.atk() !== "player") P.setArg(2, -P.arg(2));
  r6 = P.s16(r6 + P.arg(2));
  let v = P.ArcTan2Neg(r6 - s.x, r7 - s.y);
  v = P.u16(v + 0xC000);
  P.trySetRotScale(s, false, 0x100, 0x100, v);
  s.data[0] = P.arg(4);
  s.data[2] = r6;
  s.data[4] = r7;
  s.pcb = P.InitAnimLinearTranslationWithSpeedAndPos;
  P.storeCallback(s, P.DestroyAnimSprite);
};

// Lua: g2_effects2a.lua:270
function falling_coin_step(s: S): void {
  s.data[0] = P.s16(s.data[0] + 0x80);
  s.x2 = P.asr(s.data[0], 8);
  if (P.atk() === "player") s.x2 = -s.x2;
  s.y2 = P.Sin(s.data[1], s.data[2]);
  s.data[1] = s.data[1] + 5;
  if (s.data[1] > 126) {
    s.data[1] = 0;
    s.data[2] = P.div(s.data[2], 2);
    s.data[3] = s.data[3] + 1;
    if (s.data[3] === 2) P.destroy(s);
  }
}

// Lua: g2_effects2a.lua:285 -- pokefirered/src/battle_anim_effects_2.c:1794
CB.FallingCoin = function (s: S): void {
  s.data[2] = -16;
  s.y = s.y + 8;
  s.pcb = falling_coin_step;
};

// Lua: g2_effects2a.lua:291
function bullet_seed_step2(s: S): void {
  s.data[0] = P.s16(s.data[0] + s.data[7]);
  s.x2 = P.asr(s.data[0], 8);
  if (band(s.data[7], 1) !== 0) s.x2 = -s.x2;
  s.y2 = P.Sin(s.data[1], s.data[6]);
  s.data[1] = s.data[1] + 8;
  if (s.data[1] > 126) {
    s.data[1] = 0;
    s.data[2] = P.div(s.data[2], 2);
    s.data[3] = s.data[3] + 1;
    if (s.data[3] === 1) P.destroy(s);
  }
}

// Lua: g2_effects2a.lua:305
function bullet_seed_step1(s: S): void {
  const pan = vm_pan(63);
  P.playSE("SE_M_HORN_ATTACK", pan);
  s.x = s.x + s.x2;
  s.y = s.y + s.y2;
  s.y2 = 0;
  s.x2 = 0;
  for (let i = 0; i <= 7; i++) s.data[i] = 0;
  let rand = P.Random();
  s.data[6] = P.s16(0xFFF4 - band(rand, 7));
  rand = P.Random();
  s.data[7] = mod(rand, 0xA0) + 0xA0;
  s.pcb = bullet_seed_step2;
  s.affineAnimPaused = false;
}

// Lua: g2_effects2a.lua:323 -- pokefirered/src/battle_anim_effects_2.c:1819
CB.BulletSeed = function (s: S): void {
  P.InitSpritePosToAnimAttacker(s, true);
  s.data[0] = 20;
  s.data[2] = P.coord(P.tgt(), 2);
  s.data[4] = P.coord(P.tgt(), 3);
  s.pcb = P.StartAnimLinearTranslation;
  s.affineAnimPaused = true;
  P.storeCallback(s, bullet_seed_step1);
};

// Lua: g2_effects2a.lua:334 -- pokefirered/src/battle_anim_effects_2.c:1879
CB.RazorWindTornado = function (s: S): void {
  P.InitSpritePosToAnimAttacker(s, false);
  if (P.atk() === "player") s.y = s.y + 16;
  s.data[0] = P.arg(4);
  s.data[1] = P.arg(2);
  s.data[2] = P.arg(5);
  s.data[3] = P.arg(6);
  s.data[4] = P.arg(3);
  s.pcb = P.TranslateSpriteInCircle;
  P.storeCallback(s, P.DestroyAnimSprite);
  s.pcb(s);
};

// Lua: g2_effects2a.lua:347
function vice_grip_step(s: S): void {
  if (s.animEnded) P.destroy(s);
}

// Lua: g2_effects2a.lua:352 -- pokefirered/src/battle_anim_effects_2.c:1897
CB.ViceGripPincer = function (s: S): void {
  let sx = 32, sy = -32, ex = 16, ey = -16;
  if (P.arg(0) !== 0) {
    sx = -32; sy = 32; ex = -16; ey = 16;
    P.startAnim(s, 1);
  }
  s.x = s.x + sx;
  s.y = s.y + sy;
  s.data[0] = 6;
  s.data[2] = P.coord(P.tgt(), 2) + ex;
  s.data[4] = P.coord(P.tgt(), 3) + ey;
  s.pcb = P.StartAnimLinearTranslation;
  P.storeCallback(s, vice_grip_step);
};

// Lua: g2_effects2a.lua:367
function guillotine_step3(s: S): void {
  if (P.AnimTranslateLinear(s)) P.destroy(s);
}

// Lua: g2_effects2a.lua:371
function guillotine_step2(s: S): void {
  if (s.data[3] !== 0) {
    s.x2 = -s.x2;
    s.y2 = -s.y2;
  }
  s.data[3] = bxor(s.data[3], 1);
  s.data[4] = s.data[4] + 1;
  if (s.data[4] === 51) {
    s.y2 = 0;
    s.x2 = 0;
    s.data[4] = 0;
    s.data[3] = 0;
    s.animPaused = false;
    P.startAnim(s, bxor(s.data[5], 1));
    s.pcb = guillotine_step3;
  }
}

// Lua: g2_effects2a.lua:389
function guillotine_step1(s: S): void {
  if (P.AnimTranslateLinear(s) && s.animEnded) {
    P.seekAnim(s, 0);
    s.animPaused = true;
    s.x = s.x + s.x2;
    s.y = s.y + s.y2;
    s.x2 = 2;
    s.y2 = -2;
    s.data[0] = s.data[6];
    s.data[1] = bxor(s.data[1], 1);
    s.data[2] = bxor(s.data[2], 1);
    s.data[4] = 0;
    s.data[3] = 0;
    s.pcb = guillotine_step2;
  }
}

// Lua: g2_effects2a.lua:407 -- pokefirered/src/battle_anim_effects_2.c:1930
CB.GuillotinePincer = function (s: S): void {
  let sx = 32, sy = -32, ex = 16, ey = -16;
  if (P.arg(0) !== 0) {
    sx = -32; sy = 32; ex = -16; ey = 16;
    P.startAnim(s, P.arg(0));
  }
  s.x = s.x + sx;
  s.y = s.y + sy;
  s.data[0] = 6;
  s.data[1] = s.x;
  s.data[2] = P.coord(P.tgt(), 2) + ex;
  s.data[3] = s.y;
  s.data[4] = P.coord(P.tgt(), 3) + ey;
  P.InitAnimLinearTranslation(s);
  s.data[5] = P.arg(0);
  s.data[6] = s.data[0];
  s.pcb = guillotine_step1;
};

// Lua: g2_effects2a.lua:426
function grow_gray_step(t: T): void {
  t.data[0] = t.data[0] - 1;
  if (t.data[0] === -1) {
    const c = t.g2.clone;
    if (c && P.alive(c)) P.destroy(c);
    P.destroyTask(t);
  }
}

// Lua: g2_effects2a.lua:436 -- pokefirered/src/battle_anim_effects_2.c:2008
TASKS.GrowAndGrayscale = task(function (t: T): void {
  const c = P.cloneMon(P.ANIM_TARGET, P.subpriorityOf(P.tgt()));
  if (c) {
    c.affineMode = 3;
    c.affineAnimPaused = true;
    c.gray = true;
    c.objBlend = true;
    P.trySetRotScale(c, false, 0xD0, 0xD0, 0);
    t.g2.clone = c;
  }
  t.data[0] = 80;
  t.func = grow_gray_step;
});

// Lua: g2_effects2a.lua:450
function clone_minimize_step(s: S): void {
  s.data[0] = s.data[0] - 1;
  if (s.data[0] === 0) {
    const t = s.g2.task;
    if (t && t.data) t.data[s.data[2]] = t.data[s.data[2]] - 1;
    P.destroy(s);
  }
}

// Lua: g2_effects2a.lua:459
function create_minimize_sprite(t: T): void {
  const c = P.cloneMon(P.ANIM_ATTACKER, t.data[7] - t.data[3]);
  if (c) {
    c.objBlend = true;
    c.affineMode = 1;
    c.affineAnimPaused = true;
    t.data[3] = t.data[3] + 1;
    t.data[6] = t.data[6] + 1;
    c.data[0] = 16;
    c.g2.task = t;
    c.data[2] = 6;
    P.trySetRotScale(c, false, t.data[4], t.data[4], 0);
    c.pcb = clone_minimize_step;
  }
}

// Lua: g2_effects2a.lua:475
function minimize_step(t: T): void {
  const d = t.data;
  const m = t.g2.mon;
  if (d[1] === 0) {
    if (d[2] === 0 || d[2] === 3 || d[2] === 6) create_minimize_sprite(t);
    d[2] = d[2] + 1;
    d[4] = d[4] + 0x28;
    P.setSpriteRotScale(m, d[4], d[4], 0);
    P.setYOffsetFromYScale(m);
    if (d[2] === 32) {
      d[5] = d[5] + 1;
      d[1] = d[1] + 1;
    }
  } else if (d[1] === 1) {
    if (d[6] === 0) {
      if (d[5] === 3) {
        d[2] = 0;
        d[1] = 3;
      } else {
        d[2] = 0;
        d[3] = 0;
        d[4] = 0x100;
        P.setSpriteRotScale(m, d[4], d[4], 0);
        P.setYOffsetFromYScale(m);
        d[1] = 2;
      }
    }
  } else if (d[1] === 2) {
    d[1] = 0;
  } else if (d[1] === 3) {
    d[2] = d[2] + 1;
    if (d[2] > 32) {
      d[2] = 0;
      d[1] = d[1] + 1;
    }
  } else if (d[1] === 4) {
    d[2] = d[2] + 2;
    d[4] = d[4] - 0x50;
    P.setSpriteRotScale(m, d[4], d[4], 0);
    P.setYOffsetFromYScale(m);
    if (d[2] === 32) {
      d[2] = 0;
      d[1] = d[1] + 1;
    }
  } else if (d[1] === 5) {
    P.resetSpriteRotScale(m);
    m.y2 = 0;
    P.destroyTask(t);
  }
}

// Lua: g2_effects2a.lua:527 -- pokefirered/src/battle_anim_effects_2.c:2033
TASKS.Minimize = task(function (t: T): void {
  const m = P.mon(P.atk());
  if (!m) { P.destroyTask(t); return; }
  t.g2.mon = m;
  t.data[1] = 0;
  t.data[2] = 0;
  t.data[3] = 0;
  t.data[4] = 0x100;
  t.data[5] = 0;
  t.data[6] = 0;
  t.data[7] = P.subpriorityOf(P.atk());
  t.func = minimize_step;
});

// Lua: g2_effects2a.lua:541
function splash_step(t: T): void {
  const d = t.data;
  const m = t.g2.affMon;
  if (d[1] === 0) {
    P.RunAffineAnimFromTaskData(t);
    d[4] = d[4] + 3;
    m.y2 = m.y2 + d[4];
    d[3] = d[3] + 1;
    if (d[3] > 7) {
      d[3] = 0;
      d[1] = d[1] + 1;
    }
  } else if (d[1] === 1) {
    P.RunAffineAnimFromTaskData(t);
    m.y2 = m.y2 + d[4];
    d[3] = d[3] + 1;
    if (d[3] > 7) {
      d[3] = 0;
      d[1] = d[1] + 1;
    }
  } else if (d[1] === 2) {
    if (d[4] !== 0) {
      m.y2 = m.y2 - 2;
      d[4] = d[4] - 2;
    } else {
      d[1] = d[1] + 1;
    }
  } else if (d[1] === 3) {
    if (!P.RunAffineAnimFromTaskData(t)) {
      d[2] = d[2] - 1;
      if (d[2] === 0) {
        m.y2 = 0;
        P.destroyTask(t);
      } else {
        P.PrepareAffineAnimInTaskData(t, m, P.affineCmds("sSplashEffectAffineAnimCmds"));
        d[1] = 0;
      }
    }
  }
}

// Lua: g2_effects2a.lua:583 -- pokefirered/src/battle_anim_effects_2.c:2161
TASKS.Splash = task(function (t: T): void {
  if (P.arg(1) === 0) { P.destroyTask(t); return; }
  const m = P.monById(P.arg(0));
  if (!m) { P.destroyTask(t); return; }
  t.data[1] = 0;
  t.data[2] = P.arg(1);
  t.data[3] = 0;
  t.data[4] = 0;
  P.PrepareAffineAnimInTaskData(t, m, P.affineCmds("sSplashEffectAffineAnimCmds"));
  t.func = splash_step;
});

// Lua: g2_effects2a.lua:595
function affine_until_done(t: T): void {
  if (!P.RunAffineAnimFromTaskData(t)) P.destroyTask(t);
}

// Lua: g2_effects2a.lua:600 -- pokefirered/src/battle_anim_effects_2.c:2237
TASKS.GrowAndShrink = task(function (t: T): void {
  const m = P.mon(P.atk());
  if (!m) { P.destroyTask(t); return; }
  P.PrepareAffineAnimInTaskData(t, m, P.affineCmds("sGrowAndShrinkAffineAnimCmds"));
  t.func = affine_until_done;
});

// Lua: g2_effects2a.lua:608 -- pokefirered/src/battle_anim_effects_2.c:2257
CB.BreathPuff = function (s: S): void {
  const atk = P.atk();
  if (atk === "player") {
    P.startAnim(s, 0);
    s.x = P.coord(atk, 2) + 32;
    s.data[1] = 64;
  } else {
    P.startAnim(s, 1);
    s.x = P.coord(atk, 2) - 32;
    s.data[1] = -64;
  }
  s.y = P.coord(atk, 3);
  s.data[0] = 52;
  s.data[2] = 0;
  s.data[3] = 0;
  s.data[4] = 0;
  P.storeCallback(s, P.DestroyAnimSprite);
  s.pcb = P.TranslateSpriteLinearFixedPoint;
};

// Lua: g2_effects2a.lua:629 -- pokefirered/src/battle_anim_effects_2.c:2285
CB.AngerMark = function (s: S): void {
  const b = (P.arg(0) === 0) ? P.atk() : P.tgt();
  if (b !== "player") P.setArg(1, -P.arg(1));
  s.x = P.coord(b, 2) + P.arg(1);
  s.y = P.coord(b, 3) + P.arg(2);
  if (s.y < 8) s.y = 8;
  P.storeCallback(s, P.DestroySpriteAndMatrix);
  s.pcb = P.RunStoredCallbackWhenAffineAnimEnds;
};

// Lua: g2_effects2a.lua:640 -- pokefirered/src/battle_anim_effects_2.c:2307
TASKS.ThrashMoveMonHorizontal = task(function (t: T): void {
  const m = P.mon(P.atk());
  if (!m) { P.destroyTask(t); return; }
  t.data[1] = 0;
  P.PrepareAffineAnimInTaskData(t, m, P.affineCmds("sThrashMoveMonAffineAnimCmds"));
  t.func = affine_until_done;
});

// Lua: g2_effects2a.lua:648
function thrash_vertical_step(t: T): void {
  const d = t.data;
  const m = t.g2.mon;
  d[7] = d[7] + 1;
  if (d[7] > 2) {
    d[7] = 0;
    d[8] = d[8] + 1;
    if (band(d[8], 1) !== 0) m.y = m.y + d[9]; else m.y = m.y - d[9];
  }
  if (d[1] === 0) {
    m.x = m.x + d[2];
    d[3] = d[3] - 1;
    if (d[3] === 0) {
      d[3] = 14;
      d[1] = 1;
    }
  } else if (d[1] === 1) {
    m.x = m.x - d[2];
    d[3] = d[3] - 1;
    if (d[3] === 0) {
      d[3] = 7;
      d[1] = 2;
    }
  } else if (d[1] === 2) {
    m.x = m.x + d[2];
    d[3] = d[3] - 1;
    if (d[3] === 0) {
      d[4] = d[4] - 1;
      if (d[4] !== 0) {
        d[3] = 7;
        d[1] = 0;
      } else {
        if (band(d[8], 1) !== 0) m.y = m.y - d[9];
        P.destroyTask(t);
      }
    }
  }
}

// Lua: g2_effects2a.lua:688 -- pokefirered/src/battle_anim_effects_2.c:2327
TASKS.ThrashMoveMonVertical = task(function (t: T): void {
  const m = P.mon(P.atk());
  if (!m) { P.destroyTask(t); return; }
  t.g2.mon = m;
  const d = t.data;
  d[1] = 0;
  d[2] = 4;
  d[3] = 7;
  d[4] = 3;
  d[5] = m.x;
  d[6] = m.y;
  d[7] = 0;
  d[8] = 0;
  d[9] = 2;
  if (P.atk() !== "player") d[2] = -d[2];
  t.func = thrash_vertical_step;
});

// Lua: g2_effects2a.lua:706
export const G2Effects2a = { cb: CB, tasks: TASKS };
export default G2Effects2a;
