// Poké Mart stock. pokered carries each clerk's list on their text entry
// (data/items/marts.asm), the importer keeps it there, and the cooked
// gamedata ships it: text_pointers[<map label>][TEXT_*].mart. So the stock is
// READ from the dataset rather than restated here.
//
// It used to be a hand-copied table with two of the game's fourteen clerks in
// it, which is why every other shop was inert — the data for all of them was
// already in the pak, just never consulted. gen1recomp reads the same field
// (OverworldController.lua:2668 entry.mart / Commands.open_mart :852).
import type { ScriptRow } from "./script.ts";

/** The shape the lookup needs: the cooked text-pointer directory. */
export interface MartData {
  text_pointers?: Record<string, Record<string, { mart?: string[] } | undefined> | undefined>;
}

/**
 * The stock a clerk sells, or null when this (map, text) is not a mart clerk.
 *
 * `mapLabel` is the map's LABEL ("CeruleanMart"), which is how text_pointers
 * is keyed — the same key resolveText uses. Not the map id.
 */
export function martStock(
  data: MartData | undefined,
  mapLabel: string,
  textConst: string,
): string[] | null {
  const mart = data?.text_pointers?.[mapLabel]?.[textConst]?.mart;
  return Array.isArray(mart) && mart.length > 0 ? mart : null;
}

/**
 * The auto-open path (OverworldController.lua:2668): a clerk whose text entry
 * carries `.mart` and has no hand talk-script greets the player and opens the
 * shop. Composed as a script so it runs through the same runner as open_mart —
 * showMapText only falls to this when talkScript returns null, so a scripted
 * clerk (Viridian's parcel gate) still wins. Returns null for non-mart text.
 */
export function martGreetScript(
  data: MartData | undefined,
  mapLabel: string,
  textConst: string,
): ScriptRow[] | null {
  if (!martStock(data, mapLabel, textConst)) return null;
  return [
    ["face_player"],
    ["show_text", "Hi there!\nMay I help you?"], // _PokemartGreetingText
    ["open_mart", textConst],
  ];
}
