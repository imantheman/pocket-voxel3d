// Oak's aides (engine/events/oaks_aide.asm), ported from gen1recomp
// story4.lua's oaksAide.
//
// One routine, three posts: each gate's script passes a species threshold and
// the reward it hands over. They check the DEX (species owned), not the party,
// and each gives its item once.

/** The three OaksAideScript call sites, in the order you meet them. */
export interface OaksAidePost {
  /** hOaksAideRequirement — kinds of POKéMON owned. */
  threshold: number;
  /** hOaksAideRewardItem. */
  item: string;
  /** The line he repeats forever after, explaining what he gave you. */
  repeatText: string;
}

export const OAKS_AIDES: Record<string, OaksAidePost> = {
  TEXT_ROUTE2GATE_OAKS_AIDE: {
    threshold: 10,
    item: "HM_FLASH",
    repeatText: "_Route2GateOaksAideFlashExplanationText",
  },
  TEXT_ROUTE11GATE2F_OAKS_AIDE: {
    threshold: 30,
    item: "ITEMFINDER",
    repeatText: "_Route11Gate2FOaksAideItemfinderDescriptionText",
  },
  TEXT_ROUTE15GATE2F_OAKS_AIDE: {
    threshold: 50,
    item: "EXP_ALL",
    repeatText: "_Route15Gate2FOaksAideExpAllText",
  },
};

/** The flag that records a post as paid out. */
export function oaksAideFlag(item: string): string {
  return `EVENT_GOT_${item}`;
}

/** Kinds of POKéMON owned — the dex tally he reads out, not the party. */
export function countOwned(save: { pokedex?: { owned?: Record<string, boolean> } }): number {
  const owned = save.pokedex?.owned ?? {};
  let n = 0;
  for (const k in owned) if (owned[k]) n += 1;
  return n;
}

/**
 * His lines carry {NUM:hOaksAide...} and {RAM:wOaksAideRewardItemName}, whose
 * spans can carry formatting flags after a comma. {PLAYER} is left alone —
 * the textbox substitutes that one itself.
 */
export function fillAideText(
  text: string, subs: { num?: number; item?: string },
): string {
  return text
    .replace(/\{NUM:[^}]*\}/g, () => String(subs.num ?? ""))
    .replace(/\{RAM:[^}]*\}/g, () => subs.item ?? "");
}
