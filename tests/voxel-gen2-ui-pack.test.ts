// The PACK, the POKéDEX and the TRAINER CARD (voxelmon/game/gen2/ui/PackMenu,
// PackGfx, PokedexMenu, TrainerCard), opened from the START menu items on a
// real Game2 with a played save and drawn on the Gold screen.

import { describe, expect, test } from "bun:test";
import { haveGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { loadGenerated } from "../voxelmon/game/gen2/platform/data.ts";
import { FLAG_WIN_ON, WINDOW } from "../voxelmon/game/gen2/platform/lcd.ts";
import { Font } from "../voxelmon/game/gen2/shared/render/Font.ts";
import { PokedexMenu } from "../voxelmon/game/gen2/ui/PokedexMenu.ts";
import { TrainerCard } from "../voxelmon/game/gen2/ui/TrainerCard.ts";
import { draw, idle, press, rig, shot, tiles, topName } from "./gen2-ui-start-fixture.ts";

const gold = haveGoldGen();

/**
 * The text in map row `ty` (0 background, 1 window), read back through the
 * font's glyph tiles. The dex prints through the same glyph tiles, inverted
 * by palette.
 */
function rowText(lcd: any, ty: number, x0 = 0, x1 = 20, layer = 0): string {
  const byTile = new Map<number, string>();
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:?!.'é/,-") {
    const code = Font.encode(ch)[0];
    const tile = code === undefined ? undefined : Font.tileOf(code);
    if (tile !== undefined) byTile.set(tile, ch);
  }
  let s = "";
  for (let x = x0; x < x1; x++) s += byTile.get(lcd.s.cells[layer * WINDOW + ty * 32 + x]) ?? " ";
  return s;
}

/** Holes left on the visible screen (the 3D world showing through). */
function holes(lcd: any): number {
  let n = 0;
  const s = lcd.s;
  const winOn = (s.flags & FLAG_WIN_ON) !== 0;
  for (let y = 0; y < 18; y++) {
    for (let x = 0; x < 20; x++) {
      const px = x * 8 + 4;
      const inWindow = winOn && y * 8 >= s.wy && px >= s.wx - 7;
      const i = inWindow
        ? WINDOW + y * 32 + ((px - (s.wx - 7)) >> 3)
        : ((y * 8 + s.scy) >> 3) * 32 + (((px + s.scx) & 0xff) >> 3);
      if (s.attrs[i] & 0x10) n++;
    }
  }
  return n;
}

/** Clear any PACK message ("Threw away ...") with A. */
function clearMessages(game: any, pack: any): void {
  for (let i = 0; i < 6 && pack.message !== undefined; i++) press(game, "a", 4);
}

describe("gen2 PACK", () => {
  test.skipIf(!gold)("every pocket, the cursor, the submenu, a TOSS that changes the bag, B out", async () => {
    await tiles();
    const r = rig();
    const { game, lcd } = r;
    // HM_CUT is the importer's id for HM01 (items.json), which the fixture uses.
    expect(loadGenerated<any>("items").HM_CUT.tmLabel).toBe("HM01");
    // Stand-in: the field submenu only opens with an overworld to use items on,
    // and this rig runs without one (startWorld: false).
    if (!game.world) game.world = { useFieldItem: () => undefined };
    let closed = 0;
    game.closeStartMenuItem = () => {
      closed++;
      game.stack.pop();
    };

    game.pushStartMenuItem("pack");
    expect(topName(game)).toBe("PackMenu");
    const pack = game.stack.top();
    expect(pack.pocket().id).toBe("ITEM");
    expect(pack.gfx.available()).toBe(true);
    expect(pack.rows.slice(0, 2).map((x: any) => x.id)).toEqual(["POTION", "ANTIDOTE"]);
    await shot(r, "pack_items");
    expect(holes(lcd)).toBe(0);
    expect(rowText(lcd, 2, 8)).toContain("POTION");
    expect(rowText(lcd, 4, 8)).toContain("ANTIDOTE");

    press(game, "down", 4);
    expect(pack.index).toBe(2);
    press(game, "up", 4);
    expect(pack.index).toBe(1);

    press(game, "right", 20);
    expect(pack.pocket().id).toBe("BALL");
    expect(pack.rows.slice(0, 2).map((x: any) => x.id)).toEqual(["POKE_BALL", "GREAT_BALL"]);
    await shot(r, "pack_balls");
    press(game, "right", 20);
    expect(pack.pocket().id).toBe("KEY_ITEM");
    expect(pack.rows[0].id).toBe("BICYCLE");
    await shot(r, "pack_key");
    press(game, "right", 20);
    expect(pack.pocket().id).toBe("TM_HM");
    expect(pack.rows.map((x: any) => x.id)).toContain("TM_HEADBUTT");
    expect(pack.rows.map((x: any) => x.id)).toContain("HM_CUT");
    await shot(r, "pack_tmhm");
    press(game, "right", 20);
    expect(pack.pocket().id).toBe("ITEM");
    press(game, "left", 20);
    expect(pack.pocket().id).toBe("TM_HM");
    press(game, "right", 20);
    expect(pack.pocket().id).toBe("ITEM");

    // A on POTION: the submenu, not the item.
    press(game, "a", 4);
    expect(pack.submenu).toBeDefined();
    expect(pack.submenu.rows).toEqual(["use", "give", "toss", "quit"]);
    await shot(r, "pack_submenu");
    // B is QUIT by another name.
    press(game, "b", 4);
    expect(pack.submenu).toBeUndefined();

    // TOSS 2 of 3.
    press(game, "a", 4);
    press(game, "down", 2);
    press(game, "down", 2);
    expect(pack.submenu.index).toBe(3);
    press(game, "a", 4);
    expect(pack.qtyState).toBeDefined();
    expect(pack.qtyState.max).toBe(3);
    press(game, "up", 2);
    expect(pack.qtyState.qty).toBe(2);
    await shot(r, "pack_toss_qty");
    press(game, "a", 4);
    expect(pack.confirm).toBeDefined();
    await shot(r, "pack_toss_confirm");
    press(game, "a", 4);
    expect(game.save.inventory.POTION).toBe(1);
    clearMessages(game, pack);
    expect(pack.message).toBeUndefined();

    // Backing out of the quantity leaves the bag alone.
    press(game, "a", 4);
    press(game, "down", 2);
    press(game, "down", 2);
    press(game, "a", 4);
    press(game, "b", 4);
    expect(pack.qtyState).toBeUndefined();
    clearMessages(game, pack);
    expect(game.save.inventory.POTION).toBe(1);

    press(game, "b", 4);
    expect(closed).toBe(1);
    expect(topName(game)).not.toBe("PackMenu");
  });
});

describe("gen2 POKéDEX", () => {
  test.skipIf(!gold)("the listing, seen and caught entries, OPTION, SEARCH, back out", async () => {
    await tiles();
    const r = rig();
    const { game, lcd } = r;
    let closed = 0;
    game.closeStartMenuItem = () => {
      closed++;
      game.stack.pop();
    };

    game.pushStartMenuItem("pokedex");
    expect(topName(game)).toBe("PokedexMenu");
    const dex = game.stack.top();
    expect(dex.styled()).toBe(true);
    expect(dex.mode()).toBe("NEW");
    expect(dex.rows[0].species).toBe("CHIKORITA");
    expect(dex.totals()).toEqual([7, 2]);

    // NEW order: CHIKORITA, BAYLEEF, MEGANIUM, CYNDAQUIL
    press(game, "down", 2);
    press(game, "down", 2);
    press(game, "down", 2);
    expect(dex.current().species).toBe("CYNDAQUIL");
    await shot(r, "dex_list");
    // The cart's two layers: the BG scrolled by POKEDEX_SCX, the list in the window.
    expect(lcd.s.scx).toBe(5);
    expect(lcd.s.flags & FLAG_WIN_ON).toBe(FLAG_WIN_ON);
    expect(lcd.s.wx).toBe(0x47);
    expect(rowText(lcd, 2, 1, 11, 1)).toContain("CHIKORITA");
    expect(rowText(lcd, 4, 1, 11, 1).trim()).toBe("-----");
    expect(rowText(lcd, 8, 1, 11, 1)).toContain("CYNDAQUIL");
    expect(rowText(lcd, 12, 5, 8)).toBe("  7");
    expect(rowText(lcd, 15, 5, 8)).toBe("  2");
    expect(holes(lcd)).toBe(0);
    expect(lcd.s.objs.length).toBeLessThanOrEqual(40);

    // A on a caught mon: the entry, with height and weight.
    press(game, "a", 2);
    expect(dex.view).toBe("entry");
    await shot(r, "dex_entry");
    expect(rowText(lcd, 3, 9, 20)).toContain("CYNDAQUIL");
    expect(rowText(lcd, 5, 9, 20)).toContain("FIRE MOUSE");
    expect(rowText(lcd, 8, 4, 7)).toBe("155");
    expect(rowText(lcd, 9, 11, 20)).toContain("17.0");
    expect(rowText(lcd, 11, 2, 20)).toContain("It is timid, and");
    // PAGE flips to the second page of text.
    press(game, "a", 2);
    expect(dex.page).toBe(2);
    draw(r);
    expect(rowText(lcd, 11, 2, 20)).toContain("If attacked, it");
    // The arrow walks the four actions and wraps.
    press(game, "right", 2);
    expect(dex.entryAction).toBe(2);
    press(game, "left", 2);
    press(game, "left", 2);
    expect(dex.entryAction).toBe(4);
    press(game, "right", 2);
    expect(dex.entryAction).toBe(1);
    // AREA: the nest map, and A or B back to the entry.
    press(game, "right", 2);
    press(game, "a", 2);
    expect(dex.view).toBe("area");
    await shot(r, "dex_area");
    press(game, "b", 2);
    expect(dex.view).toBe("entry");
    press(game, "left", 2);
    press(game, "b", 2);
    expect(dex.view).toBe("list");

    // A seen-only mon: the entry keeps the ?'?? placeholders.
    press(game, "up", 2);
    press(game, "up", 2);
    press(game, "up", 2);
    expect(dex.current().species).toBe("CHIKORITA");
    press(game, "a", 2);
    expect(dex.view).toBe("entry");
    await shot(r, "dex_entry_seen");
    expect(rowText(lcd, 9, 11, 16)).toContain("???");
    press(game, "b", 2);
    // An unseen row does nothing.
    press(game, "down", 2);
    press(game, "a", 2);
    expect(dex.view).toBe("list");
    press(game, "up", 2);

    // SELECT: OPTION; choosing OLD resorts and goes back to the listing.
    press(game, "select", 2);
    expect(dex.view).toBe("option");
    await shot(r, "dex_option");
    expect(rowText(lcd, 4, 3, 20)).toContain("NEW");
    press(game, "down", 2);
    press(game, "a", 2);
    expect(dex.view).toBe("list");
    expect(dex.mode()).toBe("OLD");
    expect(dex.rows[0].species).toBe("BULBASAUR");
    await shot(r, "dex_list_old");
    expect(lcd.s.wx).toBe(0x4a);

    // START: SEARCH for FIRE (wheel slot 10) finds CYNDAQUIL alone.
    press(game, "start", 2);
    expect(dex.view).toBe("search");
    for (let i = 0; i < 9; i++) press(game, "right", 1);
    expect(dex.searchTypeId(1)).toBe("FIRE");
    await shot(r, "dex_search");
    press(game, "down", 2);
    press(game, "down", 2);
    press(game, "a", 2);
    expect(dex.view).toBe("list");
    expect(dex.rows.map((x: any) => x.species)).toEqual(["CYNDAQUIL"]);

    // UNOWN MODE appears once the researcher has upgraded the dex
    // (ENGINE_UNOWN_DEX), and shows the forms in catching order.
    game.save.engineFlags = { ...(game.save.engineFlags ?? {}), 12: true };
    game.save.unownDex = [1, 5, 26];
    press(game, "select", 2);
    expect(dex.optionRows().length).toBe(4);
    // The OPTION cursor opens on the current mode (OLD, row 2).
    expect(dex.optionIndex).toBe(2);
    press(game, "down", 2);
    press(game, "down", 2);
    press(game, "a", 2);
    expect(dex.view).toBe("unown");
    press(game, "right", 2);
    expect(dex.unownIndex).toBe(1);
    await shot(r, "dex_unown");
    press(game, "b", 2);
    expect(dex.view).toBe("option");
    press(game, "b", 2);
    expect(dex.view).toBe("list");

    press(game, "b", 2);
    expect(closed).toBe(1);
    expect(game.save.lastDexMode).toBe("OLD");
    expect(topName(game)).not.toBe("PokedexMenu");
  });

  test.skipIf(!gold)("printNumString is PrintNum's padding", () => {
    expect(PokedexMenu.printNumString(7, 3)).toBe("  7");
    expect(PokedexMenu.printNumString(155, 3, true)).toBe("155");
    expect(PokedexMenu.printNumString(108, 4, false, 2)).toBe(" 1.08");
    expect(PokedexMenu.printNumString(170, 5, false, 4)).toBe("  17.0");
    expect(PokedexMenu.printNumString(0, 5, false, 4)).toBe("   0.0");
  });
});

describe("gen2 TRAINER CARD", () => {
  test.skipIf(!gold)("the card, the badges page, back out", async () => {
    await tiles();
    const r = rig();
    const { game, lcd } = r;
    // The engine keys badges by name ("ZEPHYR", src/battle and world/FieldMoves);
    // the shared fixture writes ZEPHYRBADGE, so the badge is set here as well.
    game.save.player.badges.ZEPHYR = true;
    let closed = 0;
    game.closeStartMenuItem = () => {
      closed++;
      game.stack.pop();
    };

    game.pushStartMenuItem("status");
    expect(topName(game)).toBe("TrainerCard");
    const card = game.stack.top();
    expect(card.styled()).toBe(true);
    expect(card.pages()).toBe(2);
    await shot(r, "card_front");
    expect(holes(lcd)).toBe(0);
    expect(rowText(lcd, 2, 2, 14)).toBe("NAME/GOLD   ");
    expect(rowText(lcd, 4, 5, 10)).toBe("12345");
    expect(rowText(lcd, 10, 15, 18)).toBe("  2");
    expect(rowText(lcd, 12, 11, 15)).toBe("   1");
    expect(rowText(lcd, 12, 16, 18)).toBe("23");
    expect(rowText(lcd, 15, 12, 18)).toBe("BADGES");
    expect(TrainerCard.moneyText(3000)).toBe("  ¥3000");

    press(game, "right", 2);
    expect(card.page).toBe(2);
    idle(game, 7);
    await shot(r, "card_badges");
    expect(holes(lcd)).toBe(0);
    // Zephyrbadge (earned) is four objects; nothing else is.
    expect(lcd.s.objs.length).toBe(4);
    expect(rowText(lcd, 2, 2, 14)).toBe("NAME/GOLD   ");
    press(game, "left", 2);
    expect(card.page).toBe(1);
    press(game, "a", 2);
    expect(card.page).toBe(2);
    // Page 2's A quits.
    press(game, "a", 2);
    expect(closed).toBe(1);
    expect(topName(game)).not.toBe("TrainerCard");
  });
});
