// gen1recomp src/ui/gen2/BoxMenu.lua (bdfac727, MIT): Bill's PC withdraw /
// deposit list (engine/pokemon/bills_pc.asm).
//
// The screen is transcribed from the ASM's own coordinates:
//
//   BillsPC_BoxName        Textbox at (8,0), interior 10x1 -- the box name
//   BillsPC_RefreshTextboxes
//                          Textbox at (8,2), interior 10x10, its top corners
//                          overwritten by the name box above it
//   .PlaceNickname         five nicknames from (9,4), two rows apart
//   PCMonInfo              the left panel: front pic at (1,4) as 7x7 tiles,
//                          level at (1,12), gender at (5,12), species at (1,14)
//
// `mode` picks which list is being browsed: "withdraw" reads the current box,
// "deposit" reads the party, and "move" walks BOTH.
//
// MOVE POKéMON W/O MAIL (_MovePKMNWithoutMail, engine/pokemon/bills_pc.asm:480)
// is .Init -> .Joypad -> .PrepSubmenu -> .MoveMonWOMailSubmenu ->
// .PrepInsertCursor -> .Joypad2:
//   1. "Choose a <PK><MN>." over a list that left/right walks across the PARTY
//      and all fourteen boxes, wrapping at both ends
//   2. A on a mon opens MOVE / STATS / CANCEL under "What's up?"
//   3. MOVE asks "Move to where?" with an insert cursor the player drives to
//      the destination list AND the slot inside it
//   4. A there is BillsPC_CheckSpaceInDestination then
//      MovePKMNWithoutMail_InsertMon ("Saving… Leave ON!"); B restores the
//      backed-up position and goes back to step 1

import G from "../platform/screen.ts";
import { insertAt, mod, removeAt, tostring } from "../platform/lua.ts";
import { Boxes } from "../core/Boxes.ts";
import { CommonText } from "../core/CommonText.ts";
import { Mail } from "../core/Mail.ts";
import { Unown } from "../core/Unown.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Sprites } from "../shared/pokemon/Sprites.ts";
import { Assets } from "../shared/render/Assets.ts";
import { Font } from "../shared/render/Font.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import type { LcdImage } from "../platform/screen.ts";
import { ChoiceBox } from "../shared/ui/ChoiceBox.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { Palettes } from "../world/Palettes.ts";
import { Chrome } from "./Chrome.ts";
import { PartyMenu } from "./PartyMenu.ts";

type Colors = any;

export interface BoxMenuOpts {
  save?: any;
  mode?: string;
  onClose?: () => void;
  pokemon?: any;
  palettes?: any;
  menuGfx?: any;
  icons?: any;
}

interface CryWait {
  src: any;
  mon: any;
  text: string;
  t: number;
}

// Lua: BoxMenu.lua:64 -- BillsPC_NumMonsOnScreen is 5.
const VISIBLE_ROWS = 5;
const LIST_X = 9, LIST_Y = 4;
const LIST_SPACING = 2;
const PIC_X = 1, PIC_Y = 4;

// Lua: BoxMenu.lua:71 -- PadFrontpic pads a 5x5 or 6x6 pic into the 7x7
// block (engine/gfx/load_pics.asm:342-386).
const PIC_PAD: Record<number, [number, number]> = { 7: [0, 0], 6: [1, 1], 5: [1, 2] };

// Lua: BoxMenu.lua:74 -- gfx/pc/orange.pal
const BILLS_PC_ORANGE = [[255, 123, 0], [189, 99, 0], [123, 58, 0], [0, 0, 0]];

// Lua: BoxMenu.lua:80 -- PCMonInfo prints the held-item icon at hlcoord 7, 12.
const ICON_X = 7, ICON_Y = 12;

// Lua: BoxMenu.lua:84 -- $5f at hlcoord 8, 1 and $5e at hlcoord 19, 1, off a
// PCMailGFX sheet that starts at $5c (engine/pokemon/bills_pc.asm:957-963).
const ARROW_ROW = 1;
const ARROW_LEFT: [number, number] = [3, 8];
const ARROW_RIGHT: [number, number] = [2, 19];

// Lua: BoxMenu.lua:91 -- wBillsPC_LoadedBox: 0 is the PARTY (move screen only).
const PARTY_BOX = 0;

// Lua: BoxMenu.lua:96 -- .MoveMonWOMailSubmenu's .MenuData, verbatim.
const MOVE_SUBMENU = [Strings.source("MOVE"), Strings.source("STATS"), Strings.source("CANCEL")];

// Lua: BoxMenu.lua:101 -- engine/pokemon/bills_pc.asm:472-478.
const WITHDRAW_SUBMENU = [
  Strings.source("WITHDRAW"), Strings.source("STATS"),
  Strings.source("RELEASE"), Strings.source("CANCEL"),
];

// Lua: BoxMenu.lua:107 -- BillsPCDepositMenuHeader's .MenuData (:234-240).
const DEPOSIT_SUBMENU = [
  Strings.source("DEPOSIT"), Strings.source("STATS"),
  Strings.source("RELEASE"), Strings.source("CANCEL"),
];

// Lua: BoxMenu.lua:122
const SAVING_LEAVE_ON = Strings.source("Saving… Leave ON!");
const NO_RELEASING_EGGS = Strings.source("No releasing EGGS!");
const PARTY_TITLE = Strings.source("PARTY <PK><MN>");
const DEFAULT_BOX_TITLE = Strings.source("BOX%d");
const CHOOSE_PROMPT = Strings.source("Choose a <PK><MN>.");
const WHATS_UP_PROMPT = Strings.source("What's up?");
const MOVE_WHERE_PROMPT = Strings.source("Move to where?");
const LAST_MON = Strings.source("It's your last <PK><MN>!");
const NO_USABLE_MON = Strings.source("No more usable <PK><MN>!");
const REMOVE_MAIL = Strings.source("Remove MAIL.");
const NO_ROOM = Strings.source("There's no room!");
const RELEASE_PROMPT = Strings.source("Release <PK><MN>?");
const RELEASED = Strings.source("Released <PK><MN>.\fBye,\n%s!");
const GOT_MON = Strings.source("Got %s!");
const STORED_MON = Strings.source("Stored %s!");

// Lua: BoxMenu.lua:142 -- engine/pokemon/bills_pc.asm:1804 `ld c, 50 / call DelayFrames`
const STORE_MESSAGE_FRAMES = 50;

// Lua: BoxMenu.lua:147 -- Boxes' finite refusals, marked for the catalog.
export const BOX_FAILURE_SOURCES = [
  Strings.source("No save."),
  Strings.source("There is no POKéMON there."),
  Strings.source("The BOX is full."),
  Strings.source("You can't deposit\nthe last POKéMON!"),
  Strings.source("You can't take\nany more POKéMON."),
  Strings.source("It's already there."),
  Strings.source("You'll need a\nPOKéMON to call\fwith."),
];

/** Lua: BoxMenu.lua:165 -- \n, \f and \v through CommonText.pages. */
function messagePages(text: string): string[][] {
  return CommonText.pages(text) || [];
}

export class BoxMenu {
  // Lua: BoxMenu.lua:61
  static isOpaque = true;
  isOpaque = true;

  game: any;
  save: any;
  mode: string;
  onClose?: () => void;
  pokemon: any;
  palettes: any;
  menuGfx: any;
  icons: any;
  boxIndex: number;
  index: number;
  scroll: number;
  picCache: Record<string, LcdImage | false>;
  message: string | undefined;
  messagePage?: number;
  messageFrames: number | undefined;
  cryWait: CryWait | undefined;
  phase: string | undefined;
  submenuIndex: number;
  moveFrom?: { box: number; slot: number };
  backup?: { box: number; index: number; scroll: number };
  panelCleared?: boolean;
  [key: string]: any;

  /** Lua: BoxMenu.lua:112 */
  submenuRows(): string[] {
    if (this.mode === "move") return MOVE_SUBMENU;
    if (this.mode === "deposit") return DEPOSIT_SUBMENU;
    return WITHDRAW_SUBMENU;
  }

  /** Lua: BoxMenu.lua:169 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: BoxMenu.lua:170 */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: BoxMenu.lua:173 -- opts: save, mode ("withdraw" | "deposit" | "move"), onClose() */
  static new(game: any, opts?: BoxMenuOpts): BoxMenu {
    return new BoxMenu(game, opts ?? {});
  }

  constructor(game: any, opts: BoxMenuOpts) {
    this.game = game;
    this.save = opts.save || (game && game.save);
    this.mode = opts.mode || "withdraw";
    this.onClose = opts.onClose;
    const data = (game && game.data) || {};
    this.pokemon = opts.pokemon || data.pokemon;
    this.palettes = opts.palettes || data.gen2Palettes;
    // EggPic rides menu_gfx.eggHatch; ICON_EGG stands in for an older cache.
    this.menuGfx = opts.menuGfx || data.gen2MenuGfx;
    this.icons = opts.icons || data.gen2Icons;
    this.boxIndex = (this.save && this.save.currentBox) || 1;
    this.index = 1;
    this.scroll = 0;
    this.picCache = {};
    this.message = undefined;
    this.messageFrames = undefined;
    this.cryWait = undefined;
    // undefined while browsing; "submenu" while the rows are up, "insert"
    // while the insert cursor picks a destination.
    this.phase = undefined;
    this.submenuIndex = 1;
  }

  /** Lua: BoxMenu.lua:203 -- the PARTY is box 0 on the move screen only. */
  isParty(index?: number): boolean {
    if (index == null) index = this.boxIndex;
    return this.mode === "move" && index === PARTY_BOX;
  }

  /** Lua: BoxMenu.lua:210 -- a live table, so an insert here lands on the save. */
  listAt(index: number): any[] {
    if (this.isParty(index)) {
      this.save.party = this.save.party || [];
      return this.save.party;
    }
    return Boxes.box(this.save, index);
  }

  /** Lua: BoxMenu.lua:220 */
  capacityAt(index: number): number {
    if (this.isParty(index)) return Boxes.PARTY_SIZE;
    return Boxes.MONS_PER_BOX;
  }

  /** Lua: BoxMenu.lua:227 -- BillsPC_BoxName. */
  nameAt(index: number): string {
    // .PartyPKMN is "PARTY <PK><MN>@" -- eight tiles.
    if (this.isParty(index)) return Strings.get(PARTY_TITLE);
    const names = this.save && this.save.boxNames;
    const custom = names && names[index - 1];
    if (typeof custom === "string" && custom !== "") return custom;
    return Strings.get(DEFAULT_BOX_TITLE, index);
  }

  /** Lua: BoxMenu.lua:238 */
  list(): any[] {
    if (this.mode === "deposit") return this.save.party || [];
    return this.listAt(this.boxIndex);
  }

  /** Lua: BoxMenu.lua:243 */
  title(): string {
    if (this.mode === "deposit") return Strings.get(PARTY_TITLE);
    // While the insert cursor is up the header names the DESTINATION.
    return this.nameAt(this.boxIndex);
  }

  /** Lua: BoxMenu.lua:253 -- the cart's own prompts (PCString_*). */
  prompt(): string {
    // engine/pokemon/bills_pc.asm:356-369: PrepSubmenu places PCString_WhatsUp.
    if (this.phase === "submenu") return Strings.get(WHATS_UP_PROMPT);
    if (this.mode === "move") {
      if (this.phase === "insert") return Strings.get(MOVE_WHERE_PROMPT);
      return Strings.get(CHOOSE_PROMPT);
    }
    // PCString_ChooseaPKMN (engine/pokemon/bills_pc.asm:2185).
    return Strings.get(CHOOSE_PROMPT);
  }

  /** Lua: BoxMenu.lua:266 */
  total(): number {
    return this.list().length + 1; // CANCEL
  }

  /** Lua: BoxMenu.lua:270 */
  isCancel(): boolean {
    return this.index > this.list().length;
  }

  /** Lua: BoxMenu.lua:274 */
  selected(): any {
    return this.list()[this.index - 1];
  }

  /** Lua: BoxMenu.lua:278 */
  ensureVisible(): void {
    if (this.index <= this.scroll) {
      this.scroll = this.index - 1;
    } else if (this.index > this.scroll + VISIBLE_ROWS) {
      this.scroll = this.index - VISIBLE_ROWS;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.total() - VISIBLE_ROWS)));
  }

  /** Lua: BoxMenu.lua:288 */
  clampIndex(): void {
    const total = this.total();
    if (this.index > total) this.index = total;
    if (this.index < 1) this.index = 1;
    this.ensureVisible();
  }

  /** Lua: BoxMenu.lua:295 */
  act(): void {
    if (this.isCancel()) {
      if (this.onClose) this.onClose();
      return;
    }
    // engine/pokemon/bills_pc.asm:336-344, :94-102
    if (!this.selected()) return;
    this.phase = "submenu";
    // `ld a, $1 / ld [wMenuCursorY], a`
    this.submenuIndex = 1;
  }

  // ------------------------------------------------------------ MOVE, step 2

  /**
   * Lua: BoxMenu.lua:314 -- BillsPC_CheckMail_PreventBlackout
   * (engine/pokemon/bills_pc.asm:1575): [true] or [false, string].
   */
  checkMailPreventBlackout(): [true] | [false, string] {
    // `ld a, [wBillsPC_LoadedBox] / and a / jr nz, .Okay`
    if (!(this.isParty() || this.mode === "deposit")) return [true];
    const party: any[] = this.save.party || [];
    // `cp $3 / jr c, .ItsYourLastPokemon`
    if (party.length < 3) return [false, LAST_MON];
    // CheckCurPartyMonFainted (engine/pokemon/bills_pc_top.asm:171)
    let othersUsable = false;
    for (let i = 1; i <= party.length; i++) {
      const mon = party[i - 1];
      if (mon == null) break; // ipairs
      if (i !== this.index && (mon.hp || 0) > 0) {
        othersUsable = true;
        break;
      }
    }
    if (!othersUsable) return [false, NO_USABLE_MON];
    // wBillsPC_MonHasMail: the second of two nets.
    if (Mail.monHoldsMail(party[this.index - 1])) return [false, REMOVE_MAIL];
    return [true];
  }

  /** Lua: BoxMenu.lua:342 -- .Move: back the position up, step to .PrepInsertCursor. */
  beginMove(): void {
    const [ok, reason] = this.checkMailPreventBlackout();
    if (!ok) {
      // BillsPC_PlaceString + SFX_WRONG; the message holds until a button.
      this.phase = undefined;
      // engine/pokemon/bills_pc.asm:1607
      this.playRefusalSfx("Sfx_Wrong");
      this.message = Strings.get(reason!);
      return;
    }
    this.moveFrom = { box: this.boxIndex, slot: this.index };
    this.backup = { box: this.boxIndex, index: this.index, scroll: this.scroll };
    this.phase = "insert";
    this.clampInsert();
  }

  /** Lua: BoxMenu.lua:362 -- BillsPC_StatsScreen. */
  openStats(): void {
    const mon = this.selected();
    const game = this.game;
    if (!(mon && game && game.stack)) return;
    try {
      Screens.get(game, "Gen2SummaryMenu");
    } catch {
      return;
    }
    Screens.push(game, "Gen2SummaryMenu", {
      mon,
      save: this.save,
      onClose: () => game.stack.pop(),
    });
  }

  /** Lua: BoxMenu.lua:376 -- engine/pokemon/bills_pc.asm:1785-1787, :1804 */
  holdMessage(text: string): void {
    this.message = text;
    this.messagePage = 1;
    this.messageFrames = STORE_MESSAGE_FRAMES;
    this.panelCleared = true;
  }

  /** Lua: BoxMenu.lua:383 */
  isCrystal(): boolean {
    const version = (this.save && this.save.version) || GameVersion.get();
    return GameVersion.engine(version) === "crystal";
  }

  /** Lua: BoxMenu.lua:389 -- ../pokegold/home/pokemon.asm:101-107 */
  cryThenHold(src: any, mon: any, text: string): void {
    if (!(this.isCrystal() && src && src.isPlaying)) return this.holdMessage(text);
    this.cryWait = { src, mon, text, t: 0 };
  }

  /** Lua: BoxMenu.lua:397 -- engine/pokemon/bills_pc.asm:397-411 */
  doWithdraw(): void {
    const [ok, result] = Boxes.withdraw(this.save, this.boxIndex, this.index);
    if (!ok) {
      // engine/pokemon/bills_pc.asm:1845
      this.playRefusalSfx("Sfx_Wrong");
      this.message = Strings.get(result);
      return;
    }
    // engine/pokemon/bills_pc.asm:1817
    const name = result.nickname || result.name || result.species || "?";
    this.cryThenHold(this.playMonCry(result), result, Strings.get(GOT_MON, name));
  }

  /** Lua: BoxMenu.lua:411 -- engine/pokemon/bills_pc.asm:155 BillsPCDepositFuncDeposit */
  doDeposit(): void {
    const mon = this.selected();
    const name = (mon && (mon.nickname || mon.name || mon.species)) || "?";
    const [ok, result] = Boxes.deposit(this.save, this.index, this.boxIndex);
    if (!ok) {
      // engine/pokemon/bills_pc.asm:1790
      this.playRefusalSfx("Sfx_Wrong");
      this.message = Strings.get(result);
      return;
    }
    // engine/pokemon/bills_pc.asm:1762
    this.cryThenHold(this.playMonCry(result), result, Strings.get(STORED_MON, name));
  }

  /** Lua: BoxMenu.lua:425 */
  chooseSubmenu(): void {
    const row = this.submenuRows()[this.submenuIndex - 1];
    if (row === "MOVE") this.beginMove();
    else if (row === "DEPOSIT") this.doDeposit();
    else if (row === "WITHDRAW") this.doWithdraw();
    else if (row === "STATS") this.openStats();
    else if (row === "RELEASE") this.askRelease();
    else {
      // .Cancel: `ld a, $0 / ld [wJumptableIndex], a`.
      this.phase = undefined;
    }
  }

  // ------------------------------------------------------------ MOVE, step 3

  /**
   * Lua: BoxMenu.lua:448 -- BillsPC_PressDown stops at NumMonsInBox - 1, so
   * the cursor always sits ON a mon (or on row one of an empty list).
   */
  insertPositions(): number {
    return Math.max(1, this.listAt(this.boxIndex).length);
  }

  /** Lua: BoxMenu.lua:452 */
  clampInsert(): void {
    this.index = Math.max(1, Math.min(this.index, this.insertPositions()));
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.insertPositions() - VISIBLE_ROWS)));
    if (this.index <= this.scroll) {
      this.scroll = this.index - 1;
    } else if (this.index > this.scroll + VISIBLE_ROWS) {
      this.scroll = this.index - VISIBLE_ROWS;
    }
  }

  /**
   * Lua: BoxMenu.lua:468 -- BillsPC_CheckSpaceInDestination: a move inside
   * one list is always allowed; another one needs a free slot.  The port
   * refuses at the real capacity (the ASM's +1 compare can never be reached).
   */
  checkSpaceInDestination(): [true] | [false, string] {
    const from = this.moveFrom;
    if (from && from.box === this.boxIndex) return [true];
    if (this.listAt(this.boxIndex).length >= this.capacityAt(this.boxIndex)) return [false, NO_ROOM];
    return [true];
  }

  /**
   * Lua: BoxMenu.lua:483 -- MovePKMNWithoutMail_InsertMon: one remove and one
   * insert, plus the mail bookkeeping on the party end.
   */
  insertMon(): void {
    const from = this.moveFrom;
    if (!from) return;
    const source = this.listAt(from.box);
    const mon = source[from.slot - 1];
    if (!mon) {
      this.phase = undefined;
      this.moveFrom = undefined;
      this.backup = undefined;
      return;
    }
    const destIndex = this.boxIndex;
    let target = Math.min(this.index, this.insertPositions());
    removeAt(source, from.slot);
    // sPartyMail is keyed by party SLOT (RemoveMonFromPartyOrBox's tail).
    if (this.isParty(from.box)) Mail.removeSlot(this.save, from.slot);
    const dest = this.listAt(destIndex);
    if (from.box === destIndex && target > from.slot) {
      // .CheckTrivialMove: the source was taken out first.
      target = target - 1;
    }
    insertAt(dest, Math.max(1, Math.min(target, dest.length + 1)), mon);
    // .CopyToBox tails into RestorePPOfDepositedPokemon
    // (engine/pokemon/move_mon_wo_mail.asm:35-37).
    if (!this.isParty(destIndex)) Boxes.enterBox(mon);
    this.phase = undefined;
    this.moveFrom = undefined;
    this.backup = undefined;
    this.index = 1;
    this.scroll = 0;
    this.clampIndex();
    this.message = Strings.get(SAVING_LEAVE_ON);
  }

  /** Lua: BoxMenu.lua:521 -- .b_button_2: the backed-up position goes back. */
  cancelMove(): void {
    const backup = this.backup;
    if (backup) {
      this.boxIndex = backup.box;
      this.index = backup.index;
      this.scroll = backup.scroll;
    }
    this.phase = undefined;
    this.moveFrom = undefined;
    this.backup = undefined;
    this.clampIndex();
  }

  /**
   * Lua: BoxMenu.lua:534 -- BillsPC_PressLeft / PressRight, reached only from
   * MoveMonWithoutMail_DPad: the move screen wraps through box 0.
   */
  stepBox(delta: number): void {
    const low = this.mode === "move" ? PARTY_BOX : 1;
    const span = Boxes.NUM_BOXES - low + 1;
    this.boxIndex = mod(this.boxIndex - low + delta, span) + low;
    // .dpad / .dpad_2: both arms zero the cursor and the scroll.
    this.index = 1;
    this.scroll = 0;
    if (this.phase === "insert") this.clampInsert();
  }

  /** Lua: BoxMenu.lua:543 */
  update(_dt?: number): void {
    const input = this.game && this.game.input;
    if (!input) return;

    if (this.cryWait) {
      const w = this.cryWait;
      w.t = w.t + 1;
      const playing = w.src.isPlaying();
      if (w.t < 3 || (playing && w.t <= 180)) return;
      this.cryWait = undefined;
      this.holdMessage(w.text);
      return;
    }

    // engine/pokemon/bills_pc.asm:1804 DelayFrames reads no joypad; :161
    // zeroes wJumptableIndex / cursor / scroll only once it returns.
    if (this.messageFrames != null) {
      this.messageFrames = this.messageFrames - 1;
      if (this.messageFrames > 0) return;
      this.messageFrames = undefined;
      this.message = undefined;
      this.messagePage = undefined;
      this.panelCleared = undefined;
      this.phase = undefined;
      this.index = 1;
      this.scroll = 0;
      this.clampIndex();
      return;
    }

    if (this.message != null) {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        const page = (this.messagePage || 1) + 1;
        if (page <= messagePages(this.message).length) {
          this.messagePage = page;
        } else {
          this.message = undefined;
          this.messagePage = undefined;
        }
      }
      return;
    }

    // .MoveMonWOMailSubmenu, a VerticalMenu.
    if (this.phase === "submenu") {
      const submenu = this.submenuRows();
      if (input.wasPressed("up")) {
        this.submenuIndex = this.submenuIndex > 1 ? this.submenuIndex - 1 : submenu.length;
      } else if (input.wasPressed("down")) {
        this.submenuIndex = this.submenuIndex < submenu.length ? this.submenuIndex + 1 : 1;
      } else if (input.wasPressed("a")) {
        // home/menu.asm:345
        this.playSfx("Sfx_ReadText2");
        this.chooseSubmenu();
      } else if (input.wasPressed("b")) {
        this.playSfx("Sfx_ReadText2");
        this.phase = undefined;
      }
      return;
    }

    // .Joypad2: the insert cursor.
    if (this.phase === "insert") {
      const positions = this.insertPositions();
      if (input.wasPressed("up")) {
        this.index = this.index > 1 ? this.index - 1 : positions;
        this.clampInsert();
      } else if (input.wasPressed("down")) {
        this.index = this.index < positions ? this.index + 1 : 1;
        this.clampInsert();
      } else if (input.wasPressed("left")) {
        this.stepBox(-1);
      } else if (input.wasPressed("right")) {
        this.stepBox(1);
      } else if (input.wasPressed("a")) {
        const [ok, reason] = this.checkSpaceInDestination();
        if (!ok) {
          // .no_space; engine/pokemon/bills_pc.asm:1567
          this.playRefusalSfx("Sfx_Wrong");
          this.message = Strings.get(reason!);
        } else {
          this.insertMon();
        }
      } else if (input.wasPressed("b")) {
        this.cancelMove();
      }
      return;
    }

    const total = this.total();
    if (input.wasPressed("up")) {
      this.index = this.index > 1 ? this.index - 1 : total;
      this.ensureVisible();
    } else if (input.wasPressed("down")) {
      this.index = this.index < total ? this.index + 1 : 1;
      this.ensureVisible();
    } else if (input.wasPressed("left") && this.mode === "move") {
      // Withdraw_UpDown reads PAD_UP and PAD_DOWN only (bills_pc.asm:806-845).
      this.stepBox(-1);
    } else if (input.wasPressed("right") && this.mode === "move") {
      this.stepBox(1);
    } else if (input.wasPressed("a")) {
      this.act();
    } else if (input.wasPressed("select") && this.mode === "withdraw") {
      // RELEASE and the nickname keyboard are BillsPC_WithdrawMenu's rows.
      this.askRelease();
    } else if (input.wasPressed("start") && this.mode === "withdraw") {
      this.askNickname();
    } else if (input.wasPressed("b")) {
      if (this.onClose) this.onClose();
    }
  }

  /** Lua: BoxMenu.lua:662 */
  playSfx(name: string): void {
    const data = this.game && this.game.data;
    const sfx = data && data.audio && data.audio.sfx;
    if (sfx && sfx[Sound.resolve(data, name)]) Sound.play(data, name);
  }

  /** Lua: BoxMenu.lua:669 -- engine/pokemon/bills_pc.asm:1608 */
  playRefusalSfx(name: string): void {
    Sound.waitSfxDone();
    this.playSfx(name);
  }

  /** Lua: BoxMenu.lua:675 -- PlayMonCry: `call GetCryIndex / jr c, .done` */
  playMonCry(mon: any): any {
    const data = this.game && this.game.data;
    if (!(data && mon && mon.species) || mon.isEgg) return undefined;
    const cries = data.audio && data.audio.cries;
    if (cries && cries[mon.species]) return Sound.playCry(data, mon.species);
    return undefined;
  }

  /**
   * Lua: BoxMenu.lua:687 -- BillsPC's RELEASE: the cart asks first and starts
   * the prompt on NO.
   */
  askRelease(): void {
    if (this.isCancel()) return;
    const mon = this.selected();
    if (!mon) return;
    // BillsPCDepositFuncRelease runs the mail/blackout net BEFORE the egg
    // check (engine/pokemon/bills_pc.asm:183-187).
    if (this.mode === "deposit") {
      const [allowed, refusal] = this.checkMailPreventBlackout();
      if (!allowed) {
        this.phase = undefined;
        // engine/pokemon/bills_pc.asm:1607
        this.playRefusalSfx("Sfx_Wrong");
        this.message = Strings.get(refusal!);
        return;
      }
    }
    // BillsPC_IsMonAnEgg first (engine/pokemon/bills_pc.asm:186-187, :427-428).
    if (mon.isEgg) {
      this.message = Strings.get(NO_RELEASING_EGGS);
      this.playRefusalSfx("Sfx_Wrong");
      return;
    }
    const game = this.game;
    if (!(game && game.stack)) return;
    const name = mon.nickname || mon.name || mon.species || "?";
    this.message = Strings.get(RELEASE_PROMPT);
    game.stack.push(ChoiceBox.new(game, (yes: boolean) => {
      this.message = undefined;
      if (!yes) return;
      let ok: boolean;
      let err: any;
      if (this.mode === "deposit") [ok, err] = Boxes.releaseFromParty(this.save, this.index);
      else [ok, err] = Boxes.release(this.save, this.boxIndex, this.index);
      if (!ok) {
        this.message = Strings.get(err);
        return;
      }
      // engine/pokemon/bills_pc.asm:1866
      this.playMonCry(mon);
      this.message = Strings.get(RELEASED, name);
      this.phase = undefined;
      this.clampIndex();
    }, { defaultNo: true }));
  }

  /** Lua: BoxMenu.lua:737 -- the naming screen from BillsPC's nickname option. */
  askNickname(): void {
    if (this.isCancel()) return;
    const mon = this.selected();
    if (!mon) return;
    const game = this.game;
    if (!(game && game.stack)) return;
    // The resolve is guarded rather than the construction.
    try {
      Screens.get(game, "Gen2NamingScreen");
    } catch {
      return;
    }
    Screens.push(game, "Gen2NamingScreen", {
      type: "nickname",
      monName: mon.name || mon.species,
      initial: mon.nickname || "",
      onDone: (name: string) => {
        game.stack.pop();
        if (name && name.length > 0) mon.nickname = name;
      },
      onCancel: () => game.stack.pop(),
    });
  }

  /** Lua: BoxMenu.lua:761 */
  image(path: string | undefined): LcdImage | undefined {
    if (!path) return undefined;
    let cached = this.picCache[path];
    if (cached === undefined) {
      try {
        cached = Assets.image(path) || false;
      } catch {
        cached = false;
      }
      this.picCache[path] = cached;
    }
    return cached || undefined;
  }

  /** Lua: BoxMenu.lua:774 -- the selected mon's front pic. */
  picFor(mon: any): [LcdImage | undefined, boolean] {
    if (!(mon && mon.species && this.pokemon)) return [undefined, false];
    const def = this.pokemon[mon.species];
    let path: string | undefined = def && def.spriteFront;
    // BillsPC_LoadMonStats runs GetUnownLetter before GetBaseData
    // (engine/pokemon/bills_pc.asm:1048-1052): a stored Unown shows its form.
    if (mon.species === Unown.SPECIES) {
      path = Unown.formSprite(this.pokemon, Unown.monLetter(mon)) || path;
    }
    const [pic, trueColor] = Sprites.pic(path, {
      species: mon.species,
      side: "front",
      kind: "box",
      mon,
      data: this.game && this.game.data,
      letter: Unown.monLetter(mon),
      shiny: mon.shiny ? true : false,
    } as any);
    return [this.image(pic), trueColor];
  }

  /** Lua: BoxMenu.lua:800 -- engine/gfx/cgb_layouts.asm:284-300 */
  panelColors(speciesId?: string, shiny?: unknown): Colors {
    if (this.phase === "submenu" || this.phase === "insert") {
      return this.palettes && Palettes.monColors(this.palettes, speciesId, shiny);
    }
    const gfx = (this.menuGfx || {}).billsPc;
    return (gfx && gfx.orangePalette) || BILLS_PC_ORANGE;
  }

  /** Lua: BoxMenu.lua:810 -- ClearBox runs before `cp -1 / ret z` (:1009-1021) */
  fillPicBlock(colors: Colors): void {
    const blank = colors ? GbcPalette.color(colors, 1) : [255, 255, 255];
    G.setColor(blank[0]! / 255, blank[1]! / 255, blank[2]! / 255, 1);
    G.rectangle("fill", PIC_X * 8, PIC_Y * 8, 7 * 8, 7 * 8);
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: BoxMenu.lua:820 -- the padded pic as one 7x7 block at hlcoord 1, 4. */
  drawPicBlock(image: LcdImage | undefined, colors: Colors, trueColor?: boolean): void {
    if (!image) return;
    this.fillPicBlock(colors);
    const pad = PIC_PAD[Math.floor(image.getWidth() / 8)] || PIC_PAD[7]!;
    G.setColor(1, 1, 1, 1);
    const body = () => G.draw(image, (PIC_X + pad[0]) * 8, (PIC_Y + pad[1]) * 8);
    if (colors && !(trueColor && GbcPalette.mode === "gbc") && GbcPalette.available()) {
      GbcPalette.with(colors, body);
    } else {
      body();
    }
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: BoxMenu.lua:839 -- _CGB_BillsPC takes the shiny row (cgb_layouts.asm:292-293). */
  drawPic(mon: any): void {
    const colors = this.panelColors(mon.species, mon.shiny);
    const [image, trueColor] = this.picFor(mon);
    // engine/pokemon/bills_pc.asm:1009-1011
    if (!image) return this.fillPicBlock(colors);
    this.drawPicBlock(image, colors, trueColor);
  }

  /**
   * Lua: BoxMenu.lua:852 -- GetFrontpic's EGG arm hands back EggPic
   * (engine/gfx/load_pics.asm:88-91).
   */
  drawEggPic(mon: any): void {
    const colors = this.panelColors("EGG", mon && mon.shiny);
    const gfx = (this.menuGfx || {}).eggHatch;
    let image = this.image(gfx && gfx.egg);
    if (image) return this.drawPicBlock(image, colors);
    this.fillPicBlock(colors);
    const entry = this.icons && this.icons.icons && this.icons.icons.ICON_EGG;
    image = this.image(entry && entry.image);
    if (!image) return;
    // The ICON_EGG sheet stacks its frames; the first is the egg at rest.
    const w = entry.width || 16;
    let h = Math.min(entry.height || 16, image.getHeight());
    if ((entry.frames || 1) > 1) h = Math.floor(h / entry.frames);
    const quad = G.newQuad(0, 0, w, h, image.getWidth(), image.getHeight());
    // NOT FAITHFUL: the Lua draws the 16x16 icon at 2x; G ignores scale, so
    // the stand-in egg is its native size, still centred on the 2x box.
    const x = PIC_X * 8 + Math.floor((7 * 8 - w * 2) / 2);
    const y = PIC_Y * 8 + Math.floor((7 * 8 - h * 2) / 2);
    G.setColor(1, 1, 1, 1);
    const body = () => G.draw(image!, quad, x, y, 0, 2, 2);
    if (colors && GbcPalette.available()) GbcPalette.with(colors, body);
    else body();
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: BoxMenu.lua:883 -- ItemIsMail picks $5c over $5d (bills_pc.asm:1079-1094) */
  drawHeldIcon(mon: any): void {
    const row = PartyMenu.heldMarkerRow(mon);
    if (row == null) return;
    const gfx = (this.menuGfx || {}).billsPc;
    const image = this.image(gfx && gfx.icons);
    if (!image) return;
    const [iw, ih] = image.getDimensions();
    const quad = G.newQuad(row * 8, 0, 8, 8, iw, ih);
    G.setColor(1, 1, 1, 1);
    const body = () => G.draw(image, quad, ICON_X * 8, ICON_Y * 8);
    const colors = gfx && gfx.palette;
    if (colors && GbcPalette.available()) GbcPalette.with(colors, body);
    else body();
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: BoxMenu.lua:905 -- _MovePKMNWithoutMail only (bills_pc.asm:545, :698) */
  drawBoxArrows(): void {
    if (this.mode !== "move") return;
    const gfx = (this.menuGfx || {}).billsPc;
    const image = this.image(gfx && gfx.icons);
    if (!image) return;
    const [iw, ih] = image.getDimensions();
    const quads: Array<[any, number]> = [];
    for (const arrow of [ARROW_LEFT, ARROW_RIGHT]) {
      quads.push([G.newQuad(arrow[0] * 8, 0, 8, 8, iw, ih), arrow[1]]);
    }
    G.setColor(1, 1, 1, 1);
    const body = () => {
      for (const entry of quads) G.draw(image, entry[0], entry[1] * 8, ARROW_ROW * 8);
    };
    const colors = gfx && gfx.palette;
    if (colors && GbcPalette.available()) GbcPalette.with(colors, body);
    else body();
    G.setColor(1, 1, 1, 1);
  }

  /**
   * Lua: BoxMenu.lua:935 -- ../pokegold/engine/pokemon/bills_pc.asm:1439-1490,
   * ../pokecrystal/engine/pokemon/bills_pc.asm:1479-1503
   */
  selectionFrameRect(row: number): { x: number; y: number; w: number; h: number; rounded: boolean } {
    if (this.isCrystal()) return { x: 70, y: 29 + (row - 1) * 16, w: 83, h: 13, rounded: true };
    return { x: 71, y: 25 + (row - 1) * 16, w: 80, h: 16, rounded: false };
  }

  /**
   * The 1px box pieces the frame and the insert rule are built from: the
   * menu_gfx `cursor` sheet (an OAM box frame on the cart), tile 0 a corner
   * (top row + left column), tile 1 a straight top edge.
   */
  frameTiles(): { image: LcdImage; corner: any; edge: any } | undefined {
    const image = this.image((this.menuGfx || {}).cursor);
    if (!image || image.getHeight() < 16) return undefined;
    const [iw, ih] = image.getDimensions();
    return {
      image,
      corner: G.newQuad(0, 0, 8, 8, iw, ih),
      edge: G.newQuad(0, 8, 8, 8, iw, ih),
    };
  }

  /**
   * One frame piece as an object at pixel (x, y); sx/sy -1 flip it.  Drawn
   * through the box palette, whose colour 3 is the black the Lua's
   * rectangles used.
   */
  drawFramePiece(quad: any, image: LcdImage, x: number, y: number, sx: number, sy: number): void {
    G.draw(image, quad, x + (sx < 0 ? 8 : 0), y + (sy < 0 ? 8 : 0), 0, sx, sy);
  }

  /**
   * Lua: BoxMenu.lua:942
   * NOT FAITHFUL: the cart's frame is OAM built from the PC's own select
   * tiles (PCSelectLZ), which the cook does not carry, and the Gold screen has
   * no lines (a 1px fill becomes whole 8x8 objects).  The same rect is built
   * the cart's way instead -- flipped corner and edge objects -- out of the
   * naming screen's cursor box tiles.  Crystal's rounded corners are square.
   */
  drawSelectionFrame(row: number): void {
    const r = this.selectionFrameRect(row);
    const t = this.frameTiles();
    if (!t) return;
    const right = r.x + r.w - 8;
    const bottom = r.y + r.h - 8;
    G.setColor(1, 1, 1, 1);
    G.push();
    G.objects = true;
    GbcPalette.with(Chrome.DEFAULT_BOX_PALETTE, () => {
      for (let x = r.x + 8; x < right; x += 8) {
        const ex = Math.min(x, right - 8);
        this.drawFramePiece(t.edge, t.image, ex, r.y, 1, 1);
        this.drawFramePiece(t.edge, t.image, ex, bottom, 1, -1);
      }
      this.drawFramePiece(t.corner, t.image, r.x, r.y, 1, 1);
      this.drawFramePiece(t.corner, t.image, right, r.y, -1, 1);
      this.drawFramePiece(t.corner, t.image, r.x, bottom, 1, -1);
      this.drawFramePiece(t.corner, t.image, right, bottom, -1, -1);
    });
    G.pop();
  }

  /** Lua: BoxMenu.lua:964 -- ../pokecrystal/engine/pokemon/bills_pc.asm:68, :117 */
  selectionFrameVisible(): boolean {
    return this.phase == null && this.message == null && !this.cryWait;
  }

  /**
   * Lua: BoxMenu.lua:972 -- BillsPC_UpdateInsertCursor's wedge between rows,
   * drawn as a 2px rule along the top edge of the row the mon goes in front of.
   * NOT FAITHFUL (as the selection frame): the rule is two rows of 1px edge
   * objects rather than a filled rectangle.
   */
  drawInsertCursor(row: number): void {
    const x = 71;
    const y = 31 + (row - 1) * 16;
    const t = this.frameTiles();
    if (!t) return;
    G.setColor(1, 1, 1, 1);
    G.push();
    G.objects = true;
    GbcPalette.with(Chrome.DEFAULT_BOX_PALETTE, () => {
      for (let i = 0; i < 10; i++) {
        this.drawFramePiece(t.edge, t.image, x + i * 8, y, 1, 1);
        this.drawFramePiece(t.edge, t.image, x + i * 8, y + 1, 1, 1);
      }
    });
    G.pop();
  }

  /**
   * Lua: BoxMenu.lua:982 -- while the insert cursor is up the left panel
   * keeps showing the mon in flight.
   */
  panelMon(): any {
    if (this.cryWait) return this.cryWait.mon;
    const from = this.moveFrom;
    if (this.phase === "insert" && from) return this.listAt(from.box)[from.slot - 1];
    return this.selected();
  }

  /** Lua: BoxMenu.lua:992 -- engine/pokemon/bills_pc.asm:962-970, :1791-1793 */
  messageBox(page: string[]): [number, number, number, number] {
    if (page.length <= 1) return [0, 15, 20, 3];
    return [0, 12, 20, 6];
  }

  /** Lua: BoxMenu.lua:997 */
  drawPanel(): void {
    // BillsPC_InitGFX loads FontsBattleExtra for the whole screen
    // (engine/pokemon/bills_pc.asm:2169).
    const wasBattle = Font.useBattleExtra(true);
    Chrome.clear();

    // engine/pokemon/bills_pc.asm:1220-1227
    Chrome.box(8, 2, 12, 12);
    // engine/pokemon/bills_pc.asm:981-983
    Chrome.box(8, 0, 12, 3);
    Chrome.print(this.title(), 10, 1);
    this.drawBoxArrows();

    const list = this.list();
    const inserting = this.phase === "insert";
    const frameUp = this.selectionFrameVisible();
    for (let row = 1; row <= VISIBLE_ROWS; row++) {
      const i = row + this.scroll;
      const ty = LIST_Y + (row - 1) * LIST_SPACING;
      if (i <= list.length) {
        const mon = list[i - 1];
        if (i === this.index) {
          if (inserting) this.drawInsertCursor(row);
          else if (frameUp) this.drawSelectionFrame(row);
        }
        // .PlaceNickname prints the stored nickname verbatim (:1245-1356).
        const label = mon.nickname || mon.name || mon.species || "?";
        Chrome.print(label, LIST_X, ty);
      } else if (inserting) {
        // An empty destination: the cursor is the only thing on the list.
        if (i === this.index) this.drawInsertCursor(row);
      } else if (i === this.total()) {
        if (i === this.index && frameUp) this.drawSelectionFrame(row);
        Chrome.print(Strings.get("CANCEL"), LIST_X, ty);
      }
    }

    // The left panel: pic, level, gender, species -- blank on CANCEL.
    const mon = !this.panelCleared ? this.panelMon() : undefined;
    if (mon) {
      // `cp EGG / ret z` right after the frontpic (:1057-1058).
      if (mon.isEgg) {
        this.drawEggPic(mon);
      } else {
        this.drawPic(mon);
        // PrintLevel always writes the single bold glyph (home/pokemon.asm:178-183).
        Chrome.print("<LV>" + tostring(mon.level || 1), PIC_X, 12);
        if (mon.gender === "male") Chrome.print("♂", 5, 12);
        else if (mon.gender === "female") Chrome.print("♀", 5, 12);
        Chrome.print(mon.name || mon.species || "?", PIC_X, 14);
        this.drawHeldIcon(mon);
      }
    } else {
      this.fillPicBlock(this.panelColors());
    }

    // BillsPC_PlaceString: Textbox at (0,15), string at (1,16); a two-line
    // refusal gets a taller box of its own.
    if (this.message != null) {
      const page = messagePages(this.message)[(this.messagePage || 1) - 1] || [];
      const box = this.messageBox(page);
      Chrome.box(box[0], box[1], box[2], box[3]);
      page.forEach((part, k) => {
        Chrome.print(part, 1, box[1] + 1 + k * 2);
      });
    } else {
      Chrome.box(0, 15, 20, 3);
      Chrome.print(this.prompt(), 1, 16);
    }

    // .MoveMonWOMailSubmenu's .MenuHeader is `menu_coords 9, 4,
    // SCREEN_WIDTH - 1, 13`; MOVE at (11,6), one row per two tiles.
    if (this.phase === "submenu") {
      Chrome.box(9, 4, 11, 10);
      this.submenuRows().forEach((label, k) => {
        const ty = 6 + k * 2;
        if (k + 1 === this.submenuIndex) Chrome.cursor(10, ty);
        Chrome.print(Strings.get(label), 11, ty);
      });
    }
    G.setColor(1, 1, 1, 1);
    Font.useBattleExtra(wasBattle);
  }

  /** Lua: BoxMenu.lua:1094 */
  draw(): void {
    this.drawPanel();
  }

  /**
   * Lua: BoxMenu.lua:1098 -- letterbox / fit scale / origin are no-ops on the
   * Gold screen: drawPanel at the origin.
   */
  drawWidescreen(_winW?: number, _winH?: number): void {
    G.push();
    this.drawPanel();
    G.pop();
  }
}

export default BoxMenu;
