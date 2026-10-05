// Port of gen1recomp src/core/game3/battle/anim_port/g4_tasks_b.lua (GPLv3 + additional terms; see LICENSE.md).
// g4 visual tasks, part B: electric bolts/charge/shock wave, ground shakes and
// fissure, ice fog/hail, rollout, seismic toss, rain, aurora ring colours,
// water spout and water sport (pokefirered battle_anim_electric.c, _ground.c,
// _ice.c, _rock.c, _water.c).

import { mod, tonumber } from "../../../../../import/gen3/lua.ts";
import { ipairs, len, seq } from "../../../platform/lt.ts";
import { SE } from "../../se_ids.ts";
import { Audio } from "../../audio.ts";
import { AnimCoords } from "../anim_coords.ts";
import { AnimPal } from "../anim_pal.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type S = Record<string, any>;
type Task = Record<string, any>;

// Lua: g4_tasks_b.lua:2
export default function g4TasksB(K: Record<string, any>): Record<string, any> {
  const P = K.P, D = K.destroy, T = K.T;
  const TK: Record<string, any> = {};

  // Lua: g4_tasks_b.lua:8
  function play_se12(se: any, pan: any): void {
    // pcall(require, "src.core.game3.audio"): a real module, the ok path.
    if (Audio && Audio.playSe) {
      try { Audio.playSe(se, { pan: pan }); } catch (_e) { /* pcall */ }
    }
  }

  // Lua: g4_tasks_b.lua:13
  function task_alive(s: S): boolean {
    const t = s._task;
    return !!(t && t.active && t._g4id === s._taskId);
  }

  // Lua: g4_tasks_b.lua:18
  function bind(s: S, t: Task): void {
    s._task = t;
    s._taskId = t._g4id;
  }

  // Lua: g4_tasks_b.lua:24 -- pokefirered/src/battle_anim_electric.c:736
  function boltSegment(s: S): void {
    s.data[1] = s.data[1] + 1;
    if (s.data[1] === 15) P.destroy(s);
  }

  // Lua: g4_tasks_b.lua:30 -- pokefirered/src/battle_anim_electric.c:670
  function electricBoltStep(t: Task, vm: any): void {
    const d = t.data;
    let r8: number, r2: number, r12: number;
    const sp = P.u8(d[2]);
    const x = d[0], y = d[1];
    if (d[2] === 0) {
      r8 = 0; r2 = 1; r12 = 16;
    } else {
      r12 = 16; r8 = 8; r2 = 4;
    }
    const k = d[10];
    let create = false;
    if (k === 0) {
      create = true;
    } else if (k === 2) {
      r12 = r12 * 2;
      r8 = r8 + r2;
      create = true;
    } else if (k === 4) {
      r12 = r12 * 3;
      r8 = r8 + r2 * 2;
      create = true;
    } else if (k === 6) {
      r12 = r12 * 4;
      r8 = r8 + r2 * 3;
      create = true;
    } else if (k === 8) {
      r12 = r12 * 5;
      create = true;
    } else if (k === 10) {
      D(t);
      return;
    }
    if (create) {
      let w = 8, h = 16;
      if (sp !== 0) { w = 16; h = 16; }
      const s = P.createSprite(vm, "SPARK", T.sElectricBoltSegmentSpriteTemplate, x, y + r12, 2, boltSegment, w, h);
      if (s) {
        P.addTile(s, r8);
        s.data[0] = sp;
        s.callback(s);
      }
    }
    d[10] = d[10] + 1;
  }

  // Lua: g4_tasks_b.lua:77 -- pokefirered/src/battle_anim_electric.c:662
  TK.ElectricBolt = function (t: Task, vm: any): void {
    t.data[0] = P.coord(vm, P.tgt(vm), P.X) + vm.args[0];
    t.data[1] = P.coord(vm, P.tgt(vm), P.Y) + vm.args[1];
    t.data[2] = vm.args[2];
    t.func = electricBoltStep;
  };

  // pokefirered/src/battle_anim_electric.c:239
  const CHARGE_OFFSETS = [
    seq(58, -60), seq(-56, -36), seq(8, -56), seq(-16, 56), seq(58, -10), seq(-58, 10), seq(48, -18), seq(-8, 56),
    seq(16, -56), seq(-58, -42), seq(58, 30), seq(-48, 40), seq(12, -48), seq(48, -12), seq(-56, 18), seq(48, 48),
  ];

  // Lua: g4_tasks_b.lua:91 -- pokefirered/src/battle_anim_electric.c:849
  function chargingParticleStep(s: S): void {
    if (P.translateLinear(s)) {
      if (task_alive(s)) s._task.data[7] = s._task.data[7] - 1;
      P.destroy(s);
    }
  }
  // Lua: g4_tasks_b.lua:97
  function chargingParticle(s: S): void {
    P.startAnim(s, 1);
    s.callback = chargingParticleStep;
  }

  // Lua: g4_tasks_b.lua:103 -- pokefirered/src/battle_anim_electric.c:803
  function chargingStep(t: Task, vm: any): void {
    const d = t.data;
    if (d[6] !== 0) {
      d[12] = d[12] + 1;
      if (d[12] > d[13]) {
        d[12] = 0;
        const s = P.createSprite(vm, "ELECTRIC_ORBS", T.gElectricChargingParticlesSpriteTemplate, d[14], d[15], 2, P.runStoredWhenAnimEnds, 8, 8);
        if (s) {
          const o = CHARGE_OFFSETS[d[9]];
          s.x = s.x + o[1];
          s.y = s.y + o[2];
          s.data[0] = 40 - d[8] * 5;
          s.data[1] = s.x;
          s.data[2] = d[14];
          s.data[3] = s.y;
          s.data[4] = d[15];
          bind(s, t);
          P.initLinear(s);
          P.storeCb(s, chargingParticle);
          d[9] = d[9] + 1;
          if (d[9] > 15) d[9] = 0;
          d[10] = d[10] + 1;
          if (d[10] >= d[11]) {
            d[10] = 0;
            if (d[8] <= 5) d[8] = d[8] + 1;
          }
          d[7] = d[7] + 1;
          d[6] = d[6] - 1;
        }
      }
    } else if (d[7] === 0) {
      D(t);
    }
  }

  // Lua: g4_tasks_b.lua:139 -- pokefirered/src/battle_anim_electric.c:778
  TK.ElectricChargingParticles = function (t: Task, vm: any): void {
    const a = vm.args;
    const side = (a[0] === 0) ? P.atk(vm) : P.tgt(vm);
    const d = t.data;
    d[14] = P.coord(vm, side, P.X_2);
    d[15] = P.coord(vm, side, P.Y_PIC_OFFSET);
    d[6] = a[1];
    d[7] = 0; d[8] = 0; d[9] = 0; d[10] = 0;
    d[11] = a[3];
    d[12] = 0;
    d[13] = a[2];
    t.func = chargingStep;
  };

  // Lua: g4_tasks_b.lua:154 -- pokefirered/src/battle_anim_electric.c:929
  TK.VoltTackleAttackerReappear = function (t: Task, vm: any): void {
    const d = t.data;
    const p = P.present(P.atk(vm));
    if (!p) {
      D(t);
      return;
    }
    if (d[0] === 0) {
      if (P.atk(vm) === "player") {
        d[14] = -32;
        d[13] = 2;
      } else {
        d[14] = 32;
        d[13] = -2;
      }
      p.ox = d[14];
      d[0] = d[0] + 1;
    } else if (d[0] === 1) {
      d[1] = d[1] + 1;
      if (d[1] > 1) {
        d[1] = 0;
        p.visible = !(p.visible !== false);
        if (d[14] !== 0) {
          d[14] = d[14] + d[13];
          p.ox = d[14];
        } else {
          d[0] = d[0] + 1;
        }
      }
    } else if (d[0] === 2) {
      d[1] = d[1] + 1;
      if (d[1] > 1) {
        d[1] = 0;
        p.visible = !(p.visible !== false);
        d[2] = d[2] + 1;
        if (d[2] === 8) d[0] = d[0] + 1;
      }
    } else if (d[0] === 3) {
      p.visible = true;
      D(t);
    }
  };

  // Lua: g4_tasks_b.lua:198 -- pokefirered/src/battle_anim_electric.c:1080
  function voltBoltSprite(s: S): void {
    s.data[0] = s.data[0] + 1;
    if (s.data[0] > 12) {
      if (task_alive(s)) {
        const k = s.data[7];
        s._task.data[k] = s._task.data[k] - 1;
      }
      P.destroy(s);
    }
  }

  // Lua: g4_tasks_b.lua:210 -- pokefirered/src/battle_anim_electric.c:1057
  function createVoltBolt(t: Task, vm: any): boolean {
    const d = t.data;
    const s = P.createSprite(vm, "SPARK", T.gVoltTackleBoltSpriteTemplate, d[3], d[5], 35, voltBoltSprite, 8, 16);
    if (s) {
      bind(s, t);
      s.data[6] = 0;
      s.data[7] = 7;
      d[7] = d[7] + 1;
    }
    d[6] = d[6] + d[1];
    if (d[6] < 0) d[6] = 3;
    if (d[6] > 3) d[6] = 0;
    d[3] = d[3] + d[1] * 16;
    return (d[1] === 1 && d[3] >= d[4]) || (d[1] === -1 && d[3] <= d[4]);
  }

  // Lua: g4_tasks_b.lua:227 -- pokefirered/src/battle_anim_electric.c:985
  TK.VoltTackleBolt = function (t: Task, vm: any): void {
    const d = t.data;
    if (d[0] === 0) {
      d[1] = (P.atk(vm) === "player") ? 1 : -1;
      const a0 = vm.args[0];
      if (a0 === 0) {
        d[3] = P.coord(vm, P.atk(vm), P.X_2);
        d[5] = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
        d[4] = d[1] * 128 + 120;
      } else if (a0 === 4) {
        d[3] = 120 - d[1] * 128;
        d[5] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET);
        d[4] = P.coord(vm, P.tgt(vm), P.X_2) - d[1] * 32;
      } else {
        if (P.band(a0, 1) !== 0) {
          d[3] = 256; d[4] = -16;
        } else {
          d[3] = -16; d[4] = 256;
        }
        if (d[1] === 1) {
          d[5] = 80 - a0 * 10;
        } else {
          d[5] = a0 * 10 + 40;
          const old3 = d[3];
          d[3] = d[4]; d[4] = P.s16(P.u16(old3));
        }
      }
      if (d[3] < d[4]) {
        d[1] = 1;
        d[6] = 0;
      } else {
        d[1] = -1;
        d[6] = 3;
      }
      d[0] = d[0] + 1;
    } else if (d[0] === 1) {
      d[2] = d[2] + 1;
      if (d[2] > 0) {
        d[2] = 0;
        if (createVoltBolt(t, vm) || createVoltBolt(t, vm)) d[0] = d[0] + 1;
      }
    } else if (d[0] === 2) {
      if (d[7] === 0) D(t);
    }
  };

  // Lua: g4_tasks_b.lua:273 -- pokefirered/src/battle_anim_electric.c:1217
  function progressingBoltSprite(s: S): void {
    s.data[0] = s.data[0] + 1;
    if (s.data[0] > 12) {
      if (task_alive(s)) {
        const k = s.data[7];
        s._task.data[k] = s._task.data[k] - 1;
      }
      P.destroy(s);
    }
  }

  // Lua: g4_tasks_b.lua:285 -- pokefirered/src/battle_anim_electric.c:1182
  function createShockWaveBolt(t: Task, vm: any): boolean {
    const d = t.data;
    const s = P.createSprite(vm, "SPARK", T.sShockWaveProgressingBoltSpriteTemplate, d[6], d[7], 35, progressingBoltSprite, 8, 8);
    if (s) {
      P.addTile(s, d[4]);
      d[4] = d[4] + d[5];
      if (d[4] < 0) d[4] = 7;
      if (d[4] > 7) d[4] = 0;
      bind(s, t);
      s.data[7] = 3;
      d[3] = d[3] + 1;
    }
    if (d[4] === 0 && d[5] > 0) {
      d[14] = d[14] + d[15];
      play_se12(SE.SE_M_THUNDERBOLT, d[14]);
    }
    if ((d[5] < 0 && d[7] <= d[8]) || (d[5] > 0 && d[7] >= d[8])) {
      d[2] = d[2] + 1;
      d[6] = d[6] + d[9];
      return true;
    }
    d[7] = d[7] + d[5] * 8;
    return false;
  }

  // Lua: g4_tasks_b.lua:311 -- pokefirered/src/battle_anim_electric.c:1107
  TK.ShockWaveProgressingBolt = function (t: Task, vm: any): void {
    const d = t.data;
    const st = d[0];
    if (st === 0) {
      d[6] = P.coord(vm, P.atk(vm), P.X_2);
      d[7] = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
      d[8] = 4;
      d[10] = P.coord(vm, P.tgt(vm), P.X_2);
      d[9] = P.cdiv(d[10] - d[6], 5);
      d[4] = 7;
      d[5] = -1;
      d[11] = 12;
      d[12] = vm.adjustPanning(P.SOUND_PAN_ATTACKER);
      d[13] = vm.adjustPanning(P.SOUND_PAN_TARGET);
      d[14] = d[12];
      d[15] = P.cdiv(d[13] - d[12], 3);
      d[0] = d[0] + 1;
    } else if (st === 1) {
      d[1] = d[1] + 1;
      if (d[1] > 0) {
        d[1] = 0;
        if (createShockWaveBolt(t, vm)) {
          if (d[2] === 5) d[0] = 3; else d[0] = d[0] + 1;
        }
      }
      if (d[11] !== 0) d[11] = d[11] - 1;
    } else if (st === 2) {
      if (d[11] !== 0) d[11] = d[11] - 1;
      d[1] = d[1] + 1;
      if (d[1] > 4) {
        d[1] = 0;
        if (P.band(d[2], 1) !== 0) {
          d[7] = 4; d[8] = 68; d[4] = 0; d[5] = 1;
        } else {
          d[7] = 68; d[8] = 4; d[4] = 7; d[5] = -1;
        }
        if (d[11] !== 0) d[0] = 4; else d[0] = 1;
      }
    } else if (st === 3) {
      if (d[3] === 0) D(t);
    } else if (st === 4) {
      if (d[11] !== 0) d[11] = d[11] - 1; else d[0] = 1;
    }
  };

  // Lua: g4_tasks_b.lua:357 -- pokefirered/src/battle_anim_electric.c:1273
  function shockLightningSprite(s: S): void {
    if (s.animEnded) {
      if (task_alive(s)) {
        const k = s.data[7];
        s._task.data[k] = s._task.data[k] - 1;
      }
      P.destroy(s);
    }
  }

  // Lua: g4_tasks_b.lua:368 -- pokefirered/src/battle_anim_electric.c:1226
  TK.ShockWaveLightning = function (t: Task, vm: any): void {
    const d = t.data;
    if (d[0] === 0) {
      d[15] = P.coord(vm, P.tgt(vm), P.Y) + 32;
      d[14] = d[15];
      while (d[14] > 16) d[14] = d[14] - 32;
      d[13] = P.coord(vm, P.tgt(vm), P.X_2);
      d[12] = P.subpriorityOf(P.tgt(vm)) - 2;
      d[0] = d[0] + 1;
    } else if (d[0] === 1) {
      d[1] = d[1] + 1;
      if (d[1] > 1) {
        d[1] = 0;
        const s = P.createSprite(vm, "LIGHTNING", T.gLightningSpriteTemplate, d[13], d[14], d[12], shockLightningSprite, 32, 32);
        if (s) {
          bind(s, t);
          s.data[7] = 10;
          d[10] = d[10] + 1;
        }
        if (d[14] >= d[15]) {
          d[0] = d[0] + 1;
        } else {
          d[14] = d[14] + 32;
        }
      }
    } else if (d[0] === 2) {
      if (d[10] === 0) D(t);
    }
  };

  // Lua: g4_tasks_b.lua:399 -- pokefirered/src/battle_anim_ground.c:599
  function shakeTerrain(t: Task, vm: any): void {
    const d = t.data;
    if (d[0] === 0) {
      d[1] = d[1] + 1;
      if (d[1] > 1) {
        d[1] = 0;
        if (P.band(d[2], 1) === 0) vm.bg3.x = d[13] + d[15]; else vm.bg3.x = d[13] - d[15];
        d[2] = d[2] + 1;
        if (d[2] === d[3]) {
          d[2] = 0;
          d[14] = d[14] - 1;
          d[0] = d[0] + 1;
        }
      }
    } else if (d[0] === 1) {
      d[1] = d[1] + 1;
      if (d[1] > 1) {
        d[1] = 0;
        if (P.band(d[2], 1) === 0) vm.bg3.x = d[13] + d[14]; else vm.bg3.x = d[13] - d[14];
        d[2] = d[2] + 1;
        if (d[2] === 4) {
          d[2] = 0;
          d[14] = d[14] - 1;
          if (d[14] === 0) d[0] = d[0] + 1;
        }
      }
    } else if (d[0] === 2) {
      vm.bg3.x = d[13];
      D(t);
    }
  }

  // Lua: g4_tasks_b.lua:432 -- pokefirered/src/battle_anim_ground.c:688
  function setShakeX(t: Task): void {
    const d = t.data;
    let x: number;
    if (P.band(d[2], 1) === 0) {
      x = P.cdiv(d[14], 2) + P.band(d[14], 1);
    } else {
      x = -P.cdiv(d[14], 2);
    }
    const mons = t._mons;
    for (let i = 1; i <= len(mons); i++) mons[i].ox = x;
  }

  // Lua: g4_tasks_b.lua:443
  function shakeBattlers(t: Task, _vm: any): void {
    const d = t.data;
    if (d[0] === 0 || d[0] === 1) {
      d[1] = d[1] + 1;
      if (d[1] > 1) {
        d[1] = 0;
        setShakeX(t);
        d[2] = d[2] + 1;
        if (d[0] === 0 && d[2] === d[3]) {
          d[2] = 0;
          d[14] = d[14] - 1;
          d[0] = d[0] + 1;
        } else if (d[0] === 1 && d[2] === 4) {
          d[2] = 0;
          d[14] = d[14] - 1;
          if (d[14] === 0) d[0] = d[0] + 1;
        }
      }
    } else if (d[0] === 2) {
      for (const [, p] of ipairs(t._mons)) p.ox = 0;
      D(t);
    }
  }

  // Lua: g4_tasks_b.lua:468 -- pokefirered/src/battle_anim_ground.c:555
  TK.HorizontalShake = function (t: Task, vm: any): void {
    const a = vm.args;
    const d = t.data;
    if (a[1] !== 0) {
      d[14] = a[1] + 3;
    } else {
      d[14] = P.cdiv(tonumber((vm.ctx ?? {}).movePower) ?? 0, 10) + 3;
    }
    d[15] = d[14];
    d[3] = a[2];
    if (a[0] === 5) {
      d[13] = vm.bg3.x;
      t.func = shakeTerrain;
    } else if (a[0] === 4) {
      t._mons = seq();
      // require("src.core.game3.battle.anim_coords")
      for (const [, id] of ipairs<number>(AnimCoords.ids())) {
        const p = (id < 2 || AnimCoords.spritePresent(null, id)) ? P.present(id) : null;
        if (p && p.visible !== false) t._mons[len(t._mons) + 1] = p;
      }
      t.func = shakeBattlers;
    } else {
      const side = P.battlerSide(vm, a[0]);
      const p = side != null ? P.present(side) : null;
      if (!p) {
        D(t);
      } else {
        t._mons = seq(p);
        t.func = shakeBattlers;
      }
    }
  };

  // Lua: g4_tasks_b.lua:502 -- pokefirered/src/battle_anim_ground.c:713
  TK.IsPowerOver99 = function (t: Task, vm: any): void {
    vm.args[15] = ((tonumber((vm.ctx ?? {}).movePower) ?? 0) > 99) ? 1 : 0;
    D(t);
  };

  // Lua: g4_tasks_b.lua:508 -- pokefirered/src/battle_anim_ground.c:735
  function waitFissure(t: Task, vm: any): void {
    if (vm.args[7] === t.data[3]) {
      vm.bg3.x = 0; vm.bg3.y = 0;
      D(t);
    } else {
      vm.bg3.x = t.data[1]; vm.bg3.y = t.data[2];
    }
  }

  // Lua: g4_tasks_b.lua:518 -- pokefirered/src/battle_anim_ground.c:719
  TK.PositionFissureBgOnBattler = function (t: Task, vm: any): void {
    const a = vm.args;
    const side = (P.band(a[0], 1) !== 0) ? P.tgt(vm) : P.atk(vm);
    const nt = K.spawnAux(vm, waitFissure, a[1]);
    if (nt) {
      nt.data[1] = P.band(32 - P.coord(vm, side, P.X_2), 0x1FF);
      nt.data[2] = P.band(64 - P.coord(vm, side, P.Y_PIC_OFFSET), 0xFF);
      vm.bg3.x = nt.data[1];
      vm.bg3.y = nt.data[2];
      nt.data[3] = a[2];
    }
    D(t);
  };

  // Lua: g4_tasks_b.lua:533 -- pokefirered/src/battle_anim_ice.c:1468
  TK.GetRolloutCounter = function (t: Task, vm: any): void {
    const ctx = vm.ctx ?? {};
    const arg = P.u8(vm.args[0]);
    vm.args[arg] = P.u8((ctx.rolloutTimerStartValue ?? 0) - (ctx.rolloutTimer ?? 0) - 1);
    D(t);
  };

  // pokefirered/src/battle_anim_ice.c:334
  const HAZE_BLEND = [0, 1, 2, 2, 2, 2, 3, 4, 4, 4, 5, 6, 6, 6, 6, 7, 8, 8, 8, 9];
  const MIST_BLEND = [0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5];

  // Lua: g4_tasks_b.lua:544
  function fog_end(t: Task, vm: any): void {
    vm._fogBg = null;
    vm.bldAlpha = null;
    t.draw = null;
    D(t);
  }

  // Lua: g4_tasks_b.lua:552 -- pokefirered/src/battle_anim_ice.c:947
  function fog_begin(t: Task, vm: any): void {
    // require("src.core.game3.battle.anim_pal")
    vm._fogBg = { x: 0, y: 0, eva: 0, evb: 16 };
    AnimPal.bgLoad("bg1", "FOG");
    t.z = 850;
    t.draw = function (_t: Task, v: any): void {
      const f = (v ?? vm)._fogBg;
      if (f && (f.eva ?? 0) > 0) {
        AnimPal.drawBg("FOG", "bg1", f.x, f.y, { eva: f.eva, evb: f.evb });
      }
    };
  }

  // Lua: g4_tasks_b.lua:566 -- pokefirered/src/battle_anim_ice.c:955
  function hazeStep(t: Task, vm: any): void {
    const d = t.data;
    const f = vm._fogBg;
    if (f) f.x = f.x - 1;
    if (d[12] === 0) {
      d[10] = d[10] + 1;
      if (d[10] === 4) {
        d[10] = 0;
        d[9] = d[9] + 1;
        d[11] = HAZE_BLEND[d[9]] ?? 9;
        if (f) { f.eva = d[11]; f.evb = 16 - d[11]; }
        if (d[11] === 9) {
          d[12] = d[12] + 1;
          d[11] = 0;
        }
      }
    } else if (d[12] === 1) {
      d[11] = d[11] + 1;
      if (d[11] === 0x51) {
        d[11] = 9;
        d[12] = d[12] + 1;
      }
    } else if (d[12] === 2) {
      d[10] = d[10] + 1;
      if (d[10] === 4) {
        d[10] = 0;
        d[11] = d[11] - 1;
        if (f) { f.eva = d[11]; f.evb = 16 - d[11]; }
        if (d[11] === 0) {
          d[12] = d[12] + 1;
          d[11] = 0;
        }
      }
    } else {
      fog_end(t, vm);
    }
  }

  // Lua: g4_tasks_b.lua:605 -- pokefirered/src/battle_anim_ice.c:932
  TK.HazeScrollingFog = function (t: Task, vm: any): void {
    fog_begin(t, vm);
    t.func = hazeStep;
  };

  // Lua: g4_tasks_b.lua:611 -- pokefirered/src/battle_anim_ice.c:1053
  function mistBallStep(t: Task, vm: any): void {
    const d = t.data;
    const f = vm._fogBg;
    if (f) f.x = f.x + d[15];
    if (d[12] === 0) {
      d[9] = d[9] + 1;
      d[11] = MIST_BLEND[d[9]] ?? 5;
      if (f) { f.eva = d[11]; f.evb = 17 - d[11]; }
      if (d[11] === 5) {
        d[12] = d[12] + 1;
        d[11] = 0;
      }
    } else if (d[12] === 1) {
      d[11] = d[11] + 1;
      if (d[11] === 0x51) {
        d[11] = 5;
        d[12] = d[12] + 1;
      }
    } else if (d[12] === 2) {
      d[10] = d[10] + 1;
      if (d[10] === 4) {
        d[10] = 0;
        d[11] = d[11] - 1;
        if (f) { f.eva = d[11]; f.evb = 16 - d[11]; }
        if (d[11] === 0) {
          d[12] = d[12] + 1;
          d[11] = 0;
        }
      }
    } else {
      fog_end(t, vm);
    }
  }

  // Lua: g4_tasks_b.lua:646 -- pokefirered/src/battle_anim_ice.c:1029
  TK.MistBallFog = function (t: Task, vm: any): void {
    fog_begin(t, vm);
    t.data[15] = -1;
    t.func = mistBallStep;
  };

  // pokefirered/src/battle_anim_ice.c:366
  const HAIL_COORDS: any[] = [
    seq<any>(100, 120, "player", 2), seq<any>(85, 120, "player", 0), seq<any>(242, 120, "enemy", 1),
    seq<any>(66, 120, "player_right", 1), seq<any>(182, 120, "enemy_right", 0), seq<any>(60, 120, "player", 2),
    seq<any>(214, 120, "enemy", 0), seq<any>(113, 120, "player", 1), seq<any>(210, 120, "enemy_right", 1),
    seq<any>(38, 120, "player_right", 0),
  ];

  // Lua: g4_tasks_b.lua:661 -- pokefirered/src/battle_anim_ice.c:1391
  function hailContinue(s: S): void {
    s.data[0] = s.data[0] + 1;
    if (s.data[0] === 20) {
      if (task_alive(s)) {
        const k = s.data[7];
        s._task.data[k] = s._task.data[k] - 1;
      }
      P.destroy(s);
    }
  }

  // Lua: g4_tasks_b.lua:673 -- pokefirered/src/battle_anim_ice.c:1362
  function hailBegin(s: S): void {
    s.x = s.x + 4;
    s.y = s.y + 8;
    if (s.x < s.data[3] && s.y < s.data[4]) return;
    if (s.data[0] === 1 && s.data[5] === 0) {
      const vm = s._vm;
      const h = P.createSprite(vm, "ICE_CRYSTALS", T.gIceCrystalHitLargeSpriteTemplate, s.data[3], s.data[4], s.subpriority, hailContinue, 8, 16);
      if (h) {
        h._task = s._task; h._taskId = s._taskId;
        h.data[6] = s.data[6];
        h.data[7] = s.data[7];
      }
      P.destroy(s);
    } else {
      if (task_alive(s)) {
        const k = s.data[7];
        s._task.data[k] = s._task.data[k] - 1;
      }
      P.destroy(s);
    }
  }

  // Lua: g4_tasks_b.lua:696 -- pokefirered/src/battle_anim_ice.c:1304
  function generateHail(t: Task, vm: any, id: number, affNum: number, c: number): boolean {
    const e = HAIL_COORDS[id];
    let bx = e[1], by = e[2];
    let possible = 0;
    if (e[4] !== 2 && (e[3] === "player" || e[3] === "enemy")) {
      const p = P.present(e[3]);
      if (p && p.visible !== false) {
        possible = 1;
        bx = P.coord(vm, e[3], P.X_2);
        by = P.coord(vm, e[3], P.Y_PIC_OFFSET);
        const [w, h] = K.monSize(vm, e[3]);
        if (e[4] === 0) {
          bx = bx - P.cdiv(w, 6);
          by = by - P.cdiv(h, 6);
        } else if (e[4] === 1) {
          bx = bx + P.cdiv(w, 6);
          by = by + P.cdiv(h, 6);
        }
      }
    }
    const sx = bx - P.cdiv(by + 8, 2);
    const s = P.createSprite(vm, "HAIL", T.sHailParticleSpriteTemplate, sx, -8, 18, hailBegin, 16, 16);
    if (!s) return false;
    P.startAffineAnim(s, affNum);
    s.data[0] = possible;
    s.data[3] = bx;
    s.data[4] = by;
    s.data[5] = affNum;
    bind(s, t);
    s.data[7] = c;
    return true;
  }

  // Lua: g4_tasks_b.lua:730 -- pokefirered/src/battle_anim_ice.c:1260
  function hailStep(t: Task, vm: any): void {
    const d = t.data;
    if (d[0] === 0) {
      d[4] = d[4] + 1;
      if (d[4] > 2) {
        d[4] = 0; d[5] = 0; d[2] = 0;
        d[0] = d[0] + 1;
      }
    } else if (d[0] === 1) {
      if (d[5] === 0) {
        if (generateHail(t, vm, d[3], d[2], 1)) d[1] = d[1] + 1;
        d[2] = d[2] + 1;
        if (d[2] === 3) {
          d[3] = d[3] + 1;
          if (d[3] === 10) d[0] = d[0] + 1; else d[0] = d[0] - 1;
        } else {
          d[5] = 1;
        }
      } else {
        d[5] = d[5] - 1;
      }
    } else if (d[0] === 2) {
      if (d[1] === 0) D(t);
    }
  }

  // Lua: g4_tasks_b.lua:757 -- pokefirered/src/battle_anim_ice.c:1253
  TK.Hail = function (t: Task, _vm: any): void {
    t.func = hailStep;
  };

  // Lua: g4_tasks_b.lua:762 -- pokefirered/src/battle_anim_rock.c:705
  function rollout_counter(vm: any): number {
    const ctx = vm.ctx ?? {};
    let ret = P.u8((ctx.rolloutTimerStartValue ?? 0) - (ctx.rolloutTimer ?? 0));
    if (P.u8(ret - 1) > 4) ret = 1;
    return ret;
  }

  // Lua: g4_tasks_b.lua:770 -- pokefirered/src/battle_anim_rock.c:647
  function createRolloutDirt(t: Task, vm: any): void {
    const d = t.data;
    let tpl: any, tag: string, w: number, h: number, tileOffset: number;
    const c = d[1];
    if (c === 1) {
      tpl = T.gRolloutMudSpriteTemplate; tag = "MUD_SAND"; w = 8; h = 8; tileOffset = 0;
    } else if (c === 2 || c === 3) {
      tpl = T.gRolloutRockSpriteTemplate; tag = "ROCKS"; w = 32; h = 32; tileOffset = 80;
    } else if (c === 4) {
      tpl = T.gRolloutRockSpriteTemplate; tag = "ROCKS"; w = 32; h = 32; tileOffset = 64;
    } else if (c === 5) {
      tpl = T.gRolloutRockSpriteTemplate; tag = "ROCKS"; w = 32; h = 32; tileOffset = 48;
    } else {
      return;
    }
    let x = P.u16(P.asr(d[2], 3));
    const y = P.u16(P.asr(d[3], 3));
    x = P.u16(x + d[12] * 4);
    const C = K.cb();
    const s = P.createSprite(vm, tag, tpl, x, y, 35, C ? C.rolloutParticle : P.destroy, w, h);
    if (s) {
      s.data[0] = 18;
      s.data[2] = d[12] * 20 + x + d[1] * 3;
      s.data[4] = y;
      s.data[5] = -16 - d[1] * 2;
      P.addTile(s, tileOffset);
      P.initArc(s);
      bind(s, t);
      d[11] = d[11] + 1;
    }
    d[12] = -d[12];
  }

  // Lua: g4_tasks_b.lua:804 -- pokefirered/src/battle_anim_rock.c:587
  function rolloutStep(t: Task, vm: any): void {
    const d = t.data;
    const p = t._mon;
    const st = d[0];
    if (st === 0) {
      d[6] = P.s16(d[6] - d[4]);
      d[7] = P.s16(d[7] - d[5]);
      if (p) {
        p.ox = P.asr(d[6], 3);
        p.oy = P.asr(d[7], 3);
      }
      d[9] = d[9] + 1;
      if (d[9] === 10) {
        d[11] = 20;
        d[0] = d[0] + 1;
      }
      play_se12(SE.SE_M_HEADBUTT, d[13]);
    } else if (st === 1) {
      d[11] = d[11] - 1;
      if (d[11] === 0) d[0] = d[0] + 1;
    } else if (st === 2) {
      d[9] = d[9] - 1;
      if (d[9] !== 0) {
        d[6] = P.s16(d[6] + d[4]);
        d[7] = P.s16(d[7] + d[5]);
      } else {
        d[6] = 0; d[7] = 0;
        d[0] = d[0] + 1;
      }
      if (p) {
        p.ox = P.asr(d[6], 3);
        p.oy = P.asr(d[7], 3);
      }
    } else if (st === 3) {
      d[2] = P.s16(d[2] + d[4]);
      d[3] = P.s16(d[3] + d[5]);
      d[9] = d[9] + 1;
      if (d[9] >= d[10]) {
        d[9] = 0;
        createRolloutDirt(t, vm);
        d[13] = d[13] + d[14];
        play_se12(SE.SE_M_DIG, d[13]);
      }
      d[8] = d[8] - 1;
      if (d[8] === 0) d[0] = d[0] + 1;
    } else if (st === 4) {
      if (d[11] === 0) D(t);
    }
  }

  // Lua: g4_tasks_b.lua:855 -- pokefirered/src/battle_anim_rock.c:544
  TK.Rollout = function (t: Task, vm: any): void {
    const d = t.data;
    t._g4rollout = true;
    const v0 = P.coord(vm, P.atk(vm), P.X_2);
    const v1 = P.coord(vm, P.atk(vm), P.Y) + 24;
    const v2 = P.coord(vm, P.tgt(vm), P.X_2);
    const v3 = P.coord(vm, P.tgt(vm), P.Y) + 24;
    const rc = rollout_counter(vm);
    if (rc === 1) d[8] = 32; else d[8] = 48 - rc * 8;
    d[0] = 0; d[11] = 0; d[9] = 0; d[12] = 1;
    let v5 = d[8];
    if (v5 < 0) v5 = v5 + 7;
    d[10] = P.asr(v5, 3) - 1;
    d[2] = v0 * 8;
    d[3] = v1 * 8;
    d[4] = P.cdiv((v2 - v0) * 8, d[8]);
    d[5] = P.cdiv((v3 - v1) * 8, d[8]);
    d[6] = 0; d[7] = 0;
    const pan1 = vm.adjustPanning(P.SOUND_PAN_ATTACKER);
    const pan2 = vm.adjustPanning(P.SOUND_PAN_TARGET);
    d[13] = pan1;
    d[14] = P.cdiv(pan2 - pan1, d[8]);
    d[1] = rc;
    t._mon = P.present(P.atk(vm));
    t.func = rolloutStep;
  };

  // Lua: g4_tasks_b.lua:883 -- pokefirered/src/battle_anim_rock.c:777
  TK.GetSeismicTossDamageLevel = function (t: Task, vm: any): void {
    const dmg = tonumber((vm.ctx ?? {}).moveDamage) ?? 0;
    if (dmg < 33) vm.args[P.ARG_RET_ID] = 0;
    if (dmg >= 33 && dmg - 33 < 33) vm.args[P.ARG_RET_ID] = 1;
    if (dmg > 65) vm.args[P.ARG_RET_ID] = 2;
    D(t);
  };

  // Lua: g4_tasks_b.lua:892 -- pokefirered/src/battle_anim_rock.c:788
  TK.MoveSeismicTossBg = function (t: Task, vm: any): void {
    const d = t.data;
    if (d[0] === 0) d[1] = 200;
    vm.bg3.y = P.s16(vm.bg3.y + P.cdiv(d[1], 10));
    d[1] = d[1] - 3;
    if (d[0] === 120) {
      D(t);
      return;
    }
    d[0] = d[0] + 1;
  };

  // Lua: g4_tasks_b.lua:905 -- pokefirered/src/battle_anim_rock.c:805
  TK.SeismicTossBgAccelerateDownAtEnd = function (t: Task, vm: any): void {
    const d = t.data;
    if (d[0] === 0) {
      d[0] = d[0] + 1;
      d[2] = vm.bg3.y;
    }
    d[1] = P.band(d[1] + 80, 0xFF);
    vm.bg3.y = d[2] + P.Cos(4, d[1]);
    if (vm.args[7] === 0xFFF) {
      vm.bg3.y = 0;
      D(t);
    }
  };

  // Lua: g4_tasks_b.lua:920 -- pokefirered/src/battle_anim_water.c:475
  TK.CreateRaindrops = function (t: Task, vm: any): void {
    const d = t.data;
    if (d[0] === 0) {
      d[1] = vm.args[0];
      d[2] = vm.args[1];
      d[3] = vm.args[2];
    }
    d[0] = d[0] + 1;
    if (d[2] !== 0 && mod(d[0], d[2]) === 1) {
      const x = P.Random() % 240;
      const y = P.Random() % 80;
      const C = K.cb();
      P.createSprite(vm, "RAIN_DROPS", T.gRainDropSpriteTemplate, x, y, 4, C ? C.rainDrop : P.destroy, 16, 32);
    }
    if (d[0] === d[3]) D(t);
  };

  // Lua: g4_tasks_b.lua:938 -- pokefirered/src/battle_anim_water.c:626
  function rotateAuroraStep(t: Task, _vm: any): void {
    const d = t.data;
    d[10] = d[10] + 1;
    if (d[10] === 3) {
      d[10] = 0;
      // require("src.core.game3.battle.anim_pal").writeFaded("RAINBOW_RINGS")
      const f = AnimPal.writeFaded("RAINBOW_RINGS");
      if (f) {
        const saved = f[1];
        for (let i = 1; i <= 7; i++) f[i] = f[i + 1];
        f[8] = saved;
      }
    }
    d[11] = d[11] + 1;
    if (d[11] === d[0]) D(t);
  }

  // Lua: g4_tasks_b.lua:955 -- pokefirered/src/battle_anim_water.c:620
  TK.RotateAuroraRingColors = function (t: Task, vm: any): void {
    t.data[0] = vm.args[0];
    t.func = rotateAuroraStep;
  };

  // Lua: g4_tasks_b.lua:961 -- pokefirered/src/battle_anim_water.c:696
  function runSinTimer(t: Task, vm: any): void {
    vm.args[7] = P.band((vm.args[7] ?? 0) + 3, 0xFF);
    t.data[0] = (t.data[0] ?? 0) - 1;
    if (t.data[0] <= 0) D(t);
  }

  // Lua: g4_tasks_b.lua:968 -- pokefirered/src/battle_anim_mons.c:1831
  function setSquash(t: Task, xs: number, ys: number, xe: number, ye: number, dur: number): void {
    const d = t.data;
    d[8] = dur;
    d[9] = xs; d[10] = ys;
    d[13] = xe; d[14] = ye;
    d[11] = P.cdiv(xe - xs, dur);
    d[12] = P.cdiv(ye - ys, dur);
  }

  // Lua: g4_tasks_b.lua:978 -- pokefirered/src/battle_anim_mons.c:1843
  function runSquash(t: Task, vm: any): number {
    const d = t.data;
    if (d[8] === 0) return 0;
    d[8] = d[8] - 1;
    if (d[8] !== 0) {
      d[9] = d[9] + d[11];
      d[10] = d[10] + d[12];
    } else {
      d[9] = d[13]; d[10] = d[14];
    }
    const p = t._mon;
    P.setMonRotScale(p, d[9], d[10], 0);
    if (d[8] !== 0) {
      P.monYOffsetFromYScale(p, t._monSide, vm);
    } else if (p) {
      p.oy = 0;
    }
    if (p) p.oy = (p.oy ?? 0) + (p._g4y ?? 0);
    return d[8];
  }

  // Lua: g4_tasks_b.lua:1000 -- pokefirered/src/battle_anim_water.c:1138
  function waterSpoutPower(vm: any): number {
    const ctx = vm.ctx ?? {};
    const hp = tonumber(ctx.attackerHp);
    let maxhp = tonumber(ctx.attackerMaxHp);
    if (hp == null || maxhp == null) return 3;
    maxhp = Math.floor(maxhp / 4);
    for (let i = 0; i <= 2; i++) {
      if (hp < maxhp * (i + 1)) return i;
    }
    return 3;
  }

  // Lua: g4_tasks_b.lua:1012 -- pokefirered/src/battle_anim_water.c:1203
  function smallWaterOrb(s: S): void {
    if (s.data[0] === 0) {
      s.data[4] = s.data[4] + mod(s.data[1], 6) * 3;
      s.data[5] = s.data[5] + mod(s.data[1], 3) * 3;
      s.data[0] = s.data[0] + 1;
    }
    s.data[2] = P.s16(s.data[2] + s.data[4]);
    s.data[3] = P.s16(s.data[3] + s.data[5]);
    s.x = P.asr(s.data[2], 4);
    s.y = P.asr(s.data[3], 4);
    if (s.x < -8 || s.x > 248 || s.y < -8 || s.y > 120) {
      if (task_alive(s)) {
        const k = s.data[7];
        s._task.data[k] = s._task.data[k] - 1;
      }
      P.destroy(s);
    }
  }

  // Lua: g4_tasks_b.lua:1032 -- pokefirered/src/battle_anim_water.c:1170
  function spoutLaunchDroplets(t: Task, vm: any): void {
    const d = t.data;
    const ax = P.coord(vm, P.atk(vm), P.X_2);
    const ay = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
    let trig = 172;
    const sub = P.subpriorityOf(P.atk(vm)) - 1;
    let inc = 4 - d[1];
    if (inc <= 0) inc = 1;
    let i = 0;
    while (i < 20) {
      const s = P.createSprite(vm, "GLOWY_BLUE_ORB", T.gSmallWaterOrbSpriteTemplate, ax, ay, sub, smallWaterOrb, 8, 8);
      if (s) {
        s.data[1] = i;
        s.data[2] = ax * 16;
        s.data[3] = ay * 16;
        s.data[4] = P.Cos(trig, 64);
        s.data[5] = P.Sin(trig, 64);
        bind(s, t);
        s.data[7] = 2;
        if (P.band(d[2], 1) !== 0) smallWaterOrb(s);
        d[2] = d[2] + 1;
      }
      trig = P.band(trig + inc * 2, 0xFF);
      i = i + inc;
    }
  }

  // Lua: g4_tasks_b.lua:1060 -- pokefirered/src/battle_anim_water.c:1051
  function spoutLaunchStep(t: Task, vm: any): void {
    const d = t.data;
    const p = t._mon;
    const st = d[0];
    if (st === 0 || st === 1) {
      if (st === 0) {
        setSquash(t, 0x100, 0x100, 224, 0x200, 32);
        d[0] = d[0] + 1;
      }
      d[3] = d[3] + 1;
      if (d[3] > 1) {
        d[3] = 0;
        d[4] = d[4] + 1;
        if (P.band(d[4], 1) !== 0) {
          if (p) { p.ox = 3; p._g4y = (p._g4y ?? 0) + 1; }
        } else if (p) {
          p.ox = -3;
        }
      }
      if (runSquash(t, vm) === 0) {
        P.monYOffsetFromYScale(p, t._monSide, vm);
        if (p) {
          p.oy = (p.oy ?? 0) + (p._g4y ?? 0);
          p.ox = 0;
        }
        d[3] = 0; d[4] = 0;
        d[0] = d[0] + 1;
      }
    } else if (st === 2) {
      d[3] = d[3] + 1;
      if (d[3] > 4) {
        setSquash(t, 224, 0x200, 384, 224, 8);
        d[3] = 0;
        d[0] = d[0] + 1;
      }
    } else if (st === 3) {
      if (runSquash(t, vm) === 0) {
        d[3] = 0; d[4] = 0;
        d[0] = d[0] + 1;
      }
    } else if (st === 4 || st === 5) {
      if (st === 4) {
        spoutLaunchDroplets(t, vm);
        d[0] = d[0] + 1;
      }
      d[3] = d[3] + 1;
      if (d[3] > 1) {
        d[3] = 0;
        d[4] = d[4] + 1;
        if (p) {
          if (P.band(d[4], 1) !== 0) p.oy = (p.oy ?? 0) + 2; else p.oy = (p.oy ?? 0) - 2;
        }
        if (d[4] === 10) {
          setSquash(t, 384, 224, 0x100, 0x100, 8);
          d[3] = 0; d[4] = 0;
          d[0] = d[0] + 1;
        }
      }
    } else if (st === 6) {
      if (p) p._g4y = (p._g4y ?? 0) - 1;
      if (runSquash(t, vm) === 0) {
        P.resetMonRotScale(p);
        if (p) {
          p._g4y = null;
          p.oy = 0;
        }
        d[4] = 0;
        d[0] = d[0] + 1;
      }
    } else if (st === 7) {
      if (d[2] === 0) D(t);
    }
  }

  // Lua: g4_tasks_b.lua:1135 -- pokefirered/src/battle_anim_water.c:1040
  TK.WaterSpoutLaunch = function (t: Task, vm: any): void {
    t._monSide = P.atk(vm);
    t._mon = P.present(t._monSide);
    t.data[1] = waterSpoutPower(vm);
    if (t._mon) t._mon.visible = true;
    t.func = spoutLaunchStep;
  };

  // Lua: g4_tasks_b.lua:1144 -- pokefirered/src/battle_anim_water.c:1328
  function spoutRainHit(s: S): void {
    s.data[1] = s.data[1] + 1;
    if (s.data[1] > 1) {
      s.data[1] = 0;
      P.setInvisible(s, !P.isInvisible(s));
      s.data[2] = s.data[2] + 1;
      if (s.data[2] === 12) {
        if (task_alive(s)) {
          const k = s.data[7];
          s._task.data[k] = s._task.data[k] - 1;
        }
        P.destroy(s);
      }
    }
  }

  // Lua: g4_tasks_b.lua:1161 -- pokefirered/src/battle_anim_water.c:1307
  function spoutRain(s: S): void {
    if (s.data[0] === 0) {
      s.y = s.y + 8;
      if (s.y >= s.data[5]) {
        if (task_alive(s)) s._task.data[10] = 1;
        const h = P.createSprite(s._vm, "WATER_IMPACT", T.gWaterHitSplatSpriteTemplate, s.x, s.y, 1, spoutRainHit, 32, 32);
        if (h) {
          P.startAffineAnim(h, 3);
          h._task = s._task; h._taskId = s._taskId;
          h.data[6] = s.data[6];
          h.data[7] = s.data[7];
        }
        P.destroy(s);
      }
    }
  }

  // Lua: g4_tasks_b.lua:1179 -- pokefirered/src/battle_anim_water.c:1289
  function spoutRainDroplet(t: Task, vm: any): void {
    const d = t.data;
    const yPos = P.u16(P.asr(P.gSine(d[8]) + 3, 4) + d[6]);
    const s = P.createSprite(vm, "GLOWY_BLUE_ORB", T.gSmallWaterOrbSpriteTemplate, d[7], 0, 0, spoutRain, 8, 8);
    if (s) {
      s.data[5] = yPos;
      bind(s, t);
      s.data[7] = 9;
      d[9] = d[9] + 1;
    }
    d[11] = d[11] + 1;
    d[8] = P.band(d[8] + 39, 0xFF);
    // bit.band on the (exact, < 2^53) product wraps to 32 bits, like JS &.
    const r = P.u16(P.band(1103515245 * P.u16(d[7]) + 12345, 0xFFFFFFFF));
    if (d[5] !== 0) d[7] = P.s16(mod(r, d[5]) + d[4]);
  }

  // Lua: g4_tasks_b.lua:1196 -- pokefirered/src/battle_anim_water.c:1246
  function spoutRainStep(t: Task, vm: any): void {
    const d = t.data;
    if (d[0] === 0) {
      d[2] = d[2] + 1;
      if (d[2] > 2) {
        d[2] = 0;
        spoutRainDroplet(t, vm);
      }
      if (d[10] !== 0 && d[13] === 0) {
        for (const [, who] of ipairs<number>(seq(P.ANIM_TARGET, P.ANIM_DEF_PARTNER))) {
          vm.args[0] = who; vm.args[1] = 0; vm.args[2] = 12;
          const nt = K.host.spawn("HorizontalShake", 80, {}, vm);
          if (nt) {
            nt._g4kind = "visual";
            nt.func(nt, vm);
          }
        }
        d[13] = 1;
      }
      if (d[11] >= d[12]) d[0] = d[0] + 1;
    } else if (d[0] === 1) {
      if (d[9] === 0) D(t);
    }
  }

  // Lua: g4_tasks_b.lua:1222 -- pokefirered/src/battle_anim_water.c:1225
  TK.WaterSpoutRain = function (t: Task, vm: any): void {
    const d = t.data;
    d[1] = waterSpoutPower(vm);
    if (P.atk(vm) === "player") {
      d[4] = 136; d[6] = 40;
    } else {
      d[4] = 16; d[6] = 80;
    }
    d[5] = 98;
    d[7] = d[4] + 49;
    d[12] = d[1] * 5 + 5;
    t.func = spoutRainStep;
  };

  // Lua: g4_tasks_b.lua:1237 -- pokefirered/src/battle_anim_water.c:1465
  function waterSportDropletStep(s: S): void {
    if (P.translateHArc(s)) {
      if (task_alive(s)) {
        s._task.data[10] = 1;
        s._task.data[8] = s._task.data[8] - 1;
      }
      P.destroy(s);
    }
  }

  // Lua: g4_tasks_b.lua:1248 -- pokefirered/src/battle_anim_water.c:1450
  function waterSportDroplet(s: S): void {
    if (P.translateHArc(s)) {
      s.x = s.x + s.ox;
      s.y = s.y + s.oy;
      s.ox = 0; s.oy = 0;
      s.data[0] = 6;
      s.data[2] = P.band(P.Random(), 0x1F) - 16 + s.x;
      s.data[4] = P.band(P.Random(), 0x1F) - 16 + s.y;
      s.data[5] = P.s16(P.bxor(P.band(P.Random(), 7), 0xFFFF));
      P.initArc(s);
      s.callback = waterSportDropletStep;
    }
  }

  // Lua: g4_tasks_b.lua:1263 -- pokefirered/src/battle_anim_water.c:1429
  function waterSportCreate(t: Task, vm: any): void {
    const d = t.data;
    d[2] = d[2] + 1;
    if (d[2] > 1) {
      d[2] = 0;
      const s = P.createSprite(vm, "GLOWY_BLUE_ORB", T.gSmallWaterOrbSpriteTemplate, d[3], d[4], 10, waterSportDroplet, 8, 8);
      if (s) {
        s.data[0] = 16;
        s.data[2] = d[5];
        s.data[4] = d[6];
        s.data[5] = d[9];
        P.initArc(s);
        bind(s, t);
        d[8] = d[8] + 1;
      }
    }
  }

  // Lua: g4_tasks_b.lua:1282 -- pokefirered/src/battle_anim_water.c:1360
  function waterSportStep(t: Task, vm: any): void {
    const d = t.data;
    const st = d[0];
    if (st === 0) {
      waterSportCreate(t, vm);
      if (d[10] === 0) d[0] = d[0] + 1; else d[0] = d[0] + 2;
    } else if (st === 1) {
      waterSportCreate(t, vm);
      d[1] = d[1] + 1;
      if (d[1] > 16) {
        d[1] = 0;
        d[0] = d[0] + 1;
      }
    } else if (st === 2) {
      waterSportCreate(t, vm);
      d[5] = d[5] + d[7] * 6;
      if (!(d[5] >= -16 && d[5] <= 256)) {
        d[12] = d[12] + 1;
        if (d[12] > 2) {
          d[13] = 1;
          d[0] = 6;
          d[1] = 0;
        } else {
          d[1] = 0;
          d[0] = d[0] + 1;
        }
      }
    } else if (st === 3 || st === 5) {
      waterSportCreate(t, vm);
      d[6] = d[6] - d[7] * 2;
      d[1] = d[1] + 1;
      if (d[1] > 7) {
        if (st === 3) d[0] = d[0] + 1; else d[0] = 2;
      }
    } else if (st === 4) {
      waterSportCreate(t, vm);
      d[5] = d[5] - d[7] * 6;
      if (!(d[5] >= -16 && d[5] <= 256)) {
        d[12] = d[12] + 1;
        d[1] = 0;
        d[0] = d[0] + 1;
      }
    } else if (st === 6) {
      d[1] = (d[1] ?? 0) + 1;
      if (d[8] <= 0 || d[1] > 60) d[0] = d[0] + 1;
    } else {
      D(t);
    }
  }

  // Lua: g4_tasks_b.lua:1333 -- pokefirered/src/battle_anim_water.c:1343
  TK.WaterSport = function (t: Task, vm: any): void {
    const d = t.data;
    d[10] = vm.args[0] ?? 0;
    d[3] = P.coord(vm, P.atk(vm), P.X_2);
    d[4] = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
    d[7] = (P.atk(vm) === "player") ? 1 : -1;
    d[5] = d[3] + d[7] * 8;
    d[6] = d[4] - d[7] * 8;
    d[9] = -32;
    d[1] = 0;
    d[0] = 0;
    t.func = waterSportStep;
  };

  // Lua: g4_tasks_b.lua:1348 -- pokefirered/src/battle_anim_water.c:689
  TK.StartSinAnimTimer = function (t: Task, vm: any): void {
    t.data[0] = vm.args[0];
    vm.args[7] = 0;
    t.func = runSinTimer;
  };

  return TK;
}
