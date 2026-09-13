// tests/voxel-world.test.ts — the gen1recomp overworld port under test.
//
// Layer 1 (ROM-free, always runs): the two-level input edge model and the
// textbox pagination/reveal machine over synthetic strings.
//
// Layer 2 (gated, skips with a printed reason when dist/voxelmon/gen is
// absent): cell-semantics ground truths from the reference
// tests/content_red/facts.lua, movement/ledge/warp/connection behavior,
// encounter slot mapping driven through the overworld path, and the
// story.tape determinism run (in-process twice + the real cli once).

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { VOX_BTN, VOX_OP } from "../contracts/spec/voxel-spec.ts";
import { fromGenDir as loadAudioBanks } from "../voxelmon/game/audio/banks.ts";
import { loadRuntimeData, REQUIRED_MODULES, type VoxelmonData } from "../voxelmon/game/data.ts";
import { WildBattle } from "../voxelmon/game/battle/battle.ts";
import { newMon } from "../voxelmon/game/battle/mon.ts";
import { TrainerBattle } from "../voxelmon/game/battle/trainer.ts";
import { seqRng } from "../voxelmon/game/rng.ts";
import * as Bag from "../voxelmon/game/rules/bag.ts";
import { ENCOUNTER_BUCKETS } from "../voxelmon/game/rules/encounter.ts";
import { expForLevel } from "../voxelmon/game/rules/growth.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { Input } from "../voxelmon/game/input.ts";
import { gearMapPoint, gearTabs, gearTouchDown } from "../voxelmon/game/ui/kantogear.ts";
import {
  checkForMatch,
  evaluate,
  stopWheel1Early,
} from "../voxelmon/game/ui/slotmachine.ts";
import { encodeGlyphs, glyphLen, MAX_COLS } from "../voxelmon/game/ui/tiles.ts";
import { GameMap } from "../voxelmon/game/world/map.ts";
import { martStock } from "../voxelmon/game/world/marts.ts";
import { computeNeighbors } from "../voxelmon/game/world/overworld.ts";
import { paginate, Textbox } from "../voxelmon/game/world/textbox.ts";
import { parseTape, TapePlayer, TapeStallError } from "../voxelmon/game/sim/tape.ts";

const root = join(import.meta.dir, "..");
const genDir = join(root, "dist/voxelmon/gen");
const hasGen = REQUIRED_MODULES.every((m) => existsSync(join(genDir, `${m}.json`)));
if (!hasGen) {
  console.log("[voxel-world] dist/voxelmon/gen absent (run `bun tools/voxel.ts import`) — ROM-gated suites skipped");
}
const romData: VoxelmonData | null = hasGen ? await loadRuntimeData(genDir) : null;

function makeGame(seed = 1): VoxelmonGame {
  const game = new VoxelmonGame(romData!, new RecorderHost(), seed);
  game.newGame();
  return game;
}

/** Hold a button mask until pred() or maxTicks; returns ticks driven. */
function holdUntil(game: VoxelmonGame, mask: number, pred: () => boolean, maxTicks = 600): number {
  let t = 0;
  while (!pred() && t < maxTicks) {
    game.tick(mask);
    t += 1;
  }
  return t;
}

/** The tape walk rule in miniature: hold dir until `cells` land. */
function walk(game: VoxelmonGame, mask: number, cells: number, maxTicks = 2000): void {
  const p = game.overworld.player;
  const base = p.landedCount;
  let t = 0;
  while (p.landedCount - base < cells && t < maxTicks) {
    const inFlight = p.moving ? 1 : 0;
    game.tick(p.landedCount - base + inFlight >= cells ? 0 : mask);
    t += 1;
  }
  expect(p.landedCount - base).toBe(cells);
}

function idle(game: VoxelmonGame, ticks: number): void {
  for (let i = 0; i < ticks; i++) game.tick(0);
}

// ---------------------------------------------------------------------------
// Layer 1 — input: the two-level edge-per-step model (Input.lua)
// ---------------------------------------------------------------------------

describe("input edge model", () => {
  test("a press+release inside one step still edges (Input.lua:109-135)", () => {
    const input = new Input();
    input.sourcePress("a", "key:z");
    input.sourceRelease("a", "key:z");
    input.step();
    expect(input.wasPressed("a")).toBe(true);
    expect(input.isDown("a")).toBe(false);
  });

  test("edges are valid for the current step only (Input.lua:382)", () => {
    const input = new Input();
    input.sourcePress("a", "key:z");
    input.step();
    expect(input.wasPressed("a")).toBe(true);
    expect(input.isDown("a")).toBe(true);
    input.step();
    expect(input.wasPressed("a")).toBe(false);
    expect(input.isDown("a")).toBe(true); // still held by the live source
  });

  test("multi-source refcounting: one release does not clear another's hold", () => {
    const input = new Input();
    input.sourcePress("up", "key:w");
    input.sourcePress("up", "key:up");
    input.step();
    input.sourceRelease("up", "key:w");
    expect(input.isDown("up")).toBe(true);
    input.sourceRelease("up", "key:up");
    expect(input.isDown("up")).toBe(false);
  });

  test("host mask: a held bit edges once; a re-set bit edges again", () => {
    const input = new Input();
    input.setButtons(VOX_BTN.a);
    input.step();
    expect(input.wasPressed("a")).toBe(true);
    input.setButtons(VOX_BTN.a);
    input.step();
    expect(input.wasPressed("a")).toBe(false); // held, not re-pressed
    input.setButtons(0);
    input.step();
    input.setButtons(VOX_BTN.a);
    input.step();
    expect(input.wasPressed("a")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 1 — textbox machine over synthetic text (TextBox.lua)
// ---------------------------------------------------------------------------

describe("textbox machine", () => {
  test("paginate wraps at 18 glyphs on space boundaries (TextBox.lua:108)", () => {
    const pages = paginate("aaaa bbbb cccc dddd eeee ffff");
    expect(pages.length).toBe(1);
    for (const line of pages[0].lines) {
      expect(glyphLen(line)).toBeLessThanOrEqual(MAX_COLS);
    }
    expect(pages[0].lines.join("")).toBe("aaaa bbbb cccc dddd eeee ffff");
  });

  test("apostrophe digraphs are single glyphs (charmap.asm)", () => {
    // "it's" = i,t,'s -> 3 glyphs, not 4
    expect(glyphLen("it's")).toBe(3);
    expect(encodeGlyphs("'d")).toEqual([0xbb]);
  });

  test("\\f splits pages, \\v marks a cont line (TextBox.lua:141-163)", () => {
    const pages = paginate("one\ntwothree\ffour");
    expect(pages.length).toBe(2);
    expect(pages[0].lines).toEqual(["one", "two", "three"]);
    expect(pages[0].contBefore).toEqual([false, false, true]);
    expect(pages[1].lines).toEqual(["four"]);
  });

  test("typewriter reveals one glyph per 3 idle frames, 1 while A held", () => {
    const input = new Input();
    const box = new Textbox("abcdef");
    for (let i = 0; i < 3; i++) box.update(input);
    expect(box.shown[0].revealed).toBe(1);
    for (let i = 0; i < 6; i++) box.update(input);
    expect(box.shown[0].revealed).toBe(3);
    input.setButtons(VOX_BTN.a);
    input.step();
    box.update(input);
    box.update(input);
    expect(box.shown[0].revealed).toBe(5);
  });

  test("a/b advance: preWait swallows the button, then the page turns", () => {
    const input = new Input();
    const box = new Textbox("one\ftwo");
    const tap = (btn: "a" | "b") => {
      input.setButtons(VOX_BTN[btn]);
      input.step();
      box.update(input);
      input.setButtons(0);
      input.step();
    };
    // type page 1 out (held-A fast path types + reaches waiting)
    input.setButtons(VOX_BTN.a);
    input.step();
    for (let i = 0; i < 8 && !box.waiting; i++) box.update(input);
    input.setButtons(0);
    input.step();
    expect(box.waiting).toBe(true);
    // TEXT_PRE_ADVANCE (Delay3): the arrow is up but the press is ignored
    tap("a");
    expect(box.waiting).toBe(true);
    box.update(input); // drain the remaining preWait
    box.update(input);
    tap("a");
    expect(box.waiting).toBe(false);
    expect(box.pageIndex).toBe(1);
    // TEXT_PAGE_CLEAR holds before the next page types
    expect(box.holdFrames).toBeGreaterThan(0);
    // drain hold + type page 2 with A held, then close on B
    input.setButtons(VOX_BTN.a);
    input.step();
    for (let i = 0; i < 40 && !box.done; i++) box.update(input);
    input.setButtons(0);
    input.step();
    expect(box.done).toBe(true);
    tap("b");
    expect(box.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — cell semantics vs the reference facts (content_red/facts.lua)
// ---------------------------------------------------------------------------

describe("cell semantics (facts.lua ground truth)", () => {
  const map = (id: string): GameMap => {
    const def = romData!.maps![id];
    return new GameMap(def, romData!.tilesets![def.tileset]);
  };

  test.skipIf(!hasGen)("map dimensions in cells (facts.lua:25-29)", () => {
    expect(map("PALLET_TOWN").widthCells).toBe(20);
    expect(map("PALLET_TOWN").heightCells).toBe(18);
    expect(map("VIRIDIAN_CITY").widthCells).toBe(40);
    expect(map("VIRIDIAN_CITY").heightCells).toBe(36);
    expect(map("OAKS_LAB").widthCells).toBe(10);
    expect(map("OAKS_LAB").heightCells).toBe(12);
  });

  test.skipIf(!hasGen)("Pallet walkability + warp + sign (facts.lua:32-38)", () => {
    const pallet = map("PALLET_TOWN");
    expect(pallet.isWalkableCell(5, 6)).toBe(true); // spawn
    expect(pallet.isWalkableCell(5, 5)).toBe(true); // the door cell walks
    expect(pallet.isWalkableCell(4, 4)).toBe(false);
    expect(pallet.isWalkableCell(0, 3)).toBe(false);
    const door = pallet.warpAtCell(5, 5);
    expect(door?.def.destMap).toBe("REDS_HOUSE_1F");
    expect(pallet.isDoorTileCell(5, 5)).toBe(true);
    const sign = pallet.signAtCell(13, 13);
    expect(sign?.text).toBe("TEXT_PALLETTOWN_OAKSLAB_SIGN");
  });

  test.skipIf(!hasGen)("grass detection + the off-map border guard (Map.lua:224, issue #217)", () => {
    const r1 = map("ROUTE_1");
    expect(r1.isGrassCell(10, 35)).toBe(true);
    expect(r1.isGrassCell(4, 2)).toBe(false);
    expect(r1.isGrassCell(10, -1)).toBe(false); // border filler never counts
    expect(map("PALLET_TOWN").isGrassCell(5, 6)).toBe(false);
  });

  test.skipIf(!hasGen)("stairs are warp tiles, mats and lab exits are not (Map.lua:256-263)", () => {
    const h2 = map("REDS_HOUSE_2F");
    expect(h2.isWarpTileCell(7, 1)).toBe(true);
    expect(h2.isDoorTileCell(7, 1)).toBe(false);
    const h1 = map("REDS_HOUSE_1F");
    expect(h1.isWarpTileCell(3, 7)).toBe(false); // exit mat: plain tile
    expect(h1.warpAtCell(3, 7)?.def.destMap).toBe("LAST_MAP");
    const lab = map("OAKS_LAB");
    expect(lab.isWarpTileCell(5, 11)).toBe(false);
    expect(lab.warpAtCell(5, 11)?.def.destMap).toBe("LAST_MAP");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — movement (Player.lua)
// ---------------------------------------------------------------------------

describe("movement", () => {
  test.skipIf(!hasGen)("a step takes 16 frames; facing carries no step (Player.lua:14, :114)", () => {
    const game = makeGame();
    const p = game.overworld.player;
    // spawn faces down and (3,7) is walkable: no turn, pure step
    const t = holdUntil(game, VOX_BTN.down, () => p.landedCount === 1, 40);
    expect(t).toBe(16);
    expect([p.cellX, p.cellY]).toEqual([3, 7]);
  });

  test.skipIf(!hasGen)("turning first costs the 4-frame window (Player.lua:28, #415)", () => {
    const game = makeGame();
    const p = game.overworld.player;
    game.tick(VOX_BTN.right); // tap: turn only
    expect(p.facing).toBe("right");
    expect(p.landedCount).toBe(0);
    expect([p.cellX, p.cellY]).toEqual([3, 6]);
    // now hold: the turn window (4) then the step (16)
    const t = holdUntil(game, VOX_BTN.right, () => p.landedCount === 1, 40);
    expect(t + 1).toBe(4 + 16); // the tap tick above spent tick 1 of the window
  });

  test.skipIf(!hasGen)("walls block and animate in place (Player.lua:135, #230)", () => {
    const game = makeGame();
    const p = game.overworld.player;
    // (3,5) is solid furniture above the spawn
    holdUntil(game, VOX_BTN.up, () => p.landedCount > 0, 60);
    expect(p.landedCount).toBe(0);
    expect([p.cellX, p.cellY]).toEqual([3, 6]);
    expect(p.bumpFrames).toBeGreaterThan(0); // wall-bonk walk-in-place
    expect(p.walkPhase()).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — ledge hop (OverworldController.lua:1322, field.ledges)
// ---------------------------------------------------------------------------

describe("ledge hop", () => {
  test.skipIf(!hasGen)("a south-facing ledge on ROUTE_1 hops two cells", () => {
    const game = makeGame();
    // (4,4) stands on tile 44 with ledge tile 55 south of it; (4,6) walkable
    game.overworld.setMap("ROUTE_1", 4, 4, "down");
    game.overworld.refreshStandingOnWarp();
    const p = game.overworld.player;
    const before = p.landedCount;
    game.tick(VOX_BTN.down);
    // the arc armed at 32 (hopFrames); the same tick's player update
    // already burned one frame (Player.lua:172)
    expect(p.hopFrames).toBe(31);
    holdUntil(game, 0, () => p.landedCount - before >= 2, 60);
    expect(p.landedCount - before).toBe(2);
    expect([p.cellX, p.cellY]).toEqual([4, 6]);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — warps (Warp.lua + OverworldController takeWarp/startWarpTo)
// ---------------------------------------------------------------------------

describe("warps", () => {
  test.skipIf(!hasGen)("REDS_HOUSE_2F stairs fire on ARRIVAL and land on the 1F stairs", () => {
    const game = makeGame();
    const ow = game.overworld;
    walk(game, VOX_BTN.right, 1);
    walk(game, VOX_BTN.up, 4);
    walk(game, VOX_BTN.right, 3);
    walk(game, VOX_BTN.up, 1); // onto (7,1): Warp.onArrive
    idle(game, 40); // WARP_FADE_OUT
    expect(ow.map.id).toBe("REDS_HOUSE_1F");
    expect([ow.player.cellX, ow.player.cellY]).toEqual([7, 1]);
    // the landing cell is inert until stepped off (warpEntryCell, #265)
    expect(ow.warpEntryCell).toEqual({ x: 7, y: 1 });
    // a stair warp tile CLEARS standing-on-warp (issue #230)
    expect(ow.standingOnWarp).toBe(false);
  });

  test.skipIf(!hasGen)("step off and back re-fires the stairs (positional re-entry, #265)", () => {
    const game = makeGame();
    const ow = game.overworld;
    walk(game, VOX_BTN.right, 1);
    walk(game, VOX_BTN.up, 4);
    walk(game, VOX_BTN.right, 3);
    walk(game, VOX_BTN.up, 1);
    idle(game, 40); // now on 1F (7,1)
    walk(game, VOX_BTN.down, 1); // step OFF the landing
    expect(ow.warpEntryCell).toBeUndefined();
    walk(game, VOX_BTN.up, 1); // step BACK ON: the warp re-fires
    idle(game, 40);
    expect(ow.map.id).toBe("REDS_HOUSE_2F");
    expect([ow.player.cellX, ow.player.cellY]).toEqual([7, 1]);
  });

  test.skipIf(!hasGen)("exit mat: edge warp to PALLET_TOWN with the door walk-out", () => {
    const game = makeGame();
    const ow = game.overworld;
    walk(game, VOX_BTN.right, 1);
    walk(game, VOX_BTN.up, 4);
    walk(game, VOX_BTN.right, 3);
    walk(game, VOX_BTN.up, 1);
    idle(game, 40);
    walk(game, VOX_BTN.down, 5);
    walk(game, VOX_BTN.left, 4);
    walk(game, VOX_BTN.down, 1); // onto the mat (3,7)
    // the mat is a plain tile: standing-on-warp stays set (issue #378)
    expect(ow.standingOnWarp).toBe(true);
    walk(game, VOX_BTN.down, 1); // off the map edge -> LAST_MAP warp
    idle(game, 10);
    expect(ow.map.id).toBe("PALLET_TOWN");
    // landed on the door (5,5), then PlayerStepOutFromDoor stepped south
    expect([ow.player.cellX, ow.player.cellY]).toEqual([5, 6]);
    expect(ow.warpEntryCell).toBeUndefined(); // the walk-out left the mat live
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — connections (computeNeighbors + crossConnection)
// ---------------------------------------------------------------------------

describe("connections", () => {
  test.skipIf(!hasGen)("computeNeighbors offsets (OverworldController.lua:164)", () => {
    const n = computeNeighbors(romData!.maps!, "PALLET_TOWN", 1);
    const route1 = n.find((x) => x.id === "ROUTE_1");
    // north: ox = offset*32 = 0, oy = -heightBlocks*32 = -18*32
    expect(route1).toEqual({ id: "ROUTE_1", ox: 0, oy: -576 });
    const viridian = computeNeighbors(romData!.maps!, "ROUTE_1", 1).find(
      (x) => x.id === "VIRIDIAN_CITY",
    );
    // north conn offset -5 blocks: ox = -160; Viridian is 18 blocks tall
    expect(viridian).toEqual({ id: "VIRIDIAN_CITY", ox: -160, oy: -576 });
  });

  test.skipIf(!hasGen)("PALLET north edge crosses into ROUTE_1 with position continuity", () => {
    const game = makeGame();
    const ow = game.overworld;
    ow.setMap("PALLET_TOWN", 10, 1, "up");
    ow.refreshStandingOnWarp();
    const p = ow.player;
    walk(game, VOX_BTN.up, 1); // (10,0)
    walk(game, VOX_BTN.up, 1); // the seam step
    expect(ow.map.id).toBe("ROUTE_1");
    // destX = curX - offset*2 = 10; entry row = heightCells-1 = 35
    expect([p.cellX, p.cellY]).toEqual([10, 35]);
    // continuity: the seam step was one continuous 16-frame walk
    expect(p.moving).toBe(false);
  });

  test.skipIf(!hasGen)("ROUTE_1 north edge lands in VIRIDIAN_CITY at the -5 offset", () => {
    const game = makeGame();
    const ow = game.overworld;
    ow.setMap("ROUTE_1", 10, 1, "up");
    ow.refreshStandingOnWarp();
    walk(game, VOX_BTN.up, 1);
    walk(game, VOX_BTN.up, 1);
    expect(ow.map.id).toBe("VIRIDIAN_CITY");
    // destX = 10 - (-5 * 2) = 20
    expect([ow.player.cellX, ow.player.cellY]).toEqual([20, 35]);
  });

  test.skipIf(!hasGen)("a solid landing on the neighbor bumps (Map.defPassable fail-closed)", () => {
    const game = makeGame();
    const ow = game.overworld;
    // Pallet south shore: (2,17) is land; ROUTE_21 (2,0) is water -> bump
    ow.setMap("PALLET_TOWN", 2, 17, "down");
    ow.refreshStandingOnWarp();
    const p = ow.player;
    holdUntil(game, VOX_BTN.down, () => p.landedCount > 0, 60);
    expect(ow.map.id).toBe("PALLET_TOWN");
    expect([p.cellX, p.cellY]).toEqual([2, 17]);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — encounters through the overworld path (Encounter.lua:22-39)
// ---------------------------------------------------------------------------

describe("encounters", () => {
  const grassStep = (rate: number, pick: number) => {
    const game = makeGame();
    const ow = game.overworld;
    ow.setMap("ROUTE_1", 11, 6, "down");
    ow.refreshStandingOnWarp();
    game.rng = seqRng(rate, pick);
    walk(game, VOX_BTN.down, 1); // land on (11,7): grass
    return game;
  };

  test.skipIf(!hasGen)("rate gate: rand(0..255) >= rate rolls nothing", () => {
    const rate = romData!.encounters.ROUTE_1.grass!.rate;
    expect(rate).toBe(25);
    const game = grassStep(rate, 0); // roll == rate: NOT less-than -> no battle
    expect(game.overworld.encounterCount).toBe(0);
    expect(game.stackKinds()).toEqual(["overworld"]);
  });

  test.skipIf(!hasGen)("slot mapping matches encounters.json through the 256 buckets", () => {
    const slots = romData!.encounters.ROUTE_1.grass!.slots;
    // bucket thresholds (FieldDefaults.lua:210): pick < threshold[i] -> slot i
    const cases: [number, number][] = [
      [0, 0],
      [50, 0],
      [51, 1],
      [141, 3],
      [215, 5],
      [255, 9],
    ];
    for (const [pick, slotIdx] of cases) {
      expect(pick).toBeLessThan(ENCOUNTER_BUCKETS[slotIdx]);
      const game = grassStep(0, pick); // rate roll 0 always hits
      expect(game.overworld.encounterCount).toBe(1);
      expect(game.overworld.lastEncounter).toEqual({
        species: slots[slotIdx].species,
        level: slots[slotIdx].level,
      });
      // the REAL wild battle is on top (the battle port replaced the stub)
      expect(game.stackKinds()).toEqual(["overworld", "battle"]);
    }
  });

  test.skipIf(!hasGen)("no roll on plain ground; rolls only on completed grass steps", () => {
    const game = makeGame();
    const ow = game.overworld;
    ow.setMap("ROUTE_1", 9, 16, "down");
    ow.refreshStandingOnWarp();
    game.rng = seqRng(0, 0); // would ALWAYS encounter if a roll happened
    walk(game, VOX_BTN.down, 1); // (9,17): plain path
    expect(ow.encounterCount).toBe(0);
  });

  test.skipIf(!hasGen)("a grass encounter opens the real wild battle", () => {
    const game = grassStep(0, 100);
    expect(game.stackKinds()).toEqual(["overworld", "battle"]);
    const bv = game.battleView();
    expect(bv).not.toBeNull();
    expect(bv!.battle.kind).toBe("wild");
    expect(bv!.battle.enemy.mon.species).toBe(game.overworld.lastEncounter!.species);
    expect(bv!.battle.enemy.mon.level).toBe(game.overworld.lastEncounter!.level);
    // the player stayed exactly where the encounter fired — nothing moves
    // the player; the camera goes to the arena (docs/VOXEL.md §4)
    expect([game.overworld.player.cellX, game.overworld.player.cellY]).toEqual([11, 7]);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — textbox against real extracted text
// ---------------------------------------------------------------------------

describe("textbox with ROM text", () => {
  test.skipIf(!hasGen)("the Pallet sign paginates to one 3-line page with a cont scroll", () => {
    const text = (romData!.text as Record<string, string>)._PalletTownSignText;
    expect(text).toBe("PALLET TOWN\nShades of yourjourney await!");
    const pages = paginate(text);
    expect(pages.length).toBe(1);
    expect(pages[0].lines).toEqual(["PALLET TOWN", "Shades of your", "journey await!"]);
    expect(pages[0].contBefore).toEqual([false, false, true]);
    for (const line of pages[0].lines) {
      expect(glyphLen(line)).toBeLessThanOrEqual(18);
    }
  });

  test.skipIf(!hasGen)("reveal counts every glyph of the sign's first line", () => {
    const input = new Input();
    const text = (romData!.text as Record<string, string>)._PalletTownSignText;
    const box = new Textbox(text);
    // 11 glyphs at the default 3-frame cadence
    for (let i = 0; i < 33; i++) box.update(input);
    expect(box.shown[0].revealed).toBe(glyphLen("PALLET TOWN"));
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — the story tape: determinism, marks, and the real cli
// ---------------------------------------------------------------------------

const STORY_SEED = 17;

async function runStoryInProcess(): Promise<RecorderHost> {
  const host = new RecorderHost();
  const game = new VoxelmonGame(romData!, host, STORY_SEED);
  // sim/cli.ts installs the audio banks before newGame; the `audiodata` op it
  // emits is part of the trace, so this run has to do the same to compare.
  game.setAudio(await loadAudioBanks(genDir));
  game.newGame();
  const tapeText = await Bun.file(join(root, "voxelmon/tapes/story.tape")).text();
  const tape = new TapePlayer(parseTape(tapeText));
  while (!tape.done && game.tickIndex < 100_000) {
    const step = tape.next(game);
    for (const m of step.marks) host.mark(m);
    if (tape.done) break;
    game.tick(step.buttons);
    tape.observe(game);
  }
  expect(tape.done).toBe(true);
  return host;
}

describe("story tape", () => {
  test.skipIf(!hasGen)("a walk into a wall trips the 240-tick stall watchdog", () => {
    const game = makeGame();
    // (3,5) is solid furniture straight up from the spawn
    const tape = new TapePlayer(parseTape("walk u 1\n"));
    expect(() => {
      for (let i = 0; i < 400; i++) {
        const step = tape.next(game);
        if (tape.done) break;
        game.tick(step.buttons);
        tape.observe(game);
      }
    }).toThrow(TapeStallError);
  });

  test.skipIf(!hasGen)(
    "reaches every mark, sees exactly one wild encounter, and is byte-deterministic",
    async () => {
      const a = await runStoryInProcess();
      const b = await runStoryInProcess();
      expect(a.marks).toEqual([
        "bedroom",
        "downstairs",
        "pallet-town",
        "sign-read",
        "oaks-lab",
        "lab-exit",
        "route-1",
        "mid-route",
        "encounter-seen",
        "viridian",
        "done",
      ]);
      expect(a.text()).toBe(b.text());
      // the wild battle textbox crossed the boundary
      expect(a.text()).toContain('s 52 1 14 "Wild PIDGEY"');
      // the SGB palette op rides map entry (cooked gamedata only: the boot
      // bedroom is a Pallet interior -> PALLET; Route 1 -> ROUTE); a raw
      // gen/ run has no mapPalette and emits the grayscale -1 once instead
      const trace = a.text();
      if (romData!.mapPalette) {
        expect(trace).toContain(`o ${VOX_OP.palette} ${romData!.mapPalette.PALLET_TOWN}`);
        expect(trace).toContain(`o ${VOX_OP.palette} ${romData!.mapPalette.ROUTE_1}`);
      } else {
        expect(trace).toContain(`o ${VOX_OP.palette} -1`);
      }
    },
    30_000,
  );

  test.skipIf(!hasGen)(
    "the cli runs the tape end-to-end and writes the identical vtrace",
    async () => {
      const out = join(root, "dist/voxelmon/trace/story-test.vtrace");
      const proc = Bun.spawnSync(
        [
          "bun",
          "voxelmon/game/sim/cli.ts",
          "--tape",
          "voxelmon/tapes/story.tape",
          "--out",
          out,
          "--seed",
          String(STORY_SEED),
        ],
        { cwd: root },
      );
      expect(proc.exitCode).toBe(0);
      const cliText = await Bun.file(out).text();
      const inProc = await runStoryInProcess();
      expect(cliText).toBe(inProc.text());
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// the DEV menu and RARE CANDY (ui/devmenu.ts, game.ts useRareCandy)
// ---------------------------------------------------------------------------

/**
 * RecorderHost predates the pic and save ops and still doesn't implement them
 * (the standing `RecorderHost incorrectly implements VoxelHost` type error) —
 * harmless for a tape walk, fatal the moment a menu emits a pic. Filling them
 * in here keeps that gap out of this suite without changing what the .vtrace
 * traces record.
 */
class MenuHost extends RecorderHost {
  /** What the last saveWrite committed — undefined until one happens. */
  saved: string | undefined;
  pic(): void {}
  picHide(): void {}
  saveWrite(text: string): void { this.saved = text; }
  saveData(): string | undefined { return this.saved; }
}

function makeMenuGame(seed = 1): VoxelmonGame {
  const game = new VoxelmonGame(romData!, new MenuHost(), seed);
  game.newGame();
  game.closeToOverworld(); // drop the title; these tests start in the world
  return game;
}

/** Mash A until the textbox on top closes (reveal, then page, then pop). */
function dismissText(game: VoxelmonGame, maxTicks = 600): void {
  let t = 0;
  while (game.stackKinds().at(-1) === "textbox" && t < maxTicks) {
    game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    t += 1;
  }
  game.tick(0); // release, so the caller's next tap is a real edge
}

/** Tap a button for one tick, then release — one input edge. */
function tap(game: VoxelmonGame, mask: number): void {
  game.tick(mask);
  game.tick(0);
}

/** Walk a menu cursor down to `index` and press A. */
function pick(game: VoxelmonGame, index: number): void {
  for (let i = 0; i < index; i++) tap(game, VOX_BTN.down);
  tap(game, VOX_BTN.a);
}

describe("dev menu", () => {
  test.skipIf(!hasGen)("START -> DEV -> RARE CANDY fills the stack to 99", () => {
    const game = makeMenuGame();
    tap(game, VOX_BTN.start);
    expect(game.stackKinds()).toEqual(["overworld", "startmenu"]);
    // a fresh save: ITEM, <name>, SAVE, OPTION, DEV, EXIT
    const sm = game.startMenu() as { entries: string[] };
    expect(sm.entries).toContain("DEV");
    expect(sm.entries).not.toContain("WARP"); // moved down a level
    pick(game, sm.entries.indexOf("DEV"));
    expect(game.stackKinds()).toEqual(["overworld", "startmenu", "devmenu"]);

    const dv = game.devMenu() as { entries: string[] };
    expect(dv.entries).toEqual(["WARP", "RARE CANDY", "CANCEL"]);
    pick(game, dv.entries.indexOf("RARE CANDY"));
    expect(game.save.inventory.RARE_CANDY).toBe(99);
    dismissText(game);
    expect(game.stackKinds().at(-1)).toBe("devmenu");
    // topping up an existing stack adds only the remainder, never over the cap
    game.save.inventory.RARE_CANDY = 90;
    tap(game, VOX_BTN.a); // the cursor is still on RARE CANDY
    expect(game.save.inventory.RARE_CANDY).toBe(99);
  });

  test.skipIf(!hasGen)("a candy used from the BAG levels the mon and is spent", () => {
    const game = makeMenuGame();
    const mon = newMon(romData!, "SQUIRTLE", 5);
    game.save.party.push(mon);
    Bag.add(game.save, "RARE_CANDY", 2);
    const before = { hp: mon.hp, max: mon.stats.hp };

    tap(game, VOX_BTN.start);
    const sm = game.startMenu() as { entries: string[] };
    pick(game, sm.entries.indexOf("ITEM"));
    expect(game.stackKinds().at(-1)).toBe("bag");
    const bag = game.bag() as { entries: { name: string }[] };
    pick(game, bag.entries.findIndex((e) => e.name === "RARE CANDY"));
    expect(game.stackKinds().at(-1)).toBe("party"); // the chooser
    tap(game, VOX_BTN.a);                           // pick the first mon

    expect(mon.level).toBe(6);
    expect(mon.exp).toBe(
      expForLevel(romData!.pokemon.SQUIRTLE!.growthRate, 6, romData!.growth_rates),
    );
    expect(mon.stats.hp).toBeGreaterThan(before.max);
    // current HP grows by the max-HP delta, not refilled
    expect(mon.hp).toBe(before.hp + (mon.stats.hp - before.max));
    expect(game.save.inventory.RARE_CANDY).toBe(1);
    // the bag is still open underneath, so a stack can be burned through
    expect(game.stackKinds()).toContain("bag");
  });

  test.skipIf(!hasGen)("a candy at the level cap is refused and not spent", () => {
    const game = makeMenuGame();
    const mon = newMon(romData!, "SQUIRTLE", 100);
    game.save.party.push(mon);
    Bag.add(game.save, "RARE_CANDY", 1);
    game.useItem(0, "RARE_CANDY");
    expect(mon.level).toBe(100);
    expect(game.save.inventory.RARE_CANDY).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// talking to a trainer, and the trainer card
// ---------------------------------------------------------------------------

/** The full text of the textbox on top, pages joined. */
function topText(game: VoxelmonGame): string {
  const top = game.top() as unknown as { box?: { pages: { lines: string[] }[] } };
  return (top.box?.pages ?? []).map((p) => p.lines.join(" ")).join(" ");
}

/** Stand next to `npc` facing it, then press A. */
function talkTo(game: VoxelmonGame, npc: any): void {
  const p = game.overworld.player;
  p.cellX = npc.cellX;
  p.cellY = npc.cellY + 1;
  p.facing = "up";
  game.overworld.interact();
}

describe("talking to a trainer", () => {
  test.skipIf(!hasGen)("challenges them: before-battle text, then the fight", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    ow.setMap("ROUTE_3", 11, 6, "down");
    game.save.party.push(newMon(romData!, "SQUIRTLE", 5));
    const npc = ow.npcs.find((n: any) => n.def.trainerClass);
    expect(npc).toBeDefined();

    talkTo(game, npc);
    // TalkToTrainer prints the line FIRST, then starts the battle
    expect(game.stackKinds().at(-1)).toBe("textbox");
    const header = (romData!.trainer_headers as any).Route3[String(npc!.def.index)];
    expect(topText(game)).toBe((romData!.text as any)[header.battle].replace(/\n|\f|\x0b/g, " "));
    dismissText(game);
    expect(game.stackKinds().at(-1)).toBe("battle");
  });

  test.skipIf(!hasGen)("a beaten trainer says their after-battle line instead", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    ow.setMap("ROUTE_3", 11, 6, "down");
    game.save.party.push(newMon(romData!, "SQUIRTLE", 5));
    const npc = ow.npcs.find((n: any) => n.def.trainerClass)!;
    const header = (romData!.trainer_headers as any).Route3[String(npc.def.index)];
    game.save.flags[header.event] = true;

    talkTo(game, npc);
    expect(game.stackKinds().at(-1)).toBe("textbox");
    expect(topText(game)).toBe((romData!.text as any)[header.after].replace(/\n|\f|\x0b/g, " "));
  });

  test.skipIf(!hasGen)("a headerless trainer's win is remembered by object id", () => {
    // The Game Corner Rocket has no def_trainers header, so there is no
    // EVENT_BEAT_* flag that could ever record beating him — the flag alone
    // left him re-fightable forever, and his script only walks him off the
    // hidden staircase once engage_trainer reports he stands defeated.
    const game = makeMenuGame();
    const ow = game.overworld;
    ow.setMap("GAME_CORNER", 9, 7, "up");
    game.save.party.push(newMon(romData!, "SQUIRTLE", 5));
    expect((romData!.trainer_headers as any).GameCorner).toBeUndefined();
    const npc = ow.findNpc("GAMECORNER_ROCKET")!;
    expect(ow.trainerDefeated(npc)).toBe(false);

    (game as any).startTrainerBattle = (
      _id: string, _idx: number, _name: unknown, onDone: (won: boolean) => void,
    ) => onDone(true);
    ow.engageTrainer(npc);
    dismissText(game); // the before-battle line, then the (stubbed) battle
    expect(ow.trainerDefeated(npc)).toBe(true);
    expect(game.save.defeatedTrainers[npc.id]).toBe(true);
  });

  test.skipIf(!hasGen)("...which is what lets his script walk him off the stairs", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    ow.setMap("GAME_CORNER", 9, 7, "up");
    game.save.party.push(newMon(romData!, "SQUIRTLE", 5));
    (game as any).startTrainerBattle = (
      _id: string, _idx: number, _name: unknown, onDone: (won: boolean) => void,
    ) => onDone(true);
    const npc = ow.findNpc("GAMECORNER_ROCKET")!;

    ow.talkTo(npc); // TEXT_GAMECORNER_ROCKET -> engage, walk up, despawn
    for (let i = 0; i < 400; i++) {
      dismissText(game);
      if (game.save.objectToggles?.GAME_CORNER?.GAMECORNER_ROCKET === false) break;
      game.tick(0);
    }
    expect(game.save.objectToggles?.GAME_CORNER?.GAMECORNER_ROCKET).toBe(false);
  });

  test.skipIf(!hasGen)("the Game Corner Rocket has a line despite having no header", () => {
    // He is a text_asm trainer: no def_trainers header, so header.battle is
    // undefined and the taunt has to come from his own TEXT_* constant.
    const game = makeMenuGame();
    const ow = game.overworld;
    ow.setMap("GAME_CORNER", 9, 7, "up");
    game.save.party.push(newMon(romData!, "SQUIRTLE", 5));
    expect((romData!.trainer_headers as any).GameCorner).toBeUndefined();
    const npc = ow.findNpc("GAMECORNER_ROCKET");
    expect(npc).toBeDefined();

    ow.engageTrainer(npc!);
    expect(game.stackKinds().at(-1)).toBe("textbox");
    expect(topText(game)).toContain("guarding this");
  });
});

describe("LAST_MAP rewrites", () => {
  function wideGame(...maps: string[]): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [...((romData as { cookedMaps?: string[] }).cookedMaps ?? []), ...maps],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    return game;
  }

  test.skipIf(!hasGen)("the underground path delivers you to the FAR route", () => {
    const game = wideGame(
      "ROUTE_5", "ROUTE_6", "UNDERGROUND_PATH_ROUTE_5",
      "UNDERGROUND_PATH_ROUTE_6", "UNDERGROUND_PATH_NORTH_SOUTH",
    );
    const ow = game.overworld;
    // in from Route 5. The near house forces wLastMap to ROUTE_5, which is
    // what makes ITS door lead back out to Route 5.
    ow.setMap("ROUTE_5", 17, 27, "down");
    ow.setMap("UNDERGROUND_PATH_ROUTE_5", 4, 4, "down");
    expect(ow.lastOutdoor?.id).toBe("ROUTE_5");
    ow.setMap("UNDERGROUND_PATH_NORTH_SOUTH", 2, 41, "down");
    // out the far building: its script forces wLastMap to ROUTE_6, so the
    // LAST_MAP door leaves onto Route 6 and not back where we came in
    ow.setMap("UNDERGROUND_PATH_ROUTE_6", 4, 4, "down");
    expect(ow.lastOutdoor?.id).toBe("ROUTE_6");
    const exit = (romData!.maps as any).UNDERGROUND_PATH_ROUTE_6.warps[0];
    expect(exit.destMap).toBe("LAST_MAP"); // which is the whole problem
    ow.takeWarp(exit);
    for (let i = 0; i < 300 && ow.map.id !== "ROUTE_6"; i++) game.tick(0);
    expect(ow.map.id).toBe("ROUTE_6");
  });

  test.skipIf(!hasGen)("Diglett's Cave does the same, both ways", () => {
    const game = wideGame("ROUTE_2", "ROUTE_11", "DIGLETTS_CAVE_ROUTE_2",
      "DIGLETTS_CAVE_ROUTE_11");
    const ow = game.overworld;
    ow.setMap("ROUTE_2", 15, 15, "down");
    ow.setMap("DIGLETTS_CAVE_ROUTE_11", 4, 4, "down");
    expect(ow.lastOutdoor?.id).toBe("ROUTE_11");
    ow.setMap("DIGLETTS_CAVE_ROUTE_2", 4, 4, "down");
    expect(ow.lastOutdoor?.id).toBe("ROUTE_2");
  });

  test.skipIf(!hasGen)("the Route 22 gate picks its exit by the player's row", () => {
    const game = wideGame("ROUTE_22", "ROUTE_23", "ROUTE_22_GATE");
    const ow = game.overworld;
    // north half -> Route 23, south half -> Route 22
    ow.setMap("ROUTE_22_GATE", 4, 2, "up");
    expect(ow.lastOutdoor?.id).toBe("ROUTE_23");
    ow.player.cellY = 6;
    ow.onStepComplete();
    expect(ow.lastOutdoor?.id).toBe("ROUTE_22");
  });
});

describe("the saffron gates", () => {
  function gateGame(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []),
        "ROUTE_5_GATE", "ROUTE_6_GATE", "ROUTE_7_GATE", "ROUTE_8_GATE",
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    return game;
  }

  /** Step onto the gate's checkpoint and drain whatever it says. */
  function crossGate(game: VoxelmonGame, map: string, x: number, y: number): void {
    const ow = game.overworld;
    ow.setMap(map, x, y, "up");
    ow.player.cellX = x;
    ow.player.cellY = y;
    ow.onStepComplete();
    // A fixed span, not "until the stack empties": the walk-back is a script
    // row that runs after the guard's text box has already closed.
    for (let i = 0; i < 600; i++) {
      dismissText(game);
      game.tick(0);
    }
  }

  test.skipIf(!hasGen)("a thirsty guard turns you back", () => {
    const game = gateGame();
    crossGate(game, "ROUTE_5_GATE", 4, 3);
    expect(game.save.flags.EVENT_GAVE_GUARDS_DRINK).toBeUndefined();
    // walked back the way we came, so the checkpoint is not crossed
    expect(game.overworld.player.cellY).toBeGreaterThan(3);
  });

  test.skipIf(!hasGen)("the trigger takes the drink — talking is not required", () => {
    const game = gateGame();
    game.save.inventory.FRESH_WATER = 1;
    crossGate(game, "ROUTE_5_GATE", 4, 3);
    expect(game.save.flags.EVENT_GAVE_GUARDS_DRINK).toBe(true);
    expect(game.save.inventory.FRESH_WATER).toBeUndefined();
  });

  test.skipIf(!hasGen)("one drink opens all four gates", () => {
    const game = gateGame();
    game.save.inventory.LEMONADE = 1;
    crossGate(game, "ROUTE_5_GATE", 4, 3);
    expect(game.save.flags.EVENT_GAVE_GUARDS_DRINK).toBe(true);
    // the other three no longer trigger at all
    for (const [map, x, y] of [
      ["ROUTE_6_GATE", 4, 2], ["ROUTE_7_GATE", 3, 3], ["ROUTE_8_GATE", 2, 3],
    ] as [string, number, number][]) {
      const ow = game.overworld;
      ow.setMap(map, x, y, "up");
      ow.player.cellX = x;
      ow.player.cellY = y;
      ow.onStepComplete();
      expect(game.stackKinds(), `${map} still blocks`).toEqual(["overworld"]);
    }
  });

  test.skipIf(!hasGen)("any of the three drinks works, and only one is taken", () => {
    for (const drink of ["FRESH_WATER", "SODA_POP", "LEMONADE"]) {
      const game = gateGame();
      game.save.inventory[drink] = 2;
      crossGate(game, "ROUTE_6_GATE", 4, 2);
      expect(game.save.flags.EVENT_GAVE_GUARDS_DRINK, drink).toBe(true);
      expect(game.save.inventory[drink], drink).toBe(1);
    }
  });
});

describe("the game corner", () => {
  function gcGame(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []),
        "GAME_CORNER", "GAME_CORNER_PRIZE_ROOM",
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    return game;
  }

  /** Talk to a clerk/counter and answer the first YES/NO, if one opens. */
  function talkAt(game: VoxelmonGame, map: string, text: string, yes?: boolean): void {
    game.overworld.setMap(map, 4, 4, "up");
    game.overworld.showMapText(text);
    for (let i = 0; i < 900; i++) {
      if (yes !== undefined && game.stackKinds().at(-1) === "choice") {
        if (!yes) tap(game, VOX_BTN.down);
        tap(game, VOX_BTN.a);
        yes = undefined;
        continue;
      }
      if (game.stackKinds().at(-1) === "prizes") return;
      dismissText(game);
      game.tick(0);
    }
  }

  test.skipIf(!hasGen)("the clerk sells 50 coins for 1000, and refuses without a case", () => {
    const game = gcGame();
    game.save.money = 3000;
    // IsItemInBag COIN_CASE comes first: no case, no sale
    talkAt(game, "GAME_CORNER", "TEXT_GAMECORNER_CLERK1", true);
    expect(game.save.money).toBe(3000);
    expect(game.save.coins ?? 0).toBe(0);

    game.save.inventory.COIN_CASE = 1;
    talkAt(game, "GAME_CORNER", "TEXT_GAMECORNER_CLERK1", true);
    expect(game.save.money).toBe(2000);
    expect(game.save.coins).toBe(50);

    // declining costs nothing
    talkAt(game, "GAME_CORNER", "TEXT_GAMECORNER_CLERK1", false);
    expect(game.save.money).toBe(2000);
    expect(game.save.coins).toBe(50);
  });

  test.skipIf(!hasGen)("a full case, or an empty wallet, is refused", () => {
    const full = gcGame();
    full.save.inventory.COIN_CASE = 1;
    full.save.money = 3000;
    full.save.coins = 9990; // Has9990Coins
    talkAt(full, "GAME_CORNER", "TEXT_GAMECORNER_CLERK1", true);
    expect(full.save.coins).toBe(9990);
    expect(full.save.money).toBe(3000);

    const poor = gcGame();
    poor.save.inventory.COIN_CASE = 1;
    poor.save.money = 999;
    talkAt(poor, "GAME_CORNER", "TEXT_GAMECORNER_CLERK1", true);
    expect(poor.save.coins ?? 0).toBe(0);
    expect(poor.save.money).toBe(999);
  });

  test.skipIf(!hasGen)("the gambler hands over 20 coins exactly once", () => {
    const game = gcGame();
    game.save.inventory.COIN_CASE = 1;
    talkAt(game, "GAME_CORNER", "TEXT_GAMECORNER_CLERK2");
    expect(game.save.coins).toBe(20);
    talkAt(game, "GAME_CORNER", "TEXT_GAMECORNER_CLERK2");
    expect(game.save.coins).toBe(20);
  });

  test.skipIf(!hasGen)("a prize counter needs the case, then opens its own window", () => {
    const game = gcGame();
    // no case: the window never opens at all
    talkAt(game, "GAME_CORNER_PRIZE_ROOM", "TEXT_GAMECORNERPRIZEROOM_PRIZE_VENDOR_1");
    expect(game.stackKinds()).toEqual(["overworld"]);

    game.save.inventory.COIN_CASE = 1;
    talkAt(game, "GAME_CORNER_PRIZE_ROOM", "TEXT_GAMECORNERPRIZEROOM_PRIZE_VENDOR_1");
    expect(game.stackKinds().at(-1)).toBe("prizes");
    const v = game.prizes() as { rows: { label: string; cost: number }[] };
    // each counter owns ONE window of three, not the catalogue
    expect(v.rows).toEqual([
      { label: "ABRA L9", cost: 180 },
      { label: "CLEFAIRY L8", cost: 500 },
      { label: "NIDORINA L17", cost: 1200 },
    ]);
  });

  test.skipIf(!hasGen)("buying a prize spends the coins; too few buys nothing", () => {
    const game = gcGame();
    game.save.inventory.COIN_CASE = 1;
    game.save.coins = 100;
    talkAt(game, "GAME_CORNER_PRIZE_ROOM", "TEXT_GAMECORNERPRIZEROOM_PRIZE_VENDOR_1");
    tap(game, VOX_BTN.a); // ABRA, 180
    let guard = 0;
    while (game.stackKinds().at(-1) !== "choice" && guard++ < 600) game.tick(0);
    tap(game, VOX_BTN.a); // yes
    guard = 0;
    while (game.stackKinds().length > 1 && guard++ < 900) { dismissText(game); game.tick(0); }
    expect(game.save.coins).toBe(100); // HasEnoughCoins failed
    expect(game.save.party.length).toBe(0);

    game.save.coins = 500;
    talkAt(game, "GAME_CORNER_PRIZE_ROOM", "TEXT_GAMECORNERPRIZEROOM_PRIZE_VENDOR_1");
    tap(game, VOX_BTN.a);
    guard = 0;
    while (game.stackKinds().at(-1) !== "choice" && guard++ < 600) game.tick(0);
    tap(game, VOX_BTN.a);
    guard = 0;
    while (game.stackKinds().length > 1 && guard++ < 900) { dismissText(game); game.tick(0); }
    expect(game.save.coins).toBe(320);
    expect(game.save.party.map((m) => m.species)).toEqual(["ABRA"]);
    expect(game.save.pokedex.owned.ABRA).toBe(true);
  });

  test.skipIf(!hasGen)("the slot paylines are pokered's, in its order", () => {
    // Three reels of the same symbol in the tested rows. LINES is checked in
    // order and the FIRST match wins, so the diagonals beat the rows.
    const w = (...s: string[]): string[] => s;
    // a strip where position 1 reads bottom/middle/top = X/Y/Z
    const strip = (b: string, m: string, t: string): string[] => w(b, m, t, "MOUSE");
    const wheels = [strip("7", "BAR", "CHERRY"), strip("x", "BAR", "y"), strip("z", "BAR", "q")];
    const stops = [1, 1, 1];
    // middle row is all BAR: a 1-coin bet takes it
    expect(evaluate(wheels, stops, 1)).toEqual({ payout: 100, symbol: "BAR" });
    // a bet too small for a line finds nothing
    const topOnly = [strip("a", "b", "7"), strip("c", "d", "7"), strip("e", "f", "7")];
    expect(evaluate(topOnly, stops, 1)).toBeNull();
    expect(evaluate(topOnly, stops, 2)).toEqual({ payout: 300, symbol: "7" });
    // anything that is not 7/BAR/CHERRY pays a flat 15
    const fish = [strip("a", "FISH", "b"), strip("c", "FISH", "d"), strip("e", "FISH", "f")];
    expect(evaluate(fish, stops, 1)).toEqual({ payout: 15, symbol: "FISH" });
    const cherry = [strip("a", "CHERRY", "b"), strip("c", "CHERRY", "d"), strip("e", "CHERRY", "f")];
    expect(evaluate(cherry, stops, 1)).toEqual({ payout: 8, symbol: "CHERRY" });
  });

  test.skipIf(!hasGen)("the luck flags gate what a match is allowed to pay", () => {
    const strip = (b: string, m: string, t: string): string[] => [b, m, t, "MOUSE"];
    const stops = [1, 1, 1];
    const seven = [strip("a", "7", "b"), strip("c", "7", "d"), strip("e", "7", "f")];
    // cannot win at all: a lined-up match is rolled past
    expect(checkForMatch(seven, stops, 1, false, false)[0]).toBe("roll");
    // may win, but a 7 or BAR still needs seven-and-bar mode
    expect(checkForMatch(seven, stops, 1, true, false)[0]).toBe("roll");
    expect(checkForMatch(seven, stops, 1, false, true)[0]).toBe("accept");
    const fish = [strip("a", "FISH", "b"), strip("c", "FISH", "d"), strip("e", "FISH", "f")];
    expect(checkForMatch(fish, stops, 1, true, false)[0]).toBe("accept");
  });

  test.skipIf(!hasGen)("wheel 1 slips past a centred cherry, and never stops in 7/BAR mode", () => {
    const cherry = [["x", "CHERRY", "y", "z"], [], []];
    const other = [["x", "FISH", "y", "z"], [], []];
    expect(stopWheel1Early(cherry, 1, false)).toBe(false);
    expect(stopWheel1Early(other, 1, false)).toBe(true);
    // pokered's own never-true comparison: in seven-and-bar mode it always slips
    expect(stopWheel1Early(other, 1, true)).toBe(false);
  });

  test.skipIf(!hasGen)("a seat needs a case and coins, and pays out into them", () => {
    const game = gcGame();
    const ow = game.overworld;
    const seats = (romData!.field as any).slotMachines.GAME_CORNER;
    const ok = seats.find((s: any) => s.state === "ok");
    const stand = (seat: any): void => {
      ow.setMap("GAME_CORNER", seat.x, seat.y + 1, "up");
      ow.player.cellX = seat.x;
      ow.player.cellY = seat.y + 1;
      ow.player.facing = "up";
      ow.interact();
    };
    // no COIN CASE
    stand(ok);
    expect(game.stackKinds().at(-1)).toBe("textbox");
    expect(topText(game)).toContain("COIN CASE");
    dismissText(game);

    // case but no coins
    game.save.inventory.COIN_CASE = 1;
    stand(ok);
    expect(topText(game)).toContain("any coins");
    dismissText(game);

    // and with both, the machine opens
    game.save.coins = 20;
    stand(ok);
    expect(game.stackKinds().at(-1)).toBe("slots");
    const v = game.slots() as { stage: string; grid: string[][] };
    expect(v.stage).toBe("intro");
    expect(v.grid.length).toBe(3);
    expect(v.grid[0]!.length).toBe(3);
  });

  test.skipIf(!hasGen)("a broken machine says so instead of opening", () => {
    const game = gcGame();
    game.save.inventory.COIN_CASE = 1;
    game.save.coins = 500;
    const seats = (romData!.field as any).slotMachines.GAME_CORNER;
    const broken = seats.find((s: any) => s.state !== "ok");
    expect(broken).toBeDefined();
    const ow = game.overworld;
    ow.setMap("GAME_CORNER", broken.x, broken.y + 1, "up");
    ow.player.cellX = broken.x;
    ow.player.cellY = broken.y + 1;
    ow.player.facing = "up";
    ow.interact();
    expect(game.stackKinds().at(-1)).toBe("textbox");
    expect(game.stackKinds()).not.toContain("slots");
  });

  test.skipIf(!hasGen)("a spin costs the bet up front", () => {
    const game = gcGame();
    game.save.inventory.COIN_CASE = 1;
    game.save.coins = 10;
    game.openSlots(false);
    tap(game, VOX_BTN.a); // YES, play
    const v = () => game.slots() as { stage: string; bet: number };
    expect(v().stage).toBe("bet");
    expect(v().bet).toBe(3); // the cursor defaults to x3
    tap(game, VOX_BTN.a);
    expect(game.save.coins).toBe(7);
    expect(v().stage).toBe("spinup");
  });

  test.skipIf(!hasGen)("the TM counter sells items, not mons", () => {
    const game = gcGame();
    game.save.inventory.COIN_CASE = 1;
    game.save.coins = 9999;
    talkAt(game, "GAME_CORNER_PRIZE_ROOM", "TEXT_GAMECORNERPRIZEROOM_PRIZE_VENDOR_3");
    const v = game.prizes() as { rows: { label: string; cost: number }[] };
    expect(v.rows[0]!.cost).toBe(3300);
    tap(game, VOX_BTN.a);
    let guard = 0;
    while (game.stackKinds().at(-1) !== "choice" && guard++ < 600) game.tick(0);
    tap(game, VOX_BTN.a);
    guard = 0;
    while (game.stackKinds().length > 1 && guard++ < 900) { dismissText(game); game.tick(0); }
    expect(game.save.inventory.TM_DRAGON_RAGE).toBe(1);
    expect(game.save.coins).toBe(9999 - 3300);
  });
});

describe("the safari zone", () => {
  /**
   * The importer's cookedMaps is the 11-map dev set (cook/cli.ts
   * DEFAULT_MAPS); the shipped pak's is all 219. Warps into a map outside it
   * are refused on purpose — the locked frontier — so a Safari test needs a
   * dataset that has the zone in it. Shallow-copied: nothing mutates data,
   * and romData is shared with every other suite.
   */
  function safariGame(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []),
        "SAFARI_ZONE_GATE", "SAFARI_ZONE_CENTER", "SAFARI_ZONE_EAST",
        "SAFARI_ZONE_NORTH", "SAFARI_ZONE_WEST",
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    return game;
  }

  /** Walk to the gate's join trigger and answer the prompt. */
  function joinPrompt(game: VoxelmonGame, yes: boolean): void {
    const ow = game.overworld;
    ow.setMap("SAFARI_ZONE_GATE", 4, 2, "up");
    ow.onStepComplete();
    let guard = 0;
    while (game.stackKinds().at(-1) !== "choice" && guard++ < 900) {
      dismissText(game);
      game.tick(0);
    }
    expect(game.stackKinds().at(-1)).toBe("choice");
    if (!yes) tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.a);
    // Driven for a fixed span, not "until the stack empties": the script
    // outlives its text boxes — the walk into the zone and the warp it ends
    // on are script rows that need ticks after the last box closes.
    for (let i = 0; i < 900; i++) {
      dismissText(game);
      game.tick(0);
    }
  }

  test.skipIf(!hasGen)("paying buys 30 balls and a 500-step hunt", () => {
    const game = safariGame();
    game.save.money = 1000;
    joinPrompt(game, true);
    expect(game.save.money).toBe(500);
    expect(game.save.safari?.balls).toBe(30);
    // wSafariSteps is written 502; the scripted walk in spends two of them,
    // which is why the counter reads 500 on arrival
    expect(game.save.safari?.steps).toBe(500);
    // ...and that walk is what puts the player in the zone
    expect(game.overworld.map.id).toBe("SAFARI_ZONE_CENTER");
  });

  test.skipIf(!hasGen)("declining, or being broke, buys nothing", () => {
    const no = safariGame();
    no.save.money = 1000;
    joinPrompt(no, false);
    expect(no.save.money).toBe(1000);
    expect(no.save.safari).toBeUndefined();
    expect(no.overworld.map.id).toBe("SAFARI_ZONE_GATE");

    const broke = safariGame();
    broke.save.money = 499;
    joinPrompt(broke, true);
    expect(broke.save.money).toBe(499);
    expect(broke.save.safari).toBeUndefined();
  });

  test.skipIf(!hasGen)("steps only count inside the zone, and time runs out", () => {
    const game = safariGame();
    const ow = game.overworld;
    game.save.safari = { balls: 30, steps: 3 };

    // the gate is not a step map
    ow.setMap("SAFARI_ZONE_GATE", 4, 3, "down");
    ow.onStepComplete();
    expect(game.save.safari?.steps).toBe(3);

    ow.setMap("SAFARI_ZONE_CENTER", 15, 20, "down");
    ow.onStepComplete();
    expect(game.save.safari?.steps).toBe(2);
    ow.onStepComplete();
    expect(game.save.safari?.steps).toBe(1);
    // the last step ends the game: the PA calls it and the save field clears
    ow.onStepComplete();
    expect(game.save.safari).toBeNull();
    expect(topText(game)).toContain("Time's up");
    // ...and dismissing it warps back to the gate
    let guard = 0;
    while (game.overworld.map.id !== "SAFARI_ZONE_GATE" && guard++ < 900) {
      dismissText(game);
      game.tick(0);
    }
    expect(game.overworld.map.id).toBe("SAFARI_ZONE_GATE");
  });

  test.skipIf(!hasGen)("the counter shows in the START menu, only in a hunt", () => {
    const game = safariGame();
    tap(game, VOX_BTN.start);
    expect((game.startMenu() as { safari: unknown }).safari).toBeNull();
    tap(game, VOX_BTN.b);
    game.save.safari = { balls: 7, steps: 123 };
    tap(game, VOX_BTN.start);
    expect((game.startMenu() as { safari: unknown }).safari).toEqual({ balls: 7, steps: 123 });
  });

  test.skipIf(!hasGen)("a wild encounter in the zone is the BALL/BAIT/ROCK game", () => {
    const game = safariGame();
    game.save.party.push(newMon(romData!, "SQUIRTLE", 20));
    game.save.safari = { balls: 30, steps: 400 };
    game.overworld.setMap("SAFARI_ZONE_CENTER", 15, 20, "down");
    game.pushStubBattle("NIDORAN_M", 22);
    const b = (game.battleView() as { battle: any }).battle;
    expect(b.isSafari).toBe(true);
    // no mon is sent out, so the player's card and HUD stay hidden
    expect(b.showPlayerBack).toBe(true);
    const base = (romData!.pokemon as any).NIDORAN_M.catchRate;
    expect(b.catchFactor).toBe(base);

    // BAIT halves the working rate and starts it eating; ROCK doubles it
    b.safariAction("bait");
    expect(b.catchFactor).toBe(Math.floor(base / 2));
    expect(b.baitFactor).toBeGreaterThan(0);
    expect(b.escapeFactor).toBe(0);
    b.safariAction("rock");
    expect(b.catchFactor).toBe(Math.min(255, Math.floor(base / 2) * 2));
    expect(b.escapeFactor).toBeGreaterThan(0);
    expect(b.baitFactor).toBe(0); // each zeroes the other

    // a ball comes out of the hunt's own supply
    b.safariAction("ball");
    expect(game.save.safari.balls).toBe(29);
  });

  test.skipIf(!hasGen)("the last ball ends the hunt, not just the battle", () => {
    const game = safariGame();
    game.save.party.push(newMon(romData!, "SQUIRTLE", 20));
    game.save.safari = { balls: 0, steps: 400 };
    game.overworld.setMap("SAFARI_ZONE_CENTER", 15, 20, "down");
    game.pushStubBattle("NIDORAN_M", 22);
    const b = (game.battleView() as { battle: any }).battle;
    // reaching the menu with no balls left is game over
    let guard = 0;
    while (!b.outOfBalls && guard++ < 900) game.tick(guard % 2 === 0 ? VOX_BTN.a : 0);
    expect(b.outOfBalls).toBe(true);
    guard = 0;
    while (game.stackKinds().includes("battle") && guard++ < 1200) {
      game.tick(guard % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(game.save.safari).toBeNull();
  });
});

describe("gym leaders", () => {
  /** map, leader text, class, roster, beat flag, badge, TM, got flag. */
  const GYMS: [string, string, string, number, string, string, string, string][] = [
    ["PEWTER_GYM", "TEXT_PEWTERGYM_BROCK", "OPP_BROCK", 1,
     "EVENT_BEAT_BROCK", "BOULDERBADGE", "TM_BIDE", "EVENT_GOT_TM34"],
    ["CERULEAN_GYM", "TEXT_CERULEANGYM_MISTY", "OPP_MISTY", 1,
     "EVENT_BEAT_MISTY", "CASCADEBADGE", "TM_BUBBLEBEAM", "EVENT_GOT_TM11"],
    ["VERMILION_GYM", "TEXT_VERMILIONGYM_LT_SURGE", "OPP_LT_SURGE", 1,
     "EVENT_BEAT_LT_SURGE", "THUNDERBADGE", "TM_THUNDERBOLT", "EVENT_GOT_TM24"],
    ["CELADON_GYM", "TEXT_CELADONGYM_ERIKA", "OPP_ERIKA", 1,
     "EVENT_BEAT_ERIKA", "RAINBOWBADGE", "TM_MEGA_DRAIN", "EVENT_GOT_TM21"],
    ["FUCHSIA_GYM", "TEXT_FUCHSIAGYM_KOGA", "OPP_KOGA", 1,
     "EVENT_BEAT_KOGA", "SOULBADGE", "TM_TOXIC", "EVENT_GOT_TM06"],
    ["SAFFRON_GYM", "TEXT_SAFFRONGYM_SABRINA", "OPP_SABRINA", 1,
     "EVENT_BEAT_SABRINA", "MARSHBADGE", "TM_PSYWAVE", "EVENT_GOT_TM46"],
    ["CINNABAR_GYM", "TEXT_CINNABARGYM_BLAINE", "OPP_BLAINE", 1,
     "EVENT_BEAT_BLAINE", "VOLCANOBADGE", "TM_FIRE_BLAST", "EVENT_GOT_TM38"],
    ["VIRIDIAN_GYM", "TEXT_VIRIDIANGYM_GIOVANNI", "OPP_GIOVANNI", 3,
     "EVENT_BEAT_GIOVANNI", "EARTHBADGE", "TM_FISSURE", "EVENT_GOT_TM27"],
  ];

  /** Talk to the leader with the battle stubbed to `won`; returns the call. */
  function fightLeader(
    game: VoxelmonGame, map: string, text: string, won: boolean,
  ): { id: string; party: number } | null {
    let call: { id: string; party: number } | null = null;
    (game as any).startTrainerBattle = (
      id: string, party: number, _n: unknown, onDone: (w: boolean) => void,
    ) => { call = { id, party }; onDone(won); };
    game.overworld.setMap(map, 4, 4, "up");
    game.overworld.showMapText(text);
    for (let i = 0; i < 1500 && game.stackKinds().length > 1; i++) {
      dismissText(game);
      game.tick(0);
    }
    return call;
  }

  test.skipIf(!hasGen)("all eight hand over their badge and TM on a win", () => {
    for (const [map, text, cls, party, beat, badge, tm, gotFlag] of GYMS) {
      const game = makeMenuGame();
      game.save.party.push(newMon(romData!, "SQUIRTLE", 40));
      const call = fightLeader(game, map, text, true);
      expect(call, `${map} started no battle`).toEqual({ id: cls, party });
      expect(game.save.flags[beat], `${map} beat flag`).toBe(true);
      expect(game.save.inventory[badge], `${map} badge`).toBe(1);
      expect(game.save.inventory[tm], `${map} TM`).toBe(1);
      expect(game.save.flags[gotFlag], `${map} TM flag`).toBe(true);
    }
  });

  test.skipIf(!hasGen)("a loss hands over nothing", () => {
    for (const [map, text, , , beat, badge, tm] of GYMS) {
      const game = makeMenuGame();
      game.save.party.push(newMon(romData!, "SQUIRTLE", 5));
      fightLeader(game, map, text, false);
      expect(game.save.flags[beat], `${map} beat flag`).toBeUndefined();
      expect(game.save.inventory[badge], `${map} badge`).toBeUndefined();
      expect(game.save.inventory[tm], `${map} TM`).toBeUndefined();
    }
  });

  test.skipIf(!hasGen)("a beaten leader talks instead of re-battling", () => {
    const game = makeMenuGame();
    game.save.party.push(newMon(romData!, "SQUIRTLE", 40));
    fightLeader(game, "CELADON_GYM", "TEXT_CELADONGYM_ERIKA", true);
    // second visit: no battle is started at all
    const again = fightLeader(game, "CELADON_GYM", "TEXT_CELADONGYM_ERIKA", true);
    expect(again).toBeNull();
    expect(game.save.inventory.RAINBOWBADGE).toBe(1); // not a second one
    expect(game.save.inventory.TM_MEGA_DRAIN).toBe(1);
  });

  test.skipIf(!hasGen)("Giovanni fights his GYM roster and then leaves", () => {
    const game = makeMenuGame();
    game.save.party.push(newMon(romData!, "SQUIRTLE", 50));
    // his first two rosters are the Rocket Hideout and Silph Co.
    const call = fightLeader(game, "VIRIDIAN_GYM", "TEXT_VIRIDIANGYM_GIOVANNI", true);
    expect(call).toEqual({ id: "OPP_GIOVANNI", party: 3 });
    expect(game.save.objectToggles?.VIRIDIAN_GYM?.VIRIDIANGYM_GIOVANNI).toBeUndefined();
    // he says his farewell on the next talk, and is gone after it
    fightLeader(game, "VIRIDIAN_GYM", "TEXT_VIRIDIANGYM_GIOVANNI", true);
    expect(game.save.objectToggles?.VIRIDIAN_GYM?.VIRIDIANGYM_GIOVANNI).toBe(false);
  });
});

describe("poke marts", () => {
  /** Every (map label, TEXT_*) the dataset marks as a mart clerk. */
  function clerks(): { label: string; text: string; stock: string[] }[] {
    const out: { label: string; text: string; stock: string[] }[] = [];
    const tp = (romData! as any).text_pointers as Record<string, Record<string, any>>;
    for (const [label, entries] of Object.entries(tp)) {
      for (const [text, entry] of Object.entries(entries)) {
        if (entry && Array.isArray(entry.mart) && entry.mart.length > 0) {
          out.push({ label, text, stock: entry.mart });
        }
      }
    }
    return out;
  }

  test.skipIf(!hasGen)("every clerk in the data resolves its own stock", () => {
    const all = clerks();
    // pokered's marts.asm has fourteen: the eight town marts, the Indigo
    // Plateau lobby, and Celadon's five department-store counters.
    expect(all.length).toBe(14);
    for (const c of all) {
      expect(martStock(romData! as never, c.label, c.text)).toEqual(c.stock);
      // and every one of them can actually be sold: a real item with a price
      for (const id of c.stock) {
        expect((romData!.items as any)[id], `${c.label} sells ${id}`).toBeDefined();
        expect((romData!.items as any)[id].price).toBeGreaterThan(0);
      }
    }
    // not a clerk -> no stock, so an ordinary NPC never opens a shop
    expect(martStock(romData! as never, "CeruleanMart", "TEXT_CERULEANMART_COOLTRAINER_F")).toBeNull();
  });

  test.skipIf(!hasGen)("talking to a clerk opens the shop with their list", () => {
    // Cerulean, which sold nothing before: its stock was in the pak all along
    // and only Viridian's and Pewter's were transcribed into the port.
    const game = makeMenuGame();
    const ow = game.overworld;
    ow.setMap("CERULEAN_MART", 3, 5, "up");
    ow.showMapText("TEXT_CERULEANMART_CLERK");
    let guard = 0;
    while (game.stackKinds().at(-1) !== "shop" && guard++ < 900) {
      dismissText(game);
      game.tick(0);
    }
    expect(game.stackKinds().at(-1)).toBe("shop");
    // the shop opens on BUY / SELL / QUIT; BUY is what builds the list
    expect((game.shop() as { mode: string }).mode).toBe("menu");
    tap(game, VOX_BTN.a);
    const shop = game.shop() as { mode: string; list: { label: string }[] };
    expect(shop.mode).toBe("list");
    expect(shop.list.map((e) => e.label)).toEqual([
      "POKé BALL", "POTION", "REPEL", "ANTIDOTE",
      "BURN HEAL", "AWAKENING", "PARLYZ HEAL",
    ]);
  });
});

describe("catching a pokemon", () => {
  /** Run a caught battle to its finish and return the game. */
  function catchOne(game: VoxelmonGame, species: string): void {
    game.pushStubBattle(species, 5);
    const battle = (game.battleView() as { battle: any }).battle;
    // storeCaughtMon normally runs from an act row mid-queue; called cold the
    // battle is still parked on its action menu and would wait for input.
    battle.phase = "messages";
    battle.storeCaughtMon();
    // The battle's messages are its own, not textbox states, so they need A
    // edges fed to the battle itself; alternate so each tick is a fresh press.
    for (let i = 0; i < 1200 && game.stackKinds().includes("battle"); i++) {
      game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    }
    game.tick(0);
  }

  test.skipIf(!hasGen)("a new species is marked owned and shows its entry", () => {
    const game = makeMenuGame();
    game.save.party.push(newMon(romData!, "SQUIRTLE", 5));
    expect(game.save.pokedex.owned.PIDGEY).toBeUndefined();

    catchOne(game, "PIDGEY");
    expect(game.save.pokedex.owned.PIDGEY).toBe(true);

    // the line, then the data page itself — ShowPokedexData, not the list
    expect(topText(game)).toContain("New POKéDEX data");
    dismissText(game);
    expect(game.stackKinds().at(-1)).toBe("pokedex");
    const dex = game.pokedexScreen() as { mode: string; entry: { name: string } | null };
    expect(dex.mode).toBe("entry");
    expect(dex.entry?.name).toBe("PIDGEY");

    // a button closes the whole screen rather than dropping into the list
    tap(game, VOX_BTN.a);
    expect(game.stackKinds()).toEqual(["overworld"]);
  });

  test.skipIf(!hasGen)("a species already owned shows no entry", () => {
    const game = makeMenuGame();
    game.save.party.push(newMon(romData!, "SQUIRTLE", 5));
    game.save.pokedex.owned.PIDGEY = true;
    catchOne(game, "PIDGEY");
    expect(game.stackKinds()).toEqual(["overworld"]);
  });
});

describe("battle and encounter music", () => {
  /** Every song the audio director was asked for, in order. */
  function songLog(game: VoxelmonGame): string[] {
    const audio = (game as unknown as { audio: any }).audio;
    if (!audio.__log) {
      audio.__log = [];
      for (const m of ["play", "playBattle", "playVictory", "playOnce", "startMap", "restore"]) {
        const orig = audio[m].bind(audio);
        audio[m] = (...args: unknown[]) => {
          audio.__log.push(`${m}:${args[0] ?? ""}`);
          return orig(...args);
        };
      }
    }
    return audio.__log as string[];
  }

  test.skipIf(!hasGen)("a trainer's victory theme waits for their LAST mon", () => {
    const game = makeMenuGame();
    game.save.party.push(newMon(romData!, "SQUIRTLE", 60));
    const battle = new TrainerBattle(
      romData!, game.save as never, seqRng(0), "OPP_BROCK", 1,
    );
    // Brock leads with two mons, so downing the first must decide nothing.
    // Asked directly rather than through onFaint: the cue is pushed from a
    // queued act row, so an empty audioCues right after a faint would pass
    // whether or not the bug was fixed.
    expect((battle as any).enemyParty.length).toBeGreaterThan(1);
    expect((battle as any).victoryMusicKind()).toBeNull();

    // with the rest down the faint IS the win, and it is the leader's jingle
    // rather than the wild one
    for (const m of (battle as any).enemyParty) m.hp = 0;
    expect((battle as any).victoryMusicKind()).toBe("gym");

    // an ordinary trainer takes trainerWin, a wild mon wildWin
    const grunt = new TrainerBattle(
      romData!, game.save as never, seqRng(0), "OPP_YOUNGSTER", 1,
    );
    for (const m of (grunt as any).enemyParty) m.hp = 0;
    expect((grunt as any).victoryMusicKind()).toBe("trainer");
    const wild = new WildBattle(romData!, game.save as never, seqRng(0), "PIDGEY", 3);
    expect((wild as any).victoryMusicKind()).toBe("wild");
  });

  test.skipIf(!hasGen)("the battle theme is the battle's own role", () => {
    const game = makeMenuGame();
    game.save.party.push(newMon(romData!, "SQUIRTLE", 10));
    const wild = new WildBattle(romData!, game.save as never, seqRng(0), "PIDGEY", 3);
    expect(wild.musicKind()).toBe("wild");
    const mk = (id: string, party = 1): string =>
      new TrainerBattle(romData!, game.save as never, seqRng(0), id, party).musicKind();
    expect(mk("OPP_YOUNGSTER")).toBe("trainer");
    expect(mk("OPP_BROCK")).toBe("gym");
    expect(mk("OPP_LANCE")).toBe("gym");
    expect(mk("OPP_RIVAL3")).toBe("final");
    // Giovanni's gym roster is his THIRD; the earlier two are ordinary fights
    expect(mk("OPP_GIOVANNI", 1)).toBe("trainer");
    expect(mk("OPP_GIOVANNI", 2)).toBe("trainer");
    expect(mk("OPP_GIOVANNI", 3)).toBe("gym");
  });

  test.skipIf(!hasGen)("a trainer's sight line starts the encounter sting", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    game.save.party.push(newMon(romData!, "SQUIRTLE", 10));
    ow.setMap("ROUTE_3", 11, 6, "down");
    const log = songLog(game);
    const npc = ow.npcs.find((n: any) => n.def.trainerClass)!;
    // stand on the trainer's line, one cell in front of them
    const p = ow.player;
    const vec: Record<string, [number, number]> = {
      up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
    };
    const v = vec[npc.facing]!;
    p.cellX = npc.cellX + v[0];
    p.cellY = npc.cellY + v[1];
    log.length = 0;
    ow.checkTrainerSight();
    // PlayTrainerMusic fires with the "!", before the walk-up — not when the
    // battle opens, which is why the route theme used to run straight through
    expect(log.some((s) => s.startsWith("playOnce:Music_Meet"))).toBe(true);
  });
});

describe("the S.S. Anne rival", () => {
  test.skipIf(!hasGen)("ambushes in the cabin corridor, countering your starter", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    game.save.party.push(newMon(romData!, "SQUIRTLE", 20));
    game.save.flags.EVENT_CHOSE_SQUIRTLE = true;
    ow.setMap("SS_ANNE_2F", 37, 8, "up");
    // He is `hidden` in the map data, so there is nobody to talk to until
    // the coord trigger shows him — which is why a talk script could not
    // have run this scene.
    const onMap = (): boolean => ow.npcs.some((n: any) => n.def.name === "SSANNE2F_RIVAL");
    expect(onMap()).toBe(false);

    ow.onStepComplete();
    let guard = 0;
    while (game.stackKinds().at(-1) !== "textbox" && guard++ < 600) game.tick(0);
    expect(onMap()).toBe(true);
    expect(topText(game)).toContain("Bonjour");

    dismissText(game);
    guard = 0;
    while (game.stackKinds().at(-1) !== "battle" && guard++ < 900) game.tick(0);
    expect(game.stackKinds().at(-1)).toBe("battle");
    // rival_battle offsets the party by your starter: Squirtle means he took
    // BULBASAUR, so his last mon is its middle stage.
    const battle = (game.battleView() as { battle: any }).battle;
    expect(battle.enemyParty.map((m: any) => m.species)).toEqual([
      "PIDGEOTTO", "RATICATE", "KADABRA", "IVYSAUR",
    ]);
  });

  test.skipIf(!hasGen)("beating him sets the flag and walks him out", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    game.save.party.push(newMon(romData!, "SQUIRTLE", 20));
    (game as any).startTrainerBattle = (
      _id: string, _idx: number, _name: unknown, onDone: (won: boolean) => void,
    ) => onDone(true);
    ow.setMap("SS_ANNE_2F", 37, 8, "up");
    ow.onStepComplete();
    for (let i = 0; i < 1200; i++) {
      dismissText(game);
      if (game.save.objectToggles?.SS_ANNE_2F?.SSANNE2F_RIVAL === false) break;
      game.tick(0);
    }
    expect(game.save.flags.EVENT_BEAT_SS_ANNE_RIVAL).toBe(true);
    // hide_object is the last row: he leaves rather than standing in the hall
    expect(game.save.objectToggles?.SS_ANNE_2F?.SSANNE2F_RIVAL).toBe(false);
  });

  test.skipIf(!hasGen)("does not fire again once beaten", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    game.save.party.push(newMon(romData!, "SQUIRTLE", 20));
    game.save.flags.EVENT_BEAT_SS_ANNE_RIVAL = true;
    ow.setMap("SS_ANNE_2F", 37, 8, "up");
    ow.onStepComplete();
    for (let i = 0; i < 60; i++) game.tick(0);
    expect(game.stackKinds()).toEqual(["overworld"]);
    expect(ow.npcs.some((n: any) => n.def.name === "SSANNE2F_RIVAL")).toBe(false);
  });
});

describe("the town map", () => {
  /**
   * The atlas index is the COOK's product and arrives with the pak's
   * gamedata; loadRuntimeData reads the importer's output, which has none.
   * The gear checks it before offering a MAP tab (a pak cooked before the
   * town map pages existed must not draw one), so a test needs it present.
   */
  function withAtlas(game: VoxelmonGame): VoxelmonGame {
    (game.data as { atlas?: unknown }).atlas = {
      ...(game.data as { atlas?: object }).atlas,
      townMapPage: 426,
      townMapCursorPage: 427,
    };
    return game;
  }

  test.skipIf(!hasGen)("Blue's sister hands it over once Oak has sent you out", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    ow.setMap("BLUES_HOUSE", 3, 4, "up");

    // before the starter she only says where her brother is
    ow.showMapText("TEXT_BLUESHOUSE_DAISY_SITTING");
    dismissText(game);
    expect(game.save.inventory.TOWN_MAP).toBeUndefined();
    expect(game.save.flags.EVENT_GOT_TOWN_MAP).toBeUndefined();

    game.save.flags.EVENT_GOT_STARTER = true;
    ow.showMapText("TEXT_BLUESHOUSE_DAISY_SITTING");
    let guard = 0;
    while (game.stackKinds().length > 1 && guard++ < 900) dismissText(game);
    expect(game.save.inventory.TOWN_MAP).toBe(1);
    expect(game.save.flags.EVENT_GOT_TOWN_MAP).toBe(true);

    // talking again repeats the advice, it does not hand out a second map
    ow.showMapText("TEXT_BLUESHOUSE_DAISY_SITTING");
    guard = 0;
    while (game.stackKinds().length > 1 && guard++ < 900) dismissText(game);
    expect(game.save.inventory.TOWN_MAP).toBe(1);
  });

  test.skipIf(!hasGen)("the MAP tab appears only once the map is in the bag", () => {
    const game = withAtlas(makeMenuGame());
    expect(gearTabs(game as never).map((t) => t.id)).toEqual(["party"]);
    game.save.inventory.TOWN_MAP = 1;
    expect(gearTabs(game as never).map((t) => t.id)).toEqual(["party", "map"]);
  });

  test.skipIf(!hasGen)("a pak with no town map pages offers no MAP tab", () => {
    const game = makeMenuGame();
    game.save.inventory.TOWN_MAP = 1;
    (game.data as { atlas?: unknown }).atlas = { townMapPage: null };
    expect(gearTabs(game as never).map((t) => t.id)).toEqual(["party"]);
  });

  test.skipIf(!hasGen)("L/R and the header arrows both step the view", () => {
    const game = withAtlas(makeMenuGame());
    game.save.inventory.TOWN_MAP = 1;
    expect(game.gearView).toBe("party");

    game.cycleGearView(1); // the R shoulder
    expect(game.gearView).toBe("map");
    game.cycleGearView(1); // wraps
    expect(game.gearView).toBe("party");
    game.cycleGearView(-1);
    expect(game.gearView).toBe("map");

    // the header's ▶ does the same. "◀ PARTY ▶" is 9 wide, centred in the 12
    // columns left of the clock, so the right arrow sits at column 9.
    game.setGearView("party");
    gearTouchDown(game as never, 9 * 16 + 8, 4);
    expect(game.gearView).toBe("map");
  });

  test.skipIf(!hasGen)("tapping the map picks a place; tapping the sea clears it", () => {
    const game = withAtlas(makeMenuGame());
    game.save.inventory.TOWN_MAP = 1;
    game.overworld.setMap("PALLET_TOWN", 5, 6, "down");
    game.setGearView("map");
    // with nothing picked the marker follows the player
    expect(game.gearMapPick).toBeNull();

    const locs = (romData!.field as any).townMap.locations;
    const at = gearMapPoint(locs.CELADON_CITY);
    gearTouchDown(game as never, at.x, at.y);
    expect(game.gearMapPick).toBe("CELADON_CITY");

    // and a far-off corner of the sea is no place at all
    const sea = gearMapPoint({ name: "", x: 15, y: 0 });
    gearTouchDown(game as never, sea.x, sea.y);
    expect(game.gearMapPick).toBeNull();
  });
});

describe("save screen", () => {
  test.skipIf(!hasGen)("panel, question, then a timed write with no press", () => {
    const game = makeMenuGame();
    const host = (game as unknown as { host: MenuHost }).host;
    game.save.inventory.BOULDERBADGE = 1;
    (game.save as any).pokedex = { seen: {}, owned: { PIDGEY: true } };
    (game.save as any).playTime = 3 * 3600 + 5 * 60;

    tap(game, VOX_BTN.start);
    const sm = game.startMenu() as { entries: string[] };
    pick(game, sm.entries.indexOf("SAVE"));
    // the SaveScreen window is up, and it is its OWN window: four lines,
    // where the dialogue box holds two
    expect(game.savePanel()).toEqual([
      "PLAYER RED", "BADGES    1", "POKéDEX   1", "TIME      3:05",
    ]);
    expect(topText(game)).toContain("Would you like to");

    // the YES/NO opens once the question finishes typing
    let guard = 0;
    while (game.stackKinds().at(-1) !== "choice" && guard++ < 600) game.tick(0);
    expect(game.stackKinds().at(-1)).toBe("choice");
    expect(host.saved).toBeUndefined();
    tap(game, VOX_BTN.a); // YES

    // "Now saving..." takes no press and holds ~120 frames before the write
    expect(host.saved).toBeUndefined();
    guard = 0;
    while (host.saved === undefined && guard++ < 900) game.tick(0);
    expect(host.saved).toBeDefined();
    expect(host.saved).toContain("REDS_HOUSE_2F"); // the live position
    // ...then "RED saved the game!", also untouched by input, and the
    // panel comes down only when the whole flow is over
    expect(game.savePanel()).not.toBeNull();
    guard = 0;
    while (game.savePanel() !== null && guard++ < 900) game.tick(0);
    expect(game.stackKinds()).toEqual(["overworld", "startmenu"]);
  });

  test.skipIf(!hasGen)("answering NO writes nothing and takes the panel down", () => {
    const game = makeMenuGame();
    const host = (game as unknown as { host: MenuHost }).host;
    tap(game, VOX_BTN.start);
    const sm = game.startMenu() as { entries: string[] };
    pick(game, sm.entries.indexOf("SAVE"));
    let guard = 0;
    while (game.stackKinds().at(-1) !== "choice" && guard++ < 600) game.tick(0);
    tap(game, VOX_BTN.down); // NO
    tap(game, VOX_BTN.a);
    guard = 0;
    while (game.savePanel() !== null && guard++ < 300) game.tick(0);
    expect(host.saved).toBeUndefined();
  });
});

describe("options", () => {
  test.skipIf(!hasGen)("TEXT SPEED sets the typewriter delay the box uses", () => {
    const game = makeMenuGame();
    tap(game, VOX_BTN.start);
    const sm = game.startMenu() as { entries: string[] };
    pick(game, sm.entries.indexOf("OPTION"));
    expect(game.stackKinds().at(-1)).toBe("options");

    const view = () => game.optionsMenu() as { rows: { label: string; choices: string[]; index: number }[]; index: number };
    expect(view().rows[0]!.label).toBe("TEXT SPEED");
    expect(view().rows[0]!.choices).toEqual(["FAST", "MEDIUM", "SLOW"]);
    expect(view().rows[0]!.index).toBe(1); // InitOptions' TEXT_DELAY_MEDIUM
    expect(game.textSpeed()).toBe(3);

    tap(game, VOX_BTN.left); // MEDIUM -> FAST
    expect(view().rows[0]!.index).toBe(0);
    expect(game.save.options.textSpeed).toBe(1);
    expect(game.textSpeed()).toBe(1);

    tap(game, VOX_BTN.left); // wraps to SLOW
    expect(game.textSpeed()).toBe(5);
  });

  test.skipIf(!hasGen)("BATTLE ANIMATION off skips move anims, never the faint", () => {
    const game = makeMenuGame();
    tap(game, VOX_BTN.start);
    const sm = game.startMenu() as { entries: string[] };
    pick(game, sm.entries.indexOf("OPTION"));
    tap(game, VOX_BTN.down); // to BATTLE ANIMATION
    tap(game, VOX_BTN.right); // ON -> OFF
    expect(game.save.options.animations).toBe(false);
    expect(game.animationsOn()).toBe(false);

    // the battle reads the same save key, and the faint slide is not a move
    // animation — without it a fainted mon would vanish instead of sinking
    tap(game, VOX_BTN.b); // close the options
    game.save.party.push(newMon(romData!, "SQUIRTLE", 5));
    game.pushStubBattle("PIDGEY", 3);
    const battle = (game.battleView() as { battle: any }).battle;
    expect(battle.animationsOn()).toBe(false);
    expect(battle.startAnim("lunge", 0)).toBe(0);
    expect(battle.startAnim("faint", 0)).toBeGreaterThan(0);
  });

  test.skipIf(!hasGen)("CANCEL closes back to the start menu", () => {
    const game = makeMenuGame();
    tap(game, VOX_BTN.start);
    const sm = game.startMenu() as { entries: string[] };
    pick(game, sm.entries.indexOf("OPTION"));
    tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.down); // CANCEL
    tap(game, VOX_BTN.a);
    expect(game.stackKinds()).toEqual(["overworld", "startmenu"]);
  });
});

describe("trainer card", () => {
  test.skipIf(!hasGen)("shows the name, money, time and the badge slots", () => {
    const game = makeMenuGame();
    game.save.money = 1234;
    game.save.playTime = 3 * 3600 + 7 * 60 + 45;
    game.save.inventory.BOULDERBADGE = 1;
    game.save.inventory.SOULBADGE = 1;

    tap(game, VOX_BTN.start);
    const sm = game.startMenu() as { entries: string[] };
    pick(game, sm.entries.indexOf("RED")); // the player-name entry
    expect(game.stackKinds().at(-1)).toBe("trainercard");

    const card = game.trainerCard() as {
      name: string; money: number; time: string;
      badges: { n: number; name: string; owned: boolean }[];
    };
    expect(card.name).toBe("RED");
    expect(card.money).toBe(1234);
    expect(card.time).toBe("3:07");
    expect(card.badges).toHaveLength(8);
    expect(card.badges[0]).toEqual({ n: 1, name: "BOULDER", owned: true });
    expect(card.badges[1]).toEqual({ n: 2, name: "CASCADE", owned: false });
    expect(card.badges[4]).toEqual({ n: 5, name: "SOUL", owned: true });
    // either button closes it, back to the start menu with its cursor kept
    tap(game, VOX_BTN.b);
    expect(game.stackKinds().at(-1)).toBe("startmenu");
  });

  test.skipIf(!hasGen)("play time accrues a second per 60 ticks", () => {
    const game = makeMenuGame();
    expect(game.save.playTime).toBeUndefined(); // lazily created, as in the Lua
    for (let i = 0; i < 60; i++) game.tick(0);
    expect(game.save.playTime).toBe(1);
    for (let i = 0; i < 59; i++) game.tick(0);
    expect(game.save.playTime).toBe(1);
    game.tick(0);
    expect(game.save.playTime).toBe(2);
  });
});
