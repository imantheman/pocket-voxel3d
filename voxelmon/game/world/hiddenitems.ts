// Hidden items and hidden coins (engine/events/hidden_items.asm), ported
// from gen1recomp OverworldController's hidden-event pass and its
// hasHiddenItemLeft (engine/items/itemfinder.asm HiddenItemNear).
//
// Thirty-nine items lie under rocks, behind statues and in corners with no
// ball to see; pressing A on the tile finds one. field.hiddenItems and
// field.hiddenCoins carry them per map, straight from the ROM's table, and
// save.hiddenTaken remembers the ones already picked up, by map and cell.

export interface HiddenSave {
  hiddenTaken?: Record<string, boolean>;
  inventory: Record<string, number>;
  coins?: number;
  player?: { name?: string };
}

export function hiddenKey(mapId: string, x: number, y: number): string {
  return `${mapId}_${x}_${y}`;
}

export type HiddenFind =
  | { kind: "item"; item: string; name: string }
  | { kind: "bagfull"; item: string; name: string }
  | { kind: "coins"; coins: number }
  | { kind: "nocase" };

/**
 * A press on (x, y) of `mapId`: what, if anything, is under it. Marks the
 * spot taken and adds the item or the coins -- except a full bag, which
 * announces the find and leaves the spot for later, the way GiveItem's
 * .bagFull branch does. Coins need the COIN CASE, silently.
 *
 * `add` is the bag's add, returning false when it cannot take the item.
 */
export function findHidden(
  data: any,
  save: HiddenSave,
  mapId: string,
  x: number,
  y: number,
  add: (item: string) => boolean,
): HiddenFind | null {
  const key = hiddenKey(mapId, x, y);
  const taken = (save.hiddenTaken ??= {});
  const items = (data?.field?.hiddenItems?.[mapId] ?? []) as { x: number; y: number; item: string }[];
  for (const h of items) {
    if (h.x !== x || h.y !== y) continue;
    if (taken[key]) return null;
    const name: string = data?.items?.[h.item]?.name ?? h.item;
    if (!add(h.item)) return { kind: "bagfull", item: h.item, name };
    taken[key] = true;
    return { kind: "item", item: h.item, name };
  }
  const coins = (data?.field?.hiddenCoins?.[mapId] ?? []) as { x: number; y: number; coins: number }[];
  for (const h of coins) {
    if (h.x !== x || h.y !== y) continue;
    if (taken[key]) return null;
    if (!(save.inventory.COIN_CASE > 0)) return { kind: "nocase" };
    taken[key] = true;
    save.coins = Math.min(9999, (save.coins ?? 0) + h.coins);
    return { kind: "coins", coins: h.coins };
  }
  return null;
}

/**
 * The ITEMFINDER's question: is any hidden item still unfound NEAR the
 * player? HiddenItemNear's window is coord > clamp0(player - 5) and
 * coord <= player + 4 on Y, + 5 on X -- the clamp excludes coordinate 0
 * whenever the player's is 4 or less, exactly as the original does.
 */
export function hiddenItemNear(
  data: any,
  save: HiddenSave,
  mapId: string,
  px: number,
  py: number,
): boolean {
  const items = (data?.field?.hiddenItems?.[mapId] ?? []) as { x: number; y: number }[];
  const taken = save.hiddenTaken ?? {};
  const near = (c: number, v: number, hi: number): boolean => v > Math.max(c - 5, 0) && v <= c + hi;
  return items.some((h) =>
    !taken[hiddenKey(mapId, h.x, h.y)] && near(py, h.y, 4) && near(px, h.x, 5));
}
