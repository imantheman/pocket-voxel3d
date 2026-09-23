// Fishing, ported from gen1recomp OverworldController.goFishing +
// FieldDefaults.FISHING (engine/items/item_effects.asm ItemUseOldRod /
// ItemUseGoodRod / ReadSuperRodData).
//
// The three rods are three different questions asked of the same water:
//
//   OLD ROD    always hooks a L5 MAGIKARP -- no roll at all
//   GOOD ROD   a fixed pair, GOLDEEN and POLIWAG at L10
//   SUPER ROD  the map's own group (field.superRod), 33 maps have one
//
// The bite odds are not a percentage anywhere in the ROM; they fall out of a
// rejection loop, so that is what this is. They come to size/(size+4): 1/3
// for the Good Rod's pair, up to 1/2 for a four-mon Super Rod group.

/** One hooked mon. */
export interface FishCatch {
  species: string;
  level: number;
}

/** ItemUseOldRod: no roll, no group -- it is MAGIKARP or the water is dry. */
export const OLD_ROD_CATCH: FishCatch = { species: "MAGIKARP", level: 5 };

/** data/wild/good_rod.asm, the one table every map shares. */
export const GOOD_ROD_POOL: FishCatch[] = [
  { species: "GOLDEEN", level: 10 },
  { species: "POLIWAG", level: 10 },
];

/** The three rods, in the order they are given out. */
export const RODS = ["OLD_ROD", "GOOD_ROD", "SUPER_ROD"] as const;
export type Rod = (typeof RODS)[number];

export function isRod(id: string): id is Rod {
  return id === "OLD_ROD" || id === "GOOD_ROD" || id === "SUPER_ROD";
}

/** The candidates this rod offers on this map, or [] for water it cannot fish. */
export function rodPool(data: any, rod: string, mapId: string): FishCatch[] {
  if (rod === "GOOD_ROD") return GOOD_ROD_POOL;
  if (rod === "SUPER_ROD") {
    const groups = data?.field?.superRod as Record<string, FishCatch[]> | undefined;
    return groups?.[mapId] ?? [];
  }
  return [];
}

/**
 * ItemUseGoodRod `.RandomLoop` / ReadSuperRodData: an ODD random byte is no
 * bite at all; an even one picks with two bits and rerolls when the pick
 * lands past the end of the group. `rand` returns 0..255, the byte the
 * original reads.
 */
export function rollFishingGroup(group: FishCatch[], rand: () => number): FishCatch | null {
  if (group.length === 0) return null;
  // The loop terminates with probability 1, but it is driven by a caller's
  // RNG: a stuck one (a test stub returning a constant even byte past the
  // group) would spin forever, so it gets a ceiling rather than the console.
  for (let guard = 0; guard < 64; guard++) {
    const r = rand() & 0xff;
    if (r % 2 === 1) return null;
    const pick = Math.floor(r / 2) % 4;
    if (pick < group.length) return { ...group[pick]! };
  }
  return null;
}

/** What comes out of the water, or null for "Not even a nibble!". */
export function fishingCatch(
  data: any,
  rod: string,
  mapId: string,
  rand: () => number,
): FishCatch | null {
  if (rod === "OLD_ROD") return { ...OLD_ROD_CATCH };
  return rollFishingGroup(rodPool(data, rod, mapId), rand);
}
