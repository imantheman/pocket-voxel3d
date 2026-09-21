// The elevators (engine/overworld/elevator.asm DisplayElevatorFloorMenu),
// ported from gen1recomp data/scripts/story3.lua's elevator helpers.
//
// A Gen 1 lift does not jump-cut you to the floor. Choosing one REWRITES
// the car's own exit warps (wWarpEntries, via .UpdateWarp) to point at that
// floor's lift door, and hands control back: the player walks out of the
// car themselves and arrives there. The panel is a bg_event, so the menu
// waits for them to face it and press A -- entering the car only seeds an
// exit, which is what stops a walk-out landing on the car's static default
// floor (the Rocket Hideout's is B1F even when you came in from B4F).
import type { VoxelmonData } from "../data.ts";

export interface ElevatorFloor {
  /** The map this floor is. */
  map: string;
  /** What the panel prints: SILPH_CO_10F -> "10F", ..._B2F -> "B2F". */
  token: string;
  /**
   * The floor's own warp back into the car -- the reciprocal the car's
   * rewritten exit lands on, matching wElevatorWarpMaps' (warp, map).
   *
   * ONE-BASED, because that is what `destWarp` means everywhere else in
   * the dataset (world/warp.ts indexes `warps[destWarp - 1]`). Handing it
   * the 0-based array index put every ride one warp early: choosing B4F
   * walked the player out onto that floor's STAIRS.
   */
  warpIdx: number;
}

interface WarpLike {
  destMap?: string;
  destWarp?: number;
}

interface MapDefLike {
  warps?: WarpLike[];
}

/** Every floor whose lift door leads into this car, in floor order. */
export function floorsOf(data: VoxelmonData, elevatorMapId: string): ElevatorFloor[] {
  const maps = (data.maps ?? {}) as Record<string, MapDefLike>;
  const floors: ElevatorFloor[] = [];
  for (const [mapId, def] of Object.entries(maps)) {
    const warps = def?.warps ?? [];
    for (let i = 0; i < warps.length; i++) {
      if (warps[i]?.destMap !== elevatorMapId) continue;
      floors.push({
        map: mapId,
        token: mapId.slice(mapId.lastIndexOf("_") + 1) || mapId,
        warpIdx: i + 1,
      });
      break;
    }
  }
  // Numeric floor order, not lexicographic: 10F and 11F would otherwise
  // sort in front of 2F. A basement's number is its depth, and B4F is
  // further from B1F than B2F is, so the sign does not enter into it.
  floors.sort((a, b) => floorNumber(a.token) - floorNumber(b.token));
  return floors;
}

function floorNumber(token: string): number {
  const m = /\d+/.exec(token);
  return m ? Number(m[0]) : 0;
}

/**
 * Point EVERY exit of the car at one floor's lift door.
 *
 * The map definition is shared, generated data, and this writes to it --
 * as the original writes to wWarpEntries. A car's warps are only ever read
 * from inside that car, and every ride rewrites them, so the shared edit
 * cannot be seen from anywhere the player can stand.
 */
export function setExit(mapDef: MapDefLike | undefined, floor: ElevatorFloor | undefined): void {
  if (!mapDef?.warps || !floor) return;
  for (const w of mapDef.warps) {
    w.destMap = floor.map;
    w.destWarp = floor.warpIdx;
  }
}

/**
 * Seed a walk-out destination on entry, before the panel is ever read: the
 * floor they came from when it is known, else the first one listed.
 *
 * A player who reads the panel without the key, or backs out of the menu,
 * still walks out onto the floor they arrived from rather than wherever
 * the ROM's default pointed.
 */
export function seedExit(
  mapDef: MapDefLike | undefined,
  floors: ElevatorFloor[],
  fromMapId?: string,
): ElevatorFloor | undefined {
  let exit = floors[0];
  if (fromMapId) {
    const came = floors.find((f) => f.map === fromMapId);
    if (came) exit = came;
  }
  setExit(mapDef, exit);
  return exit;
}
