// Gold's OPTION screen, the credits roll, the #DEX diploma and the Hall of
// Fame (voxelmon/game/gen2/ui: OptionsMenu, Credits, Diploma, HallOfFame),
// each built on a real Game2 and driven to its exits. Shots of the main
// states go to $GOLD_SHOTS.

import { describe, expect, test } from "bun:test";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { setLcd } from "../voxelmon/game/gen2/platform/screen.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { HallOfFame as HofCore } from "../voxelmon/game/gen2/core/HallOfFame.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";
import { OptionsMenu } from "../voxelmon/game/gen2/ui/OptionsMenu.ts";
import { Credits } from "../voxelmon/game/gen2/ui/Credits.ts";
import { Diploma } from "../voxelmon/game/gen2/ui/Diploma.ts";
import { HallOfFame } from "../voxelmon/game/gen2/ui/HallOfFame.ts";

const gold = haveGoldGen();
const SHOTS = process.env.GOLD_SHOTS;

async function shot(lcd: Lcd, name: string): Promise<void> {
  if (!SHOTS) return;
  const { shotLcd } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
  shotLcd(lcd.s, `${SHOTS}/${name}.png`);
}

/** A game whose data is loaded but whose boot screens are not pushed. */
async function loaded(): Promise<{ game: Game2; lcd: Lcd }> {
  useGoldGen();
  const { useGoldTiles } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
  useGoldTiles();
  const game = Game2.new();
  const lcd = new Lcd(new RecorderHost());
  setLcd(lcd);
  game.load({ startWorld: false });
  game.stack.clear();
  return { game, lcd };
}

type Btn = keyof typeof VOX_BTN;

/** Press and release one button (two 60 Hz steps). */
function press(game: Game2, btn: Btn): void {
  game.frame(VOX_BTN[btn]);
  game.frame(0);
}

/** Cells that are neither holes nor tile 0. */
function ink(lcd: Lcd): number {
  let n = 0;
  for (let ty = 0; ty < 18; ty++) {
    for (let tx = 0; tx < 20; tx++) {
      const i = ty * 32 + tx;
      if (!(lcd.s.attrs[i]! & 0x10) && lcd.s.cells[i] !== 0) n++;
    }
  }
  return n;
}

function holes(lcd: Lcd): number {
  let n = 0;
  for (let ty = 0; ty < 18; ty++) for (let tx = 0; tx < 20; tx++) if (lcd.s.attrs[ty * 32 + tx]! & 0x10) n++;
  return n;
}

describe("gen2 OPTION screen", () => {
  test.skipIf(!gold)("groups, TEXT SPEED cycles, BACK hands the options to onDone", async () => {
    const { game, lcd } = await loaded();
    game.options.textSpeed = "MID";
    let done = 0;
    game.showOptions(() => done++);
    const menu = game.stack.top() as OptionsMenu;
    expect(menu).toBeInstanceOf(OptionsMenu);
    // Brian's top level is the groups plus the ungrouped rows (MENU ACCOUNT,
    // BACK); the groups whose rows are desktop-only are gone.
    const labels = menu.visible().map((r) => r.label);
    expect(labels).toEqual(["SPEED", "VIDEO", "GRAPHICS", "AUDIO", "BATTLE OPTIONS", "EXTRAS", "MENU ACCOUNT", "BACK"]);
    game.draw(lcd);
    expect(holes(lcd)).toBe(0);
    await shot(lcd, "options");

    // A on SPEED opens its page: TEXT SPEED, GAME SPEED, BACK.
    press(game, "a");
    const page = game.stack.top() as OptionsMenu;
    expect(page).not.toBe(menu);
    expect(page.view.map((r) => r.label)).toEqual(["TEXT SPEED", "GAME SPEED", "BACK"]);
    press(game, "right");
    expect(game.options.textSpeed).toBe("SLOW");
    press(game, "right");
    expect(game.options.textSpeed).toBe("FAST");
    // left at the first entry wraps to the last
    press(game, "left");
    expect(game.options.textSpeed).toBe("SLOW");
    game.draw(lcd);
    await shot(lcd, "options_speed");

    // B leaves the page (no onDone of its own), back on the top level.
    press(game, "b");
    expect(game.stack.top()).toBe(menu);
    expect(done).toBe(0);
    // MENU ACCOUNT is on the top level: right flips it.
    for (let i = 0; i < 6; i++) press(game, "down");
    expect(menu.row()!.label).toBe("MENU ACCOUNT");
    press(game, "right");
    expect(game.options.menuAccount).toBe(false);
    // down to BACK; A there leaves through onDone.
    press(game, "down");
    expect(menu.row()!.label).toBe("BACK");
    press(game, "a");
    expect(done).toBe(1);
    expect(game.stack.top()).toBeUndefined();
    expect(game.options.textSpeed).toBe("SLOW");
    expect(game.save.options.textSpeed).toBe("SLOW");
  });

  test.skipIf(!gold)("focusRow opens the group; FRAME cycles 1..8 and wraps", async () => {
    const { game } = await loaded();
    game.showOptions();
    const menu = game.stack.top() as OptionsMenu;
    const page = menu.focusRow("frame")!;
    expect(page.row()!.label).toBe("FRAME");
    page.options.frame = 8;
    press(game, "right");
    expect(page.options.frame).toBe(1);
    press(game, "left");
    expect(page.options.frame).toBe(8);
    page.options.frame = 1;
    // PRINT is hidden, as the Lua hides it.
    expect(menu.rows.some((r) => r.key === "print")).toBe(false);
  });
});

describe("gen2 OPTION screen's port rows", () => {
  test.skipIf(!gold)("CAMERA SPEED (the Kanto games' row) sits in GRAPHICS and cycles", async () => {
    const { game } = await loaded();
    game.showOptions();
    const menu = game.stack.top() as OptionsMenu;
    const page = menu.focusRow("cameraSpeed")!;
    expect(page.row()!.label).toBe("CAMERA SPEED");
    delete page.options.cameraSpeed;
    // unset reads NORMAL; right steps to FAST, wraps to SLOW
    press(game, "right");
    expect(page.options.cameraSpeed).toBe("fast");
    press(game, "right");
    expect(page.options.cameraSpeed).toBe("slow");
    press(game, "left");
    expect(page.options.cameraSpeed).toBe("fast");
    const { cameraSpeedQ8 } = await import("../voxelmon/game/cameraspeed.ts");
    expect(cameraSpeedQ8("slow")).toBe(128);
    expect(cameraSpeedQ8(undefined)).toBe(256);
    expect(cameraSpeedQ8("fast")).toBe(448);
  });
});

describe("gen2 credits", () => {
  test.skipIf(!gold)("runs the script to THE END; A then leaves", async () => {
    const { game, lcd } = await loaded();
    let done = 0;
    Screens.push(game, "Gen2Credits", { onDone: () => done++ });
    const credits = game.stack.top() as Credits;
    expect(credits).toBeInstanceOf(Credits);
    let shot1 = false;
    let frames = 0;
    while (!credits.exiting && frames < 20000) {
      game.frame(0);
      frames++;
      if (!shot1 && credits.scene === 0 && credits.borderFrame !== 0xff
        && credits.shown.some((e) => (e.text ?? "").includes("PROGRAMMING")) && credits.lyOverride % 32 !== 0) {
        game.draw(lcd);
        expect(holes(lcd)).toBe(0);
        expect(ink(lcd)).toBeGreaterThan(100);
        await shot(lcd, "credits_1");
        shot1 = true;
      }
    }
    expect(shot1).toBe(true);
    expect(credits.exiting).toBe(true);
    // the cart's cadence: every WAIT n is n+1 passes of 13 frames, roughly
    expect(frames).toBeGreaterThan(3000);
    expect(credits.shown.some((e) => e.theEnd)).toBe(true);
    game.draw(lcd);
    await shot(lcd, "credits_2");
    // A only leaves once the exit bit is set; it is, so it leaves.
    game.frame(VOX_BTN.a);
    expect(done).toBe(1);
  });

  test("the script is the cart's shape and B only hurries past $d", () => {
    const c = Credits.new({ data: {} }, { allowSkip: true });
    expect(Credits.SCRIPT[0]).toBe(Credits.CLEAR);
    expect(Credits.SCRIPT[Credits.SCRIPT.length - 1]).toBe(Credits.END);
    expect(Credits.STRINGS[Credits.STAFF]).toEqual(["      #MON", "    GOLD VERSION", "     PORT STAFF"]);
    c.timer = 5;
    c.pos = 3;
    c.handleB({ isDown: () => true });
    expect(c.timer).toBe(5);
    c.pos = 0xe + 1;
    c.handleB({ isDown: () => true });
    expect(c.timer).toBe(4);
    expect(c.runToEnd()).toBeGreaterThan(3000);
  });
});

describe("gen2 diploma", () => {
  test.skipIf(!gold)("draws the cart's page with the player's name; A closes", async () => {
    const { game, lcd } = await loaded();
    game.save.player.name = "GOLD";
    let closed = 0;
    Screens.push(game, "Gen2Diploma", { onClose: () => closed++ });
    const d = game.stack.top() as Diploma;
    expect(d).toBeInstanceOf(Diploma);
    expect(d.batch()).toBeTruthy();
    game.draw(lcd);
    expect(holes(lcd)).toBe(0);
    await shot(lcd, "diploma");
    press(game, "a");
    expect(closed).toBe(1);
  });
});

describe("gen2 Hall of Fame", () => {
  function party(game: Game2): void {
    const save = game.save;
    const data = game.data;
    save.player.name = "GOLD";
    save.player.id = 12345;
    save.playTime = { hours: 12, minutes: 5, seconds: 0, frames: 0 };
    const mons = [Mon.new(data, "TYPHLOSION", 52, {}), Mon.new(data, "PIDGEOT", 44, {})];
    for (const m of mons as any[]) {
      m.ot = "GOLD";
      m.otId = 12345;
    }
    save.party = mons;
  }

  test.skipIf(!gold)("induction: slide, display, the player card, onDone", async () => {
    const { game, lcd } = await loaded();
    party(game);
    const [entry] = HofCore.induct(game.save)!;
    expect(entry.mons.length).toBe(2);
    let done = 0;
    Screens.push(game, "Gen2HallOfFame", { entry, onDone: () => done++ });
    const hof = game.stack.top() as HallOfFame;
    expect(hof.phase).toBe("backpic");
    expect(hof.scx).toBe(0x90);
    let shot1 = false;
    let shotSlide = false;
    let shot2 = false;
    let shotBack = false;
    const seen = new Set<string>();
    for (let i = 0; i < 3000 && done === 0; i++) {
      game.frame(0);
      seen.add(hof.phase!);
      if (!shotSlide && hof.phase === "frontpic" && hof.scx === 0x40) {
        game.draw(lcd);
        await shot(lcd, "hof_slide");
        shotSlide = true;
      }
      if (!shot1 && hof.phase === "display" && hof.index === 1 && !hof.picAnim) {
        game.draw(lcd);
        expect(holes(lcd)).toBe(0);
        expect(HallOfFame.at(HallOfFame.monPlacements(hof.currentMon(), hof.speciesDef("TYPHLOSION")), 7, 13)).toBe("TYPHLOSION");
        await shot(lcd, "hof_1");
        shot1 = true;
      }
      if (!shotBack && hof.phase === "playerBack" && hof.scx === 0xf0) {
        game.draw(lcd);
        await shot(lcd, "hof_playerback");
        shotBack = true;
      }
      if (!shot2 && hof.phase === "player") {
        game.draw(lcd);
        await shot(lcd, "hof_2");
        shot2 = true;
      }
    }
    expect(shot1 && shot2).toBe(true);
    for (const p of ["backpic", "frontpic", "display", "playerBack", "playerFront", "player"]) expect(seen.has(p)).toBe(true);
    expect(done).toBe(1);
  });

  test.skipIf(!gold)("PC viewer: A walks the team, B leaves; an empty roster ends at once", async () => {
    const { game } = await loaded();
    let done = 0;
    Screens.push(game, "Gen2HallOfFame", { mode: "view", onDone: () => done++ });
    game.frame(0);
    expect(done).toBe(1);

    game.stack.clear();
    party(game);
    HofCore.induct(game.save);
    let done2 = 0;
    Screens.push(game, "Gen2HallOfFame", { mode: "view", onDone: () => done2++ });
    const hof = game.stack.top() as HallOfFame;
    expect(hof.phase).toBe("display");
    expect(HallOfFame.at(HallOfFame.headerPlacements("view", 1, undefined), 2, 2)).toBe("  1");
    for (let i = 0; i < 200; i++) game.frame(0); // let the pic animation finish
    press(game, "a");
    expect(hof.index).toBe(2);
    press(game, "b");
    expect(done2).toBe(1);
  });
});
