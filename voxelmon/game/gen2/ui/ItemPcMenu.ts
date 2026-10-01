// gen1recomp src/ui/gen2/ItemPcMenu.lua (bdfac727, MIT): the player's item
// PC: _PlayersPC and the three item rows behind it
// (engine/events/pokecenter_pc.asm PlayerWithdrawItemMenu /
// PlayerDepositItemMenu / PlayerTossItemMenu), plus TossItemFromPC
// (engine/pokemon/mon_menu.asm).  Both of the cart's callers land here:
//
//   PlayersPC        PLAYERSPC_NORMAL -- the <PLAYER>'s PC row of the
//                    Pokecenter's whose-PC menu (ui/CenterPcMenu.ts):
//                    WITHDRAW ITEM / DEPOSIT ITEM / TOSS ITEM / MAIL BOX /
//                    LOG OFF
//   _PlayersHousePC  PLAYERSPC_HOUSE -- the bedroom PC's whole screen: the
//                    boot sound and PlayersPCTurnOnText first, DECORATION on
//                    the list, TURN OFF instead of LOG OFF, and the answer
//                    carried back out (TRUE only when a decoration moved)
//
// Items live on save.pcItems, the id -> count map: fifty distinct stacks of
// at most 99, like wPCItems.  DEPOSIT opens the PACK as a chooser held by
// this screen, exactly the arrangement the mart's sell flow uses
// (ui/MartMenu.ts enterSell), because DepositSellPack is the same routine.

import G from "../platform/screen.ts";
import { PcItems } from "../core/PcItems.ts";
import { Bag } from "../shared/inventory/Bag.ts";
import { Logger } from "../shared/core/Logger.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { Chrome } from "./Chrome.ts";
import { Typer, type TyperRecord } from "./Typer.ts";
import { WaitPlaySFX, type PendingSfx } from "./WaitPlaySFX.ts";

export interface ItemPcEntry {
  id?: string;
  label: string;
  builtin?: boolean;
}

export interface ItemPcRow {
  id: string;
  count: number;
  name: string;
  slot: number;
}

interface QtyState {
  qty: number;
  max: number;
  prompt: string[];
  onAccept: (qty: number) => void;
}

interface Confirm {
  prompt: string[];
  choice: number;
  onYes?: () => void;
  onNo?: () => void;
}

export interface ItemPcMenuOpts {
  save?: any;
  items?: any;
  house?: any;
  events?: any;
  onClose?: (changedDecorations: boolean) => void;
}

// Lua: ItemPcMenu.lua:45 -- ../pokecrystal/engine/events/pokecenter_pc.asm:330
const CLEARS_SCREEN: Record<string, boolean> = { withdraw: true, deposit: true, toss: true };

// Lua: ItemPcMenu.lua:49 -- MAX_PC_ITEMS stacks of at most MAX_ITEM_STACK.
const PC_ITEM_CAPACITY = 50;
const MAX_STACK = 99;

/** Lua: ItemPcMenu.lua:52 */
function stacksFor(n?: number): number {
  return Math.ceil((n || 0) / MAX_STACK);
}

// Lua: ItemPcMenu.lua:57 -- PlayersPCMenuData .PlayersPCMenuPointers strings.
const ENTRIES: ItemPcEntry[] = [
  { id: "withdraw", label: Strings.source("WITHDRAW ITEM"), builtin: true },
  { id: "deposit", label: Strings.source("DEPOSIT ITEM"), builtin: true },
  { id: "toss", label: Strings.source("TOSS ITEM"), builtin: true },
  { id: "mailbox", label: Strings.source("MAIL BOX"), builtin: true },
];
const LOG_OFF: ItemPcEntry = { id: "logoff", label: Strings.source("LOG OFF"), builtin: true };
const DECORATION: ItemPcEntry = { id: "decoration", label: Strings.source("DECORATION"), builtin: true };
const TURN_OFF: ItemPcEntry = { id: "turnoff", label: Strings.source("TURN OFF"), builtin: true };

// Lua: ItemPcMenu.lua:76 -- _PlayersPC's player-facing text.
const TEXT = {
  turnedOn: Strings.source("{PLAYER} turned on\nthe PC."),
  noBagRoom: Strings.source("There's no room\nfor more items."),
  withdrew: Strings.source("Withdrew %d\n%s(S)."),
  withdrawHowMany: Strings.source("How many do you\nwant to withdraw?"),
  noPcRoom: Strings.source("There's no room to\nstore items."),
  deposited: Strings.source("Deposited %d\n%s(S)."),
  noItems: Strings.source("No items here!"),
  depositHowMany: Strings.source("How many do you\nwant to deposit?"),
  tooImportant: Strings.source("That's too impor-\ntant to toss out!"),
  tossHowMany: Strings.source("Toss out how many\n%s(S)?"),
  throwAway: Strings.source("Throw away %d\n%s(S)?"),
  discarded: Strings.source("Discarded\n%s(S)."),
  whatDo: Strings.source("What do you want\nto do?"),
};

/** Lua: ItemPcMenu.lua:92 */
function translatedLines(source: string, ...args: unknown[]): string[] {
  return Strings.get(source, ...args).split("\n");
}

/** Lua: ItemPcMenu.lua:100 */
function translatedPages(source: string, ...args: unknown[]): string[][] {
  return [translatedLines(source, ...args)];
}

/** Lua: ItemPcMenu.lua:105 -- ui.pc.items identity. */
function sameItems(_game: any, items: ItemPcEntry[]): ItemPcEntry[] {
  return items;
}

// Lua: ItemPcMenu.lua:108 -- PCItemsJoypad's ScrollingMenu is `db 4, 8`.
const VISIBLE_ROWS = 4;

// Lua: ItemPcMenu.lua:112 -- .PCItemsMenuData is menu_coords 4, 1
// (engine/events/pokecenter_pc.asm:641), plus ScrollingMenu_UpdateDisplay's
// cursor column (engine/menus/scrolling_menu.asm:359).
const LIST_X = 5;

// Lua: ItemPcMenu.lua:115 -- charmap.asm: the quantity glyph.
const TIMES = "×";

/**
 * Lua: ItemPcMenu.lua:309 -- HasNoItems (engine/pokemon/mon_menu.asm): every
 * pocket, TM/HMs included.  Badges share the table but are not bag items.
 */
function bagIsEmpty(save: any): boolean {
  const inv: Record<string, number> = (save && save.inventory) || {};
  for (const id of Object.keys(inv)) {
    if ((inv[id] || 0) > 0 && !Bag.isBadge(id)) return false;
  }
  return true;
}

/**
 * Lua: ItemPcMenu.lua:318 -- BuySellToss_InterpretJoypad
 * (engine/items/buy_sell_toss.asm): up and down wrap through the ends, left
 * and right step by ten and clamp.
 */
function qtyStep(qty: number, max: number, delta: number): number {
  let n = qty + delta;
  if (delta === 1) {
    if (n > max) n = 1;
  } else if (delta === -1) {
    if (n < 1) n = max;
  } else if (delta > 0) {
    if (n > max) n = max;
  } else {
    if (n <= 0) n = 1;
  }
  return n;
}

export class ItemPcMenu {
  // Lua: ItemPcMenu.lua:42 -- ../pokecrystal/engine/events/pokecenter_pc.asm:231
  static isOpaque = false;
  isOpaque = false;
  // Lua: ItemPcMenu.lua:748
  static ENTRIES = ENTRIES;
  static PC_ITEM_CAPACITY = PC_ITEM_CAPACITY;

  game: any;
  save: any;
  items: any;
  data: any;
  onClose?: (changedDecorations: boolean) => void;
  house: boolean;
  events: any;
  changedDecorations: boolean;
  entries: ItemPcEntry[];
  index: number;
  phase = "menu";
  rows: ItemPcRow[];
  listIndex: number;
  scroll: number;
  message: TyperRecord | undefined;
  qtyState: QtyState | undefined;
  confirm: Confirm | undefined;
  repeatSfx?: PendingSfx;
  pack?: any;
  switching?: number;
  [key: string]: any;

  /** Lua: ItemPcMenu.lua:117 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: ItemPcMenu.lua:119 */
  setPhase(phase: string): void {
    this.phase = phase;
    this.isOpaque = CLEARS_SCREEN[phase] || false;
  }

  /**
   * Lua: ItemPcMenu.lua:127 -- opts: save, items (items.lua), house
   * (PLAYERSPC_HOUSE: boot text, DECORATION row, TURN OFF), events
   * (wEventFlags, for the decoration menu), onClose(changedDecorations)
   */
  static new(game: any, opts?: ItemPcMenuOpts): ItemPcMenu {
    return new ItemPcMenu(game, opts ?? {});
  }

  constructor(game: any, opts: ItemPcMenuOpts) {
    this.game = game;
    this.save = opts.save || (game && game.save);
    this.items = opts.items || (game && game.data && game.data.items);
    this.data = game && game.data;
    this.onClose = opts.onClose;
    this.house = opts.house ? true : false;
    this.events = opts.events;
    // wChangedDecorations, carried out so `special PlayersHousePC` can answer
    // TRUE and PlayersHousePCScript can take its `.Warp` arm.
    this.changedDecorations = false;
    if (this.save) this.save.pcItems = this.save.pcItems || {};
    let entries: ItemPcEntry[] = ENTRIES.slice();
    if (this.house) entries.push(DECORATION);
    // Lua: ItemPcMenu.lua:149 -- same hook name and payload as the Gen 1 PC.
    const hooked: unknown = Runtime.call("ui.pc.items", sameItems, game, entries);
    if (Array.isArray(hooked)) {
      entries = hooked as ItemPcEntry[];
    } else {
      Logger.error("ui.pc.items returned %s; keeping the vanilla items", typeof hooked);
    }
    // LOG OFF / TURN OFF is appended AFTER the hook: a mod cannot orphan the
    // way out of the PC.
    entries.push(this.house ? TURN_OFF : LOG_OFF);
    this.entries = entries;
    this.index = 1;
    this.setPhase("menu");
    this.rows = [];
    this.listIndex = 1;
    this.scroll = 0;
    this.message = undefined;
    this.qtyState = undefined;
    this.confirm = undefined;
    if (this.house) {
      // _PlayersHousePC: PC_PlayBootSound, then PlayersPCTurnOnText.
      this.playPcSfx("Sfx_BootPc");
      this.say(translatedPages(TEXT.turnedOn));
    }
  }

  /** Lua: ItemPcMenu.lua:176 */
  playSfx(name: string): void {
    const data = this.data;
    const sfx = data && data.audio && data.audio.sfx;
    if (sfx && sfx[Sound.resolve(data, name)]) Sound.play(data, name);
  }

  /** Lua: ItemPcMenu.lua:185 -- engine/events/pokecenter_pc.asm:200 */
  playPcSfx(name: string): void {
    Sound.waitSfxDone();
    this.playSfx(name);
  }

  /** Lua: ItemPcMenu.lua:191 -- engine/events/pokecenter_pc.asm:195 */
  playPcSfxTwice(name: string): void {
    this.playPcSfx(name);
    this.repeatSfx = WaitPlaySFX.arm(name);
  }

  /** Lua: ItemPcMenu.lua:196 */
  tickRepeatSfx(): boolean {
    const pending = this.repeatSfx;
    if (!pending) return false;
    if (WaitPlaySFX.waiting(pending)) return true;
    this.repeatSfx = undefined;
    this.playPcSfx(pending.name);
    return false;
  }

  /** Lua: ItemPcMenu.lua:205 */
  playerName(): string {
    const player = this.save && this.save.player;
    return (player && player.name) || "GOLD";
  }

  /**
   * Lua: ItemPcMenu.lua:213 -- a queue of text pages; A or B turns them, and
   * the last one runs onDone.  A refusal drops back into the same menu.
   */
  say(pages: string[][], onDone?: () => void): void {
    Typer.say(this, pages, onDone, {
      expand: (line: string) => line.split("{PLAYER}").join(this.playerName()),
    });
  }

  /** Lua: ItemPcMenu.lua:219 */
  close(): void {
    // _PlayersHousePC plays PC_PlayShutdownSound only on the unchanged arm.
    if (this.house && !this.changedDecorations) this.playPcSfx("Sfx_ShutDownPc");
    if (this.onClose) this.onClose(this.changedDecorations);
  }

  // ---------------------------------------------------------------- the items

  /** Lua: ItemPcMenu.lua:230 */
  def(id: string): any {
    return this.items && this.items[id];
  }

  /**
   * Lua: ItemPcMenu.lua:237 -- _CheckTossableItem: KEY ITEMs and HMs answer
   * non-zero, carried as `canToss = false`.
   */
  cantToss(id: string): boolean {
    const def = this.def(id);
    return def != null && def.canToss === false;
  }

  /** Lua: ItemPcMenu.lua:243 -- engine/events/pokecenter_pc.asm:647 */
  rebuild(): void {
    const pc: Record<string, number> = (this.save && this.save.pcItems) || {};
    const order: string[] = (this.save && PcItems.order(this.save, this.items)) || [];
    const rows: ItemPcRow[] = [];
    for (let slot = 1; slot <= order.length; slot++) {
      const id = order[slot - 1]!;
      const count = pc[id] || 0;
      if (count > 0) {
        const def = this.def(id);
        let remaining = count;
        while (remaining > 0) {
          const n = Math.min(remaining, MAX_STACK);
          rows.push({ id, count: n, name: (def && def.name) || id, slot });
          remaining = remaining - n;
        }
      }
    }
    this.rows = rows;
    if (this.listIndex > rows.length + 1) this.listIndex = rows.length + 1;
    if (this.listIndex < 1) this.listIndex = 1;
    this.ensureVisible();
  }

  /** Lua: ItemPcMenu.lua:270 */
  listTotal(): number {
    return this.rows.length + 1; // CANCEL
  }

  /** Lua: ItemPcMenu.lua:274 */
  ensureVisible(): void {
    if (this.listIndex <= this.scroll) {
      this.scroll = this.listIndex - 1;
    } else if (this.listIndex > this.scroll + VISIBLE_ROWS) {
      this.scroll = this.listIndex - VISIBLE_ROWS;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.listTotal() - VISIBLE_ROWS)));
  }

  /**
   * Lua: ItemPcMenu.lua:289 -- ReceiveItem over wPCItems: tops up the
   * existing stacks and spills into a new one, so it only needs a free stack
   * when the room in place is short.  engine/items/items.asm:156 PutItemInPocket
   */
  pcAdd(id: string, qty: number): boolean {
    const pc: Record<string, number> = this.save.pcItems;
    const held = pc[id] || 0;
    let used = 0;
    for (const k of Object.keys(pc)) used = used + stacksFor(pc[k]);
    const need = stacksFor(held + qty) - stacksFor(held);
    if (used + need > PC_ITEM_CAPACITY) return false;
    pc[id] = held + qty;
    return true;
  }

  /** Lua: ItemPcMenu.lua:300 */
  pcRemove(id: string, qty: number): void {
    const pc: Record<string, number> = this.save.pcItems;
    const held = (pc[id] || 0) - qty;
    if (held > 0) pc[id] = held;
    else delete pc[id];
  }

  /** Lua: ItemPcMenu.lua:333 -- prompt is the two lines under the selector. */
  askQuantity(max: number, prompt: string[], onAccept: (qty: number) => void): void {
    this.qtyState = { qty: 1, max, prompt, onAccept };
  }

  // ------------------------------------------------------------ the three rows

  /** Lua: ItemPcMenu.lua:339 */
  withdraw(row: ItemPcRow, qty: number): void {
    // PlayerWithdrawItemMenu .withdraw: ReceiveItem into the bag first; only
    // a carry tosses the stack out of the PC.
    if (!Bag.add(this.save, row.id, qty, this.data)) {
      this.say(translatedPages(TEXT.noBagRoom));
      return;
    }
    this.pcRemove(row.id, qty);
    this.rebuild();
    this.say(translatedPages(TEXT.withdrew, qty, row.name));
  }

  /** Lua: ItemPcMenu.lua:351 */
  chooseWithdraw(): void {
    const row = this.rows[this.listIndex - 1];
    if (!row) {
      this.setPhase("menu");
      return;
    }
    // .Submenu: an item without a quantity attribute is always x1.
    if (this.cantToss(row.id)) {
      this.withdraw(row, 1);
      return;
    }
    this.askQuantity(row.count, translatedLines(TEXT.withdrawHowMany), (qty) => this.withdraw(row, qty));
  }

  /** Lua: ItemPcMenu.lua:368 */
  deposit(id: string, name: string, qty: number): void {
    if (!this.pcAdd(id, qty)) {
      this.say(translatedPages(TEXT.noPcRoom));
      return;
    }
    Bag.remove(this.save, id, qty);
    if (this.pack) this.pack.rebuild();
    this.say(translatedPages(TEXT.deposited, qty, name));
  }

  /** Lua: ItemPcMenu.lua:378 */
  enterDeposit(): void {
    // .CheckItemsInBag: an empty bag never opens the PACK.
    if (bagIsEmpty(this.save)) {
      this.say(translatedPages(TEXT.noItems));
      return;
    }
    this.setPhase("deposit");
    // DepositSellPack: the PACK as a chooser, held and drawn by this screen.
    // `world = {}` keeps field items inert.
    this.pack = Screens.build(this.game, "Gen2PackMenu", {
      save: this.save,
      items: this.items,
      world: {},
      onChoose: (id: string, count: number) => this.offerToDeposit(id, count),
      onClose: () => this.leaveDeposit(),
    });
  }

  /** Lua: ItemPcMenu.lua:396 */
  leaveDeposit(): void {
    this.pack = undefined;
    this.setPhase("menu");
  }

  /** Lua: ItemPcMenu.lua:401 */
  offerToDeposit(id: string, count: number): void {
    if ((count || 0) < 1) return;
    const def = this.def(id);
    const name = (def && def.name) || id;
    // .DepositItem (engine/events/pokecenter_pc.asm:504): an item with no
    // quantity is always x1 and never reaches .AskQuantity.
    if (this.cantToss(id)) {
      this.deposit(id, name, 1);
      return;
    }
    this.askQuantity(count, translatedLines(TEXT.depositHowMany), (qty) => this.deposit(id, name, qty));
  }

  /** Lua: ItemPcMenu.lua:416 */
  chooseToss(): void {
    const row = this.rows[this.listIndex - 1];
    if (!row) {
      this.setPhase("menu");
      return;
    }
    // TossItemFromPC .key_item -> .CantToss.
    if (this.cantToss(row.id)) {
      this.say(translatedPages(TEXT.tooImportant));
      return;
    }
    this.askQuantity(row.count, translatedLines(TEXT.tossHowMany, row.name), (qty) => {
      // .ItemsThrowAwayText's yes/no sits between the count and the toss.
      this.confirm = {
        prompt: translatedLines(TEXT.throwAway, qty, row.name),
        choice: 1,
        onYes: () => {
          this.pcRemove(row.id, qty);
          this.rebuild();
          this.say(translatedPages(TEXT.discarded, row.name));
        },
      };
    });
  }

  // ------------------------------------------------------------------ the menu

  /** Lua: ItemPcMenu.lua:445 */
  choose(): void {
    const entry = this.entries[this.index - 1];
    if (!entry) return;
    const game = this.game;
    if (entry.id === "withdraw" || entry.id === "toss") {
      this.setPhase(entry.id);
      this.listIndex = 1;
      this.scroll = 0;
      // engine/events/pokecenter_pc.asm:569
      this.switching = undefined;
      this.rebuild();
      return;
    }
    if (entry.id === "deposit") {
      this.enterDeposit();
      return;
    }
    if (entry.id === "mailbox") {
      if (!(game && game.stack)) return;
      Screens.push(game, "Gen2MailboxMenu", {
        save: this.save,
        onClose: () => game.stack.pop(),
      });
      return;
    }
    if (entry.id === "decoration") {
      if (!(game && game.stack)) return;
      Screens.push(game, "Gen2DecorationMenu", {
        save: this.save,
        events: this.events,
        onDone: (changed: any) => {
          this.changedDecorations = this.changedDecorations || changed || false;
          game.stack.pop();
        },
      });
      return;
    }
    // logoff / turnoff: PlayerLogOffMenu serves both rows.
    this.close();
  }

  /**
   * Lua: ItemPcMenu.lua:489 -- engine/events/pokecenter_pc.asm:622,
   * engine/items/switch_items.asm:27
   */
  armSwitch(): void {
    if (!this.rows[this.listIndex - 1]) return;
    this.switching = this.listIndex;
  }

  /** Lua: ItemPcMenu.lua:495 -- engine/events/pokecenter_pc.asm:604 */
  updateSwitch(input: any): void {
    if (input.wasPressed("up")) {
      this.listIndex = this.listIndex > 1 ? this.listIndex - 1 : this.listTotal();
      this.ensureVisible();
    } else if (input.wasPressed("down")) {
      this.listIndex = this.listIndex < this.listTotal() ? this.listIndex + 1 : 1;
      this.ensureVisible();
    } else if (input.wasPressed("a") || input.wasPressed("select")) {
      this.placeSwitch();
    } else if (input.wasPressed("b")) {
      // engine/events/pokecenter_pc.asm:615
      this.switching = undefined;
    }
  }

  /**
   * Lua: ItemPcMenu.lua:514 -- engine/events/pokecenter_pc.asm:620,
   * engine/items/switch_items.asm:12
   */
  placeSwitch(): void {
    const held = this.switching != null ? this.rows[this.switching - 1] : undefined;
    const target = this.rows[this.listIndex - 1];
    this.playPcSfxTwice("Sfx_SwitchPokemon");
    if (!target) return;
    if (held && this.save && target.slot !== held.slot) {
      PcItems.move(this.save, held.id, target.slot, this.items);
      this.rebuild();
    }
    this.switching = undefined;
  }

  // ------------------------------------------------------------------- update

  /** Lua: ItemPcMenu.lua:528 */
  update(_dt?: number): void {
    const input = this.game && this.game.input;
    if (!input) return;

    // engine/events/pokecenter_pc.asm:195
    if (this.tickRepeatSfx()) return;

    if (this.message) {
      Typer.step(this);
      if (Typer.typing(this)) return;
      if (input.wasPressed("a") || input.wasPressed("b")) {
        const m = this.message;
        if (m.page < m.pages.length) {
          Typer.turn(this, m);
          return;
        }
        this.message = undefined;
        if (m.onDone) m.onDone();
      }
      return;
    }

    if (this.qtyState) {
      const q = this.qtyState;
      if (input.wasPressed("up")) {
        q.qty = qtyStep(q.qty, q.max, 1);
      } else if (input.wasPressed("down")) {
        q.qty = qtyStep(q.qty, q.max, -1);
      } else if (input.wasPressed("right")) {
        q.qty = qtyStep(q.qty, q.max, 10);
      } else if (input.wasPressed("left")) {
        q.qty = qtyStep(q.qty, q.max, -10);
      } else if (input.wasPressed("b")) {
        this.qtyState = undefined;
      } else if (input.wasPressed("a")) {
        this.qtyState = undefined;
        q.onAccept(q.qty);
      }
      return;
    }

    if (this.confirm) {
      const c = this.confirm;
      if (input.wasPressed("up") || input.wasPressed("down")) {
        c.choice = c.choice === 1 ? 2 : 1;
      } else if (input.wasPressed("b")) {
        // home/menu.asm:345
        this.playSfx("Sfx_ReadText2");
        this.confirm = undefined;
        if (c.onNo) c.onNo();
      } else if (input.wasPressed("a")) {
        this.playSfx("Sfx_ReadText2");
        this.confirm = undefined;
        if (c.choice === 1) {
          if (c.onYes) c.onYes();
        } else if (c.onNo) {
          c.onNo();
        }
      }
      return;
    }

    if (this.phase === "deposit") {
      if (this.pack) this.pack.update(_dt);
      else this.setPhase("menu");
      return;
    }

    if (this.phase === "withdraw" || this.phase === "toss") {
      if (this.switching) {
        this.updateSwitch(input);
        return;
      }
      if (input.wasPressed("up")) {
        this.listIndex = this.listIndex > 1 ? this.listIndex - 1 : this.listTotal();
        this.ensureVisible();
      } else if (input.wasPressed("down")) {
        this.listIndex = this.listIndex < this.listTotal() ? this.listIndex + 1 : 1;
        this.ensureVisible();
      } else if (input.wasPressed("b")) {
        // engine/menus/scrolling_menu.asm:24
        this.playSfx("Sfx_ReadText2");
        this.setPhase("menu");
        this.switching = undefined;
      } else if (input.wasPressed("a")) {
        this.playSfx("Sfx_ReadText2");
        if (this.phase === "withdraw") this.chooseWithdraw();
        else this.chooseToss();
      } else if (input.wasPressed("select")) {
        this.armSwitch();
      }
      return;
    }

    if (input.wasPressed("up")) {
      this.index = this.index > 1 ? this.index - 1 : this.entries.length;
    } else if (input.wasPressed("down")) {
      this.index = this.index < this.entries.length ? this.index + 1 : 1;
    } else if (input.wasPressed("a")) {
      // home/menu.asm:476
      this.playSfx("Sfx_ReadText2");
      this.choose();
    } else if (input.wasPressed("b")) {
      // DoNthMenu's carry is `.turn_off`.
      this.playSfx("Sfx_ReadText2");
      this.close();
    }
  }

  // --------------------------------------------------------------------- draw

  /** Lua: ItemPcMenu.lua:647 */
  drawBottomLines(lines: string[] | undefined): void {
    Chrome.box(0, 12, 20, 6);
    if (!lines) return;
    const name = this.playerName();
    const startY = lines.length >= 3 ? 13 : 14;
    lines.forEach((line, k) => {
      Chrome.print(line.split("{PLAYER}").join(name), 1, startY + k * 2);
    });
  }

  /** Lua: ItemPcMenu.lua:657 */
  drawList(): void {
    Chrome.box(0, 0, 20, 12);
    // engine/events/pokecenter_pc.asm:628 .a_1 -> home/menu.asm:50
    // engine/events/pokecenter_pc.asm:605 .moving_stuff_around
    const picked = !this.switching && (this.message || this.qtyState || this.confirm) ? true : false;
    for (let row = 1; row <= VISIBLE_ROWS; row++) {
      const i = row + this.scroll;
      const ty = row * 2;
      if (i <= this.rows.length) {
        const entry = this.rows[i - 1]!;
        // home/menu.asm:50
        if (i === this.listIndex) {
          Chrome.cursor(LIST_X - 1, ty, picked);
        } else if (i === this.switching) {
          Chrome.cursor(LIST_X - 1, ty, true);
        }
        Chrome.print(entry.name, LIST_X, ty);
        // PlaceMenuItemQuantity (engine/menus/menu_2.asm:18, :24)
        if (!this.cantToss(entry.id)) {
          Chrome.print(TIMES + Chrome.number(entry.count, 2), LIST_X + 9, ty + 1);
        }
      } else if (i === this.listTotal()) {
        if (i === this.listIndex) Chrome.cursor(LIST_X - 1, ty, picked);
        Chrome.print(Strings.get("CANCEL"), LIST_X, ty);
      }
    }
    // UpdateItemDescription under the list.
    const row = this.rows[this.listIndex - 1];
    const def = row && this.def(row.id);
    const description: string | undefined = def && def.description;
    if (description != null) {
      let m = /^([\s\S]*?)<NEXT>([\s\S]*)$/.exec(description);
      if (!m) m = /^([\s\S]*?)\n([\s\S]*)$/.exec(description);
      const first = m ? m[1] : undefined;
      const second = m ? m[2] : undefined;
      Chrome.box(0, 12, 20, 6);
      Chrome.print(first ?? description, 1, 14);
      if (second != null) Chrome.print(second, 1, 16);
    } else {
      Chrome.box(0, 12, 20, 6);
    }
  }

  /** Lua: ItemPcMenu.lua:699 */
  drawPanel(): void {
    // ../pokecrystal/engine/pokemon/bills_pc_top.asm:231
    if (this.isOpaque) Chrome.clear();

    if (this.phase === "deposit" && this.pack) {
      this.pack.drawPanel();
    } else if (this.phase === "withdraw" || this.phase === "toss") {
      this.drawList();
    } else {
      // _PlayersPCAskWhatDoText, printed under the list the whole time.  The
      // box goes down first: the menu window overlays it.
      this.drawBottomLines(translatedLines(TEXT.whatDo));
      // PlayersPCMenuData is menu_coords 0, 0, 15, 12; the house list is one
      // row taller than that box, so size it to the entries.
      Chrome.box(0, 0, 16, Math.max(12, this.entries.length * 2 + 2));
      this.entries.forEach((entry, k) => {
        const i = k + 1;
        const ty = i * 2;
        if (i === this.index) Chrome.cursor(1, ty);
        Chrome.print(entry.builtin ? Strings.get(entry.label) : entry.label, 2, ty);
      });
    }

    if (this.qtyState) {
      const q = this.qtyState;
      this.drawBottomLines(q.prompt);
      // engine/items/buy_sell_toss.asm:205 TossItem_MenuHeader, :133
      Chrome.box(15, 9, 5, 3);
      Chrome.print(TIMES, 16, 10);
      Chrome.print(Chrome.number(q.qty, 2, true), 17, 10);
    } else if (this.confirm) {
      this.drawBottomLines(this.confirm.prompt);
      Chrome.box(14, 7, 6, 5);
      Chrome.print(Strings.get("YES"), 16, 8);
      Chrome.print(Strings.get("NO"), 16, 10);
      Chrome.cursor(15, this.confirm.choice === 1 ? 8 : 10);
    } else if (this.message) {
      const page = this.message.pages[this.message.page - 1];
      const fallback = typeof page === "string" ? page.split("\n") : page;
      this.drawBottomLines(Typer.text(this, fallback));
    }

    G.setColor(1, 1, 1, 1);
  }

  /** Lua: ItemPcMenu.lua:743 */
  draw(): void {
    this.drawPanel();
  }
}

export default ItemPcMenu;
