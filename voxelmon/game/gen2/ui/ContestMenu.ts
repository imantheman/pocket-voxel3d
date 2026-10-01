// gen1recomp src/ui/gen2/ContestMenu.lua (bdfac727, MIT): the Bug Catching
// Contest's one screen -- the STOCK-versus-THIS comparison the park shows
// when you catch a second mon, and the "Switch #MON?" it asks over it
// (engine/events/bug_contest/display_stats.asm DisplayCaughtContestMonStats,
// driven by caught_mon.asm BugContest_SetCaughtContestMon).
//
// Layout from the ASM's hlcoord values:
//
//   Textbox (0,0) `ld b, 4 / ld c, 13`   interior 13x4, so 15x6 on screen
//   Textbox (0,6) `ld b, 4 / ld c, 13`   the same box six rows down
//   PlaceString (2,0)   " STOCK <PK><MN> "  -- ON the top border, spaces and
//   PlaceString (2,6)   " THIS <PK><MN> "      all, erasing the border under it
//   PlaceString (5,4)   "HEALTH"
//   PlaceString (5,10)  "HEALTH"
//   PlaceString (1,2)   the stock mon's name, then PrintLevel right after it
//   PlaceString (1,8)   the new mon's nickname, then PrintLevel likewise
//   PrintNum   (11,4)   wContestMonMaxHP, `lb bc, 2, 3`
//   PrintNum   (11,10)  wEnemyMonMaxHP, same field
//   PlaceYesNoBox `lb bc, 14, 7`  -- the shared 6x5 box at (14,7)
//
// PlaceYesNoBox's `ret c` is the NO arm, so backing out with B keeps the mon
// already in stock. The RULES are core/BugContest.ts; this screen only asks
// and calls BugContest.switchCaught on a yes.

import G from "../platform/screen.ts";
import { format } from "../platform/lua.ts";
import { BugContest } from "../core/BugContest.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Font } from "../shared/render/Font.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { Chrome } from "./Chrome.ts";

export interface ContestMenuOpts {
  save?: any;
  stock?: any;
  caught?: any;
  onClose?: (kept: any) => void;
}

// Lua: ContestMenu.lua:45 ------------------------------------------ layout
const STOCK_BOX_X = 0, STOCK_BOX_Y = 0;
const THIS_BOX_Y = 6;
const BOX_INNER_W = 13, BOX_INNER_H = 4;

const LABEL_X = 2;
const NAME_X = 1;
const NAME_ROW_OFFSET = 2; // (1,2) against a box at row 0
const HEALTH_X = 5;
const HEALTH_ROW_OFFSET = 4; // (5,4) against a box at row 0
const HP_X = 11; // PrintNum fills LEFT from a 3-digit field here
const HP_DIGITS = 3;

const YESNO_X = 14, YESNO_Y = 7, YESNO_W = 6, YESNO_H = 5;

// Lua: ContestMenu.lua:61 -- the shared text box: Textbox `lb bc, 4, 18` at
// (0,12), two lines two rows apart starting at row 14.
const TEXT_BOX_X = 0, TEXT_BOX_Y = 12, TEXT_BOX_W = 20, TEXT_BOX_H = 6;
const TEXT_X = 1, TEXT_Y = 14;

/**
 * Lua: ContestMenu.lua:106 -- PrintLevel writes the <LV> tile where it is
 * given and then the number, so a name and its level are one string.
 */
function nameAndLevel(mon: any): string {
  if (!mon) return "";
  const name = mon.nickname || mon.name || mon.species || "?";
  return format("%s<LV>%d", name, mon.level || 1);
}

/** Lua: ContestMenu.lua:112 */
function maxHp(mon: any): number {
  if (!mon) return 0;
  return mon.maxHp || (mon.stats && mon.stats.hp) || 0;
}

export class ContestMenu {
  // Lua: ContestMenu.lua:42
  static isOpaque = true;
  isOpaque = true;

  /**
   * Lua: ContestMenu.lua:69 -- display_stats.asm's .Stock / .This / .Health
   * and common_2.asm's _ContestAskSwitchText. <PK><MN> are one tile each.
   */
  static TEXT = {
    stock: Strings.source(" STOCK <PK><MN> "),
    this: Strings.source(" THIS <PK><MN> "),
    health: Strings.source("HEALTH"),
    askSwitch: Strings.source("Switch #MON?"),
    // _ContestCaughtMonText and _ContestAlreadyCaughtText.
    caught: (name: string): string[] => [Strings.get("Caught %s!", name)],
    alreadyCaught: (name: string): string[] => {
      const text = Strings.get("You already caught\na %s.", name);
      const lines: string[] = [];
      for (const m of (text + "\n").matchAll(/([\s\S]*?)\n/g)) lines.push(m[1]!);
      return lines;
    },
  };

  // Lua: ContestMenu.lua:89 -- pokecrystal display_stats.asm:84-87
  static TEXT_CRYSTAL = {
    stock: " STOCK <PK><MN> ",
    this: " THIS <PK><MN>  ",
  };

  game: any;
  save: any;
  stock: any;
  caught: any;
  onClose?: (kept: any) => void;
  choice: number;
  [key: string]: any;

  /** Lua: ContestMenu.lua:94 */
  static labels(): [string, string] {
    const text = GameVersion.engine() === "crystal" ? ContestMenu.TEXT_CRYSTAL : ContestMenu.TEXT;
    return [text.stock, text.this];
  }

  /** Lua: ContestMenu.lua:100 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: ContestMenu.lua:101 */
  drawsWidescreen(): boolean {
    return true;
  }

  /**
   * Lua: ContestMenu.lua:122 -- opts: save, stock (wContestMon), caught (the
   * mon just caught), onClose(kept) -- kept is the mon that ends up in stock
   */
  static new(game: any, opts?: ContestMenuOpts): ContestMenu {
    return new ContestMenu(game, opts ?? {});
  }

  constructor(game: any, opts: ContestMenuOpts) {
    this.game = game;
    this.save = opts.save || (game && game.save);
    this.stock = opts.stock || BugContest.caughtMon(this.save);
    this.caught = opts.caught;
    this.onClose = opts.onClose;
    // PlaceYesNoBox opens on YES; B is the same as NO.
    this.choice = 1;
  }

  /** Lua: ContestMenu.lua:136 */
  close(kept: any): void {
    if (this.onClose) this.onClose(kept);
  }

  /** Lua: ContestMenu.lua:140 */
  answer(yes: boolean): void {
    let kept = this.stock;
    if (yes) kept = BugContest.switchCaught(this.save, this.caught) || this.caught;
    this.close(kept);
  }

  /** Lua: ContestMenu.lua:148 */
  update(_dt?: number): void {
    const input = this.game && this.game.input;
    if (!input) return;
    if (input.wasPressed("up") || input.wasPressed("down")) {
      this.choice = this.choice === 1 ? 2 : 1;
      return;
    }
    if (input.wasPressed("b")) return this.answer(false);
    if (input.wasPressed("a")) return this.answer(this.choice === 1);
  }

  /** Lua: ContestMenu.lua:161 */
  drawMonBox(boxY: number, label: string, mon: any): void {
    Chrome.textbox(STOCK_BOX_X, boxY, BOX_INNER_W, BOX_INNER_H);
    Chrome.print(Strings.get(label), LABEL_X, boxY);
    Chrome.print(nameAndLevel(mon), NAME_X, boxY + NAME_ROW_OFFSET);
    Chrome.print(Strings.get(ContestMenu.TEXT.health), HEALTH_X, boxY + HEALTH_ROW_OFFSET);
    // `lb bc, 2, 3`: a three-digit field, space padded, laid down FROM
    // hlcoord 11 -- the padding is part of the string.
    Chrome.print(Chrome.number(maxHp(mon), HP_DIGITS), HP_X, boxY + HEALTH_ROW_OFFSET);
  }

  /** Lua: ContestMenu.lua:174 */
  drawYesNo(): void {
    Chrome.box(YESNO_X, YESNO_Y, YESNO_W, YESNO_H);
    // GetMenuTextStartCoord with STATICMENU_NO_TOP_SPACING: YES at (16,8),
    // NO at (16,10), cursor column 15.
    Chrome.print(Strings.get("YES"), YESNO_X + 2, YESNO_Y + 1);
    Chrome.print(Strings.get("NO"), YESNO_X + 2, YESNO_Y + 3);
    Chrome.cursor(YESNO_X + 1, YESNO_Y + (this.choice === 1 ? 1 : 3));
  }

  /** Lua: ContestMenu.lua:185 */
  drawPanel(): void {
    // pokecrystal engine/events/bug_contest/display_stats.asm:5
    const wasBattle = Font.useBattleExtra(true);
    Chrome.clear();
    const [stock, thisLabel] = ContestMenu.labels();
    this.drawMonBox(STOCK_BOX_Y, stock, this.stock);
    this.drawMonBox(THIS_BOX_Y, thisLabel, this.caught);
    Chrome.box(TEXT_BOX_X, TEXT_BOX_Y, TEXT_BOX_W, TEXT_BOX_H);
    Chrome.print(Strings.get(ContestMenu.TEXT.askSwitch), TEXT_X, TEXT_Y);
    this.drawYesNo();
    Font.useBattleExtra(wasBattle);
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: ContestMenu.lua:199 */
  draw(): void {
    this.drawPanel();
  }

  /** Lua: ContestMenu.lua:203 */
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

export default ContestMenu;
