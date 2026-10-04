// gen1recomp src/ui/gen2/NamingScreen.lua (bdfac727): the Gen 2 naming
// screen, the on-screen keyboard Gold uses for the player, the rival, mom, a
// box, and mon nicknames (engine/menus/naming_screen.asm).
//
// Layout (tile coords, from the ASM's hlcoord calls):
//   whole screen filled with NAMINGSCREEN_BORDER
//   (1,1) 6x18 cleared  -- header: icon, prompt at (5,2), entry field at (5,6)
//   (1,8) 7x18 cleared  -- keyboard: 5 rows at y = 8,10,12,14,16
//   letters at x = 2,4,...,18 (nine per row)
//   NAME_BOX gets a sixth row and a shorter header (4x18 / 9x18 at y=6)
//
// Cursor grid is 9 wide by 5 rows (6 for a box). The bottom row is three fat
// targets -- case switch, DEL, END (.CaseDelEnd: $00,$00,$00,$30,$30,$30,
// $60,$60,$60). SELECT toggles case anywhere; START jumps the cursor onto
// END; B deletes.
//
// NOT FAITHFUL: name lengths count JS characters, not Lua bytes, so × é ♂ ♀
// take one slot (the Lua counted their UTF-8 bytes and could cut one in half).

import G, { putTiles, type LcdImage, type Quad } from "../platform/screen.ts";
import { format } from "../platform/lua.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Assets } from "../shared/render/Assets.ts";
import { Font } from "../shared/render/Font.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Chrome } from "./Chrome.ts";

type Colors = readonly (readonly number[])[];

/**
 * Lua: NamingScreen.lua:34 -- data/text/name_input_chars.asm. Each row is a
 * 17-character string with the letters on the even columns.
 */
function rowCells(row: string): string[] {
  const out: string[] = [];
  for (let i = 1; i <= 9; i++) out[i - 1] = row.substring(i * 2 - 2, i * 2 - 1);
  return out;
}

// Lua: NamingScreen.lua:43
const NAME_INPUT_UPPER: string[][] = [
  rowCells("A B C D E F G H I"),
  rowCells("J K L M N O P Q R"),
  rowCells("S T U V W X Y Z  "),
  rowCells("- ? ! / . ,      "),
];
const NAME_INPUT_LOWER: string[][] = [
  rowCells("a b c d e f g h i"),
  rowCells("j k l m n o p q r"),
  rowCells("s t u v w x y z  "),
  ["×", "(", ")", ":", ";", "[", "]", "<PK>", "<MN>"],
];
// Lua: NamingScreen.lua:56 -- BOX_NAME gets one extra symbol row in each case.
const BOX_INPUT_UPPER: string[][] = [
  NAME_INPUT_UPPER[0]!,
  NAME_INPUT_UPPER[1]!,
  NAME_INPUT_UPPER[2]!,
  ["×", "(", ")", ":", ";", "[", "]", "<PK>", "<MN>"],
  ["-", "?", "!", "♂", "♀", "/", ".", ",", "&"],
];
const BOX_INPUT_LOWER: string[][] = [
  NAME_INPUT_LOWER[0]!,
  NAME_INPUT_LOWER[1]!,
  NAME_INPUT_LOWER[2]!,
  ["é", "'d", "'l", "'m", "'r", "'s", "'t", "'v", "0"],
  ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
];

// Lua: NamingScreen.lua:74 -- the case target names the board it SWITCHES TO.
const BOTTOM_UPPER_LABELS = [Strings.source("lower"), Strings.source("DEL"), Strings.source("END")];
const BOTTOM_LOWER_LABELS = [Strings.source("UPPER"), Strings.source("DEL"), Strings.source("END")];
// Lua: NamingScreen.lua:85 -- .CaseDelEnd adds pixel $00 / $30 / $60 to the
// cursor's XCOORD of 24: screen tile 2 / 8 / 14, five tiles wide.
const BOTTOM_CURSOR_TX = [2, 8, 14];
const BOTTOM_LABEL_TX = [2, 9, 15];
const BOTTOM_CURSOR_TILES = 5;

export interface NamingKind {
  prompt?: string;
  maxLength: number;
  sprite?: string;
  spriteFemale?: string;
  isBox?: boolean;
}

export interface NamingScreenOpts {
  type?: string;
  prompt?: string;
  maxLength?: number;
  initial?: string;
  monName?: string;
  iconPath?: string;
  iconColors?: Colors;
  gender?: string;
  isBox?: boolean;
  menuGfx?: any;
  onDone?: (name: string) => void;
  onCancel?: () => void;
}

// Lua: NamingScreen.lua:387 -- one cursor tile's height
const CURSOR_TILE_H = 8;

// Lua: NamingScreen.lua:161 -- ui.naming.grid identity
function sameGrid(grid: string[][]): string[][] {
  return grid;
}

export class NamingScreen {
  static isOpaque = true;
  static NAME_INPUT_UPPER = NAME_INPUT_UPPER;
  static NAME_INPUT_LOWER = NAME_INPUT_LOWER;
  static BOX_INPUT_UPPER = BOX_INPUT_UPPER;
  static BOX_INPUT_LOWER = BOX_INPUT_LOWER;

  // Lua: NamingScreen.lua:91 -- NAME_* types as prompts + field sizes.
  static TYPES: Record<string, NamingKind> = {
    player: { prompt: Strings.source("YOUR NAME?"), maxLength: 7, sprite: "SPRITE_CHRIS", spriteFemale: "SPRITE_KRIS" },
    rival: { prompt: Strings.source("RIVAL'S NAME?"), maxLength: 7, sprite: "SPRITE_RIVAL" },
    mom: { prompt: Strings.source("MOTHER'S NAME?"), maxLength: 7, sprite: "SPRITE_MOM" },
    box: { prompt: Strings.source("BOX NAME?"), maxLength: 8, isBox: true },
    nickname: { prompt: undefined, maxLength: 10 },
  };

  [key: string]: any;
  isOpaque = true;
  game: any;
  kind: NamingKind;
  gender: string | undefined;
  isBox: boolean;
  maxLength: number;
  prompt: string;
  monName: string | undefined;
  onDone: ((name: string) => void) | undefined;
  onCancel: (() => void) | undefined;
  lower = false;
  text: string;
  col = 0;
  row = 0;
  iconImage: LcdImage | null = null;
  iconColors: Colors | undefined;
  gfx: any;
  palette: Colors | undefined;
  tiles: Record<string, LcdImage> = {};
  cursorQuads?: { corner: Quad; edge: Quad };

  /** Lua: NamingScreen.lua:102 -- GetPlayerIcon's two sheets (../pokecrystal/engine/gfx/player_gfx.asm:85-93). */
  static playerSprite(gender?: string | null): string {
    const kind = NamingScreen.TYPES.player!;
    if (gender === "female" && kind.spriteFemale) return kind.spriteFemale;
    return kind.sprite!;
  }

  /** Lua: NamingScreen.lua:114 */
  constructor(game: any, opts: NamingScreenOpts = {}) {
    this.game = game;
    const kind = NamingScreen.TYPES[opts.type ?? "player"] ?? NamingScreen.TYPES.player!;
    this.kind = kind;
    this.gender = opts.gender ?? (game && game.save && game.save.player && game.save.player.gender) ?? undefined;
    this.isBox = opts.isBox || kind.isBox || false;
    this.maxLength = opts.maxLength ?? kind.maxLength ?? 7;
    this.prompt = opts.prompt ?? kind.prompt ?? Strings.source("NICKNAME?");
    this.monName = opts.monName;
    this.onDone = opts.onDone;
    this.onCancel = opts.onCancel;
    this.lower = false; // wNamingScreenLetterCase; upper first
    this.text = opts.initial ?? "";
    if (opts.iconPath) {
      try {
        this.iconImage = Assets.image(opts.iconPath);
      } catch {
        this.iconImage = null;
      }
    }
    // The header icon is an OBJ on the cart, so it wears a real palette.
    this.iconColors = opts.iconColors;
    const data = (game && game.data) || {};
    this.gfx = opts.menuGfx ?? data.gen2MenuGfx;
    if (this.gfx && this.gfx.naming) this.gfx = this.gfx.naming;
    // engine/menus/naming_screen.asm:47, engine/gfx/cgb_layouts.asm:488
    const diploma = data.gen2Diploma;
    this.palette = diploma && diploma.palettes && diploma.palettes[0];
    if (this.gfx) {
      for (const key of ["border", "middleLine", "underLine", "cursor"]) {
        if (this.gfx[key]) {
          try {
            this.tiles[key] = Assets.image(this.gfx[key]);
          } catch {
            // missing art: the draws below fall back
          }
        }
      }
    }
  }

  /** Lua: NamingScreen.lua:114 */
  static new(game: any, opts?: NamingScreenOpts): NamingScreen {
    return new NamingScreen(game, opts ?? {});
  }

  /** Lua: NamingScreen.lua:108 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: NamingScreen.lua:109 */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: NamingScreen.lua:174 -- the letter rows of the page showing, through ui.naming.grid. */
  rows(): string[][] {
    let base: string[][];
    if (this.isBox) base = this.lower ? BOX_INPUT_LOWER : BOX_INPUT_UPPER;
    else base = this.lower ? NAME_INPUT_LOWER : NAME_INPUT_UPPER;
    if (!Runtime.wantsHook("ui.naming.grid")) return base;
    const hooked = Runtime.call("ui.naming.grid", sameGrid, base, {
      lower: !!this.lower,
      title: this.prompt,
      maxLen: this.maxLength,
      box: this.isBox,
      game: this.game,
    });
    if (!Array.isArray(hooked) || hooked.length === 0) return base;
    return hooked as string[][];
  }

  /** Lua: NamingScreen.lua:198 */
  keyboardTop(): number {
    return this.isBox ? 6 : 8;
  }

  /** Lua: NamingScreen.lua:204 -- one past the last letter row. */
  bottomRow(): number {
    return this.rows().length;
  }

  /** Lua: NamingScreen.lua:208 */
  onBottomRow(): boolean {
    return this.row === this.bottomRow();
  }

  /** Lua: NamingScreen.lua:214 -- 1 case, 2 delete, 3 end (`cp $3 / cp $6`). */
  bottomTarget(): number {
    if (this.col < 3) return 1;
    if (this.col < 6) return 2;
    return 3;
  }

  /** Lua: NamingScreen.lua:228 -- a blank cell is a real SPACE; off the board is undefined. */
  characterAt(col: number, row: number): string | undefined {
    const grid = this.rows();
    const line = grid[row];
    const ch = line ? line[col] : undefined;
    if (!ch || ch === "") return undefined;
    return ch;
  }

  /** Lua: NamingScreen.lua:236 */
  addCharacter(ch?: string): void {
    if (!ch) return;
    if (this.text.length >= this.maxLength) return;
    this.text = this.text + ch;
  }

  /** Lua: NamingScreen.lua:242 */
  deleteCharacter(): void {
    if (this.text.length === 0) return;
    this.text = this.text.slice(0, this.text.length - 1);
  }

  /** Lua: NamingScreen.lua:247 */
  toggleCase(): void {
    this.lower = !this.lower;
  }

  /** Lua: NamingScreen.lua:251 */
  accept(): void {
    const name = this.text;
    if (this.onDone) this.onDone(name);
  }

  /** Lua: NamingScreen.lua:259 */
  moveHorizontal(delta: number): void {
    if (this.onBottomRow()) {
      let target = this.bottomTarget() + delta;
      if (target < 1) target = 3;
      if (target > 3) target = 1;
      this.col = (target - 1) * 3;
      return;
    }
    this.col += delta;
    if (this.col < 0) this.col = 8;
    if (this.col > 8) this.col = 0;
  }

  /** Lua: NamingScreen.lua:272 */
  moveVertical(delta: number): void {
    const last = this.bottomRow();
    this.row += delta;
    if (this.row < 0) this.row = last;
    if (this.row > last) this.row = 0;
    // Coming onto the bottom row lands on a target rather than between two.
    if (this.onBottomRow()) this.col = (this.bottomTarget() - 1) * 3;
  }

  /** Lua: NamingScreen.lua:284 */
  update(_dt?: number): void {
    const input = this.game && this.game.input;
    if (!input) return;
    if (input.wasPressed("left")) {
      this.moveHorizontal(-1);
    } else if (input.wasPressed("right")) {
      this.moveHorizontal(1);
    } else if (input.wasPressed("up")) {
      this.moveVertical(-1);
    } else if (input.wasPressed("down")) {
      this.moveVertical(1);
    } else if (input.wasPressed("select")) {
      this.toggleCase();
    } else if (input.wasPressed("start")) {
      // .start parks the cursor on END (var1 = $8, var2 = last row).
      this.row = this.bottomRow();
      this.col = 6;
    } else if (input.wasPressed("b")) {
      // B is delete, not cancel.
      this.deleteCharacter();
    } else if (input.wasPressed("a")) {
      if (this.onBottomRow()) {
        const target = this.bottomTarget();
        if (target === 1) this.toggleCase();
        else if (target === 2) this.deleteCharacter();
        else this.accept();
        return;
      }
      this.addCharacter(this.characterAt(this.col, this.row));
      // Filling the last slot parks the cursor on END with the screen still
      // running (engine/menus/naming_screen.asm:401-410).
      if (this.text.length >= this.maxLength) {
        this.row = this.bottomRow();
        this.col = 6;
      }
    }
  }

  /** Lua: NamingScreen.lua:343 */
  paperColor(): readonly number[] {
    return GbcPalette.color(this.palette, 1);
  }

  /** Lua: NamingScreen.lua:350 -- one patterned tile repeated over the whole screen. */
  drawBackdrop(): void {
    const tile = this.tiles.border;
    if (!tile) {
      const paper = this.paperColor();
      G.setColor(paper[0]! / 255, paper[1]! / 255, paper[2]! / 255, 1);
      G.rectangle("fill", 0, 0, 160, 144);
      G.setColor(1, 1, 1, 1);
      return;
    }
    const blit = (): void => {
      G.setColor(1, 1, 1, 1);
      // one cell over the whole screen: a native fill of the same cells, not
      // 360 draws (most of this screen's frame under the 3DS's QuickJS)
      const id = tile.ids?.[0];
      const x0 = Math.round(G.tx);
      const y0 = Math.round(G.ty);
      if (tile.tw === 1 && tile.th === 1 && !tile.obj && id !== undefined && (x0 & 7) === 0 && (y0 & 7) === 0) {
        putTiles(id, x0, y0, Chrome.SCREEN_W, Chrome.SCREEN_H);
        return;
      }
      for (let ty = 0; ty < Chrome.SCREEN_H; ty++) {
        for (let tx = 0; tx < Chrome.SCREEN_W; tx++) G.draw(tile, tx * 8, ty * 8);
      }
    };
    if (this.palette && GbcPalette.available()) GbcPalette.with(this.palette, blit);
    else blit();
  }

  /**
   * Lua: NamingScreen.lua:393 -- where the bracket sits, in tiles, plus how
   * many tiles wide it is; a tuple.
   */
  cursorTile(): [number, number, number] {
    if (this.onBottomRow()) {
      return [BOTTOM_CURSOR_TX[this.bottomTarget() - 1]!, this.keyboardTop() + this.bottomRow() * 2, BOTTOM_CURSOR_TILES];
    }
    return [2 + this.col * 2, this.keyboardTop() + this.row * 2, 1];
  }

  /** Lua: NamingScreen.lua:401 */
  drawCursorTile(quad: Quad, x: number, y: number, flipX: boolean, flipY: boolean): void {
    G.draw(this.tiles.cursor!, quad, x, y, 0, flipX ? -1 : 1, flipY ? -1 : 1, flipX ? 8 : 0, flipY ? CURSOR_TILE_H : 0);
  }

  /**
   * Lua: NamingScreen.lua:407 -- the cursor (.OAMData_TextEntryCursor /
   * TextEntryCursorBig): a box AROUND the cell, stamped from tile $00 with
   * flips, tile $01 between the corners on the wide bracket.
   */
  drawCursorBox(tx: number, ty: number, tilesWide?: number): void {
    const sheet = this.tiles.cursor;
    if (!sheet) {
      // No extracted cursor art: the shared ▶ in the gutter left of the cell.
      Chrome.cursor(tx - 1, ty);
      return;
    }
    G.setColor(1, 1, 1, 1);
    if (!this.cursorQuads) {
      const [sw, sh] = sheet.getDimensions();
      const corner = G.newQuad(0, 0, 8, CURSOR_TILE_H, sw, sh);
      this.cursorQuads = {
        corner,
        edge: sh >= 2 * CURSOR_TILE_H ? G.newQuad(0, CURSOR_TILE_H, 8, CURSOR_TILE_H, sw, sh) : corner,
      };
    }
    const { corner, edge } = this.cursorQuads;
    const x0 = tx * 8;
    const y0 = ty * 8;
    // The cursor is OAM on the cart: every tile an object, even the ones
    // that land on the grid, so it never replaces the letter under it.
    const objects = G.objects;
    G.objects = true;
    try {
      if ((tilesWide ?? 1) <= 1) {
        this.drawCursorTile(corner, x0 - 1, y0 - 1, false, false);
        this.drawCursorTile(corner, x0, y0 - 1, true, false);
        this.drawCursorTile(corner, x0 - 1, y0, false, true);
        this.drawCursorTile(corner, x0, y0, true, true);
        return;
      }
      const right = x0 + (tilesWide! - 1) * 8;
      this.drawCursorTile(corner, x0, y0 - 1, false, false);
      this.drawCursorTile(corner, right, y0 - 1, true, false);
      this.drawCursorTile(corner, x0, y0, false, true);
      this.drawCursorTile(corner, right, y0, true, true);
      for (let i = 1; i <= tilesWide! - 2; i++) {
        this.drawCursorTile(edge, x0 + i * 8, y0 - 1, false, false);
        this.drawCursorTile(edge, x0 + i * 8, y0, false, true);
      }
    } finally {
      G.objects = objects;
    }
  }

  /** Lua: NamingScreen.lua:448 */
  clearPanel(tx: number, ty: number, tw: number, th: number): void {
    const paper = this.paperColor();
    G.setColor(paper[0]! / 255, paper[1]! / 255, paper[2]! / 255, 1);
    G.rectangle("fill", tx * 8, ty * 8, tw * 8, th * 8);
    G.setColor(0, 0, 0, 1);
  }

  /**
   * Lua: NamingScreen.lua:458 -- the entry field: typed characters, then an
   * underline in the next slot, then middle lines (NamingScreen_InitNameEntry).
   */
  drawEntry(tx: number, ty: number): void {
    let pen = tx * 8;
    const length = this.text.length;
    // The Lua inked these black with setColor; on the Gold screen a glyph's
    // paper is a cell colour too, so they go through the screen's palette
    // (colour 0 the panel paper, colour 3 the same black ink).
    GbcPalette.with(this.palette, () => {
      for (let i = 1; i <= this.maxLength; i++) {
        if (i <= length) {
          G.setColor(0, 0, 0, 1);
          Font.draw(this.text.substring(i - 1, i), pen, ty * 8);
        } else {
          const isNext = i === length + 1;
          const glyph = isNext ? this.tiles.underLine : this.tiles.middleLine;
          if (glyph) {
            G.setColor(0, 0, 0, 1);
            G.draw(glyph, pen, ty * 8);
          } else {
            // No extracted line tiles: draw them.
            // NOT FAITHFUL: a 1px rule is an object-sized block here
            G.setColor(0, 0, 0, 1);
            G.rectangle("fill", pen + 1, ty * 8 + (isNext ? 7 : 4), 6, 1);
          }
        }
        pen += 8;
      }
    });
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: NamingScreen.lua:484 */
  drawPanel(): void {
    this.drawBackdrop();

    const headerH = this.isBox ? 4 : 6;
    this.clearPanel(1, 1, 18, headerH);
    const keyboardTop = this.keyboardTop();
    const keyboardH = this.isBox ? 9 : 7;
    this.clearPanel(1, keyboardTop, 18, keyboardH);
    // NamingScreen_ApplyTextInputMode clears the bottom row separately
    // (hlcoord 1, 16 / lb bc, 1, 18).
    this.clearPanel(1, 16, 18, 1);

    // Header: the standing-down frame of a 16x96 OW sheet at (16,16).
    const icon = this.iconImage;
    if (icon) {
      G.setColor(1, 1, 1, 1);
      const [w, h] = icon.getDimensions();
      const quad = G.newQuad(0, 0, Math.min(16, w), Math.min(16, h), w, h);
      if (this.iconColors && GbcPalette.available()) GbcPalette.with(this.iconColors, () => G.draw(icon, quad, 16, 16));
      else G.draw(icon, quad, 16, 16);
    }
    const pal = this.palette;
    if (this.monName) {
      // Nickname header is two lines: "<MON>'S" then "NICKNAME?".
      Chrome.printThrough(format(Strings.lookup("%s'S"), this.monName), 5, 2, pal);
      Chrome.printThrough(Strings.get("NICKNAME?"), 5, 4, pal);
    } else {
      Chrome.printThrough(Strings.get(this.prompt), 5, 2, pal);
    }
    this.drawEntry(5, this.isBox ? 4 : 6);

    // Keyboard rows.
    const grid = this.rows();
    const bottom = this.bottomRow();
    for (let row = 0; row < bottom; row++) {
      const line = grid[row] ?? [];
      for (let col = 0; col <= 8; col++) {
        const ch = line[col];
        if (ch && ch !== " " && ch !== "") Chrome.printThrough(Strings.get(ch), 2 + col * 2, keyboardTop + row * 2, pal);
      }
    }
    const labels = this.lower ? BOTTOM_LOWER_LABELS : BOTTOM_UPPER_LABELS;
    const bottomY = keyboardTop + bottom * 2;
    labels.forEach((label, i) => {
      Chrome.printThrough(Strings.get(label), BOTTOM_LABEL_TX[i]!, bottomY, pal);
    });

    const cursor = (): void => this.drawCursorBox(...this.cursorTile());
    if (pal && GbcPalette.available()) GbcPalette.with(pal, cursor);
    else cursor();
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: NamingScreen.lua:558 */
  draw(): void {
    this.drawPanel();
  }

  /**
   * Lua: NamingScreen.lua:562 -- the patterned backdrop is the surround; the
   * Gold screen is the panel, so that is the 20x18 the panel already tiles.
   */
  drawWidescreen(winW: number, winH: number): void {
    const paper = this.paperColor();
    Chrome.letterbox(winW, winH, paper[0]! / 255, paper[1]! / 255, paper[2]! / 255);
    G.setColor(1, 1, 1, 1);
    G.push();
    G.translate(...Chrome.fitOrigin());
    this.drawPanel();
    G.pop();
  }

  /** Lua: NamingScreen.lua:600 -- for tests: the character the cursor is over. */
  cursorCharacter(): string | undefined {
    if (this.onBottomRow()) return ["CASE", "DEL", "END"][this.bottomTarget() - 1];
    return this.characterAt(this.col, this.row);
  }
}

export default NamingScreen;
