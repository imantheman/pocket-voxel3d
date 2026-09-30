// Sound programs — a port of gen1recomp (bdfac727) RomExtractorGen2.lua:2804-2976
// extractAudio(maps).
//
// Like Gen 1 (voxelmon/import/stages/audio.ts) the sound banks are copied out
// whole and concatenated (`programs.bin`); audio.json then points into them:
// a {bank, address} header per song, SFX and cry, the Music/WaveSamples/
// Drumkits tables, and which song each map plays. Unlike Gen 1 nothing comes
// from a manifest audio block -- every header is a symbol or a ROM pointer
// table read here. The banks are content: they land under dist/, never in the
// repo.
//
// Gold only: Crystal's extra bank $5e (:2810) is dropped.

import type { RomSymbol } from "../ctx.ts";
import type { Gen2Ctx } from "./ctx.ts";

const BANK_SIZE = 0x4000;

/** RomExtractorGen2.lua:2809 — Gold's sound banks, in programs.bin order
 * (audio/engine + "Songs 1..4" + sfx/cries; NOT Gen 1's {2,8,31}). */
export const GEN2_PROGRAM_BANKS = [0x07, 0x33, 0x3a, 0x3b, 0x3c, 0x3d];

/** A program header: `generation` is always 2 (ChipSynth's driver switch). */
export interface Gen2ProgramHeader {
  bank: number;
  address: number;
  generation: 2;
  /** SFX only: set on the six FANFARE_NAMES (:2876). */
  fanfare?: true;
}

export interface Gen2CryRecord {
  /** The Cries: row this species' PokemonCries index points at. */
  header: Gen2ProgramHeader;
  /** PokemonCries `dw` pitch, read UNSIGNED as Brian does (:2913): pret's
   * negative pitches (e.g. CHIKORITA -16) arrive as 65536 + pitch. */
  pitch: number;
  length: number;
}

/** GetMapMusic's two out-of-table ids (home/map.asm; constants/
 * music_constants.asm:100,109) — RomExtractorGen2.lua:2856. */
const MUSIC_MAHOGANY_MART = 100;
const RADIO_TOWER_MUSIC = 0x80;

/** RomExtractorGen2.lua:2875 FANFARE_NAMES. */
const FANFARE_NAMES = [
  "Sfx_CaughtMon",
  "Sfx_Item",
  "Sfx_DexFanfare2049",
  "Sfx_DexFanfare5079",
  "Sfx_DexFanfare80109",
  "Sfx_Fanfare",
];

/** pret NUM_CRIES (constants/cry_constants.asm:76) — RomExtractorGen2.lua:2896. */
const NUM_CRIES = 68;

/** A 3-byte `dba` row (bank, then little-endian address) -> header. */
function dba(ctx: Gen2Ctx, bank: number, address: number): Gen2ProgramHeader {
  const row = ctx.rom.bytes(bank, address, 3);
  return { bank: row[0]!, address: row[1]! + row[2]! * 256, generation: 2 };
}

/**
 * RomExtractorGen2.lua:2806 extractAudio(maps). `maps` is the maps stage's
 * output (MAP_NAME -> {music, ...}); absent, mapSongs is left empty (:2858).
 *
 * Returns `{ audio, "programs.bin" }`. audio.json shape (Brian's `data`,
 * :2927-2948):
 *   generation 2, runtime true, programFile, bankOrder number[],
 *   music {bank,address,name} (the Music: dba table),
 *   songs   { Music_* -> header }       (every musicOrder label but Music_Nothing)
 *   musicOrder string[]                 (element i = music id i; Lua [id + 1])
 *   mapSongs { MAP_NAME -> Music_* }
 *   sfx     { Sfx_* -> header (+fanfare) }, sfxOrder string[] (element i = SFX id i)
 *   fanfares { Sfx_* -> true }
 *   cries   { SPECIES -> {header, pitch, length} }
 *   waveBanks { "1": {bank,address,name:"WaveSamples"} }
 *   drumkits  {bank,address,name:"Drumkits"}
 *   source string
 * `programFile` is Brian's "assets/generated/audio/programs.bin" translated,
 * like image paths, to the name the file is returned under ("programs.bin",
 * which is also what Gen 1's audio.json carries).
 */
export function extractAudio(
  ctx: Gen2Ctx,
  maps?: Record<string, { music?: unknown }>,
): Record<string, unknown> {
  // :2809-2823 — each bank's whole $4000-$7FFF window, concatenated in order.
  const bankOrder = [...GEN2_PROGRAM_BANKS];
  const programs = new Uint8Array(bankOrder.length * BANK_SIZE);
  bankOrder.forEach((bank, index) => {
    programs.set(Uint8Array.from(ctx.rom.bytes(bank, BANK_SIZE, BANK_SIZE)), index * BANK_SIZE);
  });

  // :2825-2832 — songs from the symbol table first ...
  const consts = ctx.manifest.constants;
  const musicOrder = (consts.musicOrder as string[] | undefined) ?? [];
  const songs: Record<string, Gen2ProgramHeader> = {};
  for (const name of musicOrder) {
    const loc = name !== "Music_Nothing" ? ctx.location(name) : undefined;
    if (loc) songs[name] = { bank: loc[0], address: loc[1], generation: 2 };
  }

  // :2834-2846 — ... then the live Music: dba table for any label missing.
  const musicPtr: RomSymbol = ctx.symbol("Music");
  musicOrder.forEach((name, index) => {
    if (name !== "Music_Nothing" && !songs[name]) {
      songs[name] = dba(ctx, musicPtr.bank, musicPtr.address + index * 3);
    }
  });

  const wave = ctx.symbol("WaveSamples");
  const drums = ctx.symbol("Drumkits");

  // :2848-2868 — map music id -> song label, skipping MUSIC_MAHOGANY_MART and
  // the RADIO_TOWER_MUSIC bit, which GetMapMusic resolves before indexing Music.
  const mapSongs: Record<string, string> = {};
  if (maps) {
    for (const [mapId, def] of Object.entries(maps)) {
      const id = def?.music;
      if (typeof id === "number" && id > 0 && id !== MUSIC_MAHOGANY_MART && id < RADIO_TOWER_MUSIC) {
        const label = musicOrder[id]; // Lua musicOrder[id + 1]
        if (label && songs[label]) mapSongs[mapId] = label;
      }
    }
  }

  // :2870-2893 — SFX: pointer table (audio/sfx_pointers.asm), 3-byte dba per id.
  const sfxOrder = (consts.sfxOrder as string[] | undefined) ?? [];
  const sfxPtr = ctx.symbol("SFX");
  const sfx: Record<string, Gen2ProgramHeader> = {};
  const fanfares: Record<string, true> = {};
  sfxOrder.forEach((name, index) => {
    const def = dba(ctx, sfxPtr.bank, sfxPtr.address + index * 3);
    if (FANFARE_NAMES.includes(name)) def.fanfare = true;
    sfx[name] = def;
  });
  for (const name of FANFARE_NAMES) if (sfx[name]) fanfares[name] = true;

  // :2895-2905 — Cries: base headers, NUM_CRIES dba rows (0-based cry ids).
  const cryPtr = ctx.symbol("Cries");
  const cryHeaders: Gen2ProgramHeader[] = [];
  for (let i = 0; i < NUM_CRIES; i++) cryHeaders.push(dba(ctx, cryPtr.bank, cryPtr.address + i * 3));

  // :2906-2925 — PokemonCries: dw index, pitch, length per species (speciesOrder
  // element 0 = BULBASAUR = row 0). UNUSED* rows are skipped; UNOWN has a real
  // row (data/pokemon/cries.asm:209). A cry index past NUM_CRIES is dropped.
  const pokeCryPtr = ctx.symbol("PokemonCries");
  const speciesOrder = consts.speciesOrder ?? [];
  const cries: Record<string, Gen2CryRecord> = {};
  speciesOrder.forEach((species, index) => {
    if (String(species).startsWith("UNUSED")) return;
    const row = ctx.rom.bytes(pokeCryPtr.bank, pokeCryPtr.address + index * 6, 6);
    const header = cryHeaders[row[0]! + row[1]! * 256];
    if (header) {
      cries[species] = {
        // Lua shares one table per cry id; JSON gets a copy per species.
        header: { ...header },
        pitch: row[2]! + row[3]! * 256,
        length: row[4]! + row[5]! * 256,
      };
    }
  });

  const audio = {
    generation: 2,
    runtime: true,
    programFile: "programs.bin",
    bankOrder,
    music: musicPtr,
    songs,
    musicOrder,
    mapSongs,
    sfx,
    sfxOrder,
    fanfares,
    cries,
    // ChipSynth Gen 1 shape: one wave bank key; Gen 2 uses WaveSamples (:2941).
    waveBanks: {
      "1": { bank: wave.bank, address: wave.address, name: "WaveSamples" },
    },
    drumkits: { bank: drums.bank, address: drums.address, name: "Drumkits" },
    source: "canonical Pokemon Gold ROM sound programs (Gen 2 driver)",
  };
  return { audio, "programs.bin": programs };
}
