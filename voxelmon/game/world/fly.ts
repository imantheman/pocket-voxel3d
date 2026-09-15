// HM02 FLY: where you can fly to, and which of those you have earned.
//
// Every piece of the data was already extracted and sitting unused —
// field.flyWarps has the landing cell for each destination, field.flyOrder is
// pokered's SpecialWarpTable order, and field.townMap.locations has the names
// to show. What was missing was the move itself, its giver, and any record of
// which towns you have actually been to.
//
// pokered gates the list on wTownVisitedFlag, set when you enter a town for
// the first time (engine/overworld/special_warps.asm). There was no such
// record here, so this module owns it: MAP_IDS is the destination list, and
// `visit` marks one as the player arrives.

/** A place FLY can take you, with the cell it lands on. */
export interface FlyDest {
  map: string;
  name: string;
  x: number;
  y: number;
}

interface FlyField {
  flyWarps?: Record<string, { x: number; y: number }>;
  flyOrder?: string[];
  townMap?: { locations?: Record<string, { name?: string }> };
}

interface FlySave {
  visited?: Record<string, boolean>;
  flags?: Record<string, boolean>;
  inventory?: Record<string, number>;
  hallOfFame?: unknown[];
}

/**
 * The eleven fly destinations, in the original's menu order (flyOrder's town
 * run — the entries either side of it are the Seafoam and Mansion dungeon
 * drops, which share SpecialWarpTable but are not places you fly to).
 *
 * Hard-coded as a list rather than sliced out of flyOrder by index, because
 * an index range into extracted data is exactly the kind of thing that breaks
 * silently when the extractor changes.
 */
export const FLY_MAP_IDS = [
  "PALLET_TOWN",
  "VIRIDIAN_CITY",
  "PEWTER_CITY",
  "CERULEAN_CITY",
  "LAVENDER_TOWN",
  "VERMILION_CITY",
  "CELADON_CITY",
  "FUCHSIA_CITY",
  "CINNABAR_ISLAND",
  "INDIGO_PLATEAU",
  "SAFFRON_CITY",
] as const;

/** Is this map somewhere FLY lands? Then arriving there should be recorded. */
export function isFlyDest(mapId: string): boolean {
  return (FLY_MAP_IDS as readonly string[]).includes(mapId);
}

/**
 * Remember that the player has been here, so it can be flown to later.
 * Returns true when this was the first visit, which is the only time the
 * record changes.
 */
export function visit(save: FlySave, mapId: string): boolean {
  if (!isFlyDest(mapId)) return false;
  const seen = (save.visited ??= {});
  if (seen[mapId]) return false;
  seen[mapId] = true;
  return true;
}

/** Has the player been to this town? */
export function hasVisited(save: FlySave, mapId: string): boolean {
  return save.visited?.[mapId] === true;
}

/**
 * The destinations to offer: visited towns, minus the one being stood on —
 * pokered greys out the current town rather than flying you to your own feet.
 */
export function flyDestinations(
  field: FlyField | undefined,
  save: FlySave,
  currentMap?: string,
): FlyDest[] {
  const warps = field?.flyWarps ?? {};
  const names = field?.townMap?.locations ?? {};
  const out: FlyDest[] = [];
  for (const map of FLY_MAP_IDS) {
    if (map === currentMap) continue;
    if (!hasVisited(save, map)) continue;
    const w = warps[map];
    if (!w) continue;
    out.push({ map, name: names[map]?.name ?? map.replace(/_/g, " "), x: w.x, y: w.y });
  }
  return out;
}

/**
 * What a save already proves about where its player has been.
 *
 * `visited` did not exist before FLY did, so every save made before it -- and
 * the champion runs among them -- comes back with an empty destination list
 * and has to re-walk Kanto to earn back towns it has plainly already seen.
 * These are the receipts: a badge is only handed over in its own city, and
 * each of the three towns without a gym has a flag that is only set there.
 *
 * Conservative on purpose. Nothing here marks a town on a guess, because a
 * wrongly-offered destination flies the player somewhere they have no business
 * being; a missing one costs them one walk and then fixes itself on arrival.
 */
const VISIT_EVIDENCE: { map: string; item?: string; flags?: string[] }[] = [
  // the gym badges, each earned in the city that hands it over
  { map: "PEWTER_CITY", item: "BOULDERBADGE" },
  { map: "CERULEAN_CITY", item: "CASCADEBADGE" },
  { map: "VERMILION_CITY", item: "THUNDERBADGE" },
  { map: "CELADON_CITY", item: "RAINBOWBADGE" },
  { map: "FUCHSIA_CITY", item: "SOULBADGE" },
  { map: "SAFFRON_CITY", item: "MARSHBADGE" },
  { map: "CINNABAR_ISLAND", item: "VOLCANOBADGE" },
  { map: "VIRIDIAN_CITY", item: "EARTHBADGE" },
  // Pallet: the starter is only handed out in Oak's lab, and the parcel
  // errand proves Viridian as well
  { map: "PALLET_TOWN", flags: ["EVENT_GOT_STARTER", "EVENT_GOT_TOWN_MAP"] },
  { map: "VIRIDIAN_CITY", flags: ["EVENT_GOT_OAKS_PARCEL", "EVENT_OAK_GOT_PARCEL"] },
  // Lavender: the tower and Mr Fuji are the only source of either of these
  {
    map: "LAVENDER_TOWN",
    flags: ["EVENT_GOT_POKE_FLUTE", "EVENT_RESCUED_MR_FUJI", "EVENT_BEAT_GHOST_MAROWAK"],
  },
];

/**
 * Give a save the visit record it never kept. Only ever ADDS, so it is safe to
 * run on every load and safe to run over a save that already has one.
 *
 * Returns the towns it filled in, which is what the test asserts on.
 */
export function backfillVisited(save: FlySave): string[] {
  const inv = save.inventory ?? {};
  const flags = save.flags ?? {};
  const added: string[] = [];
  const mark = (map: string): void => {
    if (hasVisited(save, map)) return;
    (save.visited ??= {})[map] = true;
    added.push(map);
  };
  for (const e of VISIT_EVIDENCE) {
    if (e.item && (inv[e.item] ?? 0) > 0) mark(e.map);
    if (e.flags?.some((f) => flags[f] === true)) mark(e.map);
  }
  // A champion has stood on the plateau by definition.
  if ((save.hallOfFame?.length ?? 0) > 0 || flags.EVENT_BEAT_CHAMPION_RIVAL === true) {
    mark("INDIGO_PLATEAU");
  }
  return added;
}
