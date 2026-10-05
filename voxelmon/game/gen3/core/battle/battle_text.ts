// Port of gen1recomp src/core/game3/battle/battle_text.lua (GPLv3 + additional terms; see LICENSE.md).
// src/battle_message.c:1523 BufferStringBattle, :1829 BattleStringExpandPlaceholders
//
// Port notes:
// - Multiple returns are 0-based tuples: BattleText.key -> [key, fill] on
//   every path; the local special() -> [key] or [key, fillCopy].
// - BattleText.context's lazily-resolving `battle` table (a metatable
//   __index + rawset cache) is a Proxy: TextIR reads `ctx.battle[seg.code]`,
//   and the integer code arrives as a string property key, so it is turned
//   back into a number. Symbol keys read undefined; any other key throws,
//   as Lua's __index would.
// - error(msg, 0) becomes a thrown Error (no position prefix either way).
// - Lazy requires (state, pokemon, items_data, profile, versions) are static
//   imports.
// - Link / union room / tower branches are only selected by fill flags Brian
//   passes; they pick a string key and need nothing deferred, so they stay.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { format, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { pairs } from "../../platform/lt.ts";
import TextIR from "../scripting/text_ir.ts";
import RomText from "../rom_text.ts";
import State from "./state.ts";
import Pokemon from "../pokemon.ts";
import ItemsData from "../items_data.ts";
import BattleProfile from "./profile.ts";
import { Versions } from "../../../../import/gen3/versions.ts";

type Fill = Record<string, any>;
type Resolver = (f: Fill) => any;

export interface BattleTextContext {
  battle: Record<number, any>;
  stringVars: any;
  playerName: any;
  rivalName: any;
  maxWidth: any;
}

export interface BattleTextModule {
  INTROMSG: number;
  INTROSENDOUT: number;
  RETURNMON: number;
  SWITCHINMON: number;
  USEDMOVE: number;
  BATTLEEND: number;
  MOVES_COUNT: number;
  RESOLVE_RSE: Record<number, Resolver>;
  RESOLVE: Record<number, Resolver>;
  context(fill?: Fill | null): BattleTextContext;
  key(id: any, fill?: Fill | null): [any, Fill];
  ir(id: any, fill?: Fill | null): any;
  get(id: any, fill?: Fill | null): string;
  expand(id: any, fill?: Fill | null): string;
}

export const BattleText = {} as BattleTextModule;

// include/constants/battle_string_ids.h:4-9
BattleText.INTROMSG = 0;
BattleText.INTROSENDOUT = 1;
BattleText.RETURNMON = 2;
BattleText.SWITCHINMON = 3;
BattleText.USEDMOVE = 4;
BattleText.BATTLEEND = 5;
// include/constants/moves.h:360
BattleText.MOVES_COUNT = 355;

const SPECIAL: Record<string, number> = {
  STRINGID_INTROMSG: 0, STRINGID_INTROSENDOUT: 1, STRINGID_RETURNMON: 2,
  STRINGID_SWITCHINMON: 3, STRINGID_USEDMOVE: 4, STRINGID_BATTLEEND: 5,
};

// Lua: battle_text.lua:23
function need(fill: Fill, field: string, code: number): any {
  const v = fill[field];
  if (v == null) {
    throw new Error(format("battle text {%s} needs fill.%s", TextIR.B_TXT[code] ?? tostring(code), field));
  }
  return v;
}

// Lua: battle_text.lua:31
function isPlayer(ref: any): boolean {
  const side = (ref !== null && typeof ref === "object" && truthy(ref.side)) ? ref.side : ref;
  return side === "player" || side === 0;
}

// Lua: battle_text.lua:36
function monName(ref: any): any {
  if (typeof ref === "string") return ref;
  if (truthy(ref.name)) return ref.name;
  // require("src.core.game3.battle.state")
  return State.displayName(ref);
}

// src/battle_message.c:1807 HANDLE_NICKNAME_STRING_CASE
// Lua: battle_text.lua:43
function withPrefix(fill: Fill, ref: any): string {
  if (isPlayer(ref)) return monName(ref);
  const prefix = truthy(fill.trainer) ? "sText_FoePkmnPrefix" : "sText_WildPkmnPrefix";
  return RomText.plain(prefix) + monName(ref);
}

// Lua: battle_text.lua:49
function moveName(fill: Fill, move: any): string {
  if (typeof move === "string") return move;
  if (move >= BattleText.MOVES_COUNT) {
    return RomText.plain(RomText.key("sATypeMove_Table", need(fill, "moveType", 0x14)));
  }
  // require("src.core.game3.pokemon")
  return Pokemon.moveName(move);
}

// Lua: battle_text.lua:57
function abilityName(ability: any): string {
  if (typeof ability === "string") return ability;
  // require("src.core.game3.pokemon")
  return Pokemon.abilityName(ability);
}

// Lua: battle_text.lua:62
function itemName(item: any): string {
  if (typeof item === "string") return item;
  // require("src.core.game3.items_data")
  return ItemsData.displayName(item);
}

// Lua: battle_text.lua:67
function prefix(fill: Fill, field: string, code: number, ally: string, foe: string): string {
  return RomText.plain(isPlayer(need(fill, field, code)) ? ally : foe);
}

const RESOLVE: Record<number, Resolver> = {
  [0x00]: (f) => need(f, "buff1", 0x00),
  [0x01]: (f) => need(f, "buff2", 0x01),
  [0x30]: (f) => need(f, "buff3", 0x30),
  [0x02]: (f) => need(f, "stringVars", 0x02)[1],
  [0x03]: (f) => need(f, "stringVars", 0x03)[2],
  [0x04]: (f) => need(f, "stringVars", 0x04)[3],
  [0x05]: (f) => monName(need(f, "playerMon1", 0x05)),
  [0x06]: (f) => monName(need(f, "opponentMon1", 0x06)),
  [0x07]: (f) => monName(need(f, "playerMon2", 0x07)),
  [0x08]: (f) => monName(need(f, "opponentMon2", 0x08)),
  [0x09]: (f) => monName(need(f, "linkPlayerMon1", 0x09)),
  [0x0A]: (f) => monName(need(f, "linkOpponentMon1", 0x0A)),
  [0x0B]: (f) => monName(need(f, "linkPlayerMon2", 0x0B)),
  [0x0C]: (f) => monName(need(f, "linkOpponentMon2", 0x0C)),
  [0x0D]: (f) => withPrefix(f, need(f, "atkMon1", 0x0D)),
  [0x0E]: (f) => monName(need(f, "atkPartner", 0x0E)),
  [0x0F]: (f) => withPrefix(f, need(f, "atk", 0x0F)),
  [0x10]: (f) => withPrefix(f, need(f, "def", 0x10)),
  [0x11]: (f) => withPrefix(f, need(f, "eff", 0x11)),
  [0x12]: (f) => withPrefix(f, need(f, "active", 0x12)),
  [0x13]: (f) => withPrefix(f, need(f, "scrActive", 0x13)),
  [0x14]: (f) => moveName(f, need(f, "currentMove", 0x14)),
  [0x15]: (f) => moveName(f, need(f, "lastMove", 0x15)),
  [0x16]: (f) => itemName(need(f, "lastItem", 0x16)),
  [0x17]: (f) => abilityName(need(f, "lastAbility", 0x17)),
  [0x18]: (f) => abilityName(need(f, "atkAbility", 0x18)),
  [0x19]: (f) => abilityName(need(f, "defAbility", 0x19)),
  [0x1A]: (f) => abilityName(need(f, "scrActiveAbility", 0x1A)),
  [0x1B]: (f) => abilityName(need(f, "effAbility", 0x1B)),
  [0x1C]: (f) => {
    const cls = need(f, "trainer1Class", 0x1C);
    if (typeof cls === "string") return cls;
    return RomText.plain(RomText.key("gTrainerClassNames", cls));
  },
  [0x1D]: (f) => need(f, "trainer1Name", 0x1D),
  [0x1E]: (f) => need(f, "linkPlayerName", 0x1E),
  [0x1F]: (f) => need(f, "linkPartnerName", 0x1F),
  [0x20]: (f) => need(f, "linkOpponent1Name", 0x20),
  [0x21]: (f) => need(f, "linkOpponent2Name", 0x21),
  [0x22]: (f) => need(f, "linkScrTrainerName", 0x22),
  [0x23]: (f) => need(f, "playerName", 0x23),
  [0x24]: (f) => need(f, "trainer1LoseText", 0x24),
  [0x25]: (f) => need(f, "trainer1WinText", 0x25),
  [0x26]: (f) => withPrefix(f, need(f, "scrActivePartyMon", 0x26)),
  [0x27]: (f) => {
    return RomText.plain(truthy(need(f, "billsPc", 0x27)) ? "sText_Bills" : "sText_Someones");
  },
  [0x28]: (f) => prefix(f, "atk", 0x28, "sText_AllyPkmnPrefix", "sText_FoePkmnPrefix2"),
  [0x29]: (f) => prefix(f, "def", 0x29, "sText_AllyPkmnPrefix", "sText_FoePkmnPrefix2"),
  [0x2A]: (f) => prefix(f, "atk", 0x2A, "sText_AllyPkmnPrefix2", "sText_FoePkmnPrefix3"),
  [0x2B]: (f) => prefix(f, "def", 0x2B, "sText_AllyPkmnPrefix2", "sText_FoePkmnPrefix3"),
  [0x2C]: (f) => prefix(f, "atk", 0x2C, "sText_AllyPkmnPrefix3", "sText_FoePkmnPrefix4"),
  [0x2D]: (f) => prefix(f, "def", 0x2D, "sText_AllyPkmnPrefix3", "sText_FoePkmnPrefix4"),
  [0x2E]: (f) => need(f, "trainer2LoseText", 0x2E),
  [0x2F]: (f) => need(f, "trainer2WinText", 0x2F),
};

// Lua: battle_text.lua:129
function class_name(cls: any): string {
  if (typeof cls === "string") return cls;
  return RomText.plain(RomText.key("gTrainerClassNames", cls));
}

// pokeemerald/include/battle_message.h:57
const RESOLVE_RSE: Record<number, Resolver> = {};
for (const [code, fn] of pairs<Resolver>(RESOLVE)) {
  if ((code as number) <= 0x2D) RESOLVE_RSE[code as number] = fn;
}
// pokeemerald/src/battle_message.c:2631
RESOLVE_RSE[0x27] = (f) => {
  return RomText.plain(truthy(need(f, "lanettePc", 0x27)) ? "sText_Lanettes" : "sText_Someones");
};
RESOLVE_RSE[0x2E] = (f) => class_name(need(f, "trainer2Class", 0x2E));
RESOLVE_RSE[0x2F] = (f) => need(f, "trainer2Name", 0x2F);
RESOLVE_RSE[0x30] = (f) => need(f, "trainer2LoseText", 0x30);
RESOLVE_RSE[0x31] = (f) => need(f, "trainer2WinText", 0x31);
RESOLVE_RSE[0x32] = (f) => class_name(need(f, "partnerClass", 0x32));
RESOLVE_RSE[0x33] = (f) => need(f, "partnerName", 0x33);
RESOLVE_RSE[0x34] = (f) => need(f, "buff3", 0x34);
BattleText.RESOLVE_RSE = RESOLVE_RSE;
BattleText.RESOLVE = RESOLVE;

const INT_KEY = /^-?\d+$/;

// Lua: battle_text.lua:153
BattleText.context = function (fillIn?: Fill | null): BattleTextContext {
  const fill: Fill = fillIn ?? {};
  let codes = RESOLVE;
  // require("src.core.game3.battle.profile")
  if (BattleProfile.get().family === "rse") codes = RESOLVE_RSE;
  const cache: Record<string, any> = {};
  const values = new Proxy(cache, {
    get(t, k) {
      if (typeof k !== "string") return undefined;
      // rawget first: a value resolved earlier
      if (t[k] != null) return t[k];
      const code: number | string = INT_KEY.test(k) ? Number(k) : k;
      const resolve = codes[code as number];
      if (resolve == null) {
        throw new Error("battle text placeholder code " + tostring(code) + " is not a B_TXT id");
      }
      const v = resolve(fill);
      t[k] = v; // rawset(t, code, v)
      return v;
    },
  });
  return { battle: values, stringVars: fill.stringVars, playerName: fill.playerName,
    rivalName: fill.rivalName, maxWidth: fill.maxWidth };
};

// src/battle_message.c:1551-1766
// Lua: battle_text.lua:173
function special(id: number, fill: Fill): [string | undefined, Fill?] {
  if (id === 0) {
    if (truthy(fill.trainer)) {
      // pokeemerald/src/battle_message.c:1991
      if (truthy(fill.towerLinkMulti)) return ["sText_TwoTrainersWantToBattle"];
      if (truthy(fill.link)) {
        if (truthy(fill.multi)) return ["sText_TwoLinkTrainersWantToBattle"];
        return [truthy(fill.unionRoom) ? "sText_Trainer1WantsToBattle" : "sText_LinkTrainerWantsToBattle"];
      }
      // pokeemerald/src/battle_message.c:2016
      if (truthy(fill.twoOpponents)) return ["sText_TwoTrainersWantToBattle"];
      return ["sText_Trainer1WantsToBattle"];
    }
    if (truthy(fill.ghost)) {
      return [truthy(fill.ghostUnveiled) ? "sText_TheGhostAppeared" : "sText_GhostAppearedCantId"];
    } else if (truthy(fill.legendary)) {
      // require("src.core.game3.battle.profile")
      return [BattleProfile.get().strings.legendaryIntro];
    } else if (truthy(fill.double)) {
      return ["sText_TwoWildPkmnAppeared"];
    } else if (truthy(fill.oldMan) || truthy(fill.wally)) {
      return ["sText_WildPkmnAppearedPause"];
    }
    return ["sText_WildPkmnAppeared"];
  } else if (id === 1) {
    if (isPlayer(need(fill, "side", 0))) {
      if (truthy(fill.double)) {
        // pokeemerald/src/battle_message.c:2039
        if (truthy(fill.inGamePartner)) return ["sText_InGamePartnerSentOutZGoN"];
        return [truthy(fill.multi) ? "sText_LinkPartnerSentOutPkmnGoPkmn" : "sText_GoTwoPkmn"];
      }
      return ["sText_GoPkmn"];
    }
    if (truthy(fill.double)) {
      // pokeemerald/src/battle_message.c:2057
      if (truthy(fill.twoOpponents) && !truthy(fill.link)) return ["sText_TwoTrainersSentPkmn"];
      // pokeemerald/src/battle_message.c:2059
      if (truthy(fill.towerLinkMulti)) return ["sText_TwoTrainersSentPkmn"];
      if (truthy(fill.multi)) return ["sText_TwoLinkTrainersSentOutPkmn"];
      return [truthy(fill.link) ? "sText_LinkTrainerSentOutTwoPkmn" : "sText_Trainer1SentOutTwoPkmn"];
    }
    if (!truthy(fill.link) || truthy(fill.unionRoom)) return ["sText_Trainer1SentOutPkmn"];
    return ["sText_LinkTrainerSentOutPkmn"];
  } else if (id === 2) {
    if (isPlayer(need(fill, "side", 0))) {
      const scale = need(fill, "hpScale", 0);
      if (scale === 0) return ["sText_PkmnThatsEnough"];
      if (scale === 1 || truthy(fill.double)) return ["sText_PkmnComeBack"];
      if (scale === 2) return ["sText_PkmnOkComeBack"];
      return ["sText_PkmnGoodComeBack"];
    }
    if (truthy(fill.linkOpponent)) {
      return [truthy(fill.multi) ? "sText_LinkTrainer2WithdrewPkmn" : "sText_LinkTrainer1WithdrewPkmn"];
    }
    return ["sText_Trainer1WithdrewPkmn"];
  } else if (id === 3) {
    if (isPlayer(need(fill, "side", 0))) {
      const scale = need(fill, "hpScale", 0);
      if (scale === 0 || truthy(fill.double)) return ["sText_GoPkmn2"];
      if (scale === 1) return ["sText_DoItPkmn"];
      if (scale === 2) return ["sText_GoForItPkmn"];
      return ["sText_YourFoesWeakGetEmPkmn"];
    }
    if (truthy(fill.towerLinkMulti)) {
      // pokeemerald/src/battle_message.c:2122
      return [fill.switchBattler === 1 ? "sText_Trainer1SentOutPkmn2" : "sText_Trainer2SentOutPkmn"];
    }
    if (truthy(fill.link)) {
      if (truthy(fill.multi)) return ["sText_LinkTrainerMultiSentOutPkmn"];
      return [truthy(fill.unionRoom) ? "sText_Trainer1SentOutPkmn2" : "sText_LinkTrainerSentOutPkmn2"];
    }
    // pokeemerald/src/battle_message.c:2141
    if (truthy(fill.twoOpponents) && fill.switchBattler === 3) return ["sText_Trainer2SentOutPkmn"];
    return ["sText_Trainer1SentOutPkmn2"];
  } else if (id === 4) {
    const copy: Fill = {};
    for (const [k, v] of pairs(fill)) copy[k] = v;
    copy.buff2 = moveName(fill, need(fill, "currentMove", 0x14)) + RomText.plain("sText_ExclamationMark");
    return ["sText_AttackerUsedX", copy];
  } else if (id === 5) {
    const outcome = need(fill, "outcome", 0);
    if (truthy(fill.linkRan)) {
      if (outcome === "lost" || outcome === "drew") return ["sText_GotAwaySafely"];
      if (truthy(fill.multi)) return ["sText_TwoWildFled"];
      return [truthy(fill.unionRoom) ? "sText_Trainer1Fled" : "sText_WildFled"];
    }
    if (truthy(fill.towerLinkMulti) && outcome === "won") {
      // pokeemerald/src/battle_message.c:2190
      return ["sText_TwoInGameTrainersDefeated"];
    }
    if (truthy(fill.multi)) {
      return [({ won: "sText_TwoLinkTrainersDefeated", lost: "sText_PlayerLostToTwo",
        drew: "sText_PlayerBattledToDrawVsTwo" } as Record<string, string>)[outcome]];
    } else if (truthy(fill.unionRoom)) {
      return [({ won: "sText_PlayerDefeatedLinkTrainerTrainer1", lost: "sText_PlayerLostAgainstTrainer1",
        drew: "sText_PlayerBattledToDrawTrainer1" } as Record<string, string>)[outcome]];
    }
    return [({ won: "sText_PlayerDefeatedLinkTrainer", lost: "sText_PlayerLostAgainstLinkTrainer",
      drew: "sText_PlayerBattledToDrawLinkTrainer" } as Record<string, string>)[outcome]];
  }
  return [undefined];
}

// Lua: battle_text.lua:274
BattleText.key = function (idIn: any, fillIn?: Fill | null): [any, Fill] {
  const fill: Fill = fillIn ?? {};
  let id = idIn;
  if (typeof id === "string" && SPECIAL[id] != null) id = SPECIAL[id];
  if (typeof id === "number") {
    if (id < 12) {
      const [key, over] = special(id, fill);
      if (!truthy(key)) throw new Error("battle string id " + tostring(id) + " has no text for this battle");
      return [key, over ?? fill];
    }
    // require("src.import.gba.versions")
    const k = Versions.BATTLE_STRING_IDS[id];
    if (!truthy(k)) throw new Error("no battle string id " + tostring(id));
    return [k, fill];
  }
  return [id, fill];
};

// Lua: battle_text.lua:288
BattleText.ir = function (id: any, fill?: Fill | null): any {
  const key = BattleText.key(id, fill)[0];
  return RomText.ir(key);
};

// Lua: battle_text.lua:293
BattleText.get = function (id: any, fill?: Fill | null): string {
  const [key, f] = BattleText.key(id, fill);
  const ctx = BattleText.context(f);
  return TextIR.toAscii(RomText.translate(RomText.ir(key), ctx, key), ctx);
};

BattleText.expand = BattleText.get;

export default BattleText;
