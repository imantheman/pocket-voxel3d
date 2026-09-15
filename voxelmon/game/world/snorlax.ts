// The two sleeping Snorlax (scripts/Route12.asm, Route16.asm).
//
// Each one sits in a one-cell gap: Route 12 blocks the way south to Fuchsia,
// Route 16 blocks Cycling Road. They are the only two land routes there, and
// the sea route needs SURF, which is handed out in Fuchsia -- so until a
// Snorlax moves, Fuchsia and everything past it (SURF, STRENGTH, the Soul
// Badge, Cinnabar, the Secret Key) is unreachable and the game cannot be
// finished. They shipped as plain STAY objects with a line of text.
//
// Waking one is ONLY done by using the POKé FLUTE from the bag while standing
// next to it (ItemUsePokeFlute). Talking to it with the flute in your pocket
// does nothing but repeat the sleeping line, which is what the original does
// -- Route12DefaultScript special-cases EVENT_FIGHT_ROUTE12_SNORLAX, and
// nothing but the item sets that.

/** One sleeper, and everything the flute needs to know about it. */
export interface SnorlaxSpot {
  map: string;
  /** The map object, so it can be hidden once it has moved on. */
  object: string;
  /** Set on any non-blackout result; a beaten Snorlax never comes back. */
  beatFlag: string;
  /** Talking to it while it sleeps. */
  sleepText: string;
  wokeText: string;
  /** Shown only when it was NOT caught -- it wandered off instead. */
  leftText: string;
}

/** Route 16's sleeping line is the unnamed _Route16Text7 in the ROM. */
export const SNORLAX: SnorlaxSpot[] = [
  {
    map: "ROUTE_12",
    object: "ROUTE12_SNORLAX",
    beatFlag: "EVENT_BEAT_ROUTE12_SNORLAX",
    sleepText: "_Route12SnorlaxText",
    wokeText: "_Route12SnorlaxWokeUpText",
    leftText: "_Route12SnorlaxCalmedDownText",
  },
  {
    map: "ROUTE_16",
    object: "ROUTE16_SNORLAX",
    beatFlag: "EVENT_BEAT_ROUTE16_SNORLAX",
    sleepText: "_Route16Text7",
    wokeText: "_Route16SnorlaxWokeUpText",
    leftText: "_Route16SnorlaxReturnedToMountainsText",
  },
];

/** The level it is fought at (data/trainers/parties.asm's wild encounter). */
export const SNORLAX_LEVEL = 30;

export function spotFor(mapId: string): SnorlaxSpot | undefined {
  return SNORLAX.find((s) => s.map === mapId);
}

interface Cell {
  cellX: number;
  cellY: number;
}

/**
 * The still-sleeping Snorlax the player is standing next to, if any.
 *
 * pokered tests the player's exact coordinates, one hard-coded pair per route.
 * Adjacency to the object itself comes to the same thing in both places and
 * does not rot if the map data is re-extracted.
 */
export function adjacentSnorlax(
  mapId: string,
  player: Cell,
  npcs: { def?: { name?: string } ; cellX: number; cellY: number }[],
  flags: Record<string, boolean> | undefined,
): { spot: SnorlaxSpot; npc: { cellX: number; cellY: number } } | null {
  const spot = spotFor(mapId);
  if (!spot) return null;
  // Already beaten: the flute plays, and nothing happens. Without this check a
  // save whose Snorlax is beaten but still on screen could re-fight it.
  if (flags?.[spot.beatFlag] === true) return null;
  for (const npc of npcs) {
    if (npc.def?.name !== spot.object) continue;
    const dx = Math.abs(npc.cellX - player.cellX);
    const dy = Math.abs(npc.cellY - player.cellY);
    if (dx + dy === 1) return { spot, npc };
  }
  return null;
}
