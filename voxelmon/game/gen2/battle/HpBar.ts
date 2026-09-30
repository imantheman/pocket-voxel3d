// The HP bar, exactly as the cart computes it: a port of gen1recomp
// src/battle/gen2/HpBar.lua (bdfac727, MIT).
//
// Two routines, and both matter for parity because the bar is what a player
// reads the whole battle off:
//
// engine/pokemon/health.asm ComputeHPBarPixels
//   pixels = curHP * HP_BAR_LENGTH_PX / maxHP, floored, where
//   HP_BAR_LENGTH_PX = HP_BAR_LENGTH (6 tiles) * TILE_WIDTH (8) = 48.
//   A live mon never shows an empty bar: a result of 0 is forced to 1.
//   A fainted mon shows exactly 0.
//   When maxHP >= 256 the routine divides both the product and maxHP by 4
//   first, because hDivisor is one byte -- so a high-HP mon's bar moves in
//   coarser steps than the exact ratio would.  Reproduced, not smoothed over.
//
// home/tilemap.asm GetHPPal
//   green  when pixels >= 24   (HP_BAR_LENGTH_PX * 50 / 100)
//   yellow when pixels >= 10   (HP_BAR_LENGTH_PX * 21 / 100, integer 10)
//   red    otherwise
//   Note the boundaries are inclusive on the *pixel* count, not a percentage:
//   exactly half HP is green, and the yellow floor is 10/48 rather than 21%.
//
// Colours themselves come from palettes.json's hpBar (gfx/battle/hp_bar.pal).
//
// Drawing: the Lua paints draw / drawWithLabel / drawExp through love.graphics.
// Here they paint through an HpBarPainter the caller passes in (first
// argument) -- the same rectangles in the same order, nothing added.

import { truthy } from "../platform/lua.ts";

/** An RGB colour, 0-255 a channel (palettes.json's entries). */
export type HpBarRgb = readonly [number, number, number];

/**
 * THE SEAM the UI port maps onto platform/lcd.ts (the Gold screen): the Lua's
 * `love.graphics.setColor(...)` + `rectangle("fill", x, y, w, h)` pairs become
 * one `rect` call each, in screen pixels, and `font.draw(s, x, y)` becomes
 * `text`.  Colours are either a palette RGB (0-255) or the Lua's literal
 * black / white.  The painter keeps no colour state (the Lua's trailing
 * `setColor(0, 0, 0, 1)` reset has nothing to reset here).
 */
export interface HpBarPainter {
  rect(x: number, y: number, w: number, h: number, rgb: HpBarRgb | "black" | "white"): void;
  text?(s: string, x: number, y: number): void;
}

/** Mon.experienceForLevel's shape: (GROWTH_* record, level) -> total exp. */
export type ExpLevelFor = (growth: any, level: number) => number;

export interface HpAnim {
  hp: number;
  to: number;
  maxHp: number;
  px: number;
  toPx: number;
  dir: number;
  long: boolean;
  low: number;
  high: number;
}

// Lua: HpBar.lua:26
const LENGTH_TILES = 6;
const TILE_WIDTH = 8;
const LENGTH_PX = LENGTH_TILES * TILE_WIDTH; // 48

// The Lua's fallback colours when palettes has no row, as 0-255:
// setColor(0.1, 0.1, 0.1) and setColor(0.3, 0.55, 0.95), rounded.
const HP_FILL_FALLBACK: HpBarRgb = [26, 26, 26];
const EXP_FILL_FALLBACK: HpBarRgb = [77, 140, 242];

// Lua: HpBar.lua:179 -- ../pokecrystal/engine/battle/anim_hp_bar.asm:129
function shortStep(anim: HpAnim): boolean {
  if (anim.px === anim.toPx) return true;
  anim.px = anim.px + anim.dir;
  anim.hp = HpBar.shortFrameHp(anim.px, anim.maxHp, anim.low, anim.high);
  return false;
}

// Lua: HpBar.lua:187 -- ../pokecrystal/engine/battle/anim_hp_bar.asm:145
function longStep(anim: HpAnim): boolean {
  while (true) {
    if (anim.hp === anim.to) return true;
    anim.hp = anim.hp + anim.dir;
    const px = HpBar.pixels(anim.hp, anim.maxHp);
    if (px !== anim.px) {
      anim.px = px;
      return false;
    }
  }
}

export const HpBar = {
  LENGTH_TILES,
  TILE_WIDTH,
  LENGTH_PX,
  // How tall the coloured channel is inside the bar's frame.  The cart's bar
  // tiles are 8px rows with a 1px rule above and below the fill.
  CHANNEL_PX: 3,

  // GetHPPal's thresholds, computed the way RGBDS does (integer division).
  GREEN_PIXELS: Math.floor((LENGTH_PX * 50) / 100), // 24
  YELLOW_PIXELS: Math.floor((LENGTH_PX * 21) / 100), // 10

  // Lua: HpBar.lua:38 -- pixels of bar to fill, 0..48.
  pixels(hp: number | undefined | null, maxHp: number | undefined | null): number {
    const h = Math.max(0, hp ?? 0);
    const m = Math.max(0, maxHp ?? 0);
    if (h === 0) return 0;
    if (m === 0) return 0;
    let product = h * HpBar.LENGTH_PX;
    let divisor = m;
    if (divisor >= 256) {
      // The one-byte-divisor shift, applied to both sides.
      product = Math.floor(product / 4);
      divisor = Math.floor(divisor / 4);
      if (divisor === 0) divisor = 1;
    }
    const pixels = Math.floor(product / divisor);
    if (pixels === 0) return 1;
    return Math.min(HpBar.LENGTH_PX, pixels);
  },

  // Lua: HpBar.lua:57 -- "green" / "yellow" / "red", keyed to match palettes' hpBar table.
  palette(pixels: number | undefined | null): "green" | "yellow" | "red" {
    if ((pixels ?? 0) >= HpBar.GREEN_PIXELS) return "green";
    if ((pixels ?? 0) >= HpBar.YELLOW_PIXELS) return "yellow";
    return "red";
  },

  // Lua: HpBar.lua:63
  paletteFor(hp: number | undefined | null, maxHp: number | undefined | null): "green" | "yellow" | "red" {
    return HpBar.palette(HpBar.pixels(hp, maxHp));
  },

  // Lua: HpBar.lua:69 -- the bar's two colours out of palettes: the light
  // background the empty part of the bar shows, and the fill.  (Two Lua
  // returns; here a pair.)
  colors(palettes: any, key: string): [HpBarRgb | undefined, HpBarRgb | undefined] {
    const pal = truthy(palettes) && truthy(palettes.hpBar) ? palettes.hpBar[key] : undefined;
    if (!truthy(pal)) return [undefined, undefined];
    return [pal[0], pal[1]];
  },

  // Lua: HpBar.lua:81 -- draw the bar at a pixel position: 6 tiles wide, black
  // frame, white interior, coloured fill from the left.
  //
  // The cart builds it out of tiles -- $62 is an empty bar cell and $63..$6a
  // are the eight partial fills, so the fill really does move one pixel at a
  // time inside a fixed 48px frame, and the *unfilled* part is white, not tinted.
  draw(
    painter: HpBarPainter | undefined | null,
    palettes: any,
    hp: number | undefined,
    maxHp: number | undefined,
    px: number,
    py: number,
    pixels?: number,
  ): void {
    if (!truthy(painter)) return;
    const P = painter!;
    const pix = pixels ?? HpBar.pixels(hp, maxHp);
    const [, fill] = HpBar.colors(palettes, HpBar.palette(pix));
    // Frame: one pixel of black around the 48x2 channel the fill lives in.
    P.rect(px - 1, py - 1, HpBar.LENGTH_PX + 2, HpBar.CHANNEL_PX + 2, "black");
    P.rect(px, py, HpBar.LENGTH_PX, HpBar.CHANNEL_PX, "white");
    if (pix > 0) {
      P.rect(px, py, pix, HpBar.CHANNEL_PX, truthy(fill) ? fill! : HP_FILL_FALLBACK);
    }
  },

  // Lua: HpBar.lua:109 -- the battle HUD's bar, which is the plain bar with the
  // cart's "HP:" prefix in front of it (tiles $60/$61 in home/pokemon.asm, two
  // tiles wide).  `tx`/`ty` are the tile the prefix starts at; the bar follows
  // two tiles later, so the whole assembly is 2 + 6 = 8 tiles wide.  `font`
  // gates the label as in the Lua; the label is painted by painter.text.
  //
  // Returns the tile column just past the bar, so a caller can put the bar's
  // end cap or the frame stub there.
  drawWithLabel(
    painter: HpBarPainter | undefined | null,
    palettes: any,
    hp: number | undefined,
    maxHp: number | undefined,
    tx: number,
    ty: number,
    font?: unknown,
    pixels?: number,
  ): number {
    if (truthy(font) && truthy(painter) && painter!.text) {
      painter!.text("HP:", tx * 8, ty * 8);
    }
    // The bar's channel sits in the middle of the tile row, matching the tiles.
    HpBar.draw(painter, palettes, hp, maxHp, (tx + 2) * 8, ty * 8 + 2, pixels);
    return tx + 2 + HpBar.LENGTH_TILES;
  },

  // Lua: HpBar.lua:122 -- the experience bar under the player's HUD
  // (FillInExpBar).  Same 6-tile width, but it fills toward the *next* level
  // rather than showing a ratio of a maximum, and it is a flat blue with no
  // colour states (gfx/battle/exp_bar.pal).
  drawExp(painter: HpBarPainter | undefined | null, palettes: any, fraction: number | undefined, px: number, py: number): void {
    if (!truthy(painter)) return;
    const P = painter!;
    const f = Math.max(0, Math.min(1, fraction ?? 0));
    const pixels = Math.floor(f * HpBar.LENGTH_PX);
    const pal = truthy(palettes) ? palettes.expBar : undefined;
    const fill: HpBarRgb | undefined = truthy(pal) && truthy(pal[1]) ? pal[1] : truthy(pal) ? pal[0] : undefined;
    P.rect(px - 1, py - 1, HpBar.LENGTH_PX + 2, 3, "black");
    P.rect(px, py, HpBar.LENGTH_PX, 1, "white");
    if (pixels > 0) {
      P.rect(px, py, pixels, 1, truthy(fill) ? fill! : EXP_FILL_FALLBACK);
    }
  },

  // Lua: HpBar.lua:145 -- engine/battle/anim_hp_bar.asm:129
  stepToward(shown: number | undefined, target: number | undefined, maxHp: number | undefined): number {
    const s = shown ?? 0;
    const t = target ?? 0;
    let step = 1;
    if ((maxHp ?? 0) >= HpBar.LENGTH_PX) {
      step = Math.max(1, Math.ceil(maxHp! / HpBar.LENGTH_PX));
    }
    if (s < t) return Math.min(t, s + step);
    return Math.max(t, s - step);
  },

  // Lua: HpBar.lua:157 -- ../pokecrystal/engine/battle/anim_hp_bar.asm:359
  shortFrameHp(pixels: number, maxHp: number, lowHp: number, highHp: number): number {
    if (pixels >= HpBar.LENGTH_PX) return maxHp;
    if (pixels <= 0) return 0;
    const hp = Math.floor((maxHp * pixels) / HpBar.LENGTH_PX) + 1;
    if (lowHp >= hp) return lowHp;
    if (highHp < hp) return highHp;
    return hp;
  },

  // Lua: HpBar.lua:167 -- ../pokecrystal/engine/battle/anim_hp_bar.asm:56
  newAnim(from?: number, to?: number, maxHp?: number): HpAnim {
    const f = from ?? 0;
    const t = to ?? 0;
    const m = maxHp ?? 0;
    return {
      hp: f,
      to: t,
      maxHp: m,
      px: HpBar.pixels(f, m),
      toPx: HpBar.pixels(t, m),
      dir: t < f ? -1 : 1,
      long: m >= HpBar.LENGTH_PX,
      low: Math.min(f, t),
      high: Math.max(f, t),
    };
  },

  // Lua: HpBar.lua:200 -- ../pokecrystal/engine/battle/anim_hp_bar.asm:1
  // One frame of the bar animation; true when it has arrived.
  animStep(anim: HpAnim): boolean {
    if (anim.long) return longStep(anim);
    return shortStep(anim);
  },

  // Lua: HpBar.lua:206 -- how far along its current level a mon is, for the exp bar.
  expFraction(mon: any, growth: any, levelFor: ExpLevelFor | undefined | null): number {
    if (!(truthy(mon) && truthy(growth) && truthy(levelFor))) return 0;
    const level = mon.level ?? 1;
    const base = levelFor!(growth, level);
    const next = levelFor!(growth, level + 1);
    if (next <= base) return 0;
    const into = (mon.experience ?? base) - base;
    return Math.max(0, Math.min(1, into / (next - base)));
  },
};

export default HpBar;
