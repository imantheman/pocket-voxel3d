// Port of gen1recomp src/core/game3/pokemon_size_record.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG Pokemon Size Record System (pokefirered/src/pokemon_size_record.c).
// Calculates size hashes, table-interpolated heights, imperial conversions, and record comparisons.

import { format, tonumber, truthy } from "../../../import/gen3/lua.ts";
import { Constants } from "./constants.ts";
import { PokedexData } from "./pokedex_data.ts";
import { Flags } from "./scripting/flags.ts";
import { Space as SpaceMod } from "./scripting/space.ts";
import { Runtime } from "./runtime.ts";
import { Pokemon } from "./pokemon.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface SizeRow { unk0: number; unk2: number; unk4: number }

// Lua: pokemon_size_record.lua:29 -- pokefirered/src/pokemon_size_record.c:18 sBigMonSizeTable
const sBigMonSizeTable: (SizeRow | null)[] = [
  null,
  { unk0: 290, unk2: 1, unk4: 0 },
  { unk0: 300, unk2: 1, unk4: 10 },
  { unk0: 400, unk2: 2, unk4: 110 },
  { unk0: 500, unk2: 4, unk4: 310 },
  { unk0: 600, unk2: 20, unk4: 710 },
  { unk0: 700, unk2: 50, unk4: 2710 },
  { unk0: 800, unk2: 100, unk4: 7710 },
  { unk0: 900, unk2: 150, unk4: 17710 },
  { unk0: 1000, unk2: 150, unk4: 32710 },
  { unk0: 1100, unk2: 100, unk4: 47710 },
  { unk0: 1200, unk2: 50, unk4: 57710 },
  { unk0: 1300, unk2: 20, unk4: 62710 },
  { unk0: 1400, unk2: 5, unk4: 64710 },
  { unk0: 1500, unk2: 2, unk4: 65210 },
  { unk0: 1600, unk2: 1, unk4: 65410 },
  { unk0: 1700, unk2: 1, unk4: 65510 },
];

// Lua: pokemon_size_record.lua:49
const SPECIES_HEIGHT_DM: Record<number, number> = {
  [129]: 9,  // Magikarp: 0.9 m (9 dm)
  [214]: 15, // Heracross: 1.5 m (15 dm)
};

// Lua: pokemon_size_record.lua:71
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: pokemon_size_record.lua:83
function scriptStore(session: any, ctx: any): any {
  const Space: any = SpaceMod;
  return (Space && Space.store) || (ctx && ctx.session) || session || null;
}

// Lua: pokemon_size_record.lua:122 -- pokefirered/src/pokemon_size_record.c:62 TranslateBigMonSizeTableIndex
function translateBigMonSizeTableIndex(aIn: unknown): number {
  const a = (tonumber(aIn) ?? 0) & 0xFFFF;
  for (let i = 2; i <= 15; i++) { // 1-based (i = 1 in C is index 2 in Lua)
    if (a < sBigMonSizeTable[i]!.unk4) {
      return i - 1;
    }
  }
  return 16;
}

export const SizeRecord = {
  // Lua: pokemon_size_record.lua:8
  SPECIES_MAGIKARP: 129,
  SPECIES_HERACROSS: 214,

  VAR_HERACROSS_SIZE_RECORD: 0x403D,
  VAR_MAGIKARP_SIZE_RECORD: 0x4040,
  VAR_LOTAD_SIZE_RECORD: 0x404F,

  // Lua: pokemon_size_record.lua:15
  species(name: string, session?: any): any {
    const C = Constants.active(session);
    return C.id("species", name);
  },

  // Lua: pokemon_size_record.lua:20
  variable(name: string, session?: any): any {
    const C = Constants.active(session);
    return C.var(name);
  },

  // Lua: pokemon_size_record.lua:25
  DEFAULT_MAX_SIZE: 0,
  PARTY_SIZE: 6,

  // Lua: pokemon_size_record.lua:47
  TABLE: sBigMonSizeTable,

  // Lua: pokemon_size_record.lua:54
  getSpeciesHeight(speciesIn: unknown, session?: any): number {
    const species = tonumber(speciesIn) ?? 0;
    if (SPECIES_HEIGHT_DM[species]) {
      return SPECIES_HEIGHT_DM[species];
    }
    let C: any;
    try { C = Constants.active(session); } catch { C = Constants.of("firered"); }
    if (species === C.id("species", "SPECIES_LOTAD") || species === C.id("species", "SPECIES_SEEDOT")) return 5;
    if (PokedexData && PokedexData.getEntry) {
      const ent: any = PokedexData.getEntry(species);
      if (ent && ent.heightDm) return ent.heightDm;
    }
    return 10; // default 1.0 m (10 dm)
  },

  // Lua: pokemon_size_record.lua:75
  sessionOf(ctx: any): any {
    if (ctx && ctx.session) return ctx.session;
    const Space: any = SpaceMod;
    if (Space && Space.store && Space.store.flags) return Space.store;
    return Runtime && Runtime.getSession ? Runtime.getSession() ?? null : null;
  },

  // Lua: pokemon_size_record.lua:88
  getVar(session: any, ctx: any, varId: number): number {
    session = session ?? SizeRecord.sessionOf(ctx);
    return tonumber(flagsMod().getVar(scriptStore(session, ctx), ctx, varId)) ?? 0;
  },

  // Lua: pokemon_size_record.lua:93
  setVar(session: any, ctx: any, varId: number, value: unknown): void {
    session = session ?? SizeRecord.sessionOf(ctx);
    flagsMod().setVar(scriptStore(session, ctx), ctx, varId, (tonumber(value) ?? 0) & 0xFFFF);
  },

  // Lua: pokemon_size_record.lua:98
  setStringVar(ctx: any, adapters: any, index: number, text: string): void {
    if (adapters && adapters.setStringVar) adapters.setStringVar(index, text);
    if (ctx && ctx.stringVars) ctx.stringVars[index] = text;
  },

  // Lua: pokemon_size_record.lua:104 -- pokefirered/src/pokemon_size_record.c:47 GetMonSizeHash
  getMonSizeHash(pkmn: any): number {
    if (!pkmn) return 0;
    const personality = (tonumber(pkmn.personality ?? pkmn.pid ?? 0) ?? 0) & 0xFFFFFFFF;
    const ivs = pkmn.ivs ?? {};
    const hpIV = (tonumber(pkmn.ivHp ?? ivs.hp ?? 0) ?? 0) & 0xF;
    const attackIV = (tonumber(pkmn.ivAtk ?? ivs.atk ?? 0) ?? 0) & 0xF;
    const defenseIV = (tonumber(pkmn.ivDef ?? ivs.def ?? 0) ?? 0) & 0xF;
    const speedIV = (tonumber(pkmn.ivSpd ?? ivs.spd ?? 0) ?? 0) & 0xF;
    const spAtkIV = (tonumber(pkmn.ivSpAtk ?? ivs.spAtk ?? 0) ?? 0) & 0xF;
    const spDefIV = (tonumber(pkmn.ivSpDef ?? ivs.spDef ?? 0) ?? 0) & 0xF;

    const hibyte = (((attackIV ^ defenseIV) * hpIV) ^ (personality & 0xFF)) & 0xFF;
    const lobyte = (((spAtkIV ^ spDefIV) * speedIV) ^ ((personality >>> 8) & 0xFF)) & 0xFF;

    return ((hibyte << 8) | lobyte) & 0xFFFF;
  },

  // Lua: pokemon_size_record.lua:131
  translateIndex: translateBigMonSizeTableIndex,

  // Lua: pokemon_size_record.lua:134 -- pokefirered/src/pokemon_size_record.c:74 GetMonSize
  getMonSize(species: unknown, bIn: unknown, session?: any): number {
    const b = (tonumber(bIn) ?? 0) & 0xFFFF;
    const height = SizeRecord.getSpeciesHeight(species, session);
    const v = translateBigMonSizeTableIndex(b);
    const row = sBigMonSizeTable[v]!;
    let unk0 = row.unk0;
    const unk2 = row.unk2;
    const unk4 = row.unk4;
    unk0 = unk0 + Math.floor((b - unk4) / unk2);
    return Math.floor(height * unk0 / 10);
  },

  // Lua: pokemon_size_record.lua:148 -- pokefirered/src/pokemon_size_record.c:91 FormatMonSizeRecord
  formatMonSizeRecord(sizeIn: unknown): string {
    const size = tonumber(sizeIn) ?? 0;
    const inches = Math.floor(size * 100 / 254);
    const whole = Math.floor(inches / 10);
    const frac = inches % 10;
    return format("%d.%d", whole, frac);
  },

  // Lua: pokemon_size_record.lua:163 -- pokefirered/src/pokemon_size_record.c:104 CompareMonSize
  compareMonSize(session: any, ctx: any, adapters: any, species: unknown, varId: number, slotIn?: unknown): number {
    session = session ?? SizeRecord.sessionOf(ctx);
    let slot = tonumber(slotIn);
    if (slot == null) {
      const VAR_RESULT = Constants.active(session).var("VAR_RESULT");
      slot = tonumber(flagsMod().getVar(scriptStore(session, ctx), ctx, VAR_RESULT)) ?? 0;
    }

    if (slot < 0 || slot >= SizeRecord.PARTY_SIZE) {
      return 0;
    }

    const party = (session && session.party) || [null];
    const pkmn = party[slot + 1];

    if (!pkmn || truthy(pkmn.isEgg) || truthy(pkmn.is_egg) || (tonumber(pkmn.species ?? pkmn.speciesId) !== tonumber(species))) {
      return 1;
    }

    const sizeParams = SizeRecord.getMonSizeHash(pkmn);
    const newSize = SizeRecord.getMonSize(species, sizeParams, session);
    const oldRecord = SizeRecord.getVar(session, ctx, varId);
    const oldSize = SizeRecord.getMonSize(species, oldRecord, session);

    SizeRecord.setStringVar(ctx, adapters, 3, SizeRecord.formatMonSizeRecord(oldSize));
    SizeRecord.setStringVar(ctx, adapters, 2, SizeRecord.formatMonSizeRecord(newSize));

    if (newSize === oldSize) {
      return 4;
    } else if (newSize < oldSize) {
      return 2;
    } else {
      SizeRecord.setVar(session, ctx, varId, sizeParams);
      return 3;
    }
  },

  // Lua: pokemon_size_record.lua:201 -- pokefirered/src/pokemon_size_record.c:147 GetMonSizeRecordInfo
  getMonSizeRecordInfo(session: any, ctx: any, adapters: any, species: unknown, varId: number): void {
    session = session ?? SizeRecord.sessionOf(ctx);
    const sizeRecord = SizeRecord.getVar(session, ctx, varId);
    const size = SizeRecord.getMonSize(species, sizeRecord, session);

    SizeRecord.setStringVar(ctx, adapters, 3, SizeRecord.formatMonSizeRecord(size));

    SizeRecord.setStringVar(ctx, adapters, 1, (Pokemon as any).name(species));
  },

  // Lua: pokemon_size_record.lua:211
  initMagikarpSizeRecord(session: any, ctx: any): void {
    SizeRecord.setVar(session, ctx, SizeRecord.VAR_MAGIKARP_SIZE_RECORD, SizeRecord.DEFAULT_MAX_SIZE);
  },

  // Lua: pokemon_size_record.lua:215
  initHeracrossSizeRecord(session: any, ctx: any): void {
    SizeRecord.setVar(session, ctx, SizeRecord.VAR_HERACROSS_SIZE_RECORD, SizeRecord.DEFAULT_MAX_SIZE);
  },
};

export default SizeRecord;
