// Port of gen1recomp src/core/game3/battle/anim_port/g2_flying.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered battle_anim_flying.c on the g2_pret kit.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, truthy } from "../../../../../import/gen3/lua.ts";
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

// Lua: g2_flying.lua:6 -- local band = bit.band
const band = (a: number, b: number): number => a & b;

// Lua: g2_flying.lua:8
function elliptical_gust_step(s: S): void {
  s.x2 = P.Sin(s.data[1], 32);
  s.y2 = P.Cos(s.data[1], 8);
  s.data[1] = mod(s.data[1] + 5, 256);
  s.data[0] = s.data[0] + 1;
  if (s.data[0] === 71) P.destroy(s);
}

// Lua: g2_flying.lua:17 -- pokefirered/src/battle_anim_flying.c:360
CB.EllipticalGust = function (s: S): void {
  P.InitSpritePosToAnimTarget(s, false);
  s.y = s.y + 20;
  s.data[1] = 191;
  s.pcb = elliptical_gust_step;
  s.pcb(s);
};

// Lua: g2_flying.lua:25
function gust_palette_step(t: T): void {
  const d = t.data;
  const old = d[10];
  d[10] = d[10] + 1;
  if (old === d[1]) {
    d[10] = 0;
    const f = AnimPal.writeFaded("GUST");
    if (f) {
      const temp = f[8];
      for (let i = 7; i >= 1; i--) f[i + 1] = f[i];
      f[1] = temp;
    }
  }
  d[0] = d[0] - 1;
  if (d[0] === 0) P.destroyTask(t);
}

// Lua: g2_flying.lua:43 -- pokefirered/src/battle_anim_flying.c:380
TASKS.AnimateGustTornadoPalette = task(function (t: T): void {
  t.data[0] = P.arg(1);
  t.data[1] = P.arg(0);
  t.func = gust_palette_step;
});

// Lua: g2_flying.lua:49
function gust_to_target_step(s: S): void {
  if (P.AnimTranslateLinear(s)) P.destroy(s);
}

// Lua: g2_flying.lua:54 -- pokefirered/src/battle_anim_flying.c:412
CB.GustToTarget = function (s: S): void {
  P.InitSpritePosToAnimAttacker(s, true);
  if (P.atk() !== "player") P.setArg(2, -P.arg(2));
  s.data[0] = P.arg(4);
  s.data[1] = s.x;
  s.data[2] = P.coord(P.tgt(), 2) + P.arg(2);
  s.data[3] = s.y;
  s.data[4] = P.coord(P.tgt(), 3) + P.arg(3);
  P.InitAnimLinearTranslation(s);
  s.pcb = P.RunStoredCallbackWhenAffineAnimEnds;
  P.storeCallback(s, gust_to_target_step);
};

// Lua: g2_flying.lua:68 -- pokefirered/src/battle_anim_flying.c:433
CB.AirWaveCrescent = function (s: S): void {
  if (P.atk() !== "player") {
    for (let i = 0; i <= 3; i++) P.setArg(i, -P.arg(i));
  }
  const atk = P.atk();
  s.x = P.coord(atk, 2);
  s.y = P.coord(atk, 3);
  s.x = s.x + P.arg(0);
  s.y = s.y + P.arg(1);
  s.data[0] = P.arg(4);
  if (P.arg(6) === 0) {
    s.data[2] = P.coord(P.tgt(), 2);
    s.data[4] = P.coord(P.tgt(), 3);
  } else {
    [s.data[2], s.data[4]] = P.SetAverageBattlerPositions(P.tgt(), true);
  }
  s.data[2] = s.data[2] + P.arg(2);
  s.data[4] = s.data[4] + P.arg(3);
  s.pcb = P.StartAnimLinearTranslation;
  P.storeCallback(s, P.DestroyAnimSprite);
  P.seekAnim(s, P.arg(5));
};

// Lua: g2_flying.lua:91
function fly_ball_up_step(s: S): void {
  if (s.data[0] > 0) {
    s.data[0] = s.data[0] - 1;
  } else {
    s.data[2] = P.s16(s.data[2] + s.data[1]);
    s.y2 = s.y2 - P.asr(s.data[2], 8);
  }
  if (s.y + s.y2 < -32) P.destroy(s);
}

// Lua: g2_flying.lua:102 -- pokefirered/src/battle_anim_flying.c:468
CB.FlyBallUp = function (s: S): void {
  P.InitSpritePosToAnimAttacker(s, true);
  s.data[0] = P.arg(2);
  s.data[1] = P.arg(3);
  s.pcb = fly_ball_up_step;
  const m = P.monById(P.ANIM_ATTACKER);
  if (m) m.invisible = true;
};

// Lua: g2_flying.lua:111
function fly_ball_attack_step(s: S): void {
  s.data[0] = 1;
  P.AnimTranslateLinear(s);
  if (Math.floor(P.u16(s.data[3]) / 256) > 200) {
    s.x = s.x + s.x2;
    s.x2 = 0;
    s.data[3] = mod(s.data[3], 256);
  }
  if (s.x + s.x2 < -32 || s.x + s.x2 > P.DISPLAY_WIDTH + 32 || s.y + s.y2 > P.DISPLAY_HEIGHT) {
    const m = P.monById(P.ANIM_ATTACKER);
    if (m) m.invisible = false;
    P.destroy(s);
  }
}

// Lua: g2_flying.lua:127 -- pokefirered/src/battle_anim_flying.c:492
CB.FlyBallAttack = function (s: S): void {
  if (P.atk() !== "player") {
    s.x = P.DISPLAY_WIDTH + 32;
    s.y = -32;
    P.startAffineAnim(s, 1);
  } else {
    s.x = -32;
    s.y = -32;
  }
  s.data[0] = P.arg(0);
  s.data[1] = s.x;
  s.data[2] = P.coord(P.tgt(), 2);
  s.data[3] = s.y;
  s.data[4] = P.coord(P.tgt(), 3);
  P.InitAnimLinearTranslation(s);
  s.pcb = fly_ball_attack_step;
};

// Lua: g2_flying.lua:146 -- pokefirered/src/battle_anim_flying.c:533
function destroy_after_timer(s: S): void {
  const v = s.data[0];
  s.data[0] = v - 1;
  if (v <= 0) P.destroy(s);
}

// Lua: g2_flying.lua:152
function feather_matrix(s: S, f: any): void {
  const sinIndex = P.u8(P.asr(-s.x2, 1) + f.unkA);
  const sinVal = P.sine(sinIndex);
  const c = P.sine(sinIndex + 64);
  P.setMatrix(s, c, sinVal, -sinVal, c);
}

// Lua: g2_flying.lua:159
function feather_flip(s: S, f: any): void {
  s.pHFlip = !truthy(s.pHFlip);
  P.startAnim(s, s.pHFlip ? 1 : 0);
  if (f.unk0_0c !== 0) {
    if (f.unkE_0 === 0) {
      s.oamPriority = s.oamPriority - 1;
    } else {
      s.oamPriority = s.oamPriority + 1;
    }
    f.unkE_0 = 1 - f.unkE_0;
  }
  f.unk0_0d = 0;
}

// Lua: g2_flying.lua:173
function falling_feather_step(s: S): void {
  const f = s.g2.f;
  if (f.unk0_0a !== 0) {
    const old = f.unk1;
    f.unk1 = mod(old - 1, 256);
    if (mod(old, 256) === 0) {
      f.unk0_0a = 0;
      f.unk1 = 0;
    }
    return;
  }
  const q = Math.floor(f.unk2 / 64);
  const u = mod(f.unk0_1, 256);
  if (q === 0) {
    if (u === 1) {
      f.unk0_0d = 1; f.unk0_0a = 1; f.unk1 = 0;
    } else if (u === 3) {
      f.unk0_0b = 1 - f.unk0_0b; f.unk0_0a = 1; f.unk1 = 0;
    } else if (f.unk0_0d !== 0) {
      feather_flip(s, f);
    }
    f.unk0_1 = 0;
  } else if (q === 1) {
    if (u === 0) {
      f.unk0_0d = 1; f.unk0_0a = 1; f.unk1 = 0;
    } else if (u === 2) {
      f.unk0_0a = 1; f.unk1 = 0;
    } else if (f.unk0_0d !== 0) {
      feather_flip(s, f);
    }
    f.unk0_1 = 1;
  } else if (q === 2) {
    if (u === 3) {
      f.unk0_0d = 1; f.unk0_0a = 1; f.unk1 = 0;
    } else if (u === 1) {
      f.unk0_0a = 1; f.unk1 = 0;
    } else if (f.unk0_0d !== 0) {
      feather_flip(s, f);
    }
    f.unk0_1 = 2;
  } else if (q === 3) {
    if (u === 2) {
      f.unk0_0d = 1;
    } else if (u === 0) {
      f.unk0_0b = 1 - f.unk0_0b; f.unk0_0a = 1; f.unk1 = 0;
    } else if (f.unk0_0d !== 0) {
      feather_flip(s, f);
    }
    f.unk0_1 = 3;
  }
  s.x2 = P.asr(f.unkC[f.unk0_0b] * P.sine(f.unk2), 8);
  feather_matrix(s, f);
  f.unk8 = P.u16(f.unk8 + f.unk6);
  s.y = Math.floor(f.unk8 / 256);
  if (band(f.unk4, 0x8000) !== 0) {
    f.unk2 = mod(f.unk2 - band(f.unk4, 0x7FFF), 256);
  } else {
    f.unk2 = mod(f.unk2 + band(f.unk4, 0x7FFF), 256);
  }
  if (s.y + s.y2 >= f.unkE_1) {
    s.data[0] = 0;
    s.pcb = destroy_after_timer;
  }
}

// Lua: g2_flying.lua:239 -- pokefirered/src/battle_anim_flying.c:565
CB.FallingFeather = function (s: S): void {
  let b: any;
  if (band(P.arg(7), 0x100) !== 0) b = P.atk(); else b = P.tgt();
  if (b === "player") P.setArg(0, -P.arg(0));
  s.x = P.coord(b, 0) + P.arg(0);
  const spriteCoord = P.coord(b, 1);
  s.y = spriteCoord + P.arg(1);
  const f: any = {
    unk0_0a: 0, unk0_0b: 0, unk0_0c: 1, unk0_0d: 0, unk0_1: 0, unk1: 0,
    unk8: P.u16(s.y * 256),
    unkE_1: band(spriteCoord + P.arg(6), 0x7FFF),
    unk2: band(P.arg(2), 0xFF),
    unkA: band(P.asr(P.arg(2), 8), 0xFF),
    unk4: P.u16(P.arg(3)),
    unk6: P.u16(P.arg(4)),
    unkC: [band(P.arg(5), 0xFF), band(P.asr(P.arg(5), 8), 0xFF)],
    unkE_0: 0,
  };
  s.g2.f = f;
  if (f.unk2 >= 64 && f.unk2 <= 191) {
    s.oamPriority = P.bgPriority(b) + 1;
    f.unkE_0 = 0;
    if (band(f.unk4, 0x8000) === 0) {
      s.pHFlip = !truthy(s.pHFlip);
      P.startAnim(s, s.pHFlip ? 1 : 0);
    }
  } else {
    s.oamPriority = P.bgPriority(b);
    f.unkE_0 = 1;
    if (band(f.unk4, 0x8000) !== 0) {
      s.pHFlip = !truthy(s.pHFlip);
      P.startAnim(s, s.pHFlip ? 1 : 0);
    }
  }
  f.unk0_1 = Math.floor(f.unk2 / 64);
  s.x2 = P.asr(P.sine(f.unk2) * f.unkC[0], 8);
  feather_matrix(s, f);
  s.pcb = falling_feather_step;
};

// Lua: g2_flying.lua:279
function whirlwind_line_step(s: S): void {
  s.x2 = s.x2 + P.asr(s.data[1], 8);
  s.data[0] = s.data[0] + 1;
  if (s.data[0] === 6) {
    s.data[0] = 0;
    s.x2 = 0;
    P.startAnim(s, 0);
  }
  s.data[7] = s.data[7] - 1;
  if (s.data[7] === -1) P.destroy(s);
}

// Lua: g2_flying.lua:292 -- pokefirered/src/battle_anim_flying.c:988
CB.WhirlwindLine = function (s: S): void {
  if (P.arg(2) === P.ANIM_ATTACKER) {
    P.InitSpritePosToAnimAttacker(s, false);
  } else {
    P.InitSpritePosToAnimTarget(s, false);
  }
  if ((P.arg(2) === P.ANIM_ATTACKER && P.atk() === "player") || (P.arg(2) === P.ANIM_TARGET && P.tgt() === "player")) {
    s.x = s.x + 8;
  }
  P.seekAnim(s, P.arg(4));
  s.x = s.x - 32;
  s.data[1] = 0x0ccc;
  const arg = P.u16(P.arg(4));
  s.x2 = s.x2 + 12 * arg;
  s.data[0] = P.s16(arg);
  s.data[7] = P.arg(3);
  s.pcb = whirlwind_line_step;
};

// Lua: g2_flying.lua:311
function drill_peck_step(t: T): void {
  if (mod(t.data[0], 32) === 0) {
    P.setArg(0, P.Sin(t.data[0], -13));
    P.setArg(1, P.Cos(t.data[0], -13));
    P.setArg(2, 1);
    P.setArg(3, 3);
    const tb = P.tgt();
    P.createSprite("gFlashingHitSplatSpriteTemplate", P.coord(tb, 2), P.coord(tb, 3), 3, true, true);
  }
  t.data[0] = t.data[0] + 8;
  if (t.data[0] > 255) P.destroyTask(t);
}

// Lua: g2_flying.lua:325 -- pokefirered/src/battle_anim_flying.c:1025
TASKS.DrillPeckHitSplats = task(function (t: T, _vm: any): void {
  t.func = drill_peck_step;
  drill_peck_step(t);
});

// Lua: g2_flying.lua:330
function bounce_ball_shrink(s: S): void {
  if (s.data[0] === 0) {
    P.InitSpritePosToAnimAttacker(s, true);
    const m = P.monById(P.ANIM_ATTACKER);
    if (m) m.invisible = true;
    s.data[0] = s.data[0] + 1;
  } else if (s.data[0] === 1) {
    if (s.affineAnimEnded) P.destroy(s);
  }
}

// Lua: g2_flying.lua:342 -- pokefirered/src/battle_anim_flying.c:1044
CB.BounceBallShrink = function (s: S): void {
  bounce_ball_shrink(s);
  s.pcb = bounce_ball_shrink;
};

// Lua: g2_flying.lua:347
function bounce_ball_land(s: S): void {
  if (s.data[0] === 0) {
    s.y = P.coord(P.tgt(), 1);
    s.y2 = -s.y - 32;
    s.data[0] = s.data[0] + 1;
  } else if (s.data[0] === 1) {
    s.y2 = s.y2 + 10;
    if (s.y2 >= 0) s.data[0] = s.data[0] + 1;
  } else if (s.data[0] === 2) {
    s.y2 = s.y2 - 10;
    if (s.y + s.y2 < -32) {
      const m = P.monById(P.ANIM_ATTACKER);
      if (m) m.invisible = false;
      P.destroy(s);
    }
  }
}

// Lua: g2_flying.lua:366 -- pokefirered/src/battle_anim_flying.c:1060
CB.BounceBallLand = function (s: S): void {
  bounce_ball_land(s);
  s.pcb = bounce_ball_land;
};

// Lua: g2_flying.lua:371
function dive_ball_step2(s: S): void {
  s.y2 = s.y2 + P.asr(s.data[2], 8);
  if (s.y + s.y2 > -32) s.invisible = false;
  if (s.y2 > 0) P.destroy(s);
}

// Lua: g2_flying.lua:377
function dive_ball_step1(s: S): void {
  if (s.data[0] > 0) {
    s.data[0] = s.data[0] - 1;
  } else if (s.y + s.y2 > -32) {
    s.data[2] = P.s16(s.data[2] + s.data[1]);
    s.y2 = s.y2 - P.asr(s.data[2], 8);
  } else {
    s.invisible = true;
    const v = s.data[3];
    s.data[3] = v + 1;
    if (v > 20) s.pcb = dive_ball_step2;
  }
}

// Lua: g2_flying.lua:392 -- pokefirered/src/battle_anim_flying.c:1085
CB.DiveBall = function (s: S): void {
  P.InitSpritePosToAnimAttacker(s, true);
  s.data[0] = P.arg(2);
  s.data[1] = P.arg(3);
  s.pcb = dive_ball_step1;
  const m = P.monById(P.ANIM_ATTACKER);
  if (m) m.invisible = true;
};

// Lua: g2_flying.lua:401
function dive_water_splash(s: S): void {
  if (s.data[0] === 0) {
    const b = (P.arg(0) === 0) ? P.atk() : P.tgt();
    s.x = P.coord(b, 0);
    s.y = P.coord(b, 1);
    s.data[1] = 512;
    P.trySetRotScale(s, false, 256, s.data[1], 0);
    s.data[0] = s.data[0] + 1;
  } else if (s.data[0] === 1) {
    if (s.data[2] <= 11) {
      s.data[1] = s.data[1] - 40;
    } else {
      s.data[1] = s.data[1] + 40;
    }
    s.data[2] = s.data[2] + 1;
    P.trySetRotScale(s, false, 256, s.data[1], 0);
    let t2 = P.div(15616, s.matD) + 1;
    if (t2 > 128) t2 = 128;
    t2 = P.div(64 - t2, 2);
    s.y2 = t2;
    if (s.data[2] === 24) {
      P.tryResetAffine(s);
      P.destroy(s);
    }
  }
}

// Lua: g2_flying.lua:429 -- pokefirered/src/battle_anim_flying.c:1122
CB.DiveWaterSplash = function (s: S): void {
  dive_water_splash(s);
  s.pcb = dive_water_splash;
};

// Lua: g2_flying.lua:434
function spray_droplet_step(s: S): void {
  if (s.data[2] === 0) {
    s.x2 = s.x2 + P.asr(s.data[0], 8);
    s.y2 = s.y2 - P.asr(s.data[1], 8);
  } else {
    s.x2 = s.x2 - P.asr(s.data[0], 8);
    s.y2 = s.y2 - P.asr(s.data[1], 8);
  }
  s.data[1] = s.data[1] - 32;
  if (s.data[0] < 0) s.data[0] = 0;
  s.data[3] = s.data[3] + 1;
  if (s.data[3] === 31) P.destroy(s);
}

// Lua: g2_flying.lua:449 -- pokefirered/src/battle_anim_flying.c:1168
CB.SprayWaterDroplet = function (s: S): void {
  const v1 = band(0x1FF, P.Random());
  const v2 = band(0x7F, P.Random());
  if (mod(v1, 2) === 1) s.data[0] = 736 + v1; else s.data[0] = 736 - v1;
  if (mod(v2, 2) === 1) s.data[1] = 896 + v2; else s.data[1] = 896 - v2;
  s.data[2] = P.arg(0);
  if (s.data[2] !== 0) {
    s.pHFlip = true;
    s.pVFlip = false;
  }
  const b = (P.arg(1) === 0) ? P.atk() : P.tgt();
  s.x = P.coord(b, 0);
  s.y = P.coord(b, 1) + 32;
  s.pcb = spray_droplet_step;
};

// Lua: g2_flying.lua:465
function sky_attack_bird_step(s: S): void {
  s.data[4] = P.s16(s.data[4] + s.data[6]);
  s.data[5] = P.s16(s.data[5] + s.data[7]);
  s.x = P.asr(s.data[4], 4);
  s.y = P.asr(s.data[5], 4);
  if (s.x > P.DISPLAY_WIDTH + 45 || s.x < -45 || s.y > 157 || s.y < -45) {
    P.destroy(s);
  }
}

// Lua: g2_flying.lua:476 -- pokefirered/src/battle_anim_flying.c:1244
CB.SkyAttackBird = function (s: S): void {
  const posx = s.x, posy = s.y;
  const atk = P.atk();
  s.x = P.coord(atk, 2);
  s.y = P.coord(atk, 3);
  s.data[4] = P.s16(s.x * 16);
  s.data[5] = P.s16(s.y * 16);
  s.data[6] = P.div((posx - s.x) * 16, 12);
  s.data[7] = P.div((posy - s.y) * 16, 12);
  let rotation = P.ArcTan2Neg(posx - s.x, posy - s.y);
  rotation = P.u16(rotation + 49152);
  P.trySetRotScale(s, true, 0x100, 0x100, rotation);
  s.pcb = sky_attack_bird_step;
};

// Lua: g2_flying.lua:491
export const G2Flying = { cb: CB, tasks: TASKS };
export default G2Flying;
