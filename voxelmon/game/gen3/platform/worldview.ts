// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). FireRed's field as the 3DS host's voxel world, the way
// Gold's platform/worldview.ts does it for Johto: each shown frame a
// WorldState (which map, where the camera is, who stands where) becomes
// scene ops --
//
//   - mapShow(slot, index, ox, oy): the map the player is on in slot 0 (at
//     the origin), the maps its connections join in slots 1..4, placed by
//     world.json's connection offsets (cells of 16 px, as the cook lays
//     them -- pokefirered fieldmap.c's connection maths);
//   - cam(x, y): the view centre in map px, Q4;
//   - g3Ents(records, n): the people, each a sprite frame of a 2D-layer
//     texture on a billboard standing in its cell, drawn by the host in the
//     world's pass (crates/pocketvoxel-3ds/src/gen3);
//   - tint, pitch, flatWorld as Gold's (flatWorld(1): no world this frame,
//     so the host neither builds nor draws one).
//
// Where the state comes from is not this module's business: game3_world.ts
// reads it out of the Game3 runtime (FieldView's own camera and actor list);
// worldbench.ts makes one up to exercise the host without the runtime.
// Nothing here reads or changes the game.

import { Q4 } from "../../../../contracts/spec/voxel-spec.ts";

/** The scene ops this module sends (the 3DS QuickJS natives, or a test double). */
export interface WorldOps {
  mapShow(slot: number, mapId: number, ox: number, oy: number): void;
  mapHide(slot: number): void;
  cam(x: number, y: number): void;
  pitch(rung: number): void;
  tint(abgr: number): void;
  flatWorld?(on: number): void;
  /** The frame's billboards: `n` records of ENT_FLOATS floats (see WorldEnt). */
  g3Ents?(records: Float32Array, n: number): void;
}

/** One map's record in paks_firered/world.json (cook/gen3cook.ts mapRecord). */
export interface WorldMap {
  index: number;
  width: number;
  height: number;
  outdoor?: boolean;
  connections?: Record<string, { map: string; offset: number }>;
}

export interface WorldJson {
  game?: string;
  maps: Record<string, WorldMap>;
}

/** One person on a billboard. */
export interface WorldEnt {
  /** A 2D-layer texture id (platform/image.ts Image.id). */
  tex: number;
  /** The feet, map px (the middle of the cell stood in). */
  x: number;
  z: number;
  /** Raised off the floor, px. */
  lift: number;
  /** The frame's size, px. */
  w: number;
  h: number;
  /** The frame over the image (v down); u0 > u1 mirrors. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  alpha: number;
}

/** The world for one frame, or null for none (a battle, a menu screen, VIEW 2D). */
export interface WorldState {
  /** world.json's name of the map the field is on. */
  map: string;
  /** The view centre, map px. */
  camX: number;
  camY: number;
  ents: WorldEnt[];
  /** The day tint (ABGR); white when omitted -- FRLG has no clock tint. */
  tint?: number;
}

/** Map px per cell: a metatile, as the cook lays the world. */
export const CELL = 16;
/** A billboard record's floats: tex x z lift w h u0 v0 u1 v1 alpha. */
export const ENT_FLOATS = 11;
/** Billboards a frame (the host keeps this many). */
export const G3_ENTS_MAX = 64;

/** One hop of connections: the maps beside `id`, placed relative to it (px). */
export function neighbours(maps: Record<string, WorldMap>, id: string): { id: string; ox: number; oy: number; dir: string }[] {
  const out: { id: string; ox: number; oy: number; dir: string }[] = [];
  const root = maps[id];
  if (!root) return out;
  for (const [dir, conn] of Object.entries(root.connections ?? {})) {
    const dest = maps[conn.map];
    if (!dest || conn.map === id) continue;
    const off = (conn.offset | 0) * CELL;
    let ox: number;
    let oy: number;
    if (dir === "north" || dir === "up") {
      ox = off;
      oy = -dest.height * CELL;
    } else if (dir === "south" || dir === "down") {
      ox = off;
      oy = root.height * CELL;
    } else if (dir === "west" || dir === "left") {
      ox = -dest.width * CELL;
      oy = off;
    } else if (dir === "east" || dir === "right") {
      ox = root.width * CELL;
      oy = off;
    } else {
      continue; // dive / emerge: not a seam
    }
    out.push({ id: conn.map, ox, oy, dir });
  }
  return out;
}

/** Parse world.json (the host hands it over as `voxel.gamedata()`), or null. */
export function parseWorldJson(text: string | null | undefined): WorldJson | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as WorldJson;
    return j && j.maps ? j : null;
  } catch {
    return null;
  }
}

export class WorldView {
  private mapSlots: (string | null)[] = [null, null, null, null, null];
  private lastMap: string | null = null;
  private lastCamX = Number.NaN;
  private lastCamY = Number.NaN;
  private lastTint = -1;
  private lastFlat = -1;
  private started = false;
  private recs = new Float32Array(G3_ENTS_MAX * ENT_FLOATS);
  private prev = new Float32Array(G3_ENTS_MAX * ENT_FLOATS);
  private lastN = -1;
  /** Billboards sent last frame (perf/debug). */
  entCount = 0;

  constructor(
    private readonly ops: WorldOps,
    readonly world: WorldJson | null,
  ) {}

  /** Whether the world has this map. */
  has(map: string | null | undefined): boolean {
    return typeof map === "string" && !!this.world?.maps[map];
  }

  /** The scene for one shown frame. */
  emit(state: WorldState | null): void {
    if (!this.started) {
      // the overworld camera's opening rung, as Gold and Kanto start it
      this.started = true;
      this.ops.pitch(2);
    }
    if (!state || !this.has(state.map)) {
      this.stateFlat(true);
      this.clear();
      return;
    }
    this.stateFlat(false);
    const tint = state.tint ?? 0xffffffff;
    if (tint !== this.lastTint) {
      this.lastTint = tint;
      this.ops.tint(tint);
    }
    this.emitMaps(state.map);
    this.emitCam(state.camX, state.camY);
    this.emitEnts(state.ents);
  }

  private stateFlat(on: boolean): void {
    const v = on ? 1 : 0;
    if (v === this.lastFlat) return;
    this.lastFlat = v;
    this.ops.flatWorld?.(v);
  }

  /** No world: nothing on the stage. */
  clear(): void {
    for (let slot = 0; slot < 5; slot++) {
      if (this.mapSlots[slot] !== null) {
        this.ops.mapHide(slot);
        this.mapSlots[slot] = null;
      }
    }
    this.lastMap = null;
    this.sendEnts(0);
  }

  private emitMaps(mapId: string): void {
    if (mapId === this.lastMap) return;
    this.lastMap = mapId;
    const maps = this.world!.maps;
    const cur = maps[mapId]!;
    const desired: { id: string; index: number; ox: number; oy: number }[] = [{ id: mapId, index: cur.index, ox: 0, oy: 0 }];
    for (const n of neighbours(maps, mapId).slice(0, 4)) {
      desired.push({ id: n.id, index: maps[n.id]!.index, ox: n.ox, oy: n.oy });
    }
    for (let slot = 0; slot < 5; slot++) {
      const want = desired[slot];
      const key = want ? `${want.id}@${want.ox},${want.oy}` : null;
      if (key === this.mapSlots[slot]) continue;
      if (want) this.ops.mapShow(slot, want.index, want.ox, want.oy);
      else this.ops.mapHide(slot);
      this.mapSlots[slot] = key;
    }
  }

  private emitCam(x: number, y: number): void {
    const cx = Math.round(x * Q4);
    const cy = Math.round(y * Q4);
    if (cx === this.lastCamX && cy === this.lastCamY) return;
    this.lastCamX = cx;
    this.lastCamY = cy;
    this.ops.cam(cx, cy);
  }

  private emitEnts(ents: WorldEnt[]): void {
    const r = this.recs;
    const n = Math.min(ents.length, G3_ENTS_MAX);
    for (let i = 0; i < n; i++) {
      const e = ents[i]!;
      const o = i * ENT_FLOATS;
      r[o] = e.tex;
      r[o + 1] = e.x;
      r[o + 2] = e.z;
      r[o + 3] = e.lift;
      r[o + 4] = e.w;
      r[o + 5] = e.h;
      r[o + 6] = e.u0;
      r[o + 7] = e.v0;
      r[o + 8] = e.u1;
      r[o + 9] = e.v1;
      r[o + 10] = e.alpha;
    }
    this.sendEnts(n);
  }

  /** The records, sent only when they changed. */
  private sendEnts(n: number): void {
    this.entCount = n;
    const k = n * ENT_FLOATS;
    if (n === this.lastN) {
      let same = true;
      for (let i = 0; i < k; i++) if (this.recs[i] !== this.prev[i]) { same = false; break; }
      if (same) return;
    }
    this.prev.set(this.recs.subarray(0, k));
    this.lastN = n;
    this.ops.g3Ents?.(this.recs, n);
  }
}
