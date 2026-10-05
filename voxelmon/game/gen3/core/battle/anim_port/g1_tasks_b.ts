// Port of gen1recomp src/core/game3/battle/anim_port/g1_tasks_b.lua (GPLv3 + additional terms; see LICENSE.md).
// Group 1 visual tasks, part B (battle_anim_mon_movement.c shakes / slides /
// rotations, traces, Flash, sliding bg, palette blends). Brian's module returns
// `function(T, F)`, which g1_tasks calls with its tables.
//
// Port notes:
// - Brian's module-scope aliases (s16, u16, u8, Sin, Cos, cdiv) are not taken
//   at load (ES module order); the functions call P.* directly.
// - mon_or_destroy returns a tuple [p, side] ([null, null] for Brian's nil).
// - A task's func is `(t, vm)`; t._fn steps are called as Brian calls them.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber } from "../../../../../import/gen3/lua.ts";
import { ipairs, len, pairs, type LuaTable } from "../../../platform/lt.ts";
import { P } from "./g1_pret.ts";
import { S } from "./g1_sprite.ts";
import { K } from "./g1_task_base.ts";

// Lua: g1_tasks_b.lua:11
export default function G1TasksB(T: Record<string, any>, F: Record<string, any>): void {

  // Lua: g1_tasks_b.lua:13 -- returns [p, side]
  function mon_or_destroy(t: any, vm: any, animBattler: unknown): [any, any] {
    const side = K.battlerSide(vm, animBattler);
    const p = (side != null && side !== false) ? P.present(side) : null;
    if (!p) {
      K.destroy(t);
      return [null, null];
    }
    t._side = side;
    t._p = p;
    return [p, side];
  }

  // Lua: g1_tasks_b.lua:26 -- pokefirered/src/battle_anim_mon_movement.c:115
  function shake_mon_step(t: any): void {
    const d = t.data, p = t._p;
    if (d[3] === 0) {
      if ((p.ox ?? 0) === 0) p.ox = d[4]; else p.ox = 0;
      if ((p.oy ?? 0) === 0) p.oy = d[5]; else p.oy = 0;
      d[3] = d[2];
      d[1] = d[1] - 1;
      if (d[1] <= 0) {
        p.ox = 0;
        p.oy = 0;
        K.destroy(t);
      }
    } else {
      d[3] = d[3] - 1;
    }
  }

  // Lua: g1_tasks_b.lua:44 -- pokefirered/src/battle_anim_mon_movement.c:94
  T.ShakeMon = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    const [p] = mon_or_destroy(t, vm, A[0]);
    if (!p) return;
    p.ox = A[1];
    p.oy = A[2];
    d[1] = A[3];
    d[2] = A[4];
    d[3] = A[4];
    d[4] = A[1];
    d[5] = A[2];
    t._fn = shake_mon_step;
    t._fn(t);
  });

  // Lua: g1_tasks_b.lua:60 -- pokefirered/src/battle_anim_mon_movement.c:200
  function shake_mon2_step(t: any): void {
    const d = t.data, p = t._p;
    if (d[3] === 0) {
      if ((p.ox ?? 0) === d[4]) p.ox = -d[4]; else p.ox = d[4];
      if ((p.oy ?? 0) === d[5]) p.oy = -d[5]; else p.oy = d[5];
      d[3] = d[2];
      d[1] = d[1] - 1;
      if (d[1] <= 0) {
        p.ox = 0;
        p.oy = 0;
        K.destroy(t);
      }
    } else {
      d[3] = d[3] - 1;
    }
  }

  // Lua: g1_tasks_b.lua:78 -- pokefirered/src/battle_anim_mon_movement.c:146
  T.ShakeMon2 = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    let side: any;
    if (A[0] < 4) {
      side = K.battlerSide(vm, A[0]);
    } else if (A[0] !== 8) {
      if (A[0] === 4) side = 0; else if (A[0] === 5) side = 2; else if (A[0] === 6) side = 1; else side = 3;
      if (side >= 2 && !P.spriteVisible(side)) side = null;
    } else {
      side = P.atk(vm);
    }
    const p = (side != null && side !== false) ? P.present(side) : null;
    if (!p) return K.destroy(t);
    t._p = p;
    p.ox = A[1];
    p.oy = A[2];
    d[1] = A[3];
    d[2] = A[4];
    d[3] = A[4];
    d[4] = A[1];
    d[5] = A[2];
    t._fn = shake_mon2_step;
    t._fn(t);
  });

  // Lua: g1_tasks_b.lua:104 -- pokefirered/src/battle_anim_mon_movement.c:254
  function shake_in_place_step(t: any): void {
    const d = t.data, p = t._p;
    if (d[3] === 0) {
      if ((d[1] & 1) !== 0) {
        p.ox = (p.ox ?? 0) + d[5];
        p.oy = (p.oy ?? 0) + d[6];
      } else {
        p.ox = (p.ox ?? 0) - d[5];
        p.oy = (p.oy ?? 0) - d[6];
      }
      d[3] = d[4];
      d[1] = d[1] + 1;
      if (d[1] >= d[2]) {
        if ((d[1] & 1) !== 0) {
          p.ox = p.ox + P.cdiv(d[5], 2);
          p.oy = p.oy + P.cdiv(d[6], 2);
        } else {
          p.ox = p.ox - P.cdiv(d[5], 2);
          p.oy = p.oy - P.cdiv(d[6], 2);
        }
        K.destroy(t);
      }
    } else {
      d[3] = d[3] - 1;
    }
  }

  // Lua: g1_tasks_b.lua:132 -- pokefirered/src/battle_anim_mon_movement.c:232
  T.ShakeMonInPlace = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    const [p] = mon_or_destroy(t, vm, A[0]);
    if (!p) return;
    p.ox = (p.ox ?? 0) + A[1];
    p.oy = (p.oy ?? 0) + A[2];
    d[1] = 0;
    d[2] = A[3];
    d[3] = 0;
    d[4] = A[4];
    d[5] = A[1] * 2;
    d[6] = A[2] * 2;
    t._fn = shake_in_place_step;
    t._fn(t);
  });

  // Lua: g1_tasks_b.lua:149 -- pokefirered/src/battle_anim_mon_movement.c:308
  function shake_and_sink_step(t: any): void {
    const d = t.data, p = t._p;
    let x = d[1];
    const old = d[8];
    d[8] = d[8] + 1;
    if (d[2] === old) {
      d[8] = 0;
      if ((p.ox ?? 0) === x) x = -x;
      p.ox = (p.ox ?? 0) + x;
    }
    d[1] = x;
    d[9] = P.s16(d[9] + d[3]);
    p.oy = d[9] >> 8;
    d[4] = d[4] - 1;
    if (d[4] === 0) K.destroy(t);
  }

  // Lua: g1_tasks_b.lua:167 -- pokefirered/src/battle_anim_mon_movement.c:294
  T.ShakeAndSinkMon = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    const [p] = mon_or_destroy(t, vm, A[0]);
    if (!p) return;
    p.ox = A[1];
    d[1] = A[1];
    d[2] = A[2];
    d[3] = A[3];
    d[4] = A[4];
    t._fn = shake_and_sink_step;
    t._fn(t);
  });

  // Lua: g1_tasks_b.lua:181 -- pokefirered/src/battle_anim_mon_movement.c:351
  function elliptical_step(t: any): void {
    const d = t.data, p = t._p;
    p.ox = P.Sin(d[5], d[1]);
    p.oy = -P.Cos(d[5], d[2]) + d[2];
    d[5] = (d[5] + d[4]) & 0xFF;
    if (d[5] === 0) d[3] = d[3] - 1;
    if (d[3] === 0) {
      p.ox = 0;
      p.oy = 0;
      K.destroy(t);
    }
  }

  // Lua: g1_tasks_b.lua:194
  function elliptical_init(t: any, vm: any): void {
    const A = t._A, d = t.data;
    const [p] = mon_or_destroy(t, vm, A[0]);
    if (!p) return;
    if (A[4] > 5) A[4] = 5;
    let wave = 1;
    for (let i = 1; i <= A[4]; i++) wave = wave * 2;
    d[1] = A[1];
    d[2] = A[2];
    d[3] = A[3];
    d[4] = wave;
    t._fn = elliptical_step;
    t._fn(t);
  }

  // Lua: g1_tasks_b.lua:210 -- pokefirered/src/battle_anim_mon_movement.c:333
  T.TranslateMonElliptical = K.wrap(elliptical_init);

  // Lua: g1_tasks_b.lua:213 -- pokefirered/src/battle_anim_mon_movement.c:377
  T.TranslateMonEllipticalRespectSide = K.wrap(function (t: any, vm: any): void {
    if (P.isOpponent(P.atk(vm))) t._A[1] = -t._A[1];
    elliptical_init(t, vm);
  });

  // Lua: g1_tasks_b.lua:219 -- pokefirered/src/battle_anim_mon_movement.c:609
  function wind_up_step2(t: any): void {
    const d = t.data, p = t._p;
    if (d[4] > 0) {
      d[4] = d[4] - 1;
    } else {
      d[12] = P.s16(d[12] + d[5]);
      p.ox = (d[12] >> 8) + (d[11] >> 8);
      d[6] = d[6] - 1;
      if (d[6] === 0) K.destroy(t);
    }
  }

  // Lua: g1_tasks_b.lua:232 -- pokefirered/src/battle_anim_mon_movement.c:598
  function wind_up_step1(t: any): void {
    const d = t.data, p = t._p;
    d[11] = P.s16(d[11] + d[1]);
    p.ox = d[11] >> 8;
    p.oy = P.Sin(P.u8(d[10] >> 8), d[2]);
    d[10] = P.s16(d[10] + d[7]);
    d[3] = d[3] - 1;
    if (d[3] === 0) t._fn = wind_up_step2;
  }

  // Lua: g1_tasks_b.lua:243 -- pokefirered/src/battle_anim_mon_movement.c:579
  T.WindUpLunge = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    const wave = P.u16(P.cdiv(0x8000, A[3]));
    if (P.isOpponent(P.atk(vm))) {
      A[1] = -A[1];
      A[5] = -A[5];
    }
    const [p] = mon_or_destroy(t, vm, A[0]);
    if (!p) return;
    d[1] = P.s16(P.cdiv(A[1] * 256, A[3]));
    d[2] = A[2];
    d[3] = A[3];
    d[4] = A[4];
    d[5] = P.s16(P.cdiv(A[5] * 256, A[6]));
    d[6] = A[6];
    d[7] = P.s16(wave);
    t._fn = wind_up_step1;
  });

  // Lua: g1_tasks_b.lua:263 -- pokefirered/src/battle_anim_mon_movement.c:664
  function slide_off_step(t: any, vm: any): void {
    const d = t.data, p = t._p;
    p.ox = (p.ox ?? 0) + d[1];
    const x = P.coord(vm, t._side, P.X_2);
    if (p.ox + x < -32 || p.ox + x > P.DISPLAY_WIDTH + 32) K.destroy(t);
  }

  // Lua: g1_tasks_b.lua:271 -- pokefirered/src/battle_anim_mon_movement.c:626
  T.SlideOffScreen = K.wrap(function (t: any, vm: any): void {
    const A = t._A;
    if (A[0] !== 0 && A[0] !== 1) return K.destroy(t);
    const [p] = mon_or_destroy(t, vm, A[0]);
    if (!p) return;
    if (P.isOpponent(P.tgt(vm))) t.data[1] = A[1]; else t.data[1] = -A[1];
    t._fn = slide_off_step;
  });

  // Lua: g1_tasks_b.lua:281 -- pokefirered/src/battle_anim_mon_movement.c:699
  function sway_step(t: any): void {
    const d = t.data, p = t._p;
    const sineIndex = P.u16(d[10] + d[2]);
    d[10] = P.s16(sineIndex);
    const waveIndex = sineIndex >>> 8;
    const sine = P.Sin(waveIndex, d[1]);
    if (d[0] === 0) {
      p.ox = sine;
    } else if (!P.isOpponent(t._side)) {
      p.oy = Math.abs(sine);
    } else {
      p.oy = -Math.abs(sine);
    }
    if ((waveIndex > 0x7F && d[11] === 0 && d[12] === 1) || (waveIndex < 0x7F && d[11] === 1 && d[12] === 0)) {
      d[11] = d[11] ^ 1;
      d[12] = d[12] ^ 1;
      d[3] = d[3] - 1;
      if (d[3] === 0) {
        p.ox = 0;
        p.oy = 0;
        K.destroy(t);
      }
    }
  }

  // Lua: g1_tasks_b.lua:307 -- pokefirered/src/battle_anim_mon_movement.c:680
  T.SwayMon = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    if (P.isOpponent(P.atk(vm))) A[1] = -A[1];
    const [p] = mon_or_destroy(t, vm, A[4]);
    if (!p) return;
    d[0] = A[0];
    d[1] = A[1];
    d[2] = A[2];
    d[3] = A[3];
    d[12] = 1;
    t._fn = sway_step;
  });

  // Lua: g1_tasks_b.lua:321 -- pokefirered/src/battle_anim_mon_movement.c:754
  function scale_restore_step(t: any): void {
    const d = t.data;
    d[10] = P.s16(d[10] + d[0]);
    d[11] = P.s16(d[11] + d[1]);
    S.setMonRotScale(t._side, d[10], d[11], 0);
    d[2] = d[2] - 1;
    if (d[2] === 0) {
      if (d[3] > 0) {
        d[0] = -d[0];
        d[1] = -d[1];
        d[2] = d[3];
        d[3] = 0;
      } else {
        S.resetMonRotScale(t._side);
        K.destroy(t);
      }
    }
  }

  // Lua: g1_tasks_b.lua:341 -- pokefirered/src/battle_anim_mon_movement.c:740
  T.ScaleMonAndRestore = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    const [p] = mon_or_destroy(t, vm, A[3]);
    if (!p) return;
    d[0] = A[0];
    d[1] = A[1];
    d[2] = A[2];
    d[3] = A[2];
    d[10] = 0x100;
    d[11] = 0x100;
    t._fn = scale_restore_step;
  });

  // Lua: g1_tasks_b.lua:355 -- pokefirered/src/battle_anim_mon_movement.c:846
  function rotate_side_step(t: any): void {
    const d = t.data;
    d[3] = P.s16(d[3] + d[4]);
    S.setMonRotScale(t._side, 0x100, 0x100, d[3]);
    if (d[7] !== 0) S.monYOffsetFromRotation(t._side);
    d[1] = d[1] + 1;
    if (d[1] >= d[2]) {
      if (d[6] === 1) {
        S.resetMonRotScale(t._side);
        const p = t._p;
        if (p && d[7] !== 0) p.oy = 0;
        K.destroy(t);
      } else if (d[6] === 2) {
        d[1] = 0;
        d[4] = -d[4];
        d[6] = 1;
      } else {
        K.destroy(t);
      }
    }
  }

  // Lua: g1_tasks_b.lua:378 -- pokefirered/src/battle_anim_mon_movement.c:778
  T.RotateMonSpriteToSide = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    const [p] = mon_or_destroy(t, vm, A[2]);
    if (!p) return;
    d[1] = 0;
    d[2] = A[0];
    if (A[3] !== 1) d[3] = 0; else d[3] = P.s16(A[0] * A[1]);
    d[4] = A[1];
    d[6] = A[3];
    if (A[2] === 0) {
      d[7] = P.isOpponent(P.atk(vm)) ? 0 : 1;
    } else {
      d[7] = P.isOpponent(P.tgt(vm)) ? 0 : 1;
    }
    if (d[7] !== 0) {
      d[3] = -d[3];
      d[4] = -d[4];
    }
    t._fn = rotate_side_step;
  });

  // Lua: g1_tasks_b.lua:400 -- pokefirered/src/battle_anim_mon_movement.c:812
  T.RotateMonToSideAndRestore = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    const [p, side] = mon_or_destroy(t, vm, A[2]);
    if (!p) return;
    d[1] = 0;
    d[2] = A[0];
    if (P.isOpponent(side)) A[1] = -A[1];
    if (A[3] !== 1) d[3] = 0; else d[3] = P.s16(A[0] * A[1]);
    d[4] = A[1];
    d[6] = A[3];
    d[7] = 1;
    d[3] = -d[3];
    d[4] = -d[4];
    t._fn = rotate_side_step;
  });

  // Lua: g1_tasks_b.lua:417 -- pokefirered/src/battle_anim_mon_movement.c:904
  function shake_power_step(t: any): void {
    const d = t.data, p = t._p;
    d[0] = d[0] + 1;
    if (d[0] > d[1]) {
      d[0] = 0;
      d[12] = (d[12] + 1) & 1;
      if (d[10] !== 0) {
        if (d[12] !== 0) p.ox = d[8] + d[13]; else p.ox = d[8] - d[14];
      }
      if (d[11] !== 0) {
        if (d[12] !== 0) p.oy = d[15]; else p.oy = 0;
      }
      d[2] = d[2] - 1;
      if (d[2] === 0) {
        p.ox = 0;
        p.oy = 0;
        K.destroy(t);
      }
    }
  }

  // Lua: g1_tasks_b.lua:439 -- pokefirered/src/battle_anim_mon_movement.c:872
  T.ShakeTargetBasedOnMovePowerOrDmg = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    let v: number;
    if (A[0] === 0) {
      v = tonumber(K.ctx(vm, "movePower", 0)) ?? 0;
    } else {
      v = tonumber(K.ctx(vm, "moveDmg", 0)) ?? 0;
    }
    d[15] = P.cdiv(v, 12);
    if (d[15] < 1) d[15] = 1;
    if (d[15] > 16) d[15] = 16;
    d[14] = P.cdiv(d[15], 2);
    d[13] = d[14] + (d[15] & 1);
    d[12] = 0;
    d[10] = A[3];
    d[11] = A[4];
    const [p] = mon_or_destroy(t, vm, 1);
    if (!p) return;
    d[8] = p.ox ?? 0;
    d[9] = p.oy ?? 0;
    d[0] = 0;
    d[1] = A[1];
    d[2] = A[2];
    t._fn = shake_power_step;
  });

  // Lua: g1_tasks_b.lua:466 -- pokefirered/src/battle_anim_mons.c:621
  function translate_by_id(t: any): void {
    const d = t.data, p = t._p;
    if (d[0] > 0) {
      d[0] = d[0] - 1;
      p.ox = (p.ox ?? 0) + d[1];
      p.oy = (p.oy ?? 0) + d[2];
    } else {
      t._fn = t._stored ?? K.destroy;
    }
  }

  // Lua: g1_tasks_b.lua:478 -- pokefirered/src/battle_anim_mons.c:635
  function translate_by_id_fixed(t: any): void {
    const d = t.data, p = t._p;
    if (d[0] > 0) {
      d[0] = d[0] - 1;
      d[3] = P.s16(d[3] + d[1]);
      d[4] = P.s16(d[4] + d[2]);
      p.ox = d[3] >> 8;
      p.oy = d[4] >> 8;
    } else {
      t._fn = t._stored ?? K.destroy;
    }
  }

  // Lua: g1_tasks_b.lua:492 -- pokefirered/src/battle_anim_mons.c:977
  function init_linear_data(d: any): void {
    if (d[0] === 0) d[0] = 1;
    const x = P.s16((d[2] - d[1]) << 8);
    const y = P.s16((d[4] - d[3]) << 8);
    d[1] = P.cdiv(x, d[0]);
    d[2] = P.cdiv(y, d[0]);
    d[4] = 0;
    d[3] = 0;
  }

  // Lua: g1_tasks_b.lua:503 -- pokefirered/src/battle_anim_mon_movement.c:403
  function reverse_lunge(t: any): void {
    const d = t.data;
    d[0] = d[4];
    d[1] = -d[1];
    t._fn = translate_by_id;
    t._stored = K.destroy;
  }

  // Lua: g1_tasks_b.lua:512 -- pokefirered/src/battle_anim_mon_movement.c:388
  T.HorizontalLunge = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    const [p] = mon_or_destroy(t, vm, 0);
    if (!p) return;
    if (P.isOpponent(P.atk(vm))) d[1] = -A[1]; else d[1] = A[1];
    d[0] = A[0];
    d[2] = 0;
    d[4] = A[0];
    t._stored = reverse_lunge;
    t._fn = translate_by_id;
  });
  T.DoHorizontalLunge = T.HorizontalLunge;

  // Lua: g1_tasks_b.lua:526 -- pokefirered/src/battle_anim_mon_movement.c:430
  function reverse_dip(t: any): void {
    const d = t.data;
    d[0] = d[4];
    d[2] = -d[2];
    t._fn = translate_by_id;
    t._stored = K.destroy;
  }

  // Lua: g1_tasks_b.lua:535 -- pokefirered/src/battle_anim_mon_movement.c:416
  T.VerticalDip = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    const [p] = mon_or_destroy(t, vm, A[2]);
    if (!p) return;
    d[0] = A[0];
    d[1] = 0;
    d[2] = A[1];
    d[4] = A[0];
    t._stored = reverse_dip;
    t._fn = translate_by_id;
  });
  T.DoVerticalDip = T.VerticalDip;

  // Lua: g1_tasks_b.lua:549 -- pokefirered/src/battle_anim_mon_movement.c:470
  function slide_original_step(t: any): void {
    const d = t.data, p = t._p;
    const mode = t._mode;
    if (d[0] === 0) {
      if (mode === 1 || mode === 0) p.ox = 0;
      if (mode === 2 || mode === 0) p.oy = 0;
      K.destroy(t);
    } else {
      d[0] = d[0] - 1;
      d[3] = P.s16(d[3] + d[1]);
      d[4] = P.s16(d[4] + d[2]);
      p.ox = (d[3] >> 8) + d[5];
      p.oy = (d[4] >> 8) + d[6];
    }
  }

  // Lua: g1_tasks_b.lua:566 -- pokefirered/src/battle_anim_mon_movement.c:443
  T.SlideMonToOriginalPos = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    const side = (A[0] === 0) ? P.atk(vm) : P.tgt(vm);
    const p = P.present(side);
    if (!p) return K.destroy(t);
    t._p = p;
    t._side = side;
    const x = K.monX(vm, side), y = K.monY(vm, side);
    d[0] = A[2];
    d[1] = x + (p.ox ?? 0);
    d[2] = x;
    d[3] = y + (p.oy ?? 0);
    d[4] = y;
    init_linear_data(d);
    d[3] = 0;
    d[4] = 0;
    d[5] = p.ox ?? 0;
    d[6] = p.oy ?? 0;
    if (A[1] === 1) d[2] = 0; else if (A[1] === 2) d[1] = 0;
    t._mode = A[1];
    t._fn = slide_original_step;
  });

  // Lua: g1_tasks_b.lua:590 -- pokefirered/src/battle_anim_mon_movement.c:500
  T.SlideMonToOffset = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    const side = (A[0] === 0) ? P.atk(vm) : P.tgt(vm);
    const p = P.present(side);
    if (!p) return K.destroy(t);
    t._p = p;
    t._side = side;
    if (P.isOpponent(side)) {
      A[1] = -A[1];
      if (A[3] === 1) A[2] = -A[2];
    }
    const x = K.monX(vm, side), y = K.monY(vm, side);
    d[0] = A[4];
    d[1] = x;
    d[2] = x + A[1];
    d[3] = y;
    d[4] = y + A[2];
    init_linear_data(d);
    d[3] = 0;
    d[4] = 0;
    t._stored = K.destroy;
    t._fn = translate_by_id_fixed;
  });

  // Lua: g1_tasks_b.lua:615 -- pokefirered/src/battle_anim_mon_movement.c:562
  function slide_offset_back_end(t: any): void {
    const p = t._p;
    p.ox = 0;
    p.oy = 0;
    K.destroy(t);
  }

  // Lua: g1_tasks_b.lua:623 -- pokefirered/src/battle_anim_mon_movement.c:529
  T.SlideMonToOffsetAndBack = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    const side = (A[0] === 0) ? P.atk(vm) : P.tgt(vm);
    const p = P.present(side);
    if (!p) return K.destroy(t);
    t._p = p;
    t._side = side;
    if (P.isOpponent(side)) {
      A[1] = -A[1];
      if (A[3] === 1) A[2] = -A[2];
    }
    const x = K.monX(vm, side), y = K.monY(vm, side);
    d[0] = A[4];
    d[1] = x + (p.ox ?? 0);
    d[2] = d[1] + A[1];
    d[3] = y + (p.oy ?? 0);
    d[4] = d[3] + A[2];
    init_linear_data(d);
    d[3] = P.s16((p.ox ?? 0) << 8);
    d[4] = P.s16((p.oy ?? 0) << 8);
    d[6] = A[5];
    if (A[5] === 0) t._stored = K.destroy; else t._stored = slide_offset_back_end;
    t._fn = translate_by_id_fixed;
  });

  // Lua: g1_tasks_b.lua:649 -- pokefirered/src/battle_anim_effects_1.c:4549
  function bow_step4(t: any): void {
    K.destroy(t);
  }

  // Lua: g1_tasks_b.lua:654 -- pokefirered/src/battle_anim_effects_1.c:4482
  function bow_step1_cb(t: any): void {
    const d = t.data;
    if (d[0] === 0) {
      d[6] = P.isOpponent(t._side) ? 1 : 0;
      if (d[6] !== 0) d[4] = 0x300; else d[4] = -0x300;
      d[5] = 0;
    }
    d[5] = P.s16(d[5] + d[4]);
    S.setMonRotScale(t._side, 0x100, 0x100, d[5]);
    S.monYOffsetFromRotation(t._side);
    d[0] = d[0] + 1;
    if (d[0] > 3) {
      d[0] = 0;
      t._fn = bow_step4;
    }
  }

  // Lua: g1_tasks_b.lua:672 -- pokefirered/src/battle_anim_effects_1.c:4521
  function bow_step3_cb(t: any): void {
    const d = t.data;
    if (d[0] === 0) {
      d[6] = P.isOpponent(t._side) ? 1 : 0;
      if (d[6] !== 0) {
        d[4] = P.s16(0xFC00);
        d[5] = 0xC00;
      } else {
        d[4] = 0x400;
        d[5] = P.s16(0xF400);
      }
    }
    d[5] = P.s16(d[5] + d[4]);
    S.setMonRotScale(t._side, 0x100, 0x100, d[5]);
    S.monYOffsetFromRotation(t._side);
    d[0] = d[0] + 1;
    if (d[0] > 2) {
      S.resetMonRotScale(t._side);
      t._fn = bow_step4;
    }
  }

  // Lua: g1_tasks_b.lua:695 -- pokefirered/src/battle_anim_effects_1.c:4451
  T.BowMon = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    const [p] = mon_or_destroy(t, vm, 0);
    if (!p) return;
    d[0] = 0;
    const mode = A[0];
    if (mode === 0) {
      d[0] = 6;
      d[1] = P.isOpponent(P.atk(vm)) ? 2 : -2;
      d[2] = 0;
      t._stored = bow_step1_cb;
      t._fn = translate_by_id;
    } else if (mode === 1) {
      d[0] = 4;
      d[1] = P.isOpponent(P.atk(vm)) ? -3 : 3;
      d[2] = 0;
      t._stored = bow_step4;
      t._fn = translate_by_id;
    } else if (mode === 2) {
      t._fn = function (tt: any): void {
        tt.data[0] = tt.data[0] + 1;
        if (tt.data[0] > 8) {
          tt.data[0] = 0;
          tt._fn = bow_step3_cb;
        }
      };
    } else {
      t._fn = bow_step4;
    }
  });

  // Lua: g1_tasks_b.lua:727 -- pokefirered/src/battle_anim_normal.c:834
  function coord_offset_apply(t: any, delta: number): void {
    const v = t._var;
    if (v === 0 || v === 1) {
      let [x, y] = F.bg3Get(t._vm);
      if (v === 0) x = x + delta; else y = y + delta;
      F.bg3Set(t._vm, x, y);
      return;
    }
    for (const [side] of pairs(t._offMons ?? {})) {
      const p = P.present(side);
      if (p) {
        if (v === 2) p.ox = (p.ox ?? 0) + delta; else p.oy = (p.oy ?? 0) + delta;
      }
    }
    t._offAccum = (t._offAccum ?? 0) + delta;
  }

  // Lua: g1_tasks_b.lua:745 -- pokefirered/src/battle_anim_normal.c:804
  function shake_mon_or_terrain_step(t: any): void {
    const d = t.data;
    if (d[3] > 0) {
      d[3] = d[3] - 1;
      if (d[1] > 0) {
        d[1] = d[1] - 1;
      } else {
        d[1] = d[2];
        coord_offset_apply(t, d[0]);
        d[0] = -d[0];
      }
    } else {
      if (t._var === 0 || t._var === 1) {
        F.bg3Set(t._vm, t._origX ?? 0, t._origY ?? 0);
      } else {
        coord_offset_apply(t, -(t._offAccum ?? 0));
      }
      K.destroy(t);
    }
  }

  // Lua: g1_tasks_b.lua:767 -- pokefirered/src/battle_anim_normal.c:771
  T.ShakeMonOrBattleTerrain = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    d[0] = -A[0];
    d[1] = A[1];
    d[2] = A[1];
    d[3] = A[2];
    let v = A[3];
    if (v > 3 || v < 0) v = 3;
    t._var = v;
    [t._origX, t._origY] = F.bg3Get(vm);
    d[5] = A[3];
    if (v === 2 || v === 3) {
      const mons: Record<string | number, boolean> = {};
      if (A[4] === 2) {
        mons[P.atk(vm)] = true;
        mons[P.tgt(vm)] = true;
      } else if (A[4] === 0) {
        mons[P.atk(vm)] = true;
      } else {
        mons[P.tgt(vm)] = true;
      }
      t._offMons = mons;
    }
    t._fn = shake_mon_or_terrain_step;
  });

  // Lua: g1_tasks_b.lua:793
  function blend_state(color: number, coeff: number): any {
    const k = Math.max(0, Math.min(16, coeff)) / 16;
    const [r, g, b] = P.rgb555(color);
    return { m: 1 - k, r: r * k, g: g * k, b: b * k };
  }

  // Lua: g1_tasks_b.lua:800 -- pokefirered/src/battle_anim_mons.c:2294
  function battler_trace_cb(s: any): void {
    s.data[0] = s.data[0] - 1;
    if (s.data[0] === 0) {
      const t = s._owner;
      if (t && t.active && t._g1Token === s._ownerToken) t.data[5] = t.data[5] - 1;
      S.destroy(s);
    }
  }

  let traceSerial = 0;

  // Lua: g1_tasks_b.lua:812 -- pokefirered/src/battle_anim_mons.c:2277
  function create_battler_trace(t: any): void {
    const s = S.cloneMon(t._vm, t._side, t._blend);
    if (s) {
      s._pri = t.data[6];
      s.data[0] = 8;
      s._owner = t;
      s._ownerToken = t._g1Token;
      s._cb = battler_trace_cb;
      t.data[5] = t.data[5] + 1;
    }
  }

  // Lua: g1_tasks_b.lua:825 -- pokefirered/src/battle_anim_mons.c:2242
  function punch_trace_step(t: any): void {
    const d = t.data, p = t._p;
    if (d[2] === 0) {
      create_battler_trace(t);
      p.ox = (p.ox ?? 0) + d[1];
      d[3] = d[3] + 1;
      if (d[3] === 5) {
        d[3] = d[3] - 1;
        d[2] = d[2] + 1;
      }
    } else if (d[2] === 1) {
      create_battler_trace(t);
      p.ox = (p.ox ?? 0) - d[1];
      d[3] = d[3] - 1;
      if (d[3] === 0) {
        p.ox = 0;
        d[2] = d[2] + 1;
      }
    } else if (d[2] === 2) {
      if (d[5] === 0) K.destroy(t);
    }
  }

  // Lua: g1_tasks_b.lua:849 -- pokefirered/src/battle_anim_mons.c:2213
  T.AttackerPunchWithTrace = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    const [p] = mon_or_destroy(t, vm, 0);
    if (!p) return;
    traceSerial = traceSerial + 1;
    t._g1Token = traceSerial;
    d[1] = P.isOpponent(t._side) ? -8 : 8;
    d[2] = 0;
    d[3] = 0;
    d[5] = 0;
    const sub = P.subpriorityOf(t._side);
    d[6] = (sub === 20 || sub === 40) ? 2 : 3;
    t._blend = blend_state(P.u16(A[0]), A[1]);
    t._fn = punch_trace_step;
  });

  // Lua: g1_tasks_b.lua:866 -- pokefirered/src/battle_anim_utility_funcs.c:274
  function mon_trace_cb(s: any): void {
    if (s.data[0] !== 0) {
      s.data[0] = s.data[0] - 1;
    } else {
      const t = s._owner;
      if (t && t.active && t._g1Token === s._ownerToken) t.data[5] = t.data[5] - 1;
      S.destroy(s);
    }
  }

  // Lua: g1_tasks_b.lua:877 -- pokefirered/src/battle_anim_utility_funcs.c:242
  function trace_blended_step(t: any): void {
    const d = t.data;
    if (d[4] !== 0) {
      if (d[1] !== 0) {
        d[1] = d[1] - 1;
      } else {
        const s = S.cloneMon(t._vm, t._side, null);
        if (s) {
          s._pri = (d[0] !== 0) ? 1 : 2;
          s.data[0] = d[3];
          s._owner = t;
          s._ownerToken = t._g1Token;
          s._cb = mon_trace_cb;
          d[5] = d[5] + 1;
        }
        d[4] = d[4] - 1;
        d[1] = d[2];
      }
    } else if (d[5] === 0) {
      K.destroy(t);
    }
  }

  // Lua: g1_tasks_b.lua:901 -- pokefirered/src/battle_anim_utility_funcs.c:230
  T.TraceMonBlended = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    const [p] = mon_or_destroy(t, vm, A[0]);
    if (!p) return;
    traceSerial = traceSerial + 1;
    t._g1Token = traceSerial;
    d[0] = A[0];
    d[1] = 0;
    d[2] = A[1];
    d[3] = A[2];
    d[4] = A[3];
    d[5] = 0;
    t._fn = trace_blended_step;
  });

  // Lua: g1_tasks_b.lua:917 -- pokefirered/src/battle_anim_effects_1.c:5261
  function double_team_cb(s: any): void {
    const d = s.data;
    d[3] = d[3] + 1;
    if (d[3] > 1) {
      d[3] = 0;
      d[0] = d[0] + 1;
    }
    if (d[0] > 64) {
      const t = s._owner;
      if (t && t.active && t._g1Token === s._ownerToken) t.data[3] = t.data[3] - 1;
      S.destroy(s);
    } else {
      d[4] = P.cdiv(P.gSine(d[0]), 6);
      d[5] = P.cdiv(P.gSine(d[0]), 13);
      d[1] = (d[1] + d[5]) & 0xFF;
      s.ox = P.Sin(d[1], d[4]);
    }
  }

  // Lua: g1_tasks_b.lua:937 -- pokefirered/src/battle_anim_effects_1.c:5209
  T.DoubleTeam = K.wrap(function (t: any, vm: any): void {
    const d = t.data;
    const [p] = mon_or_destroy(t, vm, 0);
    if (!p) return;
    traceSerial = traceSerial + 1;
    t._g1Token = traceSerial;
    d[3] = 0;
    const st = blend_state(0, 11);
    for (let i = 0; i <= 1; i++) {
      const s = S.cloneMon(vm, t._side, st);
      if (!s) break;
      s.data[0] = 0;
      s.data[1] = i << 7;
      s._owner = t;
      s._ownerToken = t._g1Token;
      s._cb = double_team_cb;
      d[3] = d[3] + 1;
    }
    t._fn = function (tt: any): void {
      if (tt.data[3] === 0) K.destroy(tt);
    };
  });

  // Lua: g1_tasks_b.lua:961 -- pokefirered/src/battle_anim_utility_funcs.c:583
  function flash_step(t: any): void {
    const d = t.data;
    if (d[0] === 0) {
      d[1] = d[1] + 1;
      if (d[1] > 6) {
        d[1] = 0;
        d[2] = 16;
        d[0] = d[0] + 1;
      }
    } else if (d[0] === 1) {
      d[1] = d[1] + 1;
      if (d[1] > 1) {
        d[1] = 0;
        d[2] = d[2] - 1;
        P.Pal.blend("bg", d[2], 0x7FFF);
        for (const [, id] of ipairs(P.visibleIds())) P.Pal.blend(id, d[2], 0);
        P.Pal.flush();
        if (d[2] === 0) d[0] = d[0] + 1;
      }
    } else if (d[0] === 2) {
      K.destroy(t);
    }
  }

  // Lua: g1_tasks_b.lua:985
  T.Flash = K.wrap(function (t: any, _vm: any): void {
    for (const [, id] of ipairs(P.visibleIds())) P.Pal.setFaded(id, { m: 0, r: 0, g: 0, b: 0 });
    P.Pal.setFaded("bg", { m: 0, r: 1, g: 1, b: 1 });
    P.Pal.flush();
    t.data[0] = 0;
    t.data[1] = 0;
    t._fn = flash_step;
  });

  // Lua: g1_tasks_b.lua:995 -- pokefirered/src/battle_anim_utility_funcs.c:683
  function update_sliding_bg(t: any, vm: any): void {
    const d = t.data;
    d[10] = d[10] + d[1];
    d[11] = d[11] + d[2];
    const [x, y] = F.bg3Get(vm);
    F.bg3Set(vm, x + (d[10] >> 8), y + (d[11] >> 8));
    d[10] = d[10] & 0xFF;
    d[11] = d[11] & 0xFF;
    if (vm && vm.args && P.s16(vm.args[7] ?? 0) === d[3]) {
      F.bg3Set(vm, 0, 0);
      K.destroy(t);
    }
  }

  // Lua: g1_tasks_b.lua:1010 -- pokefirered/src/battle_anim_utility_funcs.c:665
  T.StartSlidingBg = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    if (A[2] !== 0 && P.isOpponent(P.atk(vm))) {
      A[0] = -A[0];
      A[1] = -A[1];
    }
    d[1] = A[0];
    d[2] = A[1];
    d[3] = A[3];
    d[0] = 1;
    t._uncounted = true;
    t._fn = update_sliding_bg;
  });

  // Lua: g1_tasks_b.lua:1025 -- pokefirered/src/battle_anim_utility_funcs.c:652
  T.BlendNonAttackerPalettes = K.wrap(function (t: any, vm: any): void {
    const A = t._A;
    for (let j = 5; j >= 1; j--) A[j] = A[j - 1];
    const keys: LuaTable = [null];
    for (let id = 0; id <= 3; id++) {
      if (id !== P.atkId(vm) && (id < 2 || P.spriteVisible(id))) keys[len(keys) + 1] = id;
    }
    t._keys = keys;
    const d = t.data;
    d[2] = A[1];
    d[3] = A[2];
    d[4] = A[3];
    d[5] = A[4];
    d[10] = A[2];
    t._fn = function (tt: any): void {
      const dd = tt.data;
      if (dd[9] === dd[2]) {
        dd[9] = 0;
        for (const [, key] of ipairs(tt._keys)) P.Pal.blend(key, dd[10], P.u16(dd[5]));
        P.Pal.flush();
        if (dd[10] < dd[4]) dd[10] = dd[10] + 1;
        else if (dd[10] > dd[4]) dd[10] = dd[10] - 1;
        else K.destroy(tt);
      } else {
        dd[9] = dd[9] + 1;
      }
    };
    t._fn(t);
  });

  // Lua: g1_tasks_b.lua:1056 -- pokefirered/src/battle_anim_utility_funcs.c:719
  T.SetAllNonAttackersInvisiblity = K.wrap(function (t: any, vm: any): void {
    for (const [, id] of ipairs(P.visibleIds(P.atkId(vm)))) {
      const p = P.present(id);
      if (p) p.visible = (t._A[0] === 0);
    }
    K.destroy(t);
  });

  // Lua: g1_tasks_b.lua:1065 -- pokefirered/src/battle_anim_effects_1.c:4635
  function skull_bash_set(t: any): void {
    const d = t.data, p = t._p, side = t._side;
    const st = d[2];
    if (st === 0) {
      if (d[3] !== 0) {
        d[4] = d[4] + d[5];
        p.ox = d[4];
        d[3] = d[3] - 1;
      } else {
        d[3] = 8;
        d[4] = 0;
        d[5] = (d[1] === 0) ? -0xC0 : 0xC0;
        d[2] = d[2] + 1;
      }
    } else if (st === 1) {
      if (d[3] !== 0) {
        d[4] = P.s16(d[4] + d[5]);
        S.setMonRotScale(side, 0x100, 0x100, d[4]);
        S.monYOffsetFromRotation(side);
        d[3] = d[3] - 1;
      } else {
        d[3] = 8;
        d[4] = p.ox ?? 0;
        d[5] = (d[1] === 0) ? 2 : -2;
        d[6] = 1;
        d[2] = d[2] + 1;
      }
    } else if (st === 2) {
      if (d[3] !== 0) {
        if (d[6] !== 0) {
          d[6] = d[6] - 1;
        } else {
          if ((d[3] & 1) !== 0) p.ox = d[4] + d[5]; else p.ox = d[4] - d[5];
          d[6] = 1;
          d[3] = d[3] - 1;
        }
      } else {
        p.ox = d[4];
        d[3] = 12;
        d[2] = d[2] + 1;
      }
    } else if (st === 3) {
      if (d[3] !== 0) {
        d[3] = d[3] - 1;
      } else {
        d[3] = 3;
        d[4] = p.ox ?? 0;
        d[5] = (d[1] === 0) ? 8 : -8;
        d[2] = d[2] + 1;
      }
    } else if (st === 4) {
      if (d[3] !== 0) {
        d[4] = d[4] + d[5];
        p.ox = d[4];
        d[3] = d[3] - 1;
      } else {
        K.destroy(t);
      }
    }
  }

  // Lua: g1_tasks_b.lua:1127 -- pokefirered/src/battle_anim_effects_1.c:4727
  function skull_bash_reset(t: any): void {
    const d = t.data;
    if (d[3] !== 0) {
      d[4] = P.s16(d[4] - d[5]);
      S.setMonRotScale(t._side, 0x100, 0x100, d[4]);
      S.monYOffsetFromRotation(t._side);
      d[3] = d[3] - 1;
    } else {
      S.resetMonRotScale(t._side);
      K.destroy(t);
    }
  }

  // Lua: g1_tasks_b.lua:1141 -- pokefirered/src/battle_anim_effects_1.c:4597
  T.SkullBashPosition = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    const [p] = mon_or_destroy(t, vm, 0);
    if (!p) return;
    d[1] = P.isOpponent(t._side) ? 1 : 0;
    d[2] = 0;
    if (A[0] === 0) {
      d[3] = 8;
      d[4] = 0;
      d[5] = (d[1] === 0) ? -3 : 3;
      t._fn = skull_bash_set;
    } else if (A[0] === 1) {
      d[3] = 8;
      d[4] = 0x600;
      d[5] = 0xC0;
      if (d[1] === 0) {
        d[4] = -d[4];
        d[5] = -d[5];
      }
      t._fn = skull_bash_reset;
    } else {
      K.destroy(t);
    }
  });

  // Lua: g1_tasks_b.lua:1167 -- pokefirered/src/battle_anim_effects_1.c:2867
  function shrink_copy_step2(t: any, vm: any): void {
    const d = t.data;
    if (vm && vm.args && P.u16(vm.args[7] ?? 0) === 0xFFFF) {
      if (d[0] === 0) {
        S.resetMonRotScale(t._side);
        t._p.ox = 0;
        t._p.oy = 0;
        d[0] = d[0] + 1;
        return;
      }
    } else {
      if (d[0] === 0) return;
    }
    d[0] = d[0] + 1;
    if (d[0] === 3) K.destroy(t);
  }

  // Lua: g1_tasks_b.lua:1185 -- pokefirered/src/battle_anim_effects_1.c:2848
  function shrink_copy_step1(t: any, vm: any): void {
    const d = t.data, p = t._p;
    d[10] = P.s16(d[10] + d[0]);
    p.ox = d[10] >> 8;
    if (P.isOpponent(t._side)) p.ox = -p.ox;
    d[11] = P.s16(d[11] + 16);
    S.setMonRotScale(t._side, d[11], d[11], 0);
    S.monYOffsetFromYScale(vm, t._side);
    d[1] = d[1] - 1;
    if (d[1] === 0) {
      d[0] = 0;
      t._fn = shrink_copy_step2;
    }
  }

  // Lua: g1_tasks_b.lua:1201 -- pokefirered/src/battle_anim_effects_1.c:2830
  T.ShrinkTargetCopy = K.wrap(function (t: any, vm: any): void {
    const [p] = mon_or_destroy(t, vm, 1);
    if (!p) return;
    if (p.visible === false) return K.destroy(t);
    t.data[0] = t._A[0];
    t.data[1] = t._A[1];
    t.data[11] = 0x100;
    t._fn = shrink_copy_step1;
  });

  // Lua: g1_tasks_b.lua:1212 -- pokefirered/src/battle_anim_mons.c:1570
  function alpha_fade_in_step(t: any, vm: any): void {
    const d = t.data;
    d[0] = d[0] + 1;
    if (d[0] > d[1]) {
      d[0] = 0;
      d[2] = d[2] + 1;
      if ((d[2] & 1) !== 0) {
        if (d[3] !== d[7]) d[3] = d[3] + d[5];
      } else {
        if (d[4] !== d[8]) d[4] = d[4] + d[6];
      }
      P.setBldAlpha(vm, d[3], d[4]);
      if (d[3] === d[7] && d[4] === d[8]) K.destroy(t);
    }
  }

  // Lua: g1_tasks_b.lua:1229 -- pokefirered/src/battle_anim_mons.c:1545
  T.AlphaFadeIn = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    let v1 = 0, v2 = 0;
    if (A[2] > A[0]) v2 = 1; else if (A[2] < A[0]) v2 = -1;
    if (A[3] > A[1]) v1 = 1; else if (A[3] < A[1]) v1 = -1;
    d[0] = 0;
    d[1] = A[4];
    d[2] = 0;
    d[3] = A[0];
    d[4] = A[1];
    d[5] = v2;
    d[6] = v1;
    d[7] = A[2];
    d[8] = A[3];
    P.setBldAlpha(vm, A[0], A[1]);
    t._fn = alpha_fade_in_step;
  });

  // Lua: g1_tasks_b.lua:1248 -- pokefirered/src/battle_anim_normal.c:302
  T.SimplePaletteBlend = K.wrap(function (t: any, vm: any): void {
    const A = t._A;
    P.beginNormalPaletteFade(P.unpackSelected(vm, A[0]), A[1], A[2], A[3], P.u16(A[4]));
    t._fn = function (tt: any): void {
      if (!P.fadeActive()) K.destroy(tt);
    };
  });

  // Lua: g1_tasks_b.lua:1257 -- pokefirered/src/battle_anim_normal.c:383
  function complex_blend_step2(t: any): void {
    if (!P.fadeActive()) {
      P.blendPalettes(t._keys, 0, 0);
      K.destroy(t);
    }
  }

  // Lua: g1_tasks_b.lua:1265 -- pokefirered/src/battle_anim_normal.c:357
  function complex_blend_step1(t: any): void {
    const d = t.data;
    if (d[0] > 0) {
      d[0] = d[0] - 1;
      return;
    }
    if (P.fadeActive()) return;
    if (d[2] === 0) {
      t._fn = complex_blend_step2;
      return;
    }
    if ((d[1] & 0x100) !== 0) {
      P.blendPalettes(t._keys, d[4], P.u16(d[3]));
    } else {
      P.blendPalettes(t._keys, d[6], P.u16(d[5]));
    }
    d[1] = d[1] ^ 0x100;
    d[0] = d[1] & 0xFF;
    d[2] = d[2] - 1;
  }

  // Lua: g1_tasks_b.lua:1287 -- pokefirered/src/battle_anim_normal.c:339
  T.ComplexPaletteBlend = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    d[0] = A[1];
    d[1] = A[1];
    d[2] = A[2];
    d[3] = A[3];
    d[4] = A[4];
    d[5] = A[5];
    d[6] = A[6];
    d[7] = A[0];
    t._keys = P.unpackSelected(vm, d[7]);
    P.blendPalettes(t._keys, A[4], P.u16(A[3]));
    t._fn = complex_blend_step1;
  });
}
