// ROCKET GAME CORNER: the coin clerks and the prize counters, ported from
// gen1recomp data/scripts/story3.lua (scripts/GameCorner.asm and
// engine/events/prize_menu.asm CeladonPrizeMenu).
//
// Coins live in `save.coins`, capped at 9999 like wPlayerCoins. The COIN CASE
// gates everything: without it a clerk refuses to sell, a counter refuses to
// open a window, and a slot machine refuses to start — which is the original's
// IsItemInBag COIN_CASE check in three places.

import { gameVersion } from "../data.ts";
import type { ScriptRow } from "./script.ts";

/** wPlayerCoins is two BCD bytes; the case holds four digits. */
export const COIN_CAP = 9999;
/** Has9990Coins: the clerk refuses a sale that could not fit 50 more. */
export const COIN_SALE_LIMIT = 9990;
/** field.coinPurchases[0] — 50 coins for ¥1000. */
export const COINS_PER_SALE = 50;
export const COIN_SALE_PRICE = 1000;

/**
 * The counter clerk (GameCornerClerk1Text). The offer, then the three
 * refusals the asm checks in order — no case, case full, cannot afford —
 * and only then the sale.
 */
export function coinClerkRows(p = "_GameCornerClerk1"): ScriptRow[] {
  // Yellow's clerk is unnumbered (_GameCornerClerk...); same lines
  return [
    ["face_player"],
    ["ask", `${p}DoYouNeedSomeGameCoinsText`],
    ["jump_if_false", "no"],
    ["check_item", "COIN_CASE"],
    ["jump_if_false", "nocase"],
    ["check_coins_below", COIN_SALE_LIMIT],
    ["jump_if_false", "full"],
    ["check_money", COIN_SALE_PRICE],
    ["jump_if_false", "poor"],
    ["take_money", COIN_SALE_PRICE],
    ["give_coins", COINS_PER_SALE],
    ["show_text", `${p}ThanksHereAre50CoinsText`],
    ["jump", "end"],
    ["label", "no"],
    ["show_text", `${p}PleaseComePlaySometimeText`],
    ["jump", "end"],
    ["label", "nocase"],
    ["show_text", `${p}DontHaveCoinCaseText`],
    ["jump", "end"],
    ["label", "full"],
    ["show_text", `${p}CoinCaseIsFullText`],
    ["jump", "end"],
    ["label", "poor"],
    ["show_text", `${p}CantAffordTheCoinsText`],
  ];
}

/** One of the three people on the floor who hand out coins. */
export interface CoinGiver {
  flag: string;
  amount: number;
  ask: string;
  received: string;
  /** Has9990Coins: their own "you have plenty" line. */
  full: string;
  /** Asked again. */
  already: string;
}

/**
 * The three coin giveaways on the floor (GameCornerFishingGuruText,
 * GameCornerClerk2Text, GameCornerGentlemanText; gen1recomp flavor/
 * game_corner.lua coinGiver), each once: the line, then the checks in the
 * asm's order -- no COIN CASE ("Oops! Forgot the COIN CASE!"), Has9990Coins
 * with their own excuse -- and only then the coins and the flag.
 *
 * The gentleman's asm tests Has9990Coins with `jr z`, the exact-9990 case
 * only; the reference ports all three as >= 9990 and so does this.
 */
export function coinGiverRows(g: CoinGiver): ScriptRow[] {
  return [
    ["face_player"],
    ["check_flag", g.flag],
    ["jump_if_true", "already"],
    ["show_text", g.ask],
    ["check_item", "COIN_CASE"],
    ["jump_if_false", "nocase"],
    ["check_coins_below", COIN_SALE_LIMIT],
    ["jump_if_false", "full"],
    ["give_coins", g.amount],
    ["set_flag", g.flag],
    ["show_text", g.received],
    ["jump", "end"],
    ["label", "already"],
    ["show_text", g.already],
    ["jump", "end"],
    ["label", "nocase"],
    ["show_text", "_GameCornerOopsForgotCoinCaseText"],
    ["jump", "end"],
    ["label", "full"],
    ["show_text", g.full],
  ];
}

/** scripts/GameCorner.asm: who gives what, under which event. */
export const COIN_GIVERS: Record<"FISHING_GURU" | "CLERK2" | "GENTLEMAN", CoinGiver> = {
  FISHING_GURU: {
    flag: "EVENT_GOT_10_COINS", amount: 10,
    ask: "_GameCornerFishingGuruWantToPlayText",
    received: "_GameCornerFishingGuruReceived10CoinsText",
    full: "_GameCornerFishingGuruDontNeedMyCoinsText",
    already: "_GameCornerFishingGuruWinsComeAndGoText",
  },
  CLERK2: {
    flag: "EVENT_GOT_20_COINS_2", amount: 20,
    ask: "_GameCornerClerk2WantSomeCoinsText",
    received: "_GameCornerClerk2Received20CoinsText",
    full: "_GameCornerClerk2YouHaveLotsOfCoinsText",
    already: "_GameCornerClerk2INeedMoreCoinsText",
  },
  GENTLEMAN: {
    flag: "EVENT_GOT_20_COINS", amount: 20,
    ask: "_GameCornerGentlemanThrowingMeOffText",
    received: "_GameCornerGentlemanReceived20CoinsText",
    full: "_GameCornerGentlemanYouGotYourOwnCoinsText",
    already: "_GameCornerGentlemanCloselyWatchTheReelsText",
  },
};

/**
 * Yellow's floor (pokeyellow scripts/GameCorner.asm): the same three
 * giveaways in the same places, but the clerk's seat is a MIDDLE_AGED_MAN2
 * and the gentleman's a FISHING_GURU2, and their lines are named for them.
 */
export const YELLOW_COIN_GIVERS: Record<"FISHING_GURU1" | "MIDDLE_AGED_MAN2" | "FISHING_GURU2", CoinGiver> = {
  FISHING_GURU1: {
    flag: "EVENT_GOT_10_COINS", amount: 10,
    ask: "_GameCornerFishingGuru1WantToPlayText",
    received: "_GameCornerFishingGuru1Received10CoinsText",
    full: "_GameCornerFishingGuru1DontNeedMyCoinsText",
    already: "_GameCornerFishingGuru1WinsComeAndGoText",
  },
  MIDDLE_AGED_MAN2: {
    flag: "EVENT_GOT_20_COINS_2", amount: 20,
    ask: "_GameCornerMiddleAgedMan2WantSomeCoinsText",
    received: "_GameCornerMiddleAgedMan2Received20CoinsText",
    full: "_GameCornerMiddleAgedMan2YouHaveLotsOfCoinsText",
    already: "_GameCornerMiddleAgedMan2INeedMoreCoinsText",
  },
  FISHING_GURU2: {
    flag: "EVENT_GOT_20_COINS", amount: 20,
    ask: "_GameCornerFishingGuru2ThrowingMeOffText",
    received: "_GameCornerFishingGuru2Received20CoinsText",
    full: "_GameCornerFishingGuru2YouGotYourOwnCoinsText",
    already: "_GameCornerFishingGuru2CloselyWatchTheReelsText",
  },
};

export interface PrizeEntry {
  kind: "mon" | "item";
  species?: string;
  level?: number;
  item?: string;
  cost: number;
}

/**
 * data/events/prizes.asm + prize_mon_levels.asm. Each counter owns ONE window
 * of three, not the whole catalogue: GetPrizeMenuId subtracts
 * TEXT_GAMECORNERPRIZEROOM_PRIZE_VENDOR_1 from the text id and indexes
 * PrizeDifferentMenuPtrs with the result. These are Red's; Blue restocks both
 * mon counters (BLUE_PRIZE_WINDOWS), and the TM window is shared.
 */
export const PRIZE_WINDOWS: PrizeEntry[][] = [
  [
    { kind: "mon", species: "ABRA", level: 9, cost: 180 },
    { kind: "mon", species: "CLEFAIRY", level: 8, cost: 500 },
    { kind: "mon", species: "NIDORINA", level: 17, cost: 1200 },
  ],
  [
    { kind: "mon", species: "DRATINI", level: 18, cost: 2800 },
    { kind: "mon", species: "SCYTHER", level: 25, cost: 5500 },
    { kind: "mon", species: "PORYGON", level: 26, cost: 9999 },
  ],
  [
    { kind: "item", item: "TM_DRAGON_RAGE", cost: 3300 },
    { kind: "item", item: "TM_HYPER_BEAM", cost: 5500 },
    { kind: "item", item: "TM_SUBSTITUTE", cost: 7700 },
  ],
];

/**
 * Blue's windows (data/events/prizes.asm and prize_mon_levels.asm, _BLUE;
 * gen1recomp data/scripts/story3.lua BLUE_PRIZE_WINDOWS).
 */
export const BLUE_PRIZE_WINDOWS: PrizeEntry[][] = [
  [
    { kind: "mon", species: "ABRA", level: 6, cost: 120 },
    { kind: "mon", species: "CLEFAIRY", level: 12, cost: 750 },
    { kind: "mon", species: "NIDORINO", level: 17, cost: 1200 },
  ],
  [
    { kind: "mon", species: "PINSIR", level: 20, cost: 2500 },
    { kind: "mon", species: "DRATINI", level: 24, cost: 4600 },
    { kind: "mon", species: "PORYGON", level: 18, cost: 6500 },
  ],
  PRIZE_WINDOWS[2]!,
];

/** Yellow's windows (pokeyellow data/events/prizes.asm, prize_mon_levels.asm). */
export const YELLOW_PRIZE_WINDOWS: PrizeEntry[][] = [
  [
    { kind: "mon", species: "ABRA", level: 15, cost: 230 },
    { kind: "mon", species: "VULPIX", level: 18, cost: 1000 },
    { kind: "mon", species: "WIGGLYTUFF", level: 22, cost: 2680 },
  ],
  [
    { kind: "mon", species: "SCYTHER", level: 30, cost: 6500 },
    { kind: "mon", species: "PINSIR", level: 30, cost: 6500 },
    { kind: "mon", species: "PORYGON", level: 26, cost: 9999 },
  ],
  PRIZE_WINDOWS[2]!,
];

/** The prize windows of the game the dataset is. */
export function prizeWindows(data: { version?: string } | null | undefined): PrizeEntry[][] {
  const v = gameVersion(data);
  return v === "blue" ? BLUE_PRIZE_WINDOWS : v === "yellow" ? YELLOW_PRIZE_WINDOWS : PRIZE_WINDOWS;
}

/**
 * A prize counter. CeladonPrizeMenu checks the COIN CASE first and returns
 * without ever opening a window when it is missing — the refusal is not a
 * "sorry" inside the menu, it is the whole interaction.
 */
export function prizeCounterRows(window: number): ScriptRow[] {
  return [
    ["check_item", "COIN_CASE"],
    ["jump_if_false", "nocase"],
    ["show_text", "_ExchangeCoinsForPrizesText"],
    ["open_prizes", window],
    ["jump", "end"],
    ["label", "nocase"],
    ["show_text", "_RequireCoinCaseText"],
  ];
}
