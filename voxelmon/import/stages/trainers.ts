// Port of gen1recomp RomExtractor.lua trainerParties + extractTrainers
// (lines 1234-1348). Trainer battle pics are not in the Pocket Voxel gfx
// set; the JSON keeps the manifest pic path so a later rung can decode them.

import { check, hex2, hex4 } from "../ctx.ts";
import { writeCompressedPic } from "./pokemon.ts";
import type { Ctx } from "../ctx.ts";
import { Rom } from "../rom.ts";

/**
 * gen1recomp RomExtractor.lua:1234 — parties fill the [start, nextStart)
 * slice exactly; first byte 0xFF means per-mon (level, species) pairs,
 * anything else is a fixed level over a 0-terminated species list.
 */
function trainerParties(
  ctx: Ctx,
  bank: number,
  startAddress: number,
  endAddress: number,
): unknown[][] {
  const { rom } = ctx;
  const parties: unknown[][] = [];
  let address = startAddress;
  while (address < endAddress) {
    const first = rom.byte(bank, address);
    address += 1;
    const party: unknown[] = [];
    if (first === 0xff) {
      while (true) {
        const level = rom.byte(bank, address);
        address += 1;
        if (level === 0) break;
        const species = rom.byte(bank, address);
        address += 1;
        party.push({ level, species: ctx.species(species) });
      }
    } else {
      while (true) {
        const species = rom.byte(bank, address);
        address += 1;
        if (species === 0) break;
        party.push({ level: first, species: ctx.species(species) });
      }
    }
    parties.push(party);
  }
  check(address === endAddress, `trainer party data overran ${hex2(bank)}:${hex4(endAddress)}`);
  return parties;
}

/** One party's extra moves: [mon (1-based), slot (1-4), move id]. */
export type SpecialMoveRow = [number, number, string];

/**
 * Yellow's SpecialTrainerMoves (data/trainers/special_moves.asm, read by
 * engine/battle/read_trainer_party.asm after the party loads): records of
 * trainer class, party number, then (mon, slot, move) triples ending 0, the
 * table ending $FF. Red and Blue have no such table -- they use LoneMoves /
 * TeamMoves, kept in game/battle/trainer.ts -- so nothing is found there.
 *
 * The manifest has no symbol for it, so it is found by shape in the trainer
 * data's own bank: the longest run of well-formed records that ends in $FF,
 * ten records at least. In US Yellow it is 17 records at $0E:5C6B.
 */
export function findSpecialTrainerMoves(
  ctx: Ctx, bank: number, classCount: number,
): Map<number, Map<number, SpecialMoveRow[]>> | null {
  const { rom } = ctx;
  const parse = (start: number): [number, number, SpecialMoveRow[]][] | null => {
    const recs: [number, number, SpecialMoveRow[]][] = [];
    let a = start;
    while (a < 0x7ffd) {
      const c = rom.byte(bank, a);
      if (c === 0xff) return recs;
      const p = rom.byte(bank, a + 1);
      if (c < 1 || c > classCount || p < 1 || p > 40) return null;
      a += 2;
      const rows: SpecialMoveRow[] = [];
      while (a < 0x7ffd) {
        const m = rom.byte(bank, a);
        if (m === 0) { a += 1; break; }
        const s = rom.byte(bank, a + 1);
        const mv = rom.byte(bank, a + 2);
        const id = ctx.move(mv);
        if (m > 6 || s < 1 || s > 4 || !id || id.startsWith("MOVE_")) return null;
        rows.push([m, s, id]);
        a += 3;
      }
      if (rows.length === 0) return null;
      recs.push([c, p, rows]);
    }
    return null;
  };
  let best: [number, number, SpecialMoveRow[]][] | null = null;
  for (let a = 0x4000; a < 0x7ff0; a++) {
    const recs = parse(a);
    if (recs && recs.length >= 10 && (!best || recs.length > best.length)) best = recs;
  }
  if (!best) return null;
  const out = new Map<number, Map<number, SpecialMoveRow[]>>();
  for (const [c, p, rows] of best) {
    if (!out.has(c)) out.set(c, new Map());
    out.get(c)!.set(p, rows);
  }
  return out;
}

export function extractTrainers(ctx: Ctx): Record<string, unknown> {
  // The player's intro portrait lives outside TrainerPicAndMoneyPointers
  // (pokered RedPicFront); pull it so the Oak speech can show the player.
  for (const [label, key] of [["RedPicFront", "battle/trainer/red"]] as const) {
    try {
      writeCompressedPic(ctx, label, key);
    } catch (e) {
      console.warn(`${label} skipped:`, String(e).slice(0, 80));
    }
  }

  const { rom, manifest } = ctx;
  const order = manifest.trainers;
  const names = ctx.symbol("TrainerNames");
  const pointers = ctx.symbol("TrainerDataPointers");
  const money = ctx.symbol("TrainerPicAndMoneyPointers");
  const choices = ctx.symbol("TrainerClassMoveChoiceModifications");

  const decodedNames: string[] = [];
  {
    let address = names.address;
    for (let i = 0; i < order.length; i++) {
      const [name, consumed] = rom.readString(names.bank, address, manifest.charmap, 0x50, 32);
      decodedNames.push(name);
      address += consumed;
    }
  }

  const aiMods: number[][] = [];
  {
    let address = choices.address;
    for (let i = 0; i < order.length; i++) {
      const mods: number[] = [];
      while (true) {
        const value = rom.byte(choices.bank, address);
        address += 1;
        if (value === 0) break;
        mods.push(value);
      }
      aiMods.push(mods);
    }
  }
  const partyStarts: number[] = [];
  for (let index = 0; index < order.length; index++) {
    partyStarts.push(rom.word(pointers.bank, pointers.address + index * 2));
  }
  // gen1recomp RomExtractor.lua:1300 — the last class's slice is bounded by
  // the TrainerAI symbol.
  const partyEnds = [...partyStarts.slice(1), ctx.symbol("TrainerAI").address];

  const special = findSpecialTrainerMoves(ctx, pointers.bank, order.length);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < order.length; i++) {
    const label = order[i];
    const index = i + 1;
    const trainerId = `OPP_${label}`;
    // gen1recomp RomExtractor.lua:1307 — 5-byte rows: 2-byte pic pointer,
    // then 3 BCD money bytes; baseMoney = floor(bcd/100).
    const rawMoney = rom.bytes(money.bank, money.address + i * 5 + 2, 3);
    const picture = manifest.trainerPics[i];
    // Trainer pics ARE in the ROM behind TrainerPicAndMoneyPointers; the
    // manifest already names each one. Extract them like pokemon.ts does so
    // the cook can build pics pages for portraits (Oak's intro, battles).
    if (picture?.label) {
      const key = `battle/trainer/${picture.imageBase ?? label.toLowerCase()}`;
      try {
        writeCompressedPic(ctx, picture.label, key);
      } catch (e) {
        console.warn(`trainer pic ${picture.label} skipped:`, String(e).slice(0, 80));
      }
    }
    let parties = trainerParties(ctx, pointers.bank, partyStarts[i], partyEnds[i]);
    // gen1recomp RomExtractor.lua:1317 — ChiefData is empty in the ROM (cut
    // content); the manifest carries a hand-authored party for it.
    if (parties.length === 0) {
      const override = manifest.trainerPartyOverrides?.[trainerId];
      if (override) parties = [structuredClone(override)];
    }
    out[trainerId] = {
      id: trainerId,
      index,
      name: decodedNames[i],
      source: "ROM:TrainerDataPointers",
      pic: picture ? picture.path : undefined,
      baseMoney: Math.floor(Rom.bcd(rawMoney) / 100),
      aiMods: aiMods[i],
      parties,
      // party number (1-based, as a string key) -> its extra moves
      specialMoves: special?.has(index)
        ? Object.fromEntries([...special.get(index)!].map(([p, rows]) => [String(p), rows]))
        : undefined,
    };
  }
  return out;
}
