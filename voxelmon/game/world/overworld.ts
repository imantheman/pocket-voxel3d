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
import {
  canMove, occupied, rotateDir, target,
  type Dir, type Mover, type TilePairs,
} from "./collision.ts";
import { defPassable, GameMap, isOutside } from "./map.ts";
import { NPC } from "./npc.ts";
import { Player } from "./player.ts";
import { talkScript, itemBallScript, itemBallFlag, TEXT_BILLSHOUSE_PC } from "./mapscripts.ts";
import { LAST_MAP_REWRITES, rewrittenLastMap } from "./lastmap.ts";
import { martGreetScript } from "./marts.ts";
import { bikeAllowed, type BikeRiding } from "./bike.ts";
import { visit } from "./fly.ts";
import { cellOf, freeDir, quantize, slide, stickPush } from "./freemove.ts";
import { repelled } from "../rules/items.ts";
import { canAt, DOOR_BLOCK, openCan, rollFirst, SECOND_LOCK, trashData } from "./trashcans.ts";
import { findHidden, hiddenItemNear } from "./hiddenitems.ts";
import * as Bag from "../rules/bag.ts";
import { spotFor } from "./snorlax.ts";
import { barriersFor, ROAD_HOLES, ROUTE_23_RESET_FLAGS } from "./toggleblocks.ts";
import {
  currentAt, defaultHiddenBoulders, FORCED_WARP_FLOORS, forcedExitAt, holesFor, isHole,
  seafoamData, surfBlockedAt, toggleToObjectName, type SeafoamField,
} from "./seafoam.ts";
import { fillBadgeName, gateFor, guardAt, hasBadge } from "./badgegate.ts";
import {
  GYM_MACHINES, gymGateFlag, gymGuardKey, LANCE_DOOR_CELLS, LEAGUE_SEALS,
  MANSION_BLOCKS, MANSION_HOLES, MANSION_SWITCHES, OPEN_BLOCK,
} from "./toggleblocks.ts";
import type { DaycareState } from "./daycare.ts";
import {
  inSafariStepZone,
  SAFARI_BALLS,
  SAFARI_EXIT,
  SAFARI_STEPS,
  SAFARI_WALK_IN_STEPS,
} from "./safari.ts";
import { nurseGreetScript } from "./nurses.ts";
import { cableClubScript } from "./cableclub.ts";
import {
  hostTransport, LinkSession, LINK_ROOM_MAP, LINK_SEATS,
  type LinkTransport,
} from "./link.ts";
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

// data/trainers/encounter_types.asm — the two lists PlayTrainerMusic checks
// before falling back to the male sting.
const FEMALE_TRAINERS = new Set([
  "OPP_LASS", "OPP_JR_TRAINER_F", "OPP_BEAUTY", "OPP_COOLTRAINER_F",
]);
const EVIL_TRAINERS = new Set([
  "OPP_UNUSED_JUGGLER", "OPP_GAMBLER", "OPP_ROCKER", "OPP_JUGGLER",
  "OPP_CHIEF", "OPP_SCIENTIST", "OPP_GIOVANNI", "OPP_ROCKET",
]);

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
  /**
   * The running SAFARI ZONE game (world/safari.ts): balls left and steps
   * left. Absent when no game is running, which is every gate in the feature.
   */
  safari?: { balls: number; steps: number } | null;
  /**
   * Riding the BICYCLE (world/bike.ts). A save flag, not a bag state: it
   * carries across warps, and entering a map that disallows riding clears
   * it on arrival.
   */
  onBike?: boolean;
  /**
   * Afloat on a mon (HM SURF). Saved rather than kept only on the Player,
   * because a save reloaded mid-lake would otherwise come back standing on
   * water with the flag cleared — a player who cannot move in any direction.
   * syncSurf treats the CELL as the authority and repairs this either way.
   */
  surfing?: boolean;
  /**
   * Towns arrived in at least once (world/fly.ts). pokered's
   * wTownVisitedFlag: what FLY is allowed to offer.
   */
  visited?: Record<string, boolean>;
  /**
   * STRENGTH has been used, so boulders can be shoved (world/script.ts
   * use_strength). pokered re-arms this per map; this keeps it, see
   * Overworld.enableStrength.
   */
  strengthActive?: boolean;
  /**
   * The Route 5 DAY CARE's boarder (world/daycare.ts). Absent/null when no
   * mon is in. The steps here are the deferred exp: the walk is only folded
   * into the mon when the player comes to collect it.
   */
  daycare?: DaycareState | null;
  /**
   * {PLAYER}'s PC — the Item Storage System's own bag (world/pcitems.ts).
   * A BagSave of its own so rules/bag.ts drives it unchanged; only the
   * number of slots differs.
   */
  pc?: { inventory: Record<string, number>; bagOrder?: string[] };
  /** Money, for the Safari gate's fee and the coin clerk. */
  money?: number;
  /** wPlayerCoins — the GAME CORNER's currency, capped at 9999. */
  coins?: number;
  /**
   * gen1recomp save.defeatedTrainers: trainers beaten, by NPC object id
   * (`<map>_obj_<index>`). The EVENT_BEAT_* flag covers trainers the
   * extractor found a def_trainers header for; this covers the rest, which
   * is every text_asm trainer — they have no header, so no flag exists to
   * record their defeat.
   */
  defeatedTrainers?: Record<string, boolean>;
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
  audio: {
    playSfx(name: string): void;
    /** Music.lua:239 startMap — the map theme, bike and surf overrides applied. */
    startMap?(mapId: string, onBike?: boolean, surfing?: boolean): void;
  };
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
  /** Field effect billboard at Q4 world px; frame < 0 clears it (host.fieldFx). */
  fieldFx(x: number, z: number, frame: number): void;
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
  // the boulder beside 2F's second switch is upstairs until it falls
  // through 3F's hole (toggleable_objects.asm TOGGLE_VICTORY_ROAD_2F_BOULDER)
  VICTORY_ROAD_2F: { VICTORYROAD2F_BOULDER3: true },
};

/** data/maps/force_bike_surf.asm, as the extractor lays it out. */
interface ForcedMovement {
  /** JoypadOverworld's simulated PAD_DOWN: the bike rolls south here. */
  slopeMaps?: string[];
  tiles?: Record<string, { mode: "bike" | "surf"; x: number; y: number }[]>;
}

/**
 * BIT_ALWAYS_ON_BIKE ends at the CYCLING ROAD gates, whose map scripts clear
 * it every frame (scripts/Route16Gate1F.asm / Route18Gate1F.asm).
 */
const FORCED_BIKE_CLEAR_MAPS = ["ROUTE_16_GATE_1F", "ROUTE_18_GATE_1F"];

/** poison.asm: `ld a, [wStepCounter]; and 3` -- every fourth step. */
const POISON_STEP_INTERVAL = 4;

const BACK: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };

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
  /**
   * The camera's yaw, radians, when the host sends it (psp-main's button
   * word). Undefined means no camera yaw is known, and the walk stays on the
   * grid.
   */
  freeYaw?: number;
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
  /** The map the player was on before this one (setMap). */
  cameFromMapId: string | undefined;
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

  /**
   * Quarter turns the player has swung the camera (host: cam::quarter_turns,
   * sent in the button word). The overworld walk is rotated by it so a press
   * keeps meaning what it looks like on screen; nothing else is.
   */
  camTurns = 0;

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
    // Where this arrival came FROM: an elevator car seeds its walk-out
    // exit with it (mapscripts.ts seedElevator), so backing out of the
    // panel puts you back on the floor you stepped in from.
    this.cameFromMapId = this.map?.id;
    // Every entry path lands here (warp, seam, boot), so this is where the
    // arrival's land-trigger look is armed (arrivalTriggers).
    this.arrivalPending = true;
    // crossConnection re-arms this right after; clearing here is what keeps a
    // warp or a reload from leaving a stale deferred PlayMapMusic pending
    // (OverworldController.lua:437-439).
    this.pendingSeamMusic = null;
    const tileset = this.shell.data.tilesets?.[def.tileset];
    if (!tileset) throw new Error(`unknown tileset ${def.tileset} for ${mapId}`);
    this.map = new GameMap(
      def,
      tileset,
      (this.shell.data.field as { waterTilesets?: string[] } | undefined)?.waterTilesets,
    );
    this.applyGameCornerPoster(mapId, def);
    this.applyCardKeyDoors(mapId, def);
    this.applyToggleBlocks(mapId, def);
    this.applyLeagueSeals(mapId, def);
    // VictoryRoad2FResetBoulderEventScript: walking onto 2F clears the 1F
    // switch, so its barrier is shut again next time you climb down.
    if (mapId === "VICTORY_ROAD_2F" && this.save?.flags) {
      this.save.flags.EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH = false;
    }
    // Route23SetVictoryRoadBoulders: every entry to Route 23 resets the rest
    // of the puzzle behind you -- 2F's and 3F's switches, and the boulder
    // that fell through 3F's hole goes back upstairs.
    if (mapId === "ROUTE_23" && this.save?.flags) {
      for (const f of ROUTE_23_RESET_FLAGS) this.save.flags[f] = false;
      for (const h of ROAD_HOLES) {
        this.setObjectToggle(h.map, h.boulder, true);
        this.setObjectToggle(h.toMap, h.toBoulder, false);
      }
    }
    this.applyRoadBarriers(mapId, def);
    // The motorized door, once both locks are open: stamped away on every
    // entry the way the card-key doors are (VermilionGymSetDoorTile runs
    // from the gym's own map script, so it fires on each load).
    if (mapId === "VERMILION_GYM" && this.save?.flags?.[SECOND_LOCK]) {
      const door = trashData(this.shell.data as never)?.doorBlock ?? DOOR_BLOCK;
      const i = door.by * def.width + door.bx;
      if (Array.isArray(def.blocks) && i >= 0 && i < def.blocks.length) {
        def.blocks[i] = door.block;
      }
    }
    // VermilionCity_Script .setFirstLockTrashCanIndex: every load of the
    // city re-rolls which can hides the first switch. Unconditional, as in
    // the ROM -- the index is only read while the first lock is shut, and
    // the gym is only reachable through here.
    if (mapId === "VERMILION_CITY") {
      const save = this.save as { trashPuzzle?: { first?: number } };
      (save.trashPuzzle ??= {}).first = rollFirst(() => this.shell.rng.int(256));
    }
    // A cut tree grows back the moment the map is left: pokered keeps no
    // record of a cut -- the block is rewritten in the map's own RAM copy,
    // which the next map load throws away -- so every tree stands again on
    // re-entry, and so does the S.S. Anne's split hull. This port used to
    // keep them cut in the save; the trees never came back. The stamps the
    // last visit hid are shown again here, on every entry path (setMap is
    // the one choke point), and the record of them cleared. Collision needs
    // nothing: the GameMap above was just rebuilt with every tree in place.
    for (const key of this.cutThisVisit) {
      const [mi, cx, cy] = key.split(",").map(Number);
      this.stamp(mi!, cx!, cy!, true);
    }
    this.cutThisVisit.clear();
    // Rock Tunnel's darkness (wMapPalOffset, home/overworld.asm): dark
    // until FLASH is used, and the light then holds between the tunnel's
    // floors -- 1F to B1F and back is one visit, not a new cave -- and
    // resets once outside (gen1recomp OverworldController save.flashLit).
    // This used to darken every floor on entry, so FLASH had to be used
    // again on every staircase.
    const save = this.save as { flashLit?: boolean };
    if (DARK_MAPS.has(mapId)) {
      this.tint(save.flashLit ? BRIGHT_TINT : DARK_TINT);
    } else {
      save.flashLit = undefined;
      this.tint(BRIGHT_TINT);
    }
    // game_corner_slots2.asm picks the lucky machine on entry, so it changes
    // every time the player walks back in.
    this.rollLuckySlot();
    // NPC instances persist across connection crossings in the pool (keyed
    // by NPC.id) so nothing snaps back to its spawn point at a seam; warps
    // rebuild from scratch, like the original's per-entry sprite init
    // (OverworldController.lua:376-385).
    if (!(opts?.seamless && this.npcPool.size > 0)) {
      this.npcPool = new Map();
    }
    // A beaten Snorlax is gone for good. The wake hides it, so this only
    // matters for a save where the flag is set and the object is somehow
    // still visible -- and that state is a dead end, because the flute
    // refuses to wake a Snorlax whose flag is already set, so the route
    // would stay sealed forever. BEFORE the spawn loop: the toggle is what
    // objectVisible reads, and a write after this point misses this entry.
    const sleeper = spotFor(mapId);
    if (sleeper && this.save?.flags?.[sleeper.beatFlag] === true) {
      const toggles = ((this.save as { objectToggles?: Record<string, Record<string, boolean>> })
        .objectToggles ??= {});
      (toggles[mapId] ??= {})[sleeper.object] = false;
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
    // The path/cave entrance houses force wLastMap to their own route as
    // their map loads; without this their far exit returns you to the route
    // you came in from. AFTER the player is placed: the Route 22 gate's rule
    // reads their row, and before this point that is still the old map's.
    this.syncLastMapRewrite();
    // IsBikeRidingAllowed (OverworldController.lua:343): walking into a
    // building gets you off the bike rather than refusing the door.
    this.syncBike();
    if (FORCED_BIKE_CLEAR_MAPS.includes(mapId) || !(this.save as { onBike?: boolean }).onBike) {
      (this.save as { forcedBike?: boolean }).forcedBike = false;
    }
    // And the same for the water. A warp can land the player on it (the
    // Seafoam drops) and a reload can put them back on it with the flag
    // cleared; either way the CELL is the authority, not the flag. After the
    // player is placed, not before -- on the first map load there is no
    // player yet.
    this.syncSurf();
    // wTownVisitedFlag (engine/overworld/special_warps.asm): arriving in a
    // town is what puts it on FLY's list. Nothing recorded this before, so
    // every destination would have read as never-visited.
    visit(this.save as never, mapId);
    // A map script's every-load hook (story5.lua M.CINNABAR_ISLAND.onEnter).
    (MAP_SCRIPTS as Record<string, MapScript>)[mapId]?.onEnter?.(this, this.save);
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
      if (this.seafoamHidden()[this.map.id]?.[key]) return false;
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
    if (!scripted && !this.transitioning) this.arrivalTriggers();
    if (!scripted && !this.transitioning) {
      if (this.freeMoveActive()) {
        this.freeWalk();
      } else {
        this.snapToCell();
        this.handleInput();
        this.rollDownhill();
      }
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

  /**
   * Walk freely rather than on the grid (world/freemove.ts, ported from
   * DramaticShapeVoxelMod's FreeMove). Needs the camera's real yaw, which only
   * a host that sends it provides -- a test driving game.tick never does, so
   * every grid-walk test stays a grid walk -- and the player can turn it off
   * in OPTIONS (MOVEMENT: GRID).
   */
  /**
   * The circle pad as the host last read it, -1..1 on each axis with +y UP
   * the pad, or undefined on a host that only sends buttons. The free walk
   * steers by it when it is pushed; the d-pad is the fallback, and every
   * menu still sees the pad as the four directions it always did.
   */
  stick?: { x: number; y: number };

  /**
   * The trees cut on the map being stood on, as "mapIndex,cx,cy" -- the
   * stamps to show again when it is left (setMap). Per visit on purpose:
   * see the regrow note there.
   */
  cutThisVisit = new Set<string>();

  freeMoveActive(): boolean {
    if (this.freeYaw === undefined) return false;
    const mv = (this.save as { options?: { movement?: string } }).options?.movement;
    return mv !== "grid";
  }

  /**
   * Back onto the grid. Switching from free movement to grid mid-cell would
   * otherwise leave the grid walker stepping from a position it does not
   * know it is at.
   */
  private snapToCell(): void {
    const p = this.player;
    if (p.moving) return;
    p.px = p.cellX * 16;
    p.py = p.cellY * 16;
  }

  /** May the free body stand in cell (cx, cy)? The grid walker's own rules. */
  private freeOpen(cx: number, cy: number): boolean {
    const m = this.map;
    const p = this.player;
    if (!m.inBounds(cx, cy)) return false;
    if (!m.isWalkableCell(cx, cy) && !(p.surfing && m.isWaterCell(cx, cy))) return false;
    if ((cx !== p.cellX || cy !== p.cellY) && occupied(this.entities, cx, cy, p)) return false;
    return true;
  }

  /**
   * One frame of free movement.
   *
   * The position is continuous and steered by the camera's yaw; everything
   * the world does is still the grid's. Crossing into a new cell runs the
   * same onStepComplete a grid step lands on -- warps, triggers, encounters,
   * the step counters -- once per cell, the rate a grid walk fires it. A push
   * that gets nowhere from the middle of a cell is handed to the grid's own
   * handler, which is what still does map edges, ledge hops, boulders and
   * door mats; and buttons go to the grid poll unchanged.
   */
  private freeWalk(): void {
    const input = this.shell.input;
    const p = this.player;
    if (p.moving) return; // a grid step (a hop, a script) owns the player
    if (input.wasPressed("a") || input.wasPressed("start") || input.wasPressed("select")) {
      this.snapToCell();
      this.handleInput();
      return;
    }
    // The pad itself when it is pushed -- any angle, and how far it is
    // pushed is how fast the walk goes -- else the d-pad's four.
    const stick = stickPush(this.stick);
    const sx = stick ? stick.x : (input.isDown("right") ? 1 : 0) - (input.isDown("left") ? 1 : 0);
    const sy = stick ? -stick.y : (input.isDown("down") ? 1 : 0) - (input.isDown("up") ? 1 : 0);
    // Cycling Road's downhill pull (home/overworld.asm JoypadOverworld's
    // simulated PAD_DOWN): with nothing held the bike rolls south -- south
    // on the map, whichever way the camera faces.
    const dir =
      sx === 0 && sy === 0 && this.slopeRolls()
        ? freeDir(0, 1, 0)
        : freeDir(sx, sy, this.freeYaw ?? 0);
    if (!dir) return;
    // the grid walker's own speed: one cell per stepSpeed() frames, scaled
    // by the pad's throw
    const speed = (16 / p.stepSpeed()) * (stick ? stick.throw : 1);
    const r = slide(p.px, p.py, dir[0] * speed, dir[1] * speed, (x, y) => this.freeOpen(x, y));
    p.facing = quantize(dir[0], dir[1]);
    if (!r.moved) {
      // Against something. From INSIDE the cell, let the grid decide what
      // that something is -- an edge to cross, a ledge to hop, a boulder to
      // shove, a door mat, or just a wall to bonk. Anywhere in the cell:
      // this used to ask only within four pixels of its centre, and a walk
      // that met a ledge or a doorway off-centre -- which a free walk
      // nearly always does -- pushed against it and got nothing, neither
      // the hop nor the door. The snap moves the body at most half a cell.
      if (Math.abs(p.px - p.cellX * 16) <= 8 && Math.abs(p.py - p.cellY * 16) <= 8) {
        this.snapToCell();
        this.handleInput();
      }
      return;
    }
    p.px = r.px;
    p.py = r.py;
    // Keeps the walk cycle turning over while moving. 2, not 1: the
    // player's own update runs before the frame is drawn and takes one off,
    // and at 0 walkPhase() reads "standing" -- which is why the walk looked
    // stiff. At 2 the draw still sees 1, and letting go of the pad stands
    // the player on the very next frame.
    p.bumpFrames = 2;
    const cx = cellOf(p.px);
    const cy = cellOf(p.py);
    if (cx !== p.cellX || cy !== p.cellY) {
      p.cellX = cx;
      p.cellY = cy;
      p.stepFlip = !p.stepFlip;
      p.landedCount += 1;
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
    for (const screenDir of ["up", "down", "left", "right"] as Dir[]) {
      if (!input.isDown(screenDir)) continue;
      // The press is screen-relative; the world is not. With the camera
      // swung round behind the player, "up" still has to mean away from the
      // camera or walking becomes a guessing game.
      const dir = rotateDir(screenDir, this.camTurns);
      if (!this.player.moving && this.player.facing === dir) {
        if (this.checkEdgeExit(dir)) return;
        if (this.checkLedgeHop(dir)) return;
        if (this.checkBoulderPush(dir)) return;
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
    p.stepFramesCur = p.stepSpeed();
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
    // A slot-machine seat (field.slotMachines). Checked before signs: the
    // seats are hidden events on the machine tiles, and the refusals are the
    // original's own, in its order — broken machine, then no COIN CASE, then
    // no coins (AbleToPlaySlotsCheck).
    if (this.trySlotSeat(fx, fy)) return;
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
    // A locked card-key door swallows the press whether or not the player
    // has the key (engine/events/card_key.asm runs before anything else on
    // the tile).
    if (this.tryCardKeyDoor(fx, fy)) return;
    if (this.tryMansionSwitch(fx, fy)) return;
    if (this.tryGymQuiz(fx, fy)) return;
    if (this.tryTrashCan(fx, fy)) return;
    if (this.tryHiddenItem(fx, fy)) return;
    // Bill's PC: a hidden PC tile (OverworldController.lua:2019). Pressing A
    // facing it opens box storage.
    if (pcTileAt(this.map.id, fx, fy, p.facing)) {
      // TurnedOnPC, then the machine's menu -- Pokemon storage is one entry
      // on it, not the whole of it (engine/menus/pc.asm).
      const t = (this.shell.data as { text?: Record<string, string> }).text ?? {};
      this.shell.showText(t._TurnedOnPC1Text ?? "{PLAYER} turned on\nthe PC.", () => {
        (this.shell as unknown as { openPc?: () => void }).openPc?.();
      });
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
    // home/trainers.asm TalkToTrainer, via OverworldController.lua:2653-2666:
    // walking up to a trainer and pressing A is a challenge, not small talk —
    // before-battle line, then the fight. Without this only the sight line
    // could start a battle, which left every range-0 trainer (the Elite Four,
    // Mt Moon's Super Nerd, the Rocket Hideout floors) unfightable.
    //
    // A trainer whose text has its own talk script (the rival, the gym
    // leaders, the Game Corner Rocket) keeps it: the script owns the engage,
    // exactly as checkTrainerSight already skips those.
    const def = npc.def;
    if (def.trainerClass && !talkScript(this.map.id, def.text)) {
      if (!this.trainerDefeated(npc)) {
        npc.facePlayer(this.player);
        this.engageTrainer(npc, unfreeze);
        return;
      }
      // Beaten: the after-battle line, the one a trainer repeats forever.
      const key = this.trainerHeader(npc)?.after;
      const after = key
        ? (this.shell.data as { text?: Record<string, string> }).text?.[key]
        : undefined;
      if (after) {
        npc.facePlayer(this.player);
        this.shell.showText(after, unfreeze);
        return;
      }
    }
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
      martGreetScript(this.shell.data as never, this.map.def.label, textConst) ??
      nurseGreetScript(textConst) ??
      cableClubScript(textConst);
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

  /**
   * The machine the player is facing, or false when it is not a seat.
   * game_corner_slots.asm's checks in order: the three broken-machine signs,
   * then the COIN CASE, then having any coins at all.
   */
  private trySlotSeat(fx: number, fy: number): boolean {
    const seats = (this.shell.data as {
      field?: { slotMachines?: Record<string, { x: number; y: number; state: string }[]> };
    }).field?.slotMachines?.[this.map.id];
    if (!seats) return false;
    const i = seats.findIndex((s) => s.x === fx && s.y === fy);
    if (i < 0) return false;
    const seat = seats[i]!;
    const t = (this.shell.data as { text?: Record<string, string> }).text ?? {};
    const say = (k: string, fallback: string): true => {
      this.shell.showText(t[k] ?? fallback);
      return true;
    };
    if (seat.state === "out_of_order") {
      return say("_GameCornerOutOfOrderText", "OUT OF ORDER\nThis is broken.");
    }
    if (seat.state === "out_to_lunch") {
      return say("_GameCornerOutToLunchText", "OUT TO LUNCH\nThis is reserved.");
    }
    if (seat.state === "keys") {
      return say("_GameCornerSomeonesKeysText", "Someone's keys!\nThey'll be back.");
    }
    if (!this.save.inventory?.COIN_CASE) {
      return say("_GameCornerCoinCaseText", "A COIN CASE is\nrequired!");
    }
    if ((this.save.coins ?? 0) === 0) {
      return say("_GameCornerNoCoinsText", "You don't have\nany coins!");
    }
    // One machine per visit is secretly lucky (wLuckySlotHiddenEventIndex),
    // picked on map entry.
    (this.shell as unknown as { openSlots?: (lucky: boolean) => void })
      .openSlots?.(i === this.luckySlot);
    return true;
  }

  /**
   * This visit's lucky machine. Rolled on every entry to a map that has
   * seats, like game_corner_slots2.asm does.
   */
  luckySlot = -1;

  private rollLuckySlot(): void {
    const seats = (this.shell.data as {
      field?: { slotMachines?: Record<string, unknown[]> };
    }).field?.slotMachines?.[this.map.id];
    this.luckySlot = seats && seats.length > 0
      ? this.shell.rng.int(seats.length)
      : -1;
  }

  /** open_prizes -> the GAME CORNER prize window, via the shell. */
  openPrizes(window: number, onDone?: () => void): void {
    (this.shell as unknown as {
      openPrizes?: (w: number, done?: () => void) => void;
    }).openPrizes?.(window, onDone);
  }

  /**
   * OverworldController.lua:343 + :899 — the forced dismount where riding
   * is disallowed, and the player's mirror of the flag (the step timer
   * reads it, and it must not survive a warp into a house).
   */
  syncBike(): void {
    const save = this.save as { onBike?: boolean };
    const rules = (this.shell.data as {
      field?: { bikeRiding?: BikeRiding };
    }).field?.bikeRiding;
    if (save.onBike && !bikeAllowed(this.map.id, this.map.def?.tileset, rules)) {
      save.onBike = false;
    }
    if (this.player) this.player.onBike = !!save.onBike;
  }

  /** Whether the BICYCLE may be ridden on the map we are standing on. */
  canRideHere(): boolean {
    const rules = (this.shell.data as {
      field?: { bikeRiding?: BikeRiding };
    }).field?.bikeRiding;
    return bikeAllowed(this.map.id, this.map.def?.tileset, rules);
  }

  /** oaks_aide -> the aide's dex check and reward, via the shell. */
  openOaksAide(textId: string, onDone?: () => void): void {
    (this.shell as unknown as {
      openOaksAide?: (t: string, done?: () => void) => void;
    }).openOaksAide?.(textId, onDone);
  }

  /** open_bike_shop -> the BIKE SHOP clerk's flow, via the shell. */
  openBikeShop(onDone?: () => void): void {
    (this.shell as unknown as {
      openBikeShop?: (done?: () => void) => void;
    }).openBikeShop?.(onDone);
  }

  /** open_daycare -> the DAY CARE gentleman's flow, via the shell. */
  /**
   * ItemUseSurfboard's check: the cell the player faces is water, they are
   * not on it yet, and nothing stands in the way.
   *
   * The tile-pair rule matters here — pokered's TilePairCollisionsWater keeps
   * you from mounting across a shore edge you could not swim back over.
   */
  canSurfHere(): boolean {
    const p = this.player;
    if (p.surfing) return false;
    const [fx, fy] = p.facingCell();
    if (!this.map.inBounds(fx, fy)) return false;
    if (!this.map.isWaterCell(fx, fy)) return false;
    // "Could a surfer step there?" -- asked of canMove rather than
    // reimplemented, so the mount obeys every rule ordinary movement does.
    // The one that matters is TilePairCollisionsWater (field.tilePairs.water,
    // three shore edges in the caves and Viridian Forest): pairBlocked picks
    // its list by mover.surfing, so the check has to be made as the surfer
    // the player is about to become, not as the walker they still are.
    //
    // A plain water + occupancy test looked equivalent and was not: it let
    // you mount across an edge the original refuses.
    return canMove(this.map, this.entities, { ...p, surfing: true }, p.facing, this.tilePairs).ok;
  }

  /**
   * Get on the water: mount, then take the step onto the cell being faced,
   * so SURF leaves the player afloat rather than standing on the bank having
   * announced it.
   */
  startSurfing(): void {
    const p = this.player;
    p.surfing = true;
    this.save.surfing = true;
    this.scriptMove(p, p.facing, 1);
    this.syncSurfSong();
  }

  /**
   * Keep `surfing` honest about where the player actually is.
   *
   * Two jobs. Walking back onto land gets off the mon (pokered dismounts on
   * the shore step, there is no command for it). And a save reloaded while
   * afloat comes back standing on water with the flag cleared — which is a
   * player stuck in the middle of a lake — so being on a water cell puts it
   * back on.
   */
  syncSurf(): void {
    const p = this.player;
    const onWater = this.map.isWaterCell(p.cellX, p.cellY);
    if (p.surfing === onWater) return;
    p.surfing = onWater;
    this.save.surfing = onWater;
    this.syncSurfSong();
  }

  /** Music_Surfing while afloat, the map's own theme once ashore. */
  private syncSurfSong(): void {
    const save = this.save as { onBike?: boolean };
    this.shell.audio?.startMap?.(this.map.id, save.onBike === true, this.player.surfing === true);
  }

  /**
   * use_strength: the player can now shove boulders. pokered clears its flag
   * on every map load, so STRENGTH is re-used per area; this keeps it for the
   * save instead. A player who has proved they can move boulders being asked
   * to prove it again on each floor of Victory Road is nagging, not
   * difficulty.
   */
  enableStrength(): void {
    (this.save as { strengthActive?: boolean }).strengthActive = true;
  }

  /** Is this NPC one of the boulders (SPRITE_BOULDER)? */
  private isBoulder(npc: unknown): boolean {
    const def = (npc as { def?: { sprite?: string } })?.def;
    return String(def?.sprite ?? "").includes("BOULDER");
  }

  /**
   * Walking into a boulder with STRENGTH active shoves it one cell and steps
   * into the space (engine/overworld/movement.asm's boulder branch).
   *
   * The far side has to be somewhere the boulder could stand: in bounds,
   * walkable, and empty. Water counts as blocked here even while surfing --
   * pokered drops a boulder into water only at the Seafoam holes, which are
   * warps rather than pushes.
   *
   * Both the boulder and the player move as scripted steps so they travel
   * together; an ordinary tryMove would be refused by the boulder still
   * occupying the cell it is in the middle of leaving.
   */
  checkBoulderPush(dir: Dir): boolean {
    if (!(this.save as { strengthActive?: boolean }).strengthActive) return false;
    const p = this.player;
    if (this.scriptMoves.length > 0 || this.runner.isRunning()) return false;
    const [bx, by] = target(p.cellX, p.cellY, dir);
    const boulder = this.npcs.find(
      (n: any) => n.cellX === bx && n.cellY === by && this.isBoulder(n),
    );
    if (!boulder) return false;
    const [tx, ty] = target(bx, by, dir);
    if (!this.map.inBounds(tx, ty)) return false;
    const hole = isHole(this.seafoam(), this.map.id, tx, ty);
    if (!this.map.isWalkableCell(tx, ty) && !hole) return false;
    if (this.map.isWaterCell(tx, ty) && !hole) return false;
    if (occupied(this.entities, tx, ty, boulder as never)) return false;
    this.shell.audio.playSfx("Push_Boulder");
    this.scriptMove(boulder as never, dir, 1, () => this.boulderLanded());
    this.scriptMove(p, dir, 1);
    return true;
  }

  /** random_text -> a 0..255 roll off the world's own stream, so a line
   * picked at random is still picked the same way twice from one seed. */
  rollByte(): number {
    return this.shell.npcRng.byte();
  }

  /** play_cry -> the audio's playCry (Sound.lua:307). */
  playCry(species: string): void {
    (this.shell.audio as { playCry?: (s: string) => void }).playCry?.(species);
  }

  /** use_dig / use_teleport -> game.ts escapeWarp (the rope's landing). */
  escapeWarp(): boolean {
    return (this.shell as unknown as { escapeWarp?: () => boolean }).escapeWarp?.() ?? false;
  }

  /** use_fly -> game.ts openFlyPicker (the destination list and the warp). */
  openFlyPicker(monName: string, onDone?: () => void): void {
    (this.shell as unknown as {
      openFlyPicker?: (name: string, done?: () => void) => void;
    }).openFlyPicker?.(monName, onDone);
  }

  // --- the CABLE CLUB link (world/link.ts, world/cableclub.ts) -----------
  //
  // The session lives here rather than on the shell because it is world
  // state: it opens at a desk on a map, it is polled on the world's own
  // tick, and walking out of the Club is what ends it.

  /** The open session, or null when there is no link. */
  link: LinkSession | null = null;
  /** What a script is waiting for the session to do. */
  private linkWait:
    | { until: (s: LinkSession) => boolean; frames: number; done: (ok: boolean) => void }
    | null = null;

  /**
   * Open a session on whatever carrier the host offers. False when there is
   * none at all -- a build with no radio, which is where the ROM's own
   * "reserved for 2 friends" belongs.
   */
  openLink(): boolean {
    if (this.link && this.link.state !== "closed") return true;
    const shell = this.shell as unknown as { linkTransport?: () => LinkTransport | null };
    const t = shell.linkTransport ? shell.linkTransport() : hostTransport();
    if (!t) return false;
    this.link = new LinkSession(t, String(this.save.player?.name ?? "RED"));
    this.link.open();
    return true;
  }

  /**
   * Hold a script until the session satisfies `until`, or `frames` pass, or
   * the carrier drops. A link cannot be opened and answered inside one
   * frame, and the overworld cannot block, so this is the shape the waiting
   * has to take.
   */
  waitLink(
    until: (s: LinkSession) => boolean,
    frames: number,
    done: (ok: boolean) => void,
  ): void {
    this.linkWait = { until, frames, done };
  }

  /**
   * Drive the link, whatever is on screen.
   *
   * Called from game.tick rather than from update(), because only the TOP
   * state updates and a trade spends most of its life under a menu. A
   * connection that stops being read the moment a menu opens is a
   * connection that deadlocks every wait the trade depends on -- and the
   * other player's body would freeze mid-step too.
   */
  serviceLink(): void {
    this.pollLink();
    if (this.link && this.inLinkRoom()) {
      const p = this.player;
      this.link.sendPos(Math.round(p.px), Math.round(p.py), p.facing);
      this.syncPeerBody();
    }
  }

  private pollLink(): void {
    const s = this.link;
    if (!s) return;
    s.poll();
    const w = this.linkWait;
    if (!w) return;
    if (w.until(s)) {
      this.linkWait = null;
      w.done(true);
      return;
    }
    w.frames -= 1;
    if (w.frames <= 0 || s.state === "closed") {
      this.linkWait = null;
      w.done(false);
    }
  }

  /** link_room -> game.ts pickLinkRoom (the TRADE CENTER / COLOSSEUM menu). */
  pickLinkRoom(done: (ok: boolean) => void): void {
    const shell = this.shell as unknown as {
      pickLinkRoom?: (s: LinkSession | null, d: (ok: boolean) => void) => void;
    };
    if (!shell.pickLinkRoom) { done(false); return; }
    shell.pickLinkRoom(this.link, done);
  }

  /** link_enter: walk into whichever room both sides asked for, on my side
   * of the table. Which side is the session's to decide, so the two
   * consoles do not put both players on the same cell. */
  enterLinkRoom(done: () => void): void {
    const room = this.link?.agreedRoom() ?? 0;
    const seat = LINK_SEATS[this.link?.seat() ?? 0]!;
    const map = LINK_ROOM_MAP[room] ?? LINK_ROOM_MAP[0];
    this.startWarpTo(map, seat.enter.x, seat.enter.y, seat.facing as Dir, done);
  }

  /** True while standing in one of the Cable Club's two rooms. */
  private inLinkRoom(): boolean {
    return (LINK_ROOM_MAP as readonly string[]).includes(this.map?.id ?? "");
  }

  /**
   * The other player, drawn where they actually are.
   *
   * Each room ships one object -- TRADECENTER_OPPONENT, COLOSSEUM_OPPONENT --
   * which the ROM uses for exactly this. It is not an NPC with a script; it
   * is the peer's body, so it is moved to wherever their console last said
   * they were standing, in world pixels, which is what makes them look like
   * they are walking rather than teleporting cell to cell.
   */
  private syncPeerBody(): void {
    const s = this.link;
    if (!s) return;
    const p = s.peerPos;
    if (!p) return;
    const body = this.npcs.find((n) =>
      String((n.def as { name?: string }).name ?? "").endsWith("_OPPONENT"),
    ) as (NPC & { px: number; py: number }) | undefined;
    if (!body) return;
    body.px = p.x;
    body.py = p.y;
    body.cellX = Math.round(p.x / 16);
    body.cellY = Math.round(p.y / 16);
    body.facing = p.facing as Dir;
  }

  /** Am I at my seat, and are they at theirs? The table needs both. */
  seatedAtTable(): boolean {
    const s = this.link;
    if (!s || !this.inLinkRoom()) return false;
    const mine = LINK_SEATS[s.seat()]!;
    const p = this.player;
    return p.cellX === mine.seat.x && p.cellY === mine.seat.y;
  }

  peerSeated(): boolean {
    const s = this.link;
    const p = s?.peerPos;
    if (!s || !p) return false;
    const theirs = LINK_SEATS[s.seat() === 0 ? 1 : 0]!;
    return (
      Math.round(p.x / 16) === theirs.seat.x &&
      Math.round(p.y / 16) === theirs.seat.y
    );
  }

  /** link_battle -> game.ts linkBattle (the machine in the COLOSSEUM). */
  linkBattle(done: () => void): void {
    const shell = this.shell as unknown as { linkBattle?: (d: () => void) => void };
    if (!shell.linkBattle) { done(); return; }
    shell.linkBattle(done);
  }

  /** link_trade -> game.ts linkTrade (the table in the TRADE CENTER). */
  linkTrade(done: () => void): void {
    const shell = this.shell as unknown as { linkTrade?: (d: () => void) => void };
    if (!shell.linkTrade) { done(); return; }
    shell.linkTrade(done);
  }

  /** save_game: the Club saves before it opens the link. */
  saveGame(): void {
    (this.shell as unknown as { writeSave?: () => void }).writeSave?.();
  }

  /** open_diploma -> game.ts openDiploma (the completed-dex page). */
  openDiploma(onDone?: () => void): void {
    (this.shell as unknown as {
      openDiploma?: (done?: () => void) => void;
    }).openDiploma?.(onDone);
  }

  /** record_hall_of_fame -> game.ts recordHallOfFame (the induction flow). */
  recordHallOfFame(onDone?: () => void): void {
    (this.shell as unknown as {
      recordHallOfFame?: (done?: () => void) => void;
    }).recordHallOfFame?.(onDone);
  }

  openDaycare(onDone?: () => void): void {
    (this.shell as unknown as {
      openDaycare?: (done?: () => void) => void;
    }).openDaycare?.(onDone);
  }

  /** The party screen as a chooser (the in-game trade's DisplayPartyMenu). */
  pickPartyMon(onPick: (index: number) => void, onCancel: () => void): void {
    const shell = this.shell as unknown as {
      pickPartyMon?: (pick: (i: number) => void, cancel: () => void) => void;
    };
    if (shell.pickPartyMon) shell.pickPartyMon(onPick, onCancel);
    else onCancel();
  }

  /** Commands.lua:587 heal_party. */
  healParty(): void {
    this.shell.healParty();
  }

  /** host.stamp passthrough — see OverworldShell.stamp. */
  stamp(mapId: number, cx: number, cy: number, on: boolean): void {
    this.shell.stamp(mapId, cx, cy, on);
  }

  fieldFx(x: number, z: number, frame: number): void {
    this.shell.fieldFx?.(x, z, frame);
  }

  /** host.tint passthrough — see OverworldShell.tint. */
  tint(abgr: number): void {
    this.shell.tint(abgr);
  }

  /** Sound.lua:190 play — a one-shot effect over whatever is playing. */
  playSfx(name: string): void {
    this.shell.audio?.playSfx?.(name);
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
  // --- SAFARI ZONE (world/safari.ts) ------------------------------------

  /**
   * safari_start: open a game. The two steps the scripted walk into the zone
   * costs are charged there, not here (SAFARI_WALK_IN_STEPS).
   */
  safariStart(): void {
    this.save.safari = { balls: SAFARI_BALLS, steps: SAFARI_STEPS };
  }

  /** safari_end: close it, leftover balls forfeited with the game. */
  safariEnd(): void {
    this.save.safari = null;
  }

  /**
   * safari_walk_in: the two scripted steps up and out through the gate's
   * north warp. Returns false (and runs nothing) when the player is not on a
   * trigger cell — someone who paid after TALKING to the worker from
   * elsewhere walks in themselves, as the original leaves them to.
   */
  safariWalkIn(done: () => void): boolean {
    const p = this.player;
    if (p.cellY !== 2) return false;
    const w = this.map.warpAtCell?.(p.cellX, 0);
    if (!w) return false;
    this.scriptMove(p, "up", 2, () => {
      const st = this.save.safari;
      if (st) st.steps -= SAFARI_WALK_IN_STEPS;
      // scripted steps skip onStepComplete (and with it the warp check), so
      // the warp the walk lands on has to be taken explicitly
      this.takeWarp(w.def);
      done();
    });
    return true;
  }

  /**
   * safari_game.asm: one step off the timer on the zone's own maps, and at
   * zero the PA calls time. Returns true when the game ended, which stops the
   * rest of the step (no warp, no encounter roll) — the same short-circuit
   * OverworldController.lua:3520 takes.
   */
  private safariStep(): boolean {
    const st = this.save.safari;
    if (!st || !inSafariStepZone(this.map.id)) return false;
    st.steps -= 1;
    if (st.steps > 0) return false;
    this.safariGameOver("_TimesUpText");
    return true;
  }

  /**
   * The PA announcement and the ride back to the gate. Shared by running out
   * of steps and running out of balls (the battle's own game-over).
   */
  safariGameOver(reasonText: string): void {
    this.save.safari = null;
    this.shell.playOnce("Safari_Zone_PA");
    const t = (this.shell.data as { text?: Record<string, string> }).text ?? {};
    const reason = t[reasonText] ?? reasonText;
    const over = t._GameOverText ?? "PA: Your SAFARI\nGAME is over!";
    this.shell.showText(`${reason}\f${over}`, () => {
      this.startWarpTo(SAFARI_EXIT.map, SAFARI_EXIT.x, SAFARI_EXIT.y, SAFARI_EXIT.facing);
    });
  }

  /**
   * The Mansion 3F floor holes (PokemonMansion3FDefaultScript.holeCoords):
   * step on one and you drop a floor. Not a warp tile — the block under it is
   * ordinary floor — so it rides the land-trigger path, ahead of the map's own
   * script, the way pokered's default script checks holeCoords first.
   *
   * These are not decoration: (16,14) and (17,14) are the ONLY way into the
   * sealed 1F room the basement stairs sit in.
   */
  private mansionHoleStep(): boolean {
    if (this.runner.isRunning() || this.map?.id !== "POKEMON_MANSION_3F") return false;
    const p = this.player;
    const h = MANSION_HOLES.find((r) => r.x === p.cellX && r.y === p.cellY);
    if (!h) return false;
    this.shell.playOnce?.("Faint_Fall");
    this.startWarpTo(h.map, h.dx, h.dy, p.facing);
    return true;
  }

  /**
   * The map's land-triggers: its onStep hook, or a declarative coord
   * trigger. True when one ran and owns what happens next.
   *
   * Run on a completed step AND on arrival (arrivalTriggers), because most
   * of these are pokered map-script defaults that fire on map load --
   * gen1recomp runs them from onEnter -- and the port only ever had a step
   * to hang them on.
   */
  private runLandTriggers(): boolean {
    if (this.runner.isRunning()) return false;
    const label = (this as any).map?.id ?? "";
    const script = (MAP_SCRIPTS as any)[label] as MapScript | undefined;
    const host = (MAP_SCRIPTS as any)[label + "_ONSTEP_HOST"] as MapScript | undefined;
    const rows =
      script?.onStep?.(this, this.save) ??
      host?.onStep?.(this, this.save) ??
      this.coordTrigger(script) ??
      this.coordTrigger(host);
    if (!rows) return false;
    this.runScript(rows);
    return true;
  }

  /**
   * A map entered but not yet settled on: the land triggers still owe this
   * arrival a look, once the door walk-out and the fade are done with.
   */
  private arrivalPending = false;

  /**
   * ViridianMartDefaultScript and its kin run when the map LOADS, not on a
   * step: the clerk calls you over the moment you are inside. The port hung
   * them on onStep, so the parcel -- and every event like it -- waited for
   * a step the player had no reason to take, on a tile that looked like the
   * event had not fired.
   *
   * So: once the arrival has settled (the fade done, the door walk-out
   * finished, nothing else running), the land triggers get their look at
   * the tile the player came in on. Idempotent -- each entry arms it once,
   * and a trigger that declines leaves nothing behind.
   */
  private arrivalTriggers(): void {
    if (!this.arrivalPending) return;
    if (this.transitioning || this.player.moving) return;
    if (this.runner.isRunning() || this.scriptMoves.length > 0 || this.emote || this.engaging) {
      return;
    }
    this.arrivalPending = false;
    if (this.seafoamStep()) return;
    this.runLandTriggers();
  }

  onStepComplete(): void {
    // safari_game.asm runs BEFORE the land triggers and the warp check: when
    // the timer runs out the PA takes the step over entirely.
    if (this.safariStep()) return;
    // A REPEL counts down by the step, and says so when it is spent
    // (home/overworld.asm .repelWoreOff).
    const rs = this.save as { repelSteps?: number };
    if ((rs.repelSteps ?? 0) > 0) {
      rs.repelSteps = (rs.repelSteps ?? 0) - 1;
      if (rs.repelSteps === 0) {
        const t = (this.shell.data as { text?: Record<string, string> }).text ?? {};
        this.shell.showText(t._RepelWoreOffText ?? "REPEL's effect\nwore off.");
      }
    }
    // engine/events/poison.asm runs on the step too, ahead of the triggers
    if (this.fieldPoisonStep()) return;
    // Daycare.asm: the boarded mon earns one exp per step the player takes,
    // anywhere. Only counted here — it is folded into the mon at collection
    // (OverworldController.lua:3522).
    const dc = this.save.daycare;
    if (dc?.mon) dc.steps = (dc.steps ?? 0) + 1;
    // The Route 22 gate rewrites wLastMap from the player's row, so it has to
    // be re-read as they move — before the warp check below reads it.
    this.syncLastMapRewrite();
    // A map's land-triggers run first (OverworldController.lua:3502): the
    // onStep function hook (story cutscene logic) or a declarative coord
    // trigger. Fires for ANY map that registers one — the two _ONSTEP_HOST
    // entries are checked too so the original Pallet/Oak hooks still run.
    this.syncSurf();
    if (this.mansionHoleStep()) return;
    if (this.roadHoleStep()) return;
    this.lanceLockDoor();
    if (this.leagueDontRun()) return;
    if (this.badgeGateStep()) return;
    if (this.forcedTileStep()) return;
    if (this.seafoamStep()) return;
    if (this.spinnerStep()) return;
    if (this.runLandTriggers()) return;

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
      // BIT_FORCED_WARP (home/overworld.asm): a Seafoam current that ends on
      // the south-edge water stairs fires them with nothing held.
      const forced = this.forcedWarp;
      this.forcedWarp = false;
      if (!w && (this.dirHeld() || forced)) {
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
    // wRepelRemainingSteps (wild_encounters.asm): while a REPEL is on, a
    // mon under the lead's level does not appear at all.
    if (enc && repelled(this.save as never, enc.level)) enc = null;
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

  /**
   * field.lastMapRewrites (world/lastmap.ts): maps that overwrite wLastMap
   * themselves, so a LAST_MAP exit leaves where their script says rather than
   * where the player came in from. Run on map load and on every completed
   * step, since the Route 22 gate's rule reads the player's row.
   */
  private syncLastMapRewrite(): void {
    const rewrite = LAST_MAP_REWRITES[this.map.id];
    if (!rewrite) return;
    const id = rewrittenLastMap(rewrite, this.player.cellX, this.player.cellY);
    if (!id || this.lastOutdoor?.id === id) return;
    const w = this.shell.data.maps?.[id]?.warps?.[0];
    this.rememberOutdoor(id, w?.x ?? 0, w?.y ?? 0);
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
            e.stepFramesCur = e.stepSpeed();
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
  /** The lift panel; the shell owns the menu (game.ts openElevator). */
  openElevator(onDone: () => void): void {
    const shell = this.shell as unknown as {
      openElevator?: (mapId: string, done: () => void) => void;
    };
    if (shell?.openElevator) shell.openElevator(this.map.id, onDone);
    else onDone();
  }

  /** open_name_rater -> the NAME RATER's flow, via the shell. */
  openNameRater(onDone: () => void): void {
    const self = this as any;
    const shell = self.shell ?? self.game ?? self.host ?? null;
    if (shell?.openNameRater) shell.openNameRater(onDone);
    else onDone();
  }

  /** open_vending -> the rooftop machine's drink list (ui/shopscreen.ts). */
  openVending(onDone: () => void): void {
    const self = this as any;
    const shell = self.shell ?? self.game ?? self.host ?? null;
    if (shell?.openVending) shell.openVending(onDone);
    else onDone();
  }

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

  private trainerHeader(
    npc: NPC,
  ): { range?: number; event?: string; battle?: string; after?: string } | undefined {
    const headers = this.shell.data.trainer_headers as
      | Record<string, unknown>
      | undefined;
    const forMap = headers?.[this.map.def.label];
    if (!forMap) return undefined;
    type H = { range?: number; event?: string; battle?: string; after?: string };
    // The extractor keys these by OBJECT INDEX, which is 1-based -- but
    // writer.ts numericKeyed turns a dense-from-1 map into an ARRAY, which is
    // 0-based. 43 of the 69 maps come through as arrays and 26 stay objects,
    // so indexing both the same way handed every trainer on those 43 the NEXT
    // trainer's header (wrong sight range, wrong beat flag, wrong before- and
    // after-battle line) and the last one on each map no header at all.
    // Verified against the map data: wherever the shape is an array, the
    // trainer objects are exactly 1..N.
    if (Array.isArray(forMap)) return (forMap as H[])[npc.def.index - 1];
    return (forMap as Record<string, H>)[npc.def.index];
  }

  /**
   * OverworldController.lua:2982-2990 trainerDefeated — save.defeatedTrainers
   * by object id FIRST, then the header's EVENT_BEAT_* flag.
   *
   * The per-object record is not redundant: a text_asm trainer has no
   * def_trainers header at all, so there is no event flag to set and the flag
   * alone can never remember him. That is the Game Corner Rocket, who stayed
   * beatable forever and so never walked off the hidden staircase.
   */
  trainerDefeated(npc: NPC): boolean {
    if (this.save.defeatedTrainers?.[npc.id]) return true;
    const ev = this.trainerHeader(npc)?.event;
    return !!ev && this.save.flags?.[ev] === true;
  }

  /** The win record both engage paths write: object id, then the flag. */
  private markTrainerDefeated(npc: NPC, event: string | undefined): void {
    const save = this.save as { defeatedTrainers?: Record<string, boolean> };
    (save.defeatedTrainers ??= {})[npc.id] = true;
    if (event && this.save.flags) this.save.flags[event] = true;
    // CinnabarGymOpenGateScript: beating a room's guardian opens his gate,
    // quiz or no quiz. The flag is set here so the gate survives him being
    // gone, and the blocks are re-applied because no map load intervenes.
    this.syncGymGates();
    this.syncLeagueSeal();
  }

  /** Open the gate of every guardian already beaten (CinnabarGymOpenGate). */
  private syncGymGates(): void {
    if (this.map?.id !== "CINNABAR_GYM") return;
    const flags = this.save.flags;
    if (!flags) return;
    let opened = false;
    GYM_MACHINES.forEach((m, i) => {
      const beaten = this.save.defeatedTrainers?.[gymGuardKey(m.npc)] === true;
      if (beaten && flags[gymGateFlag(i)] !== true) {
        flags[gymGateFlag(i)] = true;
        opened = true;
      }
    });
    if (opened) this.shell.playOnce?.("Go_Inside");
    this.applyToggleBlocks(this.map.id, this.map.def);
  }

  // Force a trainer battle by object (no sight line): MtMoonB2F's Super Nerd
  // is triggered by a coord step, not a range. Mirrors the sight path's
  // fight() — before-battle text then StartTrainerBattle, beat flag set on a
  // win so the trigger doesn't re-fire (story2.lua engageSuperNerd ->
  // ow:engageTrainer).
  /**
   * PlayTrainerMusic (home/trainers.asm:399), via OverworldController.lua's
   * meetTrainerTheme: the encounter sting is picked from the engaged class —
   * the evil list, then the female list, then male by default. The rivals
   * `ret z` out of it and keep the MUSIC_MEET_RIVAL their own scripts start,
   * so they get nothing here. Returns null when the class takes no sting.
   */
  private meetTrainerTheme(cls: string | undefined): string | null {
    if (!cls || cls.includes("RIVAL")) return null;
    if (EVIL_TRAINERS.has(cls)) return "Music_MeetEvilTrainer";
    if (FEMALE_TRAINERS.has(cls)) return "Music_MeetFemaleTrainer";
    return "Music_MeetMaleTrainer";
  }

  engageTrainer(npc: NPC, onDone?: () => void): void {
    const header = this.trainerHeader(npc);
    npc.facePlayer(this.player);
    // TalkToTrainer starts the sting here, before the before-battle text.
    // On the SIGHT path TrainerEngage already started it at the "!"
    // (trainer_sight.asm:224), and `engaging` is how that says so — it must
    // not restart.
    if (!this.engaging) {
      const theme = this.meetTrainerTheme(npc.def.trainerClass);
      if (theme) this.shell.playOnce(theme);
    }
    const launch = () =>
      this.startTrainerBattle(
        npc.def.trainerClass ?? "",
        npc.def.trainerParty ?? 1,
        undefined,
        (won) => {
          if (won) this.markTrainerDefeated(npc, header?.event);
          onDone?.();
        },
      );
    const taunt = this.beforeBattleText(npc, header?.battle);
    if (taunt) this.showText(taunt, launch);
    else launch();
  }

  /**
   * The line a trainer says before the battle. header.battle when the
   * extractor found a def_trainers header, and otherwise the object's OWN
   * TEXT_* constant (OverworldController.lua:3030-3035) — a text_asm trainer
   * like the Game Corner Rocket has no header at all, so without the fallback
   * he walks you into the battle in silence.
   */
  private beforeBattleText(npc: NPC, key: string | undefined): string | null {
    const texts = (this.shell.data as { text?: Record<string, string> }).text;
    const keyed = key ? texts?.[key] : undefined;
    return keyed ?? this.resolveText(npc.def.text);
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
          // record the win only on a win so the sight line does not re-fire;
          // a loss leaves it and blacks out.
          if (won) this.markTrainerDefeated(npc, header?.event);
          npc.frozen = false;
          this.engaging = false;
        });
      // TalkToTrainer prints the before-battle text FIRST, then StartTrainerBattle
      // (home/trainers.asm:88). header.battle -> data.text key.
      const taunt = this.beforeBattleText(npc, header?.battle);
      if (taunt) this.showText(taunt, launch);
      else launch();
    };
    // TrainerEngage (engine/overworld/trainer_sight.asm:224) starts the
    // encounter sting HERE — with the "!", before the walk-up — not when the
    // battle opens. Without it the route theme played straight through the
    // approach, which is the one moment the original always scores.
    const theme = this.meetTrainerTheme(def.trainerClass);
    if (theme) this.shell.playOnce(theme);
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

  /**
   * The Game Corner's hidden staircase (field.gameCornerPoster). The block
   * covering the hideout warp is a wall ($2a) until the switch behind the
   * poster is found and $43 after, so the stairs only exist once
   * EVENT_FOUND_ROCKET_HIDEOUT is set.
   *
   * Written into the map DEFINITION, which is the shared gamedata object, so
   * it is set from the flag in BOTH directions on every entry rather than
   * only opened — otherwise a save without the flag would inherit an open
   * staircase from a save that had it, within one session.
   *
   * COLLISION ONLY. The voxel terrain is baked per map in the pak, so the
   * wall still renders; walking the now-passable tile reads as a secret
   * passage rather than a staircase appearing. Making it look right means
   * cooking that block as a toggleable stamp, the way cuttable trees already
   * are — a cook change, noted in the commit.
   */
  /** Re-run the poster swap on the map already loaded — what the GAME_CORNER
   * onStep calls once the switch has been pushed, so the stairs open without
   * leaving and coming back. */
  refreshGameCornerPoster(): void {
    this.applyGameCornerPoster(String(this.map?.id ?? ""), this.map?.def);
  }

  /**
   * The Mansion's switch doors and the Gym's quiz gates
   * (world/toggleblocks.ts), set to whatever the save says.
   *
   * Runs on every map entry, which is what pokered's
   * Mansion*CheckReplaceSwitchDoorBlocks and CinnabarGymGateCoords do, and
   * again after a switch is pressed or a question answered.
   */
  applyToggleBlocks(mapId: string, def: any): void {
    const on = this.save?.flags?.EVENT_MANSION_SWITCH_ON === true;
    for (const b of MANSION_BLOCKS[mapId] ?? []) {
      this.setToggleBlock(def, b, b.solidWhenOn === on);
    }
    if (mapId === "CINNABAR_GYM") {
      GYM_MACHINES.forEach((m, i) => {
        this.setToggleBlock(def, m.gate, !this.gymGateOpen(i));
      });
    }
  }

  /**
   * The Elite Four's doors (world/toggleblocks.ts LEAGUE_SEALS), set to
   * whatever the save says. Runs on every map entry, which is what pokered's
   * *ShowOrHideExitBlock does, and again the moment a room's trainer falls.
   *
   * Lorelei, Bruno and Agatha seal their exit until beaten. Lance is
   * inverted: his doorway ships CLOSED and opens while
   * EVENT_LANCES_ROOM_LOCK_DOOR is unset, then shuts behind you for good.
   */
  applyLeagueSeals(mapId: string, def: any): void {
    const seal = LEAGUE_SEALS[mapId];
    if (!seal) return;
    const set = this.save?.flags?.[seal.flag] === true;
    const solid = seal.whileSet ? set : !set;
    for (const b of seal.blocks) {
      this.setToggleBlock(def, { ...b, solidWhenOn: false }, solid);
    }
  }

  /**
   * LoreleiShowOrHideExitBlock runs on a map load, and pokered reloads the
   * map after a battle — so a door has to open the moment its keeper falls,
   * with no re-entry. Called from markTrainerDefeated.
   */
  private syncLeagueSeal(): void {
    const id = this.map?.id ?? "";
    if (!LEAGUE_SEALS[id]) return;
    this.applyLeagueSeals(id, this.map.def);
  }

  /**
   * The league's three anterooms refuse to let you retreat: stepping back
   * toward the entrance gets "Don't run away!" and a shove forward (the
   * entrance coord rows in each room script). The real barrier is that the
   * exit is sealed behind you; this is the front half of it.
   */
  /**
   * OverworldController.lua:3627-3660 checkSpinner / runSpinnerMoves: the
   * arrow tiles of the Rocket Hideout and Viridian Gym (field.spinners).
   * Landing on one slides the player along its extracted move list; where it
   * stops re-enters this landing pipeline, so a chain of arrows chains, and a
   * warp at the end of one still fires.
   */
  private spinnerStep(): boolean {
    const list = (this.shell.data.field as {
      spinners?: Record<string, { x: number; y: number; moves: { dir: Dir; count: number }[] }[]>;
    } | undefined)?.spinners?.[this.map.id];
    if (!list) return false;
    const p = this.player;
    const sp = list.find((s) => s.x === p.cellX && s.y === p.cellY);
    if (!sp) return false;
    // a free walk can land mid-cell; the slide runs on the grid
    p.px = p.cellX * 16;
    p.py = p.cellY * 16;
    this.shell.audio?.playSfx?.("Arrow_Tiles");
    const run = (i: number): void => {
      const mv = sp.moves[i];
      if (!mv) {
        (p as { spinning?: boolean }).spinning = false;
        this.onStepComplete();
        return;
      }
      (p as { spinning?: boolean }).spinning = true;
      this.scriptMove(p, mv.dir, mv.count, () => run(i + 1));
    };
    run(0);
    return true;
  }

  private leagueDontRun(): boolean {
    const seal = LEAGUE_SEALS[this.map?.id ?? ""];
    const dr = seal?.dontRun;
    if (!dr || this.runner.isRunning()) return false;
    const p = this.player;
    if (p.cellY < dr.fromY || p.cellX < dr.x[0] || p.cellX > dr.x[1]) return false;
    const t = (this.shell.data as { text?: Record<string, string> }).text ?? {};
    this.shell.showText(t[dr.text] ?? "Don't run away!", () => {
      this.scriptMove(p, "up", 1);
    });
    return true;
  }

  /**
   * Route 23's badge checks (scripts/Route23.asm): seven guards up the road to
   * Victory Road, each wanting a different badge. Walking the whole road takes
   * all eight gyms, which is what makes the League an earned destination
   * instead of somewhere you can stroll to on your first afternoon.
   *
   * Show the badge and the guard steps aside for good; turn up without it and
   * you are told which one you are missing and moved back a step. The road
   * runs north, so back is south.
   */
  private badgeGateStep(): boolean {
    if (this.runner.isRunning() || this.scriptMoves.length > 0) return false;
    const field = (this.shell.data as { field?: unknown }).field as never;
    const p = this.player;
    const guard = guardAt(field, this.save as never, this.map?.id ?? "", p.cellX, p.cellY);
    if (!guard) return false;
    const gate = gateFor(field, this.map.id);
    const t = (this.shell.data as { text?: Record<string, string> }).text ?? {};
    const say = (key: string | undefined, fallback: string): string =>
      fillBadgeName(t[key ?? ""] ?? fallback, guard.badge);
    if (guard.sprite !== undefined) this.faceObject?.(guard.sprite, "down");

    if (!hasBadge(this.save as never, guard)) {
      this.shell.showText(
        say(gate?.failText, "You can pass here only if you have the {RAM:wNameBuffer}!"),
        () => {
          this.scriptMove(p, "down", 1);
        },
      );
      return true;
    }
    this.save.flags[guard.event] = true;
    this.shell.showText(
      say(gate?.passText, "Oh! That is the {RAM:wNameBuffer}!"),
      () => {
        this.shell.showText(t._Route23GoRightAheadText ?? "OK then! Please, go right ahead!");
      },
    );
    return true;
  }

  /**
   * LancesRoomDefaultScript's doorway trigger: the first crossing seals the
   * door behind the player with SFX_GO_INSIDE. One way only — the flag is
   * never cleared, so there is no walking back out mid-league.
   *
   * Public because the walk-in lands ON the doorway and a scripted landing
   * fires no step (mapscripts.ts LANCES_ROOM), so that path calls this
   * itself, exactly as the original's per-frame coord poll would have.
   */
  lanceLockDoor(): boolean {
    if (this.map?.id !== "LANCES_ROOM") return false;
    const p = this.player;
    if (!LANCE_DOOR_CELLS.some(([x, y]) => x === p.cellX && y === p.cellY)) return false;
    if (this.save.flags.EVENT_LANCES_ROOM_LOCK_DOOR) return false;
    this.save.flags.EVENT_LANCES_ROOM_LOCK_DOOR = true;
    this.shell.playOnce?.("Go_Inside");
    this.applyLeagueSeals(this.map.id, this.map.def);
    return false; // the step itself still counts; only the door changed
  }

  /**
   * Victory Road's boulder barriers, set to whatever the switches say.
   *
   * These open only PARTLY -- $25 to $1d frees one more cell of the block and
   * leaves the rest wall -- so the stamp is driven per CELL rather than per
   * block: show it wherever the cell is still wall under the block the
   * barrier is now set to. Setting def.blocks first is what makes
   * isWalkableCell the authority on that.
   */
  applyRoadBarriers(mapId: string, def: any): void {
    const list = barriersFor(mapId);
    if (list.length === 0) return;
    for (const b of list) {
      const open = this.save?.flags?.[b.flag] === true;
      const i = b.by * def.width + b.bx;
      if (Array.isArray(def.blocks) && i >= 0 && i < def.blocks.length) {
        def.blocks[i] = open ? b.open : b.closed;
      }
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const cx = b.bx * 2 + dx;
          const cy = b.by * 2 + dy;
          this.stamp(def.index, cx, cy, !this.map.isWalkableCell(cx, cy));
        }
      }
    }
  }

  /**
   * Out-of-battle poison (engine/events/poison.asm, gen1recomp
   * applyFieldPoison): every fourth step each poisoned mon loses 1 HP with
   * SFX_POISONED; one that drops to 0 faints, its status cleared, and says
   * so; with nobody left standing the player blacks out. True when a box
   * took the step over.
   */
  private fieldPoisonStep(): boolean {
    const save = this.save as {
      poisonSteps?: number;
      party?: { hp: number; status: string | null; nickname?: string; species: string }[];
      player?: { name?: string };
    };
    save.poisonSteps = ((save.poisonSteps ?? 0) + 1) % POISON_STEP_INTERVAL;
    if (save.poisonSteps !== 0) return false;
    const party = save.party ?? [];
    const fainted: string[] = [];
    let any = false;
    for (const mon of party) {
      if (mon.status !== "PSN" || mon.hp <= 0) continue;
      any = true;
      mon.hp -= 1;
      if (mon.hp <= 0) {
        mon.hp = 0;
        mon.status = null; // the original clears the status on the faint
        const species = (this.shell.data.pokemon as Record<string, { name?: string }> | undefined)
          ?.[mon.species];
        fainted.push(mon.nickname ?? species?.name ?? mon.species);
      }
    }
    if (!any) return false;
    this.shell.audio?.playSfx?.("Poisoned");
    const alive = party.some((m) => m.hp > 0);
    if (fainted.length === 0 && alive) return false;
    // the boxes run as a script so each waits for the last, like the ROM's
    // PrintText chain; the blackout itself is the script's done
    const rows: unknown[][] = fainted.map((n) => ["show_text", `${n}\nfainted!`]);
    if (!alive) rows.push(["show_text", `${save.player?.name ?? "RED"} blacked\nout!`]);
    this.runScript(rows as never[], () => {
      if (!alive) (this.shell as unknown as { blackout?: () => void }).blackout?.();
    });
    return true;
  }

  private forcedMovement(): ForcedMovement | undefined {
    return (this.shell.data.field as { forcedMovement?: ForcedMovement } | undefined)
      ?.forcedMovement;
  }

  /**
   * Does the hill pull right now? On the BICYCLE, on a slope map, standing
   * still, and not braking: JoypadOverworld's mask is PAD_CTRL_PAD | PAD_B |
   * PAD_A, so a HELD A or B stays put, as the Route 17 sign promises
   * ("Press the A or B Button to stay in place").
   */
  private slopeRolls(): boolean {
    const fm = this.forcedMovement();
    if (!fm?.slopeMaps?.includes(this.map.id)) return false;
    if (!(this.save as { onBike?: boolean }).onBike) return false;
    if (this.player.moving || this.transitioning) return false;
    if (this.runner.isRunning() || this.scriptMoves.length > 0 || this.engaging) return false;
    const input = this.shell.input;
    return !(input.isDown("a") || input.isDown("b"));
  }

  /** The grid poll's half of the pull: one step south when nothing is held. */
  private rollDownhill(): void {
    if (this.dirHeld() || !this.slopeRolls()) return;
    const p = this.player;
    p.facing = "down";
    p.tryMove("down", this.map, this.entities, this.tilePairs);
  }

  /**
   * CheckForceBikeOrSurf (engine/overworld/player_state.asm, data/maps/
   * force_bike_surf.asm): the CYCLING ROAD's mouths put you on the BICYCLE
   * -- silently; _CyclingIsFunText is only IsSurfingAllowed's refusal -- or
   * turn a walker back, and the Seafoam current mouths put you on the water.
   * BIT_ALWAYS_ON_BIKE goes with the mount, so the bike stays on until a
   * gate. True when the step was taken over.
   */
  private forcedTileStep(): boolean {
    const tiles = this.forcedMovement()?.tiles?.[this.map.id];
    if (!tiles) return false;
    const p = this.player;
    const t = tiles.find((t) => t.x === p.cellX && t.y === p.cellY);
    if (!t) return false;
    const save = this.save as { onBike?: boolean; forcedBike?: boolean; inventory?: Record<string, number> };
    if (t.mode === "bike") {
      if (save.onBike) {
        save.forcedBike = true;
        return false;
      }
      if ((save.inventory?.BICYCLE ?? 0) > 0) {
        save.onBike = true;
        save.forcedBike = true;
        this.syncBike();
        this.syncSurfSong();
        return false;
      }
      this.showText("You need a\nBICYCLE for the\nCycling Road!", () => {
        this.scriptMove(p, BACK[p.facing], 1);
      });
      return true;
    }
    // a forced surf clears the bike state the way the party-menu mount does
    if (!p.surfing) {
      p.surfing = true;
      (this.save as { surfing?: boolean }).surfing = true;
      save.onBike = false;
      this.syncBike();
      this.syncSurfSong();
    }
    return false;
  }

  /** BIT_FORCED_WARP: set by a Seafoam current, read once by the next warp check. */
  private forcedWarp = false;
  private seafoamHiddenCache?: Record<string, Record<string, boolean>>;

  private seafoam(): SeafoamField | undefined {
    return seafoamData(this.shell.data.field);
  }

  private seafoamHidden(): Record<string, Record<string, boolean>> {
    if (!this.seafoamHiddenCache) this.seafoamHiddenCache = defaultHiddenBoulders(this.seafoam());
    return this.seafoamHiddenCache;
  }

  /**
   * The Seafoam water (scripts/SeafoamIslandsB3F.asm / B4F.asm): B4F's pool
   * edge pushes a surfer back up until the B3F plugs are down, and B3F's
   * currents drag one along their movement lists to the stairs. True when
   * the water took the step over.
   */
  private seafoamStep(): boolean {
    const sf = this.seafoam();
    if (!sf) return false;
    const p = this.player;
    const flags = this.save.flags;
    const up = forcedExitAt(sf, flags, this.map.id, p.cellX, p.cellY);
    if (up > 0 && p.surfing) {
      // SeafoamIslandsB4FDefaultScript: res BIT_FORCED_WARP before the push
      // so the stair warps underfoot cannot bounce you back.
      this.forcedWarp = false;
      this.shell.audio?.playSfx?.("Collision");
      p.px = p.cellX * 16;
      p.py = p.cellY * 16;
      this.scriptMove(p, "up", up);
      return true;
    }
    if (!p.surfing) return false;
    const c = currentAt(sf, flags, this.map.id, p.cellX, p.cellY);
    if (!c) return false;
    p.px = p.cellX * 16;
    p.py = p.cellY * 16;
    if (FORCED_WARP_FLOORS.includes(this.map.id)) this.forcedWarp = true;
    const run = (i: number): void => {
      const mv = c.moves[i];
      if (!mv) {
        // scripted steps skip onStepComplete; re-enter the landing pipeline
        // so the stairs (and BIT_FORCED_WARP) see the cell we stopped on
        this.onStepComplete();
        return;
      }
      this.scriptMove(p, mv.dir, mv.count, () => run(i + 1));
    };
    run(0);
    return true;
  }

  /** IsSurfingAllowed's Seafoam clause: "The current is much too fast!" */
  surfBlockedHere(): boolean {
    const p = this.player;
    return surfBlockedAt(this.save.flags, this.map.id, p.cellX, p.cellY);
  }

  /**
   * Victory Road 3F's hole under the player (VictoryRoad3FDefaultScript's
   * dungeon warp): the cell is ordinary walkable cave, so like the Mansion
   * holes it rides the land-trigger path rather than a warp tile.
   */
  private roadHoleStep(): boolean {
    if (this.runner.isRunning()) return false;
    const p = this.player;
    const h = ROAD_HOLES.find(
      (r) => r.map === this.map?.id && r.x === p.cellX && r.y === p.cellY,
    );
    if (!h) return false;
    this.shell.playOnce?.("Faint_Fall");
    this.startWarpTo(h.toMap, h.dx, h.dy, p.facing);
    return true;
  }

  /**
   * A persisted ShowObject/HideObject for a map that need not be the current
   * one -- the script verbs' toggleObject, live-applied only when it is.
   */
  private setObjectToggle(mapId: string, name: string, visible: boolean): void {
    const save = this.save as { objectToggles?: Record<string, Record<string, boolean>> };
    save.objectToggles = save.objectToggles ?? {};
    save.objectToggles[mapId] = save.objectToggles[mapId] ?? {};
    save.objectToggles[mapId][objectToggleKey(name)] = visible;
    if (mapId === this.map?.id) this.setObjectHidden(name, !visible);
  }

  /**
   * A boulder came to rest on the hole (.handle_hole): once, it goes down
   * and its twin appears on the floor below. True when one fell.
   */
  private boulderFell(): boolean {
    const mapId = this.map?.id ?? "";
    // Seafoam's holes (Seafoam1HolesCoords ..): the boulder goes down and
    // its twin appears on the floor below, once, under the hole's event.
    for (const { hole, destMap } of holesFor(this.seafoam(), mapId)) {
      if (this.save.flags?.[hole.boulderEvent] === true) continue;
      const on = this.npcs.find(
        (n: any) => this.isBoulder(n) && !n.hidden && n.cellX === hole.x && n.cellY === hole.y,
      ) as any;
      if (!on) continue;
      this.save.flags[hole.boulderEvent] = true;
      this.setObjectToggle(mapId, String(on.def?.name ?? ""), false);
      const shown = hole.showObject ? toggleToObjectName(destMap, hole.showObject) : null;
      if (shown) this.setObjectToggle(destMap, shown, true);
      this.shell.audio?.playSfx?.("Faint_Thud");
      this.shell.showText("The boulder fell\nthrough the hole!");
      return true;
    }
    for (const h of ROAD_HOLES) {
      if (h.map !== mapId || this.save.flags?.[h.flag] === true) continue;
      const on = this.npcs.find(
        (n: any) => this.isBoulder(n) && !n.hidden && n.cellX === h.x && n.cellY === h.y,
      ) as any;
      if (!on) continue;
      this.save.flags[h.flag] = true;
      this.setObjectToggle(h.map, String(on.def?.name ?? h.boulder), false);
      this.setObjectToggle(h.toMap, h.toBoulder, true);
      return true;
    }
    return false;
  }

  /**
   * A boulder came to rest. If it landed on a switch, the barrier that switch
   * holds opens for good (CheckAndSetEvent, then ReplaceTileBlock).
   */
  private boulderLanded(): void {
    if (this.boulderFell()) return;
    const mapId = this.map?.id ?? "";
    const list = barriersFor(mapId);
    if (list.length === 0) return;
    let opened = false;
    for (const b of list) {
      if (this.save.flags?.[b.flag] === true) continue;
      const on = this.npcs.some(
        (n: any) => this.isBoulder(n) && n.cellX === b.switchX && n.cellY === b.switchY,
      );
      if (!on) continue;
      this.save.flags[b.flag] = true;
      opened = true;
    }
    if (!opened) return;
    this.shell.playOnce?.("Go_Inside");
    this.applyRoadBarriers(mapId, this.map.def);
  }

  /** A gate is open once its quiz was answered or its guardian beaten. */
  private gymGateOpen(i: number): boolean {
    const f = this.save?.flags ?? {};
    const beaten = this.save?.defeatedTrainers ?? {};
    return f[gymGateFlag(i)] === true || beaten[gymGuardKey(GYM_MACHINES[i]!.npc)] === true;
  }

  /**
   * Put one toggleable block in a state: the collision block, and the baked
   * geometry over it.
   *
   * Unlike a cut tree these go both ways -- the Mansion switch shuts doors as
   * well as opening them -- and the stamp op takes a shown flag, so the
   * geometry comes back as readily as it goes.
   */
  private setToggleBlock(def: any, b: any, solid: boolean): void {
    const i = b.by * def.width + b.bx;
    if (Array.isArray(def.blocks) && i >= 0 && i < def.blocks.length) {
      def.blocks[i] = solid ? b.solid : OPEN_BLOCK;
    }
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const cx = b.bx * 2 + dx;
        const cy = b.by * 2 + dy;
        this.stamp(def.index, cx, cy, solid);
        if (solid) this.map.markShut(cx, cy);
        else this.map.markOpen(cx, cy);
      }
    }
  }

  /**
   * A Mansion statue switch (data/events/hidden_events.asm): press it and
   * every door on all four floors flips. Facing up, like all of them.
   *
   * Returns true when the press was spent here.
   */
  tryMansionSwitch(fx: number, fy: number): boolean {
    const cfg = MANSION_SWITCHES[this.map.id];
    if (!cfg || this.player.facing !== "up") return false;
    if (!cfg.cells.some(([x, y]) => x === fx && y === fy)) return false;
    const t = (this.shell.data as { text?: Record<string, string> }).text ?? {};
    this.shell.showChoice(
      t[`${cfg.text}SwitchText`] ?? "A secret switch!\nPress it?",
      (yes) => {
        if (!yes) {
          this.shell.showText(t[`${cfg.text}SwitchNotPressedText`] ?? "Not quite yet!");
          return;
        }
        const f = this.save.flags;
        f.EVENT_MANSION_SWITCH_ON = !f.EVENT_MANSION_SWITCH_ON;
        this.applyToggleBlocks(this.map.id, this.map.def);
        this.shell.playOnce?.("Go_Inside");
        this.shell.showText(t[`${cfg.text}SwitchPressedText`] ?? "Who wouldn't?");
      },
    );
    return true;
  }

  /**
   * A Cinnabar Gym quiz machine (cinnabar_gym_quiz.asm). Right answer opens
   * that room's gate; wrong one sics the room's trainer on you.
   */
  tryGymQuiz(fx: number, fy: number): boolean {
    if (this.map.id !== "CINNABAR_GYM" || this.player.facing !== "up") return false;
    const i = GYM_MACHINES.findIndex((m) => m.x === fx && m.y === fy);
    if (i < 0) return false;
    const m = GYM_MACHINES[i]!;
    const t = (this.shell.data as { text?: Record<string, string> }).text ?? {};
    this.shell.showText(
      t._CinnabarGymQuizIntroText ?? "POKéMON Quiz!",
      () => {
        this.shell.showChoice(t[`_CinnabarQuizQuestionsText${i + 1}`] ?? "Well?", (yes) => {
          if (yes === m.yes) {
            this.shell.playOnce?.("Get_Item1");
            this.shell.showText(
              t._CinnabarGymQuizCorrectText ?? "You're absolutely\ncorrect!",
              () => {
                if (!this.gymGateOpen(i)) {
                  this.save.flags[gymGateFlag(i)] = true;
                  this.shell.playOnce?.("Go_Inside");
                }
                this.applyToggleBlocks(this.map.id, this.map.def);
              },
            );
            return;
          }
          this.shell.playOnce?.("Denied");
          this.shell.showText(t._CinnabarGymQuizIncorrectText ?? "Sorry! Bad call!", () => {
            const npc = this.findNpc(m.npc);
            if (npc && !this.trainerDefeated(npc)) this.engageTrainer(npc, () => {});
          });
        });
      },
    );
    return true;
  }

  /**
   * LT. SURGE's trash cans (world/trashcans.ts). The cans are hidden
   * events on the gym floor, not objects, so this is where they live: A on
   * one asks the puzzle what that can holds and prints the answer. The
   * beeps come as each box CLOSES, not as it opens -- the asm's text_asm
   * tail runs after the text has printed and DisplayTextID then holds for
   * the press.
   *
   * PrintTrashText's other cans -- the SS ANNE kitchen's, and the gym's own
   * sixteenth -- are plain "only trash here" and ride the same path.
   */
  private tryTrashCan(fx: number, fy: number): boolean {
    const data = this.shell.data as never;
    const t = (this.shell.data as { text?: Record<string, string> }).text ?? {};
    const trash = t._VermilionGymTrashText ?? "Nope, there's\nonly trash here.";
    const plain = ((this.shell.data as {
      field?: { hiddenExtras?: { printTrash?: Record<string, { x: number; y: number }[]> } };
    }).field?.hiddenExtras?.printTrash ?? {})[this.map.id] ?? [];
    if (plain.some((h) => h.x === fx && h.y === fy)) {
      this.shell.showText(trash);
      return true;
    }
    const can = canAt(data, this.map.id, fx, fy);
    if (can === null) return false;
    const r = openCan(data, this.save as never, can, () => this.shell.rng.int(256));
    const say = (line: string, sfx: string): void =>
      this.shell.showText(line, () => this.shell.audio.playSfx(sfx));
    if (r.kind === "trash") {
      this.shell.showText(trash);
    } else if (r.kind === "first") {
      say(t._VermilionGymTrashSuccessText1
        ?? "Hey! There's a\nswitch under the\ntrash!\fThe 1st electric\nlock opened!", "Switch");
    } else if (r.kind === "second") {
      // VermilionGymSetDoorTile: the clear block over the doorway is what
      // opens the motorized door.
      const def = this.map.def as { blocks?: number[]; width: number; index: number };
      const door = trashData(data)?.doorBlock ?? DOOR_BLOCK;
      const i = door.by * def.width + door.bx;
      if (Array.isArray(def.blocks) && i >= 0 && i < def.blocks.length) {
        def.blocks[i] = door.block;
      }
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const cx = door.bx * 2 + dx;
          const cy = door.by * 2 + dy;
          this.stamp(def.index, cx, cy, false);
          this.map.markOpen(cx, cy);
        }
      }
      say(t._VermilionGymTrashSuccessText3
        ?? "The 2nd electric\nlock opened!\fThe motorized door\nopened!", "Go_Inside");
    } else {
      say(t._VermilionGymTrashFailText
        ?? "Nope! There's\nonly trash here.\fHey! The electric\nlocks were reset!", "Denied");
    }
    return true;
  }

  /**
   * Hidden items and coins (world/hiddenitems.ts): A on a tile that hides
   * one finds it, with SFX_GET_ITEM_2 as hidden_items.asm always plays. A
   * full bag announces the find and leaves it for later.
   */
  private tryHiddenItem(fx: number, fy: number): boolean {
    const data = this.shell.data as never;
    const t = (this.shell.data as { text?: Record<string, string> }).text ?? {};
    const player = String(this.save.player?.name ?? "RED");
    const line = (k: string, fallback: string, subs: Record<string, string> = {}): string => {
      let s = t[k] ?? fallback;
      s = s.replace(/\{PLAYER\}/g, player).replace(/\{RAM:wNameBuffer\}/g, subs.name ?? "");
      return s.replace(/\{NUM:[^}]*\}/g, subs.num ?? "");
    };
    const r = findHidden(data, this.save as never, this.map.id, fx, fy,
      (item) => Bag.add(this.save, item, 1, data));
    if (!r || r.kind === "nocase") return false;
    if (r.kind === "item") {
      this.playSfx("Get_Item2");
      this.shell.showText(line("_FoundHiddenItemText", "{PLAYER} found\n{RAM:wNameBuffer}!", { name: r.name }));
    } else if (r.kind === "bagfull") {
      this.shell.showText(
        line("_FoundHiddenItemText", "{PLAYER} found\n{RAM:wNameBuffer}!", { name: r.name }) + "\f"
        + line("_HiddenItemBagFullText", "But, {PLAYER} has\nno more room for\nother items!"),
      );
    } else {
      this.playSfx("Get_Item2");
      this.shell.showText(line("_FoundHiddenCoinsText", "{PLAYER} found\n{NUM} coins!", { num: String(r.coins) }));
    }
    return true;
  }

  /** ITEMFINDER: any hidden item still unfound near the player. */
  hiddenItemNearby(): boolean {
    const p = this.player;
    return hiddenItemNear(this.shell.data as never, this.save as never, this.map.id, p.cellX, p.cellY);
  }

  /** This map's card-key doors, or an empty list. */
  private cardKeyDoors(mapId: string): any[] {
    const ck = (this.shell.data as any).field?.cardKeyDoors;
    return ck?.closedDoors?.[mapId] ?? [];
  }

  /** A door is open once every event it lists is set. */
  private doorUnlocked(door: any): boolean {
    const f = this.save?.flags ?? {};
    const events: string[] = door.events ?? (door.event ? [door.event] : []);
    return events.length > 0 && events.every((e) => f[e] === true);
  }

  /**
   * stampClosedDoors (OverworldController.lua:250): the card-key doors this
   * floor still has shut stay shut, and the ones already opened come off.
   *
   * The cook bakes the CLOSED door in and lifts it out as per-cell stamps
   * (cook/cli.ts + cook/mesh.ts), so an unlocked door is hidden the way a cut
   * tree is and the cells under it are opened up. Nothing has to be done for
   * a door that is still shut: the baked block is already solid and its
   * geometry is already there.
   *
   * Rocket Hideout B4F's lift gate lists TWO events -- both guards -- which
   * is why this takes a list rather than a flag.
   */
  private applyCardKeyDoors(mapId: string, def: any): void {
    for (const door of this.cardKeyDoors(mapId)) {
      if (this.doorUnlocked(door)) {
        this.openDoorCells(def, door);
        continue;
      }
      // Shut, and SAID to be shut here rather than trusted to be: the cook
      // bakes the closed door into the pak's geometry, but gamedata.json is
      // written from the imported map data, where the doorway is still the
      // open block it ships as. Without this the door is drawn shut and
      // walked straight through.
      const i = door.by * def.width + door.bx;
      if (Array.isArray(def.blocks) && i >= 0 && i < def.blocks.length) {
        def.blocks[i] = door.block;
      }
    }
  }

  /**
   * The floor's door callback, run again the way the ROM runs it at the end
   * of a battle: EndTrainerBattle sets BIT_CUR_MAP_LOADED_1 (home/trainers
   * .asm), and the Rocket Hideout's ...DoorCallbackScript reads that as a
   * map load, so beating the last guard opens the lift gate on the spot,
   * with SFX_GO_INSIDE. Without this the gate only opened on the NEXT load:
   * you beat both guards and stood in front of a door that would not open
   * until you left the floor and came back.
   *
   * Only doors that are shut and have just become unlockable move; a door
   * already open, or still locked, is left exactly as it is.
   */
  refreshDoors(): void {
    const def = this.map?.def;
    if (!def || !Array.isArray(def.blocks)) return;
    let opened = false;
    for (const door of this.cardKeyDoors(this.map.id)) {
      if (!this.doorUnlocked(door)) continue;
      const i = door.by * def.width + door.bx;
      if (i < 0 || i >= def.blocks.length || def.blocks[i] === door.open) continue;
      this.openDoorCells(def, door);
      opened = true;
    }
    if (opened) this.playSfx("Go_Inside");
  }

  /** Take one door off the map: the geometry, the block and the collision. */
  private openDoorCells(def: any, door: any): void {
    const i = door.by * def.width + door.bx;
    if (Array.isArray(def.blocks) && i >= 0 && i < def.blocks.length) {
      def.blocks[i] = door.open;
    }
    // A block is two cells square, hence the 2x2 from its top-left cell.
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const cx = door.bx * 2 + dx;
        const cy = door.by * 2 + dy;
        this.stamp(def.index, cx, cy, false);
        this.map.markOpen(cx, cy);
      }
    }
  }

  /**
   * PrintCardKeyText (engine/events/card_key.asm): facing a locked door with
   * the CARD KEY opens it, without it says so.
   *
   * Returns true when the press was spent on a door, so interact() stops
   * rather than falling through to whatever else is on that tile.
   */
  tryCardKeyDoor(fx: number, fy: number): boolean {
    const mapId = this.map.id;
    const door = this.cardKeyDoors(mapId).find((d: any) => {
      // the four cells of the door's block
      const cx = d.bx * 2;
      const cy = d.by * 2;
      return fx >= cx && fx <= cx + 1 && fy >= cy && fy <= cy + 1;
    });
    if (!door || this.doorUnlocked(door)) return false;
    const t = (this.shell.data as { text?: Record<string, string> }).text ?? {};
    if ((this.save.inventory?.CARD_KEY ?? 0) <= 0) {
      this.shell.showText(t._CardKeyFailText ?? "Darn! It needs a\nCARD KEY!");
      return true;
    }
    const events: string[] = door.events ?? (door.event ? [door.event] : []);
    for (const e of events) this.save.flags[e] = true;
    this.openDoorCells(this.map.def, door);
    this.shell.playOnce?.("Go_Inside");
    this.shell.showText(
      (t._CardKeySuccessText1 ?? "Bingo!") + (t._CardKeySuccessText2 ?? "\nThe CARD KEY\nopened the door!"),
    );
    return true;
  }

  private applyGameCornerPoster(mapId: string, def: any): void {
    const p = (this.shell.data as any).field?.gameCornerPoster;
    if (!p || p.map !== mapId || !Array.isArray(def.blocks)) return;
    const open = this.save?.flags?.[p.event] === true;
    const block = open ? p.openBlock : p.closedBlock;
    const i = p.y * def.width + p.x;
    if (i >= 0 && i < def.blocks.length) def.blocks[i] = block;
    // The wall the player SEES. cook/mesh.ts splits that block's quads into
    // per-cell stamps, so the geometry comes off the same way a cut tree's
    // does. A block is two cells square, hence the 2x2 loop from its
    // top-left cell. Only hiding is ever needed: a fresh map load rebuilds
    // the terrain with the wall present, and this runs on every entry.
    if (!open) return;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        this.stamp(def.index, p.x * 2 + dx, p.y * 2 + dy, false);
      }
    }
  }

  /** A script-opened wild battle (the POKEMON TOWER 6F ghost), delegated to
   * the shell the same way startTrainerBattle is. */
  startWildBattle(
    species: string,
    level: number,
    opts?: { noCatch?: boolean; disguised?: boolean; unveil?: boolean },
    onDone?: (result: string | null) => void,
  ): void {
    const self = this as any;
    const shell = self.shell ?? self.game ?? self.host ?? null;
    if (shell?.startWildBattle) shell.startWildBattle(species, level, opts, onDone);
    else onDone?.(null);
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
