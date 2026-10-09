// voxelmon/cook/g3ds/shapes.ts — the Gen 3 shape profile, translated for FRLG.
//
// MIT. Ported from UNDERdecoded/Gen2Recomped-DramaticShapes (MIT, Copyright
// (c) 2026 DramaticShape, modified by UNDERdecodedHD; THIRD_PARTY_NOTICES.md)
// at 726782f: data/gen3_shapes.lua (the behaviour -> class table, `standing`,
// `doors`, `grass_kind`) and lib/TileShape.lua (FALLBACK_HEIGHTS, ART). Every
// table below cites the file it comes from.
//
// THE TRANSLATION. His behaviour table is keyed by Emerald's behaviour
// NUMBERS (pokeemerald include/constants/metatile_behaviors.h). FireRed and
// LeafGreen number theirs differently (pokefirered's header of the same
// name), so the table here is keyed by NAME: `EMERALD_CLASS` is his table
// with each number replaced by its Emerald name, and `FRLG_NAMES` gives each
// FRLG number its FRLG name. A name both games use maps straight across; an
// FRLG-only name takes the class of its nearest Emerald counterpart, listed
// in `FRLG_ONLY` with the reason (that list IS the mapping table). Names
// neither game shares and neither table names fall back to his structural
// rule (no stated opinion: blocked -> wall, else ground), exactly as an
// Emerald MB_NORMAL does.

/** lib/TileShape.lua FALLBACK_HEIGHTS (data/voxel_heights.lua `heights` agrees). */
export const CLASS_H: Record<string, number> = {
  ground: 0,
  water: -2,
  void: 0,
  ledge: 6,
  fence: 10,
  sign: 12,
  wall: 16,
  tree: 16,
  cliff: 32,
  shell: 32,
  waterfall: 32,
  terrace: 16,
  roof: 28,
  cylinder: 16,
  canopy: 32,
  stump: 16,
  can: 9,
  chimney: 24,
  planter: 32,
  billboard: 16,
  signpost: 16,
  post: 16,
  column: 32,
  grass: 0,
  flower: 0,
  bed: 7,
  stool: 8,
  counter: 8,
  backrest: 12,
  table: 12,
  desk: 24,
  prop: 16,
  cutout: 16,
  bike: 16,
  console: 16,
  relief: 3,
  bookcase: 32,
  chair: 8,
  tabletop: 12,
  carcass: 16,
  worktop: 16,
  sink: 16,
  appliance: 32,
  cabinet: 32,
  tv: 12,
  bridge: 4,
  log: 2,
  slope: 0,
};

/**
 * lib/TileShape.lua ART -- how the mesher draws each class. The art modes this
 * port does not build (bookcase, stair, relief, chimney, planter, grass,
 * flower) are mapped to the nearest one it does, so a class never silently
 * becomes nothing: bookcase/planter/chimney stand as their measured upright
 * box, relief/grass/flower lie flat (his Gen 3 grass is flat ground with a
 * mat on it; see struct.ts).
 */
export const ART: Record<string, string> = {
  ground: "flat",
  water: "flat",
  void: "flat",
  ledge: "top",
  terrace: "top",
  roof: "top",
  wall: "upright",
  cliff: "upright",
  waterfall: "upright",
  shell: "upright",
  tree: "upright",
  // (ours) his fence is a 10px upright box, a low wall wearing the drawing;
  // here the drawing itself stands, as the post pool's thin per-pixel slab
  // squashed to the class's 10px (struct.ts buildObject), so the posts and
  // the rail read with air between them
  fence: "post",
  sign: "upright",
  cylinder: "cylinder",
  canopy: "canopy",
  stump: "cylinder",
  can: "cylinder",
  planter: "upright", // his "planter" hull (buildCylinders) is not ported
  billboard: "billboard",
  signpost: "billboard",
  post: "post",
  column: "post",
  grass: "flat",
  flower: "flat",
  bed: "top",
  backrest: "top",
  stool: "billboard",
  counter: "upright",
  table: "upright",
  desk: "upright",
  prop: "billboard",
  cutout: "billboard",
  bike: "billboard",
  console: "billboard",
  relief: "flat",
  bookcase: "upright", // his "bookcase" collapse (buildBookcases) is not ported
  bridge: "top",
  log: "top",
  slope: "top",
  chair: "top",
  tabletop: "top",
  carcass: "upright",
  worktop: "upright",
  sink: "upright",
  appliance: "upright",
  cabinet: "upright",
  tv: "upright",
  chimney: "upright",
};

export function artOf(cls: string): string {
  return ART[cls] ?? "upright";
}

/**
 * data/gen3_shapes.lua `behaviour`, by Emerald NAME (MB_ prefix dropped).
 * Only the rows whose names FRLG also has, or that an FRLG-only name maps
 * to, matter here; the Emerald-only rows (secret bases, Trick House, Sky
 * Pillar, Pacifidlog logs, the Hoenn bridges) are kept for completeness of
 * the translation table and never match an FRLG name.
 */
export const EMERALD_CLASS: Record<string, string> = {
  NORMAL: "ground",
  SHORT_GRASS: "ground",
  CAVE: "ground",
  NO_RUNNING: "ground",
  INDOOR_ENCOUNTER: "ground",
  MOUNTAIN_TOP: "ground",
  DEEP_SAND: "ground",
  SAND: "ground",
  FOOTPRINTS: "ground",
  ICE: "ground",
  THIN_ICE: "ground",
  CRACKED_ICE: "ground",
  WALK_EAST: "ground",
  WALK_WEST: "ground",
  WALK_NORTH: "ground",
  WALK_SOUTH: "ground",
  SLIDE_EAST: "ground",
  SLIDE_WEST: "ground",
  SLIDE_NORTH: "ground",
  SLIDE_SOUTH: "ground",
  IMPASSABLE_EAST: "ground",
  IMPASSABLE_WEST: "ground",
  IMPASSABLE_NORTH: "ground",
  IMPASSABLE_SOUTH: "ground",
  IMPASSABLE_NORTHEAST: "ground",
  IMPASSABLE_NORTHWEST: "ground",
  IMPASSABLE_SOUTHEAST: "ground",
  IMPASSABLE_SOUTHWEST: "ground",
  IMPASSABLE_SOUTH_AND_NORTH: "ground",
  IMPASSABLE_WEST_AND_EAST: "ground",
  MT_PYRE_HOLE: "ground",
  LAVARIDGE_GYM_B1F_WARP: "ground",
  EAST_ARROW_WARP: "ground",
  WEST_ARROW_WARP: "ground",
  NORTH_ARROW_WARP: "ground",
  SOUTH_ARROW_WARP: "ground",
  CRACKED_FLOOR_HOLE: "ground",
  LAVARIDGE_GYM_1F_WARP: "ground",
  UP_ESCALATOR: "ground",
  DOWN_ESCALATOR: "ground",
  WATER_SOUTH_ARROW_WARP: "ground",
  DEEP_SOUTH_WARP: "ground",
  BERRY_TREE_SOIL: "ground",
  CRACKED_FLOOR: "ground",
  TALL_GRASS: "grass",
  LONG_GRASS: "grass",
  LONG_GRASS_SOUTH_EDGE: "grass",
  ASHGRASS: "grass",
  POND_WATER: "water",
  INTERIOR_DEEP_WATER: "water",
  DEEP_WATER: "water",
  WATERFALL: "waterfall",
  SOOTOPOLIS_DEEP_WATER: "water",
  OCEAN_WATER: "water",
  PUDDLE: "water",
  SHALLOW_WATER: "water",
  NO_SURFACING: "water",
  SEAWEED: "water",
  HOT_SPRINGS: "water",
  SEAWEED_NO_SURFACING: "water",
  REFLECTION_UNDER_BRIDGE: "water",
  EASTWARD_CURRENT: "water",
  WESTWARD_CURRENT: "water",
  NORTHWARD_CURRENT: "water",
  SOUTHWARD_CURRENT: "water",
  JUMP_EAST: "ledge",
  JUMP_WEST: "ledge",
  JUMP_NORTH: "ledge",
  JUMP_SOUTH: "ledge",
  JUMP_NORTHEAST: "ledge",
  JUMP_NORTHWEST: "ledge",
  JUMP_SOUTHEAST: "ledge",
  JUMP_SOUTHWEST: "ledge",
  MUDDY_SLOPE: "slope",
  BUMPY_SLOPE: "slope",
  NON_ANIMATED_DOOR: "wall",
  LADDER: "wall",
  ANIMATED_DOOR: "wall",
  WATER_DOOR: "wall",
  COUNTER: "counter",
  PC: "console",
  CABLE_BOX_RESULTS_1: "console",
  REGION_MAP: "wall",
  TELEVISION: "console",
  POKEBLOCK_FEEDER: "prop",
  SLOT_MACHINE: "prop",
  ROULETTE: "tabletop",
  RUNNING_SHOES_INSTRUCTION: "wall",
  QUESTIONNAIRE: "wall",
  PLAYER_ROOM_PC_ON: "console",
  PICTURE_BOOK_SHELF: "bookcase",
  BOOKSHELF: "bookcase",
  POKEMON_CENTER_BOOKSHELF: "bookcase",
  VASE: "cylinder",
  TRASH_CAN: "can",
  SHOP_SHELF: "bookcase",
  BLUEPRINT: "wall",
  CABLE_BOX_RESULTS_2: "console",
  WIRELESS_BOX_RESULTS: "console",
  TRAINER_HILL_TIMER: "console",
};

/** data/gen3_shapes.lua `standing`: classes that only apply where the player cannot be. */
export const STANDING = new Set([
  "wall", "cliff", "tree", "shell", "column", "bookcase", "counter", "console", "prop",
  "cylinder", "can", "fence", "billboard", "signpost", "post", "planter", "canopy",
  "table_", "desk", "tabletop",
]);

/**
 * pokefirered include/constants/metatile_behaviors.h: FRLG's behaviour
 * names (MB_ dropped), for the values the game's maps place. ROM facts --
 * names and numbers, no code.
 */
export const FRLG_NAMES: Record<number, string> = {
  0x00: "NORMAL",
  0x02: "TALL_GRASS",
  0x08: "CAVE",
  0x0a: "RUNNING_DISALLOWED",
  0x0b: "INDOOR_ENCOUNTER",
  0x0c: "MOUNTAIN_TOP",
  0x10: "POND_WATER",
  0x11: "FAST_WATER",
  0x12: "DEEP_WATER",
  0x13: "WATERFALL",
  0x15: "OCEAN_WATER",
  0x16: "PUDDLE",
  0x17: "SHALLOW_WATER",
  0x19: "UNDERWATER_BLOCKED_ABOVE",
  0x1a: "UNUSED_WATER",
  0x1b: "CYCLING_ROAD_WATER",
  0x20: "STRENGTH_BUTTON",
  0x21: "SAND",
  0x22: "SEAWEED",
  0x23: "ICE",
  0x26: "THIN_ICE",
  0x27: "CRACKED_ICE",
  0x28: "HOT_SPRINGS",
  0x2a: "ROCK_STAIRS",
  0x2b: "SAND_CAVE",
  0x30: "IMPASSABLE_EAST",
  0x31: "IMPASSABLE_WEST",
  0x32: "IMPASSABLE_NORTH",
  0x33: "IMPASSABLE_SOUTH",
  0x34: "IMPASSABLE_NORTHEAST",
  0x35: "IMPASSABLE_NORTHWEST",
  0x36: "IMPASSABLE_SOUTHEAST",
  0x37: "IMPASSABLE_SOUTHWEST",
  0x38: "JUMP_EAST",
  0x39: "JUMP_WEST",
  0x3a: "JUMP_NORTH",
  0x3b: "JUMP_SOUTH",
  0x40: "WALK_EAST",
  0x41: "WALK_WEST",
  0x42: "WALK_NORTH",
  0x43: "WALK_SOUTH",
  0x44: "SLIDE_EAST",
  0x45: "SLIDE_WEST",
  0x46: "SLIDE_NORTH",
  0x47: "SLIDE_SOUTH",
  0x50: "EASTWARD_CURRENT",
  0x51: "WESTWARD_CURRENT",
  0x52: "NORTHWARD_CURRENT",
  0x53: "SOUTHWARD_CURRENT",
  0x54: "SPIN_RIGHT",
  0x55: "SPIN_LEFT",
  0x56: "SPIN_UP",
  0x57: "SPIN_DOWN",
  0x58: "STOP_SPINNING",
  0x60: "CAVE_DOOR",
  0x61: "LADDER",
  0x62: "EAST_ARROW_WARP",
  0x63: "WEST_ARROW_WARP",
  0x64: "NORTH_ARROW_WARP",
  0x65: "SOUTH_ARROW_WARP",
  0x66: "FALL_WARP",
  0x67: "REGULAR_WARP",
  0x68: "LAVARIDGE_1F_WARP",
  0x69: "WARP_DOOR",
  0x6a: "UP_ESCALATOR",
  0x6b: "DOWN_ESCALATOR",
  0x6c: "UP_RIGHT_STAIR_WARP",
  0x6d: "UP_LEFT_STAIR_WARP",
  0x6e: "DOWN_RIGHT_STAIR_WARP",
  0x6f: "DOWN_LEFT_STAIR_WARP",
  0x71: "UNION_ROOM_WARP",
  0x80: "COUNTER",
  0x81: "BOOKSHELF",
  0x82: "POKEMART_SHELF",
  0x83: "PC",
  0x84: "SIGNPOST",
  0x85: "REGION_MAP",
  0x86: "TELEVISION",
  0x87: "POKEMON_CENTER_SIGN",
  0x88: "POKEMART_SIGN",
  0x89: "CABINET",
  0x8a: "KITCHEN",
  0x8b: "DRESSER",
  0x8c: "SNACKS",
  0x8d: "CABLE_CLUB_WIRELESS_MONITOR",
  0x8e: "BATTLE_RECORDS",
  0x8f: "QUESTIONNAIRE",
  0x90: "FOOD",
  0x91: "INDIGO_PLATEAU_SIGN_1",
  0x92: "INDIGO_PLATEAU_SIGN_2",
  0x93: "BLUEPRINTS",
  0x94: "PAINTING",
  0x95: "POWER_PLANT_MACHINE",
  0x96: "TELEPHONE",
  0x97: "COMPUTER",
  0x98: "ADVERTISING_POSTER",
  0x99: "FOOD_SMELLS_TASTY",
  0x9a: "TRASH_BIN",
  0x9b: "CUP",
  0x9c: "PORTHOLE",
  0x9d: "WINDOW",
  0x9e: "BLINKING_LIGHTS",
  0x9f: "NEATLY_LINED_UP_TOOLS",
  0xa0: "IMPRESSIVE_MACHINE",
  0xa1: "VIDEO_GAME",
  0xa2: "BURGLARY",
  0xa3: "TRAINER_TOWER_MONITOR",
  0xd0: "CYCLING_ROAD_PULL_DOWN",
  0xd1: "CYCLING_ROAD_PULL_DOWN_GRASS",
};

/**
 * THE MAPPING TABLE for the FRLG names Emerald does not have: FRLG name ->
 * [the class it takes, the Emerald row it follows]. Everything not listed
 * here or in EMERALD_CLASS has no stated opinion (structural: blocked ->
 * wall, else ground), the same answer his table gives an unnamed byte.
 */
export const FRLG_ONLY: Record<string, [string | null, string]> = {
  RUNNING_DISALLOWED: ["ground", "NO_RUNNING"],
  FAST_WATER: ["water", "DEEP_WATER (surfable, a current drawn in it)"],
  UNDERWATER_BLOCKED_ABOVE: ["water", "NO_SURFACING"],
  UNUSED_WATER: ["water", "POND_WATER"],
  CYCLING_ROAD_WATER: ["water", "POND_WATER"],
  STRENGTH_BUTTON: ["ground", "NORMAL (a floor switch)"],
  ROCK_STAIRS: ["ground", "NORMAL (his flights are not ported; the steps lie flat as drawn)"],
  SAND_CAVE: ["ground", "SAND"],
  SPIN_RIGHT: ["ground", "SLIDE_EAST (forced movement)"],
  SPIN_LEFT: ["ground", "SLIDE_WEST"],
  SPIN_UP: ["ground", "SLIDE_NORTH"],
  SPIN_DOWN: ["ground", "SLIDE_SOUTH"],
  STOP_SPINNING: ["ground", "NORMAL"],
  CAVE_DOOR: ["wall", "NON_ANIMATED_DOOR (0x60 in both games; a door rises with its wall)"],
  FALL_WARP: ["ground", "CRACKED_FLOOR_HOLE"],
  REGULAR_WARP: ["ground", "DEEP_SOUTH_WARP (a floor you step onto)"],
  WARP_DOOR: ["wall", "ANIMATED_DOOR (0x69 in both games)"],
  UP_RIGHT_STAIR_WARP: ["ground", "DEEP_SOUTH_WARP"],
  UP_LEFT_STAIR_WARP: ["ground", "DEEP_SOUTH_WARP"],
  DOWN_RIGHT_STAIR_WARP: ["ground", "DEEP_SOUTH_WARP"],
  DOWN_LEFT_STAIR_WARP: ["ground", "DEEP_SOUTH_WARP"],
  UNION_ROOM_WARP: ["ground", "DEEP_SOUTH_WARP"],
  POKEMART_SHELF: ["bookcase", "SHOP_SHELF"],
  SIGNPOST: ["signpost", "his scenery carve's `signpost` (Emerald leaves signs MB_NORMAL and finds them by isolation; FRLG names them)"],
  POKEMON_CENTER_SIGN: ["wall", "part of the facade it hangs on"],
  POKEMART_SIGN: ["wall", "part of the facade it hangs on"],
  CABINET: ["cabinet", "his `cabinet` pin class (BrendansMaysHouse 571)"],
  KITCHEN: ["worktop", "his `worktop` pin class (BrendansMaysHouse 570)"],
  DRESSER: ["cabinet", "his `cabinet` pin class"],
  CABLE_CLUB_WIRELESS_MONITOR: ["console", "WIRELESS_BOX_RESULTS"],
  BATTLE_RECORDS: ["console", "CABLE_BOX_RESULTS_1"],
  BLUEPRINTS: ["wall", "BLUEPRINT"],
  PAINTING: ["wall", "SECRET_BASE_POSTER (a picture on the wall)"],
  ADVERTISING_POSTER: ["wall", "SECRET_BASE_POSTER"],
  PORTHOLE: ["wall", "SECRET_BASE_POSTER (drawn in the wall)"],
  WINDOW: ["wall", "SECRET_BASE_POSTER (drawn in the wall)"],
  COMPUTER: ["console", "PC"],
  VIDEO_GAME: ["console", "TELEVISION"],
  TRASH_BIN: ["can", "TRASH_CAN"],
  TRAINER_TOWER_MONITOR: ["console", "TRAINER_HILL_TIMER"],
  CYCLING_ROAD_PULL_DOWN: ["ground", "WALK_SOUTH (forced movement)"],
  CYCLING_ROAD_PULL_DOWN_GRASS: ["grass", "TALL_GRASS"],
  // no stated opinion, as an Emerald MB_NORMAL: the art and the collision decide
  SNACKS: [null, "-"],
  FOOD: [null, "-"],
  FOOD_SMELLS_TASTY: [null, "-"],
  CUP: [null, "-"],
  TELEPHONE: [null, "-"],
  INDIGO_PLATEAU_SIGN_1: [null, "-"],
  INDIGO_PLATEAU_SIGN_2: [null, "-"],
  POWER_PLANT_MACHINE: [null, "-"],
  BLINKING_LIGHTS: [null, "-"],
  NEATLY_LINED_UP_TOOLS: [null, "-"],
  IMPRESSIVE_MACHINE: [null, "-"],
  BURGLARY: [null, "-"],
};

/** The class FRLG behaviour `b` states, or undefined (no stated opinion). */
export function behaviourClass(b: number): string | undefined {
  const name = FRLG_NAMES[b];
  if (!name) return undefined;
  if (name in EMERALD_CLASS) return EMERALD_CLASS[name];
  const t = FRLG_ONLY[name];
  return t && t[0] ? t[0] : undefined;
}

/** data/gen3_shapes.lua `doors`, by name: walkable (or not) and part of the facade regardless. */
export const DOOR_NAMES = new Set(["NON_ANIMATED_DOOR", "LADDER", "ANIMATED_DOOR", "WATER_DOOR", "CAVE_DOOR", "WARP_DOOR"]);

export function isDoorBehaviour(b: number): boolean {
  const n = FRLG_NAMES[b];
  return n !== undefined && DOOR_NAMES.has(n);
}

/** lib/Gen3.lua MB_MOUNTAIN_TOP (0x0C in both games). */
export const MB_MOUNTAIN_TOP = 0x0c;

/** lib/Gen3.lua ELEV_*: the four reserved elevations (the same in both games). */
export const ELEV_TRANSITION = 0;
export const ELEV_SURF = 1;
export const ELEV_DEFAULT = 3;
export const ELEV_MULTI = 15;

/** lib/Gen3.lua LEDGE_HOP, by name: which way each jump drops. */
export function ledgeHop(b: number): [number, number] | null {
  switch (FRLG_NAMES[b]) {
    case "JUMP_EAST": return [1, 0];
    case "JUMP_WEST": return [-1, 0];
    case "JUMP_NORTH": return [0, -1];
    case "JUMP_SOUTH": return [0, 1];
    default: return null;
  }
}

/** The whole translation, for the report and the docs: Emerald-shared names first. */
export function mappingTable(): { value: number; frlg: string; cls: string; via: string }[] {
  const rows: { value: number; frlg: string; cls: string; via: string }[] = [];
  for (const [v, name] of Object.entries(FRLG_NAMES)) {
    const n = Number(v);
    if (name in EMERALD_CLASS) rows.push({ value: n, frlg: name, cls: EMERALD_CLASS[name]!, via: `MB_${name} (same name)` });
    else if (FRLG_ONLY[name]) rows.push({ value: n, frlg: name, cls: FRLG_ONLY[name]![0] ?? "(structural)", via: FRLG_ONLY[name]![1] });
    else rows.push({ value: n, frlg: name, cls: "(structural)", via: "-" });
  }
  return rows;
}
