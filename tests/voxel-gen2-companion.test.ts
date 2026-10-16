// Gold's bottom screen (voxelmon/game/gen2/ui/Companion.ts): its pages, turned
// by touch -- a tap is the finger lifting after it went down on a target.
import { describe, expect, test } from "bun:test";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Companion, layoutTabs, tabSpecsOf, type TabStyle } from "../voxelmon/game/gen2/ui/Companion.ts";
import { EnhancementsPanel } from "../voxelmon/game/gen2/ui/EnhancementsPanel.ts";
import { OptionsMenu, enhancementRows } from "../voxelmon/game/gen2/ui/OptionsMenu.ts";

const gold = haveGoldGen();

/** A host that keeps the cells sent to the bottom screen (target 1). */
function bottomHost(): { host: any; cells: string[] } {
  const cells: string[] = [];
  let target = 0;
  const host: any = {
    lcdTarget: (k: number) => { target = k; },
    lcdCells: (offset: number, hex: string) => { if (target === 1) cells.push(`${offset}:${hex}`); },
    lcdShow: () => {}, lcdBank: () => {}, lcdReset: () => {}, lcdRegs: () => {},
    lcdObjs: () => {}, lcdPals: () => {}, lcdLines: () => {},
  };
  return { host, cells };
}

/** A tap at panel cell (cx, cy): bottom-screen pixels are 16 a cell. */
function tap(c: Companion, game: any, cx: number, cy: number): void {
  c.touch(game, cx * 16 + 8, cy * 16 + 8, true);
  c.touch(game, cx * 16 + 8, cy * 16 + 8, true);
  c.touch(game, 0, 0, false);
}

describe("gen2 Companion (the bottom screen)", () => {
  test.skipIf(!gold)("tabs, a mon's page and back; every page draws to screen 1", async () => {
    useGoldGen();
    // the cooked tile pages, so the town map has art to draw
    const { useGoldTiles } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
    useGoldTiles();
    const game: any = Game2.new();
    game.load({ startWorld: true });
    game.save.party = [
      Mon.new(game.data, "CYNDAQUIL", 12, {}),
      Mon.new(game.data, "TOGEPI", 5, {}),
    ];
    const { host, cells } = bottomHost();
    const c = new Companion(host, []);
    const page = () => (c as any).page as string;
    const draw = () => {
      const before = cells.length;
      for (let i = 0; i < 20; i++) c.frame(game);
      return cells.length - before;
    };
    expect(draw()).toBeGreaterThan(0);
    expect(page()).toBe("party");
    // a still panel sends nothing more
    expect(draw()).toBe(0);

    // the second mon's name row (row 4) opens its page; a tap there turns to
    // the next mon, wrapping
    tap(c, game, 3, 4);
    expect(page()).toBe("mon");
    expect((c as any).mon).toBe(1);
    expect(draw()).toBeGreaterThan(0);
    tap(c, game, 3, 7);
    expect((c as any).mon).toBe(0);

    // the tab row, evenly spaced, each tab's touch reaching to the next's
    // cursor: <PK><MN> (columns 0-4), CARD (5-10), MAP (11-15), the
    // ENHANCEMENTS glyph (16-19)
    tap(c, game, 7, 14);
    expect(page()).toBe("card");
    expect(draw()).toBeGreaterThan(0);
    // the card turned over: its badges, and back
    tap(c, game, 8, 6);
    expect(page()).toBe("badges");
    expect(draw()).toBeGreaterThan(0);
    tap(c, game, 8, 6);
    expect(page()).toBe("card");
    tap(c, game, 17, 14);
    expect(page()).toBe("enh");
    expect(draw()).toBeGreaterThan(0);
    tap(c, game, 13, 14);
    expect(page()).toBe("map");
    expect(draw()).toBeGreaterThan(0);
    // the MAP page follows the player across the sea: one POKeGEAR, handed
    // the new landmark (Kanto's region with it)
    const gear = (c as any).gear;
    const before = gear.currentLandmark;
    game.world.setMap("VERMILION_CITY", 10, 10, "down");
    for (let i = 0; i < 30; i++) game.frame(0);
    expect(game.world.map.id).toBe("VERMILION_CITY");
    expect(draw()).toBeGreaterThan(0);
    expect((c as any).gear).toBe(gear);
    expect(gear.currentLandmark).not.toBe(before);
    expect(gear.region()).toBe("kanto");
    tap(c, game, 2, 14);
    expect(page()).toBe("party");

    // an empty party row does nothing; the row's ends belong to the end tabs
    tap(c, game, 3, 10);
    expect(page()).toBe("party");
    tap(c, game, 0, 14);
    expect(page()).toBe("party");
    tap(c, game, 19, 14);
    expect(page()).toBe("enh");
    tap(c, game, 0, 14);

    // a finger that is only resting (never lifted) does nothing yet
    c.touch(game, 7 * 16, 14 * 16, true);
    expect(page()).toBe("party");
    c.touch(game, 0, 0, false);
    expect(page()).toBe("card");
  });
});

describe("gen2 Companion: the ENHANCEMENTS tab", () => {
  test("every tab style's row fits twenty columns, a cursor column before each tab, nothing overlapping", () => {
    for (const style of ["card", "id", "extras"] as TabStyle[]) {
      for (const cheats of [false, true]) {
        const tabs = layoutTabs(tabSpecsOf(style, cheats));
        const taken = new Set<number>();
        for (const t of tabs) {
          expect(t.x - 1).toBeGreaterThanOrEqual(0);
          expect(t.x + t.w).toBeLessThanOrEqual(20);
          for (let x = t.x - 1; x < t.x + t.w; x++) {
            expect(taken.has(x)).toBe(false);
            taken.add(x);
          }
        }
        expect(tabs.some((t) => t.page === "enh")).toBe(true);
        expect(tabs.some((t) => t.page === "cheats")).toBe(cheats && style !== "extras");
        // every column of the row turns to some tab, and each tab's own columns to it
        for (let x = 0; x < 20; x++) expect(tabs.filter((t) => x >= t.hit0 && x <= t.hit1).length).toBe(1);
        for (const t of tabs) for (let x = t.x - 1; x < t.x + t.w; x++) expect(x >= t.hit0 && x <= t.hit1).toBe(true);
      }
    }
  });

  test("the page's rows are OPTION's ENHANCEMENTS rows: same keys, same words, a tap steps one as RIGHT does", () => {
    const panel = new EnhancementsPanel();
    const rows = panel.layout();
    expect(rows.map((p) => p.row.key)).toEqual(["gameSpeed", "expForCatching", "partyExpShare", "tradeEvoLv40", "hmsWithoutMove", "visibleWild"]);
    expect(rows.map((p) => p.row)).toEqual(enhancementRows());
    // OPTION's own page, opened the way the screen opens it, lists the same
    const opt = (OptionsMenu.ROWS as any[]).filter((r) => rows.some((p) => p.row === r));
    expect(opt.length).toBe(rows.length);
    // rows 3-12, row 13 clear; one-line rows fit their value beside the label
    expect(rows[0]!.y).toBe(3);
    const last = rows[rows.length - 1]!;
    expect(last.y + (last.twoLine ? 1 : 0)).toBeLessThanOrEqual(12);
    let saved = 0;
    const game: any = { options: {}, persistOptions: () => { saved++; } };
    const reference: Record<string, any> = {};
    for (const p of rows) {
      for (let k = 0; k < 3; k++) {
        panel.tap(game, 5, p.y);
        p.row.cycle!(reference, 1);
        expect(game.options[p.row.key!]).toEqual(reference[p.row.key!]);
        expect(panel.values(game)[rows.indexOf(p)]).toBe(String(p.row.text!(reference)));
      }
    }
    expect(saved).toBe(rows.length * 3);
    // a value set on OPTION's side shows on the tab
    game.options.visibleWild = "many";
    expect(panel.values(game)[rows.length - 1]).toBe("MANY");
    // rows 2 and 13 are no row
    const before = JSON.stringify(game.options);
    panel.tap(game, 5, 2);
    panel.tap(game, 5, 13);
    expect(JSON.stringify(game.options)).toBe(before);
  });
});
