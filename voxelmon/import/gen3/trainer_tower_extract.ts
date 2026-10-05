// Port of gen1recomp src/import/gba/trainer_tower_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/trainer_tower_sets.c:8951, src/trainer_tower.c:105, :191, :204, :382

import { Versions } from "./versions.ts";
import { BgBake } from "./bg_bake.ts";
import { format, tostring } from "./lua.ts";
import { TextIR } from "../../game/gen3/core/scripting/text_ir.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

// include/cereader_tool.h:7
const TRAINER_STRIDE = 328;
const TRAINER_NAME_LEN = 11;
const SPEECH_WORDS = 6;
const MON_STRIDE = 44;
const PARTY_SIZE = 6;
const MON_BASE = 0x40;

// Lua: trainer_tower_extract.lua:23 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: trainer_tower_extract.lua:31
function decode_name(rom: Rom, off: number, len: number): string {
  const bytes: number[] = [];
  for (let i = 0; i < len; i++) {
    const b = rom.get(off + i);
    bytes.push(b);
    if (b === 0xFF) break;
  }
  const out: string[] = [];
  for (const seg of TextIR.decode(bytes)) {
    if (seg.t === "text") out.push(seg.s!);
  }
  return out.join("");
}

// Lua: trainer_tower_extract.lua:45
function words(rom: Rom, off: number): string {
  const list: string[] = [];
  for (let i = 0; i < SPEECH_WORDS; i++) list.push(tostring(rom.u16(off + i * 2)));
  return list.join(", ");
}

// Lua: trainer_tower_extract.lua:54 -- include/pokemon.h:143
function mon_row(rom: Rom, off: number): string {
  const ivs = rom.u32(off + 0x18);
  const field = (shift: number): number => Math.floor(ivs / 2 ** shift) % 32;
  const moves: string[] = [];
  for (let i = 0; i <= 3; i++) moves.push(tostring(rom.u16(off + 4 + i * 2)));
  return format(
    "{ species = %d, heldItem = %d, moves = { %s }, level = %d, ppBonuses = %d, "
    + "hpEV = %d, attackEV = %d, defenseEV = %d, speedEV = %d, spAttackEV = %d, spDefenseEV = %d, "
    + "otId = %d, hpIV = %d, attackIV = %d, defenseIV = %d, speedIV = %d, spAttackIV = %d, "
    + "spDefenseIV = %d, abilityNum = %d, personality = %d, nickname = %q, friendship = %d }",
    rom.u16(off), rom.u16(off + 2), moves.join(", "),
    rom.get(off + 0x0C), rom.get(off + 0x0D),
    rom.get(off + 0x0E), rom.get(off + 0x0F), rom.get(off + 0x10),
    rom.get(off + 0x11), rom.get(off + 0x12), rom.get(off + 0x13),
    rom.u32(off + 0x14),
    field(0), field(5), field(10), field(15), field(20), field(25),
    Math.floor(ivs / 2 ** 31) % 2,
    rom.u32(off + 0x1C),
    decode_name(rom, off + 0x20, 11), rom.get(off + 0x2B));
}

// Lua: trainer_tower_extract.lua:77
function trainer_row(rom: Rom, off: number): string {
  const mons: string[] = [];
  for (let i = 0; i < PARTY_SIZE; i++) mons.push("        " + mon_row(rom, off + MON_BASE + i * MON_STRIDE) + ",");
  return format(`      { name = %q, facilityClass = %d, textColor = %d,
        speechBefore = { %s }, speechWin = { %s },
        speechLose = { %s }, speechAfter = { %s },
        mons = {
%s
        } },`,
    decode_name(rom, off, TRAINER_NAME_LEN), rom.get(off + 0x0B), rom.get(off + 0x0C),
    words(rom, off + 0x0E), words(rom, off + 0x1A),
    words(rom, off + 0x26), words(rom, off + 0x32),
    mons.join("\n"));
}

// Lua: trainer_tower_extract.lua:95
function floor_rows(rom: Rom, floorOff: number): string {
  const trainers: string[] = [];
  for (let i = 0; i < Versions.TRAINER_TOWER_TRAINERS_PER_FLOOR; i++) {
    trainers.push(trainer_row(rom, floorOff + 4 + i * TRAINER_STRIDE));
  }
  return format(`    { id = %d, floorIdx = %d, challengeType = %d, prize = %d,
      trainers = {
%s
      } },`,
    rom.get(floorOff), rom.get(floorOff + 1), rom.get(floorOff + 2), rom.get(floorOff + 3),
    trainers.join("\n"));
}

// Lua: trainer_tower_extract.lua:110 -- src/trainer_tower.c:960
function encounter_music(rom: Rom): string {
  const lut: { klass: number; music: number }[] = [];
  for (let i = 0; i < Versions.TT_ENCOUNTER_MUSIC_LUT_COUNT; i++) {
    const off = Versions.TT_ENCOUNTER_MUSIC_LUT + i * 4;
    lut.push({ klass: rom.get(off), music: rom.get(off + 1) });
  }
  const songs: number[] = [];
  for (let i = 0; i < Versions.TT_ENCOUNTER_MUSIC_COUNT; i++) songs[i] = rom.u16(Versions.TT_ENCOUNTER_MUSIC + i * 2);
  const out: string[] = [];
  for (let klass = 0; klass < Versions.FACILITY_CLASS_COUNT; klass++) {
    const trainerClass = rom.get(Versions.FACILITY_CLASS_TO_TRAINER_CLASS + klass);
    let idx = 0;
    for (const row of lut) {
      if (row.klass === trainerClass) { idx = row.music; break; }
    }
    out.push(format("  [%d] = %d,", klass, songs[idx] ?? songs[0] ?? 0));
  }
  return out.join("\n");
}

export const TrainerTowerExtract = {
  CACHE_REL: "trainer_tower.lua",
  CACHE_SUB: "trainer_tower",
  FORMAT_VERSION: 1,
  // src/battle_records.c:37 sTiles, :38 sPalette, :39 sTilemap
  SCREEN_W: 240,
  SCREEN_H: 160,

  // Lua: trainer_tower_extract.lua:135
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): { rel: string; floors: number; dir: string } {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const rel = cacheRoot + "/" + TrainerTowerExtract.CACHE_REL;

    const lines: string[] = [
      "-- Auto-generated FRLG gTrainerTowerFloors and facility-class lookups.",
      "return {",
      format("  format_version = %d,", TrainerTowerExtract.FORMAT_VERSION),
      format("  header = { numFloors = %d, id = %d },",
        rom.get(Versions.TRAINER_TOWER_HEADER), rom.get(Versions.TRAINER_TOWER_HEADER + 1)),
      "  floors = {",
    ];

    let floorCount = 0;
    for (let challenge = 0; challenge < Versions.TRAINER_TOWER_CHALLENGE_TYPES; challenge++) {
      lines.push(format("  [%d] = {", challenge));
      for (let floor = 0; floor < Versions.TRAINER_TOWER_MAX_FLOORS; floor++) {
        const ptr = Versions.TRAINER_TOWER_FLOORS + (challenge * Versions.TRAINER_TOWER_MAX_FLOORS + floor) * 4;
        const floorOff = rom.ptrOffset(rom.u32(ptr));
        if (floorOff === undefined) throw new Error(format("trainer_tower: bad floor pointer %d/%d", challenge, floor));
        lines.push(floor_rows(rom, floorOff));
        floorCount = floorCount + 1;
      }
      lines.push("  },");
    }
    lines.push("  },");

    lines.push("  singlesTrainerInfo = {");
    for (let i = 0; i < Versions.TT_SINGLES_INFO_COUNT; i++) {
      const off = Versions.TT_SINGLES_INFO + i * 4;
      lines.push(format("  [%d] = { objGfx = %d, gender = %d },", rom.get(off + 1), rom.get(off), rom.get(off + 2)));
    }
    lines.push("  },");

    lines.push("  doublesTrainerInfo = {");
    for (let i = 0; i < Versions.TT_DOUBLES_INFO_COUNT; i++) {
      const off = Versions.TT_DOUBLES_INFO + i * 8;
      lines.push(format("  [%d] = { objGfx1 = %d, objGfx2 = %d, gender1 = %d, gender2 = %d },",
        rom.get(off + 2), rom.get(off), rom.get(off + 1), rom.get(off + 3), rom.get(off + 4)));
    }
    lines.push("  },");

    lines.push("  encounterMusic = {");
    lines.push(encounter_music(rom));
    lines.push("  },");

    lines.push("  facilityClassPic = {");
    for (let klass = 0; klass < Versions.FACILITY_CLASS_COUNT; klass++) {
      lines.push(format("  [%d] = %d,", klass, rom.get(Versions.FACILITY_CLASS_TO_PIC + klass)));
    }
    lines.push("  },");

    // src/trainer_tower.c:447, src/battle_tower.c:1340
    lines.push("  facilityClassTrainerClass = {");
    for (let klass = 0; klass < Versions.FACILITY_CLASS_COUNT; klass++) {
      lines.push(format("  [%d] = %d,", klass, rom.get(Versions.FACILITY_CLASS_TO_TRAINER_CLASS + klass)));
    }
    lines.push("  },");

    lines.push("}");
    lines.push("");
    cache.write(rel, lines.join("\n"));

    const dir = cacheRoot + "/" + TrainerTowerExtract.CACHE_SUB;
    const raw = (off: number, n: number): Uint8Array => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = rom.get(off + i);
      return out;
    };
    // src/battle_records.c:563 LoadFrameGfxOnBg, BG_PLTT_ID(0)
    const recordsGfx = raw(Versions.BATTLE_RECORDS_GFX, 0xC0);
    const recordsMap = raw(Versions.BATTLE_RECORDS_TILEMAP, 2048);
    const recordsBanks = BgBake.loadPalBanks(raw(Versions.BATTLE_RECORDS_PAL, 32), 1);
    cache.write(dir + "/records_bg.rgba",
      BgBake.bakeBgRgba(recordsGfx, recordsBanks, recordsMap, TrainerTowerExtract.SCREEN_W, TrainerTowerExtract.SCREEN_H));
    cache.write(dir + "/manifest.lua", format(`return {
  format_version = %d,
  recordsBg = { width = %d, height = %d },
}
`, TrainerTowerExtract.FORMAT_VERSION, TrainerTowerExtract.SCREEN_W, TrainerTowerExtract.SCREEN_H));

    console.log(format("[trainer_tower_extract] %d floors, %d singles classes, %d doubles classes, records bg %dx%d -> %s",
      floorCount, Versions.TT_SINGLES_INFO_COUNT, Versions.TT_DOUBLES_INFO_COUNT,
      TrainerTowerExtract.SCREEN_W, TrainerTowerExtract.SCREEN_H, rel));
    return { rel, floors: floorCount, dir };
  },

  // Lua: trainer_tower_extract.lua:235
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = cacheRoot ?? default_cache_root();
    const rel = root + "/" + TrainerTowerExtract.CACHE_REL;
    if (!(cache && cache.exists)) return false;
    if (!cache.exists(rel)) return false;
    const dir = root + "/" + TrainerTowerExtract.CACHE_SUB;
    return cache.exists(dir + "/records_bg.rgba") && cache.exists(dir + "/manifest.lua");
  },
};

export default TrainerTowerExtract;
