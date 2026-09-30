// Port of gen1recomp RomExtractorGen2.lua:5198-5352 extractTrainers
// (bdfac727) -> the "trainers" JSON: every trainer class's display name,
// attributes, encounter jingle and parties.
//
// Gold only: the Battle Tower is Crystal-only. readBattleTowerRoster (:5125)
// returns nil unless BattleTowerTrainers and BattleTowerMons are both
// symbols ("Gold and Silver have neither symbol and get nil", :5123), so it
// -- and its helpers btSampleCeiling (:5056) and readBattleTowerMon (:5071)
// -- are not ported and `battleTower` is omitted.
//
// Names (class names and trainer names) decode through the manifest charmap
// with Rom.readString, as Brian's do.

import type { Gen2Ctx } from "./ctx.ts";
import { romAddrOk } from "./encounters.ts";
import { lua, speciesName } from "./helpers.ts";

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

  // :5349 out.battleTower = readBattleTowerRoster(...) -- nil on Gold, omitted.
  return {
    trainers: {
      generation: 2,
      source: "ROM:TrainerGroups + Trainers + TrainerClassNames + TrainerEncounterMusic",
      classes,
    },
  };
}
