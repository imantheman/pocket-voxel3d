// Route 23's badge checks (scripts/Route23.asm).
//
// Seven guards stand across the road up to Victory Road, and each one wants a
// different badge before it will let you past -- CASCADE first, then THUNDER,
// RAINBOW, SOUL, MARSH, VOLCANO and finally EARTH at the top. Walking the
// whole road therefore requires all eight gyms, which is what makes the
// Pokémon League an earned destination rather than a place you can stroll to
// on your first afternoon.
//
// field.badgeGates was extracted long ago and read by nothing, so every guard
// stood there silently and let anyone through.

export interface BadgeGuard {
  /** Inventory key of the badge this one wants. */
  badge: string;
  /** Set once passed, so a guard only ever asks once. */
  event: string;
  /** The row the check fires on. */
  y: number;
  /** Some checks only cover part of the road's width. */
  maxX?: number;
  /** Object index, for facing them. */
  sprite?: number;
}

interface BadgeGateField {
  badgeGates?: Record<string, {
    guards?: BadgeGuard[];
    failText?: string;
    passText?: string;
  }>;
}

interface GateSave {
  flags?: Record<string, boolean>;
  inventory?: Record<string, number>;
}

/** The gate on this map, if it has one. */
export function gateFor(field: BadgeGateField | undefined, mapId: string) {
  return field?.badgeGates?.[mapId];
}

/**
 * The guard whose row the player has just stepped onto and who has not been
 * satisfied yet, or null.
 *
 * pokered fires these as coord events across the row, so the check is by row
 * rather than by standing next to the sprite -- there is no walking around a
 * guard on a road this wide.
 */
export function guardAt(
  field: BadgeGateField | undefined,
  save: GateSave,
  mapId: string,
  x: number,
  y: number,
): BadgeGuard | null {
  const gate = gateFor(field, mapId);
  for (const g of gate?.guards ?? []) {
    if (g.y !== y) continue;
    if (g.maxX !== undefined && x > g.maxX) continue;
    if (save.flags?.[g.event] === true) continue;
    return g;
  }
  return null;
}

/** Does the player hold what this guard is asking for? */
export function hasBadge(save: GateSave, guard: BadgeGuard): boolean {
  return (save.inventory?.[guard.badge] ?? 0) > 0;
}

/** Both lines name the badge in wNameBuffer. */
export function fillBadgeName(text: string, badge: string): string {
  return text.replace(/\{RAM:\w+\}/g, badge);
}
