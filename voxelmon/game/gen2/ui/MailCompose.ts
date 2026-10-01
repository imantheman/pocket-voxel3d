// gen1recomp src/ui/gen2/MailCompose.lua (bdfac727, MIT): writing a letter,
// _ComposeMailMessage (engine/menus/naming_screen.asm) and its own charset,
// data/text/mail_input_chars.asm.
//
// The naming screen's cousin: the grid is TEN columns wide instead of nine,
// the entry field is two MAIL_LINE_LENGTH rows, and the charsets differ.
//
// Layout, transcribed from .InitCharset's own hlcoords:
//   rows 0-5   NAMINGSCREEN_BORDER, with (1,1) 4x18 cleared for the letter
//   .Update    ClearBox (1,1) 4x18, then PlaceString at (2,2) -- the first
//              line is row 2 and the '<NEXT>' at MAIL_LINE_LENGTH puts the
//              second on row 3
//   rows 6-17  blank; .PlaceMailCharset writes each row from x = 1, stepping
//              TWO rows: the charset at y = 7, 9, 11, 13, 15 and the
//              case/DEL/END strip at y = 17
//
// Cursor: ComposeMail_AnimateCursor's .GetDPad is a 10x6 grid that wraps in
// both axes, and row 5 (the strip) collapses to three targets at columns
// 0-2 / 3-5 / 6-9 (ComposeMail_GetCursorPosition's `cp $3 / cp $6` split).
//
// SELECT toggles case anywhere, START parks the cursor on END, B deletes.
// Filling both lines does NOT end entry: the player still has to press END.

import G from "../platform/screen.ts";
import type { LcdImage } from "../platform/screen.ts";
import { Assets } from "../shared/render/Assets.ts";
import { Font } from "../shared/render/Font.ts";
import { Mail } from "../core/Mail.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Chrome } from "./Chrome.ts";

export interface MailComposeOpts {
  initial?: string;
  menuGfx?: Record<string, any>;
  onDone?: (message: string) => void;
  onCancel?: () => void;
}

/**
 * Lua: MailCompose.lua:44 -- each ASM row is twenty columns with the
 * character on the even ones, so cell N is index N*2-1.
 */
function rowCells(row: string): string[] {
  const out: string[] = [];
  for (let i = 1; i <= 10; i++) out.push(row.substr(i * 2 - 2, 1));
  return out;
}

// Lua: MailCompose.lua:52 -- data/text/mail_input_chars.asm, cell for cell.
const MAIL_INPUT_UPPER: string[][] = [
  rowCells("A B C D E F G H I J"),
  rowCells("K L M N O P Q R S T"),
  rowCells("U V W X Y Z   , ? !"),
  rowCells("1 2 3 4 5 6 7 8 9 0"),
  // "<PK> <MN> <PO> <KE> é ♂ ♀ ¥ … ×": all ten are single font glyphs.
  ["<PK>", "<MN>", "<PO>", "<KE>", "é", "♂", "♀", "¥", "…", "×"],
];
const MAIL_INPUT_LOWER: string[][] = [
  rowCells("a b c d e f g h i j"),
  rowCells("k l m n o p q r s t"),
  rowCells("u v w x y z   . - /"),
  // the seven apostrophe pairs are one glyph each ($d0-$d6).
  ["'d", "'l", "'m", "'r", "'s", "'t", "'v", "&", "(", ")"],
  // "“ ” [ ] ' : ;      "
  ["“", "”", "[", "]", "'", ":", ";", " ", " ", " "],
];

// Lua: MailCompose.lua:77 -- "lower  DEL   END   " / "UPPER  DEL   END   ",
// written raw from x = 1: labels on columns 1, 8 and 14. The cursor is a
// sprite on the cart; here the naming screen's cursor tile, one column left.
const BOTTOM_LABELS = [Strings.source("lower"), Strings.source("DEL"), Strings.source("END")];
const BOTTOM_UPPER_LABELS = [Strings.source("UPPER"), Strings.source("DEL"), Strings.source("END")];
const BOTTOM_LABEL_TX = [1, 8, 14];
const BOTTOM_CURSOR_TX = [0, 7, 13];

// Lua: MailCompose.lua:87 -- .PlaceMailCharset: first row at (1,7).
const KEYBOARD_TOP = 7;
const KEYBOARD_X = 1;
const BOTTOM_ROW = 5;
// .Update's PlaceString target.
const ENTRY_X = 2, ENTRY_Y = 2;

export class MailCompose {
  // Lua: MailCompose.lua:38
  static isOpaque = true;
  isOpaque = true;

  static MAIL_INPUT_UPPER = MAIL_INPUT_UPPER;
  static MAIL_INPUT_LOWER = MAIL_INPUT_LOWER;

  game: any;
  onDone?: (message: string) => void;
  onCancel?: () => void;
  lower: boolean;
  text: string;
  col: number;
  row: number;
  gfx: Record<string, any> | undefined;
  tiles: Record<string, LcdImage>;
  [key: string]: any;

  /** Lua: MailCompose.lua:93 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: MailCompose.lua:94 */
  drawsWidescreen(): boolean {
    return true;
  }

  /**
   * Lua: MailCompose.lua:102 -- opts: initial, menuGfx (gen2MenuGfx),
   * onDone(message), onCancel(). There is no cancel on the cart: onCancel is
   * for a driver; nothing in the game presses it.
   */
  static new(game: any, opts?: MailComposeOpts): MailCompose {
    return new MailCompose(game, opts ?? {});
  }

  constructor(game: any, opts: MailComposeOpts) {
    this.game = game;
    this.onDone = opts.onDone;
    this.onCancel = opts.onCancel;
    this.lower = false; // wNamingScreenLetterCase; upper first
    this.text = Mail.trim(opts.initial || "");
    this.col = 0;
    this.row = 0;
    this.gfx = opts.menuGfx || (game && game.data && game.data.gen2MenuGfx);
    this.tiles = {};
    if (this.gfx) {
      for (const key of ["border", "middleLine", "underLine", "cursor"]) {
        if (this.gfx[key]) {
          try {
            this.tiles[key] = Assets.image(this.gfx[key]);
          } catch {
            // pcall: missing art falls back below
          }
        }
      }
    }
  }

  /** Lua: MailCompose.lua:125 */
  rows(): string[][] {
    return this.lower ? MAIL_INPUT_LOWER : MAIL_INPUT_UPPER;
  }

  /** Lua: MailCompose.lua:129 */
  onBottomRow(): boolean {
    return this.row === BOTTOM_ROW;
  }

  /** Lua: MailCompose.lua:135 -- columns 0-2 case, 3-5 DEL, 6-9 END. */
  bottomTarget(): number {
    if (this.col < 3) return 1;
    if (this.col < 6) return 2;
    return 3;
  }

  /** Lua: MailCompose.lua:141 */
  characterAt(col: number, row: number): string | undefined {
    const line = this.rows()[row];
    const ch = line && line[col];
    if (!ch || ch === " " || ch === "") return undefined;
    return ch;
  }

  /** Lua: MailCompose.lua:148 */
  length(): number {
    return Mail.characters(this.text).length;
  }

  /** Lua: MailCompose.lua:152 */
  addCharacter(ch: string | undefined): void {
    if (!ch) return;
    if (this.length() >= Mail.MAIL_MSG_LENGTH) return;
    this.text = this.text + ch;
  }

  /** Lua: MailCompose.lua:158 */
  deleteCharacter(): void {
    const chars = Mail.characters(this.text);
    if (chars.length === 0) return;
    this.text = chars.slice(0, chars.length - 1).join("");
  }

  /** Lua: MailCompose.lua:164 */
  toggleCase(): void {
    this.lower = !this.lower;
  }

  /** Lua: MailCompose.lua:171 -- .finished: the message is exactly what was typed. */
  accept(): void {
    if (this.onDone) this.onDone(this.text);
  }

  /**
   * Lua: MailCompose.lua:178 -- .right / .left. A letter row steps one
   * column and wraps at 9/0; the strip steps one TARGET and wraps at 3/1.
   */
  moveHorizontal(delta: number): void {
    if (this.onBottomRow()) {
      let target = this.bottomTarget() + delta;
      if (target < 1) target = 3;
      if (target > 3) target = 1;
      this.col = (target - 1) * 3;
      return;
    }
    this.col = this.col + delta;
    if (this.col < 0) this.col = 9;
    if (this.col > 9) this.col = 0;
  }

  /** Lua: MailCompose.lua:191 */
  moveVertical(delta: number): void {
    this.row = this.row + delta;
    if (this.row < 0) this.row = BOTTOM_ROW;
    if (this.row > BOTTOM_ROW) this.row = 0;
    if (this.onBottomRow()) this.col = (this.bottomTarget() - 1) * 3;
  }

  /** Lua: MailCompose.lua:200 */
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
      // .start puts VAR1 = $9 / VAR2 = $5, i.e. the cursor onto END.
      this.row = BOTTOM_ROW;
      this.col = 9;
    } else if (input.wasPressed("b")) {
      // .b is NamingScreen_DeleteCharacter, not a way out.
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
    }
  }

  /**
   * Lua: MailCompose.lua:240 -- the patterned backdrop the border tile fills
   * rows 0-5 with; a flat mid grey without menu_gfx.
   */
  drawBackdrop(): void {
    const tile = this.tiles.border;
    if (!tile) {
      G.setColor(0.62, 0.62, 0.62, 1);
      G.rectangle("fill", 0, 0, 160, 6 * 8);
      G.setColor(1, 1, 1, 1);
      return;
    }
    G.setColor(1, 1, 1, 1);
    for (let ty = 0; ty <= 5; ty++) {
      for (let tx = 0; tx <= Chrome.SCREEN_W - 1; tx++) G.draw(tile, tx * 8, ty * 8);
    }
  }

  /** Lua: MailCompose.lua:257 */
  clearPanel(tx: number, ty: number, tw: number, th: number): void {
    G.setColor(1, 1, 1, 1);
    G.rectangle("fill", tx * 8, ty * 8, tw * 8, th * 8);
    G.setColor(0, 0, 0, 1);
  }

  /**
   * Lua: MailCompose.lua:267 -- one entry row: the typed characters, then
   * the underline in the next slot and middle lines for the rest.
   */
  drawEntryRow(chars: string[], first: number, ty: number, cursorAt: number): void {
    for (let i = 1; i <= Mail.MAIL_LINE_LENGTH; i++) {
      const index = first + i - 1;
      const pen = (ENTRY_X + i - 1) * 8;
      const ch = chars[index - 1];
      if (ch) {
        G.setColor(0, 0, 0, 1);
        Font.draw(ch, pen, ty * 8);
      } else {
        const isNext = index === cursorAt;
        const glyph = isNext ? this.tiles.underLine : this.tiles.middleLine;
        G.setColor(0, 0, 0, 1);
        if (glyph) {
          G.draw(glyph, pen, ty * 8);
        } else {
          // No extracted line tiles: draw them.
          // NOT FAITHFUL: a 1px rule is an object-sized block on the Gold screen
          G.rectangle("fill", pen + 1, ty * 8 + (isNext ? 7 : 4), 6, 1);
        }
      }
    }
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: MailCompose.lua:292 */
  drawPanel(): void {
    this.drawBackdrop();
    // rows 6-17 are ByteFilled with ' ', which is the blank tile.
    this.clearPanel(0, 6, Chrome.SCREEN_W, 12);
    // .InitCharset's ClearBox (1,1) 4x18, which .Update repeats every frame.
    this.clearPanel(1, 1, 18, 4);

    const chars = Mail.characters(this.text);
    const cursorAt = chars.length + 1;
    this.drawEntryRow(chars, 1, ENTRY_Y, cursorAt);
    this.drawEntryRow(chars, Mail.MAIL_LINE_LENGTH + 1, ENTRY_Y + 1, cursorAt);

    const grid = this.rows();
    for (let row = 0; row <= BOTTOM_ROW - 1; row++) {
      const line = grid[row] || [];
      for (let col = 0; col <= 9; col++) {
        const ch = line[col];
        if (ch && ch !== " " && ch !== "") Chrome.print(ch, KEYBOARD_X + col * 2, KEYBOARD_TOP + row * 2);
      }
    }

    const labels = this.lower ? BOTTOM_UPPER_LABELS : BOTTOM_LABELS;
    const bottomY = KEYBOARD_TOP + BOTTOM_ROW * 2;
    labels.forEach((label, i) => {
      Chrome.print(Strings.get(label), BOTTOM_LABEL_TX[i]!, bottomY);
    });

    let cursorTx: number;
    let cursorTy: number;
    if (this.onBottomRow()) {
      cursorTx = BOTTOM_CURSOR_TX[this.bottomTarget() - 1]!;
      cursorTy = bottomY;
    } else {
      cursorTx = KEYBOARD_X - 1 + this.col * 2;
      cursorTy = KEYBOARD_TOP + this.row * 2;
    }
    if (this.tiles.cursor) {
      G.setColor(1, 1, 1, 1);
      G.draw(this.tiles.cursor, cursorTx * 8, cursorTy * 8);
    } else {
      Chrome.cursor(cursorTx, cursorTy);
    }
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: MailCompose.lua:338 */
  draw(): void {
    this.drawPanel();
  }

  /** Lua: MailCompose.lua:342 */
  drawWidescreen(winW: number, winH: number): void {
    Chrome.letterbox(winW, winH, 0.62, 0.62, 0.62);
    G.setColor(1, 1, 1, 1);
    const scale = Chrome.fitScale();
    G.push();
    const [ox, oy] = Chrome.fitOrigin();
    G.translate(ox, oy);
    G.scale(scale, scale);
    this.drawPanel();
    G.pop();
  }

  /** Lua: MailCompose.lua:355 -- exported for tests: what the cursor is over. */
  cursorCharacter(): string | undefined {
    if (this.onBottomRow()) return ["CASE", "DEL", "END"][this.bottomTarget() - 1];
    return this.characterAt(this.col, this.row);
  }
}

export default MailCompose;
