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
