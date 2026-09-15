// The BICYCLE. Ports gen1recomp's bike slice: the riding allowlist
// (OverworldController.lua:723 bikeAllowed, itself home/overworld.asm's
// IsBikeRidingAllowed), the doubled step speed (Player.lua:152), and the
// bike theme's override of an outdoor map song (Music.lua:337
// effectiveMapSong).
//
// Riding is a save flag, not a party or bag state: save.onBike survives a
// warp, and entering a map that disallows it dismounts you on arrival.

/** Player.lua:37 / FieldDefaults bikeStepFrames — half of the walking 16. */
export const BIKE_STEP_FRAMES = 8;

/** Music.lua:151 SPECIAL.bike. */
/** Music_Surfing — the theme while afloat, indoors or out. */
export const SURF_SONG = "Music_Surfing";

export const BIKE_SONG = "Music_BikeRiding";

/**
 * Music.lua:123 OUTDOOR — the songs the bike (and surf) themes are allowed
 * to replace. An indoor theme is never overridden, which is why the bike
 * shop's own Music_Cities2 keeps playing while you stand in it.
 */
export const OUTDOOR_SONGS: ReadonlySet<string> = new Set([
  "Music_PalletTown", "Music_Cities1", "Music_Cities2", "Music_Celadon",
  "Music_Cinnabar", "Music_Vermilion", "Music_Lavender", "Music_Routes1",
  "Music_Routes2", "Music_Routes3", "Music_Routes4", "Music_IndigoPlateau",
  "Music_SafariZone", "Music_Dungeon1", "Music_Dungeon2", "Music_Dungeon3",
]);

/** The cooked field.bikeRiding allowlist (bike_riding_tilesets.asm). */
export interface BikeRiding {
  maps?: string[];
  tilesets?: string[];
}

/**
 * The fallback for data that predates the cooked allowlist — the five
 * tilesets of bike_riding_tilesets.asm plus the two map exceptions that
 * make the Victory Road approach rideable.
 */
export const BIKE_RIDING_DEFAULT: BikeRiding = {
  maps: ["ROUTE_23", "INDIGO_PLATEAU"],
  tilesets: ["OVERWORLD", "FOREST", "UNDERGROUND", "SHIP_PORT", "CAVERN"],
};

/**
 * IsBikeRidingAllowed: the map id wins first (Route 23 and the Plateau are
 * PLATEAU-tileset maps that ride anyway), then the tileset.
 */
export function bikeAllowed(
  mapId: string, tileset: string | undefined, rules?: BikeRiding,
): boolean {
  const br = rules ?? BIKE_RIDING_DEFAULT;
  if (br.maps?.includes(mapId)) return true;
  return !!tileset && !!br.tilesets?.includes(tileset);
}

/**
 * The song a map should actually play. The bike theme only takes over an
 * outdoor song, so a rideable cave keeps its dungeon theme... except that
 * the dungeon songs ARE in the outdoor set, which is what gives the bike
 * music inside Mt. Moon.
 */
export function effectiveMapSong(
  song: string | null,
  onBike: boolean,
  surfing = false,
): string | null {
  if (!song) return song;
  // Surf outranks the bike and is not limited to outdoor themes: the Seafoam
  // caves are indoors and still play it (pokered PlayDefaultMusic checks
  // wWalkBikeSurfState before the map's own song).
  if (surfing) return SURF_SONG;
  if (!onBike) return song;
  return OUTDOOR_SONGS.has(song) ? BIKE_SONG : song;
}
