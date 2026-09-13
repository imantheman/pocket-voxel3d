// The badge set as data. Ports gen1recomp src/inventory/Badges.lua: an
// ordered list of records where list position IS the badge number, read from
// data.constants.badges when the dataset carries one and falling back to the
// vanilla gym order otherwise (the imported Red/Blue data has no such
// constant, so the fallback is the live path today).
//
// Badges live in save.inventory alongside items — rules/bag.ts isBadge is
// what keeps them out of bag slots.

import type { VoxelmonData } from "../data.ts";

export interface BadgeEntry {
  id: string;
  name?: string;
  /** Inventory key, when it differs from the id. */
  item?: string;
}

/** Badges.lua:10-14 VANILLA — gym order. */
const VANILLA: BadgeEntry[] = [
  { id: "BOULDERBADGE" }, { id: "CASCADEBADGE" }, { id: "THUNDERBADGE" },
  { id: "RAINBOWBADGE" }, { id: "SOULBADGE" }, { id: "MARSHBADGE" },
  { id: "VOLCANOBADGE" }, { id: "EARTHBADGE" },
];

/** Badges.lua:16-20 list. */
export function list(data?: Pick<VoxelmonData, "constants">): BadgeEntry[] {
  const configured = (data?.constants as { badges?: BadgeEntry[] } | undefined)?.badges;
  if (Array.isArray(configured) && configured.length > 0) return configured;
  return VANILLA;
}

/** Badges.lua:24-26 itemFor — the inventory key a badge is stored under. */
export function itemFor(entry: BadgeEntry): string {
  return entry.item ?? entry.id;
}

/**
 * The name to print. The item id doubles as the ROM name ("BOULDERBADGE"),
 * so the trailing BADGE is dropped — the card's grid labels each slot with
 * the gym's badge, and "BOULDER" is how the original's text refers to it.
 */
export function label(entry: BadgeEntry): string {
  const name = entry.name ?? entry.id;
  return name.endsWith("BADGE") && name.length > 5 ? name.slice(0, -5) : name;
}

/** Badges.lua:28-37 count. */
export function count(
  data: Pick<VoxelmonData, "constants"> | undefined,
  save: { inventory?: Record<string, number> } | undefined,
): number {
  const inv = save?.inventory;
  if (!inv) return 0;
  let n = 0;
  for (const entry of list(data)) {
    if (inv[itemFor(entry)]) n += 1;
  }
  return n;
}
