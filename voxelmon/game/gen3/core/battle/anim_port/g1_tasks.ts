// Port of gen1recomp src/core/game3/battle/anim_port/g1_tasks.lua (GPLv3 + additional terms; see LICENSE.md).
// Group 1 visual tasks (battle_anim_normal.c / battle_anim_utility_funcs.c
// palette blends, terrain shake, invert, backups, Leaf Blade, Moonlight ...);
// part B is g1_tasks_b. anim_tasks merges the table by name.
//
// Port notes:
// - A lazily-required module: anim_tasks pcall(require)s
//   "src.core.game3.battle.anim_port.g1_tasks"; it is registered in G3Lazy.
// - NOT FAITHFUL (ES module order): Brian fills T at require time
//   (`T.X = K.wrap(...)`, `B0(T, F)`, the CAMOUFLAGE / MAGICAL_LEAF_COLORS
//   tables built with P.RGB). Module-scope code must not call an import, so
//   the body is loadG1Tasks(), run once on first use, and the two colour
//   tables are built on first read. The G3Lazy entry is that loader as a
//   function module (anim_tasks calls a function entry and merges what it
//   returns).
// - Lazy in-function requires (anim_pal, anim_sprites, g1_callbacks,
//   g1_callbacks_b) are static imports; `require(g1_callbacks_b)` for its
//   side effect on P is its ensureTop(); g1_callbacks is its loader.
// - pcall(require, "src.core.game3.battle.bg"): ported (ok path).
//   pcall(require, "...anim_port.g3_pret"): another group's module, imported
//   by path; its ensureColorOverlay call keeps Brian's pcall.
// - S.inits[C.SolarBeamSmallOrb] is S.inits.get(...) (a WeakMap).
// - Tables keyed [0] = ... are JS arrays (keys 0..n).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber } from "../../../../../import/gen3/lua.ts";
import { ipairs, len, type LuaTable } from "../../../platform/lt.ts";
import { G3Lazy } from "../../lazy_registry.ts";
import { AnimPal } from "../anim_pal.ts";
import { AnimSprites } from "../anim_sprites.ts";
import { BattleBg } from "../bg.ts";
import { P } from "./g1_pret.ts";
import { S } from "./g1_sprite.ts";
import { K } from "./g1_task_base.ts";
import { ensureTop as requireCallbacksB } from "./g1_callbacks_b.ts";
import { loadG1Callbacks } from "./g1_callbacks.ts";
import G1TasksB from "./g1_tasks_b.ts";
import G3Pret from "./g3_pret.ts";

export const T: Record<string, any> = {};
const F: Record<string, any> = {};

// Lua: g1_tasks.lua:15 -- returns [key, name]
function tag_key(vm: any, tagId: unknown): [string | null, string | null] {
  const name = P.tagIdToName(vm, tagId);
  return [name != null ? ("tag:" + name) : null, name];
}

// Lua: g1_tasks.lua:259 -- pokefirered/src/battle_anim_utility_funcs.c:123 (built on first read)
let CAMOUFLAGE_: number[] | null = null;
function CAMOUFLAGE(): number[] {
  return (CAMOUFLAGE_ ??= [
    P.RGB(12, 24, 2), P.RGB(0, 15, 2), P.RGB(30, 24, 11), P.RGB(0, 0, 18),
    P.RGB(11, 22, 31), P.RGB(11, 22, 31), P.RGB(22, 16, 10), P.RGB(14, 9, 3),
    P.RGB(31, 31, 31), P.RGB(31, 31, 31),
  ]);
}

// Lua: g1_tasks.lua:393 -- pokefirered/src/battle_anim_effects_1.c:1064 (built on first read)
let MAGICAL_LEAF_COLORS_: number[] | null = null;
function MAGICAL_LEAF_COLORS(): number[] {
  return (MAGICAL_LEAF_COLORS_ ??= [
    P.RGB(31, 0, 0), P.RGB(31, 19, 0), P.RGB(31, 31, 0), P.RGB(0, 31, 0),
    P.RGB(5, 14, 31), P.RGB(22, 10, 31), P.RGB(22, 21, 31),
  ]);
}

// Lua: g1_tasks.lua:712
const ARC_NEXT: Record<number, number> = { 0: 1, 2: 3, 4: 5, 6: 7, 8: 9, 10: 11 };

let leafBladeSerial = 0;
let built = false;

// Lua: g1_tasks.lua:1..820 (the module body; see the header)
export function loadG1Tasks(): Record<string, any> {
  if (built) return T;
  built = true;

  // Lua: g1_tasks.lua:21 -- pokefirered/src/battle_anim_normal.c:437
  function blend_cycle(t: any, keys: LuaTable, start: number, target: number): void {
    P.beginNormalPaletteFade(keys, t.data[1], start, target, P.u16(t.data[5]));
    t.data[2] = t.data[2] - 1;
    t.data[8] = t.data[8] ^ 1;
  }

  // Lua: g1_tasks.lua:28 -- pokefirered/src/battle_anim_normal.c:451
  function blend_cycle_loop(t: any): void {
    if (!P.fadeActive()) {
      const d = t.data;
      if (d[2] > 0) {
        let start: number, target: number;
        if (d[8] === 0) {
          start = d[3]; target = d[4];
        } else {
          start = d[4]; target = d[3];
        }
        if (d[2] === 1) target = 0;
        blend_cycle(t, t._keys, start, target);
      } else {
        K.destroy(t);
      }
    }
  }

  // Lua: g1_tasks.lua:46
  function blend_cycle_init(t: any, keys: LuaTable): void {
    const A = t._A, d = t.data;
    d[0] = A[0];
    d[1] = A[1];
    d[2] = A[2];
    d[3] = A[3];
    d[4] = A[4];
    d[5] = A[5];
    d[8] = 0;
    t._keys = keys;
    blend_cycle(t, keys, 0, d[4]);
    t._fn = blend_cycle_loop;
  }

  // Lua: g1_tasks.lua:61 -- pokefirered/src/battle_anim_normal.c:424
  T.BlendColorCycle = K.wrap(function (t: any, vm: any): void {
    blend_cycle_init(t, P.unpackSelected(vm, t._A[0]));
  });

  // Lua: g1_tasks.lua:66 -- pokefirered/src/battle_anim_normal.c:484
  T.BlendColorCycleExclude = K.wrap(function (t: any, _vm: any): void {
    const keys: LuaTable = [null];
    if (t._A[0] === 1) keys[len(keys) + 1] = "bg";
    blend_cycle_init(t, keys);
  });

  // Lua: g1_tasks.lua:73 -- pokefirered/src/battle_anim_normal.c:559
  T.BlendColorCycleByTag = K.wrap(function (t: any, vm: any): void {
    const [key] = tag_key(vm, t._A[0]);
    blend_cycle_init(t, key != null ? [null, key] : [null]);
  });

  // Lua: g1_tasks.lua:79 -- pokefirered/src/battle_anim_normal.c:686
  function flash_tag_step2(t: any): void {
    if (!P.fadeActive()) {
      P.beginNormalPaletteFade(t._keys, 0, 0, 0, 0);
      K.destroy(t);
    }
  }

  // Lua: g1_tasks.lua:87 -- pokefirered/src/battle_anim_normal.c:652
  function flash_tag_step1(t: any): void {
    const d = t.data;
    if (d[0] > 0) {
      d[0] = d[0] - 1;
      return;
    }
    if (P.fadeActive()) return;
    if (d[2] === 0) {
      t._fn = flash_tag_step2;
      return;
    }
    if ((d[1] & 0x100) !== 0) {
      P.beginNormalPaletteFade(t._keys, 0, d[4], d[4], P.u16(d[3]));
    } else {
      P.beginNormalPaletteFade(t._keys, 0, d[6], d[6], P.u16(d[5]));
    }
    d[1] = d[1] ^ 0x100;
    d[0] = d[1] & 0xFF;
    d[2] = d[2] - 1;
  }

  // Lua: g1_tasks.lua:109 -- pokefirered/src/battle_anim_normal.c:631
  T.FlashAnimTagWithColor = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    for (let i = 1; i <= 6; i++) d[i] = A[i];
    d[0] = A[1];
    d[7] = A[0];
    const [key] = tag_key(vm, A[0]);
    t._keys = key != null ? [null, key] : [null];
    P.beginNormalPaletteFade(t._keys, 0, A[4], A[4], P.u16(A[3]));
    t._fn = flash_tag_step1;
  });

  // Lua: g1_tasks.lua:121 -- pokefirered/src/battle_anim_normal.c:698
  T.InvertScreenColor = K.wrap(function (t: any, vm: any): void {
    const A = t._A;
    if ((A[0] & 0x100) !== 0) P.Pal.invert("bg");
    if ((A[1] & 0x100) !== 0) P.Pal.invert(P.atk(vm));
    if ((A[2] & 0x100) !== 0) P.Pal.invert(P.tgt(vm));
    P.Pal.flush();
    K.destroy(t);
  });

  // Lua: g1_tasks.lua:131 -- pokefirered/src/battle_anim_normal.c:864
  function shake_terrain_set(vm: any, x: number, y: number): void {
    const Anim = P.anim();
    if (vm) {
      vm.bg3 = vm.bg3 ?? { x: 0, y: 0 };
      vm.bg3.x = x;
      vm.bg3.y = y;
    }
    Anim._bg3Scroll = Anim._bg3Scroll ?? { x: 0, y: 0 };
    Anim._bg3Scroll.x = x;
    Anim._bg3Scroll.y = y;
  }

  // Lua: g1_tasks.lua:143 -- returns [x, y]
  function shake_terrain_get(vm: any): [number, number] {
    const b = vm ? vm.bg3 : null;
    if (b) return [b.x ?? 0, b.y ?? 0];
    const s = P.anim()._bg3Scroll;
    return [s ? (s.x ?? 0) : 0, s ? (s.y ?? 0) : 0];
  }
  F.bg3Set = shake_terrain_set;
  F.bg3Get = shake_terrain_get;

  // Lua: g1_tasks.lua:152 -- pokefirered/src/battle_anim_normal.c:877
  function shake_terrain_step(t: any, vm: any): void {
    const d = t.data;
    if (d[3] === 0) {
      let [x, y] = shake_terrain_get(vm);
      if (x === d[0]) x = -d[0]; else x = d[0];
      if (y === -d[1]) y = 0; else y = -d[1];
      d[3] = d[8];
      d[2] = d[2] - 1;
      if (d[2] <= 0) {
        shake_terrain_set(vm, 0, 0);
        K.destroy(t);
        return;
      }
      shake_terrain_set(vm, x, y);
    } else {
      d[3] = d[3] - 1;
    }
  }

  // Lua: g1_tasks.lua:172 -- pokefirered/src/battle_anim_normal.c:864
  T.ShakeBattleTerrain = K.wrap(function (t: any, vm: any): void {
    const A = t._A, d = t.data;
    d[0] = A[0];
    d[1] = A[1];
    d[2] = A[2];
    d[3] = A[3];
    d[8] = A[3];
    shake_terrain_set(vm, A[0], A[1]);
    t._fn = shake_terrain_step;
    t._fn(t, vm);
  });

  // Lua: g1_tasks.lua:185 -- pokefirered/src/battle_anim_utility_funcs.c:184
  function blend_sprite_color_step2(t: any): void {
    const d = t.data;
    if (d[9] === d[2]) {
      d[9] = 0;
      for (const [, key] of ipairs(t._keys)) P.Pal.blend(key, d[10], P.u16(d[5]));
      P.Pal.flush();
      if (d[10] < d[4]) {
        d[10] = d[10] + 1;
      } else if (d[10] > d[4]) {
        d[10] = d[10] - 1;
      } else {
        K.destroy(t);
      }
    } else {
      d[9] = d[9] + 1;
    }
  }

  // Lua: g1_tasks.lua:204 -- pokefirered/src/battle_anim_utility_funcs.c:171
  function start_blend_anim_sprite_color(t: any, keys: LuaTable): void {
    const A = t._A, d = t.data;
    t._keys = keys;
    d[2] = A[1];
    if ((A[2] ?? 0) > 16) {
      d[3] = 0;
      d[4] = 16;
      d[5] = A[2];
      d[10] = 0;
    } else {
      d[3] = A[2];
      d[4] = A[3];
      d[5] = A[4];
      d[10] = A[2];
    }
    t._fn = blend_sprite_color_step2;
    t._fn(t);
  }

  // Lua: g1_tasks.lua:224 -- pokefirered/src/battle_anim_utility_funcs.c:53
  T.BlendBattleAnimPal = K.wrap(function (t: any, vm: any): void {
    const sel = t._A[0];
    const keys = P.unpackSelected(vm, sel);
    if ((sel & 0x80) !== 0) keys[len(keys) + 1] = 0;
    if ((sel & 0x100) !== 0 && P.spriteVisible(2)) keys[len(keys) + 1] = 2;
    if ((sel & 0x200) !== 0) keys[len(keys) + 1] = 1;
    if ((sel & 0x400) !== 0 && P.spriteVisible(3)) keys[len(keys) + 1] = 3;
    start_blend_anim_sprite_color(t, keys);
  });

  // Lua: g1_tasks.lua:235 -- pokefirered/src/battle_anim_utility_funcs.c:75
  T.BlendBattleAnimPalExclude = K.wrap(function (t: any, vm: any): void {
    const cmd = t._A[0];
    let keys: LuaTable = [null, "bg"];
    let ex1: number | null = null, ex2: number | null = null;
    if (cmd === 2 || cmd === 0) {
      if (cmd === 2) keys = [null];
      ex1 = P.atkId(vm);
    } else if (cmd === 3 || cmd === 1) {
      if (cmd === 3) keys = [null];
      ex1 = P.tgtId(vm);
    } else if (cmd === 4) {
      ex1 = P.atkId(vm);
      ex2 = P.tgtId(vm);
    } else if (cmd === 6) {
      keys = [null];
      ex1 = P.atkId(vm) ^ 2;
    } else if (cmd === 7) {
      keys = [null];
      ex1 = P.tgtId(vm) ^ 2;
    }
    for (const [, id] of ipairs(P.visibleIds(ex1, ex2))) keys[len(keys) + 1] = id;
    start_blend_anim_sprite_color(t, keys);
  });

  // Lua: g1_tasks.lua:265
  F.battleTerrain = function (vm: any): number {
    let v = K.ctx(vm, "battleTerrain", null);
    if (v == null) {
      // pcall(require, "src.core.game3.battle.bg"): ported (ok path).
      const BB: any = BattleBg;
      const r = (BB && BB.terrainId) ? BB.terrainId() : null;
      v = (r != null && r !== false) ? r : 8;
    }
    return tonumber(v) ?? 8;
  };

  // Lua: g1_tasks.lua:274
  T.SetCamouflageBlend = K.wrap(function (t: any, vm: any): void {
    const keys = P.unpackSelected(vm, t._A[0]);
    const c = CAMOUFLAGE()[F.battleTerrain(vm)];
    if (c != null) t._A[4] = c;
    start_blend_anim_sprite_color(t, keys);
  });

  // Lua: g1_tasks.lua:282 -- pokefirered/src/battle_anim_utility_funcs.c:163
  T.BlendParticle = K.wrap(function (t: any, vm: any): void {
    const [key] = tag_key(vm, t._A[0]);
    start_blend_anim_sprite_color(t, key != null ? [null, key] : [null]);
  });

  // Lua: g1_tasks.lua:288 -- pokefirered/src/battle_anim_mons.c:1628
  function blend_in_out_step(t: any): void {
    const d = t.data;
    d[4] = d[4] + 1;
    if (d[4] >= d[5]) {
      d[4] = 0;
      if (d[6] === 0) {
        d[2] = d[2] + 1;
        P.Pal.blend(t._key, d[2], P.u16(d[1]));
        if (d[2] === d[3]) d[6] = 1;
      } else {
        d[2] = d[2] - 1;
        P.Pal.blend(t._key, d[2], P.u16(d[1]));
        if (d[2] === 0) {
          d[7] = d[7] - 1;
          if (d[7] !== 0) {
            d[4] = 0;
            d[6] = 0;
          } else {
            P.Pal.flush();
            K.destroy(t);
            return;
          }
        }
      }
      P.Pal.flush();
    }
  }

  // Lua: g1_tasks.lua:317 -- pokefirered/src/battle_anim_mons.c:1616
  function blend_in_out_setup(t: any, key: any): void {
    const A = t._A, d = t.data;
    t._key = key;
    d[1] = A[1];
    d[2] = 0;
    d[3] = A[2];
    d[4] = 0;
    d[5] = A[3];
    d[6] = 0;
    d[7] = A[4];
    t._fn = blend_in_out_step;
  }

  // Lua: g1_tasks.lua:331 -- pokefirered/src/battle_anim_mons.c:1603
  T.BlendMonInAndOut = K.wrap(function (t: any, vm: any): void {
    const side = K.battlerSide(vm, t._A[0]);
    if (side == null || side === false) return K.destroy(t);
    blend_in_out_setup(t, side);
  });

  // Lua: g1_tasks.lua:338 -- pokefirered/src/battle_anim_mons.c:1664
  T.BlendPalInAndOutByTag = K.wrap(function (t: any, vm: any): void {
    const [key] = tag_key(vm, t._A[0]);
    if (key == null) return K.destroy(t);
    blend_in_out_setup(t, key);
  });

  // Lua: g1_tasks.lua:345 -- pokefirered/src/battle_anim_utility_funcs.c:213
  T.HardwarePaletteFade = K.wrap(function (t: any, vm: any): void {
    const A = t._A;
    P.beginHardwarePaletteFade(A[0], A[1], A[2], A[3], A[4]);
    // pcall(require, "src.core.game3.battle.anim_port.g3_pret"): another group's module.
    const G3: any = G3Pret;
    if (G3 != null && typeof G3 === "object" && G3.ensureColorOverlay) {
      try { G3.ensureColorOverlay(vm); } catch { /* pcall */ }
    }
    t._fn = function (tt: any): void {
      if (!P.fadeActive()) K.destroy(tt);
    };
  });

  // Lua: g1_tasks.lua:356 -- pokefirered/src/battle_anim_effects_1.c:4896
  T.ConversionAlphaBlend = K.wrap(function (t: any, vm: any): void {
    t._fn = function (tt: any, v: any): void {
      const d = tt.data;
      if (d[2] === 1) {
        if (v && v.args) v.args[7] = -1;
        d[2] = d[2] + 1;
      } else if (d[2] === 2) {
        K.destroy(tt);
      } else {
        d[0] = d[0] + 1;
        if (d[0] === 4) {
          d[0] = 0;
          d[1] = d[1] + 1;
          P.setBldAlpha(v, 16 - d[1], d[1]);
          if (d[1] === 16) d[2] = d[2] + 1;
        }
      }
    };
    t._fn(t, vm);
  });

  // Lua: g1_tasks.lua:378 -- pokefirered/src/battle_anim_effects_1.c:4945
  T.Conversion2AlphaBlend = K.wrap(function (t: any, vm: any): void {
    t._fn = function (tt: any, v: any): void {
      const d = tt.data;
      d[0] = d[0] + 1;
      if (d[0] === 4) {
        d[0] = 0;
        d[1] = d[1] + 1;
        P.setBldAlpha(v, d[1], 16 - d[1]);
        if (d[1] === 16) K.destroy(tt);
      }
    };
    t._fn(t, vm);
  });

  // Lua: g1_tasks.lua:399 -- pokefirered/src/battle_anim_effects_1.c:3668
  T.CycleMagicalLeafPal = K.wrap(function (t: any, vm: any): void {
    t._fn = function (tt: any, v: any): void {
      const d = tt.data;
      if (d[0] === 0) {
        d[0] = d[0] + 1;
      } else if (d[0] === 1) {
        d[9] = d[9] + 1;
        if (d[9] >= 0) {
          d[9] = 0;
          P.Pal.blend("tag:LEAF", d[10], MAGICAL_LEAF_COLORS()[d[11]]);
          P.Pal.blend("tag:RAZOR_LEAF", d[10], MAGICAL_LEAF_COLORS()[d[11]]);
          P.Pal.flush();
          d[10] = d[10] + 1;
          if (d[10] === 17) {
            d[10] = 0;
            d[11] = d[11] + 1;
            if (d[11] === 7) d[11] = 0;
          }
        }
      }
      if (v && v.args && P.s16(v.args[7] ?? 0) === -1) K.destroy(tt);
    };
    t._fn(t, vm);
  });

  // Lua: g1_tasks.lua:425 -- pokefirered/src/battle_anim_effects_1.c:5289
  T.MusicNotesRainbowBlend = K.wrap(function (t: any, _vm: any): void {
    requireCallbacksB(); // require("src.core.game3.battle.anim_port.g1_callbacks_b")
    for (let j = 0; j <= 3; j++) {
      const row = P.PARTICLES_COLOR_BLEND[j];
      let f: any = null;
      if (j === 0) {
        if (AnimPal.isLoaded(row[1])) f = AnimPal.writeFaded(row[1]);
      } else {
        AnimPal.alloc(row[1]);
        f = AnimPal.writeFaded(row[1]);
      }
      if (f) {
        for (let i = 1; i <= 5; i++) f[i] = row[i + 1];
      }
    }
    K.destroy(t);
  });

  // Lua: g1_tasks.lua:445 -- pokefirered/src/battle_anim_effects_1.c:5317
  T.MusicNotesClearRainbowBlend = K.wrap(function (t: any, _vm: any): void {
    requireCallbacksB(); // require("src.core.game3.battle.anim_port.g1_callbacks_b")
    for (let j = 1; j <= 3; j++) {
      AnimPal.free(P.PARTICLES_COLOR_BLEND[j][1]);
    }
    K.destroy(t);
  });

  // Lua: g1_tasks.lua:455 -- pokefirered/src/battle_anim_effects_1.c:5067
  function moonlight_end_fade_step(t: any, _vm: any): void {
    const d = t.data;
    if (d[0] === 0) {
      d[1] = d[1] + 1;
      if (d[1] > 0) {
        d[1] = 0;
        let color: number;
        d[2] = d[2] + 1;
        if (d[2] <= 15) {
          d[4] = d[4] + d[7];
          d[5] = d[5] + d[8];
          d[6] = d[6] + d[9];
          color = P.RGB(d[4] >>> 3, d[5] >>> 3, d[6] >>> 3);
        } else {
          color = P.RGB(27, 29, 31);
          d[0] = d[0] + 1;
        }
        const [r, g, b] = P.rgb555(color);
        P.Pal.setFaded("bg", { m: 0, r, g, b });
        P.Pal.flush();
      }
    } else if (d[0] === 1) {
      if (!P.fadeActive()) {
        AnimSprites.forEachActive(function (s: any): void {
          if (s.template === "gMoonSpriteTemplate" || s.template === "gMoonlightSparkleSpriteTemplate") {
            s.data[0] = 1;
          }
        });
        d[1] = 0;
        d[0] = d[0] + 1;
      }
    } else if (d[0] === 2) {
      d[1] = d[1] + 1;
      if (d[1] > 30) {
        P.beginNormalPaletteFade([null, "bg", "player", "enemy"], 0, 16, 0, P.RGB(27, 29, 31));
        d[0] = d[0] + 1;
      }
    } else if (d[0] === 3) {
      if (!P.fadeActive()) K.destroy(t);
    }
  }

  // Lua: g1_tasks.lua:499 -- pokefirered/src/battle_anim_effects_1.c:5040
  T.MoonlightEndFade = K.wrap(function (t: any, vm: any): void {
    const d = t.data;
    for (let i = 0; i <= 6; i++) d[i] = 0;
    d[7] = 13;
    d[8] = 14;
    d[9] = 15;
    P.beginNormalPaletteFade([null, "player", "enemy", "tag:MOON", "tag:GREEN_SPARKLE"], 0, 0, 16, P.RGB(27, 29, 31));
    t._fn = moonlight_end_fade_step;
    t._fn(t, vm);
  });

  // Lua: g1_tasks.lua:511 -- pokefirered/src/battle_anim_utility_funcs.c:838
  T.GetBattleTerrain = K.wrap(function (t: any, vm: any): void {
    if (vm && vm.args) vm.args[0] = F.battleTerrain(vm);
    K.destroy(t);
  });

  // Lua: g1_tasks.lua:517 -- pokefirered/src/battle_anim_utility_funcs.c:844
  T.AllocBackupPalBuffer = K.wrap(function (t: any, _vm: any): void {
    P.Pal.backup = {};
    K.destroy(t);
  });

  // Lua: g1_tasks.lua:523 -- pokefirered/src/battle_anim_utility_funcs.c:850
  T.FreeBackupPalBuffer = K.wrap(function (t: any, _vm: any): void {
    P.Pal.backup = {};
    K.destroy(t);
  });

  // Lua: g1_tasks.lua:528
  function pal_sel_key(vm: any, sel: number): any {
    if (sel === 0) return "bg";
    if (sel === 1) return P.atk(vm);
    if (sel === 2) return P.tgt(vm);
    return null;
  }

  // Lua: g1_tasks.lua:536 -- pokefirered/src/battle_anim_utility_funcs.c:856
  T.CopyPalUnfadedToBackup = K.wrap(function (t: any, vm: any): void {
    const key = pal_sel_key(vm, t._A[0]);
    if (key != null) P.Pal.toBackup(t._A[1], key);
    K.destroy(t);
  });

  // Lua: g1_tasks.lua:543 -- pokefirered/src/battle_anim_utility_funcs.c:874
  T.CopyPalUnfadedFromBackup = K.wrap(function (t: any, vm: any): void {
    const key = pal_sel_key(vm, t._A[0]);
    if (key != null) P.Pal.fromBackup(t._A[1], key);
    P.Pal.flush();
    K.destroy(t);
  });

  // Lua: g1_tasks.lua:551 -- pokefirered/src/battle_anim_utility_funcs.c:892
  T.CopyPalFadedToUnfaded = K.wrap(function (t: any, vm: any): void {
    const key = pal_sel_key(vm, t._A[0]);
    if (key != null) P.Pal.copyFadedToUnfaded(key);
    P.Pal.flush();
    K.destroy(t);
  });

  // Lua: g1_tasks.lua:559 -- pokefirered/src/battle_anim_utility_funcs.c:910
  T.IsContest = K.wrap(function (t: any, vm: any): void {
    if (vm && vm.args) vm.args[7] = 0;
    K.destroy(t);
  });

  // Lua: g1_tasks.lua:565 -- pokefirered/src/battle_anim_utility_funcs.c:926
  T.IsTargetSameSide = K.wrap(function (t: any, vm: any): void {
    if (vm && vm.args) {
      vm.args[7] = (P.isOpponent(P.atk(vm)) === P.isOpponent(P.tgt(vm))) ? 1 : 0;
    }
    K.destroy(t);
  });

  // Lua: g1_tasks.lua:572
  function set_battlers(vm: any, atk: any, tgt: any): void {
    if (!vm) return;
    if (vm.setBattlers) {
      vm.setBattlers(atk, tgt);
    } else {
      if (atk != null) vm._attackerSide = atk;
      if (tgt != null) vm._targetSide = tgt;
      vm.isReversed = (vm._attackerSide === "enemy");
    }
  }

  // Lua: g1_tasks.lua:584 -- pokefirered/src/battle_anim_utility_funcs.c:919
  T.SetAnimAttackerAndTargetForEffectTgt = K.wrap(function (t: any, vm: any): void {
    const atk = K.sideFromCtx(K.ctx(vm, "battlerTarget", null));
    const tgt = K.sideFromCtx(K.ctx(vm, "effectBattler", null));
    set_battlers(vm, atk, tgt);
    K.destroy(t);
  });

  // Lua: g1_tasks.lua:592 -- pokefirered/src/battle_anim_utility_funcs.c:935
  T.SetAnimTargetToBattlerTarget = K.wrap(function (t: any, vm: any): void {
    const tgt = K.sideFromCtx(K.ctx(vm, "battlerTarget", null));
    set_battlers(vm, null, tgt);
    K.destroy(t);
  });

  // Lua: g1_tasks.lua:599 -- pokefirered/src/battle_anim_utility_funcs.c:941
  T.SetAnimAttackerAndTargetForEffectAtk = K.wrap(function (t: any, vm: any): void {
    const atk = K.sideFromCtx(K.ctx(vm, "battlerAttacker", null));
    const tgt = K.sideFromCtx(K.ctx(vm, "effectBattler", null));
    set_battlers(vm, atk, tgt);
    K.destroy(t);
  });

  // Lua: g1_tasks.lua:607 -- pokefirered/src/battle_anim_utility_funcs.c:963
  function wait_restore_visibility(t: any, vm: any): void {
    if (vm && vm.args && (tonumber(vm.args[7]) ?? 0) === 0x1000) {
      const p = P.present(t._side);
      if (p) p.battlerInvisible = t._prevInvisible;
      K.destroy(t);
    }
  }

  // Lua: g1_tasks.lua:616 -- pokefirered/src/battle_anim_utility_funcs.c:948
  T.SetAttackerInvisibleWaitForSignal = K.wrap(function (t: any, vm: any): void {
    const side = P.atk(vm);
    const p = P.present(side);
    t._side = side;
    t._prevInvisible = (p && p.battlerInvisible) || false;
    if (p) p.battlerInvisible = true;
    t._uncounted = true;
    t._fn = wait_restore_visibility;
  });

  // Lua: g1_tasks.lua:627 -- pokefirered/src/battle_anim_mons.c:1865
  T.GetFrustrationPowerLevel = K.wrap(function (t: any, vm: any): void {
    let f = tonumber(K.ctx(vm, "friendship", null));
    if (f == null) {
      const st = K.battleState();
      const b = st ? st[P.atk(vm)] : null;
      f = (b && b.mon ? tonumber(b.mon.friendship) : null) ?? 0;
    }
    let lvl: number;
    if (f <= 30) lvl = 0; else if (f <= 100) lvl = 1; else if (f <= 200) lvl = 2; else lvl = 3;
    if (vm && vm.args) vm.args[7] = lvl;
    K.destroy(t);
  });

  // Lua: g1_tasks.lua:641 -- pokefirered/src/battle_anim_effects_1.c:2510
  T.SporeDoubleBattle = K.wrap(function (t: any, _vm: any): void {
    K.destroy(t);
  });

  // Lua: g1_tasks.lua:646 -- pokefirered/src/battle_anim_effects_1.c:3545
  function leaf_blade_pos_factor(s: any): number {
    if (s.data[4] < s.y) return -8;
    return 8;
  }

  // Lua: g1_tasks.lua:652 -- pokefirered/src/battle_anim_effects_1.c:3581
  function leaf_blade_trail_cb(s: any): void {
    const d = s.data;
    d[0] = d[0] + 1;
    if (d[0] > 1) {
      d[0] = 0;
      s.visible = !s.visible;
      d[1] = d[1] + 1;
      if (d[1] > 8) {
        const owner = s._owner;
        if (owner && owner.active && owner._g1LeafBlade === s._ownerToken) {
          owner.data[12] = owner.data[12] - 1;
        }
        S.destroy(s);
      }
    }
  }

  // Lua: g1_tasks.lua:670 -- pokefirered/src/battle_anim_effects_1.c:3555
  function leaf_blade_trail(t: any): void {
    const d = t.data;
    d[14] = d[14] + 1;
    if (d[14] > 0) {
      d[14] = 0;
      const main = t._spr;
      const x = main.x + main.ox;
      const y = main.y + main.oy;
      const sp = S.create(t._vm, "gLeafBladeSpriteTemplate", x, y, d[4], leaf_blade_trail_cb);
      if (sp) {
        sp._owner = t;
        sp._ownerToken = t._g1LeafBlade;
        d[12] = d[12] + 1;
        sp.data[0] = d[13] & 1;
        d[13] = d[13] + 1;
        S.startAnim(sp, d[3]);
        sp.subpriority = d[4];
        P.updateZ(sp);
      }
    }
  }

  // Lua: g1_tasks.lua:692
  function leaf_blade_restart(t: any, sprite: any, dx: number, dy: number, subDelta: number, animNum: number): void {
    const d = t.data;
    sprite.x = sprite.x + sprite.ox;
    sprite.y = sprite.y + sprite.oy;
    sprite.ox = 0;
    sprite.oy = 0;
    sprite.data[0] = 10;
    sprite.data[1] = sprite.x;
    sprite.data[2] = dx;
    sprite.data[3] = sprite.y;
    sprite.data[4] = dy;
    sprite.data[5] = leaf_blade_pos_factor(sprite);
    d[4] = d[4] + subDelta;
    d[3] = animNum;
    sprite.subpriority = d[4];
    S.startAnim(sprite, d[3]);
    S.initArc(sprite);
    d[0] = d[0] + 1;
  }

  // Lua: g1_tasks.lua:715 -- pokefirered/src/battle_anim_effects_1.c:3359
  function leaf_blade_step(t: any): void {
    const d = t.data;
    const sprite = t._spr;
    if (!sprite || !sprite.active || sprite._owner !== t || sprite._ownerToken !== t._g1LeafBlade) {
      K.destroy(t);
      return;
    }
    const a = d[0];
    const w2 = P.cdiv(d[10], 2) + 10;
    const h2 = P.cdiv(d[11], 2) + 10;
    if (ARC_NEXT[a] != null) {
      leaf_blade_trail(t);
      if (S.translateHArc(sprite)) {
        d[15] = ARC_NEXT[a];
        d[0] = 0xFF;
      }
    } else if (a === 1) {
      leaf_blade_restart(t, sprite, d[6], d[7], 2, 1);
    } else if (a === 3) {
      leaf_blade_restart(t, sprite, d[6] - w2 * d[5], d[7] - h2 * d[5], 0, 2);
    } else if (a === 5) {
      leaf_blade_restart(t, sprite, d[6] + w2 * d[5], d[7] + h2 * d[5], -2, 3);
    } else if (a === 7) {
      leaf_blade_restart(t, sprite, d[6], d[7], 2, 4);
    } else if (a === 9) {
      leaf_blade_restart(t, sprite, d[6] - w2 * d[5], d[7] + h2 * d[5], 0, 5);
    } else if (a === 11) {
      leaf_blade_restart(t, sprite, d[8], d[9], -2, 6);
    } else if (a === 12) {
      leaf_blade_trail(t);
      if (S.translateHArc(sprite)) {
        S.destroy(sprite);
        d[0] = d[0] + 1;
      }
    } else if (a === 13) {
      if (d[12] === 0) K.destroy(t);
    } else if (a === 0xFF) {
      d[1] = d[1] + 1;
      if (d[1] > 5) {
        d[1] = 0;
        d[0] = d[15];
      }
    }
  }

  // Lua: g1_tasks.lua:763 -- pokefirered/src/battle_anim_effects_1.c:3333
  T.LeafBlade = K.wrap(function (t: any, vm: any): void {
    const d = t.data;
    const tgt = P.tgt(vm);
    d[4] = P.subpriorityOf(tgt) - 1;
    d[6] = P.coord(vm, tgt, P.X_2);
    d[7] = P.coord(vm, tgt, P.Y_PIC_OFFSET);
    d[10] = P.attr(vm, tgt, P.ATTR_WIDTH);
    d[11] = P.attr(vm, tgt, P.ATTR_HEIGHT);
    d[5] = P.isOpponent(tgt) ? 1 : -1;
    d[9] = 56 - d[5] * 64;
    d[8] = d[7] - d[9] + d[6];
    const sprite = S.create(vm, "gLeafBladeSpriteTemplate", d[8], d[9], d[4], null);
    if (!sprite) return K.destroy(t);
    leafBladeSerial = leafBladeSerial + 1;
    t._g1LeafBlade = leafBladeSerial;
    sprite._owner = t;
    sprite._ownerToken = leafBladeSerial;
    t._spr = sprite;
    sprite.data[0] = 10;
    sprite.data[1] = d[8];
    sprite.data[2] = d[6] - P.cdiv(d[10], 2) * d[5] - 10 * d[5];
    sprite.data[3] = d[9];
    sprite.data[4] = d[7] + (P.cdiv(d[11], 2) + 10) * d[5];
    sprite.data[5] = leaf_blade_pos_factor(sprite);
    S.initArc(sprite);
    t._fn = leaf_blade_step;
  });

  // Lua: g1_tasks.lua:792 -- pokefirered/src/battle_anim_effects_1.c:2335
  T.CreateSmallSolarBeamOrbs = K.wrap(function (t: any, vm: any): void {
    t._fn = function (tt: any, v: any): void {
      const d = tt.data;
      d[0] = d[0] - 1;
      if (d[0] === -1) {
        d[1] = d[1] + 1;
        d[0] = 6;
        const args = [15, 0, 80, 0];
        if (v && v.args) {
          v.args[0] = 15; v.args[1] = 0; v.args[2] = 80; v.args[3] = 0;
        }
        const C = loadG1Callbacks(); // require("src.core.game3.battle.anim_port.g1_callbacks")
        S.createAndAnimate(v, "gSolarBeamSmallOrbSpriteTemplate", 0, 0, P.subpriorityOf(P.tgt(v)) + 1, S.inits.get(C.SolarBeamSmallOrb), args);
      }
      if (d[1] === 15) K.destroy(tt);
    };
    t._fn(t, vm);
  });

  // Lua: g1_tasks.lua:811
  T._F = F;
  G1TasksB(T, F);
  for (const n of ["SimplePaletteBlend", "ComplexPaletteBlend", "BowMon", "ShakeMonOrBattleTerrain",
    "SlideMonToOffset", "SlideMonToOriginalPos", "SlideMonToOffsetAndBack"]) {
    T["_noGfx_" + n] = T[n];
  }
  T._noGfx_DoHorizontalLunge = T.HorizontalLunge;
  T._noGfx_DoVerticalDip = T.VerticalDip;
  return T;
}

// A lazily-required module (see the header): the entry is the loader.
G3Lazy["src.core.game3.battle.anim_port.g1_tasks"] = function (_host: any): Record<string, any> {
  return loadG1Tasks();
};

export default T;
