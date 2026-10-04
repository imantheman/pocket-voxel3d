// gen1recomp src/script/gen2/specials/crystal_story.lua (bdfac727, MIT).
//
// ../pokecrystal/data/events/special_pointers.asm:141 GiveOddEgg, :148
// OmanyteChamber, :157 HoOhChamber, :159 CelebiShrineEvent, :160
// CheckCaughtCelebi, :164 GiveDratini, :166 BeastsCheck.

import { Specials } from "../Specials.ts";
import type { Vm } from "../Vm.ts";
import { Mon } from "../../battle/Mon.ts";
import { Save } from "../../core/Save.ts";
import { UnownWords } from "../../world/UnownWords.ts";

type Rec = any;

// pokecrystal constants/script_constants.asm:51 VAR_BATTLETYPE
const VAR_BATTLETYPE = 0x03;
// pokecrystal constants/battle_constants.asm:102 BATTLETYPE_CELEBI
const BATTLETYPE_CELEBI = 11;

// engine/pokemon/search_owned.asm:6, :11, :16
const BEASTS = ["RAIKOU", "ENTEI", "SUICUNE"];

// Lua: crystal_story.lua:25 -- engine/pokemon/search_owned.asm:1
function BeastsCheck(vm: Vm): void {
  const S = Specials.shared;
  const monCheck = Specials.HANDLERS.MonCheck!;
  const h = S.hooks(vm);
  for (const name of BEASTS) {
    vm.scriptVar = (h.monIndex && h.monIndex(name)) || name;
    monCheck(vm);
    if (vm.scriptVar !== S.TRUE) {
      S.answer(vm, S.FALSE);
      return;
    }
  }
  S.answer(vm, S.TRUE);
}

// engine/events/dratini.asm:72 .Moveset0, :79 .Moveset1
const DRATINI = "DRATINI";
const DRATINI_MOVESETS: Record<number, string[]> = {
  0: ["WRAP", "THUNDER_WAVE", "TWISTER", "EXTREMESPEED"],
  1: ["WRAP", "LEER", "THUNDER_WAVE", "TWISTER"],
};

// Lua: crystal_story.lua:50 -- dratini.asm:1: `cp $2 / ret nc`, then :16
// .CheckForDratini walks the party BACKWARDS from the last slot
function GiveDratini(vm: Vm): void {
  const S = Specials.shared;
  const set = DRATINI_MOVESETS[vm.scriptVar ?? 0];
  if (!set) return;
  const list: Rec[] = S.party(vm);
  let target: Rec;
  for (let i = list.length - 1; i >= 0; i--) {
    const mon = list[i];
    if (mon && mon.species === DRATINI) {
      target = mon;
      break;
    }
  }
  if (!target) return;
  // dratini.asm:54: each new move's PP comes from Moves + MOVE_PP
  const defs = S.data(vm);
  const moves = defs && defs.moves;
  target.moves = target.moves ?? [];
  set.forEach((id, i) => {
    const pp = (moves && moves[id] && moves[id].pp) || 0;
    target.moves[i] = { id, pp, maxPp: pp };
  });
}

// data/events/odd_eggs.asm:14-33 -- the `odd_egg_prob` arguments; the macro
// accumulates them and stores total * $ffff / 100
const ODD_EGG_PERCENTS = [8, 1, 16, 3, 16, 3, 14, 2, 10, 2, 12, 2, 10, 1];
const ODD_EGG_PROBABILITIES: number[] = [];
{
  let total = 0;
  for (const percent of ODD_EGG_PERCENTS) {
    total += percent;
    ODD_EGG_PROBABILITIES.push(Math.floor((total * 0xffff) / 100));
  }
}

interface OddEggRow {
  species: string;
  otId: number;
  experience: number;
  level: number;
  eggSteps: number;
  moves: string[];
  pp: number[];
  dvs: { attack: number; defense: number; speed: number; special: number };
  stats: { hp: number; attack: number; defense: number; speed: number; specialAttack: number; specialDefense: number };
}

const DV0 = { attack: 0, defense: 0, speed: 0, special: 0 };
const DVS = { attack: 2, defense: 10, speed: 10, special: 10 };
const stats = (hp: number, attack: number, defense: number, speed: number, specialAttack: number, specialDefense: number) =>
  ({ hp, attack, defense, speed, specialAttack, specialDefense });
const egg = (species: string, otId: number, moves: string[], pp: number[], dvs: OddEggRow["dvs"], st: OddEggRow["stats"]): OddEggRow =>
  ({ species, otId, experience: 125, level: 5, eggSteps: 20, moves, pp, dvs, stats: st });

// data/events/odd_eggs.asm:37 OddEggs, one row per NICKNAMED_MON_STRUCT
const ODD_EGGS: OddEggRow[] = [
  egg("PICHU", 2048, ["THUNDERSHOCK", "CHARM", "DIZZY_PUNCH"], [30, 20, 10], DV0, stats(17, 9, 6, 11, 8, 8)),
  egg("PICHU", 256, ["THUNDERSHOCK", "CHARM", "DIZZY_PUNCH"], [30, 20, 10], DVS, stats(17, 9, 7, 12, 9, 9)),
  egg("CLEFFA", 4096, ["POUND", "CHARM", "DIZZY_PUNCH"], [35, 20, 10], DV0, stats(20, 7, 7, 6, 9, 10)),
  egg("CLEFFA", 768, ["POUND", "CHARM", "DIZZY_PUNCH"], [35, 20, 10], DVS, stats(20, 7, 8, 7, 10, 11)),
  egg("IGGLYBUFF", 4096, ["SING", "CHARM", "DIZZY_PUNCH"], [15, 20, 10], DV0, stats(24, 8, 6, 6, 9, 7)),
  egg("IGGLYBUFF", 768, ["SING", "CHARM", "DIZZY_PUNCH"], [15, 20, 10], DVS, stats(24, 8, 7, 7, 10, 8)),
  egg("SMOOCHUM", 3584, ["POUND", "LICK", "DIZZY_PUNCH"], [35, 30, 10], DV0, stats(19, 8, 6, 11, 13, 11)),
  egg("SMOOCHUM", 512, ["POUND", "LICK", "DIZZY_PUNCH"], [35, 30, 10], DVS, stats(19, 8, 7, 12, 14, 12)),
  egg("MAGBY", 2560, ["EMBER", "DIZZY_PUNCH"], [25, 10], DV0, stats(19, 12, 8, 13, 12, 10)),
  egg("MAGBY", 512, ["EMBER", "DIZZY_PUNCH"], [25, 10], DVS, stats(19, 12, 9, 14, 13, 11)),
  egg("ELEKID", 3072, ["QUICK_ATTACK", "LEER", "DIZZY_PUNCH"], [30, 30, 10], DV0, stats(19, 11, 8, 14, 11, 10)),
  egg("ELEKID", 512, ["QUICK_ATTACK", "LEER", "DIZZY_PUNCH"], [30, 30, 10], DVS, stats(19, 11, 9, 15, 12, 11)),
  egg("TYROGUE", 2560, ["TACKLE", "DIZZY_PUNCH"], [35, 10], DV0, stats(18, 8, 8, 8, 8, 8)),
  egg("TYROGUE", 256, ["TACKLE", "DIZZY_PUNCH"], [35, 10], DVS, stats(18, 8, 9, 9, 9, 9)),
];

// engine/events/odd_egg.asm:93 `.Odd` is the OT NAME; wOddEggName ("EGG") the nickname
const ODD_EGG_OT = "ODD";
const ODD_EGG_NICKNAME = "EGG";
const EGG_TICKET = "EGG_TICKET";

// Lua: crystal_story.lua:177 -- odd_egg.asm:5-38, one Random word against the
// cumulative table; the $ffff break is :17. 1-based like the Lua.
export function oddEggIndex(roll: number): number {
  for (let i = 0; i < ODD_EGG_PROBABILITIES.length; i++) {
    const probability = ODD_EGG_PROBABILITIES[i]!;
    if (probability >= 0xffff) return i + 1;
    if (roll <= probability) return i + 1;
  }
  return ODD_EGG_PROBABILITIES.length;
}

// Lua: crystal_story.lua:188 -- odd_egg.asm:40-48, NICKNAMED_MON_STRUCT_LENGTH
// bytes copied verbatim
function buildOddEgg(data: Rec, row: OddEggRow | undefined, save: Rec): Rec {
  if (!(data && row)) return undefined;
  const moves = row.moves.map((id, i) => {
    const pp = row.pp[i] ?? 0;
    return { id, pp, maxPp: pp };
  });
  const made: Rec = Mon.new(data, row.species, row.level, {
    dvs: { ...row.dvs },
    moves,
    // odd_eggs.asm:57 `bigdw 0 ; HP`
    hp: 0,
    nickname: ODD_EGG_NICKNAME,
  });
  if (!made) return undefined;
  made.experience = row.experience;
  made.stats = { ...row.stats };
  made.maxHp = row.stats.hp;
  made.hp = 0;
  // mobile_46.asm:7528 writes EGG into wPartySpecies while the struct keeps
  // the hatchling's own species
  made.isEgg = true;
  // odd_eggs.asm:53 `db 20 ; Step cycles to hatch`
  made.eggSteps = row.eggSteps;
  made.ot = ODD_EGG_OT;
  made.otName = ODD_EGG_OT;
  made.otId = row.otId;
  if (save) Mon.stampOT(save, made);
  return made;
}

// Lua: crystal_story.lua:235 -- odd_egg.asm:1. The party-full refusal is the
// caller's (maps/DayCare.asm:31-32), not the routine's.
function GiveOddEgg(vm: Vm): void {
  const S = Specials.shared;
  const record = S.save(vm);
  const data = S.data(vm);
  if (!(record && data)) return;
  const party: Rec[] = record.party ?? [];
  record.party = party;
  if (party.length >= Mon.PARTY_SIZE) return;
  const row = ODD_EGGS[oddEggIndex(Specials.random(0x10000) - 1) - 1];
  const made = buildOddEgg(data, row, record);
  if (!made) return;
  // odd_egg.asm:50-57 TossItem on the EGG TICKET, ahead of the party write
  const h = S.hooks(vm);
  const ticket = h.itemIndex && h.itemIndex(EGG_TICKET);
  if (ticket && h.takeItem) h.takeItem(ticket, 1);
  party.push(made);
}

// Lua: crystal_story.lua:254 -- engine/events/unown_walls.asm:1
function HoOhChamber(vm: Vm): void {
  if (!UnownWords.leadIsHoOh(Specials.shared.party(vm))) return;
  UnownWords.openWall((vm as Rec).events, "HO_OH");
}

// Lua: crystal_story.lua:262 -- unown_walls.asm:13; :25 CheckItem then :38 MON_ITEM
function OmanyteChamber(vm: Vm): void {
  const S = Specials.shared;
  if (UnownWords.wallOpened((vm as Rec).events, "OMANYTE")) return;
  const h = S.hooks(vm);
  const index = h.itemIndex && h.itemIndex(UnownWords.WATER_STONE);
  const inPack = index && h.hasItem && h.hasItem(index);
  if (!inPack && UnownWords.waterStoneSlot(S.party(vm)) === undefined) return;
  UnownWords.openWall((vm as Rec).events, "OMANYTE");
}

// Lua: crystal_story.lua:273 -- engine/events/celebi.asm:9; :296
// CelebiEvent_SetBattleType is the only state it leaves
function CelebiShrineEvent(vm: Vm): void {
  const v = vm as Rec;
  if (v.writeVarFn) v.writeVarFn(VAR_BATTLETYPE, BATTLETYPE_CELEBI);
  v.celebiArmed = true;
}

// Lua: crystal_story.lua:280 -- celebi.asm:301 reads the bit
// item_effects.asm:545 sets, gated on :542
function CheckCaughtCelebi(vm: Vm): void {
  const S = Specials.shared;
  const v = vm as Rec;
  const caught = v.celebiArmed === true && v.battleOutcome === "caught";
  v.celebiArmed = undefined;
  if (caught) {
    const record = S.save(vm);
    if (record) Save.crystalState(record).celebiCaught = true;
  }
  S.answer(vm, caught ? S.TRUE : S.FALSE);
}

export const crystal_story: Record<string, (vm: Vm) => any> = {
  BeastsCheck,
  GiveDratini,
  GiveOddEgg,
  HoOhChamber,
  OmanyteChamber,
  CelebiShrineEvent,
  CheckCaughtCelebi,
};
export default crystal_story;
