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
import { BattleStage, type StageData } from "./battlestage.ts";
import { is2d } from "../../viewmode.ts";
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

/** One actor as World.viewState reports it (world/Player.ts ActorView). */
export interface ActorView {
  px: number;
  py: number;
  facing: string;
  phase?: number;
  mirror?: boolean;
  flip?: boolean;
  frame?: number;
  spriteId?: string;
  /** The sheet's gfx key ("sprites/chris"). */
  gfx?: string;
  visible?: boolean;
  lift?: number;
}

/** The parts of world/World.ts WorldView this reads. */
export interface WorldViewState {
  ready?: boolean;
  map?: { id: string };
  neighbors?: { id: string; ox: number; oy: number }[];
  camera?: { x: number; y: number; viewW: number; viewH: number };
  actors?: { kind: "player" | "npc"; view: ActorView; ox: number; oy: number }[];
  hideAll?: boolean;
  palette?: { daytime?: string; dark?: boolean };
  /** Older shapes (tests): */
  mapId?: string;
  player?: ActorView | { view: ActorView };
  npcs?: ActorView[];
  daytime?: string;
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

function playerOf(vs: WorldViewState): ActorView | undefined {
  const p = vs.player as (ActorView & { view?: ActorView }) | undefined;
  return p?.view ?? p;
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
  private lastNeighbours = "";
  private lastTint = -1;
  private started = false;

  private readonly stage: BattleStage;

  constructor(
    private readonly host: VoxelHost,
    private readonly data: WalkerData | null | undefined,
  ) {
    this.stage = new BattleStage(host, data as unknown as StageData);
  }

  /**
   * What surrounds the Gold screen's 160x144 on the 3DS's wider top screen:
   * the voxel world, full colour while it is the scene; dimmed behind a
   * full-screen menu or a battle (Game2.lua paintBattleSurround's "world"
   * mode, BG_WORLD_DIM); black before there is a world at all, where the
   * Lua's surround was the letterbox. A tint change rebakes the map once.
   */
  private emitTint(game: { world?: any; frameWorldActive?: boolean }): void {
    const want = !game.world || !game.world.map ? 0xff000000 : game.frameWorldActive === false ? 0xff707070 : 0xffffffff;
    if (want !== this.lastTint) {
      this.host.tint(want);
      this.lastTint = want;
    }
  }

  /** Emit this frame's scene from the game's world, if it has one. */
  emit(game: { world?: any; frameWorldActive?: boolean; options?: any }): void {
    if (!this.started) {
      // the overworld camera's opening rung, as the Kanto scene starts it
      // (scene.ts: PITCH_RUNGS[2] = 35 degrees); the player steers from there
      this.started = true;
      this.host.pitch(2);
    }
    // VIEW 2D: the Gold screen draws the map (map2d.ts) and the voxel world
    // stands down -- except for a battle staged in 3D (BATTLES 3D)
    const flat = is2d(game?.options?.view) && !(this.stage.wanted(game));
    if (flat) {
      if (this.lastTint !== 0xff000000) {
        this.host.tint(0xff000000);
        this.lastTint = 0xff000000;
      }
      this.clear();
      return;
    }
    this.emitTint(game);
    const world = game.world;
    const vs: WorldViewState | null = world && world.map && typeof world.viewState === "function" ? world.viewState() : null;
    if (!vs) {
      this.clear();
      return;
    }
    if (vs.ready === false) {
      this.clear();
      return;
    }
    const mapId = vs.mapId ?? vs.map?.id ?? world.map?.id;
    if (mapId) this.emitMaps(mapId, vs.neighbors);
    // a staged 3D battle owns the camera and the field (battlestage.ts)
    if (this.stage.emit(game, this.palettes(game))) {
      this.hideAllEnts();
      this.emitDaytime(vs);
      return;
    }
    if (vs.camera) {
      // the 160x144 view's centre: what the Lua's camera framed
      this.emitCamAt(vs.camera.x + vs.camera.viewW / 2, vs.camera.y + vs.camera.viewH / 2);
    } else {
      const p = playerOf(vs);
      if (p) this.emitCam(p);
    }
    this.emitEnts(vs);
    this.emitDaytime(vs);
  }

  /**
   * The world's palettes follow the clock (Palettes.lua clockDaytime), or
   * whatever the world says it is drawn in -- a dark cave is DARK.
   */
  private emitDaytime(vs: WorldViewState): void {
    let name = vs.palette?.dark ? "DARK" : (vs.daytime ?? vs.palette?.daytime);
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

  /** Gold's palettes table (the battle cards' species colours), looked up once. */
  private palettesCache: unknown;
  private palettes(game: any): any {
    if (this.palettesCache === undefined) this.palettesCache = game?.data?.gen2Palettes ?? game?.data?.palettes ?? null;
    return this.palettesCache;
  }

  /** No world: nothing on the stage. */
  clear(): void {
    this.stage.end();
    for (let slot = 0; slot < 5; slot++) {
      if (this.mapSlots[slot] !== null) {
        this.host.mapHide(slot);
        this.mapSlots[slot] = null;
      }
    }
    this.lastMapId = null;
    this.hideAllEnts();
  }

  private emitMaps(mapId: string, given?: { id: string; ox: number; oy: number }[]): void {
    const nkey = given ? given.map((n) => `${n.id}@${n.ox},${n.oy}`).join(";") : "";
    if (mapId === this.lastMapId && nkey === this.lastNeighbours) return;
    this.lastMapId = mapId;
    this.lastNeighbours = nkey;
    const maps = this.data?.maps ?? {};
    const cur = maps[mapId];
    const desired: ({ id: string; index: number; ox: number; oy: number } | null)[] = [];
    if (cur) desired.push({ id: mapId, index: cur.index, ox: 0, oy: 0 });
    for (const n of (given ?? neighbours(maps, mapId)).slice(0, 4)) {
      if (!maps[n.id]) continue;
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
    this.emitCamAt(p.px + 16, p.py + 8);
  }

  private emitCamAt(x: number, y: number): void {
    const cx = Math.round(x * Q4);
    const cy = Math.round(y * Q4);
    if (cx !== this.lastCamX || cy !== this.lastCamY) {
      this.host.cam(cx, cy);
      this.lastCamX = cx;
      this.lastCamY = cy;
    }
  }

  private sheetIndex(spriteId: string | undefined, gfx?: string): number {
    const id = gfx ?? spriteId;
    if (!id) return -1;
    const hit = this.sheetCache.get(id);
    if (hit !== undefined) return hit;
    const name = gfx ? gfx.replace(/^sprites\//, "") : id.replace(/^SPRITE_/, "").toLowerCase();
    const page = this.data?.atlas?.sprites?.[name];
    const index = typeof page === "number" ? page : -1;
    this.sheetCache.set(id, index);
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

  private actor(slot: number, a: ActorView, ghost: boolean, ox = 0, oy = 0): void {
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
      this.sheetIndex(a.spriteId, a.gfx),
      frame ?? 0,
      Math.round((a.px + ox) * Q4),
      Math.round((a.py + oy) * Q4),
      Math.round(a.lift ?? 0),
      flags,
    );
  }

  private emitEnts(vs: WorldViewState): void {
    this.entSeen.fill(0);
    if (vs.actors) {
      // the Lua's Y-sorted draw list: the player in slot 0, everyone else after
      let slot = 1;
      for (const e of vs.hideAll ? [] : vs.actors) {
        if (e.kind === "player") this.actor(0, e.view, true, e.ox, e.oy);
        else if (slot < ENTS_MAX) this.actor(slot++, e.view, false, e.ox, e.oy);
      }
    } else {
      const p = playerOf(vs);
      if (p) this.actor(0, p, true);
      const npcs = vs.npcs ?? [];
      for (let i = 0; i < npcs.length && i + 1 < ENTS_MAX; i++) this.actor(i + 1, npcs[i]!, false);
    }
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
