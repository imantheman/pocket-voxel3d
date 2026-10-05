// Port of gen1recomp src/core/game3/battle/anim_port/g2_effects2c.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered battle_anim_effects_2.c (third part) on the g2_pret kit.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, tonumber, truthy } from "../../../../../import/gen3/lua.ts";
import { AnimPal } from "../anim_pal.ts";
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

// Lua: g2_effects2c.lua:6 -- local band = bit.band
const band = (a: number, b: number): number => a & b;

// Lua: g2_effects2c.lua:8
function red_heart_projectile_step(s: S): void {
  if (!P.AnimTranslateLinear(s)) {
    s.y2 = s.y2 + P.Sin(s.data[5], 14);
    s.data[5] = mod(s.data[5] + 4, 256);
  } else {
    P.destroy(s);
  }
}

// Lua: g2_effects2c.lua:18 -- pokefirered/src/battle_anim_effects_2.c:3191
CB.RedHeartProjectile = function (s: S): void {
  P.InitSpritePosToAnimAttacker(s, true);
  s.data[0] = 95;
  s.data[1] = s.x;
  s.data[2] = P.coord(P.tgt(), 2);
  s.data[3] = s.y;
  s.data[4] = P.coord(P.tgt(), 3);
  P.InitAnimLinearTranslation(s);
  s.pcb = red_heart_projectile_step;
};

// Lua: g2_effects2c.lua:29
function particle_burst(s: S): void {
  const d = s.data;
  if (d[0] === 0) {
    d[1] = P.arg(0);
    d[2] = P.arg(1);
    d[0] = d[0] + 1;
  } else {
    d[4] = P.s16(d[4] + d[1]);
    s.x2 = P.asr(d[4], 8);
    s.y2 = P.Sin(d[3], d[2]);
    d[3] = mod(d[3] + 3, 256);
    if (d[3] > 100) s.invisible = mod(d[3], 2) === 1;
    if (d[3] > 120) P.destroy(s);
  }
}

// Lua: g2_effects2c.lua:46 -- pokefirered/src/battle_anim_effects_2.c:3216
CB.ParticleBurst = function (s: S): void {
  particle_burst(s);
  s.pcb = particle_burst;
};

// Lua: g2_effects2c.lua:51
function red_heart_rising_step(s: S): void {
  s.data[2] = P.s16(s.data[2] + s.data[1]);
  s.y2 = -Math.floor(P.u16(s.data[2]) / 256);
  s.x2 = P.Sin(s.data[3], 4);
  s.data[3] = mod(s.data[3] + 3, 256);
  const y = s.y + s.y2;
  if (y <= 72) {
    s.invisible = mod(s.data[3], 2) === 1;
    if (y <= 64) P.destroy(s);
  }
}

// Lua: g2_effects2c.lua:64 -- pokefirered/src/battle_anim_effects_2.c:3238
CB.RedHeartRising = function (s: S): void {
  s.x = P.arg(0);
  s.y = P.DISPLAY_HEIGHT;
  s.data[0] = P.arg(2);
  s.data[1] = P.arg(1);
  s.pcb = P.WaitAnimForDuration;
  P.storeCallback(s, red_heart_rising_step);
};

// Lua: g2_effects2c.lua:73 -- local AnimPal = require("src.core.game3.battle.anim_pal"): a static import.

// Lua: g2_effects2c.lua:76 -- pokefirered/src/battle_anim_mons.c:926
function bg1_draw(t: T): void {
  const g2 = t.g2;
  // (Brian's `or not (love and love.graphics)`: the platform always has graphics.)
  if (!g2) return;
  const eva = g2.eva ?? 0;
  if (eva <= 0) return;
  AnimPal.drawBg(g2.key, "bg1", g2.x ?? 0, g2.y ?? 0, { eva, evb: 16 - eva });
}

// Lua: g2_effects2c.lua:84
function hearts_step(t: T): void {
  const d = t.data;
  const g2 = t.g2;
  if (d[12] === 0) {
    d[10] = d[10] + 1;
    if (d[10] === 4) {
      d[10] = 0;
      d[11] = d[11] + 1;
      g2.eva = d[11];
      if (d[11] === 16) {
        d[12] = d[12] + 1;
        d[11] = 0;
      }
    }
  } else if (d[12] === 1) {
    d[11] = d[11] + 1;
    if (d[11] === 141) {
      d[11] = 16;
      d[12] = d[12] + 1;
    }
  } else if (d[12] === 2) {
    d[10] = d[10] + 1;
    if (d[10] === 4) {
      d[10] = 0;
      d[11] = d[11] - 1;
      g2.eva = d[11];
      if (d[11] === 0) {
        d[12] = d[12] + 1;
        d[11] = 0;
      }
    }
  } else if (d[12] === 3) {
    g2.eva = 0;
    t.draw = null;
    d[12] = d[12] + 1;
  } else if (d[12] === 4) {
    P.destroyTask(t);
  }
}

// Lua: g2_effects2c.lua:125 -- pokefirered/src/battle_anim_effects_2.c:3265
TASKS.HeartsBackground = task(function (t: T): void {
  t.g2.key = "ATTRACT";
  AnimPal.bgLoad("bg1", "ATTRACT");
  t.g2.eva = 0;
  t.z = 2;
  t.draw = bg1_draw;
  t.func = hearts_step;
});

// Lua: g2_effects2c.lua:134
function scary_step(t: T): void {
  const d = t.data;
  const g2 = t.g2;
  if (d[12] === 0) {
    d[10] = d[10] + 1;
    if (d[10] === 2) {
      d[10] = 0;
      d[11] = d[11] + 1;
      g2.eva = d[11];
      if (d[11] === 14) {
        d[12] = d[12] + 1;
        d[11] = 0;
      }
    }
  } else if (d[12] === 1) {
    d[11] = d[11] + 1;
    if (d[11] === 21) {
      d[11] = 14;
      d[12] = d[12] + 1;
    }
  } else if (d[12] === 2) {
    d[10] = d[10] + 1;
    if (d[10] === 2) {
      d[10] = 0;
      d[11] = d[11] - 1;
      g2.eva = d[11];
      if (d[11] === 0) {
        d[12] = d[12] + 1;
        d[11] = 0;
      }
    }
  } else if (d[12] === 3) {
    g2.eva = 0;
    t.draw = null;
    d[12] = d[12] + 1;
    P.destroyTask(t);
  } else if (d[12] === 4) {
    P.destroyTask(t);
  }
}

// Lua: g2_effects2c.lua:176 -- pokefirered/src/battle_anim_effects_2.c:3346
TASKS.ScaryFace = task(function (t: T): void {
  if (P.tgt() !== "player") {
    t.g2.key = "SCARY_FACE_PLAYER";
  } else {
    t.g2.key = "SCARY_FACE_OPPONENT";
  }
  AnimPal.bgLoad("bg1", t.g2.key);
  t.g2.eva = 0;
  t.z = 850;
  t.draw = bg1_draw;
  t.func = scary_step;
});

// Lua: g2_effects2c.lua:189
function orbit_fast_step(s: S): void {
  const d = s.data;
  if (d[1] >= 64 && d[1] <= 191) {
    s.subpriority = d[7] + 1;
  } else {
    s.subpriority = d[7] - 1;
  }
  s.x2 = P.Sin(d[1], P.asr(d[2], 8));
  s.y2 = P.Cos(d[1], P.asr(d[3], 8));
  d[1] = mod(d[1] + 9, 256);
  if (d[5] === 1) {
    d[2] = P.s16(d[2] - 0x400);
    d[3] = P.s16(d[3] - 0x100);
    d[4] = d[4] + 1;
    if (d[4] === d[0]) {
      d[5] = 2;
      return;
    }
  } else if (d[5] === 0) {
    d[2] = P.s16(d[2] + 0x400);
    d[3] = P.s16(d[3] + 0x100);
    d[4] = d[4] + 1;
    if (d[4] === d[0]) {
      d[4] = 0;
      d[5] = 1;
    }
  }
  if (P.u16(P.arg(7)) === 0xFFFF) P.destroy(s);
}

// Lua: g2_effects2c.lua:220 -- pokefirered/src/battle_anim_effects_2.c:3439
CB.OrbitFast = function (s: S): void {
  const atk = P.atk();
  s.x = P.coord(atk, 2);
  s.y = P.coord(atk, 3);
  s.affineAnimPaused = true;
  s.data[0] = P.arg(0);
  s.data[1] = P.arg(1);
  s.data[7] = P.subpriorityOf(atk);
  s.pcb = orbit_fast_step;
  s.pcb(s);
};

// Lua: g2_effects2c.lua:232
function orbit_scatter_step(s: S): void {
  s.x2 = s.x2 + s.data[0];
  s.y2 = s.y2 + s.data[1];
  if (P.u16(s.x + s.x2 + 16) > P.DISPLAY_WIDTH + 32 || s.y + s.y2 > P.DISPLAY_HEIGHT || s.y + s.y2 < -16) {
    P.destroy(s);
  }
}

// Lua: g2_effects2c.lua:241 -- pokefirered/src/battle_anim_effects_2.c:3490
CB.OrbitScatter = function (s: S): void {
  const atk = P.atk();
  s.x = P.coord(atk, 2);
  s.y = P.coord(atk, 3);
  s.data[0] = P.Sin(P.arg(0), 10);
  s.data[1] = P.Cos(P.arg(0), 7);
  s.pcb = orbit_scatter_step;
};

// Lua: g2_effects2c.lua:250
function spit_up_step(s: S): void {
  s.x2 = s.x2 + s.data[0];
  s.y2 = s.y2 + s.data[1];
  const v = s.data[3];
  s.data[3] = v + 1;
  if (v >= s.data[2]) P.destroy(s);
}

// Lua: g2_effects2c.lua:259 -- pokefirered/src/battle_anim_effects_2.c:3516
CB.SpitUpOrb = function (s: S): void {
  const atk = P.atk();
  s.x = P.coord(atk, 2);
  s.y = P.coord(atk, 3);
  s.data[0] = P.Sin(P.arg(0), 10);
  s.data[1] = P.Cos(P.arg(0), 7);
  s.data[2] = P.arg(1);
  s.pcb = spit_up_step;
};

// Lua: g2_effects2c.lua:269
function eye_sparkle_step(s: S): void {
  if (s.animEnded) P.destroy(s);
}

// Lua: g2_effects2c.lua:274 -- pokefirered/src/battle_anim_effects_2.c:3532
CB.EyeSparkle = function (s: S): void {
  P.InitSpritePosToAnimAttacker(s, true);
  s.pcb = eye_sparkle_step;
};

// Lua: g2_effects2c.lua:279
function angel(s: S): void {
  const d = s.data;
  if (d[0] === 0) {
    s.x = s.x + P.arg(0);
    s.y = s.y + P.arg(1);
  }
  d[0] = d[0] + 1;
  const var0 = mod(d[0] * 10, 256);
  s.x2 = P.asr(P.Sin(var0, 80), 8);
  if (d[0] < 80) {
    s.y2 = P.div(d[0], 2) + P.asr(P.Cos(var0, 80), 8);
  }
  if (d[0] > 90) {
    d[2] = d[2] + 1;
    s.x2 = s.x2 - P.div(d[2], 2);
  }
  if (d[0] > 100) P.destroy(s);
}

// Lua: g2_effects2c.lua:299 -- pokefirered/src/battle_anim_effects_2.c:3538
CB.Angel = function (s: S): void {
  angel(s);
  s.pcb = angel;
};

// Lua: g2_effects2c.lua:304
function pink_heart_step(s: S): void {
  const d = s.data;
  d[5] = d[5] + 1;
  s.x2 = P.Sin(d[3], 5);
  s.y2 = P.div(d[5], 2);
  d[3] = mod(d[3] + 3, 256);
  if (d[5] > 20) s.invisible = mod(d[5], 2) === 1;
  if (d[5] > 30) P.destroy(s);
}

// Lua: g2_effects2c.lua:314
function pink_heart(s: S): void {
  const d = s.data;
  if (d[0] === 0) {
    d[1] = P.arg(0);
    d[2] = P.arg(1);
    d[0] = d[0] + 1;
  } else {
    d[4] = P.s16(d[4] + d[1]);
    s.x2 = P.asr(d[4], 8);
    s.y2 = P.Sin(d[3], d[2]);
    d[3] = mod(d[3] + 3, 256);
    if (d[3] > 70) {
      s.pcb = pink_heart_step;
      s.x = s.x + s.x2;
      s.y = s.y + s.y2;
      s.x2 = 0;
      s.y2 = 0;
      d[3] = mod(P.Random(), 180);
    }
  }
}

// Lua: g2_effects2c.lua:337 -- pokefirered/src/battle_anim_effects_2.c:3577
CB.PinkHeart = function (s: S): void {
  s.pcb = pink_heart;
  pink_heart(s);
};

// Lua: g2_effects2c.lua:342
function devil(s: S): void {
  const d = s.data;
  if (d[3] === 0) {
    s.x = s.x + P.arg(0);
    s.y = s.y + P.arg(1);
    P.startAnim(s, 0);
    s.subpriority = P.subpriorityOf(P.tgt()) - 1;
    d[2] = 1;
  }
  d[0] = d[0] + d[2];
  d[1] = P.mod(d[0] * 4, 256);
  if (d[1] < 0) d[1] = 0;
  s.x2 = P.Cos(d[1], 30 - P.div(d[0], 4));
  s.y2 = P.Sin(d[1], 10 - P.div(d[0], 8));
  if (d[1] > 128 && d[2] > 0) d[2] = -1;
  if (d[1] === 0 && d[2] < 0) d[2] = 1;
  d[3] = d[3] + 1;
  if (d[3] < 10 || d[3] > 80) {
    s.invisible = (P.mod(d[0], 2) !== 0);
  } else {
    s.invisible = false;
  }
  if (d[3] > 90) P.destroy(s);
}

// Lua: g2_effects2c.lua:368 -- pokefirered/src/battle_anim_effects_2.c:3603
CB.Devil = function (s: S): void {
  devil(s);
  s.pcb = devil;
};

// Lua: g2_effects2c.lua:373
function fury_swipes(s: S): void {
  if (s.data[0] === 0) {
    s.x = s.x + P.arg(0);
    s.y = s.y + P.arg(1);
    P.startAnim(s, P.arg(2));
    s.data[0] = s.data[0] + 1;
  } else if (s.animEnded) {
    P.destroy(s);
  }
}

// Lua: g2_effects2c.lua:385 -- pokefirered/src/battle_anim_effects_2.c:3632
CB.FurySwipes = function (s: S): void {
  fury_swipes(s);
  s.pcb = fury_swipes;
};

// Lua: g2_effects2c.lua:390
function movement_waves_step(s: S): void {
  if (s.animEnded) {
    s.data[0] = s.data[0] - 1;
    if (s.data[0] !== 0) {
      P.startAnim(s, s.data[1]);
    } else {
      P.destroy(s);
    }
  }
}

// Lua: g2_effects2c.lua:402 -- pokefirered/src/battle_anim_effects_2.c:3647
CB.MovementWaves = function (s: S): void {
  if (P.arg(2) === 0) {
    P.destroy(s);
    return;
  }
  const b = (P.arg(0) === 0) ? P.atk() : P.tgt();
  s.x = P.coord(b, 2);
  s.y = P.coord(b, 3);
  if (P.arg(1) === 0) s.x = s.x + 32; else s.x = s.x - 32;
  s.data[0] = P.arg(2);
  s.data[1] = P.arg(1);
  P.startAnim(s, s.data[1]);
  s.pcb = movement_waves_step;
};

// Lua: g2_effects2c.lua:417
function affine_until_done(t: T): void {
  if (!P.RunAffineAnimFromTaskData(t)) P.destroyTask(t);
}

// Lua: g2_effects2c.lua:422 -- pokefirered/src/battle_anim_effects_2.c:3689
TASKS.UproarDistortion = task(function (t: T): void {
  const m = P.monById(P.arg(0));
  if (!m) { P.destroyTask(t); return; }
  P.PrepareAffineAnimInTaskData(t, m, P.affineCmds("sUproarAffineAnimCmds"));
  t.func = affine_until_done;
});

// Lua: g2_effects2c.lua:429
function jagged_step(s: S): void {
  s.data[1] = P.s16(s.data[1] + s.data[3]);
  s.data[2] = P.s16(s.data[2] + s.data[4]);
  s.x = P.asr(s.data[1], 3);
  s.y = P.asr(s.data[2], 3);
  s.data[0] = s.data[0] + 1;
  if (s.data[0] > 16) P.destroy(s);
}

// Lua: g2_effects2c.lua:439 -- pokefirered/src/battle_anim_effects_2.c:3703
CB.JaggedMusicNote = function (s: S): void {
  const b = (P.arg(0) === 0) ? P.atk() : P.tgt();
  if (b !== "player") P.setArg(1, -P.arg(1));
  s.x = P.coord(b, 2) + P.arg(1);
  s.y = P.coord(b, 3) + P.arg(2);
  s.data[0] = 0;
  s.data[1] = P.s16(P.u16(s.x) * 8);
  s.data[2] = P.s16(P.u16(s.y) * 8);
  let var1 = P.arg(1) * 8;
  if (var1 < 0) var1 = var1 + 7;
  s.data[3] = P.asr(var1, 3);
  var1 = P.arg(2) * 8;
  if (var1 < 0) var1 = var1 + 7;
  s.data[4] = P.asr(var1, 3);
  s.tileBase = s.tileBase + P.arg(3) * 16;
  s.pcb = jagged_step;
};

// Lua: g2_effects2c.lua:457
function perish_note2(s: S): void {
  const d = s.data;
  if (d[0] === 0) {
    d[1] = 120 - P.arg(0);
    s.invisible = true;
  }
  d[0] = d[0] + 1;
  if (d[0] === d[1]) {
    // require("src.core.game3.battle.anim_pal"): a static import
    AnimPal.greyscale(AnimPal.spriteTag(s, "MUSIC_NOTES_2"), false);
  }
  if (d[0] === d[1] + 80) P.destroy(s);
}

// Lua: g2_effects2c.lua:472 -- pokefirered/src/battle_anim_effects_2.c:3741
CB.PerishSongMusicNote2 = function (s: S): void {
  perish_note2(s);
  s.pcb = perish_note2;
};

// Lua: g2_effects2c.lua:477
function perish_note_step2(s: S): void {
  const d = s.data;
  d[3] = d[3] + d[2];
  s.y2 = d[3];
  d[2] = d[2] + 1;
  if (d[3] > 48 && d[2] > 0) {
    d[2] = d[4] - 5;
    d[4] = d[4] + 1;
  }
  if (d[4] > 3) {
    s.invisible = (P.mod(d[2], 2) !== 0);
    P.destroy(s);
    return;
  }
  if (d[4] === 4) P.destroy(s);
}

// Lua: g2_effects2c.lua:494
function perish_note_step1(s: S): void {
  s.data[0] = s.data[0] + 1;
  if (s.data[0] > 10) {
    s.data[0] = 0;
    s.pcb = perish_note_step2;
  }
}

// Lua: g2_effects2c.lua:502
function perish_note(s: S): void {
  const d = s.data;
  if (d[0] === 0) {
    s.x = 120;
    s.y = P.div(P.arg(0), 2) - 15;
    P.startAnim(s, P.arg(1));
    d[5] = 120;
    d[3] = P.arg(2);
  }
  d[0] = d[0] + 1;
  d[1] = P.div(d[0], 2);
  let index = d[0] * 3 + P.u16(d[3]);
  d[6] = mod(d[6] + 10, 256);
  index = band(index, 0xFF);
  s.x2 = P.Cos(index, 100);
  s.y2 = d[1] + P.Sin(index, 10) + P.Cos(d[6], 4);
  if (d[0] > d[5]) {
    s.pcb = perish_note_step1;
    d[0] = 0;
    s.x = s.x + s.x2;
    s.y = s.y + s.y2;
    s.x2 = 0;
    s.y2 = 0;
    d[2] = 5;
    d[4] = 0;
    d[3] = 0;
    P.startAffineAnim(s, 1);
  }
}

// Lua: g2_effects2c.lua:533 -- pokefirered/src/battle_anim_effects_2.c:3756
CB.PerishSongMusicNote = function (s: S): void {
  perish_note(s);
  if (s.pcb !== perish_note_step1) s.pcb = perish_note;
};

// Lua: g2_effects2c.lua:539 -- pokefirered/src/battle_anim_effects_2.c:3832
CB.GuardRing = function (s: S): void {
  s.x = P.coord(P.atk(), 0);
  s.y = P.coord(P.atk(), 1) + 40;
  s.data[0] = 13;
  s.data[2] = s.x;
  s.data[4] = s.y - 72;
  s.pcb = P.StartAnimLinearTranslation;
  P.storeCallback(s, P.DestroyAnimSprite);
};

// Lua: g2_effects2c.lua:549
function fury_counter(): number {
  const vm = P.vm;
  const ctx = vm ? vm.ctx : null;
  const v = ctx ? (truthy(ctx.furyCutterCounter) ? ctx.furyCutterCounter : ctx.furyCutter) : ctx;
  return tonumber(v) ?? 0;
}

// Lua: g2_effects2c.lua:556 -- pokefirered/src/battle_anim_effects_2.c:3855
TASKS.IsFuryCutterHitRight = task(function (t: T): void {
  P.setArg(7, band(fury_counter(), 1));
  P.destroyTask(t);
});

// Lua: g2_effects2c.lua:562 -- pokefirered/src/battle_anim_effects_2.c:3861
TASKS.GetFuryCutterHitCount = task(function (t: T): void {
  P.setArg(7, fury_counter());
  P.destroyTask(t);
});

// Lua: g2_effects2c.lua:567
export const G2Effects2c = { cb: CB, tasks: TASKS };
export default G2Effects2c;
