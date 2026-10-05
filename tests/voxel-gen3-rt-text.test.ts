// The gen3 runtime's text, window chrome and boot screens (ui/frlg_font,
// chrome, window, message, title_screen, intro_movie) on real FireRed cache
// data, drawn through the love.graphics shim into the DesktopHost rasteriser
// and checked pixel by pixel against the cache's own glyph and frame atlases.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { setHost } from "../voxelmon/game/gen3/platform/host.ts";
import { G } from "../voxelmon/game/gen3/platform/graphics.ts";
import { encodePng } from "../voxelmon/import/gen3/png.ts";
import { NotPortedError } from "../voxelmon/game/gen3/notported.ts";

const ROOT = join(homedir(), "gen3ref/frfull");
const GBA = join(ROOT, "data/generated/gba");
const SHOTS = "/tmp/g3shots";
const GEN3 = join(import.meta.dir, "../voxelmon/game/gen3");

/** Still a tools/gen3/stubs.py stub? */
function stubbed(rel: string): boolean {
  return readFileSync(join(GEN3, rel), "latin1").startsWith("// @gen3-stub");
}
const screenDepsStubbed = ["core/display.ts", "core/bg.ts", "core/oam.ts", "core/pal_fade.ts"].some(stubbed);

function shot(host: DesktopHost, name: string): void {
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, name), encodePng(240, 160, host.pixels()));
}
function px(host: DesktopHost, x: number, y: number): [number, number, number] {
  const p = host.pixels(), o = (y * 240 + x) * 4;
  return [p[o]!, p[o + 1]!, p[o + 2]!];
}
interface Sheet { w: number; h: number; px: Uint8Array }
function sheet(rel: string, w: number, h: number): Sheet {
  const b = new Uint8Array(readFileSync(join(GBA, rel)));
  expect(b.length).toBe(w * h * 4);
  return { w, h, px: b };
}
/** Source-over of a sheet texel tinted by colour c (0..255) onto dst. */
function over(dst: number[], s: Sheet, sx: number, sy: number, c: number[], flipY = false, cellH = 8, cy0 = 0): void {
  const yy = flipY ? cy0 + (cellH - 1 - (sy - cy0)) : sy;
  const o = (yy * s.w + sx) * 4;
  const a = s.px[o + 3]! / 255;
  if (a === 0) return;
  for (let k = 0; k < 3; k++) dst[k] = Math.round((s.px[o + k]! * c[k]! / 255) * a + dst[k]! * (1 - a));
}
function near(a: number[], b: number[], tol = 1): boolean {
  return Math.abs(a[0]! - b[0]!) <= tol && Math.abs(a[1]! - b[1]!) <= tol && Math.abs(a[2]! - b[2]!) <= tol;
}

describe.skipIf(!existsSync(GBA))("gen3 runtime: text, chrome, boot screens", async () => {
  const host = new DesktopHost(ROOT);
  setHost(host);
  const { FrlgFont } = await import("../voxelmon/game/gen3/ui/frlg_font.ts");
  const { Chrome } = await import("../voxelmon/game/gen3/ui/chrome.ts");
  const { Window } = await import("../voxelmon/game/gen3/ui/window.ts");
  const { Message } = await import("../voxelmon/game/gen3/ui/message.ts");

  const fg = sheet("chrome/fonts/latin_normal_fg.rgba", 256, 512);
  const sh = sheet("chrome/fonts/latin_normal_shadow.rgba", 256, 512);
  const widthsSrc = readFileSync(join(GBA, "chrome/fonts/latin_widths.lua"), "latin1");
  const widthOf = (id: number): number => Number(new RegExp(`\\[${id}\\] = (\\d+)`).exec(widthsSrc)![1]);

  /** The text as the cart composes it: each glyph's shadow then its foreground, left to right. */
  function expectedText(text: string, x0: number, y0: number, fgc: number[], shc: number[], bg: number[]): Map<number, number[]> {
    const out = new Map<number, number[]>();
    let pen = 0;
    for (const ch of text) {
      const id = FrlgFont.glyphId(ch);
      const gx = (id % 16) * 16, gy = Math.floor(id / 16) * 16;
      for (const [s, c] of [[sh, shc], [fg, fgc]] as [Sheet, number[]][]) {
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            const key = (y0 + y) * 240 + (x0 + pen + x);
            const cur = out.get(key) ?? [...bg];
            over(cur, s, gx + x, gy + y, c);
            out.set(key, cur);
          }
        }
      }
      pen += widthOf(id);
    }
    return out;
  }
  function compare(map: Map<number, number[]>): { bad: number; ink: number } {
    let bad = 0, ink = 0;
    for (const [key, want] of map) {
      const got = px(host, key % 240, Math.floor(key / 240));
      if (!near(got, want)) bad++;
      if (!near(want, [255, 255, 255], 0)) ink++;
    }
    return { bad, ink };
  }

  test("frlg_font metrics come from the ROM width table", () => {
    expect(FrlgFont.glyphId("A")).toBe(0xBB);
    expect(FrlgFont.glyphId("a")).toBe(0xD5);
    expect(FrlgFont.glyphId("\xE2\x96\xB6")).toBe(0xEF); // ▶ (UTF-8 bytes)
    expect(FrlgFont.advance(0xBB)).toBe(widthOf(0xBB));
    const s = "Hello there!";
    let w = 0;
    for (const ch of s) w += widthOf(FrlgFont.glyphId(ch));
    expect(FrlgFont.measure(s)).toBe(w);
    expect(FrlgFont.countChars("AB{PKMN}\nC")).toBe(6);
    // wrap fits the 208px dialogue box
    const wrapped = FrlgFont.wrap("The quick brown fox jumps over the lazy dog and keeps on running far away", 208);
    for (const line of wrapped.split("\n")) expect(FrlgFont.measure(line)).toBeLessThanOrEqual(208);
    expect(wrapped.split("\n").length).toBeGreaterThan(1);
  });

  test("frlg_font draws glyph pixels in the right colours and places", () => {
    const text = "Hello, PROF. OAK!";
    G.beginFrame();
    G.clear(1, 1, 1, 1);
    const [drawn, endX] = FrlgFont.draw(text, 8, 8, { colors: FrlgFont.COLOR.NORMAL });
    // a second line in red / light red, from a {COLOR} tag and an opts colour table
    FrlgFont.draw("Red text", 8, 40, { colors: FrlgFont.COLOR.RED });
    G.endFrame();
    shot(host, "text_normal.png");
    expect(drawn).toBe(text.length);
    let w = 0;
    for (const ch of text) w += widthOf(FrlgFont.glyphId(ch));
    expect(endX).toBe(8 + w);

    const DARK = [98, 98, 98], LIGHT = [213, 213, 205], RED = [230, 8, 8], LRED = [255, 189, 115];
    const a = compare(expectedText(text, 8, 8, DARK, LIGHT, [255, 255, 255]));
    expect(a.ink).toBeGreaterThan(200);
    expect(a.bad).toBe(0);
    const b = compare(expectedText("Red text", 8, 40, RED, LRED, [255, 255, 255]));
    expect(b.ink).toBeGreaterThan(80);
    expect(b.bad).toBe(0);
    // both palette colours really appear
    const seen = new Set<string>();
    for (let y = 8; y < 24; y++) for (let x = 8; x < 8 + w; x++) seen.add(px(host, x, y).join(","));
    expect(seen.has(DARK.join(","))).toBe(true);
    expect(seen.has(LIGHT.join(","))).toBe(true);
  });

  test("control codes: an inline colour switch and limitChars (typewriter)", () => {
    G.beginFrame();
    G.clear(1, 1, 1, 1);
    FrlgFont.draw("AB{COLOR BLUE}CD", 8, 8);
    const [drawn] = FrlgFont.draw("Typewriter", 8, 40, { limitChars: 4 });
    G.endFrame();
    expect(drawn).toBe(4);
    const ab = FrlgFont.measure("AB");
    const blue = compare(expectedText("CD", 8 + ab, 8, [49, 82, 205], [213, 213, 205], [255, 255, 255]));
    expect(blue.bad).toBe(0);
    // nothing right of "Type"
    const typeW = FrlgFont.measure("Type");
    let ink = 0;
    for (let y = 40; y < 56; y++) for (let x = 8 + typeW + 2; x < 120; x++) if (!near(px(host, x, y), [255, 255, 255], 0)) ink++;
    expect(ink).toBe(0);
  });

  test("window chrome: std 9-slice and the dialogue frame match the cache tiles", () => {
    const user0 = sheet("chrome/user_frame_0.rgba", 24, 24); // stdFrame: the player's frame type (0)
    const std = sheet("chrome/std_rgba.rgba", 24, 24); // fixedStdFrame
    const dlg = sheet("chrome/menu_message_rgba.rgba", 48, 24);
    const BG = [0, 0, 0];
    G.beginFrame();
    G.clear(0, 0, 0, 1);
    const tpl = Window.template(2, 2, 10, 4);
    Window.stdFrame(tpl);
    Window.print("POKEMON", 2, 2);
    Window.cursor(13, 2);
    Window.fixedStdFrame(Window.template(17, 2, 8, 4));
    Window.dialogueFrame();
    G.endFrame();
    shot(host, "window_frames.png");

    // 9-slice: tile k of the 3x3 atlas at its cell around content (L, T, W, H)
    const nine = (atlas: Sheet, L: number, T: number, W: number, H: number): number => {
      const cells: [number, number, number][] = [[0, L - 1, T - 1], [1, L, T - 1], [2, L + W, T - 1], [3, L - 1, T],
        [5, L + W, T], [6, L - 1, T + H], [7, L, T + H], [8, L + W, T + H]];
      let n = 0;
      for (const [tile, cx, cy] of cells) {
        const sx0 = (tile % 3) * 8, sy0 = Math.floor(tile / 3) * 8;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          const want = [...BG];
          over(want, atlas, sx0 + x, sy0 + y, [255, 255, 255]);
          if (!near(px(host, cx * 8 + x, cy * 8 + y), want)) n++;
        }
      }
      return n;
    };
    expect(nine(user0, 2, 2, 10, 4)).toBe(0);
    expect(nine(std, 17, 2, 8, 4)).toBe(0);
    let bad = 0;
    // interior is PIXEL_FILL(1) white where no text is
    expect(px(host, 2 * 8 + 70, 2 * 8 + 28)).toEqual([255, 255, 255]);

    // dialogue frame (2,15) 26x4: tile 0 top-left, tile 2 along the top, the bottom V-flipped
    const L = Chrome.DLG_LEFT, Top = Chrome.DLG_TOP, W = Chrome.DLG_W;
    const dcells: [number, number, number, boolean][] = [
      [0, L - 2, Top - 1, false], [1, L - 1, Top - 1, false], [2, L + 5, Top - 1, false], [4, L + W + 1, Top - 1, false],
      [5, L - 2, Top, false], [10, L - 2, Top + 1, false], [0, L - 2, Top + 4, true], [2, L + 5, Top + 4, true],
    ];
    bad = 0;
    let ink = 0;
    for (const [tile, cx, cy, flip] of dcells) {
      const sx0 = (tile % 6) * 8, sy0 = Math.floor(tile / 6) * 8;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const want = [...BG];
        over(want, dlg, sx0 + x, sy0 + y, [255, 255, 255], flip, 8, sy0);
        if (!near(want, BG, 0)) ink++;
        if (!near(px(host, cx * 8 + x, cy * 8 + y), want)) bad++;
      }
    }
    expect(ink).toBeGreaterThan(100);
    expect(bad).toBe(0);
    expect(px(host, L * 8 + 50, Top * 8 + 10)).toEqual([255, 255, 255]);
  });

  test("message box: typewriter reveal, then the whole page in the dialogue frame", () => {
    Message.show("Hello there!\nWelcome to the world of POK\xC3\xA9MON!", { speed: 1 });
    expect(Message.isOpen()).toBe(true);
    expect(Message._total).toBeGreaterThan(20);
    for (let i = 0; i < 12; i++) Message.tick();
    const early = Message._revealed;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(Message._total);
    Message.skipReveal();
    expect(Message.isWaiting()).toBe(true);
    G.beginFrame();
    G.clear(0, 0, 0, 1);
    Message.draw();
    G.endFrame();
    shot(host, "message_box.png");
    // the first line's glyphs at (L*8, Top*8+1), dark grey on white
    const L = Chrome.DLG_LEFT, Top = Chrome.DLG_TOP;
    const r = compare(expectedText("Hello there!", L * 8, Top * 8 + 1, [98, 98, 98], [213, 213, 205], [255, 255, 255]));
    expect(r.ink).toBeGreaterThan(100);
    expect(r.bad).toBe(0);
    Message.close();
    expect(Message.isOpen()).toBe(false);
  });

  // The boot screens need the display/bg/oam/pal_fade cores (another
  // cluster's stubs right now); these run as soon as those are ported.
  test.skipIf(screenDepsStubbed)("title screen runs N frames and draws a changing frame", async () => {
    const { Boot } = await import("../voxelmon/game/gen3/ui/boot.ts");
    const { Title } = await import("../voxelmon/game/gen3/ui/title_screen.ts");
    const state = Boot.new();
    Title.enter(state);
    const input = { wasPressed: () => false, isDown: () => false };
    const sums: number[] = [];
    for (let f = 0; f < 240; f++) {
      Title.update(state, input, 1 / 60);
      if (f % 40 === 39) {
        G.beginFrame();
        Title.draw(state);
        G.endFrame();
        sums.push(host.pixels().reduce((a, v) => a + v, 0));
        if (f === 199) shot(host, "title.png");
      }
    }
    expect(new Set(sums).size).toBeGreaterThan(1);
  });

  test.skipIf(screenDepsStubbed)("intro movie runs N frames and draws a changing frame", async () => {
    const { Boot } = await import("../voxelmon/game/gen3/ui/boot.ts");
    const { IntroMovie } = await import("../voxelmon/game/gen3/ui/intro_movie.ts");
    const state = Boot.new();
    const m = IntroMovie.new(state.assets);
    const sums: number[] = [];
    for (let f = 0; f < 600; f++) {
      m.frame();
      if (f % 60 === 59) {
        G.beginFrame();
        m.draw();
        G.endFrame();
        sums.push(host.pixels().reduce((a, v) => a + v, 0));
        if (f === 119) shot(host, "intro_copyright.png");
        if (f === 479) shot(host, "intro_gf.png");
      }
    }
    expect(new Set(sums).size).toBeGreaterThan(1);
    m.destroy();
  });

  test.if(screenDepsStubbed)("boot screens reach the unported cores (blocker record)", async () => {
    const { IntroMovie } = await import("../voxelmon/game/gen3/ui/intro_movie.ts");
    let err: unknown;
    try { IntroMovie.new({}); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NotPortedError);
  });
});
