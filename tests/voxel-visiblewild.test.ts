// VISIBLE WILD and the gear's ENHANCEMENTS app for Red / Blue / Yellow
// (voxelmon/game/visiblewild.ts, world/wildmons.ts, ui/gear/apps/
// enhancements.ts, ui/extras_layout.ts).
//
// Layer 1 (ROM-free): the setting, the counts, the slot weights, the cell
// rules on a hand-made map, the sprite choice.
// Layer 2 (gated on dist/voxelmon/gen): the real overworld -- spawns on the
// encounter tiles only, the counts, the touch's battle, no step rolls,
// NONE, the safari zone, water, caves, links -- and the gear app.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import type { WildBattle } from "../voxelmon/game/battle/battle.ts";
import { SafariBattle } from "../voxelmon/game/battle/safari.ts";
import { loadRuntimeData, REQUIRED_MODULES, type VoxelmonData } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { seededRng, seqRng } from "../voxelmon/game/rng.ts";
import { ENCOUNTER_BUCKETS } from "../voxelmon/game/rules/encounter.ts";
import {
  baseCount, CELL_LAND, CELL_NONE, CELL_WATER, classifyCells, iconFamily, MAX_WILD, MON_PARTY_ICONS, NEAR,
  pickSlot, visibleWildMode, visibleWildOn, WINDOW_X, WINDOW_Y, wildSprite, wildTarget, type WildMapLike,
} from "../voxelmon/game/visiblewild.ts";
import { WildMon } from "../voxelmon/game/world/wildmons.ts";
import {
  ENHANCEMENT_GEAR, ENHANCEMENT_ROWS, enhancementDefs, enhancementIndex, OPTION_PAGES, SPEED_ROW,
  VISIBLE_WILD_ROW,
} from "../voxelmon/game/ui/extras_layout.ts";
import { OptionsMenuState } from "../voxelmon/game/ui/optionsmenu.ts";
import { drawKantoGear, gearTabs, gearTouchDown, gearTouchUp } from "../voxelmon/game/ui/kantogear.ts";
import { availableApps, homePill } from "../voxelmon/game/ui/gear/apps/home.ts";
import { gearAbout, gearLabel } from "../voxelmon/game/ui/gear/apps/enhancements.ts";
import { appOf } from "../voxelmon/game/ui/gear/model.ts";
import { TILE_H, TILE_W, wrap } from "../voxelmon/game/ui/gear/draw.ts";
import { encodeGlyphs } from "../voxelmon/game/ui/tiles.ts";

const root = join(import.meta.dir, "..");
const genDir = join(root, "dist/voxelmon/gen");
const hasGen = REQUIRED_MODULES.every((m) => existsSync(join(genDir, `${m}.json`)));
const data: VoxelmonData | null = hasGen ? await loadRuntimeData(genDir) : null;
const yellowDir = join(root, "dist/voxelmon/yellow/gen");
const hasYellow = REQUIRED_MODULES.every((m) => existsSync(join(yellowDir, `${m}.json`)));

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

class MenuHost extends RecorderHost {
  saved: string | undefined;
  pic(): void {}
  picHide(): void {}
  saveWrite(text: string): void { this.saved = text; }
  saveData(): string | undefined { return this.saved; }
}

function makeGame(d: VoxelmonData = data!): VoxelmonGame {
  const game = new VoxelmonGame(d, new MenuHost(), 1);
  game.newGame();
  game.closeToOverworld();
  return game;
}

type Ow = VoxelmonGame["overworld"];

/** Every cell of a kind on the current map. */
function cellsOf(ow: Ow, kind: number): [number, number][] {
  const kinds = ow.wild.cellKinds();
  const out: [number, number][] = [];
  for (let y = 0; y < ow.map.heightCells; y++) {
    for (let x = 0; x < ow.map.widthCells; x++) if (kinds[y * ow.map.widthCells + x] === kind) out.push([x, y]);
  }
  return out;
}

/** The cell of a kind with the most cells of that kind in the spawn window. */
function busiest(ow: Ow, kind: number): { at: [number, number]; n: number } {
  const kinds = ow.wild.cellKinds();
  const w = ow.map.widthCells;
  let best: { at: [number, number]; n: number } = { at: [0, 0], n: -1 };
  for (const [cx, cy] of cellsOf(ow, kind)) {
    let n = 0;
    for (let y = Math.max(1, cy - WINDOW_Y); y <= Math.min(ow.map.heightCells - 2, cy + WINDOW_Y); y++) {
      for (let x = Math.max(1, cx - WINDOW_X); x <= Math.min(w - 2, cx + WINDOW_X); x++) if (kinds[y * w + x] === kind) n++;
    }
    if (n > best.n) best = { at: [cx, cy], n };
  }
  return best;
}

/** Stand the player on a cell (no step, nothing triggered). */
function standAt(ow: Ow, x: number, y: number): void {
  const p = ow.player;
  p.cellX = x; p.cellY = y; p.px = x * 16; p.py = y * 16; p.moving = false;
}

function battleOf(game: VoxelmonGame): WildBattle | undefined {
  const top = (game as unknown as { stack: { kind: string; battle?: WildBattle }[] }).stack.at(-1);
  return top?.kind === "battle" ? top.battle : undefined;
}

// ---------------------------------------------------------------------------
// the setting
// ---------------------------------------------------------------------------

describe("VISIBLE WILD: the setting", () => {
  test("OFF unless set; SOME and MANY are on", () => {
    expect(visibleWildMode(undefined)).toBe("off");
    expect(visibleWildMode({ options: {} })).toBe("off");
    expect(visibleWildMode({ options: { visibleWild: "lots" } })).toBe("off");
    expect(visibleWildMode({ options: { visibleWild: "some" } })).toBe("some");
    expect(visibleWildOn({ options: { visibleWild: "many" } })).toBe(true);
    expect(visibleWildOn({ options: { visibleWild: "off" } })).toBe(false);
  });

  test("the row: OFF / SOME / MANY on the save key visibleWild, last on ENHANCEMENTS", () => {
    expect(ENHANCEMENT_ROWS.at(-1)).toBe(VISIBLE_WILD_ROW);
    expect(VISIBLE_WILD_ROW.key).toBe("visibleWild");
    expect(VISIBLE_WILD_ROW.choices).toEqual(["OFF", "SOME", "MANY"]);
    expect(VISIBLE_WILD_ROW.values).toEqual(["off", "some", "many"]);
    const o: Record<string, unknown> = {};
    expect(enhancementIndex(o, VISIBLE_WILD_ROW)).toBe(0);
    o.visibleWild = "many";
    expect(enhancementIndex(o, VISIBLE_WILD_ROW)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// counts
// ---------------------------------------------------------------------------

describe("VISIBLE WILD: how many", () => {
  test("SOME is 2-3 and MANY 5-6 round the player; a small patch holds fewer", () => {
    for (const n of [40, 60, 120, 195]) {
      expect(baseCount("some", n)).toBeGreaterThanOrEqual(2);
      expect(baseCount("some", n)).toBeLessThanOrEqual(3);
      expect(baseCount("many", n)).toBeGreaterThanOrEqual(5);
      expect(baseCount("many", n)).toBeLessThanOrEqual(6);
    }
    expect(baseCount("some", 3)).toBe(1);
    expect(baseCount("many", 3)).toBe(2);
    expect(baseCount("many", 0)).toBe(0);
    expect(baseCount("off", 195)).toBe(0);
    // counts grow with the grass, never shrink
    for (const m of ["some", "many"] as const) {
      for (let n = 1; n < 200; n++) expect(baseCount(m, n)).toBeGreaterThanOrEqual(baseCount(m, n - 1));
    }
  });

  test("WILD ENCOUNTERS scales it: NONE none, LESS half, MORE half again; capped", () => {
    expect(wildTarget("many", "normal", 120)).toBe(6);
    expect(wildTarget("many", "none", 120)).toBe(0);
    expect(wildTarget("many", "less", 120)).toBe(3);
    expect(wildTarget("many", "more", 120)).toBe(MAX_WILD); // 9, held at 8
    expect(wildTarget("some", "more", 120)).toBe(5);
    expect(wildTarget("some", "less", 120)).toBe(2);
    expect(wildTarget("some", "less", 3)).toBe(1); // never rounded away
    // the entity slots the map's people leave
    expect(wildTarget("many", "normal", 120, 2)).toBe(2);
    expect(wildTarget("many", "normal", 120, 0)).toBe(0);
    expect(wildTarget("off", "more", 120)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// which mon
// ---------------------------------------------------------------------------

describe("VISIBLE WILD: the table and its slots", () => {
  const slots = Array.from({ length: 10 }, (_, i) => ({ species: `S${i}`, level: i + 2 }));
  const table = { rate: 25, slots };

  test("every byte once: each slot as often as the cart's weights", () => {
    const rng = seqRng(...Array.from({ length: 256 }, (_, i) => i));
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 256; i++) {
      const s = pickSlot(table, rng)!;
      counts[slots.findIndex((x) => x.species === s.species)]++;
    }
    const widths = ENCOUNTER_BUCKETS.map((b, i) => b - (i ? ENCOUNTER_BUCKETS[i - 1]! : 0));
    expect(widths).toEqual([51, 51, 39, 25, 25, 25, 13, 13, 11, 3]);
    expect(counts).toEqual(widths);
  });

  test("exactly the slot's species and level; a seeded run lands near the weights", () => {
    const rng = seededRng(7);
    const counts = new Array(10).fill(0);
    const N = 25600;
    for (let i = 0; i < N; i++) {
      const s = pickSlot(table, rng)!;
      const k = slots.findIndex((x) => x.species === s.species);
      expect(s.level).toBe(slots[k]!.level);
      counts[k]++;
    }
    const widths = ENCOUNTER_BUCKETS.map((b, i) => b - (i ? ENCOUNTER_BUCKETS[i - 1]! : 0));
    counts.forEach((c, i) => expect(Math.abs(c / N - widths[i]! / 256)).toBeLessThan(0.01));
  });

  test("no table, no mon", () => {
    expect(pickSlot(null, seqRng(0))).toBeNull();
    expect(pickSlot({ rate: 0, slots: [] }, seqRng(0))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// where: a hand-made map
// ---------------------------------------------------------------------------

/** g grass, . floor, # wall, w water, D a door (a warp on a floor cell). */
function fakeMap(rows: string[], opts: { index?: number; tileset?: string } = {}): WildMapLike {
  const at = (x: number, y: number) => rows[y]?.[x] ?? "#";
  return {
    widthCells: rows[0]!.length,
    heightCells: rows.length,
    def: { index: opts.index ?? 12, tileset: opts.tileset ?? "OVERWORLD" },
    isGrassCell: (x, y) => at(x, y) === "g",
    isWaterCell: (x, y) => at(x, y) === "w",
    isWalkableCell: (x, y) => "g.D".includes(at(x, y)),
    isWarpTileCell: (x, y) => at(x, y) === "D",
    warpAtCell: (x, y) => (at(x, y) === "D" ? {} : undefined),
  };
}

describe("VISIBLE WILD: the cells a mon may stand on", () => {
  const grassOnly = { grass: { rate: 25, slots: [{ species: "PIDGEY", level: 3 }] } };

  test("grass only, never the edge row, a door or beside one, or a one-wide lane", () => {
    const m = fakeMap([
      "##########",
      "#gggggg..#",
      "#gggggg..#",
      "#ggDggg..#",
      "#gggggg..#",
      "####g#####",
      "####g#####",
      "##########",
    ]);
    const k = classifyCells(m, grassOnly);
    const kind = (x: number, y: number) => k[y * m.widthCells + x];
    expect(kind(1, 1)).toBe(CELL_LAND);
    expect(kind(7, 1)).toBe(CELL_NONE); // floor, not grass
    expect(kind(3, 3)).toBe(CELL_NONE); // the door
    for (const [x, y] of [[2, 3], [4, 3], [3, 2], [3, 4]]) expect(kind(x!, y!)).toBe(CELL_NONE); // beside it
    expect(kind(4, 5)).toBe(CELL_NONE); // the lane south
    expect(kind(4, 6)).toBe(CELL_NONE); // and its dead end
    // every LAND cell is grass
    for (let y = 0; y < m.heightCells; y++) for (let x = 0; x < m.widthCells; x++) {
      if (kind(x, y) === CELL_LAND) expect(m.isGrassCell(x, y)).toBe(true);
    }
  });

  test("a map without a table (a town's grass) has no cells at all", () => {
    const m = fakeMap(["#####", "#ggg#", "#ggg#", "#ggg#", "#####"]);
    expect(classifyCells(m, undefined).every((v) => v === CELL_NONE)).toBe(true);
    expect(classifyCells(m, { grass: { rate: 0, slots: [] } }).every((v) => v === CELL_NONE)).toBe(true);
  });

  test("a cave rolls on every floor tile; the FOREST tileset only on its grass", () => {
    const rows = ["#######", "#.....#", "#.ggg.#", "#.....#", "#######"];
    const indoor = { firstIndoorMap: 37, excludedTileset: "FOREST" };
    const cave = classifyCells(fakeMap(rows, { index: 59, tileset: "CAVERN" }), grassOnly, indoor);
    expect(cave[1 * 7 + 1]).toBe(CELL_LAND);
    expect(cave[2 * 7 + 3]).toBe(CELL_LAND);
    const forest = classifyCells(fakeMap(rows, { index: 51, tileset: "FOREST" }), grassOnly, indoor);
    expect(forest[1 * 7 + 1]).toBe(CELL_NONE);
    expect(forest[2 * 7 + 3]).toBe(CELL_LAND);
  });

  test("water only with a surf table", () => {
    const rows = ["#######", "#wwwww#", "#wwwww#", "#wwwww#", "#######"];
    expect(classifyCells(fakeMap(rows), grassOnly).every((v) => v === CELL_NONE)).toBe(true);
    const k = classifyCells(fakeMap(rows), { water: { rate: 5, slots: [{ species: "TENTACOOL", level: 5 }] } });
    expect(k[2 * 7 + 3]).toBe(CELL_WATER);
  });
});

// ---------------------------------------------------------------------------
// the sprite
// ---------------------------------------------------------------------------

describe("VISIBLE WILD: the sprite", () => {
  const dex = (n: number) => ({ dex: n });
  const pokemon = { BULBASAUR: dex(1), PIDGEY: dex(16), RATTATA: dex(19), PIKACHU: dex(25), RAICHU: dex(26), CLEFAIRY: dex(35), VOLTORB: dex(100), CATERPIE: dex(10), SEEL: dex(86), TENTACOOL: dex(72) };
  const red = {
    pokemon,
    sprites: Object.fromEntries(["SPRITE_MONSTER", "SPRITE_BIRD", "SPRITE_FAIRY", "SPRITE_SEEL", "SPRITE_POKE_BALL", "SPRITE_FOSSIL"].map((s) => [s, {}])),
  };
  const yellow = { pokemon, sprites: { ...red.sprites, SPRITE_PIKACHU: {}, SPRITE_CLEFAIRY: {}, SPRITE_BULBASAUR: {} } };

  test("the ROM's menu icon families, one letter a species", () => {
    expect(MON_PARTY_ICONS.length).toBe(151);
    expect(iconFamily(red, "PIDGEY")).toBe("D");
    expect(iconFamily(red, "RATTATA")).toBe("Q");
    expect(iconFamily(red, "PIKACHU")).toBe("F"); // Red and Blue: ICON_FAIRY
    expect(iconFamily(yellow, "PIKACHU")).toBe("P"); // Yellow: ICON_PIKACHU
    expect(iconFamily(yellow, "RAICHU")).toBe("P");
  });

  test("a species' own sheet first, then its icon family's sheet, the generic mon for art the pak lacks", () => {
    expect(wildSprite(red, "PIDGEY")).toBe("SPRITE_BIRD");
    expect(wildSprite(red, "VOLTORB")).toBe("SPRITE_POKE_BALL");
    expect(wildSprite(red, "TENTACOOL")).toBe("SPRITE_SEEL");
    expect(wildSprite(red, "SEEL")).toBe("SPRITE_SEEL");
    expect(wildSprite(red, "CLEFAIRY")).toBe("SPRITE_FAIRY");
    expect(wildSprite(yellow, "CLEFAIRY")).toBe("SPRITE_CLEFAIRY");
    expect(wildSprite(yellow, "PIKACHU")).toBe("SPRITE_PIKACHU");
    expect(wildSprite(red, "PIKACHU")).toBe("SPRITE_FAIRY");
    // BUG / QUADRUPED: their icon art is not in the pak
    expect(wildSprite(red, "CATERPIE")).toBe("SPRITE_MONSTER");
    expect(wildSprite(red, "RATTATA")).toBe("SPRITE_MONSTER");
    // ...unless the pak carries a sheet for it
    const withIcons = { ...red, atlas: { sprites: { monster: 4, bird: 8, icon_bug: 90, icon_quadruped: 91 } } };
    expect(wildSprite(withIcons, "CATERPIE")).toBe("SPRITE_ICON_BUG");
    expect(wildSprite(withIcons, "RATTATA")).toBe("SPRITE_ICON_QUADRUPED");
  });

  test.skipIf(!hasGen)("every wild species in the real tables gets a sheet the dataset has", () => {
    for (const enc of Object.values(data!.encounters ?? {})) {
      for (const g of [enc.grass, enc.water]) {
        for (const s of g?.slots ?? []) expect(data!.sprites?.[wildSprite(data! as never, s.species)]).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// the overworld (the Red dataset)
// ---------------------------------------------------------------------------

describe("VISIBLE WILD in the overworld", () => {
  test.skipIf(!hasGen)("OFF: nothing spawns and the step roll is the cart's", () => {
    const game = makeGame();
    const ow = game.overworld;
    ow.setMap("ROUTE_1", 9, 27, "up");
    for (let i = 0; i < 300; i++) game.tick(0);
    expect(ow.wild.mons.length).toBe(0);
    expect(ow.wild.suppressesRoll()).toBe(false);
  });

  test.skipIf(!hasGen)("they spawn only on the map's encounter tiles, and stay on them", () => {
    const game = makeGame();
    game.save.options.visibleWild = "many";
    const ow = game.overworld;
    ow.setMap("ROUTE_1", 9, 27, "up");
    const { at } = busiest(ow, CELL_LAND);
    standAt(ow, at[0], at[1]);
    let seen = 0;
    let walked = false;
    const from = new Map<WildMon, string>();
    for (let i = 0; i < 3000; i++) {
      game.tick(0);
      expect(game.stackKinds().at(-1)).toBe("overworld");
      for (const m of ow.wild.mons) {
        seen++;
        const was = from.get(m);
        if (was === undefined) from.set(m, `${m.cellX},${m.cellY}`);
        else if (was !== `${m.cellX},${m.cellY}`) walked = true;
        for (const [x, y] of [[m.cellX, m.cellY], [m.targetX ?? m.cellX, m.targetY ?? m.cellY]] as const) {
          expect(ow.map.isGrassCell(x, y)).toBe(true);
          expect(ow.map.warpAtCell(x, y)).toBeUndefined();
          expect(ow.wild.cellKinds()[y * ow.map.widthCells + x]).toBe(CELL_LAND);
        }
        // and every one of them a slot of ROUTE_1's land table
        const slots = data!.encounters.ROUTE_1!.grass!.slots;
        expect(slots.some((s) => s.species === m.species && s.level === m.level)).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(walked).toBe(true); // they wander, on grass only
  });

  test.skipIf(!hasGen)("never within NEAR cells of the player when they appear, never on a person", () => {
    const game = makeGame();
    game.save.options.visibleWild = "many";
    const ow = game.overworld;
    ow.setMap("VIRIDIAN_FOREST", 1, 1, "down");
    const { at } = busiest(ow, CELL_LAND);
    standAt(ow, at[0], at[1]);
    game.tick(0);
    expect(ow.wild.mons.length).toBeGreaterThan(0);
    for (const m of ow.wild.mons) {
      expect(Math.max(Math.abs(m.cellX - at[0]), Math.abs(m.cellY - at[1]))).toBeGreaterThanOrEqual(NEAR);
      for (const n of ow.npcs) {
        if ((n as { hidden?: boolean }).hidden) continue;
        expect(Math.max(Math.abs(n.cellX - m.cellX), Math.abs(n.cellY - m.cellY))).toBeGreaterThan(1);
      }
    }
  });

  test.skipIf(!hasGen)("counts per setting: SOME 2-3, MANY 5-6, LESS / MORE scale them, NONE none", () => {
    const count = (vw: string, cheat?: string): number => {
      const game = makeGame();
      game.save.options.visibleWild = vw;
      if (cheat) game.save.options.wildEncounters = cheat;
      const ow = game.overworld;
      ow.setMap("VIRIDIAN_FOREST", 1, 1, "down");
      const { at, n } = busiest(ow, CELL_LAND);
      expect(n).toBeGreaterThanOrEqual(60);
      standAt(ow, at[0], at[1]);
      game.tick(0);
      return ow.wild.mons.length;
    };
    const some = count("some");
    expect(some).toBeGreaterThanOrEqual(2);
    expect(some).toBeLessThanOrEqual(3);
    const many = count("many");
    expect(many).toBeGreaterThanOrEqual(5);
    expect(many).toBeLessThanOrEqual(6);
    expect(count("many", "less")).toBe(3);
    expect(count("many", "more")).toBeGreaterThan(many);
    expect(count("many", "none")).toBe(0);
    expect(count("off")).toBe(0);
  });

  test.skipIf(!hasGen)("WILD ENCOUNTERS NONE: no visible spawns either, and still no step battles", () => {
    const game = makeGame();
    game.save.options.visibleWild = "many";
    game.save.options.wildEncounters = "none";
    const ow = game.overworld;
    ow.setMap("ROUTE_1", 9, 27, "up");
    for (let i = 0; i < 600; i++) game.tick(0);
    expect(ow.wild.mons.length).toBe(0);
    expect(ow.wild.active()).toBe(false);
  });

  test.skipIf(!hasGen)("no random encounters while ON: a thousand step rolls on grass at MORE, no battle", () => {
    const game = makeGame();
    game.save.options.visibleWild = "some";
    game.save.options.wildEncounters = "more";
    const ow = game.overworld;
    ow.setMap("ROUTE_1", 9, 27, "up");
    const grass = cellsOf(ow, CELL_LAND);
    standAt(ow, grass[0]![0], grass[0]![1]);
    const before = ow.encounterCount;
    for (let i = 0; i < 1000; i++) ow.onStepComplete();
    expect(ow.encounterCount).toBe(before);
    expect(game.stackKinds()).not.toContain("battle");
    // and OFF again, the same rolls find battles
    game.save.options.visibleWild = "off";
    for (let i = 0; i < 200 && ow.encounterCount === before; i++) ow.onStepComplete();
    expect(ow.encounterCount).toBeGreaterThan(before);
  });

  /** A mon placed `dx` cells right of the player. */
  function placeMon(ow: Ow, species: string, level: number, dx: number, dy = 0): WildMon {
    const p = ow.player;
    const m = new WildMon(species, level, "SPRITE_BIRD", CELL_LAND, p.cellX + dx, p.cellY + dy, "left", 9999, 9999, 0);
    ow.wild.mons.push(m);
    return m;
  }

  /** A grass cell with grass two cells to its right. */
  function grassRow(ow: Ow): [number, number] {
    for (const [x, y] of cellsOf(ow, CELL_LAND)) {
      const k = ow.wild.cellKinds();
      const w = ow.map.widthCells;
      if (k[y * w + x + 1] === CELL_LAND && k[y * w + x + 2] === CELL_LAND && ow.map.isWalkableCell(x + 1, y)) return [x, y];
    }
    throw new Error("no grass row");
  }

  test.skipIf(!hasGen)("walking into one starts a wild battle with exactly that species and level; it is gone", () => {
    const game = makeGame();
    game.save.options.visibleWild = "some";
    const ow = game.overworld;
    ow.setMap("ROUTE_1", 9, 27, "up");
    const [x, y] = grassRow(ow);
    standAt(ow, x, y);
    ow.player.facing = "right";
    game.tick(0); // the first fill
    ow.wild.mons.length = 0;
    const m = placeMon(ow, "RATTATA", 4, 1);
    let b: WildBattle | undefined;
    for (let i = 0; i < 60 && !b; i++) { game.tick(VOX_BTN.right); b = battleOf(game); }
    expect(b).toBeTruthy();
    expect(b!.enemy.mon.species).toBe("RATTATA");
    expect(b!.enemy.mon.level).toBe(4);
    expect(b instanceof SafariBattle).toBe(false);
    expect(ow.wild.mons).not.toContain(m);
    expect(ow.wild.battles).toBe(1);
    expect(ow.wild.lastBattle).toEqual({ species: "RATTATA", level: 4 });
  });

  test.skipIf(!hasGen)("one walking into the player is a battle too; so is A facing one", () => {
    const game = makeGame();
    game.save.options.visibleWild = "some";
    const ow = game.overworld;
    ow.setMap("ROUTE_1", 9, 27, "up");
    const [x, y] = grassRow(ow);
    standAt(ow, x, y);
    game.tick(0);
    ow.wild.mons.length = 0;
    // it steps left, into the player
    const m = placeMon(ow, "PIDGEY", 5, 1);
    m.facing = "left"; m.targetX = x; m.targetY = y; m.moving = true; m.progress = 0;
    let b: WildBattle | undefined;
    for (let i = 0; i < 40 && !b; i++) { game.tick(0); b = battleOf(game); }
    expect(b?.enemy.mon.species).toBe("PIDGEY");
    expect(b?.enemy.mon.level).toBe(5);

    const g2 = makeGame();
    g2.save.options.visibleWild = "some";
    const o2 = g2.overworld;
    o2.setMap("ROUTE_1", 9, 27, "up");
    standAt(o2, x, y);
    o2.player.facing = "right";
    g2.tick(0);
    o2.wild.mons.length = 0;
    placeMon(o2, "RATTATA", 3, 1);
    g2.tick(VOX_BTN.a);
    g2.tick(0);
    expect(battleOf(g2)?.enemy.mon.species).toBe("RATTATA");
  });

  test.skipIf(!hasGen)("inside a safari game a touch is the SAFARI battle, and the steps still count", () => {
    const game = makeGame();
    game.save.options.visibleWild = "many";
    const ow = game.overworld;
    ow.setMap("SAFARI_ZONE_CENTER", 14, 22, "up");
    ow.safariStart();
    const steps = game.save.safari!.steps;
    const [x, y] = grassRow(ow);
    standAt(ow, x, y);
    ow.player.facing = "right";
    game.tick(0);
    expect(ow.wild.mons.length).toBeGreaterThan(0);
    ow.wild.mons.length = 0;
    placeMon(ow, "NIDORAN_M", 22, 1);
    let b: WildBattle | undefined;
    for (let i = 0; i < 60 && !b; i++) { game.tick(VOX_BTN.right); b = battleOf(game); }
    expect(b instanceof SafariBattle).toBe(true);
    expect(b!.enemy.mon.species).toBe("NIDORAN_M");
    ow.onStepComplete();
    expect(game.save.safari!.steps).toBe(steps - 1);
  });

  test.skipIf(!hasGen)("water: from the surf table, on water, while surfing only", () => {
    const game = makeGame();
    game.save.options.visibleWild = "many";
    const ow = game.overworld;
    ow.setMap("ROUTE_19", 9, 9, "down");
    const water = cellsOf(ow, CELL_WATER);
    expect(water.length).toBeGreaterThan(0);
    const { at } = busiest(ow, CELL_WATER);
    standAt(ow, at[0], at[1]);
    ow.player.surfing = false;
    game.tick(0);
    expect(ow.wild.mons.filter((m) => m.kind === CELL_WATER).length).toBe(0);
    ow.wild.onMap();
    ow.player.surfing = true;
    (game.save as { surfing?: boolean }).surfing = true;
    game.tick(0);
    const swimmers = ow.wild.mons.filter((m) => m.kind === CELL_WATER);
    expect(swimmers.length).toBeGreaterThan(0);
    const table = data!.encounters.ROUTE_19!.water!.slots;
    for (const m of swimmers) {
      expect(ow.map.isWaterCell(m.cellX, m.cellY)).toBe(true);
      expect(table.some((s) => s.species === m.species && s.level === m.level)).toBe(true);
    }
  });

  test.skipIf(!hasGen)("a cave: on its floor, from its table", () => {
    const game = makeGame();
    game.save.options.visibleWild = "many";
    const ow = game.overworld;
    ow.setMap("MT_MOON_1F", 14, 35, "up");
    const { at, n } = busiest(ow, CELL_LAND);
    expect(n).toBeGreaterThan(20);
    standAt(ow, at[0], at[1]);
    game.tick(0);
    expect(ow.wild.mons.length).toBeGreaterThan(0);
    const table = data!.encounters.MT_MOON_1F!.grass!.slots;
    for (const m of ow.wild.mons) {
      expect(ow.map.isWalkableCell(m.cellX, m.cellY)).toBe(true);
      expect(table.some((s) => s.species === m.species && s.level === m.level)).toBe(true);
    }
  });

  test.skipIf(!hasGen)("a town has none, even with the setting on", () => {
    const game = makeGame();
    game.save.options.visibleWild = "many";
    const ow = game.overworld;
    for (const town of ["PALLET_TOWN", "VIRIDIAN_CITY", "PEWTER_CITY"]) {
      ow.setMap(town, 5, 5, "down");
      for (let i = 0; i < 300; i++) game.tick(0);
      expect(ow.wild.mons.length).toBe(0);
    }
  });

  test.skipIf(!hasGen)("they go when far, when their time is up, and on a map change; and come back", () => {
    const game = makeGame();
    game.save.options.visibleWild = "many";
    const ow = game.overworld;
    ow.setMap("VIRIDIAN_FOREST", 1, 1, "down");
    const { at } = busiest(ow, CELL_LAND);
    standAt(ow, at[0], at[1]);
    game.tick(0);
    const first = ow.wild.mons.length;
    expect(first).toBeGreaterThan(0);
    // time up, far enough away: gone; then the spawner refills
    for (const m of ow.wild.mons) m.life = 0;
    game.tick(0);
    expect(ow.wild.mons.every((m) => m.life > 0 || Math.max(Math.abs(m.cellX - at[0]), Math.abs(m.cellY - at[1])) < 4)).toBe(true);
    for (let i = 0; i < 400; i++) game.tick(0);
    expect(ow.wild.mons.length).toBeGreaterThan(0);
    // a map change clears them
    ow.setMap("ROUTE_2", 5, 5, "down");
    expect(ow.wild.mons.length).toBe(0);
  });

  test.skipIf(!hasGen)("a map's first tick keeps what stands there (it only clears on a new map)", () => {
    const game = makeGame();
    game.save.options.visibleWild = "some";
    const ow = game.overworld;
    ow.setMap("ROUTE_1", 9, 27, "up");
    const [x, y] = grassRow(ow);
    ow.setMap("ROUTE_1", x, y, "right");
    const m = placeMon(ow, "PIDGEY", 3, 2);
    game.tick(0);
    expect(ow.wild.mons).toContain(m);
  });

  test.skipIf(!hasGen)("frozen while a script runs; off while a link is up", () => {
    const game = makeGame();
    game.save.options.visibleWild = "many";
    const ow = game.overworld;
    ow.setMap("VIRIDIAN_FOREST", 1, 1, "down");
    const { at } = busiest(ow, CELL_LAND);
    standAt(ow, at[0], at[1]);
    game.tick(0);
    const snap = ow.wild.mons.map((m) => `${m.px},${m.py}`).join(";");
    expect(ow.wild.update(true)).toBe(false);
    expect(ow.wild.mons.map((m) => `${m.px},${m.py}`).join(";")).toBe(snap);
    (ow as { link: unknown }).link = {};
    expect(ow.wild.active()).toBe(false);
    expect(ow.wild.suppressesRoll()).toBe(false);
    ow.wild.update(false);
    expect(ow.wild.mons.length).toBe(0);
    (ow as { link: unknown }).link = null;
  });

  test.skipIf(!hasGen)("not saved: a save written with mons about has none of them", () => {
    const game = makeGame();
    game.save.options.visibleWild = "many";
    const ow = game.overworld;
    ow.setMap("VIRIDIAN_FOREST", 1, 1, "down");
    const { at } = busiest(ow, CELL_LAND);
    standAt(ow, at[0], at[1]);
    game.tick(0);
    expect(ow.wild.mons.length).toBeGreaterThan(0);
    const text = JSON.stringify(game.save);
    expect(text).not.toContain(ow.wild.mons[0]!.sprite);
    expect(text).toContain('"visibleWild":"many"');
  });

  test.skipIf(!hasGen || !hasYellow)("Yellow: a forest full of them, drawn with the dataset's own sheets", async () => {
    const yd = await loadRuntimeData(yellowDir);
    const game = makeGame(yd);
    game.save.options.visibleWild = "many";
    const ow = game.overworld;
    ow.setMap("VIRIDIAN_FOREST", 1, 1, "down");
    const { at } = busiest(ow, CELL_LAND);
    standAt(ow, at[0], at[1]);
    for (let i = 0; i < 600; i++) game.tick(0);
    expect(ow.wild.mons.length).toBeGreaterThan(0);
    for (const m of ow.wild.mons) expect(yd.sprites?.[m.sprite]).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// the gear's ENHANCEMENTS app
// ---------------------------------------------------------------------------

describe("the gear's ENHANCEMENTS app", () => {
  function frame(game: VoxelmonGame): void {
    drawKantoGear((game as unknown as { host: MenuHost }).host as never, game as never);
  }
  const at = (cx: number, cy: number): [number, number] => [cx * TILE_W + TILE_W / 2, cy * TILE_H + TILE_H / 2];
  function touch(game: VoxelmonGame, cx: number, cy: number): void {
    frame(game);
    const [x, y] = at(cx, cy);
    gearTouchDown(game as never, x, y);
    gearTouchUp(game as never);
  }

  test("its rows are OPTION's ENHANCEMENTS rows, SPEED first", () => {
    expect(enhancementDefs().map((d) => d.key)).toEqual([SPEED_ROW, ...ENHANCEMENT_ROWS].map((d) => d.key));
    expect(OPTION_PAGES).toContain("ENHANCEMENTS");
    // every gear label leaves a clear column before the pills at 15
    for (const d of enhancementDefs()) {
      const w = encodeGlyphs(gearLabel(d)).length;
      expect(w).toBeLessThanOrEqual(d === VISIBLE_WILD_ROW ? 20 : 14);
      for (const c of d.choices) expect(wrap(gearAbout(d, c), 18).length).toBeLessThanOrEqual(2);
      expect(ENHANCEMENT_GEAR[d.key]).toBeTruthy();
    }
    expect(encodeGlyphs(appOf("enhancements")!.short).length).toBeLessThanOrEqual(6);
  });

  test.skipIf(!hasGen)("always there, on HOME and in the L/R order, beside CHEATS", () => {
    const game = makeGame();
    expect(availableApps(game)).toContain("enhancements");
    expect(availableApps(game).at(-1)).toBe("enhancements");
    game.save.options.cheats = true;
    const apps = availableApps(game);
    expect(apps.slice(-2)).toEqual(["enhancements", "cheats"]);
    expect(gearTabs(game as never).map((t) => t.id)).toContain("enhancements");
    game.setGearView("home");
    game.cycleGearView(-1);
    game.cycleGearView(-1);
    expect(game.gearView).toBe("enhancements");
  });

  test("HOME: fourteen apps fill four rows of three and centre the last two", () => {
    expect(homePill(12, 14)).toEqual({ x: 3, y: 17 });
    expect(homePill(13, 14)).toEqual({ x: 11, y: 17 });
    expect(homePill(12, 13)).toEqual({ x: 7, y: 17 });
    expect(homePill(0, 14)).toEqual({ x: 0, y: 9 });
    expect(homePill(11, 14)).toEqual({ x: 14, y: 15 });
    expect(homePill(14, 15)).toEqual({ x: 14, y: 17 }); // a full last row
    expect(homePill(15, 16)).toBeNull(); // past the bottom row
    // the pair is centred: as far from either edge
    expect(homePill(12, 14)!.x).toBe(20 - (homePill(13, 14)!.x + 6));
  });

  test.skipIf(!hasGen)("with every app on offer, ENHANCEMENTS and CHEATS share the bottom row", () => {
    const game = makeGame();
    game.save.inventory.TOWN_MAP = 1;
    game.save.flags.EVENT_GOT_POKEDEX = true;
    (game as { data: any }).data = { ...(game.data as object), atlas: { ...((game.data as any).atlas ?? {}), townMapPage: 0 } };
    game.save.options.cheats = true;
    expect(availableApps(game).length).toBe(15); // HOME + 14
    game.setGearView("home");
    touch(game, 5, 17);
    expect(game.gearView).toBe("enhancements");
    game.setGearView("home");
    touch(game, 13, 17);
    expect(game.gearView).toBe("cheats");
  });

  test.skipIf(!hasGen)("a tap on the app shows on OPTION's page, and OPTION's change shows on the app", () => {
    const game = makeGame();
    game.setGearView("enhancements");
    const o = game.save.options;
    const menu = new OptionsMenuState({ input: { pressed: {} }, pop() {}, save: game.save } as never);
    menu.turnPage(1);
    const optionRow = (label: string) => menu.view().rows.find((r) => r.label === label)!;
    // SPEED on row 2
    touch(game, 17, 2);
    expect(o.gameSpeed).toBe(2);
    expect(optionRow("SPEED").index).toBe(1);
    // the toggles on rows 4, 6, 8, 10
    touch(game, 17, 4);
    expect(o.expForCatching).toBe(true);
    expect(optionRow("EXP FOR CATCHING").index).toBe(1);
    touch(game, 17, 6);
    expect(o.partyExpShare).toBe(true);
    touch(game, 17, 8);
    expect(o.tradeEvoLv40).toBe(true);
    touch(game, 17, 10);
    expect(o.hmsWithoutMove).toBe(true);
    expect(optionRow("HMS WITHOUT MOVE").index).toBe(1);
    // VISIBLE WILD's value under its label: OFF -> SOME -> MANY -> OFF
    touch(game, 15, 13);
    expect(o.visibleWild).toBe("some");
    expect(optionRow("VISIBLE WILD").index).toBe(1);
    touch(game, 15, 13);
    expect(o.visibleWild).toBe("many");
    touch(game, 15, 13);
    expect(o.visibleWild).toBe("off");
    // and the other way: OPTION's page writes, the app reads the same key
    const pressed: Record<string, boolean> = {};
    const m2 = new OptionsMenuState({ input: { pressed }, pop() {}, save: game.save } as never);
    m2.turnPage(1);
    const vwAt = m2.view().rows.findIndex((r) => r.label === "VISIBLE WILD");
    for (let i = 0; i < vwAt; i++) { pressed.down = true; m2.update(); pressed.down = false; }
    pressed.right = true; m2.update(); m2.update(); pressed.right = false;
    expect(o.visibleWild).toBe("many");
    const ui = () => (game as unknown as { gearUi: Record<string, any> }).gearUi.enhancements!;
    touch(game, 15, 13); // MANY -> OFF on the app
    expect(o.visibleWild).toBe("off");
    expect(m2.view().rows[vwAt]!.index).toBe(0);
    expect(ui().sel).toBe(enhancementDefs().indexOf(VISIBLE_WILD_ROW));
  });

  test.skipIf(!hasGen)("the page's layout: a row clear under the header, column 19 clear, values ending in 17", () => {
    class BottomGrid extends MenuHost {
      grid: number[][] = Array.from({ length: 18 }, () => Array(20).fill(0));
      uiClearBottom(): void { this.grid.forEach((r) => r.fill(0)); }
      uiTileBottom(x: number, y: number, t: number): void { if (x >= 0 && y >= 0 && x < 20 && y < 18) this.grid[y]![x] = t; }
    }
    const host = new BottomGrid();
    const game = new VoxelmonGame(data!, host, 1);
    game.newGame();
    game.closeToOverworld();
    game.save.options.expForCatching = true;
    game.save.options.visibleWild = "some";
    game.setGearView("enhancements");
    drawKantoGear(host as never, game as never);
    const g = host.grid;
    const glyph = (t: number) => t & 0x1fff;
    const blank = (t: number) => t === 0 || glyph(t) === 0x7f;
    expect(g[1]!.every(blank)).toBe(true);
    for (let y = 1; y < 18; y++) expect(blank(g[y]![19]!)).toBe(true);
    expect(g[17]!.every(blank)).toBe(true); // a clear row above the bottom edge
    expect(glyph(g[2]![17]!)).toBe(encodeGlyphs("1X")[1]);
    expect(glyph(g[4]![17]!)).toBe(encodeGlyphs("ON")[1]);
    expect(glyph(g[6]![17]!)).toBe(encodeGlyphs("OFF")[2]);
    expect(glyph(g[13]![17]!)).toBe(encodeGlyphs("SOME")[3]);
    // the labels keep a column clear of their pills
    for (const y of [2, 4, 6, 8, 10]) expect(blank(g[y]![14]!)).toBe(true);
    // the header: the title with its arrows, a column clear of both ends
    expect(blank(g[0]![0]!)).toBe(true);
    expect(blank(g[0]![19]!)).toBe(true);
  });
});
