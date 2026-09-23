// The SEAFOAM ISLANDS puzzle (scripts/SeafoamIslands1F.asm .. B4F.asm, read
// from field.seafoam the way gen1recomp's OverworldController does).
//
// Four floors of holes: a boulder shoved onto one falls a floor and turns up
// below, permanently. The two that reach B3F plug the water, and until they
// do the currents on B3F drag a surfer down to the stairs into B4F, whose
// pool edge pushes them straight back up -- ARTICUNO is reached only once
// the puzzle is solved. Which floor each boulder is on is a pair of
// toggleable objects (data/maps/toggleable_objects.asm), swapped once under
// the hole's event.
//
// field.seafoam has carried all of this since the import; nothing read it,
// so the boulders sat on every floor at once and the water was still.

export interface SeafoamHole {
  x: number;
  y: number;
  boulderEvent: string;
  /** toggleable_objects.asm names, not object_event ones. */
  hideObject?: string;
  showObject?: string;
  landsAt?: { x: number; y: number };
}

export interface SeafoamMove {
  dir: "up" | "down" | "left" | "right";
  count: number;
}

export interface SeafoamCurrent {
  x: number;
  y: number;
  moves: SeafoamMove[];
}

export interface SeafoamFloor {
  holes?: SeafoamHole[];
  holeDestination?: string;
  currents?: SeafoamCurrent[];
  currentsDisabledByEvents?: string[];
  entryCurrent?: SeafoamCurrent;
  /** Holes on the floor ABOVE whose boulders land here and plug the water. */
  pluggedByHolesOn?: { map: string; holes: SeafoamHole[] };
  forcedExit?: { activeUntilEvents: string[]; coords: { x: number; y: number }[] };
}

export type SeafoamField = Record<string, SeafoamFloor>;

type Flags = Record<string, boolean | undefined> | undefined;

export function seafoamData(field: unknown): SeafoamField | undefined {
  return (field as { seafoam?: SeafoamField } | undefined)?.seafoam;
}

/**
 * toggleable_objects.asm names (TOGGLE_SEAFOAM_ISLANDS_B3F_BOULDER_1) against
 * object_event const names (SEAFOAMISLANDSB3F_BOULDER1).
 */
export function toggleToObjectName(mapId: string, toggle: string): string | null {
  const prefix = `TOGGLE_${mapId}_`;
  if (!toggle.startsWith(prefix)) return null;
  return `${mapId.replace(/_/g, "")}_${toggle.slice(prefix.length).replace(/_/g, "")}`;
}

/** Every hole on a floor, with the floor its boulder lands on. */
export function holesFor(
  sf: SeafoamField | undefined,
  mapId: string,
): { hole: SeafoamHole; destMap: string }[] {
  const out: { hole: SeafoamHole; destMap: string }[] = [];
  for (const [owner, floor] of Object.entries(sf ?? {})) {
    if (owner === mapId && floor.holeDestination) {
      for (const hole of floor.holes ?? []) out.push({ hole, destMap: floor.holeDestination });
    }
    if (floor.pluggedByHolesOn?.map === mapId) {
      for (const hole of floor.pluggedByHolesOn.holes) out.push({ hole, destMap: owner });
    }
  }
  return out;
}

/** A hole cell: not floor for the player, but a boulder may be shoved onto it. */
export function isHole(sf: SeafoamField | undefined, mapId: string, x: number, y: number): boolean {
  return holesFor(sf, mapId).some((h) => h.hole.x === x && h.hole.y === y);
}

/**
 * The boulders that arrive from above ship hidden: every showObject target,
 * keyed by map then object name, the shape of the spawn filter's table.
 */
export function defaultHiddenBoulders(
  sf: SeafoamField | undefined,
): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {};
  const add = (mapId: string, toggle: string | undefined): void => {
    const name = toggle ? toggleToObjectName(mapId, toggle) : null;
    if (!name) return;
    (out[mapId] ??= {})[name] = true;
  };
  for (const [owner, floor] of Object.entries(sf ?? {})) {
    if (floor.holeDestination) {
      for (const h of floor.holes ?? []) add(floor.holeDestination, h.showObject);
    }
    for (const h of floor.pluggedByHolesOn?.holes ?? []) add(owner, h.showObject);
  }
  return out;
}

const allSet = (flags: Flags, events: string[] | undefined): boolean =>
  (events ?? []).every((e) => flags?.[e] === true);

/**
 * B4F's pool edge (SeafoamIslandsB4FDefaultScript): until the B3F plugs are
 * down, a surfer on the edge cells is pushed back up to the row above them.
 * Returns the tiles to push, or 0.
 */
export function forcedExitAt(
  sf: SeafoamField | undefined,
  flags: Flags,
  mapId: string,
  x: number,
  y: number,
): number {
  const fe = sf?.[mapId]?.forcedExit;
  if (!fe || allSet(flags, fe.activeUntilEvents)) return 0;
  if (!fe.coords.some((c) => c.x === x && c.y === y)) return 0;
  const top = Math.min(...fe.coords.map((c) => c.y));
  return y - (top - 1);
}

/** The current under a surfer, if its plug is not down yet. */
export function currentAt(
  sf: SeafoamField | undefined,
  flags: Flags,
  mapId: string,
  x: number,
  y: number,
): SeafoamCurrent | null {
  const floor = sf?.[mapId];
  if (!floor) return null;
  const active: SeafoamCurrent[] = [];
  if (!allSet(flags, floor.currentsDisabledByEvents)) active.push(...(floor.currents ?? []));
  if (floor.entryCurrent) {
    const plugged = (floor.pluggedByHolesOn?.holes ?? []).every(
      (h) => flags?.[h.boulderEvent] === true,
    );
    if (!plugged) active.push(floor.entryCurrent);
  }
  return active.find((c) => c.x === x && c.y === y) ?? null;
}

/**
 * B3F's currents end on the south-edge water stairs; the map script sets
 * BIT_FORCED_WARP first so they fire with no d-pad held.
 */
export const FORCED_WARP_FLOORS = ["SEAFOAM_ISLANDS_B3F"];

/**
 * IsSurfingAllowed (engine/overworld/field_move_messages.asm): B4F's stairs
 * square refuses SURF -- "The current is much too fast!" -- until both plug
 * boulders are down.
 */
export const SURF_BLOCKED = {
  map: "SEAFOAM_ISLANDS_B4F",
  x: 7,
  y: 11,
  untilEvents: ["EVENT_SEAFOAM4_BOULDER1_DOWN_HOLE", "EVENT_SEAFOAM4_BOULDER2_DOWN_HOLE"],
};

export function surfBlockedAt(flags: Flags, mapId: string, x: number, y: number): boolean {
  return (
    mapId === SURF_BLOCKED.map &&
    x === SURF_BLOCKED.x &&
    y === SURF_BLOCKED.y &&
    !allSet(flags, SURF_BLOCKED.untilEvents)
  );
}
