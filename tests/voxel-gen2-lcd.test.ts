// The Gold screen, guest side (voxelmon/game/gen2/platform/lcd.ts): the
// immediate-mode frame builder sends only what changed, and renderLcd draws
// what crates/pocketvoxel-core/src/lcd.rs draws for the same state.

import { describe, expect, test } from "bun:test";
import { RecorderHost } from "../voxelmon/game/host.ts";
import {
  ATTR_PRIORITY,
  FLAG_BG_ON,
  FLAG_WIN_ON,
  LCD_HOLE,
  LCD_W,
  Lcd,
  LcdState,
  renderLcd,
  WINDOW,
  type Palette4,
} from "../voxelmon/game/gen2/platform/lcd.ts";

/** Tile t's pixels are all colour t % 4 (lcd.rs tests' `flat`). */
const flat = (t: number): number => t % 4;

const WHITE_BLACK: Palette4 = [[255, 255, 255], [170, 170, 170], [85, 85, 85], [0, 0, 0]];

function ops(h: RecorderHost): string[] {
  h.frameDone(0, 0);
  return h.text().split("\n").filter((l) => l.startsWith("o ") || l.startsWith("s "));
}

describe("gen2 lcd", () => {
  test("a fresh state is all hole", () => {
    expect(renderLcd(new LcdState(), flat).every((p) => p === LCD_HOLE)).toBe(true);
  });

  test("cells, objects and priority draw as lcd.rs does", () => {
    const s = new LcdState();
    for (let x = 0; x < 32; x++) {
      s.cells[x] = 1;
      s.attrs[x] = 0;
    }
    s.objs.push({ x: 4, y: 2, tile: 2, attr: 3 });
    let f = renderLcd(s, flat);
    expect(f[2 * LCD_W + 4]).toBe((16 + 3) * 4 + 2);
    expect(f[2 * LCD_W + 3]).toBe(1);
    s.objs[0] = { x: -4, y: 0, tile: 2, attr: 0 };
    f = renderLcd(s, flat);
    expect(f[3]).toBe(16 * 4 + 2);
    expect(f[4]).toBe(1);
    for (let x = 0; x < 32; x++) s.attrs[x] = ATTR_PRIORITY;
    f = renderLcd(s, flat);
    expect(f[3]).toBe(1);
  });

  test("the window covers and its holes uncover", () => {
    const s = new LcdState();
    for (let i = 0; i < 18 * 32; i++) {
      s.cells[i] = 1;
      s.attrs[i] = 0;
    }
    for (let x = 0; x < 32; x++) {
      s.cells[WINDOW + 32 + x] = 3;
      s.attrs[WINDOW + 32 + x] = 1;
    }
    s.wy = 16;
    s.flags = FLAG_BG_ON | FLAG_WIN_ON;
    const f = renderLcd(s, flat);
    expect(f[0]).toBe(1);
    expect(f[16 * LCD_W]).toBe(LCD_HOLE);
    expect(f[24 * LCD_W]).toBe(4 + 3);
  });

  test("end() sends only what changed", () => {
    const h = new RecorderHost();
    const lcd = new Lcd(h);
    lcd.shown = true;
    lcd.begin();
    const pal = lcd.palette(WHITE_BLACK);
    lcd.fill(0, 12, 20, 6, 0x7f, pal);
    lcd.obj(8, 8, 0xed);
    lcd.end();
    const first = ops(h);
    // show, six cell rows, one palette run, objects; registers match the
    // core's defaults and are not sent
    expect(first.filter((l) => l.startsWith("o 96 ")).length).toBe(1);
    expect(first.filter((l) => l.startsWith("s 99 ")).length).toBe(6);
    expect(first.filter((l) => l.startsWith("s 102 ")).length).toBe(1);
    expect(first.filter((l) => l.startsWith("s 101 ")).length).toBe(1);
    expect(first.some((l) => l.startsWith("o 100 "))).toBe(false);
    expect(first.find((l) => l.startsWith("s 99 "))).toBe(
      `s 99 384 0 "${"007f00".repeat(20)}"`,
    );

    // the same frame again: nothing
    const h2 = new RecorderHost();
    const lcd2 = new Lcd(h2);
    lcd2.shown = true;
    for (let i = 0; i < 2; i++) {
      lcd2.begin();
      lcd2.fill(0, 12, 20, 6, 0x7f, lcd2.palette(WHITE_BLACK));
      lcd2.end();
      if (i === 0) ops(h2);
    }
    const again = new RecorderHost();
    const lcd3 = new Lcd(again);
    lcd3.shown = true;
    lcd3.begin();
    lcd3.fill(0, 12, 20, 6, 0x7f, lcd3.palette(WHITE_BLACK));
    lcd3.end();
    const before = ops(again).length;
    lcd3.begin();
    lcd3.fill(0, 12, 20, 6, 0x7f, lcd3.palette(WHITE_BLACK));
    lcd3.cell(5, 14, 0x80, 0);
    lcd3.end();
    const after = ops(again).length;
    // one changed cell: exactly one more cell op
    expect(after - before).toBe(1);
  });

  test("palettes are shared by colour and objects get their own slots", () => {
    const lcd = new Lcd(new RecorderHost());
    lcd.begin();
    expect(lcd.palette(WHITE_BLACK)).toBe(0);
    expect(lcd.palette([[255, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]])).toBe(1);
    expect(lcd.palette(WHITE_BLACK)).toBe(0);
    expect(lcd.palette(WHITE_BLACK, true)).toBe(0);
    expect(lcd.s.colours[0]).toBe(0x7fff);
    expect(lcd.s.colours[16 * 4 + 3]).toBe(0);
    expect(lcd.s.colours[4]).toBe(0x001f);
  });
});
