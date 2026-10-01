// gen1recomp src/ui/gen2/UnownPrinter.lua (bdfac727, MIT): the ALPH RUINS
// STAMP viewer (engine/events/print_unown.asm _UnownPrinter), reached through
// `special UnownPrinter` from the Ruins of Alph research centre's printer once
// every Unown form has been caught.
//
// Only the A press (`farcall PrintUnownStamp`) needs a peripheral. There is
// no printer here, so A lands on the arm a cartridge with nothing in its link
// port takes: the stamp does not print and the screen stays up.
//
// RotateUnownFrontpic (print_unown_2.asm) belongs to that stubbed half and is
// deliberately not ported: only the PRINTED page reads its rotated copy.
//
// Coordinates are the literal hlcoord operands _UnownPrinter writes at:
//
//   hlcoord 0, 0    Textbox, 3 rows by 18 columns
//   hlcoord 0, 5    Textbox, 7 by 7 -- the frame round the stamp
//   hlcoord 0, 14   Textbox, 2 by 18
//   hlcoord 1, 2    " ALPH RUINS STAMP"
//   hlcoord 1, 16   "Do what?"
//   hlcoord 10, 6   the four-row menu, one row per `next`
//   hlcoord 1, 6    the 7x7 frontpic, or ClearBox + "VACANT" at hlcoord 1, 9
//
// The bold A and B tiles (gfx/printer/bold_a.1bpp / bold_b.1bpp) are not
// extracted, so the ordinary font's A and B stand in (Brian's choice).
//
// THE SHEET IS ALL 26 FORMS, not the caught ones: .UpdateUnownFrontpic loads
// `wJumptableIndex + 1` whatever the #DEX holds; the 27th slot is VACANT.

import G from "../platform/screen.ts";
import type { LcdImage } from "../platform/screen.ts";
import { mod } from "../platform/lua.ts";
import { Assets } from "../shared/render/Assets.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Sprites } from "../shared/pokemon/Sprites.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Palettes } from "../world/Palettes.ts";
import { Unown } from "../core/Unown.ts";
import { Chrome } from "./Chrome.ts";

export interface UnownPrinterOpts {
  pokemon?: Record<string, any>;
  palettes?: any;
  onClose?: () => void;
}

// Lua: UnownPrinter.lua:60 -- AlphRuinsStampString keeps its leading space.
const TEXT = {
  title: Strings.source(" ALPH RUINS STAMP"),
  doWhat: Strings.source("Do what?"),
  vacant: Strings.source("VACANT"),
  menu: [
    Strings.source("A▶PRINT"),
    Strings.source("B▶CANCEL"),
    Strings.source("L▶BEFORE"),
    Strings.source("R▶NEXT"),
  ],
};

export class UnownPrinter {
  // Lua: UnownPrinter.lua:54
  static isOpaque = true;
  isOpaque = true;

  game: any;
  pokemon: Record<string, any> | undefined;
  palettes: any;
  onClose?: () => void;
  index: number;
  done: boolean;
  picCache: Record<string, LcdImage | false>;
  [key: string]: any;

  /** Lua: UnownPrinter.lua:56 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: UnownPrinter.lua:73 -- opts: pokemon, palettes, onClose() */
  static new(game: any, opts?: UnownPrinterOpts): UnownPrinter {
    return new UnownPrinter(game, opts ?? {});
  }

  constructor(game: any, opts: UnownPrinterOpts) {
    this.game = game;
    const data = (game && game.data) || {};
    this.pokemon = opts.pokemon || data.pokemon;
    this.palettes = opts.palettes || data.gen2Palettes;
    this.onClose = opts.onClose;
    // wJumptableIndex: 0..NUM_UNOWN - 1 are the letters and NUM_UNOWN is the
    // vacant slot, so the wheel is 27 long.
    this.index = 0;
    this.done = false;
    this.picCache = {};
  }

  /** Lua: UnownPrinter.lua:89 */
  slots(): number {
    return Unown.NUM_UNOWN + 1;
  }

  /** Lua: UnownPrinter.lua:94 -- the letter this slot shows, or undefined for VACANT. */
  letter(): number | undefined {
    if (this.index >= Unown.NUM_UNOWN) return undefined;
    return this.index + 1;
  }

  /** Lua: UnownPrinter.lua:99 */
  finish(): void {
    if (this.done) return;
    this.done = true;
    if (this.onClose) this.onClose();
  }

  /**
   * Lua: UnownPrinter.lua:110 -- .LeftRight and its two wraps. The cart reads
   * hJoyLast so holding scrolls; Brian uses edge detection like every other
   * Gold menu in the port.
   */
  update(_dt?: number): void {
    if (this.done) return;
    const input = this.game && this.game.input;
    if (!input) return;
    if (input.wasPressed("b")) {
      // .pressed_b: restore hInMenu/wOptions and ReturnToMapFromSubmenu.
      this.finish();
      return;
    }
    if (input.wasPressed("a")) {
      // .pressed_a is `farcall PrintUnownStamp / call RestartMapMusic` and
      // back into the joypad loop; with no printer it is a no-op.
      return;
    }
    if (input.wasPressed("right")) {
      this.index = mod(this.index + 1, this.slots());
    } else if (input.wasPressed("left")) {
      this.index = mod(this.index - 1, this.slots());
    }
  }

  /** Lua: UnownPrinter.lua:133 */
  picFor(letter: number): [LcdImage | undefined, boolean] {
    const vanilla = Unown.formSprite(this.pokemon, letter, false);
    if (!vanilla) return [undefined, false];
    const [path, trueColor] = Sprites.pic(vanilla, {
      species: Unown.SPECIES,
      side: "front",
      kind: "unown_printer",
      data: this.game && this.game.data,
      letter,
    } as any);
    if (!path) return [undefined, trueColor];
    let cached = this.picCache[path];
    if (cached === undefined) {
      try {
        cached = Assets.image(path) || false;
      } catch {
        cached = false;
      }
      this.picCache[path] = cached;
    }
    return [cached || undefined, trueColor];
  }

  /** Lua: UnownPrinter.lua:155 -- .UpdateUnownFrontpic: the 7x7 pic at hlcoord 1, 6. */
  drawPic(letter: number): void {
    const [image, trueColor] = this.picFor(letter);
    if (!image) return;
    const colors = this.palettes && Palettes.monColors(this.palettes, Unown.SPECIES);
    G.setColor(1, 1, 1, 1);
    const body = () => G.draw(image, 1 * 8, 6 * 8);
    if (colors && !(trueColor && GbcPalette.mode === "gbc") && GbcPalette.available()) {
      GbcPalette.with(colors, body);
    } else {
      body();
    }
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: UnownPrinter.lua:172 */
  drawPanel(): void {
    Chrome.clear();
    Chrome.textbox(0, 0, 18, 3);
    Chrome.textbox(0, 5, 7, 7);
    Chrome.textbox(0, 14, 18, 2);

    Chrome.print(Strings.get(TEXT.title), 1, 2);
    Chrome.print(Strings.get(TEXT.doWhat), 1, 16);
    TEXT.menu.forEach((row, i) => {
      Chrome.print(Strings.get(row), 10, 6 + i);
    });

    const letter = this.letter();
    if (letter != null) {
      this.drawPic(letter);
    } else {
      // .vacant: ClearBox over the 7x7 block, then VACANT across its middle.
      Chrome.print(Strings.get(TEXT.vacant), 1, 9);
    }
  }

  /** Lua: UnownPrinter.lua:193 */
  draw(): void {
    this.drawPanel();
  }

  /**
   * Lua: UnownPrinter.lua:200 -- _PrintUnown opens on ClearBGPalettes /
   * ClearTilemap, so the panel's Chrome.clear() white IS the surround.
   */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: UnownPrinter.lua:202 */
  drawWidescreen(winW: number, winH: number): void {
    Chrome.letterbox(winW, winH, 1, 1, 1);
    const scale = Chrome.fitScale();
    const [ox, oy] = Chrome.fitOrigin();
    G.push();
    G.translate(ox, oy);
    G.scale(scale, scale);
    this.drawPanel();
    G.pop();
  }
}

export default UnownPrinter;
