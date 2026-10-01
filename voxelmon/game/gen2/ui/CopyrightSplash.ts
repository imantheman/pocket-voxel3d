// gen1recomp src/ui/gen2/CopyrightSplash.lua (bdfac727): the boot copyright
// card (pokegold SplashScreen -> Copyright), ~100 frames then on to the GAME
// FREAK splash; A/B/START skip it.
//
// The cart's card is the three Nintendo / Creatures / GAME FREAK lines from
// CopyrightGFX, composed by the importer into title/copyright_splash.

import G, { type LcdImage } from "../platform/screen.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Assets } from "../shared/render/Assets.ts";
import { Font } from "../shared/render/Font.ts";

// Lua: CopyrightSplash.lua:19
const SCREEN_W = 160;
const SCREEN_H = 144;
const HOLD_FRAMES = 100;

// Lua: CopyrightSplash.lua:24 -- only used when the extracted splash is missing
const LINE_Y = [48, 64, 80];

// Lua: CopyrightSplash.lua:28 -- Gold boots on the default BGP
// (../pokecrystal/engine/movie/splash.asm:20-30)
const DEFAULT_BACKDROP = [1, 1, 1];
const DEFAULT_INK = [0, 0, 0];

// Lua: CopyrightSplash.lua:31
function tryImage(path: string | null | undefined): LcdImage | null {
  if (!path) return null;
  try {
    return Assets.image(path);
  } catch {
    return null;
  }
}

export interface CopyrightSplashOpts {
  onDone?: () => void;
  title?: any;
  image?: string;
  backdrop?: number[];
  ink?: number[];
  lines?: string[];
}

export class CopyrightSplash {
  static isOpaque = true;

  isOpaque = true;
  game: any;
  onDone: (() => void) | undefined;
  image: LcdImage | null;
  backdrop: number[];
  ink: number[];
  lines: string[] | undefined;
  frames = 0;
  done = false;

  constructor(game: any, opts: CopyrightSplashOpts = {}) {
    this.game = game;
    this.onDone = opts.onDone;
    const title = opts.title ?? {};
    // prefer an explicit override, then the extracted splash from title.json
    this.image = tryImage(opts.image) ?? tryImage(title.copyrightSplash) ?? tryImage("assets/generated/title/copyright_splash.png");
    this.backdrop = opts.backdrop ?? title.copyrightBackdrop ?? DEFAULT_BACKDROP;
    this.ink = opts.ink ?? title.copyrightInk ?? DEFAULT_INK;
    // text fallback only when the ROM extract is missing (tests / bare boots)
    this.lines = opts.lines;
  }

  /** Lua: CopyrightSplash.lua:41 */
  static new(game: any, opts?: CopyrightSplashOpts): CopyrightSplash {
    return new CopyrightSplash(game, opts ?? {});
  }

  /** Lua: CopyrightSplash.lua:38 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: CopyrightSplash.lua:39 */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: CopyrightSplash.lua:70 -- intro.boot.copyright */
  enter(): void {
    if (Runtime.wants("intro.boot.copyright")) Runtime.emit("intro.boot.copyright", { screen: this, game: this.game });
  }

  /** Lua: CopyrightSplash.lua:76 */
  update(_dt?: number): void {
    this.frames += 1;
    const input = this.game.input;
    const skip = input && (input.wasPressed("a") || input.wasPressed("start") || input.wasPressed("b") || input.wasPressed("select"));
    if (skip || this.frames >= HOLD_FRAMES) {
      if (this.done) return;
      this.done = true;
      if (this.onDone) this.onDone();
    }
  }

  /** Lua: CopyrightSplash.lua:88 */
  fillBackdrop(width: number, height: number): void {
    const c = this.backdrop;
    G.setColor(c[0]!, c[1]!, c[2]!, 1);
    G.rectangle("fill", 0, 0, width, height);
  }

  /** Lua: CopyrightSplash.lua:95 */
  drawPanel(): void {
    this.fillBackdrop(SCREEN_W, SCREEN_H);
    if (this.image) {
      G.setColor(1, 1, 1, 1);
      G.draw(this.image, 0, 0);
      return;
    }
    if (!this.lines) return;
    // the Gen 2 font is a fixed 8px cell, so centring is a character count
    G.setColor(this.ink[0]!, this.ink[1]!, this.ink[2]!, 1);
    this.lines.forEach((line, index) => {
      const y = LINE_Y[index];
      if (y !== undefined) Font.draw(line, Math.floor((SCREEN_W - line.length * 8) / 2), y);
    });
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: CopyrightSplash.lua:115 */
  draw(): void {
    this.drawPanel();
  }

  /** Lua: CopyrightSplash.lua:119 -- the Gold screen is the panel: no fit. */
  drawWidescreen(winW: number, winH: number): void {
    this.fillBackdrop(winW, winH);
    this.drawPanel();
  }
}

export default CopyrightSplash;
