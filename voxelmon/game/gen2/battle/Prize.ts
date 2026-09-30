// Prize money for beating a trainer: a port of gen1recomp
// src/battle/gen2/Prize.lua (bdfac727, MIT).
//
// Two routines, in two files, and both halves matter:
//
//   ComputeTrainerReward (engine/battle/read_trainer_party.asm) runs when the
//     party is READ, not when it is beaten: wBattleReward = the class's
//     TRNATTR_BASE_REWARD times wCurPartyLevel, and wCurPartyLevel at that
//     point is whatever the LAST row of data/trainers/parties.asm left there.
//     So Falkner pays for his level 9 Pidgeotto and not for the level 7 Pidgey
//     that came out first, whichever of them faints last.
//   WinTrainerBattle (engine/battle/core.asm) is the trainer-defeated arm, and
//     it hands out wBattleReward FOUR TIMES -- `ld c, 4`, one add per pass --
//     before doubling the figure twice for the text.  That factor of four is
//     the difference between Falkner's ¥900 and a ¥225 that would look
//     plausible and be wrong.
//
// The split is the other half of Bank of Mom: those four quarters are dealt
// between wMoney and wMomsMoney by wMomSavingMoney, so "save some money for
// me" is a standing 25% deduction on every trainer you beat.
//
// love-free and save-shaped: takes the Gold save table (core/Save.ts) and
// writes the two accounts on it.

import { Strings } from "../shared/core/Strings.ts";
import { mod, tonumber, truthy } from "../platform/lua.ts";

// .DoubleReward saturates: `sla [hl] / rl [hl] / rl [hl] / ret nc` and then
// $ff into all three bytes, so the shift tops out at 24 bits rather than
// wrapping.  wBattleReward is three bytes, which is where the number comes
// from -- it is NOT the money cap.
const REWARD_CAP = 0xffffff;

// constants/ram_constants.asm, wMomSavingMoney's low bits.  MOM_ACTIVE_F (bit
// 7) is deliberately outside MOM_SAVING_MONEY_MASK: it says the bank
// conversation has happened, not that anything is being skimmed.
//
// "All" is bits 0 AND 1 together, not MOM_SAVING_ALL_MONEY_F -- that third
// bit is inside the mask and is never written by anything, which is why
// WinTrainerBattle compares against `(1 << SOME) | (1 << HALF)` rather than
// against it.
const MOM_SAVING_MONEY_MASK = 7;
const MOM_SAVING_SOME = 1;
const MOM_SAVING_HALF = 2;
const MOM_SAVING_ALL = MOM_SAVING_SOME + MOM_SAVING_HALF;

// data/text/battle.asm.  Declared here and formatted at the call site so
// Strings.source is what registers them.  SentSomeToMomText keeps the cart's
// own `line`/`cont` breaks because it does not fit two rows.
const GOT_MONEY = Strings.source("%s got %s%d for winning!");
// data/text/battle.asm:179-185
const SENT_SOME = Strings.source("%s got %s%d\nfor winning!\vSent some to MOM!");
// The half and all texts really are this short on the cart: they replace the
// money line rather than following it, which is a quirk no Gold player can
// see because BankOfMom only ever writes MOM_SAVING_SOME_MONEY_F.
const SENT_HALF = Strings.source("Sent half to MOM!");
const SENT_ALL = Strings.source("Sent all to MOM!");
// BattleText_PlayerPickedUpPayDayMoney (data/text/battle.asm:3-8).
const PICKED_UP = Strings.source("%s picked up %s%d!");

// charmap.asm: the currency glyph, the same one Chrome.money floats in front
// of a six-digit field.  (The Lua spells it as its UTF-8 bytes "\xc2\xa5".)
const YEN = "¥";

export interface PrizeAwardOpts {
  /** the class's TRNATTR_BASE_REWARD (Trainers.lookup's baseMoney) */
  baseMoney?: number;
  /** wCurPartyLevel, i.e. Prize.rewardLevel(the trainer's party) */
  level?: number;
  /** wAmuletCoin, latched by CheckAmuletCoin */
  amuletCoin?: boolean;
}

export interface PrizeAward {
  quarter: number;
  /** the figure the text prints (the quarter doubled twice) */
  total: number;
  /** how many of the four quarters Mom took */
  toMom: number;
  /** the wMomSavingMoney setting the text is chosen by */
  mode: number;
  wallet: number;
  saved: number;
}

// Lua: Prize.lua:102
function doubleReward(value: number | undefined): number {
  const doubled = (value ?? 0) * 2;
  if (doubled > REWARD_CAP) return REWARD_CAP;
  return doubled;
}

// Lua: Prize.lua:112
function playerMoney(save: any): number {
  const player = truthy(save) ? save.player : undefined;
  return (truthy(player) ? player.money : undefined) ?? 0;
}

// Lua: Prize.lua:117
function momMoney(save: any): number {
  const mom = truthy(save) ? save.mom : undefined;
  return (truthy(mom) ? mom.savedMoney : undefined) ?? 0;
}

// Lua: Prize.lua:125 -- AddBattleMoneyToAccount: a 24-bit add followed by a
// compare against MAX_MONEY, and the overflow arm WRITES the cap rather than
// refusing the add.  The cart clamps; it does not wrap and it does not reject.
function addToAccount(have: number, amount: number): number {
  const total = have + amount;
  if (total > Prize.MAX_MONEY) return Prize.MAX_MONEY;
  return total;
}

// Lua: Prize.lua:131
function setPlayerMoney(save: any, value: number): void {
  const player = truthy(save) ? save.player : undefined;
  if (truthy(player)) player.money = value;
}

// Lua: Prize.lua:136
function setMomMoney(save: any, value: number): void {
  const mom = truthy(save) ? save.mom : undefined;
  if (truthy(mom)) mom.savedMoney = value;
}

// Lua: Prize.lua:162 -- `ld b, a` then the two loops: b quarters to Mom, 4 - b
// to the wallet.  3 means ALL, which is four quarters, not three.  A masked
// byte of 4 or more is not a value anything writes, so it is read as nothing.
function quartersToMom(mode: number): number {
  if (mode === MOM_SAVING_ALL) return 4;
  if (mode === MOM_SAVING_HALF) return 2;
  if (mode === MOM_SAVING_SOME) return 1;
  return 0;
}

export const Prize = {
  // constants/misc_constants.asm.  The same cap Save.MAX_MONEY carries; spelled
  // out here so this module stays usable against a bare save-shaped table.
  MAX_MONEY: 999999,

  // data/items/attributes.asm: HELD_AMULET_COIN is the only held effect that
  // reaches this file.  CheckAmuletCoin (engine/battle/core.asm) latches
  // wAmuletCoin when a mon holding one is SENT OUT, and nothing clears it for
  // the rest of the battle, so the coin still pays after its holder has fainted.
  AMULET_COIN: "AMULET_COIN",

  QUARTERS: 4,

  // Lua: Prize.lua:87 -- ComputeTrainerReward.  hProduct is four bytes and
  // wBattleReward takes the low two of them with a zero on top, so the product
  // is kept modulo 65536.
  reward(baseMoney: unknown, level: unknown): number {
    let base = Math.floor(tonumber(baseMoney) ?? 0);
    let lvl = Math.floor(tonumber(level) ?? 0);
    if (base < 0) base = 0;
    if (lvl < 0) lvl = 0;
    return mod(base * lvl, 0x10000);
  },

  // Lua: Prize.lua:97 -- the level ComputeTrainerReward would have seen:
  // wCurPartyLevel after ReadTrainerParty's loop, which is the last row it built.
  rewardLevel(party: any[] | undefined | null): number {
    const last = truthy(party) ? party![party!.length - 1] : undefined;
    return (truthy(last) ? last.level : undefined) ?? 0;
  },

  // Lua: Prize.lua:147 -- wMomSavingMoney & MOM_SAVING_MONEY_MASK.  BankOfMom
  // only ever stores (1 << MOM_ACTIVE_F) or that plus (1 <<
  // MOM_SAVING_SOME_MONEY_F), so in Gold the masked byte is 0 or 1 -- which is
  // why `savingMoney` is a boolean on this save rather than a number.
  savingMode(save: any): number {
    const mom = truthy(save) ? save.mom : undefined;
    if (!(truthy(mom) && truthy(mom.active) && truthy(mom.savingMoney))) return 0;
    if (typeof mom.savingMoney === "number") {
      return mod(mom.savingMoney, MOM_SAVING_MONEY_MASK + 1);
    }
    return MOM_SAVING_SOME;
  },

  // Lua: Prize.lua:184 -- WinTrainerBattle.  Returns a record of what happened,
  // which is what the caller turns into the message.
  award(save: any, opts?: PrizeAwardOpts): PrizeAward {
    opts = opts ?? {};
    let quarter = Prize.reward(opts.baseMoney, opts.level);
    // `ld a, [wAmuletCoin] / and a / call nz, .DoubleReward` -- before the
    // split, so Mom's cut doubles with everything else.
    if (truthy(opts.amuletCoin)) quarter = doubleReward(quarter);

    // .CheckMaxedOutMomMoney: carry means wMomsMoney is BELOW the cap.  With no
    // carry the whole reward goes to the wallet and the text is .KeepItAll,
    // however the savings setting is left.
    let mode = 0;
    if (momMoney(save) < Prize.MAX_MONEY) mode = Prize.savingMode(save);
    const toMom = quartersToMom(mode);

    let wallet = playerMoney(save);
    let saved = momMoney(save);
    for (let i = 1; i <= toMom; i++) saved = addToAccount(saved, quarter);
    for (let i = 1; i <= Prize.QUARTERS - toMom; i++) wallet = addToAccount(wallet, quarter);
    setPlayerMoney(save, wallet);
    setMomMoney(save, saved);

    return {
      quarter,
      total: doubleReward(doubleReward(quarter)),
      toMom,
      mode,
      wallet,
      saved,
    };
  },

  // Lua: Prize.lua:216 -- the line StdBattleTextbox prints, chosen by
  // .SentToMomTexts / .KeepItAll.
  message(award: Partial<PrizeAward> | undefined | null, playerName?: string): string {
    const name = playerName ?? "PLAYER";
    const total = (truthy(award) ? award!.total : undefined) ?? 0;
    const mode = (truthy(award) ? award!.mode : undefined) ?? 0;
    if (mode === MOM_SAVING_ALL) return Strings.get(SENT_ALL);
    if (mode === MOM_SAVING_HALF) return Strings.get(SENT_HALF);
    if (mode === MOM_SAVING_SOME) {
      return Strings.get(SENT_SOME, name, YEN, total);
    }
    return Strings.get(GOT_MONEY, name, YEN, total);
  },

  // Lua: Prize.lua:230 -- CheckPayDay (engine/battle/core.asm:8014-8042): the
  // Amulet Coin doubles the accumulated total once, and the wallet is written
  // directly, no Mom split.
  payDay(save: any, amount: number | undefined, amuletCoin?: boolean): number | undefined {
    if (!(truthy(save) && truthy(save.player)) || (amount ?? 0) <= 0) return undefined;
    let amt = amount!;
    if (truthy(amuletCoin)) amt = amt * 2;
    setPlayerMoney(save, addToAccount(playerMoney(save), amt));
    return amt;
  },

  // Lua: Prize.lua:237
  payDayMessage(amount: number | undefined, playerName?: string): string {
    return Strings.get(PICKED_UP, playerName ?? "PLAYER", YEN, amount ?? 0);
  },
};

export default Prize;
