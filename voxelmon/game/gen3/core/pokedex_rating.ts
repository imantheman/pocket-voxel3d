// Port of gen1recomp src/core/game3/pokedex_rating.lua (GPLv3 + additional terms; see LICENSE.md).
// Professor Oak's Pokédex Rating Evaluation (pokefirered/src/prof_pc.c).
// Evaluates caught Pokémon count brackets, Mew exception, and triggers rating messages.
//
// Port notes:
// - No stub existed (stubs.py did not reach it); natives_size_record requires
//   it directly, so it is a plain static import there.
// - getRatingMessage returns Lua's two values as [key, isComplete];
//   getProfOaksRatingMessage returns [false, msg].

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber } from "../../../import/gen3/lua.ts";
import { Space } from "./scripting/space.ts";
import { Runtime } from "./runtime.ts";
import { Dex } from "./dex.ts";
import { Flags } from "./scripting/flags.ts";
import { RomText } from "./rom_text.ts";

const KANTO_DEX_COUNT = 151;
const SPECIES_MEW = 151;

// pokefirered/src/prof_pc.c:6-21
const RATING_MESSAGES = {
  LESS_THAN_10: "PokedexRating_Text_LessThan10",
  LESS_THAN_20: "PokedexRating_Text_LessThan20",
  LESS_THAN_30: "PokedexRating_Text_LessThan30",
  LESS_THAN_40: "PokedexRating_Text_LessThan40",
  LESS_THAN_50: "PokedexRating_Text_LessThan50",
  LESS_THAN_60: "PokedexRating_Text_LessThan60",
  LESS_THAN_70: "PokedexRating_Text_LessThan70",
  LESS_THAN_80: "PokedexRating_Text_LessThan80",
  LESS_THAN_90: "PokedexRating_Text_LessThan90",
  LESS_THAN_100: "PokedexRating_Text_LessThan100",
  LESS_THAN_110: "PokedexRating_Text_LessThan110",
  LESS_THAN_120: "PokedexRating_Text_LessThan120",
  LESS_THAN_130: "PokedexRating_Text_LessThan130",
  LESS_THAN_140: "PokedexRating_Text_LessThan140",
  LESS_THAN_150: "PokedexRating_Text_LessThan150",
  COMPLETE: "PokedexRating_Text_Complete",
};

// Lua: pokedex_rating.lua:30
function sessionOf(ctx: any): any {
  if (ctx && ctx.session) return ctx.session;
  // package.loaded["src.core.game3.scripting.space"]
  const S: any = Space;
  if (S && S.store && S.store.flags) return S.store;
  // package.loaded["src.core.game3.runtime"]
  const rt: any = Runtime;
  return (rt && rt.getSession && rt.getSession()) || undefined;
}

// Lua: pokedex_rating.lua:38
function dexOf(session: any, ctx: any): any {
  session = session || sessionOf(ctx);
  return (session && (session.dex || session.pokedex)) || undefined;
}

export const PokedexRating = {
  TEXT: RATING_MESSAGES,

  // Lua: pokedex_rating.lua:45
  /** pokefirered/src/prof_pc.c:38 GetProfOaksRatingMessageByCount
   *  Evaluates Pokédex count and returns: [messageText, isComplete] */
  getRatingMessage(countIn: any, dex: any): [string, boolean] {
    const count = tonumber(countIn) ?? 0;

    if (count < 10) return [RATING_MESSAGES.LESS_THAN_10, false];
    if (count < 20) return [RATING_MESSAGES.LESS_THAN_20, false];
    if (count < 30) return [RATING_MESSAGES.LESS_THAN_30, false];
    if (count < 40) return [RATING_MESSAGES.LESS_THAN_40, false];
    if (count < 50) return [RATING_MESSAGES.LESS_THAN_50, false];
    if (count < 60) return [RATING_MESSAGES.LESS_THAN_60, false];
    if (count < 70) return [RATING_MESSAGES.LESS_THAN_70, false];
    if (count < 80) return [RATING_MESSAGES.LESS_THAN_80, false];
    if (count < 90) return [RATING_MESSAGES.LESS_THAN_90, false];
    if (count < 100) return [RATING_MESSAGES.LESS_THAN_100, false];
    if (count < 110) return [RATING_MESSAGES.LESS_THAN_110, false];
    if (count < 120) return [RATING_MESSAGES.LESS_THAN_120, false];
    if (count < 130) return [RATING_MESSAGES.LESS_THAN_130, false];
    if (count < 140) return [RATING_MESSAGES.LESS_THAN_140, false];
    if (count < 150) return [RATING_MESSAGES.LESS_THAN_150, false];

    if (count === (KANTO_DEX_COUNT - 1)) { // 150
      // In pokefirered: Mew (151) does not count towards completing the 150 requirement.
      // If Mew is caught in Kanto Dex, the player has 149 regular + Mew = 150 total,
      // which means they haven't completed the 150 standard species yet!
      if (dex && Dex.isCaught(dex, SPECIES_MEW)) {
        return [RATING_MESSAGES.LESS_THAN_150, false];
      }
      return [RATING_MESSAGES.COMPLETE, true];
    }

    if (count >= KANTO_DEX_COUNT) { // 151
      return [RATING_MESSAGES.COMPLETE, true];
    }

    return [RATING_MESSAGES.LESS_THAN_10, false];
  },

  // Lua: pokedex_rating.lua:83
  /** pokefirered/src/prof_pc.c:106 GetProfOaksRatingMessage */
  getProfOaksRatingMessage(session: any, ctx: any, adapters: any): [false, string] {
    session = session || sessionOf(ctx);
    const scriptStore = (ctx && ctx.session) || session;

    const count = tonumber(Flags.getVar(scriptStore, ctx, 0x8004)) ?? 0;
    const dex = dexOf(session, ctx);
    const [key, isComplete] = PokedexRating.getRatingMessage(count, dex);
    const msg = RomText.box(key, ctx);

    Flags.setVar(scriptStore, ctx, 0x800D, isComplete ? 1 : 0);

    // ShowFieldMessage (pokefirered/src/field_message_box.c:65)
    if (ctx) {
      ctx.messageOpen = true;
      ctx.printerDone = false;
    }
    const open = adapters && (adapters.openMessageStay || adapters.openMessageAsync);
    if (open) {
      open(msg, undefined);
    } else if (adapters && adapters.openMessage) {
      adapters.openMessage(msg);
    }

    return [false, msg];
  },
};

export default PokedexRating;
