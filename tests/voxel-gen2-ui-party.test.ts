// The party list, the SUMMARY, the held-item menu, the move deleter and the
// forget-move box (voxelmon/game/gen2/ui/PartyMenu, SummaryMenu, HeldItemMenu,
// MoveDeleter, ForgetMoveList) on a real Game2 and the Gold screen.

import { describe, expect, test } from "bun:test";
import { haveGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Font } from "../voxelmon/game/gen2/shared/render/Font.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";
import { ForgetMoveList } from "../voxelmon/game/gen2/ui/ForgetMoveList.ts";
import { PartyMenu } from "../voxelmon/game/gen2/ui/PartyMenu.ts";
import { SummaryMenu } from "../voxelmon/game/gen2/ui/SummaryMenu.ts";
import { draw, idle, press, rig, shot, tiles, topName } from "./gen2-ui-start-fixture.ts";

const gold = haveGoldGen();

/** The text on screen row `ty`, read back through the font's glyph tiles. */
function rowText(lcd: any, ty: number, x0 = 0, x1 = 20): string {
  const byTile = new Map<number, string>();
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:?!.'/é") {
    const code = Font.encode(ch)[0];
    const tile = code === undefined ? undefined : Font.tileOf(code);
    if (tile !== undefined) byTile.set(tile, ch);
  }
  let s = "";
  for (let x = x0; x < x1; x++) s += byTile.get(lcd.s.cells[ty * 32 + x]) ?? " ";
  return s;
}

/** Press A/B until `pred` holds (text boxes type out over several frames). */
function until(game: any, btn: "a" | "b", pred: () => boolean, max = 40): void {
  for (let i = 0; i < max && !pred(); i++) {
    idle(game, 8);
    if (pred()) break;
    press(game, btn);
  }
}

describe("gen2 party menu", () => {
  test.skipIf(!gold)("opens from START, moves its cursor, opens a mon's submenu, B goes to onCancel", async () => {
    await tiles();
    const r = rig();
    const { game, lcd } = r;
    game.partyMenuCursor = 0;
    game.pushStartMenuItem("pokemon");
    expect(topName(game)).toBe("PartyMenu");
    const menu = game.stack.top() as PartyMenu;
    expect(menu.index).toBe(1);
    expect(menu.count()).toBe(3);
    await shot(r, "party_list");
    expect(rowText(lcd, 1)).toContain("CYNDAQUIL");
    expect(rowText(lcd, 3)).toContain("PIDGEY");
    expect(rowText(lcd, 5)).toContain("CANCEL");
    expect(rowText(lcd, 16)).toContain("Choose a");
    // HP digits at (13,1): " 20/ 20"-style, three columns each
    const cyn = game.save.party[0];
    expect(rowText(lcd, 1, 13, 20)).toBe(PartyMenu.rowFor(cyn).hp!);

    press(game, "down");
    expect(menu.index).toBe(2);
    press(game, "down");
    expect(menu.isCancel()).toBe(true);
    press(game, "down");
    expect(menu.index).toBe(1);
    press(game, "up");
    expect(menu.isCancel()).toBe(true);
    press(game, "up");
    press(game, "up");
    expect(menu.index).toBe(1);

    press(game, "a");
    expect(menu.submenu).not.toBeNull();
    expect(menu.submenu!.items.map((i) => i.id)).toEqual(["STATS", "SWITCH", "MOVE", "ITEM", "CANCEL"]);
    // .GetTopCoord: five rows -> top 6, labels from (8, 8)
    expect(PartyMenu.submenuTop(5)).toBe(6);
    await shot(r, "party_submenu");
    expect(rowText(lcd, 8, 8, 20)).toContain("STATS");
    expect(rowText(lcd, 14, 8, 20)).toContain("ITEM");
    // PokemonActionSubmenu's ClearBox: no prompt left of the box
    expect(rowText(lcd, 16, 0, 6).trim()).toBe("");
    press(game, "down");
    expect(menu.submenu!.index).toBe(2);
    press(game, "b");
    expect(menu.submenu).toBeNull();
    // the CANCEL row of the submenu also just closes it
    press(game, "a");
    for (let i = 0; i < 4; i++) press(game, "down");
    press(game, "a");
    expect(menu.submenu).toBeNull();
    expect(topName(game)).toBe("PartyMenu");

    press(game, "b");
    expect(topName(game)).not.toBe("PartyMenu");
    expect(game.partyMenuCursor).toBe(1);
  });

  test.skipIf(!gold)("STATS opens every SUMMARY page, the move screen and its move swap, and comes back", async () => {
    await tiles();
    const r = rig();
    const { game, lcd } = r;
    game.partyMenuCursor = 0;
    game.pushStartMenuItem("pokemon");
    const party = game.stack.top() as PartyMenu;
    press(game, "a");
    press(game, "a"); // STATS
    expect(topName(game)).toBe("SummaryMenu");
    const sum = game.stack.top() as SummaryMenu;
    expect(sum.mon.species).toBe("CYNDAQUIL");
    expect(sum.page).toBe(SummaryMenu.PINK_PAGE);
    await shot(r, "summary_page1");
    expect(rowText(lcd, 0, 8, 13)).toContain("155");
    expect(rowText(lcd, 2)).toContain("CYNDAQUIL");
    expect(rowText(lcd, 9)).toContain("EXP POINTS");
    expect(rowText(lcd, 12)).toContain("STATUS/");
    expect(rowText(lcd, 13)).toContain("OK");
    expect(rowText(lcd, 15)).toContain("FIRE");
    expect(SummaryMenu.at(sum.placements(), 1, 16)).toBeUndefined();

    press(game, "right");
    expect(sum.page).toBe(SummaryMenu.GREEN_PAGE);
    await shot(r, "summary_page2");
    expect(rowText(lcd, 8)).toContain("ITEM");
    expect(rowText(lcd, 10)).toContain("MOVE");
    const moves = sum.mon.moves.map((m: any) => m.id);
    expect(rowText(lcd, 10, 8, 20)).toContain(game.data.moves[moves[0]].name);

    press(game, "right");
    expect(sum.page).toBe(SummaryMenu.BLUE_PAGE);
    await shot(r, "summary_page3");
    expect(rowText(lcd, 8, 11, 20)).toContain("ATTACK");
    expect(rowText(lcd, 13)).toContain("GOLD");
    expect(rowText(lcd, 10, 2, 7)).toBe("12345");
    press(game, "right");
    expect(sum.page).toBe(SummaryMenu.PINK_PAGE);
    press(game, "left");
    expect(sum.page).toBe(SummaryMenu.BLUE_PAGE);
    press(game, "left");
    expect(sum.page).toBe(SummaryMenu.GREEN_PAGE);

    // SELECT on the green page: MoveScreenLoop's screen
    press(game, "select");
    expect(sum.moveDetail).toBe(true);
    await shot(r, "summary_moves");
    expect(rowText(lcd, 3, 2, 12)).toContain(game.data.moves[moves[0]].name);
    expect(rowText(lcd, 12)).toContain("ATTK/");
    if (moves.length >= 2) {
      press(game, "a");
      expect(sum.swapFrom).toBe(1);
      press(game, "down");
      press(game, "a");
      idle(game, 60);
      expect(sum.mon.moves.map((m: any) => m.id)).toEqual([moves[1], moves[0], ...moves.slice(2)]);
    }
    press(game, "b");
    expect(sum.moveDetail).toBe(false);
    expect(topName(game)).toBe("SummaryMenu");

    // down walks the party, the page stays
    press(game, "down");
    expect(sum.mon.species).toBe("PIDGEY");
    expect(sum.page).toBe(SummaryMenu.GREEN_PAGE);
    press(game, "down");
    expect(sum.index).toBe(2);
    // A on the last page quits; from green it turns to blue first
    press(game, "a");
    expect(sum.page).toBe(SummaryMenu.BLUE_PAGE);
    press(game, "a");
    expect(game.stack.top()).toBe(party);

    // the MOVE row: the move screen on its own, B leaves it
    press(game, "a");
    press(game, "down");
    press(game, "down");
    press(game, "a");
    expect(topName(game)).toBe("SummaryMenu");
    const ms = game.stack.top() as SummaryMenu;
    expect(ms.moveScreen).toBe(true);
    press(game, "right");
    expect(ms.mon.species).toBe("PIDGEY");
    press(game, "b");
    expect(game.stack.top()).toBe(party);
    expect(party.index).toBe(2);
  });

  test.skipIf(!gold)("SWITCH swaps two mons in the save's party", async () => {
    await tiles();
    const r = rig();
    const { game, lcd } = r;
    game.partyMenuCursor = 0;
    game.pushStartMenuItem("pokemon");
    const menu = game.stack.top() as PartyMenu;
    press(game, "a");
    press(game, "down");
    press(game, "a"); // SWITCH
    expect(menu.switchFrom).toBe(1);
    expect(menu.count()).toBe(2);
    draw(r);
    expect(rowText(lcd, 16)).toContain("Move to where?");
    press(game, "down");
    press(game, "a");
    idle(game, 60);
    expect(menu.switchFrom).toBeNull();
    expect(game.save.party.map((m: any) => m.species)).toEqual(["PIDGEY", "CYNDAQUIL"]);
    // B out of a second pick moves nothing
    press(game, "a");
    press(game, "down");
    press(game, "a");
    press(game, "b");
    expect(menu.switchFrom).toBeNull();
    expect(game.save.party.map((m: any) => m.species)).toEqual(["PIDGEY", "CYNDAQUIL"]);
  });

  test.skipIf(!gold)("ITEM opens the GIVE/TAKE menu and TAKE puts PIDGEY's BERRY in the bag", async () => {
    await tiles();
    const r = rig();
    const { game, lcd } = r;
    game.partyMenuCursor = 2;
    game.pushStartMenuItem("pokemon");
    const menu = game.stack.top() as PartyMenu;
    expect(menu.index).toBe(2);
    expect(PartyMenu.heldMarkerRow(game.save.party[1])).toBe(1);
    expect(game.save.inventory.BERRY ?? 0).toBe(0);
    press(game, "a");
    for (let i = 0; i < 3; i++) press(game, "down");
    expect(menu.submenu!.items[menu.submenu!.index - 1]!.id).toBe("ITEM");
    press(game, "a");
    expect(topName(game)).toBe("HeldItemMenu");
    await shot(r, "helditem_menu");
    expect(rowText(lcd, 14, 12, 20)).toContain("GIVE");
    expect(rowText(lcd, 16, 12, 20)).toContain("TAKE");
    expect(rowText(lcd, 1)).toContain("CYNDAQUIL"); // the list still under it
    expect(rowText(lcd, 16, 0, 12).trim()).toBe("");
    press(game, "down");
    press(game, "a"); // TAKE
    expect(game.save.party[1].item).toBeUndefined();
    expect(game.save.inventory.BERRY).toBe(1);
    idle(game, 60);
    draw(r);
    expect(rowText(lcd, 14)).toContain("Took");
    until(game, "a", () => topName(game) === "PartyMenu");
    expect(game.stack.top()).toBe(menu);
    // TAKE again: not holding anything
    press(game, "a");
    for (let i = 0; i < 3; i++) press(game, "down");
    press(game, "a");
    press(game, "down");
    press(game, "a");
    idle(game, 120);
    draw(r);
    expect(rowText(lcd, 16)).toContain("holding anything");
    until(game, "a", () => topName(game) === "PartyMenu");
    expect(game.save.inventory.BERRY).toBe(1);
  });

  test.skipIf(!gold)("MoveDeleter and ForgetMoveList construct, draw and answer", async () => {
    await tiles();
    const r = rig();
    const { game, lcd } = r;
    const mon = game.save.party[1];
    let chosen: number | null | undefined;
    Screens.push(game, "Gen2MoveDeleter", {
      mon,
      onChoose: (i: number) => {
        chosen = i;
        game.stack.pop();
      },
      onCancel: () => {
        chosen = null;
        game.stack.pop();
      },
    });
    expect(topName(game)).toBe("MoveDeleter");
    await shot(r, "movedeleter");
    expect(rowText(lcd, 3, 2, 12)).toContain(game.data.moves[mon.moves[0].id].name);
    expect(rowText(lcd, 4, 10, 18)).toContain("/");
    press(game, "down");
    press(game, "a");
    expect(chosen).toBe(mon.moves.length >= 2 ? 2 : 1);

    chosen = undefined;
    Screens.push(game, "Gen2MoveDeleter", {
      mon,
      layout: "forget",
      onCancel: () => {
        chosen = null;
        game.stack.pop();
      },
    });
    await shot(r, "forgetmovelist");
    expect(rowText(lcd, ForgetMoveList.rowY(1), 7, 19)).toContain(game.data.moves[mon.moves[0].id].name);
    press(game, "up"); // the forget box wraps
    expect(game.stack.top().row).toBe(mon.moves.length);
    press(game, "b");
    expect(chosen).toBeNull();
    expect(game.stack.top()).toBeUndefined();
  });
});
