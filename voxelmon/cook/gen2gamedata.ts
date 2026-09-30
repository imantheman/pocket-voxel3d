// Gold's gamedata.json: what the guest reads at boot, from the Gen 2 import
// (import/gen2) in the shapes the Gen 1 overworld already walks -- maps with
// warps, connections, signs and objects, tilesets with their collision
// quadrants, sprite frame counts, and the atlas page index.
//
// This is the walker's dataset (docs/gold-plan.md step 1): enough to walk
// Johto. Brian's own fields ride along untouched (coordinate events, scene
// scripts, callbacks, script pointers), for the Gen 2 engine as it is ported.

import type { GenData, MapDef } from "./data.ts";

/** SPRITEMOVEDATA_* (constants/map_object_constants.asm) as the Gen 1
 * overworld's movement words: what stands still and which way it faces. */
const MOVEMENT: Record<number, { movement: string; range: string }> = {
  0x01: { movement: "STAY", range: "DOWN" }, // STILL
  0x02: { movement: "WALK", range: "ANY_DIR" }, // WANDER
  0x03: { movement: "STAY", range: "DOWN" }, // SPINRANDOM_SLOW
  0x04: { movement: "WALK", range: "UP_DOWN" },
  0x05: { movement: "WALK", range: "LEFT_RIGHT" },
  0x06: { movement: "STAY", range: "DOWN" },
  0x07: { movement: "STAY", range: "UP" },
  0x08: { movement: "STAY", range: "LEFT" },
  0x09: { movement: "STAY", range: "RIGHT" },
  0x0a: { movement: "STAY", range: "DOWN" }, // SPINRANDOM_FAST
  0x24: { movement: "WALK", range: "ANY_DIR" }, // SWIM_WANDER
};

interface Gen2Object {
  index: number;
  sprite: string | number;
  x: number;
  y: number;
  movement: number;
  hours?: number[];
  eventFlag?: number;
  [k: string]: unknown;
}

export function buildGen2Gamedata(gen: GenData, atlas: unknown, cookedMaps: string[]): Uint8Array {
  const maps: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(gen.maps)) {
    const def = raw as unknown as Omit<MapDef, "objects"> & { objects?: Gen2Object[] };
    const objects = (def.objects ?? []).map((o) => ({
      ...o,
      // numeric ids past the sheet table are the variable sprites; the
      // walker shows nothing for them yet
      sprite: typeof o.sprite === "string" ? o.sprite : "SPRITE_NONE",
      name: `${id}_OBJECT${o.index}`,
      text: `${id}_OBJECT${o.index}`,
      ...(MOVEMENT[o.movement] ?? { movement: "STAY", range: "DOWN" }),
      gen2Movement: o.movement,
    }));
    maps[id] = { ...def, objects };
  }
  const tilesets: Record<string, unknown> = {};
  for (const [id, ts] of Object.entries(gen.tilesets)) {
    tilesets[id] = {
      id,
      blocks: ts.blocks,
      collision: ts.collision,
      walkable: [],
      counterTiles: [],
      doorTiles: [],
      warpTiles: [],
    };
  }
  const sprites = Object.fromEntries(
    Object.entries(gen.sprites ?? {}).map(([id, s]) => [id, { frames: s.frames, walker: s.walker }]),
  );
  const game = {
    version: gen.version ?? "gold",
    generation: 2,
    constants: gen.constants,
    cookedMaps,
    maps,
    tilesets,
    sprites,
    atlas,
    mapPalette: {},
    // the modules the Gen 1 guest insists on (data.ts REQUIRED_MODULES),
    // empty until their Gen 2 stages are ported
    pokemon: {},
    moves: {},
    type_chart: {},
    encounters: {},
  };
  return new TextEncoder().encode(JSON.stringify(game));
}
