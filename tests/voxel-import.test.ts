// Pocket Voxel importer invariants (docs/VOXEL.md §7.1). These assert Red
// ground truths against dist/voxelmon/gen/ — the POCKET3D_TEST_MAPS
// convention: when the ROM-derived dataset (or its inputs) is absent the
// suite skips with a printed reason; CI never sees ROM bytes.
//
// Pinned values cross-read from gen1recomp tests/content_red/facts.lua and
// data/generated/ (the parity reference).

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { missingInputReason, resolveEnv } from "../voxelmon/import/env.ts";

const env = resolveEnv();
const genReady = existsSync(join(env.genDir, "pokemon.json"));
const reason = genReady
  ? null
  : (missingInputReason(env) ??
    `dist/voxelmon/gen missing — run \`bun tools/voxel.ts import\` first`);
if (reason) console.log(`voxel-import: skipping — ${reason}`);

const json = async (name: string): Promise<any> =>
  await Bun.file(join(env.genDir, `${name}.json`)).json();

describe.skipIf(!genReady)("voxel importer dataset", () => {
  // Battle move animations (engine/battle/animations.asm): the composed
  // beams, blobs and projectiles, read out of the ROM's own tables. Pinned
  // against what pokered's data says those animations are.
  test("battle_anims: every move and misc animation, with its script", async () => {
    const a = await json("battle_anims");
    // 165 moves (NUM_ATTACKS) then the misc animations that share the table
    expect(Object.keys(a.anims).length).toBe(202);
    expect(a.subanims.length).toBe(86);
    expect(a.frameBlocks.length).toBe(122);
    expect(a.baseCoords.length).toBe(177);

    // TACKLE is the plain lunge: move the pic, then put it back.
    expect(a.anims.TACKLE).toEqual([
      { effect: "SE_MOVE_MON_HORIZONTALLY", sound: 73 },
      { effect: "SE_RESET_MON_POSITION", sound: null },
    ]);
    // THUNDERBOLT plays its subanimation twice off the second tileset.
    expect(a.anims.THUNDERBOLT).toEqual([
      { sub: 41, tileset: 1, delay: 1, sound: 85 },
      { sub: 41, tileset: 1, delay: 1, sound: 85 },
    ]);
    // HYPER_BEAM darkens the screen, spirals its balls inward, then flashes.
    const hyper = a.anims.HYPER_BEAM.map((r: any) => r.effect ?? `sub${r.sub}`);
    expect(hyper[0]).toBe("SE_DARK_SCREEN_PALETTE");
    expect(hyper).toContain("SE_SPIRAL_BALLS_INWARD");
    expect(hyper).toContain("SE_DARK_SCREEN_FLASH");
    // the misc animations ride the same table
    expect(a.anims.SHOWPIC_ANIM).toEqual([
      { effect: "SE_SHOW_ENEMY_MON_PIC", sound: null },
    ]);
    expect(a.anims.TOSS_ANIM[0].sub).toBe(6);
  });

  test("battle_anims: every id a script names resolves", async () => {
    const a = await json("battle_anims");
    const types = ["NORMAL", "HVFLIP", "HFLIP", "COORDFLIP", "REVERSE", "ENEMY"];
    for (const [name, rows] of Object.entries<any[]>(a.anims)) {
      for (const row of rows) {
        if (row.effect !== undefined) {
          expect(row.effect.startsWith("SE_")).toBe(true);
          continue;
        }
        expect(a.subanims[row.sub], `${name} subanim ${row.sub}`).toBeDefined();
        expect(a.tilesets[row.tileset], `${name} tileset ${row.tileset}`).toBeDefined();
        expect(row.delay).toBeLessThan(64);
      }
    }
    for (const sub of a.subanims) {
      expect(types).toContain(sub.type);
      for (const b of sub.blocks) {
        expect(a.frameBlocks[b.block]).toBeDefined();
        expect(a.baseCoords[b.base]).toBeDefined();
        expect(b.mode).toBeLessThanOrEqual(4);
      }
    }
    // Frame block tiles are OAM entries: an 8x8 tile at a signed offset.
    const tiles = a.frameBlocks.flat();
    expect(tiles.length).toBeGreaterThan(500);
    for (const t of tiles.slice(0, 200)) {
      expect(t.tile).toBeLessThan(0x100);
      expect(t.attrs & ~0xf0).toBe(0); // only PAL/PRIO/XFLIP/YFLIP bits
    }
  });

  test("battle_anims: three tilesets over two sheets", async () => {
    const a = await json("battle_anims");
    const gfx = await json("gfx");
    expect(a.tilesets.length).toBe(3);
    // the third is the first sheet again, with fewer tiles loaded
    expect(a.tilesets[2].gfx).toBe(a.tilesets[0].gfx);
    expect(a.tilesets[2].tiles).toBeLessThan(a.tilesets[0].tiles);
    for (const ts of a.tilesets) {
      const sheet = gfx[ts.gfx] ?? gfx.directory?.[ts.gfx];
      expect(sheet, `gfx entry for ${ts.gfx}`).toBeDefined();
      // 16 tiles to a row, 8px tiles. A shared sheet is as tall as its
      // BIGGEST user (tileset 2 reads the first 64 of sheet 0's 79).
      expect(sheet.w).toBe(128);
      expect(sheet.h).toBeGreaterThanOrEqual(Math.ceil(ts.tiles / 16) * 8);
      expect(sheet.h % 8).toBe(0);
    }
  });

  test("pokemon: 151 species, starters and Pikachu pinned", async () => {
    const pokemon = await json("pokemon");
    expect(Object.keys(pokemon).length).toBe(151);
    expect(pokemon.PIKACHU).toBeDefined();
    expect(pokemon.PIKACHU.dex).toBe(25);
    expect(pokemon.PIKACHU.baseStats).toEqual({
      hp: 35,
      attack: 55,
      defense: 30,
      speed: 90,
      special: 50,
    });
    // facts.lua starters — dex numbers + types
    expect(pokemon.BULBASAUR.dex).toBe(1);
    expect(pokemon.BULBASAUR.types).toEqual(["GRASS", "POISON"]);
    expect(pokemon.CHARMANDER.dex).toBe(4);
    expect(pokemon.CHARMANDER.types).toEqual(["FIRE"]);
    expect(pokemon.SQUIRTLE.dex).toBe(7);
    expect(pokemon.SQUIRTLE.types).toEqual(["WATER"]);
    // Red keeps Mew outside BaseStats (MewBaseStats symbol) — dex 151
    expect(pokemon.MEW.dex).toBe(151);
  });

  test("maps: PALLET_TOWN 10x9 with the facts.lua sign and door warp", async () => {
    const maps = await json("maps");
    const pallet = maps.PALLET_TOWN;
    expect(pallet.width).toBe(10);
    expect(pallet.height).toBe(9);
    expect(pallet.blocks.length).toBe(90);
    expect(pallet.connections.north.map).toBe("ROUTE_1");
    expect(pallet.connections.south.map).toBe("ROUTE_21");
    // facts.lua pallet.oakSign / doorWarp
    expect(pallet.signs).toContainEqual({ x: 13, y: 13, text: "TEXT_PALLETTOWN_OAKSLAB_SIGN" });
    expect(pallet.warps[0]).toEqual({ x: 5, y: 5, destMap: "REDS_HOUSE_1F", destWarp: 1 });
    // facts.lua map dimensions (cells = 2x blocks)
    expect([maps.VIRIDIAN_CITY.width, maps.VIRIDIAN_CITY.height]).toEqual([20, 18]);
    expect([maps.OAKS_LAB.width, maps.OAKS_LAB.height]).toEqual([5, 6]);
  });

  test("tilesets: OVERWORLD walkable list and grass tile", async () => {
    const tilesets = await json("tilesets");
    const overworld = tilesets.OVERWORLD;
    expect(overworld.walkable.length).toBeGreaterThan(0);
    expect(overworld.walkable).toContain(0);
    expect(overworld.grassTile).toBe(82);
    expect(overworld.blocks.length).toBe(128);
    expect(overworld.blocks[0].length).toBe(16);
    expect(overworld.animation).toBe("TILEANIM_WATER_FLOWER");
  });

  test("moves: 165 moves, POUND pinned", async () => {
    const moves = await json("moves");
    expect(Object.keys(moves).length).toBe(165);
    expect(moves.POUND.power).toBe(40);
    expect(moves.POUND.accuracy).toBe(100);
    expect(moves.POUND.pp).toBe(35);
    expect(moves.POUND.type).toBe("NORMAL");
    expect(moves.POUND.effect).toBe("NO_ADDITIONAL_EFFECT");
  });

  test("type chart: multipliers are the raw x10 bytes", async () => {
    const chart = await json("type_chart");
    // TypeEffects stores only non-neutral matchups; every stored byte is the
    // x10 value (0 immune, 5 not-very, 20 super) — never 0.5/2 floats.
    for (const matchup of chart.matchups) {
      expect([0, 5, 20]).toContain(matchup.multiplier);
    }
    expect(chart.matchups).toContainEqual({ attacker: "WATER", defender: "FIRE", multiplier: 20 });
    expect(chart.matchups).toContainEqual({ attacker: "NORMAL", defender: "GHOST", multiplier: 0 });
    expect(chart.names.length).toBe(16);
  });

  test("items: key items, TM pricing, the facts.lua HM set", async () => {
    const items = await json("items");
    expect(items.BICYCLE.keyItem).toBe(true);
    expect(items.TM_MEGA_PUNCH.price).toBe(3000);
    expect(items.TM_MEGA_PUNCH.machine).toEqual({ kind: "TM", number: 1, move: "MEGA_PUNCH" });
    for (const hm of ["CUT", "FLY", "SURF", "STRENGTH", "FLASH"]) {
      expect(items[`HM_${hm}`].machine.kind).toBe("HM");
    }
  });

  test("encounters: ROUTE_1 grass table; Pallet Town has none", async () => {
    const encounters = await json("encounters");
    expect(encounters.ROUTE_1.grass.rate).toBe(25);
    expect(encounters.ROUTE_1.grass.slots.length).toBe(10);
    expect(encounters.ROUTE_1.grass.slots[0]).toEqual({ level: 3, species: "PIDGEY" });
    expect("PALLET_TOWN" in encounters).toBe(false);
  });

  test("trainers: OPP_CHIEF carries the manifest override party", async () => {
    const trainers = await json("trainers");
    expect(trainers.OPP_CHIEF.parties.length).toBe(1);
    expect(trainers.OPP_CHIEF.parties[0].length).toBe(5);
    expect(trainers.OPP_CHIEF.parties[0][0]).toEqual({ level: 41, species: "MACHOKE" });
  });

  test("sprites + font: walker sheets and glyph bases", async () => {
    const sprites = await json("sprites");
    expect(sprites.SPRITE_RED.walker).toBe(true);
    expect(sprites.SPRITE_RED.frames).toBe(6);
    expect(sprites.SPRITE_RED_BIKE.walker).toBe(true);
    const font = await json("font");
    expect(font.mainBase).toBe(0x80);
    expect(font.extraBase).toBe(0x60);
    expect(font.glyphsPerRow).toBe(16);
  });

  test("text: decoded dialogue matches known strings", async () => {
    const text = await json("text");
    expect(text._AbraDexEntry).toContain("TELEPORT");
    const headers = await json("trainer_headers");
    // dense-from-1 header tables become arrays (SCHEMA.md normalization)
    expect(Array.isArray(headers.AgathasRoom)).toBe(true);
  });

  test("gfx.bin: directory covers the blob, indexed pixels only", async () => {
    const gfx = await json("gfx");
    const bin = new Uint8Array(await Bun.file(join(env.genDir, "gfx.bin")).arrayBuffer());
    let extent = 0;
    for (const entry of Object.values<any>(gfx)) {
      extent = Math.max(extent, entry.off + entry.w * entry.h);
    }
    expect(extent).toBe(bin.length);
    expect(gfx["tilesets/overworld"]).toMatchObject({ w: 128, h: 48 });
    expect(gfx["fonts/font"]).toMatchObject({ w: 128, h: 64 });
    expect(gfx["sprites/red"]).toMatchObject({ w: 16, h: 96, walker: true });
    // PIKACHU frontSize is 5 tiles -> 40x40 px
    expect(gfx["battle/front/pikachu"]).toMatchObject({ w: 40, h: 40 });
    // 1 byte/px: 0..3 GB shade or 0xff transparent, nothing else
    for (const value of bin) {
      if (value > 3 && value !== 0xff) {
        throw new Error(`gfx.bin holds non-indexed byte ${value}`);
      }
    }
  });
});
