// The Gen 2 (Gold) importer's encounters / trainers / pokedex / landmarks
// stages (voxelmon/import/gen2/{encounters,trainers,pokedex}.ts): the table
// readers on synthetic ROM buffers laid out per pret/pokegold's formats,
// then -- only when a verified Gold ROM is on this machine -- the stages
// against it, pinned to pokegold's data/wild, data/trainers and
// data/pokemon/dex_entries. No ROM bytes are ever committed.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GOLD_SHA1 } from "../voxelmon/import/env.ts";
import { GfxBin } from "../voxelmon/import/gfx.ts";
import { Rom } from "../voxelmon/import/rom.ts";
import { Gen2Ctx } from "../voxelmon/import/gen2/ctx.ts";
import {
  GRASS_RECORD,
  WATER_RECORD,
  extractEncounters,
  readContestMons,
  readGrassTable,
  readRoamMaps,
  readRoamMons,
  readTreeMonMaps,
  readTreeMons,
  readWaterTable,
  romAddrOk,
} from "../voxelmon/import/gen2/encounters.ts";
import type { Gen2Manifest } from "../voxelmon/import/gen2/manifest.ts";
import { extractLandmarks, extractPokedex, readDexEntry } from "../voxelmon/import/gen2/pokedex.ts";
import { extractTrainers, readTrainerParty } from "../voxelmon/import/gen2/trainers.ts";

// ---------------------------------------------------------------- helpers

const BANK = 0x4000;

class FakeRom {
  readonly data = new Uint8Array(0x40 * BANK);
  put(bank: number, address: number, bytes: number[]): void {
    this.data.set(bytes, Rom.offset(bank, address));
  }
  word(bank: number, address: number, value: number): void {
    this.put(bank, address, [value & 0xff, value >> 8]);
  }
}

// A tiny charmap: "A".."Z" at $80.., space $7f, <BSP> $1f, <NEXT> $4e.
const CHARMAP: Record<string, string> = { "127": " ", "31": "<BSP>", "78": "<NEXT>" };
for (let i = 0; i < 26; i++) CHARMAP[String(0x80 + i)] = String.fromCharCode(65 + i);
const text = (s: string): number[] =>
  [...s].map((ch) => (ch === " " ? 0x7f : ch === "|" ? 0x1f : ch === "~" ? 0x4e : 0x80 + ch.charCodeAt(0) - 65));

const SPECIES = ["BULBASAUR", "IVYSAUR", "VENUSAUR", "CHARMANDER", "CHARMELEON", "CHARIZARD"];

function manifest(symbols: Gen2Manifest["symbols"], consts: Record<string, unknown> = {}, over: Partial<Gen2Manifest> = {}): Gen2Manifest {
  return {
    format: 3,
    generation: 2,
    romSha1: GOLD_SHA1,
    symbols,
    charmap: CHARMAP,
    fontCharmap: [],
    maps: {},
    tilesets: {},
    pokemonAssets: {},
    text: {},
    ...over,
    constants: {
      source: "test",
      mapOrder: [],
      mapGroups: [
        { group: 1, map: 1, name: "ROUTE_A", width: 10, height: 9 },
        { group: 1, map: 2, name: "ROUTE_B", width: 10, height: 9 },
        { group: 2, map: 1, name: "TOWN_C", width: 10, height: 9 },
      ],
      tilesetOrder: [],
      environmentOrder: [],
      paletteOrder: [],
      fishGroupOrder: ["FISHGROUP_NONE", "FISHGROUP_SHORE"],
      mapCallbackOrder: [],
      spriteOrder: [],
      speciesOrder: SPECIES,
      trainerClassOrder: [],
      ...consts,
    },
  };
}

const ctxOf = (rom: FakeRom, m: Gen2Manifest) => new Gen2Ctx(new Rom(rom.data), m, new GfxBin());

// ---------------------------------------------------------------- wild tables

describe("gen2 wild tables (data/wild/*.asm)", () => {
  test("romAddrOk: bank 0 below $4000, banked $4000-$7fff", () => {
    expect(romAddrOk(0, 0x3fff)).toBe(true);
    expect(romAddrOk(0, 0x4000)).toBe(false);
    expect(romAddrOk(5, 0x4000)).toBe(true);
    expect(romAddrOk(5, 0x8000)).toBe(false);
    expect(romAddrOk(0x80, 0x4000)).toBe(false);
  });

  test("grass: rates + morn/day/nite 7-slot lists, unknown maps skipped, -1 ends", () => {
    const rom = new FakeRom();
    const at = 0x4100;
    const record = (group: number, map: number, base: number): number[] => {
      const out = [group, map, 10, 20, 30];
      for (let day = 0; day < 3; day++) for (let s = 0; s < 7; s++) out.push(base + day * 10 + s, (s % 6) + 1);
      return out;
    };
    rom.put(3, at, record(1, 1, 2));
    rom.put(3, at + GRASS_RECORD, record(9, 9, 5)); // unknown map
    rom.put(3, at + GRASS_RECORD * 2, record(2, 1, 40));
    rom.put(3, at + GRASS_RECORD * 3, [0xff]);
    const grass = readGrassTable(ctxOf(rom, manifest({ G: [3, at] })), "G");
    expect(Object.keys(grass)).toEqual(["ROUTE_A", "TOWN_C"]);
    const a = grass.ROUTE_A!;
    expect(a.rates).toEqual({ MORN: 10, DAY: 20, NITE: 30 });
    expect(a.slots.MORN![0]).toEqual({ level: 2, species: "BULBASAUR" });
    expect(a.slots.DAY![6]).toEqual({ level: 18, species: "BULBASAUR" });
    expect(a.slots.NITE![5]).toEqual({ level: 27, species: "CHARIZARD" });
    expect(a.slots.NITE!.length).toBe(7);
    expect(grass.TOWN_C!.slots.MORN![0]!.level).toBe(40);
  });

  test("water: one rate and three slots; a species miss keeps the number", () => {
    const rom = new FakeRom();
    rom.put(3, 0x4200, [1, 2, 5, 15, 1, 20, 2, 25, 99]);
    rom.put(3, 0x4200 + WATER_RECORD, [0xff]);
    const water = readWaterTable(ctxOf(rom, manifest({ W: [3, 0x4200] })), "W");
    expect(water).toEqual({
      ROUTE_B: {
        map: "ROUTE_B",
        rate: 5,
        slots: [
          { level: 15, species: "BULBASAUR" },
          { level: 20, species: "IVYSAUR" },
          { level: 25, species: 99 },
        ],
      },
    });
  });

  test("treemon maps: map -> TREEMON_SET_* name, raw byte when unnamed", () => {
    const rom = new FakeRom();
    rom.put(3, 0x4300, [1, 1, 1, 2, 1, 7, 0xff]);
    const sets = { treeMonSetOrder: ["TREEMON_SET_NONE", "TREEMON_SET_FOREST"] };
    expect(readTreeMonMaps(ctxOf(rom, manifest({ T: [3, 0x4300] }, sets)), "T")).toEqual({
      ROUTE_A: "TREEMON_SET_FOREST",
      TOWN_C: 7,
    });
  });

  test("roam maps: rows in ROM order, count + destinations + 0, -1 ends", () => {
    const rom = new FakeRom();
    rom.put(3, 0x4400, [1, 1, 2, 1, 2, 2, 1, 0, 1, 2, 1, 9, 9, 0, 0xff]);
    expect(readRoamMaps(ctxOf(rom, manifest({ RoamMaps: [3, 0x4400] })))).toEqual([
      { map: "ROUTE_A", to: ["ROUTE_B", "TOWN_C"] },
      { map: "ROUTE_B", to: [] },
    ]);
  });

  test("roam mons: the roster read out of InitRoamMons' ld/xor writes", () => {
    const rom = new FakeRom();
    const base = 0xdfcf;
    const w = (addr: number) => [0xea, addr & 0xff, addr >> 8];
    rom.put(3, 0x4500, [
      0x3e, 4, ...w(base), 0x3e, 40, ...w(base + 1), 0x3e, 1, ...w(base + 2), 0x3e, 2, ...w(base + 3),
      0xaf, ...w(base + 4),
      0x3e, 5, ...w(base + 7), 0x3e, 40, ...w(base + 8),
      0xc9,
    ]);
    expect(readRoamMons(ctxOf(rom, manifest({ InitRoamMons: [3, 0x4500] })))).toEqual([
      { species: "CHARMANDER", level: 40, mapGroup: 1, mapNumber: 2, map: "ROUTE_B" },
      { species: "CHARMELEON", level: 40 },
    ]);
    rom.put(3, 0x4600, [0x00, 0xc9]); // an unknown opcode -> nil
    expect(readRoamMons(ctxOf(rom, manifest({ InitRoamMons: [3, 0x4600] })))).toBeUndefined();
  });

  test("contest mons: rows until the chance-$ff row, which is kept", () => {
    const rom = new FakeRom();
    rom.put(3, 0x4700, [60, 1, 7, 18, 40, 2, 9, 14, 0xff, 3, 30, 40, 50, 4, 1, 1]);
    expect(readContestMons(ctxOf(rom, manifest({ ContestMons: [3, 0x4700] })))).toEqual([
      { chance: 60, species: "BULBASAUR", min: 7, max: 18 },
      { chance: 40, species: "IVYSAUR", min: 9, max: 14 },
      { chance: 0xff, species: "VENUSAUR", min: 30, max: 40 },
    ]);
  });

  test("tree mons: common + rare per set, ROCK has one list, a species miss is omitted", () => {
    const rom = new FakeRom();
    rom.word(3, 0x4800, 0x4810);
    rom.word(3, 0x4802, 0x4820);
    rom.put(3, 0x4810, [50, 1, 10, 50, 200, 11, 0xff, 100, 2, 12, 0xff]);
    rom.put(3, 0x4820, [90, 4, 13, 10, 5, 14, 0xff, 1, 1, 1]);
    const consts = { treeMonSetOrder: ["TREEMON_SET_FOREST", "TREEMON_SET_ROCK"] };
    expect(readTreeMons(ctxOf(rom, manifest({ TreeMons: [3, 0x4800] }, consts)))).toEqual({
      TREEMON_SET_FOREST: {
        common: [
          { chance: 50, species: "BULBASAUR", level: 10 },
          { chance: 50, level: 11 },
        ],
        rare: [{ chance: 100, species: "IVYSAUR", level: 12 }],
      },
      TREEMON_SET_ROCK: {
        common: [
          { chance: 90, species: "CHARMANDER", level: 13 },
          { chance: 10, species: "CHARMELEON", level: 14 },
        ],
      },
    });
  });

  test("extractEncounters: fish rows by group id - 1, time groups, optional tables omitted", () => {
    const rom = new FakeRom();
    const g = 0x4100;
    rom.put(3, g, [0xff]);
    rom.put(3, g + 8, [0xff]);
    // FishGroups: one row (FISHGROUP_SHORE): chance, old/good/super pointers.
    rom.put(4, 0x4000, [128]);
    rom.word(4, 0x4001, 0x4100);
    rom.word(4, 0x4003, 0x4110);
    rom.word(4, 0x4005, 0x4100);
    rom.put(4, 0x4100, [179, 1, 10, 0xff, 2, 10]);
    rom.put(4, 0x4110, [100, 0, 0, 0xff, 0, 5]); // time group 0, then a missing group 5
    rom.put(4, 0x4200, [4, 20, 5, 21, 0, 0, 0, 0]); // TimeFishGroups: one row
    rom.put(5, 0x4000, [0xff]); // TreeMonMaps
    const m = manifest({
      JohtoGrassWildMons: [3, g], KantoGrassWildMons: [3, g],
      JohtoWaterWildMons: [3, g + 8], KantoWaterWildMons: [3, g + 8],
      FishGroups: [4, 0x4000], TimeFishGroups: [4, 0x4200], TreeMonMaps: [5, 0x4000],
    });
    const e = extractEncounters(ctxOf(rom, m)).encounters as any;
    expect(Object.keys(e)).toEqual([
      "generation", "source", "grass", "water", "fishGroups", "timeFishGroups", "trees", "treeSets",
    ]);
    expect(e.timeFishGroups).toEqual({
      "0": { day: { species: "CHARMANDER", level: 20 }, nite: { species: "CHARMELEON", level: 21 } },
    });
    const shore = e.fishGroups.FISHGROUP_SHORE;
    expect(shore.index).toBe(1);
    expect(shore.chance).toBe(128);
    expect(shore.old).toEqual([
      { chance: 179, species: "BULBASAUR", level: 10 },
      { chance: 0xff, species: "IVYSAUR", level: 10 },
    ]);
    expect(shore.good).toEqual([
      {
        chance: 100, timeGroup: 0, day: { species: "CHARMANDER", level: 20 },
        nite: { species: "CHARMELEON", level: 21 }, species: "CHARMANDER", level: 20,
      },
      { chance: 0xff, timeGroup: 5, species: 0, level: 5 },
    ]);
    expect(e.treeSets).toEqual({});
  });
});

// ---------------------------------------------------------------- trainers

describe("gen2 trainers (data/trainers/parties.asm)", () => {
  const consts = {
    trainerClassOrder: ["TRAINER_NONE", "LEADER_X", "YOUNGSTER"],
    trainerClassMembers: { LEADER_X: ["LEADER_X1"], YOUNGSTER: [] },
    trainerTypeOrder: ["TRAINERTYPE_NORMAL", "TRAINERTYPE_MOVES", "TRAINERTYPE_ITEM", "TRAINERTYPE_ITEM_MOVES"],
    itemOrder: ["MASTER_BALL", "POTION"],
    moveOrder: ["POUND", "TACKLE", "GUST"],
    musicOrder: ["Music_Nothing", "Music_LookYoungster"],
  };

  test("a party: name, type byte, item + moves rows, -1 skipped", () => {
    const rom = new FakeRom();
    rom.put(6, 0x4000, [...text("BO"), 0x50, 3, 5, 1, 2, 1, 2, 0, 0, 7, 2, 0, 3, 0, 0, 0, 0xff, 0x99]);
    const read = readTrainerParty(ctxOf(rom, manifest({}, consts)), 6, 0x4000);
    expect(read.name).toBe("BO");
    expect(read.trainerType).toBe(3);
    expect(read.party).toEqual([
      { level: 5, species: "BULBASAUR", item: "POTION", moves: ["POUND", "TACKLE"] },
      { level: 7, species: "IVYSAUR", moves: ["GUST"] },
    ]);
    expect(read.next).toBe(0x4000 + 3 + 1 + 7 + 7 + 1);
  });

  test("extractTrainers: class names, member ids, attributes, music, member-count bound", () => {
    const rom = new FakeRom();
    rom.put(7, 0x4000, [...text("LEADER"), 0x50, ...text("YOUNGSTER"), 0x50]); // TrainerClassNames
    rom.word(6, 0x4000, 0x4100); // TrainerGroups
    rom.word(6, 0x4002, 0x4110);
    rom.put(6, 0x4100, [...text("AL"), 0x50, 1, 7, 1, 1, 2, 0, 0, 0xff]); // LEADER_X1
    rom.put(6, 0x4110, [...text("JO"), 0x50, 0, 4, 4, 0xff, ...text("ED"), 0x50, 0, 5, 5, 0xff]);
    rom.put(6, 0x4200, [2, 0, 25, 1, 2, 3, 4, 0, 1, 4, 0, 0, 0, 0]); // attributes (7 a class)
    rom.put(6, 0x4300, [0, 1, 0]); // TrainerEncounterMusic from class 0
    const m = manifest(
      {
        TrainerClassNames: [7, 0x4000], TrainerGroups: [6, 0x4000], Trainers: [6, 0x4000],
        TrainerClassAttributes: [6, 0x4200], TrainerEncounterMusic: [6, 0x4300],
      },
      consts,
    );
    const t = extractTrainers(ctxOf(rom, m)).trainers as any;
    expect(Object.keys(t.classes)).toEqual(["LEADER_X", "YOUNGSTER"]);
    expect(t.classes.LEADER_X).toEqual({
      id: "LEADER_X", index: 1, name: "LEADER", baseMoney: 25,
      attributes: [2, 0, 25, 1, 2, 3, 4], items: ["POTION"],
      trainers: [{
        id: "LEADER_X1", index: 1, name: "AL", trainerType: "TRAINERTYPE_MOVES",
        party: [{ level: 7, species: "BULBASAUR", moves: ["POUND", "TACKLE"] }],
      }],
      encounterMusic: "Music_LookYoungster",
    });
    // No members listed: exactly one party is read, id falls back to class+n.
    const y = t.classes.YOUNGSTER;
    expect(y.name).toBe("YOUNGSTER");
    expect(y.items).toEqual(["MASTER_BALL"]);
    expect(y.trainers).toEqual([{
      id: "YOUNGSTER1", index: 1, name: "JO", trainerType: "TRAINERTYPE_NORMAL",
      party: [{ level: 4, species: "CHARMANDER" }],
    }]);
    expect(y.encounterMusic).toBe("Music_Nothing");
    expect(t.battleTower).toBeUndefined();
  });
});

// ---------------------------------------------------------------- pokedex + landmarks

describe("gen2 pokedex + landmarks", () => {
  test("a dex entry: kind@, height/weight words, two @-pages", () => {
    const rom = new FakeRom();
    rom.put(8, 0x4000, [...text("SEED"), 0x50, 204, 0, 150, 0, ...text("AB~C"), 0x50, ...text("D"), 0x50]);
    expect(readDexEntry(ctxOf(rom, manifest({})), 8, 0x4000, "BULBASAUR", 1)).toEqual({
      id: "BULBASAUR", dex: 1, kind: "SEED", height: 204, weight: 150, text: "AB<NEXT>C", text2: "D",
    });
  });

  test("extractPokedex: entries by dexLabel symbol, both sort orders", () => {
    const rom = new FakeRom();
    rom.put(8, 0x4000, [...text("SEED"), 0x50, 7, 0, 69, 0, 0x50, 0x50]);
    rom.put(9, 0x4000, [3, 1, 2, 9, 0, 0]);
    rom.put(9, 0x4010, [1, 2, 3, 4, 5, 6]);
    const m = manifest(
      { BulbaDex: [8, 0x4000], NewPokedexOrder: [9, 0x4000], AlphabeticalPokedexOrder: [9, 0x4010] },
      {},
      { pokemonAssets: { BULBASAUR: { dexLabel: "BulbaDex" }, IVYSAUR: { dexLabel: "Missing" } } },
    );
    const p = extractPokedex(ctxOf(rom, m)).pokedex as any;
    expect(Object.keys(p.entries)).toEqual(["BULBASAUR"]);
    expect(p.entries.BULBASAUR).toMatchObject({ dex: 1, kind: "SEED", height: 7, weight: 69, text: "", text2: "" });
    expect(p.newOrder).toEqual(["VENUSAUR", "BULBASAUR", "IVYSAUR", 9, 0, 0]);
    expect(p.alphabeticalOrder).toEqual(SPECIES);
  });

  test("extractLandmarks: OAM coords back to tilemap space, <BSP> as a newline, spawns", () => {
    const rom = new FakeRom();
    rom.put(10, 0x4000, [148, 116, 0x00, 0x41, 8, 16, 0x10, 0x41]);
    rom.put(10, 0x4100, [...text("NEW|TOWN"), 0x50]);
    rom.put(10, 0x4110, [...text("SPECIAL"), 0x50]);
    rom.put(11, 0x4000, [2, 1, 13, 6, 7, 7, 1, 1]);
    const m = manifest(
      { Landmarks: [10, 0x4000], SpawnPoints: [11, 0x4000] },
      { landmarkOrder: ["LANDMARK_A", "LANDMARK_B"], spawnOrder: ["SPAWN_C", "SPAWN_X"] },
    );
    const l = extractLandmarks(ctxOf(rom, m)).landmarks as any;
    expect(l.order).toEqual(["LANDMARK_A", "LANDMARK_B"]);
    expect(l.landmarks.LANDMARK_A).toEqual({ id: "LANDMARK_A", index: 0, x: 140, y: 100, name: "NEW\nTOWN" });
    expect(l.landmarks.LANDMARK_B).toEqual({ id: "LANDMARK_B", index: 1, x: 0, y: 0, name: "SPECIAL" });
    expect(l.spawns.SPAWN_C).toEqual({ id: "SPAWN_C", index: 0, x: 13, y: 6, map: "TOWN_C" });
    expect(l.spawns.SPAWN_X).toEqual({ id: "SPAWN_X", index: 1, x: 1, y: 1 });
  });
});

// ---------------------------------------------------------------- the real ROM

const GOLD_ROM = process.env.VOXELMON_GOLD_ROM ?? "/mnt/c/Users/isaac/OneDrive/Desktop/mGBA/Pokemon-Gold.gbc";
const GOLD_MANIFEST = join(
  process.env.VOXELMON_G1R_GEN2 ?? join(homedir(), "gen1recomp-mit-gen2"),
  "tools/rom_manifest_gold.json",
);
function goldInputs(): { rom: Uint8Array; manifest: Gen2Manifest } | null {
  if (!existsSync(GOLD_ROM) || !existsSync(GOLD_MANIFEST)) return null;
  const rom = new Uint8Array(readFileSync(GOLD_ROM));
  if (createHash("sha1").update(rom).digest("hex") !== GOLD_SHA1) return null;
  return { rom, manifest: JSON.parse(readFileSync(GOLD_MANIFEST, "utf8")) };
}
const gold = goldInputs();
if (!gold) console.log(`voxel-gen2-encounters: skipping the Gold ROM checks — no verified ROM at ${GOLD_ROM} or no manifest at ${GOLD_MANIFEST}`);

describe.skipIf(!gold)("gen2 encounters / trainers / pokedex against the Gold ROM", () => {
  const ctx = gold ? new Gen2Ctx(new Rom(gold.rom), gold.manifest, new GfxBin(), GOLD_SHA1) : null!;
  const enc = gold ? (extractEncounters(ctx).encounters as any) : null;
  const tr = gold ? (extractTrainers(ctx).trainers as any) : null;
  const dex = gold ? (extractPokedex(ctx).pokedex as any) : null;
  const lm = gold ? (extractLandmarks(ctx).landmarks as any) : null;
  const slots = (list: any[]) => list.map((s) => `${s.level} ${s.species}`);

  test("ROUTE_29 grass (johto_grass.asm): 10% rates, PIDGEY/SENTRET by day, HOOTHOOT at nite", () => {
    const r29 = enc.grass.ROUTE_29;
    expect(r29.rates).toEqual({ MORN: 25, DAY: 25, NITE: 25 }); // 10 percent = 25/255
    const day = ["2 PIDGEY", "3 SENTRET", "3 PIDGEY", "2 SENTRET", "4 RATTATA", "4 PIDGEY", "4 PIDGEY"];
    expect(slots(r29.slots.MORN)).toEqual(day);
    expect(slots(r29.slots.DAY)).toEqual(day);
    expect(slots(r29.slots.NITE)).toEqual(["2 HOOTHOOT", "3 HOOTHOOT", "3 HOOTHOOT", "2 RATTATA", "4 RATTATA", "4 HOOTHOOT", "4 HOOTHOOT"]);
  });

  test("ROUTE_30 grass is Gold's (CATERPIE/METAPOD by day, levels 2-5)", () => {
    const r30 = enc.grass.ROUTE_30;
    expect(slots(r30.slots.DAY)).toEqual(["2 PIDGEY", "3 CATERPIE", "4 PIDGEY", "4 METAPOD", "4 CATERPIE", "5 METAPOD", "5 METAPOD"]);
    for (const day of ["MORN", "DAY", "NITE"]) {
      for (const s of r30.slots[day]) expect(s.level >= 2 && s.level <= 5).toBe(true);
    }
  });

  test("table sizes, fish groups, trees, rocks, bug contest, swarms, roam maps", () => {
    expect(Object.keys(enc.grass).length).toBe(91);
    expect(Object.keys(enc.water).length).toBe(62);
    expect(Object.keys(enc.fishGroups).length).toBe(13);
    expect(enc.fishGroups.FISHGROUP_SHORE.old.map((r: any) => r.species)).toEqual(["MAGIKARP", "MAGIKARP", "KRABBY"]);
    expect(enc.timeFishGroups["0"]).toEqual({ day: { species: "CORSOLA", level: 20 }, nite: { species: "STARYU", level: 20 } });
    expect(enc.trees.ROUTE_29).toBe("TREEMON_SET_CANYON");
    expect(Object.keys(enc.rocks)).toEqual(["CIANWOOD_CITY", "ROUTE_40", "DARK_CAVE_VIOLET_ENTRANCE", "SLOWPOKE_WELL_B1F"]);
    expect(enc.bugContest.length).toBe(11);
    expect(enc.bugContest[0]).toEqual({ chance: 20, species: "CATERPIE", min: 7, max: 18 });
    expect(enc.bugContest[10].chance).toBe(0xff);
    expect(enc.swarmGrass.ROUTE_35.slots.DAY.some((s: any) => s.species === "YANMA")).toBe(true);
    expect(enc.roamMaps[0]).toEqual({ map: "ROUTE_29", to: ["ROUTE_30", "ROUTE_46"] });
    expect(enc.roamMaps.length).toBe(16);
    expect(enc.treeMonsAsleep).toBeUndefined(); // Crystal-only
  });

  test("66 trainer classes; FALKNER's PIDGEY 7 / PIDGEOTTO 9 with their moves", () => {
    expect(Object.keys(tr.classes).length).toBe(66);
    const falkner = tr.classes.FALKNER;
    expect(falkner.index).toBe(1);
    expect(falkner.name).toBe("LEADER");
    expect(falkner.trainers).toEqual([{
      id: "FALKNER1", index: 1, name: "FALKNER", trainerType: "TRAINERTYPE_MOVES",
      party: [
        { level: 7, species: "PIDGEY", moves: ["TACKLE", "MUD_SLAP"] },
        { level: 9, species: "PIDGEOTTO", moves: ["TACKLE", "MUD_SLAP", "GUST"] },
      ],
    }]);
    expect(tr.classes.GRUNTM.trainers.length).toBe(31);
    expect(tr.classes.RIVAL1.trainers[0].party).toEqual([{ level: 5, species: "CHIKORITA" }]);
    expect(tr.battleTower).toBeUndefined();
  });

  test("BULBASAUR's dex entry (dex_entries/bulbasaur.asm): SEED, 2'04\", 15.0 lb", () => {
    expect(Object.keys(dex.entries).length).toBe(251);
    expect(dex.entries.BULBASAUR).toMatchObject({ id: "BULBASAUR", dex: 1, kind: "SEED", height: 204, weight: 150 });
    expect(dex.entries.BULBASAUR.text.startsWith("The seed on its")).toBe(true);
    expect(dex.newOrder.slice(0, 3)).toEqual(["CHIKORITA", "BAYLEEF", "MEGANIUM"]);
    expect(dex.alphabeticalOrder[0]).toBe("ABRA");
    expect(dex.newOrder.length).toBe(251);
  });

  test("LANDMARK_NEW_BARK_TOWN is named NEW BARK / TOWN; SPAWN_HOME is upstairs", () => {
    expect(lm.landmarks.LANDMARK_NEW_BARK_TOWN).toEqual({
      id: "LANDMARK_NEW_BARK_TOWN", index: 1, x: 140, y: 100, name: "NEW BARK\nTOWN",
    });
    expect(lm.spawns.SPAWN_HOME).toEqual({ id: "SPAWN_HOME", index: 0, x: 3, y: 3, map: "PLAYERS_HOUSE_2F" });
    expect(lm.spawns.SPAWN_NEW_BARK.map).toBe("NEW_BARK_TOWN");
  });
});
