// The overworld controller SLICE. Ports the world-facing core of gen1recomp
// src/world/OverworldController.lua: map entry and connections, grid
// movement, ledges, warps (arrival / collision / edge), NPC wander,
// scripted movement, sign/talk interaction, and the completed-step
// land-triggers with wild-encounter rolls.
//
// UPDATE ORDER MATTERS and mirrors OverworldController.lua:883 update():
// script runner -> emote hold -> NPC wander -> scripted movement -> input
// (gated on scripted/transitioning) -> player animation -> warp-entry
// staleness -> land-triggers (onStepComplete, suppressed on scripted
// steps). Trainer sight, surf, bikes, boulders, spinners, Safari, poison,
// menus and the hand-ported map scripts are outside this slice.

import type { EncounterDef, MapObject, VoxelmonData } from "../data.ts";
import type { Rng } from "../rng.ts";
import { roll as encounterRoll } from "../rules/encounter.ts";
import { WARP_FADE_OUT } from "../rules/timing.ts";
import { canMove, occupied, target, type Dir, type Mover, type TilePairs } from "./collision.ts";
import { defPassable, GameMap, isOutside } from "./map.ts";
import { NPC } from "./npc.ts";
import { Player } from "./player.ts";
import { talkScript, itemBallScript, itemBallFlag, TEXT_BILLSHOUSE_PC } from "./mapscripts.ts";
import { martGreetScript } from "./marts.ts";
import { nurseGreetScript } from "./nurses.ts";
import { pcTileAt } from "./pctiles.ts";
import { ScriptRunner, type ScriptRow, type ScriptWorld } from "./script.ts";
import { MAP_SCRIPTS, type MapScript } from "./mapscripts.ts";
import {
  destination,
  onArrive,
  onCollision,
  onEdge,
  type LastOutdoor,
  type WarpCarpets,
} from "./warp.ts";
import type { MapWarp } from "../data.ts";

// HM Flash: pokered's TilesetDarknessLookup lists exactly ROCK_TUNNEL_1F and
// ROCK_TUNNEL_B1F as dark-until-lit (Diglett's Cave, despite also being a
// cave, is normally lit). This port has no per-radius flashlight cutout —
// the renderer's terrain is a baked flat vertex buffer with no per-frame
// lighting pass (crates/pocketvoxel-3ds/src/main.rs build_map) — so darkness
// is a full-map colour multiply (Scene.tint, baked into vertex colour at
// build time) instead of a lit circle around the player; Flash clears it
// for the rest of the visit, matching the mechanic's actual effect (you can
// see the room again) even though the presentation is coarser than the GB's.
const DARK_MAPS = new Set(["ROCK_TUNNEL_1F", "ROCK_TUNNEL_B1F"]);
/** 0xAABBGGRR. ~24% brightness: the GB blacks the screen OUTSIDE a lit
 * radius, which is only navigable because the radius exists. A uniform
 * multiply has no lit circle to walk by, so it has to stay light enough to
 * make out the cave's shape — dark and unpleasant, still playable. Drop it
 * toward 0x14 for a harsher cave, raise it for a kinder one. */
const DARK_TINT = 0xff3c_3c_3c;
const BRIGHT_TINT = 0xffff_ffff;

// OverworldController.lua:37
const COMPASS: Record<Dir, "north" | "south" | "east" | "west"> = {
  up: "north",
  down: "south",
  left: "west",
  right: "east",
};

export interface SaveSlice {
  flags: Record<string, boolean>;
  inventory: Record<string, number>;
  bagOrder?: string[];
  player: { name: string; rival: string };
  lastOutdoor?: LastOutdoor;
  lastHeal?: { map: string; x: number; y: number; outdoor?: LastOutdoor };
  /**
   * gen1recomp WorldAPI.lua:125-133 / the wToggleableObjectFlags array: per
   * map, per object name, an explicit visible flag written by ShowObject /
   * HideObject (Commands.lua:540-546). Present entry wins over the compiled-in
   * default, so a cross-map toggle (Oak's lab hiding the Viridian sleeper)
   * persists to when that map is next entered. true = shown, false = hidden.
   */
  objectToggles?: Record<string, Record<string, boolean>>;
  /** Cells a cut tree has been chopped at, permanently: per map id, per
   * `"cx,cy"` cell key (voxelmon/cook/structures.ts cuttableCells' own key
   * format). Reapplied as stamp-off ops at setMap so a cut tree stays gone
   * across a reload/re-entry, the way objectToggles persists object hides. */
  cutTrees?: Record<string, Record<string, boolean>>;
}

/** What the overworld needs from the game shell (game.ts implements it). */
export interface OverworldShell {
  data: VoxelmonData;
  save: SaveSlice;
  input: {
    isDown(btn: "up" | "down" | "left" | "right" | "a" | "b" | "start" | "select"): boolean;
    wasPressed(btn: "up" | "down" | "left" | "right" | "a" | "b" | "start" | "select"): boolean;
  };
  /** Encounter/battle roll stream (the guest owns the RNG). */
  rng: Rng;
  /** NPC wander stream, separate so ambience can't perturb encounters. */
  npcRng: Rng;
  /** Sound.lua:190 play — the field cues the overworld itself triggers. */
  audio: { playSfx(name: string): void };
  /** Pokemon.lua:90 heal over the party (Commands.lua:587 heal_party). */
  healParty(): void;
  /** Music.lua:383 playOnce — a jingle; Music.lua:407 restoreMap after it. */
  playOnce(song: string): void;
  restoreMapMusic(): void;
  /** Music.lua:339 playMap, called where the reference calls it. */
  startMapMusic(mapId: string): void;
  showText(text: string, onDone?: () => void): void;
  showChoice(text: string, choice: (yes: boolean) => void): void;
  pushWarpFade(frames: number, midpoint: () => void, onDone?: () => void): void;
  pushStubBattle(species: string, level: number): void;
  /** Toggle a cooked map decoration stamp (Scene.stamps_off / host.stamp) on
   * or off by cell — cut trees and the S.S. Anne hull's per-cell split
   * (voxelmon/cook/mesh.ts VERMILION_DOCK, mapscripts.ts's onStep) both ride
   * this same mechanism. */
  stamp(mapId: number, cx: number, cy: number, on: boolean): void;
  /** Scene-wide colour multiply (Scene.tint / host.tint) — HM Flash's dark-
   * cave dimming (see DARK_MAPS below) is the first caller; 0xffffffff is
   * full brightness (no-op multiply). */
  tint(abgr: number): void;
}

interface ScriptMove {
  entity: Player | NPC;
  dir?: Dir;
  remaining: number;
  onDone?: () => void;
  inPlace?: boolean;
}

export interface EmoteHold {
  entity: Player | NPC;
  kind: number;
  frames: number;
  onDone?: () => void;
}

// OverworldController.lua:164 computeNeighbors — walk the connection graph
// `hops` out, composing the strip offsets, deduped by map id (BFS, so a
// direct connection always wins over a two-hop path). Offsets are world
// pixels; connection offsets are in blocks (32 px). The view-reach widening
// (reachW/reachH) is a renderer concern and stays out of the port.
export function computeNeighbors(
  maps: NonNullable<VoxelmonData["maps"]>,
  rootId: string,
  hops: number,
): { id: string; ox: number; oy: number }[] {
  const out: { id: string; ox: number; oy: number }[] = [];
  const rootDef = maps[rootId];
  if (!rootDef) return out;
  const placed = new Set([rootId]);
  const queue: { def: typeof rootDef; ox: number; oy: number; hops: number }[] = [
    { def: rootDef, ox: 0, oy: 0, hops: 0 },
  ];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi];
    qi += 1;
    for (const [dir, conn] of Object.entries(cur.def.connections ?? {})) {
      const destDef = maps[conn.map];
      if (!destDef || placed.has(conn.map)) continue;
      placed.add(conn.map);
      let ox: number;
      let oy: number;
      if (dir === "north") {
        ox = conn.offset * 32;
        oy = -destDef.height * 32;
      } else if (dir === "south") {
        ox = conn.offset * 32;
        oy = cur.def.height * 32;
      } else if (dir === "west") {
        ox = -destDef.width * 32;
        oy = conn.offset * 32;
      } else {
        ox = cur.def.width * 32;
        oy = conn.offset * 32;
      }
      ox += cur.ox;
      oy += cur.oy;
      if (cur.hops + 1 <= hops) {
        out.push({ id: conn.map, ox, oy });
        if (cur.hops + 1 < hops) {
          queue.push({ def: destDef, ox, oy, hops: cur.hops + 1 });
        }
      }
    }
  }
  return out;
}

// The stable key for the object-toggle store: an object_event name with any
// TEXT_ prefix stripped, so a cooked object (name = "VIRIDIANCITY_OLD_MAN")
// and a script's ShowObject/HideObject argument (either the name or its
// TEXT_* const) resolve to the same slot in save.objectToggles.
export function objectToggleKey(nameOrObj: string | { name?: string; text?: string }): string {
  const raw =
    typeof nameOrObj === "string" ? nameOrObj : nameOrObj.name ?? nameOrObj.text ?? "";
  return String(raw).toUpperCase().replace(/^TEXT_/, "");
}

// gen1recomp src/save_convert/data/toggle_objects.lua bits 1-2: the Viridian
// old-man pair's compiled-in visibility (there, `true` = default VISIBLE). The
// voxel cooker doesn't emit those default-hidden bits, so only the entry that
// must start hidden is seeded — the walking old man at (17,5), who the Pokédex
// swap (data/scripts/oaks_lab.lua) shows once the parcel is delivered. The
// sleeper stays on his compiled default (visible) and needs no entry.
const TOGGLE_DEFAULT_HIDDEN: Record<string, Record<string, boolean>> = {
  VIRIDIAN_CITY: { VIRIDIANCITY_OLD_MAN: true },
};

export class Overworld implements ScriptWorld {
  /** The content-boundary test: a map outside the pak's cooked set exists
   * as DATA (warp targets, connection math) but must never be entered —
   * the pak has no geometry for it, so warps bump and connections neither
   * show nor cross. Old gamedata without the list means "everything". */
  isCooked(mapId: string): boolean {
    if (mapId === "LAST_MAP") return true; // resolves to a map we came from
    const list = this.shell.data.cookedMaps;
    return !list || list.includes(mapId);
  }

  readonly shell: OverworldShell;
  map!: GameMap;
  player!: Player;
  npcs: NPC[] = [];
  entities: Mover[] = [];
  runner: ScriptRunner;
  scriptMoves: ScriptMove[] = [];
  /** A trainer has spotted the player and is engaging (sight -> "!" -> walk-up
   * -> battle); blocks input and re-sighting until the battle resolves. */
  engaging = false;
  emote?: EmoteHold;
  lastOutdoor?: LastOutdoor;
  standingOnWarp = false;
  warpEntryCell?: { x: number; y: number };
  transitioning = false;
  private doorWarp = false;
  /** OverworldController.lua:1221 — 16 ticks between wall-bonk cues. */
  private bumpCooldown = 0;
  /** A play_once jingle is in flight (Music.lua:389 pendingRestore). */
  private oneShotPending = false;
  /** OverworldController.lua:1455 — the map whose theme the seam step owes. */
  pendingSeamMusic: string | null = null;
  private joyLatch?: { a?: boolean };
  private npcPool = new Map<string, NPC>();
  readonly tilePairs: TilePairs;
  readonly carpets?: WarpCarpets;
  /** Battle-port seam bookkeeping the tests and the sim read. */
  encounterCount = 0;
  lastEncounter?: { species: string; level: number };

  constructor(shell: OverworldShell) {
    this.shell = shell;
    const field = shell.data.field as
      | { tilePairs?: TilePairs; warpCarpets?: WarpCarpets }
      | undefined;
    // Collision.load equivalent (Collision.lua:36)
    this.tilePairs = field?.tilePairs ?? { land: [], water: [] };
    this.carpets = field?.warpCarpets;
    this.runner = new ScriptRunner(this);
  }

  get data(): VoxelmonData {
    return this.shell.data;
  }

  get save(): SaveSlice {
    return this.shell.save;
  }

  // OverworldController.lua:209 enter
  enter(mapId: string, x: number, y: number, facing?: Dir): void {
    // survives save/load: a loaded game may start inside a building whose
    // exit mat is a LAST_MAP warp
    this.lastOutdoor = this.shell.save.lastOutdoor;
    this.setMap(mapId, x, y, facing, { via: "boot" });
    // boot/load: derive the flag from the tile the save left us standing on
    // (MapEntryAfterBattle's IsPlayerStandingOnWarp — issue #378)
    this.refreshStandingOnWarp();
  }

  // OverworldController.lua:283 setMap — the single choke point for every
  // map-id change, warps and seamless connection crossings alike.
  setMap(
    mapId: string,
    x: number,
    y: number,
    facing?: Dir,
    opts?: { via?: string; seamless?: boolean },
  ): void {
    const def = this.shell.data.maps?.[mapId];
    if (!def) throw new Error(`unknown map ${mapId}`);
    // crossConnection re-arms this right after; clearing here is what keeps a
    // warp or a reload from leaving a stale deferred PlayMapMusic pending
    // (OverworldController.lua:437-439).
    this.pendingSeamMusic = null;
    const tileset = this.shell.data.tilesets?.[def.tileset];
    if (!tileset) throw new Error(`unknown tileset ${def.tileset} for ${mapId}`);
    this.map = new GameMap(def, tileset);
    // Cut trees stay cut across a reload/re-entry: reapply every stamp-off
    // this save recorded for THIS map (setMap is the single choke point, so
    // every entry path — warp, seam, boot — gets this for free, the same
    // way objectToggles' hides get reapplied below via objectVisible).
    const cut = this.save?.cutTrees?.[mapId];
    if (cut) {
      for (const key of Object.keys(cut)) {
        if (!cut[key]) continue;
        const [cx, cy] = key.split(",").map(Number);
        this.stamp(def.index, cx, cy, false);
      }
    }
    // HM Flash only lasts the current visit (pokered: leaving and
    // re-entering a dark cave darkens it again) — see DARK_MAPS' doc.
    this.tint(DARK_MAPS.has(mapId) ? DARK_TINT : BRIGHT_TINT);
    // NPC instances persist across connection crossings in the pool (keyed
    // by NPC.id) so nothing snaps back to its spawn point at a seam; warps
    // rebuild from scratch, like the original's per-entry sprite init
    // (OverworldController.lua:376-385).
    if (!(opts?.seamless && this.npcPool.size > 0)) {
      this.npcPool = new Map();
    }
    this.npcs = [];
    for (const obj of def.objects ?? []) {
      if (this.objectVisible(obj)) {
        const npc = this.pooledNPC(mapId, obj);
        npc.frozen = false;
        this.npcs.push(npc);
      }
    }
    if (this.player) {
      this.player.cellX = x;
      this.player.cellY = y;
      this.player.px = x * 16;
      this.player.py = y * 16;
      this.player.facing = facing ?? this.player.facing;
      this.player.moving = false;
      this.player.targetX = undefined;
      this.player.targetY = undefined;
    } else {
      this.player = new Player(x, y, facing);
    }
    this.entities = [this.player, ...this.npcs];
    console.log("NPCS " + (this.npcs as any[]).map((n: any) =>
      JSON.stringify(n, (k, v) => (typeof v === "object" && v !== null && k !== "" ? undefined : v))).join(" | "));
  }

  // OverworldController.lua:110-114 objectVisible — the spawn filter. A
  // save-backed toggle (save.objectToggles[map][name]) wins over the
  // compiled-in default, the way IsObjectHidden reads wToggleableObjectFlags,
  // so a persisted ShowObject/HideObject settles here at spawn.
  private objectVisible(obj: MapObject): boolean {
    const key = objectToggleKey(obj);
    const toggles = this.save?.objectToggles?.[this.map.id];
    if (toggles && Object.prototype.hasOwnProperty.call(toggles, key)) {
      // an explicit toggle decides visibility outright (an item ball that was
      // shown again would still respect its pickup flag below)
      if (!toggles[key]) return false;
    } else {
      // no toggle recorded -> the compiled-in default. The voxel cooker does
      // not carry pokered's toggleable_objects default-hidden bits, so the
      // entries this build needs are seeded (save_convert/data/toggle_objects
      // .lua): the Viridian walker defaults hidden until the Pokédex swap.
      if (TOGGLE_DEFAULT_HIDDEN[this.map.id]?.[key]) return false;
      if ((obj as MapObject & { hidden?: boolean }).hidden) return false;
    }
    // A collected item ball stays gone across reloads: its pickup flag hides
    // it at spawn the way pokered's missable-object flag keeps it despawned.
    if (obj.item && this.save?.flags?.[itemBallFlag(this.map.id, obj.text)]) {
      return false;
    }
    return true;
  }

  // OverworldController.lua:131 pooledNPC
  private pooledNPC(mapId: string, obj: MapObject): NPC {
    const key = `${mapId}_obj_${obj.index}`;
    let npc = this.npcPool.get(key);
    if (!npc) {
      npc = new NPC(mapId, obj, this.shell.npcRng);
      this.npcPool.set(key, npc);
    }
    return npc;
  }

  // OverworldController.lua:883 update
  update(): void {
    if (this.bumpCooldown > 0) this.bumpCooldown -= 1;
    this.runner.update();
    // the emotion-bubble pause holds the world for a beat
    // (OverworldController.lua:1018); only the player animates through it
    if (this.emote) {
      this.emote.frames -= 1;
      if (this.emote.frames <= 0) {
        const done = this.emote.onDone;
        this.emote = undefined;
        done?.();
      }
      this.player.update();
      return;
    }
    for (const npc of this.npcs) {
      npc.update(this.map, this.entities, this.shell.npcRng, this.tilePairs);
    }
    this.updateScriptMoves();
    // emote is included: a hold queued from a scriptMove onDone is assigned
    // mid-frame, after the early emote return above already missed it
    // (OverworldController.lua:1045-1052)
    let scripted =
      this.runner.isRunning() || this.scriptMoves.length > 0 || this.emote !== undefined ||
      this.engaging;
    // OverworldController.lua:1070 — scan for a trainer sighting on the step
    // that just landed, then re-gate: a spotted player can never start another
    // step (CheckFightingMapTrainers zeroes the joypad the instant it engages).
    if (!scripted && !this.transitioning) {
      this.checkTrainerSight();
      scripted =
        this.runner.isRunning() || this.scriptMoves.length > 0 || this.emote !== undefined ||
        this.engaging;
    }
    if (!scripted && !this.transitioning) {
      this.handleInput();
    }
    const stepped = this.player.update();
    // the warp-arrival cell goes stale the instant the player's real cell
    // leaves it, scripted walk-outs included (OverworldController.lua:1071)
    const entry = this.warpEntryCell;
    if (entry && (this.player.cellX !== entry.x || this.player.cellY !== entry.y)) {
      this.warpEntryCell = undefined;
    }
    // OverworldController.lua:1075 — the seam step landed, so the deferred
    // PlayMapMusic runs now (and only if we are still on the map it was
    // armed for; a warp taken mid-step drops it).
    if (stepped && this.pendingSeamMusic) {
      const pending = this.pendingSeamMusic;
      this.pendingSeamMusic = null;
      if (pending === this.map.id) this.shell.startMapMusic(pending);
    }
    if (stepped && !scripted) {
      this.onStepComplete();
    }
  }

  // OverworldController.lua:1113 dirHeld (hJoyHeld & PAD_CTRL_PAD)
  dirHeld(): boolean {
    const input = this.shell.input;
    return (
      input.isDown("up") || input.isDown("down") || input.isDown("left") || input.isDown("right")
    );
  }

  // OverworldController.lua:1131 — BIT_STANDING_ON_WARP: the warp under the
  // player's feet may only fire from a collision (blocked step / map edge)
  // while this flag is set.
  canCollisionWarp(): boolean {
    return this.standingOnWarp;
  }

  // OverworldController.lua:1138 refreshStandingOnWarp — a door tile keeps
  // the flag, a stair/ladder warp tile clears it (issues #230/#378).
  refreshStandingOnWarp(): void {
    const p = this.player;
    this.standingOnWarp = false;
    if (
      this.map.warpAtCell(p.cellX, p.cellY) &&
      !(this.map.isWarpTileCell(p.cellX, p.cellY) && !this.map.isDoorTileCell(p.cellX, p.cellY))
    ) {
      this.standingOnWarp = true;
    }
  }

  // OverworldController.lua:1148 handleInput — gated on the walk counter:
  // A and direction initiation are only acted on standing on a tile (#286).
  handleInput(): void {
    const input = this.shell.input;
    if (this.player.moving) {
      // OverworldController.lua:1177: a button pressed mid-step and STILL
      // HELD when the step lands reads as a fresh press at the next poll
      // (hJoyLast frozen for the animation, #525); one released before then
      // is genuinely lost.
      if (input.wasPressed("a")) {
        this.joyLatch = { ...this.joyLatch, a: true };
      }
      return;
    }
    const latch = this.joyLatch;
    this.joyLatch = undefined;
    if (input.wasPressed("a") || (latch?.a === true && input.isDown("a"))) {
      this.interact();
      return;
    }
    // START menu: outside the slice (the early return still skips the
    // turn re-arm below, like the original's jump to .displayDialogue)
    if (input.wasPressed("start")) {
      (this as any).shell?.openStartMenu?.();
      return;
    }
    for (const dir of ["up", "down", "left", "right"] as Dir[]) {
      if (!input.isDown(dir)) continue;
      if (!this.player.moving && this.player.facing === dir) {
        if (this.checkEdgeExit(dir)) return;
        if (this.checkLedgeHop(dir)) return;
        // boulder pushes: outside the slice
      }
      // Content boundary, standing case: a warp TILE whose destination map
      // is not in the cooked set must not even be stepped on (the real game
      // warps the instant you land — with the warp locked, landing would
      // leave the player standing inside the doorway's geometry, e.g. the
      // Diglett's Cave mouth on Route 2). Bump instead.
      {
        const [tx, ty] = target(this.player.cellX, this.player.cellY, dir);
        const w = this.map.warpAtCell(tx, ty);
        if (w && this.map.isWarpTileCell(tx, ty) && !this.isCooked(w.def.destMap)) {
          this.player.facing = dir;
          this.player.bumpFrames = this.player.stepFrames;
          // ENDS the poll, like every other outcome here (:1224 returns the
          // tryMove result): a poll handles ONE held direction, so a held
          // diagonal must not walk on the other axis, and falling through to
          // the turn re-arm below would hand back a turn window the original
          // never grants while a direction is down.
          return;
        }
      }
      const result = this.player.tryMove(dir, this.map, this.entities, this.tilePairs);
      // a collision while standing on a warp square fires the warp when
      // the extra check passes (CheckWarpsCollision), only while
      // BIT_STANDING_ON_WARP is set (issue #230)
      if (result === "blocked" && this.canCollisionWarp()) {
        const w = onCollision(this.map, this.carpets, this.player.cellX, this.player.cellY, dir);
        if (w) {
          this.takeWarp(w.def);
          return;
        }
      }
      // OverworldController.lua:1218-1223: the bonk. Bumping another entity
      // is silent, and the 16-frame cooldown is what keeps a held direction
      // into a wall from machine-gunning the cue.
      if (
        result === "blocked" &&
        this.player.lastBlockReason !== "entity" &&
        this.bumpCooldown <= 0
      ) {
        this.shell.audio.playSfx("Collision");
        this.bumpCooldown = 16;
      }
      return;
    }
    // OverworldController.lua:1233: a poll that found no direction held is
    // what re-arms the next turn in place (#415); the early returns above
    // skip it exactly as the original's jumps do.
    this.player.turnArmed = true;
  }

  // OverworldController.lua:1322 checkLedgeHop — standing tile + ledge tile
  // in front + matching input direction -> jump two cells.
  checkLedgeHop(dir: Dir): boolean {
    const p = this.player;
    const tileset = this.map.def.tileset;
    const standing = this.map.cellTile(p.cellX, p.cellY);
    const [fx, fy] = target(p.cellX, p.cellY, dir);
    if (!this.map.inBounds(fx, fy)) return false;
    const front = this.map.cellTile(fx, fy);
    const ledges = (this.shell.data.field as { ledges?: Array<Record<string, unknown>> })
      ?.ledges;
    for (const ledge of ledges ?? []) {
      if (
        ((ledge.tileset as string | undefined) ?? "OVERWORLD") === tileset &&
        ledge.facing === dir &&
        ledge.input === dir &&
        ledge.standingTile === standing &&
        ledge.ledgeTile === front
      ) {
        const [lx, ly] = target(fx, fy, dir);
        if (!this.map.inBounds(lx, ly)) {
          // OverworldController.lua:1337: the landing is on the CONNECTED
          // map (issue #223) — validate the seam cell like crossConnection,
          // hop the first cell, hand the second to checkEdgeExit.
          const landing = this.connectionLanding(dir);
          if (!landing) return false;
          const { dest, ts, x, y } = landing;
          if (!defPassable(dest, ts, x, y, p.surfing)) return false;
          this.shell.audio.playSfx("Ledge"); // OverworldController.lua:1352
          p.hopFrames = 32;
          p.hopTotal = 32;
          this.scriptMove(p, dir, 1, () => this.checkEdgeExit(dir));
          return true;
        }
        if (!occupied(this.entities, lx, ly, p) && this.map.isWalkableCell(lx, ly)) {
          this.shell.audio.playSfx("Ledge"); // OverworldController.lua:1359
          p.hopFrames = 32; // jump arc (cosmetic; entities can't collide mid-hop
          p.hopTotal = 32; // because the hop is a scripted move that owns input)
          this.scriptMove(p, dir, 2);
          return true;
        }
      }
    }
    return false;
  }

  // OverworldController.lua:1370 checkEdgeExit — walking off the map edge:
  // connection crossing or edge warp (exit mats).
  checkEdgeExit(dir: Dir): boolean {
    const p = this.player;
    const [tx, ty] = target(p.cellX, p.cellY, dir);
    if (this.map.inBounds(tx, ty)) return false;
    const w = onEdge(this.map, p.cellX, p.cellY, dir);
    if (w) {
      // only with BIT_STANDING_ON_WARP set: pushing into the edge beside a
      // staircase bonks instead of bouncing floors (issue #230), while the
      // door mat you warped in on keeps it and exits (issue #378)
      if (!this.canCollisionWarp()) return false;
      this.takeWarp(w.def);
      return true;
    }
    const conn = this.map.connection(COMPASS[dir]);
    if (conn) {
      return this.crossConnection(dir, conn);
    }
    return false;
  }

  // OverworldController.lua:1396 connectionLanding — landing cell on the
  // connected map for a step off this map's edge (destX = curX - offset*2).
  connectionLanding(dir: Dir) {
    const conn = this.map.connection(COMPASS[dir]);
    if (!conn) return null;
    const dest = this.shell.data.maps?.[conn.map];
    if (!dest) return null;
    const ts = this.shell.data.tilesets?.[dest.tileset];
    if (!ts) return null;
    const p = this.player;
    const destW = dest.width * 2;
    const destH = dest.height * 2;
    let x: number;
    let y: number;
    if (dir === "up") {
      x = p.cellX - conn.offset * 2;
      y = destH - 1;
    } else if (dir === "down") {
      x = p.cellX - conn.offset * 2;
      y = 0;
    } else if (dir === "left") {
      x = destW - 1;
      y = p.cellY - conn.offset * 2;
    } else {
      x = 0;
      y = p.cellY - conn.offset * 2;
    }
    x = Math.max(0, Math.min(destW - 1, x));
    y = Math.max(0, Math.min(destH - 1, y));
    return { dest, ts, x, y, conn };
  }

  // OverworldController.lua:1425 crossConnection — the map data swaps while
  // the player is placed one cell before the entry point (their old world
  // position, which the neighbor strips render identically) and walks the
  // seam step. pokered's collision check reads the NEIGHBOR strip's tiles,
  // so stepping onto a solid tile of the connected map bumps like a wall.
  crossConnection(dir: Dir, _conn: { map: string; offset: number }): boolean {
    if (!this.isCooked(_conn.map)) return false; // content boundary: a wall
    const landing = this.connectionLanding(dir);
    if (!landing) return false;
    const { dest, ts, x, y } = landing;
    const p = this.player;
    if (!defPassable(dest, ts, x, y, p.surfing)) {
      return false;
    }
    this.setMap(dest.id, x, y, p.facing, { seamless: true });
    // place the player one cell before the seam and start the step into the
    // new map RIGHT NOW so there is no one-frame stall at the boundary
    const d: Record<Dir, [number, number]> = {
      up: [0, -1],
      down: [0, 1],
      left: [-1, 0],
      right: [1, 0],
    };
    p.cellX = x - d[dir][0];
    p.cellY = y - d[dir][1];
    p.px = p.cellX * 16;
    p.py = p.cellY * 16;
    p.facing = dir;
    p.targetX = x;
    p.targetY = y;
    p.moving = true;
    p.progress = 0;
    // fresh walk-cycle clock so the seam step always shows leg frames
    p.animClock = 0;
    p.stepFramesCur = p.stepFrames;
    // OverworldController.lua:1455 — the new map's theme is DEFERRED to the
    // frame the seam step lands (issue #93). Starting it here would swap the
    // song while the player is still visibly on the old map's last cell.
    this.pendingSeamMusic = dest.id;
    // FixedStep:discardCatchup (OverworldController.lua:1477) is a no-op
    // here: the voxel host runs exactly one tick per frame, so there is no
    // catch-up accumulator to discard.
    return true;
  }

  // OverworldController.lua:1729 interact — the A press: NPC (with the
  // counter-tile reach-across), then sign. Card-key doors, hidden objects
  // and bookshelves are outside the slice.
  interact(): void {
    const p = this.player;
    const [fx, fy] = p.facingCell();
    let npc = this.npcAtCell(fx, fy);
    if (!npc && this.map.isCounterCell(fx, fy)) {
      // talk across counters (mart clerks, nurses)
      const [fx2, fy2] = target(fx, fy, p.facing);
      npc = this.npcAtCell(fx2, fy2);
    }
    if (npc) {
      if (!npc.moving) {
        this.talkTo(npc);
      }
      return;
    }
    const sign = this.map.signAtCell(fx, fy);
    if (sign) {
      this.showMapText(sign.text);
      return;
    }
    // BillsHousePC (OverworldController.lua:2248, hidden_event 1,4): Bill's
    // OWN PC is the cell-separator, not box storage — checked before the
    // generic pcTiles loop below, matching the reference's check order.
    if (this.map.id === "BILLS_HOUSE" && fx === 1 && fy === 4 && p.facing === "up") {
      this.showMapText(TEXT_BILLSHOUSE_PC);
      return;
    }
    // Bill's PC: a hidden PC tile (OverworldController.lua:2019). Pressing A
    // facing it opens box storage.
    if (pcTileAt(this.map.id, fx, fy, p.facing)) {
      (this.shell as unknown as { openBox?: () => void }).openBox?.();
      return;
    }
  }

  // OverworldController.lua:2520 talkTo — freeze, then dispatch the object's
  // TEXT_* constant. Item balls, static encounters, trainer engagement and
  // TX_SCRIPT marts/nurses are the battle/menu ports' seams.
  talkTo(npc: NPC): void {
    npc.frozen = true;
    const unfreeze = () => {
      npc.frozen = false;
    };
    this.showMapText(npc.def.text, npc, unfreeze);
  }

  // OverworldController.lua:3241 showMapText — a TEXT_* constant goes to the
  // map's hand-ported script if it has one (MapScripts.lua:239 talkScript),
  // and to the plain extracted line otherwise. The scripted path is what
  // makes a text_asm branch branch: the extracted text of one of those
  // pointers is only ever its FIRST case, so without the script Mom reads the
  // wake-up line forever and Oak never stops warning you about the grass.
  showMapText(textConst: string, npc?: NPC, onDone?: () => void): void {
    // A registered talk script wins; otherwise an object with an `item` field
    // is a ground pickup and the item-ball script is synthesised for it.
    const talk = talkScript(this.map.id, textConst);
    const script =
      (typeof talk === "function" ? talk(this, this.save) : talk) ??
      itemBallScript(this.map.id, npc?.def) ??
      martGreetScript(this.map.id, textConst) ??
      nurseGreetScript(textConst);
    if (script && !this.runner.isRunning()) {
      if (npc) npc.frozen = true;
      this.runner.run(script, {
        npc,
        onDone: () => {
          if (this.oneShotPending) {
            // Music.lua:403 oneShotPlaying holds the script until the jingle
            // ends and Music.update restores the theme; this surface cannot
            // ask, so the theme comes back when the script does.
            this.oneShotPending = false;
            this.shell.restoreMapMusic();
          }
          onDone?.();
        },
      });
      return;
    }
    const text = this.resolveText(textConst);
    if (text !== null) {
      if (npc) npc.facePlayer(this.player);
      this.shell.showText(text, onDone);
    } else {
      onDone?.();
    }
  }

  // ScriptWorld (script.ts) — the services a command reaches -------------

  /** Commands.lua:587 heal_party. */
  healParty(): void {
    this.shell.healParty();
  }

  /** host.stamp passthrough — see OverworldShell.stamp. */
  stamp(mapId: number, cx: number, cy: number, on: boolean): void {
    this.shell.stamp(mapId, cx, cy, on);
  }

  /** host.tint passthrough — see OverworldShell.tint. */
  tint(abgr: number): void {
    this.shell.tint(abgr);
  }

  /** Commands.lua:533 play_once — see showMapText's restore note. */
  playOnce(songId: string, onDone: () => void): void {
    this.oneShotPending = true;
    this.shell.playOnce(songId);
    onDone();
  }

  /**
   * Commands.lua:1216 fade — the overlay ramps to the colour and back. The
   * voxel surface has no overlay op, so the port spends the ramp's frames the
   * way it spends every other fade's (game.ts WarpFadeState holds the world).
   */
  fade(_dir: "in" | "out", frames: number, onDone: () => void): void {
    this.shell.pushWarpFade(frames, () => {}, onDone);
  }

  /** Commands.lua:162 face_player. */
  facePlayer(npc: NPC): void {
    npc.facePlayer(this.player);
  }

  // src/core/Data.lua:304 resolveText — map label + TEXT_* const through
  // text_pointers; a text_asm entry falls back to its extracted _Label
  // string when one exists (#318).
  resolveText(textConst: string): string | null {
    const pointers = this.shell.data.text_pointers as
      | Record<string, Record<string, { label?: string; text?: string; asm?: boolean }>>
      | undefined;
    const texts = this.shell.data.text as Record<string, string> | undefined;
    const entry = pointers?.[this.map.def.label]?.[textConst];
    if (!entry || !texts) return null;
    if (entry.text) {
      const s = texts[entry.text];
      if (s) return s;
    }
    if (entry.label) {
      const s = texts[`_${entry.label}`];
      if (s) return s;
    }
    return null;
  }

  // OverworldController.lua:1713
  npcAtCell(cx: number, cy: number): NPC | undefined {
    return this.npcs.find(
      (npc) =>
        !(npc as { hidden?: boolean }).hidden &&
        ((npc.cellX === cx && npc.cellY === cy) || (npc.targetX === cx && npc.targetY === cy)),
    );
  }

  // OverworldController.lua:3361 onStepComplete — the completed-step
  // land-triggers, in the original's order: warp-entry staleness, the
  // standing-on-warp refresh, arrival/held-collision warps, then the wild
  // encounter roll. (Spinners, badge gates, forced movement, Safari,
  // day-care, poison and repel are outside the slice.)
  onStepComplete(): void {
    // A map's land-triggers run first (OverworldController.lua:3502): the
    // onStep function hook (story cutscene logic) or a declarative coord
    // trigger. Fires for ANY map that registers one — the two _ONSTEP_HOST
    // entries are checked too so the original Pallet/Oak hooks still run.
    if (!this.runner.isRunning()) {
      const label = (this as any).map?.id ?? "";
      const script = (MAP_SCRIPTS as any)[label] as MapScript | undefined;
      const host = (MAP_SCRIPTS as any)[label + "_ONSTEP_HOST"] as MapScript | undefined;
      const rows =
        script?.onStep?.(this, this.save) ??
        host?.onStep?.(this, this.save) ??
        this.coordTrigger(script) ??
        this.coordTrigger(host);
      if (rows) {
        this.runScript(rows);
        return;
      }
    }

    const p = this.player;
    // The arrival disable is POSITIONAL (issue #265): the cell we warped in
    // on is inert until we step off it; pokered has no one-shot counter —
    // every completed step runs CheckWarpsNoCollision.
    let entry = this.warpEntryCell;
    if (entry && (p.cellX !== entry.x || p.cellY !== entry.y)) {
      this.warpEntryCell = undefined;
      entry = undefined;
    }
    // BIT_STANDING_ON_WARP maintenance: cleared before the check, set again
    // on a warp square, cleared once more when the square is warp-activating
    // but not a door (home/overworld.asm:324 + player_state.asm).
    this.refreshStandingOnWarp();
    if (!entry) {
      // CheckWarpsNoCollision: door/warp tiles fire immediately; otherwise
      // ExtraWarpCheck must pass AND a d-pad is held.
      let w = onArrive(this.map, p.cellX, p.cellY);
      if (!w && this.dirHeld()) {
        w = onCollision(this.map, this.carpets, p.cellX, p.cellY, p.facing);
      }
      if (w) {
        this.takeWarp(w.def);
        return;
      }
    }
    // wild encounters in grass, on water while surfing, or — on indoor maps
    // whose tileset is not FOREST — on EVERY tile (wild_encounters.asm)
    const encDef = this.shell.data.encounters[this.map.id] as EncounterDef | undefined;
    const indoor = (this.shell.data.field as {
      indoorEncounters?: { firstIndoorMap: number; excludedTileset: string };
    })?.indoorEncounters;
    let enc: { species: string; level: number } | null = null;
    if (p.surfing && encDef?.water && this.map.isWaterCell(p.cellX, p.cellY)) {
      enc = encounterRoll({ grass: encDef.water }, this.shell.rng);
    } else if (this.map.isGrassCell(p.cellX, p.cellY)) {
      enc = encounterRoll(encDef, this.shell.rng);
    } else if (
      indoor &&
      this.map.def.index >= indoor.firstIndoorMap &&
      this.map.def.tileset !== indoor.excludedTileset
    ) {
      enc = encounterRoll(encDef, this.shell.rng);
    }
    if (enc) {
      this.encounterCount += 1;
      this.lastEncounter = enc;
      // BATTLE-PORT SEAM: the real battle state machine replaces this push
      // in a later task (BattleState.newWild in the reference).
      this.shell.pushStubBattle(enc.species, enc.level);
    }
  }

  // OverworldController.lua:3907 takeWarp
  takeWarp(warpDef: MapWarp): void {
    let last = this.lastOutdoor;
    if (warpDef.destMap === "LAST_MAP" && !last) {
      // old saves / unexpected states: never crash on an exit mat — fall
      // back to the remembered heal point (OverworldController.lua:3909)
      const heal = this.shell.save.lastHeal;
      if (heal) last = { id: heal.map, x: heal.x, y: heal.y };
    }
    const dest = destination(this.shell.data, warpDef, last);
    // facing carries across the warp (leaving a gate sideways keeps you
    // walking sideways; house exit mats are stepped onto facing down)
    const facing = this.player.facing;
    // warp pads and fall-through holes are not doors (WarpFound2
    // .indoorMaps): no door SFX, no walk-out step
    const pad = this.map.warpPadOrHoleAt(this.player.cellX, this.player.cellY);
    if (pad === undefined) {
      this.doorWarp = true; // door SFX + PlayerStepOutFromDoor walk-out
    }
    this.startWarpTo(dest.map, dest.x, dest.y, facing);
  }

  // OverworldController.lua:3949 rememberOutdoor (pokered's wLastMap)
  rememberOutdoor(id: string, x: number, y: number): void {
    this.lastOutdoor = { id, x, y };
    this.shell.save.lastOutdoor = this.lastOutdoor;
  }

  // OverworldController.lua:4004 startWarpTo — the fade out (32 ticks,
  // Timing WARP_FADE_OUT), the map switch at the midpoint, no fade back in
  // (LoadGBPal restores the palettes in one write).
  startWarpTo(mapId: string, x: number, y: number, facing?: Dir, onDone?: () => void): void {
    if (!this.isCooked(mapId)) {
      // The door is locked: a warp into a map the pak has no geometry for
      // would land the player in an invisible world. The warp never happens,
      // so nothing it staged may survive it — a doorWarp left armed here
      // would spend itself on the NEXT warp, walking the player out of a
      // door they did not enter — and a parked script must be resumed or the
      // runner never wakes (ScriptRunner.lua:197 resume).
      this.doorWarp = false;
      onDone?.();
      return;
    }
    // ANY transition off an outdoor map remembers the outdoor side, so
    // LAST_MAP exits keep working (CheckIfInOutsideMap includes PLATEAU).
    if (isOutside(this.map.def) && mapId !== this.map.id) {
      this.rememberOutdoor(this.map.id, this.player.cellX, this.player.cellY);
    }
    this.transitioning = true;
    const doorWarp = this.doorWarp;
    this.doorWarp = false;
    this.shell.pushWarpFade(
      WARP_FADE_OUT,
      () => {
        this.setMap(mapId, x, y, facing ?? "down");
        // The warp we land ON stays inert until we physically step off it,
        // so a warp whose destination cell is itself a warp cannot bounce
        // us straight back. BIT_STANDING_ON_WARP is deliberately NOT
        // touched here: the flag the departing tile set rides through the
        // warp (issue #378).
        this.warpEntryCell = { x, y };
        if (doorWarp) {
          // OverworldController.lua:4053: the cue is chosen by where you
          // LANDED, and it plays for every door warp — the door-tile test
          // below only gates the walk-out step.
          this.shell.audio.playSfx(isOutside(this.map.def) ? "Go_Outside" : "Go_Inside");
        }
        if (doorWarp && this.map.isDoorTileCell(this.player.cellX, this.player.cellY)) {
          // PlayerStepOutFromDoor: any warp landing on a door tile
          // auto-steps south once. The walk-out is a simulated d-pad press,
          // so it obeys collision; a blocked landing keeps the player on
          // the door with the arrival disable intact.
          if (canMove(this.map, this.entities, this.player, "down", this.tilePairs).ok) {
            this.warpEntryCell = undefined;
            this.scriptMove(this.player, "down", 1);
          } else {
            this.player.facing = "down";
          }
        }
      },
      () => {
        this.transitioning = false;
        onDone?.();
      },
    );
  }

  // OverworldController.lua:4172 scriptMove
  scriptMove(entity: Player | NPC, dir: Dir, tiles: number, onDone?: () => void): void {
    this.scriptMoves.push({ entity, dir, remaining: tiles, onDone });
  }

  // OverworldController.lua:4195 updateScriptMoves — two phases so a
  // chained step begins the SAME frame the previous one ends: phase 1
  // retires finished moves (which may chain new ones); phase 2 starts
  // every not-yet-moving move.
  updateScriptMoves(): void {
    let i = 0;
    while (i < this.scriptMoves.length) {
      const mv = this.scriptMoves[i];
      if (!mv.entity.moving && mv.remaining <= 0) {
        this.scriptMoves.splice(i, 1);
        mv.onDone?.();
        // don't advance i: a move chained by onDone may now sit at i
      } else {
        i += 1;
      }
    }
    for (const mv of this.scriptMoves) {
      const e = mv.entity;
      if (!e.moving && mv.remaining > 0) {
        if (mv.inPlace) {
          e.moving = true;
          (e as NPC).marching = true;
          e.progress = 0;
        } else {
          e.facing = mv.dir!;
          const [tx, ty] = target(e.cellX, e.cellY, mv.dir!);
          e.targetX = tx;
          e.targetY = ty;
          e.moving = true;
          e.progress = 0;
          if (e instanceof Player) {
            e.stepFramesCur = e.stepFrames;
          }
        }
        mv.remaining -= 1;
      }
    }
  }

  // Intro portrait state; scene.ts turns this into the voxel pic op.
  picShown: { page: number; x: number; y: number; w: number; h: number } | null = null;

  showPic(page: number, x: number, y: number, w: number, h: number): void {
    this.picShown = { page, x, y, w, h };
  }

  hidePic(): void {
    this.picShown = null;
  }

  /** Run a standalone script (the intro speech), outside any object talk. */
  /** Declarative coord_event scan: the first (x,y) trigger on the player's
   * current cell whose flag gates pass, or null. */
  private coordTrigger(script?: MapScript): ScriptRow[] | null {
    const coords = script?.coord;
    if (!coords) return null;
    const p = this.player;
    const flags = this.save?.flags ?? {};
    for (const c of coords) {
      if (c.x !== p.cellX || c.y !== p.cellY) continue;
      if (c.unlessFlag && flags[c.unlessFlag]) continue;
      if (c.ifFlag && !flags[c.ifFlag]) continue;
      return c.rows;
    }
    return null;
  }

  runScript(script: ScriptRow[], onDone?: () => void): void {
    this.runner.run(script, { onDone });
  }

  /** Find an NPC by its object name or index (Commands.lua object lookup). */
  findNpc(ref: unknown): any | null {
    const list = this.npcs as any[];
    if (typeof ref === "number") {
      // Objects are id'd "<MAP>_obj_<n>"; index by that, not array slot,
      // because hidden objects would shift the slots.
      const byName = list.find((n) =>
        String((n as any)?.id ?? n?.name ?? "").endsWith("_obj_" + ref),
      );
      return byName ?? list[ref - 1] ?? list[ref] ?? null;
    }
    const want = String(ref);
    return (
      list.find(
        (n) =>
          n?.name === want || n?.id === want || n?.obj?.name === want ||
          (n as any)?.def?.name === want,
      ) ??
      // pokered object names aren't in the cooked data, so fall back to the
      // sprite id ("SPRITE_OAK") which is stable across maps.
      // Objects carry pokered's identity as def.text (TEXT_OAKSLAB_..._POKE_BALL);
      // scripts refer to them without the TEXT_ prefix.
      list.find((n) => {
        const t = String((n as any)?.def?.text ?? "").toUpperCase();
        const w = want.toUpperCase();
        return t === w || t === "TEXT_" + w || t.replace(/^TEXT_/, "") === w;
      }) ??
      list.find((n) => {
        const sp = String((n as any)?.def?.sprite ?? "").toUpperCase();
        return sp === want.toUpperCase();
      }) ?? null
    );
  }

  /** YES/NO then the letter grid (pokered's nickname prompt). */
  askNickname(defaultName: string, onDone: (name: string | null) => void): void {
    const shell = (this as any).shell ?? (this as any).game ?? null;
    if (!shell?.askNickname) { onDone(null); return; }
    shell.askNickname(defaultName, onDone);
  }

  /** Walk an actor through fixed waypoints (a scripted escort route). */
  walkRoute(ref: unknown, route: [number, number][], onDone: () => void): void {
    const list = route.slice();
    const next = () => {
      const wp = list.shift();
      if (!wp) { onDone(); return; }
      if (ref === "player") this.movePlayerTo(wp[0], wp[1], next);
      else this.moveNpcTo(ref, wp[0], wp[1], next);
    };
    next();
  }

  /** open_mart -> ShopMenu: delegate to the game shell like startTrainerBattle. */
  openShop(stock: string[], onQuit: () => void): void {
    const self = this as any;
    const shell = self.shell ?? self.game ?? self.host ?? null;
    if (shell?.openShop) shell.openShop(stock, onQuit);
    else onQuit();
  }

  /** PC tile -> Bill's PC box storage. */
  openBox(): void {
    const self = this as any;
    const shell = self.shell ?? self.game ?? self.host ?? null;
    shell?.openBox?.();
  }

  // --- Trainer sight (OverworldController.lua:3266 checkTrainerSight /
  // engine/overworld/trainer_sight.asm): a STAY trainer with a facing spots
  // the player on its line of sight, fires "!", walks up, and battles. ---

  private trainerHeader(npc: NPC): { range?: number; event?: string; battle?: string } | undefined {
    const headers = this.shell.data.trainer_headers as
      | Record<string, Record<string, { range?: number; event?: string; battle?: string }>>
      | undefined;
    return headers?.[this.map.def.label]?.[npc.def.index];
  }

  trainerDefeated(npc: NPC): boolean {
    const ev = this.trainerHeader(npc)?.event;
    return !!ev && this.save.flags?.[ev] === true;
  }

  // Force a trainer battle by object (no sight line): MtMoonB2F's Super Nerd
  // is triggered by a coord step, not a range. Mirrors the sight path's
  // fight() — before-battle text then StartTrainerBattle, beat flag set on a
  // win so the trigger doesn't re-fire (story2.lua engageSuperNerd ->
  // ow:engageTrainer).
  engageTrainer(npc: NPC, onDone?: () => void): void {
    const header = this.trainerHeader(npc);
    npc.facePlayer(this.player);
    const launch = () =>
      this.startTrainerBattle(
        npc.def.trainerClass ?? "",
        npc.def.trainerParty ?? 1,
        undefined,
        (won) => {
          const ev = header?.event;
          if (won && ev && this.save.flags) this.save.flags[ev] = true;
          onDone?.();
        },
      );
    const key = header?.battle;
    const taunt = key
      ? (this.shell.data as { text?: Record<string, string> }).text?.[key]
      : undefined;
    if (taunt) this.showText(taunt, launch);
    else launch();
  }

  checkTrainerSight(): void {
    if (this.player.moving || this.engaging) return;
    const p = this.player;
    const DIRVEC: Record<string, [number, number]> = {
      up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
    };
    for (const npc of this.npcs) {
      const def = npc.def;
      if (!def.trainerClass || npc.moving || npc.frozen) continue;
      if (this.trainerDefeated(npc)) continue;
      // scripted trainers (rival, leaders) engage through their own start_battle
      if (talkScript(this.map.id, def.text)) continue;
      // on-screen only (CheckSpriteAvailability): dx in [-4,5], dy in [-4,4]
      const dx = npc.cellX - p.cellX;
      const dy = npc.cellY - p.cellY;
      if (dx < -4 || dx > 5 || dy < -4 || dy > 4) continue;
      const range = this.trainerHeader(npc)?.range ?? 0;
      const vec = DIRVEC[npc.facing];
      if (range <= 0 || !vec) continue;
      let dist: number | null = null;
      if (vec[0] !== 0 && npc.cellY === p.cellY) dist = (p.cellX - npc.cellX) * vec[0];
      else if (vec[1] !== 0 && npc.cellX === p.cellX) dist = (p.cellY - npc.cellY) * vec[1];
      if (dist !== null && dist >= 1 && dist <= range) {
        this.startTrainerApproach(npc, dist);
        return;
      }
    }
  }

  private startTrainerApproach(npc: NPC, dist: number): void {
    this.engaging = true;
    npc.frozen = true;
    const def = npc.def;
    const header = this.trainerHeader(npc);
    const fight = () => {
      const launch = () =>
        this.startTrainerBattle(def.trainerClass ?? "", def.trainerParty ?? 1, undefined, (won) => {
          // mark the trainer's EVENT_BEAT_* only on a win so the sight line
          // does not re-fire; a loss leaves it and blacks out.
          const ev = header?.event;
          if (won && ev && this.save.flags) this.save.flags[ev] = true;
          npc.frozen = false;
          this.engaging = false;
        });
      // TalkToTrainer prints the before-battle text FIRST, then StartTrainerBattle
      // (home/trainers.asm:88). header.battle -> data.text key.
      const key = header?.battle;
      const taunt = key
        ? (this.shell.data as { text?: Record<string, string> }).text?.[key]
        : undefined;
      if (taunt) this.showText(taunt, launch);
      else launch();
    };
    // "!" bubble holds the world 60 frames (emotion_bubbles.asm), then the
    // trainer marches up to one tile away (TrainerWalkUpToPlayer).
    this.setEmote(npc, 1, 60, () => {
      const steps = dist - 1;
      if (steps > 0) this.scriptMove(npc, npc.facing, steps, fight);
      else fight();
    });
  }

  startTrainerBattle(id: string, idx: number, name?: string, onDone?: (won: boolean) => void, loseable = false): void {
    const self = this as any;
    const shell = self.shell ?? self.game ?? self.host ?? null;
    if (shell?.startTrainerBattle) shell.startTrainerBattle(id, idx, name, onDone, loseable);
    else onDone?.(false);
  }

  /** old_man_demo hand-off (Commands.lua:807-823): delegate to the shell, the
   * same way startTrainerBattle does. onDone resumes the map script. */
  startOldManDemo(onDone?: () => void): void {
    const self = this as any;
    const shell = self.shell ?? self.game ?? self.host ?? null;
    if (shell?.startOldManDemo) shell.startOldManDemo(onDone);
    else onDone?.();
  }

  /** Walk the player to a tile along a real path. */
  movePlayerTo(tx: number, ty: number, onDone: () => void): void {
    const p: any = this.player;
    const path = this.findPath(p.cellX ?? 0, p.cellY ?? 0, tx, ty, p);
    let i = 0;
    const step = () => {
      if (i >= path.length) { onDone(); return; }
      const [nx, ny] = path[i++]!;
      const dx = nx - (p.cellX ?? 0);
      const dy = ny - (p.cellY ?? 0);
      const dir = dx > 0 ? "right" : dx < 0 ? "left" : dy > 0 ? "down" : "up";
      this.scriptMove(p, dir as any, 1, step);
    };
    step();
  }

  /** Commands.lua place_npc: spawn a scripted actor (Oak's escort). */
  placeNpc(sprite: string, x: number, y: number, facing = "down"): any {
    let existing = this.findNpc(sprite);
    // If the sprite has no visible actor, prefer REVEALING the map's real
    // (spawn-hidden) object for it over a synthetic one: pokered HideObject's
    // Oak / the rival until a ShowObject, and only the real object carries the
    // def.text talkTo dispatches on (TEXT_OAKSLAB_OAK1). A synthetic actor has
    // no text, so talking to it would do nothing.
    if (!existing) {
      const def = (this.map.def.objects ?? []).find(
        (o) => o.sprite === sprite && !this.npcs.some((n) => n.def === o),
      );
      if (def) {
        existing = this.pooledNPC(this.map.id, def);
        this.npcs.push(existing);
        this.entities = [this.player, ...this.npcs];
      }
    }
    if (existing) {
      existing.hidden = false;
      existing.cellX = x; existing.cellY = y;
      existing.px = x * 16; existing.py = y * 16;
      existing.facing = facing;
      return existing;
    }
    const obj: any = { sprite, x, y, cellX: x, cellY: y, facing, movement: "static" };
    const self = this as any;
    const npc = self.pooledNPC(self.mapId ?? self.map?.id ?? "", obj);
    npc.def = npc.def ?? obj;
    npc.cellX = x; npc.cellY = y;
    npc.px = x * 16; npc.py = y * 16;
    npc.facing = facing;
    npc.frozen = false;
    npc.wanders = false;
    this.npcs.push(npc);
    this.entities = [this.player, ...this.npcs];
    return npc;
  }

  setObjectHidden(objName: unknown, hidden: boolean): void {
    let npc = this.findNpc(objName);
    // show_object on a spawn-hidden object (pokered ShowObject): it is not in
    // this.npcs yet, so reveal the real map def object for it. Matched by
    // name/text (not sprite) so ROUTE22_RIVAL1 resolves distinctly from a
    // second same-sprite rival on the map.
    if (!npc && !hidden) {
      const want = String(objName).toUpperCase();
      const def = (this.map.def.objects ?? []).find((o) => {
        const name = String((o as MapObject & { name?: string }).name ?? "").toUpperCase();
        const text = String(o.text ?? "").toUpperCase();
        const matches =
          name === want || text === want || text === "TEXT_" + want ||
          text.replace(/^TEXT_/, "") === want;
        return matches && !this.npcs.some((n) => n.def === o);
      });
      if (def) {
        npc = this.pooledNPC(this.map.id, def);
        this.npcs.push(npc);
        this.entities = [this.player, ...this.npcs];
      }
    }
    if (npc) npc.hidden = hidden;
  }

  faceObject(ref: unknown, dir: string): void {
    const npc = this.findNpc(ref);
    if (npc) npc.facing = dir;
  }

  /** Breadth-first route between two cells over walkable tiles. */
  private findPath(sx: number, sy: number, tx: number, ty: number, mover: unknown): [number, number][] {
    const W = 64, H = 64;
    const key = (x: number, y: number) => y * W + x;
    const prev = new Map<number, number>();
    const seen = new Set<number>([key(sx, sy)]);
    let q: [number, number][] = [[sx, sy]];
    const ok = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      try {
        return this.map.isWalkableCell(x, y) && !occupied(this.entities, x, y, mover as any);
      } catch { return false; }
    };
    while (q.length) {
      const nq: [number, number][] = [];
      for (const [x, y] of q) {
        if (x === tx && y === ty) {
          const out: [number, number][] = [];
          let k = key(x, y);
          while (k !== key(sx, sy)) {
            out.push([k % W, Math.floor(k / W)]);
            const p2 = prev.get(k);
            if (p2 === undefined) break;
            k = p2;
          }
          return out.reverse();
        }
        for (const [nx, ny] of [[x, y + 1], [x, y - 1], [x + 1, y], [x - 1, y]] as [number, number][]) {
          const nk = key(nx, ny);
          if (seen.has(nk) || !(ok(nx, ny) || (nx === tx && ny === ty))) continue;
          seen.add(nk);
          prev.set(nk, key(x, y));
          nq.push([nx, ny]);
        }
      }
      q = nq;
    }
    return [];
  }

  /** Walk an NPC to a tile along a real path (no clipping through houses). */
  moveNpcTo(ref: unknown, tx: number, ty: number, onDone: () => void): void {
    const npc = this.findNpc(ref);
    if (!npc) { onDone(); return; }
    const path = this.findPath(npc.cellX ?? 0, npc.cellY ?? 0, tx, ty, npc);
    let i = 0;
    const step = () => {
      if (i >= path.length) { onDone(); return; }
      const [nx, ny] = path[i++]!;
      const dx = nx - (npc.cellX ?? 0);
      const dy = ny - (npc.cellY ?? 0);
      const dir = dx > 0 ? "right" : dx < 0 ? "left" : dy > 0 ? "down" : "up";
      this.scriptMove(npc, dir as any, 1, step);
    };
    step();
  }

  // ScriptWorld surface for the runner's verbs -------------------------------

  showText(text: string, onDone?: () => void): void {
    this.shell.showText(text, onDone);
  }

  showChoice(text: string, choice: (yes: boolean) => void): void {
    this.shell.showChoice(text, choice);
  }

  setEmote(entity: unknown, kind: number, frames: number, onDone: () => void): void {
    this.emote = { entity: entity as Player | NPC, kind, frames, onDone };
  }
}
