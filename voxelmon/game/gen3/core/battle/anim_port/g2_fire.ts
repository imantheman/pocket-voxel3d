// Port of gen1recomp src/core/game3/battle/anim_port/g2_fire.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered battle_anim_fire.c on the g2_pret kit.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, truthy } from "../../../../../import/gen3/lua.ts";
import { seq } from "../../../platform/lt.ts";
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

// Lua: g2_fire.lua:7 -- pokefirered/src/battle_anim_fire.c:462
CB.FireSpiralInward = function (s: S): void {
  s.data[0] = P.arg(0);
  s.data[1] = 0x3C;
  s.data[2] = 0x9;
  s.data[3] = 0x1E;
  s.data[4] = P.s16(0xFE00);
  P.storeCallback(s, P.DestroyAnimSprite);
  s.pcb = P.TranslateSpriteInGrowingCircle;
  s.pcb(s);
};

// Lua: g2_fire.lua:19 -- pokefirered/src/battle_anim_fire.c:475
CB.FireSpread = function (s: S): void {
  P.SetAnimSpriteInitialXOffset(s, P.arg(0));
  s.y = s.y + P.arg(1);
  s.data[0] = P.arg(4);
  s.data[1] = P.arg(2);
  s.data[2] = P.arg(3);
  s.pcb = P.TranslateSpriteLinearFixedPoint;
  P.storeCallback(s, P.DestroyAnimSprite);
};

// Lua: g2_fire.lua:29
function large_flame_step(s: S): void {
  s.data[0] = s.data[0] + 1;
  if (s.data[0] < s.data[4]) {
    s.x2 = s.x2 + s.data[2];
    s.y2 = s.y2 + s.data[3];
  }
  if (s.data[0] === s.data[1]) P.destroy(s);
}

// Lua: g2_fire.lua:39 -- pokefirered/src/battle_anim_fire.c:486
CB.FirePlume = function (s: S): void {
  P.SetSpriteCoordsToAnimAttackerCoords(s);
  if (P.atk() !== "player") {
    s.x = s.x - P.arg(0);
    s.y = s.y + P.arg(1);
    s.data[2] = -P.arg(4);
  } else {
    s.x = s.x + P.arg(0);
    s.y = s.y + P.arg(1);
    s.data[2] = P.arg(4);
  }
  s.data[1] = P.arg(2);
  s.data[4] = P.arg(3);
  s.data[3] = P.arg(5);
  s.pcb = large_flame_step;
};

// Lua: g2_fire.lua:57 -- pokefirered/src/battle_anim_fire.c:507
CB.LargeFlame = function (s: S): void {
  if (P.atk() !== "player") {
    s.x = s.x - P.arg(0);
    s.y = s.y + P.arg(1);
    s.data[2] = P.arg(4);
  } else {
    s.x = s.x + P.arg(0);
    s.y = s.y + P.arg(1);
    s.data[2] = -P.arg(4);
  }
  s.data[1] = P.arg(2);
  s.data[4] = P.arg(3);
  s.data[3] = P.arg(5);
  s.pcb = large_flame_step;
};

// Lua: g2_fire.lua:74 -- pokefirered/src/battle_anim_fire.c:583
CB.Sunlight = function (s: S): void {
  s.x = 0;
  s.y = 0;
  s.data[0] = 60;
  s.data[2] = 140;
  s.data[4] = 80;
  s.pcb = P.StartAnimLinearTranslation;
  P.storeCallback(s, P.DestroyAnimSprite);
};

// Lua: g2_fire.lua:85 -- pokefirered/src/battle_anim_fire.c:603
CB.EmberFlare = function (s: S): void {
  s.pcb = P.AnimTravelDiagonally;
  s.pcb(s);
};

// Lua: g2_fire.lua:91 -- pokefirered/src/battle_anim_fire.c:613
CB.BurnFlame = function (s: S): void {
  P.setArg(0, -P.arg(0));
  P.setArg(2, -P.arg(2));
  s.pcb = P.AnimTravelDiagonally;
};

// Lua: g2_fire.lua:97
function fire_ring_offset(s: S): void {
  s.x2 = P.Sin(s.data[7], 28);
  s.y2 = P.Cos(s.data[7], 28);
  s.data[7] = mod(s.data[7] + 20, 256);
}

// Lua: g2_fire.lua:103
function fire_ring_step3(s: S): void {
  fire_ring_offset(s);
  s.data[0] = s.data[0] + 1;
  if (s.data[0] === 0x1F) P.destroy(s);
}

// Lua: g2_fire.lua:109
function fire_ring_step2(s: S): void {
  if (P.AnimTranslateLinear(s)) {
    s.data[0] = 0;
    s.x = P.coord(P.tgt(), 2);
    s.y = P.coord(P.tgt(), 3);
    s.x2 = 0;
    s.y2 = 0;
    s.pcb = fire_ring_step3;
    s.pcb(s);
  } else {
    s.x2 = s.x2 + P.Sin(s.data[7], 28);
    s.y2 = s.y2 + P.Cos(s.data[7], 28);
    s.data[7] = mod(s.data[7] + 20, 256);
  }
}

// Lua: g2_fire.lua:125
function fire_ring_step1(s: S): void {
  fire_ring_offset(s);
  s.data[0] = s.data[0] + 1;
  if (s.data[0] === 0x12) {
    s.data[0] = 0x19;
    s.data[1] = s.x;
    s.data[2] = P.coord(P.tgt(), 2);
    s.data[3] = s.y;
    s.data[4] = P.coord(P.tgt(), 3);
    P.InitAnimLinearTranslation(s);
    s.pcb = fire_ring_step2;
  }
}

// Lua: g2_fire.lua:140 -- pokefirered/src/battle_anim_fire.c:628
CB.FireRing = function (s: S): void {
  P.InitSpritePosToAnimAttacker(s, true);
  s.data[7] = P.arg(2);
  s.data[0] = 0;
  s.pcb = fire_ring_step1;
};

// Lua: g2_fire.lua:148 -- pokefirered/src/battle_anim_fire.c:692
CB.FireCross = function (s: S): void {
  s.x = s.x + P.arg(0);
  s.y = s.y + P.arg(1);
  s.data[0] = P.arg(2);
  s.data[1] = P.arg(3);
  s.data[2] = P.arg(4);
  P.storeCallback(s, P.DestroyAnimSprite);
  s.pcb = P.TranslateSpriteLinear;
};

// Lua: g2_fire.lua:158
function spiral_out_step2(s: S): void {
  s.x2 = P.Sin(s.data[1], P.asr(s.data[2], 8));
  s.y2 = P.Cos(s.data[1], P.asr(s.data[2], 8));
  s.data[1] = mod(s.data[1] + 10, 256);
  s.data[2] = P.s16(s.data[2] + 0xD0);
  s.data[0] = s.data[0] - 1;
  if (s.data[0] === -1) P.destroy(s);
}

// Lua: g2_fire.lua:167
function spiral_out_step1(s: S): void {
  s.invisible = false;
  s.data[0] = s.data[1];
  s.data[1] = 0;
  s.pcb = spiral_out_step2;
  s.pcb(s);
}

// Lua: g2_fire.lua:176 -- pokefirered/src/battle_anim_fire.c:703
CB.FireSpiralOutward = function (s: S): void {
  P.InitSpritePosToAnimAttacker(s, true);
  s.data[1] = P.arg(2);
  s.data[0] = P.arg(3);
  s.invisible = true;
  s.pcb = P.WaitAnimForDuration;
  P.storeCallback(s, spiral_out_step1);
};

// Lua: g2_fire.lua:185
const ROCK_SPEEDS = seq(seq(-2, -5), seq(-1, -1), seq(3, -6), seq(4, -2), seq(2, -8), seq(-5, -5), seq(4, -7));

// Lua: g2_fire.lua:187
function update_launch_rock(s: S): void {
  const d = s.data;
  d[0] = d[0] + 1;
  if (d[0] > 2) {
    d[0] = 0;
    d[1] = d[1] + 1;
    const extra = P.u16(d[1]) * P.u16(d[1]);
    d[3] = P.s16(d[3] + extra);
  }
  d[2] = P.s16(d[2] + d[4]);
  s.x = P.asr(d[2], 3);
  d[3] = P.s16(d[3] + d[5]);
  s.y = P.asr(d[3], 3);
  if (s.x < -8 || s.x > P.DISPLAY_WIDTH + 8 || s.y < -8 || s.y > 120) {
    s.invisible = true;
  }
}

// Lua: g2_fire.lua:206 -- pokefirered/src/battle_anim_fire.c:916
CB.EruptionLaunchRock = function (s: S): void {
  update_launch_rock(s);
  if (s.invisible) {
    const t = s.g2.task;
    if (t && t.data) t.data[6] = t.data[6] - 1;
    P.destroy(s);
  }
};

// Lua: g2_fire.lua:215
function create_launch_rocks(t: T, m: any): void {
  const y = P.u16(m.y + m.y2 - 64 + ((P.atk() === "player") ? 74 : 44));
  let x = P.u16(m.x);
  let sign: number;
  if (P.atk() === "player") {
    x = x - 12;
    sign = 1;
  } else {
    x = x + 16;
    sign = -1;
  }
  let j = 0;
  for (let i = 0; i <= 6; i++) {
    const r = P.createSprite("gEruptionLaunchRockSpriteTemplate", P.s16(x), P.s16(y), 2);
    if (r) {
      r.tileBase = r.tileBase + j * 4 + 0x40;
      j = j + 1;
      if (j >= 5) j = 0;
      r.data[0] = 0;
      r.data[1] = 0;
      r.data[2] = P.s16(P.u16(r.x) * 8);
      r.data[3] = P.s16(P.u16(r.y) * 8);
      r.data[4] = ROCK_SPEEDS[i + 1]![1]! * sign * 8;
      r.data[5] = ROCK_SPEEDS[i + 1]![2]! * 8;
      r.g2.task = t;
      t.data[6] = t.data[6] + 1;
    }
  }
}

// Lua: g2_fire.lua:245
function eruption_step(t: T): void {
  const d = t.data;
  const m = t.g2.mon;
  if (d[0] === 0) {
    P.SetSpriteSquashParams(t, m, 0x100, 0x100, 0xE0, 0x200, 32);
    d[0] = d[0] + 1;
  }
  if (d[0] === 1) {
    d[1] = d[1] + 1;
    if (d[1] > 1) {
      d[1] = 0;
      d[2] = d[2] + 1;
      if (mod(d[2], 2) === 1) m.x2 = 3; else m.x2 = -3;
    }
    if (d[5] !== 0) {
      d[3] = d[3] + 1;
      if (d[3] > 4) {
        d[3] = 0;
        m.y = m.y + 1;
      }
    }
    if (P.RunSpriteSquash(t) === 0) {
      P.setYOffsetFromYScale(m);
      m.x2 = 0;
      d[1] = 0;
      d[2] = 0;
      d[3] = 0;
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 2) {
    d[1] = d[1] + 1;
    if (d[1] > 4) {
      if (d[5] !== 0) {
        P.SetSpriteSquashParams(t, m, 0xE0, 0x200, 0x180, 0xF0, 6);
      } else {
        P.SetSpriteSquashParams(t, m, 0xE0, 0x200, 0x180, 0xC0, 6);
      }
      d[1] = 0;
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 3) {
    if (P.RunSpriteSquash(t) === 0) {
      create_launch_rocks(t, m);
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 4) {
    d[1] = d[1] + 1;
    if (d[1] > 1) {
      d[1] = 0;
      d[2] = d[2] + 1;
      if (mod(d[2], 2) === 1) m.y2 = m.y2 + 3; else m.y2 = m.y2 - 3;
    }
    d[3] = d[3] + 1;
    if (d[3] > 24) {
      if (d[5] !== 0) {
        P.SetSpriteSquashParams(t, m, 0x180, 0xF0, 0x100, 0x100, 8);
      } else {
        P.SetSpriteSquashParams(t, m, 0x180, 0xC0, 0x100, 0x100, 8);
      }
      if (mod(d[2], 2) === 1) m.y2 = m.y2 - 3;
      d[1] = 0;
      d[2] = 0;
      d[3] = 0;
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 5) {
    if (d[5] !== 0) m.y = m.y - 1;
    if (P.RunSpriteSquash(t) === 0) {
      m.y = d[4];
      P.resetSpriteRotScale(m);
      d[2] = 0;
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 6) {
    if (d[6] === 0) P.destroyTask(t);
  }
}

// Lua: g2_fire.lua:324 -- pokefirered/src/battle_anim_fire.c:754
TASKS.EruptionLaunchRocks = task(function (t: T): void {
  const m = P.monById(P.ANIM_ATTACKER);
  if (!m) {
    P.destroyTask(t);
    return;
  }
  t.g2.mon = m;
  t.data[0] = 0;
  t.data[1] = 0;
  t.data[2] = 0;
  t.data[3] = 0;
  t.data[4] = m.y;
  t.data[5] = P.side(P.atk());
  t.data[6] = 0;
  t.func = eruption_step;
});

// Lua: g2_fire.lua:341
function falling_rock_step(s: S): void {
  const d = s.data;
  if (d[0] === 0) {
    if (d[6] !== 0) {
      d[6] = d[6] - 1;
      return;
    }
    d[0] = d[0] + 1;
  }
  if (d[0] === 1) {
    s.y = s.y + 8;
    if (s.y >= d[7]) {
      s.y = d[7];
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 2) {
    d[1] = d[1] + 1;
    if (d[1] > 1) {
      d[1] = 0;
      d[2] = d[2] + 1;
      if (mod(d[2], 2) !== 0) s.y2 = -3; else s.y2 = 3;
    }
    d[3] = d[3] + 1;
    if (d[3] > 16) P.destroy(s);
  }
}

// Lua: g2_fire.lua:369 -- pokefirered/src/battle_anim_fire.c:994
CB.EruptionFallingRock = function (s: S): void {
  s.x = P.arg(0);
  s.y = P.arg(1);
  s.data[0] = 0;
  s.data[1] = 0;
  s.data[2] = 0;
  s.data[6] = P.arg(2);
  s.data[7] = P.arg(3);
  s.tileBase = s.tileBase + P.arg(4) * 16;
  s.pcb = falling_rock_step;
};

// Lua: g2_fire.lua:381
function wisp_orb_step(s: S): void {
  if (!P.AnimTranslateLinear(s)) {
    s.x2 = s.x2 + P.Sin(s.data[5], 16);
    const initial = s.data[5];
    s.data[5] = mod(s.data[5] + 4, 256);
    const nw = s.data[5];
    if ((initial === 0 || initial > 196) && nw > 0 && s.data[7] === 0) {
      P.playSE("SE_M_FLAME_WHEEL", P.customPanning());
    }
  } else {
    P.destroy(s);
  }
}

// Lua: g2_fire.lua:395
function wisp_orb(s: S): void {
  const d = s.data;
  if (d[0] === 0) {
    P.InitSpritePosToAnimAttacker(s, false);
    P.startAnim(s, P.arg(2));
    d[7] = P.arg(2);
    if (P.atk() !== "player") d[4] = 4; else d[4] = -4;
    s.oamPriority = P.bgPriority(P.tgt());
    d[0] = d[0] + 1;
  } else if (d[0] === 1) {
    d[1] = P.s16(d[1] + 192);
    if (P.atk() !== "player") {
      s.y2 = -P.asr(d[1], 8);
    } else {
      s.y2 = P.asr(d[1], 8);
    }
    s.x2 = P.Sin(d[2], d[4]);
    d[2] = mod(d[2] + 4, 256);
    d[3] = d[3] + 1;
    if (d[3] === 1) {
      d[3] = 0;
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 2) {
    s.x2 = P.Sin(d[2], d[4]);
    d[2] = mod(d[2] + 4, 256);
    d[3] = d[3] + 1;
    if (d[3] === 31) {
      s.x = s.x + s.x2;
      s.y = s.y + s.y2;
      s.x2 = 0;
      s.y2 = 0;
      d[0] = 256;
      d[1] = s.x;
      d[2] = P.coord(P.tgt(), 2);
      d[3] = s.y;
      d[4] = P.coord(P.tgt(), 3);
      P.InitAnimLinearTranslationWithSpeed(s);
      s.pcb = wisp_orb_step;
    }
  }
}

// Lua: g2_fire.lua:439 -- pokefirered/src/battle_anim_fire.c:1057
CB.WillOWispOrb = function (s: S): void {
  wisp_orb(s);
  if (s.pcb == null || s.pcb === CB.WillOWispOrb) s.pcb = wisp_orb;
};

// Lua: g2_fire.lua:444
function wisp_fire(s: S): void {
  const d = s.data;
  if (d[0] === 0) {
    d[1] = P.arg(0);
    d[0] = d[0] + 1;
  }
  d[3] = P.s16(d[3] + 0xC0 * 2);
  d[4] = P.s16(d[4] + 0xA0);
  s.x2 = P.Sin(d[1], P.asr(d[3], 8));
  s.y2 = P.Cos(d[1], P.asr(d[4], 8));
  d[1] = mod(d[1] + 7, 256);
  if (d[1] < 64 || d[1] > 195) {
    s.oamPriority = P.bgPriority(P.tgt());
  } else {
    s.oamPriority = P.bgPriority(P.tgt()) + 1;
  }
  d[2] = d[2] + 1;
  if (d[2] > 0x14) s.invisible = !truthy(s.invisible);
  if (d[2] === 0x1E) P.destroy(s);
}

// Lua: g2_fire.lua:466 -- pokefirered/src/battle_anim_fire.c:1125
CB.WillOWispFire = function (s: S): void {
  wisp_fire(s);
  s.pcb = wisp_fire;
};

// Lua: g2_fire.lua:471
function heat_wave_apply(t: T): void {
  const m = t.g2.mon;
  if (m && t.data[13] >= 1) m.x2 = t.data[10] + t.data[11];
}

// Lua: g2_fire.lua:476
function heat_wave_toggle(t: T): void {
  t.data[1] = 0;
  t.data[2] = t.data[2] + 1;
  if (mod(t.data[2], 2) === 1) t.data[11] = 2; else t.data[11] = -2;
}

// Lua: g2_fire.lua:482
function heat_wave_step(t: T): void {
  const d = t.data;
  if (d[0] === 0) {
    d[10] = d[10] + d[12] * 2;
    d[1] = d[1] + 1;
    if (d[1] >= 2) heat_wave_toggle(t);
    heat_wave_apply(t);
    d[9] = d[9] + 1;
    if (d[9] === 16) {
      d[9] = 0;
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 1) {
    d[1] = d[1] + 1;
    if (d[1] >= 5) heat_wave_toggle(t);
    heat_wave_apply(t);
    d[9] = d[9] + 1;
    if (d[9] === 96) {
      d[9] = 0;
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 2) {
    d[10] = d[10] - d[12] * 2;
    d[1] = d[1] + 1;
    if (d[1] >= 2) heat_wave_toggle(t);
    heat_wave_apply(t);
    d[9] = d[9] + 1;
    if (d[9] === 16) d[0] = d[0] + 1;
  } else if (d[0] === 3) {
    const m = t.g2.mon;
    if (m) m.x2 = 0;
    P.destroyTask(t);
  }
}

// Lua: g2_fire.lua:518 -- pokefirered/src/battle_anim_fire.c:1157
TASKS.MoveHeatWaveTargets = task(function (t: T): void {
  t.data[12] = (P.atk() === "player") ? 1 : -1;
  t.data[13] = 1;
  t.g2.mon = P.monById(P.ANIM_TARGET);
  t.func = heat_wave_step;
});

// Lua: g2_fire.lua:526 -- pokefirered/src/battle_anim_fire.c:1238
TASKS.BlendBackground = task(function (t: T): void {
  const vm = P.vm;
  if (vm) {
    vm._animBgBlend = { coeff: P.arg(0), color: P.u16(P.arg(1)) };
  }
  P.destroyTask(t);
});

// Lua: g2_fire.lua:534 -- { [0] = { [0] = ... }, [1] = { [0] = ... } }
const SHAKE_DIRS = [
  [-1, -1, 0, 1, 1, 0, 0, -1, -1, 1, 1, 0, 0, -1, 0, 1],
  [-1, 0, 1, 0, -1, 1, 0, -1, 0, 1, 0, -1, 0, 1, 0, 1],
];

// Lua: g2_fire.lua:539
function shake_pattern(t: T): void {
  const d = t.data;
  if (d[0] === 0) {
    d[1] = P.arg(0);
    d[2] = P.arg(1);
    d[3] = P.arg(2);
    d[4] = P.arg(3);
  }
  d[0] = d[0] + 1;
  const m = t.g2.mon;
  let dir: number;
  if (d[4] === 0) dir = SHAKE_DIRS[0]![mod(d[0], 10)]!; else dir = SHAKE_DIRS[1]![mod(d[0], 10)]!;
  if (m) {
    if (d[3] === 1) {
      const v = P.arg(1) * dir;
      m.y2 = v < 0 ? -v : v;
    } else {
      m.x2 = P.arg(1) * dir;
    }
  }
  if (d[0] === d[1]) {
    if (m) {
      m.x2 = 0;
      m.y2 = 0;
    }
    P.destroyTask(t);
  }
}

// Lua: g2_fire.lua:569 -- pokefirered/src/battle_anim_fire.c:1254
TASKS.ShakeTargetInPattern = task(function (t: T): void {
  t.g2.mon = P.mon(P.tgt());
  t.func = shake_pattern;
  shake_pattern(t);
});

// Lua: g2_fire.lua:575
export const G2Fire = { cb: CB, tasks: TASKS };
export default G2Fire;
