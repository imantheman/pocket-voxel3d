// gen1recomp src/ui/gen2/IntroFade.lua (bdfac727): the intro/Oak palette
// fades.
// ../pokecrystal/home/fade.asm:22-101 RotateFourPalettes* / RotateThreePalettes*
// (ui/MenuFade.ts is the other ramp, home/map.asm:1910-1940.)
//
// On the Gold screen the fade is what it was on the cart: an rBGP byte every
// draw goes through (GbcPalette.setBgp), so `paint` is the whole effect.

import G from "../platform/screen.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";

export type FadeKind = "outBlack" | "inBlack" | "outWhite" | "inWhite";

// IntroFade.lua:10 -- ../pokecrystal/home/fade.asm:56-57, :99-100
const STEP_FRAMES = 8;

// IntroFade.lua:18 -- pokecrystal/home/fade.asm:106-113; home/palettes.asm:69-113
// outBlack  RotateFourPalettesLeft   03 02 01 00
// inBlack   RotateFourPalettesRight  00 01 02 03
// outWhite  RotateThreePalettesRight 05 06 07
// inWhite   RotateThreePalettesLeft  06 05 04
const ROWS: Record<FadeKind, number[]> = {
  outBlack: [0xe4, 0xf9, 0xfe, 0xff],
  inBlack: [0xff, 0xfe, 0xf9, 0xe4],
  outWhite: [0x90, 0x40, 0x00],
  inWhite: [0x40, 0x90, 0xe4],
};

// IntroFade.lua:26
const LEVELS: Record<FadeKind, number[]> = {
  outBlack: [0, 1 / 3, 2 / 3, 1],
  inBlack: [1, 2 / 3, 1 / 3, 0],
  outWhite: [1 / 3, 2 / 3, 1],
  inWhite: [2 / 3, 1 / 3, 0],
};

const BLACK: [number, number, number] = [0, 0, 0];
const WHITE: [number, number, number] = [1, 1, 1];
const COLORS: Record<FadeKind, [number, number, number]> = {
  outBlack: BLACK,
  inBlack: BLACK,
  outWhite: WHITE,
  inWhite: WHITE,
};

/** The fields IntroFade's owner-side mixin keeps on its owner. */
export interface FadeOwner {
  fade?: IntroFade | null;
  fadeQueue?: FadeKind[] | null;
  fadeAt?: number | null;
  fadeDone?: (() => void) | null;
  [key: string]: any;
}

export class IntroFade {
  static STEP_FRAMES = STEP_FRAMES;
  static ROWS = ROWS;
  static FOUR_FRAMES = 4 * STEP_FRAMES;
  static THREE_FRAMES = 3 * STEP_FRAMES;

  kind: FadeKind;
  rows: number[];
  levels: number[];
  color: [number, number, number];
  frame = 0;
  total: number;

  constructor(kind: FadeKind) {
    this.kind = kind;
    this.rows = ROWS[kind];
    this.levels = LEVELS[kind];
    this.color = COLORS[kind];
    this.total = this.rows.length * STEP_FRAMES;
  }

  /** IntroFade.lua:41 */
  static frames(kind: string): number {
    const rows = ROWS[kind as FadeKind];
    return rows ? rows.length * STEP_FRAMES : 0;
  }

  /** IntroFade.lua:46 */
  static new(kind: string): IntroFade | null {
    if (!ROWS[kind as FadeKind]) return null;
    return new IntroFade(kind as FadeKind);
  }

  /** IntroFade.lua:59 */
  done(): boolean {
    return this.frame >= this.total;
  }

  /** IntroFade.lua:61 */
  tick(): boolean {
    if (this.frame < this.total) this.frame += 1;
    return this.done();
  }

  /** IntroFade.lua:66 -- 1-based, as the Lua. */
  index(): number {
    let k = Math.floor(this.frame / STEP_FRAMES) + 1;
    if (k > this.rows.length) k = this.rows.length;
    return k;
  }

  /** IntroFade.lua:73 -- pokecrystal/home/palettes.asm:69-113 */
  bgp(): number {
    return this.rows[this.index() - 1]!;
  }

  /** IntroFade.lua:77 */
  level(): number {
    return this.levels[this.index() - 1]!;
  }

  /**
   * IntroFade.lua:81 -- the no-shader fallback: a translucent veil. The Gold
   * screen has no alpha, so this is only reached if GbcPalette is off, and
   * then paints solid once the level passes half.
   */
  draw(w: number, h: number): void {
    const a = this.level();
    if (a <= 0) return;
    const c = this.color;
    // NOT FAITHFUL: no alpha on the Gold screen; the veil is all or nothing
    if (a < 0.5) return;
    G.setColor(c[0], c[1], c[2], 1);
    G.rectangle("fill", 0, 0, w, h);
    G.setColor(1, 1, 1, 1);
  }

  /** IntroFade.lua:91 -- the Lua's three returns as a tuple. */
  blend(r: number, g: number, b: number): [number, number, number] {
    const a = this.level();
    const c = this.color;
    return [r + (c[0] - r) * a, g + (c[1] - g) * a, b + (c[2] - b) * a];
  }

  // ---------------------------------------------------------- owner-side mixin

  /** IntroFade.lua:99 */
  static step(owner: FadeOwner): void {
    owner.fadeAt = (owner.fadeAt ?? 0) + 1;
    const kind = owner.fadeQueue ? owner.fadeQueue[owner.fadeAt - 1] : undefined;
    if (!kind) {
      owner.fade = null;
      owner.fadeQueue = null;
      owner.fadeAt = null;
      const fn = owner.fadeDone;
      owner.fadeDone = null;
      if (fn) fn();
      return;
    }
    owner.fade = IntroFade.new(kind);
  }

  /** IntroFade.lua:112 */
  static run(owner: FadeOwner, kinds: FadeKind[], onDone?: () => void): void {
    owner.fadeQueue = kinds;
    owner.fadeAt = 0;
    owner.fadeDone = onDone ?? null;
    IntroFade.step(owner);
  }

  /** IntroFade.lua:117 */
  static busy(owner: FadeOwner): boolean {
    return owner.fade != null;
  }

  /** IntroFade.lua:122 -- true when the fade owned this frame. */
  static advance(owner: FadeOwner): boolean {
    if (!owner.fade) return false;
    if (owner.fade.tick()) IntroFade.step(owner);
    return true;
  }

  /** IntroFade.lua:129 -- pokecrystal/home/palettes.asm:69-113 */
  static paint(owner: FadeOwner, w: number, h: number, drawFn: () => void): void {
    const fade = owner.fade;
    if (!fade) {
      drawFn();
      return;
    }
    if (!GbcPalette.available()) {
      drawFn();
      fade.draw(w, h);
      return;
    }
    const previous = GbcPalette.setBgp(fade.bgp());
    try {
      drawFn();
    } finally {
      GbcPalette.setBgp(previous);
    }
  }

  /** IntroFade.lua:142 -- the surround colour under the fade; a tuple. */
  static surround(owner: FadeOwner, palette: readonly (readonly number[])[] | null | undefined, r: number, g: number, b: number, index?: number): [number, number, number] {
    const fade = owner.fade;
    if (!fade) return [r, g, b];
    if (GbcPalette.available() && palette) {
      const remapped = GbcPalette.remap(GbcPalette.resolve(palette), fade.bgp());
      const c = remapped ? remapped[(index ?? 1) - 1] : undefined;
      if (c) return [c[0]! / 255, c[1]! / 255, c[2]! / 255];
    }
    return fade.blend(r, g, b);
  }
}

export default IntroFade;
