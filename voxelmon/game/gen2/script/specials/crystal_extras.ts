// gen1recomp src/script/gen2/specials/crystal_extras.lua (bdfac727, MIT).
//
// ../pokecrystal/data/events/special_pointers.asm:147 MoveTutor, :161 PokeSeer,
// :162 BuenasPassword, :163 BuenaPrize, :179 AskRememberPassword, :181
// UnusedFindItemInPCOrBag, plus :126 PrintDiploma. (The Lua module also
// carries OverworldTownMap; this port has it in Specials.ts already, where
// both carts reach it, so it is not defined twice here.)

import { Specials } from "../Specials.ts";
import type { Script, Vm } from "../Vm.ts";
import { Mon } from "../../battle/Mon.ts";
import { BugContest } from "../../core/BugContest.ts";
import { Nests } from "../../core/Nests.ts";
import { Save } from "../../core/Save.ts";
import { Bag } from "../../shared/inventory/Bag.ts";
import { Strings } from "../../shared/core/Strings.ts";

type Rec = any;

// engine/overworld/variables.asm:65 wBlueCardBalance, :66 wBuenasPassword
const VAR_BLUECARDBALANCE = 0x18;
const VAR_BUENASPASSWORD = 0x19;
// maps/RadioTower2F.asm:1 BLUE_CARD_POINT_CAP
const BLUE_CARD_POINT_CAP = 30;

const hooks = (vm: Vm): Rec => (vm && (vm as Rec).specials) || {};

// ------------------------------------------- MoveTutor (engine/events/move_tutor.asm:1)

// .GetMoveTutorMove (move_tutor.asm:36): MOVETUTOR_* onto MT01..MT03, i.e.
// pokemon.tutorMoves
function tutorMove(vm: Vm, index: number): string | undefined {
  const d = Specials.shared.data(vm);
  const list = d && d.pokemon && d.pokemon.tutorMoves;
  if (!Array.isArray(list)) return undefined;
  if (index !== 1 && index !== 2) index = 3;
  return list[index - 1];
}

function* MoveTutor(vm: Vm): Script<void> {
  const h = hooks(vm);
  const moveId = tutorMove(vm, vm.scriptVar ?? 0);
  // move_tutor.asm:29 .cancel, which is maps/GoldenrodCity.asm:72 .Incompatible
  if (!(moveId && h.pushScreen)) {
    vm.scriptVar = 255;
    return;
  }
  const d = Specials.shared.data(vm);
  const moveDef = d && d.moves && d.moves[moveId];
  const learned = yield* Specials.block(vm, (done) => {
    const ok = h.pushScreen("Gen2MoveTutor", {
      move: moveId,
      moveName: (moveDef && moveDef.name) || moveId,
      onDone: (taught: unknown) => done(!!taught),
    });
    if (!ok) done(false);
  });
  // move_tutor.asm:25 `xor a ; FALSE` on the learn arm
  vm.scriptVar = learned ? 0 : 255;
}

// --------------------- Buena (engine/events/buena.asm:1, engine/events/buena_menu.asm:1)

// data/radio/buenas_passwords.asm, in table order. `kind` is the BUENA_*
// function (constants/radio_constants.asm:128-131); `points` is both the Blue
// Card value and the menu width buena.asm:9 adds.
const BUENA_PASSWORDS: { kind: string; points: number; words: string[] }[] = [
  { kind: "mon", points: 10, words: ["CYNDAQUIL", "TOTODILE", "CHIKORITA"] },
  { kind: "item", points: 12, words: ["FRESH_WATER", "SODA_POP", "LEMONADE"] },
  { kind: "item", points: 12, words: ["POTION", "ANTIDOTE", "PARLYZ_HEAL"] },
  { kind: "item", points: 12, words: ["POKE_BALL", "GREAT_BALL", "ULTRA_BALL"] },
  { kind: "mon", points: 10, words: ["PIKACHU", "RATTATA", "GEODUDE"] },
  { kind: "mon", points: 10, words: ["HOOTHOOT", "SPINARAK", "DROWZEE"] },
  { kind: "string", points: 16, words: [Strings.source("NEW BARK TOWN"), Strings.source("CHERRYGROVE CITY"), Strings.source("AZALEA TOWN")] },
  { kind: "string", points: 6, words: [Strings.source("FLYING"), Strings.source("BUG"), Strings.source("GRASS")] },
  { kind: "move", points: 12, words: ["TACKLE", "GROWL", "MUD_SLAP"] },
  { kind: "item", points: 12, words: ["X_ATTACK", "X_DEFEND", "X_SPEED"] },
  { kind: "string", points: 13, words: [Strings.source("#MON Talk"), Strings.source("#MON Music"), Strings.source("Lucky Channel")] },
];
// constants/radio_constants.asm:120-121
const NUM_PASSWORD_CATEGORIES = BUENA_PASSWORDS.length;
const NUM_PASSWORDS_PER_CATEGORY = 3;

// GetBuenasPassword.StringFunctionJumptable (engine/pokegear/radio.asm:1534)
function passwordWord(vm: Vm, group: number, index: number): string {
  const row = BUENA_PASSWORDS[group];
  if (!row) return "?";
  const word = row.words[index];
  if (!word) return "?";
  if (row.kind === "string") return Strings.get(word);
  const d = Specials.shared.data(vm);
  const table = row.kind === "mon" ? d?.pokemon : row.kind === "item" ? d?.items : d?.moves;
  const def = table && table[word];
  return (def && def.name) || word;
}

// BuenasPassword4's two rejection rolls, packed group-high over word-low
// (engine/pokegear/radio.asm:1470-1487)
function rollPassword(save: Rec, day: number): number {
  const buena = Save.crystalState(save).buenaPassword;
  buena.word = (Specials.random(NUM_PASSWORD_CATEGORIES) - 1) * 16 + (Specials.random(NUM_PASSWORDS_PER_CATEGORY) - 1);
  buena.day = day;
  return buena.word;
}

// DAILYFLAGS2_BUENAS_PASSWORD_F makes the roll once a day (radio.asm:1467,
// :1489); the day stamp stands in for it
function currentPassword(vm: Vm): number {
  const record = Specials.shared.save(vm);
  if (!record) return 0;
  const buena = Save.crystalState(record).buenaPassword;
  const today = BugContest.now().day;
  if (buena.word == null || buena.day !== today) rollPassword(record, today);
  const v = vm as Rec;
  if (v.writeVarFn) v.writeVarFn(VAR_BUENASPASSWORD, buena.word % 256);
  return buena.word % 256;
}

// buena_menu.asm:1-9: carry (NO or B) is 0 and a YES is 1
function* AskRememberPassword(vm: Vm): Script<void> {
  const yes = yield { kind: "yesorno" };
  Specials.shared.answer(vm, yes ? 1 : 0);
}

// buena.asm:19-23 `ld a, [wBuenasPassword] / maskbits 3 / cp c`, and :44-49
// .PasswordIndices, which makes the menu's answer zero based
function* BuenasPassword(vm: Vm): Script<void> {
  const S = Specials.shared;
  const h = hooks(vm);
  const packed = currentPassword(vm);
  let group = Math.floor(packed / 16) % 16;
  if (group >= NUM_PASSWORD_CATEGORIES) group = 0;
  const answer = packed % 4;
  const words: string[] = [];
  for (let row = 0; row < NUM_PASSWORDS_PER_CATEGORY; row++) words.push(passwordWord(vm, group, row));
  if (!h.pushScreen) {
    S.answer(vm, 0);
    return;
  }
  const picked = yield* Specials.block(vm, (done) => {
    const ok = h.pushScreen("Gen2BuenaPassword", {
      mode: "password",
      words,
      width: BUENA_PASSWORDS[group]!.points,
      onDone: (index: number | undefined) => done(index ?? -1),
    });
    if (!ok) done(-1);
  });
  S.answer(vm, picked === answer ? 1 : 0);
}

// data/items/buena_prizes.asm
const BUENA_PRIZES = [
  { item: "ULTRA_BALL", cost: 2 },
  { item: "FULL_RESTORE", cost: 2 },
  { item: "NUGGET", cost: 3 },
  { item: "RARE_CANDY", cost: 3 },
  { item: "PROTEIN", cost: 5 },
  { item: "IRON", cost: 5 },
  { item: "CARBOS", cost: 5 },
  { item: "CALCIUM", cost: 5 },
  { item: "HP_UP", cost: 5 },
];

// data/text/common_3.asm:1082-1116, the six pages BuenaPrintText cycles
const PRIZE_TEXT = {
  which: Strings.source("Which prize would\nyou like?"),
  confirm: Strings.source("{STRBUF}?\nIs that right?"),
  hereYouGo: Strings.source("Here you go!"),
  notEnough: Strings.source("You don't have\nenough points."),
  noRoom: Strings.source("You have no room\nfor it."),
  comeAgain: Strings.source("Oh. Please come\nback again!"),
};

// wBlueCardBalance is a RETVAR_ADDR_DE var (maps/RadioTower2F.asm:144-146)
function blueCardBalance(vm: Vm): number {
  const v = vm as Rec;
  if (!v.readVarFn) return 0;
  let value = Math.floor(Number(v.readVarFn(VAR_BLUECARDBALANCE)) || 0);
  if (value < 0) value = 0;
  return Math.min(value, BLUE_CARD_POINT_CAP);
}

function setBlueCardBalance(vm: Vm, value: number): void {
  const v = vm as Rec;
  if (v.writeVarFn) v.writeVarFn(VAR_BLUECARDBALANCE, Math.max(0, value) % 256);
}

// ReceiveItem into wNumItems (buena.asm:104-110)
function receiveItem(vm: Vm, itemId: string): boolean {
  const record = Specials.shared.save(vm);
  if (!record) return false;
  record.inventory = record.inventory ?? {};
  return !!Bag.add(record, itemId, 1, Specials.shared.data(vm));
}

function* BuenaPrize(vm: Vm): Script<void> {
  const S = Specials.shared;
  const h = hooks(vm);
  if (!h.pushScreen) return;
  const d = S.data(vm);
  const items = d && d.items;
  const rows = BUENA_PRIZES.map((prize) => {
    const def = items && items[prize.item];
    return { item: prize.item, cost: prize.cost, name: (def && def.name) || prize.item };
  });
  for (;;) {
    // buena.asm:71-83: the page is printed and the menu opens over it
    yield* S.showRawHeld(vm, Strings.get(PRIZE_TEXT.which));
    const pick = yield* Specials.block(vm, (done) => {
      const ok = h.pushScreen("Gen2BuenaPassword", {
        mode: "prize",
        prizes: rows,
        balance: blueCardBalance(vm),
        onDone: (index: number | undefined) => done(index ?? 0),
      });
      if (!ok) done(0);
    });
    // buena.asm:84 `jr z, .done`: 0 is the B press (1-based picks)
    if (!(typeof pick === "number" && rows[pick - 1])) break;
    const row = rows[pick - 1]!;
    (vm as Rec).setStringBuffer(row.name);
    yield* S.showRawHeld(vm, Strings.get(PRIZE_TEXT.confirm));
    const sure = yield { kind: "yesorno" };
    if (sure) {
      // buena.asm:95-119: the cost is checked, then ReceiveItem, and only a
      // delivered item spends the points
      const balance = blueCardBalance(vm);
      if (balance < row.cost) {
        yield* (vm as Rec).showRaw(Strings.get(PRIZE_TEXT.notEnough));
      } else if (!receiveItem(vm, row.item)) {
        yield* (vm as Rec).showRaw(Strings.get(PRIZE_TEXT.noRoom));
      } else {
        setBlueCardBalance(vm, balance - row.cost);
        if (h.playSfxNamed) h.playSfxNamed("Sfx_Transaction");
        yield* (vm as Rec).showRaw(Strings.get(PRIZE_TEXT.hereYouGo));
      }
    }
  }
  // buena.asm:138-145 .done
  yield* (vm as Rec).showRaw(Strings.get(PRIZE_TEXT.comeAgain));
}

// ------------------------------------------- PokeSeer (engine/events/poke_seer.asm:18)

// data/text/common_3.asm:281-445, SeerTexts (poke_seer.asm:289) in jumptable order
const SEER_TEXT = {
  intro: Strings.source("I see all.\nI know all…\fCertainly, I know\nof your #MON!"),
  cantTell: Strings.source("Whaaaat? I can't\ntell a thing!\fHow could I not\nknow of this?"),
  nameLocation: Strings.source("Hm… I see you met\n%s here:\v%s!"),
  timeLevel: Strings.source("The time was\n%s!\fIts level was %s!\fAm I good or what?"),
  trade: Strings.source("Hm… %s\ncame from %s\vin a trade?\f%s\nwas where %s\vmet %s!"),
  noLocation: Strings.source(
    "What!? Incredible!\fI don't understand\nhow, but it is\fincredible!\n"
      + "You are special.\fI can't tell where\nyou met it, but it\v"
      + "was at level %s.\fAm I good or what?",
  ),
  egg: Strings.source("Hey!\fThat's an EGG!\fYou can't say that\nyou've met it yet…"),
  doNothing: Strings.source("Fufufu! I saw that\nyou'd do nothing!"),
};

// SeerAdviceTexts (poke_seer.asm:357), `dbw level, text`; true splices the nickname
const SEER_ADVICE: [number, string, boolean?][] = [
  [9, Strings.source("Incidentally…\fIt would be wise\nto raise your\f#MON with a\nlittle more care.")],
  [29, Strings.source("Incidentally…\fIt seems to have\ngrown a little.\f%s seems\nto be becoming\vmore confident."), true],
  [59, Strings.source("Incidentally…\f%s has\ngrown. It's gained\vmuch strength."), true],
  [89, Strings.source(
    "Incidentally…\fIt certainly has\ngrown mighty!\fThis %s\nmust have come\f"
      + "through numerous\n#MON battles.\fIt looks brimming\nwith confidence.",
  ), true],
  [100, Strings.source(
    "Incidentally…\fI'm impressed by\nyour dedication.\fIt's been a long\n"
      + "time since I've\fseen a #MON as\nmighty as this\v%s.\fI'm sure that\n"
      + "seeing %s\fin battle would\nexcite anyone.",
  ), true],
  [255, Strings.source("Incidentally…\fIt would be wise\nto raise your\f#MON with a\nlittle more care.")],
];

// GetCaughtTime's .times (poke_seer.asm:203) and UnknownCaughtData (:215)
const SEER_TIMES = [Strings.source("Morning"), Strings.source("Day"), Strings.source("Night")];
const SEER_UNKNOWN = Strings.source("Unknown");
const SEER_NO_LEVEL = Strings.source("???");
// constants/pokemon_data_constants.asm:130 CAUGHT_EGG_LEVEL, battle_constants.asm:4 EGG_LEVEL
const CAUGHT_EGG_LEVEL = 1;
const EGG_LEVEL = 5;

// GetCaughtLevel (poke_seer.asm:148-179)
function caughtLevel(byte0: number): [number | undefined, string] {
  let level = byte0 % 0x40;
  if (level === 0) return [undefined, Strings.get(SEER_NO_LEVEL)];
  if (level === CAUGHT_EGG_LEVEL) level = EGG_LEVEL;
  return [level, String(level)];
}

// GetCaughtLocation (poke_seer.asm:217-249); the second answer is the
// SEERACTION_* its two sentinel arms override wSeerAction with
function caughtLocation(vm: Vm, byte1: number): [string | undefined, string | undefined] {
  const landmark = byte1 % 0x80;
  if (landmark === 0) return [Strings.get(SEER_UNKNOWN), undefined];
  if (landmark === Mon.LANDMARK_EVENT) return [undefined, "level_only"];
  if (landmark === Mon.LANDMARK_GIFT) return [undefined, "cant_tell"];
  const record = Nests.landmark(Specials.shared.data(vm), landmark);
  const name = record && record.name;
  if (!name) return [Strings.get(SEER_UNKNOWN), undefined];
  // GetLandmarkName copies the break byte through; it becomes a space
  return [String(name).replace(/\n/g, " "), undefined];
}

// SeerAdvice (poke_seer.asm:331-355); `sub c` is one byte
function* seerAdvice(vm: Vm, mon: Rec, level: number | undefined): Script<void> {
  const diff = (((mon.level ?? 0) - (level ?? 0)) % 256 + 256) % 256;
  const name = Mon.displayName(mon);
  for (const row of SEER_ADVICE) {
    if (diff <= row[0]) {
      if (row[2]) yield* (vm as Rec).showRaw(Strings.get(row[1], name, name));
      else yield* (vm as Rec).showRaw(Strings.get(row[1]));
      return;
    }
  }
}

function* PokeSeer(vm: Vm): Script<void> {
  const S = Specials.shared;
  const v = vm as Rec;
  yield* v.showRaw(Strings.get(SEER_TEXT.intro));
  const [, mon] = yield* S.selectMon(vm, "choose");
  // poke_seer.asm:38 .cancel
  if (!mon) {
    yield* v.showRaw(Strings.get(SEER_TEXT.doNothing));
    return;
  }
  // :28-29 `cp EGG / jr z, .egg`
  if (mon.isEgg) {
    yield* v.showRaw(Strings.get(SEER_TEXT.egg));
    return;
  }
  const [byte0, byte1] = Mon.packCaughtData(mon);
  // ReadCaughtData's `.error` (poke_seer.asm:104-105, :133)
  if (byte0 === 0 && byte1 === 0) {
    yield* v.showRaw(Strings.get(SEER_TEXT.cantTell));
    return;
  }
  // poke_seer.asm:110-119: only the HIGH byte of the OT id decides "traded"
  const record = S.save(vm);
  const playerId = (record && record.player && record.player.id) || 0;
  const traded = Math.floor((mon.otId ?? 0) / 256) % 256 !== Math.floor(playerId / 256) % 256;
  const [level, levelText] = caughtLevel(byte0);
  const [place, override] = caughtLocation(vm, byte1);
  const name = Mon.displayName(mon);
  // SeerAction2 / SeerAction3 (poke_seer.asm:81-89)
  if (override === "cant_tell") {
    yield* v.showRaw(Strings.get(SEER_TEXT.cantTell));
    return;
  }
  // SeerAction4 (poke_seer.asm:91-95)
  if (override === "level_only") {
    yield* v.showRaw(Strings.get(SEER_TEXT.noLocation, levelText));
    yield* seerAdvice(vm, mon, level);
    return;
  }
  const time = Math.floor(byte0 / 0x40);
  const timeText = time > 0 ? Strings.get(SEER_TIMES[time - 1]!) : Strings.get(SEER_UNKNOWN);
  if (traded) {
    // SeerAction1 (poke_seer.asm:72-79)
    const ot = mon.otName ?? mon.ot ?? Strings.get(SEER_UNKNOWN);
    yield* v.showRaw(Strings.get(SEER_TEXT.trade, name, ot, place, ot, name));
  } else {
    // SeerAction0 (poke_seer.asm:64-70)
    yield* v.showRaw(Strings.get(SEER_TEXT.nameLocation, name, place));
  }
  yield* v.showRaw(Strings.get(SEER_TEXT.timeLevel, timeText, levelText));
  yield* seerAdvice(vm, mon, level);
}

// --------------------- UnusedFindItemInPCOrBag (mobile/mobile_12_2.asm:191)

// CheckItem against wNumPCItems, then wNumItems (mobile_12_2.asm:194, :201)
function UnusedFindItemInPCOrBag(vm: Vm): void {
  const S = Specials.shared;
  const h = hooks(vm);
  const index = vm.scriptVar ?? 0;
  const record = S.save(vm);
  const d = S.data(vm);
  let id: string | undefined;
  for (const [key, def] of Object.entries((d && d.items) || {})) {
    if (def && typeof def === "object" && (def as Rec).index === index) {
      id = key;
      break;
    }
  }
  const pc = record && record.pcItems;
  if (id && pc && typeof pc === "object" && (Number(pc[id]) || 0) > 0) {
    S.answer(vm, 1);
    return;
  }
  if (h.hasItem && h.hasItem(index)) {
    S.answer(vm, 1);
    return;
  }
  S.answer(vm, 0);
}

// ------------------------------- the printed diploma (engine/events/specials.asm:448)

// _PrintDiploma (engine/printer/printer.asm:382) opens with the very page
// `special Diploma` shows and only then reaches for the serial port; page 1
// IS the whole visible routine
function* PrintDiploma(vm: Vm): Script<void> {
  const h = Specials.shared.hooks(vm);
  if (!h.showDiploma) return;
  yield* Specials.block(vm, (done) => {
    h.showDiploma(() => done(true));
  });
}

export const crystal_extras: Record<string, (vm: Vm) => any> = {
  MoveTutor,
  AskRememberPassword,
  BuenasPassword,
  BuenaPrize,
  PokeSeer,
  UnusedFindItemInPCOrBag,
  PrintDiploma,
};
export default crystal_extras;
