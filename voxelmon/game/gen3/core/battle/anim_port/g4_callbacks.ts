// Port of gen1recomp src/core/game3/battle/anim_port/g4_callbacks.lua (GPLv3 + additional terms; see LICENSE.md).
// The g4 group's sprite callbacks: g4_cb_a + g4_cb_b merged, each wrapped so a
// sprite gets its g4 template / default position on its first call. Also the
// player trainer's ball-throw back-pic animation (battle_main.c).

import { truthy } from "../../../../../import/gen3/lua.ts";
import { pairs, seq } from "../../../platform/lt.ts";
import { G3Lazy } from "../../lazy_registry.ts";
import { BattleProfile } from "../profile.ts";
import { Anim } from "../anim.ts";
import { AnimVm } from "../anim_vm.ts";
import { P } from "./g4_pret.ts";
import { T } from "./g4_templates.ts";
import g4CbA from "./g4_cb_a.ts";
import g4CbB from "./g4_cb_b.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type S = Record<string, any>;

// Lua: g4_callbacks.lua:4
export default function g4Callbacks(host: any): Record<string, any> {
  const C: Record<string, any> = { P: P, T: T, host: host };

  // pokefirered/src/battle_main.c:304
  const PLAYER_THROW_X = [-32, -16, -16, -32, -32, 0, 0, 0];
  // pokefirered/src/data/trainer_graphics/back_pic_anims.h:1
  const BACK_THROW: Record<string, any> = {
    red: { 1: seq({ f: 1, d: 20 }, { f: 2, d: 6 }, { f: 3, d: 6 }, { f: 4, d: 24 }, { f: 0, d: 1 }, { e: true }) },
    oldman: { 1: seq({ f: 1, d: 24 }, { f: 2, d: 9 }, { f: 3, d: 24 }, { f: 0, d: 9 }, { e: true }) },
    // pokeemerald/src/data/trainer_graphics/back_pic_anims.h:1
    rse: { 1: seq({ f: 0, d: 24 }, { f: 1, d: 9 }, { f: 2, d: 24 }, { f: 0, d: 9 }, { f: 3, d: 50 }, { e: true }) },
  };

  // Lua: g4_callbacks.lua:17
  function family_throw(): any {
    // pcall(require, "src.core.game3.battle.profile"): a real module, the ok path.
    if (BattleProfile.get().family === "rse") return BACK_THROW.rse;
    return BACK_THROW.red;
  }

  // Lua: g4_callbacks.lua:24 -- pokefirered/src/battle_main.c:2172
  C.startPlayerThrow = function (vm: any): void {
    const ctx = vm.ctx ?? {};
    const pseudo: S = {
      _g4a: truthy(ctx.oldManThrow) ? BACK_THROW.oldman : family_throw(),
      data: {},
    };
    P.startAnim(pseudo, 1);
    vm._playerThrow = pseudo;
    const stage = P.stage();
    const tp = (stage && stage.trainer) ? stage.trainer.player : null;
    vm.addSpriteHook(function (v: any): boolean {
      if (v._playerThrow !== pseudo) return false;
      if (pseudo.done) return true;
      if (pseudo.started) {
        if ((pseudo.animDelayCounter ?? 0) === 0 && tp) {
          tp.ox = (PLAYER_THROW_X[pseudo.animCmdIndex ?? 0] ?? -32) + 32;
        }
        if (pseudo.animEnded) {
          pseudo.done = true;
          return true;
        }
      }
      pseudo.started = true;
      P.animate(pseudo);
      const c = pseudo._g4a[pseudo.animNum ?? 0][(pseudo.animCmdIndex ?? 0) + 1];
      if (tp && c && c.f != null) tp.frame = c.f;
      return true;
    });
  };

  // Lua: g4_callbacks.lua:54
  C.playerThrowIndex = function (vm: any): number {
    const p = vm._playerThrow;
    return p ? (p.animCmdIndex ?? -1) : -1;
  };

  // Lua: g4_callbacks.lua:59
  C.playerThrowEnded = function (vm: any): boolean {
    const p = vm._playerThrow;
    return (!p) || p.animEnded === true;
  };

  // Lua: g4_callbacks.lua:64
  C.resetPlayerThrow = function (vm: any): void {
    const stage = P.stage();
    const tp = (stage && stage.trainer) ? stage.trainer.player : null;
    if (tp) {
      tp.frame = 0;
      tp.ox = 0;
    }
    vm._playerThrow = null;
  };

  const TABLE: Record<string, any> = {};
  // Lua: g4_callbacks.lua:75
  function merge(m: any): void {
    for (const [k, fn] of pairs(m)) TABLE[k as string] = fn;
  }
  merge(g4CbA(C));
  merge(g4CbB(C));

  const OUT: Record<string, any> = {};
  for (const [name, fn] of pairs(TABLE)) {
    // Lua: g4_callbacks.lua:83
    OUT[name as string] = function (s: S): any {
      if (!s._g4init) {
        s._g4init = true;
        let vm = s._vm;
        if (!vm) {
          // pcall(require, "src.core.game3.battle.anim"): a real module, the ok path.
          vm = (Anim && Anim.vm) ? Anim.vm() : null;
          if (!vm) vm = AnimVm.new();
          s._vm = vm;
        }
        P.setupTemplate(s, T[s.template ?? ""] ?? T.EMPTY);
        for (let i = 0; i <= 7; i++) s.data[i] = 0;
        s.ox = 0; s.oy = 0;
        s.visible = true;
        if (vm) {
          s.x = P.coord(vm, P.tgt(vm), P.X_2);
          s.y = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET);
        }
        s._pz = true;
        P.setPriority(s, s.oamPriority ?? 2, s.subpriority ?? 0);
      }
      return fn(s);
    };
  }
  OUT._g4 = C;
  return OUT;
}

// pcall(require, "src.core.game3.battle.anim_port.g4_callbacks") in anim_callbacks.lua
G3Lazy["src.core.game3.battle.anim_port.g4_callbacks"] = g4Callbacks;
