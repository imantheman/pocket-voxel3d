// Port of gen1recomp src/core/game3/scripting/natives_gift.lua (GPLv3 + additional terms; see LICENSE.md).
// Mystery Gift specials: Wonder Card validation, card stats, Wonder News
// rewards, and the trywondercardscript delivery.
//
// Port notes:
// - Handlers return Lua's multiple returns as a 0-based tuple (see
//   natives.ts); Gift.obtainedLine returns [line, song] ([] for nil) and
//   Gift.runWonderCardScript returns [yield, ran].
// - NOT FAITHFUL: link deferred. Mystery gift is deferred and
//   core/mystery_gift.ts throws NotPortedError until it is ported. Brian's
//   handlers call it unguarded, so the script entry points (the three
//   specials and runWonderCardScript) take the offline path when it is not
//   ported: no Wonder Card or Wonder News saved (0 / NEWS_REWARD_NONE, and no
//   card script). Once mystery_gift.ts is ported the guard never fires.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ipairs, len, insert, concat, seq, type LuaTable } from "../../platform/lt.ts";
import { truthy, tonumber } from "../../../../import/gen3/lua.ts";
import { NotPortedError } from "../../notported.ts";
import Std from "./stdscripts.ts";
import RomText from "../rom_text.ts";
import MysteryGift from "../mystery_gift.ts";
import Flags from "./flags.ts";
import Runtime from "../runtime.ts";
import TextIR from "./text_ir.ts";
import Song from "../song_ids.ts";
import Strings from "../../shared/core/Strings.ts";
import Pokemon from "../pokemon.ts";
import ItemsData from "../items_data.ts";
import Audio from "../audio.ts";
import Natives, { type Handler, type HandlerRet } from "./natives.ts";

/** Lua's `a or b`. */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

// NOT FAITHFUL: link deferred (see the port notes): run `f`, or return the
// offline value when mystery_gift.ts is still a stub.
function offlineIfDeferred<T>(f: () => T, offline: T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof NotPortedError && e.what.startsWith("MysteryGift.")) return offline;
    throw e;
  }
}

// pokefirered/data/specials.inc:395
const SPECIAL_ValidateSavedWonderCard = 0x180;
// pokefirered/data/specials.inc:401
const SPECIAL_GetMysteryGiftCardStat = 0x186;
// pokefirered/data/specials.inc:404
const SPECIAL_WonderNews_GetRewardInfo = 0x189;

const VAR_RESULT = 0x800D; // pokefirered/include/constants/vars.h:328

// Lua: natives_gift.lua:16
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: natives_gift.lua:20
function sessionOf(): any {
  // package.loaded["src.core.game3.runtime"]
  const rt = Runtime;
  return lor(rt && rt.getSession && rt.getSession(), undefined);
}

// Lua: natives_gift.lua:26
function scriptStore(): any {
  return MysteryGift.scriptStore(sessionOf());
}

// Lua: natives_gift.lua:30
function varGet(ctx: any, id: number): number {
  return tonumber(flagsMod().getVar(scriptStore(), ctx, id)) ?? 0;
}

// Lua: natives_gift.lua:34
function varSet(ctx: any, id: number, value: any): void {
  flagsMod().setVar(scriptStore(), ctx, id, tonumber(value) ?? 0);
}

// Lua: natives_gift.lua:59
function textBox(ascii: string, adapters: any): string {
  const view: any = {};
  if (adapters) {
    view.playerName = typeof adapters.playerName === "function"
      ? adapters.playerName() : adapters.playerName;
  }
  return TextIR.toTextBox(TextIR.fromAscii(ascii), view);
}

const BY_NAME: Record<string, Handler> = {
  // Lua: natives_gift.lua:133
  // pokefirered/src/mystery_gift.c:180 ValidateSavedWonderCard
  ValidateSavedWonderCard: () => {
    return offlineIfDeferred((): HandlerRet =>
      [false, truthy(MysteryGift.validateSavedCard(sessionOf())) ? 1 : 0], [false, 0]);
  },
  // Lua: natives_gift.lua:137
  // pokefirered/src/field_specials.c:1955 GetMysteryGiftCardStat
  GetMysteryGiftCardStat: (ctx) => {
    return offlineIfDeferred((): HandlerRet =>
      [false, MysteryGift.getCardStatForScript(sessionOf(), varGet(ctx, VAR_RESULT))], [false, 0]);
  },
  // Lua: natives_gift.lua:141
  // pokefirered/src/wonder_news.c:68 WonderNews_GetRewardInfo
  WonderNews_GetRewardInfo: (ctx) => {
    return offlineIfDeferred((): HandlerRet => {
      const [rewardType, item] = MysteryGift.getNewsRewardInfo(sessionOf());
      if (truthy(item)) varSet(ctx, VAR_RESULT, item);
      return [false, rewardType];
    }, [false, 0]); // MysteryGift.NEWS_REWARD_NONE
  },
};

export const Gift = {
  // Lua: natives_gift.lua:24
  session: sessionOf,

  // Lua: natives_gift.lua:39
  // pokefirered/data/mystery_event_msg.s:244
  deliveryText(session: any, code: any): string {
    const card = MysteryGift.getSavedCard(session);
    const ctx = { playerName: (typeof session === "object" && session != null) ? lor(session.name, session.playerName) : undefined };
    const key = MysteryGift.deliveryTextKey(session, code, card);
    if (truthy(key)) return RomText.ascii(key, ctx);
    const lines: LuaTable = seq();
    for (const [, line] of ipairs<string>(lor(card && card.bodyText, {}))) {
      if (line !== "") lines[len(lines) + 1] = line;
    }
    if (len(lines) === 0) {
      return RomText.ascii(MysteryGift.fallbackTextKey(session, card), ctx);
    }
    // pokefirered/data/mystery_event_msg.s:303 sText_MysticTicket2
    const pages: LuaTable = seq();
    for (let i = 1; i <= len(lines); i += 2) {
      insert(pages, truthy(lines[i + 1]) ? (lines[i] + "\n" + lines[i + 1]) : lines[i]);
    }
    return concat(pages, "\\p");
  },

  // Lua: natives_gift.lua:68
  textBox,

  // Lua: natives_gift.lua:73
  obtainedLine(session: any, code: any): [string?, any?] {
    if (code !== MysteryGift.DELIVER_GIVEN) return [];
    const card = MysteryGift.getSavedCard(session);
    const gift = lor(card && card.gift, {} as any);
    const player = (typeof session === "object" && session != null) ? lor(lor(session.name, session.playerName), "") : "";
    if (gift.kind === "mon") {
      let ok = true;
      let name: any;
      try { name = Pokemon.name(tonumber(gift.species)); } catch (e) { ok = false; name = e; }
      // pokefirered/data/maps/CeladonCity_Condominiums_RoofRoom/scripts.inc:21
      return [Strings("%s obtained %s!", player, ok ? lor(name, "") : ""), Song.MUS_LEVEL_UP];
    } else if (gift.kind === "egg") {
      // pokefirered/data/mystery_event_msg.s:55
      return [Strings("%s received an EGG!", player), Song.MUS_OBTAIN_ITEM];
    } else if (gift.kind === "item") {
      const id = tonumber(gift.item);
      const key = ItemsData.pocketOf(id) === "KEY_ITEMS";
      return [Strings("%s obtained the %s!", player, ItemsData.displayName(id)), key ? Song.MUS_OBTAIN_KEY_ITEM : Song.MUS_OBTAIN_ITEM];
    }
    return [];
  },

  lastDelivery: undefined as any,
  lastObtained: undefined as string | undefined,

  // Lua: natives_gift.lua:97
  // pokefirered/src/scrcmd.c:275 ScrCmd_trywondercardscript
  runWonderCardScript(ctx: any, adapters: any): [boolean, boolean] {
    const session = sessionOf();
    // NOT FAITHFUL: link deferred (see the port notes).
    if (!offlineIfDeferred(() => truthy(MysteryGift.validateSavedCard(session)), false)) return [false, false];
    const code = MysteryGift.deliverGift(session);
    Gift.lastDelivery = code;
    const text = textBox(Gift.deliveryText(session, code), adapters);
    const [line, song] = Gift.obtainedLine(session, code);
    Gift.lastObtained = line;
    if (!(adapters && (truthy(adapters.openMessageAsync) || truthy(adapters.openMessage)))) {
      return [false, true];
    }
    const show = (msg: string, after: () => any): void => {
      if (truthy(adapters.openMessageAsync)) {
        adapters.openMessageAsync(msg, after);
      } else {
        adapters.openMessage(msg);
        after();
      }
    };
    const yld = Natives.yieldHost(ctx, adapters, (done) => {
      show(text, () => {
        if (!truthy(line)) return done();
        Audio.playFanfare(song);
        show(textBox(line!, adapters), () => {
          if (truthy(adapters.waitFanfare)) return adapters.waitFanfare(done);
          Audio.waitFanfare(done);
        });
      });
    });
    return [yld, true];
  },

  BY_NAME,
  /** Set by Std.legacyHandlers (stdscripts.lua:262): special id -> handler. */
  HANDLERS: undefined as Record<number, Handler> | undefined,

  SPECIAL_IDS: {
    ValidateSavedWonderCard: SPECIAL_ValidateSavedWonderCard,
    GetMysteryGiftCardStat: SPECIAL_GetMysteryGiftCardStat,
    WonderNews_GetRewardInfo: SPECIAL_WonderNews_GetRewardInfo,
  },
};
// Lua: natives_gift.lua:147
Std.legacyHandlers(Gift);

export default Gift;
