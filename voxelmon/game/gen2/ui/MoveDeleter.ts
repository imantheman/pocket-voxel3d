// gen1recomp src/ui/gen2/MoveDeleter.lua (bdfac727, MIT): the Blackthorn
// move deleter's move list (engine/events/move_deleter.asm
// ChooseMoveToDelete, engine/pokemon/mon_menu.asm). ChooseMoveToDelete
// shares SetUpMoveScreenBG / SetUpMoveList with the summary screen's move
// page (SummaryMenu.ts moveDetailPlacements), so the four-slot list geometry
// is the same box: names at (2, 3 + 2*slot), PP at (10/13/15/16, nameY + 1).
// What it does NOT share is the type/power/accuracy plaque under it --
// DeleteMoveScreen2DMenuData is a bare `db 3, 1` / `dn 2, 0` menu -- so only
// the move list itself is drawn here.
//
// The special that opens this (Specials H.MoveDeletion) has already run the
// "which move should it forget" line and refused a one-move mon before this
// screen is pushed, so this only has to answer a row. `layout: "forget"`
// draws the learn.asm forget box (ForgetMoveList) instead.

import G from "../platform/screen.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Chrome } from "./Chrome.ts";
import { ForgetMoveList } from "./ForgetMoveList.ts";

export interface MoveDeleterOpts {
  mon?: any;
  moves?: Record<string, any>;
  layout?: string;
  onChoose?: (index: number) => void;
  onCancel?: () => void;
}

export class MoveDeleter {
  // Lua: MoveDeleter.lua:23
  static isOpaque = false;
  isOpaque = false;

  game: any;
  forget: boolean;
  mon: any;
  moves: Record<string, any> | undefined;
  onChoose?: (index: number) => void;
  onCancel?: () => void;
  list: any[];
  row: number;
  done?: boolean;
  [key: string]: any;

  /** Lua: MoveDeleter.lua:25 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: MoveDeleter.lua:29 -- opts: mon, moves (data.moves), onChoose(slot), onCancel() */
  static new(game: any, opts?: MoveDeleterOpts): MoveDeleter {
    return new MoveDeleter(game, opts ?? {});
  }

  constructor(game: any, opts: MoveDeleterOpts) {
    this.game = game;
    const data = (game && game.data) || {};
    this.forget = opts.layout === "forget";
    this.mon = opts.mon;
    this.moves = opts.moves || data.moves;
    this.onChoose = opts.onChoose;
    this.onCancel = opts.onCancel;
    this.list = (this.mon && this.mon.moves) || [];
    this.row = 1;
  }

  /** Lua: MoveDeleter.lua:44 */
  moveName(entry: any): string {
    if (!entry) return "-";
    const def = this.moves ? this.moves[entry.id] : undefined;
    return (def && def.name) || entry.id;
  }

  /** Lua: MoveDeleter.lua:50 */
  playSfx(name: string): void {
    const data = this.game && this.game.data;
    const sfx = data && data.audio && data.audio.sfx;
    if (sfx && sfx[Sound.resolve(data, name)]) Sound.play(data, name);
  }

  /** Lua: MoveDeleter.lua:58 */
  finish(index?: number | null): void {
    if (this.done) return;
    this.done = true;
    if (index != null) {
      if (this.onChoose) this.onChoose(index);
    } else if (this.onCancel) {
      this.onCancel();
    }
  }

  /**
   * Lua: MoveDeleter.lua:71 -- ScrollingMenuJoypad, no wrap:
   * DeleteMoveScreen2DMenuData sets no _2DMENU_WRAP bit, so the cursor stops
   * at the ends (the forget box wraps: engine/pokemon/learn.asm:160).
   */
  update(_dt?: number): void {
    if (this.done) return;
    const input = this.game && this.game.input;
    if (!input) return;
    const n = this.list.length;
    if (n === 0) {
      if (input.wasPressed("a") || input.wasPressed("b")) this.finish(null);
      return;
    }
    if (input.wasPressed("up")) {
      if (this.row > 1) this.row = this.row - 1;
      else if (this.forget) this.row = n;
    } else if (input.wasPressed("down")) {
      if (this.row < n) this.row = this.row + 1;
      else if (this.forget) this.row = 1;
    } else if (input.wasPressed("a")) {
      this.playSfx("Sfx_ReadText2");
      this.finish(this.row);
    } else if (input.wasPressed("b")) {
      this.playSfx("Sfx_ReadText2");
      this.finish(null);
    }
  }

  /** Lua: MoveDeleter.lua:102 */
  draw(): void {
    if (this.forget) {
      ForgetMoveList.draw(this.list, this.row, this.moves);
      G.setColor(1, 1, 1, 1);
      return;
    }
    Chrome.textbox(0, 1, 18, 9);
    for (let slot = 1; slot <= 4; slot++) {
      const nameY = 3 + (slot - 1) * 2;
      const ppY = nameY + 1;
      const entry = this.list[slot - 1];
      if (entry) {
        Chrome.print(this.moveName(entry), 2, nameY);
        Chrome.print(Strings.get("PP"), 10, ppY);
        Chrome.print(Chrome.number(entry.pp, 2, true), 13, ppY);
        Chrome.print("/", 15, ppY);
        Chrome.print(Chrome.number(entry.maxPp ?? entry.pp, 2, true), 16, ppY);
      } else {
        Chrome.print("-", 2, nameY);
        Chrome.print("--", 10, ppY);
      }
    }
    if (this.row >= 1 && this.row <= this.list.length) Chrome.cursor(1, 3 + (this.row - 1) * 2);
    G.setColor(1, 1, 1, 1);
  }
}

export default MoveDeleter;
