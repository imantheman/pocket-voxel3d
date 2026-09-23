// CELADON MART ROOF: the three vending machines and the thirsty little girl,
// ported from gen1recomp data/scripts/story4.lua (scripts/CeladonMartRoof.asm).
//
// The machines are SIGNS, not people -- three tiles with their own TEXT_*
// constants -- so they reach this file the same way a sign's text does, and
// the drinks they sell are the only source of the three TMs the girl trades
// for and the only way past the four Saffron gate guards (world/saffrongate.ts).

import type { ScriptRow } from "./script.ts";

/** VendingMachineText's list, in its order. Prices are the items' own. */
export const VENDING_DRINKS = ["FRESH_WATER", "SODA_POP", "LEMONADE"] as const;

/**
 * A machine. The whole interaction is the drink list, so the row opens it
 * straight away -- pokered prints no greeting either; the money box IS the
 * greeting.
 */
export function vendingRows(): ScriptRow[] {
  return [["open_vending"]];
}

/**
 * drink -> TM, the `.gaveFreshWater` / `.gaveSodaPop` / `.gaveLemonade`
 * branches of CeladonMartRoofScript_GiveDrinkToGirl. Each is once only, held
 * by its own event flag.
 */
const GIRL_TMS = [
  {
    drink: "FRESH_WATER",
    tm: "TM_ICE_BEAM",
    flag: "EVENT_GOT_TM13",
    yay: "_CeladonMartRoofLittleGirlYayFreshWaterText",
    received: "_CeladonMartRoofLittleGirlReceivedTM13Text",
    explain: "_CeladonMartRoofLittleGirlTM13ExplanationText",
  },
  {
    drink: "SODA_POP",
    tm: "TM_ROCK_SLIDE",
    flag: "EVENT_GOT_TM48",
    yay: "_CeladonMartRoofLittleGirlYaySodaPopText",
    received: "_CeladonMartRoofLittleGirlReceivedTM48Text",
    explain: "_CeladonMartRoofLittleGirlTM48ExplanationText",
  },
  {
    drink: "LEMONADE",
    tm: "TM_TRI_ATTACK",
    flag: "EVENT_GOT_TM49",
    yay: "_CeladonMartRoofLittleGirlYayLemonadeText",
    received: "_CeladonMartRoofLittleGirlReceivedTM49Text",
    explain: "_CeladonMartRoofLittleGirlTM49ExplanationText",
  },
] as const;

/**
 * The little girl (CeladonMartRoofLittleGirlText). Nothing to drink means the
 * thirsty line and no offer at all.
 *
 * The original opens a menu of the drinks you are carrying and trades the one
 * you pick; this asks about the first one whose TM is still unclaimed, in the
 * machines' own order. The same three TMs come out of the same three drinks
 * either way -- only the ORDER is forced when the bag holds more than one, and
 * a drink whose TM is already taken is passed over rather than wasted on her
 * "not thirsty after all" refusal.
 */
export function thirstyGirlRows(_ow: unknown, save: any): ScriptRow[] {
  const inv = save?.inventory ?? {};
  const flags = save?.flags ?? {};
  const g = GIRL_TMS.find((t) => (inv[t.drink] ?? 0) > 0 && !flags[t.flag]);
  if (!g) {
    return [
      ["face_player"],
      ["show_text", "_CeladonMartRoofLittleGirlImThirstyText"],
    ];
  }
  return [
    ["face_player"],
    ["ask", "_CeladonMartRoofLittleGirlGiveHerADrinkText"],
    ["jump_if_false", "end"],
    ["show_text", g.yay],
    // give BEFORE take: give_item is the one step that can refuse (a full
    // bag), and it ends the script when it does -- so a refusal must not
    // already have swallowed the drink.
    ["give_item", g.tm, 1, g.received],
    ["take_item", g.drink, 1],
    ["set_flag", g.flag],
    ["show_text", g.explain],
  ];
}
