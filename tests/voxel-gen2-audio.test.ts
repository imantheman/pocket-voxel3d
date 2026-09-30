// The Gen 2 (Gold) audio stage (voxelmon/import/gen2/audio.ts, a port of
// RomExtractorGen2.lua:2806 extractAudio): the dba pointer tables, the map ->
// song filter and the cry join on a synthetic ROM, then -- only when a
// verified Gold ROM is on this machine -- the same stage against it, pinned
// to pret/pokegold's audio/*.asm and data/pokemon/cries.asm. No ROM bytes are
// ever committed.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GOLD_SHA1 } from "../voxelmon/import/env.ts";
import { GfxBin } from "../voxelmon/import/gfx.ts";
import { Rom } from "../voxelmon/import/rom.ts";
import { extractAudio, GEN2_PROGRAM_BANKS } from "../voxelmon/import/gen2/audio.ts";
import { Gen2Ctx } from "../voxelmon/import/gen2/ctx.ts";
import type { Gen2Manifest } from "../voxelmon/import/gen2/manifest.ts";

const BANK = 0x4000;

class FakeRom {
  readonly data = new Uint8Array(0x40 * BANK);
  put(bank: number, address: number, bytes: number[]): void {
    this.data.set(bytes, Rom.offset(bank, address));
  }
  dba(bank: number, address: number, toBank: number, to: number): void {
    this.put(bank, address, [toBank, to & 0xff, to >> 8]);
  }
  word(bank: number, address: number, value: number): void {
    this.put(bank, address, [value & 0xff, value >> 8]);
  }
}

function manifest(symbols: Gen2Manifest["symbols"], consts: Record<string, unknown>): Gen2Manifest {
  return {
    format: 3,
    generation: 2,
    romSha1: GOLD_SHA1,
    symbols,
    charmap: {},
    fontCharmap: [],
    maps: {},
    tilesets: {},
    pokemonAssets: {},
    text: {},
    constants: {
      source: "test",
      mapOrder: [],
      mapGroups: [],
      tilesetOrder: [],
      environmentOrder: [],
      paletteOrder: [],
      fishGroupOrder: [],
      mapCallbackOrder: [],
      spriteOrder: [],
      speciesOrder: [],
      trainerClassOrder: [],
      ...consts,
    },
  };
}

describe("gen2 extractAudio on a synthetic ROM", () => {
  const rom = new FakeRom();
  const B = 0x3a;
  const MUSIC = 0x4000, SFX = 0x4100, CRIES = 0x4200, POKECRIES = 0x4400;
  // Music: dba table — row 2 (Music_Lost, no symbol) -> 3b:5555
  rom.dba(B, MUSIC + 2 * 3, 0x3b, 0x5555);
  // SFX: row 0 Sfx_Item (a fanfare), row 1 Sfx_Beep
  rom.dba(B, SFX, 0x3c, 0x4abc);
  rom.dba(B, SFX + 3, 0x3c, 0x4def);
  // Cries: row 5 -> 3c:6000
  rom.dba(B, CRIES + 5 * 3, 0x3c, 0x6000);
  // PokemonCries: A -> cry 5, pitch -16 (unsigned), length 176; UNUSED_X; C -> cry 99 (out of range)
  rom.word(B, POKECRIES, 5);
  rom.word(B, POKECRIES + 2, 0x10000 - 16);
  rom.word(B, POKECRIES + 4, 176);
  rom.word(B, POKECRIES + 6, 5);
  rom.word(B, POKECRIES + 12, 99);
  // programs.bin markers: first byte of bank $07, last byte of bank $3d
  rom.put(0x07, 0x4000, [0xa7]);
  rom.put(0x3d, 0x7fff, [0xd3]);

  const m = manifest(
    {
      Music: [B, MUSIC], SFX: [B, SFX], Cries: [B, CRIES], PokemonCries: [B, POKECRIES],
      WaveSamples: [B, 0x4d00], Drumkits: [B, 0x4e00],
      Music_Nothing: [B, 0x4f00], Music_Found: [0x3a, 0x7000],
    },
    {
      musicOrder: ["Music_Nothing", "Music_Found", "Music_Lost"],
      sfxOrder: ["Sfx_Item", "Sfx_Beep"],
      speciesOrder: ["A", "UNUSED_X", "C"],
    },
  );
  const ctx = new Gen2Ctx(new Rom(rom.data), m, new GfxBin());
  const out = extractAudio(ctx, {
    M1: { music: 1 }, M2: { music: 2 }, M0: { music: 0 },
    MART: { music: 100 }, RADIO: { music: 0x81 }, BAD: { music: 7 }, STR: { music: "1" },
  });
  const audio = out.audio as any;

  test("programs.bin is the six Gold banks' windows, concatenated", () => {
    const bin = out["programs.bin"] as Uint8Array;
    expect(GEN2_PROGRAM_BANKS).toEqual([0x07, 0x33, 0x3a, 0x3b, 0x3c, 0x3d]);
    expect(bin.length).toBe(6 * BANK);
    expect(bin[0]).toBe(0xa7);
    expect(bin[6 * BANK - 1]).toBe(0xd3);
    expect(audio.bankOrder).toEqual(GEN2_PROGRAM_BANKS);
    expect(audio.programFile).toBe("programs.bin");
  });

  test("songs: symbols first, Music: table for the rest, never Music_Nothing", () => {
    expect(audio.songs).toEqual({
      Music_Found: { bank: 0x3a, address: 0x7000, generation: 2 },
      Music_Lost: { bank: 0x3b, address: 0x5555, generation: 2 },
    });
    expect(audio.music).toEqual({ bank: B, address: MUSIC, name: "Music" });
    expect(audio.musicOrder).toEqual(m.constants.musicOrder);
  });

  test("mapSongs: music id indexes musicOrder 0-based; 0, MAHOGANY_MART, radio bit, misses dropped", () => {
    expect(audio.mapSongs).toEqual({ M1: "Music_Found", M2: "Music_Lost" });
  });

  test("sfx and fanfares", () => {
    expect(audio.sfx).toEqual({
      Sfx_Item: { bank: 0x3c, address: 0x4abc, generation: 2, fanfare: true },
      Sfx_Beep: { bank: 0x3c, address: 0x4def, generation: 2 },
    });
    expect(audio.fanfares).toEqual({ Sfx_Item: true });
  });

  test("cries: unsigned pitch, UNUSED and out-of-range cry ids dropped", () => {
    expect(audio.cries).toEqual({
      A: { header: { bank: 0x3c, address: 0x6000, generation: 2 }, pitch: 65520, length: 176 },
    });
  });

  test("wave bank and drumkits", () => {
    expect(audio.waveBanks).toEqual({ "1": { bank: B, address: 0x4d00, name: "WaveSamples" } });
    expect(audio.drumkits).toEqual({ bank: B, address: 0x4e00, name: "Drumkits" });
    expect(audio.generation).toBe(2);
    expect(audio.runtime).toBe(true);
  });

  test("no maps: empty mapSongs", () => {
    expect((extractAudio(ctx).audio as any).mapSongs).toEqual({});
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
if (!gold) console.log(`voxel-gen2-audio: skipping the Gold ROM checks — no verified ROM at ${GOLD_ROM} or no manifest at ${GOLD_MANIFEST}`);

describe.skipIf(!gold)("gen2 extractAudio against the Gold ROM", () => {
  const ctx = gold ? new Gen2Ctx(new Rom(gold.rom), gold.manifest, new GfxBin(), GOLD_SHA1) : null!;
  // MUSIC_NEW_BARK_TOWN = $3c (constants/music_constants.asm:64); the radio
  // bit and id 0 must drop out.
  const out = gold
    ? extractAudio(ctx, { NEW_BARK_TOWN: { music: 0x3c }, ROUTE_X: { music: 0 }, RADIO: { music: 0x80 | 0x3c } })
    : null!;
  const audio = gold ? (out.audio as any) : null;
  const bin = gold ? (out["programs.bin"] as Uint8Array) : null!;

  test("counts: 92 songs (93 music ids less Music_Nothing), 187 SFX names over 188 ids, 251 cries", () => {
    // audio/music_pointers.asm 93 dba; audio/sfx_pointers.asm 188 dba, with
    // Sfx_GetEgg twice (:153-154), so 187 sfx keys, as in Brian's table.
    expect(Object.keys(audio.songs).length).toBe(92);
    expect(audio.songs.Music_Nothing).toBeUndefined();
    expect(audio.sfxOrder.length).toBe(188);
    expect(Object.keys(audio.sfx).length).toBe(187);
    expect(Object.keys(audio.cries).length).toBe(251);
    expect(Object.keys(audio.fanfares).sort()).toEqual(
      ["Sfx_CaughtMon", "Sfx_DexFanfare2049", "Sfx_DexFanfare5079", "Sfx_DexFanfare80109", "Sfx_Fanfare", "Sfx_Item"],
    );
    expect(bin.length).toBe(6 * BANK);
  });

  test("every header lands in a programs.bin bank, inside the $4000 window", () => {
    const headers = [
      ...Object.values(audio.songs),
      ...Object.values(audio.sfx),
      ...Object.values(audio.cries).map((c: any) => c.header),
    ] as { bank: number; address: number }[];
    for (const h of headers) {
      expect(audio.bankOrder).toContain(h.bank);
      expect(h.address).toBeGreaterThanOrEqual(0x4000);
      expect(h.address).toBeLessThan(0x8000);
    }
  });

  test("Music_NewBarkTown: 3 channels (audio/music/newbarktown.asm)", () => {
    const song = audio.songs.Music_NewBarkTown;
    expect(song).toBeDefined();
    const at = audio.bankOrder.indexOf(song.bank) * BANK + (song.address - BANK);
    // `channel 1..3` headers: dn (count-1)<<2, id-1 on the first, then 1, 2.
    expect([bin[at], bin[at + 3], bin[at + 6]]).toEqual([0x80, 0x01, 0x02]);
    expect(audio.mapSongs).toEqual({ NEW_BARK_TOWN: "Music_NewBarkTown" });
    expect(audio.musicOrder[0x3c]).toBe("Music_NewBarkTown");
  });

  test("cries: data/pokemon/cries.asm rows", () => {
    // mon_cry CRY_CHIKORITA, -16, 176 ; mon_cry CRY_CYNDAQUIL, 839, 128
    expect(audio.cries.CHIKORITA.pitch).toBe(0x10000 - 16);
    expect(audio.cries.CHIKORITA.length).toBe(176);
    expect(audio.cries.CYNDAQUIL.pitch).toBe(839);
    expect(audio.cries.CYNDAQUIL.length).toBe(128);
    expect(audio.cries.BAYLEEF.header).toEqual(audio.cries.CHIKORITA.header);
    expect(audio.cries.CYNDAQUIL.header).not.toEqual(audio.cries.CHIKORITA.header);
    expect(audio.cries.BULBASAUR.pitch).toBe(128);
  });

  test("wave samples and drumkits point at the symbols", () => {
    const [wb, wa] = gold!.manifest.symbols.WaveSamples!;
    expect(audio.waveBanks["1"]).toEqual({ bank: wb, address: wa, name: "WaveSamples" });
    expect(audio.drumkits.name).toBe("Drumkits");
  });
});
