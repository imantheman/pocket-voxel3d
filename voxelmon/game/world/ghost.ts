// Where the SILPH SCOPE matters (engine/battle/core.asm IsGhostBattle):
// every wild battle in the Pokemon Tower is the unidentifiable GHOST until
// the scope is in the bag. gen1recomp Map.ghostBattles keys the same rule on
// the map id; a map record may carry its own `ghostBattles` to override it.

export function isGhostMap(mapId: string | undefined): boolean {
  return typeof mapId === "string" && mapId.startsWith("POKEMON_TOWER");
}
