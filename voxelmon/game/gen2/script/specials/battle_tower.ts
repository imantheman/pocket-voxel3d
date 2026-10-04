// gen1recomp src/script/gen2/specials/battle_tower.lua (bdfac727, MIT): the
// Battle Tower specials -- pokecrystal data/events/special_pointers.asm:132-140
// and :150 BattleTowerAction, :152 Menu_ChallengeExplanationCancel.
//
// One addition of this port's own: the GS BALL. Brian's BATTLETOWERACTION_GSBALL
// answers from sGSBallFlag, which only Japan's Mobile System GB ever set. The
// 3DS Virtual Console release of Crystal sets it when the player enters the
// HALL OF FAME, and the cart's own scripts do the rest: the Goldenrod
// POKeMON CENTER scene asks this action and hands the GS BALL over once
// (its own event flag), KURT studies it, and the ILEX FOREST shrine calls
// CelebiShrineEvent (specials/crystal_story.ts). That is the event here.

import { Specials } from "../Specials.ts";
import type { Script, Vm } from "../Vm.ts";
import { BattleTower } from "../../core/BattleTower.ts";
import { HallOfFame } from "../../core/HallOfFame.ts";
import { Save } from "../../core/Save.ts";
import { Bag } from "../../shared/inventory/Bag.ts";
import { RomText } from "../../shared/core/RomText.ts";
import { Strings } from "../../shared/core/Strings.ts";

type Rec = any;
type Action = (vm: Vm, tower: Rec, record: Rec) => any;

const A = BattleTower.ACTIONS;

// battle_tower.asm:190-196 InitBattleTowerChallengeRAM; wNrOfBeatenBattleTowerTrainers
// is the byte the room script `readmem`s
function initChallengeRam(vm: Vm): void {
  const v = vm as Rec;
  v.btBattleEnded = 0;
  v.btBeaten = 0;
  if (v.mem) v.mem[BattleTower.WRAM_NR_BEATEN] = 0;
}

// rules.asm:57-92, the far labels rom_text carries
const RULE_FALLBACKS: Record<string, string> = {
  _ExcuseMeYoureNotReadyText: Strings.source("Excuse me.\nYou're not ready."),
  _OnlyThreeMonMayBeEnteredText: Strings.source("Only three POKéMON\nmay be entered."),
  _TheMonMustAllBeDifferentKindsText: Strings.source("The {STRBUF} POKéMON\nmust all be different kinds."),
  _TheMonMustNotHoldTheSameItemsText: Strings.source("The {STRBUF} POKéMON\nmust not hold the same items."),
  _YouCantTakeAnEggText: Strings.source("You can't take an\nEGG!"),
  _BattleTowerReturnWhenReadyText: Strings.source("Please return when\nyou're ready."),
};

// battle_tower.asm:1157-1171: the running game IS the loaded save, so
// CompareLoadedAndSavedPlayerID can only match
function saveFileIsYours(vm: Vm): number {
  const S = Specials.shared;
  const record = S.save(vm);
  if (!(record && record.version)) return S.FALSE;
  return Save.exists(record.version) ? S.TRUE : S.FALSE;
}

// battle_tower.asm:1024-1127, :1187-1242, :1314-1447: SRAM bank 5 and WRAM
// bank 3 belong to the Mobile System GB; a cart that never linked reads zero
const MOBILE_ARMS: Record<number, { value?: number; why: string }> = {
  [A.ACTION_05!]: { value: 0, why: "s5_be46 is 0 until a mobile challenge" },
  [A.ACTION_06!]: { why: "clears the mobile challenge bytes" },
  [A.ACTION_0C!]: { why: "stamps the mobile challenge day" },
  [A.ACTION_0D!]: { value: 0, why: "s5_aa47 is 0, so `and a / ret z`" },
  [A.ACTION_0F!]: { value: 0, why: "w3_d090 is the adapter's status byte" },
  [A.ACTION_10!]: { value: 0, why: "s5_a800 is 0, the .NoAction row" },
  [A.ACTION_16!]: { why: "stamps the mobile news day" },
  [A.ACTION_17!]: { value: 0, why: "s5_b2f9 is 0, so `and a / ret z`" },
  [A.LEVEL_CHECK!]: { value: 0, why: "s5_b2fb is the stadium's max level" },
  [A.UBERS_CHECK!]: { value: 0, why: "s5_b2fb is the stadium's max level" },
};

// battle_tower.asm:951-953 BattleTower_SaveOptions writes options.lua
const UNHOOKED_ARMS: Record<number, string> = {
  [A.SAVEOPTIONS!]: "needs a saveOptions hook in World:specialHooks",
};

// battle_tower.asm:1311-1312 String_MysteryJP, the OT the Mobile Stadium
// stamps on an Odd Egg
const MYSTERY_OT = "なぞナノ";

/** Whether the GS BALL is on offer: sGSBallFlag (Brian's crystal.gsBall), or
 * -- the Virtual Console's rule -- the HALL OF FAME entered. */
export function gsBallAvailable(record: Rec): boolean {
  if (!record) return false;
  const crystal = Save.crystalState(record);
  if (Save.GS_BALL_STATES[crystal.gsBall]) return true;
  return HallOfFame.hasEntered(record);
}

const ACTIONS: Record<number, Action> = {
  // battle_tower.asm:978-990
  [A.CHECK_EXPLANATION_READ!]: (vm, _tower, record) => {
    const yours = saveFileIsYours(vm);
    Specials.shared.answer(vm, yours);
    if (yours === 0) return;
    Specials.shared.answer(vm, BattleTower.saveFileFlag(record, BattleTower.SAVEFILE_EXPLANATION));
  },
  // :1001-1008
  [A.SET_EXPLANATION_READ!]: (_vm, _tower, record) => {
    BattleTower.setSaveFileFlag(record, BattleTower.SAVEFILE_EXPLANATION);
  },
  // :992-999
  [A.GET_CHALLENGE_STATE!]: (vm, tower) => Specials.shared.answer(vm, tower.challenge),
  // :1010-1012
  [A.SAVE_AND_QUIT!]: (_vm, _tower, record) => BattleTower.setChallengeState(record, BattleTower.SAVED_AND_LEFT),
  // :1014-1022
  [A.CHALLENGECANCELED!]: (_vm, _tower, record) => BattleTower.setChallengeState(record, BattleTower.NO_CHALLENGE),
  // :1129-1141
  [A.SAVELEVELGROUP!]: (vm, tower) => {
    tower.levelGroup = Math.max(0, Math.floor(Number((vm as Rec).btLevelGroup) || 0));
  },
  // :1143-1155
  [A.LOADLEVELGROUP!]: (vm, tower) => {
    (vm as Rec).btLevelGroup = tower.levelGroup;
  },
  // :1157-1171
  [A.CHECKSAVEFILEISYOURS!]: (vm) => Specials.shared.answer(vm, saveFileIsYours(vm)),
  // :1173-1177: the pending fade dropped, the volume back to full
  [A.ACTION_0A!]: (vm) => {
    const h = Specials.shared.hooks(vm);
    if (h.stopMusic) h.stopMusic();
  },
  // :1179-1185 (and this port's Virtual Console rule, see the header)
  [A.GSBALL!]: (vm, _tower, record) => {
    Specials.shared.answer(vm, gsBallAvailable(record) ? BattleTower.GS_BALL_AVAILABLE : 0);
  },
  // :1244-1309: the EGG_TICKET is spent only on a party egg carrying String_MysteryJP
  [A.EGGTICKET!]: (vm, _tower, record) => {
    const S = Specials.shared;
    S.answer(vm, S.FALSE);
    const held = record && record.inventory && record.inventory.EGG_TICKET;
    if (!held || held <= 0) return;
    for (const mon of S.party(vm)) {
      if (mon.isEgg && mon.otName === MYSTERY_OT) {
        mon.otName = "";
        Bag.remove(record, "EGG_TICKET", 1);
        S.answer(vm, S.TRUE);
        return;
      }
    }
  },
  // :1449-1461
  [A.ACTION_11!]: (_vm, tower) => {
    tower.reentry = false;
  },
  [A.ACTION_12!]: (_vm, tower) => {
    tower.reentry = true;
  },
  // :1463-1469
  [A.ACTION_13!]: (vm, tower) => Specials.shared.answer(vm, tower.reentry ? Specials.shared.TRUE : Specials.shared.FALSE),
  // :1471-1483
  [A.ACTION_14!]: (vm, _tower, record) => {
    const yours = saveFileIsYours(vm);
    Specials.shared.answer(vm, yours);
    if (yours === 0) return;
    Specials.shared.answer(vm, BattleTower.saveFileFlag(record, BattleTower.SAVEFILE_REGISTERED));
  },
  // :1485-1492
  [A.ACTION_15!]: (_vm, _tower, record) => BattleTower.setSaveFileFlag(record, BattleTower.SAVEFILE_REGISTERED),
  // :890-904
  [A.RESETDATA!]: (_vm, _tower, record) => BattleTower.resetTrainers(record),
  // :906-933
  [A.GIVEREWARD!]: (vm, tower, record) => {
    const S = Specials.shared;
    const h = S.hooks(vm);
    let reward = tower.reward || BattleTower.FALLBACK_REWARD;
    const data = S.data(vm);
    let fits = false;
    if (record) {
      record.inventory = record.inventory ?? {};
      fits = BattleTower.rewardFits(Bag.slots(record, data, "ITEM"), Bag.capacity(data, "ITEM"), record.inventory[reward]);
    }
    if (!fits) reward = BattleTower.FALLBACK_REWARD;
    S.answer(vm, (h.itemIndex && h.itemIndex(reward)) || 0);
  },
  // :935-949
  [A.ACTION_1C!]: (_vm, _tower, record) => BattleTower.setChallengeState(record, BattleTower.WON_CHALLENGE),
  [A.ACTION_1D!]: (_vm, _tower, record) => BattleTower.setChallengeState(record, BattleTower.RECEIVED_REWARD),
  // :955-976: Specials.random answers 1..n; `% mask` makes the maskbits byte
  [A.CHOOSEREWARD!]: (vm, tower) => {
    const data = Specials.shared.data(vm);
    const order = data && data.gen2Constants && data.gen2Constants.itemOrder;
    tower.reward = BattleTower.rollReward(order, (n) => Specials.random(n)) ?? BattleTower.FALLBACK_REWARD;
  },
};

// battle_tower.asm:852-887, the jumptable `special BattleTowerAction` dispatches on wScriptVar
function BattleTowerAction(vm: Vm): any {
  const id = Math.floor(Number(vm.scriptVar) || 0);
  // ram/sram.asm:147-172, read as the zeroes a fresh cart holds
  const record = Specials.shared.save(vm) ?? {};
  const tower = BattleTower.state(record);
  const run = ACTIONS[id];
  if (run) return run(vm, tower, record);
  const mobile = MOBILE_ARMS[id];
  if (mobile) {
    if (mobile.value !== undefined) Specials.shared.answer(vm, mobile.value);
    return;
  }
  if (UNHOOKED_ARMS[id]) return;
}

// battle_tower.asm:1583-1594: TRUE means the party FAILED (`ifnotequal FALSE`)
function* CheckForBattleTowerRules(vm: Vm): Script<void> {
  const S = Specials.shared;
  const [lines, failed] = BattleTower.checkRules(S.party(vm));
  const data = S.data(vm);
  // rules.asm:28-31 wStringBuffer2
  (vm as Rec).setStringBuffer(BattleTower.RULE_PARTY_COUNT_TEXT);
  for (const label of lines) yield* (vm as Rec).showRaw(RomText(data, label, RULE_FALLBACKS[label] ?? label));
  S.answer(vm, failed ? S.TRUE : S.FALSE);
}

// mobile/mobile_5f.asm:425-468, MenuData :490-495: wScriptVar leaves the row
// number, or 4 for a B press
const CHALLENGE_MENU_ROWS = [Strings.source("Challenge"), Strings.source("Explanation"), Strings.source("Cancel")];
const CHALLENGE_MENU_CANCEL = 4;
// mobile_5f.asm:484-488 `menu_coords 0, 0, 14, 7`, STATICMENU_CURSOR | STATICMENU_WRAP
const CHALLENGE_MENU_FLAGS = 0x80 + 0x20;

function* Menu_ChallengeExplanationCancel(vm: Vm): Script<void> {
  const S = Specials.shared;
  const h = S.hooks(vm);
  let choice = yield* Specials.block(vm, (done) => {
    if (!h.scriptMenu) return done(0);
    h.scriptMenu(
      { items: CHALLENGE_MENU_ROWS, left: 0, top: 0, right: 14, bottom: 7, dataFlags: CHALLENGE_MENU_FLAGS, cursor: 1 },
      done,
    );
  });
  choice = Math.floor(Number(choice) || 0);
  if (choice < 1 || choice > CHALLENGE_MENU_ROWS.length) {
    S.answer(vm, CHALLENGE_MENU_CANCEL);
    return;
  }
  S.answer(vm, choice);
}

// battle_tower.asm:1534-1550: the trainer row, three mons and the two SRAM
// tables that stop either repeating; wScriptVar holds the object the
// opponent walks in as and is NOT written
function LoadOpponentTrainerAndPokemonWithOTSprite(vm: Vm): void {
  const S = Specials.shared;
  const v = vm as Rec;
  const record = S.save(vm);
  if (!record) return;
  const opponent = BattleTower.drawOpponent(S.data(vm), record, (n) => Specials.random(n), v.btLevelGroup);
  v.btOpponent = opponent;
  if (!opponent) return;
  // :1552-1575: BTTrainerClassSprites[class - 1] into the map object wScriptVar names
  const h = S.hooks(vm);
  if (h.setObjectSprite && opponent.sprite) h.setObjectSprite(Math.floor(Number(vm.scriptVar) || 0), opponent.sprite);
}

// battle_tower.asm:181-185 and RunBattleTowerTrainer (:214-259): HealParty,
// ReadBTTrainerParty (the streak steps, the challenge arms), StartBattle,
// HealParty, wBattleResult into wScriptVar; a win copies the beaten count to
// the byte the room script `readmem`s and leaves `count + 1` as the digit
// Text_NextUpOpponentNo prints
function* BattleTowerBattle(vm: Vm): Script<void> {
  const S = Specials.shared;
  const v = vm as Rec;
  v.btBattleEnded = 0;
  const record = S.save(vm);
  const data = S.data(vm);
  const h = S.hooks(vm);
  let opponent = v.btOpponent;
  if (!opponent && record) {
    opponent = BattleTower.drawOpponent(data, record, (n) => Specials.random(n), v.btLevelGroup);
    v.btOpponent = opponent;
  }
  // no roster: LOSE is the room script's own back-out arm
  // (maps/BattleTowerBattleRoom.asm:34-37)
  if (!(opponent && record)) {
    v.btBattleEnded = 1;
    S.answer(vm, 1);
    return;
  }
  const streak = BattleTower.beginBattle(record);
  if (h.healParty) h.healParty();
  const classes = data && data.trainers && data.trainers.classes;
  const cls = classes && classes[opponent.classId];
  const className = (cls && cls.name) || opponent.classId;
  const party = BattleTower.battleParty(data, opponent.rows);
  const outcome = yield* Specials.block(vm, (done) => {
    if (!h.startTowerBattle) return done("lose");
    const started = h.startTowerBattle(
      {
        class: opponent.class,
        classId: opponent.classId,
        className,
        // PlaceEnemysName prints the class then the trainer's own name
        name: className ? `${className} ${opponent.name}` : opponent.name,
        trainerName: opponent.name,
        party,
        attributes: cls && cls.attributes,
        baseMoney: cls && cls.baseMoney,
        items: cls && cls.items,
      },
      done,
    );
    if (!started) done("lose");
  });
  if (h.healParty) h.healParty();
  // :236-237 wBattleResult: WIN is 0
  const won = outcome !== "lose";
  S.answer(vm, won ? 0 : 1);
  if (won && v.mem) {
    v.mem[BattleTower.WRAM_NR_BEATEN] = streak % 256;
    v.setStringBuffer(String(streak + 1));
  }
  v.btBattleEnded = 1;
  v.btOpponent = undefined;
}

// battle_tower.asm:1-5 (InitBattleTowerChallengeRAM + _BattleTowerRoomMenu,
// mobile/mobile_46.asm:137-177): 0 for a chosen room, $a for the cancel
function* BattleTowerRoomMenu(vm: Vm): Script<void> {
  const S = Specials.shared;
  initChallengeRam(vm);
  const h = S.hooks(vm);
  const record = S.save(vm);
  const result = yield* Specials.block(vm, (done) => {
    if (!h.pushScreen) return done(undefined);
    const ok = h.pushScreen("Gen2BattleTowerMenu", {
      save: record,
      party: S.party(vm),
      rows: BattleTower.levelGroupRows(record),
      monName: h.monName,
      onDone: done,
    });
    if (!ok) done(undefined);
  });
  const group = Math.floor(Number(result) || 0);
  if (group < 1 || group > BattleTower.MAX_LEVEL_GROUP) {
    // mobile_46.asm:4609-4610
    S.answer(vm, 0x0a);
    return;
  }
  (vm as Rec).btLevelGroup = group;
  S.answer(vm, 0);
}

export const battle_tower: Record<string, (vm: Vm) => any> = {
  BattleTowerAction,
  CheckForBattleTowerRules,
  Menu_ChallengeExplanationCancel,
  LoadOpponentTrainerAndPokemonWithOTSprite,
  BattleTowerBattle,
  BattleTowerRoomMenu,
};
export default battle_tower;
