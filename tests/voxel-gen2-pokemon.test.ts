// The Gen 2 (Gold) pokemon / icons / mon-sprite stages
// (voxelmon/import/gen2/pokemon.ts, monanim.ts, icons.ts): synthetic ROM
// buffers laid out per pret/pokegold's formats, then -- only when a verified
// Gold ROM is on this machine -- the stages against it, pinned to
// pokegold's data/pokemon/*.asm. No ROM bytes are ever committed.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GOLD_SHA1 } from "../voxelmon/import/env.ts";
import { GfxBin, TRANSPARENT } from "../voxelmon/import/gfx.ts";
import { Rom } from "../voxelmon/import/rom.ts";
import { Gen2Ctx } from "../voxelmon/import/gen2/ctx.ts";
import { extractIcons, extractMonSprites } from "../voxelmon/import/gen2/icons.ts";
import type { Gen2Manifest } from "../voxelmon/import/gen2/manifest.ts";
import {
  readMonAnimScript,
  readMonFrames,
  tileMap,
  writeMonAnimSheet,
} from "../voxelmon/import/gen2/monanim.ts";
import { extractPokemon, luaSeq, readEvosAttacks } from "../voxelmon/import/gen2/pokemon.ts";
import { extractSprites } from "../voxelmon/import/gen2/sprites.ts";

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

function manifest(symbols: Gen2Manifest["symbols"], consts: Record<string, unknown> = {}): Gen2Manifest {
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
      speciesOrder: ["BULBASAUR", "IVYSAUR", "VENUSAUR"],
      trainerClassOrder: [],
      moveOrder: ["POUND", "KARATE_CHOP", "DOUBLESLAP"],
      itemOrder: ["MASTER_BALL", "ULTRA_BALL", "BRIGHTPOWDER"],
      ...consts,
    },
  };
}

const ctxOf = (rom: FakeRom, m: Gen2Manifest) => new Gen2Ctx(new Rom(rom.data), m, new GfxBin());

// ---------------------------------------------------------------- synthetic

describe("gen2 luaSeq (LuaWriter isArray)", () => {
  test("dense -> array, trailing nil dropped, hole -> 1-based object", () => {
    expect(luaSeq(["A", "B"])).toEqual(["A", "B"]);
    expect(luaSeq(["A", undefined])).toEqual(["A"]);
    expect(luaSeq([undefined, undefined])).toEqual([]);
    expect(luaSeq([undefined, "B"])).toEqual({ "2": "B" });
  });
});

describe("gen2 readEvosAttacks (data/pokemon/evos_attacks.asm)", () => {
  test("every method, then level moves", () => {
    const rom = new FakeRom();
    rom.put(0x10, 0x4000, [
      1, 16, 2, // EVOLVE_LEVEL 16 -> IVYSAUR
      2, 3, 3, // EVOLVE_ITEM BRIGHTPOWDER -> VENUSAUR
      3, 0xff, 2, // EVOLVE_TRADE, no item
      4, 3, 1, // EVOLVE_HAPPINESS TR_NITE
      5, 20, 2, 3, // EVOLVE_STAT 20 ATK_LT_DEF -> VENUSAUR
      9, 7, 1, // unknown method
      0,
      1, 1, 7, 3, 12, 99, 0, // (1 POUND) (7 DOUBLESLAP) (12 move 99)
    ]);
    const ctx = ctxOf(rom, manifest({}));
    const { evolutions, levelMoves } = readEvosAttacks(ctx, 0x10, 0x4000);
    expect(evolutions).toEqual([
      { method: "EVOLVE_LEVEL", into: "IVYSAUR", level: 16 },
      { method: "EVOLVE_ITEM", into: "VENUSAUR", item: "BRIGHTPOWDER" },
      { method: "EVOLVE_TRADE", into: "IVYSAUR" },
      { method: "EVOLVE_HAPPINESS", into: "BULBASAUR", time: "NITE" },
      { method: "EVOLVE_STAT", level: 20, comparison: "ATK_LT_DEF", into: "VENUSAUR" },
      { method: 9, into: "BULBASAUR", parameter: 7 },
    ]);
    expect(levelMoves).toEqual([
      { level: 1, move: "POUND" },
      { level: 7, move: "DOUBLESLAP" },
      { level: 12, move: 99 },
    ]);
  });
});

describe("gen2 mon anim readers (MonAnim.lua / pic_animation.asm)", () => {
  test("readMonFrames dedupes bitmasks into 1-based slots; tileMap applies them", () => {
    const rom = new FakeRom();
    // frames list at $4000: two dw pointers (count = ($4004-$4000)/2 = 2)
    rom.word(0x10, 0x4000, 0x4004);
    rom.word(0x10, 0x4002, 0x4004);
    rom.put(0x10, 0x4004, [1, 30, 31]); // bitmask id 1, tiles for its 2 set bits
    // 5x5 pic: 4-byte bitmasks at $5000; id 1 -> bits 0 and 9
    rom.put(0x10, 0x5004, [0x01, 0x02, 0x00, 0x00]);
    const ctx = ctxOf(rom, manifest({}));
    const read = readMonFrames(ctx, 0x10, 0x4000, 0x10, 0x5000, 5)!;
    expect(read.bitmasks).toEqual([[1, 2, 0, 0]]);
    expect(read.frames).toEqual([
      { bitmask: 1, tiles: [30, 31] },
      { bitmask: 1, tiles: [30, 31] },
    ]);
    const map = tileMap({ tiles: 5, ...read }, 1)!;
    expect(map[0]).toBe(30);
    expect(map[9]).toBe(31);
    expect(map[1]).toBe(1);
    expect(tileMap({ tiles: 5, ...read }, 0)).toEqual([...Array(25).keys()]);
    expect(tileMap({ tiles: 5, ...read }, 3)).toBeUndefined();
    // a 4x4 pic has no bitmask width
    expect(readMonFrames(ctx, 0x10, 0x4000, 0x10, 0x5000, 4)).toBeUndefined();
  });

  test("readMonAnimScript stops at $ff; sheet is one column of count+1 pics", () => {
    const rom = new FakeRom();
    rom.put(0x10, 0x4000, [1, 8, 0xfe, 2, 0, 4, 0xfd, 1, 0xff]);
    rom.put(0x10, 0x4100, new Array(256).fill(0x11));
    const ctx = ctxOf(rom, manifest({}));
    expect(readMonAnimScript(ctx, 0x10, 0x4000)).toEqual([[1, 8], [0xfe, 2], [0, 4], [0xfd, 1]]);
    expect(readMonAnimScript(ctx, 0x10, 0x4100)).toBeUndefined();

    const stream = new Array(26 * 16).fill(0xff); // all black, 26 tiles
    const key = writeMonAnimSheet(ctx, stream, 5, [{ bitmask: 1, tiles: [25] }], [[1, 0, 0, 0]], "battle/anim/x.png");
    expect(key).toBe("battle/anim/x");
    expect(ctx.gfx.directory["battle/anim/x"]).toMatchObject({ w: 40, h: 80 });
    // a tile id past the stream fails the whole sheet
    expect(writeMonAnimSheet(ctx, stream, 5, [{ bitmask: 1, tiles: [26] }], [[1, 0, 0, 0]], "battle/anim/y.png")).toBeUndefined();
    expect(ctx.gfx.has("battle/anim/y")).toBe(false);
  });
});

describe("gen2 extractIcons + extractMonSprites (mon_icons.asm, sprite_mons.asm)", () => {
  test("icon sheets, species map, and SpriteMons rows pointing at them", () => {
    const rom = new FakeRom();
    rom.word(0x23, 0x4000, 0x4100); // IconPointers: ICON_NULL
    rom.word(0x23, 0x4002, 0x4180); // ICON_BULBASAUR
    rom.put(0x23, 0x4180, new Array(128).fill(0xff));
    rom.put(0x23, 0x4200, [1, 1, 0]); // MonMenuIcons (species 1..3)
    rom.put(0x05, 0x4000, [0, 2]); // SpriteMons row 1 = IVYSAUR
    const m = manifest(
      {
        IconPointers: [0x23, 0x4000],
        Icons: [0x23, 0x4000],
        MonMenuIcons: [0x23, 0x4200],
        SpriteMons: [0x05, 0x4000],
      },
      {
        iconOrder: ["ICON_NULL", "ICON_BULBASAUR"],
        spriteOrder: ["SPRITE_CHRIS", "UNUSED", "SPRITE_IVYSAUR"],
        spritePokemon: 2,
      },
    );
    const ctx = ctxOf(rom, m);
    const icons = extractIcons(ctx).icons as any;
    expect(icons.icons.ICON_BULBASAUR).toEqual({
      id: "ICON_BULBASAUR", index: 1, image: "icons/gen2/bulbasaur", width: 16, height: 32, frames: 2,
    });
    expect(icons.species).toEqual({ BULBASAUR: "ICON_BULBASAUR", IVYSAUR: "ICON_BULBASAUR", VENUSAUR: "ICON_NULL" });
    expect(icons.heldItem).toBeUndefined();
    const gfx = ctx.gfx.directory["icons/gen2/null"]!;
    expect(ctx.gfx.bytes()[gfx.off]).toBe(TRANSPARENT);

    const sprites: Record<string, unknown> = {};
    extractMonSprites(ctx, sprites);
    expect(sprites).toEqual({
      SPRITE_IVYSAUR: {
        id: "SPRITE_IVYSAUR", source: "ROM:SpriteMons[1]", image: "icons/gen2/bulbasaur", frames: 2,
        walker: false, spriteType: "POKEMON_SPRITE", palette: "PAL_OW_RED", paletteId: 0,
        species: "IVYSAUR", icon: "ICON_BULBASAUR",
      },
    });
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
if (!gold) console.log(`voxel-gen2-pokemon: skipping the Gold ROM checks — no verified ROM at ${GOLD_ROM}`);

describe.skipIf(!gold)("gen2 pokemon/icons against the Gold ROM", () => {
  const ctx = gold ? new Gen2Ctx(new Rom(gold.rom), gold.manifest, new GfxBin(), GOLD_SHA1) : null!;
  const pokemon = gold ? (extractPokemon(ctx).pokemon as any) : null;
  const icons = gold ? (extractIcons(ctx).icons as any) : null;
  const sprites = gold ? (extractMonSprites(ctx, extractSprites(ctx) as Record<string, unknown>) as any) : null;
  const species = gold ? gold.manifest.constants.speciesOrder : [];

  test("all 251 species (no EGG row), dex = index", () => {
    expect(species.length).toBe(251);
    for (let i = 0; i < species.length; i++) {
      expect(pokemon[species[i]!].dex).toBe(i + 1);
    }
    expect(pokemon.EGG).toBeUndefined();
  });

  test("BULBASAUR base data (base_stats/bulbasaur.asm)", () => {
    const b = pokemon.BULBASAUR;
    expect(b.name).toBe("BULBASAUR");
    expect(b.baseStats).toEqual({ hp: 45, attack: 49, defense: 49, speed: 45, specialAttack: 65, specialDefense: 65 });
    expect(b.types).toEqual(["GRASS", "POISON"]);
    expect([b.catchRate, b.baseExp, b.eggSteps, b.picSize]).toEqual([45, 64, 20, 5]);
    expect(b.growthRate).toBe("GROWTH_MEDIUM_SLOW");
    expect(b.eggGroups).toEqual(["EGG_MONSTER", "EGG_PLANT"]);
    expect(b.items).toEqual([]);
    expect(b.tmhm).toContain("SOLARBEAM");
    expect(b.tmhm).toContain("FLASH");
    expect(b.tmhm.length).toBe(23);
    expect(b.spriteFront).toBe("battle/front/bulbasaur");
    expect(b.spriteBack).toBe("battle/back/bulbasaur_back");
    expect(ctx.gfx.directory["battle/front/bulbasaur"]).toMatchObject({ w: 40, h: 40 });
    expect(ctx.gfx.directory["battle/back/bulbasaur_back"]).toMatchObject({ w: 48, h: 48 });
    expect(ctx.gfx.directory["battle/front/onix"]).toMatchObject({ w: 56, h: 56 });
  });

  test("evolutions and learnsets (evos_attacks.asm)", () => {
    expect(pokemon.CHIKORITA.evolutions).toEqual([{ method: "EVOLVE_LEVEL", into: "BAYLEEF", level: 16 }]);
    expect(pokemon.CHIKORITA.levelMoves).toContainEqual({ level: 8, move: "RAZOR_LEAF" });
    expect(pokemon.CHIKORITA.levelMoves.at(-1)).toEqual({ level: 50, move: "SOLARBEAM" });
    expect(pokemon.EEVEE.evolutions).toContainEqual({ method: "EVOLVE_HAPPINESS", into: "UMBREON", time: "NITE" });
    expect(pokemon.TYROGUE.evolutions[0]).toEqual({
      method: "EVOLVE_STAT", level: 20, comparison: "ATK_LT_DEF", into: "HITMONCHAN",
    });
    expect(pokemon.ONIX.evolutions).toEqual([{ method: "EVOLVE_TRADE", into: "STEELIX", item: "METAL_COAT" }]);
    expect(pokemon.CELEBI.evolutions).toEqual([]);
    expect(pokemon.tmhmMoves.length).toBe(57);
    expect(pokemon.tutorMoves).toBeUndefined();
    expect(pokemon.growthRates.GROWTH_MEDIUM_SLOW).toMatchObject({ numerator: 6, denominator: 5, squared: -15, linear: 100, constant: 140 });
  });

  test("Unown: 26 letters, species pics are letter A's", () => {
    const u = pokemon.UNOWN;
    expect(Object.keys(u.letters).length).toBe(26);
    expect(u.letters.Q).toEqual({ spriteFront: "battle/front/unown_q", spriteBack: "battle/back/unown_q" });
    expect(u.spriteFront).toBe("battle/front/unown_a");
    expect(ctx.gfx.directory["battle/front/unown_q"]).toMatchObject({ w: 40, h: 40 });
    expect(u.anim).toBeUndefined(); // Gold pics do not animate
  });

  test("icons and the mon-doll sprites", () => {
    expect(Object.keys(icons.icons).length).toBe(39);
    expect(icons.species.BULBASAUR).toBe("ICON_BULBASAUR");
    expect(icons.species.PIKACHU).toBe("ICON_PIKACHU");
    expect(icons.heldItem.image).toBe("icons/gen2/held_item_markers");
    expect(ctx.gfx.directory["icons/gen2/bulbasaur"]).toMatchObject({ w: 16, h: 32 });
    expect(sprites.SPRITE_BULBASAUR).toMatchObject({ species: "BULBASAUR", icon: "ICON_BULBASAUR", image: "icons/gen2/bulbasaur" });
    expect(sprites.SPRITE_LUGIA).toMatchObject({ species: "LUGIA", icon: "ICON_LUGIA" });
    const monSprites = Object.values(sprites).filter((s: any) => s.spriteType === "POKEMON_SPRITE");
    expect(monSprites.length).toBe(35); // SPRITE_UNOWN..SPRITE_HO_OH
  });
});
