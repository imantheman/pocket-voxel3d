// gen1recomp src/ui/gen2/BattleTowerMenu.lua (bdfac727, MIT): the Battle
// Tower desk's level pick -- pokecrystal mobile/mobile_46.asm:137-177
// _BattleTowerRoomMenu and the jumptable at :625-641 it drives.

import { BattleTower } from "../core/BattleTower.ts";
import { format } from "../platform/lua.ts";
import G from "../platform/screen.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Chrome } from "./Chrome.ts";

type Rec = any;

// mobile_46.asm:3854-3858 MenuHeader_119cf7, `menu_coords 12, 7, SCREEN_WIDTH - 1, TEXTBOX_Y - 1`
const PICK_X = 12, PICK_Y = 7, PICK_W = 8, PICK_H = 5;
// :1178-1183, :1222 and :1147
const ROW_X = 13, ROW_Y = 9;
const ARROW_X = 16, UP_Y = 8, DOWN_Y = 10;
// :4635-4639 MenuHeader_11a2de and :4516-4530
const YN_X = 14, YN_Y = 7, YN_W = 6, YN_H = 5;
const YN_TEXT_X = 16, YES_Y = 8, NO_Y = 10;
// constants/text_constants.asm:25-32, the box SpeechTextbox fills (:5267)
const SAY_X = 0, SAY_Y = 12, SAY_W = 18, SAY_H = 4;
const SAY_TEXT_X = 1, SAY_TEXT_Y = 14;
// :3803-3813 `ld a, $80 / ld [wcd50]`, counted down before the menu restarts
const MESSAGE_FRAMES = 0x80;

const PICK_TEXT = Strings.source("What level do you\nwant to challenge?"); // :5488-5491
const TOPS_TEXT = Strings.source("A party POKéMON\ntops this level."); // :5459-5462
const UBER_TEXT = Strings.source("%s may go\nonly to BATTLE\n\nROOMS that are\nLv.70 or higher."); // :5464-5471
const QUIT_TEXT = Strings.source("Cancel your BATTLE\nROOM challenge?"); // :5473-5476
// constants/charmap.asm:89 and :192, tiles $61 and $ee
const UP_ARROW = "▲";
const DOWN_ARROW = "▼";
const CANCEL_LABEL = Strings.source("CANCEL");
const YES_LABEL = Strings.source("YES");
const NO_LABEL = Strings.source("NO");

export interface BattleTowerMenuOpts {
  save?: Rec;
  party?: Rec[];
  rows?: { group: number; level: number }[];
  monName?: (species: string) => string;
  onDone?: (group: number | undefined) => void;
}

export class BattleTowerMenu {
  static isOpaque = false;
  isOpaque = false;
  // :4609-4610, the code BattleTowerRoomMenu_Cleanup copies into wScriptVar
  static CANCELLED = 0x0a;

  game: Rec;
  data: Rec;
  save: Rec;
  party: Rec[];
  rows: { group: number; level: number }[];
  monName: ((species: string) => string) | undefined;
  onDone: ((group: number | undefined) => void) | undefined;
  cursor = 1;
  phase: "pick" | "quit" | "message" = "pick";
  message: string = Strings.get(PICK_TEXT);
  pages: string[] | null = null;
  page = 1;
  wait = 0;
  yes = true;
  done = false;

  // :3869-3879 Strings_L10ToL100, six tiles a row
  static levelLabel(group: number): string {
    return format(" L:%-3d", group * 10).slice(0, 6);
  }

  // opts: save, party, rows, monName, onDone(levelGroup) with undefined for the cancel
  constructor(game: Rec, opts: BattleTowerMenuOpts = {}) {
    this.game = game;
    this.data = (game && game.data) || {};
    this.save = opts.save ?? game?.save;
    this.party = opts.party ?? this.save?.party ?? [];
    this.rows = opts.rows ?? BattleTower.levelGroupRows(this.save);
    this.monName = opts.monName;
    this.onDone = opts.onDone;
  }

  static new(game: Rec, opts?: BattleTowerMenuOpts): BattleTowerMenu {
    return new BattleTowerMenu(game, opts ?? {});
  }

  wantsFillScale(): boolean {
    return true;
  }

  playSfx(name: string): void {
    const sfx = this.data.audio && this.data.audio.sfx;
    if (sfx && sfx[Sound.resolve(this.data, name)]) Sound.play(this.data, name);
  }

  // the last row is CANCEL (:1160, :1165)
  rowCount(): number {
    return this.rows.length + 1;
  }

  finish(group: number | undefined): void {
    if (this.done) return;
    this.done = true;
    const game = this.game;
    if (game && game.stack && game.stack.top() === this) game.stack.pop();
    if (this.onDone) this.onDone(group);
  }

  // :3794-3816: the refusal is printed, held $80 frames, and the menu restarts
  refuse(text: string): void {
    this.phase = "message";
    // home/text.asm:479 Paragraph
    const pages = `${text}\n\n`.split("\n\n").slice(0, -1);
    this.pages = pages.length > 0 ? pages : [text];
    this.page = 1;
    this.message = this.pages[0]!;
    this.wait = MESSAGE_FRAMES;
  }

  // :1258-1286 `.a_button`
  confirm(): void {
    const row = this.rows[this.cursor - 1];
    if (!row) {
      // :1291-1303 `.asm_118a3c`
      this.phase = "quit";
      this.message = Strings.get(QUIT_TEXT);
      this.yes = true;
      return;
    }
    if (BattleTower.levelCheck(this.party, row.group)) {
      this.refuse(Strings.get(TOPS_TEXT));
      return;
    }
    const uber = BattleTower.ubersCheck(this.party, row.group);
    if (uber) {
      const name = (this.monName && this.monName(uber)) || uber;
      this.refuse(Strings.get(UBER_TEXT, name));
      return;
    }
    this.finish(row.group);
  }

  // :1240-1256: UP walks the level up and rolls over to the first row, DOWN
  // walks it back and rolls over to CANCEL
  updatePick(): void {
    const input = this.game && this.game.input;
    if (!input) return;
    const count = this.rowCount();
    if (input.wasPressed("up")) {
      this.cursor = this.cursor < count ? this.cursor + 1 : 1;
    } else if (input.wasPressed("down")) {
      this.cursor = this.cursor > 1 ? this.cursor - 1 : count;
    } else if (input.wasPressed("a")) {
      this.playSfx("Sfx_ReadText2");
      this.confirm();
    } else if (input.wasPressed("b")) {
      this.playSfx("Sfx_ReadText2");
      this.phase = "quit";
      this.message = Strings.get(QUIT_TEXT);
      this.yes = true;
    }
  }

  // :4535-4621 BattleTowerRoomMenu2_UpdateYesNoMenu
  updateQuit(): void {
    const input = this.game && this.game.input;
    if (!input) return;
    if (input.wasPressed("up")) {
      this.yes = true;
    } else if (input.wasPressed("down")) {
      this.yes = false;
    } else if (input.wasPressed("a") || input.wasPressed("b")) {
      this.playSfx("Sfx_ReadText2");
      if (input.wasPressed("a") && this.yes) {
        this.finish(undefined);
        return;
      }
      this.phase = "pick";
      this.message = Strings.get(PICK_TEXT);
      this.cursor = 1;
    }
  }

  update(_dt?: number): void {
    if (this.done) return;
    if (this.phase === "message") {
      if (this.pages && this.page < this.pages.length) {
        const input = this.game && this.game.input;
        if (input && (input.wasPressed("a") || input.wasPressed("b"))) {
          this.page += 1;
          this.message = this.pages[this.page - 1]!;
        }
        return;
      }
      this.wait -= 1;
      if (this.wait > 0) return;
      this.phase = "pick";
      this.message = Strings.get(PICK_TEXT);
      this.cursor = 1;
      return;
    }
    if (this.phase === "quit") {
      this.updateQuit();
      return;
    }
    this.updatePick();
  }

  drawPanel(): void {
    Chrome.textbox(SAY_X, SAY_Y, SAY_W, SAY_H);
    // home/text.asm:473-477 LineChar
    Chrome.printWrapped(this.message, SAY_TEXT_X, SAY_TEXT_Y, SAY_W, 2, 2);
    if (this.phase === "message") {
      G.setColor(1, 1, 1, 1);
      return;
    }
    if (this.phase === "quit") {
      Chrome.box(YN_X, YN_Y, YN_W, YN_H);
      Chrome.print(Strings.get(YES_LABEL), YN_TEXT_X, YES_Y);
      Chrome.print(Strings.get(NO_LABEL), YN_TEXT_X, NO_Y);
      Chrome.cursor(YN_TEXT_X - 1, this.yes ? YES_Y : NO_Y);
      G.setColor(1, 1, 1, 1);
      return;
    }
    Chrome.box(PICK_X, PICK_Y, PICK_W, PICK_H);
    const row = this.rows[this.cursor - 1];
    Chrome.print(row ? BattleTowerMenu.levelLabel(row.group) : Strings.get(CANCEL_LABEL), ROW_X, ROW_Y);
    Chrome.print(UP_ARROW, ARROW_X, UP_Y);
    Chrome.print(DOWN_ARROW, ARROW_X, DOWN_Y);
    G.setColor(1, 1, 1, 1);
  }

  draw(): void {
    this.drawPanel();
  }
}

export default BattleTowerMenu;
