// GAME SPEED (voxelmon/game/gamespeed.ts): the OPTION screen's SPEED 1X/2X.
// At 2X each host step runs two logic ticks and composes the scene once,
// after the last; the sound's clock keeps real time; a link runs at 1X.
//
// Layer 1 (always runs): the stepper and the option helpers.
// Layer 2 (gated on the cooked datasets): Red/Blue/Yellow's VoxelmonGame and
// Gold's Game2 driven the way their 3DS entries drive them.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import {
  GAME_SPEEDS, GAME_SPEED_LABEL, gameSpeedIndex, gameSpeedOf, setGameSpeedIn, SpeedGovernor, SpeedStepper, stepHost,
} from "../voxelmon/game/gamespeed.ts";
import { loadRuntimeData, REQUIRED_MODULES, type VoxelmonData } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { OptionsMenuState } from "../voxelmon/game/ui/optionsmenu.ts";
import { encodeSave } from "../voxelmon/game/save-lua.ts";
import { decodeSave } from "../voxelmon/game/save-read.ts";
import { fromDisk, toDisk } from "../voxelmon/game/savecompat.ts";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";

describe("the speed stepper", () => {
  test("1X is one tick a step, 2X two, a fractional speed averages out", () => {
    const s = new SpeedStepper();
    expect([1, 2, 3].map(() => s.ticks(1))).toEqual([1, 1, 1]);
    expect([1, 2, 3].map(() => s.ticks(2))).toEqual([2, 2, 2]);
    expect([1, 2, 3, 4].map(() => s.ticks(1.5))).toEqual([1, 2, 1, 2]);
    // nonsense is 1X, never zero ticks
    for (const v of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) expect(s.ticks(v)).toBe(1);
  });

  test("stepHost composes once, on the last tick, and only when the host renders after", () => {
    const s = new SpeedStepper();
    const seen: boolean[] = [];
    expect(stepHost(s, 2, true, (c) => seen.push(c))).toBe(2);
    expect(seen).toEqual([false, true]);
    seen.length = 0;
    expect(stepHost(s, 2, false, (c) => seen.push(c))).toBe(2);
    expect(seen).toEqual([false, false]);
    seen.length = 0;
    expect(stepHost(s, 1, true, (c) => seen.push(c))).toBe(1);
    expect(seen).toEqual([true]);
  });

  test("the fallback: 1.5X while the logic overfills frames, 2X again once they are quick", () => {
    const changes: number[] = [];
    const g = new SpeedGovernor(18000, 14000, (cap) => changes.push(cap));
    /** A rendered frame of `us`, `logicPart` of it logic, over two host steps. */
    const frame = (us: number, logicPart: number, want = 2): void => {
      g.sample(us / 2, (us * logicPart) / 2, false, want);
      g.sample(us / 2, (us * logicPart) / 2, true, want);
    };
    for (let i = 0; i < 60; i++) frame(12000, 0.5);
    expect(g.speed(2)).toBe(2);
    // one map load's long frame is not enough
    frame(400000, 0.5);
    expect(g.speed(2)).toBe(2);
    for (let i = 0; i < 10; i++) frame(12000, 0.5);
    // full frames the drawing fills: slowing the game would buy nothing
    for (let i = 0; i < 80; i++) frame(24000, 0.15);
    expect(g.speed(2)).toBe(2);
    // full frames the logic fills
    for (let i = 0; i < 80; i++) frame(24000, 0.5);
    expect(g.speed(2)).toBe(1.5);
    expect(g.speed(1)).toBe(1);
    // quick again: back to 2X after a second of it
    for (let i = 0; i < 20; i++) frame(10000, 0.5);
    expect(g.speed(2)).toBe(1.5);
    for (let i = 0; i < 60; i++) frame(10000, 0.5);
    expect(g.speed(2)).toBe(2);
    expect(changes).toEqual([1.5, 2]);
  });

  test("a battle's turn: one overfull frame steps SPEED down at once, held till the turn ends", () => {
    const changes: number[] = [];
    const g = new SpeedGovernor(18000, 14000, (cap) => changes.push(cap));
    const frame = (us: number, logicPart: number, busy: boolean, want = 2): void => {
      g.sample(us / 2, (us * logicPart) / 2, false, want, busy);
      g.sample(us / 2, (us * logicPart) / 2, true, want, busy);
    };
    // a quick turn stays 2X
    for (let i = 0; i < 60; i++) frame(15000, 0.5, true);
    expect(g.speed(2)).toBe(2);
    // a frame the drawing overfills buys nothing from slowing the game
    frame(30000, 0.1, true);
    expect(g.speed(2)).toBe(2);
    // nor one a single long tick overfills (the turn resolving: there at any speed)
    g.sample(15000, 1000, false, 2, true, 1000);
    g.sample(15000, 17000, true, 2, true, 17000);
    expect(g.speed(2)).toBe(2);
    // one the logic overfills: 1.5X on the spot, then 1X if it does again
    frame(30000, 0.6, true);
    expect(g.speed(2)).toBe(1.5);
    frame(30000, 0.6, true);
    expect(g.speed(2)).toBe(1);
    // quick frames for the rest of the turn do not lift it
    for (let i = 0; i < 120; i++) frame(8000, 0.5, true);
    expect(g.speed(2)).toBe(1);
    // the turn over: straight back to 2X
    frame(8000, 0.5, false);
    expect(g.speed(2)).toBe(2);
    expect(changes).toEqual([1.5, 1, 2]);
    // at 1X nothing changes: it is the game as it always ran
    frame(30000, 0.6, true, 1);
    expect(g.speed(1)).toBe(1);
    expect(g.speed(2)).toBe(2);
  });

  test("the option: 1 or 2 under options.gameSpeed, anything else is 1X", () => {
    expect(GAME_SPEEDS.map((s) => s.label)).toEqual(["1X", "2X"]);
    expect(gameSpeedOf(undefined)).toBe(1);
    expect(gameSpeedOf({})).toBe(1);
    expect(gameSpeedOf({ gameSpeed: 2 })).toBe(2);
    expect(gameSpeedOf({ gameSpeed: "2" })).toBe(2);
    expect(gameSpeedOf({ gameSpeed: 10 })).toBe(2);
    expect(gameSpeedOf({ gameSpeed: "fast" })).toBe(1);
    const o: { gameSpeed?: unknown } = {};
    expect(setGameSpeedIn(o, 7)).toBe(2);
    expect(o.gameSpeed).toBe(2);
    expect(gameSpeedIndex(o)).toBe(1);
    expect(setGameSpeedIn(o, 1)).toBe(1);
    expect(gameSpeedIndex(o)).toBe(0);
  });
});

// ---- Red / Blue / Yellow ----------------------------------------------------

const root = join(import.meta.dir, "..");
const genDir = join(root, "dist/voxelmon/gen");
const hasGen = REQUIRED_MODULES.every((m) => existsSync(join(genDir, `${m}.json`)));
const romData: VoxelmonData | null = hasGen ? await loadRuntimeData(genDir) : null;

function kantoGame(): VoxelmonGame {
  const game = new VoxelmonGame(romData!, new RecorderHost(), 1);
  game.newGame();
  game.closeToOverworld();
  return game;
}

/** psp-main.ts's frame(), the part that runs the ticks. */
function kantoStep(game: VoxelmonGame, stepper: SpeedStepper, buttons: number, show = true): number {
  return stepHost(stepper, game.logicSpeed(), show, (compose) => game.tick(buttons, compose));
}

/** A straight run of `n` plain cells (no grass, warp, water or door) going right. */
function plainRun(game: VoxelmonGame, n: number): [number, number] | null {
  const m: any = game.overworld.map;
  for (let y = 1; y < m.heightCells - 1; y++) {
    for (let x = 1; x + n < m.widthCells - 1; x++) {
      let ok = true;
      for (let i = 0; i <= n && ok; i++) {
        const cx = x + i;
        ok = m.isWalkableCell(cx, y) && !m.isGrassCell(cx, y) && !m.isWaterCell(cx, y)
          && !m.warpAtCell(cx, y) && !m.isDoorTileCell(cx, y) && !m.isWarpTileCell(cx, y);
      }
      if (ok) return [x, y];
    }
  }
  return null;
}

describe("GAME SPEED on Red/Blue/Yellow", () => {
  test.skipIf(!hasGen)("2X runs two logic ticks a host step and composes the scene once", () => {
    const game = kantoGame();
    const g: any = game;
    let emits = 0;
    const emit = g.scene.emit.bind(g.scene);
    g.scene.emit = (v: unknown) => { emits++; emit(v); };
    const stepper = new SpeedStepper();
    expect(game.gameSpeed()).toBe(1);
    const t0 = g.tickIndex;
    for (let i = 0; i < 30; i++) kantoStep(game, stepper, 0);
    expect(g.tickIndex - t0).toBe(30);
    expect(emits).toBe(30);

    expect(game.setGameSpeed(2)).toBe(2);
    emits = 0;
    const t1 = g.tickIndex;
    for (let i = 0; i < 30; i++) kantoStep(game, stepper, 0);
    expect(g.tickIndex - t1).toBe(60);
    expect(emits).toBe(30);
    // a step the host does not render after composes nothing
    emits = 0;
    kantoStep(game, stepper, 0, false);
    expect(emits).toBe(0);
  });

  test.skipIf(!hasGen)("2X walks twice as far in the same host steps", () => {
    const walked = (speed: number): number => {
      const game = kantoGame();
      (game.save as any).options = { ...((game.save as any).options ?? {}), movement: "grid" };
      game.overworld.enter("PALLET_TOWN", 0, 0, "right");
      const at = plainRun(game, 10);
      expect(at).not.toBeNull();
      game.overworld.enter("PALLET_TOWN", at![0], at![1], "right");
      game.setGameSpeed(speed);
      const stepper = new SpeedStepper();
      for (let i = 0; i < 20; i++) kantoStep(game, stepper, 0);
      const p: any = game.overworld.player;
      const n0 = p.landedCount;
      // two 16-frame steps at 1X
      for (let i = 0; i < 32; i++) kantoStep(game, stepper, VOX_BTN.right);
      for (let i = 0; i < 20; i++) kantoStep(game, stepper, 0);
      return p.landedCount - n0;
    };
    const one = walked(1);
    const two = walked(2);
    expect(one).toBeGreaterThanOrEqual(2);
    expect(two).toBeGreaterThanOrEqual(one * 2 - 1);
  });

  test.skipIf(!hasGen)("2X plays a battle's sounds once each, in the same order as 1X", async () => {
    const { fromGenDir } = await import("../voxelmon/game/audio/banks.ts");
    const banks = await fromGenDir(genDir);
    const sounds = async (speed: number): Promise<{ ops: string[]; steps: number }> => {
      const ops: string[] = [];
      const host = new RecorderHost();
      const h: any = host;
      for (const k of ["sfx", "cry", "music", "musicStop", "musicFade"]) {
        const f = h[k].bind(host);
        h[k] = (...a: number[]) => { ops.push(`${k} ${a.join(" ")}`); f(...a); };
      }
      const game = new VoxelmonGame(romData!, host, 1);
      game.setAudio(banks);
      game.newGame();
      game.closeToOverworld();
      const s: any = game.save;
      const { newMon } = await import("../voxelmon/game/battle/mon.ts");
      s.party = [newMon(romData!, "MEW", 70)];
      s.party[0].moves = [{ id: "SWIFT", pp: 30 }];
      game.setGameSpeed(speed);
      const stepper = new SpeedStepper();
      for (let i = 0; i < 10; i++) kantoStep(game, stepper, 0);
      ops.length = 0;
      game.startWildBattle("CHANSEY", 30);
      // the slide-in, the cries, the pages, then one whole turn (FIGHT ->
      // SWIFT, the foe's move) back to the menu
      let steps = 0;
      let turned = false;
      while (steps < 6000) {
        const ph = (game as any).battleView()?.battle.phase;
        if (ph === "moveSelect") turned = true;
        // (or the battle over: SWIFT may win it in one)
        if (turned && (ph === "menu" || ph === undefined)) break;
        kantoStep(game, stepper, steps % 2 === 0 ? VOX_BTN.a : 0);
        steps++;
      }
      expect(turned).toBe(true);
      return { ops, steps };
    };
    const one = await sounds(1);
    const two = await sounds(2);
    // the battle theme, the cry, SWIFT's sound, and what follows it
    expect(one.ops.length).toBeGreaterThanOrEqual(3);
    expect(two.ops).toEqual(one.ops);
    // and it got there in fewer host steps
    expect(two.steps).toBeLessThan(one.steps);
  });

  test.skipIf(!hasGen)("a link session runs at 1X whatever SPEED says", () => {
    const game = kantoGame();
    game.setGameSpeed(2);
    expect(game.logicSpeed()).toBe(2);
    (game.overworld as any).link = { state: "open" };
    expect(game.logicSpeed()).toBe(1);
    const stepper = new SpeedStepper();
    const g: any = game;
    // (the stand-in session is not a real one: serviceLink is kept off it)
    (game.overworld as any).serviceLink = () => {};
    const t0 = g.tickIndex;
    for (let i = 0; i < 10; i++) kantoStep(game, stepper, 0);
    expect(g.tickIndex - t0).toBe(10);
    (game.overworld as any).link = null;
    expect(game.logicSpeed()).toBe(2);
  });

  test.skipIf(!hasGen)("SPEED heads the OPTION screen's ENHANCEMENTS page", () => {
    const game = kantoGame();
    const menu = new OptionsMenuState(game as never);
    const rows = () => menu.view().rows;
    // not on SETTINGS
    expect(rows().some((r) => r.label === GAME_SPEED_LABEL)).toBe(false);
    game.push(menu as never);
    // SELECT (or L/R) turns to ENHANCEMENTS, cursor on its top row
    game.tick(VOX_BTN.select);
    game.tick(0);
    expect(menu.view().pages[menu.view().page]).toBe("ENHANCEMENTS");
    const at = rows().findIndex((r) => r.label === GAME_SPEED_LABEL);
    expect(at).toBe(0);
    expect(rows()[at]!.choices).toEqual(["1X", "2X"]);
    expect(rows()[at]!.index).toBe(0);
    game.tick(VOX_BTN.right);
    game.tick(0);
    expect((game.save as any).options.gameSpeed).toBe(2);
    expect(game.gameSpeed()).toBe(2);
    expect(rows()[at]!.index).toBe(1);
    game.tick(VOX_BTN.right);
    game.tick(0);
    expect(game.gameSpeed()).toBe(1);
  });

  test.skipIf(!hasGen)("options.gameSpeed survives the Lua save and the gen1recomp swap", () => {
    const game = kantoGame();
    game.setGameSpeed(2);
    const text = encodeSave(toDisk(game.save as never));
    const back: any = decodeSave(text);
    expect(back.options.gameSpeed).toBe(2);
    fromDisk(back, romData as never);
    expect(back.options.gameSpeed).toBe(2);
    expect(gameSpeedOf(back.options)).toBe(2);
  });
});

// ---- Gold / Silver / Crystal --------------------------------------------------

const gold = haveGoldGen();

describe("GAME SPEED on Gold/Silver/Crystal", () => {
  async function goldGame(): Promise<any> {
    useGoldGen();
    const { Game2 } = await import("../voxelmon/game/gen2/core/Game2.ts");
    const game: any = Game2.new();
    game.load({ startWorld: true });
    return game;
  }

  /** gen2/main.ts's frame(), the part that runs the ticks. */
  function goldStep(game: any, stepper: SpeedStepper, buttons: number, onCompose: () => void): void {
    game.audioFrame();
    stepHost(stepper, game.logicSpeed(), true, (compose) => {
      game.logicFrame(buttons);
      game.serviceLink();
      if (compose) onCompose();
    });
  }

  test.skipIf(!gold)("2X: two logic ticks a host step, one compose, the sound's clock at 1X", async () => {
    const game = await goldGame();
    const { Sound } = await import("../voxelmon/game/gen2/shared/core/Sound.ts");
    expect(game.logicSpeed()).toBe(1);
    expect(game.setGameSpeed(2)).toBe(2);
    expect(game.options.gameSpeed).toBe(2);
    expect(game.logicSpeed()).toBe(2);
    const stepper = new SpeedStepper();
    let ticks = 0;
    const logic = game.logicFrame.bind(game);
    game.logicFrame = (b: number) => { ticks++; logic(b); };
    let composes = 0;
    const clock0 = Sound.now();
    for (let i = 0; i < 30; i++) goldStep(game, stepper, 0, () => composes++);
    expect(ticks).toBe(60);
    expect(composes).toBe(30);
    expect(Sound.now() - clock0).toBe(30);
  });

  test.skipIf(!gold)("2X walks twice as far in the same host steps", async () => {
    const walked = async (speed: number): Promise<number> => {
      const game = await goldGame();
      game.options.movement = "grid";
      game.setGameSpeed(speed);
      const w = game.world;
      const id = "NEW_BARK_TOWN";
      w.setMap(id, 5, 5, "right");
      const m = w.map;
      const def = w.maps[id];
      let at: [number, number] | null = null;
      for (let y = 1; y < def.height * 2 - 1 && !at; y++) {
        for (let x = 1; x + 10 < def.width * 2 - 1 && !at; x++) {
          let ok = true;
          for (let i = 0; i <= 10 && ok; i++) {
            ok = m.isWalkableCell(x + i, y) && !m.isGrassCell(x + i, y) && !m.warpAt(x + i, y);
          }
          if (ok) at = [x, y];
        }
      }
      expect(at).not.toBeNull();
      w.setMap(id, at![0], at![1], "right");
      const stepper = new SpeedStepper();
      for (let i = 0; i < 30; i++) goldStep(game, stepper, 0, () => {});
      const p = game.world.player;
      const x0 = p.cellX;
      // two 16-frame steps at 1X
      for (let i = 0; i < 32; i++) goldStep(game, stepper, VOX_BTN.right, () => {});
      for (let i = 0; i < 20; i++) goldStep(game, stepper, 0, () => {});
      return Math.abs(game.world.player.cellX - x0);
    };
    const one = await walked(1);
    const two = await walked(2);
    expect(one).toBeGreaterThanOrEqual(2);
    expect(two).toBeGreaterThanOrEqual(one * 2 - 1);
  });

  test.skipIf(!gold)("the CABLE CLUB's session runs at 1X", async () => {
    const game = await goldGame();
    game.setGameSpeed(2);
    const club = game.cableClub();
    expect(game.logicSpeed()).toBe(2);
    club.session = { state: "open" };
    expect(game.logicSpeed()).toBe(1);
    club.session = null;
    club.battle = { service() {} };
    expect(game.logicSpeed()).toBe(1);
    club.battle = null;
    expect(game.logicSpeed()).toBe(2);
  });

  test.skipIf(!gold)("SPEED heads the OPTION screen's ENHANCEMENTS page, saved as gameSpeed", async () => {
    useGoldGen();
    const { Game2 } = await import("../voxelmon/game/gen2/core/Game2.ts");
    const { OptionsMenu, GAME_SPEED_ROW } = await import("../voxelmon/game/gen2/ui/OptionsMenu.ts");
    const game: any = Game2.new();
    game.load({ startWorld: false });
    game.stack.clear();
    game.showOptions();
    const menu = game.stack.top() as InstanceType<typeof OptionsMenu>;
    const page = menu.focusRow("gameSpeed")!;
    expect(page.row()!.label).toBe(GAME_SPEED_LABEL);
    expect(page.view.map((r: any) => r.label)).toEqual([
      GAME_SPEED_LABEL, "EXP FOR CATCHING", "PARTY EXP SHARE", "TRADE EVO LV.40", "HMS WITHOUT MOVE", "VISIBLE WILD", "BACK",
    ]);
    // gen1recomp's own `speed` row is gone; its key is left alone
    expect(menu.rows.some((r: any) => r.key === "speed")).toBe(false);
    delete page.options.gameSpeed;
    expect(GAME_SPEED_ROW.text!(page.options)).toBe("1X");
    game.frame(VOX_BTN.right);
    game.frame(0);
    expect(page.options.gameSpeed).toBe(2);
    expect(GAME_SPEED_ROW.text!(page.options)).toBe("2X");
    game.frame(VOX_BTN.right);
    game.frame(0);
    expect(page.options.gameSpeed).toBe(1);
  });
});
