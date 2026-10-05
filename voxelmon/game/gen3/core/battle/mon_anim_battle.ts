// Port of gen1recomp src/core/game3/battle/mon_anim_battle.lua (GPLv3 + additional terms; see LICENSE.md).
// Pokemon front / back animations in battle (pret battle_main.c / pokemon
// animation callbacks through core/mon_anim), applied to the anim engine's
// present() records.
//
// Port notes:
// - _active is keyed by present-record tables: a Map.
// - The lazy requires (anim, state, options, audio, package.loaded battle /
//   runtime) are static imports.
// - pcall around Audio.playCry: errors are swallowed as in Lua.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, truthy } from "../../../../import/gen3/lua.ts";
import { seq, len, ipairs, type LuaTable } from "../../platform/lt.ts";
import MonAnim, { type MonSprite } from "../mon_anim.ts";
import Anim from "./anim.ts";
import State from "./state.ts";
import Options from "../options.ts";
import Runtime from "../runtime.ts";
import Audio from "../audio.ts";
import { Battle } from "../battle.ts";

export interface MonAnimBattleModule {
  _active: Map<any, MonSprite>;
  enabled(): boolean;
  apply(p: any, sprite: MonSprite | null | undefined): void;
  start(key: any, kind: string, opts?: any): MonSprite | undefined;
  busy(keys: LuaTable | null | undefined): boolean;
  reset(): void;
  introSteps(steps: LuaTable, wild?: any): LuaTable;
  switchSteps(steps: LuaTable | null | undefined): LuaTable | null | undefined;
}

export const MonAnimBattle = {} as MonAnimBattleModule;

MonAnimBattle._active = new Map();

// Lua: mon_anim_battle.lua:7
MonAnimBattle.enabled = function (): boolean {
  return MonAnim.enabled();
};

// Lua: mon_anim_battle.lua:14
function present(key: any): any {
  const A = Anim;
  let p = A.present(key);
  if (!truthy(p) && typeof key === "number" && key < 2) p = A.present(State.sideOf(key));
  return p;
}

// Lua: mon_anim_battle.lua:21
function battlerOf(st: any, key: any): any {
  if (!truthy(st)) {
    // package.loaded["src.core.game3.battle"]
    st = truthy(Battle) ? Battle._st : undefined;
  }
  if (!truthy(st)) return undefined;
  if (typeof key === "number") return State.battler(st, key);
  return st[key];
}

// Lua: mon_anim_battle.lua:31
function speciesOf(b: any): number | undefined {
  if (!truthy(b)) return undefined;
  return tonumber(truthy(b.species) ? b.species
    : (truthy(b.mon) ? (truthy(b.mon.species) ? b.mon.species : b.mon.speciesId) : b.mon));
}

// Lua: mon_anim_battle.lua:36
function sceneOn(): boolean {
  // pcall(require, "src.core.game3.options"); package.loaded["src.core.game3.runtime"]
  const session = truthy(Runtime) && truthy(Runtime.getSession) ? Runtime.getSession() : undefined;
  if (truthy(session) && truthy(Options.battleScene)) return Options.battleScene(session) !== false;
  return true;
}

// Lua: mon_anim_battle.lua:44
MonAnimBattle.apply = function (p: any, sprite: MonSprite | null | undefined): void {
  if (!(truthy(p) && truthy(sprite))) return;
  const t: any = MonAnim.transform(sprite!);
  p.ox = t.x2; p.oy = t.y2;
  p.sx = t.sx; p.sy = t.sy; p.rotation = t.rotation;
  p.invisible = truthy(t.invisible) ? t.invisible : undefined;
  p.monFrame = t.frame;
  if ((sprite!.blendCoeff ?? 0) > 0) {
    const [r, g, b, k] = MonAnim.blendRgb(sprite!);
    p.blendCoeff = k; p.blendColor = seq(r, g, b);
  } else {
    p.blendCoeff = undefined; p.blendColor = undefined;
  }
};

// pokeemerald/src/battle_main.c:2702
// Lua: mon_anim_battle.lua:60
MonAnimBattle.start = function (key: any, kind: string, opts?: any): MonSprite | undefined {
  opts = opts ?? {};
  const b = battlerOf(opts.st, key);
  const species = speciesOf(b);
  const p = present(key);
  if (!(species != null && truthy(p) && MonAnim.enabled())) return undefined;
  const id = typeof key === "number" ? key : ((key === "player") ? 0 : 1);
  const sprite = MonAnim.newSprite(species);
  sprite.data[0] = id; sprite.data[2] = species;
  const noAnims = !sceneOn();
  if (kind === "back") {
    const nature = Math.floor(tonumber(truthy(b.mon) ? b.mon.personality : undefined) ?? 0) % 25;
    sprite.callback = (s: MonSprite) => { MonAnim.battleBack(s, species, nature, { noAnimations: noAnims }); };
  } else {
    const noCry = truthy(opts.noCry) ? true : false;
    sprite.callback = (s: MonSprite) => {
      // pokeemerald/src/battle_main.c:2843
      if (noCry && !noAnims && MonAnim.hasTwoFramesAnimation(species)) MonAnim.startSpriteAnim(s, 1);
      MonAnim.battleFront(s, species, noCry, 1, {
        noAnimations: noAnims,
        cry: (sp: unknown, pan: number) => {
          try { Audio.playCry(sp, truthy(opts.cryMode) ? opts.cryMode : 0, pan); } catch { /* pcall */ }
        },
      });
    };
  }
  const prev = MonAnimBattle._active.get(p);
  if (prev) MonAnim.stop(prev);
  MonAnimBattle._active.set(p, sprite);
  MonAnim.run(sprite, {
    onStep: (s) => { if (MonAnimBattle._active.get(p) === s) MonAnimBattle.apply(p, s); },
    onDone: (s) => {
      if (MonAnimBattle._active.get(p) === s) {
        MonAnimBattle.apply(p, s);
        MonAnimBattle._active.delete(p);
      }
    },
  });
  return sprite;
};

// Lua: mon_anim_battle.lua:101
MonAnimBattle.busy = function (keys: LuaTable | null | undefined): boolean {
  for (const [, key] of ipairs(keys ?? [null])) {
    const p = present(key);
    const s = truthy(p) ? MonAnimBattle._active.get(p) : undefined;
    if (s && MonAnim.busy(s)) return true;
  }
  return false;
};

// Lua: mon_anim_battle.lua:110
MonAnimBattle.reset = function (): void {
  for (const [, s] of MonAnimBattle._active) MonAnim.stop(s);
  MonAnimBattle._active = new Map();
};

// Lua: mon_anim_battle.lua:115
function keysOf(d: any, dflt: any): LuaTable {
  return truthy(d.ids) ? d.ids : seq(d.id != null ? d.id : (truthy(d.side) ? d.side : dflt));
}

// Lua: mon_anim_battle.lua:119
MonAnimBattle.introSteps = function (steps: LuaTable, wild?: any): LuaTable {
  if (!MonAnim.enabled()) return steps;
  const out: any = [null];
  const add = (kind: string, data?: any) => { out[len(out) + 1] = { kind, data: data ?? {} }; };
  for (const [, step] of ipairs<any>(steps)) {
    const d = step.data ?? {};
    if (truthy(wild) && step.kind === "cry" && !truthy(d.release) && (truthy(d.side) ? d.side : "enemy") === "enemy") {
      out.pendingWildFront = keysOf(d, "enemy");
    } else {
      out[len(out) + 1] = step;
    }
    if (step.kind === "undarken" && truthy(out.pendingWildFront)) {
      // pokeemerald/src/battle_main.c:2698
      add("mon_anim", { kind: "front", ids: out.pendingWildFront });
      out.pendingWildFront = undefined;
    } else if (step.kind === "opponent_sendout") {
      // pokeemerald/src/battle_main.c:2837
      add("mon_anim", { kind: "front", ids: keysOf(d, "enemy"), noCry: true });
      out.waitFront = keysOf(d, "enemy");
    } else if (step.kind === "player_throw") {
      // pokeemerald/src/battle_main.c:2987
      add("mon_anim", { kind: "back", ids: keysOf(d, "player") });
      out.waitBack = keysOf(d, "player");
    } else if (step.kind === "healthbox") {
      // pokeemerald/src/battle_controller_opponent.c:353
      const side = truthy(d.side) ? d.side : "enemy";
      const wait = (side === "player") ? out.waitBack : out.waitFront;
      if (truthy(wait)) {
        add("mon_anim_wait", { ids: wait });
        if (side === "player") out.waitBack = undefined; else out.waitFront = undefined;
      }
    }
  }
  delete out.pendingWildFront; delete out.waitFront; delete out.waitBack;
  return out;
};

// Lua: mon_anim_battle.lua:156
function stepKey(d: any, side: any): any {
  if (d.id != null) return d.id;
  return truthy(d.side) ? d.side : side;
}

// Lua: mon_anim_battle.lua:161
MonAnimBattle.switchSteps = function (steps: LuaTable | null | undefined): LuaTable | null | undefined {
  if (!(truthy(steps) && MonAnim.enabled()) || truthy(steps!.monAnim)) return steps;
  const out: any = [null];
  out.monAnim = true;
  const wait: Record<string | number, any> = {};
  for (const [, step] of ipairs<any>(steps)) {
    const d = step.data ?? {};
    if (step.kind === "healthbox") {
      const key = stepKey(d, "enemy");
      if (wait[key] != null) {
        // pokeemerald/src/battle_controller_opponent.c:482
        out[len(out) + 1] = { kind: "mon_anim_wait", data: { ids: seq(wait[key]) } };
        delete wait[key];
      }
    }
    out[len(out) + 1] = step;
    if (step.kind === "sendout_enemy") {
      const key = stepKey(d, "enemy");
      // pokeemerald/src/battle_main.c:2837
      out[len(out) + 1] = { kind: "mon_anim", data: { kind: "front", ids: seq(key), noCry: true } };
      wait[key] = key;
    } else if (step.kind === "sendout_player") {
      const key = stepKey(d, "player");
      // pokeemerald/src/battle_main.c:2987
      out[len(out) + 1] = { kind: "mon_anim", data: { kind: "back", ids: seq(key) } };
      wait[key] = key;
    }
  }
  return out;
};

export default MonAnimBattle;
