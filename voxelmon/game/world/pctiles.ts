// PC tile coordinates, ported from gen1recomp tools/rom_manifest.json
// field.hiddenExtras.pcTiles (OverworldController.lua:2019 — a hidden tile you
// press A on, not an NPC). Every Pokémon Center's PC is at (13,3) facing up.
// The bedroom PC (REDS_HOUSE_2F) is intentionally omitted — it opens item
// storage, which is a later rung; these all open Bill's PC (box storage).

interface PcTile {
  x: number;
  y: number;
  facing: string;
}

export const PC_TILES: Record<string, PcTile[]> = {
  VIRIDIAN_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  PEWTER_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  CERULEAN_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  VERMILION_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  LAVENDER_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  CELADON_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  FUCHSIA_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  CINNABAR_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  SAFFRON_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  MT_MOON_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  ROCK_TUNNEL_POKECENTER: [{ x: 13, y: 3, facing: "up" }],
  INDIGO_PLATEAU_LOBBY: [{ x: 15, y: 7, facing: "up" }],
};

/** True when (x,y) facing `facing` is a PC tile on this map. */
export function pcTileAt(mapLabel: string, x: number, y: number, facing: string): boolean {
  const tiles = PC_TILES[mapLabel];
  if (!tiles) return false;
  return tiles.some((t) => t.x === x && t.y === y && (!t.facing || t.facing === facing));
}
