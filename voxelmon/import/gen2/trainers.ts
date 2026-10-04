// Port of gen1recomp RomExtractorGen2.lua:5198-5352 extractTrainers
// (bdfac727) -> the "trainers" JSON: every trainer class's display name,
// attributes, encounter jingle and parties.
//
// Crystal's Battle Tower roster: readBattleTowerRoster (:5125) with its
// helpers btSampleCeiling (:5056) and readBattleTowerMon (:5071). It returns
// undefined unless BattleTowerTrainers and BattleTowerMons are both symbols
// ("Gold and Silver have neither symbol and get nil", :5123).
//
// Names (class names and trainer names) decode through the manifest charmap
// with Rom.readString, as Brian's do.

import type { Gen2Ctx } from "./ctx.ts";
import { romAddrOk } from "./encounters.ts";
import { lua, speciesName } from "./helpers.ts";

/** :125-129 — pokecrystal constants/pokemon_data_constants.asm:113-115,
 * data/battle_tower/parties.asm:2, constants/battle_tower_constants.asm:4. */
const PARTYMON_STRUCT_LENGTH = 48;
const MON_NAME_LENGTH = 11;
const NAME_LENGTH = 11;
const NICKNAMED_MON_STRUCT_LENGTH = PARTYMON_STRUCT_LENGTH + MON_NAME_LENGTH;
const BT_LEVEL_GROUPS = 10;
const BT_PARTY_LENGTH = 3;

/**
 * :5056 btSampleCeiling — pokecrystal engine/events/battle_tower/
 * load_trainer.asm:29-38 and :117-119: both rejection loops are `maskbits N
 * / cp N / jr nc, .resample` (E6 mask / FE count / 30 rel), so the ceiling
 * the cart samples against is read, not written down. Crystal 1.0 and 1.1
 * differ in exactly this byte.
 */
function btSampleCeiling(ctx: Gen2Ctx, label: string): number {
  const symbol = ctx.symbol(label);
  const raw = ctx.rom.bytes(symbol.bank, symbol.address, 24);
  for (let i = 0; i < raw.length - 4; i++) {
    if (raw[i] === 0xe6 && raw[i + 2] === 0xfe && raw[i + 4] === 0x30) return raw[i + 3]!;
  }
  throw new Error(`battle tower sample ceiling not found at ${label}`);
}

/** :5071 readBattleTowerMon — one big-endian `party_struct`
 * (pokecrystal macros/ram.asm, constants/pokemon_data_constants.asm:75-113). */
function readBattleTowerMon(
  ctx: Gen2Ctx, bank: number, address: number, moveOrder: string[], itemOrder: string[],
): Record<string, unknown> {
  const raw = ctx.rom.bytes(bank, address, PARTYMON_STRUCT_LENGTH);
  const at = (i: number): number => raw[i - 1]!; // Lua's 1-based raw[i]
  const word = (i: number): number => at(i) * 0x100 + at(i + 1);
  const moves: (string | number)[] = [];
  const pp: number[] = [];
  for (let slot = 0; slot < 4; slot++) {
    const moveId = at(3 + slot);
    if (moveId !== 0) {
      moves.push(lua(moveOrder, moveId) ?? moveId);
      // MON_PP's top two bits are the PP Ups (PP_UP_MASK)
      pp.push(at(24 + slot) % 64);
    }
  }
  let item: string | undefined = lua(itemOrder, at(2));
  if (item === "NO_ITEM") item = undefined;
  return {
    species: speciesName(ctx, at(1)),
    item,
    moves,
    pp,
    otId: word(7),
    experience: at(9) * 0x10000 + at(10) * 0x100 + at(11),
    statExp: { hp: word(12), attack: word(14), defense: word(16), speed: word(18), special: word(20) },
    dvs: {
      attack: Math.floor(at(22) / 16), defense: at(22) % 16,
      speed: Math.floor(at(23) / 16), special: at(23) % 16,
    },
    happiness: at(28),
    level: at(32),
    hp: word(35),
    maxHp: word(37),
    stats: {
      hp: word(37), attack: word(39), defense: word(41),
      speed: word(43), specialAttack: word(45), specialDefense: word(47),
    },
  };
}

/**
 * :5125 readBattleTowerRoster — 70 fixed-width name+class rows
 * (pokecrystal data/battle_tower/classes.asm `bt_trainer`) and ten level
 * groups of fully built party_structs out of BattleTowerMons.
 */
function readBattleTowerRoster(ctx: Gen2Ctx, charmap: Record<string, string>): Record<string, unknown> | undefined {
  if (!(ctx.location("BattleTowerTrainers") && ctx.location("BattleTowerMons"))) return undefined;
  const consts = ctx.manifest.constants as Record<string, any>;
  const classOrder: string[] = consts.trainerClassOrder ?? [];
  const spriteOrder: string[] = consts.spriteOrder ?? [];
  const moveOrder: string[] = consts.moveOrder ?? [];
  const itemOrder: string[] = consts.itemOrder ?? [];
  const trainerSym = ctx.symbol("BattleTowerTrainers");
  const monSym = ctx.symbol("BattleTowerMons");
  // BattleTowerMons is the label straight after BattleTowerTrainers, so the
  // gap IS the row count (load_trainer.asm:210-212)
  const uniqueTrainers = Math.floor((monSym.address - trainerSym.address) / NAME_LENGTH);
  const uniqueMon = btSampleCeiling(ctx, "LoadRandomBattleTowerMon.resample");
  const trainers: Record<string, unknown>[] = [];
  for (let index = 0; index < uniqueTrainers; index++) {
    const address = trainerSym.address + index * NAME_LENGTH;
    const raw = ctx.rom.bytes(trainerSym.bank, address, NAME_LENGTH - 1);
    const classId = ctx.rom.byte(trainerSym.bank, address + NAME_LENGTH - 1);
    trainers.push({ index, name: ctx.rom.decodeText(raw, charmap, 0x50), class: classId, classId: classOrder[classId] });
  }
  const groups: Record<string, unknown>[][] = [];
  for (let group = 1; group <= BT_LEVEL_GROUPS; group++) {
    const rows: Record<string, unknown>[] = [];
    for (let slot = 0; slot < uniqueMon; slot++) {
      const address = monSym.address + ((group - 1) * uniqueMon + slot) * NICKNAMED_MON_STRUCT_LENGTH;
      rows.push(readBattleTowerMon(ctx, monSym.bank, address, moveOrder, itemOrder));
    }
    groups.push(rows);
  }
  // pokecrystal data/trainers/sprites.asm:1-3, one SPRITE_* per class from
  // class 1, one row short of the class list (excludes MYSTICALMAN)
  const sprites: Record<string, unknown> = {};
  const spriteSym = ctx.location("BTTrainerClassSprites");
  if (spriteSym) {
    for (let classId = 1; classId <= classOrder.length - 2; classId++) {
      const byte = ctx.rom.byte(spriteSym[0], spriteSym[1] + classId - 1);
      sprites[classOrder[classId]!] = lua(spriteOrder, byte) ?? byte;
    }
  }
  return {
    source: "ROM:BattleTowerTrainers + BattleTowerMons + BTTrainerClassSprites",
    partyLength: BT_PARTY_LENGTH,
    levelGroups: BT_LEVEL_GROUPS,
    uniqueMon,
    uniqueTrainers,
    // the trainer draw's own ceiling, which on Crystal 1.0 is uniqueMon
    sampleTrainers: btSampleCeiling(ctx, "LoadOpponentTrainerAndPokemon.resample"),
    trainers,
    groups,
    classSprites: sprites,
  };
}

/** TrainerClassAttributes stride: NUM_TRAINER_ATTRIBUTES is 7 (:5319). */
export const TRAINER_ATTRIBUTES_LENGTH = 7;

export interface TrainerMon {
  level: number;
  species: string | number;
  /** TRAINERTYPE_ITEM(_MOVES) only; omitted for NO_ITEM (Lua itemOrder[0] = nil). */
  item?: string;
  /** TRAINERTYPE_MOVES / _ITEM_MOVES only; empty move slots dropped. */
  moves?: string[];
}

export interface TrainerParty {
  /** trainerClassMembers[className][n] or `${className}${n}`. */
  id: string;
  /** 1-based position in the group (the trainer constant's value). */
  index: number;
  name: string;
  trainerType: string | number;
  party: TrainerMon[];
}

export interface TrainerClass {
  id: string;
  /** The trainer class constant (FALKNER = 1). */
  index: number;
  name: string;
  encounterMusic?: string;
  baseMoney: number;
  /** The 7 raw TrainerClassAttributes bytes (Lua [1..7]). */
  attributes: number[];
  items: string[];
  trainers: TrainerParty[];
}

/**
 * One party at `address` in the Trainers bank: name@, TRAINERTYPE byte, then
 * (level, species[, item][, 4 moves]) rows until -1 (at most six). Returns
 * the party and the address after its -1. :5256-5299.
 */
export function readTrainerParty(
  ctx: Gen2Ctx,
  bank: number,
  address: number,
): { name: string; trainerType: number; party: TrainerMon[]; next: number } {
  const consts = ctx.manifest.constants;
  const itemOrder = consts.itemOrder as string[] | undefined;
  const moveOrder = consts.moveOrder as string[] | undefined;
  const rom = ctx.rom;
  const [name, consumed] = rom.readString(bank, address, ctx.manifest.charmap ?? {}, 0x50, 16);
  let at = address + consumed;
  const trainerType = rom.byte(bank, at);
  at += 1;
  const hasMoves = trainerType === 1 || trainerType === 3;
  const hasItem = trainerType === 2 || trainerType === 3;
  const party: TrainerMon[] = [];
  while (party.length < 6) {
    const level = rom.byte(bank, at);
    if (level === 0xff) break;
    const species = rom.byte(bank, at + 1);
    at += 2;
    const mon: TrainerMon = { level, species: speciesName(ctx, species) };
    if (hasItem) {
      const item = lua(itemOrder, rom.byte(bank, at));
      if (item !== undefined) mon.item = item;
      at += 1;
    }
    if (hasMoves) {
      const moves: string[] = [];
      for (let i = 0; i < 4; i++) {
        const moveId = rom.byte(bank, at + i);
        const move = moveId !== 0 ? lua(moveOrder, moveId) : undefined;
        if (move !== undefined) moves.push(move);
      }
      at += 4;
      mon.moves = moves;
    }
    party.push(mon);
  }
  // :5299 — skip the -1 that ends this party (even after a sixth mon).
  return { name, trainerType, party, next: at + 1 };
}

/**
 * :5201 extractTrainers -> `{ trainers }`: { generation, source, classes }
 * with classes keyed by trainer class name (FALKNER..), each a TrainerClass
 * whose `trainers` is an array (Lua [1..n]).
 */
export function extractTrainers(ctx: Gen2Ctx): Record<string, unknown> {
  const consts = ctx.manifest.constants;
  const classOrder = consts.trainerClassOrder ?? [];
  const members = (consts.trainerClassMembers as Record<string, string[]> | undefined) ?? {};
  const itemOrder = consts.itemOrder as string[] | undefined;
  const typeOrder = consts.trainerTypeOrder as string[] | undefined;
  const musicOrder = consts.musicOrder as string[] | undefined;
  const charmap = ctx.manifest.charmap ?? {};
  const rom = ctx.rom;

  const groups = ctx.symbol("TrainerGroups");
  const trainers = ctx.symbol("Trainers");
  const classNames = ctx.symbol("TrainerClassNames");
  const attributes = ctx.symbol("TrainerClassAttributes");
  const encounterMusic = ctx.symbol("TrainerEncounterMusic");

  const classes: Record<string, TrainerClass> = {};

  // :5232 — TrainerClassNames: @-terminated, class 1 first.
  let nameAddress = classNames.address;
  const classDisplay: Record<string, string> = {};
  for (let i = 1; i < classOrder.length; i++) {
    const [value, consumed] = rom.readString(classNames.bank, nameAddress, charmap, 0x50, 24);
    nameAddress += consumed;
    classDisplay[classOrder[i]!] = value;
  }

  for (let i = 1; i < classOrder.length; i++) {
    const className = classOrder[i]!;
    const classId = i;
    const pointer = rom.word(groups.bank, groups.address + (classId - 1) * 2);
    let address = pointer;
    const parties: TrainerParty[] = [];
    const memberNames = members[className] ?? [];
    // :5253 — groups have no end marker: the member count bounds the walk,
    // the next group's pointer is the belt-and-braces bound.
    const expected = memberNames.length;
    let nextPointer = 0x8000;
    if (i < classOrder.length - 1) {
      const following = rom.word(groups.bank, groups.address + classId * 2);
      if (following > pointer) nextPointer = following;
    }
    while ((expected > 0 && parties.length < expected) || (expected === 0 && parties.length < 1)) {
      if (address >= nextPointer || !romAddrOk(trainers.bank, address)) break;
      if (rom.byte(trainers.bank, address) === 0xff) break;
      const read = readTrainerParty(ctx, trainers.bank, address);
      address = read.next;
      const n = parties.length + 1;
      parties.push({
        id: memberNames[n - 1] ?? `${className}${n}`,
        index: n,
        name: read.name,
        trainerType: lua(typeOrder, read.trainerType + 1) ?? read.trainerType,
        party: read.party,
      });
    }
    // :5319 — seven attribute bytes: item1, item2, base money, AI move
    // weights (word), AI item/switch (word).
    const attrRow = rom.bytes(
      attributes.bank,
      attributes.address + (classId - 1) * TRAINER_ATTRIBUTES_LENGTH,
      TRAINER_ATTRIBUTES_LENGTH,
    );
    const carried: string[] = [];
    for (let slot = 0; slot < 2; slot++) {
      const item = lua(itemOrder, attrRow[slot]!);
      if (item && item !== "NO_ITEM") carried.push(item);
    }
    const musicId = rom.byte(encounterMusic.bank, encounterMusic.address + classId);
    const entry: TrainerClass = {
      id: className,
      index: classId,
      name: classDisplay[className] ?? className,
      baseMoney: attrRow[2]!,
      attributes: attrRow,
      items: carried,
      trainers: parties,
    };
    const music = lua(musicOrder, musicId + 1);
    if (music !== undefined) entry.encounterMusic = music;
    classes[className] = entry;
  }

  return {
    trainers: {
      generation: 2,
      source: "ROM:TrainerGroups + Trainers + TrainerClassNames + TrainerEncounterMusic",
      classes,
      // :5340 — Crystal's roster; undefined (omitted) on Gold and Silver
      battleTower: readBattleTowerRoster(ctx, (ctx.manifest.charmap ?? {}) as Record<string, string>),
    },
  };
}
