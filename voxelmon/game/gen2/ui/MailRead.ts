// gen1recomp src/ui/gen2/MailRead.lua (bdfac727, MIT): reading a letter,
// ReadAnyMail / ReadPartyMonMail (engine/pokemon/mail_2.asm).
//
// The screen is one full-page piece of stationery -- ten of them, one per
// mail item, each its own Load*MailGFX routine. None of that art is in the
// cache (the extractor never followed gfx/mail.asm), so Brian draws the page
// as a plain full-screen box and puts the two DATA pieces exactly where
// MailGFX_PlaceMessage puts them:
//
//   message  hlcoord 2, 7 -- one PlaceString, so the '<NEXT>' stored at
//            offset MAIL_LINE_LENGTH lands the second line on row 8
//   author   hlcoord 5, 14, except hlcoord 8, 14 for PORTRAITMAIL_INDEX and
//            hlcoord 6, 14 for MORPH_MAIL_INDEX
//
// .loop reads A, B and START and exits on any of them (START is the printer;
// the VC builds mask it off, so treating it as an exit is the VC behaviour).

import G from "../platform/screen.ts";
import { Mail } from "../core/Mail.ts";
import { Chrome } from "./Chrome.ts";

export interface MailReadOpts {
  entry?: any;
  onClose?: () => void;
}

// Lua: MailRead.lua:28
const MESSAGE_X = 2;
const MESSAGE_Y = 7;
const AUTHOR_Y = 14;

export class MailRead {
  // Lua: MailRead.lua:26
  static isOpaque = true;
  isOpaque = true;

  game: any;
  entry: any;
  onClose?: () => void;
  [key: string]: any;

  /** Lua: MailRead.lua:31 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: MailRead.lua:32 */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: MailRead.lua:35 -- opts: entry (a `mailmsg` from core/Mail.ts), onClose() */
  static new(game: any, opts?: MailReadOpts): MailRead {
    return new MailRead(game, opts ?? {});
  }

  constructor(game: any, opts: MailReadOpts) {
    this.game = game;
    this.entry = opts.entry;
    this.onClose = opts.onClose;
  }

  /**
   * Lua: MailRead.lua:47 -- MailGFX_PlaceMessage's three author columns,
   * picked by wCurMailIndex (the *_MAIL_INDEX of the stationery).
   */
  authorColumn(): number {
    const index = (Mail.INDEX as Record<string, number>)[(this.entry && this.entry.type) || ""];
    if (index !== undefined && index === Mail.INDEX.PORTRAITMAIL) return 8;
    if (index !== undefined && index === Mail.INDEX.MORPH_MAIL) return 6;
    return 5;
  }

  /** Lua: MailRead.lua:54 */
  close(): void {
    if (this.onClose) this.onClose();
  }

  /** Lua: MailRead.lua:58 */
  update(_dt?: number): void {
    const input = this.game && this.game.input;
    if (!input) return;
    if (input.wasPressed("a") || input.wasPressed("b") || input.wasPressed("start")) {
      this.close();
    }
  }

  /** Lua: MailRead.lua:67 */
  drawPanel(): void {
    Chrome.clear();
    // DrawMailBorder frames the whole 20x18 page; without the stationery
    // tiles the shared box frame is the honest stand-in.
    Chrome.box(0, 0, Chrome.SCREEN_W, Chrome.SCREEN_H);

    const [top, bottom] = Mail.lines(this.entry);
    Chrome.print(top, MESSAGE_X, MESSAGE_Y);
    if (bottom !== "") Chrome.print(bottom, MESSAGE_X, MESSAGE_Y + 1);

    // Lua: MailRead.lua:77 -- MailGFX_PlaceMessage returns early on an empty
    // author (`ld a, [de] / and a / ret z`).
    const author = (this.entry && this.entry.author) || "";
    if (author !== "") Chrome.print(author, this.authorColumn(), AUTHOR_Y);
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: MailRead.lua:87 */
  draw(): void {
    this.drawPanel();
  }

  /** Lua: MailRead.lua:91 */
  drawWidescreen(winW: number, winH: number): void {
    Chrome.letterbox(winW, winH, 1, 1, 1);
    const scale = Chrome.fitScale();
    G.push();
    const [ox, oy] = Chrome.fitOrigin();
    G.translate(ox, oy);
    G.scale(scale, scale);
    this.drawPanel();
    G.pop();
  }
}

export default MailRead;
