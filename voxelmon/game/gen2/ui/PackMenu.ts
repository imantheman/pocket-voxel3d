// gen1recomp src/ui/gen2/PackMenu.lua (bdfac727, MIT): Gen 2 PACK -- four
// pockets instead of Gen 1's one bag.
//
// constants/item_data_constants.asm orders them ITEM, KEY_ITEM, BALL, TM_HM,
// and each item's own ItemAttributes row says which pocket it lives in -- so
// the flat id->count inventory the engine already keeps is bucketed here at
// draw time rather than stored four ways.
//
// Left/right switch pockets, up/down scroll the list, A selects, B closes.
// A TM/HM row shows the move it teaches (attributes carry `teaches`), which is
// the whole reason the TM pocket is readable at all -- the item names are just
// "TM01".."HM07".

import { Mon } from "../battle/Mon.ts";
import { CommonText } from "../core/CommonText.ts";
import { Happiness } from "../core/Happiness.ts";
import { Save as Gen2Save } from "../core/Save.ts";
import { format, tostring, tonumber } from "../platform/lua.ts";
import G, { cachedBlock, keyOf } from "../platform/screen.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Bag } from "../shared/inventory/Bag.ts";
import { MenuRepeat, type RepeatState } from "../shared/ui/MenuRepeat.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { Chrome } from "./Chrome.ts";
import { PackGfx } from "./PackGfx.ts";
import { WaitPlaySFX } from "./WaitPlaySFX.ts";

// constants/sfx_constants.asm:3, :28
const SFX_DEX_FANFARE_50_79 = 0;
const SFX_WRONG = 25;

const LIST_DIRS = ["up", "down"];

// ItemsPocketMenuHeader (engine/items/pack.asm): menu_coords 7, 1, 19, 11 --
// so the list body starts one row and one column inside that box, five rows of
// two, with the quantity on each entry's second line.
const LIST_X = 8;
const LIST_Y = 2;
const LIST_SPACING = 2;

export interface Pocket {
  id: string;
  label: string;
}

// Display order and titles.  The cart shows the pocket name in a tab strip
// across the top; these are the strings it uses.
const POCKETS: Pocket[] = [
  { id: "ITEM", label: Strings.source("ITEMS") },
  { id: "BALL", label: Strings.source("POKé BALLS") },
  { id: "KEY_ITEM", label: Strings.source("KEY ITEMS") },
  { id: "TM_HM", label: Strings.source("TM/HM") },
];

// Five item rows fit under the tab strip, two lines each.
const VISIBLE_ROWS = 5;

// The item submenu (.ItemBallsKey_LoadSubmenu, engine/items/pack.asm:243).
// A on a row does NOT use the item on the cart: it opens a menu whose rows are
// picked from the item's own ITEMATTR_PERMISSIONS bits and its field-menu
// nibble, and the six headers between MenuHeader_UsableKeyItem and
// MenuHeader_HoldableItem are every combination of them:
//
//   CAN toss + CAN select + usable      USE / GIVE / TOSS / SEL / QUIT
//   CAN toss + CAN select + NOUSE             GIVE / TOSS / SEL / QUIT
//   CAN toss + cant select + usable     USE / GIVE / TOSS / QUIT
//   CAN toss + cant select + NOUSE            GIVE / TOSS / QUIT
//   cant toss + cant select             USE / QUIT
//   cant toss + CAN select              USE / SEL / QUIT
//
// (the labels read backwards against the header names -- _CheckTossableItem
// and CheckSelectableItem both answer NON-zero for the item that CANNOT, so
// pack.asm's `.tossable` arm is the untossable one.)  The TM/HM pocket has a
// pair of its own, .MenuHeader1 / .MenuHeader2 at pack.asm:160.
//
// Without this menu a TOSS is unreachable and the PACK is a one-verb screen,
// which is what "the pack only offers USE" is.
const SUBMENU_LABEL: Record<string, string> = {
  use: Strings.source("USE"),
  give: Strings.source("GIVE"),
  toss: Strings.source("TOSS"),
  sel: Strings.source("SEL"),
  quit: Strings.source("QUIT"),
};

// _AskThrowAwayText / _AskQuantityThrowAwayText / _ThrewAwayText
// (data/text/common_2.asm), the three lines TossMenu prints in order.
const TOSS_HOW_MANY = Strings.source("Throw away how\nmany?");

// _AskItemMoveText (data/text/common_2.asm:322), printed while wSwitchItem
// holds a row and the cursor is looking for its new home.
const ASK_ITEM_MOVE = Strings.source("Where should this\nbe moved to?");

// _YouDontHaveAMonText and .AnEggCantHoldAnItemText, GiveItem's two refusals.
const NO_POKEMON = Strings.source("You don't have a\n#MON!");
const EGG_CANT_HOLD = Strings.source("An EGG can't hold\nan item.");

/**
 * Lua: PackMenu.lua:93 -- _CGB_PackPals' .KrisPackPals arm, and the
 * BATTLETYPE_TUTORIAL test above it that forces the DUDE's
 * (../pokecrystal/engine/gfx/cgb_layouts.asm:770-786).
 */
function packGfxFor(menuGfx: any, save: any, tutorial: unknown): any {
  const pack = menuGfx ? menuGfx.pack : undefined;
  if (!(pack && pack.palettesFemale)) return menuGfx;
  if (tutorial || !Gen2Save.isFemale(save)) return menuGfx;
  const female: any = { ...pack };
  female.palettes = pack.palettesFemale;
  const out: any = { ...menuGfx };
  out.pack = female;
  return out;
}

export interface PackCursorStore {
  cursor: Record<string, number>;
  scroll: Record<string, number>;
  pocket?: string;
}

/**
 * Lua: PackMenu.lua:115 -- the PACK's cursor bytes.  Every pocket menu
 * restores its own cursor and scroll before ScrollingMenu and writes them back
 * after -- `ld a, [wItemsPocketCursor] / ld [wMenuCursorPosition], a` ... `ld
 * a, [wMenuCursorY] / ld [wItemsPocketCursor], a` (engine/items/pack.asm:76),
 * and the same pair for wKeyItemsPocketCursor, wBallsPocketCursor and
 * wTMHMPocketCursor -- while InitPackBuffers opens the PACK on wLastPocket,
 * which Pack's own exit path stored.  They are WRAM, not save data: they last
 * for the session and must not survive a reload, and CleanUpBattleRAM is the
 * only thing that clears them (engine/battle/core.asm:7994, which pointedly
 * leaves the TM/HM pair in place).
 */
function cursorStore(game: any): PackCursorStore | undefined {
  if (!game) return undefined;
  let mem = game.packCursor as PackCursorStore | undefined;
  if (!mem) {
    mem = { cursor: {}, scroll: {} };
    game.packCursor = mem;
  }
  return mem;
}

// home/text.asm:424
const PAGE = "\f";
const SCROLL = "\v";
const LINE = "\n";

type Message = string | string[];

/** Lua: PackMenu.lua:128 */
function messageTokens(text: Message): Message {
  if (typeof text !== "string") return text;
  const out: string[] = [];
  let start = 0;
  while (start <= text.length) {
    const rest = text.slice(start);
    const found = rest.search(/[\n\f\v]/);
    const marker = found >= 0 ? start + found : -1;
    out.push(text.slice(start, marker >= 0 ? marker : text.length));
    if (marker < 0) break;
    const code = text[marker];
    if (code === PAGE) out.push(PAGE);
    else if (code === SCROLL) out.push(SCROLL);
    start = marker + 1;
  }
  return out;
}

/** Lua: PackMenu.lua:144 -- home/text.asm:397 */
function messagePages(lines: Message | undefined): string[][] {
  if (typeof lines === "string") return (CommonText.pages(lines) as string[][] | undefined) ?? [];
  const pages: string[][] = [];
  let rows: string[] = [];
  const flush = (scroll: boolean): void => {
    if (rows.length > 0) pages.push(rows);
    rows = scroll ? [rows[rows.length - 1] ?? ""] : [];
  };
  for (const line of lines ?? []) {
    if (line === PAGE) flush(false);
    else if (line === SCROLL) flush(true);
    else rows.push(line);
  }
  flush(false);
  return pages;
}

// data/text/common_2.asm:627
const OAK_THIS_ISNT_THE_TIME = Strings.source("OAK: {PLAYER}!\nThis isn't the\vtime to use that!");

// RepelUsedEarlierIsStillInEffectText (data/text/common_3.asm): static, and
// names REPEL no matter which of the three repel items is the one actually
// still ticking down -- the cart never reads the active item back out to
// print it.
// ../pokecrystal/data/text/common_3.asm:1270 -- `cont` again, so two pages.
const REPEL_STILL_ACTIVE = Strings.source("The REPEL used\nearlier is still\vin effect.");

export interface PackRow {
  id: string;
  count: number;
  name: string;
  teaches: string | undefined;
  tmNumber: unknown;
  tmhmLabel: string | undefined;
  showCount: boolean;
}

interface Submenu {
  row: PackRow;
  rows: string[];
  index: number;
}

interface QtyState {
  row: PackRow;
  qty: number;
  max: number;
}

interface Confirm {
  prompt: Message;
  choice: number;
  onYes?: () => void;
  onNo?: () => void;
}

export interface PackMenuOpts {
  save?: any;
  items?: Record<string, any>;
  onChoose?: (itemId: string, count: number) => void;
  onClose?: () => void;
  pocket?: string;
  world?: any;
  give?: boolean;
  battle?: boolean;
  tutorial?: boolean;
}

/**
 * Lua: PackMenu.lua:641 -- BuySellToss_InterpretJoypad
 * (engine/items/buy_sell_toss.asm): up and down wrap through the ends, left
 * and right step by ten and clamp.  The same stepper src/ui/gen2/ItemPcMenu.lua
 * uses, because it is the same loop.
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

/**
 * Lua: PackMenu.lua:283 -- engine/items/tmhm.asm:357-375 -- the number a
 * TM/HM row prints: a TM with PRINTNUM_LEADINGZEROS, an HM as 'H' and its own
 * left-aligned ordinal.
 */
function tmhmLabelFor(itemId: string, def: any): string | undefined {
  const m = /(\d+)/.exec(tostring((def && def.tmLabel) || (def && def.name) || itemId));
  const n = m ? tonumber(m[1]) : undefined;
  if (n === undefined) return undefined;
  if (tostring(itemId).slice(0, 3) === "HM_") return "H" + n;
  return format("%02d", n);
}

export class PackMenu {
  static isOpaque = true;
  static POCKETS = POCKETS;
  isOpaque = true;

  game: any;
  save: any;
  items: Record<string, any> | undefined;
  bagData: { items: Record<string, any> | undefined };
  world: any;
  onChoose?: (itemId: string, count: number) => void;
  onClose?: () => void;
  give: boolean;
  battle: boolean;
  tutorial: boolean;
  cursorStore: PackCursorStore | undefined;
  hold: RepeatState;
  pocketIndex: number;
  index = 1;
  scroll = 0;
  gfx: PackGfx;
  rows: PackRow[] = [];
  repeatSfx: any;
  message: Message | undefined;
  messagePage: number | undefined;
  pagesSource: Message | undefined;
  pages: string[][] = [];
  staleRows: boolean | undefined;
  submenu: Submenu | undefined;
  qtyState: QtyState | undefined;
  confirm: Confirm | undefined;
  switching: number | undefined;
  screenId?: string;

  /** Lua: PackMenu.lua:172 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: PackMenu.lua:173 */
  drawsWidescreen(): boolean {
    return true;
  }

  /**
   * Lua: PackMenu.lua:182 -- opts: save, items (items.lua), onChoose(itemId,
   * count), onClose(), pocket (starting pocket id), world (the overworld a
   * field item acts on; defaults to game.world, which is where Game2 keeps it),
   * give (DepositSellPack: the PACK is a CHOOSER, so selecting a row hands the
   * id back instead of running the item's field effect), battle (BattlePack
   * rather than the field Pack: a different jumptable, which dispatches on the
   * item's BATTLE menu nibble and never runs a field effect)
   */
  constructor(game: any, opts?: PackMenuOpts) {
    opts = opts ?? {};
    this.game = game;
    this.save = opts.save ?? (game ? game.save : undefined);
    this.items = opts.items ?? (game && game.data ? game.data.items : undefined);
    // Bag.order / Bag.move read `.items` off an injectable data table, and the
    // one this screen draws from is not always the Data singleton.
    this.bagData = { items: this.items };
    this.world = opts.world ?? (game ? game.world : undefined);
    this.onChoose = opts.onChoose;
    this.onClose = opts.onClose;
    // DepositSellPack rather than the PACK's own UseItem: a chooser must not run
    // a rod or the ITEMFINDER on the way past (src/ui/gen2/HeldItemMenu.lua).
    this.give = !!opts.give;
    this.battle = !!opts.battle;
    // engine/items/pack.asm:1068 TutorialPack
    this.tutorial = !!opts.tutorial;
    this.cursorStore = cursorStore(game);
    // engine/menus/scrolling_menu.asm:6
    this.hold = MenuRepeat.new(MenuRepeat.GEN2_DELAY, MenuRepeat.GEN2_RATE);
    this.pocketIndex = 1;
    // wLastPocket, unless the caller names one: DepositSellInitPackBuffers writes
    // ITEM_POCKET over it, so an explicit pocket still wins.
    const startPocket = opts.pocket ?? (this.cursorStore ? this.cursorStore.pocket : undefined);
    if (startPocket) {
      for (let i = 0; i < POCKETS.length; i++) {
        if (POCKETS[i]!.id === startPocket) {
          this.pocketIndex = i + 1;
          break;
        }
      }
    }
    this.restoreCursor();
    // The cart's own PACK tiles, when the cache has them.
    this.gfx = PackGfx.new(packGfxFor(game && game.data ? game.data.gen2MenuGfx : undefined, this.save, opts.tutorial));
    this.rebuild();
  }

  static new(game: any, opts?: PackMenuOpts): PackMenu {
    return new PackMenu(game, opts);
  }

  /** Lua: PackMenu.lua:221 */
  pocket(): Pocket {
    return POCKETS[this.pocketIndex - 1]!;
  }

  /**
   * Lua: PackMenu.lua:228 -- the pair of loads each pocket menu runs before
   * ScrollingMenu.  rebuild() clamps the row afterwards, so a pocket that
   * shrank while the PACK was closed lands on its last entry rather than past
   * it.
   */
  restoreCursor(): void {
    const mem = this.cursorStore;
    const pocketId = this.pocket().id;
    this.index = (mem && mem.cursor[pocketId]) || 1;
    this.scroll = (mem && mem.scroll[pocketId]) ?? 0;
  }

  /**
   * Lua: PackMenu.lua:237 -- and the pair of stores after it, plus Pack's
   * `.done` writing wCurPocket into wLastPocket.
   */
  storeCursor(): void {
    const mem = this.cursorStore;
    if (!mem) return;
    const pocketId = this.pocket().id;
    mem.cursor[pocketId] = this.index;
    mem.scroll[pocketId] = this.scroll;
    mem.pocket = pocketId;
  }

  /**
   * Lua: PackMenu.lua:249 -- which pocket an item belongs to.  Items imported
   * before attributes existed have no `pocket`; treat those as general items
   * rather than dropping them, so an older cache still shows a full bag.
   */
  pocketOf(itemId: string): string {
    const def = this.items ? this.items[itemId] : undefined;
    return (def && def.pocket) || "ITEM";
  }

  /** Lua: PackMenu.lua:255 -- engine/items/tmhm.asm:341 */
  tmhmKey(itemId: string): number {
    const def = this.items ? this.items[itemId] : undefined;
    const n = def ? tonumber(def.tmNumber) : undefined;
    if (n !== undefined) return n;
    return 1000 + ((def ? tonumber(def.index) : undefined) ?? 0);
  }

  /**
   * Lua: PackMenu.lua:266 -- the name on the row.  An inventory key with no
   * ItemAttributes row behind it (an older cache, a mod's own item, a driver
   * seeding an id that is not in items.lua) still has to draw something a
   * person can read, so the id stands in for the name with its underscores
   * opened out.
   */
  static label(itemId: string, def: any): string {
    if (def && def.name) return def.name;
    return tostring(itemId).replace(/_/g, " ");
  }

  /**
   * Lua: PackMenu.lua:274 -- TMHM_DisplayPocketItems
   * (engine/items/tmhm.asm:381-385) places GetMoveName's string three tiles
   * right of the row's number, so a TM/HM row reads as the MOVE's name and the
   * TM's own item name is never printed.
   */
  moveLabel(moveId: string | undefined): string | undefined {
    if (!moveId) return undefined;
    const moves = this.game && this.game.data ? this.game.data.moves : undefined;
    const def = moves ? moves[moveId] : undefined;
    return (def && def.name) || tostring(moveId).replace(/_/g, " ");
  }

  /** Lua: PackMenu.lua:292 */
  rebuild(): void {
    const pocket = this.pocket().id;
    const rows: PackRow[] = [];
    const save = this.save;
    const inventory = (save && save.inventory) || {};
    // Row order IS wBagItems' order, which is what SELECT rewrites.
    const order: string[] = save && save.inventory ? Bag.order(save, this.bagData as any) : [];
    for (const itemId of order) {
      const raw = inventory[itemId];
      // A count that is not a number at all (a hand-written save, a mod, an old
      // migration) counts as one rather than raising out of the draw.
      const count = tonumber(raw) ?? (raw != null && raw !== false ? 1 : 0);
      if (count > 0 && this.pocketOf(itemId) === pocket) {
        const def = this.items ? this.items[itemId] : undefined;
        rows.push({
          id: itemId,
          count,
          name: PackMenu.label(itemId, def),
          teaches: this.moveLabel(def ? def.teaches : undefined),
          tmNumber: def ? def.tmNumber : undefined,
          tmhmLabel: (pocket === "TM_HM" && tmhmLabelFor(itemId, def)) || undefined,
          // A KEY_ITEM never shows one, and engine/items/tmhm.asm:390 skips the
          // count for an HM only -- a TM prints ×NN like any other stack.
          showCount: pocket === "ITEM" || pocket === "BALL" || (pocket === "TM_HM" && tostring(itemId).slice(0, 3) !== "HM_"),
        });
      }
    }
    // engine/items/tmhm.asm:341
    if (pocket === "TM_HM") {
      rows.sort((a, b) => {
        const ka = this.tmhmKey(a.id);
        const kb = this.tmhmKey(b.id);
        if (ka !== kb) return ka - kb;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    }
    this.rows = rows;
    this.index = Math.min(this.index, rows.length + 1);
    if (this.index < 1) this.index = 1;
    this.ensureVisible();
  }

  /** Lua: PackMenu.lua:335 */
  total(): number {
    return this.rows.length + 1; // CANCEL
  }

  /** Lua: PackMenu.lua:339 */
  isCancel(): boolean {
    return this.index > this.rows.length;
  }

  /** Lua: PackMenu.lua:344 -- home/menu.asm:746, :758 */
  playSfx(name: string): void {
    const data = this.game ? this.game.data : undefined;
    const sfx = data && data.audio ? data.audio.sfx : undefined;
    if (sfx && sfx[Sound.resolve(data, name)]) Sound.play(data, name);
  }

  /** Lua: PackMenu.lua:351 -- engine/items/pack.asm:1312, home/audio.asm:220 */
  playSfxTwice(name: string): void {
    this.playSfx(name);
    this.repeatSfx = WaitPlaySFX.arm(name);
  }

  /** Lua: PackMenu.lua:356 */
  tickRepeatSfx(): boolean {
    const pending = this.repeatSfx;
    if (!pending) return false;
    if (WaitPlaySFX.waiting(pending)) return true;
    this.repeatSfx = undefined;
    this.playSfx(pending.name);
    return false;
  }

  /** Lua: PackMenu.lua:365 */
  showMessage(lines: Message): void {
    lines = messageTokens(lines);
    this.message = lines;
    this.messagePage = 1;
    this.pagesSource = lines;
    this.pages = messagePages(lines);
  }

  /** Lua: PackMenu.lua:371 */
  pagesFor(lines: Message): string[][] {
    if (this.pagesSource !== lines) {
      this.pagesSource = lines;
      this.pages = messagePages(lines);
    }
    return this.pages;
  }

  /** Lua: PackMenu.lua:378 */
  ensureVisible(): void {
    if (this.index <= this.scroll) {
      this.scroll = this.index - 1;
    } else if (this.index > this.scroll + VISIBLE_ROWS) {
      this.scroll = this.index - VISIBLE_ROWS;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.total() - VISIBLE_ROWS)));
  }

  /** Lua: PackMenu.lua:388 */
  switchPocket(delta: number): void {
    // The pocket being left keeps its own cursor and scroll; the one being
    // entered restores its own (pack.asm:76).
    this.storeCursor();
    this.pocketIndex = ((((this.pocketIndex - 1 + delta) % POCKETS.length) + POCKETS.length) % POCKETS.length) + 1;
    this.restoreCursor();
    this.rebuild();
    this.storeCursor();
    // engine/items/pack.asm:1268
    this.playSfx("Sfx_SwitchPockets");
  }

  /**
   * Lua: PackMenu.lua:402 -- the player name OakThisIsntTheTimeText
   * addresses, same fallback the SAVE screen uses when a driver runs without
   * a named save.
   */
  playerName(): string {
    return (this.save && this.save.player && this.save.player.name) || "GOLD";
  }

  /**
   * Lua: PackMenu.lua:411 -- .Field (engine/items/pack.asm UseItem): a
   * field-usable item runs its effect, and only a NON-ZERO
   * wItemEffectSucceeded sets PACKSTATE_QUITRUNSCRIPT -- which quits the PACK,
   * and with it the START menu it was opened from, so the script the effect
   * queued can run in the overworld.  A zero drops into .Oak instead, which
   * prints inside the PACK and leaves it exactly where it was.
   */
  exitToField(): void {
    this.storeCursor();
    const stack = this.game ? this.game.stack : undefined;
    if (stack && stack.clear) {
      stack.clear();
      // ../pokecrystal/home/map.asm:1927-1940
      const world = this.game.world;
      if (world && world.exitMenusFade && !world.mapSetup) {
        world.exitMenusFade();
      }
    } else if (this.onClose) {
      // No clear on this stack (a test harness, or a screen pushed on its own):
      // at least give the pack back.
      this.onClose();
    }
  }

  /**
   * Lua: PackMenu.lua:432 -- whether this pack is BattlePack
   * (engine/items/pack.asm:627) rather than the field Pack.  The two are
   * separate jumptables: nothing opened over a battle may reach a field
   * effect, so the live overworld's own flag counts as well as the caller
   * saying so.
   */
  inBattle(): boolean {
    if (this.battle) return true;
    return !!(this.world && this.world.battleActive);
  }

  /**
   * Lua: PackMenu.lua:440 -- A on a row.  A field item the world claims never
   * reaches onChoose: the world has already run its effect, and all that is
   * left is which of UseItem's two endings the PACK takes.
   */
  useSelected(): void {
    const row = this.rows[this.index - 1];
    if (!row) return;
    // ScrollingMenu has returned by the time a row is acted on, so the pocket's
    // cursor bytes are already written back before the submenu opens.
    this.storeCursor();
    if (this.give) {
      if (this.onChoose) this.onChoose(row.id, row.count);
      return;
    }
    // BattlePack's .Use dispatches on the item's BATTLE menu nibble, and the
    // first four entries of its .ItemFunctionJumptable are all .Oak: a battle-
    // NOUSE item prints OakThisIsntTheTimeText inside the pack and goes nowhere.
    // Everything else is handed to the screen that opened this one
    // (src/ui/gen2/BattleState.lua), which owns the balls, the X items and the
    // party-target heals.  The FIELD jumptable is not on this path at all.
    if (this.inBattle()) {
      const def = this.items ? this.items[row.id] : undefined;
      if (def && def.battleMenu === "ITEMMENU_NOUSE") {
        this.showMessage(Strings.get(OAK_THIS_ISNT_THE_TIME));
        return;
      }
      if (this.onChoose) {
        this.staleRows = true;
        this.onChoose(row.id, row.count);
      }
      return;
    }
    const world = this.world;
    let result: any;
    let extra: any;
    if (world && world.useFieldItem) {
      const ret = world.useFieldItem(row.id);
      if (Array.isArray(ret)) [result, extra] = ret;
      else result = ret;
    }
    if (result) {
      if (result === "nowhere") {
        this.showMessage(Strings.get(OAK_THIS_ISNT_THE_TIME));
      } else if (result === "coin_case") {
        // _CoinCaseCountText (data/text/common_3.asm:336): "Coins:" then the
        // count, text_decimal 4 digits with PRINTNUM_LEFTALIGN_F so no padding.
        this.showMessage(Strings.get(Strings.source("Coins:\n%d"), extra ?? 0));
      } else if (result === "blue_card") {
        // _BlueCardBalanceText (../pokecrystal/data/text/common_3.asm:1297).
        this.showMessage(Strings.get(Strings.source("You now have\n%d points."), extra ?? 0));
      } else if (result === "repel_used") {
        // ItemUsedText (data/text/common_3.asm): "<PLAYER> used the\n<ITEM>."
        // World already wrote the counter and took the item out of the bag, so
        // the row list is rebuilt under the message the way a TOSS would.
        this.showMessage(Strings.get(Strings.source("{PLAYER} used the\n%s."), row.name));
        this.rebuild();
      } else if (result === "repel_active") {
        this.showMessage(Strings.get(REPEL_STILL_ACTIVE));
      } else if (result === "trophy_sent") {
        // ../pokecrystal/data/text/common_3.asm:1338
        if (world.playSfxNamed) {
          world.playSfxNamed("Sfx_DexFanfare5079", SFX_DEX_FANFARE_50_79);
        }
        this.showMessage(Strings.get(Strings.source("There was a trophy\ninside!\f{PLAYER} sent the\ntrophy home.")));
        this.rebuild();
      } else {
        this.exitToField();
      }
      return;
    }
    // UseItem's FIELD-pack tail (engine/items/tmhm.asm:73): a TM/HM row opens
    // the party to teach, and a field-NOUSE item -- an X ATTACK or a POKé DOLL
    // used from the field PACK -- prints OakThisIsntTheTimeText and goes
    // nowhere (UseItem's jumptable's first four entries are all .Oak).  Both
    // checks live behind `world.useFieldItem` on purpose: DepositSellPack (the
    // mart's SELL, the item PC's DEPOSIT) is a chooser whose jumptable is four
    // ScrollingMenus and never reaches tmhm.asm, so a TM picked there hands
    // its row to onChoose like every other item instead of opening the teach
    // party.  The battle pack returned above, and the catch tutorial's DUDE
    // pack carries a stub world with no useFieldItem at all -- its POKE BALL
    // is field-NOUSE and must still reach the throw.
    if (world && world.useFieldItem) {
      const def = this.items ? this.items[row.id] : undefined;
      if (def && def.teaches) {
        this.openTeachParty(row);
        return;
      }
      if (def && def.fieldMenu === "ITEMMENU_NOUSE") {
        this.showMessage(Strings.get(OAK_THIS_ISNT_THE_TIME));
        return;
      }
    }
    if (this.onChoose) {
      // The .Party flow runs OVER this pack and UseDisposableItem spends the
      // item out from under the row list; rebuild on the first frame the pack
      // owns again, which is UseItem .Party's own Pack_InitGFX redraw.
      this.staleRows = true;
      this.onChoose(row.id, row.count);
    }
  }

  // ------------------------------------------------------------- the submenu

  /**
   * Lua: PackMenu.lua:546
   *
   *   DepositSellPack (pack.asm:931) -- the mart's SELL, the item PC's DEPOSIT
   *     and HeldItemMenu's GIVE.  Its jumptable is four ScrollingMenus and
   *     nothing else, which is why `give` and the empty-world callers answer
   *     their chooser directly.
   *   TutorialPack (pack.asm:1068) -- the DUDE's pack, same shape.
   *
   * engine/items/pack.asm:627 BattlePack
   * ItemPcMenu:enterDeposit both pass `world = {}` precisely so no field effect
   * can fire, and Game2's START-menu PACK passes the real overworld.
   */
  hasSubmenu(): boolean {
    if (this.give) return false;
    if (this.tutorial) return false;
    if (this.inBattle()) return true;
    const world = this.world;
    return !!(world && world.useFieldItem);
  }

  /**
   * Lua: PackMenu.lua:558 -- ITEMATTR_PERMISSIONS' two bits and the
   * field-menu nibble, as the cart reads them.  An id with no attributes row
   * at all (an older cache, a mod's item) counts as tossable and
   * unusable-for-SEL, which is the same lean the sell gate and
   * ItemPcMenu:cantToss take.
   */
  submenuRows(itemId: string): string[] {
    const def = this.items ? this.items[itemId] : undefined;
    if (this.inBattle()) {
      // engine/items/pack.asm:783 ItemSubmenu, :745 .TMHMPocketMenu
      let usable = !(def && def.battleMenu === "ITEMMENU_NOUSE");
      if (this.pocket().id === "TM_HM") usable = false;
      if (usable) return ["use", "quit"];
      return ["quit"];
    }
    const canToss = !(def && def.canToss === false);
    const canSelect = def != null && def.canSelect === true;
    const usable = !(def && def.fieldMenu === "ITEMMENU_NOUSE");
    const rows: string[] = [];
    const add = (id: string): void => {
      rows.push(id);
    };
    if (this.pocket().id === "TM_HM") {
      // .TMHMPocketMenu's own pair: an HM cannot be tossed and gets USE / QUIT,
      // a TM gets USE / GIVE / QUIT.  Neither has a TOSS row.
      add("use");
      if (canToss) add("give");
      add("quit");
      return rows;
    }
    if (!canToss) {
      // MenuHeader_UnusableItem / MenuHeader_UnusableKeyItem: the untossable arm
      // never looks at the menu nibble, so a key item always offers USE.
      add("use");
      if (canSelect) add("sel");
      add("quit");
      return rows;
    }
    if (usable) add("use");
    add("give");
    add("toss");
    if (canSelect) add("sel");
    add("quit");
    return rows;
  }

  /** Lua: PackMenu.lua:596 */
  openSubmenu(): void {
    const row = this.rows[this.index - 1];
    if (!row) return;
    // ScrollingMenu has returned by the time the submenu opens, so the pocket's
    // cursor bytes are written back first (pack.asm:76).
    this.storeCursor();
    this.submenu = {
      row,
      rows: this.submenuRows(row.id),
      index: 1, // `db 1 ; default option`
    };
  }

  /** Lua: PackMenu.lua:609 */
  closeSubmenu(): void {
    this.submenu = undefined;
  }

  /** Lua: PackMenu.lua:613 */
  chooseSubmenu(): void {
    const menu = this.submenu;
    if (!menu) return;
    const id = menu.rows[menu.index - 1];
    const row = menu.row;
    if (id === "quit") {
      // QuitItemSubmenu: a bare `ret`, back to the pocket list.
      this.closeSubmenu();
    } else if (id === "use") {
      this.closeSubmenu();
      this.useSelected();
    } else if (id === "sel") {
      this.closeSubmenu();
      this.registerSelected();
    } else if (id === "toss") {
      this.closeSubmenu();
      this.tossItem(row);
    } else if (id === "give") {
      this.closeSubmenu();
      this.giveItem(row);
    }
  }

  // ------------------------------------------------------------------- TOSS

  /**
   * Lua: PackMenu.lua:659 -- TossMenu (engine/items/pack.asm:477): "Throw away
   * how many?" over SelectQuantityToToss, then the count in a yes/no, then
   * TossItem and "Threw away <ITEM>(S)."  Backing out of either question is
   * `jr c, .finish` -- the item is untouched and the PACK is exactly where it
   * was.
   */
  tossItem(row: PackRow | undefined): void {
    if (!row) return;
    this.showMessage(Strings.get(TOSS_HOW_MANY));
    this.qtyState = {
      row,
      qty: 1,
      max: row.count || 1,
    };
  }

  /** Lua: PackMenu.lua:669 */
  confirmToss(): void {
    const state = this.qtyState;
    if (!state) return;
    this.qtyState = undefined;
    const row = state.row;
    const qty = state.qty;
    this.confirm = {
      prompt: messageTokens(Strings.get(Strings.source("Throw away %d\n%s(S)?"), qty, row.name)),
      // YesNoBox opens on YES; B and NO are the same `jr c, .finish`.
      choice: 1,
      onYes: () => {
        Bag.remove(this.save, row.id, qty);
        this.rebuild();
        this.showMessage(Strings.get(Strings.source("Threw away\n%s(S)."), row.name));
      },
    };
  }

  // ------------------------------------------------------------------- GIVE

  /**
   * Lua: PackMenu.lua:695 -- GiveItem (engine/items/pack.asm:562): the party
   * list under PARTYMENUACTION_GIVE_ITEM ("To which <PK><MN>?"), an EGG
   * refused with .AnEggCantHoldAnItemText, and everything else handed to
   * TryGiveItemToPartymon -- which is exactly what the party's own GIVE row
   * runs (src/ui/gen2/HeldItemMenu.lua), so the two doors share one routine
   * rather than each growing a copy of the swap question and the mail
   * keyboard.
   */
  giveItem(row: PackRow): void {
    const game = this.game;
    const party = (this.save && this.save.party) || [];
    if (party.length === 0) {
      this.showMessage(Strings.get(NO_POKEMON));
      return;
    }
    if (!(game && game.stack)) return;
    try {
      Screens.get(game, "Gen2PartyMenu");
    } catch {
      return;
    }
    Screens.push(game, "Gen2PartyMenu", {
      save: this.save,
      prompt: "toWhich",
      onChoose: (slot: number) => this.giveToSlot(slot, row),
      onCancel: () => {
        // `.finish` / PartyMenuSelect's carry: back to the PACK.
        game.stack.pop();
        this.rebuild();
      },
    });
  }

  /** Lua: PackMenu.lua:716 */
  giveToSlot(slot: number, row: PackRow): void {
    const game = this.game;
    const mon = this.save && this.save.party ? this.save.party[slot - 1] : undefined;
    if (!(mon && game && game.stack)) return;
    try {
      Screens.get(game, "Gen2HeldItemMenu");
    } catch {
      return;
    }
    // The GIVE/TAKE menu's own machinery, opened past its two rows: it already
    // owns the text box over the party list, the swap question and the mail
    // keyboard, and this is the same TryGiveItemToPartymon call its GIVE row
    // makes.
    const held = Screens.build(game, "Gen2HeldItemMenu", {
      save: this.save,
      slot,
      items: this.items,
      onClose: () => {
        game.stack.pop();
        this.rebuild();
      },
    });
    game.stack.push(held);
    if (mon.isEgg) {
      // `cp EGG / jr nz, .give`: the refusal prints over the party list, which
      // stays up (`jr .loop`) for another pick.
      held.say(CommonText.pages(Strings.get(EGG_CANT_HOLD)), () => game.stack.pop());
      return;
    }
    held.giveItem(row.id);
  }

  /** Lua: PackMenu.lua:746 -- engine/items/tmhm.asm:73 */
  openTeachParty(row: PackRow): void {
    const game = this.game;
    const party = (this.save && this.save.party) || [];
    if (party.length === 0) {
      this.showMessage(Strings.get(NO_POKEMON));
      return;
    }
    if (!(game && game.stack)) return;
    try {
      Screens.get(game, "Gen2PartyMenu");
    } catch {
      return;
    }
    const def = this.items ? this.items[row.id] : undefined;
    const moveId = def ? def.teaches : undefined;
    const moves = game.data ? game.data.moves : undefined;
    const moveDef = moves ? moves[moveId] : undefined;
    const moveName = (moveDef && moveDef.name) || moveId;
    this.staleRows = true;
    Screens.push(game, "Gen2PartyMenu", {
      save: this.save,
      prompt: "teach",
      tmhm: { move: moveId },
      onCancel: () => {
        game.stack.pop();
        this.rebuild();
      },
      onChoose: (_slot: number, mon: any) => {
        game.stack.pop();
        const species = game.data && game.data.pokemon ? game.data.pokemon[mon.species] : undefined;
        let allowed = false;
        for (const id of (species && species.tmhm) || []) {
          if (id === moveId) allowed = true;
        }
        if (!allowed) {
          // engine/items/tmhm.asm:131
          const world = game.world;
          if (world && world.playSfxNamed) {
            world.playSfxNamed("Sfx_Wrong", SFX_WRONG);
          }
          if (game.say) {
            game.say(Strings.get(Strings.source("%s can't learn %s!"), Mon.displayName(mon), moveName));
          }
          return;
        }
        for (const move of mon.moves || []) {
          if (move.id === moveId) {
            if (game.say) {
              game.say(Strings.get(Strings.source("%s already knows %s!"), Mon.displayName(mon), moveName));
            }
            return;
          }
        }
        if (!game.learnMoveOn) return;
        game.learnMoveOn(mon, moveId, (learned: boolean) => {
          if (!learned) return;
          if (tostring(row.id).slice(0, 3) === "HM_") return;
          Happiness.change(mon, "LEARNMOVE");
          if (game.consumeItem) game.consumeItem(row.id);
          this.rebuild();
        });
      },
    });
  }

  /** Lua: PackMenu.lua:810 */
  update(_dt?: number): void {
    const input = this.game ? this.game.input : undefined;
    if (!input) return;
    if (this.staleRows) {
      this.staleRows = undefined;
      this.rebuild();
    }
    // engine/items/pack.asm:1312, home/audio.asm:225
    if (this.tickRepeatSfx()) return;
    // Pack_PrintTextNoScroll ends on a `prompt`, so the message holds the PACK
    // until a button clears it and the list is untouchable underneath.  The
    // quantity selector is the one thing drawn OVER a message rather than under
    // it: "Throw away how many?" is printed and SelectQuantityToToss runs on top
    // of it, so that pair is stepped before the message is cleared.
    if (this.qtyState) {
      this.updateQuantity(input);
      return;
    }
    // engine/items/pack.asm:1237 Pack_InterpretJoypad .switching_item
    if (this.switching !== undefined) {
      this.updateSwitch(input);
      return;
    }
    // home/joypad.asm:383
    if (this.message !== undefined) {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        const page = (this.messagePage || 1) + 1;
        if (page <= this.pagesFor(this.message).length) {
          this.messagePage = page;
          this.playSfx("Sfx_ReadText2");
        } else {
          this.message = undefined;
          this.messagePage = undefined;
        }
      }
      return;
    }
    if (this.confirm) {
      this.updateConfirm(input);
      return;
    }
    if (this.submenu) {
      this.updateSubmenu(input);
      return;
    }
    const [dir, edge] = MenuRepeat.direction(this.hold, input, LIST_DIRS);
    if (input.wasPressed("left")) {
      this.switchPocket(-1);
      return;
    } else if (input.wasPressed("right")) {
      this.switchPocket(1);
      return;
    } else if (dir === "up") {
      this.stepCursor(-1, edge);
      return;
    } else if (dir === "down") {
      this.stepCursor(1, edge);
      return;
    } else if (input.wasPressed("b")) {
      this.playSfx("Sfx_ReadText2");
      this.storeCursor();
      if (this.onClose) this.onClose();
      return;
    } else if (input.wasPressed("a")) {
      this.playSfx("Sfx_ReadText2");
      if (this.isCancel()) {
        this.storeCursor();
        if (this.onClose) this.onClose();
      } else if (this.hasSubmenu()) {
        // Pack_InterpretJoypad's A falls through to .ItemBallsKey_LoadSubmenu:
        // the row is chosen, not used.
        this.openSubmenu();
      } else {
        this.useSelected();
      }
      return;
    } else if (input.wasPressed("select")) {
      this.armSwitch();
      return;
    }
  }

  /** Lua: PackMenu.lua:892 -- engine/menus/scrolling_menu.asm */
  stepCursor(delta: number, edge: boolean): void {
    const total = this.total();
    let next = this.index + delta;
    if (next < 1) {
      next = edge ? total : 1;
    } else if (next > total) {
      next = edge ? 1 : total;
    }
    this.index = next;
    this.ensureVisible();
  }

  /**
   * Lua: PackMenu.lua:906 -- engine/items/pack.asm:1290 Pack_InterpretJoypad
   * .select; engine/items/tmhm.asm:207 -- the TM/HM pocket's joypad filter
   * drops SELECT.
   */
  armSwitch(): void {
    if (this.pocket().id === "TM_HM") return;
    if (this.isCancel()) return;
    if (!this.rows[this.index - 1]) return;
    this.switching = this.index;
    this.showMessage(Strings.get(ASK_ITEM_MOVE));
  }

  /**
   * Lua: PackMenu.lua:916 -- `.switching_item` (engine/items/pack.asm:1297): A
   * or SELECT places, B backs out, and left/right cannot leave the pocket
   * mid-move.
   */
  updateSwitch(input: any): void {
    const [dir, edge] = MenuRepeat.direction(this.hold, input, LIST_DIRS);
    if (dir === "up") {
      this.stepCursor(-1, edge);
    } else if (dir === "down") {
      this.stepCursor(1, edge);
    } else if (input.wasPressed("a") || input.wasPressed("select")) {
      this.placeSwitch();
    } else if (input.wasPressed("b")) {
      this.endSwitch();
    }
  }

  /** Lua: PackMenu.lua:930 -- engine/items/pack.asm:1307 .place_insert / .end_switch */
  placeSwitch(): void {
    const from = this.switching!;
    const row = this.rows[from - 1];
    if (row && !this.isCancel() && this.index !== from) {
      Bag.move(this.save, row.id, this.pocket().id, this.index, this.bagData as any);
      this.rebuild();
      this.storeCursor();
    }
    // engine/items/pack.asm:1309, :1311
    this.playSfxTwice("Sfx_SwitchPokemon");
    this.endSwitch();
  }

  /** Lua: PackMenu.lua:943 */
  endSwitch(): void {
    this.switching = undefined;
    this.message = undefined;
    this.messagePage = undefined;
  }

  /**
   * Lua: PackMenu.lua:950 -- VerticalMenu over the submenu rows: up/down wrap,
   * A picks, B is the carry that ExitMenu answers with (`ret c`), which is
   * QUIT by another name.
   */
  updateSubmenu(input: any): void {
    const menu = this.submenu!;
    const total = menu.rows.length;
    if (input.wasPressed("up")) {
      menu.index = menu.index > 1 ? menu.index - 1 : total;
    } else if (input.wasPressed("down")) {
      menu.index = menu.index < total ? menu.index + 1 : 1;
    } else if (input.wasPressed("a")) {
      this.playSfx("Sfx_ReadText2");
      this.chooseSubmenu();
    } else if (input.wasPressed("b")) {
      this.playSfx("Sfx_ReadText2");
      this.closeSubmenu();
    }
  }

  /**
   * Lua: PackMenu.lua:968 -- Toss_Sell_Loop: the count is stepped until A
   * takes it or B backs out, and backing out is the whole toss cancelled.
   */
  updateQuantity(input: any): void {
    const state = this.qtyState!;
    if (input.wasPressed("up")) {
      state.qty = qtyStep(state.qty, state.max, 1);
    } else if (input.wasPressed("down")) {
      state.qty = qtyStep(state.qty, state.max, -1);
    } else if (input.wasPressed("right")) {
      state.qty = qtyStep(state.qty, state.max, 10);
    } else if (input.wasPressed("left")) {
      state.qty = qtyStep(state.qty, state.max, -10);
    } else if (input.wasPressed("a")) {
      this.playSfx("Sfx_ReadText2");
      this.message = undefined;
      this.messagePage = undefined;
      this.confirmToss();
    } else if (input.wasPressed("b")) {
      this.playSfx("Sfx_ReadText2");
      this.qtyState = undefined;
      this.message = undefined;
      this.messagePage = undefined;
    }
  }

  /** Lua: PackMenu.lua:990 -- YesNoBox: up/down flip, A takes the highlighted row, B is NO. */
  updateConfirm(input: any): void {
    const confirm = this.confirm!;
    if (input.wasPressed("up") || input.wasPressed("down")) {
      confirm.choice = confirm.choice === 1 ? 2 : 1;
    } else if (input.wasPressed("b")) {
      this.playSfx("Sfx_ReadText2");
      this.confirm = undefined;
      if (confirm.onNo) confirm.onNo();
    } else if (input.wasPressed("a")) {
      this.playSfx("Sfx_ReadText2");
      const yes = confirm.choice === 1;
      this.confirm = undefined;
      if (yes) {
        if (confirm.onYes) confirm.onYes();
      } else if (confirm.onNo) {
        confirm.onNo();
      }
    }
  }

  /**
   * Lua: PackMenu.lua:1014 -- RegisterItem (engine/items/pack.asm), the
   * submenu's SEL row and its ONLY door -- the cart's SELECT is the bag's own
   * item shuffle (see armSwitch).  World:registerItem re-runs
   * CheckSelectableItem's gate (TM/HM and anything CANT_SELECT_F refuses), so
   * it cannot register what the cart would not.
   */
  registerSelected(): void {
    if (this.isCancel()) return;
    const row = this.rows[this.index - 1];
    if (!row) return;
    // BattlePack shares Pack_InterpretJoypad, whose SELECT arm is the bag's own
    // item shuffle rather than the field pack's item submenu, so nothing over a
    // battle registers anything.
    const world = !this.inBattle() ? this.world : undefined;
    const ok = world && world.registerItem && world.registerItem(row.id);
    if (ok) {
      // engine/items/pack.asm:551
      this.playSfx("Sfx_FullHeal");
      // RegisteredItemText: "Registered the\n<item>."
      this.showMessage(Strings.get(Strings.source("Registered the\n%s."), row.name));
    } else {
      // CantRegisterText: "You can't register\nthat item."
      this.showMessage(Strings.get(Strings.source("You can't register\nthat item.")));
    }
  }

  /**
   * Lua: PackMenu.lua:1036 -- a TM or HM's `move` is what it teaches; the
   * extractor carries it on the item record, and moves.lua carries that move's
   * own description.
   */
  moveOf(itemId: string | undefined): string | undefined {
    const def = itemId && this.items ? this.items[itemId] : undefined;
    // The extractor calls it `teaches`.
    return (def && def.teaches) || undefined;
  }

  /**
   * Lua: PackMenu.lua:1045 -- the description under the list.  A TM shows the
   * MOVE's description rather than the item's -- which is what the cart's TM
   * pocket does, and the whole reason move descriptions are worth extracting.
   */
  description(): string | undefined {
    if (this.isCancel()) return undefined;
    const row = this.rows[this.index - 1];
    if (!row) return undefined;
    const moveId = this.moveOf(row.id);
    if (moveId) {
      const moves = this.game && this.game.data ? this.game.data.moves : undefined;
      const moveDef = moves ? moves[moveId] : undefined;
      if (moveDef && moveDef.description) return moveDef.description;
    }
    const def = this.items ? this.items[row.id] : undefined;
    return (def && def.description) || undefined;
  }

  /**
   * Lua: PackMenu.lua:1061 -- engine/gfx/cgb_layouts.asm:723-726 -- the cursor
   * column (7,2) 1x9 takes palette $3, whose colour 3 is red
   * (gfx/pack/pack.pal).
   */
  cursorAt(tx: number, ty: number, hollow?: boolean): void {
    const palette = this.gfx && this.gfx.available() && this.gfx.colorsAt(tx, ty);
    if (palette) {
      Chrome.cursorThrough(tx, ty, palette, false, hollow);
    } else {
      Chrome.cursor(tx, ty, hollow);
    }
  }

  /**
   * Lua: PackMenu.lua:1083 -- the list, description and cursor, on top of
   * whatever chrome was drawn.
   *
   * ScrollingMenu_CallFunctions1and2 (engine/menus/scrolling_menu.asm:424-429)
   * steps the coord on by the header's `db 5, 8` COLUMN count before
   * PlaceMenuItemQuantity (engine/menus/menu_2.asm:19-25) adds SCREEN_WIDTH + 1,
   * so the ×N sits at name + 9 on the row BELOW the name, flush right in every
   * pocket (#1425, #1693).  Its `lb bc, 1, 2` is a TWO-digit field with the
   * leading digit blanked.  engine/items/tmhm.asm:392-403 writes that same
   * column for a TM.
   *
   * ScrollingMenu_PlaceCursor (engine/menus/scrolling_menu.asm:438) marks the
   * row SELECT armed with the hollow ▷ while the solid ▶ goes on looking.
   */
  drawList(listX: number, listY: number): void {
    // engine/menus/scrolling_menu.asm:86 .a_button -> home/menu.asm:50
    // engine/items/pack.asm:1301 .select
    const picked = this.switching === undefined && !!(this.submenu || this.qtyState || this.confirm || this.message !== undefined);
    for (let row = 1; row <= VISIBLE_ROWS; row++) {
      const i = row + this.scroll;
      const ty = listY + (row - 1) * LIST_SPACING;
      if (i <= this.rows.length) {
        const entry = this.rows[i - 1]!;
        // engine/items/tmhm.asm:355-385 (#1695)
        if (entry.tmhmLabel) {
          Chrome.printThrough(entry.tmhmLabel, listX - 3, ty, Chrome.DEFAULT_BOX_PALETTE);
        }
        if (i === this.index) {
          this.cursorAt(listX - 1, ty, picked);
        } else if (i === this.switching) {
          this.cursorAt(listX - 1, ty, true);
        }
        Chrome.printThrough((entry.tmhmLabel && entry.teaches) || entry.name, listX, ty, Chrome.DEFAULT_BOX_PALETTE);
        if (entry.showCount) {
          Chrome.printThrough("×" + Chrome.number(entry.count, 2), listX + 9, ty + 1, Chrome.DEFAULT_BOX_PALETTE);
        }
      } else if (i === this.total()) {
        if (i === this.index) this.cursorAt(listX - 1, ty, picked);
        Chrome.printThrough(Strings.get("CANCEL"), listX, ty, Chrome.DEFAULT_BOX_PALETTE);
      }
    }
  }

  /** Lua: PackMenu.lua:1116 */
  drawDescription(ty: number): void {
    // Pack_PrintTextNoScroll writes over the same box the description lives in,
    // so while a message is up it IS the box's contents.  TossMenu's yes/no
    // (AskQuantityThrowAwayText through MenuTextbox) is the same box: the
    // question is printed there and the YES/NO window opens over the list.
    const lines = this.message ?? (this.confirm ? this.confirm.prompt : undefined);
    if (lines !== undefined) {
      const name = this.playerName();
      // home/text.asm:397
      const page = this.pagesFor(lines)[(this.messagePage || 1) - 1] ?? [];
      page.forEach((line, i) => {
        Chrome.printThrough(line.split("{PLAYER}").join(name), 1, ty + i * 2, Chrome.DEFAULT_BOX_PALETTE);
      });
      return;
    }
    const description = this.description();
    if (!description) return;
    // Item descriptions join their two lines with the '<NEXT>' the extractor
    // leaves in place, and $4e steps SCREEN_WIDTH * 2 from the line's own
    // start (home/text.asm NextLineChar) -- TWO rows, the same metric every
    // text box uses.  PrintItemDescription writes them from decoord 1, 14, so
    // the second line is row 16.  '\n' covers hand-written data.
    let m = /^([\s\S]*?)<NEXT>([\s\S]*)$/.exec(description);
    if (!m) m = new RegExp(`^([\\s\\S]*?)${LINE}([\\s\\S]*)$`).exec(description);
    const first = m ? m[1] : undefined;
    const second = m ? m[2] : undefined;
    Chrome.printThrough(first ?? description, 1, ty, Chrome.DEFAULT_BOX_PALETTE);
    if (second !== undefined) Chrome.printThrough(second, 1, ty + 2, Chrome.DEFAULT_BOX_PALETTE);
  }

  /**
   * Lua: PackMenu.lua:1147 -- ../pokecrystal/engine/items/pack.asm:162, :178,
   * :313, :335, :355, :371, TEXTBOX_Y - 1`; ../pokegold/engine/items/pack.asm
   * has the same ten at column 0.
   */
  submenuColumn(): number {
    const version = (this.save && this.save.version) || GameVersion.get();
    return GameVersion.engine(version) === "crystal" ? 13 : 0;
  }

  /** Lua: PackMenu.lua:1152 */
  drawSubmenu(): void {
    const menu = this.submenu!;
    const count = menu.rows.length;
    const x = this.submenuColumn();
    // ../pokegold/engine/items/pack.asm:313 ends on TEXTBOX_Y, pokecrystal:313
    const bottom = count >= 5 && x === 0 ? 12 : 11;
    const top = bottom - count * 2;
    Chrome.box(x, top, 7, bottom - top + 1);
    menu.rows.forEach((id, idx) => {
      const i = idx + 1;
      const ty = top + 1 + (i - 1) * 2;
      if (i === menu.index) Chrome.cursorThrough(x + 1, ty, Chrome.DEFAULT_BOX_PALETTE);
      Chrome.printThrough(Strings.get(SUBMENU_LABEL[id] ?? id), x + 2, ty, Chrome.DEFAULT_BOX_PALETTE);
    });
  }

  /** Lua: PackMenu.lua:1169 -- engine/items/buy_sell_toss.asm:133 BuySellToss_UpdateQuantityDisplay */
  drawQuantity(): void {
    Chrome.box(15, 9, 5, 3);
    Chrome.printThrough("×" + Chrome.number(this.qtyState!.qty, 2, true), 16, 10, Chrome.DEFAULT_BOX_PALETTE);
  }

  /** Lua: PackMenu.lua:1176 -- YesNoBox's own coords, the same box every other Gen 2 screen here draws. */
  drawYesNo(): void {
    Chrome.box(14, 7, 6, 5);
    Chrome.printThrough(Strings.get("YES"), 16, 8, Chrome.DEFAULT_BOX_PALETTE);
    Chrome.printThrough(Strings.get("NO"), 16, 10, Chrome.DEFAULT_BOX_PALETTE);
    Chrome.cursorThrough(15, this.confirm!.choice === 1 ? 8 : 10, Chrome.DEFAULT_BOX_PALETTE);
  }

  /** Lua: PackMenu.lua:1183 */
  drawOverlays(): void {
    if (this.submenu) this.drawSubmenu();
    if (this.qtyState) this.drawQuantity();
    if (this.confirm) this.drawYesNo();
  }

  /** Lua: PackMenu.lua:1189 */
  drawPanel(): void {
    if (this.gfx.available()) {
      // Pack_InitGFX's screen: the header strip, the patterned left column, the
      // bag picture for this pocket and the pocket plaque, then Textbox at
      // (0,12) for the item description.
      // the pocket's background is the same cells until the pocket changes
      // (screen.ts cachedBlock)
      const pocketId = this.pocket().id;
      cachedBlock(this, `gfx:${pocketId}:${keyOf(this.gfx)}:${GbcPalette.stateKey()}`,
        () => this.gfx.draw(pocketId));
      Chrome.box(0, PackGfx.DESCRIPTION_Y, 20, 6);
      this.drawList(LIST_X, LIST_Y);
      this.drawDescription(PackGfx.DESCRIPTION_Y + 2);
      this.drawOverlays();
      G.setColor(1, 1, 1, 1);
      return;
    }

    // No pack tiles in the cache (an import from before the pack stage): plain
    // boxes, the layout this screen shipped with.
    Chrome.clear();
    Chrome.box(0, 0, 20, 3);
    Chrome.printThrough(Strings.get(this.pocket().label), 2, 1, Chrome.DEFAULT_BOX_PALETTE);
    Chrome.box(0, 3, 20, 12);
    this.drawList(5, 4);
    Chrome.box(0, 12, 20, 6);
    this.drawDescription(14);
    this.drawOverlays();
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: PackMenu.lua:1217 */
  draw(): void {
    this.drawPanel();
  }

  /** Lua: PackMenu.lua:1221 */
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

export default PackMenu;
