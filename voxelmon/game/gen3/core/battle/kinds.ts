// Port of gen1recomp src/core/game3/battle/kinds.lua (GPLv3 + additional terms; see LICENSE.md).
// Battle kinds: the boolean battle-type flags of a battle state, plus the
// profile's first-battle / tutorial kind names.
//
// Port note: error(msg, 2) becomes a thrown Error (no position prefix).

import { tostring, truthy, mod } from "../../../../import/gen3/lua.ts";
import { ipairs, pairs, seq } from "../../platform/lt.ts";
import { BattleProfile, type BattleProfileT } from "./profile.ts";

export type KindsTable = Record<string, any>;

const BOOLEAN_KINDS = seq(
  "wild", "double", "link", "multi", "safari", "roamer", "legendary", "wildScripted",
  "trainerTower", "eReader", "battleTower", "secretBase", "pokedude", "ghostBattle",
  "oldManTutorial", "unionRoom", "spectate",
);

const EXTRA_KINDS = seq(
  "twoOpponents", "partner", "recordedLink", "frontier", "trainerHill", "kyogreGroudon", "regi",
  "groudon", "kyogre", "rayquaza", "dome", "palace", "arena", "factory", "pike", "pyramid",
);

export const Kinds = {
  // Lua: kinds.lua:16
  fromOpts(opts?: any, st?: any, p?: BattleProfileT): KindsTable {
    opts = opts ?? {};
    p = p ?? BattleProfile.of(st);
    const k: KindsTable = {};
    for (const [, name] of ipairs<string>(BOOLEAN_KINDS)) {
      if (truthy(st) && truthy(st[name])) k[name] = true;
    }
    for (const [, name] of ipairs<string>(EXTRA_KINDS)) {
      if (truthy(opts[name])) k[name] = true;
    }
    k.trainer = !(truthy(st) && truthy(st.wild)) || null;
    if (truthy(st) && truthy(st.firstBattle)) {
      k.firstBattle = p.kinds.firstBattle;
    } else if (opts.firstBattleKind != null) {
      if (opts.firstBattleKind !== p.kinds.firstBattle) {
        throw new Error("battle kinds: " + tostring(p.gameId) + " has no first battle kind " + tostring(opts.firstBattleKind));
      }
      k.firstBattle = opts.firstBattleKind;
    }
    if (opts.tutorialKind != null) {
      if (opts.tutorialKind !== p.kinds.tutorial) {
        throw new Error("battle kinds: " + tostring(p.gameId) + " has no tutorial kind " + tostring(opts.tutorialKind));
      }
      k.tutorial = opts.tutorialKind;
    } else if (truthy(st) && truthy(st.oldManTutorial)) {
      k.tutorial = p.kinds.tutorial;
    }
    return k;
  },

  // Lua: kinds.lua:46
  has(st: any, name: string): boolean {
    const k = truthy(st) ? st.kinds : null;
    return k != null && k[name] != null && k[name] !== false;
  },

  // Lua: kinds.lua:51
  isBirchFirstBattle(st: any): boolean {
    return st != null && st.kinds != null && st.kinds.firstBattle === "birch";
  },

  // Lua: kinds.lua:55
  isWallyTutorial(st: any): boolean {
    return st != null && st.kinds != null && st.kinds.tutorial === "wally";
  },

  // Lua: kinds.lua:59
  noCrit(st: any): boolean {
    const ex = BattleProfile.of(st).rules.critExclusions;
    if (!truthy(ex) || !truthy(st) || !truthy(st.kinds)) return false;
    if (truthy(ex.firstBattle) && truthy(st.kinds.firstBattle)) return true;
    if (truthy(ex.wallyTutorial) && st.kinds.tutorial === "wally") return true;
    return false;
  },

  // Lua: kinds.lua:67
  noExp(st: any): boolean {
    if (!truthy(st)) return false;
    const rule = BattleProfile.of(st).rules.noExp ?? {};
    for (const [name] of pairs(rule)) {
      if (truthy(st[name]) || (truthy(st.kinds) && truthy(st.kinds[name]))) return true;
    }
    return false;
  },

  // Lua: kinds.lua:77 -- pokeemerald/src/battle_controllers.c:112
  controllerOf(st: any, id: number | null | undefined): string | null {
    if (!truthy(st) || id == null) return null;
    const k = st.kinds ?? {};
    if (mod(id, 2) === 1) {
      return truthy(st.link) ? "link" : "ai";
    }
    if (truthy(st.multi) && st.linkOwn != null && id !== st.linkOwn) return "link";
    if (id === 2 && truthy(k.partner)) return "aiPartner";
    if (k.tutorial === "wally") return "tutorial";
    if (truthy(st.pokedude)) return "pokedude";
    if (truthy(st.oldManTutorial)) return "tutorial";
    return "player";
  },
};

export default Kinds;
