// Port of gen1recomp src/core/game3/battle/items.lua (GPLv3 + additional terms; see LICENSE.md).
// In-battle item use: balls (catch), medicine, X items, Poke Doll.
// Catch odds follow pret battle_script_commands.c (simplified shake check).
//
// Port notes:
// - The lazy requires (link_guard, state, profile, storage, pokemon,
//   oak_advice, ai_items) are static imports.
// - `BattleItems.isFlute = ItemUse.isFlute` (items.lua:36) is a function that
//   calls ItemUse.isFlute, so this module can load inside an import cycle
//   before item_use has evaluated. Same behaviour.
// - `math.random` (the link_guard.source fallback) is platform random().
// - Multiple returns are 0-based tuples on every path:
//   canUseOn -> [ok, message?]; tryCatch -> [caught, shakes] (Catching's);
//   use -> [result, msgs, endsTurn, endsBattle, text?].
//   Callee tuples used here: BattleText.key -> [key, fill];
//   ItemUse.revive / healMon / clearStatus -> [ok, x].
// - Item effect tables (ItemsData.info(id).effect) are cache sequences:
//   e[1]..e[6], plus e.hp.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, tonumber, truthy } from "../../../../import/gen3/lua.ts";
import { len, seq, type LuaTable } from "../../platform/lt.ts";
import { random } from "../../platform/rng.ts";
import { ItemsData } from "../items_data.ts";
import { Bag } from "../bag.ts";
import ItemUse from "../item_use.ts";
import { Pokemon } from "../pokemon.ts";
// required at load by items.lua:8 (unused there too); a bare import, so the
// binding is never read while the import cycle loads
import "./types.ts";
import Catching from "./catching.ts";
import { Strings } from "../../shared/core/Strings.ts";
import { RomText } from "../rom_text.ts";
import BattleText from "./battle_text.ts";
import Adapter from "./adapter.ts";
import Guard from "./link_guard.ts";
import State from "./state.ts";
import BattleProfile from "./profile.ts";
import { Storage } from "../storage.ts";
import Oak from "./oak_advice.ts";
import AiItems from "./ai_items.ts";

export type UseResult = [string, LuaTable, boolean, boolean, any?];

export interface BattleItemsModule {
  isFlute(id: any): boolean;
  isStatBooster(id: any): boolean;
  isBall(id: any): boolean | null;
  isBattleUsable(id: any): boolean;
  needsPartySelect(id: any): boolean;
  canUseOn(st: any, itemId: any, partySlot: any, mon: any, moveSlot?: any): [boolean, string?];
  ballMultiplier(itemId: any, foeBattler: any, st: any, session: any): any;
  catchOdds(itemId: any, foeBattler: any, st: any, session: any): any;
  tryCatch(itemId: any, foeBattler: any, st: any, rng: any, session: any): [any, any];
  storeCaught(session: any, foeBattler: any, ballId: any): any;
  statBoosterHasEffect(st: any, itemId: any, battlerId?: any): boolean;
  use(st: any, adapter: any, bag: any, session: any, itemId: any, partySlot?: any, battlerId?: any, moveSlot?: any): UseResult;
  afterPlayerItem(st: any, adapter: any, itemId: any): any;
  enemyUse(st: any, adapter: any, act: any): boolean;
}

export const BattleItems = {} as BattleItemsModule;

// pret sBallCatchBonuses (x10): Ultra=20, Great=15, Poke=10, Safari=15
const BALL_MULT: Record<number, number> = {
  1: 255, // MASTER (handled specially)
  2: 20,  // ULTRA
  3: 15,  // GREAT
  4: 10,  // POKE
  5: 15,  // SAFARI
  6: 10,  // NET (default; type boost below)
  7: 10,  // DIVE
  8: 10,  // NEST (level boost)
  9: 10,  // REPEAT
  10: 10, // TIMER
  11: 10, // LUXURY
  12: 10, // PREMIER
};
void BALL_MULT; // unused in items.lua too (Catching owns the multipliers)

// Lua: items.lua:28
function band(a: any, m: number): number { return (tonumber(a) ?? 0) & m; }

// Lua: items.lua:30
function effect_of(itemId: any): any {
  const info = ItemsData.info(itemId);
  const e = truthy(info) ? info!.effect : info;
  return (e !== null && typeof e === "object") ? e : null;
}

// Lua: items.lua:36 (BattleItems.isFlute = ItemUse.isFlute; see the header)
BattleItems.isFlute = function (id: any): boolean {
  return ItemUse.isFlute(id);
};

// Lua: items.lua:39 -- pokefirered/src/party_menu.c:5339
BattleItems.isStatBooster = function (id: any): boolean {
  const e = effect_of(id);
  if (!truthy(e)) return false;
  return band(e[1], 0x3F) !== 0 || band(e[2], 0xFF) !== 0 || band(e[3], 0xFF) !== 0 || band(e[4], 0x80) !== 0;
};

// Lua: items.lua:53 -- src/strings.c:254
function wont_have_effect(): string {
  return RomText.ascii("gText_WontHaveEffect");
}

// Lua: items.lua:58 -- pokefirered/src/item_use.c:578
function player_used(session: any, itemId: any): string {
  return RomText.ascii("gText_PlayerUsedVar2", {
    playerName: truthy(session) ? session.name : session,
    stringVars: seq(null, ItemsData.displayName(itemId)),
  });
}

// pokefirered/src/pokemon.c:4957
const STAT_INDEX: Record<string, number> = { attack: 1, defense: 2, speed: 3, spAtk: 4, spDef: 5, accuracy: 6 };

// Lua: items.lua:66
BattleItems.isBall = function (id: any): boolean | null {
  return Catching.isBall(id);
};

// Lua: items.lua:70
BattleItems.isBattleUsable = function (id: any): boolean {
  const info = ItemsData.info(id);
  if (!truthy(info)) return false;
  const bu = tonumber(info!.battleUsage) ?? 0;
  if (bu > 0) return true;
  const pocket = info!.pocket;
  return pocket === "POKE_BALLS" || pocket === "BERRY_POUCH";
};

// Lua: items.lua:79
BattleItems.needsPartySelect = function (id: any): boolean {
  if (!truthy(id)) return false;
  if (truthy(Catching.isBall(id))) return false;
  const num = ItemsData.toNumericId(id) ?? tonumber(id);
  if (num === 80) return false; // POKE_DOLL
  if (BattleItems.isStatBooster(id)) return false;
  const use = ItemsData.fieldUseKind(id);
  const info = ItemsData.info(id);
  const bu = (truthy(info) ? tonumber(info!.battleUsage) : undefined) ?? 0;
  if (bu === 1 || use === "heal" || use === "status" || use === "revive"
      || (truthy(info) && info!.pocket === "BERRY_POUCH")) {
    return true;
  }
  return false;
};

// Lua: items.lua:95
function active_for_slot(st: any, partySlot: any): any {
  if (!truthy(st) || !truthy(partySlot)) return null;
  if (truthy(st.player) && st.player.partyIndex === partySlot) return st.player;
  const b2 = truthy(st.double) && truthy(st.battlers) ? st.battlers[2] : null;
  if (truthy(b2) && b2.partyIndex === partySlot) return b2;
  return null;
}

// Lua: items.lua:104 -- pokefirered/src/pokemon.c:4081
function status2_cure(b: any, e: any, apply: boolean): boolean {
  if (!truthy(b) || !truthy(e)) return false;
  let changed = false;
  if (band(e[1], 0x80) !== 0 && truthy(b.expInfatuated)) {
    changed = true;
    if (apply) { b.expInfatuated = null; b.expInfatuatedWith = null; b.expInfatuatedBy = null; }
  }
  // pokefirered/src/pokemon.c:4189
  if (band(e[4], 0x01) !== 0 && (tonumber(b.confusionTurns) ?? 0) > 0) {
    changed = true;
    if (apply) b.confusionTurns = null;
  }
  return changed;
}

// Lua: items.lua:120 -- pokefirered/src/pokemon.c:4089
function stat_booster(st: any, b: any, e: any, apply: boolean): boolean {
  if (!truthy(b) || !truthy(e)) return false;
  b.stages = truthy(b.stages) ? b.stages : {};
  let changed = false;
  // Lua: items.lua:124
  function raise(key: string, n: number): void {
    const cur = b.stages[key] ?? 0;
    if (n > 0 && cur < 6) {
      changed = true;
      if (apply) b.stages[key] = Math.min(6, cur + n);
    }
  }
  raise("attack", band(e[1], 0x0F));
  if (band(e[1], 0x30) !== 0 && !truthy(truthy(b.focusEnergy) ? b.focusEnergy : b.expFocusEnergy)) {
    changed = true;
    if (apply) b.focusEnergy = true;
  }
  raise("defense", Math.floor(band(e[2], 0xF0) / 16));
  raise("speed", band(e[2], 0x0F));
  raise("accuracy", Math.floor(band(e[3], 0xF0) / 16));
  raise("spAtk", band(e[3], 0x0F));
  // pokefirered/src/pokemon.c:4156
  const side = b.side === "enemy" ? st.enemySide : st.playerSide;
  if (band(e[4], 0x80) !== 0 && truthy(side) && (tonumber(side.expMistTurns) ?? 0) === 0) {
    changed = true;
    if (apply) side.expMistTurns = 5;
  }
  return changed;
}

// pokefirered/src/pokemon.c:1611 (key 0 set, then 1..5)
const STATS_TO_RAISE: string[] = ["attack", "attack", "speed", "defense", "spAtk", "accuracy"];

// Lua: items.lua:153 -- pokefirered/src/pokemon.c:4965 Battle_PrintStatBoosterEffectMessage
function stat_booster_text(st: any, b: any, e: any): any {
  let text: any = null;
  // Lua: items.lua:155
  function rose(idx: number): void {
    const stat = STATS_TO_RAISE[idx]!;
    text = BattleText.get("STRINGID_DEFENDERSSTATROSE", Adapter.fill(st, {
      def: b,
      buff1: RomText.at("gStatNamesTable", STAT_INDEX[stat]!), buff2: BattleText.get("STRINGID_STATROSE"),
    }));
  }
  const masks = seq(seq(0x0F, 0x30), seq(0x0F, 0xF0), seq(0x0F, 0xF0));
  for (let i = 0; i <= 2; i++) {
    const byte = e[i + 1];
    if (band(byte, masks[i + 1]![1]!) !== 0) rose(i * 2);
    if (band(byte, masks[i + 1]![2]!) !== 0) {
      if (i !== 0) {
        rose(i * 2 + 1);
      } else {
        text = BattleText.get("STRINGID_PKMNGETTINGPUMPED", Adapter.fill(st, { atk: b }));
      }
    }
  }
  if (band(e[4], 0x80) !== 0) {
    text = BattleText.get("STRINGID_PKMNSHROUDEDINMIST", Adapter.fill(st, { atk: b }));
  }
  return text;
}

// Lua: items.lua:178
BattleItems.canUseOn = function (st: any, itemId: any, partySlot: any, mon: any, moveSlot?: any): [boolean, string?] {
  if (!truthy(mon) || !truthy(itemId)) return [false, wont_have_effect()];
  if (truthy(mon.isEgg)) return [false, Strings("An EGG can't be used on.")];
  const hp = tonumber(mon.hp) ?? 0;
  const maxHp = tonumber(truthy(mon.maxHp) ? mon.maxHp : mon.maxhp) ?? 1;
  const mk = ItemsData.medicineKind(itemId);
  const use = ItemsData.fieldUseKind(itemId);
  // pokefirered/src/party_menu.c:4675 TryUsePPItemInBattle
  if (use === "pp") {
    if (truthy(ItemUse.ppItemHasEffect(mon, itemId, truthy(moveSlot) ? moveSlot : 1))) return [true];
    return [false, wont_have_effect()];
  }
  const e = effect_of(itemId);
  if (mk === "revive" || use === "revive") {
    if (hp > 0) return [false, wont_have_effect()];
    return [true];
  } else if (hp <= 0) {
    return [false, wont_have_effect()];
  } else if (status2_cure(active_for_slot(st, partySlot), e, false)) {
    return [true];
  } else if (mk === "status" || use === "status") {
    const s = mon.status;
    if (!truthy(s) || s === 0 || s === "") return [false, wont_have_effect()];
    return [true];
  } else if (truthy(e) && band(e[5], 0x04) === 0) {
    return [false, wont_have_effect()];
  } else {
    const s = mon.status;
    const cures = truthy(e) && band(e[4], 0x3E) !== 0 && truthy(s) && s !== 0 && s !== "";
    if (hp >= maxHp && !cures) return [false, wont_have_effect()];
    return [true];
  }
};

// Lua: items.lua:212
BattleItems.ballMultiplier = function (itemId: any, foeBattler: any, st: any, session: any): any {
  return Catching.ballMultiplier(itemId, foeBattler, st, session);
};

// Lua: items.lua:216
BattleItems.catchOdds = function (itemId: any, foeBattler: any, st: any, session: any): any {
  return Catching.catchOdds(itemId, foeBattler, st, session);
};

// Lua: items.lua:220
BattleItems.tryCatch = function (itemId: any, foeBattler: any, st: any, rng: any, session: any): [any, any] {
  return Catching.tryCatch(itemId, foeBattler, st, session, rng);
};

// Lua: items.lua:224
BattleItems.storeCaught = function (session: any, foeBattler: any, ballId: any): any {
  const res = Catching.storeCaught(session, foeBattler, ballId);
  return res.location;
};

// Lua: items.lua:229
function user_battler(st: any, battlerId: any): any {
  if (battlerId == null || battlerId === 0) return st.player;
  const b = truthy(st.battlers) ? st.battlers[battlerId] : st.battlers;
  return truthy(b) ? b : st.player;
}

// Lua: items.lua:235 -- pokefirered/src/item_use.c:757
BattleItems.statBoosterHasEffect = function (st: any, itemId: any, battlerId?: any): boolean {
  return stat_booster(st, user_battler(st, battlerId), effect_of(itemId), false);
};

// Lua: items.lua:239
function sync_player_battler(st: any, battlerId?: any): void {
  const b = user_battler(st, battlerId);
  if (!truthy(b) || !truthy(b.mon)) return;
  b.fainted = (tonumber(b.mon.hp) ?? 0) <= 0;
  b.status = b.mon.status;
}

/**
 * Use a battle item. Returns:
 *   result: "catch"|"fail_catch"|"heal"|"xitem"|"doll"|"cancel"|"error"
 *   msgs: string list
 *   endsTurn: bool (enemy may still move unless endsBattle)
 *   endsBattle: bool
 */
// Lua: items.lua:251
BattleItems.use = function (
  st: any, adapter: any, bag: any, session: any, itemId: any, partySlot?: any, battlerId?: any, moveSlot?: any,
): UseResult {
  const msgs: LuaTable = seq();
  // Lua: items.lua:253
  function say(t: any, id?: any): void {
    msgs[len(msgs) + 1] = t;
    if (truthy(adapter) && truthy(adapter.say)) adapter.say(t, id);
  }
  // Lua: items.lua:257
  function say_id(id: any, fill?: any): void {
    say(BattleText.get(id, fill), BattleText.key(id, fill)[0]);
  }

  if (!truthy(itemId) || !truthy(bag)) {
    return ["error", msgs, false, false];
  }
  if (!Bag.has(bag, itemId, 1)) {
    say(Strings("You don't have that item."));
    return ["error", msgs, false, false];
  }

  const num = ItemsData.toNumericId(itemId) ?? tonumber(itemId);

  // Poke Doll -> flee wild
  if (num === 80) {
    if (!truthy(st.wild)) {
      say(Strings("This can't be used right now."));
      return ["error", msgs, false, false];
    }
    Bag.remove(bag, itemId, 1);
    // pokefirered/src/item_use.c:821
    say(player_used(session, itemId));
    return ["doll", msgs, true, true];
  }

  // Balls
  if (BattleItems.isBall(itemId)) {
    const fill = Adapter.fill(st, {
      lastItem: itemId, playerName: (truthy(session) && truthy(session.name)) ? session.name : st.playerName,
    });
    if (!truthy(st.wild)) {
      // pokefirered/data/battle_scripts_2.s:118
      say_id("STRINGID_TRAINERBLOCKEDBALL", fill);
      return ["error", msgs, false, false];
    }
    Bag.remove(bag, itemId, 1);
    // pokefirered/data/battle_scripts_2.s:57
    say_id("STRINGID_PLAYERUSEDITEM", fill);
    let rng: any = (truthy(adapter) && truthy(adapter.rng)) ? adapter.rng() : null;
    if (!truthy(rng)) rng = Guard.source("items.rng", random);
    const foe = Catching.targetFor(st, battlerId);
    const [caught, shakes] = BattleItems.tryCatch(itemId, foe, st, rng, session);
    if (truthy(caught)) {
      const res = Catching.storeCaught(session, foe, itemId);
      const ename = State.displayName(foe);
      fill.opponentMon1 = foe;
      // pokefirered/data/battle_scripts_2.s:77
      say_id(BattleProfile.of(st).strings.caught, fill);
      if (truthy(res) && truthy(res.firstTimeCaught)) {
        say_id("STRINGID_PKMNDATAADDEDTODEX", fill);
      }
      if (truthy(res) && res.location === "pc") {
        // pokefirered/src/battle_script_commands.c:9617
        say(Storage.pcTransferMessage(session, ename));
      }
      return ["catch", msgs, true, true];
    }
    // pokefirered/src/battle_message.c:1151
    say_id(["STRINGID_PKMNBROKEFREE", "STRINGID_ITAPPEAREDCAUGHT",
      "STRINGID_AARGHALMOSTHADIT", "STRINGID_SHOOTSOCLOSE"][Math.min(3, tonumber(shakes) ?? 0)], fill);
    return ["fail_catch", msgs, true, false];
  }

  // pokefirered/src/item_use.c:755 BattleUseFunc_StatBooster
  if (BattleItems.isStatBooster(itemId)) {
    const e = effect_of(itemId);
    const battler = user_battler(st, battlerId);
    if (!stat_booster(st, battler, e, true)) {
      // pokefirered/src/item_use.c:758
      say(wont_have_effect());
      return ["error", msgs, false, false];
    }
    // pokefirered/src/item_use.c:774
    Bag.remove(bag, itemId, 1);
    // pokefirered/src/data/pokemon/item_effects.h:225
    if (truthy(battler.mon)) {
      Pokemon.itemFriendship(battler.mon, Pokemon.STAT_BOOST_FRIENDSHIP_CHANGE,
        { mapSec: Pokemon.currentMapSec(session) });
    }
    // pokefirered/data/battle_scripts_2.s:130
    return ["xitem", msgs, true, false, stat_booster_text(st, battler, e)];
  }

  // Medicine / berries on party mon
  const use = ItemsData.fieldUseKind(itemId);
  const info = ItemsData.info(itemId);
  // pokefirered/src/party_menu.c:4675 TryUsePPItemInBattle
  if (use === "pp") {
    const party = truthy(st.playerParty) ? st.playerParty : (truthy(session) ? session.party : session);
    if (!truthy(partySlot)) {
      return ["need_slot", msgs, false, false];
    }
    const mon = truthy(party) ? party[partySlot] : party;
    let battler: any = null;
    if (truthy(st.player) && st.player.partyIndex === partySlot) {
      battler = st.player;
    } else if (truthy(st.double) && truthy(st.battlers) && truthy(st.battlers[2]) && st.battlers[2].partyIndex === partySlot) {
      battler = st.battlers[2];
    }
    if (truthy(battler)) {
      State.syncBattlerToParty(battler, party);
    }
    if (!truthy(mon) || !truthy(ItemUse.applyPpItem(mon, itemId, truthy(moveSlot) ? moveSlot : 1, battler, session))) {
      say(wont_have_effect());
      return ["error", msgs, false, false];
    }
    Bag.remove(bag, itemId, 1);
    // pokefirered/src/party_menu.c:4700
    return ["heal", msgs, true, false, ItemUse.ppItemText(mon, itemId, truthy(moveSlot) ? moveSlot : 1)];
  }
  const bu = (truthy(info) ? tonumber(info!.battleUsage) : undefined) ?? 0;
  if (bu === 1 || use === "heal" || use === "status" || use === "revive"
      || (truthy(info) && info!.pocket === "BERRY_POUCH")) {
    // Prefer in-battle party copy (writeback syncs to session).
    const party = truthy(st.playerParty) ? st.playerParty : (truthy(session) ? session.party : session);
    if (!truthy(partySlot)) {
      return ["need_slot", msgs, false, false];
    }
    const mon = truthy(party) ? party[partySlot] : party;
    if (!truthy(mon)) {
      say(wont_have_effect());
      return ["error", msgs, false, false];
    }
    let ok: any = false, cured: any = null;
    const hpBefore = tonumber(mon.hp) ?? 0;
    const mk = ItemsData.medicineKind(itemId);
    const e = effect_of(itemId);
    const active = active_for_slot(st, partySlot);
    const asleep = mon.status === "SLP" || mon.status === 5 || (tonumber(mon.sleep) ?? 0) > 0;
    // pokefirered/src/pokemon.c:4258
    if (mk === "revive" || use === "revive" || num === ItemUse.ITEM_REVIVAL_HERB) {
      const max = num === 25 || num === ItemUse.ITEM_REVIVAL_HERB;
      if (num === 45) {
        ok = ItemUse.reviveAll(party);
      } else {
        ok = ItemUse.revive(mon, max)[0];
      }
    } else if (mk === "status" || use === "status") {
      [ok, cured] = ItemUse.clearStatus(mon, itemId);
    } else {
      ok = ItemUse.healMon(session, mon, itemId)[0];
    }
    if (status2_cure(active, e, true)) ok = true;
    if (!truthy(ok)) {
      say(wont_have_effect());
      return ["error", msgs, false, false];
    }
    // pokefirered/src/pokemon.c:4178
    if (truthy(active) && asleep && truthy(e) && band(e[4], 0x20) !== 0
        && !(truthy(mon.status) || (tonumber(mon.sleep) ?? 0) > 0)) {
      active.expNightmare = null;
    }
    // pokefirered/src/party_menu.c:5345
    if (truthy(e)) cured = ItemUse.cureKind(itemId);
    // pokefirered/src/pokemon.c:4481
    if (truthy(num) && truthy(ItemUse.BITTER_MEDICINE_FRIENDSHIP[num as number])) {
      Pokemon.itemFriendship(mon, ItemUse.BITTER_MEDICINE_FRIENDSHIP[num as number],
        { mapSec: Pokemon.currentMapSec(session) });
    }
    // pokefirered/src/party_menu.c:4498
    if (!BattleItems.isFlute(itemId)) Bag.remove(bag, itemId, 1);
    if (truthy(st.player) && st.player.partyIndex === partySlot) {
      sync_player_battler(st);
    }
    const b2 = truthy(st.double) && truthy(st.battlers) ? st.battlers[2] : null;
    if (truthy(b2) && b2.partyIndex === partySlot) sync_player_battler(st, 2);
    return ["heal", msgs, true, false, ItemUse.medicineText(mon, hpBefore, cured)];
  }

  say(Strings("This can't be used right now."));
  return ["error", msgs, false, false];
};

// Lua: items.lua:433 -- pokefirered/src/battle_controller_oak_old_man.c:388
BattleItems.afterPlayerItem = function (st: any, adapter: any, itemId: any): any {
  if ((ItemsData.toNumericId(itemId) ?? tonumber(itemId)) !== 13) return false;
  return Oak.sayOnce(st, Oak.FLAG_HP_RESTORE, "keepAnEyeOnHp", function (t: any, id: any): void {
    if (truthy(adapter) && truthy(adapter.say)) adapter.say(t, id);
  });
};

// pokefirered/src/battle_message.c:1195
const ENEMY_CURE_TEXT: Record<number, string> = {
  0: "STRINGID_PKMNSITEMSNAPPEDOUT",
  1: "STRINGID_PKMNSITEMCUREDPARALYSIS",
  2: "STRINGID_PKMNSITEMDEFROSTEDIT",
  3: "STRINGID_PKMNSITEMHEALEDBURN",
  4: "STRINGID_PKMNSITEMCUREDPOISON",
  5: "STRINGID_PKMNSITEMWOKEIT",
};

// Lua: items.lua:452 -- pokefirered/src/pokemon.c:4001
function enemy_item_effects(st: any, ad: any, b: any, e: any): void {
  void st;
  const band = AiItems.band;
  if (band(e[1], 0x80) !== 0 && truthy(b.expInfatuated)) { b.expInfatuated = null; b.expInfatuatedWith = null; }
  if (band(e[1], 0x30) !== 0 && !truthy(b.expFocusEnergy)) {
    b.expFocusEnergy = true; b.focusEnergy = true;
  }
  // Lua: items.lua:459
  function raise(key: string, n: number): void {
    const cur = (truthy(b.stages) ? b.stages[key] : b.stages) ?? 0;
    if (n > 0 && cur < 6) ad.changeStages(b, { [key]: n });
  }
  raise("attack", band(e[1], 0x0F));
  raise("defense", Math.floor(band(e[2], 0xF0) / 16));
  raise("speed", band(e[2], 0x0F));
  raise("accuracy", Math.floor(band(e[3], 0xF0) / 16));
  raise("spAtk", band(e[3], 0x0F));
  const side = ad.ownSide(b);
  if (band(e[4], 0x80) !== 0 && truthy(side) && (tonumber(side.expMistTurns) ?? 0) === 0) {
    side.expMistTurns = 5;
  }
  const s = AiItems.statusName(b);
  const cure = (band(e[4], 0x20) !== 0 && s === "SLP") || (band(e[4], 0x10) !== 0 && (s === "PSN" || s === "TOX"))
    || (band(e[4], 0x08) !== 0 && s === "BRN") || (band(e[4], 0x04) !== 0 && s === "FRZ")
    || (band(e[4], 0x02) !== 0 && s === "PAR");
  if (cure) {
    if (s === "SLP") b.expNightmare = null;
    ad.clearStatus(b);
  }
  if (band(e[4], 0x01) !== 0 && (tonumber(b.confusionTurns) ?? 0) > 0) b.confusionTurns = null;
  if (band(e[5], 0x04) !== 0) {
    const hp: number = ad.hp(b), maxHp: number = ad.maxHp(b);
    const revive = band(e[5], 0x40) !== 0;
    if ((revive && hp === 0) || (!revive && hp !== 0)) {
      let data = truthy(e.hp) ? e.hp : 0;
      if (data === AiItems.HEAL_HP_FULL) {
        data = maxHp - hp;
      } else if (data === AiItems.HEAL_HP_HALF) {
        data = Math.floor(maxHp / 2);
        if (data === 0) data = 1;
      } else if (data === AiItems.HEAL_HP_LVL_UP) {
        data = 0;
      }
      if (maxHp !== hp) ad.heal(b, data);
    }
  }
  if (truthy(b.mon)) b.status = b.mon.status;
}

// Lua: items.lua:501 -- pokefirered/src/battle_main.c:4150
BattleItems.enemyUse = function (st: any, adapter: any, act: any): boolean {
  const id = truthy(act) ? (truthy(act.battler) ? act.battler : 1) : 1;
  const b = State.battler(st, id);
  if (!truthy(b) || !truthy(b.mon) || !truthy(act.item)) return false;
  const item = act.item;
  const e = AiItems.effect(item);
  const kind = truthy(act.aiItemType) ? act.aiItemType : (truthy(e) ? AiItems.itemType(item, e) : e);
  const flags = tonumber(act.aiItemFlags) ?? 0;
  b.expFuryCutter = 0; b.destinyBond = null; b.expDestinyBond = null; b.expGrudge = null;
  const fill: any = { scrActive: b, atk: b, lastItem: item };
  // pokefirered/data/battle_scripts_2.s:134
  adapter.pushEvent({ kind: "item_use", battler: id, side: b.side, item: item, se: "SE_USE_ITEM" });
  adapter.sayText("STRINGID_TRAINER1USEDITEM", fill);
  if (truthy(e)) enemy_item_effects(st, adapter, b, e);
  const T = AiItems.TYPE;
  if (kind === T.FULL_RESTORE || kind === T.HEAL_HP) {
    adapter.sayText("STRINGID_PKMNSITEMRESTOREDHEALTH", fill);
    adapter.pushEvent({ kind: "status", battler: id, side: b.side });
  } else if (kind === T.CURE_CONDITION) {
    let chooser = 0;
    if (mod(flags, 2) === 1) {
      if (AiItems.band(flags, 0x3E) !== 0) chooser = 5;
    } else {
      let f = flags;
      while (f > 0 && mod(f, 2) === 0) {
        f = Math.floor(f / 2);
        chooser = chooser + 1;
      }
    }
    adapter.sayText(ENEMY_CURE_TEXT[chooser], fill);
    adapter.pushEvent({ kind: "status", battler: id, side: b.side });
  } else if (kind === T.X_STAT) {
    if (AiItems.band(flags, 0x80) !== 0) {
      adapter.sayText("STRINGID_PKMNUSEDXTOGETPUMPED", fill);
    } else {
      let stat = 1, f = flags;
      while (f > 0 && mod(f, 2) === 0) {
        f = Math.floor(f / 2);
        stat = stat + 1;
      }
      // pokefirered/src/battle_main.c:4205
      fill.buff1 = RomText.at("gStatNamesTable", stat);
      fill.buff2 = BattleText.get("STRINGID_STATROSE");
      adapter.sayText("STRINGID_USINGITEMSTATOFPKMNROSE", fill);
    }
  } else if (kind === T.GUARD_SPECS) {
    // pokefirered/src/battle_main.c:4216
    if (truthy(st.double)) {
      adapter.sayText("STRINGID_PKMNGETTINGPUMPED", fill);
    } else {
      adapter.sayText("STRINGID_PKMNSHROUDEDINMIST", fill);
    }
  }
  return true;
};

export default BattleItems;
