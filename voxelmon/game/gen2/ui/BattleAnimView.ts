// gen1recomp src/ui/gen2/BattleAnimView.lua (bdfac727, MIT): drawing for the
// Gen 2 battle-animation runtime.
//
// battle/AnimRunner.ts produces two things a frame: a list of OAM entries (the
// OBJ layer) and a set of BG register writes. The Lua draws the battle panel
// into a canvas and blits it back one scanline at a time at that scanline's own
// offset, because LÖVE has no scroll registers. The Gold screen does: the
// panel is drawn straight into the BG map as cells, the rest of the 32x32 map
// is filled with the blank tile (what a shifted scanline exposes), and the
// per-scanline offsets become `lcd.lines` -- which is what the cart's LCD STAT
// interrupt does with wLYOverridesBackup. OBJs are not affected by SCX/SCY on
// the hardware and are not here either.
//
// This class is also the AnimPainter (battle/AnimRunner.ts) the runner draws
// through: `obj` for an anim-sheet OAM entry, `battlerObj` for the battler
// pseudo-sheets, `bgEffect` for the BG state.

import { Assets } from "../shared/render/Assets.ts";
import { Chrome } from "./Chrome.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Palettes } from "../world/Palettes.ts";
import G, { currentLcd, type LcdImage, SOLID } from "../platform/screen.ts";
import { ATTR_HOLE, ATTR_PRIORITY, ATTR_X_FLIP, ATTR_Y_FLIP, type Palette4 } from "../platform/lcd.ts";
import type { AnimBgState, AnimPainter, AnimRunnerInstance } from "../battle/AnimRunner.ts";

type Colors = readonly (readonly number[])[];

// Lua: BattleAnimView.lua:28-33
const SCREEN_W = 160;
const SCREEN_H = 144;
const OAM_YFLIP = 0x40;
const OAM_XFLIP = 0x20;
const OAM_PRIORITY = 0x80;
const BGP_IDENTITY = 0xe4;
/** The BG map row a hidden ($90) scanline is pointed at: below the panel, all blank fill. */
const BLANK_MAP_ROW = 200;

// Every coordinate the runtime produces is a byte; "left of / above" arrives as
// two's complement.
// Lua: BattleAnimView.lua:37
function signed(value: number | undefined): number {
  const v = (((value ?? 0) % 256) + 256) % 256;
  return v < 0x80 ? v : v - 256;
}

type BgLike = Pick<AnimBgState, "scx" | "scy" | "lcdc" | "lyStart" | "lyEnd" | "lyBackup" | "bgp" | "liftedRows">;

// True when the BG layer needs the scanline treatment at all.
// Lua: BattleAnimView.lua:152
function needsCanvas(runner: { bg: BgLike }): boolean {
  const bg = runner.bg;
  // engine/battle_anims/bg_effects.asm:448-465
  const lifted = bg.liftedRows;
  if (lifted && (lifted.player || lifted.enemy)) return true;
  if (bg.scx !== 0 || bg.scy !== 0) return true;
  if (!bg.lcdc) return false;
  if (bg.lyEnd <= bg.lyStart) return false;
  for (let row = bg.lyStart; row <= Math.min(bg.lyEnd, SCREEN_H) - 1; row++) {
    if ((bg.lyBackup[row] ?? 0) !== 0) return true;
  }
  return false;
}

interface Band {
  byte: number;
  rows: number[];
}

// The rBGP window's scanlines grouped by the byte they hold, identity first.
// Lua: BattleAnimView.lua:243
function bgpBands(bg: BgLike): Band[] {
  const base = bg.bgp ?? GbcPalette.BGP_IDENTITY;
  const order: Band[] = [];
  const bands = new Map<number, Band>();
  for (let row = 0; row < SCREEN_H; row++) {
    // home/lcd.asm:12
    const inWindow = row > bg.lyStart && row <= bg.lyEnd;
    const byte = inWindow ? (bg.lyBackup[row - 1] ?? base) : base;
    let band = bands.get(byte);
    if (!band) {
      band = { byte, rows: [] };
      bands.set(byte, band);
      order.push(band);
    }
    band.rows.push(row);
  }
  order.sort((a, b) => {
    if (a.byte === b.byte) return 0;
    if (a.byte === base) return -1;
    if (b.byte === base) return 1;
    return a.rows[0]! - b.rows[0]!;
  });
  return order;
}

interface Scanline {
  src: number;
  dest: number;
  dx: number;
}

// engine/battle_anims/bg_effects.asm:2638
// Lua: BattleAnimView.lua:272
function scanlines(bg: BgLike): Scanline[] {
  const lines: Scanline[] = [];
  const scy = signed(bg.scy);
  for (let row = 0; row < SCREEN_H; row++) {
    let dx = 0;
    let src = row + scy;
    // home/lcd.asm:12
    const inWindow = !!bg.lcdc && bg.lcdc !== "BGP" && row > bg.lyStart && row <= bg.lyEnd;
    const byte = inWindow ? (bg.lyBackup[row - 1] ?? 0) : 0;
    if (inWindow) {
      const value = signed(byte);
      if (bg.lcdc === "SCX") dx = -value;
      else src = src + value;
      // home/lcd.asm:3
      if (byte !== 0x90 && scy === 0) {
        if (src < 0) src = 0;
        else if (src >= SCREEN_H) src = SCREEN_H - 1;
      }
    }
    if ((!inWindow || byte !== 0x90) && src >= 0 && src < SCREEN_H) {
      lines.push({ src, dest: row, dx });
    }
  }
  return lines;
}

// A DMG palette byte's mean shade against the identity, signed (+1 black, -1
// white). Kept for API parity: the Gold screen always has palettes.
// Lua: BattleAnimView.lua:363
function palVeil(palByte: number | undefined): number {
  if (palByte == null) return 0;
  let sum = 0;
  for (let index = 0; index < 4; index++) sum += Math.floor(palByte / 4 ** index) % 4;
  return (sum - 6) / 6;
}

// Lua: BattleAnimView.lua:381
const SLIDE_FRAMES = 72;

// BattleIntroSlidingPics (engine/battle/sliding_intro.asm): scanlines 0-$3f
// take `c` ($90 falling by 2 a frame), $40-$5f take `b` ($70 rising by 2).
// Lua: BattleAnimView.lua:383
function slideOffsets(frame: number): [number, number] {
  const step = Math.max(0, Math.min(SLIDE_FRAMES, frame));
  const top = (((0x90 - step * 2) % 256) + 256) % 256;
  const middle = (0x70 + step * 2) % 256;
  return [top, middle];
}

// Lua: BattleAnimView.lua:394
function slideBackpicOffset(frame: number): number {
  const step = Math.max(0, Math.min(SLIDE_FRAMES, frame));
  return (SLIDE_FRAMES - step) * 2;
}

// Lua: BattleAnimView.lua:442
function shadeColors(colors: Colors | null | undefined, palByte: number | null | undefined): Colors | null {
  return GbcPalette.remap(colors, palByte);
}

export class BattleAnimView implements AnimPainter {
  /** Set by BattleState while it draws a battle staged in 3D: leave holes open. */
  static openField = false;

  static SCREEN_W = SCREEN_W;
  static SCREEN_H = SCREEN_H;
  static SLIDE_FRAMES = SLIDE_FRAMES;
  static needsCanvas = needsCanvas;
  static bgpBands = bgpBands;
  static scanlines = scanlines;
  static palVeil = palVeil;
  static slideOffsets = slideOffsets;
  static slideBackpicOffset = slideBackpicOffset;
  static shadeColors = shadeColors;

  data: Record<string, any>;
  palettes: any;
  images: Record<string, LcdImage | false> = {};
  /** The battle drawObjects is painting for (the painter callbacks read it). */
  battle: any = undefined;
  /** The runner drawObjects is painting (for its wBGP / wOBP0). */
  runner: AnimRunnerInstance | undefined = undefined;
  /** The last BG state the runner handed over (bgEffect). */
  bg: AnimBgState | undefined = undefined;

  constructor(data?: Record<string, any>, palettes?: any) {
    this.data = data ?? {};
    this.palettes = palettes;
  }

  // data: the cache's battle_anims table; palettes: the cache's palettes table
  // Lua: BattleAnimView.lua:43
  static new(data?: Record<string, any>, palettes?: any): BattleAnimView {
    return new BattleAnimView(data, palettes);
  }

  // Lua: BattleAnimView.lua:54
  image(path: string | undefined): LcdImage | undefined {
    if (!path) return undefined;
    let cached = this.images[path];
    if (cached === undefined) {
      try {
        cached = Assets.image(path);
      } catch {
        cached = false;
      }
      this.images[path] = cached;
    }
    return cached || undefined;
  }

  // Lua: BattleAnimView.lua:67 -- a sheet tile is its id in the cooked grid
  // rather than a quad.
  quad(_sheetName: string, index: number, wide: number, image: LcdImage): number | undefined {
    const col = index % wide;
    const row = Math.floor(index / wide);
    if (col >= image.tw || row >= image.th) return undefined;
    return image.ids[row * image.tw + col];
  }

  // PAL_BATTLE_OB_ENEMY and PAL_BATTLE_OB_PLAYER are the two battlers' own
  // colours; the others are the fixed block from battle_anims.pal.
  // Lua: BattleAnimView.lua:96
  objPalette(name: string | undefined, battle: any): Colors | undefined {
    if (name === "PAL_BATTLE_OB_ENEMY") {
      const enemy = battle && battle.enemy;
      return enemy ? Palettes.monColors(this.palettes, enemy.species, enemy.shiny) : undefined;
    }
    if (name === "PAL_BATTLE_OB_PLAYER") {
      const player = battle && battle.player;
      return player ? Palettes.monColors(this.palettes, player.species, player.shiny) : undefined;
    }
    const set = this.palettes && this.palettes.battleObjects;
    return set ? set[name as string] : undefined;
  }

  /**
   * The rBGP / rOBP0 byte an OBJ palette is permuted by this frame. Not in the
   * Lua (it colours every OBJ as-is): BattleAnimRequestPals
   * (engine/battle_anims/anim_commands.asm:149-165) copies wBGP into OB
   * palettes 0-1 (the battlers) and wOBP0 into 2-3 (GRAY, YELLOW) through
   * CopyPals every frame on the CGB.
   */
  private objByte(name: string | undefined): number | null {
    const r = this.runner;
    if (!r) return null;
    if (name === "PAL_BATTLE_OB_ENEMY" || name === "PAL_BATTLE_OB_PLAYER") return r.bg.bgp;
    if (name === "PAL_BATTLE_OB_GRAY" || name === "PAL_BATTLE_OB_YELLOW") return r.bg.obp0;
    return null;
  }

  /** One OAM entry onto the Gold screen's object list, through `colors`. */
  private putObj(x: number, y: number, tile: number, attr: number, palette: string | undefined): void {
    const lcd = currentLcd();
    if (!lcd) return;
    let colors = this.objPalette(palette, this.battle) ?? GbcPalette.DMG_SHADES;
    const byte = this.objByte(palette);
    if (byte != null && byte !== BGP_IDENTITY) colors = GbcPalette.remap(colors, byte) ?? colors;
    let pal: Palette4 = G.palette;
    GbcPalette.with(colors, () => {
      pal = G.palette;
    });
    const slot = lcd.palette(pal, true);
    const flags =
      (attr & OAM_XFLIP ? ATTR_X_FLIP : 0) | (attr & OAM_YFLIP ? ATTR_Y_FLIP : 0) | (attr & OAM_PRIORITY ? ATTR_PRIORITY : 0);
    const [tx, ty] = G.transformPoint(x, y);
    lcd.obj(tx, ty, tile, slot | flags);
  }

  // AnimPainter: one anim-sheet OAM entry, already at screen pixels.
  // Lua: BattleAnimView.lua:118-145 (the loop body of drawObjects)
  obj(x: number, y: number, gfxKey: string, tile: number, attr: number, palette: string | undefined, wide: number): void {
    const image = this.image(gfxKey);
    if (!image) return;
    const id = this.quad(gfxKey, tile, wide, image);
    if (id === undefined) return;
    this.putObj(x, y, id, attr, palette);
  }

  // AnimPainter: an OAM entry in a battler pseudo-sheet. The Lua draws nothing
  // here ("nothing in the cache holds them as a sheet"). The Gold screen does
  // hold them: BattleAnimCmd_BattlerGFX_1Row/_2Row
  // (engine/battle_anims/anim_commands.asm:755-860) copy the enemy pic's bottom
  // row(s) (vTiles2 $06 / $05, column by column) and the player pic's top
  // row(s) (vTiles2 $31) into OBJ tiles, and those are exactly the pic cells on
  // the BG map at the enemy box (12,0) and the player box (2,6).
  // NOT FAITHFUL (to the Lua, which skips these; faithful to the cart's copy),
  // except that the cart copies VRAM once at the command and this reads the
  // cells every frame.
  battlerObj(x: number, y: number, side: "player" | "enemy", tile: number, attr: number, palette: string | undefined): void {
    const lcd = currentLcd();
    if (!lcd || !this.runner) return;
    let rows = 1;
    for (const entry of this.runner.loaded) if (entry.battler === side) rows = entry.rows ?? 1;
    const col = rows === 2 ? tile >> 1 : tile;
    const sub = rows === 2 ? tile & 1 : 0;
    let cx: number;
    let cy: number;
    if (side === "enemy") {
      cx = 12 + col;
      cy = rows === 2 ? 5 + sub : 6;
    } else {
      cx = 2 + col;
      cy = 6 + sub;
    }
    const i = cy * 32 + cx;
    if (lcd.s.attrs[i]! & ATTR_HOLE) return;
    this.putObj(x, y, lcd.s.cells[i]!, attr, palette);
  }

  // AnimPainter: the BG state is applied by present(); keep it for readers.
  bgEffect(state: AnimBgState): void {
    this.bg = state;
  }

  // One frame's OBJ layer.
  // Lua: BattleAnimView.lua:110
  drawObjects(runner: AnimRunnerInstance, battle: any): void {
    G.setColor(1, 1, 1, 1);
    this.battle = battle;
    this.runner = runner;
    runner.draw(this);
  }

  // The battle background is BG colour 0 everywhere the panel does not draw:
  // every BG map cell still a hole after the panel (the 12 columns and 14 rows
  // past the 20x18 screen included, which is what a scrolled scanline exposes)
  // gets the blank tile in that colour. The Lua fills the 160x144 rect under
  // its blit instead.
  // Lua: BattleAnimView.lua:168
  fillBackground(palByte?: number | null): void {
    // a battle staged in the voxel world keeps its field open onto the arena
    if (BattleAnimView.openField) return;
    const lcd = currentLcd();
    if (!lcd) return;
    const previousBgp = GbcPalette.setBgp(palByte);
    try {
      const c = GbcPalette.color(Chrome.DEFAULT_BOX_PALETTE, 1);
      const rgb: readonly [number, number, number] = [c[0]!, c[1]!, c[2]!];
      const slot = lcd.palette([rgb, rgb, rgb, rgb]);
      for (let i = 0; i < 1024; i++) {
        if (lcd.s.attrs[i]! & ATTR_HOLE) lcd.cell(i & 31, i >> 5, SOLID[0], slot);
      }
    } finally {
      GbcPalette.setBgp(previousBgp);
    }
  }

  // Lua: BattleAnimView.lua:178 -- there is no blit: a scanline's offset is a
  // scroll register value (see present).
  blitRowAt(_srcRow: number, _destRow: number, _dx: number): void {}

  // Lua: BattleAnimView.lua:194
  blitRow(_row: number, _dx: number, _dy: number): void {}

  // Draw the battle panel with an rBGP byte folded into every palette on the
  // way in -- straight into the BG map rather than into a canvas.
  // Lua: BattleAnimView.lua:209
  bake(drawBg: () => void, palByte?: number | null): void {
    const previousBgp = GbcPalette.setBgp(palByte);
    G.push();
    G.origin();
    try {
      drawBg();
    } finally {
      G.pop();
      GbcPalette.setBgp(previousBgp);
    }
  }

  // Runs `drawBg` (the battle panel) and puts it on screen through the
  // animation's BG registers.
  // Lua: BattleAnimView.lua:298
  present(runner: AnimRunnerInstance, drawBg: () => void, _battle?: any): void {
    const bg = runner.bg;
    // engine/battle_anims/anim_commands.asm:1293
    const byte = bg.bgp !== GbcPalette.BGP_IDENTITY ? bg.bgp : null;
    if (byte == null && !needsCanvas(runner)) {
      drawBg();
      return;
    }
    const lcd = currentLcd();

    // hLCDCPointer aimed at rBGP: each scanline gets its own PALETTE.
    if (bg.lcdc === "BGP") {
      // NOT FAITHFUL: the Gold screen has no per-scanline palette, only a
      // palette per cell. Each 8-line cell row takes the byte most of its
      // scanlines hold (a tie goes to the non-base byte), and the panel is
      // drawn once per byte, clipped to that byte's cell rows. The cart's
      // every-other-line stripes become whole cell rows.
      const bands = bgpBands(bg);
      const base = bg.bgp ?? GbcPalette.BGP_IDENTITY;
      const rowByte: number[] = [];
      for (let cr = 0; cr < SCREEN_H / 8; cr++) {
        const counts = new Map<number, number>();
        for (const band of bands) {
          for (const r of band.rows) if (r >> 3 === cr) counts.set(band.byte, (counts.get(band.byte) ?? 0) + 1);
        }
        let best = base;
        let bestN = -1;
        for (const [b, n] of counts) {
          if (n > bestN || (n === bestN && best === base)) {
            best = b;
            bestN = n;
          }
        }
        rowByte.push(best);
      }
      for (const band of bands) {
        let cr = 0;
        while (cr < rowByte.length) {
          if (rowByte[cr] !== band.byte) {
            cr++;
            continue;
          }
          let end = cr;
          while (end < rowByte.length && rowByte[end] === band.byte) end++;
          G.push();
          G.intersectScissor(0, cr * 8, SCREEN_W, (end - cr) * 8);
          this.bake(drawBg, band.byte);
          G.pop();
          cr = end;
        }
      }
      this.fillBackground(base);
      lcd?.regs({ scx: signed(bg.scx) & 0xff, scy: signed(bg.scy) & 0xff });
      return;
    }

    this.bake(drawBg, byte);
    // A shifted scanline exposes the blank tile beside the pic boxes.
    this.fillBackground(byte);
    if (!lcd) return;
    // hSCX / hSCY move the whole background; the per-scanline overrides only
    // apply inside the effect's own window. The Lua's (src, dx) per row is the
    // same thing as a scroll value per row: SCX = scx + value on an SCX
    // window, SCY = src - row on an SCY one.
    const scx = signed(bg.scx);
    const scy = signed(bg.scy);
    lcd.regs({ scx: scx & 0xff, scy: scy & 0xff });
    if (!bg.lcdc || bg.lyEnd <= bg.lyStart) return;
    const values = new Array<number>(SCREEN_H);
    if (bg.lcdc === "SCX") {
      // NOT FAITHFUL (to the Lua): a $90 byte in an SCX window is a scroll of
      // 144 here, as on the hardware; the Lua blanks the line instead.
      for (let row = 0; row < SCREEN_H; row++) {
        const inWindow = row > bg.lyStart && row <= bg.lyEnd;
        const value = inWindow ? signed(bg.lyBackup[row - 1] ?? 0) : 0;
        values[row] = (scx + value) & 0xff;
      }
      lcd.lines(2, values);
      return;
    }
    // An SCY window: rows the Lua does not draw (a $90 byte, or a source row
    // off the panel) point at the blank fill below the panel.
    for (let row = 0; row < SCREEN_H; row++) values[row] = (BLANK_MAP_ROW - row) & 0xff;
    for (const line of scanlines(bg)) values[line.dest] = (line.src - line.dest) & 0xff;
    lcd.lines(1, values);
  }

  // The battle intro slide (engine/battle/sliding_intro.asm): three SCX bands,
  // which here are simply three per-line SCX values. `drawBackpic(offset)` draws
  // the player's back pic over the bands the way the cart's OAM copy rides over
  // them (the caller draws it as objects).
  // Lua: BattleAnimView.lua:408
  presentSlide(frame: number, drawBg: () => void, drawBackpic?: (offset: number) => void): void {
    const [top, middle] = slideOffsets(frame);
    if (top === 0 && middle === 0) {
      drawBg();
      if (drawBackpic) drawBackpic(0);
      return;
    }
    this.bake(drawBg, null);
    this.fillBackground();
    const lcd = currentLcd();
    if (lcd) {
      const values = new Array<number>(SCREEN_H);
      for (let row = 0; row < SCREEN_H; row++) {
        let scx = 0;
        if (row < 0x40) scx = top;
        else if (row < 0x60) scx = middle;
        // SCX is unsigned and the map wraps at 256, exactly as the Lua's
        // "coming in from the other side" reads it.
        values[row] = scx;
      }
      lcd.lines(2, values);
    }
    if (drawBackpic) drawBackpic(slideBackpicOffset(frame));
  }
}

export default BattleAnimView;
