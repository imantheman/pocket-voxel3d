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
    expect(labels).toEqual(["SPEED", "VIDEO", "GRAPHICS", "CONTROLS", "AUDIO", "BATTLE OPTIONS", "EXTRAS", "MENU ACCOUNT", "BACK"]);
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
    for (let i = 0; i < 7; i++) press(game, "down");
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
  test.skipIf(!gold)("MOVEMENT flips FREE/GRID; CAMERA SPEED cycles (the Kanto games' rows, under CONTROLS)", async () => {
    const { game } = await loaded();
    game.showOptions();
    const menu = game.stack.top() as OptionsMenu;
    const moves = menu.focusRow("movement")!;
    expect(moves.row()!.label).toBe("MOVEMENT");
    expect(moves.view.map((r) => r.label)).toEqual(["MOVEMENT", "RUNNING SHOES", "CAMERA SPEED", "BACK"]);
    delete moves.options.movement;
    expect(moves.rows.find((r) => r.key === "movement")!.text!(moves.options)).toBe("FREE");
    press(game, "right");
    expect(moves.options.movement).toBe("grid");
    press(game, "right");
    expect(moves.options.movement).toBe("free");
    press(game, "b");
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
    press(game, "b");
    // RUNNING SHOES: ON unless set; right turns them OFF and back
    const shoes = menu.focusRow("runningShoes")!;
    expect(shoes.row()!.label).toBe("RUNNING SHOES");
    delete shoes.options.runningShoes;
    expect(shoes.rows.find((r) => r.key === "runningShoes")!.text!(shoes.options)).toBe("ON");
    press(game, "right");
    expect(shoes.options.runningShoes).toBe(false);
    press(game, "right");
    expect(shoes.options.runningShoes).toBe(true);
    const { cameraSpeedQ8 } = await import("../voxelmon/game/cameraspeed.ts");
    expect(cameraSpeedQ8("slow")).toBe(128);
    expect(cameraSpeedQ8(undefined)).toBe(256);
    expect(cameraSpeedQ8("fast")).toBe(448);
  });
});

describe("gen2 DEV menu (the Kanto games' DEV MENU option)", () => {
  test.skipIf(!gold)("DEV in START only with DEV MENU on; RARE CANDY, CARD TEST, WARP", async () => {
    useGoldGen();
    const { useGoldTiles } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
    useGoldTiles();
    const game: any = Game2.new();
    const lcd = new Lcd(new RecorderHost());
    setLcd(lcd);
    game.load({ startWorld: true });
    for (let i = 0; i < 30; i++) game.frame(0);
    const startIds = (): string[] => {
      game.openStartMenu();
      const ids = (game.stack.top() as any).items.map((it: any) => it.value);
      game.stack.pop();
      return ids;
    };
    delete game.options.devMenu;
    expect(startIds()).not.toContain("dev");
    game.options.devMenu = true;
    expect(startIds()).toContain("dev");

    // the menu, as START -> DEV opens it
    game.openStartMenu();
    game.pushStartMenuItem("dev");
    const dev: any = game.stack.top();
    expect(dev.screenId).toBe("Gen2DevMenu");
    game.draw(lcd);
    await shot(lcd, "dev_menu");
    // RARE CANDY: topped up to 99, and a word about it
    game.save.inventory.RARE_CANDY = 5;
    dev.pick("candy");
    expect(game.save.inventory.RARE_CANDY).toBe(99);
    expect(game.stack.top()).not.toBe(dev);
    game.stack.pop();
    // CARD TEST with no host to ask says so
    dev.pick("cardtest");
    expect(game.stack.top()).not.toBe(dev);
    game.stack.pop();
    // WARP: the list opens on the map stood in; a pick lands on that map
    // with the menus gone
    dev.pick("warp");
    expect(dev.phase).toBe("warp");
    expect(dev.maps[dev.warpList.index - 1]).toBe(game.world.map.id);
    game.draw(lcd);
    await shot(lcd, "dev_warp");
    dev.page(1);
    expect(dev.warpList.index).toBeGreaterThan(1);
    dev.warp("ROUTE_29");
    for (let i = 0; i < 120; i++) game.frame(0);
    expect(game.world.map.id).toBe("ROUTE_29");
    expect(game.stack.top()).toBeUndefined();
    delete game.options.devMenu;
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

describe("gen2 RARE CANDY", () => {
  test.skipIf(!gold)("evolves only a mon that has reached its level", async () => {
    const { game } = await loaded();
    const g: any = game;
    const young = Mon.new(g.data, "PIDGEY", 6, {});
    const ready = Mon.new(g.data, "PIDGEY", 18, {});
    g.save.party = [young, ready];
    let done = 0;
    // a level short of PIDGEOTTO: no evolution screen, straight on
    g.afterRareCandy(young, { learned: [] }, () => done++);
    expect(g.stack.top()?.screenId).not.toBe("Gen2EvolutionAnim");
    expect(done).toBe(1);
    // at 18: the screen, evolving into PIDGEOTTO
    g.afterRareCandy(ready, { learned: [] }, () => done++);
    expect(g.stack.top()?.screenId).toBe("Gen2EvolutionAnim");
    expect(g.stack.top().newSpecies).toBe("PIDGEOTTO");
  });
});

describe("gen2 3D battle arena", () => {
  test.skipIf(!gold)("Map.openCells answers openCell for every cell of every map", async () => {
    const { game } = await loaded();
    const { Map: GoldMap } = await import("../voxelmon/game/gen2/world/Map.ts");
    const { openCell, search, SHAPES } = await import("../voxelmon/game/battle/arena.ts") as any;
    const { loadGenerated } = await import("../voxelmon/game/gen2/platform/data.ts");
    const maps: any = (game as any).data?.gen2Maps ?? loadGenerated("maps");
    const tilesets: any = (game as any).data?.gen2Tilesets ?? loadGenerated("tilesets");
    let checked = 0;
    for (const id of Object.keys(maps ?? {})) {
      const def = maps[id];
      const ts = tilesets?.[def?.tileset];
      if (!def || !ts) continue;
      const map: any = GoldMap.new(def, ts);
      for (const surfing of [false, true]) {
        const fast = map.openCells(surfing);
        for (let cy = 0; cy < map.heightCells; cy++) {
          for (let cx = 0; cx < map.widthCells; cx++) {
            const want = openCell(map, cx, cy, surfing) ? 1 : 0;
            if (fast[cy * map.widthCells + cx] !== want) throw new Error(`${id} (${cx},${cy}) surfing=${surfing}: ${fast[cy * map.widthCells + cx]} != ${want}`);
          }
        }
      }
      // the sightline grid, the same way
      const solid = map.solidCells();
      for (let cy = 0; cy < map.heightCells; cy++) {
        for (let cx = 0; cx < map.widthCells; cx++) {
          const want = !map.isWalkableCell(cx, cy) && !map.isWaterCell(cx, cy) ? 1 : 0;
          if (solid[cy * map.widthCells + cx] !== want) throw new Error(`${id} (${cx},${cy}) solid ${solid[cy * map.widthCells + cx]} != ${want}`);
        }
      }
      // the search (summed-area fits) against the old one, cell by cell
      const ref = (fx: number, fy: number) => {
        const w = map.widthCells, h = map.heightCells;
        const grid: boolean[] = [];
        for (let cy = 0; cy < h; cy++) for (let cx = 0; cx < w; cx++) grid[cy * w + cx] = openCell(map, cx, cy, false);
        for (const shape of SHAPES) {
          let best: any = null;
          let bestD = Infinity;
          for (let y = 0; y <= h - shape.h; y++) {
            for (let x = 0; x <= w - shape.w; x++) {
              let ok = true;
              for (let cy = y; cy < y + shape.h && ok; cy++) for (let cx = x; cx < x + shape.w; cx++) if (!grid[cy * w + cx]) { ok = false; break; }
              if (!ok) continue;
              const dx = x + (shape.w - 1) / 2 - fx, dy = y + (shape.h - 1) / 2 - fy;
              if (dx * dx + dy * dy < bestD) { bestD = dx * dx + dy * dy; best = { shape: shape.id, x, y }; }
            }
          }
          if (best) return best;
        }
        return null;
      };
      const fx = map.widthCells >> 1, fy = map.heightCells >> 1;
      const got = search(map, fx, fy, false);
      expect(got ? { shape: got.shape, x: got.x, y: got.y } : null).toEqual(ref(fx, fy));
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });
});

describe("gen2 RUNNING SHOES", () => {
  test.skipIf(!gold)("B held on foot halves a step's frames; not with the option off, nor surfing", async () => {
    useGoldGen();
    const g: any = Game2.new();
    g.load({ startWorld: true });
    const w = g.world;
    let b = false;
    g.input = { isDown: (k: string) => k === "b" && b, wasPressed: () => false };
    g.options = { ...(g.options ?? {}) };
    delete g.options.runningShoes;
    expect(w.walkFrames()).toBe(16);
    b = true;
    expect(w.walkFrames()).toBe(8);
    g.options.runningShoes = false;
    expect(w.walkFrames()).toBe(16);
    g.options.runningShoes = true;
    const { FieldMoves } = await import("../voxelmon/game/gen2/world/FieldMoves.ts");
    const was = w.playerState;
    w.playerState = FieldMoves.PLAYER_SURF;
    expect(w.walkFrames()).toBe(16);
    w.playerState = was;
  });
});
