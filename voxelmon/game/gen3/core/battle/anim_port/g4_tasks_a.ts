// Port of gen1recomp src/core/game3/battle/anim_port/g4_tasks_a.lua (GPLv3 + additional terms; see LICENSE.md).
// g4 visual tasks, part A: healthbox level-up flash, switch-out, ball throws,
// substitute, safari/ghost battler setup and the sound tasks (pokefirered
// battle_anim_special.c, battle_anim_sound_tasks.c).

import { tonumber, truthy } from "../../../../../import/gen3/lua.ts";
import { len } from "../../../platform/lt.ts";
import { SE } from "../../se_ids.ts";
import { Audio } from "../../audio.ts";
import { AnimCoords } from "../anim_coords.ts";
import { BallOpen } from "../ball_open.ts";
import { CatchSeq } from "../catch_seq.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Task = Record<string, any>;

// Lua: g4_tasks_a.lua:2
export default function g4TasksA(K: Record<string, any>): Record<string, any> {
  const P = K.P, D = K.destroy;
  const TK: Record<string, any> = {};

  // Lua: g4_tasks_a.lua:8
  function audio(): any {
    // pcall(require, "src.core.game3.audio"): a real module, the ok path.
    return Audio ?? null;
  }

  // Lua: g4_tasks_a.lua:13
  function play_se12(se: any, pan: any): void {
    const A = audio();
    if (A && A.playSe && se != null) {
      try { A.playSe(se, { pan: pan }); } catch (_e) { /* pcall */ }
    }
  }

  // Lua: g4_tasks_a.lua:18
  function play_cry(species: any, pan: any, mode: any): void {
    const A = audio();
    if (A && A.playCry && species != null) {
      try { A.playCry(species, mode, pan); } catch (_e) { /* pcall */ }
    }
  }

  // Lua: g4_tasks_a.lua:23
  function cry_playing(): boolean {
    const A = audio();
    if (A && A.isReady && !A.isReady()) return false;
    if (A && A.isCryFinished) {
      let ok = true, v: any;
      try { v = A.isCryFinished(); } catch (_e) { ok = false; }
      return ok && !v;
    }
    return false;
  }

  // Lua: g4_tasks_a.lua:33
  function species_of(vm: any, side: any): any {
    return side != null ? P.species(vm, side) : null;
  }

  // pokefirered/src/battle_anim_special.c:530
  // Lua: g4_tasks_a.lua:38
  TK.LoadHealthboxPalsForLevelUp = function (t: Task): void { D(t); };
  TK.FreeHealthboxPalsForLevelUp = function (t: Task): void { D(t); };
  TK.LoadBallGfx = function (t: Task): void { D(t); };
  TK.FreeBallGfx = function (t: Task): void { D(t); };
  TK.LoadBaitGfx = function (t: Task): void { D(t); };
  TK.FreeBaitGfx = function (t: Task): void { D(t); };

  // Lua: g4_tasks_a.lua:46 -- pokefirered/src/battle_anim_special.c:569
  function flashHealthboxStep(t: Task, vm: any): void {
    const d = t.data;
    d[0] = d[0] + 1;
    const v = d[0];
    d[0] = v + 1;
    if (v >= d[11]) {
      d[0] = 0;
      const colorOffset = (d[10] === 0) ? 6 : 2;
      const stage = P.stage();
      const hb = (stage && stage.healthbox) ? stage.healthbox[P.atk(vm)] : null;
      if (d[1] === 0) {
        d[2] = d[2] + 2;
        if (d[2] > 16) d[2] = 16;
        if (hb) hb.levelUpBlend = { coeff: d[2], color: P.rgb(20, 27, 31), colorIndex: colorOffset };
        if (d[2] === 16) d[1] = d[1] + 1;
      } else if (d[1] === 1) {
        d[2] = d[2] - 2;
        if (d[2] < 0) d[2] = 0;
        if (hb) hb.levelUpBlend = { coeff: d[2], color: P.rgb(20, 27, 31), colorIndex: colorOffset };
        if (d[2] === 0) {
          if (hb) hb.levelUpBlend = null;
          D(t);
        }
      }
    }
  }

  // Lua: g4_tasks_a.lua:74 -- pokefirered/src/battle_anim_special.c:562
  TK.FlashHealthboxOnLevelUp = function (t: Task, vm: any): void {
    t.data[10] = vm.args[0];
    t.data[11] = vm.args[1];
    t.func = flashHealthboxStep;
  };

  // Lua: g4_tasks_a.lua:81 -- pokefirered/src/battle_anim_special.c:606
  TK.SwitchOutShrinkMon = function (t: Task, vm: any): void {
    const side = P.atk(vm);
    const p = P.present(side);
    const d = t.data;
    if (d[0] === 0) {
      if (p) p.visible = true;
      d[10] = 0x100;
      d[0] = d[0] + 1;
    } else if (d[0] === 1) {
      d[10] = d[10] + 0x30;
      P.setMonRotScale(p, d[10], d[10], 0);
      P.monYOffsetFromYScale(p, side, vm);
      if (d[10] >= 0x2D0) d[0] = d[0] + 1;
    } else if (d[0] === 2) {
      P.resetMonRotScale(p);
      if (p) {
        p.oy = 0;
        p.visible = false;
      }
      D(t);
    }
  };

  // Lua: g4_tasks_a.lua:104
  function ball_open(): any {
    // pcall(require, "src.core.game3.battle.ball_open"): a real module, the ok path.
    return BallOpen ?? null;
  }

  // Lua: g4_tasks_a.lua:110 -- pokefirered/src/battle_anim_special.c:633
  TK.SwitchOutBallEffect = function (t: Task, vm: any): void {
    const d = t.data;
    const side = P.atk(vm);
    const bo = ball_open();
    if (d[0] === 0) {
      const x = P.coord(vm, side, P.X);
      const y = P.coord(vm, side, P.Y);
      const id = vm.attackerId ? vm.attackerId() : P.sideId(side);
      let item = vm.ctx ? (vm.ctx.ballItem ? vm.ctx.ballItem[side] : null) ?? vm.ctx.pokeball : null;
      if (item == null || item === false) {
        // require("src.core.game3.battle.anim_coords").battler(nil, id)
        const b = AnimCoords.battler(null, id);
        item = (b && b.mon) ? b.mon.pokeball : null;
      }
      if (bo) bo.start(id, x, y + 32 + 5, item, false);
      d[0] = d[0] + 1;
    } else if (d[0] === 1) {
      if (!bo || len(bo._tasks) === 0) D(t);
    }
  };

  // Lua: g4_tasks_a.lua:131 -- pokefirered/src/battle_anim_special.c:684
  TK.IsBallBlockedByTrainerOrDodged = function (t: Task, vm: any): void {
    const c = (vm.ctx ?? {}).ballThrowCaseId;
    if (c === 5) vm.args[P.ARG_RET_ID] = -1;
    else if (c === 6) vm.args[P.ARG_RET_ID] = -2;
    else vm.args[P.ARG_RET_ID] = 0;
    D(t);
  };

  // Lua: g4_tasks_a.lua:140 -- pokeemerald/src/battle_anim_throw.c:718
  TK.IsBallBlockedByTrainer = function (t: Task, vm: any): void {
    const c = (vm.ctx ?? {}).ballThrowCaseId;
    vm.args[P.ARG_RET_ID] = (c === 5) ? -1 : 0;
    D(t);
  };

  // Lua: g4_tasks_a.lua:146
  function throw_wait(t: Task, _vm: any): void {
    const b = t._ball;
    if (!b || b.finished || b.dead) D(t);
  }

  // Lua: g4_tasks_a.lua:152 -- pokefirered/src/battle_anim_special.c:734
  TK.ThrowBall = function (t: Task, vm: any): void {
    // pcall(require, "src.core.game3.battle.catch_seq"): a real module, the ok path.
    const ctx = vm.ctx ?? {};
    const p = P.present(P.tgt(vm));
    ctx.wildMonInvisible = p ? p.visible === false : p;
    if (CatchSeq && CatchSeq.startBall) {
      t._ball = CatchSeq.startBall({ caseId: ctx.ballThrowCaseId ?? 0, itemId: ctx.lastUsedItem });
    }
    t.func = throw_wait;
  };

  // Lua: g4_tasks_a.lua:164 -- pokefirered/src/battle_anim_special.c:790
  function throwSpecialPlaySfx(t: Task, vm: any): void {
    const C = K.cb();
    if (C && C.playerThrowIndex(vm) === 1) {
      play_se12(SE.SE_BALL_THROW, 0);
      if (t._ball) t._ball.cb = t._ballInit;
      t.func = throw_wait;
    }
  }

  // Lua: g4_tasks_a.lua:174 -- pokefirered/src/battle_anim_special.c:758
  TK.ThrowBallSpecial = function (t: Task, vm: any): void {
    const ctx = vm.ctx ?? {};
    let x: number, y: number;
    if (truthy(ctx.oldManTutorial)) {
      x = 28; y = 11;
    } else {
      x = 23; y = 11;
      if (ctx.playerGender === 1) y = 13;
    }
    // pcall(require, "src.core.game3.battle.catch_seq"): a real module, the ok path.
    if (CatchSeq && CatchSeq.startBall) {
      const b = CatchSeq.startBall({ caseId: ctx.ballThrowCaseId ?? 0, itemId: ctx.lastUsedItem });
      if (b) {
        b.x = P.bor(x, 32);
        b.y = P.bor(y, 80);
        t._ballInit = b.cb;
        b.cb = function (): void {};
        t._ball = b;
      }
    }
    const C = K.cb();
    if (C) C.startPlayerThrow(vm);
    t.func = throwSpecialPlaySfx;
  };

  // Lua: g4_tasks_a.lua:200 -- pokeemerald/src/battle_anim_throw.c:790
  TK.ThrowBall_StandingTrainer = function (t: Task, vm: any): void {
    const ctx = vm.ctx ?? {};
    let x: number, y: number;
    if (truthy(ctx.wallyTutorial)) {
      x = 32; y = 11;
    } else {
      x = 23; y = 5;
    }
    // pcall(require, "src.core.game3.battle.catch_seq"): a real module, the ok path.
    if (CatchSeq && CatchSeq.startBall) {
      const b = CatchSeq.startBall({ caseId: ctx.ballThrowCaseId ?? 0, itemId: ctx.lastUsedItem });
      if (b) {
        b.x = x + 32;
        b.y = P.bor(y, 80);
        t._ballInit = b.cb;
        b.cb = function (): void {};
        t._ball = b;
      }
    }
    const C = K.cb();
    if (C) C.startPlayerThrow(vm);
    t.func = throwSpecialPlaySfx;
  };

  // Lua: g4_tasks_a.lua:225 -- pokefirered/src/battle_anim_special.c:1936
  TK.SwapMonSpriteToFromSubstitute = function (t: Task, vm: any): void {
    const side = P.atk(vm);
    const p = P.present(side);
    const d = t.data;
    if (!p) {
      D(t);
      return;
    }
    if (d[10] === 0) {
      d[11] = vm.args[0];
      d[0] = d[0] + 0x500;
      if (side !== "player") {
        p.ox = (p.ox ?? 0) + P.asr(d[0], 8);
      } else {
        p.ox = (p.ox ?? 0) - P.asr(d[0], 8);
      }
      d[0] = d[0] & 0xFF;
      const x = P.COORDS[side].x + (p.ox ?? 0) + 32;
      if (x < 0 || x > 304) d[10] = d[10] + 1;
    } else if (d[10] === 1) {
      p.substitute = (d[11] === 0);
      p.substituteY = p.substitute ? P.substituteY(side) : null;
      p.alpha = 1;
      d[10] = d[10] + 1;
    } else if (d[10] === 2) {
      d[0] = d[0] + 0x500;
      if (side !== "player") {
        p.ox = (p.ox ?? 0) - P.asr(d[0], 8);
      } else {
        p.ox = (p.ox ?? 0) + P.asr(d[0], 8);
      }
      d[0] = d[0] & 0xFF;
      let done = false;
      if (side !== "player") {
        if ((p.ox ?? 0) <= 0) {
          p.ox = 0;
          done = true;
        }
      } else if ((p.ox ?? 0) >= 0) {
        p.ox = 0;
        done = true;
      }
      if (done) D(t);
    }
  };

  // Lua: g4_tasks_a.lua:272 -- pokefirered/src/battle_anim_special.c:1994
  TK.SubstituteFadeToInvisible = function (t: Task, vm: any): void {
    const d = t.data;
    const p = P.present(P.atk(vm));
    if (d[15] === 0) {
      if (p) p.alpha = 1;
      d[15] = d[15] + 1;
    } else if (d[15] === 1) {
      const v = d[1];
      d[1] = v + 1;
      if (v > 1) {
        d[1] = 0;
        d[0] = d[0] + 1;
        if (p) p.alpha = (16 - d[0]) / 16;
        if (d[0] === 16) d[15] = d[15] + 1;
      }
    } else if (d[15] === 2) {
      if (p) p.alpha = 0;
      const ctx = vm.ctx ?? {};
      if (ctx.behindSubstitute) ctx.behindSubstitute[P.atk(vm)] = false;
      D(t);
    }
  };

  // Lua: g4_tasks_a.lua:296 -- pokefirered/src/battle_anim_special.c:2028
  TK.IsAttackerBehindSubstitute = function (t: Task, vm: any): void {
    const ctx = vm.ctx ?? {};
    const b = ctx.behindSubstitute ? ctx.behindSubstitute[P.atk(vm)] : null;
    vm.args[P.ARG_RET_ID] = (b != null && b !== false) ? 1 : 0;
    D(t);
  };

  // Lua: g4_tasks_a.lua:304 -- pokefirered/src/battle_anim_special.c:2034
  TK.SetTargetToEffectBattler = function (t: Task, vm: any): void {
    const ctx = vm.ctx ?? {};
    if (ctx.effectBattler != null && ctx.effectBattler !== false) P.setBattlers(vm, null, ctx.effectBattler);
    D(t);
  };

  // Lua: g4_tasks_a.lua:311 -- pokefirered/src/battle_anim_special.c:2256
  TK.SafariOrGhost_DecideAnimSides = function (t: Task, vm: any): void {
    const a = vm.args[0];
    if (a === 0) {
      P.setBattlers(vm, "player", "enemy");
    } else if (a === 1) {
      P.setBattlers(vm, "enemy", "player");
    }
    D(t);
  };

  // Lua: g4_tasks_a.lua:322 -- pokefirered/src/battle_anim_special.c:2273
  TK.SafariGetReaction = function (t: Task, vm: any): void {
    const r = tonumber((vm.ctx ?? {}).safariReaction) ?? 0;
    if (r >= 3) vm.args[7] = 0; else vm.args[7] = r;
    D(t);
  };

  // Lua: g4_tasks_a.lua:329 -- pokefirered/src/battle_anim_special.c:2283
  TK.GetTrappedMoveAnimId = function (t: Task, vm: any): void {
    const m = tonumber(vm.animArg) ?? 0;
    if (m === 83) vm.args[0] = 1;
    else if (m === 250) vm.args[0] = 2;
    else if (m === 128) vm.args[0] = 3;
    else if (m === 328) vm.args[0] = 4;
    else vm.args[0] = 0;
    D(t);
  };

  // Lua: g4_tasks_a.lua:340 -- pokefirered/src/battle_anim_special.c:2299
  TK.GetBattlersFromArg = function (t: Task, vm: any): void {
    const m = P.u16(vm.animArg ?? 0);
    P.setBattlers(vm, P.band(m, 3), P.band(P.rshift(m, 8), 3));
    D(t);
  };

  // Lua: g4_tasks_a.lua:347 -- pokefirered/src/battle_anim_sound_tasks.c:39
  function fireBlastStep2(t: Task, vm: any): void {
    const d = t.data;
    d[10] = d[10] + 1;
    if (d[10] === 6) {
      d[10] = 0;
      play_se12(d[1], vm.adjustPanning(P.SOUND_PAN_TARGET));
      d[11] = d[11] + 1;
      if (d[11] === 2) D(t);
    }
  }
  // Lua: g4_tasks_a.lua:357
  function fireBlastStep1(t: Task, _vm: any): void {
    const d = t.data;
    let pan = d[2];
    const inc = P.s8(d[4]);
    d[11] = d[11] + 1;
    if (d[11] === 111) {
      d[10] = 5;
      d[11] = 0;
      t.func = fireBlastStep2;
    } else {
      d[10] = d[10] + 1;
      if (d[10] === 11) {
        d[10] = 0;
        play_se12(d[0], pan);
      }
      pan = pan + inc;
      d[2] = K.keepPan(pan);
    }
  }

  // Lua: g4_tasks_a.lua:378 -- pokefirered/src/battle_anim_sound_tasks.c:23
  TK.SoundTask_FireBlast = function (t: Task, vm: any): void {
    const d = t.data;
    d[0] = vm.args[0];
    d[1] = vm.args[1];
    const pan1 = vm.adjustPanning(P.SOUND_PAN_ATTACKER);
    const pan2 = vm.adjustPanning(P.SOUND_PAN_TARGET);
    d[2] = pan1;
    d[3] = pan2;
    d[4] = K.panInc(pan1, pan2, 2);
    d[10] = 10;
    t.func = fireBlastStep1;
  };

  // Lua: g4_tasks_a.lua:392 -- pokefirered/src/battle_anim_sound_tasks.c:102
  function loopSeAdjustStep(t: Task, _vm: any): void {
    const d = t.data;
    const v12 = d[12];
    d[12] = v12 + 1;
    if (v12 === d[6]) {
      d[12] = 0;
      play_se12(d[0], d[11]);
      d[4] = P.band(d[4] - 1, 0xFFFF);
      if (d[4] === 0) {
        D(t);
        return;
      }
    }
    const v10 = d[10];
    d[10] = v10 + 1;
    if (v10 === d[5]) {
      d[10] = 0;
      d[11] = K.keepPan(P.s16(d[3] + d[11]));
    }
  }

  // Lua: g4_tasks_a.lua:414 -- pokefirered/src/battle_anim_sound_tasks.c:76
  TK.SoundTask_LoopSEAdjustPanning = function (t: Task, vm: any): void {
    const a = vm.args;
    const songId = P.u16(a[0]);
    let targetPan = P.s8(a[2]);
    let inc = P.s8(a[3]);
    const r10 = P.u8(a[4]), r7 = P.u8(a[5]), r9 = P.u8(a[6]);
    const sourcePan = vm.adjustPanning(P.s8(a[1]));
    targetPan = vm.adjustPanning(targetPan);
    inc = K.panInc(sourcePan, targetPan, inc);
    const d = t.data;
    d[0] = songId; d[1] = sourcePan; d[2] = targetPan; d[3] = inc;
    d[4] = r10; d[5] = r7; d[6] = r9;
    d[10] = 0;
    d[11] = sourcePan;
    d[12] = r9;
    t.func = loopSeAdjustStep;
    t.func(t, vm);
  };

  // Lua: g4_tasks_a.lua:433
  function cry_battler(vm: any): any {
    const a0 = vm.args[0];
    if (a0 === P.ANIM_ATTACKER) return P.atk(vm);
    if (a0 === P.ANIM_TARGET) return P.tgt(vm);
    return null;
  }

  // Lua: g4_tasks_a.lua:441 -- pokefirered/src/battle_anim_sound_tasks.c:126
  TK.SoundTask_PlayCryHighPitch = function (t: Task, vm: any): void {
    const pan = vm.adjustPanning(P.SOUND_PAN_ATTACKER);
    const side = cry_battler(vm);
    const p = side != null ? P.present(side) : null;
    if (vm.args[0] === P.ANIM_TARGET && p && p.visible === false) {
      D(t);
      return;
    }
    const sp = species_of(vm, side);
    if (sp != null && sp !== false) play_cry(sp, pan, 3);
    D(t);
  };

  // Lua: g4_tasks_a.lua:455 -- pokefirered/src/battle_anim_sound_tasks.c:201
  function doubleCryStep(t: Task, _vm: any): void {
    const d = t.data;
    if (d[9] < 2) {
      d[9] = d[9] + 1;
    } else if (!cry_playing()) {
      play_cry(t._species, d[2], (d[0] === 255 || d[0] === -1) ? 10 : 8);
      D(t);
    }
  }

  // Lua: g4_tasks_a.lua:466 -- pokefirered/src/battle_anim_sound_tasks.c:158
  TK.SoundTask_PlayDoubleCry = function (t: Task, vm: any): void {
    const pan = vm.adjustPanning(P.SOUND_PAN_ATTACKER);
    const side = cry_battler(vm);
    const p = side != null ? P.present(side) : null;
    if (vm.args[0] === P.ANIM_TARGET && p && p.visible === false) {
      D(t);
      return;
    }
    const sp = species_of(vm, side);
    t.data[0] = vm.args[1];
    t._species = sp;
    t.data[2] = pan;
    if (sp != null && sp !== false) {
      const growl = (vm.args[1] === 255 || vm.args[1] === -1);
      play_cry(sp, pan, growl ? 9 : 7);
      t.func = doubleCryStep;
    } else {
      D(t);
    }
  };

  // Lua: g4_tasks_a.lua:488 -- pokefirered/src/battle_anim_sound_tasks.c:228
  TK.SoundTask_WaitForCry = function (t: Task, _vm: any): void {
    if (t.data[9] < 2) {
      t.data[9] = t.data[9] + 1;
    } else if (!cry_playing()) {
      D(t);
    }
  };

  // Lua: g4_tasks_a.lua:497 -- pokefirered/src/battle_anim_sound_tasks.c:258
  function echoStep(t: Task, _vm: any): void {
    const d = t.data;
    if (d[9] < 2) {
      d[9] = d[9] + 1;
    } else if (!cry_playing()) {
      play_cry(t._species, d[2], 6);
      D(t);
    }
  }

  // Lua: g4_tasks_a.lua:508 -- pokefirered/src/battle_anim_sound_tasks.c:240
  TK.SoundTask_PlayCryWithEcho = function (t: Task, vm: any): void {
    const pan = vm.adjustPanning(P.SOUND_PAN_ATTACKER);
    const sp = species_of(vm, P.atk(vm));
    t._species = sp;
    t.data[2] = pan;
    if (sp != null && sp !== false) {
      play_cry(sp, pan, 4);
      t.func = echoStep;
    } else {
      D(t);
    }
  };

  // Lua: g4_tasks_a.lua:522 -- pokefirered/src/battle_anim_sound_tasks.c:279
  TK.SoundTask_PlaySE1WithPanning = function (t: Task, vm: any): void {
    play_se12(P.u16(vm.args[0]), vm.adjustPanning(P.s8(vm.args[1])));
    D(t);
  };

  // Lua: g4_tasks_a.lua:528 -- pokefirered/src/battle_anim_sound_tasks.c:288
  TK.SoundTask_PlaySE2WithPanning = function (t: Task, vm: any): void {
    play_se12(P.u16(vm.args[0]), vm.adjustPanning(P.s8(vm.args[1])));
    D(t);
  };

  // Lua: g4_tasks_a.lua:534 -- pokefirered/src/battle_anim_sound_tasks.c:318
  function adjustPanVarStep(t: Task, vm: any): void {
    const d = t.data;
    const v = d[10];
    d[10] = v + 1;
    if (v === d[5]) {
      d[10] = 0;
      d[11] = K.keepPan(P.s16(d[3] + d[11]));
    }
    vm.animCustomPanning = d[11];
    if (d[11] === d[2]) D(t);
  }

  // Lua: g4_tasks_a.lua:547 -- pokefirered/src/battle_anim_sound_tasks.c:299
  TK.SoundTask_AdjustPanningVar = function (t: Task, vm: any): void {
    const a = vm.args;
    let targetPan = P.s8(a[1]);
    let inc = P.s8(a[2]);
    const r9 = P.u16(a[3]);
    const sourcePan = vm.adjustPanning(P.s8(a[0]));
    targetPan = vm.adjustPanning(targetPan);
    inc = K.panInc(sourcePan, targetPan, inc);
    const d = t.data;
    d[1] = sourcePan; d[2] = targetPan; d[3] = inc; d[5] = r9;
    d[10] = 0;
    d[11] = sourcePan;
    t.func = adjustPanVarStep;
    t.func(t, vm);
  };

  return TK;
}
