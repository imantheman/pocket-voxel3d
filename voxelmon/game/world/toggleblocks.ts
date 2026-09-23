// Blocks that open and shut: the Pokémon Mansion's switch doors
// (scripts/PokemonMansion1F/2F/3F/B1F.asm) and the Cinnabar Gym's quiz gates
// (scripts/CinnabarGym.asm + engine/events/hidden_events/cinnabar_gym_quiz.asm).
//
// pokered keeps the map data in ONE state and rewrites these blocks on every
// map load (Mansion*CheckReplaceSwitchDoorBlocks, CinnabarGymGateCoords), so
// the extracted maps ship every one of them OPEN. Cooked as-is, none of these
// barriers exists: the mansion is one open floor and the gym's six rooms run
// together.
//
// Nothing here can rewrite baked chunk geometry at runtime, so the cook bakes
// the SOLID block and lifts it out as per-cell stamps (cook/cli.ts +
// cook/mesh.ts), and the runtime shows or hides the stamp and sets the block
// under it — the same mechanism as the card-key doors, except these toggle
// both ways, which the stamp op already supports.
//
// This module is imported by the COOKER as well as the game, so the list of
// blocks to bake and the list the runtime toggles cannot drift apart.

/** The walkable floor these all open to ($0e). */
export const OPEN_BLOCK = 0x0e;

export interface ToggleBlock {
  /** Block coords, the (X, Y) ReplaceTileBlock takes. */
  bx: number;
  by: number;
  /** The block when the way is SHUT — what the cook bakes. */
  solid: number;
  /** True when the switch being ON is what shuts this one. */
  solidWhenOn: boolean;
}

/**
 * One shared switch, EVENT_MANSION_SWITCH_ON, flips every door on all four
 * floors — some shut, some open, which is what makes the mansion a puzzle
 * rather than a corridor.
 */
export const MANSION_BLOCKS: Record<string, ToggleBlock[]> = {
  POKEMON_MANSION_1F: [
    { bx: 12, by: 6, solid: 0x2d, solidWhenOn: true },
    { bx: 8, by: 3, solid: 0x2d, solidWhenOn: false },
    { bx: 10, by: 8, solid: 0x2d, solidWhenOn: false },
    { bx: 13, by: 13, solid: 0x2d, solidWhenOn: false },
  ],
  POKEMON_MANSION_2F: [
    { bx: 4, by: 2, solid: 0x5f, solidWhenOn: true },
    { bx: 9, by: 4, solid: 0x54, solidWhenOn: false },
    { bx: 3, by: 11, solid: 0x5f, solidWhenOn: false },
  ],
  POKEMON_MANSION_3F: [
    { bx: 7, by: 2, solid: 0x5f, solidWhenOn: true },
    { bx: 7, by: 5, solid: 0x5f, solidWhenOn: false },
  ],
  POKEMON_MANSION_B1F: [
    { bx: 13, by: 8, solid: 0x2d, solidWhenOn: true },
    { bx: 6, by: 11, solid: 0x5f, solidWhenOn: true },
    { bx: 4, by: 3, solid: 0x5f, solidWhenOn: false },
    { bx: 8, by: 8, solid: 0x54, solidWhenOn: false },
  ],
};

/**
 * The statue switches themselves (data/events/hidden_events.asm
 * Mansion*Script_Switches), in CELL coords. All face up.
 *
 * 2F, 3F and B1F share 2F's text in pokered, which is why the prefix is not
 * simply the floor.
 */
export const MANSION_SWITCHES: Record<string, { cells: [number, number][]; text: string }> = {
  POKEMON_MANSION_1F: { cells: [[2, 5]], text: "_PokemonMansion1F" },
  POKEMON_MANSION_2F: { cells: [[2, 11]], text: "_PokemonMansion2F" },
  POKEMON_MANSION_3F: { cells: [[10, 5]], text: "_PokemonMansion2F" },
  POKEMON_MANSION_B1F: { cells: [[20, 3], [18, 25]], text: "_PokemonMansion2F" },
};

/**
 * 3F's floor holes (PokemonMansion3FDefaultScript.holeCoords +
 * data/maps/special_warps.asm): stepping on one drops you. The first two are
 * the only way into the sealed basement-stairs room.
 */
export const MANSION_HOLES: {
  x: number; y: number; map: string; dx: number; dy: number;
}[] = [
  { x: 16, y: 14, map: "POKEMON_MANSION_1F", dx: 16, dy: 14 },
  { x: 17, y: 14, map: "POKEMON_MANSION_1F", dx: 16, dy: 14 },
  { x: 19, y: 14, map: "POKEMON_MANSION_2F", dx: 18, dy: 14 },
];

export interface GymMachine {
  /** The quiz machine's tile, in CELL coords; faced from below. */
  x: number;
  y: number;
  /** Whether YES is the right answer (the answer nibble). */
  yes: boolean;
  /** The gate this question opens. */
  gate: ToggleBlock;
  /** Object index of the trainer who comes at you for a wrong answer
   * (wOpponentAfterWrongAnswer = gate index + 2). */
  npc: number;
}

/** CinnabarGymGateCoords, paired with the questions and the guardians. */
export const GYM_MACHINES: GymMachine[] = [
  { x: 15, y: 7, yes: true, gate: { bx: 9, by: 3, solid: 0x54, solidWhenOn: false }, npc: 3 },
  { x: 10, y: 1, yes: false, gate: { bx: 6, by: 3, solid: 0x54, solidWhenOn: false }, npc: 4 },
  { x: 9, y: 7, yes: false, gate: { bx: 6, by: 6, solid: 0x54, solidWhenOn: false }, npc: 5 },
  { x: 9, y: 13, yes: false, gate: { bx: 3, by: 8, solid: 0x5f, solidWhenOn: false }, npc: 6 },
  { x: 1, y: 13, yes: true, gate: { bx: 2, by: 6, solid: 0x54, solidWhenOn: false }, npc: 7 },
  { x: 1, y: 7, yes: false, gate: { bx: 2, by: 3, solid: 0x54, solidWhenOn: false }, npc: 8 },
];

/** Per-door unlock flag, so an opened gate stays open. */
export function gymGateFlag(i: number): string {
  return `EVENT_CINNABAR_GYM_GATE${i}_UNLOCKED`;
}

/** The defeatedTrainers key for a gate's guardian. */
export function gymGuardKey(npc: number): string {
  return `CINNABAR_GYM_obj_${npc}`;
}

/**
 * Every block the COOKER must bake solid on this map, so its geometry exists
 * to be toggled. Card-key doors are baked separately from the cooked field
 * data; these come from the tables above.
 */
export function toggleBlocksFor(mapId: string): ToggleBlock[] {
  if (mapId === "CINNABAR_GYM") return GYM_MACHINES.map((m) => m.gate);
  const barriers = ROAD_BARRIERS[mapId];
  if (barriers) {
    // These already ship closed, so baking changes nothing -- what the cook
    // needs them for is the LIFT, which is what gives the runtime per-cell
    // stamps to hide when the switch is pressed.
    return barriers.map((b) => ({
      bx: b.bx, by: b.by, solid: b.closed, solidWhenOn: false,
    }));
  }
  const seal = LEAGUE_SEALS[mapId];
  if (seal) {
    // solidWhenOn is meaningless for these — the cook only reads bx/by/solid,
    // and the runtime drives them from the room's own flag instead.
    return seal.blocks.map((b) => ({ ...b, solidWhenOn: false }));
  }
  return MANSION_BLOCKS[mapId] ?? [];
}

// ---------------------------------------------------------------------------
// The Elite Four's doors
// ---------------------------------------------------------------------------

/**
 * One room of the league, and the block that seals it.
 *
 * Lorelei, Bruno and Agatha each seal their EXIT (LoreleiShowOrHideExitBlock
 * and the Bruno/Agatha equivalents): the block above the north warp is solid
 * until that room's trainer is beaten, so the only way on is through them.
 *
 * Lance is the odd one out — LancesRoomShowOrHideEntranceBlocks gates his
 * ENTRANCE instead, and the .blk ships it CLOSED, so without this script his
 * arena and both Champion's Room warps behind it are walled off and the
 * league simply dead-ends at his door.
 */
export interface LeagueSeal {
  /** Solid while this flag is UNSET (Lance: while it is SET — see `whileSet`). */
  flag: string;
  /** Inverted: Lance's door is open until you cross it and it locks behind. */
  whileSet?: boolean;
  blocks: { bx: number; by: number; solid: number }[];
  /** The line for retreating toward the entrance, and the rows it covers. */
  /** `fromY` is a MINIMUM: these are the rows nearest the entrance. */
  dontRun?: { text: string; fromY: number; x: [number, number] };
}

/**
 * Block ids are ReplaceTileBlock's: $24 the GYM gate, $3b the CEMETERY gate,
 * $72/$73 the two halves of the DOJO doorway. Each opens to plain floor
 * ($05 / $36 / $31+$32), which is why hiding the lifted stamp is enough —
 * liftBlock leaves the ground behind it.
 *
 * LORELEIS_ROOM and LANCES_ROOM ship these blocks CLOSED already; BRUNOS_ROOM
 * and AGATHAS_ROOM ship them OPEN and the cook has to bake them shut.
 */
export const LEAGUE_SEALS: Record<string, LeagueSeal> = {
  LORELEIS_ROOM: {
    flag: "EVENT_BEAT_LORELEIS_ROOM_TRAINER_0",
    blocks: [{ bx: 2, by: 0, solid: 0x24 }],
    dontRun: { text: "_LoreleisRoomLoreleiDontRunAwayText", fromY: 10, x: [4, 5] },
  },
  BRUNOS_ROOM: {
    flag: "EVENT_BEAT_BRUNOS_ROOM_TRAINER_0",
    blocks: [{ bx: 2, by: 0, solid: 0x24 }],
    dontRun: { text: "_BrunosRoomBrunoDontRunAwayText", fromY: 10, x: [4, 5] },
  },
  AGATHAS_ROOM: {
    flag: "EVENT_BEAT_AGATHAS_ROOM_TRAINER_0",
    blocks: [{ bx: 2, by: 0, solid: 0x3b }],
    dontRun: { text: "_AgathasRoomAgathaDontRunAwayText", fromY: 10, x: [4, 5] },
  },
  LANCES_ROOM: {
    flag: "EVENT_LANCES_ROOM_LOCK_DOOR",
    whileSet: true,
    blocks: [
      { bx: 2, by: 6, solid: 0x72 },
      { bx: 3, by: 6, solid: 0x73 },
    ],
  },
};

/** The doorway cells that lock Lance's room behind you (LancesRoomDefault). */
export const LANCE_DOOR_CELLS: [number, number][] = [[5, 11], [6, 11]];

/** The trainer whose defeat opens each room, by object id. */
export function leagueGuardKey(mapId: string): string {
  return `${mapId}_obj_1`;
}

// ---------------------------------------------------------------------------
// Victory Road's boulder switches
// ---------------------------------------------------------------------------

/**
 * A barrier that a boulder on a switch takes down
 * (scripts/VictoryRoad1F/2F/3F.asm).
 *
 * Unlike every other toggle in this file these open only PARTLY: $25 opens to
 * $1d, which frees one more cell of the block and leaves the rest wall, and
 * $37 opens to $15, which frees two. So the runtime cannot just hide the whole
 * lifted block -- it shows the stamp on whichever cells are still wall under
 * the block the barrier is currently set to.
 *
 * The closed ids are the shipped .blk bytes, checked against the extracted
 * map data rather than taken on trust.
 */
export interface RoadBarrier {
  bx: number;
  by: number;
  /** The shipped block: the way in is walled off. */
  closed: number;
  /** With a boulder on the switch. */
  open: number;
  flag: string;
  /** The CELL a boulder has to come to rest on. */
  switchX: number;
  switchY: number;
}

export const ROAD_BARRIERS: Record<string, RoadBarrier[]> = {
  VICTORY_ROAD_1F: [
    {
      bx: 4, by: 6, closed: 0x25, open: 0x1d,
      flag: "EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH",
      switchX: 17, switchY: 13,
    },
  ],
  VICTORY_ROAD_2F: [
    {
      bx: 3, by: 4, closed: 0x37, open: 0x15,
      flag: "EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH1",
      switchX: 1, switchY: 16,
    },
    {
      bx: 11, by: 7, closed: 0x25, open: 0x1d,
      flag: "EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH2",
      switchX: 9, switchY: 16,
    },
  ],
  VICTORY_ROAD_3F: [
    {
      bx: 3, by: 5, closed: 0x25, open: 0x1d,
      flag: "EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH1",
      switchX: 3, switchY: 5,
    },
  ],
};

export function barriersFor(mapId: string): RoadBarrier[] {
  return ROAD_BARRIERS[mapId] ?? [];
}

/**
 * The hole in Victory Road 3F (scripts/VictoryRoad3F.asm, .handle_hole and
 * VictoryRoad3FDefaultScript). A boulder shoved onto it drops a floor and
 * turns up on 2F beside the second switch -- it is the only boulder that
 * can reach that switch -- and the player who steps in after it falls to
 * 2F too. Which floor the boulder is on is a pair of toggleable objects
 * (data/maps/toggleable_objects.asm), swapped once, under the flag.
 */
export interface RoadHole {
  map: string;
  /** The hole's CELL. */
  x: number;
  y: number;
  /** The boulder that goes down it, and the one that appears below. */
  boulder: string;
  toBoulder: string;
  flag: string;
  /** Where the player lands (DungeonWarpData). */
  toMap: string;
  dx: number;
  dy: number;
}

export const ROAD_HOLES: RoadHole[] = [
  {
    map: "VICTORY_ROAD_3F", x: 23, y: 15,
    boulder: "VICTORYROAD3F_BOULDER4", toBoulder: "VICTORYROAD2F_BOULDER3",
    flag: "EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH2",
    toMap: "VICTORY_ROAD_2F", dx: 22, dy: 16,
  },
];

/**
 * Route23SetVictoryRoadBoulders (scripts/Route23.asm): the switch events
 * every entry to Route 23 clears, so the puzzle is whole again on the way
 * back. 1F's is reset by 2F instead.
 */
export const ROUTE_23_RESET_FLAGS = [
  "EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH1",
  "EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH2",
  "EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH1",
  "EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH2",
];
