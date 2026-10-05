// Port of gen1recomp src/core/game3/battle/held_items.lua (GPLv3 + additional terms; see LICENSE.md).
// Held-item battle effects: berries, herbs, Leftovers, King's Rock, Shell Bell,
// Focus Band, Amulet Coin.
//
// Port notes:
// - The lazy requires (items_data, moves, state, profile) are static imports;
//   `pcall(require, "src.core.game3.items_data")` always succeeds here, and
//   `pcall(ItemsData.info, item)` is a try/catch.
// - Multiple returns are 0-based tuples: effectOf -> [holdEffect, param];
//   of -> [holdEffect, param, item].
// - Adapter colon calls (`ad:sayText(...)`) are method calls on the adapter.
// - Quirk kept (battle_util.c:2995): King's Rock reads its chance from the
//   PLAYER battler's held item param (`HeldItems.of(ad._st.player)`).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, tonumber, truthy } from "../../../../import/gen3/lua.ts";
import { ipairs, pairs, seq } from "../../platform/lt.ts";
import Secondary from "./effects/secondary.ts";
import State from "./state.ts";
import { RomText } from "../rom_text.ts";
import { ItemsData } from "../items_data.ts";
import Moves from "./moves.ts";
import BattleProfile from "./profile.ts";

export interface HeldItemsModule {
  HOLD: Record<string, number>;
  TYPE_BOOST: Record<number, number>;
  flavorRelation(personality: any, flavor: number): number;
  effectOf(item: any): [number, number];
  itemOf(b: any): number;
  of(b: any): [number, number, number];
  has(b: any, he: number): boolean;
  name(item: any): any;
  consume(ad: any, b: any): void;
  normal(ad: any, b: any, moveTurn?: any): boolean;
  moveEnd(ad: any): boolean;
  kingsRockShellBell(M: any): boolean;
  onSwitchIn(ad: any, b: any): boolean;
  rollFocusBand(ad: any, target: any): boolean;
  focusBandMessage(ad: any, target: any): void;
}

export const HeldItems = {} as HeldItemsModule;

// pokefirered/include/constants/hold_effects.h:4
const H: Record<string, number> = {
  RESTORE_HP: 1, CURE_PAR: 2, CURE_SLP: 3, CURE_PSN: 4, CURE_BRN: 5, CURE_FRZ: 6,
  RESTORE_PP: 7, CURE_CONFUSION: 8, CURE_STATUS: 9, CONFUSE_SPICY: 10, CONFUSE_DRY: 11,
  CONFUSE_SWEET: 12, CONFUSE_BITTER: 13, CONFUSE_SOUR: 14, ATTACK_UP: 15, DEFENSE_UP: 16,
  SPEED_UP: 17, SP_ATTACK_UP: 18, SP_DEFENSE_UP: 19, CRITICAL_UP: 20, RANDOM_STAT_UP: 21,
  EVASION_UP: 22, RESTORE_STATS: 23, MACHO_BRACE: 24, EXP_SHARE: 25, QUICK_CLAW: 26,
  FRIENDSHIP_UP: 27, CURE_ATTRACT: 28, CHOICE_BAND: 29, FLINCH: 30, BUG_POWER: 31,
  DOUBLE_PRIZE: 32, REPEL: 33, SOUL_DEW: 34, DEEP_SEA_TOOTH: 35, DEEP_SEA_SCALE: 36,
  CAN_ALWAYS_RUN: 37, PREVENT_EVOLVE: 38, FOCUS_BAND: 39, LUCKY_EGG: 40, SCOPE_LENS: 41,
  STEEL_POWER: 42, LEFTOVERS: 43, DRAGON_SCALE: 44, LIGHT_BALL: 45, GROUND_POWER: 46,
  ROCK_POWER: 47, GRASS_POWER: 48, DARK_POWER: 49, FIGHTING_POWER: 50, ELECTRIC_POWER: 51,
  WATER_POWER: 52, FLYING_POWER: 53, POISON_POWER: 54, ICE_POWER: 55, GHOST_POWER: 56,
  PSYCHIC_POWER: 57, FIRE_POWER: 58, DRAGON_POWER: 59, NORMAL_POWER: 60, UP_GRADE: 61,
  SHELL_BELL: 62, LUCKY_PUNCH: 63, METAL_POWDER: 64, THICK_CLUB: 65, STICK: 66,
};
HeldItems.HOLD = H;

// pokefirered/src/data/items.json:1
const ITEM_HOLD: Record<number, (number | null)[]> = {
  44: seq(1, 20), 133: seq(2, 0), 134: seq(3, 0), 135: seq(4, 0), 136: seq(5, 0),
  137: seq(6, 0), 138: seq(7, 10), 139: seq(1, 10), 140: seq(8, 0), 141: seq(9, 0),
  142: seq(1, 30), 143: seq(10, 8), 144: seq(11, 8), 145: seq(12, 8), 146: seq(13, 8),
  147: seq(14, 8), 168: seq(15, 4), 169: seq(16, 4), 170: seq(17, 4), 171: seq(18, 4),
  172: seq(19, 4), 173: seq(20, 4), 174: seq(21, 4), 179: seq(22, 10), 180: seq(23, 0),
  181: seq(24, 0), 182: seq(25, 0), 183: seq(26, 20), 184: seq(27, 0), 185: seq(28, 0),
  186: seq(29, 0), 187: seq(30, 10), 188: seq(31, 10), 189: seq(32, 10), 190: seq(33, 0),
  191: seq(34, 0), 192: seq(35, 0), 193: seq(36, 0), 194: seq(37, 0), 195: seq(38, 0),
  196: seq(39, 10), 197: seq(40, 0), 198: seq(41, 0), 199: seq(42, 10), 200: seq(43, 10),
  201: seq(44, 10), 202: seq(45, 0), 203: seq(46, 10), 204: seq(47, 10), 205: seq(48, 10),
  206: seq(49, 10), 207: seq(50, 10), 208: seq(51, 10), 209: seq(52, 10), 210: seq(53, 10),
  211: seq(54, 10), 212: seq(55, 10), 213: seq(56, 10), 214: seq(57, 10), 215: seq(58, 10),
  216: seq(59, 10), 217: seq(60, 10), 218: seq(61, 0), 219: seq(62, 8), 220: seq(52, 5),
  221: seq(22, 5), 222: seq(63, 0), 223: seq(64, 0), 224: seq(65, 0), 225: seq(66, 0),
};

// pokefirered/src/pokemon.c:1461
HeldItems.TYPE_BOOST = {
  [H.BUG_POWER!]: 6, [H.STEEL_POWER!]: 8, [H.GROUND_POWER!]: 4, [H.ROCK_POWER!]: 5,
  [H.GRASS_POWER!]: 12, [H.DARK_POWER!]: 17, [H.FIGHTING_POWER!]: 1, [H.ELECTRIC_POWER!]: 13,
  [H.WATER_POWER!]: 11, [H.FLYING_POWER!]: 2, [H.POISON_POWER!]: 3, [H.ICE_POWER!]: 15,
  [H.GHOST_POWER!]: 7, [H.PSYCHIC_POWER!]: 14, [H.FIRE_POWER!]: 10, [H.DRAGON_POWER!]: 16,
  [H.NORMAL_POWER!]: 0,
};

// pokefirered/src/pokemon.c:1398 (key 0 set, then 1..24: a sequence with slot 0)
const FLAVOR_TABLE: (number | null)[][] = [
  seq(0, 0, 0, 0, 0), seq(1, 0, 0, 0, -1), seq(1, 0, -1, 0, 0), seq(1, -1, 0, 0, 0),
  seq(1, 0, 0, -1, 0), seq(-1, 0, 0, 0, 1), seq(0, 0, 0, 0, 0), seq(0, 0, -1, 0, 1),
  seq(0, -1, 0, 0, 1), seq(0, 0, 0, -1, 1), seq(-1, 0, 1, 0, 0), seq(0, 0, 1, 0, -1),
  seq(0, 0, 0, 0, 0), seq(0, -1, 1, 0, 0), seq(0, 0, 1, -1, 0), seq(-1, 1, 0, 0, 0),
  seq(0, 1, 0, 0, -1), seq(0, 1, -1, 0, 0), seq(0, 0, 0, 0, 0), seq(0, 1, 0, -1, 0),
  seq(-1, 0, 0, 1, 0), seq(0, 0, 0, 1, -1), seq(0, 0, -1, 1, 0), seq(0, -1, 0, 1, 0),
  seq(0, 0, 0, 0, 0),
];

const STAT_ORDER = seq("attack", "defense", "speed", "spAtk", "spDef");

// Lua: held_items.lua:65
HeldItems.flavorRelation = function (personality: any, flavor: number): number {
  const row = FLAVOR_TABLE[mod(tonumber(personality) ?? 0, 25)]!;
  return row[flavor + 1] ?? 0;
};

// Lua: held_items.lua:70
HeldItems.effectOf = function (itemIn: any): [number, number] {
  const item = tonumber(itemIn) ?? 0;
  if (item === 0) return [0, 0];
  const row = ITEM_HOLD[item];
  if (truthy(row)) return [row![1]!, row![2]!];
  // pcall(require, "src.core.game3.items_data") -- always loads here
  if (truthy(ItemsData) && truthy(ItemsData.info)) {
    let ok2 = false, info: any;
    try {
      info = ItemsData.info(item);
      ok2 = true;
    } catch {
      ok2 = false;
    }
    if (ok2 && truthy(info) && tonumber(info.holdEffect) != null) {
      return [tonumber(info.holdEffect) as number, tonumber(info.holdEffectParam) ?? 0];
    }
  }
  return [0, 0];
};

// Lua: held_items.lua:85
HeldItems.itemOf = function (b: any): number {
  // b and tonumber(b.item) or 0
  return (truthy(b) ? tonumber(b.item) : undefined) ?? 0;
};

// Lua: held_items.lua:89
HeldItems.of = function (b: any): [number, number, number] {
  const item = HeldItems.itemOf(b);
  const [he, param] = HeldItems.effectOf(item);
  return [he, param, item];
};

// Lua: held_items.lua:95
HeldItems.has = function (b: any, he: number): boolean {
  return HeldItems.of(b)[0] === he;
};

// Lua: held_items.lua:99
HeldItems.name = function (item: any): any {
  return Secondary.itemName(item);
};

// Lua: held_items.lua:103
function say_id(ad: any, id: string, fill?: any): void {
  ad.sayText(id, fill);
}

// Lua: held_items.lua:107
function item_anim(ad: any, b: any): void {
  ad.playAnim("general", "HELD_ITEM_EFFECT", b, b);
}

// Lua: held_items.lua:112 -- pokefirered/src/battle_script_commands.c:5642
HeldItems.consume = function (ad: any, b: any): void {
  const item = HeldItems.itemOf(b);
  if (item === 0) return;
  b.item = 0;
  b.expUsedHeldItem = item;
  const side = ad.ownSide(b);
  if (truthy(side)) side.expUsedHeldItem = item;
  Secondary.persistItem(b, 0);
};

// Lua: held_items.lua:123 -- src/battle_script_commands.c:6788
function stat_up(ad: any, b: any, item: number, stat: string, delta: number): void {
  item_anim(ad, b);
  b.stages[stat] = Math.min(6, (b.stages[stat] ?? 0) + delta);
  ad.playAnim("general", "STATS_CHANGE", b, b, Secondary.statAnimArg(stat, delta));
  let change = RomText.plain("STRINGID_STATROSE");
  if (delta >= 2) change = RomText.plain("STRINGID_STATSHARPLY") + change;
  say_id(ad, "STRINGID_USINGITEMSTATOFPKMNROSE", {
    lastItem: item, buff1: Secondary.statName(stat), scrActive: b, buff2: change,
  });
  HeldItems.consume(ad, b);
}

// data/battle_scripts_1.s:4216
const CURE_TEXT: Record<number, string> = {
  [H.CURE_PAR!]: "STRINGID_PKMNSITEMCUREDPARALYSIS",
  [H.CURE_PSN!]: "STRINGID_PKMNSITEMCUREDPOISON",
  [H.CURE_BRN!]: "STRINGID_PKMNSITEMHEALEDBURN",
  [H.CURE_FRZ!]: "STRINGID_PKMNSITEMDEFROSTEDIT",
  [H.CURE_SLP!]: "STRINGID_PKMNSITEMWOKEIT",
};

// Lua: held_items.lua:144
function cure_status_item(ad: any, b: any, item: number, he: number): boolean {
  const s = ad.status(b);
  const ok = (he === H.CURE_PAR && s === "PAR") || (he === H.CURE_PSN && (s === "PSN" || s === "TOX"))
    || (he === H.CURE_BRN && s === "BRN") || (he === H.CURE_FRZ && s === "FRZ") || (he === H.CURE_SLP && s === "SLP");
  if (!ok) return false;
  if (he === H.CURE_SLP) b.expNightmare = null;
  ad.clearStatus(b);
  item_anim(ad, b);
  say_id(ad, CURE_TEXT[he]!, { scrActive: b, lastItem: item });
  HeldItems.consume(ad, b);
  return true;
}

// Lua: held_items.lua:158 -- src/battle_util.c:2778
function lum(ad: any, b: any, item: number, allowNormalized: boolean): boolean {
  const s = ad.status(b);
  const confused = (b.confusionTurns ?? 0) > 0;
  if (!truthy(s) && !confused) return false;
  let count = 0, word: string | null = null;
  if (s === "PSN" || s === "TOX") { word = "gText_Poison"; count = count + 1; }
  if (s === "SLP") { b.expNightmare = null; word = "gText_Sleep"; count = count + 1; }
  if (s === "PAR") { word = "gText_Paralysis"; count = count + 1; }
  if (s === "BRN") { word = "gText_Burn"; count = count + 1; }
  if (s === "FRZ") { word = "gText_Ice"; count = count + 1; }
  if (confused) { word = "gText_Confusion"; count = count + 1; }
  ad.clearStatus(b);
  b.confusionTurns = null;
  item_anim(ad, b);
  if (allowNormalized && count > 1) {
    say_id(ad, "STRINGID_PKMNSITEMNORMALIZEDSTATUS", { scrActive: b, lastItem: item });
  } else {
    say_id(ad, "STRINGID_PKMNSITEMCUREDPROBLEM", { scrActive: b, lastItem: item, buff1: RomText.plain(word as string) });
  }
  HeldItems.consume(ad, b);
  return true;
}

// Lua: held_items.lua:181
function white_herb(ad: any, b: any, item: number): boolean {
  let any = false;
  for (const [k, v] of pairs<number>(b.stages ?? {})) {
    if (v < 0) { b.stages[k] = 0; any = true; }
  }
  if (!any) return false;
  item_anim(ad, b);
  say_id(ad, "STRINGID_PKMNSITEMRESTOREDSTATUS", { scrActive: b, lastItem: item });
  HeldItems.consume(ad, b);
  return true;
}

// Lua: held_items.lua:193
function mental_herb(ad: any, b: any, item: number): boolean {
  if (!truthy(b.expInfatuated)) return false;
  b.expInfatuated = null; b.expInfatuatedWith = null; b.expInfatuatedBy = null;
  item_anim(ad, b);
  say_id(ad, "STRINGID_PKMNSITEMCUREDPROBLEM", { scrActive: b, lastItem: item, buff1: RomText.plain("gText_Love") });
  HeldItems.consume(ad, b);
  return true;
}

// Lua: held_items.lua:202
function persim(ad: any, b: any, item: number): boolean {
  if ((b.confusionTurns ?? 0) <= 0) return false;
  b.confusionTurns = null;
  item_anim(ad, b);
  say_id(ad, "STRINGID_PKMNSITEMSNAPPEDOUT", { scrActive: b, lastItem: item });
  HeldItems.consume(ad, b);
  return true;
}

// Lua: held_items.lua:211
function leppa(ad: any, b: any, item: number, param: number): boolean {
  const mon = b.mon;
  if (!truthy(mon) || !truthy(mon.moves)) return false;
  let slot: number | null = null;
  for (let i = 1; i <= 4; i++) {
    const mv = mon.moves[i];
    if (truthy(mv) && mv !== 0 && mv !== "" && tonumber(truthy(mon.pp) ? mon.pp[i] : mon.pp) === 0) { slot = i; break; }
  }
  if (slot == null) return false;
  let base: number | undefined = truthy(mon.maxPp) ? tonumber(mon.maxPp[slot]) : undefined;
  if (base == null) base = tonumber(Moves.get(mon.moves[slot]).pp) ?? param;
  const pp = Math.min(base, param);
  item_anim(ad, b);
  say_id(ad, "STRINGID_PKMNSITEMRESTOREDPP", {
    scrActive: b, lastItem: item, buff1: Moves.displayName(mon.moves[slot]),
  });
  HeldItems.consume(ad, b);
  const perm = b.permanentSlots;
  if (!truthy(perm) || truthy(perm[slot])) {
    mon.pp[slot] = pp;
  }
  const pm = State.partyMon(b);
  if (truthy(pm) && pm !== mon && truthy(pm.pp)) pm.pp[slot] = pp;
  return true;
}

// Lua: held_items.lua:239
function heal_berry(ad: any, b: any, item: number, amount: number): void {
  item_anim(ad, b);
  say_id(ad, "STRINGID_PKMNSITEMRESTOREDHEALTH", { scrActive: b, lastItem: item });
  ad.heal(b, amount);
}

// Lua: held_items.lua:246 -- pokefirered/src/battle_util.c:2557
HeldItems.normal = function (ad: any, b: any, moveTurn?: any): boolean {
  if (!truthy(b) || ad.hp(b) <= 0) return false;
  const [he, param, item] = HeldItems.of(b);
  if (he === 0) return false;
  const hp: number = ad.hp(b), maxHp: number = ad.maxHp(b);
  if (he === H.RESTORE_HP) {
    if (hp <= Math.floor(maxHp / 2)) {
      let amt = param;
      if (hp + param > maxHp) amt = maxHp - hp;
      heal_berry(ad, b, item, amt);
      HeldItems.consume(ad, b);
      return true;
    }
  } else if (he === H.RESTORE_PP) {
    return leppa(ad, b, item, param);
  } else if (he === H.RESTORE_STATS) {
    return white_herb(ad, b, item);
  } else if (he === H.LEFTOVERS) {
    if (hp < maxHp && !truthy(moveTurn)) {
      let amt = Math.floor(maxHp / 16);
      if (amt === 0) amt = 1;
      item_anim(ad, b);
      say_id(ad, "STRINGID_PKMNSITEMRESTOREDHPALITTLE", { scrActive: b, lastItem: item });
      ad.heal(b, amt);
      return true;
    }
  } else if (he >= H.CONFUSE_SPICY! && he <= H.CONFUSE_SOUR!) {
    if (hp <= Math.floor(maxHp / 2)) {
      const flavor = he - H.CONFUSE_SPICY!;
      let amt = Math.floor(maxHp / Math.max(1, param));
      if (amt === 0) amt = 1;
      if (hp + amt > maxHp) amt = maxHp - hp;
      heal_berry(ad, b, item, amt);
      const mon = truthy(b.mon) ? b.mon : {};
      if (HeldItems.flavorRelation(mon.personality, flavor) < 0) {
        // src/battle_message.c:2282
        say_id(ad, "STRINGID_FORXCOMMAYZ", {
          scrActive: b, lastItem: item, buff1: RomText.at("gPokeblockWasTooXStringTable", flavor),
        });
        if (ad.abilityOf(b) !== "OWN_TEMPO" && (b.confusionTurns ?? 0) <= 0) {
          b.confusionTurns = mod(ad.roll(0, 3), 4) + 2;
          ad.playAnim("status", "CONFUSION", b, b);
          say_id(ad, "STRINGID_PKMNWASCONFUSED", { eff: b });
        }
      }
      HeldItems.consume(ad, b);
      return true;
    }
  } else if (he >= H.ATTACK_UP! && he <= H.SP_DEFENSE_UP!) {
    const stat = STAT_ORDER[he - H.ATTACK_UP! + 1] as string;
    if (hp <= Math.floor(maxHp / Math.max(1, param)) && (b.stages[stat] ?? 0) < 6) {
      stat_up(ad, b, item, stat, 1);
      return true;
    }
  } else if (he === H.CRITICAL_UP) {
    if (hp <= Math.floor(maxHp / Math.max(1, param)) && !truthy(truthy(b.focusEnergy) ? b.focusEnergy : b.expFocusEnergy)) {
      b.focusEnergy = true;
      b.expFocusEnergy = true;
      item_anim(ad, b);
      say_id(ad, "STRINGID_PKMNUSEDXTOGETPUMPED", { scrActive: b, lastItem: item });
      HeldItems.consume(ad, b);
      return true;
    }
  } else if (he === H.RANDOM_STAT_UP) {
    if (hp <= Math.floor(maxHp / Math.max(1, param))) {
      let any = false;
      for (const [, s] of ipairs<string>(STAT_ORDER)) {
        if ((b.stages[s] ?? 0) < 6) any = true;
      }
      if (any) {
        let stat: string;
        do {
          stat = STAT_ORDER[mod(ad.roll(0, 4), 5) + 1] as string;
        } while (!((b.stages[stat] ?? 0) < 6));
        stat_up(ad, b, item, stat, 2);
        return true;
      }
    }
  } else if (he >= H.CURE_PAR! && he <= H.CURE_FRZ!) {
    return cure_status_item(ad, b, item, he);
  } else if (he === H.CURE_CONFUSION) {
    return persim(ad, b, item);
  } else if (he === H.CURE_STATUS) {
    return lum(ad, b, item, true);
  } else if (he === H.CURE_ATTRACT) {
    return mental_herb(ad, b, item);
  }
  return false;
};

// Lua: held_items.lua:337 -- pokefirered/src/battle_util.c:2851
HeldItems.moveEnd = function (ad: any): boolean {
  let any = false;
  let list: any = seq(ad._st.player, ad._st.enemy);
  if (truthy(ad._st.double)) list = ad.activeBattlers();
  for (const [, b] of ipairs(list)) {
    if (truthy(b) && !truthy(ad.isFainted(b))) {
      const [he, , item] = HeldItems.of(b);
      let did = false;
      if (he >= H.CURE_PAR! && he <= H.CURE_FRZ!) {
        did = cure_status_item(ad, b, item, he);
      } else if (he === H.CURE_CONFUSION) {
        did = persim(ad, b, item);
      } else if (he === H.CURE_ATTRACT) {
        did = mental_herb(ad, b, item);
      } else if (he === H.CURE_STATUS) {
        did = lum(ad, b, item, false);
      } else if (he === H.RESTORE_STATS) {
        did = white_herb(ad, b, item);
      }
      any = any || did;
    }
  }
  return any;
};

// Lua: held_items.lua:363 -- pokefirered/src/battle_util.c:2995
HeldItems.kingsRockShellBell = function (M: any): boolean {
  const ad = M.adapter, user = M.user, target = M.target;
  if (!truthy(user) || !truthy(target) || (M.firstDmg ?? 0) === 0) return false;
  const [he, param, item] = HeldItems.of(user);
  if (he === H.FLINCH) {
    const p0 = HeldItems.of(ad._st.player)[1];
    if (!truthy(M.noEffect) && truthy(M.targetDamaged) && ad.roll(0, 99) < p0
        && truthy(M.move) && truthy(M.move.flags) && mod(Math.floor((tonumber(M.move.flags) ?? 0) / 32), 2) === 1
        && ad.hp(target) > 0) {
      Secondary.set(M, "FLINCH", false, false, false);
      return true;
    }
  } else if (he === H.SHELL_BELL) {
    if (!truthy(M.noEffect) && user !== target && ad.hp(user) !== ad.maxHp(user) && ad.hp(user) > 0) {
      let amt = Math.floor(M.firstDmg / Math.max(1, param));
      if (amt === 0) amt = 1;
      M.firstDmg = 0;
      item_anim(ad, user);
      say_id(ad, "STRINGID_PKMNSITEMRESTOREDHPALITTLE", { scrActive: user, lastItem: item });
      ad.heal(user, amt);
      return true;
    }
  }
  return false;
};

// Lua: held_items.lua:390 -- pokefirered/src/battle_util.c:2532
HeldItems.onSwitchIn = function (ad: any, b: any): boolean {
  if (!truthy(b)) return false;
  const [he, , item] = HeldItems.of(b);
  if (he === H.DOUBLE_PRIZE) {
    // pokeemerald/src/battle_util.c:3294
    if (b.side === "player" || !truthy(BattleProfile.rule(ad._st, "amuletCoinPlayerOnly"))) {
      ad._st.moneyMultiplier = 2;
    }
  } else if (he === H.RESTORE_STATS) {
    return white_herb(ad, b, item);
  }
  return false;
};

// Lua: held_items.lua:405 -- pokefirered/src/battle_script_commands.c:1596
HeldItems.rollFocusBand = function (ad: any, target: any): boolean {
  const [he, param] = HeldItems.of(target);
  if (he === H.FOCUS_BAND && ad.roll(0, 99) < param) {
    target.expFocusBanded = true;
    return true;
  }
  return false;
};

// Lua: held_items.lua:415 -- pokefirered/data/battle_scripts_1.s:4340
HeldItems.focusBandMessage = function (ad: any, target: any): void {
  ad.playAnim("general", "FOCUS_BAND", target, target);
  say_id(ad, "STRINGID_PKMNHUNGONWITHX", { def: target, lastItem: HeldItems.itemOf(target) });
};

export default HeldItems;
