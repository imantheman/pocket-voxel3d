// gen1recomp src/core/gen2/MomShopping.lua at bdfac727 (MIT): Mom spends the
// money she is saving for you (engine/events/mom_phone.asm with
// data/items/mom_phone.asm).
//
// Two lists: MomItems_2 is a LADDER walked once in order by wWhichMomItem
// (each row unlocked by a savings balance -- the four DOLLS live here);
// MomItems_1 is a RANDOM consolation buy that fires only when the savings land
// EXACTLY on a multiple of MOM_MONEY the trigger balance has not passed.
//
// Indexing: mom.whichItem is the cart's 0-based wWhichMomItem, so the ladder
// row is ITEMS_2[whichItem] (the Lua's ITEMS_2[whichItem + 1]).

import { Strings } from "../shared/core/Strings.ts";
import { Decorations } from "./Decorations.ts";

/** One momitem row: `item` is an item id for MOM_ITEM, a DECO_* id for MOM_DOLL. */
export interface MomItem {
  trigger: number;
  cost: number;
  kind: number;
  item: string | number;
}

/** save.mom as this module reads and writes it. */
export interface MomState {
  savedMoney?: number;
  whichItem: number;
  triggerBalance: number;
  [k: string]: unknown;
}

/** What tryBuy answers. */
export interface MomPurchase {
  kind: "item" | "doll";
  item: string | number;
  cost: number;
  set: number;
  saved: number;
}

/** tryBuy's options (see the Lua's comment at MomShopping.lua:181-186). */
export interface MomBuyOpts {
  /** the world/Events.ts bitfield, for a doll's flag */
  events?: any;
  /** the cache, for the PC's stack cap (data.field.pcItemCap) */
  data?: any;
  /** RandomRange: 0..n-1 */
  random?: (n: number) => number;
  /** GetMapPhoneService: false on a map with no reception */
  phoneService?: boolean;
}

type SaveLike = Record<string, any> | null | undefined;

// Lua: MomShopping.lua:31 -- constants/misc_constants.asm.
const MOM_MONEY = 2300;

// Lua: MomShopping.lua:35
const MAX_MONEY = 999999;

// Lua: MomShopping.lua:38 -- the `momitem kind` const_def 1 block.
const MOM_ITEM = 1, MOM_DOLL = 2;

// Lua: MomShopping.lua:42-43 -- wNumPCItems capacity and stack size.
const PC_ITEM_CAPACITY = 50;
const MAX_STACK = 99;

// Lua: MomShopping.lua:52-54
function momitem(trigger: number, cost: number, kind: number, item: string | number): MomItem {
  return { trigger, cost, kind, item };
}

// Lua: MomShopping.lua:56-59
const DECO_BIG_SNORLAX_DOLL = 26;
const DECO_PIKACHU_DOLL = 30;
const DECO_CLEFAIRY_DOLL = 32;
const DECO_CHARMANDER_DOLL = 35;

// Lua: MomShopping.lua:85-93 -- data/text/common_1.asm (source strings).
const MOM_HI = Strings.source("Hi, {PLAYER}!\nHow are you?");
const FOUND_AN_ITEM = Strings.source(
  "I found a useful\nitem shopping, so");
const FOUND_A_DOLL = Strings.source(
  "While shopping\ntoday, I saw this\nadorable doll, so");
const BOUGHT_WITH_YOUR_MONEY = Strings.source(
  "I bought it with\nyour money. Sorry!");
const ITS_IN_PC = Strings.source("It's in your PC.\nYou'll like it!");
const ITS_IN_YOUR_ROOM = Strings.source("It's in your room.\nYou'll love it!");

// Lua: MomShopping.lua:112-115
function savedMoney(save: SaveLike): number {
  const mom = save && save.mom;
  return (mom && mom.savedMoney) || 0;
}

// Lua: MomShopping.lua:162-175 -- the PC half of ReceiveItem over save.pcItems;
// false for a full PC (the purchase does not happen).
function receiveItemToPc(save: SaveLike, id: string, data: any): boolean {
  if (save === null || typeof save !== "object") return false;
  save.pcItems = save.pcItems || {};
  const pc: Record<string, number> = save.pcItems;
  const held = pc[id] || 0;
  const cap = (data && data.field && data.field.pcItemCap) || PC_ITEM_CAPACITY;
  const stacksFor = (n: number | undefined) => Math.ceil((n || 0) / MAX_STACK);
  let used = 0;
  for (const k of Object.keys(pc)) used = used + stacksFor(pc[k]);
  // engine/items/items.asm:156 PutItemInPocket
  if (used + stacksFor(held + 1) - stacksFor(held) > cap) return false;
  pc[id] = held + 1;
  return true;
}

export const MomShopping = {
  MOM_MONEY,

  // Lua: MomShopping.lua:61-67 -- MomItems_1, the consolation list.
  ITEMS_1: [
    momitem(0, 600, MOM_ITEM, "SUPER_POTION"),
    momitem(0, 90, MOM_ITEM, "ANTIDOTE"),
    momitem(0, 180, MOM_ITEM, "POKE_BALL"),
    momitem(0, 450, MOM_ITEM, "ESCAPE_ROPE"),
    momitem(0, 500, MOM_ITEM, "GREAT_BALL"),
  ] as MomItem[],

  // Lua: MomShopping.lua:69-80 -- MomItems_2, the ladder.
  ITEMS_2: [
    momitem(900, 600, MOM_ITEM, "SUPER_POTION"),
    momitem(4000, 270, MOM_ITEM, "REPEL"),
    momitem(7000, 600, MOM_ITEM, "SUPER_POTION"),
    momitem(10000, 1800, MOM_DOLL, DECO_CHARMANDER_DOLL),
    momitem(15000, 3000, MOM_ITEM, "MOON_STONE"),
    momitem(19000, 600, MOM_ITEM, "SUPER_POTION"),
    momitem(30000, 4800, MOM_DOLL, DECO_CLEFAIRY_DOLL),
    momitem(40000, 900, MOM_ITEM, "HYPER_POTION"),
    momitem(50000, 8000, MOM_DOLL, DECO_PIKACHU_DOLL),
    momitem(100000, 22800, MOM_DOLL, DECO_BIG_SNORLAX_DOLL),
  ] as MomItem[],

  /**
   * Lua: MomShopping.lua:104 -- save.mom with wWhichMomItem (0) and
   * wMomItemTriggerBalance (MOM_MONEY) filled in; undefined when the save
   * has no mom table.
   */
  state(save: SaveLike): MomState | undefined {
    const mom = save && save.mom;
    if (mom === null || typeof mom !== "object") return undefined;
    if (mom.whichItem == null) mom.whichItem = 0;
    if (mom.triggerBalance == null) mom.triggerBalance = MOM_MONEY;
    return mom as MomState;
  },

  /**
   * Lua: MomShopping.lua:127 -- CheckBalance_MomItem2: {row, set} (set 2 the
   * ladder, 1 the consolation buy) or undefined. `random(n)` is 0..n-1.
   */
  pick(save: SaveLike, random?: ((n: number) => number) | null): { row: MomItem | undefined; set: number } | undefined {
    const mom = MomShopping.state(save);
    if (!mom) return undefined;
    const saved = savedMoney(save);

    // A ladder that has run out falls through to the consolation test.
    const row = MomShopping.ITEMS_2[mom.whichItem];
    if (row && saved >= row.trigger) {
      return { row, set: 2 };
    }

    // .check_have_2300 is a WHILE: walk up in MOM_MONEY steps; only an EXACT
    // landing buys, and an overshoot leaves the balance where the walk left it.
    while (mom.triggerBalance < saved) {
      mom.triggerBalance = mom.triggerBalance + MOM_MONEY;
    }
    if (mom.triggerBalance !== saved) return undefined;
    mom.triggerBalance = mom.triggerBalance + MOM_MONEY;
    let roll = 0;
    if (random) roll = Math.floor(random(MomShopping.ITEMS_1.length) || 0);
    return { row: MomShopping.ITEMS_1[roll], set: 1 };
  },

  /**
   * Lua: MomShopping.lua:191 -- MomTriesToBuySomething. Returns the purchase
   * {kind, item, cost, set, saved} or undefined.
   */
  tryBuy(save: SaveLike, opts?: MomBuyOpts | null): MomPurchase | undefined {
    opts = opts || {};
    if (opts.phoneService === false) return undefined;
    const mom = MomShopping.state(save);
    if (!mom) return undefined;

    // wWhichMomItemSet: only a LADDER buy advances wWhichMomItem.
    const pick = MomShopping.pick(save, opts.random);
    if (!(pick && pick.row)) return undefined;
    const row = pick.row;

    if (row.kind === MOM_DOLL) {
      // DecorationFlagAction_c SET_FLAG: a doll cannot fail.
      Decorations.give(opts.events, row.item as number);
    } else if (!receiveItemToPc(save, row.item as string, opts.data)) {
      return undefined;
    }

    // MomBuysItem_DeductFunds: TakeMoney floors at zero.
    mom.savedMoney = Math.max(0, Math.min(savedMoney(save), MAX_MONEY) - row.cost);
    if (pick.set === 2) mom.whichItem = mom.whichItem + 1;

    return {
      kind: row.kind === MOM_DOLL ? "doll" : "item",
      item: row.item,
      cost: row.cost,
      set: pick.set,
      saved: mom.savedMoney,
    };
  },

  /**
   * Lua: MomShopping.lua:234 -- Mom_GetScriptPointer's .ItemScript /
   * .DollScript: four SOURCE strings (the caller's rawtext looks them up).
   */
  pages(purchase: MomPurchase | null | undefined): string[] {
    if (!purchase) return [];
    if (purchase.kind === "doll") {
      return [MOM_HI, FOUND_A_DOLL, BOUGHT_WITH_YOUR_MONEY, ITS_IN_YOUR_ROOM];
    }
    return [MOM_HI, FOUND_AN_ITEM, BOUGHT_WITH_YOUR_MONEY, ITS_IN_PC];
  },
};

export default MomShopping;
