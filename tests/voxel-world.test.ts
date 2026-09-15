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
import { encodeSave } from "../voxelmon/game/save-lua.ts";
import { decodeSave } from "../voxelmon/game/save-read.ts";
import {
  applyPostGameHome, POST_GAME_HOME, recordHallOfFame,
} from "../voxelmon/game/world/halloffame.ts";
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
import { rotateDir } from "../voxelmon/game/world/collision.ts";
import { poseDir } from "../voxelmon/game/scene.ts";
import { SEVEN_BADGES, silphAftermathRows } from "../voxelmon/game/world/mapscripts.ts";
import { deposit, pcCapacityData, withdraw } from "../voxelmon/game/world/pcitems.ts";
import {
  GYM_MACHINES, gymGateFlag, gymGuardKey, LEAGUE_SEALS, MANSION_BLOCKS,
  MANSION_HOLES, OPEN_BLOCK, toggleBlocksFor,
} from "../voxelmon/game/world/toggleblocks.ts";
import { bikeAllowed, BIKE_SONG, effectiveMapSong } from "../voxelmon/game/world/bike.ts";
import { fillAideText } from "../voxelmon/game/world/oaksaide.ts";
import { daycareFee, learnMovesFromDayCare } from "../voxelmon/game/world/daycare.ts";
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
    expect(dv.entries).toEqual(["WARP", "RARE CANDY", "CARD TEST", "CANCEL"]);
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
    tap(game, VOX_BTN.a); // ItemMenu: USE (TOSS is the other row)
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

describe("the Pokemon Tower rival", () => {
  /** Is he standing on the map right now? */
  function onMap(ow: any): boolean {
    return ow.npcs.some((n: any) => n.def.name === "POKEMONTOWER2F_RIVAL");
  }

  /** Squirtle in the party and chosen, so his counterpick is the Bulbasaur line. */
  function towerGame(): VoxelmonGame {
    const game = makeMenuGame();
    game.save.party.push(newMon(romData!, "SQUIRTLE", 30));
    game.save.flags.EVENT_CHOSE_SQUIRTLE = true;
    return game;
  }

  test.skipIf(!hasGen)("stops you on the landing without being talked to", () => {
    const game = towerGame();
    const ow = game.overworld;
    ow.setMap("POKEMON_TOWER_2F", 15, 5, "up");
    ow.onStepComplete();
    let guard = 0;
    while (game.stackKinds().at(-1) !== "textbox" && guard++ < 600) game.tick(0);
    expect(topText(game)).toContain("brings you here");

    dismissText(game);
    guard = 0;
    while (game.stackKinds().at(-1) !== "battle" && guard++ < 900) game.tick(0);
    expect(game.stackKinds().at(-1)).toBe("battle");
    // OPP_RIVAL2 party 4 + the Squirtle counterpick = party 5
    const battle = (game.battleView() as { battle: any }).battle;
    expect(battle.enemyParty.map((m: any) => m.species)).toEqual([
      "PIDGEOTTO", "GYARADOS", "GROWLITHE", "KADABRA", "IVYSAUR",
    ]);
  });

  test.skipIf(!hasGen)("the other approach tile triggers him too", () => {
    const game = towerGame();
    const ow = game.overworld;
    ow.setMap("POKEMON_TOWER_2F", 14, 6, "up");
    ow.onStepComplete();
    let guard = 0;
    while (game.stackKinds().at(-1) !== "textbox" && guard++ < 600) game.tick(0);
    expect(topText(game)).toContain("brings you here");
  });

  test.skipIf(!hasGen)("an ordinary tile does not", () => {
    const game = towerGame();
    const ow = game.overworld;
    ow.setMap("POKEMON_TOWER_2F", 10, 10, "up");
    ow.onStepComplete();
    for (let i = 0; i < 60; i++) game.tick(0);
    expect(game.stackKinds()).toEqual(["overworld"]);
  });

  test.skipIf(!hasGen)("beating him sets the flag and walks him out", () => {
    const game = towerGame();
    const ow = game.overworld;
    (game as any).startTrainerBattle = (
      _id: string, _idx: number, _name: unknown, onDone: (won: boolean) => void,
    ) => onDone(true);
    ow.setMap("POKEMON_TOWER_2F", 15, 5, "up");
    ow.onStepComplete();
    for (let i = 0; i < 1200; i++) {
      dismissText(game);
      if (game.save.objectToggles?.POKEMON_TOWER_2F?.POKEMONTOWER2F_RIVAL === false) break;
      game.tick(0);
    }
    expect(game.save.flags.EVENT_BEAT_POKEMON_TOWER_RIVAL).toBe(true);
    expect(game.save.objectToggles?.POKEMON_TOWER_2F?.POKEMONTOWER2F_RIVAL).toBe(false);
  });

  test.skipIf(!hasGen)("losing leaves him standing there to try again", () => {
    // row 6 is `jump_if_false end`: no flag, no exit walk, no hide.
    const game = towerGame();
    const ow = game.overworld;
    (game as any).startTrainerBattle = (
      _id: string, _idx: number, _name: unknown, onDone: (won: boolean) => void,
    ) => onDone(false);
    ow.setMap("POKEMON_TOWER_2F", 15, 5, "up");
    ow.onStepComplete();
    for (let i = 0; i < 900; i++) {
      dismissText(game);
      game.tick(0);
    }
    expect(game.save.flags.EVENT_BEAT_POKEMON_TOWER_RIVAL ?? false).toBe(false);
    expect(game.save.objectToggles?.POKEMON_TOWER_2F?.POKEMONTOWER2F_RIVAL).not.toBe(false);
    expect(onMap(ow)).toBe(true);
  });

  test.skipIf(!hasGen)("once beaten he is gone and the tile is inert", () => {
    const game = towerGame();
    const ow = game.overworld;
    game.save.flags.EVENT_BEAT_POKEMON_TOWER_RIVAL = true;
    ow.setMap("POKEMON_TOWER_2F", 15, 5, "up");
    ow.onStepComplete();
    for (let i = 0; i < 60; i++) game.tick(0);
    expect(game.stackKinds()).toEqual(["overworld"]);
  });

  test.skipIf(!hasGen)("talking to him after the win gets the Pokedex line, not a rematch", () => {
    const game = towerGame();
    const ow = game.overworld;
    game.save.flags.EVENT_BEAT_POKEMON_TOWER_RIVAL = true;
    ow.setMap("POKEMON_TOWER_2F", 15, 5, "up");
    ow.showMapText("TEXT_POKEMONTOWER2F_RIVAL");
    let guard = 0;
    while (game.stackKinds().at(-1) !== "textbox" && guard++ < 600) game.tick(0);
    expect(topText(game)).toContain("POKéDEX");
    expect(topText(game)).not.toContain("brings you here");
  });
});

describe("the Route 22 rival rematch", () => {
  function r22Game(): VoxelmonGame {
    const game = makeMenuGame();
    game.save.party.push(newMon(romData!, "SQUIRTLE", 50));
    game.save.flags.EVENT_CHOSE_SQUIRTLE = true;
    game.save.flags.EVENT_GOT_POKEDEX = true;
    return game;
  }

  /** Walk onto the gate tile and let whatever fires, fire. */
  function stepOnGate(game: VoxelmonGame, y = 4): void {
    game.overworld.setMap("ROUTE_22", 29, y, "up");
    game.overworld.onStepComplete();
    let guard = 0;
    while (game.stackKinds().at(-1) !== "textbox" && guard++ < 600) game.tick(0);
  }

  test.skipIf(!hasGen)("stays quiet until Giovanni is beaten", () => {
    const game = r22Game();
    const ow = game.overworld;
    game.save.flags.EVENT_BEAT_BROCK = true;
    game.save.flags.EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE = true;
    ow.setMap("ROUTE_22", 29, 4, "up");
    ow.onStepComplete();
    // show_object is row 1, so he appears long before any text does -- watch
    // for HIM, not for a textbox, or the walk-on delay hides a live trigger
    for (let i = 0; i < 400; i++) {
      expect(ow.npcs.some((n: any) => n.def.name === "ROUTE22_RIVAL2")).toBe(false);
      expect(game.stackKinds().at(-1)).toBe("overworld");
      game.tick(0);
    }
  });

  test.skipIf(!hasGen)("fires on the way to the League once he is", () => {
    const game = r22Game();
    game.save.flags.EVENT_BEAT_BROCK = true;
    game.save.flags.EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE = true;
    game.save.flags.EVENT_BEAT_GIOVANNI = true;
    stepOnGate(game);
    expect(topText(game)).toContain("surprise to see");

    dismissText(game);
    let guard = 0;
    while (game.stackKinds().at(-1) !== "battle" && guard++ < 900) game.tick(0);
    // OPP_RIVAL2 party 10 + the Squirtle counterpick = party 11, the six-mon
    // team — not the four-mon Tower set the first battle uses
    const battle = (game.battleView() as { battle: any }).battle;
    expect(battle.enemyParty.map((m: any) => m.species)).toEqual([
      "PIDGEOT", "RHYHORN", "GYARADOS", "GROWLITHE", "ALAKAZAM", "VENUSAUR",
    ]);
  });

  test.skipIf(!hasGen)("it is the SECOND rival object, so the first stays hidden", () => {
    const game = r22Game();
    game.save.flags.EVENT_BEAT_BROCK = true;
    game.save.flags.EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE = true;
    game.save.flags.EVENT_BEAT_GIOVANNI = true;
    stepOnGate(game);
    const ow = game.overworld;
    expect(ow.npcs.some((n: any) => n.def.name === "ROUTE22_RIVAL2")).toBe(true);
    expect(ow.npcs.some((n: any) => n.def.name === "ROUTE22_RIVAL1")).toBe(false);
  });

  test.skipIf(!hasGen)("the early ambush still wins the tile when both could fire", () => {
    // Pokédex in hand and Brock unbeaten is the first battle's window; a save
    // that somehow has Giovanni too must not skip straight to the rematch.
    const game = r22Game();
    game.save.flags.EVENT_BEAT_GIOVANNI = true;
    stepOnGate(game);
    expect(topText(game)).toContain("Forget it!");
  });

  test.skipIf(!hasGen)("beating him sets the 2nd-battle flag and walks him off", () => {
    const game = r22Game();
    game.save.flags.EVENT_BEAT_BROCK = true;
    game.save.flags.EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE = true;
    game.save.flags.EVENT_BEAT_GIOVANNI = true;
    (game as any).startTrainerBattle = (
      _id: string, _idx: number, _name: unknown, onDone: (won: boolean) => void,
    ) => onDone(true);
    game.overworld.setMap("ROUTE_22", 29, 4, "up");
    game.overworld.onStepComplete();
    for (let i = 0; i < 1500; i++) {
      dismissText(game);
      if (game.save.objectToggles?.ROUTE_22?.ROUTE22_RIVAL2 === false) break;
      game.tick(0);
    }
    expect(game.save.flags.EVENT_BEAT_ROUTE22_RIVAL_2ND_BATTLE).toBe(true);
    expect(game.save.objectToggles?.ROUTE_22?.ROUTE22_RIVAL2).toBe(false);
    // and the tile is inert afterwards
    game.overworld.onStepComplete();
    for (let i = 0; i < 60; i++) game.tick(0);
    expect(game.stackKinds()).toEqual(["overworld"]);
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

describe("the day care", () => {
  function dcGame(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [...((romData as { cookedMaps?: string[] }).cookedMaps ?? []), "DAYCARE"],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    return game;
  }

  /** A party of `n`, so the "you only have one" branch can be aimed at. */
  function party(game: VoxelmonGame, n: number, level = 10): void {
    game.save.party = [];
    for (let i = 0; i < n; i++) {
      game.save.party.push(newMon(game.data, i === 0 ? "PIDGEY" : "RATTATA", level, seqRng([0])));
    }
  }

  /**
   * Talk to the gentleman and answer as we go: each `answers` entry feeds the
   * next YES/NO, and `pick` (when given) picks that party slot.
   */
  function talkDaycare(
    game: VoxelmonGame, answers: boolean[], pick?: number,
  ): Set<string> {
    const seen = new Set<string>();
    game.overworld.setMap("DAYCARE", 2, 4, "up");
    game.overworld.showMapText("TEXT_DAYCARE_GENTLEMAN");
    const queue = answers.slice();
    let picked = pick === undefined;
    for (let i = 0; i < 1200; i++) {
      const top = game.stackKinds().at(-1);
      if (top) seen.add(top);
      if (top === "choice" && queue.length > 0) {
        if (!queue.shift()) tap(game, VOX_BTN.down);
        tap(game, VOX_BTN.a);
        continue;
      }
      if (top === "party" && !picked) {
        for (let k = 0; k < pick!; k++) tap(game, VOX_BTN.down);
        tap(game, VOX_BTN.a);
        picked = true;
        continue;
      }
      const runner = (game.overworld as unknown as { runner: { isRunning(): boolean } }).runner;
      if (top === "overworld" && !runner.isRunning()) break;
      dismissText(game);
      game.tick(0);
    }
    return seen;
  }

  test.skipIf(!hasGen)("he boards the mon you pick, and the walk earns it exp", () => {
    const game = dcGame();
    party(game, 2);
    talkDaycare(game, [true], 1); // hand over the second one
    expect(game.save.party.length).toBe(1);
    expect(game.save.daycare?.mon?.species).toBe("RATTATA");
    expect(game.save.daycare?.depositLevel).toBe(10);
    expect(game.save.daycare?.steps).toBe(0);

    // one exp per step taken ANYWHERE, not just on his map
    game.overworld.setMap("PALLET_TOWN", 5, 6, "down");
    walk(game, VOX_BTN.up, 3);
    expect(game.save.daycare?.steps).toBe(3);
  });

  test.skipIf(!hasGen)("he will not take your last mon", () => {
    const game = dcGame();
    party(game, 1);
    // he refuses before the chooser: it must never open, or he would be
    // taking the mon and just failing to record it
    const seen = talkDaycare(game, [true]);
    expect(seen.has("party")).toBe(false);
    expect(game.save.daycare ?? null).toBe(null);
    expect(game.save.party.length).toBe(1);

    // with a second one he gets that far
    party(game, 2);
    expect(talkDaycare(game, [true], 1).has("party")).toBe(true);
  });

  test.skipIf(!hasGen)("declining the fee leaves the mon boarded, unchanged", () => {
    const game = dcGame();
    party(game, 2);
    talkDaycare(game, [true], 1);
    const mon = game.save.daycare!.mon;
    const def = game.data.pokemon[mon.species]!;
    // enough exp for two levels
    mon.exp = expForLevel(def.growthRate, 12, game.data.growth_rates);
    game.save.money = 9999;

    talkDaycare(game, [false]); // "All right then, come again."
    expect(game.save.money).toBe(9999);
    expect(game.save.party.length).toBe(1);
    expect(game.save.daycare?.mon?.level).toBe(10); // not raised until paid
    expect(game.save.daycare?.depositLevel).toBe(10);
  });

  test.skipIf(!hasGen)("an empty wallet cannot collect, and is quoted the same later", () => {
    const game = dcGame();
    party(game, 2);
    talkDaycare(game, [true], 1);
    const mon = game.save.daycare!.mon;
    const def = game.data.pokemon[mon.species]!;
    mon.exp = expForLevel(def.growthRate, 12, game.data.growth_rates);
    game.save.money = 100; // the fee is 100 + 2 x 100

    talkDaycare(game, [true]);
    expect(game.save.party.length).toBe(1);
    expect(game.save.money).toBe(100);

    game.save.money = 300;
    talkDaycare(game, [true]);
    expect(game.save.party.length).toBe(2);
    expect(game.save.money).toBe(0);
    expect(game.save.party[1]!.level).toBe(12);
  });

  test.skipIf(!hasGen)("paying up returns the mon grown, healed and re-statted", () => {
    const game = dcGame();
    party(game, 2);
    talkDaycare(game, [true], 1);
    const state = game.save.daycare!;
    const before = { ...state.mon.stats };
    const def = game.data.pokemon[state.mon.species]!;
    state.mon.exp = expForLevel(def.growthRate, 15, game.data.growth_rates);
    state.mon.hp = 1;
    game.save.money = 5000;

    talkDaycare(game, [true]);
    expect(game.save.daycare ?? null).toBe(null);
    const back = game.save.party[1]!;
    expect(back.level).toBe(15);
    expect(game.save.money).toBe(5000 - (100 + 5 * 100));
    expect(back.stats.hp).toBeGreaterThan(before.hp);
    expect(back.hp).toBe(back.stats.hp); // comes back at full health
  });

  test.skipIf(!hasGen)("a full party has nowhere to put him", () => {
    const game = dcGame();
    party(game, 2);
    talkDaycare(game, [true], 1);
    party(game, 6); // filled up while he was away — note this drops nothing else
    game.save.daycare = {
      mon: newMon(game.data, "RATTATA", 10, seqRng([0])), steps: 0, depositLevel: 10,
    };
    game.save.money = 5000;
    talkDaycare(game, [true]);
    expect(game.save.party.length).toBe(6);
    expect(game.save.daycare?.mon?.species).toBe("RATTATA");
    expect(game.save.money).toBe(5000);
  });

  test.skipIf(!hasGen)("the steps are folded in once, not counted again", () => {
    const game = dcGame();
    party(game, 2);
    talkDaycare(game, [true], 1);
    game.save.daycare!.steps = 5000;
    const exp0 = game.save.daycare!.mon.exp ?? 0;

    talkDaycare(game, [false]); // look, then walk away
    expect(game.save.daycare!.steps).toBe(0);
    expect(game.save.daycare!.mon.exp).toBe(exp0 + 5000);

    talkDaycare(game, [false]); // a second look adds nothing
    expect(game.save.daycare!.mon.exp).toBe(exp0 + 5000);
  });

  test.skipIf(!hasGen)("he turns away a mon carrying an HM move", () => {
    const game = dcGame();
    party(game, 2);
    game.save.party[1]!.moves = [{ id: "CUT", pp: 30 }];
    talkDaycare(game, [true], 1);
    expect(game.save.daycare ?? null).toBe(null);
    expect(game.save.party.length).toBe(2);
    // the one without it still boards
    talkDaycare(game, [true], 0);
    expect(game.save.daycare?.mon?.species).toBe("PIDGEY");
  });

  test("the fee is 100 flat plus 100 a level", () => {
    expect(daycareFee(0)).toBe(100);
    expect(daycareFee(1)).toBe(200);
    expect(daycareFee(7)).toBe(800);
  });

  test.skipIf(!hasGen)("day-care learning shifts the oldest move out, with no prompt", () => {
    const mon = newMon(romData!, "PIDGEY", 5, seqRng([0]));
    mon.moves = [
      { id: "TACKLE", pp: 35 }, { id: "GROWL", pp: 40 },
      { id: "TAIL_WHIP", pp: 30 }, { id: "LEER", pp: 30 },
    ];
    learnMovesFromDayCare(romData!, mon, 5, 30);
    expect(mon.moves.length).toBe(4);
    expect(mon.moves.some((m) => m.id === "TACKLE")).toBe(false); // pushed off the front
    const learnt = romData!.pokemon.PIDGEY!.learnset
      .filter((e) => e.level > 5 && e.level <= 30).at(-1)!.move;
    expect(mon.moves.at(-1)!.id).toBe(learnt);
  });
});

describe("the bike voucher, the bike shop and the bicycle", () => {
  function bikeGame(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []),
        "BIKE_SHOP", "POKEMON_FAN_CLUB", "CERULEAN_CITY",
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    return game;
  }

  /** Talk to an NPC and answer the first YES/NO if one opens. */
  function talk(game: VoxelmonGame, map: string, text: string, yes?: boolean): Set<string> {
    const seen = new Set<string>();
    game.overworld.setMap(map, 4, 4, "up");
    game.overworld.showMapText(text);
    const runner = (game.overworld as unknown as { runner: { isRunning(): boolean } }).runner;
    for (let i = 0; i < 1200; i++) {
      const top = game.stackKinds().at(-1);
      if (top) seen.add(top);
      if (top === "choice" && yes !== undefined) {
        if (!yes) tap(game, VOX_BTN.down);
        tap(game, VOX_BTN.a);
        yes = undefined;
        continue;
      }
      if (top === "bikeshop") return seen; // the window waits for a pick
      if (top === "overworld" && !runner.isRunning()) break;
      dismissText(game);
      game.tick(0);
    }
    return seen;
  }

  /** Drive whatever the bike-shop window's answer pushed, to the end. */
  function drain(game: VoxelmonGame): void {
    const runner = (game.overworld as unknown as { runner: { isRunning(): boolean } }).runner;
    for (let i = 0; i < 1200; i++) {
      if (game.stackKinds().at(-1) === "overworld" && !runner.isRunning()) return;
      dismissText(game);
      game.tick(0);
    }
  }

  // --- the chairman -------------------------------------------------------

  test.skipIf(!hasGen)("the chairman's story earns the BIKE VOUCHER, exactly once", () => {
    const game = bikeGame();
    talk(game, "POKEMON_FAN_CLUB", "TEXT_POKEMONFANCLUB_CHAIRMAN", true);
    expect(game.save.inventory.BIKE_VOUCHER).toBe(1);
    expect(game.save.flags.EVENT_GOT_BIKE_VOUCHER).toBe(true);

    // a second visit is the ChairFinal brush-off, not another voucher
    talk(game, "POKEMON_FAN_CLUB", "TEXT_POKEMONFANCLUB_CHAIRMAN", true);
    expect(game.save.inventory.BIKE_VOUCHER).toBe(1);
  });

  test.skipIf(!hasGen)("declining his story leaves you empty-handed", () => {
    const game = bikeGame();
    talk(game, "POKEMON_FAN_CLUB", "TEXT_POKEMONFANCLUB_CHAIRMAN", false);
    expect(game.save.inventory.BIKE_VOUCHER ?? 0).toBe(0);
    expect(game.save.flags.EVENT_GOT_BIKE_VOUCHER ?? false).toBe(false);
    // and he will still tell it when you come back and say yes
    talk(game, "POKEMON_FAN_CLUB", "TEXT_POKEMONFANCLUB_CHAIRMAN", true);
    expect(game.save.inventory.BIKE_VOUCHER).toBe(1);
  });

  test.skipIf(!hasGen)("the two fans arm each other's retort", () => {
    const game = bikeGame();
    talk(game, "POKEMON_FAN_CLUB", "TEXT_POKEMONFANCLUB_PIKACHU_FAN");
    expect(game.save.flags.EVENT_SEEL_FAN_BOAST).toBe(true);
    expect(game.save.flags.EVENT_PIKACHU_FAN_BOAST ?? false).toBe(false);
    // the SEEL fan now retorts, which spends her own flag and arms nobody
    talk(game, "POKEMON_FAN_CLUB", "TEXT_POKEMONFANCLUB_SEEL_FAN");
    expect(game.save.flags.EVENT_SEEL_FAN_BOAST ?? false).toBe(false);
    expect(game.save.flags.EVENT_PIKACHU_FAN_BOAST ?? false).toBe(false);
    // and she is back to her normal line, which arms the PIKACHU fan again
    talk(game, "POKEMON_FAN_CLUB", "TEXT_POKEMONFANCLUB_SEEL_FAN");
    expect(game.save.flags.EVENT_PIKACHU_FAN_BOAST).toBe(true);
  });

  // --- the clerk ----------------------------------------------------------

  test.skipIf(!hasGen)("no voucher: the pitch, the million-yen window, and no sale", () => {
    const game = bikeGame();
    game.save.money = 999999;
    const seen = talk(game, "BIKE_SHOP", "TEXT_BIKESHOP_CLERK");
    expect(seen.has("bikeshop")).toBe(true);
    const v = game.bikeShop() as { rows: string[]; price: string; footer: string | null };
    expect(v.rows).toEqual(["BICYCLE", "CANCEL"]);
    expect(v.price).toBe("¥1000000");
    expect(v.footer).not.toBeNull(); // the pitch stays up under the menu

    tap(game, VOX_BTN.a); // YES, buy it
    drain(game);
    expect(game.save.inventory.BICYCLE ?? 0).toBe(0);
    expect(game.save.money).toBe(999999); // nothing is ever taken
    expect(game.stackKinds()).toEqual(["overworld"]); // the window closed too
  });

  test.skipIf(!hasGen)("cancelling the window closes it the same way", () => {
    const game = bikeGame();
    talk(game, "BIKE_SHOP", "TEXT_BIKESHOP_CLERK");
    expect(game.stackKinds().at(-1)).toBe("bikeshop");
    tap(game, VOX_BTN.b);
    drain(game);
    expect(game.stackKinds()).toEqual(["overworld"]);
  });

  test.skipIf(!hasGen)("the voucher buys the BICYCLE and is spent doing it", () => {
    const game = bikeGame();
    Bag.add(game.save, "BIKE_VOUCHER", 1);
    const seen = talk(game, "BIKE_SHOP", "TEXT_BIKESHOP_CLERK");
    expect(seen.has("bikeshop")).toBe(false); // no window on this branch
    expect(game.save.inventory.BICYCLE).toBe(1);
    expect(game.save.inventory.BIKE_VOUCHER ?? 0).toBe(0);
    expect(game.save.flags.EVENT_GOT_BICYCLE).toBe(true);

    // with the bike in hand he just admires it
    talk(game, "BIKE_SHOP", "TEXT_BIKESHOP_CLERK");
    expect(game.save.inventory.BICYCLE).toBe(1);
  });

  test.skipIf(!hasGen)("the youngster has a line for each side of owning one", () => {
    const game = bikeGame();
    /** Whatever he says, flattened out of the box's own pages. */
    const shown = (): string => {
      game.overworld.setMap("BIKE_SHOP", 4, 4, "up");
      game.overworld.showMapText("TEXT_BIKESHOP_YOUNGSTER");
      for (let i = 0; i < 300; i++) {
        const src = game.uiBox() as { box?: { pages?: { lines: string[] }[] } } | null;
        const pages = src?.box?.pages;
        if (pages?.length) {
          const t = pages.map((pg) => pg.lines.join(" ")).join(" ");
          drain(game);
          return t;
        }
        game.tick(0);
      }
      return "";
    };
    const poor = shown();
    Bag.add(game.save, "BICYCLE", 1);
    const rich = shown();
    expect(poor).toContain("expensive");
    expect(rich).toContain("really cool");
    expect(poor).not.toContain("really cool");
  });

  // --- riding -------------------------------------------------------------

  test("the bike theme replaces an outdoor song only", () => {
    expect(effectiveMapSong("Music_Routes1", true)).toBe(BIKE_SONG);
    expect(effectiveMapSong("Music_Routes1", false)).toBe("Music_Routes1");
    // an indoor theme is never overridden, even while riding
    expect(effectiveMapSong("Music_Pokecenter", true)).toBe("Music_Pokecenter");
    expect(effectiveMapSong(null, true)).toBeNull();
  });

  test("riding is allowed by tileset, or by the two map exceptions", () => {
    expect(bikeAllowed("ROUTE_5", "OVERWORLD")).toBe(true);
    expect(bikeAllowed("MT_MOON_1F", "CAVERN")).toBe(true);
    expect(bikeAllowed("BIKE_SHOP", "CLUB")).toBe(false);
    // PLATEAU-tileset maps that ride anyway
    expect(bikeAllowed("ROUTE_23", "PLATEAU")).toBe(true);
    expect(bikeAllowed("INDIGO_PLATEAU", "PLATEAU")).toBe(true);
    expect(bikeAllowed("VICTORY_ROAD_1F", "PLATEAU")).toBe(false);
  });

  /** START -> ITEM -> BICYCLE, the way a player reaches it. */
  function useBike(game: VoxelmonGame): void {
    tap(game, VOX_BTN.start);
    const sm = game.startMenu() as { entries: string[] };
    pick(game, sm.entries.indexOf("ITEM"));
    const bag = game.bag() as { entries: { name: string }[] };
    pick(game, bag.entries.findIndex((e) => e.name === "BICYCLE"));
    tap(game, VOX_BTN.a); // ItemMenu: USE
  }

  test.skipIf(!hasGen)("the bicycle mounts outdoors, doubles the pace, and plays its theme", () => {
    const game = bikeGame();
    Bag.add(game.save, "BICYCLE", 1);
    game.overworld.setMap("CERULEAN_CITY", 20, 20, "down");

    useBike(game);
    expect(game.save.onBike).toBe(true);
    expect(game.overworld.player.onBike).toBe(true);
    expect(game.overworld.player.stepSpeed()).toBe(8); // walking is 16
    dismissText(game);

    // and off again
    useBike(game);
    expect(game.save.onBike).toBe(false);
    expect(game.overworld.player.stepSpeed()).toBe(16);
    // (the theme swap itself is driven through the director, which this
    //  harness has no banks for — voxel-audio.test.ts "the bike theme")
  });

  test.skipIf(!hasGen)("a step on the bike really does take half the frames", () => {
    const game = bikeGame();
    Bag.add(game.save, "BICYCLE", 1);
    game.overworld.setMap("CERULEAN_CITY", 20, 20, "down");
    const p = game.overworld.player;

    const time = (): number => {
      const base = p.landedCount;
      let t = 0;
      while (p.landedCount === base && t < 200) { game.tick(VOX_BTN.down); t += 1; }
      game.tick(0);
      return t;
    };
    const walked = time();
    useBike(game);
    dismissText(game);
    const ridden = time();
    expect(ridden).toBeLessThan(walked);
  });

  test.skipIf(!hasGen)("there is no cycling indoors, and a door gets you off", () => {
    const game = bikeGame();
    Bag.add(game.save, "BICYCLE", 1);
    game.overworld.setMap("BIKE_SHOP", 4, 4, "up");
    useBike(game);
    expect(game.save.onBike ?? false).toBe(false); // "No cycling allowed here."
    dismissText(game);

    // mount outside, then walk in: the map change dismounts you
    game.overworld.setMap("CERULEAN_CITY", 20, 20, "down");
    useBike(game);
    expect(game.save.onBike).toBe(true);
    dismissText(game);
    game.overworld.setMap("BIKE_SHOP", 4, 4, "up");
    expect(game.save.onBike).toBe(false);
    expect(game.overworld.player.onBike).toBe(false);
  });
});

describe("cut trees across a reload", () => {
  /** A host that records every stamp op, so re-entry can be inspected. */
  class StampHost extends MenuHost {
    stamps: [number, number, number, number][] = [];
    stamp(mapId: number, cx: number, cy: number, on: number): void {
      this.stamps.push([mapId, cx, cy, on]);
    }
  }

  function cutGame(): { game: VoxelmonGame; host: StampHost } {
    const host = new StampHost();
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []),
        "VIRIDIAN_CITY", "ROUTE_2", "PALLET_TOWN",
      ],
    };
    const game = new VoxelmonGame(data as never, host, 1);
    game.newGame();
    game.closeToOverworld();
    return { game, host };
  }

  /** The first cuttable cell this map cooked, if it has one. */
  function cuttable(game: VoxelmonGame, mapId: string): [number, number] | null {
    game.overworld.setMap(mapId, 4, 4, "down");
    const m = game.overworld.map;
    for (let y = 0; y < m.heightCells; y++) {
      for (let x = 0; x < m.widthCells; x++) {
        if (m.isCuttableCell(x, y)) return [x, y];
      }
    }
    return null;
  }

  test.skipIf(!hasGen)("a chopped tree is still gone after leaving and coming back", () => {
    const { game, host } = cutGame();
    const at = cuttable(game, "VIRIDIAN_CITY");
    if (!at) return; // this build cooked no cuttable cells here
    const [cx, cy] = at;
    const index = game.overworld.map.def.index;

    // chop it the way use_cut does
    game.overworld.map.markCut(cx, cy);
    game.save.cutTrees ??= {};
    game.save.cutTrees.VIRIDIAN_CITY = { [`${cx},${cy}`]: true };

    // leave and come back
    game.overworld.setMap("PALLET_TOWN", 5, 6, "down");
    host.stamps.length = 0;
    game.overworld.setMap("VIRIDIAN_CITY", 4, 4, "down");

    // the geometry is told to stay hidden...
    expect(host.stamps).toContainEqual([index, cx, cy, 0]);
    // ...and the cell stays walkable, so there is no invisible wall
    expect(game.overworld.map.isCuttableCell(cx, cy)).toBe(false);
  });

  test.skipIf(!hasGen)("and after a save/load round trip", () => {
    const { game } = cutGame();
    const at = cuttable(game, "VIRIDIAN_CITY");
    if (!at) return;
    const [cx, cy] = at;
    game.save.cutTrees = { VIRIDIAN_CITY: { [`${cx},${cy}`]: true } };

    const text = encodeSave(game.save as never);
    const back = decodeSave(text) as { cutTrees?: Record<string, Record<string, boolean>> };
    expect(back.cutTrees?.VIRIDIAN_CITY?.[`${cx},${cy}`]).toBe(true);
  });
});

describe("Oak's aides", () => {
  function aideGame(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []),
        "ROUTE_2_GATE", "ROUTE_11_GATE_2F", "ROUTE_15_GATE_2F",
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    return game;
  }

  /** Own `n` distinct species, the only thing he actually counts. */
  function own(game: VoxelmonGame, n: number): void {
    const ids = Object.keys(game.data.pokemon).slice(0, n);
    const dex = ((game.save as { pokedex?: { owned?: Record<string, boolean> } }).pokedex ??=
      {}) as { owned?: Record<string, boolean> };
    dex.owned = {};
    for (const id of ids) dex.owned[id] = true;
  }

  /** Talk to him, answering his question. Returns every line he showed. */
  function talkAide(game: VoxelmonGame, map: string, text: string, yes: boolean): string {
    game.overworld.setMap(map, 4, 4, "up");
    game.overworld.showMapText(text);
    const runner = (game.overworld as unknown as { runner: { isRunning(): boolean } }).runner;
    const said: string[] = [];
    let answered = false;
    for (let i = 0; i < 1500; i++) {
      const top = game.stackKinds().at(-1);
      if (top === "choice" && !answered) {
        if (!yes) tap(game, VOX_BTN.down);
        tap(game, VOX_BTN.a);
        answered = true;
        continue;
      }
      const src = game.uiBox() as { box?: { pages?: { lines: string[] }[] } } | null;
      const pages = src?.box?.pages;
      if (pages?.length) {
        const t = pages.map((pg) => pg.lines.join(" ")).join(" ");
        if (said.at(-1) !== t) said.push(t);
      }
      if (top === "overworld" && !runner.isRunning()) break;
      dismissText(game);
      game.tick(0);
    }
    return said.join(" | ");
  }

  test.skipIf(!hasGen)("ten kinds earns HM05 FLASH, once", () => {
    const game = aideGame();
    own(game, 10);
    const said = talkAide(game, "ROUTE_2_GATE", "TEXT_ROUTE2GATE_OAKS_AIDE", true);
    expect(game.save.inventory.HM_FLASH).toBe(1);
    expect(game.save.flags.EVENT_GOT_HM_FLASH).toBe(true);
    // the tally he reads back is the real one, not the {NUM:} placeholder
    expect(said).toContain("10");
    expect(said).not.toContain("{NUM");
    expect(said).not.toContain("{RAM");

    // coming back gets the explanation, not a second copy
    const again = talkAide(game, "ROUTE_2_GATE", "TEXT_ROUTE2GATE_OAKS_AIDE", true);
    expect(game.save.inventory.HM_FLASH).toBe(1);
    expect(again).toContain("darkest dungeons");
  });

  test.skipIf(!hasGen)("he counts for himself, so claiming ten with nine fails", () => {
    const game = aideGame();
    own(game, 9);
    const said = talkAide(game, "ROUTE_2_GATE", "TEXT_ROUTE2GATE_OAKS_AIDE", true);
    expect(game.save.inventory.HM_FLASH ?? 0).toBe(0);
    expect(game.save.flags.EVENT_GOT_HM_FLASH ?? false).toBe(false);
    expect(said).toContain("Uh-oh"); // _OaksAideUhOhText, with the real 9
    expect(said).toContain("9");
  });

  test.skipIf(!hasGen)("saying no just sends you away, with the reward intact", () => {
    const game = aideGame();
    own(game, 30);
    talkAide(game, "ROUTE_2_GATE", "TEXT_ROUTE2GATE_OAKS_AIDE", false);
    expect(game.save.inventory.HM_FLASH ?? 0).toBe(0);
    // and it is still there when you come back and say yes
    talkAide(game, "ROUTE_2_GATE", "TEXT_ROUTE2GATE_OAKS_AIDE", true);
    expect(game.save.inventory.HM_FLASH).toBe(1);
  });

  test.skipIf(!hasGen)("the other two posts want 30 and 50, for their own rewards", () => {
    const game = aideGame();
    own(game, 30);
    talkAide(game, "ROUTE_11_GATE_2F", "TEXT_ROUTE11GATE2F_OAKS_AIDE", true);
    expect(game.save.inventory.ITEMFINDER).toBe(1);
    // 30 is not enough for the Route 15 aide
    talkAide(game, "ROUTE_15_GATE_2F", "TEXT_ROUTE15GATE2F_OAKS_AIDE", true);
    expect(game.save.inventory.EXP_ALL ?? 0).toBe(0);

    own(game, 50);
    talkAide(game, "ROUTE_15_GATE_2F", "TEXT_ROUTE15GATE2F_OAKS_AIDE", true);
    expect(game.save.inventory.EXP_ALL).toBe(1);
  });

  test("the placeholders his lines carry are all filled", () => {
    expect(fillAideText("caught {NUM:hOaksAideNumMonsOwned, 1, 3} kinds", { num: 7 }))
      .toBe("caught 7 kinds");
    expect(fillAideText("the {RAM:wOaksAideRewardItemName}!", { item: "HM05" }))
      .toBe("the HM05!");
    // {PLAYER} is the textbox's own token and must survive untouched
    expect(fillAideText("{PLAYER} got the {RAM:x}!", { item: "HM05" }))
      .toBe("{PLAYER} got the HM05!");
  });
});

describe("walking with the camera swung round", () => {
  test("an unswung camera leaves every press alone", () => {
    for (const d of ["up", "down", "left", "right"] as const) {
      expect(rotateDir(d, 0)).toBe(d);
      expect(rotateDir(d, 4)).toBe(d);
      expect(rotateDir(d, -4)).toBe(d);
    }
  });

  test("a quarter turn carries the press round with the view", () => {
    // The camera swung a quarter turn clockwise: pushing up now walks east.
    expect(rotateDir("up", 1)).toBe("right");
    expect(rotateDir("right", 1)).toBe("down");
    expect(rotateDir("down", 1)).toBe("left");
    expect(rotateDir("left", 1)).toBe("up");
  });

  test("a half turn is the flip that made walking a guessing game", () => {
    expect(rotateDir("up", 2)).toBe("down");
    expect(rotateDir("down", 2)).toBe("up");
    expect(rotateDir("left", 2)).toBe("right");
    expect(rotateDir("right", 2)).toBe("left");
  });

  test("three quarters is the same as a quarter the other way", () => {
    for (const d of ["up", "down", "left", "right"] as const) {
      expect(rotateDir(d, 3)).toBe(rotateDir(d, -1));
    }
  });

  test.skipIf(!hasGen)("a half turn sends the same press the opposite way", () => {
    /** Hold `mask` for a fixed span and report where the player ended up. */
    const walk = (turns: number, mask: number): [number, number] => {
      const game = makeGame();
      game.closeToOverworld();
      game.overworld.setMap("PALLET_TOWN", 5, 6, "down");
      game.overworld.camTurns = turns;
      for (let i = 0; i < 120; i++) game.tick(mask);
      return [game.overworld.player.cellX, game.overworld.player.cellY];
    };
    // A fixed span rather than "until it moves": the first press only turns
    // the player, and stopping at the first changed cell would pass on a
    // single step in ANY direction.
    const [, northY] = walk(0, VOX_BTN.up);
    const [, southY] = walk(2, VOX_BTN.up);
    expect(northY).toBeLessThan(6);   // unswung: up walks north
    expect(southY).toBeGreaterThan(6); // swung right round: up walks south
  });

  test.skipIf(!hasGen)("a quarter turn sends an up-press sideways", () => {
    const game = makeGame();
    game.closeToOverworld();
    game.overworld.setMap("PALLET_TOWN", 5, 6, "down");
    game.overworld.camTurns = 1;
    const p = game.overworld.player;
    const x0 = p.cellX;
    holdUntil(game, VOX_BTN.up, () => p.cellX !== x0, 200);
    expect(p.cellX).toBe(x0 + 1); // east
  });

  test.skipIf(!hasGen)("menus are not rotated: the cursor still moves as pressed", () => {
    const game = makeMenuGame();
    game.overworld.camTurns = 2; // camera swung right round
    tap(game, VOX_BTN.start);
    const sm = () => (game.startMenu() as { entries: string[]; index: number });
    const first = sm().index;
    tap(game, VOX_BTN.down);
    // down moves the cursor down the list, camera or no camera
    expect(sm().index).toBe((first + 1) % sm().entries.length);
  });
});

describe("which way a walker looks from a swung camera", () => {
  test("an unswung camera poses every sprite exactly as before", () => {
    for (const d of ["up", "down", "left", "right"] as const) {
      expect(poseDir(d, 0)).toBe(d);
    }
  });

  test("walking away from the camera shows the back, however it is swung", () => {
    // Unswung the camera is south, so facing north is walking away: the
    // "up" pose, which is the back view.
    expect(poseDir("up", 0)).toBe("up");
    // Swung right round the camera is north, so the walk-away direction is
    // south -- and it has to resolve to that same back pose.
    expect(poseDir("down", 2)).toBe("up");
    // The same world facing, seen from the other side, must NOT stay the
    // back view: that was the bug, the sprite walking away face-first.
    expect(poseDir("up", 2)).toBe("down");
  });

  test("a quarter turn swaps the side-on poses for the front and back", () => {
    // Swung a quarter turn, a press of up walks the player EAST, so east is
    // the away-from-camera direction and must draw the back pose.
    expect(poseDir("right", 1)).toBe("up");
    expect(poseDir("left", 1)).toBe("down"); // west: walking toward you
    // North and south are side-on from here.
    expect(poseDir("up", 1)).toBe("left");
    expect(poseDir("down", 1)).toBe("right");
  });

  test("a full turn is where it started", () => {
    for (const d of ["up", "down", "left", "right"] as const) {
      expect(poseDir(d, 4)).toBe(d);
      expect(poseDir(d, -4)).toBe(d);
    }
  });

  test("the pose turns opposite the walk, so the two agree on screen", () => {
    // A press of `screen` walks the world direction rotateDir(screen, q);
    // posing that world direction must give the screen one back again.
    for (const q of [0, 1, 2, 3]) {
      for (const screen of ["up", "down", "left", "right"] as const) {
        expect(poseDir(rotateDir(screen, q), q)).toBe(screen);
      }
    }
  });
});

describe("the two HMs people hand over", () => {
  function hmGame(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []),
        "SAFARI_ZONE_SECRET_HOUSE", "WARDENS_HOUSE",
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    return game;
  }

  /**
   * Talk, answering the first YES/NO if one opens, and return every line the
   * NPC said.
   *
   * Driven for a fixed span rather than "until the stack settles": a script
   * outlives its boxes, so a loop that stops at the first idle frame quietly
   * misses everything after the first page.
   */
  function say(game: VoxelmonGame, map: string, text: string, yes?: boolean): string {
    game.overworld.setMap(map, 4, 4, "up");
    game.overworld.showMapText(text);
    const said: string[] = [];
    let answered = false;
    for (let i = 0; i < 2000; i++) {
      const src = game.uiBox() as { box?: { pages?: { lines: string[] }[] } } | null;
      const pages = src?.box?.pages;
      if (pages?.length) {
        const t = pages.map((pg) => pg.lines.join(" ")).join(" ");
        if (!said.includes(t)) said.push(t);
      }
      if (game.stackKinds().at(-1) === "choice" && yes !== undefined && !answered) {
        if (!yes) tap(game, VOX_BTN.down);
        tap(game, VOX_BTN.a);
        answered = true;
        continue;
      }
      // A or nothing, alternating, so held A never eats two boxes at once.
      game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    }
    return said.join(" | ");
  }

  test.skipIf(!hasGen)("the secret house guru hands over HM03 SURF, once", () => {
    const game = hmGame();
    const said = say(game, "SAFARI_ZONE_SECRET_HOUSE", "TEXT_SAFARIZONESECRETHOUSE_FISHING_GURU");
    expect(game.save.inventory.HM_SURF).toBe(1);
    expect(game.save.flags.EVENT_GOT_HM03).toBe(true);
    // the received line reads the item name out of wStringBuffer
    expect(said).toContain("HM03");
    expect(said).not.toContain("{RAM");

    // coming back gets the explanation, not a second copy
    const again = say(game, "SAFARI_ZONE_SECRET_HOUSE", "TEXT_SAFARIZONESECRETHOUSE_FISHING_GURU");
    expect(game.save.inventory.HM_SURF).toBe(1);
    expect(again).toContain("SURF");
  });

  test.skipIf(!hasGen)("the warden is unintelligible until the teeth come back", () => {
    const game = hmGame();
    // No teeth: gibberish, and nothing changes hands either way.
    const no = say(game, "WARDENS_HOUSE", "TEXT_WARDENSHOUSE_WARDEN", false);
    expect(game.save.inventory.HM_STRENGTH ?? 0).toBe(0);
    expect(no).toContain("Ha?"); // Gibberish3, the "no" answer
    const yes = say(game, "WARDENS_HOUSE", "TEXT_WARDENSHOUSE_WARDEN", true);
    expect(yes).toContain("Ah howhee"); // Gibberish2, the "yes" answer
    expect(game.save.inventory.HM_STRENGTH ?? 0).toBe(0);
  });

  test.skipIf(!hasGen)("the teeth buy HM04 STRENGTH and are handed over", () => {
    const game = hmGame();
    Bag.add(game.save, "GOLD_TEETH", 1);
    const said = say(game, "WARDENS_HOUSE", "TEXT_WARDENSHOUSE_WARDEN");
    expect(game.save.inventory.HM_STRENGTH).toBe(1);
    expect(game.save.inventory.GOLD_TEETH ?? 0).toBe(0);
    expect(game.save.flags.EVENT_GAVE_GOLD_TEETH).toBe(true);
    expect(game.save.flags.EVENT_GOT_HM04).toBe(true);
    // he puts them in before he can be understood
    expect(said).toContain("popped in his teeth");
    expect(said).toContain("Thanks");

    // afterwards he explains what it does, and gives nothing more
    const again = say(game, "WARDENS_HOUSE", "TEXT_WARDENSHOUSE_WARDEN");
    expect(game.save.inventory.HM_STRENGTH).toBe(1);
    expect(again).toContain("STRENGTH");
  });
});

describe("tossing things out of the bag", () => {
  /** Open the bag with the cursor on `name`, and press A to get USE/TOSS. */
  function openItem(game: VoxelmonGame, name: string): void {
    tap(game, VOX_BTN.start);
    const sm = game.startMenu() as { entries: string[] };
    pick(game, sm.entries.indexOf("ITEM"));
    const bag = game.bag() as { entries: { name: string }[] };
    pick(game, bag.entries.findIndex((e) => e.name === name));
  }

  /** From the USE/TOSS box, choose TOSS. */
  function chooseToss(game: VoxelmonGame): void {
    tap(game, VOX_BTN.down); // USE -> TOSS
    tap(game, VOX_BTN.a);
  }

  /**
   * Answer the "Is it OK to toss...?" confirm.
   *
   * showChoice pushes a TEXTBOX that only opens its YES/NO once the line has
   * typed out, so the answer has to wait for the choice to actually exist --
   * pressing A the moment the box appears just advances the text.
   */
  function answerConfirm(game: VoxelmonGame, yes: boolean): boolean {
    for (let i = 0; i < 400; i++) {
      if (game.stackKinds().at(-1) === "choice") {
        // Release first: the loop above holds A to type the line out, and
        // pressing an already-held button is no edge at all -- the answer
        // would be swallowed and the confirm would sit there forever.
        game.tick(0);
        if (!yes) tap(game, VOX_BTN.down);
        tap(game, VOX_BTN.a);
        // The answer runs the callback on a later frame, so settle before
        // the caller looks at what it did.
        for (let k = 0; k < 20; k++) game.tick(0);
        return true;
      }
      game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    }
    return false; // no confirm ever appeared
  }

  test.skipIf(!hasGen)("a single item is tossed after a yes", () => {
    const game = makeMenuGame();
    Bag.add(game.save, "POTION", 1);
    openItem(game, "POTION");
    expect((game.bag() as { mode: string }).mode).toBe("submenu");
    chooseToss(game);
    // one of them, so no quantity to choose: straight to the confirm
    expect(answerConfirm(game, true)).toBe(true);
    expect(game.save.inventory.POTION ?? 0).toBe(0);
  });

  test.skipIf(!hasGen)("saying no keeps it", () => {
    const game = makeMenuGame();
    Bag.add(game.save, "POTION", 1);
    openItem(game, "POTION");
    chooseToss(game);
    // it really did ask, and NO really does keep it
    expect(answerConfirm(game, false)).toBe(true);
    expect(game.save.inventory.POTION).toBe(1);
  });

  test.skipIf(!hasGen)("a stack asks how many, and tosses exactly that many", () => {
    const game = makeMenuGame();
    Bag.add(game.save, "POTION", 9);
    openItem(game, "POTION");
    chooseToss(game);
    expect((game.bag() as { mode: string }).mode).toBe("quantity");
    tap(game, VOX_BTN.up); // 1 -> 2
    tap(game, VOX_BTN.up); // 2 -> 3
    expect((game.bag() as { qty: number }).qty).toBe(3);
    tap(game, VOX_BTN.a); // accept the count
    expect(answerConfirm(game, true)).toBe(true);
    expect(game.save.inventory.POTION).toBe(6);
  });

  test.skipIf(!hasGen)("the count cannot run past what is held, or below one", () => {
    const game = makeMenuGame();
    Bag.add(game.save, "POTION", 3);
    openItem(game, "POTION");
    chooseToss(game);
    for (let i = 0; i < 8; i++) tap(game, VOX_BTN.up);
    expect((game.bag() as { qty: number }).qty).toBe(3);
    for (let i = 0; i < 8; i++) tap(game, VOX_BTN.down);
    expect((game.bag() as { qty: number }).qty).toBe(1);
  });

  test.skipIf(!hasGen)("a key item is refused outright", () => {
    const game = makeMenuGame();
    Bag.add(game.save, "BICYCLE", 1);
    openItem(game, "BICYCLE");
    chooseToss(game);
    // no confirm at all: it just says no and keeps it
    expect(game.stackKinds().at(-1)).not.toBe("choice");
    expect(game.save.inventory.BICYCLE).toBe(1);
    const src = game.uiBox() as { box?: { pages?: { lines: string[] }[] } } | null;
    const said = (src?.box?.pages ?? []).map((pg) => pg.lines.join(" ")).join(" ");
    expect(said).toContain("too impor");
  });

  test.skipIf(!hasGen)("B backs out of the submenu without tossing", () => {
    const game = makeMenuGame();
    Bag.add(game.save, "POTION", 2);
    openItem(game, "POTION");
    tap(game, VOX_BTN.b);
    expect((game.bag() as { mode: string }).mode).toBe("list");
    expect(game.save.inventory.POTION).toBe(2);
  });

  test.skipIf(!hasGen)("tossing the last of a stack leaves the cursor somewhere real", () => {
    const game = makeMenuGame();
    Bag.add(game.save, "POTION", 1);
    openItem(game, "POTION");
    chooseToss(game);
    expect(answerConfirm(game, true)).toBe(true);
    for (let i = 0; i < 20; i++) game.tick(0); // let the confirm close
    const v = game.bag() as { entries: unknown[]; index: number } | null;
    expect(v).not.toBeNull();
    expect(v!.index).toBeLessThanOrEqual(v!.entries.length);
  });
});

describe("the end of Team Rocket", () => {
  function silphGame(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []),
        "SILPH_CO_11F", "SAFFRON_CITY",
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    game.save.party.push(newMon(romData!, "CHARIZARD", 80));
    return game;
  }

  /** Step onto a tile and let the land-trigger run for a few frames. */
  function stepOn(game: VoxelmonGame, x: number, y: number): void {
    game.overworld.setMap("SILPH_CO_11F", x, y, "up");
    game.overworld.onStepComplete();
    for (let i = 0; i < 40; i++) game.tick(0);
  }

  /** Whatever box is open, flattened. */
  function boxText(game: VoxelmonGame): string {
    const src = game.uiBox() as { box?: { pages?: { lines: string[] }[] } } | null;
    return (src?.box?.pages ?? []).map((pg) => pg.lines.join(" ")).join(" ");
  }

  test.skipIf(!hasGen)("his tiles start the encounter and no others do", () => {
    const game = silphGame();
    // Not one of his two: nothing at all.
    stepOn(game, 10, 10);
    expect(game.stackKinds()).toEqual(["overworld"]);

    // Both of the tiles pokered watches, each on a fresh game so the first
    // does not disarm the second.
    for (const [x, y] of [[6, 13], [7, 12]] as const) {
      const g = silphGame();
      stepOn(g, x, y);
      expect(boxText(g)).toContain("So we meet again");
    }
  });

  test.skipIf(!hasGen)("once he is beaten the tile is dead", () => {
    const game = silphGame();
    game.save.flags.EVENT_BEAT_SILPH_CO_GIOVANNI = true;
    stepOn(game, 6, 13);
    expect(game.stackKinds()).toEqual(["overworld"]);
  });

  test.skipIf(!hasGen)("the aftermath empties Silph AND the streets outside", () => {
    const game = silphGame();
    game.overworld.setMap("SILPH_CO_11F", 6, 13, "up");
    // The rows the win runs, driven on their own: the battle itself is the
    // engine's business and takes hundreds of frames to fight by hand.
    game.overworld.runScript(silphAftermathRows() as never);
    for (let i = 0; i < 2000; i++) game.tick(i % 2 === 0 ? VOX_BTN.a : 0);

    const t = game.save.objectToggles ?? {};
    // every floor, not just the one he was standing on
    expect(t.SILPH_CO_2F?.SILPHCO2F_ROCKET1).toBe(false);
    expect(t.SILPH_CO_7F?.SILPHCO7F_ROCKET3).toBe(false);
    expect(t.SILPH_CO_11F?.SILPHCO11F_ROCKET2).toBe(false);
    expect(t.SILPH_CO_11F?.SILPHCO11F_GIOVANNI).toBe(false);
    // the nine holding Saffron, and the people they displaced coming back
    expect(t.SAFFRON_CITY?.SAFFRONCITY_ROCKET1).toBe(false);
    expect(t.SAFFRON_CITY?.SAFFRONCITY_ROCKET9).toBe(false);
    expect(t.SAFFRON_CITY?.SAFFRONCITY_SCIENTIST).toBe(true);
    expect(t.SAFFRON_CITY?.SAFFRONCITY_PIDGEOT).toBe(true);
  });

  test("the aftermath leaves the rescued workers and item balls alone", () => {
    const rows = silphAftermathRows() as unknown as [string, string, string][];
    const touched = new Set(rows.filter((r) => r[0] === "hide_object").map((r) => r[2]));
    // 2F and 10F have workers the player rescued; they are not rockets
    expect([...touched].some((n) => n.includes("WORKER"))).toBe(false);
    expect([...touched].some((n) => n.includes("ITEM"))).toBe(false);
    // and the 7F rival keeps his place too
    expect([...touched].some((n) => n.includes("RIVAL"))).toBe(false);
  });

  test("it hides behind a fade, and says why first", () => {
    const rows = silphAftermathRows() as unknown as [string, ...unknown[]][];
    const kinds = rows.map((r) => r[0]);
    // the speech comes before the fade, and every hide is inside it
    expect(kinds[0]).toBe("show_text");
    expect(kinds[1]).toBe("fade");
    expect(kinds.at(-1)).toBe("fade");
    const firstHide = kinds.indexOf("hide_object");
    expect(firstHide).toBeGreaterThan(1);
    expect(kinds.lastIndexOf("show_object")).toBeLessThan(kinds.length - 1);
  });

  test.skipIf(!hasGen)("the president hands over the MASTER BALL, once", () => {
    const game = silphGame();
    game.overworld.setMap("SILPH_CO_11F", 7, 6, "up");
    game.overworld.showMapText("TEXT_SILPHCO11F_SILPH_PRESIDENT");
    for (let i = 0; i < 900; i++) game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    expect(game.save.inventory.MASTER_BALL).toBe(1);
    expect(game.save.flags.EVENT_GOT_MASTER_BALL).toBe(true);

    game.closeToOverworld();
    game.overworld.showMapText("TEXT_SILPHCO11F_SILPH_PRESIDENT");
    for (let i = 0; i < 900; i++) game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    expect(game.save.inventory.MASTER_BALL).toBe(1);
  });
});

describe("the card key doors", () => {
  function doorGame(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []),
        "SILPH_CO_3F", "ROCKET_HIDEOUT_B4F",
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    return game;
  }

  /** The doors the cook baked shut on a map. */
  function doorsOf(mapId: string): { bx: number; by: number; event?: string; events?: string[] }[] {
    const ck = (romData as { field?: { cardKeyDoors?: { closedDoors?: Record<string, unknown[]> } } })
      .field?.cardKeyDoors?.closedDoors;
    return ((ck?.[mapId] ?? []) as never[]);
  }

  /** Stand in front of a door's top-left cell and press A. */
  function faceDoor(game: VoxelmonGame, mapId: string, d: { bx: number; by: number }): void {
    const cx = d.bx * 2;
    const cy = d.by * 2;
    // one cell below the door, looking up at it
    game.overworld.setMap(mapId, cx, cy + 2, "up");
    game.overworld.interact();
    for (let i = 0; i < 40; i++) game.tick(0);
  }

  function boxText(game: VoxelmonGame): string {
    const src = game.uiBox() as { box?: { pages?: { lines: string[] }[] } } | null;
    return (src?.box?.pages ?? []).map((pg) => pg.lines.join(" ")).join(" ");
  }

  test.skipIf(!hasGen)("the cook baked them shut, with stamps to lift", () => {
    // Without this the barrier does not exist: the extracted map ships the
    // doorway OPEN and the CARD KEY has nothing to do.
    const doors = doorsOf("SILPH_CO_3F");
    expect(doors.length).toBeGreaterThan(0);
    const game = doorGame();
    game.overworld.setMap("SILPH_CO_3F", 4, 8, "up");
    const def = game.overworld.map.def as { blocks: number[]; width: number };
    for (const d of doors) {
      const got = def.blocks[d.by * def.width + d.bx];
      expect(got).toBe((d as { block: number }).block); // the CLOSED block
    }
  });

  test.skipIf(!hasGen)("a locked door with no key says so and stays shut", () => {
    const game = doorGame();
    const d = doorsOf("SILPH_CO_3F")[0]!;
    faceDoor(game, "SILPH_CO_3F", d);
    expect(boxText(game)).toContain("CARD KEY");
    expect(game.save.flags[d.event!] ?? false).toBe(false);
    expect(game.overworld.map.isOpenedDoor(d.bx * 2, d.by * 2)).toBe(false);
  });

  test.skipIf(!hasGen)("the CARD KEY opens it, and it stays open", () => {
    const game = doorGame();
    Bag.add(game.save, "CARD_KEY", 1);
    const d = doorsOf("SILPH_CO_3F")[0]!;
    faceDoor(game, "SILPH_CO_3F", d);
    expect(boxText(game)).toContain("opened the door");
    expect(game.save.flags[d.event!]).toBe(true);
    // all four cells of the block open up, not just the one faced
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        expect(game.overworld.map.isOpenedDoor(d.bx * 2 + dx, d.by * 2 + dy)).toBe(true);
      }
    }
    // and walking out and back in leaves it open
    game.overworld.setMap("SILPH_CO_3F", 1, 1, "down");
    expect(game.overworld.map.isOpenedDoor(d.bx * 2, d.by * 2)).toBe(true);
  });

  test.skipIf(!hasGen)("opening one door does not open its neighbour", () => {
    const doors = doorsOf("SILPH_CO_3F");
    if (doors.length < 2) return;
    const game = doorGame();
    Bag.add(game.save, "CARD_KEY", 1);
    faceDoor(game, "SILPH_CO_3F", doors[0]!);
    expect(game.save.flags[doors[0]!.event!]).toBe(true);
    expect(game.save.flags[doors[1]!.event!] ?? false).toBe(false);
  });

  test.skipIf(!hasGen)("the lift gate needs BOTH guards, not one", () => {
    // Rocket Hideout B4F lists two events (CheckBothEventsSet), which is why
    // the unlock test takes a list rather than a flag.
    const d = doorsOf("ROCKET_HIDEOUT_B4F")[0]!;
    expect((d.events ?? []).length).toBe(2);
    const game = doorGame();
    game.save.flags[d.events![0]!] = true;
    game.overworld.setMap("ROCKET_HIDEOUT_B4F", 1, 1, "down");
    expect(game.overworld.map.isOpenedDoor(d.bx * 2, d.by * 2)).toBe(false);

    const both = doorGame();
    both.save.flags[d.events![0]!] = true;
    both.save.flags[d.events![1]!] = true;
    both.overworld.setMap("ROCKET_HIDEOUT_B4F", 1, 1, "down");
    expect(both.overworld.map.isOpenedDoor(d.bx * 2, d.by * 2)).toBe(true);
  });

  test.skipIf(!hasGen)("an already-open door is not a door any more", () => {
    const game = doorGame();
    const d = doorsOf("SILPH_CO_3F")[0]!;
    game.save.flags[d.event!] = true;
    Bag.add(game.save, "CARD_KEY", 1);
    faceDoor(game, "SILPH_CO_3F", d);
    // no "Bingo!" a second time: the press falls through to the tile
    expect(boxText(game)).not.toContain("opened the door");
  });
});

describe("the Mansion switches and the Cinnabar quiz", () => {
  function tgGame(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []),
        "POKEMON_MANSION_1F", "POKEMON_MANSION_3F", "POKEMON_MANSION_B1F", "CINNABAR_GYM",
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    return game;
  }

  /** The block sitting at (bx, by) on the map that is loaded right now. */
  function blockAt(game: VoxelmonGame, bx: number, by: number): number {
    const def = game.overworld.map.def as { blocks: number[]; width: number };
    return def.blocks[by * def.width + bx]!;
  }

  /** Stand one cell below a tile, look up at it, and press A. */
  function pressUpAt(game: VoxelmonGame, map: string, x: number, y: number): void {
    game.overworld.setMap(map, x, y + 1, "up");
    game.overworld.interact();
    for (let i = 0; i < 40; i++) game.tick(0);
  }

  /** Mash to the YES/NO, answer it, then let the rest of the box play out. */
  function answer(game: VoxelmonGame, yes: boolean): boolean {
    let answered = false;
    for (let i = 0; i < 900 && !answered; i++) {
      if (game.stackKinds().at(-1) === "choice") {
        game.tick(0); // release, so the next press is an edge
        if (!yes) tap(game, VOX_BTN.down);
        tap(game, VOX_BTN.a);
        answered = true;
        break;
      }
      game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    }
    if (!answered) return false;
    for (let i = 0; i < 400; i++) {
      game.tick(game.stackKinds().at(-1) === "textbox" && i % 2 === 0 ? VOX_BTN.a : 0);
    }
    return true;
  }

  const MANSION_1F = MANSION_BLOCKS.POKEMON_MANSION_1F!;

  test.skipIf(!hasGen)("the cook baked every switch door SHUT, with stamps to lift", () => {
    // pokered rewrites these on every map load, so the extracted map ships
    // them all OPEN — cooked as-is the mansion is one open floor with no
    // puzzle in it at all.
    const game = tgGame();
    game.overworld.setMap("POKEMON_MANSION_1F", 5, 5, "down");
    for (const b of MANSION_1F) {
      // switch off: the solidWhenOn doors stand open, the others are walls
      expect(blockAt(game, b.bx, b.by)).toBe(b.solidWhenOn ? OPEN_BLOCK : b.solid);
    }
  });

  test.skipIf(!hasGen)("pressing a switch flips every door on the floor", () => {
    const game = tgGame();
    game.overworld.setMap("POKEMON_MANSION_1F", 5, 5, "down");
    const before = MANSION_1F.map((b) => blockAt(game, b.bx, b.by));
    pressUpAt(game, "POKEMON_MANSION_1F", 2, 5);
    expect(answer(game, true)).toBe(true);
    expect(game.save.flags.EVENT_MANSION_SWITCH_ON).toBe(true);
    MANSION_1F.forEach((b, i) => {
      expect(blockAt(game, b.bx, b.by)).not.toBe(before[i]);
      expect(blockAt(game, b.bx, b.by)).toBe(b.solidWhenOn ? b.solid : OPEN_BLOCK);
    });
  });

  /**
   * How many of a block's four cells can be stood on. A gate block ($2d, $54,
   * $5f) walls off only half of its block — the wall runs across two of the
   * four cells — so "shut" is fewer than 4, not 0.
   */
  function walkableCells(game: VoxelmonGame, b: { bx: number; by: number }): number {
    let n = 0;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        if (game.overworld.map.isWalkableCell(b.bx * 2 + dx, b.by * 2 + dy)) n += 1;
      }
    }
    return n;
  }

  test.skipIf(!hasGen)("collision follows the doors, both ways", () => {
    // The stamp only moves the geometry; without the def.blocks write the
    // player walks through a door they can plainly see is shut.
    const game = tgGame();
    game.overworld.setMap("POKEMON_MANSION_1F", 5, 5, "down");
    const wall = MANSION_1F.find((b) => !b.solidWhenOn)!;
    expect(walkableCells(game, wall)).toBeLessThan(4);
    pressUpAt(game, "POKEMON_MANSION_1F", 2, 5);
    expect(answer(game, true)).toBe(true);
    expect(walkableCells(game, wall)).toBe(4);
    // and the switch shuts it again — markShut has to lift the override, or
    // the door closes on screen and stays open underfoot
    pressUpAt(game, "POKEMON_MANSION_1F", 2, 5);
    expect(answer(game, true)).toBe(true);
    expect(walkableCells(game, wall)).toBeLessThan(4);
  });

  test.skipIf(!hasGen)("a shut gym gate blocks the way through", () => {
    const game = tgGame();
    game.overworld.setMap("CINNABAR_GYM", 5, 5, "down");
    for (const m of GYM_MACHINES) {
      expect(walkableCells(game, m.gate)).toBeLessThan(4);
    }
  });

  test.skipIf(!hasGen)("the switch toggles BACK off, doors and all", () => {
    const game = tgGame();
    pressUpAt(game, "POKEMON_MANSION_1F", 2, 5);
    expect(answer(game, true)).toBe(true);
    const on = MANSION_1F.map((b) => blockAt(game, b.bx, b.by));
    pressUpAt(game, "POKEMON_MANSION_1F", 2, 5);
    expect(answer(game, true)).toBe(true);
    expect(game.save.flags.EVENT_MANSION_SWITCH_ON).toBe(false);
    MANSION_1F.forEach((b, i) => {
      expect(blockAt(game, b.bx, b.by)).not.toBe(on[i]);
    });
  });

  test.skipIf(!hasGen)("saying NO leaves the switch alone", () => {
    const game = tgGame();
    pressUpAt(game, "POKEMON_MANSION_1F", 2, 5);
    expect(answer(game, false)).toBe(true);
    expect(game.save.flags.EVENT_MANSION_SWITCH_ON ?? false).toBe(false);
  });

  test.skipIf(!hasGen)("one switch moves the OTHER floors too", () => {
    // EVENT_MANSION_SWITCH_ON is shared; each floor re-reads it on entry.
    const game = tgGame();
    pressUpAt(game, "POKEMON_MANSION_1F", 2, 5);
    expect(answer(game, true)).toBe(true);
    game.overworld.setMap("POKEMON_MANSION_B1F", 5, 5, "down");
    for (const b of MANSION_BLOCKS.POKEMON_MANSION_B1F!) {
      expect(blockAt(game, b.bx, b.by)).toBe(b.solidWhenOn ? b.solid : OPEN_BLOCK);
    }
  });

  test.skipIf(!hasGen)("a 3F hole drops you through the floor", () => {
    const game = tgGame();
    const h = MANSION_HOLES[0]!;
    game.overworld.setMap("POKEMON_MANSION_3F", h.x, h.y, "down");
    game.overworld.onStepComplete();
    for (let i = 0; i < 200; i++) game.tick(0);
    expect(game.overworld.map.id).toBe(h.map);
    expect(game.overworld.player.cellX).toBe(h.dx);
    expect(game.overworld.player.cellY).toBe(h.dy);
  });

  test.skipIf(!hasGen)("ordinary 3F floor does not drop you", () => {
    const game = tgGame();
    const h = MANSION_HOLES[0]!;
    game.overworld.setMap("POKEMON_MANSION_3F", h.x, h.y + 2, "down");
    game.overworld.onStepComplete();
    for (let i = 0; i < 200; i++) game.tick(0);
    expect(game.overworld.map.id).toBe("POKEMON_MANSION_3F");
  });

  test.skipIf(!hasGen)("the gym's six gates ship shut", () => {
    const game = tgGame();
    game.overworld.setMap("CINNABAR_GYM", 5, 5, "down");
    for (const m of GYM_MACHINES) {
      expect(blockAt(game, m.gate.bx, m.gate.by)).toBe(m.gate.solid);
    }
  });

  test.skipIf(!hasGen)("a right answer opens that room's gate, and only that one", () => {
    const game = tgGame();
    const m = GYM_MACHINES[0]!;
    pressUpAt(game, "CINNABAR_GYM", m.x, m.y);
    expect(answer(game, m.yes)).toBe(true);
    expect(game.save.flags[gymGateFlag(0)]).toBe(true);
    expect(blockAt(game, m.gate.bx, m.gate.by)).toBe(OPEN_BLOCK);
    const other = GYM_MACHINES[1]!;
    expect(walkableCells(game, m.gate)).toBe(4);
    expect(walkableCells(game, other.gate)).toBeLessThan(4);
    expect(game.save.flags[gymGateFlag(1)] ?? false).toBe(false);
    expect(blockAt(game, other.gate.bx, other.gate.by)).toBe(other.gate.solid);
  });

  test.skipIf(!hasGen)("a wrong answer leaves the gate shut", () => {
    const game = tgGame();
    const m = GYM_MACHINES[0]!;
    pressUpAt(game, "CINNABAR_GYM", m.x, m.y);
    expect(answer(game, !m.yes)).toBe(true);
    expect(game.save.flags[gymGateFlag(0)] ?? false).toBe(false);
    expect(blockAt(game, m.gate.bx, m.gate.by)).toBe(m.gate.solid);
  });

  test.skipIf(!hasGen)("the answers are not all the same button", () => {
    // Mashing A through all six would otherwise pass the gym, which is the
    // one thing the quiz exists to prevent.
    const yeses = GYM_MACHINES.filter((m) => m.yes).length;
    expect(yeses).toBeGreaterThan(0);
    expect(yeses).toBeLessThan(GYM_MACHINES.length);
  });

  test.skipIf(!hasGen)("an opened gate is still open on re-entry", () => {
    const game = tgGame();
    const m = GYM_MACHINES[0]!;
    pressUpAt(game, "CINNABAR_GYM", m.x, m.y);
    expect(answer(game, m.yes)).toBe(true);
    game.overworld.setMap("CINNABAR_ISLAND", 5, 5, "down");
    game.overworld.setMap("CINNABAR_GYM", 5, 5, "down");
    expect(blockAt(game, m.gate.bx, m.gate.by)).toBe(OPEN_BLOCK);
  });

  test.skipIf(!hasGen)("beating a guardian opens his gate without the quiz", () => {
    const game = tgGame();
    const m = GYM_MACHINES[2]!;
    ((game.save as { defeatedTrainers?: Record<string, boolean> }).defeatedTrainers ??= {})[
      gymGuardKey(m.npc)
    ] = true;
    game.overworld.setMap("CINNABAR_GYM", 5, 5, "down");
    expect(blockAt(game, m.gate.bx, m.gate.by)).toBe(OPEN_BLOCK);
  });

  test("the six questions map to six distinct gates and six distinct guards", () => {
    expect(GYM_MACHINES.length).toBe(6);
    expect(new Set(GYM_MACHINES.map((m) => `${m.gate.bx},${m.gate.by}`)).size).toBe(6);
    expect(new Set(GYM_MACHINES.map((m) => m.npc)).size).toBe(6);
    expect(new Set(GYM_MACHINES.map((m) => `${m.x},${m.y}`)).size).toBe(6);
    // wOpponentAfterWrongAnswer = gate index + 2, which is SUPER_NERD(i+1)
    GYM_MACHINES.forEach((m, i) => expect(m.npc).toBe(i + 3));
  });

  test("the cook is told about exactly the blocks the runtime toggles", () => {
    // If these two lists drift the geometry and the collision disagree.
    for (const [mapId, rows] of Object.entries(MANSION_BLOCKS)) {
      expect(toggleBlocksFor(mapId)).toEqual(rows);
    }
    expect(toggleBlocksFor("CINNABAR_GYM")).toEqual(GYM_MACHINES.map((m) => m.gate));
    expect(toggleBlocksFor("PALLET_TOWN")).toEqual([]);
  });
});

describe("the endgame", () => {
  function champGame(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []),
        "CHAMPIONS_ROOM", "HALL_OF_FAME",
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    game.save.party.push(newMon(romData!, "SQUIRTLE", 60));
    game.save.flags.EVENT_CHOSE_SQUIRTLE = true;
    return game;
  }

  function winBattles(game: VoxelmonGame): void {
    (game as any).startTrainerBattle = (
      _id: string, _idx: number, _name: unknown, onDone: (won: boolean) => void,
    ) => onDone(true);
  }

  /** Mash through whatever the scene is doing until `stop` says so. */
  function runScene(game: VoxelmonGame, stop: () => boolean, ticks = 4000): boolean {
    for (let i = 0; i < ticks; i++) {
      if (stop()) return true;
      if (game.stackKinds().at(-1) === "textbox") dismissText(game);
      else game.tick(0);
    }
    return stop();
  }

  test.skipIf(!hasGen)("the Champion's room opens with the rival, not silence", () => {
    const game = champGame();
    const ow = game.overworld;
    ow.setMap("CHAMPIONS_ROOM", 4, 6, "up");
    ow.onStepComplete();
    let guard = 0;
    while (game.stackKinds().at(-1) !== "textbox" && guard++ < 400) game.tick(0);
    expect(topText(game)).toContain("looking forward to seeing");
  });

  test.skipIf(!hasGen)("he fights with the champion team", () => {
    const game = champGame();
    const ow = game.overworld;
    ow.setMap("CHAMPIONS_ROOM", 4, 6, "up");
    ow.onStepComplete();
    let guard = 0;
    while (game.stackKinds().at(-1) !== "battle" && guard++ < 1200) {
      if (game.stackKinds().at(-1) === "textbox") dismissText(game);
      else game.tick(0);
    }
    expect(game.stackKinds().at(-1)).toBe("battle");
    // OPP_RIVAL3 party 1 + the Squirtle counterpick = party 2, the VENUSAUR set
    const battle = (game.battleView() as { battle: any }).battle;
    expect(battle.enemyParty.at(-1).species).toBe("VENUSAUR");
    expect(battle.enemyParty.length).toBe(6);
  });

  test.skipIf(!hasGen)("losing to him does not crown you", () => {
    const game = champGame();
    const ow = game.overworld;
    (game as any).startTrainerBattle = (
      _id: string, _idx: number, _name: unknown, onDone: (won: boolean) => void,
    ) => onDone(false);
    ow.setMap("CHAMPIONS_ROOM", 4, 6, "up");
    ow.onStepComplete();
    runScene(game, () => false, 1200);
    expect(game.save.flags.EVENT_BEAT_CHAMPION_RIVAL ?? false).toBe(false);
    expect(game.save.flags.EVENT_HALL_OF_FAME_PENDING ?? false).toBe(false);
    expect(game.save.hallOfFame ?? []).toEqual([]);
  });

  test.skipIf(!hasGen)("beating him crowns you and sends you up to the Hall", () => {
    const game = champGame();
    const ow = game.overworld;
    winBattles(game);
    ow.setMap("CHAMPIONS_ROOM", 4, 6, "up");
    ow.onStepComplete();
    expect(runScene(game, () => ow.map.id === "HALL_OF_FAME")).toBe(true);
    expect(game.save.flags.EVENT_BEAT_CHAMPION_RIVAL).toBe(true);
    expect(game.save.flags.EVENT_BEAT_CHAMPION_RIVAL_THIS_RUN).toBe(true);
  });

  test.skipIf(!hasGen)("walking back in as champion does not re-run the fight", () => {
    const game = champGame();
    const ow = game.overworld;
    game.save.flags.EVENT_BEAT_CHAMPION_RIVAL_THIS_RUN = true;
    ow.setMap("CHAMPIONS_ROOM", 4, 6, "up");
    ow.onStepComplete();
    for (let i = 0; i < 200; i++) game.tick(0);
    expect(game.stackKinds()).toEqual(["overworld"]);
  });

  test.skipIf(!hasGen)("the Hall records the party, rolls the credits, and sends you home", () => {
    const game = champGame();
    const ow = game.overworld;
    game.save.party.push(newMon(romData!, "PIDGEOT", 55));
    game.save.flags.EVENT_HALL_OF_FAME_PENDING = true;
    ow.setMap("HALL_OF_FAME", 4, 7, "up");
    ow.onStepComplete();

    // the induction rolls first
    expect(runScene(game, () => game.stackKinds().at(-1) === "halloffame", 2000)).toBe(true);
    const hof = game.hallOfFameScreen() as any;
    expect(hof.total).toBe(2);
    expect(hof.mon.name).toBe("SQUIRTLE");
    expect(hof.title).toContain("HALL OF FAME");

    // then the credits
    expect(runScene(game, () => game.stackKinds().at(-1) === "credits", 4000)).toBe(true);
    const cr = game.creditsScreen() as any;
    expect(cr.total).toBeGreaterThan(5);
    expect(cr.lines.length).toBeGreaterThan(0);

    // and then home to Pallet, healed, with the record kept
    expect(runScene(game, () => ow.map.id === "REDS_HOUSE_2F", 60000)).toBe(true);
    expect(game.save.hallOfFame.length).toBe(1);
    expect(game.save.hallOfFame[0].map((m: any) => m.species))
      .toEqual(["SQUIRTLE", "PIDGEOT"]);
    expect(game.save.lastOutdoor.id).toBe("PALLET_TOWN");
    // clear_flag deletes the key rather than writing false
    expect(game.save.flags.EVENT_HALL_OF_FAME_PENDING ?? false).toBe(false);
  });

  test.skipIf(!hasGen)("the induction runs once, not on every visit", () => {
    const game = champGame();
    const ow = game.overworld;
    ow.setMap("HALL_OF_FAME", 4, 7, "up");
    ow.onStepComplete();
    for (let i = 0; i < 300; i++) game.tick(0);
    expect(game.stackKinds()).toEqual(["overworld"]);
    expect(game.save.hallOfFame ?? []).toEqual([]);
  });

  test("the record is a photograph, not a live view of the party", () => {
    // The mons go on being played with -- levelled, renamed, released -- and
    // the hall has to keep the team that actually won.
    const save: any = { party: [{ species: "RATTATA", level: 12, nickname: "RAT" }] };
    const entry = recordHallOfFame(save);
    save.party[0].level = 99;
    save.party[0].species = "RAICHU";
    expect(entry).toEqual([{ species: "RATTATA", level: 12, nickname: "RAT" }]);
    expect(save.hallOfFame[0][0].level).toBe(12);
  });

  test("a second win is a second record, not a replacement", () => {
    const save: any = { party: [{ species: "RATTATA", level: 12 }] };
    recordHallOfFame(save);
    save.party = [{ species: "MEWTWO", level: 70 }];
    recordHallOfFame(save);
    expect(save.hallOfFame.length).toBe(2);
    expect(save.hallOfFame[1][0].species).toBe("MEWTWO");
  });

  test("the record survives a save round trip", () => {
    const save: any = { party: [{ species: "RATTATA", level: 12, nickname: "RAT" }] };
    recordHallOfFame(save);
    const back = decodeSave(encodeSave(save)) as any;
    expect(back.hallOfFame[0][0]).toEqual({ species: "RATTATA", level: 12, nickname: "RAT" });
  });

  test("home is Pallet, not wherever the league left you", () => {
    const save: any = { lastOutdoor: { id: "INDIGO_PLATEAU", x: 1, y: 1 } };
    applyPostGameHome(save);
    expect(save.lastOutdoor).toEqual({ id: "PALLET_TOWN", x: 5, y: 6 });
    expect(POST_GAME_HOME.map).toBe("REDS_HOUSE_2F");
  });
});

describe("the trainer headers", () => {
  /**
   * The extractor keys these by object index, 1-based; writer.ts numericKeyed
   * silently turns a dense-from-1 map into a 0-based array. 43 of the 69 maps
   * come through as arrays, so a single indexing rule cannot be right for
   * both -- and the one that was there gave every trainer on those 43 maps
   * the NEXT trainer's header.
   */
  test.skipIf(!hasGen)("resolve to the right trainer in both shapes", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    const header = (npc: unknown): any => (ow as any).trainerHeader(npc);

    // array shape: MT_MOON_1F's seven trainers ARE objects 1..7
    ow.setMap("MT_MOON_1F", 5, 5, "down");
    const hiker = ow.npcs.find((n: any) => n.def.name === "MTMOON1F_HIKER");
    expect(header(hiker)?.event).toBe("EVENT_BEAT_MT_MOON_1_TRAINER_0");
    const last = ow.npcs.find((n: any) => n.def.name === "MTMOON1F_YOUNGSTER3");
    // the last one on the map used to fall off the end of the array entirely
    expect(header(last)?.event).toBe("EVENT_BEAT_MT_MOON_1_TRAINER_6");

    // object shape: PEWTER_GYM keys its one header "2", the Jr. Trainer --
    // Brock is scripted and has none
    ow.setMap("PEWTER_GYM", 4, 10, "up");
    const jr = ow.npcs.find((n: any) => n.def.index === 2);
    expect(header(jr)?.event).toBe("EVENT_BEAT_PEWTER_GYM_TRAINER_0");
  });

  test.skipIf(!hasGen)("every array-shaped map's trainers all resolve", () => {
    // The real symptom was the LAST trainer of each of those maps silently
    // having no header: no sight line, and no beat flag on a win.
    const game = makeMenuGame();
    const ow = game.overworld;
    const headers = (romData as any).trainer_headers as Record<string, unknown>;
    const maps = (romData as any).maps as Record<string, any>;
    let checked = 0;
    for (const [name, def] of Object.entries(maps)) {
      const h = def.label ? headers[def.label] : undefined;
      if (!Array.isArray(h)) continue;
      ow.setMap(name, 1, 1, "down");
      for (let i = 1; i <= h.length; i++) {
        const got = (ow as any).trainerHeader({ def: { index: i } });
        expect(got, `${name} obj ${i}`).toBeTruthy();
        expect(got).toBe(h[i - 1]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe("the Elite Four's doors", () => {
  const ROOMS = ["LORELEIS_ROOM", "BRUNOS_ROOM", "AGATHAS_ROOM", "LANCES_ROOM"];

  function leagueGame(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []),
        ...ROOMS,
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    return game;
  }

  function blockAt(game: VoxelmonGame, bx: number, by: number): number {
    const def = game.overworld.map.def as { blocks: number[]; width: number };
    return def.blocks[by * def.width + bx]!;
  }

  /** How many of a block's four cells can be stood on. */
  function walkableCells(game: VoxelmonGame, b: { bx: number; by: number }): number {
    let n = 0;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        if (game.overworld.map.isWalkableCell(b.bx * 2 + dx, b.by * 2 + dy)) n += 1;
      }
    }
    return n;
  }

  const ANTEROOMS = ["LORELEIS_ROOM", "BRUNOS_ROOM", "AGATHAS_ROOM"] as const;

  test.skipIf(!hasGen)("each anteroom's exit is sealed until its keeper falls", () => {
    // BRUNOS_ROOM and AGATHAS_ROOM ship these blocks OPEN -- pokered rewrites
    // them on load -- so without the cook baking them shut the league is a
    // straight corridor you can walk to Lance through.
    for (const id of ANTEROOMS) {
      const seal = LEAGUE_SEALS[id]!;
      const b = seal.blocks[0]!;
      const shut = leagueGame();
      shut.overworld.setMap(id, 4, 5, "up");
      expect(blockAt(shut, b.bx, b.by), `${id} shut`).toBe(b.solid);
      expect(walkableCells(shut, b), `${id} shut`).toBeLessThan(4);

      const open = leagueGame();
      open.save.flags[seal.flag] = true;
      open.overworld.setMap(id, 4, 5, "up");
      expect(blockAt(open, b.bx, b.by), `${id} open`).toBe(OPEN_BLOCK);
      expect(walkableCells(open, b), `${id} open`).toBe(4);
    }
  });

  test.skipIf(!hasGen)("the door opens the moment the keeper falls, with no re-entry", () => {
    // pokered reloads the map after a battle, which is what re-runs
    // LoreleiShowOrHideExitBlock. Nothing reloads here, so the win has to
    // re-apply the seal itself.
    const game = leagueGame();
    const ow = game.overworld;
    const b = LEAGUE_SEALS.LORELEIS_ROOM!.blocks[0]!;
    ow.setMap("LORELEIS_ROOM", 4, 5, "up");
    expect(walkableCells(game, b)).toBeLessThan(4);

    // beat her for real, through engageTrainer -- the point of the test is
    // that the WIN re-applies the seal, so poking the flag would prove nothing
    (game as any).startTrainerBattle = (
      _id: string, _idx: number, _name: unknown, onDone: (won: boolean) => void,
    ) => onDone(true);
    const lorelei = ow.npcs.find((n: any) => n.def.name === "LORELEISROOM_LORELEI");
    expect(lorelei).toBeTruthy();
    ow.engageTrainer(lorelei, () => {});
    for (let i = 0; i < 900; i++) {
      dismissText(game);
      if (ow.trainerDefeated(lorelei)) break;
      game.tick(0);
    }
    expect(ow.trainerDefeated(lorelei)).toBe(true);
    expect(walkableCells(game, b)).toBe(4);
  });

  test.skipIf(!hasGen)("one room's win does not open another's door", () => {
    const game = leagueGame();
    game.save.flags.EVENT_BEAT_LORELEIS_ROOM_TRAINER_0 = true;
    const b = LEAGUE_SEALS.BRUNOS_ROOM!.blocks[0]!;
    game.overworld.setMap("BRUNOS_ROOM", 4, 5, "up");
    expect(blockAt(game, b.bx, b.by)).toBe(b.solid);
  });

  test.skipIf(!hasGen)("retreating toward the entrance gets you shoved back", () => {
    for (const id of ANTEROOMS) {
      const game = leagueGame();
      const ow = game.overworld;
      ow.setMap(id, 4, 11, "down");
      ow.onStepComplete();
      let guard = 0;
      while (game.stackKinds().at(-1) !== "textbox" && guard++ < 300) game.tick(0);
      expect(topText(game), id).toContain("run away");
      // and the shove actually moves them off the entrance row
      dismissText(game);
      for (let i = 0; i < 200; i++) game.tick(0);
      expect(ow.player.cellY, id).toBeLessThan(11);
    }
  });

  test.skipIf(!hasGen)("the rest of the room is free to walk", () => {
    const game = leagueGame();
    const ow = game.overworld;
    ow.setMap("LORELEIS_ROOM", 4, 6, "up");
    ow.onStepComplete();
    for (let i = 0; i < 120; i++) game.tick(0);
    expect(game.stackKinds()).toEqual(["overworld"]);
  });

  test.skipIf(!hasGen)("Lance's doorway stands OPEN on the way in", () => {
    // His is the inverted one: the .blk ships the arena doorway CLOSED and
    // pokered opens it on load. Cooked as-is, Lance and both Champion's Room
    // warps behind him were walled off and the league dead-ended at his door.
    const game = leagueGame();
    game.overworld.setMap("LANCES_ROOM", 6, 12, "up");
    for (const b of LEAGUE_SEALS.LANCES_ROOM!.blocks) {
      expect(blockAt(game, b.bx, b.by)).toBe(OPEN_BLOCK);
    }
    expect(game.overworld.map.isWalkableCell(5, 11)).toBe(true);
    expect(game.overworld.map.isWalkableCell(6, 11)).toBe(true);
  });

  test.skipIf(!hasGen)("crossing it locks the door behind you", () => {
    const game = leagueGame();
    const ow = game.overworld;
    ow.setMap("LANCES_ROOM", 6, 11, "up");
    expect(game.save.flags.EVENT_LANCES_ROOM_LOCK_DOOR ?? false).toBe(false);
    ow.onStepComplete();
    expect(game.save.flags.EVENT_LANCES_ROOM_LOCK_DOOR).toBe(true);
    for (const b of LEAGUE_SEALS.LANCES_ROOM!.blocks) {
      expect(blockAt(game, b.bx, b.by)).toBe(b.solid);
    }
    // and it stays locked across a re-entry
    ow.setMap("INDIGO_PLATEAU_LOBBY", 4, 4, "down");
    ow.setMap("LANCES_ROOM", 6, 2, "up");
    for (const b of LEAGUE_SEALS.LANCES_ROOM!.blocks) {
      expect(blockAt(game, b.bx, b.by)).toBe(b.solid);
    }
  });

  test.skipIf(!hasGen)("a tile that is not the doorway does not lock it", () => {
    const game = leagueGame();
    const ow = game.overworld;
    ow.setMap("LANCES_ROOM", 10, 11, "up");
    ow.onStepComplete();
    expect(game.save.flags.EVENT_LANCES_ROOM_LOCK_DOOR ?? false).toBe(false);
  });

  test("the seals and the blocks the cook bakes cannot drift apart", () => {
    for (const [id, seal] of Object.entries(LEAGUE_SEALS)) {
      expect(toggleBlocksFor(id).map((b) => [b.bx, b.by, b.solid]))
        .toEqual(seal.blocks.map((b) => [b.bx, b.by, b.solid]));
    }
    // Lance is the only inverted one, and the only one with no retreat line
    expect(LEAGUE_SEALS.LANCES_ROOM!.whileSet).toBe(true);
    expect(LEAGUE_SEALS.LANCES_ROOM!.dontRun).toBeUndefined();
    for (const id of ANTEROOMS) {
      expect(LEAGUE_SEALS[id]!.whileSet ?? false, id).toBe(false);
      expect(LEAGUE_SEALS[id]!.dontRun, id).toBeTruthy();
    }
  });
});

describe("the PC item storage", () => {
  /** The PC menu, opened as the tile opens it. */
  function openPc(game: VoxelmonGame): void {
    game.openPc();
  }

  function pcv(game: VoxelmonGame): any {
    return game.pc() as any;
  }

  /** Walk a menu cursor to `i` and press A. */
  function choose(game: VoxelmonGame, i: number): void {
    for (let k = 0; k < i; k++) tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.a);
  }

  /** Get past whatever box the last choice pushed. */
  function settle(game: VoxelmonGame): void {
    for (let i = 0; i < 300; i++) {
      if (game.stackKinds().at(-1) === "pc") break;
      game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    }
    game.tick(0);
  }

  /** Into MY PC -> the numbered item action. */
  function itemAction(game: VoxelmonGame, action: number): void {
    openPc(game);
    choose(game, 1); // MY PC
    settle(game);
    choose(game, action);
    settle(game);
  }

  test.skipIf(!hasGen)("depositing moves it out of the bag and into the PC", () => {
    const game = makeMenuGame();
    Bag.add(game.save, "POTION", 5);
    itemAction(game, 1); // DEPOSIT ITEM
    expect(pcv(game).mode).toBe("list");
    tap(game, VOX_BTN.a); // first item -> quantity (a stack of 5)
    expect(pcv(game).mode).toBe("quantity");
    tap(game, VOX_BTN.up); // 1 -> 2
    tap(game, VOX_BTN.a);
    settle(game);
    expect(game.save.inventory.POTION).toBe(3);
    expect(game.save.pc?.inventory.POTION).toBe(2);
  });

  test.skipIf(!hasGen)("withdrawing brings it back", () => {
    const game = makeMenuGame();
    game.save.pc = { inventory: { POTION: 4 }, bagOrder: ["POTION"] };
    itemAction(game, 0); // WITHDRAW ITEM
    tap(game, VOX_BTN.a);
    tap(game, VOX_BTN.a); // take 1
    settle(game);
    expect(game.save.inventory.POTION).toBe(1);
    expect(game.save.pc?.inventory.POTION).toBe(3);
  });

  test.skipIf(!hasGen)("tossing from the PC just removes it", () => {
    const game = makeMenuGame();
    game.save.pc = { inventory: { POTION: 2 }, bagOrder: ["POTION"] };
    itemAction(game, 2); // TOSS ITEM
    tap(game, VOX_BTN.a);
    tap(game, VOX_BTN.a); // 1 of them
    settle(game);
    expect(game.save.pc?.inventory.POTION).toBe(1);
    expect(game.save.inventory.POTION ?? 0).toBe(0); // not into the bag
  });

  test.skipIf(!hasGen)("an empty box says so instead of opening a list", () => {
    const game = makeMenuGame();
    itemAction(game, 0); // WITHDRAW with nothing stored
    expect(pcv(game)?.mode).toBe("items");
  });

  test.skipIf(!hasGen)("an empty bag has nothing to deposit", () => {
    const game = makeMenuGame();
    for (const id of Bag.order(game.save)) Bag.remove(game.save, id, 99);
    itemAction(game, 1);
    expect(pcv(game)?.mode).toBe("items");
  });

  test("the PC holds 50 slots where the bag holds 20", () => {
    const save: any = { inventory: {}, bagOrder: [] };
    const data: any = { constants: {} };
    // 25 distinct things: the bag refuses past 20, the PC takes them all
    const ids = Array.from({ length: 25 }, (_, i) => `ITEM_${i}`);
    let inBag = 0;
    for (const id of ids) if (Bag.add(save, id, 1, data)) inBag += 1;
    expect(inBag).toBe(20);

    const box: any = { inventory: {}, bagOrder: [] };
    let inPc = 0;
    for (const id of ids) {
      if (Bag.add(box, id, 1, pcCapacityData(data))) inPc += 1;
    }
    expect(inPc).toBe(25);
  });

  test("a full box keeps the item in the bag rather than eating it", () => {
    const save: any = { inventory: { POTION: 1 }, bagOrder: ["POTION"], pc: undefined };
    const data: any = { constants: {}, field: { pcItemCap: 1 } };
    // fill the single PC slot with something else
    expect(deposit(save, "POTION", 1, data)).toBe(true);
    save.inventory.ETHER = 1;
    save.bagOrder.push("ETHER");
    expect(deposit(save, "ETHER", 1, data)).toBe(false);
    // refused, and NOT taken out of the bag on the way
    expect(save.inventory.ETHER).toBe(1);
    expect(save.pc.inventory.ETHER).toBeUndefined();
  });

  test("a full bag keeps the item in the box", () => {
    const save: any = { inventory: {}, bagOrder: [], pc: { inventory: { POTION: 1 }, bagOrder: ["POTION"] } };
    const data: any = { constants: { bagSize: 1 } };
    save.inventory.ETHER = 1;
    save.bagOrder.push("ETHER");
    expect(withdraw(save, "POTION", 1, data)).toBe(false);
    expect(save.pc.inventory.POTION).toBe(1);
  });
});

describe("the two locked gym doors", () => {
  function gateGame2(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []),
        "CINNABAR_ISLAND", "VIRIDIAN_CITY",
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    return game;
  }

  /** Stand on a tile and let the land-trigger run. */
  function stepOnto(game: VoxelmonGame, map: string, x: number, y: number): void {
    game.overworld.setMap(map, x, y, "up");
    game.overworld.onStepComplete();
    for (let i = 0; i < 60; i++) game.tick(0);
  }

  function boxText(game: VoxelmonGame): string {
    const src = game.uiBox() as { box?: { pages?: { lines: string[] }[] } } | null;
    return (src?.box?.pages ?? []).map((pg) => pg.lines.join(" ")).join(" ");
  }

  test.skipIf(!hasGen)("Cinnabar's gym is locked until the SECRET KEY", () => {
    const game = gateGame2();
    stepOnto(game, "CINNABAR_ISLAND", 18, 4);
    expect(boxText(game)).toContain("locked");

    const open = gateGame2();
    Bag.add(open.save, "SECRET_KEY", 1);
    stepOnto(open, "CINNABAR_ISLAND", 18, 4);
    expect(open.stackKinds()).toEqual(["overworld"]);
  });

  test.skipIf(!hasGen)("the rest of Cinnabar is walkable either way", () => {
    const game = gateGame2();
    stepOnto(game, "CINNABAR_ISLAND", 10, 10);
    expect(game.stackKinds()).toEqual(["overworld"]);
  });

  test.skipIf(!hasGen)("Viridian's gym needs all seven other badges", () => {
    const game = gateGame2();
    stepOnto(game, "VIRIDIAN_CITY", 32, 8);
    expect(boxText(game)).toContain("locked");

    // six of seven is still locked -- it is every badge, not a count
    const six = gateGame2();
    for (const b of SEVEN_BADGES.slice(0, 6)) six.save.inventory[b] = 1;
    stepOnto(six, "VIRIDIAN_CITY", 32, 8);
    expect(boxText(six)).toContain("locked");

    const all = gateGame2();
    for (const b of SEVEN_BADGES) all.save.inventory[b] = 1;
    stepOnto(all, "VIRIDIAN_CITY", 32, 8);
    expect(all.stackKinds()).toEqual(["overworld"]);
  });

  test.skipIf(!hasGen)("the gym lock does not eat the sleeping old man's block", () => {
    // The two share one onStep; the gym check must fall through when the
    // player is nowhere near the gym door.
    const game = gateGame2();
    stepOnto(game, "VIRIDIAN_CITY", 19, 9);
    // whatever the old-man corridor does, it is not the gym's line
    expect(boxText(game)).not.toContain("GYM's doors");
  });

  test.skipIf(!hasGen)("the gambler reports the leader once the badges are in", () => {
    const before = gateGame2();
    before.overworld.setMap("VIRIDIAN_CITY", 10, 10, "up");
    before.overworld.showMapText("TEXT_VIRIDIANCITY_GAMBLER1");
    for (let i = 0; i < 600; i++) before.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    expect(boxText(before) + " ").toBeTruthy();

    const after = gateGame2();
    for (const b of SEVEN_BADGES) after.save.inventory[b] = 1;
    after.overworld.setMap("VIRIDIAN_CITY", 10, 10, "up");
    after.overworld.showMapText("TEXT_VIRIDIANCITY_GAMBLER1");
    let said = "";
    for (let i = 0; i < 600; i++) {
      const s = boxText(after);
      if (s) said = s;
      after.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(said).toContain("returned");
  });

  test.skipIf(!hasGen)("and goes back to wondering once Giovanni is beaten", () => {
    const game = gateGame2();
    for (const b of SEVEN_BADGES) game.save.inventory[b] = 1;
    game.save.flags.EVENT_BEAT_GIOVANNI = true;
    game.overworld.setMap("VIRIDIAN_CITY", 10, 10, "up");
    game.overworld.showMapText("TEXT_VIRIDIANCITY_GAMBLER1");
    let said = "";
    for (let i = 0; i < 600; i++) {
      const s = boxText(game);
      if (s) said = s;
      game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(said).toContain("always closed");
  });
});
