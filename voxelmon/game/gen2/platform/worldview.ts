// The Gold world in voxels: reads the ported World's state each frame
// (world/World.ts viewState) and emits the scene ops -- the map and its
// connected neighbours, the camera, the player and the NPCs as walker cards
// -- exactly as the Gen 1 Scene does for Kanto (voxelmon/game/scene.ts
// emitMaps / emitCam / emitEnts), delta-gated the same way.
//
// World.lua drew all of this into a canvas. Here it keeps its logic and its
// state, and this module is the only thing that turns that state into
// pictures. Nothing here changes the world.

import { ENT_FLAG, ENTS_MAX, Q4 } from "../../../../contracts/spec/voxel-spec.ts";
import type { VoxelHost } from "../../host.ts";
import { Palettes } from "../world/Palettes.ts";

/** The `daytime` op's order (cook/gen2.ts GEN2_DAYTIMES). */
const DAYTIMES = ["MORN", "DAY", "NITE", "DARK"];

// scene.ts:64 -- the walk sheet's poses
const STAND: Record<string, number> = { down: 0, up: 1, left: 2, right: 2 };
const WALK: Record<string, number> = { down: 3, up: 4, left: 5, right: 5 };

interface WalkerMap {
  index: number;
  width: number;
  height: number;
  connections?: Record<string, { map: string; offset: number }>;
}

interface WalkerData {
  maps?: Record<string, WalkerMap>;
  cookedMaps?: string[];
  atlas?: { sprites?: Record<string, number> };
  sprites?: Record<string, { frames?: number; walker?: boolean }>;
}

/** One actor as World.viewState reports it (world/World.ts). */
export interface ActorView {
  px: number;
  py: number;
  facing: string;
  /** 1 mid-step (the walk frame), 0 standing. */
  phase?: number;
  mirror?: boolean;
  flip?: boolean;
  frame?: number;
  spriteId?: string;
  visible?: boolean;
  lift?: number;
}

export interface WorldViewState {
  /** "MORN" | "DAY" | "NITE" | "DARK": the palettes the map is drawn in. */
  daytime?: string;
  mapId?: string;
  map?: { id: string };
  player?: ActorView;
  npcs?: ActorView[];
}

/** overworld.ts:249 computeNeighbors, one hop: the maps a connection joins. */
function neighbours(maps: Record<string, WalkerMap>, rootId: string): { id: string; ox: number; oy: number }[] {
  const out: { id: string; ox: number; oy: number }[] = [];
  const root = maps[rootId];
  if (!root) return out;
  for (const [dir, conn] of Object.entries(root.connections ?? {})) {
    const dest = maps[conn.map];
    if (!dest || conn.map === rootId) continue;
    let ox: number;
    let oy: number;
    if (dir === "north") {
      ox = conn.offset * 32;
      oy = -dest.height * 32;
    } else if (dir === "south") {
      ox = conn.offset * 32;
      oy = root.height * 32;
    } else if (dir === "west") {
      ox = -dest.width * 32;
      oy = conn.offset * 32;
    } else {
      ox = root.width * 32;
      oy = conn.offset * 32;
    }
    out.push({ id: conn.map, ox, oy });
  }
  return out;
}

export class WorldView {
  private mapSlots: (string | null)[] = [null, null, null, null, null];
  private lastMapId: string | null = null;
  private lastCamX = Number.NaN;
  private lastCamY = Number.NaN;
  private entVals = new Int32Array(ENTS_MAX * 6);
  private entShown = new Uint8Array(ENTS_MAX);
  private entSeen = new Uint8Array(ENTS_MAX);
  private sheetCache = new Map<string, number>();
  private lastDaytime = -1;

  constructor(
    private readonly host: VoxelHost,
    private readonly data: WalkerData | null | undefined,
  ) {}

  /** Emit this frame's scene from the game's world, if it has one. */
  emit(game: { world?: any; frameWorldActive?: boolean }): void {
    const world = game.world;
    const vs: WorldViewState | null = world && world.map && typeof world.viewState === "function" ? world.viewState() : null;
    if (!vs) {
      this.clear();
      return;
    }
    const mapId = vs.mapId ?? vs.map?.id ?? world.map?.id;
    if (mapId) this.emitMaps(mapId);
    if (vs.player) this.emitCam(vs.player);
    this.emitEnts(vs);
    this.emitDaytime(vs);
  }

  /**
   * The world's palettes follow the clock (Palettes.lua clockDaytime), or
   * whatever the world says it is drawn in -- a dark cave is DARK.
   */
  private emitDaytime(vs: WorldViewState): void {
    let name = vs.daytime;
    if (!name) {
      try {
        name = (Palettes as unknown as { clockDaytime?: () => string }).clockDaytime?.();
      } catch {
        name = undefined;
      }
    }
    const k = Math.max(0, DAYTIMES.indexOf(name ?? "DAY"));
    if (k !== this.lastDaytime) {
      this.host.daytime?.(k);
      this.lastDaytime = k;
    }
  }

  /** No world: nothing on the stage. */
  clear(): void {
    for (let slot = 0; slot < 5; slot++) {
      if (this.mapSlots[slot] !== null) {
        this.host.mapHide(slot);
        this.mapSlots[slot] = null;
      }
    }
    this.lastMapId = null;
    this.hideAllEnts();
  }

  private emitMaps(mapId: string): void {
    if (mapId === this.lastMapId) return;
    this.lastMapId = mapId;
    const maps = this.data?.maps ?? {};
    const cur = maps[mapId];
    const desired: ({ id: string; index: number; ox: number; oy: number } | null)[] = [];
    if (cur) desired.push({ id: mapId, index: cur.index, ox: 0, oy: 0 });
    for (const n of neighbours(maps, mapId).slice(0, 4)) {
      if (this.data?.cookedMaps && !this.data.cookedMaps.includes(n.id)) continue;
      desired.push({ id: n.id, index: maps[n.id]!.index, ox: n.ox, oy: n.oy });
    }
    for (let slot = 0; slot < 5; slot++) {
      const want = desired[slot] ?? null;
      const key = want ? `${want.id}@${want.ox},${want.oy}` : null;
      if (key === this.mapSlots[slot]) continue;
      if (want) this.host.mapShow(slot, want.index, want.ox, want.oy);
      else this.host.mapHide(slot);
      this.mapSlots[slot] = key;
    }
  }

  private emitCam(p: ActorView): void {
    // scene.ts:425 -- Camera.lua follow at the 160x144 view
    const cx = Math.round((p.px + 16) * Q4);
    const cy = Math.round((p.py + 8) * Q4);
    if (cx !== this.lastCamX || cy !== this.lastCamY) {
      this.host.cam(cx, cy);
      this.lastCamX = cx;
      this.lastCamY = cy;
    }
  }

  private sheetIndex(spriteId: string | undefined): number {
    if (!spriteId) return -1;
    const hit = this.sheetCache.get(spriteId);
    if (hit !== undefined) return hit;
    const name = spriteId.replace(/^SPRITE_/, "").toLowerCase();
    const page = this.data?.atlas?.sprites?.[name];
    const index = typeof page === "number" ? page : -1;
    this.sheetCache.set(spriteId, index);
    return index;
  }

  private emitSlot(slot: number, sheet: number, frame: number, x: number, y: number, lift: number, flags: number): void {
    const b = slot * 6;
    const v = this.entVals;
    this.entSeen[slot] = 1;
    if (
      this.entShown[slot] !== 0 &&
      v[b] === sheet &&
      v[b + 1] === frame &&
      v[b + 2] === x &&
      v[b + 3] === y &&
      v[b + 4] === lift &&
      v[b + 5] === flags
    ) {
      return;
    }
    this.host.ent(slot, sheet, frame, x, y, lift, flags);
    v[b] = sheet;
    v[b + 1] = frame;
    v[b + 2] = x;
    v[b + 3] = y;
    v[b + 4] = lift;
    v[b + 5] = flags;
    this.entShown[slot] = 1;
  }

  private actor(slot: number, a: ActorView, ghost: boolean): void {
    if (a.visible === false) return;
    const def = a.spriteId ? this.data?.sprites?.[a.spriteId] : undefined;
    const frames = def?.frames ?? 6;
    const walker = def?.walker ?? frames > 1;
    const facing = a.facing ?? "down";
    const walking = (a.phase ?? 0) === 1;
    const frame = a.frame ?? (frames <= 1 ? 0 : walking && walker ? WALK[facing]! : STAND[facing]!);
    const mirror =
      a.mirror ??
      (frames > 1 && (facing === "right" || ((facing === "down" || facing === "up") && walking && !!a.flip)));
    let flags = walker ? ENT_FLAG.walker : 0;
    if (ghost) flags |= ENT_FLAG.ghost;
    if (mirror) flags |= ENT_FLAG.mirror;
    this.emitSlot(
      slot,
      this.sheetIndex(a.spriteId),
      frame ?? 0,
      Math.round(a.px * Q4),
      Math.round(a.py * Q4),
      Math.round(a.lift ?? 0),
      flags,
    );
  }

  private emitEnts(vs: WorldViewState): void {
    this.entSeen.fill(0);
    if (vs.player) this.actor(0, vs.player, true);
    const npcs = vs.npcs ?? [];
    for (let i = 0; i < npcs.length && i + 1 < ENTS_MAX; i++) this.actor(i + 1, npcs[i]!, false);
    for (let slot = 0; slot < ENTS_MAX; slot++) {
      if (this.entSeen[slot] === 0 && this.entShown[slot] !== 0) {
        this.host.entHide(slot);
        this.entShown[slot] = 0;
      }
    }
  }

  private hideAllEnts(): void {
    for (let slot = 0; slot < ENTS_MAX; slot++) {
      if (this.entShown[slot] !== 0) {
        this.host.entHide(slot);
        this.entShown[slot] = 0;
      }
    }
    this.entSeen.fill(0);
  }
}
