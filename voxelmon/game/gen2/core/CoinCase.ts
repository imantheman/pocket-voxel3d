// gen1recomp src/core/gen2/CoinCase.lua at bdfac727 (MIT): the player's coin
// case -- engine/events/money.asm GiveCoins / TakeCoins / CheckCoins on
// save.player.coins. Model, not menu: PrizeMenu, SlotMachine and CardFlip all
// read it.
//
// giveCoins / takeCoins return the new balance only: the Lua's second value
// (the carry) is read by no caller.

import { Save } from "./Save.ts";

type SaveLike = Record<string, any> | null | undefined;

export const CoinCase = {
  // Lua: CoinCase.lua:17 -- MAX_COINS 9999 (constants/misc_constants.asm),
  // read lazily from Save (it may still be loading when this module is).
  get MAX_COINS(): number {
    return Save.MAX_COINS;
  },

  /** Lua: CoinCase.lua:19 */
  coins(save: SaveLike): number {
    const player = save && save.player;
    return (player && player.coins) || 0;
  },

  /** Lua: CoinCase.lua:26 -- GiveCoins: add, capping at MAX_COINS. The new balance. */
  giveCoins(save: SaveLike, amount?: number | null): number {
    const player = save && save.player;
    if (!player) return 0;
    const total = (player.coins || 0) + Math.floor(amount || 0);
    if (total >= CoinCase.MAX_COINS) {
      player.coins = CoinCase.MAX_COINS;
      return player.coins;
    }
    player.coins = total;
    return total;
  },

  /** Lua: CoinCase.lua:40 -- TakeCoins: subtract; a borrow leaves the case at 0. The new balance. */
  takeCoins(save: SaveLike, amount?: number | null): number {
    const player = save && save.player;
    if (!player) return 0;
    const total = (player.coins || 0) - Math.floor(amount || 0);
    if (total < 0) {
      player.coins = 0;
      return 0;
    }
    player.coins = total;
    return total;
  },

  // Lua: CoinCase.lua:54-56 -- constants/script_constants.asm HAVE_*.
  HAVE_MORE: 0,
  HAVE_AMOUNT: 1,
  HAVE_LESS: 2,

  /** Lua: CoinCase.lua:58 -- CheckCoins -> CompareMoneyAction's wScriptVar. */
  checkCoins(save: SaveLike, amount?: number | null): number {
    const have = CoinCase.coins(save);
    const want = Math.floor(amount || 0);
    if (have < want) return CoinCase.HAVE_LESS;
    if (have === want) return CoinCase.HAVE_AMOUNT;
    return CoinCase.HAVE_MORE;
  },

  /** Lua: CoinCase.lua:66 */
  canAfford(save: SaveLike, cost?: number | null): boolean {
    return CoinCase.checkCoins(save, cost) !== CoinCase.HAVE_LESS;
  },
};

export default CoinCase;
