// The START menu, SAVE and the script menus (voxelmon/game/gen2/ui/StartMenu,
// SaveMenu, ScriptMenu) on a real Game2 and the Gold screen.

import { describe, expect, test } from "bun:test";
import { haveGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { loadGenerated } from "../voxelmon/game/gen2/platform/data.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { Font } from "../voxelmon/game/gen2/shared/render/Font.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";
import { ScriptMenu } from "../voxelmon/game/gen2/ui/ScriptMenu.ts";
import { SaveMenu } from "../voxelmon/game/gen2/ui/SaveMenu.ts";
import { StartMenu } from "../voxelmon/game/gen2/ui/StartMenu.ts";
import { idle, press, rig, shot, tiles, topName } from "./gen2-ui-start-fixture.ts";

const gold = haveGoldGen();

/** The text on screen row `ty`, read back through the font's glyph tiles. */
function rowText(lcd: any, ty: number, x0 = 0, x1 = 20): string {
  const byTile = new Map<number, string>();
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:?!.'é") {
    const code = Font.encode(ch)[0];
    const tile = code === undefined ? undefined : Font.tileOf(code);
    if (tile !== undefined) byTile.set(tile, ch);
  }
  let s = "";
  for (let x = x0; x < x1; x++) s += byTile.get(lcd.s.cells[ty * 32 + x]) ?? " ";
  return s;
}

function findHeader(pred: (h: any) => boolean): any {
  const scripts = loadGenerated<any>("scripts");
  let hit: any;
  const walk = (o: any): void => {
    if (hit || !o || typeof o !== "object") return;
    if (o.dataFlags !== undefined && (o.items || o.gridItems) && pred(o)) {
      hit = o;
      return;
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(scripts);
  return hit;
}

describe("gen2 START menu", () => {
  test.skipIf(!gold)("opens over the world, grows with the save, remembers its cursor, closes on B and START", async () => {
    await tiles();
    const r = rig();
    const { game, lcd } = r;
    StartMenu.lastIndex = 1;
    // early game: no Pokédex, no Pokégear
    game.openStartMenu();
    expect(topName(game)).toBe("StartMenu");
    let menu = game.stack.top();
    expect(menu.items.map((i: any) => i.value)).toEqual(["pokemon", "pack", "status", "save", "option", "quit"]);
    expect(menu.items[2].label).toBe("GOLD");
    press(game, "b");
    expect(game.stack.top()).toBeUndefined();

    // with both key items
    game.save.pokedexReceived = true;
    game.save.engineFlags = { 4: true };
    game.openStartMenu();
    menu = game.stack.top();
    expect(menu.items.map((i: any) => i.value)).toEqual(["pokedex", "pokemon", "pack", "pokegear", "status", "save", "option", "quit"]);
    await shot(r, "start_menu");
    // the box is (10,0) 10 wide, 18 tall; POKéDEX label at (12,2), cursor at (11,2)
    expect(rowText(lcd, 2, 12, 19)).toBe("POK DEX".replace(" ", "é"));
    expect(lcd.s.cells[2 * 32 + 11]).toBe(Font.tileOf(0xed)!);
    // outside the boxes the world shows through: a hole at (0,0)
    expect(lcd.s.attrs[0]! & 0x10).toBe(0x10);
    // MENU ACCOUNT: the description at (0,14)
    expect(rowText(lcd, 14, 0, 10).trim()).toBe("POKéMON");
    expect(rowText(lcd, 16, 0, 10).trim()).toBe("database");

    press(game, "down");
    press(game, "down");
    press(game, "down");
    expect(menu.list.current().value).toBe("pokegear");
    await shot(r, "start_menu_gear");
    // "Trainer's": 's is one glyph in Gold's charmap
    expect(rowText(lcd, 14, 0, 10).startsWith("Trainer")).toBe(true);
    expect(rowText(lcd, 16, 0, 10).trim()).toBe("key device");
    // START closes it too, and the cursor is remembered
    press(game, "start");
    expect(game.stack.top()).toBeUndefined();
    expect(StartMenu.lastIndex).toBe(4);
    game.openStartMenu();
    expect(game.stack.top().list.index).toBe(4);
    // up wraps from the top to QUIT
    press(game, "up");
    press(game, "up");
    press(game, "up");
    press(game, "up");
    expect(game.stack.top().list.current().value).toBe("quit");
  });

  test.skipIf(!gold)("QUIT asks first, NO is the default, YES returns to the title", async () => {
    await tiles();
    const r = rig();
    const { game } = r;
    StartMenu.lastIndex = 1;
    let toTitle = 0;
    game.returnToTitle = () => toTitle++;
    game.openStartMenu();
    const menu = game.stack.top();
    for (let i = 0; i < 5; i++) press(game, "down");
    expect(menu.list.current().value).toBe("quit");
    press(game, "a");
    expect(menu.phase).toBe("confirm");
    expect(menu.confirmChoice).toBe(2);
    await shot(r, "start_quit_confirm");
    press(game, "a"); // NO
    expect(menu.phase).toBeUndefined();
    expect(toTitle).toBe(0);
    press(game, "a");
    press(game, "up");
    press(game, "a"); // YES
    expect(toTitle).toBe(1);
  });

  test.skipIf(!gold)("an item opens its screen through Game2 and comes back", async () => {
    await tiles();
    const r = rig();
    const { game } = r;
    StartMenu.lastIndex = 1;
    const opened: string[] = [];
    game.pushStartMenuItem = (id: string) => opened.push(id);
    game.openStartMenu();
    press(game, "a"); // POKéMON (first row, no Pokédex yet)
    // the MenuFade (if any) runs, then Game2 pushes the screen
    idle(game, 40);
    expect(opened).toEqual(["pokemon"]);
    expect(StartMenu.lastIndex).toBe(1);
  });
});

describe("gen2 SAVE", () => {
  test.skipIf(!gold)("the SAVE flow writes through Game2.writeSave into the save store, then closes the menu", async () => {
    await tiles();
    const r = rig();
    const { game, io } = r;
    StartMenu.lastIndex = 1;
    expect(io.text).toBeUndefined();
    game.openStartMenu();
    // POKéMON, PACK, GOLD, SAVE
    press(game, "down");
    press(game, "down");
    press(game, "down");
    expect(game.stack.top().list.current().value).toBe("save");
    press(game, "a");
    idle(game, 40);
    expect(topName(game)).toBe("SaveMenu");
    const sm = game.stack.top();
    expect(sm.existed).toBe(false);
    // type out "Would you like to / save the game?"
    idle(game, 120);
    expect(sm.yesNoVisible()).toBe(true);
    await shot(r, "save_confirm");
    expect(rowText(r.lcd, 14, 1, 19).trim()).toBe("Would you like to");
    expect(rowText(r.lcd, 16, 1, 19).trim()).toBe("save the game?");
    // the continue panel: PLAYER GOLD, badges 1, dex 2, time 1:23
    expect(rowText(r.lcd, 2, 5, 19).trim()).toBe("PLAYER GOLD");
    expect(rowText(r.lcd, 4, 17, 19).trim()).toBe("1");
    expect(rowText(r.lcd, 6, 16, 19).trim()).toBe("2");
    expect(rowText(r.lcd, 8, 13, 19).trim()).toBe("1:23");
    press(game, "a"); // YES
    expect(sm.phase).toBe("saving");
    // MID speed typing, then the DelayFrames run; nothing is written before
    for (let i = 0; i < 300 && sm.timer === 0; i++) idle(game, 1);
    expect(sm.saved).toBeUndefined();
    expect(io.text).toBeUndefined();
    await shot(r, "save_saving");
    expect(rowText(r.lcd, 14, 1, 19).startsWith("SAVING")).toBe(true);
    expect(rowText(r.lcd, 16, 1, 19).trim()).toBe("OFF THE POWER.");
    idle(game, 120);
    expect(sm.saved).toBe(true);
    expect(io.text!.startsWith("return {")).toBe(true);
    const [loaded] = Save.load();
    expect(loaded!.player.name).toBe("GOLD");
    expect(loaded!.party.map((m: any) => m.species)).toEqual(["CYNDAQUIL", "PIDGEY"]);
    // "GOLD saved / the game." shows, then the save screen and the start menu close
    let sawSaved = false;
    for (let i = 0; i < 400 && game.stack.top(); i++) {
      if (sm.phase === "done" && !sawSaved && sm.typer?.done()) {
        await shot(r, "save_done");
        sawSaved = rowText(r.lcd, 14, 1, 19).trim() === "GOLD saved" && rowText(r.lcd, 16, 1, 19).trim() === "the game.";
      }
      idle(game, 1);
    }
    expect(sawSaved).toBe(true);
    expect(game.stack.top()).toBeUndefined();
  });

  test.skipIf(!gold)("a second save asks to overwrite; NO backs out without writing", async () => {
    await tiles();
    const r = rig();
    const { game, io } = r;
    Save.save(game.save);
    const first = io.text;
    let done: boolean | undefined;
    Screens.push(game, "Gen2SaveMenu", { save: game.save, writer: () => game.writeSave(), onDone: (s: boolean) => (done = s) });
    const sm = game.stack.top() as SaveMenu;
    expect(sm.existed).toBe(true);
    idle(game, 120);
    press(game, "a");
    expect(sm.phase).toBe("overwrite");
    // "There is already a / save file. Is it" then the \v scroll page
    idle(game, 120);
    expect(sm.pages!.length).toBe(2);
    press(game, "a");
    idle(game, 60);
    expect(sm.yesNoVisible()).toBe(true);
    await shot(r, "save_overwrite");
    expect(rowText(r.lcd, 16, 1, 19).trim()).toBe("OK to overwrite?");
    press(game, "down");
    press(game, "a");
    expect(done).toBe(false);
    expect(io.text).toBe(first);
  });

  test("pagesOf: \\f pages, \\v scrolls keeping the last line", () => {
    const p = SaveMenu.pagesOf("There is already a\nsave file. Is it\vOK to overwrite?");
    expect(p.length).toBe(2);
    expect([...p[0]!]).toEqual(["There is already a", "save file. Is it"]);
    expect([...p[1]!]).toEqual(["save file. Is it", "OK to overwrite?"]);
    expect(p[1]!.scrolled).toBe(true);
    expect(SaveMenu.pagesOf("")).toEqual([[""]]);
  });
});

describe("gen2 script menus", () => {
  test.skipIf(!gold)("a vending machine's vertical menu answers the row, B answers 0", async () => {
    await tiles();
    const r = rig();
    const { game } = r;
    const header = findHeader((h) => (h.items ?? [])[0]?.startsWith("FRESH WATER"));
    expect(header).toBeDefined();
    expect(ScriptMenu.startCoord(header)).toEqual([2, 4]);
    const answers: number[] = [];
    Screens.push(game, "Gen2ScriptMenu", {
      header, style: "vertical", balance: "money", save: game.save,
      onChoose: (i: number) => {
        game.stack.pop();
        answers.push(i);
      },
    });
    press(game, "down");
    press(game, "down");
    press(game, "down");
    press(game, "down"); // stops at CANCEL: no wrap
    await shot(r, "script_vending");
    press(game, "a");
    expect(answers).toEqual([4]);
    Screens.push(game, "Gen2ScriptMenu", { header, style: "vertical", onChoose: (i: number) => answers.push(i) });
    press(game, "b");
    expect(answers).toEqual([4, 0]);
  });

  test.skipIf(!gold)("the 2D status menu lays out by rows and answers (row-1)*cols+col", async () => {
    await tiles();
    const r = rig();
    const { game } = r;
    const header = findHeader((h) => (h.gridItems ?? []).includes("PSN"));
    expect(header).toBeDefined();
    let answer = -1;
    Screens.push(game, "Gen2ScriptMenu", { header, style: "2d", onChoose: (i: number) => (answer = i) });
    const m = game.stack.top() as ScriptMenu;
    expect(m.itemPosition(2)).toEqual([2 + 5, 2]);
    press(game, "right");
    press(game, "down");
    await shot(r, "script_2d");
    press(game, "a");
    expect(answer).toBe(4); // BRN
  });

  test.skipIf(!gold)("the coin counter's balance box sits under the menu", async () => {
    await tiles();
    const r = rig();
    const { game } = r;
    game.save.player.coins = 500;
    const header = findHeader((h) => (h.items ?? [])[0]?.includes(" 50 :"));
    Screens.push(game, "Gen2ScriptMenu", { header, style: "vertical", balance: "moneycoins", save: game.save, onChoose: () => {} });
    await shot(r, "script_coins");
    expect(game.stack.top().items.length).toBe(3);
  });
});
