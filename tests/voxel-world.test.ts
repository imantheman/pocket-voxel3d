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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ENT_FLAG, VOX_BTN, VOX_OP } from "../contracts/spec/voxel-spec.ts";
import { fromGenDir as loadAudioBanks } from "../voxelmon/game/audio/banks.ts";
import { loadRuntimeData, REQUIRED_MODULES, type VoxelmonData } from "../voxelmon/game/data.ts";
import { WildBattle } from "../voxelmon/game/battle/battle.ts";
import { newMon, type PartyMon } from "../voxelmon/game/battle/mon.ts";
import { EVO_FLASH_FRAMES, flashPeriod } from "../voxelmon/game/ui/evoscreen.ts";
import * as Bag from "../voxelmon/game/rules/bag.ts";
import { floorsOf } from "../voxelmon/game/world/elevator.ts";
import { destination as warpDestination } from "../voxelmon/game/world/warp.ts";
import * as Pc from "../voxelmon/game/world/pcitems.ts";
import { decodeSave } from "../voxelmon/game/save-read.ts";
import { ShopState } from "../voxelmon/game/ui/shopscreen.ts";
import { thirstyGirlRows } from "../voxelmon/game/world/vending.ts";
import { MAP_SCRIPTS } from "../voxelmon/game/world/mapscripts.ts";
import * as Items from "../voxelmon/game/rules/items.ts";
import * as Trash from "../voxelmon/game/world/trashcans.ts";
import * as Hidden from "../voxelmon/game/world/hiddenitems.ts";
import * as Seafoam from "../voxelmon/game/world/seafoam.ts";
import { PartyState } from "../voxelmon/game/ui/partyscreen.ts";
import { picPageFor } from "../voxelmon/game/battle/staging.ts";
import { POST_GAME_HOME, postGameRescue } from "../voxelmon/game/world/halloffame.ts";
import { fishingCatch, rodPool } from "../voxelmon/game/world/fishing.ts";
import { talkScript } from "../voxelmon/game/world/mapscripts.ts";
import { LANCE_WALK_IN } from "../voxelmon/game/world/mapscripts.ts";
import { TrainerBattle } from "../voxelmon/game/battle/trainer.ts";
import { seqRng } from "../voxelmon/game/rng.ts";
import * as Bag from "../voxelmon/game/rules/bag.ts";
import { ENCOUNTER_BUCKETS } from "../voxelmon/game/rules/encounter.ts";
import { expForLevel } from "../voxelmon/game/rules/growth.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { encodeSave } from "../voxelmon/game/save-lua.ts";
import { bodyClear, freeDir, slide, stickPush, STICK_MIN_THROW } from "../voxelmon/game/world/freemove.ts";
import { OptionsMenuState } from "../voxelmon/game/ui/optionsmenu.ts";
import { PartyState } from "../voxelmon/game/ui/partyscreen.ts";
import { decodeSave } from "../voxelmon/game/save-read.ts";
import {
  backfillVisited, FLY_MAP_IDS, flyDestinations, visit,
} from "../voxelmon/game/world/fly.ts";
import {
  adjacentSnorlax, SNORLAX, SNORLAX_LEVEL, spotFor,
} from "../voxelmon/game/world/snorlax.ts";
import {
  applyPostGameHome, POST_GAME_HOME, recordHallOfFame,
} from "../voxelmon/game/world/halloffame.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { Input } from "../voxelmon/game/input.ts";
import { gearMapPoint, gearTabs, gearTouchDown, gearTouchUp } from "../voxelmon/game/ui/kantogear.ts";
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
  barriersFor, GYM_MACHINES, gymGateFlag, gymGuardKey, LEAGUE_SEALS,
  MANSION_BLOCKS, MANSION_HOLES, OPEN_BLOCK, ROAD_HOLES, toggleBlocksFor,
} from "../voxelmon/game/world/toggleblocks.ts";
import {
  bikeAllowed, BIKE_SONG, effectiveMapSong, SURF_SONG,
} from "../voxelmon/game/world/bike.ts";
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
    // DEV is an OPTION now, off by default (ui/optionsmenu.ts DEV MENU)
    game.save.options.devMenu = true;
    tap(game, VOX_BTN.start);
    expect(game.stackKinds()).toEqual(["overworld", "startmenu"]);
    // with it on: ITEM, <name>, SAVE, OPTION, DEV, EXIT
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

describe("the OLD AMBER and the fossil lab", () => {
  /** Run a map text's script to the end, answering its YES/NOs in order. */
  function runText(game: VoxelmonGame, map: string, text: string, answers: boolean[] = []): void {
    const ow = game.overworld;
    if (ow.map.id !== map) ow.setMap(map, 4, 4, "up");
    ow.showMapText(text);
    for (let i = 0; i < 900; i++) {
      const top = game.stackKinds().at(-1);
      if (top === "choice") {
        if (!(answers.shift() ?? false)) tap(game, VOX_BTN.down);
        tap(game, VOX_BTN.a);
        // the answer is held on screen for a beat before the box closes
        for (let h = 0; h < 60 && game.stackKinds().at(-1) === "choice"; h++) game.tick(0);
        continue;
      }
      if (top !== "textbox" && !(ow as any).runner.isRunning()) return;
      dismissText(game);
      game.tick(0);
    }
  }

  test.skipIf(!hasGen)("the museum scientist hands over the OLD AMBER, once", () => {
    const game = makeMenuGame();
    runText(game, "MUSEUM_1F", "TEXT_MUSEUM1F_SCIENTIST2");
    expect(game.save.inventory.OLD_AMBER).toBe(1);
    expect(game.save.flags.EVENT_GOT_OLD_AMBER).toBe(true);
    expect(game.save.objectToggles?.MUSEUM_1F?.MUSEUM1F_OLD_AMBER).toBe(false);
    runText(game, "MUSEUM_1F", "TEXT_MUSEUM1F_SCIENTIST2");
    expect(game.save.inventory.OLD_AMBER).toBe(1);
  });

  test.skipIf(!hasGen)("the lab revives it after a walk on the island", () => {
    const game = makeMenuGame();
    (game as any).askNickname = (_n: string, done: (n: string | null) => void) => done(null);
    game.save.inventory.OLD_AMBER = 1;
    const lab = "CINNABAR_LAB_FOSSIL_ROOM";
    const doc = "TEXT_CINNABARLABFOSSILROOM_SCIENTIST1";
    runText(game, lab, doc, [true]);
    expect(game.save.inventory.OLD_AMBER ?? 0).toBe(0);
    expect(game.save.flags.EVENT_GAVE_FOSSIL_TO_LAB).toBe(true);
    // still in the lab: not ready
    const before = game.save.party.length;
    runText(game, lab, doc);
    expect(game.save.party.length).toBe(before);
    // out onto the island and back
    game.overworld.setMap("CINNABAR_ISLAND", 6, 4, "down");
    expect(game.save.flags.EVENT_LAB_STILL_REVIVING_FOSSIL).toBeFalsy();
    runText(game, lab, doc, [false]); // no nickname
    expect(game.save.party.length).toBe(before + 1);
    const mon = game.save.party.at(-1)!;
    expect(mon.species).toBe("AERODACTYL");
    expect(mon.level).toBe(30);
    expect(game.save.flags.EVENT_GAVE_FOSSIL_TO_LAB).toBeFalsy();
  });

  test.skipIf(!hasGen)("with two fossils, NO to the first offers the next", () => {
    const game = makeMenuGame();
    game.save.inventory.HELIX_FOSSIL = 1;
    game.save.inventory.OLD_AMBER = 1;
    runText(game, "CINNABAR_LAB_FOSSIL_ROOM", "TEXT_CINNABARLABFOSSILROOM_SCIENTIST1", [false, true]);
    expect(game.save.inventory.HELIX_FOSSIL).toBe(1);
    expect(game.save.inventory.OLD_AMBER ?? 0).toBe(0);
    expect((game.save as any).labFossilMon).toBe("AERODACTYL");
  });
});

describe("spinners, trades, legendaries, the League rematch", () => {
  function drain(game: VoxelmonGame, answers: boolean[] = [], pick?: number): void {
    const ow = game.overworld;
    for (let i = 0; i < 900; i++) {
      const top = game.stackKinds().at(-1);
      if (top === "choice") {
        if (!(answers.shift() ?? false)) tap(game, VOX_BTN.down);
        tap(game, VOX_BTN.a);
        for (let h = 0; h < 60 && game.stackKinds().at(-1) === "choice"; h++) game.tick(0);
        continue;
      }
      if (top === "party") {
        for (let k = 0; k < (pick ?? 0); k++) tap(game, VOX_BTN.down);
        tap(game, VOX_BTN.a);
        continue;
      }
      if (top !== "textbox" && !(ow as any).runner.isRunning() && ow.scriptMoves.length === 0) return;
      dismissText(game);
      game.tick(0);
    }
  }

  test.skipIf(!hasGen)("a Rocket Hideout arrow slides the player", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    const sp = (romData!.field as any).spinners.ROCKET_HIDEOUT_B2F[0];
    ow.setMap("ROCKET_HIDEOUT_B2F", sp.x, sp.y, "down");
    ow.onStepComplete();
    for (let i = 0; i < 400 && ow.scriptMoves.length > 0; i++) game.tick(0);
    const mv = sp.moves[0];
    const dx = mv.dir === "left" ? -mv.count : mv.dir === "right" ? mv.count : 0;
    const dy = mv.dir === "up" ? -mv.count : mv.dir === "down" ? mv.count : 0;
    // it moved off the arrow the way the arrow points (a chain may carry on)
    expect(ow.player.cellX !== sp.x || ow.player.cellY !== sp.y).toBe(true);
    if (sp.moves.length === 1 && dx) expect(Math.sign(ow.player.cellX - sp.x)).toBe(Math.sign(dx));
    if (sp.moves.length === 1 && dy) expect(Math.sign(ow.player.cellY - sp.y)).toBe(Math.sign(dy));
  });

  test.skipIf(!hasGen)("the Route 2 trader swaps ABRA for MR. MIME, once", () => {
    const game = makeMenuGame();
    game.save.party.push(newMon(romData!, "ABRA", 9));
    const at = game.save.party.length - 1;
    game.overworld.setMap("ROUTE_2_TRADE_HOUSE", 3, 3, "up");
    game.overworld.showMapText("TEXT_ROUTE2TRADEHOUSE_GAMEBOY_KID");
    drain(game, [true], at);
    const got = game.save.party.at(-1)!;
    expect(got.species).toBe("MR_MIME");
    expect(got.nickname).toBe("MARCEL");
    expect(got.level).toBe(9);
    expect(game.save.party.some((m) => m.species === "ABRA")).toBe(false);
    expect(game.save.flags.EVENT_TRADED_ABRA_FOR_MR_MIME).toBe(true);
  });

  test.skipIf(!hasGen)("the wrong mon is refused and nothing moves", () => {
    const game = makeMenuGame();
    const before = game.save.party.map((m) => m.species);
    game.overworld.setMap("ROUTE_2_TRADE_HOUSE", 3, 3, "up");
    game.overworld.showMapText("TEXT_ROUTE2TRADEHOUSE_GAMEBOY_KID");
    drain(game, [true], 0);
    expect(game.save.party.map((m) => m.species)).toEqual(before);
    expect(game.save.flags.EVENT_TRADED_ABRA_FOR_MR_MIME).toBeFalsy();
  });

  test.skipIf(!hasGen)("ZAPDOS battles, and is gone for good once it is over", () => {
    const game = makeMenuGame();
    let fought: string | null = null;
    (game as any).startWildBattle = (sp: string, _l: number, _o: unknown, done: (r: string) => void) => {
      fought = sp;
      done("run");
    };
    game.overworld.setMap("POWER_PLANT", 4, 11, "up");
    game.overworld.showMapText("TEXT_POWERPLANT_ZAPDOS");
    drain(game);
    expect(fought).toBe("ZAPDOS");
    expect(game.save.flags.EVENT_BEAT_ZAPDOS).toBe(true);
    expect(game.save.objectToggles?.POWER_PLANT?.POWERPLANT_ZAPDOS).toBe(false);
  });

  test.skipIf(!hasGen)("a blackout against it leaves the bird there", () => {
    const game = makeMenuGame();
    (game as any).startWildBattle = (_s: string, _l: number, _o: unknown, done: (r: string) => void) => done("lose");
    game.overworld.setMap("SEAFOAM_ISLANDS_B4F", 6, 3, "up");
    game.overworld.showMapText("TEXT_SEAFOAMISLANDSB4F_ARTICUNO");
    drain(game);
    expect(game.save.flags.EVENT_BEAT_ARTICUNO).toBeFalsy();
  });

  test.skipIf(!hasGen)("the lobby resets the League after a run", () => {
    const game = makeMenuGame();
    const f = game.save.flags;
    f.EVENT_BEAT_LORELEIS_ROOM_TRAINER_0 = true;
    f.EVENT_BEAT_LANCES_ROOM_TRAINER_0 = true;
    f.EVENT_LANCES_ROOM_LOCK_DOOR = true;
    f.EVENT_BEAT_CHAMPION_RIVAL_THIS_RUN = true;
    f.EVENT_BEAT_CHAMPION_RIVAL = true;
    (game.save as any).defeatedTrainers = { LORELEIS_ROOM_obj_1: true, ROUTE_3_obj_2: true };
    game.overworld.setMap("INDIGO_PLATEAU_LOBBY", 7, 10, "up");
    expect(f.EVENT_BEAT_LORELEIS_ROOM_TRAINER_0).toBeFalsy();
    expect(f.EVENT_LANCES_ROOM_LOCK_DOOR).toBeFalsy();
    expect(f.EVENT_BEAT_CHAMPION_RIVAL_THIS_RUN).toBeFalsy();
    expect(f.EVENT_BEAT_CHAMPION_RIVAL).toBe(true); // the title stays
    expect((game.save as any).defeatedTrainers.LORELEIS_ROOM_obj_1).toBeUndefined();
    expect((game.save as any).defeatedTrainers.ROUTE_3_obj_2).toBe(true);
  });
});

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

  test.skipIf(!hasGen)("the guru and the gentleman give coins once too, each under its own event", () => {
    const ALL = ["TEXT_GAMECORNER_FISHING_GURU", "TEXT_GAMECORNER_CLERK2", "TEXT_GAMECORNER_GENTLEMAN"];
    const game = gcGame();
    // no case yet: "Oops!" from all three, and nothing given
    for (const key of ALL) {
      talkAt(game, "GAME_CORNER", key);
      expect(game.save.coins ?? 0, key).toBe(0);
    }
    game.save.inventory.COIN_CASE = 1;
    talkAt(game, "GAME_CORNER", "TEXT_GAMECORNER_FISHING_GURU");
    expect(game.save.coins).toBe(10);
    expect(game.save.flags.EVENT_GOT_10_COINS).toBe(true);
    talkAt(game, "GAME_CORNER", "TEXT_GAMECORNER_GENTLEMAN");
    expect(game.save.coins).toBe(30);
    expect(game.save.flags.EVENT_GOT_20_COINS).toBe(true);
    talkAt(game, "GAME_CORNER", "TEXT_GAMECORNER_CLERK2");
    expect(game.save.coins).toBe(50);
    expect(game.save.flags.EVENT_GOT_20_COINS_2).toBe(true);
    // asked again, each has an excuse and no coins
    for (const key of ALL) {
      talkAt(game, "GAME_CORNER", key);
      expect(game.save.coins, key).toBe(50);
    }
    // a case at Has9990Coins is turned down, and the gift kept for later
    const rich = gcGame();
    rich.save.inventory.COIN_CASE = 1;
    rich.save.coins = 9990;
    talkAt(rich, "GAME_CORNER", "TEXT_GAMECORNER_FISHING_GURU");
    expect(rich.save.coins).toBe(9990);
    expect(rich.save.flags.EVENT_GOT_10_COINS ?? false).toBe(false);
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
      const hooked = ["play", "playBattle", "playVictory", "playOnce", "startMap",
                      "restore", "playSfx"];
      for (const m of hooked) {
        const orig = audio[m].bind(audio);
        audio[m] = (...args: unknown[]) => {
          audio.__log.push(`${m}:${args[0] ?? ""}`);
          return orig(...args);
        };
      }
    }
    return audio.__log as string[];
  }

  test.skipIf(!hasGen)("the rival's encounter theme opens his scene", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    game.save.party.push(newMon(romData!, "SQUIRTLE", 20));
    const log = songLog(game);
    ow.setMap("SS_ANNE_2F", 37, 8, "up");
    log.length = 0;
    ow.onStepComplete();
    let guard = 0;
    while (game.stackKinds().at(-1) !== "textbox" && guard++ < 600) game.tick(0);
    // PlayTrainerMusic bails on the rival classes (home/trainers.asm:399), so
    // his own scene is the only thing that gives him a sting -- and it starts
    // as he walks up, before his line, not under the battle.
    expect(log[0]).toBe("playOnce:Music_MeetRival");
    expect(topText(game)).toContain("Bonjour");
  });

  test.skipIf(!hasGen)("a gift plays the item jingle, a key item its own", () => {
    const game = makeMenuGame();
    const ow = game.overworld as any;
    const log = songLog(game);
    ow.setMap("PALLET_TOWN", 5, 6, "down");

    const gift = (item: string): string[] => {
      log.length = 0;
      ow.runner.run([["give_item", item]]);
      for (let i = 0; i < 400; i++) {
        game.tick(0);
        dismissText(game);
        if (!ow.runner.isRunning()) break;
      }
      return [...log];
    };

    // sound_get_item_1 / sound_get_key_item (home/text.asm TextCommand_SOUND)
    expect(gift("POTION")).toContain("playSfx:Get_Item1");
    expect(gift("TOWN_MAP")).toContain("playSfx:Get_Key_Item");
    expect(game.save.inventory.POTION).toBe(1);
  });

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
    // On a COPY: `game.data` is the one dataset every test in this file
    // shares, and replacing its atlas outright left every later test
    // without picFront -- which is a mystery failure two thousand lines
    // away rather than a wrong answer here.
    (game as { data: unknown }).data = {
      ...(game.data as object),
      atlas: {
        ...(game.data as { atlas?: object }).atlas,
        townMapPage: 426,
        townMapCursorPage: 427,
      },
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
    (game as { data: unknown }).data = { ...(game.data as object), atlas: { townMapPage: null } };
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

describe("touching the battle panel", () => {
  /** A wild battle idling on its action menu, with a full moveset to aim at. */
  function battleOnMenu() {
    const game = makeMenuGame();
    // a new game has no party yet: give it one mon with four moves
    if (game.save.party.length === 0) {
      game.save.party.push(newMon(romData!, "SQUIRTLE", 5, game.battleRng));
    }
    const lead = game.save.party[0]!;
    lead.moves = [
      { id: "TACKLE", pp: 35 }, { id: "GROWL", pp: 40 },
      { id: "TAIL_WHIP", pp: 30 }, { id: "BUBBLE", pp: 30 },
    ];
    game.overworld.setMap("ROUTE_1", 5, 5, "down");
    game.pushStubBattle("PIDGEY", 3);
    // through the intro to the menu
    for (let t = 0; t < 4000; t++) {
      const b = (game.battleView() as any)?.battle;
      if (b?.phase === "menu") break;
      game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    }
    const b = (game.battleView() as any).battle;
    expect(b.phase).toBe("menu");
    return { game, b };
  }
  // the centre of a 2x2 cell (drawActionGrid / drawMoveSelect)
  const cell = (c: number, r: number) => ({ x: c * 160 + 80, y: r === 0 ? 80 : 190 });

  test.skipIf(!hasGen)("the down edge highlights, the up edge executes", () => {
    const { game, b } = battleOnMenu();
    // FIGHT is the resting cursor; touch RUN (bottom-right)
    gearTouchDown(game as never, cell(1, 1).x, cell(1, 1).y);
    expect(b.menuIndex).toBe(4);
    expect(b.phase).toBe("menu"); // nothing has run yet: only highlighted
    gearTouchUp(game as never);
    expect(b.phase).not.toBe("menu"); // now it has
  });

  test.skipIf(!hasGen)("a tap on a move picks THAT move, on the 2x2 grid it is drawn on", () => {
    const { game, b } = battleOnMenu();
    gearTouchDown(game as never, cell(0, 0).x, cell(0, 0).y); // FIGHT
    gearTouchUp(game as never);
    expect(b.phase).toBe("moveSelect");
    // bottom-left is the third move, not "row 13 of a list"
    gearTouchDown(game as never, cell(0, 1).x, cell(0, 1).y);
    expect(b.moveIndex).toBe(3);
    gearTouchDown(game as never, cell(1, 0).x, cell(1, 0).y);
    expect(b.moveIndex).toBe(2);
    gearTouchUp(game as never);
    expect(b.phase).toBe("messages");
    // the exchange plays out over the next frames; the move that ran is the
    // one the finger was on
    for (let t = 0; t < 600 && b.phase === "messages"; t++) {
      game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(b.messageLog.some((m: string) => m.includes("used GROWL"))).toBe(true);
  });

  test.skipIf(!hasGen)("an empty slot is not an option: neither edge does anything", () => {
    const { game, b } = battleOnMenu();
    const lead = game.save.party[0]!;
    lead.moves = [{ id: "TACKLE", pp: 35 }];
    b.player.curMoves = lead.moves;
    gearTouchDown(game as never, cell(0, 0).x, cell(0, 0).y);
    gearTouchUp(game as never);
    expect(b.phase).toBe("moveSelect");
    gearTouchDown(game as never, cell(1, 1).x, cell(1, 1).y); // no fourth move
    expect(b.moveIndex).toBe(1);
    gearTouchUp(game as never);
    expect(b.phase).toBe("moveSelect");
  });

  test.skipIf(!hasGen)("the party panel is 2x3, and a tap lands on the mon drawn there", () => {
    const { game, b } = battleOnMenu();
    while (game.save.party.length < 4) {
      game.save.party.push(newMon(romData!, "RATTATA", 5, game.battleRng));
    }
    gearTouchDown(game as never, cell(1, 0).x, cell(1, 0).y); // PKMN
    gearTouchUp(game as never);
    expect(b.phase).toBe("party");
    // drawPartyList: colX=[0,10], rowY=[2,7,12] -> the fourth mon is right
    // column, middle row (rows 7..11 -> y in 93..159)
    gearTouchDown(game as never, 240, 130);
    expect(b.partyIndex).toBe(3);
    // and the right column, bottom row is nobody: the cursor stays
    gearTouchDown(game as never, 240, 200);
    expect(b.partyIndex).toBe(3);
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

  test.skipIf(!hasGen)("the screen scrolls so the selected row is always on it", () => {
    const game = makeMenuGame();
    tap(game, VOX_BTN.start);
    const sm = game.startMenu() as { entries: string[] };
    pick(game, sm.entries.indexOf("OPTION"));
    const view = () => game.optionsMenu() as { rows: unknown[]; index: number; first: number; visible: number };
    const n = view().rows.length + 1; // + CANCEL
    expect(n).toBeGreaterThan(view().visible);
    for (let i = 0; i < n; i++) {
      const v = view();
      expect(v.index).toBe(i);
      expect(v.index - v.first).toBeGreaterThanOrEqual(0);
      expect(v.index - v.first).toBeLessThan(v.visible);
      tap(game, VOX_BTN.down);
    }
    // wrapped to the top: the window came back with it
    expect(view().index).toBe(0);
    expect(view().first).toBe(0);
    tap(game, VOX_BTN.up); // CANCEL again, from above
    expect(view().index).toBe(n - 1);
    expect(view().first).toBe(n - view().visible);
  });

  test.skipIf(!hasGen)("DEV MENU turned on in OPTION shows DEV on the pause menu underneath", () => {
    const game = makeMenuGame();
    tap(game, VOX_BTN.start);
    expect((game.startMenu() as { entries: string[] }).entries).not.toContain("DEV");
    pick(game, (game.startMenu() as { entries: string[] }).entries.indexOf("OPTION"));
    const rows = (game.optionsMenu() as { rows: { label: string }[] }).rows;
    const dev = rows.findIndex((r) => r.label === "DEV MENU");
    for (let i = 0; i < dev; i++) tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.right);
    expect(game.save.options.devMenu).toBe(true);
    tap(game, VOX_BTN.b); // back to the pause menu still open beneath
    expect(game.stackKinds().at(-1)).toBe("startmenu");
    game.tick(0);
    expect((game.startMenu() as { entries: string[] }).entries).toContain("DEV");
  });

  test.skipIf(!hasGen)("CANCEL closes back to the start menu", () => {
    const game = makeMenuGame();
    tap(game, VOX_BTN.start);
    const sm = game.startMenu() as { entries: string[] };
    pick(game, sm.entries.indexOf("OPTION"));
    // CANCEL sits under every row there is, however many that is today
    const rows = (game.optionsMenu() as { rows: unknown[] }).rows.length;
    for (let i = 0; i < rows; i++) tap(game, VOX_BTN.down);
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

  test.skipIf(!hasGen)("a chopped tree is back after leaving and coming back", () => {
    // pokered keeps no record of a cut: the next map load has the tree
    // standing again. (This port used to keep it cut in the save.)
    const { game, host } = cutGame();
    const at = cuttable(game, "VIRIDIAN_CITY");
    if (!at) return; // this build cooked no cuttable cells here
    const [cx, cy] = at;
    const index = game.overworld.map.def.index;

    // chop it the way use_cut does
    game.overworld.map.markCut(cx, cy);
    game.overworld.stamp(index, cx, cy, false);
    game.overworld.cutThisVisit.add(`${index},${cx},${cy}`);
    expect(game.overworld.map.isCuttableCell(cx, cy)).toBe(false);

    // leave: the geometry is put back as the map goes
    host.stamps.length = 0;
    game.overworld.setMap("PALLET_TOWN", 5, 6, "down");
    expect(host.stamps).toContainEqual([index, cx, cy, 1]);
    expect(game.overworld.cutThisVisit.size).toBe(0);

    // and come back: nothing hides it, and it can be cut again
    host.stamps.length = 0;
    game.overworld.setMap("VIRIDIAN_CITY", 4, 4, "down");
    expect(host.stamps).not.toContainEqual([index, cx, cy, 0]);
    expect(game.overworld.map.isCuttableCell(cx, cy)).toBe(true);
  });

  test.skipIf(!hasGen)("a cut is not written into the save", () => {
    const { game } = cutGame();
    const at = cuttable(game, "VIRIDIAN_CITY");
    if (!at) return;
    const [cx, cy] = at;
    const ow = game.overworld;
    ow.setMap("VIRIDIAN_CITY", cx, cy + 1, "up");
    ow.runScript([["use_cut", "BULBASAUR"]]);
    for (let t = 0; t < 400; t++) game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    expect(ow.cutThisVisit.has(`${ow.map.def.index},${cx},${cy}`)).toBe(true);
    const back = decodeSave(encodeSave(game.save as never)) as { cutTrees?: unknown };
    expect(back.cutTrees).toBeUndefined();
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

describe("HM04 STRENGTH", () => {
  const MAP = "VICTORY_ROAD_1F";

  function strGame(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []),
        MAP,
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    return game;
  }

  function boulders(game: VoxelmonGame): any[] {
    return game.overworld.npcs.filter((n: any) =>
      String(n.def?.sprite ?? "").includes("BOULDER"));
  }

  /**
   * Put the player next to a boulder that has somewhere to go, facing it.
   * Returns the boulder and the direction of the shove.
   */
  function atBoulder(
    game: VoxelmonGame,
  ): { b: any; dir: Dir; to: [number, number] } | null {
    const ow = game.overworld;
    ow.setMap(MAP, 1, 1, "down");
    const DIRS: [Dir, number, number][] = [
      ["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0],
    ];
    for (const b of boulders(game)) {
      for (const [dir, dx, dy] of DIRS) {
        const fromX = b.cellX - dx;
        const fromY = b.cellY - dy;
        const toX = b.cellX + dx;
        const toY = b.cellY + dy;
        if (!ow.map.inBounds(fromX, fromY) || !ow.map.inBounds(toX, toY)) continue;
        if (!ow.map.isWalkableCell(fromX, fromY)) continue;
        if (!ow.map.isWalkableCell(toX, toY) || ow.map.isWaterCell(toX, toY)) continue;
        if (boulders(game).some((o) => o.cellX === toX && o.cellY === toY)) continue;
        ow.setMap(MAP, fromX, fromY, dir);
        const live = boulders(game).find((o) => o.cellX === b.cellX && o.cellY === b.cellY);
        if (live) return { b: live, dir, to: [toX, toY] };
      }
    }
    return null;
  }

  /**
   * Hold the direction for exactly ONE step, then let go. Holding it down
   * keeps pushing: a 120-frame hold walks seven cells, which tests nothing
   * about the first shove.
   */
  function settle(game: VoxelmonGame, dir: Dir): void {
    const mask = { up: VOX_BTN.up, down: VOX_BTN.down, left: VOX_BTN.left, right: VOX_BTN.right }[dir];
    const ow = game.overworld;
    const x0 = ow.player.cellX;
    const y0 = ow.player.cellY;
    for (let i = 0; i < 200; i++) {
      game.tick(mask);
      if (ow.player.cellX !== x0 || ow.player.cellY !== y0) break;
    }
    for (let i = 0; i < 60; i++) game.tick(0);
  }

  test.skipIf(!hasGen)("the maps really do carry boulders", () => {
    const game = strGame();
    game.overworld.setMap(MAP, 1, 1, "down");
    expect(boulders(game).length).toBeGreaterThan(0);
  });

  test.skipIf(!hasGen)("without STRENGTH a boulder is just a wall", () => {
    const found = (() => { const g = strGame(); const a = atBoulder(g); return a && { g, a }; })();
    if (!found) return;
    const { g: game, a } = found;
    const ow = game.overworld;
    const was = [a.b.cellX, a.b.cellY];
    const me = [ow.player.cellX, ow.player.cellY];
    expect(ow.checkBoulderPush(a.dir)).toBe(false);
    settle(game, a.dir);
    expect([a.b.cellX, a.b.cellY]).toEqual(was);
    expect([ow.player.cellX, ow.player.cellY]).toEqual(me);
  });

  test.skipIf(!hasGen)("with STRENGTH, walking into it shoves it and you follow", () => {
    const found = (() => { const g = strGame(); const a = atBoulder(g); return a && { g, a }; })();
    if (!found) return;
    const { g: game, a } = found;
    const ow = game.overworld;
    (game.save as any).strengthActive = true;
    const bWas = [a.b.cellX, a.b.cellY];
    const pWas = [ow.player.cellX, ow.player.cellY];
    settle(game, a.dir);
    // the boulder moved one cell, and the player took its old place
    expect([a.b.cellX, a.b.cellY]).not.toEqual(bWas);
    expect([ow.player.cellX, ow.player.cellY]).toEqual(bWas);
    expect([ow.player.cellX, ow.player.cellY]).not.toEqual(pWas);
  });

  test.skipIf(!hasGen)("the shove moves BOTH, in the same beat", () => {
    // Moving only the boulder looks almost right -- the next poll walks the
    // player into the space anyway -- so check they are queued together.
    const found = (() => { const g = strGame(); const a = atBoulder(g); return a && { g, a }; })();
    if (!found) return;
    const { g: game, a } = found;
    const ow = game.overworld;
    (game.save as any).strengthActive = true;
    expect(ow.checkBoulderPush(a.dir)).toBe(true);
    const moving = ow.scriptMoves.map((m: any) => m.entity);
    expect(moving).toContain(a.b);
    expect(moving).toContain(ow.player);
    expect(moving.length).toBe(2);
  });

  test.skipIf(!hasGen)("a boulder against a wall does not budge", () => {
    // Push it as far as it goes, and the last shove has to be refused.
    const found = (() => { const g = strGame(); const a = atBoulder(g); return a && { g, a }; })();
    if (!found) return;
    const { g: game, a } = found;
    const ow = game.overworld;
    (game.save as any).strengthActive = true;
    let pushes = 0;
    while (ow.checkBoulderPush(a.dir) && pushes < 40) {
      pushes += 1;
      for (let i = 0; i < 200; i++) {
        game.tick(0);
        if (ow.scriptMoves.length === 0) break;
      }
      ow.player.facing = a.dir;
      // the boulder never ends up INSIDE anything -- "it stopped eventually"
      // is also true of one that ploughed through the wall to the map edge
      expect(ow.map.isWalkableCell(a.b.cellX, a.b.cellY), `push ${pushes}`).toBe(true);
    }
    expect(pushes).toBeGreaterThan(0);
    // it ran out of room rather than out of patience
    expect(pushes).toBeLessThan(40);
    const [tx, ty] = [
      a.b.cellX + (a.dir === "left" ? -1 : a.dir === "right" ? 1 : 0),
      a.b.cellY + (a.dir === "up" ? -1 : a.dir === "down" ? 1 : 0),
    ];
    const blocked =
      !ow.map.inBounds(tx, ty) || !ow.map.isWalkableCell(tx, ty) ||
      boulders(game).some((o: any) => o !== a.b && o.cellX === tx && o.cellY === ty);
    expect(blocked).toBe(true);
  });

  test.skipIf(!hasGen)("a boulder will not go through another boulder", () => {
    const found = (() => { const g = strGame(); const a = atBoulder(g); return a && { g, a }; })();
    if (!found) return;
    const { g: game, a } = found;
    const ow = game.overworld;
    (game.save as any).strengthActive = true;
    const other = boulders(game).find((o: any) => o !== a.b);
    if (!other) return;
    // park the second one exactly where the first is headed
    other.cellX = a.to[0];
    other.cellY = a.to[1];
    other.targetX = undefined;
    other.targetY = undefined;
    expect(ow.checkBoulderPush(a.dir)).toBe(false);
  });

  test.skipIf(!hasGen)("an ordinary person is not a boulder", () => {
    // isBoulder reads the sprite; without that check STRENGTH would shove
    // trainers and shopkeepers around the map.
    const game = strGame();
    const ow = game.overworld;
    (game.save as any).strengthActive = true;
    ow.setMap(MAP, 1, 1, "down");
    const person = ow.npcs.find((n: any) =>
      !String(n.def?.sprite ?? "").includes("BOULDER"));
    if (!person) return;
    const DIRS: [Dir, number, number][] = [
      ["up", 0, 1], ["down", 0, -1], ["left", 1, 0], ["right", -1, 0],
    ];
    for (const [dir, dx, dy] of DIRS) {
      const fx = person.cellX + dx;
      const fy = person.cellY + dy;
      if (!ow.map.inBounds(fx, fy) || !ow.map.isWalkableCell(fx, fy)) continue;
      ow.setMap(MAP, fx, fy, dir);
      expect(ow.checkBoulderPush(dir)).toBe(false);
      return;
    }
  });

  test.skipIf(!hasGen)("STRENGTH from the party menu is what switches it on", () => {
    const game = strGame();
    const ow = game.overworld;
    ow.setMap(MAP, 1, 1, "down");
    expect((game.save as any).strengthActive ?? false).toBe(false);
    ow.runScript([["use_strength", "MACHOKE"]]);
    for (let i = 0; i < 600; i++) {
      if (game.stackKinds().at(-1) === "textbox") dismissText(game);
      else game.tick(0);
    }
    expect((game.save as any).strengthActive).toBe(true);
  });

  test.skipIf(!hasGen)("and it says so, using the mon's name", () => {
    const game = strGame();
    const ow = game.overworld;
    ow.setMap(MAP, 1, 1, "down");
    ow.runScript([["use_strength", "MACHOKE"]]);
    let guard = 0;
    while (game.stackKinds().at(-1) !== "textbox" && guard++ < 400) game.tick(0);
    expect(topText(game)).toContain("MACHOKE");
    expect(topText(game)).toContain("STRENGTH");
  });

  test.skipIf(!hasGen)("it stays on across a map change", () => {
    const game = strGame();
    const ow = game.overworld;
    ow.setMap(MAP, 1, 1, "down");
    ow.runScript([["use_strength", "MACHOKE"]]);
    for (let i = 0; i < 600; i++) {
      if (game.stackKinds().at(-1) === "textbox") dismissText(game);
      else game.tick(0);
    }
    ow.setMap("PALLET_TOWN", 5, 6, "down");
    ow.setMap(MAP, 1, 1, "down");
    expect((game.save as any).strengthActive).toBe(true);
  });

  test.skipIf(!hasGen)("the party menu offers STRENGTH, and it dispatches the right verb", () => {
    const game = strGame();
    const mon: any = newMon(romData!, "MACHOKE", 40);
    mon.moves = [{ id: "STRENGTH", pp: 15 }];
    game.save.party.push(mon);
    tap(game, VOX_BTN.start);
    let guard = 0;
    while (game.stackKinds().at(-1) !== "party" && guard++ < 40) tap(game, VOX_BTN.a);
    tap(game, VOX_BTN.a);
    const items = (game.party() as any).submenuItems as string[];
    expect(items).toContain("STRENGTH");
    for (let i = 0; i < items.indexOf("STRENGTH"); i++) tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.a);
    for (let i = 0; i < 600; i++) {
      if (game.stackKinds().at(-1) === "textbox") dismissText(game);
      else game.tick(0);
    }
    // use_strength is the only field verb that sets this
    expect((game.save as any).strengthActive).toBe(true);
  });
});

describe("the Route 23 badge checks", () => {
  const ALL_BADGES = [
    "BOULDERBADGE", "CASCADEBADGE", "THUNDERBADGE", "RAINBOWBADGE",
    "SOULBADGE", "MARSHBADGE", "VOLCANOBADGE", "EARTHBADGE",
  ];

  function r23Game(badges: string[] = []): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []), "ROUTE_23",
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    for (const b of badges) Bag.add(game.save, b, 1);
    return game;
  }

  const guards = () =>
    ((romData as any).field?.badgeGates?.ROUTE_23?.guards ?? []) as any[];

  /** Step onto a guard's row and let whatever happens, happen. */
  function stepOnto(game: VoxelmonGame, g: any): void {
    const ow = game.overworld;
    ow.setMap("ROUTE_23", g.maxX !== undefined ? g.maxX : 9, g.y, "up");
    ow.onStepComplete();
    for (let i = 0; i < 60; i++) {
      if (game.stackKinds().at(-1) === "textbox") break;
      game.tick(0);
    }
  }

  test.skipIf(!hasGen)("all eight gyms are wanted between here and the League", () => {
    // Seven guards on the road, plus the Route 22 gate for the eighth. With
    // none of them read, the League was a stroll from the first afternoon.
    const gs = guards();
    expect(gs.length).toBe(7);
    const wanted = gs.map((g) => g.badge);
    expect(new Set(wanted).size).toBe(7);
    for (const b of wanted) expect(ALL_BADGES).toContain(b);
    // each has its own once-only event
    expect(new Set(gs.map((g) => g.event)).size).toBe(7);
    // the road runs north, so the rows descend as the badges get later
    const byRow = [...gs].sort((a, b) => b.y - a.y).map((g) => g.badge);
    expect(byRow[0]).toBe("CASCADEBADGE");
    expect(byRow.at(-1)).toBe("EARTHBADGE");
  });

  test.skipIf(!hasGen)("without the badge you are stopped and moved back", () => {
    for (const g of guards()) {
      const game = r23Game();
      const ow = game.overworld;
      stepOnto(game, g);
      expect(game.stackKinds().at(-1), g.badge).toBe("textbox");
      expect(topText(game), g.badge).toContain(g.badge);
      expect(game.save.flags[g.event] ?? false, g.badge).toBe(false);
      // and shoved back south, away from the League
      dismissText(game);
      for (let i = 0; i < 200; i++) game.tick(0);
      expect(ow.player.cellY, g.badge).toBeGreaterThan(g.y);
    }
  });

  test.skipIf(!hasGen)("with the badge they step aside, for good", () => {
    for (const g of guards()) {
      const game = r23Game([g.badge]);
      const ow = game.overworld;
      stepOnto(game, g);
      expect(topText(game), g.badge).toContain(g.badge);
      expect(game.save.flags[g.event], g.badge).toBe(true);
      dismissText(game);
      for (let i = 0; i < 200; i++) game.tick(0);
      // not pushed back
      expect(ow.player.cellY, g.badge).toBe(g.y);

      // and walking the row again says nothing
      ow.onStepComplete();
      for (let i = 0; i < 60; i++) game.tick(0);
      expect(game.stackKinds(), g.badge).toEqual(["overworld"]);
    }
  });

  test.skipIf(!hasGen)("one badge does not satisfy another guard", () => {
    const [first, second] = guards();
    const game = r23Game([first.badge]);
    stepOnto(game, second);
    expect(topText(game)).toContain(second.badge);
    expect(game.save.flags[second.event] ?? false).toBe(false);
  });

  test.skipIf(!hasGen)("a full set walks the whole road", () => {
    const game = r23Game(ALL_BADGES);
    const ow = game.overworld;
    for (const g of guards()) {
      stepOnto(game, g);
      dismissText(game);
      for (let i = 0; i < 200; i++) game.tick(0);
      expect(game.save.flags[g.event], g.badge).toBe(true);
      expect(ow.player.cellY, g.badge).toBe(g.y);
    }
  });

  test.skipIf(!hasGen)("the first check only covers its half of the road", () => {
    // That guard carries a maxX; past it the row is open.
    const g = guards().find((x: any) => x.maxX !== undefined);
    expect(g).toBeTruthy();
    const game = r23Game();
    const ow = game.overworld;
    ow.setMap("ROUTE_23", g.maxX + 3, g.y, "up");
    ow.onStepComplete();
    for (let i = 0; i < 60; i++) game.tick(0);
    expect(game.stackKinds()).toEqual(["overworld"]);
  });

  test.skipIf(!hasGen)("an ordinary row on the same road is not a checkpoint", () => {
    const rows = new Set(guards().map((g: any) => g.y));
    const game = r23Game();
    const ow = game.overworld;
    ow.setMap("ROUTE_23", 9, 20, "up"); // load it before asking about its cells
    let free = 0;
    for (let y = 20; y < 140 && free < 3; y += 7) {
      if (rows.has(y)) continue;
      // the road is not walkable at every x, so find a cell rather than
      // assuming the middle of it is open
      let x = -1;
      for (let i = 0; i < ow.map.widthCells; i++) {
        if (ow.map.isWalkableCell(i, y)) { x = i; break; }
      }
      if (x < 0) continue;
      ow.setMap("ROUTE_23", x, y, "up");
      ow.onStepComplete();
      for (let i = 0; i < 40; i++) game.tick(0);
      expect(game.stackKinds(), `row ${y}`).toEqual(["overworld"]);
      free += 1;
    }
    expect(free).toBeGreaterThan(0);
  });
});

describe("Victory Road's boulder switches", () => {
  const FLOORS = ["VICTORY_ROAD_1F", "VICTORY_ROAD_2F", "VICTORY_ROAD_3F"];

  function vrGame(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []), ...FLOORS,
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    (game.save as any).strengthActive = true;
    return game;
  }

  function blockAt(game: VoxelmonGame, bx: number, by: number): number {
    const def = game.overworld.map.def as { blocks: number[]; width: number };
    return def.blocks[by * def.width + bx]!;
  }

  function walkableCells(game: VoxelmonGame, b: { bx: number; by: number }): number {
    let n = 0;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        if (game.overworld.map.isWalkableCell(b.bx * 2 + dx, b.by * 2 + dy)) n += 1;
      }
    }
    return n;
  }

  test.skipIf(!hasGen)("every barrier ships shut, and the shipped ids are the ones we act on", () => {
    const game = vrGame();
    for (const map of FLOORS) {
      game.overworld.setMap(map, 1, 1, "down");
      for (const b of barriersFor(map)) {
        expect(blockAt(game, b.bx, b.by), `${map} ${b.bx},${b.by}`).toBe(b.closed);
      }
    }
  });

  test.skipIf(!hasGen)("the flag opens it, and it opens only PARTLY", () => {
    // $25 -> $1d frees one more cell and leaves the rest wall. Hiding the
    // whole lifted block would take the wall with it.
    const game = vrGame();
    for (const map of FLOORS) {
      for (const b of barriersFor(map)) {
        const shut = vrGame();
        shut.overworld.setMap(map, 1, 1, "down");
        const before = walkableCells(shut, b);

        const open = vrGame();
        open.save.flags[b.flag] = true;
        open.overworld.setMap(map, 1, 1, "down");
        expect(blockAt(open, b.bx, b.by), `${map} ${b.flag}`).toBe(b.open);
        const after = walkableCells(open, b);
        expect(after, `${map} ${b.flag}`).toBeGreaterThan(before);
        // $37 -> $15 is the only one that opens the whole block
        if (b.closed !== 0x37) expect(after, `${map} ${b.flag}`).toBeLessThan(4);
      }
      void game;
    }
  });

  test.skipIf(!hasGen)("a boulder coming to rest on a switch opens its barrier", () => {
    const game = vrGame();
    const ow = game.overworld;
    const b = barriersFor("VICTORY_ROAD_3F")[0]!;
    ow.setMap("VICTORY_ROAD_3F", 1, 1, "down");
    expect(walkableCells(game, b)).toBeLessThan(4);

    // put a boulder on the switch cell and tell the world it landed
    const boulder = ow.npcs.find((n: any) =>
      String(n.def?.sprite ?? "").includes("BOULDER"));
    expect(boulder).toBeTruthy();
    boulder.cellX = b.switchX;
    boulder.cellY = b.switchY;
    (ow as any).boulderLanded();

    expect(game.save.flags[b.flag]).toBe(true);
    expect(blockAt(game, b.bx, b.by)).toBe(b.open);
  });

  test.skipIf(!hasGen)("a boulder anywhere else does nothing", () => {
    const game = vrGame();
    const ow = game.overworld;
    const b = barriersFor("VICTORY_ROAD_3F")[0]!;
    ow.setMap("VICTORY_ROAD_3F", 1, 1, "down");
    const boulder = ow.npcs.find((n: any) =>
      String(n.def?.sprite ?? "").includes("BOULDER"));
    boulder.cellX = b.switchX + 2;
    boulder.cellY = b.switchY + 2;
    (ow as any).boulderLanded();
    expect(game.save.flags[b.flag] ?? false).toBe(false);
    expect(blockAt(game, b.bx, b.by)).toBe(b.closed);
  });

  test.skipIf(!hasGen)("the 3F hole drops a boulder to 2F, and you after it", () => {
    const game = vrGame();
    const ow = game.overworld;
    const h = ROAD_HOLES[0]!;
    const below = () => ow.npcs.some((n: any) => n.def?.name === h.toBoulder && !n.hidden);
    const above = () => ow.npcs.some((n: any) => n.def?.name === h.boulder && !n.hidden);
    // 2F's third boulder is not there until one falls
    ow.setMap("VICTORY_ROAD_2F", 1, 1, "down");
    expect(below()).toBe(false);

    ow.setMap("VICTORY_ROAD_3F", 1, 1, "down");
    expect(above()).toBe(true);
    const boulder = ow.npcs.find((n: any) => n.def?.name === h.boulder) as any;
    boulder.cellX = h.x;
    boulder.cellY = h.y;
    (ow as any).boulderLanded();
    expect(game.save.flags[h.flag]).toBe(true);
    expect(above()).toBe(false);
    ow.setMap("VICTORY_ROAD_2F", 1, 1, "down");
    expect(below()).toBe(true);

    // the player follows it down
    ow.setMap("VICTORY_ROAD_3F", h.x, h.y, "down");
    ow.onStepComplete();
    for (let i = 0; i < 200; i++) game.tick(0);
    expect(ow.map.id).toBe(h.toMap);
    expect([ow.player.cellX, ow.player.cellY]).toEqual([h.dx, h.dy]);

    // Route 23 puts the whole puzzle back behind you
    game.save.flags.EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH1 = true;
    ow.setMap("ROUTE_23", 9, 5, "down");
    expect(game.save.flags[h.flag]).toBe(false);
    expect(game.save.flags.EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH1).toBe(false);
    ow.setMap("VICTORY_ROAD_2F", 1, 1, "down");
    expect(below()).toBe(false);
    ow.setMap("VICTORY_ROAD_3F", 1, 1, "down");
    expect(above()).toBe(true);
  });

  test.skipIf(!hasGen)("2F's two switches are separate barriers", () => {
    const game = vrGame();
    const [one, two] = barriersFor("VICTORY_ROAD_2F");
    game.save.flags[one!.flag] = true;
    game.overworld.setMap("VICTORY_ROAD_2F", 1, 1, "down");
    expect(blockAt(game, one!.bx, one!.by)).toBe(one!.open);
    expect(blockAt(game, two!.bx, two!.by)).toBe(two!.closed);
  });

  test.skipIf(!hasGen)("walking onto 2F resets 1F's switch, as the original does", () => {
    // VictoryRoad2FResetBoulderEventScript. Without it 1F's barrier stays
    // open for the rest of the run and the puzzle is solved once, forever.
    const game = vrGame();
    game.save.flags.EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH = true;
    game.overworld.setMap("VICTORY_ROAD_2F", 1, 1, "down");
    expect(game.save.flags.EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH).toBe(false);
    // and 1F is shut again when you climb back down
    const b = barriersFor("VICTORY_ROAD_1F")[0]!;
    game.overworld.setMap("VICTORY_ROAD_1F", 1, 1, "down");
    expect(blockAt(game, b.bx, b.by)).toBe(b.closed);
  });

  test.skipIf(!hasGen)("the barrier stays open across a re-entry of its own floor", () => {
    const game = vrGame();
    const b = barriersFor("VICTORY_ROAD_3F")[0]!;
    game.save.flags[b.flag] = true;
    game.overworld.setMap("VICTORY_ROAD_3F", 1, 1, "down");
    game.overworld.setMap("VICTORY_ROAD_2F", 1, 1, "down");
    game.overworld.setMap("VICTORY_ROAD_3F", 1, 1, "down");
    expect(blockAt(game, b.bx, b.by)).toBe(b.open);
  });

  test("the cook is told about exactly the barrier blocks", () => {
    for (const map of FLOORS) {
      expect(toggleBlocksFor(map).map((t) => [t.bx, t.by, t.solid]))
        .toEqual(barriersFor(map).map((b) => [b.bx, b.by, b.closed]));
    }
    // four barriers, four distinct flags
    const all = FLOORS.flatMap((m) => barriersFor(m));
    expect(all.length).toBe(4);
    expect(new Set(all.map((b) => b.flag)).size).toBe(4);
  });
});

describe("the sleeping Snorlax", () => {
  function snorGame(map: string): { game: VoxelmonGame; npc: any } {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []), map,
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    game.save.party.push(newMon(romData!, "SQUIRTLE", 40));
    Bag.add(game.save, "POKE_FLUTE", 1);
    const spot = spotFor(map)!;
    game.overworld.setMap(map, 1, 1, "down");
    const npc = game.overworld.npcs.find((n: any) => n.def?.name === spot.object);
    return { game, npc };
  }

  /** Stand on the cell the player reaches it from, facing it. */
  function standBeside(game: VoxelmonGame, map: string, npc: any): void {
    const ow = game.overworld;
    for (const [dir, dx, dy] of [
      ["up", 0, 1], ["down", 0, -1], ["left", 1, 0], ["right", -1, 0],
    ] as [Dir, number, number][]) {
      const x = npc.cellX + dx;
      const y = npc.cellY + dy;
      if (ow.map.inBounds(x, y) && ow.map.isWalkableCell(x, y)) {
        ow.setMap(map, x, y, dir);
        return;
      }
    }
    throw new Error("nowhere to stand");
  }

  function playFlute(game: VoxelmonGame): void {
    game.useKeyItem("POKE_FLUTE");
    for (let i = 0; i < 200; i++) {
      if (game.stackKinds().at(-1) === "textbox") dismissText(game);
      else break;
    }
  }

  test.skipIf(!hasGen)("blocks the only way past until it moves", () => {
    // Both land routes to Fuchsia run through one of these, and the sea route
    // needs SURF, which is handed out in Fuchsia. A Snorlax that never moves
    // is the whole game.
    for (const spot of SNORLAX) {
      const { game, npc } = snorGame(spot.map);
      expect(npc, spot.map).toBeTruthy();
      const ow = game.overworld;
      standBeside(game, spot.map, npc);
      const [fx, fy] = ow.player.facingCell();
      expect([fx, fy], spot.map).toEqual([npc.cellX, npc.cellY]);
      // walking into it gets nowhere
      const was = [ow.player.cellX, ow.player.cellY];
      for (let i = 0; i < 120; i++) game.tick(VOX_BTN[ow.player.facing as "up"] ?? 0);
      expect([ow.player.cellX, ow.player.cellY], spot.map).toEqual(was);
    }
  });

  test.skipIf(!hasGen)("talking to it only ever says it is asleep", () => {
    const { game, npc } = snorGame("ROUTE_12");
    standBeside(game, "ROUTE_12", npc);
    game.overworld.showMapText("TEXT_ROUTE12_SNORLAX");
    let guard = 0;
    while (game.stackKinds().at(-1) !== "textbox" && guard++ < 200) game.tick(0);
    expect(topText(game)).toContain("sleeping");
    // and it is still there, flute in the bag or not
    expect(game.save.flags.EVENT_BEAT_ROUTE12_SNORLAX ?? false).toBe(false);
  });

  test.skipIf(!hasGen)("the flute wakes it, and it is gone before the battle", () => {
    for (const spot of SNORLAX) {
      const { game, npc } = snorGame(spot.map);
      standBeside(game, spot.map, npc);
      playFlute(game);
      // hidden BEFORE the fight, so a blackout still clears the road
      expect(game.save.objectToggles?.[spot.map]?.[spot.object], spot.map).toBe(false);
      expect(game.stackKinds().at(-1), spot.map).toBe("battle");
      const b = (game.battleView() as any).battle;
      expect(b.enemy.mon.species, spot.map).toBe("SNORLAX");
      expect(b.enemy.mon.level, spot.map).toBe(SNORLAX_LEVEL);
    }
  });

  test.skipIf(!hasGen)("and the road is open afterwards", () => {
    // The point of the whole thing: the cell it sat on is walkable.
    const spot = SNORLAX[0]!;
    const { game, npc } = snorGame(spot.map);
    const at = [npc.cellX, npc.cellY];
    standBeside(game, spot.map, npc);
    playFlute(game);
    game.save.flags[spot.beatFlag] = true;
    game.closeToOverworld();
    game.overworld.setMap(spot.map, 1, 1, "down");
    const still = game.overworld.npcs.some((n: any) => n.def?.name === spot.object);
    expect(still).toBe(false);
    expect(game.overworld.map.isWalkableCell(at[0], at[1])).toBe(true);
  });

  test.skipIf(!hasGen)("playing it anywhere else is just a tune", () => {
    const { game } = snorGame("ROUTE_12");
    game.overworld.setMap("PALLET_TOWN", 5, 6, "down");
    playFlute(game);
    expect(game.stackKinds()).toEqual(["overworld"]);
    expect(game.save.flags.EVENT_BEAT_ROUTE12_SNORLAX ?? false).toBe(false);
  });

  test.skipIf(!hasGen)("standing a cell too far does nothing", () => {
    const { game, npc } = snorGame("ROUTE_12");
    const ow = game.overworld;
    ow.setMap("ROUTE_12", npc.cellX, npc.cellY - 2, "down");
    playFlute(game);
    expect(ow.npcs.some((n: any) => n.def?.name === "ROUTE12_SNORLAX")).toBe(true);
    expect(game.save.flags.EVENT_BEAT_ROUTE12_SNORLAX ?? false).toBe(false);
  });

  test.skipIf(!hasGen)("a beaten one is not re-fought", () => {
    const { game, npc } = snorGame("ROUTE_12");
    game.save.flags.EVENT_BEAT_ROUTE12_SNORLAX = true;
    standBeside(game, "ROUTE_12", npc);
    playFlute(game);
    expect(game.stackKinds().at(-1)).not.toBe("battle");
  });

  test.skipIf(!hasGen)("a save with the flag set but the sleeper on screen is repaired", () => {
    // That state is a dead end -- the flute refuses a Snorlax whose flag is
    // set, so without this the route stays sealed for good.
    const { game } = snorGame("ROUTE_12");
    game.save.flags.EVENT_BEAT_ROUTE12_SNORLAX = true;
    (game.save.objectToggles ??= {}).ROUTE_12 = { ROUTE12_SNORLAX: true };
    game.overworld.setMap("ROUTE_12", 1, 1, "down");
    expect(game.overworld.npcs.some((n: any) => n.def?.name === "ROUTE12_SNORLAX")).toBe(false);
  });

  test("each route has its own lines, and they all exist in the ROM", () => {
    expect(SNORLAX.length).toBe(2);
    const text = (romData as any)?.text ?? {};
    for (const s of SNORLAX) {
      for (const k of [s.sleepText, s.wokeText, s.leftText]) {
        expect(text[k], `${s.map} ${k}`).toBeTruthy();
      }
    }
    // the two routes do not share a parting line -- one calms down, the
    // other returns to the mountains
    expect(SNORLAX[0]!.leftText).not.toBe(SNORLAX[1]!.leftText);
  });
});

describe("HM02 FLY", () => {
  function flyGame(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []),
        "ROUTE_16_FLY_HOUSE",
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    return game;
  }

  const field = () => (romData as any).field;

  test.skipIf(!hasGen)("the Route 16 girl is the only source, and gives it once", () => {
    // Nothing gave HM02 before this, so FLY could not be obtained at all.
    const game = flyGame();
    game.overworld.setMap("ROUTE_16_FLY_HOUSE", 4, 5, "up");
    game.overworld.showMapText("TEXT_ROUTE16FLYHOUSE_BRUNETTE_GIRL");
    let guard = 0;
    while (game.stackKinds().length > 1 && guard++ < 900) dismissText(game);
    expect(game.save.inventory.HM_FLY).toBe(1);
    expect(game.save.flags.EVENT_GOT_HM02).toBe(true);

    game.overworld.showMapText("TEXT_ROUTE16FLYHOUSE_BRUNETTE_GIRL");
    guard = 0;
    while (game.stackKinds().length > 1 && guard++ < 900) dismissText(game);
    expect(game.save.inventory.HM_FLY).toBe(1);
  });

  test.skipIf(!hasGen)("a town has to be visited before you can fly to it", () => {
    const save: any = {};
    expect(flyDestinations(field(), save)).toEqual([]);
    visit(save, "PEWTER_CITY");
    expect(flyDestinations(field(), save).map((d: any) => d.map)).toEqual(["PEWTER_CITY"]);
  });

  test.skipIf(!hasGen)("arriving in a town is what records it", () => {
    const game = flyGame();
    // a new game starts in the bedroom, so nothing is on the list yet
    expect(game.save.visited?.PALLET_TOWN ?? false).toBe(false);
    game.overworld.setMap("PALLET_TOWN", 5, 6, "down");
    expect(game.save.visited?.PALLET_TOWN).toBe(true);
    expect(game.save.visited?.CELADON_CITY ?? false).toBe(false);
    game.overworld.setMap("CELADON_CITY", 20, 20, "down");
    expect(game.save.visited?.CELADON_CITY).toBe(true);
  });

  test.skipIf(!hasGen)("walking through a route does not put it on the list", () => {
    const game = flyGame();
    game.overworld.setMap("ROUTE_1", 5, 5, "down");
    expect(game.save.visited?.ROUTE_1 ?? false).toBe(false);
  });

  test.skipIf(!hasGen)("the town you are standing in is not offered", () => {
    const save: any = {};
    visit(save, "PEWTER_CITY");
    visit(save, "CERULEAN_CITY");
    const from = flyDestinations(field(), save, "PEWTER_CITY").map((d: any) => d.map);
    expect(from).toEqual(["CERULEAN_CITY"]);
  });

  test.skipIf(!hasGen)("destinations keep the original's menu order", () => {
    const save: any = {};
    for (const m of ["SAFFRON_CITY", "PALLET_TOWN", "CELADON_CITY"]) visit(save, m);
    expect(flyDestinations(field(), save).map((d: any) => d.map))
      .toEqual(["PALLET_TOWN", "CELADON_CITY", "SAFFRON_CITY"]);
  });

  test.skipIf(!hasGen)("every destination has a real landing cell", () => {
    const save: any = {};
    for (const m of FLY_MAP_IDS) visit(save, m);
    const all = flyDestinations(field(), save);
    expect(all.length).toBe(FLY_MAP_IDS.length);
    for (const d of all) {
      expect(typeof d.x, d.map).toBe("number");
      expect(typeof d.y, d.map).toBe("number");
      expect(d.name.length, d.map).toBeGreaterThan(0);
      // and the map it lands on is real
      expect((romData as any).maps[d.map], d.map).toBeTruthy();
    }
  });

  test.skipIf(!hasGen)("picking a town flies you there", () => {
    const game = flyGame();
    const ow = game.overworld;
    ow.setMap("PALLET_TOWN", 5, 6, "down"); // FLY only leaves outside
    visit(game.save as never, "PEWTER_CITY");
    ow.runScript([["use_fly", "PIDGEOT"]]);
    let guard = 0;
    while (game.stackKinds().at(-1) !== "flypicker" && guard++ < 400) game.tick(0);
    expect(game.stackKinds().at(-1)).toBe("flypicker");
    const v = game.flyPicker() as any;
    expect(v.entries).toContain("PEWTER CITY");
    for (let i = 0; i < v.entries.indexOf("PEWTER CITY"); i++) tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.a);
    for (let i = 0; i < 400; i++) game.tick(0);
    expect(ow.map.id).toBe("PEWTER_CITY");
  });

  test.skipIf(!hasGen)("backing out of the list leaves you where you were", () => {
    const game = flyGame();
    const ow = game.overworld;
    ow.setMap("PALLET_TOWN", 5, 6, "down");
    visit(game.save as never, "PEWTER_CITY");
    ow.runScript([["use_fly", "PIDGEOT"]]);
    let guard = 0;
    while (game.stackKinds().at(-1) !== "flypicker" && guard++ < 400) game.tick(0);
    expect(game.stackKinds().at(-1)).toBe("flypicker");
    tap(game, VOX_BTN.b);
    for (let i = 0; i < 200; i++) game.tick(0);
    expect(ow.map.id).toBe("PALLET_TOWN");
    expect(game.stackKinds()).toEqual(["overworld"]);
  });

  test.skipIf(!hasGen)("with nowhere to go it says so instead of opening an empty list", () => {
    const game = flyGame();
    const ow = game.overworld;
    // Outside, so the location check passes and the EMPTY LIST is what
    // refuses: a brand new save standing in Pallet has visited exactly
    // Pallet, and you cannot fly to where you already are.
    ow.setMap("PALLET_TOWN", 5, 6, "down");
    expect(ow.map.def.tileset).toBe("OVERWORLD");
    expect(flyDestinations((romData as any).field, game.save as never, "PALLET_TOWN"))
      .toEqual([]);
    ow.runScript([["use_fly", "PIDGEOT"]]);
    let guard = 0;
    while (game.stackKinds().at(-1) !== "textbox" && guard++ < 400) game.tick(0);
    expect(game.stackKinds().at(-1)).toBe("textbox");
    expect(topText(game)).toContain("FLY");
  });

  test("a save from before FLY gets its visit record reconstructed", () => {
    // Every save made before `visited` existed comes back with an empty
    // destination list. A finished game having nowhere to fly to is the whole
    // point of this: the receipts are already in the save.
    const save: any = {
      inventory: { BOULDERBADGE: 1, CASCADEBADGE: 1, SOULBADGE: 1 },
      flags: { EVENT_GOT_STARTER: true, EVENT_GOT_POKE_FLUTE: true },
    };
    const added = backfillVisited(save);
    expect(added.sort()).toEqual(
      ["CERULEAN_CITY", "FUCHSIA_CITY", "LAVENDER_TOWN", "PALLET_TOWN", "PEWTER_CITY"],
    );
    // and nothing it has no evidence for
    expect(save.visited.CELADON_CITY ?? false).toBe(false);
    expect(save.visited.INDIGO_PLATEAU ?? false).toBe(false);
  });

  test("a champion has been to the plateau by definition", () => {
    const a: any = { hallOfFame: [[{ species: "RATTATA", level: 12 }]] };
    backfillVisited(a);
    expect(a.visited.INDIGO_PLATEAU).toBe(true);
    const b: any = { flags: { EVENT_BEAT_CHAMPION_RIVAL: true } };
    backfillVisited(b);
    expect(b.visited.INDIGO_PLATEAU).toBe(true);
  });

  test("the backfill only ever adds, so running it twice is harmless", () => {
    const save: any = {
      inventory: { BOULDERBADGE: 1 },
      visited: { CELADON_CITY: true },
    };
    expect(backfillVisited(save)).toEqual(["PEWTER_CITY"]);
    expect(backfillVisited(save)).toEqual([]);
    // the town it already knew about is untouched
    expect(save.visited.CELADON_CITY).toBe(true);
    expect(save.visited.PEWTER_CITY).toBe(true);
  });

  test("a brand new save gains nothing from it", () => {
    const save: any = { inventory: {}, flags: {} };
    expect(backfillVisited(save)).toEqual([]);
  });

  test("every town the backfill can name is a real fly destination", () => {
    // A reconstructed town that FLY does not list is a town the player can
    // never be offered, and one that is not a destination at all would throw.
    const save: any = {
      inventory: Object.fromEntries(
        ["BOULDERBADGE", "CASCADEBADGE", "THUNDERBADGE", "RAINBOWBADGE",
         "SOULBADGE", "MARSHBADGE", "VOLCANOBADGE", "EARTHBADGE"].map((b) => [b, 1]),
      ),
      flags: {
        EVENT_GOT_STARTER: true, EVENT_GOT_POKE_FLUTE: true,
        EVENT_BEAT_CHAMPION_RIVAL: true,
      },
    };
    const added = backfillVisited(save);
    for (const m of added) expect(FLY_MAP_IDS as readonly string[]).toContain(m);
    // with every receipt in the save, that is the whole map
    expect(added.sort()).toEqual([...FLY_MAP_IDS].sort());
  });

  test.skipIf(!hasGen)("CONTINUE runs the backfill, so an old save can fly", () => {
    // The function being right is half of it; the other half is that loading
    // a save actually calls it. Driven through the title's CONTINUE, which is
    // the only path a real save takes into the game.
    const old: any = {
      player: { name: "RED", rival: "BLUE", map: "PALLET_TOWN", x: 5, y: 6, facing: "down" },
      party: [], inventory: { BOULDERBADGE: 1, CASCADEBADGE: 1 },
      flags: { EVENT_GOT_STARTER: true }, money: 3000,
      lastOutdoor: { id: "PALLET_TOWN", x: 5, y: 6 },
    };
    const host = new MenuHost();
    host.saveWrite(encodeSave(old));

    const game = new VoxelmonGame(romData!, host, 1);
    game.newGame(); // stages the world and pushes the title
    expect(game.stackKinds().at(-1)).toBe("title");
    tap(game, VOX_BTN.start); // PRESS START -> the menu
    let guard = 0;
    while (game.stackKinds().at(-1) === "title" && guard++ < 40) tap(game, VOX_BTN.a);
    expect(game.stackKinds().at(-1)).toBe("overworld");

    // the save loaded, and it can fly to the two cities its badges prove
    expect(game.save.inventory.BOULDERBADGE).toBe(1);
    expect(game.save.visited?.PEWTER_CITY).toBe(true);
    expect(game.save.visited?.CERULEAN_CITY).toBe(true);
    expect(game.save.visited?.PALLET_TOWN).toBe(true);
    expect(game.save.visited?.CELADON_CITY ?? false).toBe(false);
  });

  /**
   * Open the picker from `map` and say what came back. A fresh game per call:
   * the script runner from the previous use_fly is still live otherwise.
   */
  function flyFrom(map: string, visitAll = true): "picker" | "refused" | "nothing" {
    const game = flyGame();
    if (visitAll) for (const m of FLY_MAP_IDS) visit(game.save as never, m);
    game.overworld.setMap(map, 4, 4, "down");
    game.overworld.runScript([["use_fly", "PIDGEOT"]]);
    for (let i = 0; i < 400; i++) {
      const top = game.stackKinds().at(-1);
      if (top === "flypicker") return "picker";
      if (top === "textbox") return "refused";
      game.tick(0);
    }
    return "nothing";
  }

  /** The refusal line, for the test that checks WHICH refusal it was. */
  function flyRefusalFrom(map: string, visitAll: boolean): string {
    const game = flyGame();
    if (visitAll) for (const m of FLY_MAP_IDS) visit(game.save as never, m);
    game.overworld.setMap(map, 4, 4, "down");
    game.overworld.runScript([["use_fly", "PIDGEOT"]]);
    for (let i = 0; i < 400; i++) {
      if (game.stackKinds().at(-1) === "textbox") return topText(game);
      game.tick(0);
    }
    return "";
  }

  test.skipIf(!hasGen)("FLY only leaves from outside", () => {
    // CheckIfInOutsideMap: an OVERWORLD or PLATEAU map. Without this you can
    // fly out of a cave or out of Silph Co.
    for (const map of ["ROUTE_1", "CELADON_CITY", "PALLET_TOWN"]) {
      expect(flyFrom(map), map).toBe("picker");
    }
    for (const map of ["SILPH_CO_3F", "MT_MOON_1F", "VIRIDIAN_FOREST", "CELADON_GYM"]) {
      expect(flyFrom(map), map).toBe("refused");
      expect(flyRefusalFrom(map, true), map).toContain("FLY");
    }
  });

  test.skipIf(!hasGen)("and not out of an Elite Four room", () => {
    // Lance's door locks behind you on the way in. Flying out of the league
    // mid-run would undo that entirely.
    for (const map of ["LORELEIS_ROOM", "BRUNOS_ROOM", "AGATHAS_ROOM", "LANCES_ROOM",
                       "CHAMPIONS_ROOM"]) {
      expect(flyFrom(map), map).toBe("refused");
    }
  });

  test.skipIf(!hasGen)("the plateau counts as outside, as it does in the original", () => {
    // CheckIfInOutsideMap takes tileset 0 OR PLATEAU, which is why Indigo
    // Plateau is somewhere you can fly from as well as to.
    expect(flyFrom("INDIGO_PLATEAU")).toBe("picker");
  });

  test.skipIf(!hasGen)("being outside is checked before having anywhere to go", () => {
    // Both refuse with the same line, so the order only shows in which reason
    // is reported -- but a cave with a full destination list must still say
    // no, and that is the case this pins.
    expect(flyFrom("MT_MOON_1F", false)).toBe("refused");
    expect(flyFrom("MT_MOON_1F", true)).toBe("refused");
  });

  test.skipIf(!hasGen)("the party menu offers FLY to a mon that knows it", () => {
    const game = flyGame();
    const mon: any = newMon(romData!, "PIDGEOT", 40);
    mon.moves = [{ id: "FLY", pp: 15 }];
    game.save.party.push(mon);
    game.overworld.setMap("PALLET_TOWN", 5, 6, "down"); // FLY only leaves outside
    tap(game, VOX_BTN.start);
    let guard = 0;
    while (game.stackKinds().at(-1) !== "party" && guard++ < 40) tap(game, VOX_BTN.a);
    tap(game, VOX_BTN.a);
    const items = (game.party() as any).submenuItems as string[];
    expect(items).toContain("FLY");

    // and choosing it runs FLY's verb, not some other move's -- listing the
    // entry while dispatching use_flash would look right and do nothing
    visit(game.save as never, "PEWTER_CITY");
    for (let i = 0; i < items.indexOf("FLY"); i++) tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.a);
    guard = 0;
    while (game.stackKinds().at(-1) !== "flypicker" && guard++ < 400) game.tick(0);
    expect(game.stackKinds().at(-1)).toBe("flypicker");
  });
});

describe("free movement", () => {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

  test("up on the pad is always away from the camera", () => {
    const n = freeDir(0, -1, 0)!;
    expect(near(n[0], 0) && near(n[1], -1)).toBe(true); // north
    const e = freeDir(0, -1, Math.PI / 2)!;
    expect(near(e[0], 1) && near(e[1], 0)).toBe(true); // camera looks east
    const r = freeDir(1, 0, 0)!;
    expect(near(r[0], 1) && near(r[1], 0)).toBe(true); // right is east
  });

  test("at an angle the walk goes at that angle, not the nearest axis", () => {
    // The whole point: with the camera at 30 degrees, forward is 30 degrees.
    const a = Math.PI / 6;
    const d = freeDir(0, -1, a)!;
    expect(near(d[0], Math.sin(a)) && near(d[1], -Math.cos(a))).toBe(true);
  });

  test("a diagonal is no faster than a straight", () => {
    const d = freeDir(1, -1, 0)!;
    expect(near(Math.hypot(d[0], d[1]), 1)).toBe(true);
    expect(freeDir(0, 0, 1)).toBeNull();
  });

  test("a push into a wall at an angle slides along it", () => {
    // wall everywhere north of row 1
    const open = (_x: number, y: number) => y >= 1;
    let px = 16, py = 16;
    for (let i = 0; i < 20; i++) {
      const r = slide(px, py, 2, -2, open);
      px = r.px;
      py = r.py;
    }
    // it kept going along the wall...
    expect(px).toBe(56);
    // ...and its body never crossed into the wall row (top edge stays >= 16;
    // the body has a little slack inside its own cell before it touches)
    expect(py + 8 - 5.5).toBeGreaterThanOrEqual(16);
    // straight into the wall, once touching, gets nowhere
    expect(slide(px, py, 0, -2, open).moved).toBe(false);
  });

  test("the pad is a push past its dead zone, at the throw it is given", () => {
    expect(stickPush(undefined)).toBeNull();
    expect(stickPush({ x: 0.1, y: 0.1 })).toBeNull(); // inside the dead zone
    const rim = stickPush({ x: 0, y: 1 })!;
    expect(near(rim.x, 0) && near(rim.y, 1)).toBe(true);
    expect(near(rim.throw, 1)).toBe(true);
    // just past the dead zone: a walk at the floor speed, not a shuffle
    const bare = stickPush({ x: 0.3, y: 0 })!;
    expect(bare.throw).toBeGreaterThanOrEqual(STICK_MIN_THROW);
    expect(bare.throw).toBeLessThan(0.5);
    // halfway out: between the two
    const half = stickPush({ x: 0, y: -0.6 })!;
    expect(half.throw).toBeGreaterThan(bare.throw);
    expect(half.throw).toBeLessThan(1);
    expect(near(half.y, -1)).toBe(true);
  });

  test("a body at rest never tests its neighbours", () => {
    const seen: string[] = [];
    bodyClear(32, 48, (x, y) => { seen.push(`${x},${y}`); return true; });
    expect(new Set(seen)).toEqual(new Set(["2,3"]));
  });

  /** An open straight run of `len` cells east from somewhere on `map`. */
  function openRun(game: VoxelmonGame, map: string, len: number): [number, number] {
    const ow = game.overworld;
    ow.setMap(map, 1, 1, "down");
    const m = ow.map;
    for (let y = 2; y < m.heightCells - 2; y++) {
      for (let x = 2; x < m.widthCells - len - 2; x++) {
        let ok = true;
        for (let i = 0; i <= len && ok; i++) {
          for (let dy = -1; dy <= 1 && ok; dy++) {
            const cx = x + i, cy = y + dy;
            if (!m.isWalkableCell(cx, cy) || m.warpAtCell(cx, cy) ||
                ow.npcs.some((n: any) => n.cellX === cx && n.cellY === cy)) ok = false;
          }
        }
        if (ok) return [x, y];
      }
    }
    throw new Error("no open run");
  }

  function hold(game: VoxelmonGame, mask: number, frames: number): void {
    for (let i = 0; i < frames; i++) game.tick(mask);
  }

  test.skipIf(!hasGen)("with a camera yaw the player walks continuously", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    const [x, y] = openRun(game, "PALLET_TOWN", 4);
    ow.setMap("PALLET_TOWN", x, y, "right");
    game.setCamYaw(0);
    expect(ow.freeMoveActive()).toBe(true);
    hold(game, VOX_BTN.right, 6);
    const p = ow.player;
    // part way into a cell, which a grid walk never rests at
    expect(p.px).toBeGreaterThan(x * 16);
    expect(p.px % 16).not.toBe(0);
    expect(p.moving).toBe(false);
    expect(p.py).toBe(y * 16);
  });

  test.skipIf(!hasGen)("the circle pad walks at its own angle and speed", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    const [x, y] = openRun(game, "PALLET_TOWN", 4);
    ow.setMap("PALLET_TOWN", x, y, "right");
    game.setCamYaw(0);
    // pad full right: as fast as the d-pad, no d-pad held
    game.setStick(156, 0, 156);
    hold(game, 0, 8);
    const full = ow.player.px - x * 16;
    expect(full).toBeGreaterThan(0);
    // pad half right: slower, still moving
    ow.setMap("PALLET_TOWN", x, y, "right");
    game.setStick(78, 0, 156);
    hold(game, 0, 8);
    const half = ow.player.px - x * 16;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(full);
    // pad at rest: the d-pad still walks, so nothing is lost
    ow.setMap("PALLET_TOWN", x, y, "right");
    game.setStick(0, 0, 156);
    hold(game, VOX_BTN.right, 8);
    expect(ow.player.px - x * 16).toBe(full);
    // and inside the dead zone a d-pad-free frame stands still
    ow.setMap("PALLET_TOWN", x, y, "right");
    game.setStick(20, 0, 156);
    hold(game, 0, 8);
    expect(ow.player.px).toBe(x * 16);
  });

  test.skipIf(!hasGen)("blocked off-centre, the grid still gets to decide", () => {
    // Stand a little east of a cell's centre with a wall to the north and
    // push north: the free body gets nowhere, and the grid's own handler
    // runs (which is what does ledges, doors, boulders, edges) -- it used
    // to run only within four pixels of the centre, so a walk that met a
    // ledge off-centre just stood there.
    const game = makeMenuGame();
    const ow = game.overworld;
    ow.setMap("PALLET_TOWN", 5, 6, "down");
    const m = ow.map;
    let spot: [number, number] | null = null;
    for (let cy = 1; cy < m.heightCells && !spot; cy++) {
      for (let cx = 1; cx < m.widthCells - 1 && !spot; cx++) {
        if (m.isWalkableCell(cx, cy) && m.isWalkableCell(cx + 1, cy) &&
            !m.isWalkableCell(cx, cy - 1) && !m.isWalkableCell(cx + 1, cy - 1) &&
            !m.warpAtCell(cx, cy) && !m.warpAtCell(cx + 1, cy)) spot = [cx, cy];
      }
    }
    expect(spot).not.toBeNull();
    const [cx, cy] = spot!;
    ow.setMap("PALLET_TOWN", cx, cy, "down");
    game.setCamYaw(0);
    game.setStick(0, 0, 156);
    ow.player.px = cx * 16 + 6; // off-centre, inside the cell
    // the body has a couple of pixels of slack before its corner touches
    // the wall row; hold long enough to use them up and be stopped
    hold(game, VOX_BTN.up, 12);
    // the grid took over: the body is back on the cell, facing the wall
    expect(ow.player.px).toBe(cx * 16);
    expect(ow.player.facing).toBe("up");
  });

  test.skipIf(!hasGen)("forward follows the camera, not the map", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    const [x, y] = openRun(game, "PALLET_TOWN", 4);
    ow.setMap("PALLET_TOWN", x, y, "up");
    game.setCamYaw(Math.PI / 2); // camera looking east
    hold(game, VOX_BTN.up, 20);
    expect(ow.player.px).toBeGreaterThan(x * 16 + 8); // went east
    expect(ow.player.py).toBe(y * 16); // not north
    expect(ow.player.facing).toBe("right");
  });

  test.skipIf(!hasGen)("the walk animates, rather than sliding stiffly", () => {
    // The walk cycle has to be alive at DRAW time. The player's own update
    // runs first and counts the cycle down, so a counter it had already taken
    // to zero drew the standing pose every frame.
    const game = makeMenuGame();
    const ow = game.overworld;
    const [x, y] = openRun(game, "PALLET_TOWN", 4);
    ow.setMap("PALLET_TOWN", x, y, "right");
    game.setCamYaw(0);
    const phases = new Set<number>();
    for (let i = 0; i < 32; i++) {
      game.tick(VOX_BTN.right);
      phases.add(ow.player.walkPhase());
    }
    expect(phases).toEqual(new Set([0, 1])); // both legs, not one pose
    // and letting go stands the player straight away
    game.tick(0);
    game.tick(0);
    expect(ow.player.walkPhase()).toBe(0);
  });

  test.skipIf(!hasGen)("each cell crossed lands like a grid step", () => {
    // onStepComplete is what runs warps, triggers and encounters -- once per
    // cell, the rate a grid walk fires it.
    const game = makeMenuGame();
    const ow = game.overworld;
    const [x, y] = openRun(game, "PALLET_TOWN", 4);
    ow.setMap("PALLET_TOWN", x, y, "right");
    game.setCamYaw(0);
    let landed = 0;
    const orig = ow.onStepComplete.bind(ow);
    ow.onStepComplete = () => { landed += 1; orig(); };
    hold(game, VOX_BTN.right, 16 * 3);
    expect(ow.player.cellX).toBe(x + 3);
    expect(landed).toBe(3);
  });

  test.skipIf(!hasGen)("it does not walk into walls", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    game.setCamYaw(0);
    const [x, y] = openRun(game, "PALLET_TOWN", 4);
    ow.setMap("PALLET_TOWN", x, y, "up");
    hold(game, VOX_BTN.up, 200);
    // wherever it stopped, it is standing somewhere walkable
    expect(ow.map.isWalkableCell(ow.player.cellX, ow.player.cellY)).toBe(true);
  });

  test.skipIf(!hasGen)("MOVEMENT: GRID puts it back on the grid", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    const [x, y] = openRun(game, "PALLET_TOWN", 4);
    ow.setMap("PALLET_TOWN", x, y, "right");
    game.setCamYaw(0);
    (game.save as any).options = { movement: "grid" };
    expect(ow.freeMoveActive()).toBe(false);
    hold(game, VOX_BTN.right, 6);
    // a grid step is in flight: the classic walker owns it
    expect(ow.player.moving).toBe(true);
  });

  test.skipIf(!hasGen)("with no camera yaw it stays a grid walk", () => {
    // Every other test in this suite drives the grid; none sends a yaw.
    const game = makeMenuGame();
    expect(game.overworld.freeMoveActive()).toBe(false);
  });

  test("the OPTIONS screen offers FREE and GRID", () => {
    const save: any = {};
    const st = new OptionsMenuState({ input: { pressed: {} }, pop() {}, save } as never);
    const row = (st.view().rows as any[]).find((r) => r.label === "MOVEMENT");
    expect(row.choices).toEqual(["FREE", "GRID"]);
    expect(row.index).toBe(0); // free by default
    (st as any).set(2, 1);
    expect(save.options.movement).toBe("grid");
  });
});

describe("HM03 SURF", () => {
  /** A water cell on this map with a walkable cell beside it, if one exists. */
  function shore(
    game: VoxelmonGame,
  ): { land: [number, number]; water: [number, number]; dir: Dir } | null {
    const m = game.overworld.map;
    const DIRS: [Dir, number, number][] = [
      ["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0],
    ];
    for (let y = 1; y < m.heightCells - 1; y++) {
      for (let x = 1; x < m.widthCells - 1; x++) {
        if (!m.isWalkableCell(x, y) || m.isWaterCell(x, y)) continue;
        for (const [dir, dx, dy] of DIRS) {
          if (m.isWaterCell(x + dx, y + dy)) {
            return { land: [x, y], water: [x + dx, y + dy], dir };
          }
        }
      }
    }
    return null;
  }

  /** Stand on the bank of a real lake, facing the water. */
  function atShore(map = "PALLET_TOWN"): { game: VoxelmonGame; at: any } | null {
    const game = makeMenuGame();
    game.overworld.setMap(map, 5, 6, "down");
    const at = shore(game);
    if (!at) return null;
    game.overworld.setMap(map, at.land[0], at.land[1], at.dir);
    return { game, at };
  }

  /** START -> POKéMON, the way a player reaches the party menu. */
  function openParty(game: VoxelmonGame): void {
    tap(game, VOX_BTN.start);
    let guard = 0;
    while (game.stackKinds().at(-1) !== "party" && guard++ < 40) tap(game, VOX_BTN.a);
    expect(game.stackKinds().at(-1)).toBe("party");
  }

  function partyView(game: VoxelmonGame): any {
    return game.party() as any;
  }

  function runSurf(game: VoxelmonGame, name = "SQUIRTLE"): void {
    game.overworld.runScript([["use_surf", name]]);
    for (let i = 0; i < 600; i++) {
      if (game.stackKinds().at(-1) === "textbox") dismissText(game);
      else game.tick(0);
    }
  }

  test.skipIf(!hasGen)("water is impassable on foot and ridable afloat", () => {
    // Every consumer of `surfing` was already wired -- passability, the water
    // encounter table, the battle arena. Nothing ever set it, so the flag was
    // permanently false and the water was a wall.
    const found = atShore();
    if (!found) return;
    const { game, at } = found;
    const ow = game.overworld;
    expect(ow.map.isWalkableCell(at.water[0], at.water[1])).toBe(false);
    expect(ow.map.isWaterCell(at.water[0], at.water[1])).toBe(true);
    expect(ow.player.surfing).toBe(false);
  });

  test.skipIf(!hasGen)("SURF gets you onto the water and off the bank", () => {
    const found = atShore();
    if (!found) return;
    const { game, at } = found;
    const ow = game.overworld;
    expect(ow.canSurfHere()).toBe(true);
    runSurf(game);
    expect(ow.player.surfing).toBe(true);
    expect(game.save.surfing).toBe(true);
    // it takes the step, rather than announcing SURF from dry land
    expect([ow.player.cellX, ow.player.cellY]).toEqual(at.water);
  });

  test.skipIf(!hasGen)("facing dry land it refuses, and does not mount", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    ow.setMap("PALLET_TOWN", 5, 6, "down");
    expect(ow.canSurfHere()).toBe(false);
    runSurf(game);
    expect(ow.player.surfing).toBe(false);
  });

  test.skipIf(!hasGen)("stepping back onto land gets you off", () => {
    const found = atShore();
    if (!found) return;
    const { game, at } = found;
    const ow = game.overworld;
    runSurf(game);
    expect(ow.player.surfing).toBe(true);
    // walk back to the bank the way a completed step would land
    ow.player.cellX = at.land[0];
    ow.player.cellY = at.land[1];
    ow.onStepComplete();
    expect(ow.player.surfing).toBe(false);
    expect(game.save.surfing).toBe(false);
  });

  test.skipIf(!hasGen)("a save reloaded afloat comes back afloat, not stuck", () => {
    // Without syncSurf on map entry this is a player standing in open water
    // with the flag cleared: every direction blocked, no way to move at all.
    const found = atShore();
    if (!found) return;
    const { game, at } = found;
    const ow = game.overworld;
    ow.player.surfing = false;
    ow.setMap("PALLET_TOWN", at.water[0], at.water[1], "down");
    expect(ow.player.surfing).toBe(true);
  });

  test.skipIf(!hasGen)("the party menu offers SURF only to a mon that knows it", () => {
    // Same rule CUT and FLASH already follow: the entry appears on the mon
    // the submenu was opened on, not on the party as a whole.
    const game = makeMenuGame();
    const mon: any = newMon(romData!, "SQUIRTLE", 30);
    mon.moves = [{ id: "TACKLE", pp: 30 }];
    game.save.party.push(mon);
    openParty(game);
    tap(game, VOX_BTN.a); // open the submenu on slot 1
    expect(partyView(game).submenuItems).not.toContain("SURF");

    mon.moves = [{ id: "SURF", pp: 15 }];
    expect(partyView(game).submenuItems).toContain("SURF");
    // and the ones that were already there did not move
    expect(partyView(game).submenuItems).toEqual(["STATS", "SWITCH", "SURF", "CANCEL"]);
  });

  test.skipIf(!hasGen)("choosing SURF from that menu actually puts you on the water", () => {
    // The menu entry and the verb it dispatches are separate things: listing
    // SURF while running use_flash would look right and do nothing at all.
    const found = atShore();
    if (!found) return;
    const { game, at } = found;
    const mon: any = newMon(romData!, "SQUIRTLE", 30);
    mon.moves = [{ id: "SURF", pp: 15 }];
    game.save.party.push(mon);
    openParty(game);
    tap(game, VOX_BTN.a);
    const items = partyView(game).submenuItems as string[];
    for (let i = 0; i < items.indexOf("SURF"); i++) tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.a);
    for (let i = 0; i < 600; i++) {
      if (game.stackKinds().at(-1) === "textbox") dismissText(game);
      else game.tick(0);
    }
    expect(game.overworld.player.surfing).toBe(true);
    expect([game.overworld.player.cellX, game.overworld.player.cellY]).toEqual(at.water);
  });

  test.skipIf(!hasGen)("mounting obeys the water tile-pairs, not just 'is it wet'", () => {
    // TilePairCollisionsWater: three shore edges in the caves and Viridian
    // Forest that a surfer may not cross. The mount has to honour them as the
    // SURFER the player is about to become -- pairBlocked picks its list by
    // mover.surfing, so asking as a walker consults the wrong table entirely.
    const pairs = (romData as any).field?.tilePairs?.water ?? [];
    expect(pairs.length).toBeGreaterThan(0);

    const maps = (romData as any).maps as Record<string, any>;
    const tilesets = (romData as any).tilesets as Record<string, any>;
    let checked = 0;

    for (const [name, def] of Object.entries(maps)) {
      const forHere = pairs.filter((p: any) => p.tileset === def.tileset);
      if (forHere.length === 0) continue;
      const map = new GameMap(def, tilesets[def.tileset]);
      for (let y = 1; y < map.heightCells - 1 && checked < 3; y++) {
        for (let x = 1; x < map.widthCells - 1 && checked < 3; x++) {
          if (map.isWaterCell(x, y)) continue;
          for (const [dir, dx, dy] of [
            ["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0],
          ] as [Dir, number, number][]) {
            const wx = x + dx;
            const wy = y + dy;
            if (!map.isWaterCell(wx, wy)) continue;
            const a = map.cellTile(x, y);
            const b = map.cellTile(wx, wy);
            const blocked = forHere.some(
              (p: any) => (p.a === a && p.b === b) || (p.a === b && p.b === a),
            );
            if (!blocked) continue;
            // a real forbidden edge in the shipped data: the mount must refuse
            const game = makeMenuGame();
            const data = {
              ...(romData as object),
              cookedMaps: [
                ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []), name,
              ],
            };
            const g = new VoxelmonGame(data as never, new MenuHost(), 1);
            g.newGame();
            g.closeToOverworld();
            g.overworld.setMap(name, x, y, dir);
            expect(g.overworld.canSurfHere(), `${name} (${x},${y}) ${dir}`).toBe(false);
            void game;
            checked += 1;
            break;
          }
        }
      }
    }
    // the rule is only worth having if the data actually exercises it
    expect(checked).toBeGreaterThan(0);
  });

  test("surfing takes the music over, indoors as well as out", () => {
    // pokered checks wWalkBikeSurfState before the map's own song, so the
    // Seafoam caves play it too -- unlike the bike, which only overrides
    // outdoor themes.
    expect(effectiveMapSong("Music_Pallet", false, true)).toBe(SURF_SONG);
    expect(effectiveMapSong("Music_Dungeon1", false, true)).toBe(SURF_SONG);
    // and it outranks the bike
    expect(effectiveMapSong("Music_Routes1", true, true)).toBe(SURF_SONG);
    // ashore, nothing changes
    expect(effectiveMapSong("Music_Pallet", false, false)).toBe("Music_Pallet");
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
    // and it stays locked across a re-entry (not via the lobby, which
    // resets the whole League for a rematch)
    ow.setMap("AGATHAS_ROOM", 4, 4, "down");
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

describe("the MAGIKARP salesman", () => {
  /** Talk to him, answering his YES/NO the way `answers` says. */
  function haggle(game: VoxelmonGame, answers: boolean[] = []): void {
    const ow = game.overworld;
    if (ow.map.id !== "MT_MOON_POKECENTER") ow.setMap("MT_MOON_POKECENTER", 10, 7, "up");
    ow.showMapText("TEXT_MTMOONPOKECENTER_MAGIKARP_SALESMAN");
    for (let i = 0; i < 900; i++) {
      const top = game.stackKinds().at(-1);
      if (top === "choice") {
        if (!(answers.shift() ?? false)) tap(game, VOX_BTN.down);
        tap(game, VOX_BTN.a);
        for (let h = 0; h < 60 && game.stackKinds().at(-1) === "choice"; h++) game.tick(0);
        continue;
      }
      if (top !== "textbox" && !(ow as any).runner.isRunning()) return;
      dismissText(game);
      game.tick(0);
    }
  }

  function buyer(): VoxelmonGame {
    const game = makeMenuGame();
    (game as any).askNickname = (_n: string, done: (n: string | null) => void) => done(null);
    game.save.money = 1000;
    return game;
  }

  test.skipIf(!hasGen)("sells one level 5 MAGIKARP for 500", () => {
    const game = buyer();
    const before = game.save.party.length;
    haggle(game, [true]);
    expect(game.save.money).toBe(500);
    expect(game.save.flags.EVENT_BOUGHT_MAGIKARP).toBe(true);
    expect(game.save.party.length).toBe(before + 1);
    const fish = game.save.party.at(-1)!;
    expect(fish.species).toBe("MAGIKARP");
    expect(fish.level).toBe(5);
  });

  test.skipIf(!hasGen)("and only the once -- no refunds", () => {
    const game = buyer();
    haggle(game, [true]);
    const after = game.save.party.length;
    haggle(game, [true]);
    expect(game.save.party.length).toBe(after);
    expect(game.save.money).toBe(500);
  });

  test.skipIf(!hasGen)("saying no costs nothing", () => {
    const game = buyer();
    const before = game.save.party.length;
    haggle(game, [false]);
    expect(game.save.money).toBe(1000);
    expect(game.save.party.length).toBe(before);
    expect(game.save.flags.EVENT_BOUGHT_MAGIKARP).toBeFalsy();
  });

  test.skipIf(!hasGen)("a short wallet keeps its money", () => {
    const game = buyer();
    game.save.money = 499;
    haggle(game, [true]);
    expect(game.save.money).toBe(499);
    expect(game.save.flags.EVENT_BOUGHT_MAGIKARP).toBeFalsy();
  });

  test.skipIf(!hasGen)("a full party is refused before the money moves", () => {
    const game = buyer();
    while (game.save.party.length < 6) {
      game.save.party.push(newMon(romData!, "PIDGEY", 5));
    }
    haggle(game, [true]);
    // pokered would box it; this port has no boxes, so he keeps the fish
    // and the player keeps the 500.
    expect(game.save.money).toBe(1000);
    expect(game.save.party.length).toBe(6);
    expect(game.save.flags.EVENT_BOUGHT_MAGIKARP).toBeFalsy();
  });
});

describe("Lance's room", () => {
  /** Walk the runner to a stop, or give up. */
  function settleScript(game: VoxelmonGame, ticks = 2000): void {
    const ow = game.overworld as any;
    for (let i = 0; i < ticks; i++) {
      if (!ow.runner?.isRunning?.() && !ow.player.moving) return;
      game.tick(0);
    }
  }

  test.skipIf(!hasGen)("walks you in from the stairs and seals the door", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    // Coming up from Agatha's lands on the staircase cell.
    ow.setMap("LANCES_ROOM", 24, 16, "up");
    settleScript(game);
    // WalkToLance ends on the doorway, which locks behind you.
    expect([ow.player.cellX, ow.player.cellY]).toEqual([6, 11]);
    expect(game.save.flags.EVENT_LANCES_ROOM_LOCK_DOOR).toBe(true);
  });

  test.skipIf(!hasGen)("does not re-run it once Lance is beaten", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    game.save.flags.EVENT_BEAT_LANCE = true;
    ow.setMap("LANCES_ROOM", 24, 16, "up");
    settleScript(game, 120);
    expect([ow.player.cellX, ow.player.cellY]).toEqual([24, 16]);
  });

  test.skipIf(!hasGen)("every step of the route is floor", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    game.save.flags.EVENT_BEAT_LANCE = true; // no walk-in; just read the map
    ow.setMap("LANCES_ROOM", 24, 16, "up");
    const step: Record<string, [number, number]> = {
      up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
    };
    let [x, y] = [24, 16];
    for (const [dir, n] of LANCE_WALK_IN) {
      const [dx, dy] = step[dir]!;
      for (let i = 0; i < n; i++) {
        x += dx;
        y += dy;
        expect({ dir, x, y, walkable: ow.map.isWalkableCell(x, y) })
          .toEqual({ dir, x, y, walkable: true });
      }
    }
    // and it ends on the doorway cell the original lands on
    expect([x, y]).toEqual([6, 11]);
  });
});

describe("Oak's POKe BALLs", () => {
  /** Talk to Oak and answer nothing; returns when the script idles. */
  function talkToOak(game: VoxelmonGame): void {
    const ow = game.overworld;
    if (ow.map.id !== "OAKS_LAB") ow.setMap("OAKS_LAB", 4, 5, "up");
    ow.showMapText("TEXT_OAKSLAB_OAK1");
    for (let i = 0; i < 1200; i++) {
      const top = game.stackKinds().at(-1);
      if (top !== "textbox" && !(ow as any).runner.isRunning()) return;
      dismissText(game);
      game.tick(0);
    }
  }

  test.skipIf(!hasGen)("five of them, once, after the Route 22 rival", () => {
    const game = makeMenuGame();
    const f = game.save.flags;
    f.EVENT_GOT_POKEDEX = true;
    f.EVENT_BATTLED_RIVAL_IN_OAKS_LAB = true;
    // OaksLabScript_Oak1's own gate: the balls are the reward for the
    // OPTIONAL Route 22 rival battle, which is why a player who skips it
    // never sees them (pokered .GiveBalls, same order as bryan's).
    f.EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE = true;
    delete game.save.inventory.POKE_BALL;

    talkToOak(game);
    expect(game.save.inventory.POKE_BALL).toBe(5);
    expect(f.EVENT_GOT_POKEBALLS_FROM_OAK).toBe(true);

    // and not a second handful
    delete game.save.inventory.POKE_BALL;
    talkToOak(game);
    expect(game.save.inventory.POKE_BALL ?? 0).toBe(0);
  });

  test.skipIf(!hasGen)("not before that battle is won", () => {
    const game = makeMenuGame();
    const f = game.save.flags;
    f.EVENT_GOT_POKEDEX = true;
    f.EVENT_BATTLED_RIVAL_IN_OAKS_LAB = true;
    delete game.save.inventory.POKE_BALL;
    talkToOak(game);
    expect(game.save.inventory.POKE_BALL ?? 0).toBe(0);
    expect(f.EVENT_GOT_POKEBALLS_FROM_OAK).toBeFalsy();
  });
});

describe("what the game will not take off you", () => {
  test.skipIf(!hasGen)("key items and HMs are not sellable, tossable or PC-tossable", () => {
    const data = romData!;
    // pokemart.asm IsKeyItem / IsItemHM, the one rule every screen asks.
    for (const id of ["TOWN_MAP", "POKEDEX", "BICYCLE", "BOULDERBADGE", "S_S_TICKET",
                      "HM_CUT", "HM_SURF", "HM_FLY", "HM_STRENGTH", "HM_FLASH"]) {
      expect({ id, precious: Bag.precious(data, id) }).toEqual({ id, precious: true });
    }
    // and the ordinary stock still is: the MOON STONE is priced 0 and
    // perfectly tossable, which is why price cannot be the test.
    for (const id of ["POTION", "POKE_BALL", "MOON_STONE", "ANTIDOTE", "TM_MEGA_PUNCH"]) {
      expect({ id, precious: Bag.precious(data, id) }).toEqual({ id, precious: false });
    }
    // an id no dataset knows is treated as precious rather than sold for
    // whatever a missing price rounds to
    expect(Bag.precious(data, "ITEM_NOT_A_THING")).toBe(true);
  });

  test.skipIf(!hasGen)("the mart refuses to buy a TOWN MAP", () => {
    const game = makeMenuGame();
    game.save.inventory.TOWN_MAP = 1;
    game.save.inventory.POTION = 2;
    game.save.money = 0;
    const shop = new ShopState(game as never, ["POTION"]);
    (game as any).push?.(shop);
    // SELL, then the TOWN MAP: the clerk says no and the bag is untouched.
    const sell = (id: string): boolean => (shop as never as {
      unsellable(id: string): boolean;
    }).unsellable(id);
    expect(sell("TOWN_MAP")).toBe(true);
    expect(sell("HM_CUT")).toBe(true);
    expect(sell("POTION")).toBe(false);
    expect(game.save.inventory.TOWN_MAP).toBe(1);
    expect(game.save.money).toBe(0);
  });
});

describe("fishing", () => {
  test.skipIf(!hasGen)("the three gurus each hand over their own rod, once", () => {
    const cases: [string, string, string, string][] = [
      ["VERMILION_OLD_ROD_HOUSE", "TEXT_VERMILIONOLDRODHOUSE_FISHING_GURU",
       "OLD_ROD", "EVENT_GOT_OLD_ROD"],
      ["FUCHSIA_GOOD_ROD_HOUSE", "TEXT_FUCHSIAGOODRODHOUSE_FISHING_GURU",
       "GOOD_ROD", "EVENT_GOT_GOOD_ROD"],
      ["ROUTE_12_SUPER_ROD_HOUSE", "TEXT_ROUTE12SUPERRODHOUSE_FISHING_GURU",
       "SUPER_ROD", "EVENT_GOT_SUPER_ROD"],
    ];
    for (const [map, textConst, rod, flag] of cases) {
      const rows = talkScript(map, textConst) as ScriptRow[];
      expect({ map, rows: Array.isArray(rows) }).toEqual({ map, rows: true });
      // the rod itself, the flag that closes the gift, and a "no" that is
      // answered rather than ignored
      expect(rows.some((r) => r[0] === "give_item" && r[1] === rod)).toBe(true);
      expect(rows.some((r) => r[0] === "set_flag" && r[1] === flag)).toBe(true);
      expect(rows.some((r) => r[0] === "check_flag" && r[1] === flag)).toBe(true);
      expect(rows.some((r) => r[0] === "ask")).toBe(true);
    }
  });

  test.skipIf(!hasGen)("the OLD ROD always hooks a L5 MAGIKARP", () => {
    // ItemUseOldRod does not roll at all, so no byte the RNG gives can
    // turn it into a miss.
    for (const byte of [0, 1, 7, 128, 255]) {
      expect(fishingCatch(romData!, "OLD_ROD", "PALLET_TOWN", () => byte))
        .toEqual({ species: "MAGIKARP", level: 5 });
    }
  });

  test.skipIf(!hasGen)("an odd byte is no bite; an even one picks from the group", () => {
    const good = (byte: number) =>
      fishingCatch(romData!, "GOOD_ROD", "PALLET_TOWN", () => byte);
    expect(good(1)).toBeNull();
    expect(good(255)).toBeNull();
    // r=0 -> pick 0, r=2 -> pick 1: the Good Rod's pair, in its order
    expect(good(0)).toEqual({ species: "GOLDEEN", level: 10 });
    expect(good(2)).toEqual({ species: "POLIWAG", level: 10 });
    // r=4 -> pick 2, past the pair: reroll rather than catch nothing, which
    // is what makes the odds 1/3 and not 1/4
    const bytes = [4, 2];
    let i = 0;
    expect(fishingCatch(romData!, "GOOD_ROD", "PALLET_TOWN", () => bytes[i++]!))
      .toEqual({ species: "POLIWAG", level: 10 });
  });

  test.skipIf(!hasGen)("the SUPER ROD reads the map's own group, and dry water is a miss", () => {
    const pal = rodPool(romData!, "SUPER_ROD", "PALLET_TOWN");
    expect(pal.length).toBeGreaterThan(0);
    expect(fishingCatch(romData!, "SUPER_ROD", "PALLET_TOWN", () => 0))
      .toEqual(pal[0]);
    // a map with no group: nothing to hook, whatever the roll
    expect(rodPool(romData!, "SUPER_ROD", "REDS_HOUSE_1F")).toEqual([]);
    expect(fishingCatch(romData!, "SUPER_ROD", "REDS_HOUSE_1F", () => 0)).toBeNull();
  });

  test.skipIf(!hasGen)("a rod pointed away from water says so, and refuses on the water", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    ow.setMap("PALLET_TOWN", 5, 6, "up");
    game.save.inventory.OLD_ROD = 1;
    // facing dry land: the cast never happens
    game.goFishing("OLD_ROD");
    expect(game.stackKinds().at(-1)).toBe("textbox");
    dismissText(game);
    expect(game.stackKinds()).not.toContain("battle");

    // and FishingInit's first check: surfing refuses every rod outright
    ow.player.surfing = true;
    game.goFishing("OLD_ROD");
    dismissText(game);
    expect(game.stackKinds()).not.toContain("battle");
  });
});

/** Mash through a gift's text, keeping the default name at the keyboard. */
function takeTheGift(game: VoxelmonGame, maxTicks = 2000): void {
  for (let t = 0; t < maxTicks; t++) {
    const top = game.stackKinds().at(-1);
    if (top === "textbox") game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    else if (top === "naming") game.tick(t % 2 === 0 ? VOX_BTN.start : 0);
    else break;
  }
  game.tick(0);
}

describe("the Pokemon Tower without the SILPH SCOPE", () => {
  /** The wild battle the grass would open on this map, as built. */
  function wildOn(map: string, inventory: Record<string, number>) {
    const game = makeMenuGame();
    game.overworld.setMap(map, 5, 5, "down");
    Object.assign(game.save.inventory, inventory);
    game.pushStubBattle("GASTLY", 20);
    return (game.battleView() as { battle: any } | null)?.battle;
  }

  test.skipIf(!hasGen)("a wild tower encounter is an ordinary fight, scope or no scope", () => {
    // Only the 6F MAROWAK is the GHOST (a departure from the ROM, which
    // disguises every wild mon in the tower until the scope is carried).
    expect(wildOn("POKEMON_TOWER_3F", {})?.disguised).toBe(false);
    expect(wildOn("POKEMON_TOWER_3F", {})?.enemy?.name).toBe("GASTLY");
    expect(wildOn("POKEMON_TOWER_3F", { SILPH_SCOPE: 1 })?.disguised).toBe(false);
    expect(wildOn("ROUTE_1", {})?.disguised).toBe(false);
  });

  test.skipIf(!hasGen)("the 6F MAROWAK is unveiled by the scope, not skipped by it", () => {
    const step = (MAP_SCRIPTS as any).POKEMON_TOWER_6F.onStep;
    const rowsFor = (inventory: Record<string, number>) =>
      step({ player: { cellX: 10, cellY: 16, facing: "up" } },
           { flags: {}, inventory }) as ScriptRow[] | null;
    const without = rowsFor({})!.find((r) => r[0] === "start_battle")!;
    const withScope = rowsFor({ SILPH_SCOPE: 1 })!.find((r) => r[0] === "start_battle")!;
    expect(without[4]).toEqual({ noCatch: true, disguised: true, unveil: false });
    expect(withScope[4]).toEqual({ noCatch: true, disguised: false, unveil: true });
  });

  test.skipIf(!hasGen)("the GHOST has a pic of its own in the cooked atlas", () => {
    // battle/front/ghost is cooked with the species pics, so the page sits
    // in every pak at the same index the dataset names.
    const shipped = JSON.parse(readFileSync(join(root, "dist/voxelmon/paks/gamedata.json"), "utf8"));
    const pf = shipped.atlas.picFront;
    expect(typeof pf.GHOST).toBe("number");
    expect(pf.GHOST).toBe(pf.GEODUDE + 1); // sorted between geodude and gloom
    expect(pf.GHOST).toBe(pf.GLOOM - 1);
  });
});

describe("the Rocket Hideout lift gate", () => {
  test.skipIf(!hasGen)("opens the moment the last guard falls, not on the next visit", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    const door = (romData as any).field.cardKeyDoors.closedDoors.ROCKET_HIDEOUT_B4F[0];
    ow.setMap("ROCKET_HIDEOUT_B4F", 2, 2, "down");
    // a shut door is the baked block, which the tile grid does not know
    // about: what changes when it opens is the door record (isOpenedDoor),
    // the same thing the load-time test reads
    const shut = () => !ow.map.isOpenedDoor(door.bx * 2, door.by * 2);
    const open = () => ow.map.isOpenedDoor(door.bx * 2, door.by * 2);
    expect(shut()).toBe(true);

    // one guard down: still shut -- CheckBothEventsSet wants both
    game.save.flags[door.events[0]] = true;
    ow.refreshDoors();
    expect(shut()).toBe(true);

    // the second falls: the gate goes on the spot, no reload
    game.save.flags[door.events[1]] = true;
    ow.refreshDoors();
    expect(open()).toBe(true);
    expect(ow.map.def.blocks[door.by * ow.map.def.width + door.bx]).toBe(door.open);

    // and running it again over an open door changes nothing
    ow.refreshDoors();
    expect(open()).toBe(true);
  });
});

describe("the save the Hall of Fame writes", () => {
  test.skipIf(!hasGen)("is written at home, wherever the player is standing", () => {
    const game = makeMenuGame();
    const host = (game as any).host as { saved?: string };
    game.overworld.setMap("HALL_OF_FAME", 4, 2, "left");
    game.writeSave(POST_GAME_HOME);
    const written = decodeSave(host.saved!) as any;
    expect(written.player.map).toBe("REDS_HOUSE_2F");
    expect([written.player.x, written.player.y]).toEqual([POST_GAME_HOME.x, POST_GAME_HOME.y]);
    // and an ordinary save still takes the live position
    game.writeSave();
    expect((decodeSave(host.saved!) as any).player.map).toBe("HALL_OF_FAME");
  });

  test.skipIf(!hasGen)("a save stranded in the hall by the old write comes home once", () => {
    const stranded = () => ({
      player: { map: "HALL_OF_FAME", x: 4, y: 2, facing: "left" },
      hallOfFame: [[{ species: "PIKACHU", level: 50 }]],
      flags: {} as Record<string, boolean>,
    });
    const s = stranded();
    expect(postGameRescue(s as never)).toBe(true);
    expect(s.player.map).toBe("REDS_HOUSE_2F");
    // the induction not yet run: the player is there to be crowned
    const pending = stranded();
    pending.flags.EVENT_HALL_OF_FAME_PENDING = true;
    expect(postGameRescue(pending as never)).toBe(false);
    expect(pending.player.map).toBe("HALL_OF_FAME");
    // never crowned at all: not a rescue case
    const visitor = stranded();
    visitor.hallOfFame = [];
    expect(postGameRescue(visitor as never)).toBe(false);
    // already home: nothing to do
    const home = stranded();
    home.player.map = "REDS_HOUSE_2F";
    expect(postGameRescue(home as never)).toBe(false);
  });
});

describe("surfing", () => {
  /** Slot 0's sheet and lift, frame by frame. */
  class SurfHost extends MenuHost {
    poses: { sheet: number; lift: number }[] = [];
    ent(slot: number, sheet: number, _frame: number, _x: number, _y: number,
        lift: number, _flags: number): void {
      if (slot === 0) this.poses.push({ sheet, lift });
    }
  }

  test.skipIf(!hasGen)("afloat, the player is the surf sprite and it bobs", () => {
    const host = new SurfHost();
    const game = new VoxelmonGame(romData!, host, 1);
    game.newGame();
    game.closeToOverworld();
    const ow = game.overworld;
    ow.setMap("PALLET_TOWN", 5, 6, "down");
    const atlas = (romData as any).atlas.sprites;

    // ashore: Red's own sheet, flat on the ground
    for (let t = 0; t < 8; t++) game.tick(0);
    expect(host.poses.at(-1)?.sheet).toBe(atlas.red);
    expect(host.poses.every((p) => p.lift === 0)).toBe(true);

    // find the water and get on it
    const m = ow.map;
    let spot: { x: number; y: number; facing: string } | null = null;
    const dirs: [number, number, string][] = [[0, 1, "down"], [0, -1, "up"], [1, 0, "right"], [-1, 0, "left"]];
    for (let y = 0; y < m.def.height * 2 && !spot; y++) {
      for (let x = 0; x < m.def.width * 2 && !spot; x++) {
        if (!m.isWalkableCell(x, y) || m.isWaterCell(x, y)) continue;
        for (const [dx, dy, facing] of dirs) {
          if (m.inBounds(x + dx, y + dy) && m.isWaterCell(x + dx, y + dy)) { spot = { x, y, facing }; break; }
        }
      }
    }
    ow.setMap("PALLET_TOWN", spot!.x, spot!.y, spot!.facing);
    expect(ow.canSurfHere()).toBe(true);
    ow.startSurfing();
    host.poses.length = 0;
    for (let t = 0; t < 80; t++) game.tick(0);
    // SPRITE_SEEL, the whole time; and the 1px sink for half of every 32
    expect(host.poses.every((p) => p.sheet === atlas.seel)).toBe(true);
    const lifts = new Set(host.poses.map((p) => p.lift));
    expect([...lifts].sort()).toEqual([-1, 0]);
  });
});

describe("the CAMERA SPEED option", () => {
  test.skipIf(!hasGen)("is a row on the OPTION screen and a multiplier the host reads", () => {
    const game = makeMenuGame();
    // unset: the tuned rate
    expect(game.cameraSpeedQ8()).toBe(256);
    const menu = new OptionsMenuState(game as never);
    const rows = () => menu.view().rows;
    const cam = rows().findIndex((r) => r.label === "CAMERA SPEED");
    expect(cam).toBeGreaterThanOrEqual(0);
    expect(rows()[cam]!.choices).toEqual(["SLOW", "NORMAL", "FAST"]);
    expect(rows()[cam]!.index).toBe(1);

    // walk down to the row and step it right: FAST
    (game as any).push?.(menu);
    for (let i = 0; i < cam; i++) tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.right);
    expect(game.save.options.cameraSpeed).toBe("fast");
    expect(game.cameraSpeedQ8()).toBe(448);
    expect(rows()[cam]!.index).toBe(2);
    // and left twice: SLOW, half the rate
    tap(game, VOX_BTN.left);
    tap(game, VOX_BTN.left);
    expect(game.save.options.cameraSpeed).toBe("slow");
    expect(game.cameraSpeedQ8()).toBe(128);
    // a value no build wrote reads as NORMAL rather than freezing the stick
    game.save.options.cameraSpeed = "ludicrous";
    expect(game.cameraSpeedQ8()).toBe(256);
  });
});

describe("HM FLASH", () => {
  const BRIGHT = 0xffffffff;

  /** The last scene tint the overworld set. */
  class TintHost extends MenuHost {
    tints: number[] = [];
    tint(abgr: number): void { this.tints.push(abgr >>> 0); }
  }

  test.skipIf(!hasGen)("lights every floor of the tunnel, and goes out outside", () => {
    const host = new TintHost();
    const game = new VoxelmonGame(romData!, host, 1);
    game.newGame();
    game.closeToOverworld();
    const ow = game.overworld;
    const last = () => host.tints.at(-1);

    ow.setMap("ROCK_TUNNEL_1F", 5, 5, "down");
    expect(last()).not.toBe(BRIGHT); // dark until FLASH
    ow.runScript([["use_flash"]]);
    dismissText(game);
    expect(game.save.flashLit).toBe(true);
    expect(last()).toBe(BRIGHT);

    // the next floor down is still lit: one cave, one FLASH
    ow.setMap("ROCK_TUNNEL_B1F", 5, 5, "down");
    expect(last()).toBe(BRIGHT);
    ow.setMap("ROCK_TUNNEL_1F", 5, 5, "down");
    expect(last()).toBe(BRIGHT);

    // stepping outside puts the light out; the tunnel is dark again next time
    ow.setMap("ROUTE_10", 5, 5, "down");
    expect(game.save.flashLit).toBeUndefined();
    expect(last()).toBe(BRIGHT);
    ow.setMap("ROCK_TUNNEL_1F", 5, 5, "down");
    expect(last()).not.toBe(BRIGHT);
  });
});

describe("using items (rules/items.ts)", () => {
  const mon = (species: string, level: number, hp?: number) => {
    const m = newMon(romData!, species, level);
    if (hp !== undefined) m.hp = hp;
    return m;
  };
  const save = () => ({ player: { name: "RED" }, inventory: {}, party: [] as any[], coins: 0 });

  test.skipIf(!hasGen)("a POTION restores 20, capped, and refuses at full HP", () => {
    const m = mon("PIDGEY", 20, 5);
    const r = Items.useItem(romData!, save(), "POTION", m, null);
    expect(r.kind).toBe("consumed");
    expect(m.hp).toBe(25);
    expect(r.healedFrom).toBe(5);
    expect(r.msgs[0]).toContain("recovered by 20");
    // capped at max
    m.hp = m.stats.hp - 3;
    Items.useItem(romData!, save(), "POTION", m, null);
    expect(m.hp).toBe(m.stats.hp);
    // full: no effect, and nothing is spent (the caller removes on consumed only)
    const full = Items.useItem(romData!, save(), "SUPER_POTION", m, null);
    expect(full.kind).toBe("failed");
    expect(full.msgs[0]).toContain("won't have any");
    // fainted: a potion is not a revive
    m.hp = 0;
    expect(Items.useItem(romData!, save(), "POTION", m, null).kind).toBe("failed");
  });

  test.skipIf(!hasGen)("a cure lifts its own status and no other", () => {
    const m = mon("PIDGEY", 20);
    m.status = "PSN";
    expect(Items.useItem(romData!, save(), "BURN_HEAL", m, null).kind).toBe("failed");
    expect(m.status).toBe("PSN");
    const r = Items.useItem(romData!, save(), "ANTIDOTE", m, null);
    expect(r.kind).toBe("consumed");
    expect(m.status).toBeNull();
    expect(r.msgs[0]).toContain("cured of poison");
    m.status = "PAR";
    expect(Items.useItem(romData!, save(), "FULL_HEAL", m, null).kind).toBe("consumed");
    expect(m.status).toBeNull();
    // a FULL RESTORE at full HP with a status acts as a FULL HEAL
    m.status = "BRN";
    const fr = Items.useItem(romData!, save(), "FULL_RESTORE", m, null);
    expect(fr.kind).toBe("consumed");
    expect(m.status).toBeNull();
  });

  test.skipIf(!hasGen)("a REVIVE brings half back, a MAX REVIVE all of it", () => {
    const m = mon("PIDGEY", 20, 0);
    m.status = "PSN";
    expect(Items.useItem(romData!, save(), "REVIVE", mon("PIDGEY", 20), null).kind).toBe("failed");
    const r = Items.useItem(romData!, save(), "REVIVE", m, null);
    expect(r.kind).toBe("consumed");
    expect(m.hp).toBe(Math.floor(m.stats.hp / 2));
    expect(m.status).toBeNull();
    expect(r.healedFrom).toBe(0);
    const k = mon("PIDGEY", 20, 0);
    Items.useItem(romData!, save(), "MAX_REVIVE", k, null);
    expect(k.hp).toBe(k.stats.hp);
  });

  test.skipIf(!hasGen)("an ETHER restores 10 PP of the move picked; an ELIXER every move", () => {
    const m = mon("PIDGEY", 20);
    const cap = Items.maxPP(romData!, m.moves[0]!)!;
    m.moves[0]!.pp = cap - 15;
    m.moves[1]!.pp = 0;
    const r = Items.useItem(romData!, save(), "ETHER", m, null, 0);
    expect(r.kind).toBe("consumed");
    expect(m.moves[0]!.pp).toBe(cap - 5);
    expect(m.moves[1]!.pp).toBe(0);
    Items.useItem(romData!, save(), "MAX_ELIXER", m, null);
    expect(m.moves[0]!.pp).toBe(cap);
    expect(m.moves[1]!.pp).toBe(Items.maxPP(romData!, m.moves[1]!));
    // nothing to restore: no effect
    expect(Items.useItem(romData!, save(), "ETHER", m, null, 0).kind).toBe("failed");
  });

  test.skipIf(!hasGen)("PP UP raises a move's ceiling three times, then no more", () => {
    const m = mon("PIDGEY", 20);
    const base = romData!.moves[m.moves[0]!.id]!.pp;
    for (let i = 1; i <= 3; i++) {
      expect(Items.useItem(romData!, save(), "PP_UP", m, null, 0).kind).toBe("consumed");
      expect(Items.maxPP(romData!, m.moves[0]!)).toBe(base + i * Math.floor(base / 5));
    }
    expect(Items.useItem(romData!, save(), "PP_UP", m, null, 0).kind).toBe("failed");
  });

  test.skipIf(!hasGen)("the X items and the DOLL work only in a fight, the DOLL only on a wild one", () => {
    const s = save();
    const me = { name: "PIDGEY", mon: mon("PIDGEY", 20), stages: {} as Record<string, number> };
    const foe = { name: "RATTATA", mon: mon("RATTATA", 5) };
    expect(Items.useItem(romData!, s, "X_ATTACK", null, null).kind).toBe("failed");
    const wild = { kind: "wild", player: me, enemy: foe };
    expect(Items.useItem(romData!, s, "X_ATTACK", null, wild).kind).toBe("consumed");
    expect(me.stages.attack).toBe(1);
    me.stages.attack = 6;
    const capped = Items.useItem(romData!, s, "X_ATTACK", null, wild);
    expect(capped.kind).toBe("consumed"); // spent all the same
    expect(capped.msgs[0]).toBe("Nothing happened!");
    expect(me.stages.attack).toBe(6);
    Items.useItem(romData!, s, "DIRE_HIT", null, wild);
    expect((me as any).focusEnergy).toBe(true);
    Items.useItem(romData!, s, "X_ACCURACY", null, wild);
    expect((me as any).xAccuracy).toBe(true);
    expect(Items.useItem(romData!, s, "POKE_DOLL", null, wild).kind).toBe("consumed_escape");
    expect(Items.useItem(romData!, s, "POKE_DOLL", null, { kind: "trainer", player: me, enemy: foe }).kind).toBe("failed");
    // and what a fight refuses
    expect(Items.useItem(romData!, s, "RARE_CANDY", me.mon, wild).kind).toBe("failed");
    expect(Items.useItem(romData!, s, "HP_UP", me.mon, wild).kind).toBe("failed");
  });

  test.skipIf(!hasGen)("a vitamin adds stat exp until the cap, and a stone names the evolution", () => {
    const m = mon("PIDGEY", 20);
    const before = m.stats.attack;
    expect(Items.useItem(romData!, save(), "PROTEIN", m, null).kind).toBe("consumed");
    expect((m.statExp as any).attack).toBe(2560);
    expect(m.stats.attack).toBeGreaterThanOrEqual(before);
    (m.statExp as any).attack = 25600;
    expect(Items.useItem(romData!, save(), "PROTEIN", m, null).kind).toBe("failed");
    const c = mon("CLEFAIRY", 20);
    const r = Items.useItem(romData!, save(), "MOON_STONE", c, null);
    expect(r.kind).toBe("consumed");
    expect(r.evolveTo).toBe("CLEFABLE");
    expect(Items.useItem(romData!, save(), "FIRE_STONE", c, null).kind).toBe("failed");
  });

  test.skipIf(!hasGen)("a REPEL runs for its steps and keeps the small fry away", () => {
    const s = save();
    s.party.push(mon("PIDGEY", 20));
    const r = Items.useItem(romData!, s, "SUPER_REPEL", null, null);
    expect(r.kind).toBe("consumed");
    expect((s as any).repelSteps).toBe(200);
    expect(Items.repelled(s as any, 12)).toBe(true);
    expect(Items.repelled(s as any, 20)).toBe(false); // the lead's level is not under it
    (s as any).repelSteps = 0;
    expect(Items.repelled(s as any, 12)).toBe(false);
  });

  test.skipIf(!hasGen)("from the bag: a POTION heals the picked mon and is spent", () => {
    const game = makeMenuGame();
    game.save.party.push(newMon(romData!, "SQUIRTLE", 10, game.battleRng));
    const m = game.save.party[0]!;
    m.hp = 3;
    game.save.inventory.POTION = 2;
    game.useItem(0, "POTION");
    dismissText(game);
    expect(m.hp).toBe(23);
    expect(game.save.inventory.POTION).toBe(1);
    // and an X item from the bag is OAK's "not the time", unspent
    game.save.inventory.X_ATTACK = 1;
    game.useKeyItem("X_ATTACK");
    expect(game.stackKinds().at(-1)).toBe("textbox");
    dismissText(game);
    expect(game.save.inventory.X_ATTACK).toBe(1);
  });

  test.skipIf(!hasGen)("in a fight: an X ATTACK from the ITEM list spends the turn", () => {
    const game = makeMenuGame();
    game.save.party.push(newMon(romData!, "SQUIRTLE", 30, game.battleRng));
    game.save.inventory.X_ATTACK = 1;
    game.overworld.setMap("ROUTE_1", 5, 5, "down");
    game.pushStubBattle("PIDGEY", 3);
    for (let t = 0; t < 4000; t++) {
      const b = (game.battleView() as any)?.battle;
      if (b?.phase === "menu") break;
      game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    }
    const b = (game.battleView() as any).battle;
    b.openItems();
    expect(b.phase).toBe("item");
    b.itemIndex = b.itemList.indexOf("X_ATTACK");
    expect(b.itemIndex).toBeGreaterThanOrEqual(0);
    tap(game, VOX_BTN.a);
    expect(b.player.stages.attack).toBe(1);
    expect(game.save.inventory.X_ATTACK).toBeUndefined();
    for (let t = 0; t < 600 && b.phase === "messages"; t++) game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    expect(b.phase).toBe("menu");
    expect(b.messageLog.some((m: string) => m.includes("ATTACK rose"))).toBe(true);
    // the foe had its move
    expect(b.messageLog.some((m: string) => m.includes("Enemy PIDGEY\nused"))).toBe(true);
  });
});

describe("the DEV menu option", () => {
  test.skipIf(!hasGen)("is off the pause menu until the OPTION screen turns it on", () => {
    const game = makeMenuGame();
    tap(game, VOX_BTN.start);
    expect((game.startMenu() as { entries: string[] }).entries).not.toContain("DEV");
    tap(game, VOX_BTN.b);

    // turn it on from OPTION, which is where it lives now
    const menu = new OptionsMenuState(game as never);
    const rows = menu.view().rows;
    const dev = rows.findIndex((r) => r.label === "DEV MENU");
    expect(dev).toBeGreaterThanOrEqual(0);
    expect(rows[dev]!.choices).toEqual(["OFF", "ON"]);
    expect(rows[dev]!.index).toBe(0);
    (game as any).push?.(menu);
    for (let i = 0; i < dev; i++) tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.right);
    expect(game.save.options.devMenu).toBe(true);
    tap(game, VOX_BTN.b);

    // and now it is there, above EXIT
    tap(game, VOX_BTN.start);
    const entries = (game.startMenu() as { entries: string[] }).entries;
    expect(entries).toContain("DEV");
    expect(entries.indexOf("DEV")).toBe(entries.indexOf("EXIT") - 1);
  });
});

describe("LT. SURGE's trash cans", () => {
  const byte = (...v: number[]) => { let i = 0; return () => v[Math.min(i++, v.length - 1)]!; };
  const fresh = () => ({ flags: {} as Record<string, boolean> });

  test.skipIf(!hasGen)("the first switch is in an even can, and only that one opens it", () => {
    const data = romData!;
    // Random & $0e: 0,2,4..14 and nothing odd, whatever byte comes back
    for (let b = 0; b < 256; b++) {
      const c = Trash.rollFirst(() => b);
      expect(c % 2).toBe(0);
      expect(c).toBeLessThanOrEqual(14);
    }
    const save = fresh();
    save.trashPuzzle = { first: 6 } as never;
    expect(Trash.openCan(data, save as never, 7, byte(0)).kind).toBe("trash");
    expect(save.flags[Trash.FIRST_LOCK]).toBeFalsy();
    const hit = Trash.openCan(data, save as never, 6, byte(1));
    expect(hit.kind).toBe("first");
    expect(save.flags[Trash.FIRST_LOCK]).toBe(true);
  });

  test.skipIf(!hasGen)("the second switch hides next to the first, and opens the door", () => {
    const data = romData!;
    const adj = (data as any).field.hiddenExtras.trashCans.adjacent["6"] as number[];
    const save = fresh();
    save.trashPuzzle = { first: 6 } as never;
    // masked = byte & adj.length, offset by one into the candidates
    const r = Trash.openCan(data, save as never, 6, byte(1));
    expect(r.kind).toBe("first");
    const second = (r as { second: number }).second;
    expect(adj).toContain(second);
    expect(Trash.openCan(data, save as never, second, byte(0)).kind).toBe("second");
    expect(save.flags[Trash.SECOND_LOCK]).toBe(true);
    // solved: every can is just trash again
    expect(Trash.openCan(data, save as never, second, byte(0)).kind).toBe("trash");
  });

  test.skipIf(!hasGen)("a wrong second guess resets both locks and moves the first", () => {
    const data = romData!;
    const save = fresh();
    save.trashPuzzle = { first: 6 } as never;
    Trash.openCan(data, save as never, 6, byte(1));
    const second = (save as any).trashPuzzle.second as number;
    const wrong = [0, 1, 2, 3, 4, 5, 7, 8].find((c) => c !== second)!;
    const r = Trash.openCan(data, save as never, wrong, byte(8));
    expect(r.kind).toBe("fail");
    expect(save.flags[Trash.FIRST_LOCK]).toBe(false);
    expect((save as any).trashPuzzle.second).toBeUndefined();
    expect((save as any).trashPuzzle.first % 2).toBe(0);
  });

  test.skipIf(!hasGen)("a result of 0 lands the switch in can 0 (the GymTrashCans bug)", () => {
    // `dec a` underflows and the read lands on the bank's zero padding.
    expect(Trash.rollSecond([1, 3], () => 0)).toBe(0);
    expect(Trash.rollSecond([1, 3], () => 4)).toBe(0); // 4 & 2 == 0
  });

  test.skipIf(!hasGen)("in the gym: A on the right can opens the lock, and the door goes", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    const cans = (romData as any).field.hiddenExtras.trashCans.cans as { can: number; x: number; y: number }[];
    ow.setMap("VERMILION_GYM", 5, 5, "down");
    (game.save as any).trashPuzzle = { first: cans[0]!.can };
    // stand on the can's tile and face it
    const c = cans[0]!;
    ow.setMap("VERMILION_GYM", c.x, c.y + 1, "up");
    ow.interact();
    expect(topText(game)).toContain("1st electric");
    dismissText(game);
    expect(game.save.flags[Trash.FIRST_LOCK]).toBe(true);

    // the second, wherever it landed
    const second = (game.save as any).trashPuzzle.second as number;
    const sc = cans.find((x) => x.can === second)!;
    ow.setMap("VERMILION_GYM", sc.x, sc.y + 1, "up");
    ow.interact();
    expect(topText(game)).toContain("motorized door");
    dismissText(game);
    expect(game.save.flags[Trash.SECOND_LOCK]).toBe(true);
    // the doorway is open, and stays open on the next visit
    const door = Trash.DOOR_BLOCK;
    expect(ow.map.def.blocks[door.by * ow.map.def.width + door.bx]).toBe(door.block);
    ow.setMap("VERMILION_CITY", 5, 5, "down");
    ow.setMap("VERMILION_GYM", 5, 5, "down");
    expect(ow.map.def.blocks[door.by * ow.map.def.width + door.bx]).toBe(door.block);
  });

  test.skipIf(!hasGen)("walking into Vermilion City moves the first switch", () => {
    const game = makeMenuGame();
    (game.save as any).trashPuzzle = { first: 99 };
    game.overworld.setMap("VERMILION_CITY", 5, 5, "down");
    const rolled = (game.save as any).trashPuzzle.first as number;
    expect(rolled % 2).toBe(0);
    expect(rolled).toBeLessThanOrEqual(14);
  });
});

describe("the Route 1 sample man", () => {
  test.skipIf(!hasGen)("hands over one POTION, then talks about POKe BALLs", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    ow.setMap("ROUTE_1", 5, 5, "down");
    expect(game.save.inventory.POTION ?? 0).toBe(0);

    ow.showMapText("TEXT_ROUTE1_YOUNGSTER1");
    dismissText(game);
    expect(game.save.inventory.POTION).toBe(1);
    expect(game.save.flags.EVENT_GOT_POTION_SAMPLE).toBe(true);

    // a second time is the mart plug, not another potion
    ow.showMapText("TEXT_ROUTE1_YOUNGSTER1");
    expect(topText(game)).toContain("POKé BALL");
    dismissText(game);
    expect(game.save.inventory.POTION).toBe(1);
  });
});

describe("a map's own script on arrival", () => {
  test.skipIf(!hasGen)("the VIRIDIAN MART clerk calls you over as you walk in", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    game.save.flags.EVENT_GOT_STARTER = true;

    // walk in through the city's mart door rather than warping by hand
    ow.setMap("VIRIDIAN_CITY", 5, 5, "down");
    const mart = ow.map.def.warps.findIndex((w: any) => w.destMap === "VIRIDIAN_MART");
    expect(mart).toBeGreaterThanOrEqual(0);
    const w = ow.map.def.warps[mart];
    ow.setMap("VIRIDIAN_MART", 3, 7, "down");

    // no step taken: the tile walked in on is enough
    for (let t = 0; t < 240; t++) game.tick(0);
    expect(topText(game)).toContain("PALLET TOWN");
    // and it plays out into the parcel
    for (let t = 0; t < 4000 && !game.save.flags.EVENT_GOT_OAKS_PARCEL; t++) {
      game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(game.save.inventory.OAKS_PARCEL).toBe(1);
    expect(w).toBeDefined();
  });

  test.skipIf(!hasGen)("a map whose trigger declines is left alone", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    // no starter: the clerk has nothing to say, and nothing else fires
    game.save.flags.EVENT_GOT_STARTER = false;
    ow.setMap("VIRIDIAN_MART", 3, 7, "down");
    for (let t = 0; t < 240; t++) game.tick(0);
    expect(game.stackKinds()).toEqual(["overworld"]);
    // and the player can still walk
    const before = ow.player.cellY;
    for (let t = 0; t < 40; t++) game.tick(VOX_BTN.up);
    expect(ow.player.cellY).toBeLessThan(before);
  });
});

describe("the NAME RATER", () => {
  /** Drive his flow: YES/NO answers in order, then the keyboard. */
  function raterGame() {
    const game = makeMenuGame();
    game.save.party.push(newMon(romData!, "SQUIRTLE", 10, game.battleRng));
    game.overworld.setMap("NAME_RATERS_HOUSE", 5, 4, "up");
    return game;
  }
  /** Mash through text until a screen of `kind` is on top, then stop. */
  const until = (game: VoxelmonGame, kind: string, max = 900): void => {
    for (let t = 0; t < max; t++) {
      if (game.stackKinds().at(-1) === kind) return;
      game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    }
  };
  /** Answer the YES/NO box on top, and let it close. */
  const answer = (game: VoxelmonGame, yes: boolean) => {
    until(game, "choice");
    if (game.stackKinds().at(-1) !== "choice") return;
    if (!yes) tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.a);
    for (let h = 0; h < 60 && game.stackKinds().at(-1) === "choice"; h++) game.tick(0);
  };

  test.skipIf(!hasGen)("renames the mon you pick", () => {
    const game = raterGame();
    game.overworld.showMapText("TEXT_NAMERATERSHOUSE_NAME_RATER");
    answer(game, true); // rate them? yes
    // "Which POKeMON?" then the party list
    until(game, "party");
    expect(game.stackKinds().at(-1)).toBe("party");
    tap(game, VOX_BTN.a); // the first mon
    answer(game, true); // a nicer name? yes
    // the keyboard: type one glyph and confirm with START
    until(game, "naming");
    expect(game.stackKinds().at(-1)).toBe("naming");
    tap(game, VOX_BTN.a); // one letter
    tap(game, VOX_BTN.start);
    dismissText(game, 800);
    const mon = game.save.party[0]!;
    expect(mon.nickname).toBeTruthy();
    expect(mon.nickname).not.toBe("SQUIRTLE");
  });

  test.skipIf(!hasGen)("will not touch a traded mon, and takes no for an answer", () => {
    /**
     * One visit, saying YES to everything and typing a name if he offers
     * the keyboard. Returns whether it ever got that far.
     */
    const visit = (game: VoxelmonGame, yes: boolean): boolean => {
      let named = false;
      game.overworld.showMapText("TEXT_NAMERATERSHOUSE_NAME_RATER");
      for (let t = 0; t < 900; t++) {
        const top = game.stackKinds().at(-1);
        if (top === "overworld") break;
        if (top === "choice") {
          if (!yes) tap(game, VOX_BTN.down);
          tap(game, VOX_BTN.a);
          for (let h = 0; h < 60 && game.stackKinds().at(-1) === "choice"; h++) game.tick(0);
          continue;
        }
        if (top === "party") { tap(game, VOX_BTN.a); continue; }
        if (top === "naming") {
          named = true;
          tap(game, VOX_BTN.a);
          tap(game, VOX_BTN.start);
          continue;
        }
        game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
      }
      return named;
    };

    // A traded mon is refused: NameRatersHouseCheckMonOTScript never gets
    // to the keyboard, however willing the player is.
    const traded = raterGame();
    traded.save.party[0]!.traded = true;
    expect(visit(traded, true)).toBe(false);
    expect(traded.save.party[0]!.nickname).toBeUndefined();

    // the same mon, not traded: he does offer the keyboard
    const own = raterGame();
    expect(visit(own, true)).toBe(true);

    // and a "no" at the door ends the visit with nothing renamed
    const shy = raterGame();
    expect(visit(shy, false)).toBe(false);
    expect(shy.save.party[0]!.nickname).toBeUndefined();
    expect(shy.stackKinds()).toEqual(["overworld"]);
  });
});

describe("a trainer who has already lost", () => {
  /** The first sight-line trainer on a route, and its header. */
  function trainerOn(game: VoxelmonGame, map: string) {
    const ow = game.overworld;
    ow.setMap(map, 5, 5, "down");
    const npc = ow.npcs.find((n: any) => n.def.trainerClass);
    expect(npc).toBeDefined();
    return { ow, npc, header: ow.trainerHeader(npc) };
  }

  test.skipIf(!hasGen)("says their after-battle line instead of fighting again", () => {
    const game = makeMenuGame();
    const { ow, npc, header } = trainerOn(game, "ROUTE_3");
    expect(header?.after).toBeTruthy();

    // beaten, however it was recorded: the flag OR the per-object record
    game.save.flags[header!.event!] = true;
    expect(ow.trainerDefeated(npc)).toBe(true);

    const p = ow.player;
    p.cellX = npc.cellX;
    p.cellY = npc.cellY + 1;
    p.facing = "up";
    ow.interact();
    // the after line, and no battle. topText joins the box's pages with
    // spaces, so compare on the words rather than the line breaks.
    const words = (x: string) => x.replace(/[\n\f\u000b]+/g, " ").trim();
    expect(words(topText(game))).toBe(words((romData as any).text[header!.after!]));
    expect(game.stackKinds()).not.toContain("battle");
  });

  test.skipIf(!hasGen)("stays beaten when the win was recorded by object, not flag", () => {
    const game = makeMenuGame();
    const { ow, npc } = trainerOn(game, "ROUTE_3");
    (game.save as any).defeatedTrainers = { [npc.id]: true };
    expect(ow.trainerDefeated(npc)).toBe(true);
    const p = ow.player;
    p.cellX = npc.cellX;
    p.cellY = npc.cellY + 1;
    p.facing = "up";
    ow.interact();
    expect(game.stackKinds()).not.toContain("battle");
    expect(game.stackKinds().at(-1)).toBe("textbox");
  });

  test.skipIf(!hasGen)("a trainer who spots you scores the moment the ! goes up", () => {
    const game = makeMenuGame();
    const host = (game as any).host as { music?: string[] };
    const { ow, npc, header } = trainerOn(game, "ROUTE_3");
    expect(header?.range).toBeGreaterThan(0);

    // stand in the line of sight, one cell along the way they face
    const step: Record<string, [number, number]> = {
      up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
    };
    const [dx, dy] = step[npc.facing as string]!;
    ow.player.cellX = npc.cellX + dx;
    ow.player.cellY = npc.cellY + dy;
    ow.player.px = ow.player.cellX * 16;
    ow.player.py = ow.player.cellY * 16;
    ow.checkTrainerSight();
    // the "!" is up and the encounter sting has started, before the walk-up
    expect((ow as any).emote).toBeDefined();
    expect((ow as any).engaging).toBe(true);
  });
});

describe("the party menu and the status screens, as the GB lays them out", () => {
  function partyGame() {
    const game = makeMenuGame();
    game.save.party.push(newMon(romData!, "SQUIRTLE", 12, game.battleRng));
    game.save.party.push(newMon(romData!, "PIDGEY", 9, game.battleRng));
    game.save.party[1]!.hp = 0;
    return game;
  }

  test.skipIf(!hasGen)("the party view says what it was opened for, and has no CANCEL row", () => {
    const game = partyGame();
    tap(game, VOX_BTN.start);
    const sm = game.startMenu() as { entries: string[] };
    pick(game, sm.entries.indexOf("POKéMON"));
    const pv = game.party() as any;
    expect(pv.prompt).toBe("Choose a POKéMON.");
    expect(pv.entries.map((e: any) => e.species)).toEqual(["SQUIRTLE", "PIDGEY"]);
    // two mons: the cursor wraps between them, never onto a third row
    expect(pv.index).toBe(0);
    tap(game, VOX_BTN.down);
    expect((game.party() as any).index).toBe(1);
    tap(game, VOX_BTN.down);
    expect((game.party() as any).index).toBe(0);
    // B leaves
    tap(game, VOX_BTN.b);
    expect(game.stackKinds().at(-1)).toBe("startmenu");
    // the icons ride the pic layer, one per mon, in the two-cell nooks
    tap(game, VOX_BTN.a);
    const pics = game.pic() as { x: number; y: number; w: number; h: number }[];
    expect(pics.length).toBe(2);
    expect(pics[1]!.y).toBeGreaterThan(pics[0]!.y);
  });

  test.skipIf(!hasGen)("a SWITCH says where to, and a chooser says what it is for", () => {
    const game = partyGame();
    tap(game, VOX_BTN.start);
    const sm = game.startMenu() as { entries: string[] };
    pick(game, sm.entries.indexOf("POKéMON"));
    tap(game, VOX_BTN.a); // the submenu
    const items = (game.party() as any).submenuItems as string[];
    pick(game, items.indexOf("SWITCH"));
    expect((game.party() as any).prompt).toContain("where?");
    // a chooser opened for an item
    game.closeToOverworld();
    game.push(new PartyState(game as never, { onPick: () => {} }));
    expect((game.party() as any).prompt).toContain("Use item on which");
  });

  test.skipIf(!hasGen)("STATS is two pages: stats, then EXP and the moves", () => {
    const game = partyGame();
    const mon = game.save.party[0]!;
    tap(game, VOX_BTN.start);
    const sm = game.startMenu() as { entries: string[] };
    pick(game, sm.entries.indexOf("POKéMON"));
    tap(game, VOX_BTN.a);
    const items = (game.party() as any).submenuItems as string[];
    pick(game, items.indexOf("STATS"));
    expect(game.stackKinds().at(-1)).toBe("summary");
    const p1 = game.summary() as any;
    expect(p1.page).toBe(1);
    expect(p1.speciesId).toBe("SQUIRTLE");
    expect(p1.dex).toBe(7);
    expect(p1.otName).toBe(game.save.player.name);
    expect(p1.otId).toBe(game.save.player.id);
    expect(p1.types).toEqual(["WATER"]);
    // the pic sits on the layer while the screen is up
    expect((game.pic() as unknown[]).length).toBe(1);
    // A turns the page
    tap(game, VOX_BTN.a);
    const p2 = game.summary() as any;
    expect(p2.page).toBe(2);
    expect(p2.exp).toBe(mon.exp);
    expect(p2.nextLevel).toBe(13);
    expect(p2.expToNext).toBeGreaterThan(0);
    expect(p2.moves[0].maxPp).toBeGreaterThanOrEqual(p2.moves[0].pp);
    // and A again closes
    tap(game, VOX_BTN.a);
    expect(game.stackKinds().at(-1)).toBe("party");
  });
});

describe("the FIGHTING DOJO prize", () => {
  /** Talk to a dojo object and answer its YES/NO; returns what was said. */
  function talk(game: VoxelmonGame, text: string, yes = true): string {
    let said = "";
    game.overworld.showMapText(text);
    for (let t = 0; t < 900; t++) {
      const top = game.stackKinds().at(-1);
      if (top === "overworld") break;
      if (top === "textbox") said += topText(game) + " ";
      if (top === "choice") {
        if (!yes) tap(game, VOX_BTN.down);
        tap(game, VOX_BTN.a);
        for (let h = 0; h < 60 && game.stackKinds().at(-1) === "choice"; h++) game.tick(0);
        continue;
      }
      if (top === "naming") { tap(game, VOX_BTN.start); continue; }
      game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    }
    return said;
  }

  test.skipIf(!hasGen)("the balls refuse until the master is beaten, then give one mon", () => {
    const game = makeMenuGame();
    game.save.party.push(newMon(romData!, "SQUIRTLE", 40, game.battleRng));
    const ow = game.overworld;
    ow.setMap("FIGHTING_DOJO", 4, 2, "up");

    // before the master: nothing to take
    expect(talk(game, "TEXT_FIGHTINGDOJO_HITMONLEE_POKE_BALL")).toContain("beat the master");
    expect(game.save.party.length).toBe(1);

    // beaten (the fight itself is engage_trainer's, tested elsewhere)
    game.save.flags.EVENT_BEAT_KARATE_MASTER = true;
    expect(talk(game, "TEXT_FIGHTINGDOJO_KARATE_MASTER")).toContain("Stay and train");

    // a "no" leaves the ball where it is
    expect(talk(game, "TEXT_FIGHTINGDOJO_HITMONLEE_POKE_BALL", false)).toContain("hard kicking");
    expect(game.save.party.length).toBe(1);

    // take HITMONLEE: it joins, its ball goes, the dojo is done
    talk(game, "TEXT_FIGHTINGDOJO_HITMONLEE_POKE_BALL", true);
    expect(game.save.party.length).toBe(2);
    expect(game.save.party[1]!.species).toBe("HITMONLEE");
    expect(game.save.party[1]!.level).toBe(30);
    expect(game.save.flags.EVENT_GOT_HITMONLEE).toBe(true);
    expect(game.save.flags.EVENT_DEFEATED_FIGHTING_DOJO).toBe(true);
    const lee = ow.npcs.find((n: any) => n.def.name === "FIGHTINGDOJO_HITMONLEE_POKE_BALL");
    expect(!lee || (lee as any).hidden).toBe(true);

    // the other ball stays, and knows better
    expect(talk(game, "TEXT_FIGHTINGDOJO_HITMONCHAN_POKE_BALL")).toContain("greedy");
    expect(game.save.party.length).toBe(2);
  });

  test.skipIf(!hasGen)("a full party keeps the ball on the mat", () => {
    const game = makeMenuGame();
    while (game.save.party.length < 6) {
      game.save.party.push(newMon(romData!, "RATTATA", 5, game.battleRng));
    }
    game.save.flags.EVENT_BEAT_KARATE_MASTER = true;
    game.overworld.setMap("FIGHTING_DOJO", 4, 2, "up");
    expect(talk(game, "TEXT_FIGHTINGDOJO_HITMONCHAN_POKE_BALL", true)).toContain("no room");
    expect(game.save.flags.EVENT_GOT_HITMONCHAN).toBeUndefined();
    expect(game.save.party.length).toBe(6);
  });
});

describe("hidden items", () => {
  const spotOn = (map: string) => {
    const list = (romData as any).field.hiddenItems[map] as { x: number; y: number; item: string }[];
    expect(list?.length).toBeGreaterThan(0);
    return list[0]!;
  };

  test.skipIf(!hasGen)("A on the tile finds it once, and a full bag leaves it", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    const h = spotOn("CELADON_CITY");
    ow.setMap("CELADON_CITY", h.x, h.y + 1, "up");
    ow.interact();
    expect(topText(game)).toContain("found");
    expect(topText(game)).toContain((romData as any).items[h.item].name);
    dismissText(game);
    expect(game.save.inventory[h.item]).toBe(1);
    expect(game.save.hiddenTaken[Hidden.hiddenKey("CELADON_CITY", h.x, h.y)]).toBe(true);
    // gone now: the press falls through to nothing
    ow.interact();
    expect(game.stackKinds()).toEqual(["overworld"]);
  });

  test.skipIf(!hasGen)("a full bag announces the find and keeps the spot", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    const h = spotOn("CERULEAN_CAVE_1F");
    // twenty different items: the bag is full
    const ids = Object.keys((romData as any).items).filter((id) => id !== h.item).slice(0, 20);
    for (const id of ids) game.save.inventory[id] = 1;
    ow.setMap("CERULEAN_CAVE_1F", h.x, h.y + 1, "up");
    ow.interact();
    expect(topText(game)).toContain("no more room");
    dismissText(game);
    expect(game.save.inventory[h.item]).toBeUndefined();
    expect(game.save.hiddenTaken?.[Hidden.hiddenKey("CERULEAN_CAVE_1F", h.x, h.y)]).toBeUndefined();
  });

  test.skipIf(!hasGen)("hidden coins need the COIN CASE and go into it", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    const c = ((romData as any).field.hiddenCoins.GAME_CORNER as { x: number; y: number; coins: number }[])[0]!;
    ow.setMap("GAME_CORNER", c.x, c.y + 1, "up");
    ow.interact();
    expect(game.save.coins ?? 0).toBe(0); // no case: nothing
    dismissText(game);
    game.save.inventory.COIN_CASE = 1;
    ow.interact();
    expect(topText(game)).toContain("coins");
    dismissText(game);
    expect(game.save.coins).toBe(c.coins);
  });

  test.skipIf(!hasGen)("the ITEMFINDER answers by the window around the player", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    const h = spotOn("CELADON_CITY");
    game.save.inventory.ITEMFINDER = 1;
    ow.setMap("CELADON_CITY", h.x - 2, h.y + 2, "down");
    expect(ow.hiddenItemNearby()).toBe(true);
    game.useKeyItem("ITEMFINDER");
    expect(topText(game)).toContain("nearby");
    dismissText(game);
    // taken: nothing left to point at
    game.save.hiddenTaken = { [Hidden.hiddenKey("CELADON_CITY", h.x, h.y)]: true };
    expect(ow.hiddenItemNearby()).toBe(false);
    game.useKeyItem("ITEMFINDER");
    expect(topText(game)).toContain("isn't responding");
    dismissText(game);
    // pure window: the clamp excludes coordinate 0 near the top-left
    const data = { field: { hiddenItems: { M: [{ x: 0, y: 0, item: "POTION" }] } } };
    expect(Hidden.hiddenItemNear(data, { inventory: {} }, "M", 3, 3)).toBe(false);
    expect(Hidden.hiddenItemNear({ field: { hiddenItems: { M: [{ x: 1, y: 1, item: "POTION" }] } } },
      { inventory: {} }, "M", 3, 3)).toBe(true);
  });
});

describe("EEVEE and the stones", () => {
  /** Talk to the ball; A through everything, START past the keyboard. */
  function takeBall(game: VoxelmonGame): void {
    game.overworld.showMapText("TEXT_CELADONMANSION_ROOF_HOUSE_EEVEE_POKEBALL");
    for (let t = 0; t < 900; t++) {
      const top = game.stackKinds().at(-1);
      if (top === "overworld") break;
      if (top === "naming") { tap(game, VOX_BTN.start); continue; }
      game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    }
  }

  test.skipIf(!hasGen)("the ball on the table gives an EEVEE, once", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    ow.setMap("CELADON_MANSION_ROOF_HOUSE", 4, 4, "up");
    takeBall(game);
    expect(game.save.party.length).toBe(1);
    expect(game.save.party[0]!.species).toBe("EEVEE");
    expect(game.save.party[0]!.level).toBe(25);
    expect(game.save.flags.EVENT_GOT_EEVEE).toBe(true);
    const ball = ow.npcs.find((n: any) => n.def.name === "CELADONMANSION_ROOF_HOUSE_EEVEE_POKEBALL");
    expect(!ball || (ball as any).hidden).toBe(true);
    // and it is not on the table next time in
    ow.setMap("CELADON_CITY", 5, 5, "down");
    ow.setMap("CELADON_MANSION_ROOF_HOUSE", 4, 4, "up");
    expect(ow.npcs.some((n: any) => n.def.name === "CELADONMANSION_ROOF_HOUSE_EEVEE_POKEBALL" && !n.hidden))
      .toBe(false);
    takeBall(game);
    expect(game.save.party.length).toBe(1);
  });

  /** Use a stone from the bag on party slot 0 and let the movie play. */
  function useStone(game: VoxelmonGame, stone: string): void {
    game.save.inventory[stone] = 1;
    game.useItem(0, stone);
    for (let t = 0; t < 6000; t++) {
      const top = game.stackKinds().at(-1);
      if (top === "overworld") break;
      if (top === "naming" || top === "moveforget") { tap(game, VOX_BTN.start); continue; }
      game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    }
  }

  test.skipIf(!hasGen)("each stone turns it into its own form, and the stone is spent", () => {
    for (const [stone, form] of [
      ["FIRE_STONE", "FLAREON"], ["THUNDER_STONE", "JOLTEON"], ["WATER_STONE", "VAPOREON"],
    ] as const) {
      const game = makeMenuGame();
      game.save.party.push(newMon(romData!, "EEVEE", 25, game.battleRng));
      game.overworld.setMap("PALLET_TOWN", 5, 6, "down");
      useStone(game, stone);
      expect(game.save.party[0]!.species).toBe(form);
      expect(game.save.inventory[stone]).toBeUndefined();
      expect(game.save.pokedex?.owned?.[form]).toBe(true);
    }
  });

  test.skipIf(!hasGen)("the new form stays on screen under the congratulations", () => {
    const game = makeMenuGame();
    game.save.party.push(newMon(romData!, "EEVEE", 25, game.battleRng));
    game.overworld.setMap("PALLET_TOWN", 5, 6, "down");
    game.save.inventory.FIRE_STONE = 1;
    game.useItem(0, "FIRE_STONE");
    // run the movie out to its last page: a textbox over the evolution
    let seen = false;
    for (let t = 0; t < 6000; t++) {
      const kinds = game.stackKinds();
      if (kinds.at(-1) === "textbox" && kinds.at(-2) === "evolution") { seen = true; break; }
      if (kinds.at(-1) === "naming" || kinds.at(-1) === "moveforget") { tap(game, VOX_BTN.start); continue; }
      game.tick(0);
    }
    expect(seen).toBe(true);
    expect(topText(game)).toContain("FLAREON");
    const pics = game.pic() as { page: number }[];
    expect(pics.length).toBe(1);
    expect(pics[0]!.page).toBe(picPageFor(romData as never, "FLAREON"));
  });

  test.skipIf(!hasGen)("a stone the mon cannot use has no effect and is kept", () => {
    const game = makeMenuGame();
    game.save.party.push(newMon(romData!, "EEVEE", 25, game.battleRng));
    game.overworld.setMap("PALLET_TOWN", 5, 6, "down");
    useStone(game, "MOON_STONE");
    expect(game.save.party[0]!.species).toBe("EEVEE");
    expect(game.save.inventory.MOON_STONE).toBe(1);
    // and the other stone users still work: a MOON STONE on a CLEFAIRY
    const g2 = makeMenuGame();
    g2.save.party.push(newMon(romData!, "CLEFAIRY", 20, g2.battleRng));
    g2.overworld.setMap("PALLET_TOWN", 5, 6, "down");
    useStone(g2, "MOON_STONE");
    expect(g2.save.party[0]!.species).toBe("CLEFABLE");
  });
});

describe("the TM givers", () => {
  /** Talk, then A through every page until the world is back on top. */
  function talkThrough(game: VoxelmonGame, key: string): void {
    game.overworld.showMapText(key);
    for (let t = 0; t < 3000; t++) {
      if (game.stackKinds().at(-1) === "overworld") break;
      game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(game.stackKinds().at(-1)).toBe("overworld");
  }

  const GIVERS = [
    ["MR_PSYCHICS_HOUSE", 4, 4, "TEXT_MRPSYCHICSHOUSE_MR_PSYCHIC", "TM_PSYCHIC_M", "EVENT_GOT_TM29", "PSYCHIC"],
    ["ROUTE_12_GATE_2F", 3, 3, "TEXT_ROUTE12GATE2F_BRUNETTE_GIRL", "TM_SWIFT", "EVENT_GOT_TM39", "SWIFT"],
    ["CELADON_CITY", 22, 17, "TEXT_CELADONCITY_GRAMPS3", "TM_SOFTBOILED", "EVENT_GOT_TM41", "SOFTBOILED"],
    ["CINNABAR_LAB_METRONOME_ROOM", 6, 2, "TEXT_CINNABARLABMETRONOMEROOM_SCIENTIST1", "TM_METRONOME", "EVENT_GOT_TM35", "METRONOME"],
    ["VIRIDIAN_CITY", 5, 5, "TEXT_VIRIDIANCITY_FISHER", "TM_DREAM_EATER", "EVENT_GOT_TM42", "DREAM EATER"],
    ["CELADON_MART_3F", 5, 5, "TEXT_CELADONMART3F_CLERK", "TM_COUNTER", "EVENT_GOT_TM18", "COUNTER"],
    ["SILPH_CO_2F", 10, 2, "TEXT_SILPHCO2F_SILPH_WORKER_F", "TM_SELFDESTRUCT", "EVENT_GOT_TM36", "SELFDESTRUCT"],
  ] as const;

  test.skipIf(!hasGen)("each hands over the TM once, then only explains it", () => {
    for (const [map, x, y, key, item, flag, word] of GIVERS) {
      const game = makeMenuGame();
      const ow = game.overworld;
      ow.setMap(map, x, y, "down");
      expect(game.save.inventory[item] ?? 0).toBe(0);
      talkThrough(game, key);
      expect(game.save.inventory[item]).toBe(1);
      expect(game.save.flags[flag]).toBe(true);
      // again: the explanation, and no second TM
      ow.showMapText(key);
      expect(topText(game)).toContain(word);
      talkThrough(game, key);
      expect(game.save.inventory[item]).toBe(1);
    }
  });

  test.skipIf(!hasGen)("a full bag halts the gift and keeps it for later", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    const ids = Object.keys((romData as any).items).filter((id) => id !== "TM_PSYCHIC_M").slice(0, 20);
    for (const id of ids) game.save.inventory[id] = 1;
    ow.setMap("MR_PSYCHICS_HOUSE", 4, 4, "down");
    talkThrough(game, "TEXT_MRPSYCHICSHOUSE_MR_PSYCHIC");
    expect(game.save.inventory.TM_PSYCHIC_M).toBeUndefined();
    expect(game.save.flags.EVENT_GOT_TM29).toBeUndefined();
    // make room and come back
    game.save.inventory = {};
    talkThrough(game, "TEXT_MRPSYCHICSHOUSE_MR_PSYCHIC");
    expect(game.save.inventory.TM_PSYCHIC_M).toBe(1);
    expect(game.save.flags.EVENT_GOT_TM29).toBe(true);
  });

  test.skipIf(!hasGen)("the COPYCAT takes a POKe DOLL for TM31, and nothing without one", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    ow.setMap("COPYCATS_HOUSE_2F", 4, 4, "down");
    talkThrough(game, "TEXT_COPYCATSHOUSE2F_COPYCAT");
    expect(game.save.inventory.TM_MIMIC).toBeUndefined();
    expect(game.save.flags.EVENT_GOT_TM31).toBeUndefined();
    game.save.inventory.POKE_DOLL = 2;
    talkThrough(game, "TEXT_COPYCATSHOUSE2F_COPYCAT");
    expect(game.save.inventory.TM_MIMIC).toBe(1);
    expect(game.save.inventory.POKE_DOLL).toBe(1);
    expect(game.save.flags.EVENT_GOT_TM31).toBe(true);
    // afterwards she thanks you for it and keeps the second doll
    ow.showMapText("TEXT_COPYCATSHOUSE2F_COPYCAT");
    expect(topText(game)).toContain("TM31");
    talkThrough(game, "TEXT_COPYCATSHOUSE2F_COPYCAT");
    expect(game.save.inventory.TM_MIMIC).toBe(1);
    expect(game.save.inventory.POKE_DOLL).toBe(1);
  });
});

describe("the CYCLING ROAD gates", () => {
  const GATES = [
    ["ROUTE_16_GATE_1F", 4, 9, 7, "pedestrians"],
    ["ROUTE_18_GATE_1F", 4, 5, 3, "BICYCLE"],
  ] as const;

  /** Land on a cell beside the counter and let the guard react. */
  function stepOnto(game: VoxelmonGame, map: string, x: number, y: number): void {
    const ow = game.overworld;
    ow.setMap(map, x, y, "left");
    ow.onStepComplete();
    for (let i = 0; i < 60; i++) {
      if (game.stackKinds().at(-1) === "textbox") break;
      game.tick(0);
    }
  }

  test.skipIf(!hasGen)("without a BICYCLE the guard stops you and walks you back", () => {
    for (const [map, x, y, counterY, word] of GATES) {
      const game = makeMenuGame();
      const ow = game.overworld;
      stepOnto(game, map, x, y);
      expect(game.stackKinds().at(-1), map).toBe("textbox");
      // read both pages, then let the walk finish
      for (let t = 0; t < 600; t++) {
        if (game.stackKinds().at(-1) === "overworld") break;
        game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
      }
      expect(topText(game) ?? "").not.toContain(word);
      for (let t = 0; t < 600; t++) game.tick(0);
      const p = (ow as any).player;
      expect([p.cellX, p.cellY], map).toEqual([x + 1, counterY]);
    }
  });

  test.skipIf(!hasGen)("with a BICYCLE nobody says a word", () => {
    for (const [map, x, y] of GATES) {
      const game = makeMenuGame();
      game.save.inventory.BICYCLE = 1;
      stepOnto(game, map, x, y);
      expect(game.stackKinds(), map).toEqual(["overworld"]);
    }
  });
});

describe("the SEAFOAM ISLANDS puzzle", () => {
  const FLOORS = [
    "SEAFOAM_ISLANDS_1F", "SEAFOAM_ISLANDS_B1F", "SEAFOAM_ISLANDS_B2F",
    "SEAFOAM_ISLANDS_B3F", "SEAFOAM_ISLANDS_B4F",
  ];
  const sf = () => Seafoam.seafoamData((romData as any).field)!;

  function sfGame(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []), ...FLOORS,
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    (game.save as any).strengthActive = true;
    return game;
  }

  const shown = (ow: any, name: string) =>
    ow.npcs.some((n: any) => n.def?.name === name && !n.hidden);

  test.skipIf(!hasGen)("the dataset carries the whole puzzle", () => {
    const d = sf();
    expect(Object.keys(d).length).toBeGreaterThanOrEqual(4);
    expect(Seafoam.holesFor(d, "SEAFOAM_ISLANDS_1F").length).toBe(2);
    expect(Seafoam.holesFor(d, "SEAFOAM_ISLANDS_B2F").length).toBe(2);
    expect(Seafoam.toggleToObjectName("SEAFOAM_ISLANDS_B3F", "TOGGLE_SEAFOAM_ISLANDS_B3F_BOULDER_5"))
      .toBe("SEAFOAMISLANDSB3F_BOULDER5");
  });

  test.skipIf(!hasGen)("the boulders that come from above ship hidden", () => {
    const game = sfGame();
    const ow = game.overworld;
    ow.setMap("SEAFOAM_ISLANDS_B1F", 1, 1, "down");
    expect(shown(ow, "SEAFOAMISLANDSB1F_BOULDER1")).toBe(false);
    ow.setMap("SEAFOAM_ISLANDS_B3F", 1, 1, "down");
    expect(shown(ow, "SEAFOAMISLANDSB3F_BOULDER1")).toBe(true);
    expect(shown(ow, "SEAFOAMISLANDSB3F_BOULDER5")).toBe(false);
    expect(shown(ow, "SEAFOAMISLANDSB3F_BOULDER6")).toBe(false);
    ow.setMap("SEAFOAM_ISLANDS_B4F", 1, 1, "down");
    expect(shown(ow, "SEAFOAMISLANDSB4F_BOULDER1")).toBe(false);
  });

  test.skipIf(!hasGen)("a boulder shoved into a hole turns up on the floor below", () => {
    const game = sfGame();
    const ow = game.overworld;
    const { hole } = Seafoam.holesFor(sf(), "SEAFOAM_ISLANDS_1F")[0]!;
    ow.setMap("SEAFOAM_ISLANDS_1F", 1, 1, "down");
    const boulder = ow.npcs.find((n: any) => n.def?.name === "SEAFOAMISLANDS1F_BOULDER1") as any;
    expect(boulder).toBeTruthy();
    boulder.cellX = hole.x;
    boulder.cellY = hole.y;
    (ow as any).boulderLanded();
    expect(game.save.flags[hole.boulderEvent]).toBe(true);
    expect(shown(ow, "SEAFOAMISLANDS1F_BOULDER1")).toBe(false);
    expect(topText(game)).toContain("fell");
    dismissText(game);
    ow.setMap("SEAFOAM_ISLANDS_B1F", 1, 1, "down");
    expect(shown(ow, "SEAFOAMISLANDSB1F_BOULDER1")).toBe(true);
    // and it stays gone upstairs
    ow.setMap("SEAFOAM_ISLANDS_1F", 1, 1, "down");
    expect(shown(ow, "SEAFOAMISLANDS1F_BOULDER1")).toBe(false);
  });

  function surfAt(game: VoxelmonGame, map: string, x: number, y: number): void {
    const ow = game.overworld;
    ow.setMap(map, x, y, "down");
    ow.player.surfing = true;
    game.save.surfing = true;
    ow.onStepComplete();
    for (let i = 0; i < 1500; i++) game.tick(0);
  }

  test.skipIf(!hasGen)("B3F's current carries a surfer down to the stairs, and B4F's edge pushes back", () => {
    const game = sfGame();
    const ow = game.overworld;
    const c = sf().SEAFOAM_ISLANDS_B3F!.currents![0]!;
    surfAt(game, "SEAFOAM_ISLANDS_B3F", c.x, c.y);
    expect(ow.map.id).toBe("SEAFOAM_ISLANDS_B4F");
    // the pool edge (rows 16-17) shoved us up off it
    expect(ow.player.cellY).toBeLessThan(16);
  });

  test.skipIf(!hasGen)("with the plugs down the water is still", () => {
    const game = sfGame();
    const ow = game.overworld;
    for (const e of sf().SEAFOAM_ISLANDS_B3F!.currentsDisabledByEvents!) game.save.flags[e] = true;
    const c = sf().SEAFOAM_ISLANDS_B3F!.currents![0]!;
    surfAt(game, "SEAFOAM_ISLANDS_B3F", c.x, c.y);
    expect(ow.map.id).toBe("SEAFOAM_ISLANDS_B3F");
    expect([ow.player.cellX, ow.player.cellY]).toEqual([c.x, c.y]);
  });

  test.skipIf(!hasGen)("SURF is refused on B4F's stairs square until the plugs are down", () => {
    const game = sfGame();
    const ow = game.overworld;
    ow.setMap("SEAFOAM_ISLANDS_B4F", Seafoam.SURF_BLOCKED.x, Seafoam.SURF_BLOCKED.y, "down");
    expect(ow.surfBlockedHere()).toBe(true);
    for (const e of Seafoam.SURF_BLOCKED.untilEvents) game.save.flags[e] = true;
    expect(ow.surfBlockedHere()).toBe(false);
  });
});

describe("the CYCLING ROAD's forced bike and downhill roll", () => {
  const MAPS = ["ROUTE_16", "ROUTE_17", "ROUTE_18", "ROUTE_16_GATE_1F"];

  function fmGame(): VoxelmonGame {
    const data = {
      ...(romData as object),
      cookedMaps: [
        ...((romData as { cookedMaps?: string[] }).cookedMaps ?? []), ...MAPS,
      ],
    };
    const game = new VoxelmonGame(data as never, new MenuHost(), 1);
    game.newGame();
    game.closeToOverworld();
    return game;
  }

  const tile = () => (romData as any).field.forcedMovement.tiles.ROUTE_16[0] as { x: number; y: number };

  test.skipIf(!hasGen)("the road's mouth puts you on the BICYCLE, and the gate takes it off", () => {
    const game = fmGame();
    const ow = game.overworld;
    const save = game.save as any;
    save.inventory.BICYCLE = 1;
    ow.setMap("ROUTE_16", tile().x, tile().y, "left");
    ow.onStepComplete();
    expect(save.onBike).toBe(true);
    expect(save.forcedBike).toBe(true);
    expect(game.stackKinds()).toEqual(["overworld"]);
    ow.setMap("ROUTE_16_GATE_1F", 5, 8, "right");
    expect(save.forcedBike).toBe(false);
  });

  test.skipIf(!hasGen)("a walker is turned back", () => {
    const game = fmGame();
    const ow = game.overworld;
    ow.setMap("ROUTE_16", tile().x, tile().y, "left");
    ow.onStepComplete();
    expect(game.stackKinds().at(-1)).toBe("textbox");
    expect(topText(game)).toContain("BICYCLE");
    dismissText(game);
    for (let i = 0; i < 200; i++) game.tick(0);
    expect([ow.player.cellX, ow.player.cellY]).toEqual([tile().x + 1, tile().y]);
    expect((game.save as any).onBike ?? false).toBe(false);
  });

  /** A run of three plain cells down a column of Route 17. */
  function slopeCell(ow: any): [number, number] {
    for (let y = 8; y < 60; y++) {
      for (let x = 0; x < 20; x++) {
        const ok = [0, 1, 2, 3].every(
          (d) => ow.map.isWalkableCell(x, y + d) && !ow.map.isGrassCell(x, y + d) &&
            !ow.map.isWaterCell(x, y + d),
        );
        if (ok) return [x, y];
      }
    }
    throw new Error("no slope cell");
  }

  test.skipIf(!hasGen)("the hill rolls the bike south when nothing is held; A holds you", () => {
    const rolling = fmGame();
    (rolling.save as any).onBike = true;
    rolling.overworld.setMap("ROUTE_17", 5, 5, "down");
    const [x, y] = slopeCell(rolling.overworld);
    rolling.overworld.setMap("ROUTE_17", x, y, "down");
    rolling.overworld.syncBike();
    for (let i = 0; i < 240; i++) rolling.tick(0);
    expect(rolling.overworld.player.cellY).toBeGreaterThan(y);

    const braking = fmGame();
    (braking.save as any).onBike = true;
    braking.overworld.setMap("ROUTE_17", x, y, "down");
    braking.overworld.syncBike();
    for (let i = 0; i < 240; i++) braking.tick(VOX_BTN.b);
    expect(braking.overworld.player.cellY).toBe(y);

    // on foot the hill is just a hill
    const walking = fmGame();
    walking.overworld.setMap("ROUTE_17", x, y, "down");
    for (let i = 0; i < 240; i++) walking.tick(0);
    expect(walking.overworld.player.cellY).toBe(y);
  });
});

describe("the Silph Co 9F nurse", () => {
  function talkThrough(game: VoxelmonGame): void {
    game.overworld.showMapText("TEXT_SILPHCO9F_NURSE");
    for (let t = 0; t < 3000; t++) {
      // the script's own wait between the fades leaves the world on top
      // while it is still running
      const idle = !(game.overworld as any).runner.isRunning();
      if (game.stackKinds().at(-1) === "overworld" && idle) break;
      game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(game.stackKinds().at(-1)).toBe("overworld");
  }

  test.skipIf(!hasGen)("she heals the party while the Rockets hold the building, and only thanks you after", () => {
    const game = makeMenuGame();
    const mon = newMon(romData!, "PIDGEY", 12, game.battleRng);
    mon.hp = 1;
    game.save.party.push(mon);
    game.overworld.setMap("SILPH_CO_9F", 5, 5, "down");
    talkThrough(game);
    expect(game.save.party[0]!.hp).toBeGreaterThan(1);

    game.save.party[0]!.hp = 1;
    game.save.flags.EVENT_BEAT_SILPH_CO_GIOVANNI = true;
    // let the fade settle before she is spoken to again
    for (let i = 0; i < 120; i++) game.tick(0);
    game.overworld.showMapText("TEXT_SILPHCO9F_NURSE");
    for (let i = 0; i < 120 && game.stackKinds().at(-1) !== "textbox"; i++) game.tick(0);
    expect(topText(game)).toContain("Thank");
    talkThrough(game);
    expect(game.save.party[0]!.hp).toBe(1);
  });
});

describe("poison on the walk", () => {
  const steps = (game: VoxelmonGame, n: number) => {
    for (let i = 0; i < n; i++) game.overworld.onStepComplete();
  };

  test.skipIf(!hasGen)("every fourth step costs each poisoned mon a point, and a faint says so", () => {
    const game = makeMenuGame();
    const a = newMon(romData!, "PIDGEY", 10, game.battleRng);
    const b = newMon(romData!, "RATTATA", 10, game.battleRng);
    a.status = "PSN";
    a.hp = 2;
    game.save.party.push(a, b);
    game.overworld.setMap("PALLET_TOWN", 5, 6, "down");
    steps(game, 3);
    expect(a.hp).toBe(2);
    steps(game, 1);
    expect(a.hp).toBe(1);
    expect(b.hp).toBe(b.stats.hp);
    expect(game.stackKinds()).toEqual(["overworld"]);
    steps(game, 4);
    expect(a.hp).toBe(0);
    expect(a.status).toBeNull();
    expect(topText(game)).toContain("fainted");
    dismissText(game);
    // the other one still stands: no blackout
    expect(game.stackKinds()).toEqual(["overworld"]);
    expect(game.save.money).toBe(3000);
  });

  test.skipIf(!hasGen)("with nobody left standing you black out, healed and half as rich", () => {
    const game = makeMenuGame();
    const a = newMon(romData!, "PIDGEY", 10, game.battleRng);
    a.status = "PSN";
    a.hp = 1;
    game.save.party.push(a);
    game.save.money = 3000;
    game.overworld.setMap("PALLET_TOWN", 5, 6, "down");
    steps(game, 4);
    expect(topText(game)).toContain("fainted");
    // the next box opens the tick this one closes, so read it by its words
    // rather than by the stack emptying between the two
    for (let t = 0; t < 600 && !topText(game).includes("blacked"); t++) {
      game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(topText(game)).toContain("blacked");
    dismissText(game);
    expect(a.hp).toBe(a.stats.hp);
    expect(game.save.money).toBe(1500);
  });

  test.skipIf(!hasGen)("a clean party is not touched", () => {
    const game = makeMenuGame();
    const a = newMon(romData!, "PIDGEY", 10, game.battleRng);
    a.hp = 3;
    game.save.party.push(a);
    game.overworld.setMap("PALLET_TOWN", 5, 6, "down");
    steps(game, 8);
    expect(a.hp).toBe(3);
  });
});

describe("DIG, TELEPORT and SOFTBOILED from the party menu", () => {
  const withMoves = (game: VoxelmonGame, species: string, ids: string[]) => {
    const m = newMon(romData!, species, 30, game.battleRng);
    m.moves = ids.map((id) => ({ id, pp: 10 }));
    game.save.party.push(m);
    return m;
  };
  /** Open the party screen on slot 0 and its submenu; the rows offered. */
  const submenu = (game: VoxelmonGame): string[] => {
    game.push(new PartyState(game as never));
    tap(game, VOX_BTN.a);
    return ((game.top() as any).view().submenuItems as string[]);
  };

  test.skipIf(!hasGen)("TELEPORT is offered outdoors and DIG in the dungeons, never the other way", () => {
    const town = makeMenuGame();
    withMoves(town, "KADABRA", ["DIG", "TELEPORT", "SOFTBOILED"]);
    town.overworld.setMap("PALLET_TOWN", 5, 6, "down");
    const outside = submenu(town);
    expect(outside).toContain("TELEPORT");
    expect(outside).toContain("SOFTBOILED");
    expect(outside).not.toContain("DIG");

    const cave = makeMenuGame();
    withMoves(cave, "KADABRA", ["DIG", "TELEPORT"]);
    cave.overworld.setMap("MT_MOON_1F", 5, 5, "down");
    const inside = submenu(cave);
    expect(inside).toContain("DIG");
    expect(inside).not.toContain("TELEPORT");
  });

  test.skipIf(!hasGen)("DIG takes you back to the last POKeMON CENTER", () => {
    const game = makeMenuGame();
    withMoves(game, "SANDSHREW", ["DIG"]);
    (game.save as any).lastHeal = { map: "PALLET_TOWN", x: 5, y: 6 };
    game.overworld.setMap("MT_MOON_1F", 5, 5, "down");
    const items = submenu(game);
    pick(game, items.indexOf("DIG"));
    for (let i = 0; i < 300; i++) game.tick(0);
    expect(game.overworld.map.id).toBe("PALLET_TOWN");
    expect(game.stackKinds()).toEqual(["overworld"]);
  });

  test.skipIf(!hasGen)("SOFTBOILED hands a fifth of the user's HP to a teammate, if it can spare it", () => {
    const game = makeMenuGame();
    const chansey = withMoves(game, "CHANSEY", ["SOFTBOILED"]);
    const pidgey = withMoves(game, "PIDGEY", ["TACKLE"]);
    pidgey.hp = 1;
    game.overworld.setMap("PALLET_TOWN", 5, 6, "down");
    const share = Math.floor(chansey.stats.hp / 5);
    const items = submenu(game);
    pick(game, items.indexOf("SOFTBOILED"));
    expect(game.stackKinds().at(-1)).toBe("party"); // the chooser
    pick(game, 1);                                   // the PIDGEY
    expect(pidgey.hp).toBe(1 + share);
    expect(chansey.hp).toBe(chansey.stats.hp - share);

    // too little left to give: refused, nothing moves
    chansey.hp = share - 1;
    pidgey.hp = 1;
    game.closeToOverworld();
    const again = submenu(game);
    pick(game, again.indexOf("SOFTBOILED"));
    expect(topText(game)).toContain("Not enough");
    dismissText(game);
    expect(pidgey.hp).toBe(1);
  });
});

describe("the intro's name presets", () => {
  test.skipIf(!hasGen)("NEW NAME and three presets for you, then for the rival", () => {
    const game = makeMenuGame();
    game.startIntro();
    const untilNaming = (): void => {
      for (let t = 0; t < 6000 && game.stackKinds().at(-1) !== "naming"; t++) {
        game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
      }
      expect(game.stackKinds().at(-1)).toBe("naming");
      game.tick(0); // release, so the next tap is a real edge
    };
    const view = () => (game.top() as any).view();

    untilNaming();
    expect(view().grid).toEqual([["NEW NAME"], ["RED"], ["ASH"], ["JACK"]]);
    pick(game, 2); // ASH
    expect(game.save.player.name).toBe("ASH");

    untilNaming();
    expect(view().grid).toEqual([["NEW NAME"], ["BLUE"], ["GARY"], ["JOHN"]]);
    pick(game, 0); // NEW NAME: the keyboard, empty
    expect(game.stackKinds().at(-1)).toBe("naming");
    expect(view().grid[0]![0]).toBe("A");
    expect(view().name).toBe("");
    tap(game, VOX_BTN.start); // nothing typed: the first preset
    expect(game.save.player.rival).toBe("BLUE");
  });
});

describe("the PEWTER MUSEUM's ticket desk", () => {
  /** Type the line out, then answer the YES/NO under it. */
  function answerChoice(game: VoxelmonGame, yes: boolean): boolean {
    for (let i = 0; i < 400; i++) {
      if (game.stackKinds().at(-1) === "choice") {
        game.tick(0);
        if (!yes) tap(game, VOX_BTN.down);
        tap(game, VOX_BTN.a);
        for (let k = 0; k < 20; k++) game.tick(0);
        return true;
      }
      game.tick(i % 2 === 0 ? VOX_BTN.a : 0);
    }
    return false;
  }
  const ropeGame = (money: number): VoxelmonGame => {
    const game = makeMenuGame();
    game.save.money = money;
    game.overworld.setMap("MUSEUM_1F", 9, 5, "up");
    game.overworld.setMap("MUSEUM_1F", 9, 4, "up");
    game.overworld.onStepComplete();
    return game;
  };

  test.skipIf(!hasGen)("the rope asks for ¥50, and a yes buys the ticket", () => {
    const game = ropeGame(3000);
    expect(answerChoice(game, true)).toBe(true);
    expect(topText(game)).toContain("Thank you");
    dismissText(game);
    expect(game.save.money).toBe(2950);
    expect(game.save.flags.EVENT_BOUGHT_MUSEUM_TICKET).toBe(true);
    for (let i = 0; i < 60; i++) game.tick(0);
    expect([game.overworld.player.cellX, game.overworld.player.cellY]).toEqual([9, 4]);
    // with a ticket the desk only wishes you a good look
    game.overworld.showMapText("TEXT_MUSEUM1F_SCIENTIST1");
    expect(topText(game)).toContain("plenty");
  });

  test.skipIf(!hasGen)("a no, or an empty wallet, is walked back off the rope", () => {
    const no = ropeGame(3000);
    expect(answerChoice(no, false)).toBe(true);
    expect(topText(no)).toContain("Come again");
    dismissText(no);
    for (let i = 0; i < 120; i++) no.tick(0);
    expect([no.overworld.player.cellX, no.overworld.player.cellY]).toEqual([9, 5]);
    expect(no.save.money).toBe(3000);

    const poor = ropeGame(10);
    expect(answerChoice(poor, true)).toBe(true);
    expect(topText(poor)).toContain("enough money");
    dismissText(poor);
    for (let i = 0; i < 120; i++) poor.tick(0);
    expect(poor.overworld.player.cellY).toBe(5);
    expect(poor.save.money).toBe(10);
    expect(poor.save.flags.EVENT_BOUGHT_MUSEUM_TICKET ?? false).toBe(false);
  });

  test.skipIf(!hasGen)("spoken to from the wrong sides he sends you round, or quizzes you on AMBER", () => {
    const game = makeMenuGame();
    game.overworld.setMap("MUSEUM_1F", 12, 5, "up");
    game.overworld.showMapText("TEXT_MUSEUM1F_SCIENTIST1");
    expect(topText(game)).toContain("other side");
    dismissText(game);
    game.overworld.setMap("MUSEUM_1F", 14, 4, "left");
    game.overworld.showMapText("TEXT_MUSEUM1F_SCIENTIST1");
    expect(answerChoice(game, false)).toBe(true);
    expect(topText(game)).toContain("tree sap");
    dismissText(game);
  });
});

describe("cries in the field", () => {
  const listen = (game: VoxelmonGame): string[] => {
    const cries: string[] = [];
    (game as any).audio.playCry = (s: string) => { cries.push(s); };
    return cries;
  };

  test.skipIf(!hasGen)("the birds and MEWTWO cry before their line", () => {
    for (const [map, key, species] of [
      ["POWER_PLANT", "TEXT_POWERPLANT_ZAPDOS", "ZAPDOS"],
      ["SEAFOAM_ISLANDS_B4F", "TEXT_SEAFOAMISLANDSB4F_ARTICUNO", "ARTICUNO"],
      ["VICTORY_ROAD_2F", "TEXT_VICTORYROAD2F_MOLTRES", "MOLTRES"],
      ["CERULEAN_CAVE_B1F", "TEXT_CERULEANCAVEB1F_MEWTWO", "MEWTWO"],
    ] as const) {
      const game = makeMenuGame();
      const cries = listen(game);
      game.save.flags[`EVENT_BEAT_${species}`] = true; // no fight, just the greeting
      game.overworld.setMap(map, 1, 1, "down");
      game.overworld.showMapText(key);
      expect(cries, key).toEqual([species]);
      expect(game.stackKinds().at(-1)).toBe("textbox");
      dismissText(game);
    }
  });

  test.skipIf(!hasGen)("the pets answer with theirs", () => {
    const game = makeMenuGame();
    const cries = listen(game);
    game.overworld.setMap("PEWTER_NIDORAN_HOUSE", 2, 2, "down");
    game.overworld.showMapText("TEXT_PEWTERNIDORANHOUSE_NIDORAN");
    expect(cries).toEqual(["NIDORAN_M"]);
    expect(topText(game).length).toBeGreaterThan(0);
    dismissText(game);
    game.overworld.setMap("VIRIDIAN_NICKNAME_HOUSE", 2, 2, "down");
    game.overworld.showMapText("TEXT_VIRIDIANNICKNAMEHOUSE_SPEAROW");
    expect(cries).toEqual(["NIDORAN_M", "SPEAROW"]);
    dismissText(game);
  });
});

describe("water is only where the tileset has any", () => {
  test.skipIf(!hasGen)("an exit mat indoors is not water, so leaving a house never mounts the surf sprite", () => {
    const listed = (romData as any).field.waterTilesets as string[];
    expect(listed).toContain("OVERWORLD");
    // (not a GYM: the ROM lists that tileset for CERULEAN's pool)
    for (const map of ["REDS_HOUSE_1F", "VIRIDIAN_MART", "OAKS_LAB", "PEWTER_POKECENTER"]) {
      const game = makeMenuGame();
      const ow = game.overworld;
      ow.setMap(map, 1, 1, "down");
      for (const w of ow.map.def.warps as { x: number; y: number }[]) {
        expect(ow.map.isWaterCell(w.x, w.y), `${map} mat ${w.x},${w.y}`).toBe(false);
      }
      // step onto the mat: still on foot
      const w = (ow.map.def.warps as { x: number; y: number }[])[0]!;
      ow.setMap(map, w.x, w.y, "down");
      ow.syncSurf();
      expect(ow.player.surfing).toBe(false);
    }
    // and the sea is still the sea
    const sea = makeMenuGame();
    sea.overworld.setMap("PALLET_TOWN", 5, 6, "down");
    expect(listed).toContain(sea.overworld.map.def.tileset);
  });
});

describe("the GAME FREAK floor's diploma", () => {
  /** Talk to the designer and read whatever page comes up. */
  function talkDesigner(game: VoxelmonGame): void {
    game.overworld.setMap("CELADON_MANSION_3F", 2, 2, "up");
    game.overworld.showMapText("TEXT_CELADONMANSION3F_GAME_DESIGNER");
    for (let i = 0; i < 60 && game.stackKinds().at(-1) !== "textbox"; i++) game.tick(0);
  }
  const ownAll = (game: VoxelmonGame, n: number) => {
    const owned: Record<string, boolean> = {};
    for (const id of Object.keys((romData as any).pokemon).slice(0, n)) owned[id] = true;
    (game.save as any).pokedex = { owned, seen: { ...owned } };
  };

  test.skipIf(!hasGen)("short of 150 he only tells you to keep at it", () => {
    const game = makeMenuGame();
    ownAll(game, 149);
    talkDesigner(game);
    expect(topText(game)).toContain("game");
    expect(topText(game)).not.toContain("completed");
    dismissText(game);
    for (let i = 0; i < 60; i++) game.tick(0);
    expect(game.stackKinds()).toEqual(["overworld"]);
  });

  test.skipIf(!hasGen)("a completed dex gets the congratulations and the diploma", () => {
    const game = makeMenuGame();
    ownAll(game, 150);
    game.save.player.name = "ISAAC";
    talkDesigner(game);
    expect(topText(game)).toContain("completed");
    // A through the congratulations: the diploma is what it opens onto
    for (let t = 0; t < 600 && game.stackKinds().at(-1) !== "diploma"; t++) {
      game.tick(t % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(game.stackKinds().at(-1)).toBe("diploma");
    const v = game.diplomaScreen() as { title: string; name: string; lines: string[] };
    expect(v.title).toBe("Diploma");
    expect(v.name).toBe("ISAAC");
    expect(v.lines.join(" ")).toContain("POK");
    // it holds a moment, then a button closes it back to the world
    tap(game, VOX_BTN.a);
    expect(game.stackKinds().at(-1)).toBe("diploma");
    for (let i = 0; i < 10; i++) game.tick(0);
    tap(game, VOX_BTN.a);
    for (let i = 0; i < 60; i++) game.tick(0);
    expect(game.stackKinds()).toEqual(["overworld"]);
  });
});

describe("Silph Co 7F", () => {
  test.skipIf(!hasGen)("the rival waits at the door, and only there", () => {
    const rows = (ow: any, save: any) =>
      (MAP_SCRIPTS as any).SILPH_CO_7F.onStep(ow, save);
    const at = (x: number, y: number) => ({ player: { cellX: x, cellY: y, facing: "up" } });
    const fresh = { flags: {} as Record<string, boolean> };

    // SilphCo7FDefaultScript's coord pair, and nothing else on the floor
    expect(rows(at(3, 2), fresh)).not.toBeNull();
    expect(rows(at(3, 3), fresh)).not.toBeNull();
    expect(rows(at(3, 4), fresh)).toBeNull();
    expect(rows(at(4, 2), fresh)).toBeNull();
    // beaten once is beaten for good
    expect(rows(at(3, 2), { flags: { EVENT_BEAT_SILPH_CO_RIVAL: true } })).toBeNull();

    const scene = rows(at(3, 2), fresh) as ScriptRow[];
    // his own theme, OPP_RIVAL2's Silph parties, and he leaves whatever the
    // result was -- the loss jump lands on the same hide the win walks into
    expect(scene[0]).toEqual(["play_music", "Music_MeetRival"]);
    expect(scene.some((r) => r[0] === "rival_battle" && r[1] === "OPP_RIVAL2" && r[2] === 7))
      .toBe(true);
    expect(scene.at(-1)).toEqual(["hide_object", "SILPH_CO_7F", "SILPHCO7F_RIVAL"]);
    const lose = scene.find((r) => r[0] === "jump_if_false")![1] as number;
    expect(scene[lose - 1]).toEqual(["hide_object", "SILPH_CO_7F", "SILPHCO7F_RIVAL"]);
  });

  test.skipIf(!hasGen)("he is off the floor until the trigger puts him on it", () => {
    const hidden: string[] = [];
    const ow = { setObjectHidden: (n: string, h: boolean) => { if (h) hidden.push(n); } };
    (MAP_SCRIPTS as any).SILPH_CO_7F.onEnter(ow, { flags: {} });
    expect(hidden).toEqual(["SILPHCO7F_RIVAL"]);
    // once he has been beaten he is gone by his own script, not by this
    hidden.length = 0;
    (MAP_SCRIPTS as any).SILPH_CO_7F.onEnter(ow, {
      flags: { EVENT_BEAT_SILPH_CO_RIVAL: true },
    });
    expect(hidden).toEqual([]);
  });

  test.skipIf(!hasGen)("the worker's LAPRAS is given once and joins the party", () => {
    const game = makeMenuGame();
    game.overworld.setMap("SILPH_CO_7F", 3, 5, "up");
    const before = game.save.party.length;
    game.overworld.showMapText("TEXT_SILPHCO7F_SILPH_WORKER_M1");
    takeTheGift(game);
    const mon = game.save.party[game.save.party.length - 1];
    expect({ party: game.save.party.length, species: mon?.species })
      .toEqual({ party: before + 1, species: "LAPRAS" });
    expect(mon?.level).toBe(15);
    expect(game.save.flags.EVENT_GOT_LAPRAS).toBe(true);

    // and asking again only gets the story about it
    game.overworld.showMapText("TEXT_SILPHCO7F_SILPH_WORKER_M1");
    takeTheGift(game);
    expect(game.save.party.length).toBe(before + 1);
  });
});

describe("a rod in the water", () => {
  /** A dry cell in PALLET_TOWN with water next to it, and the way to face it. */
  function shoreSpot(ow: any): { x: number; y: number; facing: string } {
    const m = ow.map;
    const dirs: [number, number, string][] = [
      [0, 1, "down"], [0, -1, "up"], [1, 0, "right"], [-1, 0, "left"],
    ];
    for (let y = 0; y < m.def.height * 2; y++) {
      for (let x = 0; x < m.def.width * 2; x++) {
        if (!m.isWalkableCell(x, y) || m.isWaterCell(x, y)) continue;
        for (const [dx, dy, facing] of dirs) {
          if (m.inBounds(x + dx, y + dy) && m.isWaterCell(x + dx, y + dy)) {
            return { x, y, facing };
          }
        }
      }
    }
    throw new Error("no shore cell in PALLET_TOWN");
  }

  test.skipIf(!hasGen)("casting at real water lands the battle the rod hooked", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    ow.setMap("PALLET_TOWN", 5, 6, "down");
    const spot = shoreSpot(ow);
    ow.setMap("PALLET_TOWN", spot.x, spot.y, spot.facing);
    game.save.inventory.OLD_ROD = 1;

    game.goFishing("OLD_ROD");
    // the dots, then the bite, then the battle itself
    dismissText(game);
    expect(game.stackKinds()).toContain("battle");
    // and it is the rod's mon in it, not a grass roll
    const battle = (game.battleView() as { battle: any } | null)?.battle;
    expect(battle?.enemy?.mon?.species).toBe("MAGIKARP");
    expect(battle?.enemy?.mon?.level).toBe(5);
  });
});

describe("the Celadon rooftop", () => {
  test.skipIf(!hasGen)("a vending machine sells one can at the item's own price", () => {
    const game = makeMenuGame();
    game.save.money = 1000;
    game.openVending();
    expect(game.stackKinds().at(-1)).toBe("shop");
    // A machine opens ON the drinks -- there is no BUY/SELL/QUIT menu in
    // front of it -- and it lists all three, in the machine's order.
    const view = () => (game as never as { shop(): {
      mode: string; list: { id: string; right: string }[]; listIndex: number;
      footer: string | null; money: number;
    } | null }).shop()!;
    expect(view().mode).toBe("list");
    expect(view().list.map((r) => r.id))
      .toEqual(["FRESH_WATER", "SODA_POP", "LEMONADE"]);
    expect(view().list.map((r) => r.right))
      .toEqual(["\u00a5200", "\u00a5300", "\u00a5350"]);

    // FRESH WATER: straight to the price confirm, no quantity box.
    tap(game, VOX_BTN.a);
    expect(view().mode).toBe("confirm");
    tap(game, VOX_BTN.a);
    expect(game.save.money).toBe(800);
    expect(game.save.inventory.FRESH_WATER).toBe(1);
    expect(view().footer).toBe("FRESH WATER\npopped out!");
    expect(view().mode).toBe("list");
  });

  test.skipIf(!hasGen)("it refuses a drink you cannot pay for, and B walks away", () => {
    const game = makeMenuGame();
    game.save.money = 100;
    game.openVending();
    tap(game, VOX_BTN.a);
    expect(game.save.inventory.FRESH_WATER ?? 0).toBe(0);
    expect(game.save.money).toBe(100);
    // no menu behind the list: B closes the machine itself
    tap(game, VOX_BTN.b);
    expect(game.stackKinds().at(-1)).not.toBe("shop");
  });

  test.skipIf(!hasGen)("the little girl trades each drink for its own TM, once", () => {
    const save = {
      inventory: { LEMONADE: 1 } as Record<string, number>,
      flags: {} as Record<string, boolean>,
    };
    // Only LEMONADE in the bag -> TM49, and the asking is hers, not ours.
    let rows = thirstyGirlRows(null, save);
    expect(rows.some((r) => r[0] === "give_item" && r[1] === "TM_TRI_ATTACK")).toBe(true);
    expect(rows.some((r) => r[0] === "take_item" && r[1] === "LEMONADE")).toBe(true);
    // the drink is taken AFTER the TM lands, so a full bag costs nothing
    const give = rows.findIndex((r) => r[0] === "give_item");
    const take = rows.findIndex((r) => r[0] === "take_item");
    expect(give).toBeLessThan(take);

    // Her TM already claimed: that drink is passed over rather than wasted.
    save.flags.EVENT_GOT_TM49 = true;
    save.inventory.FRESH_WATER = 1;
    rows = thirstyGirlRows(null, save);
    expect(rows.some((r) => r[0] === "give_item" && r[1] === "TM_ICE_BEAM")).toBe(true);

    // Nothing to give: the thirsty line and no offer at all.
    rows = thirstyGirlRows(null, { inventory: {}, flags: {} });
    expect(rows.map((r) => r[0])).toEqual(["face_player", "show_text"]);
  });

  test.skipIf(!hasGen)("the machines are signs, and every roof script is registered", () => {
    for (const n of [1, 2, 3]) {
      const rows = talkScript(
        "CELADON_MART_ROOF", `TEXT_CELADONMARTROOF_VENDING_MACHINE${n}`,
      );
      expect(rows).toEqual([["open_vending"]]);
    }
    expect(talkScript("CELADON_MART_ROOF", "TEXT_CELADONMARTROOF_LITTLE_GIRL"))
      .toBeTypeOf("function");
  });

  test.skipIf(!hasGen)("the mart's floors are all cooked and all reachable", () => {
    // Three of them had no pak at all: the cooker refused any map needing a
    // per-map tile-id colour fix, and the mart owns all three such maps --
    // including its ground floor, which is the only way in.
    //
    // Asked of the SHIPPED set, not of `romData`: a full run cooks maps of
    // its own, and a cook rewrites the gamedata.json beside its output --
    // which for the default path is the very dataset the headless loader
    // reads, so `romData.cookedMaps` is whichever cook ran last.
    const paks = join(root, "dist/voxelmon/paks");
    const shipped = JSON.parse(readFileSync(join(paks, "gamedata.json"), "utf8"));
    const cooked = new Set<string>(shipped.cookedMaps ?? []);
    for (const f of ["1F", "2F", "3F", "4F", "5F", "ROOF", "ELEVATOR"]) {
      const name = `CELADON_MART_${f}`;
      expect({ floor: f, cooked: cooked.has(name), pak: existsSync(join(paks, `${name}.vxpak`)) })
        .toEqual({ floor: f, cooked: true, pak: true });
    }
  });
});

describe("NPCs on the move", () => {
  /** Every ent op, so an NPC's pose can be read back frame by frame. */
  class EntHost extends MenuHost {
    poses: { slot: number; frame: number; mirror: boolean }[] = [];
    ent(slot: number, _sheet: number, frame: number, _x: number, _y: number,
        _lift: number, flags: number): void {
      this.poses.push({ slot, frame, mirror: (flags & ENT_FLAG.mirror) !== 0 });
    }
  }

  /** Walk one NPC a few steps and report the poses it struck. */
  function walkPoses(data: VoxelmonData): { frames: Set<number>; mirrors: Set<boolean> } {
    const host = new EntHost();
    const game = new VoxelmonGame(data, host, 1);
    game.newGame();
    game.closeToOverworld();
    const ow = game.overworld;
    ow.setMap("PALLET_TOWN", 5, 6, "down");
    const npc = ow.npcs.find((n: any) => n.def?.movement === "WALK") ?? ow.npcs[0];
    expect(npc).toBeTruthy();
    const frames = new Set<number>();
    const mirrors = new Set<boolean>();
    // MARCH it: NPC_CHANGE_FACING walks the cycle on the spot (npc.ts
    // update), which needs no free cell and no wander roll.
    for (let i = 0; i < 200; i++) {
      if (!npc.moving) {
        npc.moving = true;
        npc.marching = true;
        npc.progress = 0;
      }
      host.poses.length = 0;
      game.tick(0);
      for (const p of host.poses) {
        if (p.slot === 0) continue; // slot 0 is the player
        frames.add(p.frame);
        mirrors.add(p.mirror);
      }
    }
    return { frames, mirrors };
  }

  test.skipIf(!hasGen)("a walk sheet with no dataset record still animates", () => {
    // A dataset cooked before the sprite table shipped: scene.ts has no
    // record to read, and every NPC used to hold its standing frame while
    // the mirror kept flipping -- legs still, hair swapping sides.
    const bare = { ...(romData as object) } as VoxelmonData & { sprites?: unknown };
    delete bare.sprites;
    const { frames } = walkPoses(bare);
    expect(frames.size).toBeGreaterThan(1);
  });

  test.skipIf(!hasGen)("the cooked dataset carries what a pose needs", () => {
    // The fallback above is a fallback; the data is meant to be there.
    const sprites = (romData as { sprites?: Record<string, { frames?: number; walker?: boolean }> })
      .sprites;
    expect(sprites?.SPRITE_BLUE?.walker).toBe(true);
    expect(sprites?.SPRITE_BLUE?.frames).toBe(6);
  });
});

describe("the evolution movie", () => {
  /** A game with one mon one level short of evolving, levelled into it. */
  function evolving(nickname?: string): { game: VoxelmonGame; mon: PartyMon } {
    const game = makeMenuGame();
    // The movie needs a page per form; say which rather than depending on
    // whatever the shared dataset's atlas looks like by now.
    (game as { data: unknown }).data = {
      ...(game.data as object),
      atlas: {
        ...(game.data as { atlas?: object }).atlas,
        picFront: { BULBASAUR: 80, IVYSAUR: 81 },
      },
    };
    const mon = newMon(romData!, "BULBASAUR", 16);
    if (nickname) mon.nickname = nickname;
    game.save.party = [mon];
    // checkParty asks whether THIS mon just levelled, so say it did.
    (game as any).runEvolutions(new Set([mon]));
    return { game, mon };
  }

  test.skipIf(!hasGen)("flashes the two forms, then evolves and renames", () => {
    const { game, mon } = evolving();
    expect(game.stackKinds().at(-1)).toBe("evolution");
    const view = () => (game as any).evolutionScreen();
    const pages = new Set<number>();
    // "What? BULBASAUR is evolving!" over the flashing forms.
    expect(view().lines).toEqual(["What?", "BULBASAUR is", "evolving!"]);
    for (let i = 0; i < EVO_FLASH_FRAMES - 1; i++) {
      pages.add(view().picPage);
      game.tick(0);
    }
    expect(pages.size).toBe(2); // both forms took their turn
    expect(mon.species).toBe("BULBASAUR"); // not until the flashing is done

    game.tick(0); // the last frame: apply, cry, congratulations
    expect(mon.species).toBe("IVYSAUR");
    expect(game.stackKinds().at(-1)).toBe("textbox");
    expect(topText(game)).toContain("evolved into");
    // No nickname, so what it is CALLED follows what it is.
    expect(mon.nickname).toBeUndefined();
    expect(romData!.pokemon[mon.species]!.name).toBe("IVYSAUR");

    dismissText(game);
    // the movie is off the stack once its text closes
    for (let i = 0; i < 30 && game.stackKinds().includes("evolution"); i++) game.tick(0);
    expect(game.stackKinds()).not.toContain("evolution");
  });

  test.skipIf(!hasGen)("a nickname survives the evolution", () => {
    const { game, mon } = evolving("SPROUT");
    expect((game as any).evolutionScreen().lines[1]).toBe("SPROUT is");
    for (let i = 0; i < EVO_FLASH_FRAMES + 1; i++) game.tick(0);
    expect(mon.species).toBe("IVYSAUR");
    expect(mon.nickname).toBe("SPROUT");
    expect(topText(game)).toContain("Your SPROUT");
  });

  test.skipIf(!hasGen)("holding B calls it off", () => {
    const { game, mon } = evolving();
    // EvolveMon polls the joypad every flash iteration; a held B aborts.
    for (let i = 0; i < 5; i++) game.tick(VOX_BTN.b);
    expect(mon.species).toBe("BULBASAUR");
    expect(topText(game)).toContain("stopped evolving");
  });

  test.skipIf(!hasGen)("the flash speeds up as it goes", () => {
    // 28 frames a form to begin with, down to a floor of 4.
    expect(flashPeriod(0)).toBe(28);
    expect(flashPeriod(40)).toBe(22);
    expect(flashPeriod(200)).toBe(4);
    expect(flashPeriod(1000)).toBe(4);
  });
});

describe("a save that was written with an empty list", () => {
  // `{}` is what Lua writes for BOTH an empty array and an empty record,
  // so a save made while a list was empty reads back as an object -- and
  // every push and splice on it throws. On the console a thrown guest
  // frame is answered by the host dropping into its map viewer, which is
  // what "hitting DEPOSIT opens the map viewer" was.
  test.skipIf(!hasGen)("the reader hands back the arrays the game expects", () => {
    const text = [
      "return {",
      '  party = {},',
      "  bagOrder = {},",
      "  inventory = { POTION = 3 },",
      "  pc = { inventory = {}, bagOrder = {} },",
      "}",
    ].join("\n");
    const save = decodeSave(text) as {
      party: unknown;
      bagOrder: unknown;
      pc: { bagOrder: unknown };
    };
    expect(Array.isArray(save.party)).toBe(true);
    expect(Array.isArray(save.bagOrder)).toBe(true);
    expect(Array.isArray(save.pc.bagOrder)).toBe(true);
  });

  test.skipIf(!hasGen)("storage boxes and move lists too, however deep", () => {
    // The shape a real save takes: twelve boxes, most of them untouched,
    // and a mon whose move list the writer emptied.
    const text = [
      "return {",
      '  boxes = { [1] = {}, [2] = { [1] = { species = "PIDGEY", moves = {} } } },',
      '  party = { [1] = { species = "SQUIRTLE", moves = {} } },',
      "}",
    ].join("\n");
    const save = decodeSave(text) as {
      boxes: { moves: unknown }[][];
      party: { moves: unknown }[];
    };
    expect(Array.isArray(save.boxes)).toBe(true);
    expect(save.boxes.every((b) => Array.isArray(b))).toBe(true);
    expect(Array.isArray(save.boxes[1]![0]!.moves)).toBe(true);
    expect(Array.isArray(save.party[0]!.moves)).toBe(true);
    // and the ones that were never lists are left alone
    expect(Array.isArray((save as { boxes: unknown }).boxes)).toBe(true);
  });

  test.skipIf(!hasGen)("a record that happens to be empty stays a record", () => {
    const save = decodeSave("return { flags = {}, inventory = {}, pokedex = { seen = {} } }") as {
      flags: unknown;
      inventory: unknown;
      pokedex: { seen: unknown };
    };
    expect(Array.isArray(save.flags)).toBe(false);
    expect(Array.isArray(save.inventory)).toBe(false);
    expect(Array.isArray(save.pokedex.seen)).toBe(false);
  });

  test.skipIf(!hasGen)("the bag rebuilds an order that is not a list", () => {
    // Belt and braces: even handed the wrong shape outright, nothing throws.
    const save = { inventory: { POTION: 3, ANTIDOTE: 1 }, bagOrder: {} as never };
    expect(Bag.order(save as never).sort()).toEqual(["ANTIDOTE", "POTION"]);
    expect(() => Bag.add(save as never, "ETHER", 1)).not.toThrow();
    expect(() => Bag.remove(save as never, "POTION", 3)).not.toThrow();
    expect(save.inventory.POTION).toBeUndefined();
  });

  test.skipIf(!hasGen)("depositing into a PC saved empty does not throw", () => {
    const game = makeMenuGame();
    game.save.inventory.POTION = 3;
    // The shape a save written with an empty PC comes back as.
    (game.save as { pc?: unknown }).pc = { inventory: {}, bagOrder: {} };
    expect(() => Pc.deposit(game.save as never, "POTION", 2, game.data)).not.toThrow();
    expect(Pc.pcBag(game.save as never).inventory.POTION).toBe(2);
    expect(game.save.inventory.POTION).toBe(1);
  });
});

describe("the lifts", () => {
  /** Read the panel sign and drive until something settles. */
  function readPanel(game: VoxelmonGame, map: string, text: string): void {
    const ow = game.overworld;
    if (ow.map.id !== map) ow.setMap(map, 3, 2, "up");
    ow.showMapText(text);
    for (let i = 0; i < 400; i++) {
      if (game.stackKinds().at(-1) === "floorpicker") return;
      if (game.stackKinds().at(-1) !== "textbox" && !(ow as any).runner.isRunning()) return;
      dismissText(game);
      game.tick(0);
    }
  }

  test.skipIf(!hasGen)("the hideout's floors are its own, in order", () => {
    const floors = floorsOf(romData!, "ROCKET_HIDEOUT_ELEVATOR");
    expect(floors.map((f) => f.token)).toEqual(["B1F", "B2F", "B4F"]);
    // Each one's warpIdx is that floor's own door back into the car --
    // read the way a warp reads it, 1-based (world/warp.ts).
    for (const f of floors) {
      const warp = (romData!.maps as any)[f.map].warps[f.warpIdx - 1];
      expect({ map: f.map, dest: warp?.destMap }).toEqual({
        map: f.map,
        dest: "ROCKET_HIDEOUT_ELEVATOR",
      });
    }
  });

  test.skipIf(!hasGen)("no LIFT KEY, no floor menu", () => {
    const game = makeMenuGame();
    delete game.save.inventory.LIFT_KEY;
    readPanel(game, "ROCKET_HIDEOUT_ELEVATOR", "TEXT_ROCKETHIDEOUTELEVATOR");
    expect(game.stackKinds()).not.toContain("floorpicker");
  });

  test.skipIf(!hasGen)("with the key it opens, and the choice rewrites the car's exits", () => {
    const game = makeMenuGame();
    game.save.inventory.LIFT_KEY = 1;
    readPanel(game, "ROCKET_HIDEOUT_ELEVATOR", "TEXT_ROCKETHIDEOUTELEVATOR");
    expect(game.stackKinds().at(-1)).toBe("floorpicker");
    const view = (game as any).floorPicker();
    expect(view.entries).toEqual(["B1F", "B2F", "B4F"]);

    // Down twice to B4F -- Giovanni's floor -- then A.
    tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.a);
    expect(game.stackKinds()).not.toContain("floorpicker");
    // Every exit of the car now leads to B4F: walking out is the ride.
    const def = (romData!.maps as any).ROCKET_HIDEOUT_ELEVATOR;
    expect(def.warps.every((w: any) => w.destMap === "ROCKET_HIDEOUT_B4F")).toBe(true);
    // And it lands on B4F's OWN LIFT DOOR -- the cell that warps back into
    // the car -- not on whatever warp happens to sit beside it. Resolved
    // through the same function a real step through the door uses.
    const landing = warpDestination(romData!, def.warps[0]);
    const b4f = (romData!.maps as any).ROCKET_HIDEOUT_B4F;
    const door = b4f.warps.find((w: any) => w.destMap === "ROCKET_HIDEOUT_ELEVATOR");
    expect({ map: landing.map, x: landing.x, y: landing.y }).toEqual({
      map: "ROCKET_HIDEOUT_B4F",
      x: door.x,
      y: door.y,
    });
  });

  test.skipIf(!hasGen)("stepping in seeds the way back out", () => {
    const game = makeMenuGame();
    const ow = game.overworld;
    // Arrive from B2F; the car's ROM default is B1F.
    ow.setMap("ROCKET_HIDEOUT_B2F", 5, 5, "up");
    ow.setMap("ROCKET_HIDEOUT_ELEVATOR", 3, 2, "up");
    const def = (romData!.maps as any).ROCKET_HIDEOUT_ELEVATOR;
    expect(def.warps.every((w: any) => w.destMap === "ROCKET_HIDEOUT_B2F")).toBe(true);
  });
});
