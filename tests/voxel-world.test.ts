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
import { newMon } from "../voxelmon/game/battle/mon.ts";
import { seqRng } from "../voxelmon/game/rng.ts";
import * as Bag from "../voxelmon/game/rules/bag.ts";
import { ENCOUNTER_BUCKETS } from "../voxelmon/game/rules/encounter.ts";
import { expForLevel } from "../voxelmon/game/rules/growth.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { Input } from "../voxelmon/game/input.ts";
import { encodeGlyphs, glyphLen, MAX_COLS } from "../voxelmon/game/ui/tiles.ts";
import { GameMap } from "../voxelmon/game/world/map.ts";
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
