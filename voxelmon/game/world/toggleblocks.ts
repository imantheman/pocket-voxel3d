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
  return MANSION_BLOCKS[mapId] ?? [];
}
