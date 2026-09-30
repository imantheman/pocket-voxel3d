// The screen drawing stack on the Gold screen: Font, GbcPalette, Assets and
// Chrome (voxelmon/game/gen2) against the real cooked Gold graphics.

import { describe, expect, test } from "bun:test";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { loadGenerated } from "../voxelmon/game/gen2/platform/data.ts";
import { Lcd, LCD_HOLE, LCD_W, renderLcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { resetDrawState, setLcd } from "../voxelmon/game/gen2/platform/screen.ts";
import { Font } from "../voxelmon/game/gen2/shared/render/Font.ts";
import { Chrome } from "../voxelmon/game/gen2/ui/Chrome.ts";

const gold = haveGoldGen();

async function setup(): Promise<{ lcd: Lcd; px: (id: number, x: number, y: number) => number }> {
  useGoldGen();
  const { useGoldTiles, tilePixel } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
  const t = useGoldTiles();
  Font.load({ font: loadGenerated("font") });
  const lcd = new Lcd(new RecorderHost());
  setLcd(lcd);
  return { lcd, px: (id, x, y) => tilePixel(t, id, x, y) };
}

describe("gen2 chrome on the Gold screen", () => {
  test.skipIf(!gold)("a text box: border, blank paper, glyph cells, holes around it", async () => {
    const { lcd, px } = await setup();
    lcd.begin();
    resetDrawState();
    Chrome.textbox(0, 12, 18, 4);
    Chrome.print("NEW BARK TOWN", 1, 14);
    const f = renderLcd(lcd.s, px);
    // outside the box: the world shows through
    expect(f[0]).toBe(LCD_HOLE);
    // the box's corner is a frame glyph: some ink in it
    let ink = 0;
    for (let y = 96; y < 104; y++) for (let x = 0; x < 8; x++) if ((f[y * LCD_W + x]! & 3) === 3) ink++;
    expect(ink).toBeGreaterThan(0);
    // the paper is colour 0 of the box palette (white)
    const paper = f[13 * 8 * LCD_W + 10 * 8]!;
    expect(paper & 3).toBe(0);
    expect(lcd.s.colours[paper]).toBe(0x7fff);
    // "N" of NEW is a glyph cell at (1, 14)
    const cell = 14 * 32 + 1;
    expect(lcd.s.cells[cell]).toBe(Font.tileOf(Font.encode("N")[0]!));
    // one palette for the box, one reused for the text: the white/black box palette
    expect(lcd.s.attrs[cell]! & 0x0f).toBe(lcd.s.attrs[12 * 32]! & 0x0f);
    if (process.env.GOLD_SHOTS) {
      const { shotLcd } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
      shotLcd(lcd.s, `${process.env.GOLD_SHOTS}/chrome_textbox.png`);
    }
  });

  test.skipIf(!gold)("a cursor list with scrolling and the money field", async () => {
    const { lcd } = await setup();
    const chosen: unknown[] = [];
    const list = Chrome.List.new({
      items: ["POKéDEX", "POKéMON", "PACK", "SAVE", "OPTION", "EXIT"],
      x: 11,
      y: 2,
      rows: 4,
      onChoose: (v) => chosen.push(v),
    });
    const press = (b: string) => list.update({ wasPressed: (x) => x === b });
    press("down");
    press("down");
    press("down");
    press("down");
    expect(list.index).toBe(5);
    expect(list.scroll).toBe(1);
    press("a");
    expect(chosen).toEqual(["OPTION"]);
    lcd.begin();
    resetDrawState();
    Chrome.box(10, 0, 10, 10);
    list.draw();
    expect(lcd.s.cells[(2 + 3 * 2) * 32 + 10]).toBe(Font.tileOf(Chrome.CURSOR));
    expect(Chrome.money(3000)).toBe("  ¥3000");
    expect(Chrome.number(7, 3)).toBe("  7");
    if (process.env.GOLD_SHOTS) {
      const { shotLcd } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
      Chrome.moneyBalanceBox(3000);
      shotLcd(lcd.s, `${process.env.GOLD_SHOTS}/chrome_list.png`);
    }
  });
});
