// Port of gen1recomp src/core/game3/battle/anim_port/g1_callbacks.lua (GPLv3 + additional terms; see LICENSE.md).
// Group 1 sprite callbacks (battle_anim_normal.c hit splats, battle_anim_mons.c
// generic movers, battle_anim_effects_1.c grass / powder / roots ...); part B
// is g1_callbacks_b. anim_callbacks merges the table by name.
//
// Port notes:
// - A lazily-required module: anim_callbacks pcall(require)s
//   "src.core.game3.battle.anim_port.g1_callbacks"; it is registered in G3Lazy.
// - NOT FAITHFUL (ES module order): Brian fills C at require time
//   (`C.X = S.wrap(...)`, `B(C, F)`), calling into g1_sprite / g1_callbacks_b.
//   Module-scope code must not call an import here, so the body is
//   loadG1Callbacks(), run once on first use. The G3Lazy entry is that loader
//   as a function module (anim_callbacks calls a function entry and merges what
//   it returns); C itself is exported for direct importers, who call the loader
//   first (g1_tasks does).
// - math.random -> random() (platform/rng.ts).
// - Brian's module-scope aliases (s16, u16, Sin, Cos) are not taken at load;
//   the functions call P.* directly.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod } from "../../../../../import/gen3/lua.ts";
import { random } from "../../../platform/rng.ts";
import { G3Lazy } from "../../lazy_registry.ts";
import { P } from "./g1_pret.ts";
import { S } from "./g1_sprite.ts";
import G1CallbacksB from "./g1_callbacks_b.ts";

export const C: Record<string, any> = {};
const F: Record<string, any> = {};

// Lua: g1_callbacks.lua:12
function random16(): number {
  return random(0, 0xFFFF);
}

// Lua: g1_callbacks.lua:16
function atk_opp(s: any): boolean {
  return P.isOpponent(P.atk(s._vm));
}

let built = false;

// Lua: g1_callbacks.lua:1..742 (the module body; see the header)
export function loadG1Callbacks(): Record<string, any> {
  if (built) return C;
  built = true;

  // Lua: g1_callbacks.lua:21 -- pokefirered/src/battle_anim_normal.c:283
  F.ConfusionDuckStep = function (s: any): void {
    const d = s.data;
    s.ox = P.Cos(d[0], 30);
    s.oy = P.Sin(d[0], 10);
    if (P.u16(d[0]) < 128) s._pri = 1; else s._pri = 3;
    d[0] = (d[0] + d[1]) & 0xFF;
    d[2] = d[2] + 1;
    if (d[2] === d[3]) S.destroy(s);
  };

  // Lua: g1_callbacks.lua:32 -- pokefirered/src/battle_anim_normal.c:262
  C.ConfusionDuck = S.wrap(function (s: any): void {
    const A = s._A, d = s.data;
    s.x = s.x + A[0];
    s.y = s.y + A[1];
    d[0] = A[2];
    if (atk_opp(s)) {
      d[1] = -A[3];
      d[4] = 1;
    } else {
      d[1] = A[3];
      d[4] = 0;
      S.startAnim(s, 1);
    }
    d[3] = A[4];
    s._cb = F.ConfusionDuckStep;
    s._cb(s);
  });

  // Lua: g1_callbacks.lua:51 -- pokefirered/src/battle_anim_normal.c:911
  function hit_splat_basic(s: any): void {
    const A = s._A;
    S.startAffineAnim(s, A[3]);
    if (A[2] === 0) S.initPosToAttacker(s, true); else S.initPosToTarget(s, true);
    s._cb = S.runStoredWhenAffineEnds;
    S.store(s, S.destroy);
  }
  C.HitSplatBasic = S.wrap(hit_splat_basic);

  // Lua: g1_callbacks.lua:61 -- pokefirered/src/battle_anim_normal.c:923
  C.HitSplatPersistent = S.wrap(function (s: any): void {
    const A = s._A;
    S.startAffineAnim(s, A[3]);
    if (A[2] === 0) S.initPosToAttacker(s, true); else S.initPosToTarget(s, true);
    s.data[0] = A[4];
    s._cb = S.runStoredWhenAffineEnds;
    S.store(s, F.DestroyAfterTimer);
  });

  // Lua: g1_callbacks.lua:71 -- pokefirered/src/battle_anim_flying.c:533
  F.DestroyAfterTimer = function (s: any): void {
    const old = s.data[0];
    s.data[0] = old - 1;
    if (old <= 0) S.destroy(s);
  };

  // Lua: g1_callbacks.lua:78 -- pokefirered/src/battle_anim_normal.c:937
  C.HitSplatHandleInvert = S.wrap(function (s: any): void {
    if (atk_opp(s)) s._A[1] = -s._A[1];
    hit_splat_basic(s);
  });

  // Lua: g1_callbacks.lua:84 -- pokefirered/src/battle_anim_normal.c:944
  C.HitSplatRandom = S.wrap(function (s: any): void {
    const A = s._A;
    if (A[1] === -1) A[1] = random16() & 3;
    S.startAffineAnim(s, A[1]);
    if (A[0] === P.ANIM_ATTACKER) S.initPosToAttacker(s, false); else S.initPosToTarget(s, false);
    s.ox = s.ox + mod(random16(), 48) - 24;
    s.oy = s.oy + mod(random16(), 24) - 12;
    S.store(s, S.destroy);
    s._cb = S.runStoredWhenAffineEnds;
  });

  // Lua: g1_callbacks.lua:96 -- pokefirered/src/battle_anim_normal.c:959
  C.HitSplatOnMonEdge = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    const side = P.sideOf(vm, A[0]);
    const p = P.present(side);
    s.x = P.coord(vm, side, P.X_2) + (p ? (p.ox ?? 0) : 0);
    s.y = P.coord(vm, side, P.Y_PIC_OFFSET_DEFAULT) + (p ? (p.oy ?? 0) : 0);
    s.ox = A[1];
    s.oy = A[2];
    S.startAffineAnim(s, A[3]);
    S.store(s, S.destroy);
    s._cb = S.runStoredWhenAffineEnds;
  });

  // Lua: g1_callbacks.lua:110 -- pokefirered/src/battle_anim_normal.c:971
  C.CrossImpact = S.wrap(function (s: any): void {
    const A = s._A;
    if (A[2] === P.ANIM_ATTACKER) S.initPosToAttacker(s, true); else S.initPosToTarget(s, true);
    s.data[0] = A[3];
    S.store(s, S.destroy);
    s._cb = S.waitAnimForDuration;
  });

  // Lua: g1_callbacks.lua:119 -- pokefirered/src/battle_anim_normal.c:992
  F.FlashingHitSplatStep = function (s: any): void {
    s.visible = !s.visible;
    const old = s.data[0];
    s.data[0] = old + 1;
    if (old > 12) S.destroy(s);
  };

  // Lua: g1_callbacks.lua:127 -- pokefirered/src/battle_anim_normal.c:982
  C.FlashingHitSplat = S.wrap(function (s: any): void {
    const A = s._A;
    S.startAffineAnim(s, A[3]);
    if (A[2] === P.ANIM_ATTACKER) S.initPosToAttacker(s, true); else S.initPosToTarget(s, true);
    s._cb = F.FlashingHitSplatStep;
  });

  // Lua: g1_callbacks.lua:135 -- pokefirered/src/battle_anim_mons.c:1409
  C.SpriteOnMonPos = S.wrap(function (s: any): void {
    s._cb = function (sp: any): void {
      if (sp.data[0] === 0) {
        const v = sp._A[3] === 0;
        if (sp._A[2] === 0) S.initPosToAttacker(sp, v); else S.initPosToTarget(sp, v);
        sp.data[0] = sp.data[0] + 1;
      } else if (sp.animEnded || sp.affineAnimEnded) {
        S.destroy(sp);
      }
    };
    s._cb(s);
  });

  // Lua: g1_callbacks.lua:149 -- pokefirered/src/battle_anim_mons.c:1440
  C.TranslateAnimSpriteToTargetMonLocation = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    const respect = (P.u16(A[5]) & 0xFF00) === 0;
    const coordType = (P.u16(A[5]) & 0xFF) === 0 ? P.Y_PIC_OFFSET : P.Y;
    S.initPosToAttacker(s, respect);
    if (atk_opp(s)) A[2] = -A[2];
    s.data[0] = A[4];
    s.data[2] = P.coord(vm, P.tgt(vm), P.X_2) + A[2];
    s.data[4] = P.coord(vm, P.tgt(vm), coordType) + A[3];
    s._cb = S.startLinear;
    S.store(s, S.destroy);
  });

  // Lua: g1_callbacks.lua:163 -- pokefirered/src/battle_anim_mons.c:1463
  C.ThrowProjectile = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    S.initPosToAttacker(s, true);
    if (atk_opp(s)) A[2] = -A[2];
    s.data[0] = A[4];
    s.data[2] = P.coord(vm, P.tgt(vm), P.X_2) + A[2];
    s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + A[3];
    s.data[5] = A[5];
    S.initArc(s);
    s._cb = function (sp: any): void {
      if (S.translateHArc(sp)) S.destroy(sp);
    };
  });

  // Lua: g1_callbacks.lua:178 -- pokefirered/src/battle_anim_mons.c:1482
  C.TravelDiagonally = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    let r4: boolean, coordType: number, side: any;
    if (A[6] === 0) {
      r4 = true;
      coordType = P.Y_PIC_OFFSET;
    } else {
      r4 = false;
      coordType = P.Y;
    }
    if (A[5] === 0) {
      S.initPosToAttacker(s, r4);
      side = P.atk(vm);
    } else {
      S.initPosToTarget(s, r4);
      side = P.tgt(vm);
    }
    if (atk_opp(s)) A[2] = -A[2];
    S.initPosToTarget(s, r4);
    s.data[0] = A[4];
    s.data[2] = P.coord(vm, side, P.X_2) + A[2];
    s.data[4] = P.coord(vm, side, coordType) + A[3];
    s._cb = S.startLinear;
    S.store(s, S.destroy);
  });

  // Lua: g1_callbacks.lua:205 -- pokefirered/src/battle_anim_mons.c:2188
  C.SpinningSparkle = S.wrap(function (s: any): void {
    const A = s._A;
    S.setToAttackerCoords(s);
    if (atk_opp(s)) s.x = s.x - A[0]; else s.x = s.x + A[0];
    s.y = s.y + A[1];
    s._cb = S.runStoredWhenAnimEnds;
    S.store(s, S.destroy);
  });

  // Lua: g1_callbacks.lua:215 -- pokefirered/src/battle_anim_mons.c:2327
  F.WeatherBallUpStep = function (s: any): void {
    const d = s.data;
    d[2] = P.s16(d[2] + d[0]);
    d[3] = P.s16(d[3] + d[1]);
    s.ox = P.cdiv(d[2], 10);
    s.oy = P.cdiv(d[3], 10);
    if (d[1] < -20) d[1] = d[1] + 1;
    if (s.y + s.oy < -32) S.destroy(s);
  };

  // Lua: g1_callbacks.lua:226 -- pokefirered/src/battle_anim_mons.c:2315
  C.WeatherBallUp = S.wrap(function (s: any): void {
    const vm = s._vm;
    s.x = P.coord(vm, P.atk(vm), P.X_2);
    s.y = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
    if (!atk_opp(s)) s.data[0] = 5; else s.data[0] = -10;
    s.data[1] = -40;
    s._cb = F.WeatherBallUpStep;
  });

  // Lua: g1_callbacks.lua:236 -- pokefirered/src/battle_anim_mons.c:2339
  C.WeatherBallDown = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    s.data[0] = A[2];
    s.data[2] = s.x + A[4];
    s.data[4] = s.y + A[5];
    if (!P.isOpponent(P.tgt(vm))) {
      s.x = P.s16(s.x + P.u16(A[4]) + 30);
      s.y = A[5] - 20;
    } else {
      s.x = P.s16(s.x + P.u16(A[4]) - 30);
      s.y = A[5] - 80;
    }
    s._cb = S.startLinear;
    S.store(s, S.destroy);
  });

  // Lua: g1_callbacks.lua:253 -- pokefirered/src/battle_anim_effects_1.c:2247
  F.MovePowderParticleStep = function (s: any): void {
    const d = s.data;
    if (d[0] > 0) {
      d[0] = d[0] - 1;
      s.oy = d[2] >> 8;
      d[2] = P.s16(d[2] + d[1]);
      s.ox = P.Sin(d[5], d[3]);
      d[5] = (d[5] + d[4]) & 0xFF;
    } else {
      S.destroy(s);
    }
  };

  // Lua: g1_callbacks.lua:267 -- pokefirered/src/battle_anim_effects_1.c:2227
  C.MovePowderParticle = S.wrap(function (s: any): void {
    const A = s._A, d = s.data;
    s.x = s.x + A[0];
    s.y = s.y + A[1];
    d[0] = A[2];
    d[1] = A[3];
    if (atk_opp(s)) d[3] = -A[4]; else d[3] = A[4];
    d[4] = A[5];
    s._cb = F.MovePowderParticleStep;
  });

  // Lua: g1_callbacks.lua:279 -- pokefirered/src/battle_anim_effects_1.c:2267
  C.PowerAbsorptionOrb = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    S.initPosToAttacker(s, true);
    s.data[0] = A[2];
    s.data[2] = P.coord(vm, P.atk(vm), P.X_2);
    s.data[4] = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
    s._cb = S.startLinear;
    S.store(s, S.destroy);
  });

  // Lua: g1_callbacks.lua:290 -- pokefirered/src/battle_anim_effects_1.c:2282
  C.SolarBeamBigOrb = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    S.initPosToAttacker(s, true);
    S.startAnim(s, A[3]);
    s.data[0] = A[2];
    s.data[2] = P.coord(vm, P.tgt(vm), P.X_2);
    s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET);
    s._cb = S.startLinear;
    S.store(s, S.destroy);
  });

  // Lua: g1_callbacks.lua:302 -- pokefirered/src/battle_anim_effects_1.c:2313
  F.SolarBeamSmallOrbStep = function (s: any): void {
    const vm = s._vm;
    if (S.translateLinear(s)) {
      S.destroy(s);
    } else {
      if (s.data[5] > 0x7F) {
        s.subpriority = P.subpriorityOf(P.tgt(vm)) + 1;
      } else {
        s.subpriority = P.subpriorityOf(P.tgt(vm)) + 6;
      }
      s.ox = s.ox + P.Sin(s.data[5], 5);
      s.oy = s.oy + P.Cos(s.data[5], 14);
      s.data[5] = (s.data[5] + 15) & 0xFF;
    }
  };

  // Lua: g1_callbacks.lua:319 -- pokefirered/src/battle_anim_effects_1.c:2299
  C.SolarBeamSmallOrb = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm, d = s.data;
    S.initPosToAttacker(s, true);
    d[0] = A[2];
    d[1] = s.x;
    d[2] = P.coord(vm, P.tgt(vm), P.X_2);
    d[3] = s.y;
    d[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET);
    S.initLinear(s);
    d[5] = A[3];
    s._cb = F.SolarBeamSmallOrbStep;
    s._cb(s);
  });

  // Lua: g1_callbacks.lua:334 -- pokefirered/src/battle_anim_effects_1.c:2357
  C.AbsorptionOrb = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    S.initPosToTarget(s, true);
    s.data[0] = A[3];
    s.data[2] = P.coord(vm, P.atk(vm), P.X_2);
    s.data[4] = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
    s.data[5] = A[2];
    S.initArc(s);
    s._cb = function (sp: any): void {
      if (S.translateHArc(sp)) S.destroy(sp);
    };
  });

  // Lua: g1_callbacks.lua:348 -- pokefirered/src/battle_anim_effects_1.c:2402
  F.HyperBeamOrbStep = function (s: any): void {
    const d = s.data;
    if (S.fastTranslateLinear(s)) {
      S.destroy(s);
    } else {
      s.oy = s.oy + P.Cos(d[5], 12);
      if (d[5] < 0x7F) s.subpriority = d[6]; else s.subpriority = d[6] + 1;
      d[5] = (d[5] + 24) & 0xFF;
    }
  };

  // Lua: g1_callbacks.lua:360 -- pokefirered/src/battle_anim_effects_1.c:2376
  C.HyperBeamOrb = S.wrap(function (s: any): void {
    const vm = s._vm, d = s.data;
    S.startAnim(s, mod(random16(), 8));
    s.x = P.coord(vm, P.atk(vm), P.X_2);
    s.y = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
    if (atk_opp(s)) s.x = s.x - 20; else s.x = s.x + 20;
    d[0] = (random16() & 31) + 64;
    d[1] = s.x;
    d[2] = P.coord(vm, P.tgt(vm), P.X_2);
    d[3] = s.y;
    d[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET);
    S.initFastLinearWithSpeed(s);
    d[5] = random16() & 0xFF;
    d[6] = s.subpriority;
    s._cb = F.HyperBeamOrbStep;
    s._cb(s);
  });

  // Lua: g1_callbacks.lua:379 -- pokefirered/src/battle_anim_effects_1.c:2454
  F.LeechSeedSprouts = function (s: any): void {
    s.visible = true;
    S.startAnim(s, 1);
    s.data[0] = 60;
    s._cb = S.waitAnimForDuration;
    S.store(s, S.destroy);
  };

  // Lua: g1_callbacks.lua:388 -- pokefirered/src/battle_anim_effects_1.c:2443
  F.LeechSeedStep = function (s: any): void {
    if (S.translateHArc(s)) {
      s.visible = false;
      s.data[0] = 10;
      s._cb = S.waitAnimForDuration;
      S.store(s, F.LeechSeedSprouts);
    }
  };

  // Lua: g1_callbacks.lua:398 -- pokefirered/src/battle_anim_effects_1.c:2429
  C.LeechSeed = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    S.initPosToAttacker(s, true);
    if (atk_opp(s)) A[2] = -A[2];
    s.data[0] = A[4];
    s.data[2] = P.coord(vm, P.tgt(vm), P.X) + A[2];
    s.data[4] = P.coord(vm, P.tgt(vm), P.Y) + A[3];
    s.data[5] = A[5];
    S.initArc(s);
    s._cb = F.LeechSeedStep;
  });

  // Lua: g1_callbacks.lua:411 -- pokefirered/src/battle_anim_effects_1.c:2484
  F.SporeParticleStep = function (s: any): void {
    const d = s.data, vm = s._vm;
    s.ox = P.Sin(d[1], 32);
    d[2] = P.s16(d[2] + 24);
    s.oy = P.Cos(d[1], -3) + (d[2] >> 8);
    if (P.u16(d[1] - 0x40) < 0x80) {
      s._pri = P.bgPriorityOf(P.tgt(vm));
    } else {
      let pri = P.bgPriorityOf(P.tgt(vm)) + 1;
      if (pri > 3) pri = 3;
      s._pri = pri;
    }
    d[1] = (d[1] + 2) & 0xFF;
    d[0] = d[0] - 1;
    if (d[0] === -1) S.destroy(s);
  };

  // Lua: g1_callbacks.lua:429 -- pokefirered/src/battle_anim_effects_1.c:2471
  C.SporeParticle = S.wrap(function (s: any): void {
    const A = s._A;
    S.initPosToTarget(s, true);
    S.startAnim(s, A[4]);
    if (A[4] === 1) s.objBlend = true;
    s.data[0] = A[3];
    s.data[1] = A[2];
    s._cb = F.SporeParticleStep;
    s._cb(s);
  });

  // Lua: g1_callbacks.lua:441 -- pokefirered/src/battle_anim_effects_1.c:2547
  F.PetalDanceBigFlowerStep = function (s: any): void {
    const vm = s._vm, d = s.data;
    if (!S.translateLinear(s)) {
      s.ox = s.ox + P.Sin(d[5], 32);
      s.oy = s.oy + P.Cos(d[5], -5);
      if (P.u16(d[5] - 0x40) < 0x80) {
        s.subpriority = P.subpriorityOf(P.atk(vm)) - 1;
      } else {
        s.subpriority = P.subpriorityOf(P.atk(vm)) + 1;
      }
      d[5] = (d[5] + 5) & 0xFF;
    } else {
      S.destroy(s);
    }
  };

  // Lua: g1_callbacks.lua:458 -- pokefirered/src/battle_anim_effects_1.c:2533
  C.PetalDanceBigFlower = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm, d = s.data;
    S.initPosToAttacker(s, false);
    d[0] = A[3];
    d[1] = s.x;
    d[2] = s.x;
    d[3] = s.y;
    d[4] = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET) + A[2];
    S.initLinear(s);
    d[5] = 0x40;
    s._cb = F.PetalDanceBigFlowerStep;
    s._cb(s);
  });

  // Lua: g1_callbacks.lua:473 -- pokefirered/src/battle_anim_effects_1.c:2585
  F.PetalDanceSmallFlowerStep = function (s: any): void {
    const d = s.data;
    if (!S.translateLinear(s)) {
      s.ox = s.ox + P.Sin(d[5], 8);
      if (P.u16(d[5] - 59) < 5 || P.u16(d[5] - 187) < 5) s._oamH = !s._oamH;
      d[5] = (d[5] + 5) & 0xFF;
    } else {
      S.destroy(s);
    }
  };

  // Lua: g1_callbacks.lua:485 -- pokefirered/src/battle_anim_effects_1.c:2571
  C.PetalDanceSmallFlower = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm, d = s.data;
    S.initPosToAttacker(s, true);
    d[0] = A[3];
    d[1] = s.x;
    d[2] = s.x;
    d[3] = s.y;
    d[4] = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET) + A[2];
    S.initLinear(s);
    d[5] = 0x40;
    s._cb = F.PetalDanceSmallFlowerStep;
    s._cb(s);
  });

  // Lua: g1_callbacks.lua:500 -- pokefirered/src/battle_anim_effects_1.c:2642
  F.RazorLeafParticleStep2 = function (s: any): void {
    const d = s.data;
    if (atk_opp(s)) s.ox = -P.Sin(d[0], 25); else s.ox = P.Sin(d[0], 25);
    d[0] = (d[0] + 2) & 0xFF;
    d[1] = d[1] + 1;
    if ((d[1] & 1) === 0) s.oy = s.oy + 1;
    if (d[1] > 80) S.destroy(s);
  };

  // Lua: g1_callbacks.lua:510 -- pokefirered/src/battle_anim_effects_1.c:2616
  F.RazorLeafParticleStep1 = function (s: any): void {
    const d = s.data;
    if (d[2] === 0) {
      if ((d[1] & 1) !== 0) {
        d[0] = 0x80;
      } else {
        d[0] = 0;
      }
      d[1] = 0;
      d[2] = 0;
      s._cb = F.RazorLeafParticleStep2;
    } else {
      d[2] = d[2] - 1;
      s.x = s.x + d[0];
      s.y = s.y + d[1];
    }
  };

  // Lua: g1_callbacks.lua:529 -- pokefirered/src/battle_anim_effects_1.c:2606
  C.RazorLeafParticle = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    s.x = P.coord(vm, P.atk(vm), P.X_2);
    s.y = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
    s.data[0] = A[0];
    s.data[1] = A[1];
    s.data[2] = A[2];
    s._cb = F.RazorLeafParticleStep1;
  });

  // Lua: g1_callbacks.lua:540 -- pokefirered/src/battle_anim_effects_1.c:2698
  F.TranslateLinearSingleSineWaveStep = function (s: any): void {
    const d = s.data;
    let destroy = false;
    const a = d[0];
    const b = d[7];
    d[0] = 1;
    S.translateHArc(s);
    const r0 = d[7];
    d[0] = a;
    s._affParam = s._affParam ?? 0;
    if (b > 200 && r0 < 56 && s._affParam === 0) s._affParam = s._affParam + 1;
    if (s._affParam !== 0 && d[0] !== 0) {
      s.visible = !s.visible;
      s._affParam = s._affParam + 1;
      if (s._affParam === 30) destroy = true;
    }
    const x = s.x + s.ox, y = s.y + s.oy;
    if (x > P.DISPLAY_WIDTH + 16 || x < -16 || y > P.DISPLAY_HEIGHT || y < -16) destroy = true;
    if (destroy) S.destroy(s);
  };

  // Lua: g1_callbacks.lua:562 -- pokefirered/src/battle_anim_effects_1.c:2669
  C.TranslateLinearSingleSineWave = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    S.initPosToAttacker(s, true);
    if (atk_opp(s)) A[2] = -A[2];
    s.data[0] = A[4];
    if (A[6] === 0) {
      s.data[2] = P.coord(vm, P.tgt(vm), P.X_2) + A[2];
      s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + A[3];
    } else {
      s.data[2] = P.coord(vm, P.tgt(vm), P.X_2) + A[2];
      s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + A[3];
    }
    s.data[5] = A[5];
    S.initArc(s);
    if (P.isOpponent(P.atk(vm)) === P.isOpponent(P.tgt(vm))) s.data[0] = 1; else s.data[0] = 0;
    s._affParam = 0;
    s._cb = F.TranslateLinearSingleSineWaveStep;
  });

  // Lua: g1_callbacks.lua:582 -- pokefirered/src/battle_anim_effects_1.c:2750
  F.MoveTwisterParticleStep = function (s: any): void {
    const d = s.data, vm = s._vm;
    if (d[1] === 0xFF) {
      s.y = s.y - 2;
    } else if (d[1] > 0) {
      s.y = s.y - 2;
      d[1] = d[1] - 2;
    }
    d[5] = d[5] + d[2];
    if (d[0] < d[4]) d[5] = d[5] + d[2];
    d[5] = d[5] & 0xFF;
    s.ox = P.Cos(d[5], d[3]);
    s.oy = P.Sin(d[5], 5);
    if (d[5] < 0x80) {
      s._pri = P.bgPriorityOf(P.tgt(vm)) - 1;
    } else {
      s._pri = P.bgPriorityOf(P.tgt(vm)) + 1;
    }
    d[0] = d[0] - 1;
    if (d[0] === 0) S.destroy(s);
  };

  // Lua: g1_callbacks.lua:605 -- pokefirered/src/battle_anim_effects_1.c:2736
  C.MoveTwisterParticle = S.wrap(function (s: any): void {
    const A = s._A, d = s.data;
    s.y = s.y + 32;
    d[0] = A[0];
    d[1] = A[1];
    d[2] = A[2];
    d[3] = A[3];
    d[4] = A[4];
    s._cb = F.MoveTwisterParticleStep;
  });

  // Lua: g1_callbacks.lua:617 -- pokefirered/src/battle_anim_effects_1.c:2806
  F.ConstrictBindingStep2 = function (s: any): void {
    const d = s.data;
    if (d[2] === 0) d[0] = d[0] + 11; else d[0] = d[0] - 11;
    d[1] = d[1] + 1;
    if (d[1] === 6) {
      d[1] = 0;
      d[2] = d[2] ^ 1;
    }
    if (s.affineAnimEnded) {
      d[7] = d[7] - 1;
      if (d[7] > 0) S.startAffineAnim(s, d[6]); else S.destroy(s);
    }
  };

  // Lua: g1_callbacks.lua:632 -- pokefirered/src/battle_anim_effects_1.c:2793
  F.ConstrictBindingStep1 = function (s: any): void {
    const vm = s._vm;
    if (vm && vm.args && P.u16(vm.args[7] ?? 0) === 0xFFFF) {
      s.affineAnimPaused = false;
      s.data[0] = 0x100;
      s._cb = F.ConstrictBindingStep2;
    }
  };

  // Lua: g1_callbacks.lua:642 -- pokefirered/src/battle_anim_effects_1.c:2783
  C.ConstrictBinding = S.wrap(function (s: any): void {
    const A = s._A;
    S.initPosToTarget(s, false);
    s.affineAnimPaused = true;
    S.startAffineAnim(s, A[2]);
    s.data[6] = A[2];
    s.data[7] = A[3];
    s._cb = F.ConstrictBindingStep1;
  });

  // Lua: g1_callbacks.lua:653 -- pokefirered/src/battle_anim_effects_1.c:2894
  C.MimicOrb = S.wrap(function (s: any): void {
    s._cb = function (sp: any): void {
      const vm = sp._vm, d = sp.data;
      if (d[0] === 0) {
        const A = sp._A;
        if (!P.isOpponent(P.tgt(vm))) A[0] = -A[0];
        sp.x = P.coord(vm, P.tgt(vm), P.X) + A[0];
        sp.y = P.coord(vm, P.tgt(vm), P.Y) + A[1];
        sp.visible = false;
        d[0] = d[0] + 1;
      } else if (d[0] === 1) {
        sp.visible = true;
        if (sp.affineAnimEnded) {
          S.changeAffineAnim(sp, 1);
          d[0] = 25;
          d[2] = P.coord(vm, P.atk(vm), P.X_2);
          d[4] = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
          sp._cb = S.initAndRunFastLinear;
          S.store(sp, S.destroy);
        }
      }
    };
    s._cb(s);
  });

  // Lua: g1_callbacks.lua:679 -- pokefirered/src/battle_anim_effects_1.c:2976
  F.RootFlickerOut = function (s: any): void {
    const d = s.data;
    d[0] = d[0] + 1;
    if (d[0] > d[2] - 10) s.visible = mod(d[0], 2) === 0;
    if (d[0] > d[2]) S.destroy(s);
  };

  // Lua: g1_callbacks.lua:687 -- pokefirered/src/battle_anim_effects_1.c:2928
  C.IngrainRoot = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm, d = s.data;
    if (d[0] === 0) {
      s.x = P.coord(vm, P.atk(vm), P.X_2);
      s.y = P.coord(vm, P.atk(vm), P.Y);
      s.ox = A[0];
      s.oy = A[1];
      s.subpriority = A[2] + 30;
      S.startAnim(s, A[3]);
      d[2] = A[4];
      d[0] = d[0] + 1;
      if (s.y + s.oy > 120) s.y = s.y + s.oy + s.y - 120;
    }
    s._cb = F.RootFlickerOut;
  });

  // Lua: g1_callbacks.lua:704 -- pokefirered/src/battle_anim_effects_1.c:2953
  C.FrenzyPlantRoot = S.wrap(function (s: any): void {
    const A = s._A, vm = s._vm;
    const ax = P.coord(vm, P.atk(vm), P.X_2);
    const ay = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
    const tx = P.coord(vm, P.tgt(vm), P.X_2) - ax;
    const ty = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) - ay;
    s.x = ax + P.cdiv(tx * A[0], 100);
    s.y = ay + P.cdiv(ty * A[0], 100);
    s.ox = A[1];
    s.oy = A[2];
    s.subpriority = A[3] + 30;
    S.startAnim(s, A[4]);
    s.data[2] = A[5];
    s._cb = F.RootFlickerOut;
  });

  // Lua: g1_callbacks.lua:721 -- pokefirered/src/battle_anim_effects_1.c:2991
  C.IngrainOrb = S.wrap(function (s: any): void {
    s._cb = function (sp: any): void {
      const A = sp._A, vm = sp._vm, d = sp.data;
      if (d[0] === 0) {
        sp.x = P.coord(vm, P.atk(vm), P.X_2) + A[0];
        sp.y = P.coord(vm, P.atk(vm), P.Y) + A[1];
        d[1] = A[2];
        d[2] = A[3];
        d[3] = A[4];
      }
      d[0] = d[0] + 1;
      sp.ox = d[1] * d[0];
      sp.oy = P.Sin((d[0] * 20) & 0xFF, d[2]);
      if (d[0] > d[3]) S.destroy(sp);
    };
    s._cb(s);
  });

  // Lua: g1_callbacks.lua:739
  C._F = F;
  G1CallbacksB(C, F);
  return C;
}

// A lazily-required module (see the header): the entry is the loader.
G3Lazy["src.core.game3.battle.anim_port.g1_callbacks"] = function (_host: any): Record<string, any> {
  return loadG1Callbacks();
};

export default C;
