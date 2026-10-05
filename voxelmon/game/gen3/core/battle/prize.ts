// Port of gen1recomp src/core/game3/battle/prize.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG trainer prize money (pret Cmd_getmoneyreward / gTrainerMoneyTable).
//
// Port notes:
// - Multiple returns are 0-based tuples: Prize.apply -> [gained, money] on
//   every path. Everything else returns one value.
// - Lazy requires (dataset, pokemon, rng) are static imports.
// - `assert(load(src, ...))()` on the rse_data cache chunk is luaLoad.
// - NOT FAITHFUL: Emerald only: pickup_banded's Battle Pyramid branch
//   (src.core.game3.rse.frontier.pyramid has no file in the port) throws.
//   The rest of the RSE helpers (calcRse, rewardRse, rseData, pickupBanded)
//   are plain data code and are ported as written; FRLG never calls them.
// - Prize.pickup's default `random` is core/rng.ts's Random (gameplay RNG):
//   one draw (`% 10`) per eligible Pickup mon, then one more (`% 100`) when
//   it finds an item, in party order, exactly as Brian's.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring, truthy, mod as lmod } from "../../../../import/gen3/lua.ts";
import { seq, len, type LuaTable } from "../../platform/lt.ts";
import { luaLoad } from "../../platform/luadata.ts";
import { notPorted } from "../../notported.ts";
import Trainers from "../scripting/trainers.ts";
import BattleText from "./battle_text.ts";
import Dataset from "../dataset.ts";
import Pokemon from "../pokemon.ts";
import Rng from "../rng.ts";

/** Lua `a or b` (b already evaluated). */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

export interface PrizeModule {
  MAX_MONEY: number;
  CLASS_MONEY: Record<number, number>;
  DEFAULT_CLASS_VALUE: number;
  classValue(classId: any): number;
  calc(trainerId: any, opts?: any): number;
  calcRse(trainerId: any, opts?: any): number;
  rewardRse(trainerId: any, opts?: any): number;
  apply(session: any, amount: any): [number, number];
  awardTrainerWin(session: any, trainerId: any, opts?: any): number;
  moneyMessage(playerName: any, amount: any): string;
  payDay(session: any, coins: any, opts?: any): number;
  payDayMessage(playerName: any, amount: any): string;
  ABILITY_PICKUP: number;
  PICKUP_ITEMS: LuaTable;
  RSE_DATA_REL: string;
  _rseData: any;
  rseData(): any;
  pickupBanded(level: any, rand: number, data?: any): any;
  pickup(party: any, random?: (() => number) | null, rules?: any): LuaTable;
}

export const Prize = {} as PrizeModule;

Prize.MAX_MONEY = 999999;

// pret battle_main.c gTrainerMoneyTable (classId → payout factor).
// Unknown classes fall through to terminator value 5.
const CLASS_MONEY: Record<number, number> = {
  [84]: 25, // LEADER
  [87]: 25, // ELITE_FOUR
  [97]: 25, // PKMN_PROF
  [81]: 4,  // RIVAL_EARLY
  [89]: 9,  // RIVAL_LATE
  [90]: 25, // CHAMPION
  [57]: 4,  // YOUNGSTER
  [58]: 3,  // BUG_CATCHER
  [65]: 9,  // HIKER
  [79]: 6,  // BIRD_KEEPER
  [62]: 5,  // PICNICKER
  [64]: 6,  // SUPER_NERD
  [69]: 9,  // FISHERMAN
  [85]: 8,  // TEAM_ROCKET
  [59]: 4,  // LASS
  [73]: 18, // BEAUTY
  [80]: 6,  // BLACK_BELT
  [71]: 6,  // CUE_BALL
  [91]: 8,  // CHANNELER
  [76]: 6,  // ROCKER
  [88]: 18, // GENTLEMAN
  [67]: 22, // BURGLAR
  [70]: 1,  // SWIMMER_M
  [68]: 12, // ENGINEER
  [77]: 10, // JUGGLER
  [60]: 8,  // SAILOR
  [86]: 9,  // COOLTRAINER
  [63]: 12, // POKEMANIAC
  [78]: 10, // TAMER
  [61]: 5,  // CAMPER
  [75]: 5,  // PSYCHIC
  [66]: 5,  // BIKER
  [72]: 18, // GAMER
  [82]: 12, // SCIENTIST
  [99]: 6,  // CRUSH_GIRL
  [100]: 1, // TUBER
  [101]: 7, // PKMN_BREEDER
  [102]: 9, // PKMN_RANGER
  [103]: 7, // AROMA_LADY
  [104]: 12, // RUIN_MANIAC
  [105]: 50, // LADY
  [106]: 4, // PAINTER
  [92]: 3,  // TWINS
  [94]: 7,  // YOUNG_COUPLE
  [96]: 1,  // SIS_AND_BRO
  [93]: 6,  // COOL_COUPLE
  [95]: 6,  // CRUSH_KIN
  [74]: 1,  // SWIMMER_F
  [98]: 1,  // PLAYER
  [24]: 25, // RS_LEADER
  [23]: 25, // RS_ELITE_FOUR
  [49]: 4,  // RS_LASS
  [29]: 4,  // RS_YOUNGSTER
  [44]: 15, // PKMN_TRAINER
  [51]: 10, // RS_HIKER
  [12]: 20, // RS_BEAUTY
  [31]: 10, // RS_FISHERMAN
  [11]: 50, // RS_LADY
  [32]: 10, // TRIATHLETE
  [3]: 5,   // TEAM_AQUA
  [40]: 3,  // RS_TWINS
  [38]: 2,  // RS_SWIMMER_F
  [50]: 4,  // RS_BUG_CATCHER
  [25]: 5,  // SCHOOL_KID
  [13]: 50, // RICH_BOY
  [26]: 4,  // SR_AND_JR
  [16]: 8,  // RS_BLACK_BELT
  [7]: 1,   // RS_TUBER_F
  [10]: 6,  // HEX_MANIAC
  [45]: 10, // RS_PKMN_BREEDER
  [48]: 5,  // TEAM_MAGMA
  [6]: 12,  // INTERVIEWER
  [8]: 1,   // RS_TUBER_M
  [52]: 8,  // RS_YOUNG_COUPLE
  [17]: 8,  // GUITARIST
  [22]: 20, // RS_GENTLEMAN
  [30]: 50, // RS_CHAMPION
  [47]: 20, // MAGMA_LEADER
  [36]: 6,  // BATTLE_GIRL
  [15]: 2,  // RS_SWIMMER_M
  [27]: 20, // POKEFAN
  [28]: 10, // EXPERT
  [33]: 12, // DRAGON_TAMER
  [34]: 8,  // RS_BIRD_KEEPER
  [35]: 3,  // NINJA_BOY
  [37]: 10, // PARASOL_LADY
  [20]: 15, // BUG_MANIAC
  [41]: 8,  // RS_SAILOR
  [43]: 15, // COLLECTOR
  [46]: 12, // RS_PKMN_RANGER
  [56]: 10, // MAGMA_ADMIN
  [4]: 10,  // RS_AROMA_LADY
  [5]: 15,  // RS_RUIN_MANIAC
  [9]: 12,  // RS_COOLTRAINER
  [14]: 15, // RS_POKEMANIAC
  [18]: 8,  // KINDLER
  [19]: 4,  // RS_CAMPER
  [39]: 4,  // RS_PICNICKER
  [21]: 6,  // RS_PSYCHIC
  [54]: 3,  // RS_SIS_AND_BRO
  [53]: 10, // OLD_COUPLE
  [55]: 10, // AQUA_ADMIN
  [2]: 20,  // AQUA_LEADER
  [83]: 25, // BOSS
};

Prize.CLASS_MONEY = CLASS_MONEY;
Prize.DEFAULT_CLASS_VALUE = 5;

// Lua: prize.lua:122
Prize.classValue = function (classIdIn: any): number {
  const classId = tonumber(classIdIn);
  if (classId == null) return Prize.DEFAULT_CLASS_VALUE;
  return CLASS_MONEY[classId] ?? Prize.DEFAULT_CLASS_VALUE;
};

// Lua: prize.lua:129
/** pret: 4 * lastMonLevel * moneyMultiplier * (double ? 2 : 1) * classValue */
Prize.calc = function (trainerId: any, optsIn?: any): number {
  const opts = optsIn ?? {};
  const info = lor(Trainers.info(trainerId), {});
  const classId = lor(opts.class, info.class);
  let lastLevel = tonumber(opts.lastLevel)
    ?? tonumber(info.lastLevel)
    ?? tonumber(opts.level)
    ?? 1;
  if (lastLevel < 1) lastLevel = 1;
  let mult = tonumber(opts.moneyMultiplier) ?? 1;
  if (mult < 1) mult = 1;
  const doubleMult = truthy(opts.double) ? 2 : 1;
  const value = Prize.classValue(classId);
  return 4 * lastLevel * mult * doubleMult * value;
};

// pokeemerald/src/battle_script_commands.c:5578
// Lua: prize.lua:146
Prize.calcRse = function (trainerId: any, optsIn?: any): number {
  const opts = optsIn ?? {};
  const pack = Trainers.pack();
  const money = truthy(pack) ? pack.money : pack;
  if (money === null || typeof money !== "object" || pack.moneyDefault == null) {
    throw new Error("trainers.lua has no money table");
  }
  const row: any = Trainers.get(trainerId);
  if (!truthy(row)) throw new Error("no trainer row " + tostring(trainerId));
  const lastMon = row.party[len(row.party)];
  const lastLevel = tonumber(truthy(lastMon) ? lastMon.level : lastMon) ?? 0;
  const value = tonumber(money[tonumber(row.class) as number]) ?? tonumber(pack.moneyDefault) as number;
  const mult = tonumber(opts.moneyMultiplier) ?? 1;
  // pokeemerald/src/battle_script_commands.c:5624
  if (truthy(opts.double) && !truthy(opts.twoOpponents)) {
    return 4 * lastLevel * mult * 2 * value;
  }
  return 4 * lastLevel * mult * value;
};

// pokeemerald/src/battle_script_commands.c:5635
// Lua: prize.lua:167
Prize.rewardRse = function (trainerId: any, optsIn?: any): number {
  const opts = optsIn ?? {};
  let amount = Prize.calcRse(trainerId, opts);
  if (truthy(opts.twoOpponents) && truthy(opts.trainerIdB)) {
    amount = amount + Prize.calcRse(opts.trainerIdB, opts);
  }
  return amount;
};

// Lua: prize.lua:176
Prize.apply = function (session: any, amountIn: any): [number, number] {
  const amount = Math.max(0, Math.floor(tonumber(amountIn) ?? 0));
  if (!truthy(session) || amount <= 0) return [0, tonumber(truthy(session) ? session.money : session) ?? 0];
  const money = tonumber(session.money) ?? 0;
  let nextMoney = money + amount;
  if (nextMoney > Prize.MAX_MONEY) nextMoney = Prize.MAX_MONEY;
  const gained = nextMoney - money;
  session.money = nextMoney;
  return [gained, nextMoney];
};

// Lua: prize.lua:188
/** Award trainer prize into session; returns amount gained (0 if wild/none). */
Prize.awardTrainerWin = function (session: any, trainerId: any, opts?: any): number {
  if (!truthy(trainerId)) return 0;
  const amount = Prize.calc(trainerId, opts);
  const gained = Prize.apply(session, amount)[0];
  return gained;
};

// data/battle_scripts_1.s:2918
// Lua: prize.lua:196
Prize.moneyMessage = function (playerName: any, amountIn: any): string {
  const amount = Math.floor(tonumber(amountIn) ?? 0);
  return BattleText.get("STRINGID_PLAYERGOTMONEY", { playerName: playerName, buff1: tostring(amount) });
};

// pokefirered/src/battle_script_commands.c:7064
// Lua: prize.lua:202
Prize.payDay = function (session: any, coinsIn: any, optsIn?: any): number {
  const opts = optsIn ?? {};
  const coins = Math.floor(tonumber(coinsIn) ?? 0);
  if (coins <= 0 || truthy(opts.link)) return 0;
  let mult = tonumber(opts.moneyMultiplier) ?? 1;
  if (mult < 1) mult = 1;
  const bonus = coins * mult;
  Prize.apply(session, bonus);
  return bonus;
};

// pokefirered/src/battle_message.c:178
// Lua: prize.lua:214
Prize.payDayMessage = function (playerName: any, amountIn: any): string {
  const amount = lmod(Math.floor(tonumber(amountIn) ?? 0), 65536);
  return BattleText.get("STRINGID_PLAYERPICKEDUPMONEY", { playerName: playerName, buff1: tostring(amount) });
};

Prize.ABILITY_PICKUP = 53;

// pokefirered/src/battle_script_commands.c:772
Prize.PICKUP_ITEMS = seq(
  seq(139, 15), seq(133, 25), seq(134, 35), seq(135, 45), seq(136, 55), seq(137, 65),
  seq(140, 75), seq(298, 80), seq(69, 85), seq(68, 90), seq(110, 95), seq(163, 96),
  seq(164, 97), seq(165, 98), seq(166, 99), seq(167, 1),
);

// Lua: prize.lua:228
function no_item(v: any): boolean {
  return v == null || v === 0 || v === "" || v === "NONE";
}

Prize.RSE_DATA_REL = "data/generated/gba/pokemon/battle/rse_data.lua";
Prize._rseData = undefined;

// Lua: prize.lua:235
Prize.rseData = function (): any {
  if (truthy(Prize._rseData)) return Prize._rseData;
  // require("src.core.game3.dataset")
  const cache: any = Dataset.cache();
  const src = (truthy(cache) && truthy(cache.read)) ? cache.read(Prize.RSE_DATA_REL) : undefined;
  if (typeof src !== "string") throw new Error(Prize.RSE_DATA_REL + " is missing from the cache");
  const [chunk, err] = luaLoad(src, "@" + Prize.RSE_DATA_REL);
  if (!chunk) throw new Error(err);
  const data: any = chunk();
  if (data === null || typeof data !== "object" || data.pickupItems === null || typeof data.pickupItems !== "object") {
    throw new Error(Prize.RSE_DATA_REL + " has no pickup tables");
  }
  Prize._rseData = data;
  return data;
};

// pokeemerald/src/battle_script_commands.c:9707
// Lua: prize.lua:249
Prize.pickupBanded = function (level: any, rand: number, dataIn?: any): any {
  const data = dataIn ?? Prize.rseData();
  let lvlDiv10 = Math.floor(((tonumber(level) ?? 1) - 1) / 10);
  if (lvlDiv10 > 9) lvlDiv10 = 9;
  if (lvlDiv10 < 0) lvlDiv10 = 0;
  const probs = data.pickupProbabilities;
  for (let j = 0; j <= len(probs) - 1; j++) {
    if (probs[j + 1] > rand) {
      return data.pickupItems[lvlDiv10 + j + 1].id;
    } else if (rand === 99 || rand === 98) {
      return data.rarePickupItems[lvlDiv10 + (99 - rand) + 1].id;
    }
  }
  return undefined;
};

// Lua: prize.lua:265
function pickup_banded(party: any, random: () => number, rules: any): LuaTable {
  const picked: LuaTable = seq();
  // require("src.core.game3.pokemon")
  for (let i = 1; i <= 6; i++) {
    const mon = party[i];
    if (mon !== null && typeof mon === "object") {
      const species = truthy(Pokemon.speciesOf) ? lor(Pokemon.speciesOf(mon), tonumber(mon.species)) : tonumber(mon.species);
      let ability = tonumber(mon.abilityId) ?? tonumber(mon.ability);
      if (ability == null && truthy(species) && truthy(Pokemon.abilityId)) {
        ability = Pokemon.abilityId(species, lor(mon.personality, 0));
      }
      if (ability === Prize.ABILITY_PICKUP && truthy(species) && species !== 0
        && !(truthy(mon.isEgg) || truthy(mon.egg))
        && no_item(mon.item) && no_item(mon.heldItem)
        && lmod(random(), 10) === 0) {
        let itemId: any;
        if (truthy(rules) && truthy(rules.pyramidSession)) {
          // pokeemerald/src/battle_script_commands.c:9667
          // require("src.core.game3.rse.frontier.pyramid").pickupItemId(rules.pyramidSession)
          // NOT FAITHFUL: Emerald only: the module has no file in the port, so the require fails.
          notPorted("src.core.game3.rse.frontier.pyramid (Emerald only)");
        } else {
          itemId = Prize.pickupBanded(mon.level, lmod(random(), 100));
        }
        if (truthy(itemId)) {
          mon.item = itemId;
          mon.heldItem = itemId;
          picked[len(picked) + 1] = { slot: i, item: itemId };
        }
      }
    }
  }
  return picked;
}

// pokefirered/src/battle_script_commands.c:9261
// Lua: prize.lua:299
Prize.pickup = function (party: any, randomIn?: (() => number) | null, rules?: any): LuaTable {
  const picked: LuaTable = seq();
  if (party === null || typeof party !== "object") return picked;
  if (truthy(rules) && (rules.pickup === false || truthy(rules.noPickup))) return picked;
  // require("src.core.game3.rng").Random
  const random: () => number = truthy(randomIn) ? randomIn as () => number : Rng.Random;
  if (truthy(rules) && rules.pickup === "level_bands") return pickup_banded(party, random, rules);
  // require("src.core.game3.pokemon")
  for (let i = 1; i <= 6; i++) {
    const mon = party[i];
    if (mon !== null && typeof mon === "object") {
      const species = truthy(Pokemon.speciesOf) ? lor(Pokemon.speciesOf(mon), tonumber(mon.species)) : tonumber(mon.species);
      let ability = tonumber(mon.abilityId) ?? tonumber(mon.ability);
      if (ability == null && truthy(species) && truthy(Pokemon.abilityId)) {
        ability = Pokemon.abilityId(species, lor(mon.personality, 0));
      }
      if (ability === Prize.ABILITY_PICKUP && truthy(species) && species !== 0
        && !(truthy(mon.isEgg) || truthy(mon.egg))
        && no_item(mon.item) && no_item(mon.heldItem)
        && lmod(random(), 10) === 0) {
        const r = lmod(random(), 100);
        let j = 1;
        while (j <= 15 && !(Prize.PICKUP_ITEMS[j][2] > r)) {
          j = j + 1;
        }
        const itemId = Prize.PICKUP_ITEMS[j][1];
        mon.item = itemId;
        mon.heldItem = itemId;
        picked[len(picked) + 1] = { slot: i, item: itemId };
      }
    }
  }
  return picked;
};

export default Prize;
