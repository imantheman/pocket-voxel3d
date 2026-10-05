// Port of gen1recomp src/core/game3/battle/anim_port/g5_tasks.lua (GPLv3 + additional terms; see LICENSE.md).
// The g5 group's visual tasks: sandstorm and surf backgrounds, the stat-mask
// overlays (curse lines, cure bubbles, metal shine), psychic / white bg palette
// rotation, dig, ghost "get out" and the frozen ice cube (pokefirered
// battle_anim_rock.c, _water.c, _utility_funcs.c, _effects_3.c, _dark.c,
// _ground.c, _ghost.c, _status_effects.c).

import { tonumber } from "../../../../../import/gen3/lua.ts";
import { G } from "../../../platform/graphics.ts";
import { ipairs, seq } from "../../../platform/lt.ts";
import { G3Lazy } from "../../lazy_registry.ts";
import { AnimPal } from "../anim_pal.ts";
import { P } from "./g3_pret.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Task = Record<string, any>;

export const T: Record<string, any> = {};
// local band = P.band or bit.band: JS & (no top-level read of an import).

// T.X = P.task(fn) at require time: the wrap is made on first call instead (no
// top-level call into an import inside the import cycle). P.task returns a
// stateless closure over fn, so this is the same function.
function taskOf(entry: (t: Task, vm: any) => void): (t: Task, vm: any) => void {
  let w: ((t: Task, vm: any) => void) | null = null;
  return (t: Task, vm: any) => (w ??= P.task(entry))(t, vm);
}

// Lua: g5_tasks.lua:7 (returns [x, y])
function monBase(vm: any, side: any): [number, number] {
  const p = P.monPresent(side);
  const [cx, cy] = P.monCenter(vm, side);
  return [cx - ((p ? p.ox : null) ?? 0), cy - ((p ? p.oy : null) ?? 0)];
}

// Lua: g5_tasks.lua:13
function sx16(v: number): number { return P.s16(v); }

// Lua: g5_tasks.lua:15
function statMask(side: any, mask: any): any {
  const p = P.monPresent(side);
  if (p) p.statMask = mask;
  return p;
}

// Lua: g5_tasks.lua:21
function clearStatMask(side: any, mask: any): void {
  const p = P.monPresent(side);
  if (p && p.statMask === mask) p.statMask = null;
}

// Lua: g5_tasks.lua:26
function sandstormStep(t: Task, vm: any): void {
  const d = t.data;
  if (d[0] === 0) {
    t._bg1x = sx16((t._bg1x ?? 0) - 6);
  } else {
    t._bg1x = sx16((t._bg1x ?? 0) + 6);
  }
  t._bg1y = sx16((t._bg1y ?? 0) - 1);
  const k = d[12];
  if (k === 0) {
    d[10] = d[10] + 1;
    if (d[10] === 4) {
      d[10] = 0;
      d[11] = d[11] + 1;
      P.setBld(vm, d[11], 16 - d[11]);
      if (d[11] === 7) {
        d[12] = d[12] + 1;
        d[11] = 0;
      }
    }
  } else if (k === 1) {
    d[11] = d[11] + 1;
    if (d[11] === 101) {
      d[11] = 7;
      d[12] = d[12] + 1;
    }
  } else if (k === 2) {
    d[10] = d[10] + 1;
    if (d[10] === 4) {
      d[10] = 0;
      d[11] = d[11] - 1;
      P.setBld(vm, d[11], 16 - d[11]);
      if (d[11] === 0) {
        d[12] = d[12] + 1;
        d[11] = 0;
      }
    }
  } else if (k === 3) {
    P.bg1Clear(t);
    d[12] = d[12] + 1;
  } else if (k === 4) {
    t._bg1x = 0; t._bg1y = 0;
    P.setBld(vm, null);
    P.DestroyAnimVisualTask(t);
  }
}

// Lua: g5_tasks.lua:74 -- pokefirered/src/battle_anim_rock.c:388
T.LoadSandstormBackground = taskOf(function (t: Task, vm: any): void {
  P.setBld(vm, 0, 16);
  t._bg1x = 0; t._bg1y = 0;
  P.bg1Layer(t, vm, "SANDSTORM", 1);
  let var0 = 0;
  if (t.ga[0] !== 0 && !P.atkIsPlayer(vm)) var0 = 1;
  t.data[0] = var0;
  t.fn = sandstormStep;
});

// Lua: g5_tasks.lua:84
function surfBands(t: Task): any {
  const sc = t._scan;
  if (!sc) return null;
  return sc;
}

// Lua: g5_tasks.lua:90
function surfDraw(t: Task, _vm: any): void {
  const sc = surfBands(t);
  if (!sc) return;
  const x = t._bg1x ?? 0, y = t._bg1y ?? 0;
  // Lua: g5_tasks.lua:94
  const band_ = (y0: number, y1: number, v: number): void => {
    if (y1 <= y0) return;
    const eva = v & 0x1F, evb = P.shr(v, 8) & 0x1F;
    if (eva <= 0) return;
    AnimPal.drawBg("SURF_" + t._surfSide, "bg1", x, y + y0, { y: y0, h: y1 - y0, eva: eva, evb: evb });
  };
  band_(0, sc[4], sc[2]);
  band_(sc[4], sc[5], sc[1]);
  band_(sc[5], 160, sc[2]);
}

// Lua: g5_tasks.lua:105
function surfScanStep(t: Task): void {
  const sc = t._scan;
  if (!sc) return;
  if (sc[0] === 0) {
    sc[0] = 1;
  } else if (sc[0] === 1) {
    if (sc[3] === 0) {
      sc[4] = sc[4] - 1;
      if (sc[4] <= 0) {
        sc[4] = 0;
        sc[0] = 2;
      }
    } else {
      sc[5] = sc[5] + 1;
      if (sc[5] > 111) sc[0] = 2;
    }
  }
}

// Lua: g5_tasks.lua:124
function surfStep2(t: Task, vm: any): void {
  const d = t.data;
  surfScanStep(t);
  if (d[0] === 0) {
    t.draw = null;
    d[0] = d[0] + 1;
  } else {
    t._bg1x = 0; t._bg1y = 0;
    P.setBld(vm, null);
    t._scan = null;
    P.DestroyAnimVisualTask(t);
  }
}

// Lua: g5_tasks.lua:138
function surfStep1(t: Task, _vm: any): void {
  const d = t.data;
  t._bg1x = sx16((t._bg1x ?? 0) + d[0]);
  t._bg1y = sx16((t._bg1y ?? 0) + d[1]);
  d[2] = d[2] + d[1];
  d[5] = d[5] + 1;
  if (d[5] === 4) {
    const f = AnimPal.bgWriteFaded("bg1");
    if (f) {
      const buf = f[7];
      for (let i = 6; i >= 1; i--) f[1 + i] = f[i];
      f[1] = buf;
    }
    d[5] = 0;
  }
  d[6] = d[6] + 1;
  if (d[6] > 1) {
    d[6] = 0;
    d[3] = d[3] + 1;
    if (d[3] < 14) {
      t._scan[1] = P.s16(d[3] + P.lshift(16 - d[3], 8));
      d[4] = d[4] + 1;
    }
    if (d[3] > 54) {
      d[4] = d[4] - 1;
      t._scan[1] = P.s16(d[4] + P.lshift(16 - d[4], 8));
    }
  }
  if ((t._scan[1] & 0x1F) === 0) {
    d[0] = t._scan[1] & 0x1F;
    t.fn = surfStep2;
  }
  surfScanStep(t);
}

// Lua: g5_tasks.lua:174 -- pokefirered/src/battle_anim_water.c:799
T.CreateSurfWave = taskOf(function (t: Task, vm: any): void {
  const d = t.data;
  const opp = !P.atkIsPlayer(vm);
  t._surfSide = opp ? "OPPONENT" : "PLAYER";
  AnimPal.bgLoad("bg1", "SURF_" + t._surfSide,
    (t.ga[0] !== 0 && AnimPal._pack && AnimPal._pack.bgPals) ? (AnimPal._pack.bgPals.MUDDY_WATER ?? null) : null);
  t._scan = [0, 0x1000, 0x1000];
  if (opp) {
    t._bg1x = -224; t._bg1y = 256;
    d[0] = 2; d[1] = -1;
    t._scan[3] = 1;
  } else {
    t._bg1x = 0; t._bg1y = -48;
    d[0] = -2; d[1] = 1;
    t._scan[3] = 0;
  }
  if (t._scan[3] === 0) {
    t._scan[4] = 48; t._scan[5] = 112;
  } else {
    t._scan[4] = 0; t._scan[5] = 0;
  }
  d[6] = 1;
  t.z = P.bgZ(1);
  t.draw = surfDraw;
  t.fn = surfStep1;
});

// Lua: g5_tasks.lua:200
function curseStep(t: Task, _vm: any): void {
  const d = t.data;
  const m = t._mask;
  d[10] = d[10] + 4;
  m.y = m.y - 4;
  if (d[10] === 64) {
    d[10] = 0;
    m.y = m.y + 64;
    d[11] = d[11] + 1;
    if (d[11] === 4) {
      clearStatMask(t._side, m);
      P.DestroyAnimVisualTask(t);
    }
  }
}

// Lua: g5_tasks.lua:217 -- pokefirered/src/battle_anim_utility_funcs.c:288
T.DrawFallingWhiteLinesOnAttacker = taskOf(function (t: Task, vm: any): void {
  const side = P.atk(vm);
  const [x, y] = monBase(vm, side);
  t._side = side;
  t._mask = { tilemap: "CURSE", x: -x + 32, y: -y + 32, eva: 8, evb: 12 };
  statMask(side, t._mask);
  t.fn = curseStep;
});

// Lua: g5_tasks.lua:226
function scrollingMaskStep(t: Task, _vm: any): void {
  const d = t.data;
  const m = t._mask;
  const sp = d[1];
  d[13] = d[13] + (sp < 0 ? -sp : sp);
  if (sp < 0) {
    m.y = m.y - P.shr(d[13], 8);
  } else {
    m.y = m.y + P.shr(d[13], 8);
  }
  d[13] = d[13] & 0xFF;
  const k = d[15];
  if (k === 0) {
    const old = d[11];
    d[11] = d[11] + 1;
    if (old >= d[6]) {
      d[11] = 0;
      d[12] = d[12] + 1;
      m.eva = d[12]; m.evb = 16 - d[12];
      if (d[12] === d[4]) d[15] = d[15] + 1;
    }
  } else if (k === 1) {
    d[10] = d[10] + 1;
    if (d[10] === d[5]) d[15] = d[15] + 1;
  } else if (k === 2) {
    const old = d[11];
    d[11] = d[11] + 1;
    if (old >= d[6]) {
      d[11] = 0;
      d[12] = d[12] - 1;
      m.eva = d[12]; m.evb = 16 - d[12];
      if (d[12] === 0) {
        clearStatMask(t._side, m);
        P.DestroyAnimVisualTask(t);
      }
    }
  }
}

// Lua: g5_tasks.lua:266 -- pokefirered/src/battle_anim_utility_funcs.c:729
function startMonScrollingBgMask(t: Task, _vm: any, scrollSpeed: number, side: any, numFadeSteps: number,
  fadeStepDelay: number, duration: number, key: string): void {
  const d = t.data;
  t._side = side;
  t._mask = { tilemap: key, x: 0, y: 0, eva: 0, evb: 16 };
  statMask(side, t._mask);
  d[1] = P.s16(scrollSpeed);
  d[4] = numFadeSteps;
  d[5] = duration;
  d[6] = fadeStepDelay;
  t.fn = scrollingMaskStep;
}

// Lua: g5_tasks.lua:279 -- pokefirered/src/battle_anim_effects_3.c:3830
T.StatusClearedEffect = taskOf(function (t: Task, vm: any): void {
  startMonScrollingBgMask(t, vm, 0x1A0, P.atk(vm), 10, 2, 30, "CURE_BUBBLES");
});

// Lua: g5_tasks.lua:283
function setGrey(p: any, restore: boolean): void {
  if (!p) return;
  if (restore) {
    p.grayscale = false;
    P.monBlend(p, 0, 0);
  } else {
    p.grayscale = true;
  }
}

// Lua: g5_tasks.lua:293
function metallicShineStep(t: Task, vm: any): void {
  const d = t.data;
  const m = t._mask;
  d[10] = d[10] + 4;
  m.x = m.x - 4;
  if (d[10] === 128) {
    d[10] = 0;
    m.x = m.x + 128;
    d[11] = d[11] + 1;
    if (d[11] === 2) {
      if (d[1] === 0) setGrey(t._p, true);
      clearStatMask(t._side, m);
    } else if (d[11] === 3) {
      P.setBld(vm, null);
      P.DestroyAnimVisualTask(t);
    }
  }
}

// Lua: g5_tasks.lua:313 -- pokefirered/src/battle_anim_dark.c:769
T.MetallicShine = taskOf(function (t: Task, vm: any): void {
  const d = t.data;
  const side = P.atk(vm);
  const [x, y] = monBase(vm, side);
  t._side = side;
  t._p = P.monPresent(side);
  t._mask = { tilemap: "METAL_SHINE", x: -x + 96, y: -y + 32, eva: 8, evb: 12 };
  statMask(side, t._mask);
  if (t.ga[1] === 0) {
    setGrey(t._p, false);
  } else {
    P.monBlend(t._p, 11, P.u16(t.ga[2]));
  }
  d[1] = t.ga[0];
  d[2] = t.ga[1];
  d[3] = t.ga[2];
  t.fn = metallicShineStep;
});

// Lua: g5_tasks.lua:332
function rotateBgPal(t: Task, vm: any, both: boolean): void {
  const d = t.data;
  d[5] = d[5] + 1;
  if (d[5] === 4) {
    const f = AnimPal.bgWriteFaded("bg");
    if (f) {
      const last = f[11];
      for (let i = 10; i >= 1; i--) f[i + 1] = f[i];
      f[1] = last;
    }
    if (both) {
      const u = AnimPal.bgUnfaded.bg;
      if (u) {
        const last = u[11];
        for (let i = 10; i >= 1; i--) u[i + 1] = u[i];
        u[1] = last;
      }
    }
    d[5] = 0;
  }
  if (P.u16(tonumber(vm && vm.args ? vm.args[7] : null) ?? 0) === 0xFFFF) {
    P.DestroyAnimVisualTask(t);
  }
}

// Lua: g5_tasks.lua:358 -- pokefirered/src/battle_anim_effects_3.c:1356
T.SetPsychicBackground = taskOf(function (t: Task, _vm: any): void {
  t._g4kind = "aux";
  t.fn = function (tt: Task, v: any): void { rotateBgPal(tt, v, false); };
});

// Lua: g5_tasks.lua:364 -- pokefirered/src/battle_anim_effects_3.c:1382
T.FadeScreenToWhite = taskOf(function (t: Task, _vm: any): void {
  t._g4kind = "aux";
  t.fn = function (tt: Task, v: any): void { rotateBgPal(tt, v, true); };
});

// Lua: g5_tasks.lua:369
function digClip(p: any, y0: number, y1: number, hideBelow: boolean): Record<number, any> {
  const rows: Record<number, any> = {};
  for (let r = 0; r <= 159; r++) {
    if (r < y0 || r >= y1) rows[r] = hideBelow ? -240 : null;
  }
  p.hShift = rows;
  return rows;
}

// Lua: g5_tasks.lua:378
function digBounce(t: Task, vm: any): void {
  const d = t.data;
  const p = t._p;
  const k = d[0];
  if (k === 0) {
    const y = P.yWithElevation(vm, P.atk(vm));
    d[14] = y - 32;
    d[15] = y + 32;
    if (d[14] < 0) d[14] = 0;
    d[13] = 0;
    d[0] = d[0] + 1;
  } else if (k === 1) {
    if (p) t._rows = digClip(p, d[14], d[15], true);
    d[0] = d[0] + 1;
  } else if (k === 2) {
    d[2] = (d[2] + 6) & 0x7F;
    d[4] = d[4] + 1;
    if (d[4] > 2) {
      d[4] = 0;
      d[3] = d[3] + 1;
    }
    d[5] = d[3] + P.shr(P.SINE[d[2] + 1], 4);
    if (p) p.oy = d[5];
    if (d[5] > 63) {
      d[5] = 120 - d[14];
      if (p) p.oy = d[5];
      d[0] = d[0] + 1;
    }
  } else if (k === 3) {
    if (p && p.hShift === t._rows) p.hShift = null;
    d[0] = d[0] + 1;
  } else if (k === 4) {
    if (p) {
      p.invisible = true;
      p.oy = 0;
      p.ox = 272 - P.coord(vm, P.atk(vm), P.COORD_X);
    }
    P.DestroyAnimVisualTask(t);
  }
}

// Lua: g5_tasks.lua:419
function digDisappear(t: Task, _vm: any): void {
  const p = t._p;
  if (p) {
    p.invisible = true;
    p.ox = 0; p.oy = 0;
    p.hShift = null;
  }
  P.DestroyAnimVisualTask(t);
}

// Lua: g5_tasks.lua:430 -- pokefirered/src/battle_anim_ground.c:282
T.DigDownMovement = taskOf(function (t: Task, vm: any): void {
  t._p = P.monPresent(P.atk(vm));
  if (t.ga[0] === 0) {
    t.fn = digBounce;
  } else {
    t.fn = digDisappear;
  }
  t.fn(t, vm);
});

// Lua: g5_tasks.lua:440
function digSetVisibleUnderground(t: Task, vm: any): void {
  const d = t.data;
  const p = t._p;
  if (d[0] === 0) {
    if (p) {
      const [, cy] = monBase(vm, P.atk(vm));
      p.invisible = false;
      p.ox = 0;
      p.oy = 160 - cy;
    }
    d[0] = d[0] + 1;
  } else {
    P.DestroyAnimVisualTask(t);
  }
}

// Lua: g5_tasks.lua:456
function digRiseUp(t: Task, vm: any): void {
  const d = t.data;
  const p = t._p;
  const k = d[0];
  if (k === 0) {
    const y = P.yWithElevation(vm, P.atk(vm));
    d[14] = y - 32;
    d[15] = y + 32;
    d[0] = d[0] + 1;
  } else if (k === 1) {
    if (p) t._rows = digClip(p, 0, d[15], true);
    d[0] = d[0] + 1;
  } else if (k === 2) {
    if (p) p.oy = 96;
    d[0] = d[0] + 1;
  } else if (k === 3) {
    if (p) {
      p.oy = p.oy - 8;
      if (p.oy === 0) {
        if (p.hShift === t._rows) p.hShift = null;
        d[0] = d[0] + 1;
      }
    } else {
      d[0] = d[0] + 1;
    }
  } else if (k === 4) {
    P.DestroyAnimVisualTask(t);
  }
}

// Lua: g5_tasks.lua:487 -- pokefirered/src/battle_anim_ground.c:375
T.DigUpMovement = taskOf(function (t: Task, vm: any): void {
  t._p = P.monPresent(P.atk(vm));
  if (t.ga[0] === 0) {
    t.fn = digSetVisibleUnderground;
  } else {
    t.fn = digRiseUp;
  }
  t.fn(t, vm);
});

const GHOST_BLUE = 23 * 32 + 25 * 1024;
const GHOST_WHITE = 31 + 31 * 32 + 29 * 1024;

// Lua: g5_tasks.lua:500
function ghostFaceDraw(t: Task, _vm: any): void {
  const g = t._ghost;
  if (!(g && g.face)) return;
  let eva = 16, evb = 0;
  if (g.bldTarget === 2) { eva = g.eva; evb = g.evb; }
  if (eva <= 0) return;
  AnimPal.drawBg("SCARY_FACE_PLAYER", "bg2", 0, 0, { eva: eva, evb: evb });
}

// Lua: g5_tasks.lua:509
function ghostApply(t: Task): void {
  const g = t._ghost;
  const p = g.p;
  if (!p) return;
  P.monBlend(p, g.monCoeff ?? 0, g.monColor ?? GHOST_BLUE);
  if (g.bldTarget === 1) {
    p.alpha = Math.max(0, Math.min(16, g.eva)) / 16;
  } else {
    p.alpha = 1;
  }
  p.hShift = (g.wave && g.waveRows) ? g.waveRows : null;
}

// Lua: g5_tasks.lua:522
function ghostSetBld(t: Task, target: number, eva: number, evb: number): void {
  const g = t._ghost;
  g.bldTarget = target; g.eva = eva; g.evb = evb;
}

// Lua: g5_tasks.lua:527
function ghostStep3(t: Task, _vm: any): void {
  const d = t.data;
  const g = t._ghost;
  const k = d[15];
  if (k === 0) {
    g.wave = null;
    g.monCoeff = 12; g.monColor = GHOST_BLUE;
  } else if (k === 1) {
    ghostSetBld(t, 2, 16, 0);
    d[2] = 16;
    d[3] = 0;
  } else if (k === 2) {
    d[2] = d[2] - 1;
    d[3] = d[3] + 1;
    ghostSetBld(t, 2, d[2], d[3]);
    if (d[3] <= 15) {
      ghostApply(t);
      return;
    }
    t.z = P.bgZ(2);
  } else if (k === 3) {
    g.face = false;
    d[1] = 12;
  } else if (k === 4) {
    g.monCoeff = d[1]; g.monColor = GHOST_BLUE;
    if (d[1] !== 0) {
      d[1] = d[1] - 1;
      ghostApply(t);
      return;
    }
    d[1] = 0;
    ghostSetBld(t, 2, 0, 16);
  } else if (k === 5) {
    g.monCoeff = 0;
    ghostSetBld(t, 0, 16, 0);
    ghostApply(t);
    if (g.p) {
      g.p.alpha = 1;
      g.p.hShift = null;
      P.monBlend(g.p, 0, 0);
    }
    t.draw = null;
    P.DestroyAnimVisualTask(t);
    return;
  }
  ghostApply(t);
  d[15] = d[15] + 1;
}

// Lua: g5_tasks.lua:576
function ghostStep2(t: Task, vm: any): void {
  const d = t.data;
  const g = t._ghost;
  d[1] = d[1] + 1;
  d[8] = d[1] & 1;
  if (d[8] === 0) d[2] = P.div(P.SINE[d[1] + 1], 18);
  if (d[8] === 1) d[3] = 16 - P.div(P.SINE[d[1] + 1], 18);
  ghostSetBld(t, 1, d[2], d[3]);
  // g.wave:step(0) -- w.step(self, base)
  if (g.wave) g.waveRows = P.hShiftFromHofs(g.wave.step(g.wave, 0));
  ghostApply(t);
  if (d[1] === 128) {
    d[15] = 0;
    t.fn = ghostStep3;
    ghostStep3(t, vm);
  }
}

// Lua: g5_tasks.lua:593
function ghostStep1(t: Task, vm: any): void {
  const d = t.data;
  const g = t._ghost;
  const k = d[15];
  if (k === 0) {
    t.z = P.bgZ(1);
    d[1] = 0;
    d[2] = 0;
    d[3] = 16;
  } else if (k === 1) {
    d[1] = d[1] + 1;
    if ((d[1] & 1) !== 0) return;
    g.monCoeff = d[2]; g.monColor = GHOST_BLUE;
    ghostApply(t);
    if (d[2] <= 11) {
      d[2] = d[2] + 1;
      return;
    }
    d[1] = 0;
    d[2] = 0;
    ghostSetBld(t, 2, 0, 16);
  } else if (k === 2) {
    AnimPal.bgLoad("bg2", "SCARY_FACE_PLAYER");
  } else if (k === 3) {
    g.face = true;
    t.draw = ghostFaceDraw;
  } else if (k === 4) {
    d[1] = d[1] + 1;
    if ((d[1] & 1) !== 0) return;
    d[2] = d[2] + 1;
    d[3] = d[3] - 1;
    ghostSetBld(t, 2, d[2], d[3]);
    if (d[3] !== 0) return;
    d[1] = 0;
    d[2] = 0;
    d[3] = 16;
    ghostSetBld(t, 1, 0, 16);
    t.z = P.bgZ(2);
  } else if (k === 5) {
    g.hidden = true;
  } else if (k === 6) {
    const [, cy] = P.monCenter(vm, P.atk(vm));
    let y = Math.floor(cy) - 32;
    if (y < 0) y = 0;
    g.wave = P.Wave(y, y + 64, 4, 8, 0);
  } else if (k === 7) {
    g.monCoeff = 12; g.monColor = GHOST_WHITE;
    g.hidden = false;
    ghostApply(t);
    t.fn = ghostStep2;
    d[15] = 0;
    return;
  }
  ghostApply(t);
  d[15] = d[15] + 1;
}

// Lua: g5_tasks.lua:651 -- pokefirered/src/battle_anim_ghost.c:1267
T.GhostGetOut = taskOf(function (t: Task, vm: any): void {
  t._ghost = { p: P.monPresent(P.atk(vm)), bldTarget: 0, eva: 16, evb: 0, monCoeff: 0 };
  t.data[15] = 0;
  t.fn = ghostStep1;
  ghostStep1(t, vm);
});

const ICE_CUBE_SUBSPRITES = seq(
  seq(-16, -16, 64, 64, 0),
  seq(-16, 48, 64, 32, 64),
  seq(48, -16, 32, 64, 96),
  seq(48, 48, 32, 32, 128),
);

// Lua: g5_tasks.lua:665
function iceCubeDraw(t: Task, vm: any): void {
  const c = t._cube;
  // `and love and love.graphics`: the platform always has graphics.
  if (!(c && c.visible)) return;
  const pack = vm ? vm._pack : null;
  const info = (pack && pack.tags) ? pack.tags.ICE_CUBE : null;
  const img = info ? info.image : null;
  if (!img) return;
  const tw = Math.max(1, Math.floor(img.getWidth() / 8));
  const [iw, ih] = img.getDimensions();
  const draw = AnimPal.begin({ tag: "ICE_CUBE" }, img) ?? img;
  G.setColor(1, 1, 1, Math.max(0, Math.min(16, c.eva)) / 16);
  c.quads = c.quads ?? {};
  for (const [, ss] of ipairs<any>(ICE_CUBE_SUBSPRITES)) {
    const cols = ss[3] / 8, rows = ss[4] / 8;
    for (let r = 0; r <= rows - 1; r++) {
      for (let col = 0; col <= cols - 1; col++) {
        const tile = ss[5] + r * cols + col;
        let q = c.quads[tile];
        if (!q) {
          q = G.newQuad((tile % tw) * 8, Math.floor(tile / tw) * 8, 8, 8, iw, ih);
          c.quads[tile] = q;
        }
        G.draw(draw, q, c.x + ss[1] + col * 8, c.y + ss[2] + r * 8);
      }
    }
  }
  if (draw !== img) AnimPal.finish();
  G.setColor(1, 1, 1, 1);
}

// Lua: g5_tasks.lua:695
function iceCubeStep4(t: Task, _vm: any): void {
  const d = t.data;
  d[1] = d[1] + 1;
  if (d[1] === 37) {
    t._cube.visible = false;
  } else if (d[1] === 39) {
    t.draw = null;
    P.DestroyAnimVisualTask(t);
  }
}

// Lua: g5_tasks.lua:706
function iceCubeStep3(t: Task, _vm: any): void {
  const d = t.data;
  d[1] = d[1] - 1;
  if (d[1] === -1) {
    t.fn = iceCubeStep4;
    d[1] = 0;
  } else {
    t._cube.eva = d[1];
  }
}

// Lua: g5_tasks.lua:717
function iceCubeStep2(t: Task, _vm: any): void {
  const d = t.data;
  const old = d[1];
  d[1] = d[1] + 1;
  if (old > 13) {
    d[2] = d[2] + 1;
    if (d[2] === 3) {
      const f = AnimPal.writeFaded("ICE_CUBE");
      if (f) {
        const temp = f[13];
        f[13] = f[14];
        f[14] = f[15];
        f[15] = temp;
      }
      d[2] = 0;
      d[3] = d[3] + 1;
      if (d[3] === 3) {
        d[3] = 0;
        d[1] = 0;
        d[4] = d[4] + 1;
        if (d[4] === 2) {
          d[1] = 9;
          t.fn = iceCubeStep3;
        }
      }
    }
  }
}

// Lua: g5_tasks.lua:746
function iceCubeStep1(t: Task, _vm: any): void {
  const d = t.data;
  d[1] = d[1] + 1;
  if (d[1] === 10) {
    t.fn = iceCubeStep2;
    d[1] = 0;
  } else {
    t._cube.eva = d[1];
  }
}

// Lua: g5_tasks.lua:758 -- pokefirered/src/battle_anim_status_effects.c:350
T.FrozenIceCube = taskOf(function (t: Task, vm: any): void {
  const side = P.tgt(vm);
  const x = P.coord(vm, side, P.COORD_X_2) - 32;
  const y = P.coord(vm, side, P.COORD_Y_PIC) - 36;
  t._cube = { x: x, y: y, eva: 0, visible: true };
  t.z = 295;
  t.draw = iceCubeDraw;
  t.fn = iceCubeStep1;
});

export default T;

// pcall(require, "src.core.game3.battle.anim_port.g5_tasks") in anim_tasks.lua
G3Lazy["src.core.game3.battle.anim_port.g5_tasks"] = T;
