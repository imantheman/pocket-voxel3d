// PROF.OAK's POKéDEX rating (engine/events/pokedex_rating.asm DisplayDexRating),
// for Oak in his lab and PROF.OAK's PC.
//
//   _DexCompletionText   "POKéDEX comp- / letion is:" para "<seen> POKéMON
//                        seen / <owned> POKéMON owned" para "PROF.OAK's /
//                        Rating:"
//   DexRatingsTable      the first row whose cap is above the owned count:
//                        caps 10, 20 ... 150, then NUM_POKEMON + 1 -- so a
//                        line per ten, 150 and 151 sharing the last
//   PlayPokedexRatingSfx the jingle by owned count: OwnedMonValues 10, 40, 60,
//                        90, 120, 150 pick SFX_DENIED, POKEDEX_RATING,
//                        GET_ITEM_1, CAUGHT_MON, LEVEL_UP, GET_KEY_ITEM,
//                        GET_ITEM_2
//
// Seen and owned are counted over the whole dex, MEW included.

import { countOwned } from "./oaksaide.ts";

const RATING_KEYS: [number, string][] = [
  [10, "_DexRatingText_Own0To9"],
  [20, "_DexRatingText_Own10To19"],
  [30, "_DexRatingText_Own20To29"],
  [40, "_DexRatingText_Own30To39"],
  [50, "_DexRatingText_Own40To49"],
  [60, "_DexRatingText_Own50To59"],
  [70, "_DexRatingText_Own60To69"],
  [80, "_DexRatingText_Own70To79"],
  [90, "_DexRatingText_Own80To89"],
  [100, "_DexRatingText_Own90To99"],
  [110, "_DexRatingText_Own100To109"],
  [120, "_DexRatingText_Own110To119"],
  [130, "_DexRatingText_Own120To129"],
  [140, "_DexRatingText_Own130To139"],
  [150, "_DexRatingText_Own140To149"],
  [152, "_DexRatingText_Own150To151"],
];

const RATING_SFX: [number, string][] = [
  [10, "Denied"],
  [40, "Pokedex_Rating"],
  [60, "Get_Item1"],
  [90, "Caught_Mon"],
  [120, "Level_Up"],
  [150, "Get_Key_Item"],
  [152, "Get_Item2"],
];

function countSeen(save: { pokedex?: { seen?: Record<string, boolean> } }): number {
  const seen = save.pokedex?.seen ?? {};
  let n = 0;
  for (const k in seen) if (seen[k]) n += 1;
  return n;
}

export interface DexRating {
  seen: number;
  owned: number;
  /** _DexCompletionText, filled. */
  completion: string;
  /** The rating line. */
  rating: string;
  /** The jingle after it. */
  sfx: string;
}

export function dexRating(text: Record<string, string>, save: any): DexRating {
  const seen = countSeen(save);
  const owned = countOwned(save);
  const completion = (text._DexCompletionText ??
    "POKéDEX comp-\nletion is:\f{NUM:hDexRatingNumMonsSeen, 1, 3} POKéMON seen\n{NUM:hDexRatingNumMonsOwned, 1, 3} POKéMON owned\fPROF.OAK's\nRating:")
    .replace(/\{NUM:hDexRatingNumMonsSeen[^}]*\}/g, String(seen))
    .replace(/\{NUM:hDexRatingNumMonsOwned[^}]*\}/g, String(owned));
  const key = RATING_KEYS.find(([cap]) => owned < cap)?.[1] ?? RATING_KEYS[RATING_KEYS.length - 1]![1];
  const sfx = RATING_SFX.find(([cap]) => owned < cap)?.[1] ?? "Get_Item2";
  return { seen, owned, completion, rating: text[key] ?? "", sfx };
}
