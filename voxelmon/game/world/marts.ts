// Poké Mart stock, ported from gen1recomp tools/rom_manifest.json — the
// `.mart` arrays cooked onto each clerk's text entry (pokered
// data/items/marts.asm), opened via src/ui/ShopMenu.lua. Keyed by interior map
// label -> clerk TEXT_* -> item id list, mirroring how the reference carries
// the list on the text entry (OverworldController.lua:2668 entry.mart /
// Commands.open_mart :852). Add a mart by copying its manifest block.
import type { ScriptRow } from "./script.ts";

export const MART_STOCK: Record<string, Record<string, string[]>> = {
  VIRIDIAN_MART: {
    TEXT_VIRIDIANMART_CLERK: ["POKE_BALL", "ANTIDOTE", "PARLYZ_HEAL", "BURN_HEAL"],
  },
  PEWTER_MART: {
    TEXT_PEWTERMART_CLERK: [
      "POKE_BALL",
      "POTION",
      "ESCAPE_ROPE",
      "ANTIDOTE",
      "BURN_HEAL",
      "AWAKENING",
      "PARLYZ_HEAL",
    ],
  },
};

/** The stock a clerk sells, or null when this (map, text) is not a mart clerk. */
export function martStock(mapLabel: string, textConst: string): string[] | null {
  return MART_STOCK[mapLabel]?.[textConst] ?? null;
}

/**
 * The auto-open path (OverworldController.lua:2668): a clerk whose text entry
 * carries `.mart` and has no hand talk-script greets the player and opens the
 * shop. Composed as a script so it runs through the same runner as open_mart —
 * showMapText only falls to this when talkScript returns null, so a scripted
 * clerk (Viridian's parcel gate) still wins. Returns null for non-mart text.
 */
export function martGreetScript(
  mapLabel: string,
  textConst: string,
): ScriptRow[] | null {
  if (!martStock(mapLabel, textConst)) return null;
  return [
    ["face_player"],
    ["show_text", "Hi there!\nMay I help you?"], // _PokemartGreetingText
    ["open_mart", textConst],
  ];
}
