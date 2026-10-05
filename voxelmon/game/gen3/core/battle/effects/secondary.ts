// Port of gen1recomp src/core/game3/battle/effects/secondary.lua (GPLv3 + additional terms; see LICENSE.md).
// Secondary effects: stat stage changes, the status/volatile effect setter
// (SetMoveEffect) and the secondary-effect chance roll.
//
// Port notes:
// - `package.loaded["src.core.game3.battle.state"]` and the lazy requires
//   (items_data, rules, pokemon, effects.hazards) are static imports: every
//   module is in the bundle, so state always reads as loaded.
// - Gameplay RNG goes through the adapter (ad.roll / ad.rng) exactly where
//   Brian's does, in the same order.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { truthy, tonumber } from "../../../../../import/gen3/lua.ts";
import { ipairs, seq, type LuaTable } from "../../../platform/lt.ts";
import Types from "../types.ts";
import Oak from "../oak_advice.ts";
import RomText from "../../rom_text.ts";
import H from "./_helpers.ts";
import ItemsData from "../../items_data.ts";
import State from "../state.ts";
import Rules from "../rules.ts";
import Pokemon from "../../pokemon.ts";
import Hazards from "./hazards.ts";

/** Lua `a or b` (b already evaluated). */
function lor(a: any, b: any): any {
  return truthy(a) ? a : b;
}

/** changeStat flags. */
export interface ChangeStatFlags {
  user?: any;
  certain?: any;
  curse?: any;
  allowPtr?: any;
  noMsg?: any;
  noAnim?: any;
}

// Lua: secondary.lua:36
// src/battle_script_commands.c:6758
function stat_text(ad: any, battler: any, stat: string, delta: number, isUser: any): void {
  let change: string;
  if (delta >= 2) change = RomText.plain("STRINGID_STATSHARPLY") + RomText.plain("STRINGID_STATROSE");
  else if (delta >= 1) change = RomText.plain("STRINGID_STATROSE");
  else if (delta <= -2) change = RomText.plain("STRINGID_STATHARSHLY") + RomText.plain("STRINGID_STATFELL");
  else change = RomText.plain("STRINGID_STATFELL");
  let id: string;
  if (delta > 0) {
    id = truthy(isUser) ? "STRINGID_ATTACKERSSTATROSE" : "STRINGID_DEFENDERSSTATROSE";
  } else {
    id = truthy(isUser) ? "STRINGID_ATTACKERSSTATFELL" : "STRINGID_DEFENDERSSTATFELL";
  }
  ad.sayText(id, { atk: battler, def: battler, buff1: Secondary.statName(stat), buff2: change });
}

// data/battle_scripts_1.s:3848
const STATUS_MSG: Record<string, string> = {
  SLP: "STRINGID_PKMNFELLASLEEP",
  PSN: "STRINGID_PKMNWASPOISONED",
  BRN: "STRINGID_PKMNWASBURNED",
  FRZ: "STRINGID_PKMNWASFROZEN",
  PAR: "STRINGID_PKMNWASPARALYZED",
  TOX: "STRINGID_PKMNBADLYPOISONED",
};

const EFFECT_TO_STATUS: Record<string, string> = {
  SLEEP: "SLP", POISON: "PSN", BURN: "BRN", FREEZE: "FRZ", PARALYSIS: "PAR", TOXIC: "TOX",
};

// pokefirered/src/battle_script_commands.c:2110
const STATUS_EFFECT_RANK: Record<string, number> = {
  SLEEP: 1, POISON: 2, BURN: 3, FREEZE: 4, PARALYSIS: 5, TOXIC: 6, CONFUSION: 7,
  FLINCH: 8, TRI_ATTACK: 9,
};

// Lua: secondary.lua:182
function ability_prevention_msg(ad: any, b: any, ab: any, id: string): void {
  const abId = H.abilityId(ab);
  ad.sayText(id, { eff: b, defAbility: abId, effAbility: abId });
}

// Lua: secondary.lua:187
function apply_status_effect(M: any, eff: string, primary: any, certain: any, effBattler: any): boolean {
  const ad = M.adapter;
  const status = EFFECT_TO_STATUS[eff];
  const ab = ad.abilityOf(effBattler);
  const strict = truthy(primary) || truthy(certain);
  if (status === "PSN" || status === "TOX") {
    if (ab === "IMMUNITY" && strict) {
      ability_prevention_msg(ad, effBattler, ab, "STRINGID_PKMNPREVENTSPOISONINGWITH");
      return false;
    }
  } else if (status === "BRN") {
    if (ab === "WATER_VEIL" && strict) {
      ability_prevention_msg(ad, effBattler, ab, "STRINGID_PKMNSXPREVENTSBURNS");
      return false;
    }
  } else if (status === "PAR") {
    if (ab === "LIMBER" && strict) {
      ability_prevention_msg(ad, effBattler, ab, "STRINGID_PKMNPREVENTSPARALYSISWITH");
      return false;
    }
  }
  // a:canApplyStatus returns (ok, reason): only the first value is used.
  if (!truthy(ad.canApplyStatus(effBattler, status, M.user, { ignoreSafeguard: true })[0])) {
    if (status === "TOX" && !truthy(ad.status(effBattler))
        && (truthy(ad.hasType(effBattler, Types.ID.POISON)) || truthy(ad.hasType(effBattler, Types.ID.STEEL)))) {
      M.doesntAffect = true;
    }
    return false;
  }
  ad.applyStatus(effBattler, status, M.user, { ignoreSafeguard: true, force: true });
  ad.statusAnim(effBattler, status);
  ad.sayText(STATUS_MSG[status!], { eff: effBattler });
  // pokefirered/src/battle_script_commands.c:2376
  if (status === "PSN" || status === "TOX" || status === "PAR" || status === "BRN") {
    ad._syncEffect = { status };
  }
  return true;
}

// Lua: secondary.lua:225
function item_name(id: any): any {
  return ItemsData.displayName(id);
}

// Lua: secondary.lua:230
function is_mail(id: any): boolean {
  id = tonumber(id) ?? 0;
  return id >= 121 && id <= 132;
}

// src/battle_message.c:1042
const TRAP_MSG: Record<number, string> = {
  20: "STRINGID_PKMNSQUEEZEDBYBIND",
  35: "STRINGID_PKMNWRAPPEDBY",
  83: "STRINGID_PKMNTRAPPEDINVORTEX",
  128: "STRINGID_PKMNCLAMPED",
  250: "STRINGID_PKMNTRAPPEDINVORTEX",
  328: "STRINGID_PKMNTRAPPEDBYSANDTOMB",
};

// Lua: secondary.lua:246
function persist_item(b: any, item: any): void {
  // package.loaded["src.core.game3.battle.state"]: always loaded here.
  const Engine: any = State;
  let mon: any;
  if (truthy(Engine) && truthy(Engine.partyMon)) mon = Engine.partyMon(b);
  if (!truthy(mon)) mon = truthy(b) ? b.mon : b;
  if (truthy(mon)) {
    if (truthy(item) && item !== 0) {
      mon.item = item;
      mon.heldItem = item;
    } else {
      mon.item = null;
      mon.heldItem = null;
    }
  }
}

// Lua: secondary.lua:263
// Battle-scoped state (the adapter carries it as `_st`).  Resolved lazily so
// this module stays loadable without the battle engine.
function battle_state(): any {
  return State;
}

export const Secondary = {
  // pokefirered/include/constants/pokemon.h:167
  STAT_ID: {
    attack: 1, defense: 2, speed: 3, spAtk: 4, spDef: 5, accuracy: 6, evasion: 7,
  } as Record<string, number>,

  // pokefirered/include/battle_anim.h:41
  STAT_ANIM: {
    PLUS1: 15, PLUS2: 39, MINUS1: 22, MINUS2: 46,
    MULTIPLE_PLUS1: 55, MULTIPLE_PLUS2: 56, MULTIPLE_MINUS1: 57, MULTIPLE_MINUS2: 58,
  },

  // Lua: secondary.lua:20
  // pokefirered/src/battle_script_commands.c:3934
  statAnimArg(stat: string, delta: number): number {
    const id = lor(Secondary.STAT_ID[stat], 1);
    let base: number;
    if (delta >= 2) base = Secondary.STAT_ANIM.PLUS2;
    else if (delta >= 1) base = Secondary.STAT_ANIM.PLUS1;
    else if (delta <= -2) base = Secondary.STAT_ANIM.MINUS2;
    else base = Secondary.STAT_ANIM.MINUS1;
    return id + base - 1;
  },

  // Lua: secondary.lua:31
  // src/battle_message.c:437
  statName(stat: string): string {
    return RomText.at("gStatNamesTable", Secondary.STAT_ID[stat]!);
  },

  // Lua: secondary.lua:52
  // pokefirered/src/battle_script_commands.c:6655
  changeStat(ad: any, battler: any, stat: string, delta: number, flags?: ChangeStatFlags | null): string {
    flags = lor(flags, {}) as ChangeStatFlags;
    if (!truthy(battler) || !truthy(battler.stages)) return "blocked";
    const cur = lor(battler.stages[stat], 0);
    if (delta < 0) {
      const side = ad.ownSide(battler);
      const ab = ad.abilityOf(battler);
      if (truthy(side) && lor(side.expMistTurns, 0) > 0 && !truthy(flags.certain) && !truthy(flags.curse)) {
        if (truthy(flags.allowPtr) && !truthy(battler._statLoweredMsg)) {
          battler._statLoweredMsg = true;
          ad.sayText("STRINGID_PKMNPROTECTEDBYMIST", { scrActive: battler });
        }
        return "blocked";
      }
      if ((ab === "CLEAR_BODY" || ab === "WHITE_SMOKE") && !truthy(flags.certain) && !truthy(flags.curse)) {
        if (truthy(flags.allowPtr) && !truthy(battler._statLoweredMsg)) {
          battler._statLoweredMsg = true;
          ad.sayText("STRINGID_PKMNPREVENTSSTATLOSSWITH", { scrActive: battler, scrActiveAbility: H.abilityId(ab) });
        }
        return "blocked";
      }
      if (((ab === "KEEN_EYE" && stat === "accuracy") || (ab === "HYPER_CUTTER" && stat === "attack")) && !truthy(flags.certain)) {
        if (truthy(flags.allowPtr)) {
          ad.sayText("STRINGID_PKMNSXPREVENTSYLOSS", {
            scrActive: battler, scrActiveAbility: H.abilityId(ab), buff1: Secondary.statName(stat),
          });
        }
        return "blocked";
      }
      if (ab === "SHIELD_DUST" && !truthy(flags.allowPtr) && !truthy(flags.user)) {
        return "blocked";
      }
      if (cur <= -6) {
        if (!truthy(flags.noMsg)) {
          ad.sayText("STRINGID_STATSWONTDECREASE", { def: battler, buff1: Secondary.statName(stat) });
        }
        return "wont";
      }
    } else {
      if (cur >= 6) {
        if (!truthy(flags.noMsg)) {
          ad.sayText("STRINGID_STATSWONTINCREASE", { atk: battler, buff1: Secondary.statName(stat) });
        }
        return "wont";
      }
    }
    let nxt = cur + delta;
    if (nxt < -6) nxt = -6; else if (nxt > 6) nxt = 6;
    battler.stages[stat] = nxt;
    if (!truthy(flags.noAnim)) {
      ad.playAnim("general", "STATS_CHANGE", battler, battler, Secondary.statAnimArg(stat, delta));
    }
    if (!truthy(flags.noMsg)) {
      stat_text(ad, battler, stat, delta, flags.user);
      // pokefirered/src/battle_controller_oak_old_man.c:1768
      if (truthy(Oak.active(ad._st)) && delta < 0 && battler.side === "enemy") {
        Oak.sayOnce(ad._st, Oak.FLAG_STAT_CHG, "loweringStats", (t: any, key: any) => { ad.say(t, key); });
      }
    }
    return "worked";
  },

  // Lua: secondary.lua:115
  // pokefirered/src/battle_script_commands.c:3957
  multiStatAnim(ad: any, battler: any, stats: LuaTable, delta: number, opts?: { cantPrevent?: any } | null): number {
    opts = lor(opts, {}) as { cantPrevent?: any };
    let count = 0;
    let only: any = null;
    for (const [, s] of ipairs<string>(stats)) {
      const cur = truthy(battler.stages) && truthy(battler.stages[s]) ? battler.stages[s] : 0;
      let can: boolean;
      if (delta < 0) {
        const side = ad.ownSide(battler);
        const ab = ad.abilityOf(battler);
        if (truthy(opts.cantPrevent)) {
          can = cur > -6;
        } else {
          can = !(truthy(side) && lor(side.expMistTurns, 0) > 0)
            && ab !== "CLEAR_BODY" && ab !== "WHITE_SMOKE"
            && !(ab === "KEEN_EYE" && s === "accuracy")
            && !(ab === "HYPER_CUTTER" && s === "attack")
            && cur > -6;
        }
      } else {
        can = cur < 6;
      }
      if (can) { count = count + 1; only = s; }
    }
    if (count === 0) return 0;
    let arg: number;
    if (count > 1) {
      if (delta >= 2) arg = Secondary.STAT_ANIM.MULTIPLE_PLUS2;
      else if (delta >= 1) arg = Secondary.STAT_ANIM.MULTIPLE_PLUS1;
      else if (delta <= -2) arg = Secondary.STAT_ANIM.MULTIPLE_MINUS2;
      else arg = Secondary.STAT_ANIM.MULTIPLE_MINUS1;
    } else {
      arg = Secondary.statAnimArg(only, delta);
    }
    ad.playAnim("general", "STATS_CHANGE", battler, battler, arg);
    return count;
  },

  STAT_EFFECTS: {
    ATK_PLUS_1: seq<any>("attack", 1), DEF_PLUS_1: seq<any>("defense", 1), SPD_PLUS_1: seq<any>("speed", 1),
    SP_ATK_PLUS_1: seq<any>("spAtk", 1), SP_DEF_PLUS_1: seq<any>("spDef", 1), ACC_PLUS_1: seq<any>("accuracy", 1),
    EVS_PLUS_1: seq<any>("evasion", 1),
    ATK_MINUS_1: seq<any>("attack", -1), DEF_MINUS_1: seq<any>("defense", -1), SPD_MINUS_1: seq<any>("speed", -1),
    SP_ATK_MINUS_1: seq<any>("spAtk", -1), SP_DEF_MINUS_1: seq<any>("spDef", -1), ACC_MINUS_1: seq<any>("accuracy", -1),
    EVS_MINUS_1: seq<any>("evasion", -1),
  } as Record<string, LuaTable>,

  STATUS_MSG,

  itemName: item_name,
  isMail: is_mail,
  persistItem: persist_item,

  // Lua: secondary.lua:268
  set(M: any, eff: string, primary: any, certain: any, affectsUser: any): boolean {
    const ad = M.adapter;
    const user = M.user, target = M.target;
    const effBattler = truthy(affectsUser) ? user : target;
    const rank = STATUS_EFFECT_RANK[eff];
    if (!truthy(effBattler)) return false;
    // pokefirered/src/battle_script_commands.c:2128
    if (truthy(M.st) && truthy(M.st.pokedude) && eff !== "SLEEP" && effBattler.side === "enemy") return false;
    if (rank != null && rank <= 9 && !truthy(primary) && ad.abilityOf(effBattler) === "SHIELD_DUST" && !truthy(affectsUser)) {
      return false;
    }
    if (rank != null && rank <= 7 && !truthy(primary) && !truthy(affectsUser)) {
      const side = ad.ownSide(effBattler);
      if (truthy(side) && lor(side.expSafeguardTurns, 0) > 0) return false;
    }
    if (ad.hp(effBattler) <= 0 && eff !== "PAYDAY" && eff !== "STEAL_ITEM") return false;
    if (!truthy(affectsUser) && lor(effBattler.substituteHP, 0) > 0) return false;

    if (EFFECT_TO_STATUS[eff] != null) {
      return apply_status_effect(M, eff, primary, certain, effBattler);
    }

    if (eff === "CONFUSION") {
      if (ad.abilityOf(effBattler) === "OWN_TEMPO" || lor(effBattler.confusionTurns, 0) > 0) return false;
      effBattler.confusionTurns = ad.roll(0, 3) % 4 + 2;
      ad.playAnim("status", "CONFUSION", effBattler, effBattler);
      ad.sayText("STRINGID_PKMNWASCONFUSED", { eff: effBattler });
      return true;
    } else if (eff === "FLINCH") {
      if (ad.abilityOf(effBattler) === "INNER_FOCUS") {
        if (truthy(primary) || truthy(certain)) {
          ad.sayText("STRINGID_PKMNSXPREVENTSFLINCHING", { eff: effBattler, effAbility: H.abilityId("INNER_FOCUS") });
        }
        return false;
      }
      if (!truthy(effBattler.expMovedThisTurn)) effBattler.flinched = true;
      return true;
    } else if (eff === "UPROAR") {
      if (lor(effBattler.expUproarTurns, 0) > 0) return false;
      effBattler.expLockedMove = M.moveId;
      effBattler.expLockedSlot = M.slot;
      effBattler.expUproarTurns = ad.roll(0, 3) % 4 + 2;
      effBattler.uproar = true;
      ad.sayText("STRINGID_PKMNCAUSEDUPROAR", { atk: effBattler });
      return true;
    } else if (eff === "PAYDAY") {
      // pokefirered/src/battle_script_commands.c:2455
      if (lor(user.side, "player") === "player") {
        const lvl = tonumber(truthy(user.mon) ? user.mon.level : user.mon) ?? 1;
        M.st.payDayCoins = Math.min(0xFFFF, lor(M.st.payDayCoins, 0) + lvl * 5);
      }
      ad.sayText("STRINGID_COINSSCATTERED");
      return true;
    } else if (eff === "TRI_ATTACK") {
      if (truthy(ad.status(effBattler))) return false;
      const r = ad.roll(0, 2) % 3;
      const pick = ({ 0: "BURN", 1: "FREEZE", 2: "PARALYSIS" } as Record<number, string>)[r]!;
      return Secondary.set(M, pick, false, false, false);
    } else if (eff === "WRAP") {
      if (lor(effBattler.expTrapTurns, 0) > 0) return false;
      if (truthy(Rules.partialTrap.active) && !truthy(Rules.partialTrap.active())) return false;
      effBattler.expTrapTurns = Rules.partialTrap.rollTurns(ad.rng());
      effBattler.expTrapMove = M.mnum;
      effBattler.expTrapSource = user;
      effBattler.wrapped = true;
      ad.sayText(TRAP_MSG[M.mnum], { atk: user, def: effBattler });
      return true;
    } else if (eff === "RECOIL_25" || eff === "RECOIL_33") {
      const div = (eff === "RECOIL_25") ? 4 : 3;
      let dmg = Math.floor(lor(M.hpDealt, 0) / div);
      if (dmg === 0) dmg = 1;
      if (M.mnum !== 165 && ad.abilityOf(user) === "ROCK_HEAD") return false;
      ad.applyHpLoss(user, dmg);
      ad.sayText("STRINGID_PKMNHITWITHRECOIL", { atk: user });
      M.checkUserFaint = true;
      return true;
    } else if (truthy(Secondary.STAT_EFFECTS[eff])) {
      const spec = Secondary.STAT_EFFECTS[eff];
      const res = Secondary.changeStat(ad, effBattler, spec[1], spec[2], {
        user: affectsUser, certain, allowPtr: false,
      });
      return res === "worked";
    } else if (eff === "RECHARGE") {
      effBattler.expRechargeTurns = 2;
      effBattler.expMustRecharge = true;
      effBattler.recharge = true;
      return true;
    } else if (eff === "RAGE") {
      user.rage = true;
      return true;
    } else if (eff === "STEAL_ITEM") {
      // src/battle_script_commands.c:2610-2622
      const StType = ad._st;
      if (truthy(StType) && truthy(StType.trainerTower)) return false;
      if (user.side !== "player" && !(truthy(StType) && (truthy(StType.link) || truthy(StType.battleTower)
          || truthy(StType.eReader) || truthy(StType.secretBase)))) return false;
      const St = battle_state();
      if (truthy(user.expKnockedOff) || (truthy(St) && truthy(St.isKnockedOff(ad._st, user)))) return false;
      const tItem = tonumber(target.item) ?? 0;
      if (tItem !== 0 && ad.abilityOf(target) === "STICKY_HOLD") {
        ad.sayText("STRINGID_PKMNSXMADEYINEFFECTIVE", { def: target, defAbility: H.abilityId("STICKY_HOLD"), currentMove: M.mnum });
        return false;
      }
      if ((tonumber(user.item) ?? 0) !== 0 || tItem === 0 || tItem === 175 || is_mail(tItem)) {
        return false;
      }
      user.item = tItem;
      target.item = 0;
      persist_item(user, tItem);
      // Both sides, not just the player: leaving the victim's party mon holding
      // an item its battler no longer has duplicates it on the next send-out.
      persist_item(target, 0);
      ad.playAnim("general", "ITEM_STEAL", user, target);
      ad.sayText("STRINGID_PKMNSTOLEITEM", { atk: user, def: target, lastItem: tItem });
      return true;
    } else if (eff === "PREVENT_ESCAPE") {
      target.expTrapped = true;
      target.escapePrevention = true;
      target.expTrappedBy = user;
      return true;
    } else if (eff === "NIGHTMARE") {
      target.expNightmare = true;
      return true;
    } else if (eff === "ALL_STATS_UP") {
      const order = seq("attack", "defense", "speed", "spAtk", "spDef");
      let any = false;
      for (const [, s] of ipairs<string>(order)) {
        if (lor(user.stages[s], 0) < 6) any = true;
      }
      if (!any) return false;
      Secondary.multiStatAnim(ad, user, order, 1);
      for (const [, s] of ipairs<string>(order)) {
        if (lor(user.stages[s], 0) < 6) {
          Secondary.changeStat(ad, user, s, 1, { user: true, noAnim: true });
        }
      }
      return true;
    } else if (eff === "RAPIDSPIN") {
      // pokefirered/src/battle_script_commands.c:8435
      let did = false;
      if (lor(user.expTrapTurns, 0) > 0) {
        const src = user.expTrapSource;
        ad.sayText("STRINGID_PKMNGOTFREE", {
          atk: user, def: lor(src, target), buff1: Pokemon.moveName(user.expTrapMove),
        });
        user.expTrapTurns = null;
        user.expTrapMove = null;
        user.expTrapSource = null;
        user.wrapped = null;
        did = true;
      }
      if (truthy(user.expSeeded) || truthy(user.leechSeed)) {
        user.expSeeded = null;
        user.expSeedSource = null;
        user.leechSeed = null;
        ad.sayText("STRINGID_PKMNSHEDLEECHSEED", { atk: user });
        did = true;
      }
      const side = ad.ownSide(user);
      if (truthy(side) && Hazards.layers(side) > 0) {
        Hazards.clear(side);
        ad.sayText("STRINGID_PKMNBLEWAWAYSPIKES", { atk: user });
        did = true;
      }
      user.trapped = null;
      return did;
    } else if (eff === "REMOVE_PARALYSIS") {
      if (ad.status(target) !== "PAR") return false;
      ad.clearStatus(target);
      ad.sayText("STRINGID_PKMNHEALEDPARALYSIS", { def: target });
      return true;
    } else if (eff === "ATK_DEF_DOWN") {
      Secondary.multiStatAnim(ad, user, seq("attack", "defense"), -1, { cantPrevent: true });
      Secondary.changeStat(ad, user, "attack", -1, { user: true, certain: true, allowPtr: true, noAnim: true, noMsg: lor(user.stages.attack, 0) <= -6 });
      Secondary.changeStat(ad, user, "defense", -1, { user: true, certain: true, allowPtr: true, noAnim: true, noMsg: lor(user.stages.defense, 0) <= -6 });
      return true;
    } else if (eff === "SP_ATK_TWO_DOWN") {
      if (lor(user.stages.spAtk, 0) > -6) {
        ad.playAnim("general", "STATS_CHANGE", user, user, Secondary.statAnimArg("spAtk", -2));
        Secondary.changeStat(ad, user, "spAtk", -2, { user: true, certain: true, allowPtr: true, noAnim: true });
      }
      return true;
    } else if (eff === "THRASH") {
      if (lor(effBattler.expRampageTurns, 0) > 0) return false;
      effBattler.expLockedMove = M.moveId;
      effBattler.expLockedSlot = M.slot;
      effBattler.expRampageTurns = ad.roll(0, 1) % 2 + 2;
      return true;
    } else if (eff === "KNOCK_OFF") {
      const tItem = tonumber(effBattler.item) ?? 0;
      if (ad.abilityOf(effBattler) === "STICKY_HOLD") {
        if (tItem === 0) return false;
        ad.sayText("STRINGID_PKMNSXMADEYINEFFECTIVE", { def: effBattler, defAbility: H.abilityId("STICKY_HOLD"), currentMove: M.mnum });
        return false;
      }
      if (tItem === 0) return false;
      effBattler.item = 0;
      // pokefirered/src/battle_script_commands.c:2730-2752
      effBattler.expKnockedOff = true;
      const St = battle_state();
      if (truthy(St)) St.markKnockedOff(ad._st, effBattler);
      ad.playAnim("general", "ITEM_KNOCKOFF", user, effBattler);
      ad.sayText("STRINGID_PKMNKNOCKEDOFF", { atk: user, def: effBattler, lastItem: tItem });
      return true;
    }
    return false;
  },

  // Lua: secondary.lua:479
  // pokefirered/src/battle_script_commands.c:2774
  withChance(M: any, eff: any, certainFlag: any, affectsUser: any): boolean {
    if (!truthy(eff)) return false;
    if (truthy(M.noEffect)) return false;
    const ad = M.adapter;
    let chance = tonumber(truthy(M.move) ? M.move.secondaryChance : M.move) ?? 0;
    if (ad.abilityOf(M.user) === "SERENE_GRACE") chance = chance * 2;
    if (truthy(certainFlag)) {
      return Secondary.set(M, eff, false, true, affectsUser);
    }
    if (ad.roll(0, 99) <= chance) {
      return Secondary.set(M, eff, false, chance >= 100, affectsUser);
    }
    return false;
  },
};

export default Secondary;
