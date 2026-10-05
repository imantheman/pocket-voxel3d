// Port of gen1recomp src/core/game3/battle/anim_tasks.lua (GPLv3 + additional terms; see LICENSE.md).
// Visual-task registry + fixed task pool (pret gTasks for battle anims).
// Default stub finishes in 1 frame so unknown createvisualtask still ends scripts.

import { mod, tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { len, ipairs, pairs, type LuaTable } from "../../platform/lt.ts";
import { random } from "../../platform/rng.ts";
import { find, gsub } from "../../platform/lpattern.ts";
import { G } from "../../platform/graphics.ts";
import { G3Lazy } from "../lazy_registry.ts";
import { Trig } from "../trig.ts";
import { Audio } from "../audio.ts";
import { SE } from "../se_ids.ts";
import { AnimSprites } from "./anim_sprites.ts";
import { Anim } from "./anim.ts";
import { AnimVm } from "./anim_vm.ts";

// A sequence ({a, b}); local so module-scope tables never call an import.
function lseq<T = any>(...xs: T[]): (T | null)[] { return [null, ...xs]; }


/** A pooled task (pret gTasks entry). Brian's tasks are open tables: `data[0..15]` plus whatever fields a task hangs on itself. */
export type AnimTask = Record<string, any> & { data: Record<number, any> };
type TaskFn = (t: AnimTask, vm: any) => void;

export const AnimTasks: Record<string, any> = {};

AnimTasks.MAX = 48;

// The anim_port groups merge once, on the first init() (see loadGroups below).
let groupsLoaded = false;

// Lua: anim_tasks.lua:13
function Sin(index: unknown, amp?: number | null): number {
  const i = mod(Math.floor(tonumber(index) ?? 0), 256);
  const val = Trig.SINE[i + 1] ?? 0;
  return Math.floor((val * (amp ?? 0)) / 256);
}

// Lua: anim_tasks.lua:19
function Cos(index: unknown, amp?: number | null): number {
  return Sin((tonumber(index) ?? 0) + 64, amp);
}

// Lua: anim_tasks.lua:23
function clear_task(t: AnimTask): void {
  for (const k in t) {
    if (k !== "data") delete t[k];
  }
  t.active = false;
  t.priority = 0;
  for (let i = 0; i <= 15; i++) {
    t.data[i] = 0;
  }
}

// Lua: anim_tasks.lua:34
AnimTasks.init = function (): void {
  // NOT FAITHFUL: the anim_port groups merge on first init(), not at require time (ES module order)
  loadGroups();
  if (AnimTasks._pool) return;
  AnimTasks._pool = lseq<AnimTask>();
  for (let i = 1; i <= AnimTasks.MAX; i++) {
    const t: AnimTask = { data: {} };
    for (let j = 0; j <= 15; j++) t.data[j] = 0;
    clear_task(t);
    AnimTasks._pool[i] = t;
  }
};

// Lua: anim_tasks.lua:45
AnimTasks.reset = function (): void {
  AnimTasks.init();
  for (let i = 1; i <= AnimTasks.MAX; i++) {
    clear_task(AnimTasks._pool[i]);
  }
};

// Lua: anim_tasks.lua:52
AnimTasks.activeCount = function (): number {
  AnimTasks.init();
  let n = 0;
  for (let i = 1; i <= AnimTasks.MAX; i++) {
    if (AnimTasks._pool[i].active && !AnimTasks._pool[i]._uncounted) n = n + 1;
  }
  return n;
};

// Lua: anim_tasks.lua:61
function destroy_task(t: AnimTask): void {
  clear_task(t);
}

// Lua: anim_tasks.lua:66
//- Stub: lasts 1 frame then finishes (keeps waitforvisualfinish moving).
function stub_task(t: AnimTask, _vm?: any): void {
  t.data[15] = (t.data[15] ?? 0) + 1;
  if (t.data[15] >= 1) {
    destroy_task(t);
  }
}

// Registry: name → function(task, vm)
AnimTasks.REGISTRY = {} as Record<string, TaskFn>;

// Lua: anim_tasks.lua:78
//- pret AnimTask_ShakeMon (pokefirered/src/battle_anim_mon_movement.c:94)
// arg 0: battler, arg 1: x offset, arg 2: y offset, arg 3: num shakes, arg 4: delay
AnimTasks.ShakeMon = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const side = vm.resolveBattlerSide(t.data[0]);
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._xOff = tonumber(t.data[1]) ?? 0;
    t._yOff = tonumber(t.data[2]) ?? 0;
    t._numShakes = Math.max(1, tonumber(t.data[3]) ?? 1);
    t._delay = Math.max(0, tonumber(t.data[4]) ?? 1);
    t._timer = t._delay;
    t._p.ox = t._xOff;
    t._p.oy = t._yOff;
    return;
  }
  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }
  if ((t._timer ?? 0) <= 0) {
    p.ox = (p.ox === 0) ? t._xOff : 0;
    p.oy = (p.oy === 0) ? t._yOff : 0;
    t._timer = t._delay;
    t._numShakes = t._numShakes - 1;
    if (t._numShakes <= 0) {
      p.ox = 0;
      p.oy = 0;
      destroy_task(t);
    }
  } else {
    t._timer = t._timer - 1;
  }
};

AnimTasks.REGISTRY.ShakeMon = AnimTasks.ShakeMon;
AnimTasks.REGISTRY.AnimTask_ShakeMon = AnimTasks.ShakeMon;

// Lua: anim_tasks.lua:123
//- pret AnimTask_ShakeMon2 (pokefirered/src/battle_anim_mon_movement.c:146)
// arg 0: battler, arg 1: x offset, arg 2: y offset, arg 3: num shakes, arg 4: delay
AnimTasks.ShakeMon2 = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const side = vm.resolveBattlerSide(t.data[0]);
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._xOff = tonumber(t.data[1]) ?? 0;
    t._yOff = tonumber(t.data[2]) ?? 0;
    t._numShakes = Math.max(1, tonumber(t.data[3]) ?? 1);
    t._delay = Math.max(0, tonumber(t.data[4]) ?? 1);
    t._timer = t._delay;
    t._p.ox = t._xOff;
    t._p.oy = t._yOff;
    return;
  }
  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }
  if ((t._timer ?? 0) <= 0) {
    p.ox = (p.ox === t._xOff) ? -t._xOff : t._xOff;
    p.oy = (p.oy === t._yOff) ? -t._yOff : t._yOff;
    t._timer = t._delay;
    t._numShakes = t._numShakes - 1;
    if (t._numShakes <= 0) {
      p.ox = 0;
      p.oy = 0;
      destroy_task(t);
    }
  } else {
    t._timer = t._timer - 1;
  }
};

AnimTasks.REGISTRY.ShakeMon2 = AnimTasks.ShakeMon2;
AnimTasks.REGISTRY.AnimTask_ShakeMon2 = AnimTasks.ShakeMon2;

// Lua: anim_tasks.lua:168
//- pret AnimTask_ShakeMonInPlace (pokefirered/src/battle_anim_mon_movement.c:232)
// arg 0: battler, arg 1: x offset, arg 2: y offset, arg 3: num shakes, arg 4: delay
AnimTasks.ShakeMonInPlace = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const side = vm.resolveBattlerSide(t.data[0]);
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    const xOff = tonumber(t.data[1]) ?? 0;
    const yOff = tonumber(t.data[2]) ?? 0;
    t._p.ox = (t._p.ox ?? 0) + xOff;
    t._p.oy = (t._p.oy ?? 0) + yOff;
    t._step = 0;
    t._numShakes = Math.max(1, tonumber(t.data[3]) ?? 1);
    t._timer = 0;
    t._delay = Math.max(0, tonumber(t.data[4]) ?? 1);
    t._dx = xOff * 2;
    t._dy = yOff * 2;
    return;
  }
  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }
  if ((t._timer ?? 0) <= 0) {
    if (mod(t._step, 2) === 1) {
      p.ox = (p.ox ?? 0) + t._dx;
      p.oy = (p.oy ?? 0) + t._dy;
    } else {
      p.ox = (p.ox ?? 0) - t._dx;
      p.oy = (p.oy ?? 0) - t._dy;
    }
    t._timer = t._delay;
    t._step = t._step + 1;
    if (t._step >= t._numShakes) {
      if (mod(t._step, 2) === 1) {
        p.ox = (p.ox ?? 0) + Math.floor(t._dx / 2);
        p.oy = (p.oy ?? 0) + Math.floor(t._dy / 2);
      } else {
        p.ox = (p.ox ?? 0) - Math.floor(t._dx / 2);
        p.oy = (p.oy ?? 0) - Math.floor(t._dy / 2);
      }
      destroy_task(t);
    }
  } else {
    t._timer = t._timer - 1;
  }
};

AnimTasks.REGISTRY.ShakeMonInPlace = AnimTasks.ShakeMonInPlace;
AnimTasks.REGISTRY.AnimTask_ShakeMonInPlace = AnimTasks.ShakeMonInPlace;

// Lua: anim_tasks.lua:226
//- pret AnimTask_ShakeAndSinkMon (pokefirered/src/battle_anim_mon_movement.c:294)
// arg 0: battler, arg 1: x offset, arg 2: frame delay, arg 3: downward speed (subpixel Q8.8), arg 4: duration
AnimTasks.ShakeAndSinkMon = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const side = vm.resolveBattlerSide(t.data[0]);
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._xOff = tonumber(t.data[1]) ?? 0;
    t._delay = Math.max(1, tonumber(t.data[2]) ?? 1);
    t._downSpeed = tonumber(t.data[3]) ?? 0;
    t._duration = Math.max(1, tonumber(t.data[4]) ?? 1);
    t._delayCounter = 0;
    t._subY = 0;
    t._p.ox = t._xOff;
    return;
  }
  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }
  t._delayCounter = t._delayCounter + 1;
  if (t._delayCounter >= t._delay) {
    t._delayCounter = 0;
    if (p.ox === t._xOff) {
      t._xOff = -t._xOff;
    }
    p.ox = p.ox + t._xOff;
  }
  t._subY = t._subY + t._downSpeed;
  p.oy = Math.floor(t._subY / 256);
  t._duration = t._duration - 1;
  if (t._duration <= 0) {
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.ShakeAndSinkMon = AnimTasks.ShakeAndSinkMon;
AnimTasks.REGISTRY.AnimTask_ShakeAndSinkMon = AnimTasks.ShakeAndSinkMon;

// Lua: anim_tasks.lua:272
//- pret DoHorizontalLunge / ReverseHorizontalLungeDirection (pokefirered/src/battle_anim_mon_movement.c:388)
// arg 0: duration of single lunge direction, arg 1: x pixel delta per frame
AnimTasks.HorizontalLunge = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const side = vm.attackerSide();
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._dur = Math.max(1, tonumber(t.data[0]) ?? 4);
    let delta = tonumber(t.data[1]) ?? 4;
    if (side !== "player") {
      delta = -delta;
    }
    t._delta = delta;
    t._frame = 0;
    t._origZ = t._p.z;
    // Dynamic Z-indexing: elevate attacker above target and healthbox during lunge
    t._p.z = AnimVm.Z.FRONT;
  }
  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }
  t._frame = t._frame + 1;
  if (t._frame <= t._dur) {
    p.ox = (p.ox ?? 0) + t._delta;
  } else if (t._frame <= t._dur * 2) {
    p.ox = (p.ox ?? 0) - t._delta;
  } else {
    p.ox = 0;
    if (t._origZ != null) p.z = t._origZ;
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.HorizontalLunge = AnimTasks.HorizontalLunge;
AnimTasks.REGISTRY.DoHorizontalLunge = AnimTasks.HorizontalLunge;
AnimTasks.REGISTRY.ReverseHorizontalLungeDirection = AnimTasks.HorizontalLunge;

// Lua: anim_tasks.lua:318
//- pret DoVerticalDip / ReverseVerticalDipDirection (pokefirered/src/battle_anim_mon_movement.c:416)
// arg 0: duration of single dip direction, arg 1: y pixel delta per frame, arg 2: battler
AnimTasks.VerticalDip = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const side = vm.resolveBattlerSide(t.data[2] ?? 0);
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._dur = Math.max(1, tonumber(t.data[0]) ?? 4);
    t._delta = tonumber(t.data[1]) ?? 4;
    t._frame = 0;
  }
  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }
  t._frame = t._frame + 1;
  if (t._frame <= t._dur) {
    p.oy = (p.oy ?? 0) + t._delta;
  } else if (t._frame <= t._dur * 2) {
    p.oy = (p.oy ?? 0) - t._delta;
  } else {
    p.oy = 0;
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.VerticalDip = AnimTasks.VerticalDip;
AnimTasks.REGISTRY.DoVerticalDip = AnimTasks.VerticalDip;
AnimTasks.REGISTRY.ReverseVerticalDipDirection = AnimTasks.VerticalDip;

// Lua: anim_tasks.lua:355
//- pret SlideMonToOriginalPos (pokefirered/src/battle_anim_mon_movement.c:443)
// arg 0: 0=attacker, 1=target; arg 1: dir (0=both, 1=horiz, 2=vert); arg 2: duration
AnimTasks.SlideMonToOriginalPos = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const side = vm.resolveBattlerSide(t.data[0] ?? 0);
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._dir = tonumber(t.data[1]) ?? 0;
    t._dur = Math.max(1, tonumber(t.data[2]) ?? 10);
    t._startX = t._p.ox ?? 0;
    t._startY = t._p.oy ?? 0;
    t._deltaX_fp = Math.floor((-t._startX * 256) / t._dur);
    t._deltaY_fp = Math.floor((-t._startY * 256) / t._dur);
    t._accumX = 0;
    t._accumY = 0;
    t._ticks = t._dur;
    t._p.z = (side === "player") ? AnimVm.Z.PLAYER : AnimVm.Z.ENEMY;
  }
  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }
  if (t._ticks <= 0) {
    if (t._dir === 0 || t._dir === 1) p.ox = 0;
    if (t._dir === 0 || t._dir === 2) p.oy = 0;
    p.z = (t._side === "player") ? AnimVm.Z.PLAYER : AnimVm.Z.ENEMY;
    destroy_task(t);
    return;
  }
  t._ticks = t._ticks - 1;
  t._accumX = t._accumX + t._deltaX_fp;
  t._accumY = t._accumY + t._deltaY_fp;
  if (t._dir === 0 || t._dir === 1) {
    p.ox = t._startX + Math.floor(t._accumX / 256);
  }
  if (t._dir === 0 || t._dir === 2) {
    p.oy = t._startY + Math.floor(t._accumY / 256);
  }
  if (t._ticks <= 0) {
    if (t._dir === 0 || t._dir === 1) p.ox = 0;
    if (t._dir === 0 || t._dir === 2) p.oy = 0;
    p.z = (t._side === "player") ? AnimVm.Z.PLAYER : AnimVm.Z.ENEMY;
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.SlideMonToOriginalPos = AnimTasks.SlideMonToOriginalPos;
AnimTasks.REGISTRY.AnimTask_SlideMonToOriginalPos = AnimTasks.SlideMonToOriginalPos;

// Lua: anim_tasks.lua:412
//- pret SlideMonToOffset (pokefirered/src/battle_anim_mon_movement.c:500)
// arg 0: 0=attacker, 1=target; arg 1: targetX; arg 2: targetY; arg 3: mirrorY; arg 4: duration
AnimTasks.SlideMonToOffset = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const side = vm.resolveBattlerSide(t.data[0] ?? 0);
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    let targetX = tonumber(t.data[1]) ?? 0;
    let targetY = tonumber(t.data[2]) ?? 0;
    const mirrorY = tonumber(t.data[3]) ?? 0;
    if (side !== "player") {
      targetX = -targetX;
      if (mirrorY === 1) targetY = -targetY;
    }
    t._dur = Math.max(1, tonumber(t.data[4]) ?? 10);
    t._startX = t._p.ox ?? 0;
    t._startY = t._p.oy ?? 0;
    t._targetX = targetX;
    t._targetY = targetY;
    t._deltaX_fp = Math.floor(((targetX - t._startX) * 256) / t._dur);
    t._deltaY_fp = Math.floor(((targetY - t._startY) * 256) / t._dur);
    t._accumX = 0;
    t._accumY = 0;
    t._ticks = t._dur;
  }
  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }
  if (t._ticks <= 0) {
    p.ox = t._targetX;
    p.oy = t._targetY;
    destroy_task(t);
    return;
  }
  t._ticks = t._ticks - 1;
  t._accumX = t._accumX + t._deltaX_fp;
  t._accumY = t._accumY + t._deltaY_fp;
  p.ox = t._startX + Math.floor(t._accumX / 256);
  p.oy = t._startY + Math.floor(t._accumY / 256);
  if (t._ticks <= 0) {
    p.ox = t._targetX;
    p.oy = t._targetY;
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.SlideMonToOffset = AnimTasks.SlideMonToOffset;
AnimTasks.REGISTRY.AnimTask_SlideMonToOffset = AnimTasks.SlideMonToOffset;

// Lua: anim_tasks.lua:469
//- pret SlideMonToOffsetAndBack (pokefirered/src/battle_anim_mon_movement.c:529)
// arg 0: battler; arg 1: targetX; arg 2: targetY; arg 3: mirrorY; arg 4: duration; arg 5: resetAtEnd
AnimTasks.SlideMonToOffsetAndBack = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const side = vm.resolveBattlerSide(t.data[0] ?? 0);
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    let targetX = tonumber(t.data[1]) ?? 0;
    let targetY = tonumber(t.data[2]) ?? 0;
    const mirrorY = tonumber(t.data[3]) ?? 0;
    if (side !== "player") {
      targetX = -targetX;
      if (mirrorY === 1) targetY = -targetY;
    }
    t._dur = Math.max(1, tonumber(t.data[4]) ?? 10);
    t._resetAtEnd = (tonumber(t.data[5]) ?? 0) === 1;
    t._startX = t._p.ox ?? 0;
    t._startY = t._p.oy ?? 0;
    t._targetX = targetX;
    t._targetY = targetY;
    t._deltaX_fp = Math.floor(((targetX - t._startX) * 256) / t._dur);
    t._deltaY_fp = Math.floor(((targetY - t._startY) * 256) / t._dur);
    t._accumX = 0;
    t._accumY = 0;
    t._ticks = t._dur;
  }
  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }
  if (t._ticks <= 0) {
    if (t._resetAtEnd) {
      p.ox = 0;
      p.oy = 0;
    } else {
      p.ox = t._targetX;
      p.oy = t._targetY;
    }
    destroy_task(t);
    return;
  }
  t._ticks = t._ticks - 1;
  t._accumX = t._accumX + t._deltaX_fp;
  t._accumY = t._accumY + t._deltaY_fp;
  p.ox = t._startX + Math.floor(t._accumX / 256);
  p.oy = t._startY + Math.floor(t._accumY / 256);
  if (t._ticks <= 0) {
    if (t._resetAtEnd) {
      p.ox = 0;
      p.oy = 0;
    } else {
      p.ox = t._targetX;
      p.oy = t._targetY;
    }
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.SlideMonToOffsetAndBack = AnimTasks.SlideMonToOffsetAndBack;
AnimTasks.REGISTRY.AnimTask_SlideMonToOffsetAndBack = AnimTasks.SlideMonToOffsetAndBack;
AnimTasks.REGISTRY.SlideMon = AnimTasks.SlideMonToOffsetAndBack;

// Lua: anim_tasks.lua:537
//- Sound tasks: finish on a short timer (cry audio optional later).
AnimTasks.SoundTaskWait = function (t: AnimTask, _vm: any): void {
  t.data[14] = (t.data[14] ?? 0) + 1;
  if (t.data[14] >= 18) {
    destroy_task(t);
  }
};

// pokefirered/include/constants/sound.h:20-31
const CRY_MODE_HIGH_PITCH = 3;
const CRY_MODE_ROAR_1 = 7;
const CRY_MODE_ROAR_2 = 8;
const CRY_MODE_GROWL_1 = 9;
const CRY_MODE_GROWL_2 = 10;
// pokefirered/include/constants/sound.h:35
const DOUBLE_CRY_GROWL = 255;
// pokefirered/include/constants/battle_anim.h
const SOUND_PAN_ATTACKER = -64;

// Lua: anim_tasks.lua:555
function cry_species(vm: any, battler: unknown): any {
  if (!(vm && vm.resolveBattlerSide && vm.speciesForSide)) return null;
  return vm.speciesForSide(vm.resolveBattlerSide(battler));
}

// Lua: anim_tasks.lua:560
function cry_pan(vm: any): number {
  if (vm && vm.adjustPanning) return vm.adjustPanning(SOUND_PAN_ATTACKER);
  return SOUND_PAN_ATTACKER;
}

// Lua: anim_tasks.lua:566
//- pokefirered/src/battle_anim_sound_tasks.c:158
AnimTasks.SoundTask_PlayDoubleCry = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    t._species = cry_species(vm, t.data[0]);
    if (!truthy(t._species)) {
      destroy_task(t);
      return;
    }
    t._pan = cry_pan(vm);
    const growl = (t.data[1] === DOUBLE_CRY_GROWL || t.data[1] === -1);
    t._mode2 = growl ? CRY_MODE_GROWL_2 : CRY_MODE_ROAR_2;
    t._frames = 0;
    Audio.playCry(t._species, {
      pan: t._pan,
      mode: growl ? CRY_MODE_GROWL_1 : CRY_MODE_ROAR_1,
    });
    return;
  }
  // pokefirered/src/battle_anim_sound_tasks.c:201
  t._frames = (t._frames ?? 0) + 1;
  if (t._frames < 2) return;
  if ((!Audio.isCryFinished) || Audio.isCryFinished()) {
    Audio.playCry(t._species, { pan: t._pan, mode: t._mode2 });
    destroy_task(t);
    return;
  }
  if (t._frames >= 150) {
    destroy_task(t);
  }
};

// Lua: anim_tasks.lua:599
//- pokefirered/src/battle_anim_sound_tasks.c:228
AnimTasks.SoundTask_WaitForCry = function (t: AnimTask, _vm: any): void {
  t.data[14] = (t.data[14] ?? 0) + 1;
  if (t.data[14] < 2) return;
  if ((!Audio.isCryFinished) || Audio.isCryFinished()) {
    destroy_task(t);
    return;
  }
  if (t.data[14] >= 300) {
    destroy_task(t);
  }
};

// Lua: anim_tasks.lua:613
//- pokefirered/src/battle_anim_sound_tasks.c:140
AnimTasks.SoundTask_PlayCryHighPitch = function (t: AnimTask, vm: any): void {
  const species = cry_species(vm, t.data[0]);
  if (truthy(species)) {
    Audio.playCry(species, { pan: cry_pan(vm), mode: CRY_MODE_HIGH_PITCH });
  }
  destroy_task(t);
};

AnimTasks.REGISTRY.SoundTask_PlayDoubleCry = AnimTasks.SoundTask_PlayDoubleCry;
AnimTasks.REGISTRY.SoundTask_WaitForCry = AnimTasks.SoundTask_WaitForCry;
AnimTasks.REGISTRY.PlayDoubleCry = AnimTasks.SoundTask_PlayDoubleCry;
AnimTasks.REGISTRY.SoundTask_PlayCryHighPitch = AnimTasks.SoundTask_PlayCryHighPitch;

// Lua: anim_tasks.lua:628
//- BlendColorCycle stub: nudge pal toward a tint for a few frames then restore.
AnimTasks.BlendColorCycle = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const pal = vm.pals[0];
  if (pal && frame === 0) {
    t.data[10] = 1; // marked
    for (let i = 1; i <= 15; i++) {
      const c = pal[i];
      if (c) {
        c[1] = Math.min(1, (c[1] ?? 0) + 0.15);
      }
    }
  }
  if (frame >= 8) {
    if (pal) {
      pal[1] = lseq(1, 1, 1, 1);
      pal[2] = lseq(1, 0.9, 0.2, 1);
      pal[3] = lseq(1, 0.4, 0.1, 1);
    }
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.BlendColorCycle = AnimTasks.BlendColorCycle;
AnimTasks.REGISTRY.AnimTask_BlendColorCycle = AnimTasks.BlendColorCycle;
AnimTasks.REGISTRY.AnimTask_BlendColorCycleByTag = AnimTasks.BlendColorCycle;
AnimTasks.REGISTRY.AnimTask_BlendColorCycleExclude = AnimTasks.BlendColorCycle;

// Lua: anim_tasks.lua:657
//- pret AnimTask_DefenseCurlDeformMon: squishes mon vertically/horizontally (2 cycles of 16 ticks = 32 ticks).
AnimTasks.DefenseCurlDeformMon = function (t: AnimTask, vm: any): void {
  const side = vm.attackerSide();
  const p = Anim.present(side);
  if (!p) {
    destroy_task(t);
    return;
  }
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  if (frame < 32) {
    const phase = (mod(frame, 16)) / 16 * Math.PI * 2;
    const deform = Math.sin(phase) * 0.22;
    p.sx = 1.0 - deform * 0.8;
    p.sy = 1.0 + deform;
  } else {
    p.sx = 1.0;
    p.sy = 1.0;
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.DefenseCurlDeformMon = AnimTasks.DefenseCurlDeformMon;
AnimTasks.REGISTRY.AnimTask_DefenseCurlDeformMon = AnimTasks.DefenseCurlDeformMon;
AnimTasks.REGISTRY.StockpileDeformMon = AnimTasks.DefenseCurlDeformMon;
AnimTasks.REGISTRY.AnimTask_StockpileDeformMon = AnimTasks.DefenseCurlDeformMon;
AnimTasks.REGISTRY.SwallowDeformMon = AnimTasks.DefenseCurlDeformMon;
AnimTasks.REGISTRY.AnimTask_SwallowDeformMon = AnimTasks.DefenseCurlDeformMon;
AnimTasks.REGISTRY.SpitUpDeformMon = AnimTasks.DefenseCurlDeformMon;
AnimTasks.REGISTRY.AnimTask_SpitUpDeformMon = AnimTasks.DefenseCurlDeformMon;

// Lua: anim_tasks.lua:689
//- pret AnimTask_DarkenBattleAnimBg: dims background during signature VFX.
AnimTasks.DarkenBattleAnimBg = function (t: AnimTask, _vm: any): void {
  const stage = Anim.stage ? Anim.stage() : null;
  if (!stage) {
    destroy_task(t);
    return;
  }
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 32;
  if (frame < 8) {
    stage.bgDim = (frame / 8) * 0.85;
  } else if (frame < 24) {
    stage.bgDim = 0.85;
  } else if (frame < dur) {
    stage.bgDim = (1.0 - (frame - 24) / 8) * 0.85;
  } else {
    stage.bgDim = 0;
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.DarkenBattleAnimBg = AnimTasks.DarkenBattleAnimBg;
AnimTasks.REGISTRY.AnimTask_DarkenBattleAnimBg = AnimTasks.DarkenBattleAnimBg;

// Lua: anim_tasks.lua:716
//- pret AnimBowMon (pokefirered/src/battle_anim_effects_1.c:4451)
// arg 0: step mode (0=bow start, 1=return slide, 2=hold & unbow, 3=end)
AnimTasks.BowMon = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const stepMode = tonumber(t.data[0]) ?? 0;
    const side = vm.attackerSide();
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._mode = stepMode;
    t._frame = 0;
    const dir = (side === "player") ? -1 : 1;
    if (stepMode === 0) {
      t._dx = dir * 2;
      t._dur = 6;
    } else if (stepMode === 1) {
      t._dx = -dir * 3;
      t._dur = 4;
    } else if (stepMode === 2) {
      t._dur = 8;
    } else {
      t._dur = 1;
    }
  }
  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }
  t._frame = t._frame + 1;
  if (t._mode === 0) {
    if (t._frame <= t._dur) {
      p.ox = (p.ox ?? 0) + t._dx;
    } else {
      p.rotation = (t._side === "player") ? -0.05 : 0.05;
      if (t._frame > t._dur + 3) {
        destroy_task(t);
      }
    }
  } else if (t._mode === 1) {
    if (t._frame <= t._dur) {
      p.ox = (p.ox ?? 0) + t._dx;
    } else {
      destroy_task(t);
    }
  } else if (t._mode === 2) {
    if (t._frame > t._dur) {
      p.rotation = 0;
      destroy_task(t);
    }
  } else {
    p.rotation = 0;
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.BowMon = AnimTasks.BowMon;
AnimTasks.REGISTRY.AnimBowMon = AnimTasks.BowMon;
AnimTasks.REGISTRY.AnimTask_BowMon = AnimTasks.BowMon;

// Lua: anim_tasks.lua:781
//- pret AnimShakeMonOrBattleTerrain (pokefirered/src/battle_anim_normal.c:771)
// arg 0: offset, arg 1: frame delay, arg 2: duration, arg 3: target type (0=BG3_X, 1=BG3_Y, 2=spriteX, 3=spriteY)
AnimTasks.ShakeMonOrBattleTerrain = function (t: AnimTask, _vm: any): void {
  if (!t._inited) {
    t._inited = true;
    t._offset = tonumber(t.data[0]) ?? 4;
    t._delay = Math.max(1, tonumber(t.data[1]) ?? 2);
    t._duration = Math.max(1, tonumber(t.data[2]) ?? 16);
    t._targetType = tonumber(t.data[3]) ?? 0;
    t._timer = t._delay;
    t._stage = Anim.stage();
    t._curOff = t._offset;
  }
  const st = t._stage;
  if (t._duration > 0) {
    t._duration = t._duration - 1;
    if (t._timer > 0) {
      t._timer = t._timer - 1;
    } else {
      t._timer = t._delay;
      t._curOff = -t._curOff;
      if (t._targetType === 0 || t._targetType === 2) {
        if (st && st.bgSlide) {
          st.bgSlide.playerOx = t._curOff;
          st.bgSlide.enemyOx = t._curOff;
        }
      }
    }
  } else {
    if (st && st.bgSlide) {
      st.bgSlide.playerOx = 0;
      st.bgSlide.enemyOx = 0;
    }
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.ShakeMonOrBattleTerrain = AnimTasks.ShakeMonOrBattleTerrain;
AnimTasks.REGISTRY.AnimShakeMonOrBattleTerrain = AnimTasks.ShakeMonOrBattleTerrain;
AnimTasks.REGISTRY.AnimTask_ShakeMonOrBattleTerrain = AnimTasks.ShakeMonOrBattleTerrain;

// Lua: anim_tasks.lua:823
//- pret AnimTask_CreateSurfWave (pokefirered/src/battle_anim_water.c:799):
// Authentic multi-phase surging tidal wave with GBA scanline displacement, dynamic sine foam crests, and collision impact.
AnimTasks.CreateSurfWave = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const totalDur = 46;

  const atkSide = vm.attackerSide();
  const tgtSide = vm.resolveBattlerSide("target");
  const pTgt = Anim.present(tgtSide);
  const pAtk = Anim.present(atkSide);

  const isMuddy = (t.data[0] === 1 || t.data[8] === 1 || (t.name != null && find(t.name, "Muddy") != null));
  t.data[8] = isMuddy ? 1 : 0;
  t.z = AnimSprites.Z.GLOBAL_FRONT;

  // Initial setup matching GBA AnimTask_CreateSurfWave
  if (frame === 1) {
    if (atkSide === "player") {
      t.data[0] = -2;   // dx
      t.data[1] = 1;    // dy
      t.data[10] = 0;   // scrollX
      t.data[11] = -48; // scrollY
    } else {
      t.data[0] = 2;
      t.data[1] = -1;
      t.data[10] = -224;
      t.data[11] = 256;
    }
    t._particles = lseq();
  }

  // Update scroll offsets
  t.data[10] = (t.data[10] ?? 0) + (t.data[0] ?? -2);
  t.data[11] = (t.data[11] ?? 0) + (t.data[1] ?? 1);

  // GBA Alpha Blending Curve (0 -> 14/16 -> 0)
  let alpha = 0;
  if (frame <= 14) {
    alpha = (frame / 14) * (14 / 16);
  } else if (frame <= 34) {
    alpha = 14 / 16;
  } else {
    alpha = Math.max(0, (14 / 16) * (1 - (frame - 34) / 12));
  }
  t._alpha = alpha;

  // 1. Attacker lunges slightly forward on wave launch (frames 1..12)
  if (frame < 12 && pAtk) {
    const u = frame / 12;
    const dir = (atkSide === "player") ? 1 : -1;
    pAtk.ox = Math.floor(Math.sin(u * Math.PI) * 8 * dir);
  } else if (frame >= 12 && pAtk && pAtk.ox !== 0) {
    pAtk.ox = 0;
  }

  // 2. Wave impact & collision shudder on target (frames 16..38)
  if (frame >= 16 && frame < 38 && pTgt) {
    const phase = mod(frame, 4);
    const amp = Math.max(1, Math.floor(5 * (1 - (frame - 16) / 22)));
    pTgt.ox = (phase === 0 || phase === 3) ? amp : -amp;
    pTgt.oy = (phase === 1 || phase === 2) ? amp : -amp;
    pTgt.flash = frame;
  } else if (frame >= 38 && pTgt) {
    pTgt.ox = 0;
    pTgt.oy = 0;
    pTgt.flash = 0;
  }

  // 3. Procedural water splash & droplet particles around target on impact
  if (frame >= 16 && frame <= 34 && mod(frame, 2) === 0) {
    const [tx, ty] = vm.battlerCenter(tgtSide);
    t._particles = t._particles ?? lseq();
    for (let _ = 1; _ <= 3; _++) {
      t._particles[len(t._particles) + 1] = {
        x: tx + random(-24, 24),
        y: ty + random(-16, 16),
        vx: (random() - 0.5) * 3,
        vy: -(random() * 2.5 + 1.5),
        life: 0,
        maxLife: random(10, 18),
        size: random(2, 4),
      };
    }
  }

  // Update active particles
  if (t._particles) {
    const alive: LuaTable = lseq();
    const ps = t._particles;
    const n = len(ps);
    for (let i = 1; i <= n; i++) {
      const p = ps[i];
      p.life = p.life + 1;
      p.x = p.x + p.vx;
      p.y = p.y + p.vy;
      p.vy = p.vy + 0.15; // gravity
      if (p.life < p.maxLife) {
        alive[len(alive) + 1] = p;
      }
    }
    t._particles = alive;
  }

  // 4. Draw callback attached directly to task
  t.draw = function (task: AnimTask, _vm: any): void {
    const a = task._alpha ?? 0;
    if (a <= 0.01) return;
    // (Brian's `if not (love and love.graphics) then return end`: the platform always has graphics.)

    const isMud = (task.data[8] === 1);
    let rFill = 0.12, gFill = 0.52, bFill = 0.90;
    let rDeep = 0.05, gDeep = 0.30, bDeep = 0.65;
    let rCrest = 0.94, gCrest = 0.97, bCrest = 1.00;
    let rShimmer = 0.40, gShimmer = 0.75, bShimmer = 1.00;
    if (isMud) {
      rFill = 0.56; gFill = 0.40; bFill = 0.22;
      rDeep = 0.36; gDeep = 0.24; bDeep = 0.12;
      rCrest = 0.86; gCrest = 0.78; bCrest = 0.62;
      rShimmer = 0.70; gShimmer = 0.55; bShimmer = 0.35;
    }

    const scrollX = task.data[10] ?? 0;
    const isPlr = (atkSide === "player");
    const f = task.data[14] ?? 1;

    // GBA Scanline Swelling & Full-Screen Tidal Wave Engulfment
    // Wave crest swells and rises to engulf the whole screen (0..112)
    let surgeProgress = 0;
    if (f <= 20) {
      surgeProgress = f / 20; // rising surge (0 -> 1)
    } else if (f <= 34) {
      surgeProgress = 1.0;    // full screen engulfment peak
    } else {
      surgeProgress = Math.max(0, 1.0 - (f - 34) / 12); // receding drain (1 -> 0)
    }

    // Swell baseline: Player surge rises from 95 up to -10 (engulfs entire arena); Opponent crashes from 0 down to 112
    let baselineY = 0;
    if (isPlr) {
      baselineY = 95 - (surgeProgress * 105) + Math.floor(Sin(mod(scrollX * 2, 256), 4));
    } else {
      baselineY = 15 + (surgeProgress * 85) + Math.floor(Sin(mod(scrollX * 2, 256), 4));
    }

    // Build smooth wave crest polygon across the full screen width (0..240)
    const numSegs = 32;
    const stepX = 240 / numSegs;
    const pts: LuaTable = lseq();
    for (let i = 0; i <= numSegs; i++) {
      const sx = i * stepX;
      const wavePhase1 = mod(sx * 3 + scrollX * 4, 256);
      const wavePhase2 = mod(sx * 6 - scrollX * 5, 256);
      const waveAmp = (6 + Math.floor(surgeProgress * 8)) + Sin(mod(f * 6, 256), 3);
      const waveH = Sin(wavePhase1, waveAmp) + Sin(wavePhase2, 3);
      // Dynamic surge slope from attacker side across to target
      const slopeProgress = Math.min(1.0, f / 18);
      const slope = isPlr ? (((sx / 240) * 20 - 10) * (1 - slopeProgress * 0.5))
                          : ((((240 - sx) / 240) * 20 - 10) * (1 - slopeProgress * 0.5));
      const sy = baselineY + waveH - slope;
      pts[len(pts) + 1] = { x: sx, y: Math.min(112, sy) };
    }
    const npts = len(pts);

    // 1. Fill deep water body across the entire battle arena (y = 0..112)
    const poly: LuaTable = lseq();
    for (let i = 1; i <= npts; i++) {
      const pt = pts[i];
      poly[len(poly) + 1] = pt.x;
      poly[len(poly) + 1] = pt.y;
    }
    poly[len(poly) + 1] = 240;
    poly[len(poly) + 1] = 112;
    poly[len(poly) + 1] = 0;
    poly[len(poly) + 1] = 112;

    if (len(poly) >= 6) {
      G.setColor(rDeep, gDeep, bDeep, a * 0.75);
      G.polygon("fill", poly);

      // 2. Mid water surge layer with offset
      const midPoly: LuaTable = lseq();
      for (let i = 1; i <= npts; i++) {
        const pt = pts[i];
        midPoly[len(midPoly) + 1] = pt.x;
        midPoly[len(midPoly) + 1] = pt.y + 4;
      }
      midPoly[len(midPoly) + 1] = 240;
      midPoly[len(midPoly) + 1] = 112;
      midPoly[len(midPoly) + 1] = 0;
      midPoly[len(midPoly) + 1] = 112;
      if (len(midPoly) >= 6) {
        G.setColor(rFill, gFill, bFill, a * 0.85);
        G.polygon("fill", midPoly);
      }
    }

    // 3. Shimmering horizontal wave scanline bands
    G.setColor(rShimmer, gShimmer, bShimmer, a * 0.55);
    for (let i = 1; i <= npts; i++) {
      const pt = pts[i];
      if (mod(pt.x, 16) < stepX) {
        G.line(pt.x, pt.y + 8, pt.x + 10, pt.y + 8);
        G.line(pt.x + 4, pt.y + 16, pt.x + 14, pt.y + 16);
        G.line(pt.x + 2, pt.y + 24, pt.x + 12, pt.y + 24);
        G.line(pt.x + 6, pt.y + 36, pt.x + 18, pt.y + 36);
      }
    }

    // 4. White foam crest along the leading wave ridge
    G.setColor(rCrest, gCrest, bCrest, a * 0.95);
    G.setLineWidth(2.5);
    for (let i = 1; i <= npts - 1; i++) {
      G.line(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      if (mod(i, 3) === 0) {
        G.circle("fill", pts[i].x, pts[i].y - 1, 2.0);
      }
    }
    G.setLineWidth(1);

    // 5. Splashing spray droplets
    if (task._particles) {
      const ps = task._particles;
      const n = len(ps);
      for (let i = 1; i <= n; i++) {
        const p = ps[i];
        const pAlpha = a * (1 - p.life / p.maxLife);
        G.setColor(rCrest, gCrest, bCrest, pAlpha);
        G.circle("fill", p.x, p.y, p.size);
      }
    }

    G.setColor(1, 1, 1, 1);
  };

  if (frame >= totalDur) {
    if (pTgt) { pTgt.ox = 0; pTgt.oy = 0; pTgt.flash = 0; }
    if (pAtk) { pAtk.ox = 0; }
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.CreateSurfWave = AnimTasks.CreateSurfWave;
AnimTasks.REGISTRY.AnimTask_CreateSurfWave = AnimTasks.CreateSurfWave;

// Lua: anim_tasks.lua:1058
//- pret AnimTask_WaterSport / AnimTask_Splash: water droplets and splashing fountain.
AnimTasks.WaterSport = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 24;
  const side = vm.attackerSide();
  const [cx, cy] = vm.battlerCenter(side);
  const pack = vm._pack;

  if (frame < 16 && mod(frame, 3) === 0) {
    const imgMeta = pack && pack.tags && (pack.tags["WATER_DROPLET"] || pack.tags["BUBBLE"] || pack.tags["WATER_ORB"]);
    if (imgMeta && imgMeta.image) {
      for (let _ = 1; _ <= 3; _++) {
        const vx = random(-25, 25) / 10;
        const vy = -random(30, 50) / 10;
        const spr = AnimSprites.acquire({
          x: cx + random(-12, 12),
          y: cy + random(-8, 8),
          z: AnimSprites.Z.FRONT, // (no FRONT in AnimSprites.Z: nil, as in Brian's)
          image: imgMeta.image,
          w: imgMeta.frameW ?? 16,
          h: imgMeta.frameH ?? 16,
          tag: "WATER_DROPLET",
          callback: function (s: any): void {
            s.data[0] = (s.data[0] ?? 0) + 1;
            const step = s.data[0];
            s.ox = Math.floor(vx * step);
            s.oy = Math.floor(vy * step + 0.5 * 0.35 * step ** 2);
            s.alpha = Math.max(0, 1 - step / 20);
            if (step >= 20) AnimSprites.release(s);
          },
        });
        if (spr) {
          spr._baseW = imgMeta.frameW ?? 16;
          spr._baseH = imgMeta.frameH ?? 16;
        }
      }
    }
  }

  if (frame >= dur) {
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.WaterSport = AnimTasks.WaterSport;
AnimTasks.REGISTRY.AnimTask_WaterSport = AnimTasks.WaterSport;
AnimTasks.REGISTRY.Splash = AnimTasks.WaterSport;
AnimTasks.REGISTRY.AnimTask_Splash = AnimTasks.WaterSport;

// Lua: anim_tasks.lua:1108
//- pret AnimTask_InvertScreenColor / AnimTask_HardwarePaletteFade / AnimTask_FadeScreenToWhite: GLSL screen effect shaders.
AnimTasks.InvertScreenColor = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = Math.max(8, tonumber(t.data[0]) ?? 16);

  // Flash screen negative every 4 frames (2 frames on, 2 frames off)
  if ((mod(frame, 4) < 2) && frame < dur) {
    Anim.setScreenEffect({ type: "invert", coeff: 1.0 });
  } else {
    Anim.setScreenEffect(null);
  }

  if (frame >= dur) {
    Anim.setScreenEffect(null);
    destroy_task(t);
  }
};

// Lua: anim_tasks.lua:1127
AnimTasks.FlashAnimTagWithColor = function (t: AnimTask, _vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const tag = t.data[0] ?? 0;
    const delay = Math.max(1, tonumber(t.data[1]) ?? 2);
    const numFlashes = Math.max(1, tonumber(t.data[2]) ?? 1);
    const color = t.data[3] ?? 0;
    const coeff = tonumber(t.data[4]) ?? 16;
    t._tag = tag;
    t._delay = delay;
    t._flashesLeft = numFlashes;
    t._color = color;
    t._coeff = coeff;
    t._timer = delay;
  }

  t._timer = t._timer - 1;
  if (t._timer <= 0) {
    t._timer = t._delay;
    t._flashesLeft = t._flashesLeft - 1;
    if (t._flashesLeft <= 0) {
      destroy_task(t);
    }
  }
};

AnimTasks.REGISTRY.InvertScreenColor = AnimTasks.InvertScreenColor;
AnimTasks.REGISTRY.AnimTask_InvertScreenColor = AnimTasks.InvertScreenColor;
AnimTasks.REGISTRY.FlashAnimTagWithColor = AnimTasks.FlashAnimTagWithColor;
AnimTasks.REGISTRY.AnimTask_FlashAnimTagWithColor = AnimTasks.FlashAnimTagWithColor;

// Lua: anim_tasks.lua:1158
AnimTasks.FadeScreenToWhite = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = Math.max(10, tonumber(t.data[0]) ?? 20);

  const u = Math.sin((frame / dur) * Math.PI);
  Anim.setScreenEffect({ type: "fade_white", coeff: u });

  if (frame >= dur) {
    Anim.setScreenEffect(null);
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.FadeScreenToWhite = AnimTasks.FadeScreenToWhite;
AnimTasks.REGISTRY.AnimTask_FadeScreenToWhite = AnimTasks.FadeScreenToWhite;

// Lua: anim_tasks.lua:1176
AnimTasks.HardwarePaletteFade = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const delay = Math.max(1, tonumber(t.data[1]) ?? 2);
  const startCoeff = tonumber(t.data[2]) ?? 0;
  const targetCoeff = tonumber(t.data[3]) ?? 10;
  const totalSteps = Math.max(1, Math.abs(targetCoeff - startCoeff));
  const dur = Math.max(6, delay * totalSteps);

  const progress = Math.min(1.0, frame / dur);
  const curCoeff = (startCoeff + (targetCoeff - startCoeff) * progress) / 16;
  Anim.setScreenEffect({ type: "fade_black", coeff: curCoeff });

  if (frame >= dur) {
    if (targetCoeff === 0) {
      Anim.setScreenEffect(null);
    }
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.HardwarePaletteFade = AnimTasks.HardwarePaletteFade;
AnimTasks.REGISTRY.AnimTask_HardwarePaletteFade = AnimTasks.HardwarePaletteFade;

// Lua: anim_tasks.lua:1203
//- pret AnimTask_HorizontalShake / AnimTask_ShakeBattleTerrain (pokefirered/src/battle_anim_ground.c:555)
// arg 0: what to shake (0-3 battler, 4 all battlers, 5 terrain); arg 1: shake intensity; arg 2: length of time
AnimTasks.HorizontalShake = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    let intensity = tonumber(t.data[1]) ?? 0;
    if (intensity === 0) {
      intensity = Math.floor((vm.movePower ?? 80) / 10) + 3;
    } else {
      intensity = intensity + 3;
    }
    t._intensity = intensity;
    t._curOffset = intensity;
    t._maxTime = Math.max(1, tonumber(t.data[2]) ?? 16);
    t._which = t.data[0];
    t._state = 0;
    t._delay = 0;
    t._timer = 0;
    t._stage = Anim.stage();
  }
  const st = t._stage;
  if (t._state === 0) {
    t._delay = t._delay + 1;
    if (t._delay > 1) {
      t._delay = 0;
      const off = (mod(t._timer, 2) === 0) ? t._intensity : -t._intensity;
      if (st && st.bgSlide) {
        st.bgSlide.playerOx = off;
        st.bgSlide.enemyOx = off;
      }
      t._timer = t._timer + 1;
      if (t._timer >= t._maxTime) {
        t._timer = 0;
        t._curOffset = t._curOffset - 1;
        t._state = 1;
      }
    }
  } else if (t._state === 1) {
    t._delay = t._delay + 1;
    if (t._delay > 1) {
      t._delay = 0;
      const off = (mod(t._timer, 2) === 0) ? t._curOffset : -t._curOffset;
      if (st && st.bgSlide) {
        st.bgSlide.playerOx = off;
        st.bgSlide.enemyOx = off;
      }
      t._timer = t._timer + 1;
      if (t._timer >= 4) {
        t._timer = 0;
        t._curOffset = t._curOffset - 1;
        if (t._curOffset <= 0) {
          t._state = 2;
        }
      }
    }
  } else if (t._state === 2) {
    if (st && st.bgSlide) {
      st.bgSlide.playerOx = 0;
      st.bgSlide.enemyOx = 0;
    }
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.HorizontalShake = AnimTasks.HorizontalShake;
AnimTasks.REGISTRY.AnimTask_HorizontalShake = AnimTasks.HorizontalShake;
AnimTasks.REGISTRY.ShakeBattleTerrain = AnimTasks.HorizontalShake;
AnimTasks.REGISTRY.AnimTask_ShakeBattleTerrain = AnimTasks.HorizontalShake;
AnimTasks.REGISTRY.ShakeBattlers = AnimTasks.HorizontalShake;
AnimTasks.REGISTRY.ShakeTerrain = AnimTasks.HorizontalShake;

// Lua: anim_tasks.lua:1275
//- pret AnimTask_ShakeTargetBasedOnMovePowerOrDmg (pokefirered/src/battle_anim_mon_movement.c:872)
// arg 0: 0=power, 1=dmg; arg 1: frame delay; arg 2: num shakes; arg 3: shakeX; arg 4: shakeY
AnimTasks.ShakeTargetBasedOnMovePowerOrDmg = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const modeArg = tonumber(t.data[0]) ?? 0;
    const val = (modeArg === 0) ? (vm.movePower ?? 60) : (vm.moveDmg ?? 60);
    const intensity = Math.max(1, Math.min(16, Math.floor(val / 12)));
    t._half = Math.floor(intensity / 2);
    t._plusOdd = t._half + mod(intensity, 2);
    t._intensity = intensity;
    t._delay = Math.max(1, tonumber(t.data[1]) ?? 2);
    t._numShakes = Math.max(1, tonumber(t.data[2]) ?? 4);
    t._shakeX = (tonumber(t.data[3]) ?? 0) !== 0;
    t._shakeY = (tonumber(t.data[4]) ?? 0) !== 0;
    t._side = vm.targetSide();
    t._p = Anim.present(t._side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._origX = t._p.ox ?? 0;
    t._origY = t._p.oy ?? 0;
    t._phase = 0;
    t._timer = 0;
  }
  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }
  t._timer = t._timer + 1;
  if (t._timer > t._delay) {
    t._timer = 0;
    t._phase = mod(t._phase + 1, 2);
    if (t._shakeX) {
      if (t._phase === 1) {
        p.ox = t._origX + t._plusOdd;
      } else {
        p.ox = t._origX - t._half;
      }
    }
    if (t._shakeY) {
      if (t._phase === 1) {
        p.oy = t._intensity;
      } else {
        p.oy = 0;
      }
    }
    t._numShakes = t._numShakes - 1;
    if (t._numShakes <= 0) {
      p.ox = 0;
      p.oy = 0;
      destroy_task(t);
    }
  }
};

AnimTasks.REGISTRY.ShakeTargetBasedOnMovePowerOrDmg = AnimTasks.ShakeTargetBasedOnMovePowerOrDmg;
AnimTasks.REGISTRY.AnimTask_ShakeTargetBasedOnMovePowerOrDmg = AnimTasks.ShakeTargetBasedOnMovePowerOrDmg;

// pokefirered/src/battle_anim_fire.c:1254

// Lua: anim_tasks.lua:1338
//- RGB555 unpacker helper (pokefirered RGB_*)
function unpackRgb555(col: any): [number, number, number] {
  if (col != null && typeof col === "object") {
    const r = (col[1] ?? 0) > 1 ? (col[1] / 31) : (col[1] ?? 0);
    const g = (col[2] ?? 0) > 1 ? (col[2] / 31) : (col[2] ?? 0);
    const b = (col[3] ?? 0) > 1 ? (col[3] / 31) : (col[3] ?? 0);
    return [r, g, b];
  }
  const c = tonumber(col) ?? 0;
  const r = mod(c, 32) / 31;
  const g = mod(Math.floor(c / 32), 32) / 31;
  const b = mod(Math.floor(c / 1024), 32) / 31;
  return [r, g, b];
}

// Lua: anim_tasks.lua:1354
//- pret AnimTask_BlendBattleAnimPal (pokefirered/src/battle_anim_utility_funcs.c:53)
// arg 0: pal selector bitfield, arg 1: delay, arg 2: startCoeff, arg 3: targetCoeff, arg 4: color
AnimTasks.BlendBattleAnimPal = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const palMask = tonumber(t.data[0]) ?? 0;
    const delay = Math.max(0, tonumber(t.data[1]) ?? 0);
    const startCoeff = Math.max(0, Math.min(16, tonumber(t.data[2]) ?? 0));
    const targetCoeff = Math.max(0, Math.min(16, tonumber(t.data[3]) ?? 0));
    const color = t.data[4] ?? 0;
    const [r, g, b] = unpackRgb555(color);
    t._palMask = palMask;
    t._delay = delay;
    t._currCoeff = startCoeff;
    t._targetCoeff = targetCoeff;
    t._color = lseq(r, g, b);
    t._timer = 0;
  }

  if ((t._timer ?? 0) <= 0) {
    t._timer = t._delay;
    const coeff = t._currCoeff / 16;
    const r = t._color[1], g = t._color[2], b = t._color[3];
    const palMask = t._palMask;

    // Bit 0: Background
    if (mod(palMask, 2) === 1) {
      let fxType = "custom_blend";
      if (r === 1 && g === 1 && b === 1) fxType = "fade_white";
      else if (r === 0 && g === 0 && b === 0) fxType = "fade_black";
      if (coeff > 0) {
        Anim.setScreenEffect({ type: fxType, coeff: coeff, targetColor: lseq(r, g, b) });
      } else {
        Anim.setScreenEffect(null);
      }
    }

    // Battler palettes: bit 1 (atk), bit 2 (tgt), bit 7 (player), bit 9 (enemy)
    const atkPresent = Anim.present(vm.attackerSide());
    const tgtPresent = Anim.present(vm.targetSide());
    let isAtkSelected = (mod(Math.floor(palMask / 2), 2) === 1);
    let isTgtSelected = (mod(Math.floor(palMask / 4), 2) === 1);
    if (mod(Math.floor(palMask / 128), 2) === 1) { // player
      if (vm.attackerSide() === "player") isAtkSelected = true; else isTgtSelected = true;
    }
    if (mod(Math.floor(palMask / 512), 2) === 1) { // enemy
      if (vm.attackerSide() === "enemy") isAtkSelected = true; else isTgtSelected = true;
    }

    if (isAtkSelected && atkPresent) {
      atkPresent.blendColor = lseq(r, g, b);
      atkPresent.blendCoeff = coeff;
      atkPresent.darken = (r === 0 && g === 0 && b === 0) ? coeff : 0;
      atkPresent.flash = (r === 1 && g === 1 && b === 1) ? (coeff > 0 ? 1 : 0) : 0;
    }
    if (isTgtSelected && tgtPresent) {
      tgtPresent.blendColor = lseq(r, g, b);
      tgtPresent.blendCoeff = coeff;
      tgtPresent.darken = (r === 0 && g === 0 && b === 0) ? coeff : 0;
      tgtPresent.flash = (r === 1 && g === 1 && b === 1) ? (coeff > 0 ? 1 : 0) : 0;
    }

    const finished = (t._currCoeff === t._targetCoeff);
    if (t._currCoeff < t._targetCoeff) {
      t._currCoeff = t._currCoeff + 1;
    } else if (t._currCoeff > t._targetCoeff) {
      t._currCoeff = t._currCoeff - 1;
    }

    if (finished) {
      if (t._targetCoeff === 0) {
        if (mod(palMask, 2) === 1) Anim.setScreenEffect(null);
        if (isAtkSelected && atkPresent) {
          atkPresent.blendCoeff = 0;
          atkPresent.darken = 0;
          atkPresent.flash = 0;
        }
        if (isTgtSelected && tgtPresent) {
          tgtPresent.blendCoeff = 0;
          tgtPresent.darken = 0;
          tgtPresent.flash = 0;
        }
      }
      destroy_task(t);
    }
  } else {
    t._timer = t._timer - 1;
  }
};

AnimTasks.REGISTRY.BlendBattleAnimPal = AnimTasks.BlendBattleAnimPal;
AnimTasks.REGISTRY.AnimTask_BlendBattleAnimPal = AnimTasks.BlendBattleAnimPal;

// Lua: anim_tasks.lua:1448
//- pret AnimTask_BlendColorCycle / BlendColorCycleExclude / BlendColorCycleByTag (pokefirered/src/battle_anim_normal.c:424, 484, 559)
// arg 0: pal selector, arg 1: delay, arg 2: numBlends, arg 3: initialBlend, arg 4: targetBlend, arg 5: color
AnimTasks.BlendColorCycle = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const palMask = tonumber(t.data[0]) ?? 0;
    const delay = Math.max(0, tonumber(t.data[1]) ?? 0);
    const numBlends = Math.max(1, tonumber(t.data[2]) ?? 1);
    const initialBlend = tonumber(t.data[3]) ?? 0;
    const targetBlend = tonumber(t.data[4]) ?? 16;
    const color = t.data[5] ?? 0;
    const [r, g, b] = unpackRgb555(color);
    t._palMask = palMask;
    t._delay = delay;
    t._numBlends = numBlends;
    t._initialBlend = initialBlend;
    t._targetBlend = targetBlend;
    t._color = lseq(r, g, b);
    t._currCoeff = initialBlend;
    t._targetCoeff = targetBlend;
    t._timer = 0;
    t._restore = false;
  }

  if ((t._timer ?? 0) <= 0) {
    t._timer = t._delay;
    const coeff = t._currCoeff / 16;
    const r = t._color[1], g = t._color[2], b = t._color[3];
    const palMask = t._palMask;

    // Screen / BG
    if (mod(palMask, 2) === 1) {
      let fxType = "custom_blend";
      if (r === 1 && g === 1 && b === 1) fxType = "fade_white";
      else if (r === 0 && g === 0 && b === 0) fxType = "fade_black";
      if (coeff > 0) {
        Anim.setScreenEffect({ type: fxType, coeff: coeff, targetColor: lseq(r, g, b) });
      } else {
        Anim.setScreenEffect(null);
      }
    }

    // Battlers
    const atkPresent = Anim.present(vm.attackerSide());
    const tgtPresent = Anim.present(vm.targetSide());
    const isAtkSelected = (mod(Math.floor(palMask / 2), 2) === 1);
    const isTgtSelected = (mod(Math.floor(palMask / 4), 2) === 1);
    if (isAtkSelected && atkPresent) {
      atkPresent.blendColor = lseq(r, g, b);
      atkPresent.blendCoeff = coeff;
      atkPresent.darken = (r === 0 && g === 0 && b === 0) ? coeff : 0;
      atkPresent.flash = (r === 1 && g === 1 && b === 1) ? (coeff > 0 ? 1 : 0) : 0;
    }
    if (isTgtSelected && tgtPresent) {
      tgtPresent.blendColor = lseq(r, g, b);
      tgtPresent.blendCoeff = coeff;
      tgtPresent.darken = (r === 0 && g === 0 && b === 0) ? coeff : 0;
      tgtPresent.flash = (r === 1 && g === 1 && b === 1) ? (coeff > 0 ? 1 : 0) : 0;
    }

    if (t._currCoeff < t._targetCoeff) {
      t._currCoeff = t._currCoeff + 1;
    } else if (t._currCoeff > t._targetCoeff) {
      t._currCoeff = t._currCoeff - 1;
    } else {
      t._numBlends = t._numBlends - 1;
      if (t._numBlends > 0) {
        t._restore = !t._restore;
        if (t._restore) {
          t._targetCoeff = (t._numBlends === 1) ? 0 : t._initialBlend;
        } else {
          t._targetCoeff = t._targetBlend;
        }
      } else {
        if (mod(palMask, 2) === 1) Anim.setScreenEffect(null);
        if (isAtkSelected && atkPresent) {
          atkPresent.blendCoeff = 0;
          atkPresent.darken = 0;
          atkPresent.flash = 0;
        }
        if (isTgtSelected && tgtPresent) {
          tgtPresent.blendCoeff = 0;
          tgtPresent.darken = 0;
          tgtPresent.flash = 0;
        }
        destroy_task(t);
      }
    }
  } else {
    t._timer = t._timer - 1;
  }
};

AnimTasks.REGISTRY.BlendColorCycle = AnimTasks.BlendColorCycle;
AnimTasks.REGISTRY.AnimTask_BlendColorCycle = AnimTasks.BlendColorCycle;
AnimTasks.REGISTRY.BlendColorCycleExclude = AnimTasks.BlendColorCycle;
AnimTasks.REGISTRY.AnimTask_BlendColorCycleExclude = AnimTasks.BlendColorCycle;
AnimTasks.REGISTRY.BlendColorCycleByTag = AnimTasks.BlendColorCycle;
AnimTasks.REGISTRY.AnimTask_BlendColorCycleByTag = AnimTasks.BlendColorCycle;

// Lua: anim_tasks.lua:1549
//- pret AnimComplexPaletteBlend (pokefirered/src/battle_anim_normal.c:339)
// arg 0: palMask, arg 1: delay, arg 2: numCycles, arg 3: color1, arg 4: coeff1, arg 5: color2, arg 6: coeff2
AnimTasks.ComplexPaletteBlend = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const palMask = tonumber(t.data[0]) ?? 0;
    const delay = Math.max(1, tonumber(t.data[1]) ?? 1);
    const numCycles = Math.max(1, tonumber(t.data[2]) ?? 1);
    const color1 = t.data[3] ?? 0;
    const coeff1 = (tonumber(t.data[4]) ?? 16) / 16;
    const color2 = t.data[5] ?? 0;
    const coeff2 = (tonumber(t.data[6]) ?? 0) / 16;
    const [r1, g1, b1] = unpackRgb555(color1);
    const [r2, g2, b2] = unpackRgb555(color2);
    t._palMask = palMask;
    t._delay = delay;
    t._cyclesLeft = numCycles;
    t._c1 = lseq(r1, g1, b1);
    t._k1 = coeff1;
    t._c2 = lseq(r2, g2, b2);
    t._k2 = coeff2;
    t._phase = 0;
    t._timer = delay;

    // Initial blend 1
    const isAtk = (mod(Math.floor(palMask / 2), 2) === 1);
    const isTgt = (mod(Math.floor(palMask / 4), 2) === 1);
    const atkP = Anim.present(vm.attackerSide());
    const tgtP = Anim.present(vm.targetSide());
    if (isAtk && atkP) {
      atkP.blendColor = t._c1;
      atkP.blendCoeff = t._k1;
      atkP.darken = (r1 === 0 && g1 === 0 && b1 === 0) ? t._k1 : 0;
      atkP.flash = (r1 === 1 && g1 === 1 && b1 === 1) ? (t._k1 > 0 ? 1 : 0) : 0;
    }
    if (isTgt && tgtP) {
      tgtP.blendColor = t._c1;
      tgtP.blendCoeff = t._k1;
      tgtP.darken = (r1 === 0 && g1 === 0 && b1 === 0) ? t._k1 : 0;
      tgtP.flash = (r1 === 1 && g1 === 1 && b1 === 1) ? (t._k1 > 0 ? 1 : 0) : 0;
    }
  }

  t._timer = t._timer - 1;
  if (t._timer <= 0) {
    t._timer = t._delay;
    if (t._cyclesLeft <= 0) {
      const palMask = t._palMask;
      const isAtk = (mod(Math.floor(palMask / 2), 2) === 1);
      const isTgt = (mod(Math.floor(palMask / 4), 2) === 1);
      const atkP = Anim.present(vm.attackerSide());
      const tgtP = Anim.present(vm.targetSide());
      if (mod(palMask, 2) === 1) Anim.setScreenEffect(null);
      if (isAtk && atkP) { atkP.blendCoeff = 0; atkP.darken = 0; atkP.flash = 0; }
      if (isTgt && tgtP) { tgtP.blendCoeff = 0; tgtP.darken = 0; tgtP.flash = 0; }
      destroy_task(t);
    } else {
      t._phase = 1 - t._phase;
      const c = (t._phase === 0) ? t._c1 : t._c2;
      const k = (t._phase === 0) ? t._k1 : t._k2;
      const palMask = t._palMask;
      const isAtk = (mod(Math.floor(palMask / 2), 2) === 1);
      const isTgt = (mod(Math.floor(palMask / 4), 2) === 1);
      const atkP = Anim.present(vm.attackerSide());
      const tgtP = Anim.present(vm.targetSide());
      if (isAtk && atkP) {
        atkP.blendColor = c;
        atkP.blendCoeff = k;
        atkP.darken = (c[1] === 0 && c[2] === 0 && c[3] === 0) ? k : 0;
        atkP.flash = (c[1] === 1 && c[2] === 1 && c[3] === 1) ? (k > 0 ? 1 : 0) : 0;
      }
      if (isTgt && tgtP) {
        tgtP.blendColor = c;
        tgtP.blendCoeff = k;
        tgtP.darken = (c[1] === 0 && c[2] === 0 && c[3] === 0) ? k : 0;
        tgtP.flash = (c[1] === 1 && c[2] === 1 && c[3] === 1) ? (k > 0 ? 1 : 0) : 0;
      }
      t._cyclesLeft = t._cyclesLeft - 1;
    }
  }
};

AnimTasks.REGISTRY.ComplexPaletteBlend = AnimTasks.ComplexPaletteBlend;
AnimTasks.REGISTRY.AnimComplexPaletteBlend = AnimTasks.ComplexPaletteBlend;

// Lua: anim_tasks.lua:1634
//- pret AnimTask_BlendBattleAnimPalExclude (pokefirered/src/battle_anim_utility_funcs.c:75)
AnimTasks.BlendBattleAnimPalExclude = function (t: AnimTask, vm: any): void {
  const cmd = tonumber(t.data[0]) ?? 0;
  // Map exclude cmd to palMask:
  // 0: Not attacker (blend target and BG -> bit 0 | bit 2 = 5)
  // 1: Not target (blend attacker and BG -> bit 0 | bit 1 = 3)
  // 2: Not attacker nor BG (blend target only -> bit 2 = 4)
  // 3: Not target nor BG (blend attacker only -> bit 1 = 2)
  // 4: Neither attacker nor target (blend BG only -> bit 0 = 1)
  // 5: Blend all (bit 0 | bit 1 | bit 2 = 7)
  // 6: Neither bg nor attacker partner (blend target = 4)
  // 7: Neither bg nor target partner (blend attacker = 2)
  const maskMap: number[] = [5, 3, 4, 2, 1, 7, 4, 2];
  const palMask = maskMap[cmd] ?? 7;
  t.data[0] = palMask;
  AnimTasks.BlendBattleAnimPal(t, vm);
};

AnimTasks.REGISTRY.BlendBattleAnimPalExclude = AnimTasks.BlendBattleAnimPalExclude;
AnimTasks.REGISTRY.AnimTask_BlendBattleAnimPalExclude = AnimTasks.BlendBattleAnimPalExclude;

// Lua: anim_tasks.lua:1655
//- pret AnimTask_SetCamouflageBlend (pokefirered/src/battle_anim_utility_funcs.c:123)
AnimTasks.SetCamouflageBlend = function (t: AnimTask, vm: any): void {
  const TERRAIN_COLORS = {
    grass: 0x0718,       // RGB(12, 24, 2)
    long_grass: 0x05E0,  // RGB(0, 15, 2)
    sand: 0x2F1E,        // RGB(30, 24, 11)
    water: 0x7ECA,       // RGB(11, 22, 31)
    cave: 0x0D2E,        // RGB(14, 9, 3)
    building: 0x7FFF,    // RGB(31, 31, 31)
    plain: 0x7FFF,       // RGB(31, 31, 31)
  };
  t.data[4] = TERRAIN_COLORS.plain;
  AnimTasks.BlendBattleAnimPal(t, vm);
};

AnimTasks.REGISTRY.SetCamouflageBlend = AnimTasks.SetCamouflageBlend;
AnimTasks.REGISTRY.AnimTask_SetCamouflageBlend = AnimTasks.SetCamouflageBlend;

// Lua: anim_tasks.lua:1673
//- pret AnimTask_BlendParticle (pokefirered/src/battle_anim_utility_funcs.c:163)
AnimTasks.BlendParticle = function (t: AnimTask, vm: any): void {
  t.data[0] = 1; // BG / particle palette
  AnimTasks.BlendBattleAnimPal(t, vm);
};

AnimTasks.REGISTRY.BlendParticle = AnimTasks.BlendParticle;
AnimTasks.REGISTRY.AnimTask_BlendParticle = AnimTasks.BlendParticle;

// Lua: anim_tasks.lua:1683
//- pret AnimTask_BlendMonInAndOut (pokefirered/src/battle_anim_mons.c:1603)
// arg 0: battler, arg 1: color, arg 2: targetCoeff, arg 3: delay, arg 4: repeats
AnimTasks.BlendMonInAndOut = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const whichMon = t.data[0] ?? 0;
    const color = t.data[1] ?? 0;
    const targetCoeff = tonumber(t.data[2]) ?? 16;
    const delay = Math.max(0, tonumber(t.data[3]) ?? 0);
    const repeats = Math.max(1, tonumber(t.data[4]) ?? 1);
    const [r, g, b] = unpackRgb555(color);
    const side = vm.resolveBattlerSide(whichMon);
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._targetCoeff = targetCoeff;
    t._delay = delay;
    t._repeats = repeats;
    t._color = lseq(r, g, b);
    t._currCoeff = 0;
    t._dir = 0; // 0=in, 1=out
    t._timer = 0;
  }

  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }

  if ((t._timer ?? 0) <= 0) {
    t._timer = t._delay;
    const r = t._color[1], g = t._color[2], b = t._color[3];
    const coeff = t._currCoeff / 16;
    p.blendColor = lseq(r, g, b);
    p.blendCoeff = coeff;
    p.darken = (r === 0 && g === 0 && b === 0) ? coeff : 0;
    p.flash = (r === 1 && g === 1 && b === 1) ? (coeff > 0 ? 1 : 0) : 0;

    if (t._dir === 0) {
      t._currCoeff = t._currCoeff + 1;
      if (t._currCoeff >= t._targetCoeff) {
        t._dir = 1;
      }
    } else {
      t._currCoeff = t._currCoeff - 1;
      if (t._currCoeff <= 0) {
        t._repeats = t._repeats - 1;
        if (t._repeats > 0) {
          t._dir = 0;
        } else {
          p.blendCoeff = 0;
          p.darken = 0;
          p.flash = 0;
          destroy_task(t);
        }
      }
    }
  } else {
    t._timer = t._timer - 1;
  }
};

AnimTasks.REGISTRY.BlendMonInAndOut = AnimTasks.BlendMonInAndOut;
AnimTasks.REGISTRY.AnimTask_BlendMonInAndOut = AnimTasks.BlendMonInAndOut;
AnimTasks.REGISTRY.BlendPalInAndOutByTag = AnimTasks.BlendMonInAndOut;
AnimTasks.REGISTRY.AnimTask_BlendPalInAndOutByTag = AnimTasks.BlendMonInAndOut;
AnimTasks.REGISTRY.MetallicShine = AnimTasks.BlendMonInAndOut;
AnimTasks.REGISTRY.AnimTask_MetallicShine = AnimTasks.BlendMonInAndOut;

// Lua: anim_tasks.lua:1757
//- pret AnimTask_TraceMonBlended (pokefirered/src/battle_anim_utility_funcs.c:230)
// arg 0: battler, arg 1: interval, arg 2: lifetime, arg 3: count
AnimTasks.TraceMonBlended = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const whichMon = t.data[0] ?? 0;
    const interval = Math.max(1, tonumber(t.data[1]) ?? 1);
    const lifetime = Math.max(1, tonumber(t.data[2]) ?? 5);
    const count = Math.max(1, tonumber(t.data[3]) ?? 3);
    const side = vm.resolveBattlerSide(whichMon);
    t._side = side;
    t._interval = interval;
    t._lifetime = lifetime;
    t._count = count;
    t._timer = 0;
    t._activeAfterimages = 0;
  }

  if (t._count > 0) {
    if ((t._timer ?? 0) <= 0) {
      t._timer = t._interval;
      t._count = t._count - 1;
      const [cx, cy] = Anim.battlerCenter(t._side);
      const pres = Anim.present(t._side);
      const s = AnimSprites.acquire({
        x: cx,
        y: cy,
        z: ((pres && pres.z != null) ? pres.z : 100) - 5,
        alpha: 0.5,
        priority: 1,
        callback: function (sprite: any): void {
          sprite.data[0] = (sprite.data[0] ?? 0) + 1;
          if (sprite.data[0] >= t._lifetime) {
            t._activeAfterimages = Math.max(0, t._activeAfterimages - 1);
            AnimSprites.release(sprite);
          }
        },
      });
      if (s) {
        t._activeAfterimages = t._activeAfterimages + 1;
      }
    } else {
      t._timer = t._timer - 1;
    }
  } else if (t._activeAfterimages <= 0) {
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.TraceMonBlended = AnimTasks.TraceMonBlended;
AnimTasks.REGISTRY.AnimTask_TraceMonBlended = AnimTasks.TraceMonBlended;

// Lua: anim_tasks.lua:1810
//- pret AnimTask_AttackerFadeToInvisible / AttackerFadeFromInvisible (pokefirered/src/battle_anim_dark.c:187, 226)
AnimTasks.AttackerFadeToInvisible = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const delay = Math.max(0, tonumber(t.data[0]) ?? 0);
    const side = vm.attackerSide();
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._delay = delay;
    t._timer = delay;
    t._step = 0;
  }

  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }

  if ((t._timer ?? 0) <= 0) {
    t._timer = t._delay;
    t._step = t._step + 1;
    p.alpha = Math.max(0, 1 - (t._step / 16));
    if (t._step >= 16) {
      p.alpha = 0;
      p.visible = false;
      destroy_task(t);
    }
  } else {
    t._timer = t._timer - 1;
  }
};

AnimTasks.REGISTRY.AttackerFadeToInvisible = AnimTasks.AttackerFadeToInvisible;
AnimTasks.REGISTRY.AnimTask_AttackerFadeToInvisible = AnimTasks.AttackerFadeToInvisible;

// Lua: anim_tasks.lua:1850
AnimTasks.AttackerFadeFromInvisible = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const delay = Math.max(0, tonumber(t.data[0]) ?? 0);
    const side = vm.attackerSide();
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    const p0 = t._p;
    p0.visible = true;
    t._delay = delay;
    t._timer = delay;
    t._step = 0;
  }

  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }

  if ((t._timer ?? 0) <= 0) {
    t._timer = t._delay;
    t._step = t._step + 1;
    p.alpha = Math.min(1, t._step / 16);
    if (t._step >= 16) {
      p.alpha = 1;
      destroy_task(t);
    }
  } else {
    t._timer = t._timer - 1;
  }
};

AnimTasks.REGISTRY.AttackerFadeFromInvisible = AnimTasks.AttackerFadeFromInvisible;
AnimTasks.REGISTRY.AnimTask_AttackerFadeFromInvisible = AnimTasks.AttackerFadeFromInvisible;

// Lua: anim_tasks.lua:1892
//- pret AnimTask_HardwarePaletteFade (pokefirered/src/battle_anim_utility_funcs.c:213)
AnimTasks.HardwarePaletteFade = function (t: AnimTask, vm: any): void {
  // arg 0: selectedPalettes, arg 1: delay, arg 2: startCoeff, arg 3: endCoeff, arg 4: color
  AnimTasks.BlendBattleAnimPal(t, vm);
};

AnimTasks.REGISTRY.HardwarePaletteFade = AnimTasks.HardwarePaletteFade;
AnimTasks.REGISTRY.AnimTask_HardwarePaletteFade = AnimTasks.HardwarePaletteFade;

//- pret AnimSimplePaletteBlend (pokefirered/src/battle_anim_normal.c:302)
// arg 0: selectedPalettes, arg 1: delay, arg 2: startCoeff, arg 3: endCoeff, arg 4: color
AnimTasks.REGISTRY.SimplePaletteBlend = AnimTasks.BlendBattleAnimPal;
AnimTasks.REGISTRY.AnimSimplePaletteBlend = AnimTasks.BlendBattleAnimPal;
AnimTasks.REGISTRY.ComplexPaletteBlend = AnimTasks.ComplexPaletteBlend;
AnimTasks.REGISTRY.AnimComplexPaletteBlend = AnimTasks.ComplexPaletteBlend;

// Lua: anim_tasks.lua:1908
//- pret AnimTask_Flash (pokefirered/src/battle_anim_utility_funcs.c:583)
AnimTasks.Flash = function (t: AnimTask, _vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const palMask = tonumber(t.data[0]) ?? 1;
    const delay = Math.max(0, tonumber(t.data[1]) ?? 1);
    const numFlashes = Math.max(1, tonumber(t.data[2]) ?? 1);
    const color = t.data[3] ?? 0x7FFF;
    const [r, g, b] = unpackRgb555(color);
    t._palMask = palMask;
    t._delay = delay;
    t._numFlashes = numFlashes;
    t._color = lseq(r, g, b);
    t._timer = 0;
    t._state = 0;
  }

  if ((t._timer ?? 0) <= 0) {
    t._timer = t._delay;
    t._state = 1 - t._state;
    const coeff = (t._state === 1) ? 1 : 0;
    const r = t._color[1], g = t._color[2], b = t._color[3];
    if (mod(t._palMask, 2) === 1) {
      if (coeff > 0) {
        Anim.setScreenEffect({ type: (r === 1 && g === 1 && b === 1) ? "fade_white" : "fade_black", coeff: coeff, targetColor: lseq(r, g, b) });
      } else {
        Anim.setScreenEffect(null);
      }
    }
    if (t._state === 0) {
      t._numFlashes = t._numFlashes - 1;
      if (t._numFlashes <= 0) {
        Anim.setScreenEffect(null);
        destroy_task(t);
      }
    }
  } else {
    t._timer = t._timer - 1;
  }
};

AnimTasks.REGISTRY.Flash = AnimTasks.Flash;
AnimTasks.REGISTRY.AnimTask_Flash = AnimTasks.Flash;

// Lua: anim_tasks.lua:1953
//- pret AnimTask_BlendNonAttackerPalettes (pokefirered/src/battle_anim_utility_funcs.c:652)
AnimTasks.BlendNonAttackerPalettes = function (t: AnimTask, vm: any): void {
  t.data[0] = 5; // target & BG
  AnimTasks.BlendBattleAnimPal(t, vm);
};

AnimTasks.REGISTRY.BlendNonAttackerPalettes = AnimTasks.BlendNonAttackerPalettes;
AnimTasks.REGISTRY.AnimTask_BlendNonAttackerPalettes = AnimTasks.BlendNonAttackerPalettes;

//- pret AnimTask_FacadeColorBlend (pokefirered/src/battle_anim_effects_3.c:3802)
const FACADE_COLORS = lseq(
  0x76FF, 0x6EBE, 0x667D, 0x5E3C, 0x55FB, 0x4D9A, 0x4559, 0x3D18,
  0x34D7, 0x2C96, 0x2455, 0x1C14, 0x13D3, 0x0B92, 0x0351, 0x0BD2,
  0x1433, 0x1C94, 0x24F5, 0x2D56, 0x35B7, 0x3E18, 0x4679, 0x4ED9,
);

// Lua: anim_tasks.lua:1968
AnimTasks.FacadeColorBlend = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const whichMon = t.data[0] ?? 0;
    const duration = Math.max(1, tonumber(t.data[1]) ?? 24);
    const side = vm.resolveBattlerSide(whichMon);
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._duration = duration;
    t._colorIdx = 1;
    t._timer = duration;
  }

  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }

  if (t._timer > 0) {
    const c = FACADE_COLORS[t._colorIdx] ?? 0;
    const [r, g, b] = unpackRgb555(c);
    p.blendColor = lseq(r, g, b);
    p.blendCoeff = 0.5;
    t._colorIdx = mod(t._colorIdx, len(FACADE_COLORS)) + 1;
    t._timer = t._timer - 1;
  } else {
    p.blendCoeff = 0;
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.FacadeColorBlend = AnimTasks.FacadeColorBlend;
AnimTasks.REGISTRY.AnimTask_FacadeColorBlend = AnimTasks.FacadeColorBlend;

//- pret AnimTask_CycleMagicalLeafPal (pokefirered/src/battle_anim_effects_1.c:3668)
const MAGICAL_LEAF_COLORS = lseq(
  0x001F, 0x03E0, 0x7C00, 0x03FF, 0x7C1F, 0x7FE0, 0x7FFF,
);

// Lua: anim_tasks.lua:2013
AnimTasks.CycleMagicalLeafPal = function (t: AnimTask, _vm: any): void {
  if (!t._inited) {
    t._inited = true;
    t._colorIdx = 1;
    t._coeff = 0;
    t._timer = 0;
  }

  t._coeff = t._coeff + 1;
  if (t._coeff >= 17) {
    t._coeff = 0;
    t._colorIdx = mod(t._colorIdx, len(MAGICAL_LEAF_COLORS)) + 1;
  }

  if (tonumber(t.data[7]) === -1) {
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.CycleMagicalLeafPal = AnimTasks.CycleMagicalLeafPal;
AnimTasks.REGISTRY.AnimTask_CycleMagicalLeafPal = AnimTasks.CycleMagicalLeafPal;

// Lua: anim_tasks.lua:2036
//- pret AnimTask_AcidArmor (pokefirered/src/battle_anim_effects_3.c:3222)
AnimTasks.AcidArmor = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const whichMon = t.data[0] ?? 0;
    const side = vm.resolveBattlerSide(whichMon);
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._step = 0;
    t._timer = 0;
    t._wave = 0;
  }

  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }

  t._wave = mod(t._wave + 16, 256);
  p.ox = Sin(t._wave, 4);

  if (t._step === 0) {
    t._timer = t._timer + 1;
    p.alpha = Math.max(0, 1 - (t._timer / 32));
    if (t._timer >= 32) {
      t._step = 1;
      t._timer = 0;
    }
  } else if (t._step === 1) {
    t._timer = t._timer + 1;
    if (t._timer >= 16) {
      t._step = 2;
      t._timer = 0;
    }
  } else if (t._step === 2) {
    t._timer = t._timer + 1;
    p.alpha = Math.min(1, t._timer / 32);
    if (t._timer >= 32) {
      p.ox = 0;
      p.alpha = 1;
      destroy_task(t);
    }
  }
};

AnimTasks.REGISTRY.AcidArmor = AnimTasks.AcidArmor;
AnimTasks.REGISTRY.AnimTask_AcidArmor = AnimTasks.AcidArmor;

// Lua: anim_tasks.lua:2090
//- pret AnimTask_TransformMon (pokefirered/src/battle_anim_effects_3.c:2223)
AnimTasks.TransformMon = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const side = vm.attackerSide();
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._timer = 0;
  }

  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }

  t._timer = t._timer + 1;
  if (t._timer < 20) {
    p.flash = (mod(t._timer, 4) < 2) ? 1 : 0;
    p.sx = 1 + Sin(t._timer * 12, 32) / 256;
    p.sy = 1 - Sin(t._timer * 12, 32) / 256;
  } else {
    p.flash = 0;
    p.sx = 1;
    p.sy = 1;
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.TransformMon = AnimTasks.TransformMon;
AnimTasks.REGISTRY.AnimTask_TransformMon = AnimTasks.TransformMon;

// Lua: anim_tasks.lua:2127
//- General Battler Affine Animation Tables & Engine (pokefirered/src/battle_anim_mons.c:1677, 1690)
// (A command list is a sequence that may also carry a `loop` key, like Brian's mixed tables.)
interface AffineCmd { dx: number; dy: number; dr: number; dur: number }
type AffineCmds = (AffineCmd | null)[] & { loop?: number };
const AFFINE_COMMANDS: Record<string, AffineCmds> = {
  DefenseCurl: Object.assign(lseq<AffineCmd>(
    { dx: -12, dy: 20, dr: 0, dur: 8 },
    { dx: 12, dy: -20, dr: 0, dur: 8 },
  ), { loop: 2 }),
  Stockpile: Object.assign(lseq<AffineCmd>(
    { dx: 8, dy: -8, dr: 0, dur: 12 },
    { dx: -16, dy: 16, dr: 0, dur: 12 },
    { dx: 8, dy: -8, dr: 0, dur: 12 },
  ), { loop: 1 }),
  SpitUp: lseq<AffineCmd>(
    { dx: 0, dy: 6, dr: 0, dur: 20 },
    { dx: 0, dy: 0, dr: 0, dur: 20 },
    { dx: 0, dy: -18, dr: 0, dur: 6 },
    { dx: -18, dy: -18, dr: 0, dur: 3 },
    { dx: 0, dy: 0, dr: 0, dur: 15 },
    { dx: 4, dy: 4, dr: 0, dur: 13 },
  ),
  Swallow: lseq<AffineCmd>(
    { dx: 0, dy: 6, dr: 0, dur: 20 },
    { dx: 0, dy: 0, dr: 0, dur: 20 },
    { dx: 7, dy: -30, dr: 0, dur: 6 },
    { dx: 0, dy: 0, dr: 0, dur: 20 },
    { dx: -2, dy: 3, dr: 0, dur: 20 },
  ),
  StretchBattlerUp: lseq<AffineCmd>(
    { dx: 10, dy: -13, dr: 0, dur: 10 },
    { dx: -10, dy: 13, dr: 0, dur: 10 },
  ),
  GrowAndShrink: lseq<AffineCmd>(
    { dx: 4, dy: 4, dr: 0, dur: 16 },
    { dx: 0, dy: 0, dr: 0, dur: 32 },
    { dx: -4, dy: -4, dr: 0, dur: 16 },
  ),
  ThrashMoveMon: Object.assign(lseq<AffineCmd>(
    { dx: 8, dy: -8, dr: 0, dur: 4 },
    { dx: -16, dy: 16, dr: 0, dur: 8 },
    { dx: 8, dy: -8, dr: 0, dur: 4 },
  ), { loop: 2 }),
  MeditateStretch: Object.assign(lseq<AffineCmd>(
    { dx: 0, dy: 6, dr: 0, dur: 16 },
    { dx: 0, dy: -6, dr: 0, dur: 16 },
  ), { loop: 2 }),
  SlackOffSquish: lseq<AffineCmd>(
    { dx: -4, dy: 8, dr: 0, dur: 8 },
    { dx: 4, dy: -8, dr: 0, dur: 8 },
  ),
  SmellingSaltsSquish: lseq<AffineCmd>(
    { dx: 10, dy: -10, dr: 0, dur: 6 },
    { dx: -10, dy: 10, dr: 0, dur: 6 },
  ),
  FacadeSquish: lseq<AffineCmd>(
    { dx: 8, dy: -8, dr: 0, dur: 4 },
    { dx: -16, dy: 16, dr: 0, dur: 8 },
    { dx: 8, dy: -8, dr: 0, dur: 4 },
  ),
  Uproar: Object.assign(lseq<AffineCmd>(
    { dx: 12, dy: -12, dr: 0, dur: 4 },
    { dx: -24, dy: 24, dr: 0, dur: 8 },
    { dx: 12, dy: -12, dr: 0, dur: 4 },
  ), { loop: 3 }),
};

// Lua: anim_tasks.lua:2195
function stepAffineAnim(task: AnimTask, p: any, cmds: AffineCmds): boolean {
  if (!task._affineInited) {
    task._affineInited = true;
    task._affineCmdIdx = 1;
    task._affineFrameTimer = 0;
    task._affineLoopCount = cmds.loop ?? 0;
    task._affineScaleX = 256;
    task._affineScaleY = 256;
    task._affineRot = 0;
  }

  const cmd = cmds[task._affineCmdIdx];
  if (!cmd) {
    p.sx = 1;
    p.sy = 1;
    p.rotation = 0;
    p.oy = 0;
    return false;
  }

  task._affineScaleX = task._affineScaleX + (cmd.dx ?? 0);
  task._affineScaleY = task._affineScaleY + (cmd.dy ?? 0);
  task._affineRot = mod(task._affineRot + (cmd.dr ?? 0), 65536);

  p.sx = 256 / Math.max(1, task._affineScaleX);
  p.sy = 256 / Math.max(1, task._affineScaleY);
  p.rotation = (task._affineRot / 256) * (2 * Math.PI);
  p.oy = Math.floor((64 - (64 * 256 / Math.max(1, task._affineScaleY))) / 2);

  task._affineFrameTimer = task._affineFrameTimer + 1;
  if (task._affineFrameTimer >= (cmd.dur ?? 1)) {
    task._affineFrameTimer = 0;
    task._affineCmdIdx = task._affineCmdIdx + 1;
    if (task._affineCmdIdx > len(cmds)) {
      if (task._affineLoopCount > 0) {
        task._affineLoopCount = task._affineLoopCount - 1;
        task._affineCmdIdx = 1;
      } else {
        p.sx = 1;
        p.sy = 1;
        p.rotation = 0;
        p.oy = 0;
        return false;
      }
    }
  }
  return true;
}

// Lua: anim_tasks.lua:2244
function runBattlerAffineTask(t: AnimTask, _vm: any, side: unknown, cmds: AffineCmds): void {
  if (!t._p) {
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
  }
  if (!stepAffineAnim(t, t._p, cmds)) {
    destroy_task(t);
  }
}

//- Affine Command Task Handlers
// Lua: anim_tasks.lua:2259
AnimTasks.DefenseCurlDeformMon = function (t: AnimTask, vm: any): void { runBattlerAffineTask(t, vm, vm.attackerSide(), AFFINE_COMMANDS.DefenseCurl!); };
AnimTasks.REGISTRY.DefenseCurlDeformMon = AnimTasks.DefenseCurlDeformMon;
AnimTasks.REGISTRY.AnimTask_DefenseCurlDeformMon = AnimTasks.DefenseCurlDeformMon;

// Lua: anim_tasks.lua:2263
AnimTasks.StockpileDeformMon = function (t: AnimTask, vm: any): void { runBattlerAffineTask(t, vm, vm.attackerSide(), AFFINE_COMMANDS.Stockpile!); };
AnimTasks.REGISTRY.StockpileDeformMon = AnimTasks.StockpileDeformMon;
AnimTasks.REGISTRY.AnimTask_StockpileDeformMon = AnimTasks.StockpileDeformMon;

// Lua: anim_tasks.lua:2267
AnimTasks.SpitUpDeformMon = function (t: AnimTask, vm: any): void { runBattlerAffineTask(t, vm, vm.attackerSide(), AFFINE_COMMANDS.SpitUp!); };
AnimTasks.REGISTRY.SpitUpDeformMon = AnimTasks.SpitUpDeformMon;
AnimTasks.REGISTRY.AnimTask_SpitUpDeformMon = AnimTasks.SpitUpDeformMon;

// Lua: anim_tasks.lua:2271
AnimTasks.SwallowDeformMon = function (t: AnimTask, vm: any): void { runBattlerAffineTask(t, vm, vm.attackerSide(), AFFINE_COMMANDS.Swallow!); };
AnimTasks.REGISTRY.SwallowDeformMon = AnimTasks.SwallowDeformMon;
AnimTasks.REGISTRY.AnimTask_SwallowDeformMon = AnimTasks.SwallowDeformMon;

// Lua: anim_tasks.lua:2275
AnimTasks.StretchTargetUp = function (t: AnimTask, vm: any): void { runBattlerAffineTask(t, vm, vm.targetSide(), AFFINE_COMMANDS.StretchBattlerUp!); };
AnimTasks.REGISTRY.StretchTargetUp = AnimTasks.StretchTargetUp;
AnimTasks.REGISTRY.AnimTask_StretchTargetUp = AnimTasks.StretchTargetUp;

// Lua: anim_tasks.lua:2279
AnimTasks.StretchAttackerUp = function (t: AnimTask, vm: any): void { runBattlerAffineTask(t, vm, vm.attackerSide(), AFFINE_COMMANDS.StretchBattlerUp!); };
AnimTasks.REGISTRY.StretchAttackerUp = AnimTasks.StretchAttackerUp;
AnimTasks.REGISTRY.AnimTask_StretchAttackerUp = AnimTasks.StretchAttackerUp;

// Lua: anim_tasks.lua:2283
AnimTasks.GrowAndShrink = function (t: AnimTask, vm: any): void { runBattlerAffineTask(t, vm, vm.attackerSide(), AFFINE_COMMANDS.GrowAndShrink!); };
AnimTasks.REGISTRY.GrowAndShrink = AnimTasks.GrowAndShrink;
AnimTasks.REGISTRY.AnimTask_GrowAndShrink = AnimTasks.GrowAndShrink;

// Lua: anim_tasks.lua:2287
AnimTasks.ThrashMoveMon = function (t: AnimTask, vm: any): void { runBattlerAffineTask(t, vm, vm.attackerSide(), AFFINE_COMMANDS.ThrashMoveMon!); };
AnimTasks.REGISTRY.ThrashMoveMon = AnimTasks.ThrashMoveMon;
AnimTasks.REGISTRY.AnimTask_ThrashMoveMon = AnimTasks.ThrashMoveMon;

// Lua: anim_tasks.lua:2291
AnimTasks.MeditateStretchAttacker = function (t: AnimTask, vm: any): void { runBattlerAffineTask(t, vm, vm.attackerSide(), AFFINE_COMMANDS.MeditateStretch!); };
AnimTasks.REGISTRY.MeditateStretchAttacker = AnimTasks.MeditateStretchAttacker;
AnimTasks.REGISTRY.AnimTask_MeditateStretchAttacker = AnimTasks.MeditateStretchAttacker;

// Lua: anim_tasks.lua:2295
AnimTasks.SlackOffSquish = function (t: AnimTask, vm: any): void { runBattlerAffineTask(t, vm, vm.attackerSide(), AFFINE_COMMANDS.SlackOffSquish!); };
AnimTasks.REGISTRY.SlackOffSquish = AnimTasks.SlackOffSquish;
AnimTasks.REGISTRY.AnimTask_SlackOffSquish = AnimTasks.SlackOffSquish;

// Lua: anim_tasks.lua:2299
AnimTasks.SmellingSaltsSquish = function (t: AnimTask, vm: any): void { runBattlerAffineTask(t, vm, vm.attackerSide(), AFFINE_COMMANDS.SmellingSaltsSquish!); };
AnimTasks.REGISTRY.SmellingSaltsSquish = AnimTasks.SmellingSaltsSquish;
AnimTasks.REGISTRY.AnimTask_SmellingSaltsSquish = AnimTasks.SmellingSaltsSquish;

// Lua: anim_tasks.lua:2303
AnimTasks.Uproar = function (t: AnimTask, vm: any): void { runBattlerAffineTask(t, vm, vm.attackerSide(), AFFINE_COMMANDS.Uproar!); };
AnimTasks.REGISTRY.Uproar = AnimTasks.Uproar;
AnimTasks.REGISTRY.AnimTask_Uproar = AnimTasks.Uproar;

// Lua: anim_tasks.lua:2309
//- pret AnimTask_RotateMonSpriteToSide / RotateMonToSideAndRestore (pokefirered/src/battle_anim_mon_movement.c:778, 812)
// arg 0: duration, arg 1: rotDelta, arg 2: whichMon, arg 3: returnMode (0=stay, 1=reset, 2=rotate back)
AnimTasks.RotateMonSpriteToSide = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const duration = tonumber(t.data[0]) ?? 1;
    let speed = tonumber(t.data[1]) ?? 0;
    const whichMon = t.data[2] ?? 0;
    const returnMode = tonumber(t.data[3]) ?? 0;
    const side = vm.resolveBattlerSide(whichMon);
    const isPlayer = (side === "player");
    if (isPlayer) {
      speed = -speed;
    }
    t._duration = duration;
    t._speed = speed;
    t._whichMon = whichMon;
    t._returnMode = returnMode;
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._rot = 0;
    t._timer = 0;
  }

  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }

  t._rot = t._rot + t._speed;
  p.rotation = (t._rot / 256) * (2 * Math.PI);
  p.oy = Math.floor(Sin(mod(Math.floor(Math.abs(t._rot) / 256), 256), 16));

  t._timer = t._timer + 1;
  if (t._timer >= t._duration) {
    if (t._returnMode === 1) {
      p.rotation = 0;
      p.oy = 0;
      destroy_task(t);
    } else if (t._returnMode === 2) {
      t._timer = 0;
      t._speed = -t._speed;
      t._returnMode = 1;
    } else {
      destroy_task(t);
    }
  }
};

AnimTasks.REGISTRY.RotateMonSpriteToSide = AnimTasks.RotateMonSpriteToSide;
AnimTasks.REGISTRY.AnimTask_RotateMonSpriteToSide = AnimTasks.RotateMonSpriteToSide;
AnimTasks.REGISTRY.RotateMonToSideAndRestore = AnimTasks.RotateMonSpriteToSide;
AnimTasks.REGISTRY.AnimTask_RotateMonToSideAndRestore = AnimTasks.RotateMonSpriteToSide;

// Lua: anim_tasks.lua:2369
//- pret AnimTask_RockMonBackAndForth (pokefirered/src/battle_anim_effects_3.c:2643)
// arg 0: whichBattler, arg 1: numRocks, arg 2: speedIncrease
AnimTasks.RockMonBackAndForth = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const whichMon = t.data[0] ?? 0;
    const numRocks = tonumber(t.data[1]) ?? 2;
    const speedInc = Math.max(0, Math.min(2, tonumber(t.data[2]) ?? 0));
    if (numRocks <= 0) {
      destroy_task(t);
      return;
    }
    const side = vm.resolveBattlerSide(whichMon);
    const p0 = Anim.present(side);
    if (!p0) {
      destroy_task(t);
      return;
    }
    t._p = p0;
    t._side = side;
    t._step = 0;
    t._timer = 0;
    t._rot = 0;
    t._halfDur = 8 - (2 * speedInc);
    t._rotSpeed = 0x100 + (speedInc * 128);
    t._xSpeed = speedInc + 2;
    t._repeats = numRocks - 1;
    if (side === "enemy" || (side !== "player" && !truthy(vm.isReversed))) {
      t._rotSpeed = -t._rotSpeed;
      t._xSpeed = -t._xSpeed;
    }
  }

  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }

  if (t._step === 0) {
    p.ox = (p.ox ?? 0) + t._xSpeed;
    t._rot = t._rot - t._rotSpeed;
    p.rotation = (t._rot / 65536) * (2 * Math.PI);
    p.oy = Math.floor(Sin(mod(Math.floor(Math.abs(t._rot) / 256), 256), 16));
    t._timer = t._timer + 1;
    if (t._timer >= t._halfDur) {
      t._timer = 0;
      t._step = 1;
    }
  } else if (t._step === 1) {
    p.ox = (p.ox ?? 0) - t._xSpeed;
    t._rot = t._rot + t._rotSpeed;
    p.rotation = (t._rot / 65536) * (2 * Math.PI);
    p.oy = Math.floor(Sin(mod(Math.floor(Math.abs(t._rot) / 256), 256), 16));
    t._timer = t._timer + 1;
    if (t._timer >= (t._halfDur * 2)) {
      t._timer = 0;
      t._step = 2;
    }
  } else if (t._step === 2) {
    p.ox = (p.ox ?? 0) + t._xSpeed;
    t._rot = t._rot - t._rotSpeed;
    p.rotation = (t._rot / 65536) * (2 * Math.PI);
    p.oy = Math.floor(Sin(mod(Math.floor(Math.abs(t._rot) / 256), 256), 16));
    t._timer = t._timer + 1;
    if (t._timer >= t._halfDur) {
      if (t._repeats > 0) {
        t._repeats = t._repeats - 1;
        t._timer = 0;
        t._step = 0;
      } else {
        t._step = 3;
      }
    }
  } else if (t._step >= 3) {
    p.ox = 0;
    p.oy = 0;
    p.rotation = 0;
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.RockMonBackAndForth = AnimTasks.RockMonBackAndForth;
AnimTasks.REGISTRY.AnimTask_RockMonBackAndForth = AnimTasks.RockMonBackAndForth;
AnimTasks.REGISTRY.CycleMagicalLeafPal = AnimTasks.RockMonBackAndForth;
AnimTasks.REGISTRY.AnimTask_CycleMagicalLeafPal = AnimTasks.RockMonBackAndForth;

// Lua: anim_tasks.lua:2457
//- pret AnimTask_ScaleMonAndRestore (pokefirered/src/battle_anim_mon_movement.c:740)
// arg 0: dx, arg 1: dy, arg 2: duration, arg 3: whichMon
AnimTasks.ScaleMonAndRestore = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const dx = tonumber(t.data[0]) ?? 0;
    const dy = tonumber(t.data[1]) ?? 0;
    const duration = Math.max(1, tonumber(t.data[2]) ?? 1);
    const whichMon = t.data[3] ?? 0;
    const side = vm.resolveBattlerSide(whichMon);
    t._dx = dx;
    t._dy = dy;
    t._duration = duration;
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._scaleX = 256;
    t._scaleY = 256;
    t._timer = 0;
    t._phase = 0;
  }

  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }

  t._scaleX = t._scaleX + t._dx;
  t._scaleY = t._scaleY + t._dy;
  p.sx = 256 / Math.max(1, t._scaleX);
  p.sy = 256 / Math.max(1, t._scaleY);
  p.oy = Math.floor((64 - (64 * 256 / Math.max(1, t._scaleY))) / 2);

  t._timer = t._timer + 1;
  if (t._timer >= t._duration) {
    if (t._phase === 0) {
      t._phase = 1;
      t._timer = 0;
      t._dx = -t._dx;
      t._dy = -t._dy;
    } else {
      p.sx = 1;
      p.sy = 1;
      p.oy = 0;
      destroy_task(t);
    }
  }
};

AnimTasks.REGISTRY.ScaleMonAndRestore = AnimTasks.ScaleMonAndRestore;
AnimTasks.REGISTRY.AnimTask_ScaleMonAndRestore = AnimTasks.ScaleMonAndRestore;

// Lua: anim_tasks.lua:2513
//- pret AnimTask_Minimize (pokefirered/src/battle_anim_effects_2.c:2033)
AnimTasks.Minimize = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const side = vm.attackerSide();
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._step = 0;
    t._frame = 0;
    t._cycle = 0;
    t._scale = 256;
  }

  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }

  if (t._step === 0) {
    t._scale = t._scale + 0x28;
    p.sx = 256 / t._scale;
    p.sy = 256 / t._scale;
    p.oy = Math.floor((64 - (64 * 256 / t._scale)) / 2);
    t._frame = t._frame + 1;
    if (t._frame >= 32) {
      t._frame = 0;
      t._cycle = t._cycle + 1;
      if (t._cycle >= 3) {
        t._step = 2;
      } else {
        t._scale = 256;
        t._step = 0;
      }
    }
  } else if (t._step === 2) {
    t._frame = t._frame + 1;
    if (t._frame >= 32) {
      t._frame = 0;
      t._step = 3;
    }
  } else if (t._step === 3) {
    t._scale = t._scale - 0x50;
    p.sx = 256 / Math.max(1, t._scale);
    p.sy = 256 / Math.max(1, t._scale);
    p.oy = Math.floor((64 - (64 * 256 / Math.max(1, t._scale))) / 2);
    t._frame = t._frame + 1;
    if (t._frame >= 16 || t._scale <= 256) {
      p.sx = 1;
      p.sy = 1;
      p.oy = 0;
      destroy_task(t);
    }
  }
};

AnimTasks.REGISTRY.Minimize = AnimTasks.Minimize;
AnimTasks.REGISTRY.AnimTask_Minimize = AnimTasks.Minimize;

// Lua: anim_tasks.lua:2577
//- pret AnimTask_Withdraw (pokefirered/src/battle_anim_effects_2.c:1377)
AnimTasks.Withdraw = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const side = vm.attackerSide();
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._rot = 0;
    t._step = 0;
    t._pause = 0;
  }

  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }

  if (t._step === 0) {
    t._rot = t._rot + 0xB0;
    let r = t._rot;
    if (t._side === "player") r = -r;
    p.rotation = (r / 256) * (2 * Math.PI / 256);
    p.oy = Math.floor(Sin(mod(Math.floor(Math.abs(r) / 256), 256), 16));
    if (t._rot >= 0xF20) {
      t._step = 1;
    }
  } else if (t._step === 1) {
    t._pause = t._pause + 1;
    if (t._pause >= 30) {
      t._step = 2;
    }
  } else if (t._step === 2) {
    t._rot = t._rot - 0xB0;
    let r = t._rot;
    if (t._side === "player") r = -r;
    p.rotation = (r / 256) * (2 * Math.PI / 256);
    p.oy = Math.floor(Sin(mod(Math.floor(Math.abs(r) / 256), 256), 16));
    if (t._rot <= 0) {
      p.rotation = 0;
      p.oy = 0;
      destroy_task(t);
    }
  }
};

AnimTasks.REGISTRY.Withdraw = AnimTasks.Withdraw;
AnimTasks.REGISTRY.AnimTask_Withdraw = AnimTasks.Withdraw;

// Lua: anim_tasks.lua:2632
//- pret AnimTask_SwayMon (pokefirered/src/battle_anim_mon_movement.c:680)
// arg 0: dir (0=horiz, 1=vert); arg 1: amp; arg 2: period; arg 3: num sways; arg 4: which mon (0=atk, 1=tgt)
AnimTasks.SwayMon = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const dir = tonumber(t.data[0]) ?? 0;
    let amp = tonumber(t.data[1]) ?? 8;
    const period = tonumber(t.data[2]) ?? 0x100;
    const numSways = Math.max(1, tonumber(t.data[3]) ?? 1);
    const which = t.data[4] ?? 0;
    const side = vm.resolveBattlerSide(which);
    if (vm.attackerSide() !== "player") {
      amp = -amp;
    }
    t._dir = dir;
    t._amp = amp;
    t._period = period;
    t._numSways = numSways;
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._sineIndex = 0;
    t._flag11 = 0;
    t._flag12 = 1;
  }
  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }
  t._sineIndex = mod(t._sineIndex + t._period, 65536);
  const waveIdx = mod(Math.floor(t._sineIndex / 256), 256);
  const sineVal = Sin(waveIdx, t._amp);
  if (t._dir === 0) {
    p.ox = sineVal;
  } else {
    if (t._side === "player") {
      p.oy = Math.abs(sineVal);
    } else {
      p.oy = -Math.abs(sineVal);
    }
  }
  if ((waveIdx > 0x7F && t._flag11 === 0 && t._flag12 === 1)
      || (waveIdx < 0x7F && t._flag11 === 1 && t._flag12 === 0)) {
    t._flag11 = 1 - t._flag11;
    t._flag12 = 1 - t._flag12;
    t._numSways = t._numSways - 1;
    if (t._numSways <= 0) {
      p.ox = 0;
      p.oy = 0;
      destroy_task(t);
    }
  }
};

AnimTasks.REGISTRY.SwayMon = AnimTasks.SwayMon;
AnimTasks.REGISTRY.AnimTask_SwayMon = AnimTasks.SwayMon;

// Lua: anim_tasks.lua:2694
//- pret AnimTask_WindUpLunge (pokefirered/src/battle_anim_mon_movement.c:579)
// arg 0: anim battler; arg 1: hspeed; arg 2: wave amp; arg 3: dur1; arg 4: delay; arg 5: target x; arg 6: lunge dur
AnimTasks.WindUpLunge = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const side = vm.resolveBattlerSide(t.data[0] ?? 0);
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    let speed1 = tonumber(t.data[1]) ?? 0;
    let targetX2 = tonumber(t.data[5]) ?? 0;
    if (side !== "player") {
      speed1 = -speed1;
      targetX2 = -targetX2;
    }
    t._amp = tonumber(t.data[2]) ?? 0;
    t._dur1 = Math.max(1, tonumber(t.data[3]) ?? 10);
    t._delay = tonumber(t.data[4]) ?? 0;
    t._dur2 = Math.max(1, tonumber(t.data[6]) ?? 4);
    t._speed1_fp = Math.floor((speed1 * 256) / t._dur1);
    t._speed2_fp = Math.floor((targetX2 * 256) / t._dur2);
    t._wavePeriod = Math.floor(0x8000 / t._dur1);
    t._waveAngle = 0;
    t._subX1 = 0;
    t._subX2 = 0;
    t._step = 1;
    t._origZ = t._p.z;
    t._p.z = AnimVm.Z.FRONT;
  }
  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }
  if (t._step === 1) {
    t._subX1 = t._subX1 + t._speed1_fp;
    p.ox = Math.floor(t._subX1 / 256);
    p.oy = Sin(Math.floor(t._waveAngle / 256), t._amp);
    t._waveAngle = t._waveAngle + t._wavePeriod;
    t._dur1 = t._dur1 - 1;
    if (t._dur1 <= 0) {
      t._step = 2;
    }
  } else if (t._step === 2) {
    if (t._delay > 0) {
      t._delay = t._delay - 1;
    } else {
      t._subX2 = t._subX2 + t._speed2_fp;
      p.ox = Math.floor(t._subX2 / 256) + Math.floor(t._subX1 / 256);
      t._dur2 = t._dur2 - 1;
      if (t._dur2 <= 0) {
        if (t._origZ != null) p.z = t._origZ;
        destroy_task(t);
      }
    }
  }
};

AnimTasks.REGISTRY.WindUpLunge = AnimTasks.WindUpLunge;
AnimTasks.REGISTRY.AnimTask_WindUpLunge = AnimTasks.WindUpLunge;

// Lua: anim_tasks.lua:2759
//- pret AnimTask_DragonDanceWaver: wave distortion & sway.
AnimTasks.DragonDanceWaver = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = Math.max(16, tonumber(t.data[0]) ?? 28);
  const side = vm.attackerSide();
  const p = Anim.present(side);

  if (p) {
    p.ox = Math.floor(Math.sin(frame * 0.45) * 6);
    p.rotation = Math.sin(frame * 0.3) * 0.12;
  }

  if (frame >= dur) {
    if (p) { p.ox = 0; p.rotation = 0; }
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.DragonDanceWaver = AnimTasks.DragonDanceWaver;
AnimTasks.REGISTRY.AnimTask_DragonDanceWaver = AnimTasks.DragonDanceWaver;

// Lua: anim_tasks.lua:2782
//- Utility Side Query Tasks (pokefirered/src/battle_anim_utility_funcs.c:700)
AnimTasks.GetAttackerSide = function (t: AnimTask, vm: any): void {
  const side = vm.attackerSide();
  vm.args[7] = (side === "player") ? 0 : 1;
  destroy_task(t);
};

AnimTasks.REGISTRY.GetAttackerSide = AnimTasks.GetAttackerSide;
AnimTasks.REGISTRY.AnimTask_GetAttackerSide = AnimTasks.GetAttackerSide;

// Lua: anim_tasks.lua:2791
AnimTasks.GetTargetSide = function (t: AnimTask, vm: any): void {
  const side = vm.targetSide();
  vm.args[7] = (side === "player") ? 0 : 1;
  destroy_task(t);
};

AnimTasks.REGISTRY.GetTargetSide = AnimTasks.GetTargetSide;
AnimTasks.REGISTRY.AnimTask_GetTargetSide = AnimTasks.GetTargetSide;

// Lua: anim_tasks.lua:2801
// pokefirered/src/battle_anim_utility_funcs.c:712
AnimTasks.GetTargetIsAttackerPartner = function (t: AnimTask, vm: any): void {
  const atkR = vm.attackerId ? vm.attackerId() : null;
  const atk = truthy(atkR) ? atkR : 0;
  const tgtR = vm.targetId ? vm.targetId() : null;
  const tgt = truthy(tgtR) ? tgtR : 1;
  vm.args[7] = ((atk ^ 2) === tgt) ? 1 : 0;
  destroy_task(t);
};

AnimTasks.REGISTRY.GetTargetIsAttackerPartner = AnimTasks.GetTargetIsAttackerPartner;
AnimTasks.REGISTRY.AnimTask_GetTargetIsAttackerPartner = AnimTasks.GetTargetIsAttackerPartner;

// Lua: anim_tasks.lua:2811
AnimTasks.SetAllNonAttackersInvisiblity = function (t: AnimTask, vm: any): void {
  const invis = (tonumber(t.data[0]) ?? 0) !== 0;
  const atkSide = vm.attackerSide();
  const otherSide = (atkSide === "player") ? "enemy" : "player";
  const p = Anim.present(otherSide);
  if (p) p.visible = !invis;
  destroy_task(t);
};

AnimTasks.REGISTRY.SetAllNonAttackersInvisiblity = AnimTasks.SetAllNonAttackersInvisiblity;
AnimTasks.REGISTRY.AnimTask_SetAllNonAttackersInvisiblity = AnimTasks.SetAllNonAttackersInvisiblity;

// Lua: anim_tasks.lua:2826
//- pret AnimTask_TranslateMonElliptical / AnimTask_TranslateMonEllipticalRespectSide (pokefirered/src/battle_anim_mon_movement.c:334, 377)
// arg 0: battler; arg 1: ellipse width; arg 2: ellipse height; arg 3: num loops; arg 4: speed (0-5)
AnimTasks.TranslateMonElliptical = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const side = vm.resolveBattlerSide(t.data[0]);
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    t._radiusX = tonumber(t.data[1]) ?? 0;
    t._radiusY = tonumber(t.data[2]) ?? 0;
    t._numLoops = Math.max(1, tonumber(t.data[3]) ?? 1);
    const spd = Math.min(5, Math.max(0, tonumber(t.data[4]) ?? 0));
    t._wavePeriod = 2 ** spd;
    t._angle = 0;
    t._origZ = t._p.z;
    t._p.z = AnimVm.Z.FRONT;
  }
  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }
  p.ox = Sin(t._angle, t._radiusX);
  p.oy = -Cos(t._angle, t._radiusY) + t._radiusY;
  t._angle = mod(t._angle + t._wavePeriod, 256);
  if (t._angle === 0) {
    t._numLoops = t._numLoops - 1;
  }
  if (t._numLoops <= 0) {
    p.ox = 0;
    p.oy = 0;
    if (t._origZ != null) p.z = t._origZ;
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.TranslateMonElliptical = AnimTasks.TranslateMonElliptical;
AnimTasks.REGISTRY.AnimTask_TranslateMonElliptical = AnimTasks.TranslateMonElliptical;

// Lua: anim_tasks.lua:2869
AnimTasks.TranslateMonEllipticalRespectSide = function (t: AnimTask, vm: any): void {
  const atkSide = vm.attackerSide();
  if (atkSide !== "player") {
    t.data[1] = -(tonumber(t.data[1]) ?? 0);
  }
  AnimTasks.TranslateMonElliptical(t, vm);
};

AnimTasks.REGISTRY.TranslateMonEllipticalRespectSide = AnimTasks.TranslateMonEllipticalRespectSide;
AnimTasks.REGISTRY.AnimTask_TranslateMonEllipticalRespectSide = AnimTasks.TranslateMonEllipticalRespectSide;

// Lua: anim_tasks.lua:2882
//- pret AnimTask_SlideOffScreen (pokefirered/src/battle_anim_mon_movement.c:626)
// arg 0: battler; arg 1: speed
AnimTasks.SlideOffScreen = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const side = vm.resolveBattlerSide(t.data[0] ?? 0);
    t._side = side;
    t._p = Anim.present(side);
    if (!t._p) {
      destroy_task(t);
      return;
    }
    let speed = tonumber(t.data[1]) ?? 8;
    const tgtSide = vm.targetSide();
    if (tgtSide === "player") {
      speed = -speed;
    }
    t._speed = speed;
  }
  const p = t._p;
  if (!p) {
    destroy_task(t);
    return;
  }
  p.ox = (p.ox ?? 0) + t._speed;
  const [cx] = vm.battlerCenter(t._side);
  if (cx < -40 || cx > 280) {
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.SlideOffScreen = AnimTasks.SlideOffScreen;
AnimTasks.REGISTRY.AnimTask_SlideOffScreen = AnimTasks.SlideOffScreen;

// Lua: anim_tasks.lua:2917
//- pret AnimTask_VoltTackleBolt (pokefirered/src/battle_anim_electric.c:985)
// arg 0: bolt step index (0=start, 1..3=mid, 4=impact)
AnimTasks.VoltTackleBolt = function (t: AnimTask, vm: any): void {
  if (!t._inited) {
    t._inited = true;
    const stepIdx = tonumber(t.data[0]) ?? 0;
    const isPlayer = (vm.attackerSide() === "player");
    const dir = isPlayer ? 1 : -1;
    const [ax, ay] = vm.battlerCenter("attacker");
    const [tx, ty] = vm.battlerCenter("target");
    let startX: number, startY: number, endX: number;
    if (stepIdx === 0) {
      startX = ax; startY = ay;
      endX = (dir * 128) + 120;
    } else if (stepIdx === 4) {
      startX = 120 - (dir * 128);
      startY = ty;
      endX = tx - (dir * 32);
    } else {
      startX = (mod(stepIdx, 2) === 1) ? 256 : -16;
      endX = (mod(stepIdx, 2) === 1) ? -16 : 256;
      startY = isPlayer ? (80 - stepIdx * 10) : (stepIdx * 10 + 40);
    }
    t._currX = startX;
    t._startY = startY;
    t._endX = endX;
    t._dir = (startX < endX) ? 1 : -1;
    t._timer = 0;
    t._activeBolts = 0;
  }

  const pack = vm._pack;
  const imgMeta = pack && pack.tags && (pack.tags["ELECTRICITY"] || pack.tags["SPARK"] || pack.tags["LIGHTNING"]);
  if (imgMeta && imgMeta.image) {
    const spr = AnimSprites.acquire({
      x: t._currX,
      y: t._startY + random(-8, 8),
      z: AnimSprites.Z.GLOBAL_FRONT,
      image: imgMeta.image,
      w: imgMeta.frameW ?? 16,
      h: imgMeta.frameH ?? 16,
      hFlip: (t._dir < 0),
      tag: "ELECTRICITY",
      callback: function (s: any): void {
        s.data[0] = (s.data[0] ?? 0) + 1;
        if (s.data[0] >= 6) AnimSprites.release(s);
      },
    });
    if (spr) {
      spr._baseW = imgMeta.frameW ?? 16;
      spr._baseH = imgMeta.frameH ?? 16;
    }
  }

  t._currX = t._currX + t._dir * 16;
  const reached = (t._dir === 1 && t._currX >= t._endX) || (t._dir === -1 && t._currX <= t._endX);
  if (reached) {
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.VoltTackleBolt = AnimTasks.VoltTackleBolt;
AnimTasks.REGISTRY.AnimTask_VoltTackleBolt = AnimTasks.VoltTackleBolt;

// Lua: anim_tasks.lua:2980
//- pret AnimTask_ShockWaveProgressingBolt / AnimTask_ShockWaveLightning (pokefirered/src/battle_anim_electric.c:1107, 1226)
AnimTasks.ShockWaveProgressingBolt = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 20;
  const [ax, ay] = vm.battlerCenter("attacker");
  const [tx, ty] = vm.battlerCenter("target");
  const pack = vm._pack;

  if (frame < 16 && mod(frame, 2) === 0) {
    const u = frame / 16;
    const bx = ax + (tx - ax) * u;
    const by = ay + (ty - ay) * u + random(-12, 12);
    const imgMeta = pack && pack.tags && (pack.tags["LIGHTNING"] || pack.tags["ELECTRICITY"] || pack.tags["SPARK"]);
    if (imgMeta && imgMeta.image) {
      const spr = AnimSprites.acquire({
        x: bx,
        y: by,
        z: AnimSprites.Z.GLOBAL_FRONT,
        image: imgMeta.image,
        w: imgMeta.frameW ?? 32,
        h: imgMeta.frameH ?? 32,
        tag: "LIGHTNING",
        callback: function (s: any): void {
          s.data[0] = (s.data[0] ?? 0) + 1;
          if (s.data[0] >= 8) AnimSprites.release(s);
        },
      });
      if (spr) {
        spr._baseW = imgMeta.frameW ?? 32;
        spr._baseH = imgMeta.frameH ?? 32;
      }
    }
  }

  if (frame >= dur) {
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.ShockWaveProgressingBolt = AnimTasks.ShockWaveProgressingBolt;
AnimTasks.REGISTRY.AnimTask_ShockWaveProgressingBolt = AnimTasks.ShockWaveProgressingBolt;
AnimTasks.REGISTRY.ShockWaveLightning = AnimTasks.ShockWaveProgressingBolt;
AnimTasks.REGISTRY.AnimTask_ShockWaveLightning = AnimTasks.ShockWaveProgressingBolt;
AnimTasks.REGISTRY.ElectricBolt = AnimTasks.ShockWaveProgressingBolt;
AnimTasks.REGISTRY.AnimTask_ElectricBolt = AnimTasks.ShockWaveProgressingBolt;

// Lua: anim_tasks.lua:3027
//- pret AnimTask_EruptionLaunchRocks (pokefirered/src/battle_anim_fire.c:754)
AnimTasks.EruptionLaunchRocks = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 36;
  const [ax, ay] = vm.battlerCenter("attacker");
  const pack = vm._pack;

  if (frame < 20 && mod(frame, 4) === 0) {
    const imgMeta = pack && pack.tags && (pack.tags["ROCKS"] || pack.tags["SMALL_ROCK"] || pack.tags["IMPACT"]);
    if (imgMeta && imgMeta.image) {
      for (let _ = 1; _ <= 2; _++) {
        const spr = AnimSprites.acquire({
          x: ax + random(-16, 16),
          y: ay,
          z: AnimSprites.Z.GLOBAL_FRONT,
          image: imgMeta.image,
          w: imgMeta.frameW ?? 16,
          h: imgMeta.frameH ?? 16,
          tag: "ROCKS",
          callback: function (s: any): void {
            s.data[0] = (s.data[0] ?? 0) + 1;
            if (s._vx == null) {
              s._vx = (random() - 0.5) * 3.5;
              s._vy = -4.5 - random() * 2.0;
            }
            s._vy = s._vy + 0.3; // gravity
            s.ox = (s.ox ?? 0) + s._vx;
            s.oy = (s.oy ?? 0) + s._vy;
            s.rotation = (s.rotation ?? 0) + 0.2;
            if (s.data[0] >= 24) AnimSprites.release(s);
          },
        });
        if (spr) {
          spr._baseW = imgMeta.frameW ?? 16;
          spr._baseH = imgMeta.frameH ?? 16;
        }
      }
    }
  }

  if (frame >= dur) {
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.EruptionLaunchRocks = AnimTasks.EruptionLaunchRocks;
AnimTasks.REGISTRY.AnimTask_EruptionLaunchRocks = AnimTasks.EruptionLaunchRocks;

// Lua: anim_tasks.lua:3076
//- pret AnimTask_FrozenIceCube (pokefirered/src/battle_anim_status_effects.c:350)
AnimTasks.FrozenIceCube = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 32;
  const tgtSide = vm.resolveBattlerSide("target");
  const pTgt = Anim.present(tgtSide);
  t.z = AnimSprites.Z.GLOBAL_FRONT;

  if (frame < dur && pTgt) {
    pTgt.blendColor = lseq(0.4, 0.8, 1.0);
    pTgt.blendCoeff = 0.5 + 0.2 * Math.sin((frame / 8) * Math.PI);
  } else if (frame >= dur && pTgt) {
    pTgt.blendCoeff = 0;
  }

  t.draw = function (task: AnimTask, _vm: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const [tx, ty] = vm.battlerCenter(tgtSide);
    const f = task.data[14] ?? 1;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    // Crystalline faceted ice block overlay
    G.setColor(0.60, 0.88, 1.00, a * 0.55);
    G.rectangle("fill", tx - 28, ty - 28, 56, 56, 4, 4);
    G.setColor(0.90, 0.98, 1.00, a * 0.85);
    G.setLineWidth(1.5);
    G.rectangle("line", tx - 28, ty - 28, 56, 56, 4, 4);
    // Shimmering internal prism facet lines
    G.line(tx - 28, ty - 12, tx + 28, ty - 20);
    G.line(tx - 12, ty + 28, tx + 18, ty - 28);
    G.setLineWidth(1);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    if (pTgt) pTgt.blendCoeff = 0;
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.FrozenIceCube = AnimTasks.FrozenIceCube;
AnimTasks.REGISTRY.AnimTask_FrozenIceCube = AnimTasks.FrozenIceCube;

// Lua: anim_tasks.lua:3120
//- pret AnimTask_Hail (pokefirered/src/battle_anim_ice.c:1253)
AnimTasks.Hail = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 32;
  t.z = AnimSprites.Z.GLOBAL_FRONT;

  if (frame === 1) {
    t._particles = lseq();
  }

  // Spawn falling hail shards
  if (frame < 26 && mod(frame, 2) === 0) {
    t._particles = t._particles ?? lseq();
    for (let _ = 1; _ <= 4; _++) {
      t._particles[len(t._particles) + 1] = {
        x: random(10, 240),
        y: -10,
        vx: -3.5,
        vy: 6.0 + random() * 2.0,
        life: 0,
        maxLife: 20,
      };
    }
  }

  if (t._particles) {
    const alive: LuaTable = lseq();
    const ps = t._particles;
    const n = len(ps);
    for (let i = 1; i <= n; i++) {
      const p = ps[i];
      p.life = p.life + 1;
      p.x = p.x + p.vx;
      p.y = p.y + p.vy;
      if (p.life < p.maxLife && p.y < 120) {
        alive[len(alive) + 1] = p;
      }
    }
    t._particles = alive;
  }

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    if (!task._particles) return;
    G.setLineWidth(1.5);
    const ps = task._particles;
    const n = len(ps);
    for (let i = 1; i <= n; i++) {
      const p = ps[i];
      const a = 1.0 - (p.life / p.maxLife);
      G.setColor(0.85, 0.95, 1.0, a * 0.9);
      G.line(p.x, p.y, p.x + p.vx * 1.5, p.y + p.vy * 1.5);
      G.setColor(1, 1, 1, a);
      G.circle("fill", p.x, p.y, 1.5);
    }
    G.setLineWidth(1);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.Hail = AnimTasks.Hail;
AnimTasks.REGISTRY.AnimTask_Hail = AnimTasks.Hail;

// Lua: anim_tasks.lua:3182
//- pret Atmospheric Fog & Spore Tasks (Mist, Haze, Spore, Smokescreen)
AnimTasks.AtmosphericFog = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = Math.max(16, tonumber(t.data[0]) ?? 28);
  t.z = AnimSprites.Z.MID_FIELD;

  if (frame === 1) {
    t._particles = lseq();
    for (let _ = 1; _ <= 8; _++) {
      t._particles[len(t._particles) + 1] = {
        x: random(10, 230),
        y: random(35, 100),
        vx: (random() > 0.5 ? 0.4 : -0.4),
        radius: random(18, 32),
        life: 0,
        maxLife: dur,
      };
    }
  }

  if (t._particles) {
    const ps = t._particles;
    const n = len(ps);
    for (let i = 1; i <= n; i++) {
      const p = ps[i];
      p.life = p.life + 1;
      p.x = p.x + p.vx;
    }
  }

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    if (!task._particles) return;
    const f = task.data[14] ?? 0;
    const globalAlpha = (f <= 8) ? (f / 8) : ((f >= dur - 8) ? ((dur - f) / 8) : 1.0);
    const ps = task._particles;
    const n = len(ps);
    for (let i = 1; i <= n; i++) {
      const p = ps[i];
      G.setColor(0.92, 0.94, 0.98, globalAlpha * 0.35);
      G.circle("fill", p.x, p.y, p.radius);
    }
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.MistBallFog = AnimTasks.AtmosphericFog;
AnimTasks.REGISTRY.AnimTask_MistBallFog = AnimTasks.AtmosphericFog;
AnimTasks.REGISTRY.HazeScrollingFog = AnimTasks.AtmosphericFog;
AnimTasks.REGISTRY.AnimTask_HazeScrollingFog = AnimTasks.AtmosphericFog;
AnimTasks.REGISTRY.SporeDoubleBattle = AnimTasks.AtmosphericFog;
AnimTasks.REGISTRY.AnimTask_SporeDoubleBattle = AnimTasks.AtmosphericFog;
AnimTasks.REGISTRY.SmokescreenImpact = AnimTasks.AtmosphericFog;
AnimTasks.REGISTRY.AnimTask_SmokescreenImpact = AnimTasks.AtmosphericFog;

// Lua: anim_tasks.lua:3236
//- pret AnimTask_LoadSandstormBackground (pokefirered/src/battle_anim_rock.c:405)
AnimTasks.LoadSandstormBackground = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 32;
  t.z = AnimSprites.Z.MID_FIELD;

  if (frame === 1) {
    t._particles = lseq();
    for (let _ = 1; _ <= 14; _++) {
      t._particles[len(t._particles) + 1] = {
        x: random(0, 240),
        y: random(20, 110),
        vx: -(4.0 + random() * 3.0),
        vy: (random() - 0.5) * 1.5,
        len: random(8, 20),
        life: 0,
        maxLife: dur,
      };
    }
  }

  if (t._particles) {
    const ps = t._particles;
    const n = len(ps);
    for (let i = 1; i <= n; i++) {
      const p = ps[i];
      p.life = p.life + 1;
      p.x = p.x + p.vx;
      p.y = p.y + p.vy;
      if (p.x < -20) { p.x = 260; p.y = random(20, 110); }
    }
  }

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    if (!task._particles) return;
    const f = task.data[14] ?? 0;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    // Ambient sandstorm tint
    G.setColor(0.78, 0.65, 0.40, a * 0.30);
    G.rectangle("fill", 0, 0, 240, 112);
    // Swirling wind and dust streaks
    G.setColor(0.90, 0.80, 0.55, a * 0.70);
    G.setLineWidth(1.5);
    const ps = task._particles;
    const n = len(ps);
    for (let i = 1; i <= n; i++) {
      const p = ps[i];
      G.line(p.x, p.y, p.x + p.len, p.y - 2);
      G.circle("fill", p.x, p.y, 1.2);
    }
    G.setLineWidth(1);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.LoadSandstormBackground = AnimTasks.LoadSandstormBackground;
AnimTasks.REGISTRY.AnimTask_LoadSandstormBackground = AnimTasks.LoadSandstormBackground;

// Lua: anim_tasks.lua:3294
//- Sound Tasks with spatial panning
AnimTasks.SoundTask_PlaySE1WithPanning = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const songId = t.data[0];
  const initPan = tonumber(t.data[1]) ?? -64;
  const targetPan = tonumber(t.data[2]) ?? 63;
  const dur = Math.max(1, tonumber(t.data[3]) ?? 16);

  if (frame === 1) {
    t.data[10] = initPan;
    // pcall(require, "src.core.game3.audio"): a real module, the ok branch.
    if (Audio && Audio.playSe) {
      Audio.playSe(songId, { pan: initPan });
    }
  }

  const u = Math.min(1, frame / dur);
  const currentPan = Math.floor(initPan + (targetPan - initPan) * u);
  t.data[10] = currentPan;

  if (frame >= dur) {
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.SoundTask_PlaySE1WithPanning = AnimTasks.SoundTask_PlaySE1WithPanning;

// Lua: anim_tasks.lua:3321
AnimTasks.SoundTask_AdjustPanningVar = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = Math.max(1, tonumber(t.data[1]) ?? 16);
  if (frame >= dur) {
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.SoundTask_AdjustPanningVar = AnimTasks.SoundTask_AdjustPanningVar;

// Lua: anim_tasks.lua:3332
AnimTasks.SetGrayscaleOrOriginalPal = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = Math.max(12, tonumber(t.data[0]) ?? 24);

  const u = Math.sin((frame / dur) * Math.PI);
  Anim.setScreenEffect({ type: "grayscale", coeff: u });

  if (frame >= dur) {
    Anim.setScreenEffect(null);
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.SetGrayscaleOrOriginalPal = AnimTasks.SetGrayscaleOrOriginalPal;
AnimTasks.REGISTRY.AnimTask_SetGrayscaleOrOriginalPal = AnimTasks.SetGrayscaleOrOriginalPal;

// Lua: anim_tasks.lua:3351
//- pret AnimTask_PainSplitMovement: visual energy transfer pulse
AnimTasks.PainSplitMovement = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 24;
  const pAtk = Anim.present(vm.attackerSide());
  const pTgt = Anim.present(vm.resolveBattlerSide("target"));
  if (frame < 12) {
    if (pTgt) pTgt.flash = (mod(frame, 2) === 0) ? 1 : 0;
  } else if (frame < 24) {
    if (pTgt) pTgt.flash = 0;
    if (pAtk) pAtk.flash = (mod(frame, 2) === 0) ? 1 : 0;
  }
  if (frame >= dur) {
    if (pAtk) pAtk.flash = 0;
    if (pTgt) pTgt.flash = 0;
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.PainSplitMovement = AnimTasks.PainSplitMovement;
AnimTasks.REGISTRY.AnimTask_PainSplitMovement = AnimTasks.PainSplitMovement;

// Lua: anim_tasks.lua:3375
//- pret AnimTask_DoubleTeam / AnimTask_MonToSubstitute
AnimTasks.DoubleTeam = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = Math.max(20, tonumber(t.data[0]) ?? 30);
  const side = vm.attackerSide();
  const p = Anim.present(side);
  if (p) {
    const phase = mod(frame, 6);
    p.ox = (phase < 3) ? 12 : -12;
    p.alpha = 0.65 + 0.35 * Math.sin(frame * 0.5);
  }
  if (frame >= dur) {
    if (p) { p.ox = 0; p.alpha = 1.0; }
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.DoubleTeam = AnimTasks.DoubleTeam;
AnimTasks.REGISTRY.AnimTask_DoubleTeam = AnimTasks.DoubleTeam;

// Lua: anim_tasks.lua:3396
AnimTasks.MonToSubstitute = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 16;
  const side = vm.attackerSide();
  const p = Anim.present(side);
  if (p) {
    const u = Math.sin((frame / dur) * Math.PI);
    p.sy = 1.0 - u * 0.3;
    p.sx = 1.0 + u * 0.2;
  }
  if (frame >= dur) {
    if (p) { p.sx = 1.0; p.sy = 1.0; }
    destroy_task(t);
  }
};

AnimTasks.REGISTRY.MonToSubstitute = AnimTasks.MonToSubstitute;
AnimTasks.REGISTRY.AnimTask_MonToSubstitute = AnimTasks.MonToSubstitute;


// =========================================================================
// Phase 4: Dynamic Backgrounds, Clones, Distortions & Specialized Subsystems
// =========================================================================

//- Subsystem A: Dynamic Scrolling Backgrounds & High-Altitude Environments

// Lua: anim_tasks.lua:3425
//- pret AnimTask_MoveSkyUppercutBg (pokefirered/src/battle_anim_fight.c:280)
AnimTasks.MoveSkyUppercutBg = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 36;
  t.z = AnimSprites.Z.GLOBAL_BEHIND;
  t.data[10] = (t.data[10] ?? 0) + 14; // vertical scroll speed upward

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    const scrollY = mod(task.data[10] ?? 0, 112);
    // Sky gradient background
    G.setColor(0.20, 0.50, 0.90, a * 0.85);
    G.rectangle("fill", 0, 0, 240, 112);
    // Fast ascending high-altitude cloud speed lines
    G.setColor(0.90, 0.95, 1.00, a * 0.70);
    G.setLineWidth(2);
    for (let i = 0; i <= 8; i++) {
      const x = mod(i * 28 + 14, 240);
      const y = mod(i * 32 - scrollY * 2, 128) - 16;
      G.line(x, y, x, y + 24);
    }
    G.setLineWidth(1);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.MoveSkyUppercutBg = AnimTasks.MoveSkyUppercutBg;
AnimTasks.REGISTRY.AnimTask_MoveSkyUppercutBg = AnimTasks.MoveSkyUppercutBg;

// Lua: anim_tasks.lua:3460
//- pret AnimTask_MoveSeismicTossBg & SeismicTossBgAccelerateDownAtEnd (pokefirered/src/battle_anim_fight.c:320)
AnimTasks.MoveSeismicTossBg = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 40;
  t.z = AnimSprites.Z.GLOBAL_BEHIND;
  const speed = 2 + (frame * 0.4);
  t.data[10] = (t.data[10] ?? 0) + speed; // accelerating descent

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    const scrollY = mod(task.data[10] ?? 0, 112);
    // Space / upper atmosphere deep navy background
    G.setColor(0.04, 0.08, 0.22, a * 0.90);
    G.rectangle("fill", 0, 0, 240, 112);
    // Earth curve horizon glow
    G.setColor(0.18, 0.55, 0.85, a * 0.65);
    G.arc("fill", 120, 180 - scrollY * 0.5, 140, Math.PI, Math.PI * 2);
    // Re-entry meteor friction streaks
    G.setColor(1.00, 0.65, 0.20, a * 0.80);
    G.setLineWidth(2);
    for (let i = 0; i <= 6; i++) {
      const x = mod(i * 36 + 18, 240);
      const y = mod(i * 24 + scrollY * 2, 128) - 16;
      G.line(x, y, x, y + 18);
    }
    G.setLineWidth(1);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.MoveSeismicTossBg = AnimTasks.MoveSeismicTossBg;
AnimTasks.REGISTRY.AnimTask_MoveSeismicTossBg = AnimTasks.MoveSeismicTossBg;
AnimTasks.REGISTRY.SeismicTossBgAccelerateDownAtEnd = AnimTasks.MoveSeismicTossBg;
AnimTasks.REGISTRY.AnimTask_SeismicTossBgAccelerateDownAtEnd = AnimTasks.MoveSeismicTossBg;

// Lua: anim_tasks.lua:3501
//- pret AnimTask_PositionFissureBgOnBattler (pokefirered/src/battle_anim_ground.c:450)
AnimTasks.PositionFissureBgOnBattler = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 40;
  t.z = AnimSprites.Z.GLOBAL_BEHIND;
  const [tx, ty] = vm.battlerCenter("target");

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    const width = Math.min(36, f * 1.5);
    // Ground abyss fissure opening beneath target
    G.setColor(0.08, 0.05, 0.02, a * 0.95);
    G.polygon("fill", tx - width, ty + 20, tx + width, ty + 20, tx + width * 0.7, 112, tx - width * 0.7, 112);
    // Glowing molten/rock core crack lines
    G.setColor(0.85, 0.35, 0.10, a * 0.80);
    G.setLineWidth(2);
    G.line(tx - width, ty + 20, tx, ty + 35, tx + width, ty + 20);
    G.setLineWidth(1);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.PositionFissureBgOnBattler = AnimTasks.PositionFissureBgOnBattler;
AnimTasks.REGISTRY.AnimTask_PositionFissureBgOnBattler = AnimTasks.PositionFissureBgOnBattler;

// Lua: anim_tasks.lua:3532
//- pret SetPsychicBackground (Psychic, Psybeam, Teleport, Skill Swap, Extrasensory)
AnimTasks.SetPsychicBackground = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 32;
  t.z = AnimSprites.Z.GLOBAL_BEHIND;

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    // Cosmic psychic distortion background
    G.setColor(0.35, 0.05, 0.45, a * 0.50);
    G.rectangle("fill", 0, 0, 240, 112);
    // Warping psychic concentric rings
    G.setColor(0.85, 0.35, 0.95, a * 0.40);
    G.setLineWidth(1.5);
    const [cx, cy] = vm.battlerCenter("target");
    for (let r = 16; r <= 80; r += 16) {
      const rad = mod(r + f * 2, 80);
      G.circle("line", cx, cy, rad);
    }
    G.setLineWidth(1);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.SetPsychicBackground = AnimTasks.SetPsychicBackground;
AnimTasks.REGISTRY.UnsetPsychicBackground = stub_task;

// Lua: anim_tasks.lua:3565
//- pret AnimTask_HeartsBackground (Attract)
AnimTasks.HeartsBackground = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 36;
  t.z = AnimSprites.Z.GLOBAL_BEHIND;

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    // Pink ambient glow
    G.setColor(0.95, 0.40, 0.65, a * 0.30);
    G.rectangle("fill", 0, 0, 240, 112);
    // Floating background hearts
    G.setColor(1.00, 0.45, 0.70, a * 0.75);
    for (let i = 0; i <= 6; i++) {
      const hx = mod(i * 40 + f * 2, 250) - 10;
      const hy = mod(i * 20 + Math.floor(Sin(mod(hx + f * 4, 256), 8)), 100) + 10;
      G.circle("fill", hx - 3, hy, 4);
      G.circle("fill", hx + 3, hy, 4);
      G.polygon("fill", hx - 6, hy + 2, hx + 6, hy + 2, hx, hy + 8);
    }
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.HeartsBackground = AnimTasks.HeartsBackground;
AnimTasks.REGISTRY.AnimTask_HeartsBackground = AnimTasks.HeartsBackground;

// Lua: anim_tasks.lua:3598
//- pret AnimTask_ScaryFace (pokefirered/src/battle_anim_effects_2.c:3360)
AnimTasks.ScaryFace = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 32;
  t.z = AnimSprites.Z.MID_FIELD;
  const [tx, ty] = vm.battlerCenter("target");

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    const scale = 0.6 + (f / dur) * 0.8;
    // Looming dark shadowy phantom mask zooming behind target
    G.setColor(0.10, 0.02, 0.15, a * 0.70);
    G.circle("fill", tx, ty, 32 * scale);
    // Glowing demonic red eyes
    G.setColor(0.95, 0.15, 0.10, a * 0.95);
    G.circle("fill", tx - 12 * scale, ty - 6 * scale, 4 * scale);
    G.circle("fill", tx + 12 * scale, ty - 6 * scale, 4 * scale);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.ScaryFace = AnimTasks.ScaryFace;
AnimTasks.REGISTRY.AnimTask_ScaryFace = AnimTasks.ScaryFace;

// Lua: anim_tasks.lua:3628
//- pret AnimTask_CreateRaindrops (Rain Dance)
AnimTasks.CreateRaindrops = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 36;
  t.z = AnimSprites.Z.GLOBAL_FRONT;

  if (!t._particles) {
    t._particles = lseq();
    for (let _ = 1; _ <= 18; _++) {
      t._particles[len(t._particles) + 1] = {
        x: random(-20, 240),
        y: random(-20, 100),
        vx: -4.0,
        vy: 7.0,
        len: random(10, 18),
      };
    }
  }

  if (t._particles) {
    const ps = t._particles;
    const n = len(ps);
    for (let i = 1; i <= n; i++) {
      const p = ps[i];
      p.x = p.x + p.vx;
      p.y = p.y + p.vy;
      if (p.y > 115 || p.x < -20) {
        p.x = random(60, 260);
        p.y = -15;
      }
    }
  }

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    if (!task._particles) return;
    const f = task.data[14] ?? 1;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    G.setColor(0.60, 0.80, 1.00, a * 0.70);
    G.setLineWidth(1.5);
    const ps = task._particles;
    const n = len(ps);
    for (let i = 1; i <= n; i++) {
      const p = ps[i];
      G.line(p.x, p.y, p.x + p.vx * 1.5, p.y + p.vy * 1.5);
    }
    G.setLineWidth(1);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.CreateRaindrops = AnimTasks.CreateRaindrops;
AnimTasks.REGISTRY.AnimTask_CreateRaindrops = AnimTasks.CreateRaindrops;


//- Subsystem B: Shadow Clones, Afterimages & Silhouette Transfers

// Lua: anim_tasks.lua:3683
//- pret AnimTask_NightShadeClone & NightmareClone (pokefirered/src/battle_anim_ghost.c:280)
AnimTasks.NightShadeClone = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 32;
  t.z = AnimSprites.Z.MID_FIELD;
  const atkSide = vm.attackerSide();
  const [ax, ay] = vm.battlerCenter(atkSide);

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    const scale = 1.0 + (f / dur) * 0.5;
    // Dark rising shadow silhouette clone
    G.setColor(0.08, 0.04, 0.12, a * 0.80);
    G.circle("fill", ax + 6, ay - 8, 28 * scale);
    G.setColor(0.85, 0.10, 0.10, a * 0.90);
    G.circle("fill", ax - 4, ay - 14, 3);
    G.circle("fill", ax + 14, ay - 14, 3);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.NightShadeClone = AnimTasks.NightShadeClone;
AnimTasks.REGISTRY.AnimTask_NightShadeClone = AnimTasks.NightShadeClone;
AnimTasks.REGISTRY.NightmareClone = AnimTasks.NightShadeClone;
AnimTasks.REGISTRY.AnimTask_NightmareClone = AnimTasks.NightShadeClone;

// Lua: anim_tasks.lua:3716
//- pret AnimTask_DestinyBondWhiteShadow
AnimTasks.DestinyBondWhiteShadow = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 30;
  t.z = AnimSprites.Z.GLOBAL_BEHIND;
  const [ax, ay] = vm.battlerCenter(vm.attackerSide());

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    const rad = Math.min(32, f * 1.5);
    G.setColor(0.95, 0.98, 1.00, a * 0.65);
    G.ellipse("fill", ax, ay + 24, rad, rad * 0.4);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.DestinyBondWhiteShadow = AnimTasks.DestinyBondWhiteShadow;
AnimTasks.REGISTRY.AnimTask_DestinyBondWhiteShadow = AnimTasks.DestinyBondWhiteShadow;

// Lua: anim_tasks.lua:3741
//- pret Memento Tasks (InitMementoShadow, MoveAttackerMementoShadow, MementoHandleBg, MoveTargetMementoShadow)
AnimTasks.MementoShadow = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 32;
  t.z = AnimSprites.Z.MID_FIELD;
  const [ax, ay] = vm.battlerCenter(vm.attackerSide());
  const [tx, ty] = vm.battlerCenter("target");

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const u = Math.min(1.0, f / 24);
    const curX = ax + (tx - ax) * u;
    const curY = ay + (ty - ay) * u;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    G.setColor(0.06, 0.02, 0.08, a * 0.85);
    G.ellipse("fill", curX, curY + 20, 24, 10);
    G.circle("fill", curX, curY, 16);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.InitMementoShadow = AnimTasks.MementoShadow;
AnimTasks.REGISTRY.MoveAttackerMementoShadow = AnimTasks.MementoShadow;
AnimTasks.REGISTRY.MementoHandleBg = AnimTasks.MementoShadow;
AnimTasks.REGISTRY.MoveTargetMementoShadow = AnimTasks.MementoShadow;
AnimTasks.REGISTRY.SpiteTargetShadow = AnimTasks.MementoShadow;

// Lua: anim_tasks.lua:3773
//- pret RolePlaySilhouette
AnimTasks.RolePlaySilhouette = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 28;
  t.z = AnimSprites.Z.MID_FIELD;
  const [ax, ay] = vm.battlerCenter(vm.attackerSide());
  const [tx, ty] = vm.battlerCenter("target");

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const u = Math.min(1.0, f / 20);
    const curX = tx + (ax - tx) * u;
    const curY = ty + (ay - ty) * u;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    G.setColor(0.40, 0.85, 0.95, a * 0.50);
    G.circle("fill", curX, curY, 24);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.RolePlaySilhouette = AnimTasks.RolePlaySilhouette;
AnimTasks.REGISTRY.AnimTask_RolePlaySilhouette = AnimTasks.RolePlaySilhouette;
AnimTasks.REGISTRY.TransparentCloneGrowAndShrink = AnimTasks.RolePlaySilhouette;


//- Subsystem C: Screen Distortions, Spotlights & Lighting

// Lua: anim_tasks.lua:3805
//- pret ExtrasensoryDistortion & UproarDistortion
AnimTasks.ScreenDistortionWobble = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 24;
  const u = Math.sin((frame / dur) * Math.PI);
  Anim.setScreenEffect({ type: "custom_blend", coeff: u * 0.35, targetColor: lseq(0.7, 0.3, 0.9) });

  if (frame >= dur) {
    Anim.setScreenEffect(null);
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.ExtrasensoryDistortion = AnimTasks.ScreenDistortionWobble;
AnimTasks.REGISTRY.AnimTask_ExtrasensoryDistortion = AnimTasks.ScreenDistortionWobble;
AnimTasks.REGISTRY.UproarDistortion = AnimTasks.ScreenDistortionWobble;
AnimTasks.REGISTRY.AnimTask_UproarDistortion = AnimTasks.ScreenDistortionWobble;

// Lua: anim_tasks.lua:3824
//- pret CreateSpotlight & RemoveSpotlight (Spotlight, Follow Me)
AnimTasks.Spotlight = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 32;
  t.z = AnimSprites.Z.GLOBAL_FRONT;
  const [tx, ty] = vm.battlerCenter(vm.resolveBattlerSide("target"));

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    // Elliptical yellow spotlight cone shining down from top
    G.setColor(1.00, 0.95, 0.60, a * 0.45);
    G.polygon("fill", 120, -10, tx - 32, ty + 24, tx + 32, ty + 24);
    G.ellipse("fill", tx, ty + 24, 32, 12);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.CreateSpotlight = AnimTasks.Spotlight;
AnimTasks.REGISTRY.AnimTask_CreateSpotlight = AnimTasks.Spotlight;
AnimTasks.REGISTRY.RemoveSpotlight = stub_task;
AnimTasks.REGISTRY.AnimTask_RemoveSpotlight = stub_task;

// Lua: anim_tasks.lua:3852
//- pret MorningSunLightBeam & MoonlightEndFade
AnimTasks.MorningSunLightBeam = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 32;
  t.z = AnimSprites.Z.GLOBAL_FRONT;
  const [ax, ay] = vm.battlerCenter(vm.attackerSide());

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    // Divine descending sunbeams
    G.setColor(1.00, 0.98, 0.70, a * 0.50);
    G.polygon("fill", ax - 10, -10, ax + 10, -10, ax + 36, ay + 30, ax - 36, ay + 30);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.MorningSunLightBeam = AnimTasks.MorningSunLightBeam;
AnimTasks.REGISTRY.AnimTask_MorningSunLightBeam = AnimTasks.MorningSunLightBeam;
AnimTasks.REGISTRY.MoonlightEndFade = stub_task;

// Lua: anim_tasks.lua:3878
//- pret GlareEyeDots (Glare)
AnimTasks.GlareEyeDots = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 28;
  t.z = AnimSprites.Z.GLOBAL_FRONT;
  const [ax, ay] = vm.battlerCenter(vm.attackerSide());

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const a = (f <= 4) ? (f / 4) : ((f >= dur - 4) ? ((dur - f) / 4) : 1.0);
    // Piercing glowing crimson eyes
    G.setColor(1.00, 0.15, 0.15, a * 0.95);
    G.circle("fill", ax - 6, ay - 10, 3);
    G.circle("fill", ax + 6, ay - 10, 3);
    G.setColor(1.00, 0.85, 0.85, a * 0.90);
    G.circle("fill", ax - 6, ay - 10, 1.2);
    G.circle("fill", ax + 6, ay - 10, 1.2);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) {
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.GlareEyeDots = AnimTasks.GlareEyeDots;
AnimTasks.REGISTRY.AnimTask_GlareEyeDots = AnimTasks.GlareEyeDots;

// Lua: anim_tasks.lua:3907
//- pret ElectricChargingParticles, DrillPeckHitSplats, GrudgeFlames, BarrageBall
AnimTasks.GenericCombatFX = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 24;
  if (frame >= dur) destroy_task(t);
};
AnimTasks.REGISTRY.ElectricChargingParticles = AnimTasks.GenericCombatFX;
AnimTasks.REGISTRY.DrillPeckHitSplats = AnimTasks.GenericCombatFX;
AnimTasks.REGISTRY.GrudgeFlames = AnimTasks.GenericCombatFX;
AnimTasks.REGISTRY.BarrageBall = AnimTasks.GenericCombatFX;
AnimTasks.REGISTRY.StatusClearedEffect = AnimTasks.GenericCombatFX;
AnimTasks.REGISTRY.RapinSpinMonElevation = AnimTasks.GenericCombatFX;
AnimTasks.REGISTRY.ImprisonOrbs = AnimTasks.GenericCombatFX;
AnimTasks.REGISTRY.SketchDrawMon = AnimTasks.GenericCombatFX;
AnimTasks.REGISTRY.SkillSwap = AnimTasks.GenericCombatFX;
AnimTasks.REGISTRY.Teleport = AnimTasks.GenericCombatFX;
AnimTasks.REGISTRY.ConversionAlphaBlend = AnimTasks.GenericCombatFX;
AnimTasks.REGISTRY.Conversion2AlphaBlend = AnimTasks.GenericCombatFX;
AnimTasks.REGISTRY.RotateAuroraRingColors = AnimTasks.GenericCombatFX;
AnimTasks.REGISTRY.AnimateGustTornadoPalette = AnimTasks.GenericCombatFX;
AnimTasks.REGISTRY.MusicNotesClearRainbowBlend = AnimTasks.GenericCombatFX;
AnimTasks.REGISTRY.LoadMusicNotesPals = AnimTasks.GenericCombatFX;
AnimTasks.REGISTRY.FreeMusicNotesPals = AnimTasks.GenericCombatFX;
AnimTasks.REGISTRY.AllocBackupPalBuffer = stub_task;
AnimTasks.REGISTRY.FreeBackupPalBuffer = stub_task;
AnimTasks.REGISTRY.CopyPalUnfadedFromBackup = stub_task;
AnimTasks.REGISTRY.BlendBackground = stub_task;
AnimTasks.REGISTRY.StartSinAnimTimer = stub_task;
AnimTasks.REGISTRY.SetAttackerInvisibleWaitForSignal = stub_task;
AnimTasks.REGISTRY.InitAttackerFadeFromInvisible = stub_task;
AnimTasks.REGISTRY.VoltTackleAttackerReappear = stub_task;


//- Subsystem D: Battler Movement & Metadata Evaluators

// Lua: anim_tasks.lua:3942
AnimTasks.AttackerPunchWithTrace = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 20;
  const pAtk = Anim.present(vm.attackerSide());
  if (frame < 10 && pAtk) {
    pAtk.ox = Math.floor(Math.sin((frame / 10) * Math.PI) * 12);
  } else if (frame >= 10 && pAtk) {
    pAtk.ox = 0;
  }
  if (frame >= dur) {
    if (pAtk) pAtk.ox = 0;
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.AttackerPunchWithTrace = AnimTasks.AttackerPunchWithTrace;
AnimTasks.REGISTRY.HelpingHandAttackerMovement = AnimTasks.AttackerPunchWithTrace;
AnimTasks.REGISTRY.TeeterDanceMovement = AnimTasks.AttackerPunchWithTrace;
AnimTasks.REGISTRY.FlailMovement = AnimTasks.AttackerPunchWithTrace;
AnimTasks.REGISTRY.OdorSleuthMovement = AnimTasks.AttackerPunchWithTrace;
AnimTasks.REGISTRY.TormentAttacker = AnimTasks.AttackerPunchWithTrace;
AnimTasks.REGISTRY.Rollout = AnimTasks.AttackerPunchWithTrace;
AnimTasks.REGISTRY.LeafBlade = AnimTasks.AttackerPunchWithTrace;

// Lua: anim_tasks.lua:3968
//- Dynamic Metadata and Query Evaluators
AnimTasks.QueryStateTask = function (t: AnimTask, _vm: any): void {
  destroy_task(t);
};
AnimTasks.REGISTRY.GetRolloutCounter = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.GetFuryCutterHitCount = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.IsFuryCutterHitRight = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.GetReturnPowerLevel = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.GetFrustrationPowerLevel = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.GetSeismicTossDamageLevel = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.IsPowerOver99 = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.GetBattleTerrain = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.GetWeather = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.IsContest = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.IsTargetPlayerSide = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.GetIsDoomDesireHitTurn = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.IsHealingMove = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.IsAttackerBehindSubstitute = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.IsBallBlockedByTrainerOrDodged = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.IsMonInvisible = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.IsTargetSameSide = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.GetBattlersFromArg = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.GetTrappedMoveAnimId = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.SnatchOpposingMonMove = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.SnatchPartnerMove = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.SetAnimAttackerAndTargetForEffectAtk = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.SetAnimAttackerAndTargetForEffectTgt = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.SetAnimTargetToBattlerTarget = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.SetTargetToEffectBattler = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.SafariGetReaction = AnimTasks.QueryStateTask;
AnimTasks.REGISTRY.SafariOrGhost_DecideAnimSides = AnimTasks.QueryStateTask;

// =========================================================================
// Pret Alignment: Movement, Special Combat, Buffers & System Subroutines
// =========================================================================

// Lua: anim_tasks.lua:4004
//- pret AnimTask_DigDownMovement & AnimTask_DigUpMovement (battle_anim_ground.c)
AnimTasks.DigDownMovement = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 24;
  const p = Anim.present(vm.attackerSide());
  const isDisappear = (tonumber(t.data[0]) ?? 0) !== 0;
  if (p) {
    if (!isDisappear) {
      // Bounce down into hole
      const u = frame / dur;
      p.oy = Math.floor(u * 32);
      p.alpha = Math.max(0, 1.0 - u * 1.2);
    } else {
      p.oy = 40;
      p.invisible = true;
    }
  }
  if (frame >= dur) {
    if (p) p.invisible = true;
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.DigDownMovement = AnimTasks.DigDownMovement;
AnimTasks.REGISTRY.AnimTask_DigDownMovement = AnimTasks.DigDownMovement;

// Lua: anim_tasks.lua:4030
AnimTasks.DigUpMovement = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 20;
  const p = Anim.present(vm.attackerSide());
  const isRise = (tonumber(t.data[0]) ?? 0) !== 0;
  if (p) {
    p.invisible = false;
    if (isRise) {
      const u = 1.0 - (frame / dur);
      p.oy = Math.floor(u * 32);
      p.alpha = Math.min(1.0, (frame / dur) * 1.5);
    } else {
      p.oy = 0;
      p.alpha = 1.0;
    }
  }
  if (frame >= dur) {
    if (p) { p.oy = 0; p.alpha = 1.0; p.invisible = false; }
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.DigUpMovement = AnimTasks.DigUpMovement;
AnimTasks.REGISTRY.AnimTask_DigUpMovement = AnimTasks.DigUpMovement;

// Lua: anim_tasks.lua:4057
//- pret AnimTask_SkullBashPosition (battle_anim_effects_1.c)
AnimTasks.SkullBashPosition = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 16;
  const side = vm.attackerSide();
  const p = Anim.present(side);
  const modeArg = tonumber(t.data[0]) ?? 0;
  const dir = (side === "player") ? -1 : 1;
  if (p) {
    if (modeArg === 0) {
      // Step back to charge
      const u = Math.min(1.0, frame / dur);
      p.ox = Math.floor(dir * 10 * u);
    } else {
      // Rush forward
      const u = Math.min(1.0, frame / dur);
      p.ox = Math.floor(-dir * 16 * (1.0 - u));
    }
  }
  if (frame >= dur) {
    if (p && modeArg !== 0) p.ox = 0;
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.SkullBashPosition = AnimTasks.SkullBashPosition;
AnimTasks.REGISTRY.AnimTask_SkullBashPosition = AnimTasks.SkullBashPosition;

// Lua: anim_tasks.lua:4086
//- pret AnimTask_ExtremeSpeedImpact & AnimTask_ExtremeSpeedMonReappear (battle_anim_effects_2.c)
AnimTasks.ExtremeSpeedImpact = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 18;
  const p = Anim.present(vm.targetSide());
  if (p) {
    const phase = mod(frame, 4);
    const amp = Math.max(1, 8 - Math.floor(frame / 2));
    p.ox = (phase < 2) ? amp : -amp;
  }
  if (frame >= dur) {
    if (p) p.ox = 0;
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.ExtremeSpeedImpact = AnimTasks.ExtremeSpeedImpact;
AnimTasks.REGISTRY.AnimTask_ExtremeSpeedImpact = AnimTasks.ExtremeSpeedImpact;

// Lua: anim_tasks.lua:4105
AnimTasks.ExtremeSpeedMonReappear = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 14;
  const p = Anim.present(vm.attackerSide());
  if (p) {
    p.invisible = (mod(frame, 2) === 1);
  }
  if (frame >= dur) {
    if (p) p.invisible = false;
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.ExtremeSpeedMonReappear = AnimTasks.ExtremeSpeedMonReappear;
AnimTasks.REGISTRY.AnimTask_ExtremeSpeedMonReappear = AnimTasks.ExtremeSpeedMonReappear;

// Lua: anim_tasks.lua:4123
//- pret AnimTask_AttackerStretchAndDisappear (battle_anim_effects_2.c)
AnimTasks.AttackerStretchAndDisappear = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 18;
  const p = Anim.present(vm.attackerSide());
  if (p) {
    const u = frame / dur;
    p.sy = 1.0 + u * 0.8;
    p.sx = Math.max(0.1, 1.0 - u * 0.8);
    p.alpha = Math.max(0, 1.0 - u);
  }
  if (frame >= dur) {
    if (p) { p.sx = 1.0; p.sy = 1.0; p.invisible = true; }
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.AttackerStretchAndDisappear = AnimTasks.AttackerStretchAndDisappear;
AnimTasks.REGISTRY.AnimTask_AttackerStretchAndDisappear = AnimTasks.AttackerStretchAndDisappear;

// Lua: anim_tasks.lua:4144
//- pret AnimTask_SlideMonForFocusBand (battle_anim_effects_3.c)
AnimTasks.SlideMonForFocusBand = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 16;
  const p = Anim.present(vm.attackerSide());
  const dir = (vm.attackerSide() === "player") ? -1 : 1;
  if (p) {
    const u = Math.sin((frame / dur) * Math.PI);
    p.ox = Math.floor(dir * 10 * u);
  }
  if (frame >= dur) {
    if (p) p.ox = 0;
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.SlideMonForFocusBand = AnimTasks.SlideMonForFocusBand;
AnimTasks.REGISTRY.AnimTask_SlideMonForFocusBand = AnimTasks.SlideMonForFocusBand;

// Lua: anim_tasks.lua:4164
//- pret AnimTask_SpeedDust (battle_anim_effects_2.c)
AnimTasks.SpeedDust = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 20;
  t.z = AnimSprites.Z.GLOBAL_FRONT;
  const [ax, ay] = vm.battlerCenter(vm.attackerSide());

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const a = Math.max(0, 1.0 - (f / dur));
    G.setColor(0.85, 0.80, 0.70, a * 0.75);
    for (let i = 0; i <= 3; i++) {
      const dx = (i * 12 - f * 1.5);
      G.circle("fill", ax + dx, ay + 22, 3 + (f * 0.2));
    }
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) destroy_task(t);
};
AnimTasks.REGISTRY.SpeedDust = AnimTasks.SpeedDust;
AnimTasks.REGISTRY.AnimTask_SpeedDust = AnimTasks.SpeedDust;

// Lua: anim_tasks.lua:4189
//- pret AnimTask_ThrashMoveMonHorizontal & AnimTask_ThrashMoveMonVertical (battle_anim_effects_2.c)
AnimTasks.ThrashMoveMonHorizontal = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 24;
  const p = Anim.present(vm.attackerSide());
  if (p) {
    p.ox = Math.floor(Math.sin(frame * 0.8) * 12);
  }
  if (frame >= dur) {
    if (p) p.ox = 0;
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.ThrashMoveMonHorizontal = AnimTasks.ThrashMoveMonHorizontal;
AnimTasks.REGISTRY.AnimTask_ThrashMoveMonHorizontal = AnimTasks.ThrashMoveMonHorizontal;

// Lua: anim_tasks.lua:4206
AnimTasks.ThrashMoveMonVertical = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 24;
  const p = Anim.present(vm.attackerSide());
  if (p) {
    p.oy = Math.floor(Math.sin(frame * 0.8) * 8);
  }
  if (frame >= dur) {
    if (p) p.oy = 0;
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.ThrashMoveMonVertical = AnimTasks.ThrashMoveMonVertical;
AnimTasks.REGISTRY.AnimTask_ThrashMoveMonVertical = AnimTasks.ThrashMoveMonVertical;

// Lua: anim_tasks.lua:4224
//- pret AnimTask_MoveHeatWaveTargets (battle_anim_fire.c)
AnimTasks.MoveHeatWaveTargets = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 32;
  const p = Anim.present(vm.targetSide());
  if (p) {
    p.ox = Math.floor(Math.sin(frame * 0.6) * 6);
  }
  if (frame >= dur) {
    if (p) p.ox = 0;
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.MoveHeatWaveTargets = AnimTasks.MoveHeatWaveTargets;
AnimTasks.REGISTRY.AnimTask_MoveHeatWaveTargets = AnimTasks.MoveHeatWaveTargets;

// Lua: anim_tasks.lua:4242
//- pret AnimTask_DeepInhale (battle_anim_effects_3.c)
AnimTasks.DeepInhale = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 24;
  const p = Anim.present(vm.attackerSide());
  if (p) {
    const u = Math.sin((frame / dur) * Math.PI);
    p.sx = 1.0 + u * 0.25;
    p.sy = 1.0 + u * 0.15;
  }
  if (frame >= dur) {
    if (p) { p.sx = 1.0; p.sy = 1.0; }
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.DeepInhale = AnimTasks.DeepInhale;
AnimTasks.REGISTRY.AnimTask_DeepInhale = AnimTasks.DeepInhale;

// Lua: anim_tasks.lua:4262
//- pret AnimTask_WaterSpoutLaunch & AnimTask_WaterSpoutRain (battle_anim_water.c)
AnimTasks.WaterSpoutLaunch = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 32;
  t.z = AnimSprites.Z.MID_FIELD;
  const [ax, ay] = vm.battlerCenter(vm.attackerSide());

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    const height = Math.min(112, f * 6);
    G.setColor(0.20, 0.55, 0.95, a * 0.80);
    G.rectangle("fill", ax - 24, ay + 20 - height, 48, height);
    G.setColor(0.70, 0.90, 1.00, a * 0.90);
    G.rectangle("fill", ax - 16, ay + 20 - height, 32, height);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) destroy_task(t);
};
AnimTasks.REGISTRY.WaterSpoutLaunch = AnimTasks.WaterSpoutLaunch;
AnimTasks.REGISTRY.AnimTask_WaterSpoutLaunch = AnimTasks.WaterSpoutLaunch;

// Lua: anim_tasks.lua:4286
AnimTasks.WaterSpoutRain = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 36;
  t.z = AnimSprites.Z.GLOBAL_FRONT;

  if (!t._particles) {
    t._particles = lseq();
    for (let _ = 1; _ <= 24; _++) {
      t._particles[len(t._particles) + 1] = {
        x: random(10, 230),
        y: random(-30, 20),
        vy: random(5, 9),
      };
    }
  }

  {
    const ps = t._particles;
    const n = len(ps);
    for (let i = 1; i <= n; i++) {
      const p = ps[i];
      p.y = p.y + p.vy;
      if (p.y > 115) { p.y = -15; p.x = random(10, 230); }
    }
  }

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    if (!task._particles) return;
    const f = task.data[14] ?? 1;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    G.setColor(0.35, 0.70, 1.00, a * 0.85);
    G.setLineWidth(2);
    const ps = task._particles;
    const n = len(ps);
    for (let i = 1; i <= n; i++) {
      const p = ps[i];
      G.line(p.x, p.y, p.x, p.y + 12);
    }
    G.setLineWidth(1);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) destroy_task(t);
};
AnimTasks.REGISTRY.WaterSpoutRain = AnimTasks.WaterSpoutRain;
AnimTasks.REGISTRY.AnimTask_WaterSpoutRain = AnimTasks.WaterSpoutRain;

// Lua: anim_tasks.lua:4328
//- pret AnimTask_DoomDesireLightBeam (battle_anim_effects_3.c)
AnimTasks.DoomDesireLightBeam = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 36;
  t.z = AnimSprites.Z.GLOBAL_FRONT;
  const [tx, ty] = vm.battlerCenter("target");

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    G.setColor(1.00, 0.95, 0.40, a * 0.75);
    G.polygon("fill", tx - 8, -10, tx + 8, -10, tx + 24, ty + 24, tx - 24, ty + 24);
    G.setColor(1.00, 1.00, 0.90, a * 0.90);
    G.polygon("fill", tx - 3, -10, tx + 3, -10, tx + 10, ty + 24, tx - 10, ty + 24);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) destroy_task(t);
};
AnimTasks.REGISTRY.DoomDesireLightBeam = AnimTasks.DoomDesireLightBeam;
AnimTasks.REGISTRY.AnimTask_DoomDesireLightBeam = AnimTasks.DoomDesireLightBeam;

// Lua: anim_tasks.lua:4352
//- pret AnimTask_AirCutterProjectile (battle_anim_effects_2.c)
AnimTasks.AirCutterProjectile = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 20;
  t.z = AnimSprites.Z.GLOBAL_FRONT;
  const [ax, ay] = vm.battlerCenter(vm.attackerSide());
  const [tx, ty] = vm.battlerCenter("target");

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const u = Math.min(1.0, f / dur);
    const cx = ax + (tx - ax) * u;
    const cy = ay + (ty - ay) * u;
    const a = (f <= 4) ? (f / 4) : ((f >= dur - 4) ? ((dur - f) / 4) : 1.0);
    G.setColor(0.70, 0.95, 0.90, a * 0.90);
    G.setLineWidth(2);
    G.arc("line", cx, cy, 18, -Math.PI * 0.4, Math.PI * 0.4);
    G.setLineWidth(1);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) destroy_task(t);
};
AnimTasks.REGISTRY.AirCutterProjectile = AnimTasks.AirCutterProjectile;
AnimTasks.REGISTRY.AnimTask_AirCutterProjectile = AnimTasks.AirCutterProjectile;

// Lua: anim_tasks.lua:4380
//- pret AnimTask_CreateSmallSolarBeamOrbs (battle_anim_effects_1.c)
AnimTasks.CreateSmallSolarBeamOrbs = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 32;
  t.z = AnimSprites.Z.GLOBAL_FRONT;
  const [ax, ay] = vm.battlerCenter(vm.attackerSide());

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    G.setColor(1.00, 0.90, 0.30, a * 0.85);
    for (let i = 0; i <= 7; i++) {
      const angle = (i / 8) * Math.PI * 2 + (f * 0.1);
      const r = Math.max(4, 36 - (f * 1.0));
      const px = ax + Math.cos(angle) * r;
      const py = ay + Math.sin(angle) * r;
      G.circle("fill", px, py, 2.5);
    }
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) destroy_task(t);
};
AnimTasks.REGISTRY.CreateSmallSolarBeamOrbs = AnimTasks.CreateSmallSolarBeamOrbs;
AnimTasks.REGISTRY.AnimTask_CreateSmallSolarBeamOrbs = AnimTasks.CreateSmallSolarBeamOrbs;

// Lua: anim_tasks.lua:4408
//- pret AnimTask_CurseStretchingBlackBg (battle_anim_ghost.c)
AnimTasks.CurseStretchingBlackBg = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 32;
  t.z = AnimSprites.Z.GLOBAL_BEHIND;

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const a = (f <= 6) ? (f / 6) : ((f >= dur - 6) ? ((dur - f) / 6) : 1.0);
    const height = Math.min(112, f * 4);
    G.setColor(0.05, 0.02, 0.08, a * 0.75);
    G.rectangle("fill", 0, 56 - height / 2, 240, height);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) destroy_task(t);
};
AnimTasks.REGISTRY.CurseStretchingBlackBg = AnimTasks.CurseStretchingBlackBg;
AnimTasks.REGISTRY.AnimTask_CurseStretchingBlackBg = AnimTasks.CurseStretchingBlackBg;

// Lua: anim_tasks.lua:4430
//- pret AnimTask_CastformGfxChange & AnimTask_MusicNotesRainbowBlend (battle_anim_effects_3.c & 1.c)
AnimTasks.CastformGfxChange = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 20;
  if (frame >= dur) destroy_task(t);
};
AnimTasks.REGISTRY.CastformGfxChange = AnimTasks.CastformGfxChange;
AnimTasks.REGISTRY.AnimTask_CastformGfxChange = AnimTasks.CastformGfxChange;
AnimTasks.REGISTRY.MusicNotesRainbowBlend = AnimTasks.CastformGfxChange;
AnimTasks.REGISTRY.AnimTask_MusicNotesRainbowBlend = AnimTasks.CastformGfxChange;

// Lua: anim_tasks.lua:4442
//- pret AnimTask_AlphaFadeIn (battle_anim_mons.c)
AnimTasks.AlphaFadeIn = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = Math.max(8, tonumber(t.data[0]) ?? 16);
  if (frame >= dur) destroy_task(t);
};
AnimTasks.REGISTRY.AlphaFadeIn = AnimTasks.AlphaFadeIn;
AnimTasks.REGISTRY.AnimTask_AlphaFadeIn = AnimTasks.AlphaFadeIn;

// Lua: anim_tasks.lua:4452
//- pret AnimTask_DrawFallingWhiteLinesOnAttacker (battle_anim_utility_funcs.c)
AnimTasks.DrawFallingWhiteLinesOnAttacker = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 24;
  t.z = AnimSprites.Z.GLOBAL_FRONT;
  const [ax, ay] = vm.battlerCenter(vm.attackerSide());

  t.draw = function (task: AnimTask, _vm2: any): void {
    // (love.graphics guard dropped: the platform always has graphics.)
    const f = task.data[14] ?? 1;
    const a = (f <= 4) ? (f / 4) : ((f >= dur - 4) ? ((dur - f) / 4) : 1.0);
    G.setColor(1, 1, 1, a * 0.85);
    G.setLineWidth(1.5);
    for (let i = -2; i <= 2; i++) {
      const lx = ax + (i * 10);
      const ly = mod(ay - 24 + f * 3 + i * 4, 64) + (ay - 32);
      G.line(lx, ly, lx, ly + 14);
    }
    G.setLineWidth(1);
    G.setColor(1, 1, 1, 1);
  };

  if (frame >= dur) destroy_task(t);
};
AnimTasks.REGISTRY.DrawFallingWhiteLinesOnAttacker = AnimTasks.DrawFallingWhiteLinesOnAttacker;
AnimTasks.REGISTRY.AnimTask_DrawFallingWhiteLinesOnAttacker = AnimTasks.DrawFallingWhiteLinesOnAttacker;

// Lua: anim_tasks.lua:4480
//- pret AnimTask_GrowAndGrayscale & AnimTask_ShrinkTargetCopy (battle_anim_effects_2.c & 1.c)
AnimTasks.GrowAndGrayscale = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 24;
  const p = Anim.present(vm.attackerSide());
  if (p) {
    const u = frame / dur;
    p.sx = 1.0 + u * 0.3;
    p.sy = 1.0 + u * 0.3;
    p.grayscale = u;
  }
  if (frame >= dur) {
    if (p) { p.sx = 1.0; p.sy = 1.0; p.grayscale = 0; }
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.GrowAndGrayscale = AnimTasks.GrowAndGrayscale;
AnimTasks.REGISTRY.AnimTask_GrowAndGrayscale = AnimTasks.GrowAndGrayscale;

// Lua: anim_tasks.lua:4500
AnimTasks.ShrinkTargetCopy = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 20;
  const p = Anim.present(vm.targetSide());
  if (p) {
    const u = 1.0 - (frame / dur);
    p.sx = Math.max(0.1, u);
    p.sy = Math.max(0.1, u);
    p.alpha = Math.max(0, u);
  }
  if (frame >= dur) {
    if (p) { p.sx = 1.0; p.sy = 1.0; p.alpha = 1.0; }
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.ShrinkTargetCopy = AnimTasks.ShrinkTargetCopy;
AnimTasks.REGISTRY.AnimTask_ShrinkTargetCopy = AnimTasks.ShrinkTargetCopy;

// Lua: anim_tasks.lua:4521
//- pret AnimTask_StrongFrustrationGrowAndShrink & AnimTask_SquishAndSweatDroplets (battle_anim_effects_3.c)
AnimTasks.StrongFrustrationGrowAndShrink = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 24;
  const p = Anim.present(vm.attackerSide());
  if (p) {
    const u = Math.sin((frame / dur) * Math.PI);
    p.sx = 1.0 + u * 0.35;
    p.sy = 1.0 + u * 0.35;
    p.blendColor = lseq(1.0, 0.2, 0.2);
    p.blendCoeff = u * 0.6;
  }
  if (frame >= dur) {
    if (p) { p.sx = 1.0; p.sy = 1.0; p.blendCoeff = 0; }
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.StrongFrustrationGrowAndShrink = AnimTasks.StrongFrustrationGrowAndShrink;
AnimTasks.REGISTRY.AnimTask_StrongFrustrationGrowAndShrink = AnimTasks.StrongFrustrationGrowAndShrink;

// Lua: anim_tasks.lua:4542
AnimTasks.SquishAndSweatDroplets = function (t: AnimTask, vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 20;
  const p = Anim.present(vm.attackerSide());
  if (p) {
    const u = Math.sin((frame / dur) * Math.PI);
    p.sy = 1.0 - u * 0.3;
    p.sx = 1.0 + u * 0.2;
  }
  if (frame >= dur) {
    if (p) { p.sx = 1.0; p.sy = 1.0; }
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.SquishAndSweatDroplets = AnimTasks.SquishAndSweatDroplets;
AnimTasks.REGISTRY.AnimTask_SquishAndSweatDroplets = AnimTasks.SquishAndSweatDroplets;

// Lua: anim_tasks.lua:4562
//- pret AnimTask_StartSlidingBg & AnimTask_StatsChange
AnimTasks.StartSlidingBg = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 32;
  if (frame >= dur) destroy_task(t);
};
AnimTasks.REGISTRY.StartSlidingBg = AnimTasks.StartSlidingBg;
AnimTasks.REGISTRY.AnimTask_StartSlidingBg = AnimTasks.StartSlidingBg;

const STAT_ANIM_ID: Record<number, number> = { 1: 0, 2: 1, 3: 3, 4: 5, 5: 6, 6: 2, 7: 4 };

// Lua: anim_tasks.lua:4574
// pokefirered/src/battle_anim_status_effects.c:455
function stats_change_params(argIn: unknown): [boolean | null, number | null, boolean | null] {
  const arg = tonumber(argIn) ?? 0;
  if (arg >= 55 && arg <= 58) {
    return [arg >= 57, 0xFF, (arg === 56 || arg === 58)];
  }
  for (const [, row] of ipairs<LuaTable>(lseq(lseq<number | boolean>(15, false, false), lseq<number | boolean>(22, true, false), lseq<number | boolean>(39, false, true), lseq<number | boolean>(46, true, true)))) {
    const stat = arg - row[1] + 1;
    if (stat >= 1 && stat <= 7) return [row[2], STAT_ANIM_ID[stat]!, row[3]];
  }
  return [null, null, null];
}

// pokefirered/src/battle_anim_utility_funcs.c:444
const STAT_MASK_PAL: number[] = [2, 1, 3, 4, 6, 7, 8];

// Lua: anim_tasks.lua:4590
// pokefirered/src/battle_anim_utility_funcs.c:526
AnimTasks.StatsChange = function (t: AnimTask, vm: any): void {
  const d = t.data;
  if (!t._sc) {
    const [goesDown, statId, sharply] = stats_change_params(vm ? vm.animArg : vm);
    if (goesDown == null) {
      destroy_task(t);
      return;
    }
    const side = vm.attackerSide();
    const mask = {
      tilemap: goesDown ? 2 : 1,
      pal: STAT_MASK_PAL[statId!] ?? 5,
      x: goesDown ? 64 : 0,
      y: 0,
      eva: 0,
    };
    t._sc = { side: side, mask: mask, dy: goesDown ? -3 : 3, wait: 2, down: goesDown };
    d[4] = sharply ? 13 : 10;
    d[5] = sharply ? 30 : 20;
    d[10] = 0; d[11] = 0; d[12] = 0; d[15] = 0;
    return;
  }
  const sc = t._sc;
  if (sc.wait > 0) {
    sc.wait = sc.wait - 1;
    if (sc.wait === 0) {
      const p = Anim.present(sc.side);
      if (p) p.statMask = sc.mask;
      vm.playSe12(sc.down ? SE.SE_M_STAT_DECREASE : SE.SE_M_STAT_INCREASE, vm.adjustPanning2(-64));
    }
    return;
  }
  const mask = sc.mask;
  mask.y = mod(mask.y + sc.dy, 256);
  if (d[15] === 0) {
    d[11] = d[11] + 1;
    if (d[11] > 1) {
      d[11] = 0;
      d[12] = d[12] + 1;
      mask.eva = d[12];
      if (d[12] === d[4]) d[15] = d[15] + 1;
    }
  } else if (d[15] === 1) {
    d[10] = d[10] + 1;
    if (d[10] === d[5]) d[15] = d[15] + 1;
  } else if (d[15] === 2) {
    d[11] = d[11] + 1;
    if (d[11] > 1) {
      d[11] = 0;
      d[12] = d[12] - 1;
      mask.eva = d[12];
      if (d[12] === 0) d[15] = d[15] + 1;
    }
  } else {
    const p = Anim.present(sc.side);
    if (p && p.statMask === mask) p.statMask = null;
    t._sc = null;
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.StatsChange = AnimTasks.StatsChange;
AnimTasks.REGISTRY.AnimTask_StatsChange = AnimTasks.StatsChange;

// Lua: anim_tasks.lua:4655
AnimTasks.FakeOut = function (t: AnimTask, _vm: any): void {
  const frame = t.data[14] ?? 0;
  t.data[14] = frame + 1;
  const dur = 16;
  if (frame < 8) {
    Anim.setScreenEffect({ type: "fade_black", coeff: 0.5 });
  } else {
    Anim.setScreenEffect(null);
  }
  if (frame >= dur) {
    Anim.setScreenEffect(null);
    destroy_task(t);
  }
};
AnimTasks.REGISTRY.FakeOut = AnimTasks.FakeOut;
AnimTasks.REGISTRY.AnimTask_FakeOut = AnimTasks.FakeOut;

//- pret Palette Buffers & Generic System Tasks
AnimTasks.REGISTRY.CopyPalFadedToUnfaded = stub_task;
AnimTasks.REGISTRY.AnimTask_CopyPalFadedToUnfaded = stub_task;
AnimTasks.REGISTRY.CopyPalUnfadedToBackup = stub_task;
AnimTasks.REGISTRY.AnimTask_CopyPalUnfadedToBackup = stub_task;
AnimTasks.REGISTRY.SubstituteFadeToInvisible = stub_task;
AnimTasks.REGISTRY.AnimTask_SubstituteFadeToInvisible = stub_task;
AnimTasks.REGISTRY.SwapMonSpriteToFromSubstitute = stub_task;
AnimTasks.REGISTRY.AnimTask_SwapMonSpriteToFromSubstitute = stub_task;
AnimTasks.REGISTRY.SwitchOutBallEffect = stub_task;
AnimTasks.REGISTRY.AnimTask_SwitchOutBallEffect = stub_task;
AnimTasks.REGISTRY.SwitchOutShrinkMon = stub_task;
AnimTasks.REGISTRY.AnimTask_SwitchOutShrinkMon = stub_task;
AnimTasks.REGISTRY.ThrowBall = stub_task;
AnimTasks.REGISTRY.AnimTask_ThrowBall = stub_task;
AnimTasks.REGISTRY.ThrowBallSpecial = stub_task;
AnimTasks.REGISTRY.AnimTask_ThrowBallSpecial = stub_task;
AnimTasks.REGISTRY.LoadBallGfx = stub_task;
AnimTasks.REGISTRY.AnimTask_LoadBallGfx = stub_task;
AnimTasks.REGISTRY.FreeBallGfx = stub_task;
AnimTasks.REGISTRY.AnimTask_FreeBallGfx = stub_task;
AnimTasks.REGISTRY.LoadBaitGfx = stub_task;
AnimTasks.REGISTRY.AnimTask_LoadBaitGfx = stub_task;
AnimTasks.REGISTRY.FreeBaitGfx = stub_task;
AnimTasks.REGISTRY.AnimTask_FreeBaitGfx = stub_task;
AnimTasks.REGISTRY.GhostGetOut = stub_task;
AnimTasks.REGISTRY.AnimTask_GhostGetOut = stub_task;
AnimTasks.REGISTRY.FlashHealthboxOnLevelUp = stub_task;
AnimTasks.REGISTRY.AnimTask_FlashHealthboxOnLevelUp = stub_task;
AnimTasks.REGISTRY.LoadHealthboxPalsForLevelUp = stub_task;
AnimTasks.REGISTRY.AnimTask_LoadHealthboxPalsForLevelUp = stub_task;
AnimTasks.REGISTRY.FreeHealthboxPalsForLevelUp = stub_task;
AnimTasks.REGISTRY.AnimTask_FreeHealthboxPalsForLevelUp = stub_task;
AnimTasks.REGISTRY.SoundTask_PlayCryWithEcho = stub_task;
AnimTasks.REGISTRY.SoundTask_PlaySE2WithPanning = stub_task;


AnimTasks._destroy = destroy_task;
AnimTasks._clear = clear_task;
AnimTasks._stub = stub_task;
AnimTasks._Sin = Sin;
AnimTasks._Cos = Cos;

// Lua: anim_tasks.lua:4715
// NOT FAITHFUL: the anim_port groups merge on first init(), not at require time (ES module order).
// Brian runs this loop when the module loads; here the group modules register in G3Lazy after this
// module has evaluated, so the loop is a function that init() runs once (also AnimTasks._loadGroups).
// A missing G3Lazy entry is Brian's failed require whose message contains "not found" (silent).
function loadGroups(): void {
  if (groupsLoaded) return;
  groupsLoaded = true;
  for (const [, group] of ipairs<string>(lseq("g1", "g2", "g3", "g4", "g5"))) {
    const name = "src.core.game3.battle.anim_port." + group + "_tasks";
    const lazy = G3Lazy[name];
    const ok = lazy != null;
    let modv: any = ok ? lazy : "module '" + name + "' not found";
    if (ok && typeof modv === "function") modv = modv(AnimTasks);
    if (ok && modv != null && typeof modv === "object") {
      for (const [k, fn] of pairs(modv)) {
        const short = gsub(tostring(k), "^AnimTask_", "")[0];
        AnimTasks.REGISTRY[short] = fn;
        AnimTasks.REGISTRY["AnimTask_" + short] = fn;
      }
    } else if (!ok && find(tostring(modv), "not found") == null) {
      console.log("[battle.anim] " + group + "_tasks: " + tostring(modv));
    }
  }
}
AnimTasks._loadGroups = loadGroups;

// Lua: anim_tasks.lua:4729
AnimTasks.spawn = function (nameIn: unknown, priority: unknown, args: LuaTable, _vm: any): AnimTask {
  AnimTasks.init();
  const name = tostring(truthy(nameIn) ? nameIn : "stub");
  // Strip g prefix / AnimTask_ variants for lookup
  let key = name;
  key = gsub(key, "^g", "")[0];
  let fn: TaskFn | undefined = AnimTasks.REGISTRY[name]
    || AnimTasks.REGISTRY[key]
    || AnimTasks.REGISTRY["AnimTask_" + key];
  if (!fn) {
    fn = stub_task;
  }
  let t: AnimTask | undefined;
  for (let i = 1; i <= AnimTasks.MAX; i++) {
    const cand = AnimTasks._pool[i];
    if (!cand.active) {
      t = cand;
      break;
    }
  }
  if (!t) {
    AnimTasks.MAX = AnimTasks.MAX + 1;
    t = AnimTasks._pool[AnimTasks.MAX];
    if (!t) {
      t = { data: {} };
      for (let j = 0; j <= 15; j++) t.data[j] = 0;
      AnimTasks._pool[AnimTasks.MAX] = t;
    }
  }
  const task = t!;
  clear_task(task);
  task.active = true;
  task.name = name;
  task.priority = tonumber(priority) ?? 2;
  task.func = fn;
  if (args != null && typeof args === "object") {
    for (const [ai, av] of ipairs(args)) {
      const v = av;
      if (typeof v === "string") {
        task.data[ai - 1] = v;
      } else {
        task.data[ai - 1] = tonumber(v) ?? 0;
      }
    }
    for (const [ai, av] of ipairs(args)) {
      if (typeof av === "string") {
        task.data[ai - 1] = av;
      }
    }
  }
  return task;
};

// Lua: anim_tasks.lua:4781
AnimTasks.update = function (vm: any): void {
  AnimTasks.init();
  for (let i = 1; i <= AnimTasks.MAX; i++) {
    const t = AnimTasks._pool[i];
    if (t.active && t.func) {
      try {
        t.func(t, vm);
      } catch (err) {
        console.log("[battle.anim] task " + tostring(t.name) + ": " + tostring(err));
        destroy_task(t);
      }
    }
  }
};

// Lua: anim_tasks.lua:4795
AnimTasks.draw = function (minZ: number | null | undefined, maxZ: number | null | undefined, vm: any): void {
  // (Brian's `if not (love and love.graphics) then return end`: the platform always has graphics.)
  AnimTasks.init();
  for (let i = 1; i <= AnimTasks.MAX; i++) {
    const t = AnimTasks._pool[i];
    if (t.active && t.draw) {
      const z = t.z ?? AnimSprites.Z.MID_FIELD;
      if ((!truthy(minZ) || z >= minZ!) && (!truthy(maxZ) || z <= maxZ!)) {
        try {
          t.draw(t, vm);
        } catch (err) {
          console.log("[battle.anim] task draw " + tostring(t.name) + ": " + tostring(err));
          clear_task(t);
        }
      }
    }
  }
};

//- Destroy helper for sprite callbacks / tasks that finish themselves.
AnimTasks.destroy = destroy_task;

export default AnimTasks;
