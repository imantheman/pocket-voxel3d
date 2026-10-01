// gen1recomp src/world/gen2/WorldAPI.lua at bdfac727 (MIT).
//
// mod.world for Gen 2 (Gold): the same facade src/world/WorldAPI.lua gives a
// mod under Gen 1, resolved against world/World instead of the Gen 1
// overworld state.  One name, one method set, two arms.
//
// Two structural differences show through, and both are reported rather than
// faked:
//   * Gold's World is not a stack state.  It hangs off the service owner as
//     game.world for the whole run, so there is no stack scan here.
//   * Gen 2 event flags are NUMBERS (wEventFlags is a bitfield), where Gen 1
//     flags are string keys in save.flags.  setFlag/getFlag take a numeric id
//     here and say so when handed a string.
//
// Anything Gen 2 has no equivalent for returns nil plus a reason.  The Lua's
// `value, reason` pairs are TUPLES here: `[value | undefined, reason?]`
// (ApiResult).  Methods whose Lua returns one value return it alone
// (overworld, canReorderParty).

import { Logger } from "../shared/core/Logger.ts";
import { Movement } from "../script/Movement.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { HiddenItems } from "./HiddenItems.ts";
import { MapOverview, type MapMarker, type MapOverviewResult } from "../shared/world/MapOverview.ts";
import { Bike } from "./Bike.ts";
import { FieldMoves } from "./FieldMoves.ts";
import { Permissions } from "./Permissions.ts";
import { Mail } from "../core/Mail.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Roamers } from "../core/Roamers.ts";
import { Encounter } from "../battle/Encounter.ts";
import { Clock } from "../core/Clock.ts";
import { Palettes } from "./Palettes.ts";
import { Mon } from "../battle/Mon.ts";
import { format, tonumber, tostring } from "../platform/lua.ts";

/** A Lua `value, reason` pair. */
export type ApiResult<T> = [T | undefined, string?];

export interface FieldActionInfo {
  id: string;
  label: string;
  rods?: { id: string; label: string }[];
  sources?: HealSource[];
}

interface MonInfo {
  slot: number;
  species: any;
  name: any;
  level: any;
  hp: any;
  maxHp: number;
}

interface HealSource extends MonInfo {
  cost: number;
  targets: MonInfo[];
}

// Lua: WorldAPI.lua:39-52
const NO_OVERWORLD = "no overworld";
const RODS = ["OLD_ROD", "GOOD_ROD", "SUPER_ROD"];
const FIELD_ACTIONS: { id: string; move: string }[] = [
  { id: "cut", move: "CUT" },
  { id: "surf", move: "SURF" },
  { id: "strength", move: "STRENGTH" },
  { id: "flash", move: "FLASH" },
  { id: "headbutt", move: "HEADBUTT" },
  { id: "whirlpool", move: "WHIRLPOOL" },
  { id: "waterfall", move: "WATERFALL" },
  { id: "sweet_scent", move: "SWEET_SCENT" },
  { id: "dig", move: "DIG" },
  { id: "teleport", move: "TELEPORT" },
];

// Lua: WorldAPI.lua:55 -- engine/pokemon/mon_menu.asm:138
// MonMenu_Softboiled_MilkDrink
const HEAL_ACTIONS: { id: string; move: string }[] = [
  { id: "softboiled", move: "SOFTBOILED" },
  { id: "milk_drink", move: "MILK_DRINK" },
];

// Party slots are 1-based, as the Lua (and the mod contract) count them.
function slotOf(party: any[], slot: number): any {
  return party[slot - 1];
}

// Lua: WorldAPI.lua:60
function validPartySlot(party: any[], slot: unknown): slot is number {
  return typeof slot === "number" && slot === Math.floor(slot)
    && slotOf(party, slot) != null;
}

// Lua: WorldAPI.lua:65
function maxHpOf(mon: any): number {
  return (mon && (mon.maxHp ?? (mon.stats && mon.stats.hp))) || 0;
}

// Lua: WorldAPI.lua:69
function knows(mon: any, moveId: string): boolean {
  for (const move of (mon && mon.moves) || []) {
    if (move == null) break; // ipairs
    if ((typeof move === "object" ? move.id : move) === moveId) return true;
  }
  return false;
}

// Lua: WorldAPI.lua:76
function monInfo(game: any, mon: any, slot: number): MonInfo {
  const def = (game.data.pokemon || {})[mon.species] || {};
  return {
    slot, species: mon.species,
    name: mon.nickname || def.name || mon.species, level: mon.level,
    hp: mon.hp, maxHp: maxHpOf(mon),
  };
}

// Lua: WorldAPI.lua:84 -- engine/items/item_effects.asm:2016
// .SelectMilkDrinkRecipient
function healSources(game: any, moveId: string): HealSource[] {
  const party: any[] = (game.save && game.save.party) || [];
  const sources: HealSource[] = [];
  for (let sourceSlot = 1; sourceSlot <= party.length; sourceSlot++) {
    const source = party[sourceSlot - 1];
    if (source == null) break; // ipairs
    const cost = Math.floor(maxHpOf(source) / 5);
    if (knows(source, moveId) && (source.hp ?? 0) > cost) {
      const info = monInfo(game, source, sourceSlot) as HealSource;
      info.cost = cost;
      info.targets = [];
      for (let targetSlot = 1; targetSlot <= party.length; targetSlot++) {
        const target = party[targetSlot - 1];
        if (target == null) break;
        if (FieldMoves.softboiledTargetOk(source, target)) {
          info.targets.push(monInfo(game, target, targetSlot));
        }
      }
      if (info.targets.length > 0) sources.push(info);
    }
  }
  return sources;
}

// Lua: WorldAPI.lua:148
function itemLabel(game: any, id: string): string {
  const def = game && game.data && game.data.items ? game.data.items[id] : undefined;
  return (def && def.name) || id;
}

// Lua: WorldAPI.lua:281-282
const ENCOUNTER_TERRAIN: Record<string, boolean> = { grass: true, water: true };
const DAYTIMES: Record<string, boolean> = { MORN: true, DAY: true, NITE: true, DARK: true };

// Lua: WorldAPI.lua:452 -- id is a numeric EVENT_* index into wEventFlags.
// A string is the Gen 1 habit and cannot work here, so it is refused with the
// reason.  TUPLE [id, err?].
function flagId(id: unknown): ApiResult<number> {
  if (typeof id === "number") return [id];
  return [undefined, format("Gen 2 event flags are numeric ids, got %s (%s)",
    luaType(id), tostring(id))];
}

function luaType(v: unknown): string {
  if (v == null) return "nil";
  if (typeof v === "object") return "table";
  return typeof v;
}

// Lua: WorldAPI.lua:484
const UNSUPPORTED = "not supported in Gen 2 yet";

// Lua: WorldAPI.lua:508 -- a handle onto a live NPC.  Scripted movement does
// carry over: it compiles to the cart's own movement stream and rides
// World:beginMovement, the same path an `applymovement` in a map script
// takes.  Only spawning does not.
export class Handle {
  world: any;
  npc: any;
  objectId: number;

  constructor(world: any, npc: any, objectId: number) {
    this.world = world;
    this.npc = npc;
    this.objectId = objectId;
  }

  // Lua: WorldAPI.lua:514 -- one movement stream at a time is the engine's
  // own limit (World.moveState is a single slot), so a second call while one
  // is running is refused rather than stranding the first's onDone.
  scriptMove(dir: string, tiles?: number, onDone?: () => void): ApiResult<true> {
    const world = this.world;
    if (world.moveState) return [undefined, "a movement is already running"];
    const step = Movement.stepByte(dir);
    if (step == null) return [undefined, "unknown direction: " + tostring(dir)];
    const bytes: number[] = [];
    const n = Math.max(0, tiles ?? 1);
    for (let i = 1; i <= n; i++) bytes.push(step);
    bytes.push(Movement.STEP_END);
    world.beginMovement(this.objectId, bytes, onDone);
    return [true];
  }

  // Lua: WorldAPI.lua:529 -- Gen 1's marchInPlace is step_sleep-with-
  // animation; the Gen 2 stream has no single byte for it.  Left explicit
  // rather than approximated.
  marchInPlace(): ApiResult<never> {
    return [undefined, UNSUPPORTED];
  }

  // Lua: WorldAPI.lua:533
  face(dir: string): boolean {
    this.npc.scriptFace(dir);
    return true;
  }

  // Lua: WorldAPI.lua:538 -- TUPLE [cellX, cellY].
  position(): [number, number] {
    return [this.npc.cellX, this.npc.cellY];
  }
}

type Verb = (api: WorldAPI, row: any[], resume: () => void) => ApiResult<true>;

// Lua: WorldAPI.lua:564 -- the Gen 2 VM runs the cart's own bytecode, not
// the Gen 1 runner's `{ "command", ... }` rows.  What a mod reaches for out of
// that vocabulary is a small set of verbs Gold has its own entry points for,
// so those are driven directly here, one row at a time, and anything else is
// refused BY NAME before the first row runs.
const VERBS: Record<string, Verb> = {
  // Lua: WorldAPI.lua:571 -- start_battle "wild" species level.  Gold's own
  // grass step ends in World:startBattle with a Mon, so this is that call
  // with the mon built from the mod's species and level.  Only the wild arm
  // is served.
  start_battle(api, row, resume) {
    const world = api.overworld();
    const kind = row[1];
    if (kind !== "wild") {
      return [undefined, "only start_battle \"wild\" is supported in Gen 2"];
    }
    const game = world.game;
    const mon = Mon.new(game ? game.data : undefined, row[2], tonumber(row[3]) ?? 5);
    if (!mon) return [undefined, "unknown species: " + tostring(row[2])];
    const save = game ? game.save : undefined;
    if (save) {
      save.pokedex = save.pokedex || { seen: {}, caught: {} };
      save.pokedex.seen[mon.species] = true;
    }
    world.startBattle({ wild: mon }, () => resume());
    return [true];
  },

  // Lua: WorldAPI.lua:590
  warp(api, row, resume) {
    const [ok, err] = api.warpTo(row[1], row[2], row[3], row[4]);
    if (!ok) return [undefined, err];
    resume();
    return [true];
  },

  // Lua: WorldAPI.lua:597
  text(api, row, resume) {
    const world = api.overworld();
    world.showText(tostring(row[1] ?? ""), () => resume());
    return [true];
  },

  // Lua: WorldAPI.lua:603
  setflag(api, row, resume) {
    const [ok, err] = api.setFlag(row[1], true);
    if (!ok) return [undefined, err];
    resume();
    return [true];
  },

  // Lua: WorldAPI.lua:610
  clearflag(api, row, resume) {
    const [ok, err] = api.setFlag(row[1], false);
    if (!ok) return [undefined, err];
    resume();
    return [true];
  },
};

export class WorldAPI {
  game: any;
  modId: any;
  queue: true | undefined;

  constructor(game: any, modId: any) {
    this.game = game;
    this.modId = modId;
  }

  // Lua: WorldAPI.lua:103
  static new(game: any, modId: any): WorldAPI {
    return new WorldAPI(game, modId);
  }

  // Lua: WorldAPI.lua:108 -- the live World, or undefined while the boot
  // cinema is still up.
  overworld(): any {
    const world = this.game ? this.game.world : undefined;
    if (world && world.map) return world;
    return undefined;
  }

  // Lua: WorldAPI.lua:114
  current(): ApiResult<{ mapId: string; x: number | undefined; y: number | undefined; facing: string | undefined }> {
    const world = this.overworld();
    if (!world || !world.map) return [undefined, NO_OVERWORLD];
    const p = world.player;
    return [{
      mapId: world.map.id, x: p ? p.cellX : undefined, y: p ? p.cellY : undefined,
      facing: p ? p.facing : undefined,
    }];
  }

  // Lua: WorldAPI.lua:125 -- keep the public party-ordering contract
  // identical across generations.  Gen 2 stores mail by party slot, so it
  // must move with the Pokemon just as PartyMenu's SwitchPartyMons does.
  canReorderParty(): boolean {
    const world = this.overworld();
    const game = this.game;
    const party: any[] = (game && game.save && game.save.party) || [];
    return party.length > 1 && world != null && !!world.acceptsMenuInput();
  }

  // Lua: WorldAPI.lua:131 -- slots are 1-based.
  reorderParty(fromSlot: number, toSlot: number): ApiResult<true> {
    const world = this.overworld();
    const game = this.game;
    if (!world) return [undefined, NO_OVERWORLD];
    if (!world.acceptsMenuInput()) return [undefined, "world is busy"];
    const party: any[] = (game.save && game.save.party) || [];
    if (!validPartySlot(party, fromSlot) || !validPartySlot(party, toSlot)) {
      return [undefined, "invalid party slot"];
    }
    if (fromSlot !== toSlot) {
      const a = party[fromSlot - 1];
      party[fromSlot - 1] = party[toSlot - 1];
      party[toSlot - 1] = a;
      Mail.swapSlots(game.save, fromSlot, toSlot);
      Sound.play(game.data, "Sfx_SwitchPokemon");
    }
    return [true];
  }

  // Lua: WorldAPI.lua:156 -- the same field-item contract as Gen 1, resolved
  // through Gold's own bike, collision and fishing rules.  TUPLE
  // [actions, reason?]: the list is always there (empty with a reason).
  availableFieldActions(): [FieldActionInfo[], string?] {
    const world = this.overworld();
    const game = this.game;
    const out: FieldActionInfo[] = [];
    if (!(world && game && game.save && world.map && world.player)) {
      return [out, NO_OVERWORLD];
    }
    if (!world.acceptsMenuInput()) return [out, "world is busy"];
    const inventory = game.save.inventory || {};

    if ((inventory.BICYCLE ?? 0) > 0) {
      const bike = Bike.tryBike({
        state: world.playerState,
        environment: world.map.def ? world.map.def.environment : undefined,
        collision: world.playerCollision(),
        alwaysOnBike: world.alwaysOnBike(),
      });
      if (bike === "mount" || bike === "dismount") {
        out.push({ id: "bicycle", label: bike === "dismount" ? "BIKE OFF" : "BICYCLE" });
      }
    }

    const context = world.fieldContext();
    if (!FieldMoves.isSurfing(world.playerState)
      && Permissions.isWater(context.facingColl)) {
      const rods: { id: string; label: string }[] = [];
      for (const id of RODS) {
        if ((inventory[id] ?? 0) > 0) {
          rods.push({ id, label: itemLabel(game, id) });
        }
      }
      if (rods.length > 0) {
        out.push({ id: "fish", label: "FISH", rods });
      }
    }

    for (const row of FIELD_ACTIONS) {
      if (!(row.move === "STRENGTH" && world.strengthActive)) {
        const mon = FieldMoves.partyMoveUser(context.party, row.move, context);
        if (mon) {
          context.mon = mon;
          const result = FieldMoves.fromMenu(row.move, context);
          if (result.ok) {
            out.push({ id: row.id, label: row.move.replace(/_/g, " ") });
          }
        }
      }
    }

    for (const row of HEAL_ACTIONS) {
      const sources = healSources(game, row.move);
      if (sources.length > 0) {
        out.push({ id: row.id, label: row.move.replace(/_/g, " "), sources });
      }
    }

    if ((inventory.SQUIRTBOTTLE ?? 0) > 0 && world.squirtbottleTreeScript()) {
      out.push({ id: "squirtbottle", label: itemLabel(game, "SQUIRTBOTTLE") });
    }
    return [out];
  }

  // Lua: WorldAPI.lua:221 -- World:useFieldItem returns a TUPLE
  // [outcome | undefined, extra?]; only the outcome is read here.
  useFieldAction(id: string, opts?: { rod?: string; sourceSlot?: unknown; targetSlot?: unknown }): ApiResult<true> {
    const world = this.overworld();
    if (!world) return [undefined, NO_OVERWORLD];
    if (!world.acceptsMenuInput()) return [undefined, "world is busy"];
    let found: FieldActionInfo | undefined;
    for (const action of this.availableFieldActions()[0]) {
      if (action.id === id) {
        found = action;
        break;
      }
    }
    if (!found) return [undefined, "field action unavailable"];

    if (id === "bicycle") {
      const [outcome] = world.useFieldItem("BICYCLE");
      if (outcome && outcome !== "nowhere") return [true];
    } else if (id === "fish") {
      const rods = found.rods!;
      let rod = opts ? opts.rod : undefined;
      if (!rod && rods.length === 1) rod = rods[0]!.id;
      for (const choice of rods) {
        if (choice.id === rod) {
          const [outcome] = world.useFieldItem(rod);
          if (outcome && outcome !== "nowhere") return [true];
          break;
        }
      }
      return [undefined, "fishing rod unavailable"];
    } else if (id === "squirtbottle") {
      const [outcome] = world.useFieldItem("SQUIRTBOTTLE");
      if (outcome && outcome !== "nowhere") return [true];
    } else if (id === "softboiled" || id === "milk_drink") {
      const party: any[] = (this.game.save && this.game.save.party) || [];
      const sourceSlot = opts ? tonumber(opts.sourceSlot) : undefined;
      const targetSlot = opts ? tonumber(opts.targetSlot) : undefined;
      let cost: number | undefined;
      for (const source of found.sources || []) {
        if (source.slot === sourceSlot) {
          for (const target of source.targets || []) {
            if (target.slot === targetSlot) {
              cost = source.cost;
              break;
            }
          }
        }
      }
      if (cost == null) return [undefined, "softboiled target unavailable"];
      const user = party[sourceSlot! - 1];
      const target = party[targetSlot! - 1];
      // FieldMoves.softboiledTransfer: the Lua's `before, after` pair, as a
      // TUPLE [before, after] | undefined.
      const moved = FieldMoves.softboiledTransfer(user, target, cost);
      if (!moved) return [undefined, "softboiled target unavailable"];
      const [before, after] = moved;
      // data/text/common_1.asm:40 _RecoveredSomeHPText
      world.showText(Strings.get("%s\nrecovered %dHP!",
        target.nickname || target.species, after - before));
      return [true];
    }
    for (const row of FIELD_ACTIONS) {
      if (row.id === id) {
        const context = world.fieldContext();
        const mon = FieldMoves.partyMoveUser(context.party, row.move, context);
        const result = mon ? world.useFieldMove(row.move, mon) : undefined;
        if (result && result.ok) return [true];
        return [undefined, "field action unavailable"];
      }
    }
    return [undefined, "field action unavailable"];
  }

  // Lua: WorldAPI.lua:301 -- same contract as the Gen 1 arm's
  // effectiveEncounters: the effective wild distribution for a map/terrain,
  // composed with any encounter.table wrapper, with no RNG and no live World.
  //
  // Grass is three distributions per map, one per time of day.
  // opts.daytime previews one ("MORN"/"DAY"/"NITE", or "DARK" which reads as
  // NITE, Encounter.grassSlot's fallback); omitted, this resolves the map's
  // actual current time via Clock/Palettes.  The base table goes through
  // Roamers.Swarm.tables first, so an active swarm is reflected; a ROAMING
  // legendary is not (Roamers.checkEncounter overrides a step at roll time).
  effectiveEncounters(mapId: string, terrain: string, opts?: { daytime?: string }): ApiResult<{ chance: number; dist: Record<string, number> }> {
    if (!ENCOUNTER_TERRAIN[terrain]) {
      return [undefined, "invalid terrain: " + tostring(terrain)];
    }
    const game = this.game;
    const data = game ? game.data : undefined;
    const encounters = data ? data.encounters : undefined;
    const save = game ? game.save : undefined;
    let tables = encounters;
    if (encounters && save) {
      tables = Roamers.Swarm.tables(save, encounters, mapId);
    }

    let dist: Record<string, number> = {};
    let chance: number;

    if (terrain === "water") {
      const entry = tables && tables.water ? tables.water[mapId] : undefined;
      chance = ((entry && tonumber(entry.rate)) || 0) / 256;
      if (entry && chance > 0 && entry.slots) {
        let prev = 0;
        Encounter.WATER_SLOT_CHANCES.forEach((cumulative, i) => {
          const slot = entry.slots[i];
          if (slot && slot.species) {
            dist[slot.species] = (dist[slot.species] ?? 0) + (cumulative - prev);
          }
          prev = cumulative;
        });
      }
    } else {
      const entry = tables && tables.grass ? tables.grass[mapId] : undefined;
      let daytime = opts ? opts.daytime : undefined;
      if (daytime && !DAYTIMES[daytime]) {
        return [undefined, "invalid daytime: " + tostring(daytime)];
      }
      if (!daytime) {
        daytime = save ? Palettes.clockDaytime(Clock.hour(save)) : "DAY";
      }
      const key = daytime === "DARK" ? "NITE" : daytime;
      const rate = entry && entry.rates ? (entry.rates[key] ?? entry.rates.DAY) : undefined;
      chance = (tonumber(rate) ?? 0) / 256;
      const slots = entry && entry.slots ? entry.slots[key] : undefined;
      if (slots && chance > 0) {
        let prev = 0;
        Encounter.GRASS_SLOT_CHANCES.forEach((cumulative, i) => {
          const slot = slots[i];
          if (slot && slot.species) {
            dist[slot.species] = (dist[slot.species] ?? 0) + (cumulative - prev);
          }
          prev = cumulative;
        });
      }
    }

    if (Runtime.wantsHook("encounter.table")) {
      // A wrapper that forgets to return anything makes Runtime.call return
      // nothing; keep the pre-hook dist instead of handing back a nil.
      const transformed: unknown = Runtime.call("encounter.table",
        (d: unknown) => d, dist,
        { mapId, terrain, preview: true });
      if (transformed != null && typeof transformed === "object") dist = transformed as Record<string, number>;
    }
    return [{ chance, dist }];
  }

  // Lua: WorldAPI.lua:373 -- the same read-only minimap contract as Gen 1,
  // with Gold's object/event visibility rules supplying the markers.
  mapOverview(): ApiResult<MapOverviewResult> {
    const world = this.overworld();
    if (!world || !world.map) return [undefined, NO_OVERWORLD];
    const map = world.map;
    const def = world.map.def || {};
    const markers: MapMarker[] = [];
    for (const warp of def.warps || []) {
      if (warp == null) break; // ipairs
      markers.push({ kind: "warp", x: warp.x, y: warp.y });
    }
    // a Lua table keyed by the def tables themselves: a Set here
    const visible = new Set<unknown>();
    for (const npc of world.npcs || []) {
      if (npc == null) break;
      if (npc.def) visible.add(npc.def);
    }
    for (const obj of def.objects || []) {
      if (obj == null) break;
      const item = obj.itemball ? obj.itemball.item : undefined;
      if (item != null && item !== false && item !== "0" && item !== 0 && visible.has(obj)) {
        markers.push({ kind: "item", x: obj.x, y: obj.y });
      }
    }
    for (const item of HiddenItems.unfound(def, world.events) || []) {
      if (item == null) break;
      markers.push({ kind: "hidden", x: item.x, y: item.y });
    }
    return [MapOverview.build(map, markers)];
  }

  // Lua: WorldAPI.lua:398 -- opts is accepted for signature parity with the
  // Gen 1 arm; Gold's arrival FX come from the map setup method.
  warpTo(mapId: string, x?: number, y?: number, facing?: string, _opts?: unknown): ApiResult<true> {
    const world = this.overworld();
    if (!world) return [undefined, NO_OVERWORLD];
    if (!(world.maps && world.maps[mapId])) {
      return [undefined, "unknown map: " + tostring(mapId)];
    }
    if (!(x != null && y != null)) return [undefined, "warpTo needs x and y"];
    const ok = world.warpToMapId(mapId, x, y,
      facing || (world.player && world.player.facing) || "down");
    if (!ok) return [undefined, world.status || "warp failed"];
    return [true];
  }

  // Lua: WorldAPI.lua:419 -- Gen 2 has no save.objectToggles: an object's
  // visibility IS its MAPOBJECT_EVENT_FLAG, already persistent and re-read by
  // the next LoadObjectMasks.  appear/disappear additionally take it off the
  // live map.  objRef is the object's 1-based index in the map's object list,
  // or its name when the extracted map carries one.
  toggleObject(mapId: string, objRef: number | string, visible: unknown): ApiResult<true> {
    const world = this.overworld();
    if (!world) return [undefined, NO_OVERWORLD];
    if (!(world.map && world.map.id === mapId)) {
      // the flag is per object, and the object list only resolves for a
      // loaded map, so an off-map toggle has nothing to name
      return [undefined, "map is not active: " + tostring(mapId)];
    }
    const def = world.map.def;
    const objects = def ? def.objects : undefined;
    if (!objects) return [undefined, "map has no objects"];
    let index: number | undefined;
    for (let i = 1; i <= objects.length; i++) {
      const obj = objects[i - 1];
      if (obj == null) break; // ipairs
      if (i === objRef || obj.name === objRef) {
        // def.objects is keyed by the object's own index, and
        // World:objectEntity reads it back as objectId - 1, so the id is that
        // key plus one
        index = obj.index ?? i;
        break;
      }
    }
    if (index == null) {
      return [undefined, "no such object: " + tostring(objRef)];
    }
    const objectId = index + 1;
    const shown = visible != null && visible !== false;
    if (shown) world.appearObject(objectId); else world.disappearObject(objectId);
    Runtime.emit("world.object_toggled", { mapId, objName: objRef, visible: shown });
    return [true];
  }

  // Lua: WorldAPI.lua:458
  setFlag(id: unknown, value: unknown): ApiResult<true> {
    const world = this.overworld();
    if (!world || !world.events) return [undefined, NO_OVERWORLD];
    const [numeric, err] = flagId(id);
    if (numeric == null) return [undefined, err];
    world.events.set(numeric, value != null && value !== false);
    return [true];
  }

  // Lua: WorldAPI.lua:467
  getFlag(id: unknown): ApiResult<any> {
    const world = this.overworld();
    if (!world || !world.events) return [undefined, NO_OVERWORLD];
    const [numeric, err] = flagId(id);
    if (numeric == null) return [undefined, err];
    return [world.events.get(numeric)];
  }

  // Lua: WorldAPI.lua:477 -- active map only, same contract as the Gen 1 arm:
  // this mutates the loaded block data and rebuilds the view.  `block` is a
  // block id.
  replaceBlock(bx: number, by: number, block: number): ApiResult<true> {
    const world = this.overworld();
    if (!world || !world.map) return [undefined, NO_OVERWORLD];
    world.changeBlock(bx, by, block);
    return [true];
  }

  // Lua: WorldAPI.lua:489 -- objDef uses the same shape as an extracted map's
  // objects list.  Runtime objects are not serialized; a mod respawns them on
  // map.entered.  World:addRuntimeObject already answers a TUPLE
  // [npcId | undefined, reason?].
  spawnNpc(mapId: string, objDef: unknown): ApiResult<string> {
    const world = this.overworld();
    if (!world) return [undefined, NO_OVERWORLD];
    if (objDef == null || typeof objDef !== "object") return [undefined, "objDef must be a table"];
    const copy: Record<string, unknown> = {};
    for (const k of Object.keys(objDef)) copy[k] = (objDef as Record<string, unknown>)[k];
    return world.addRuntimeObject(mapId, copy, this.modId);
  }

  // Lua: WorldAPI.lua:498 -- World:removeRuntimeObject answers a TUPLE.
  removeNpc(npcId: string): ApiResult<true> {
    const world = this.overworld();
    if (!world) return [undefined, NO_OVERWORLD];
    return world.removeRuntimeObject(npcId, this.modId);
  }

  // Lua: WorldAPI.lua:542
  npc(mapId: string, indexOrName: number | string): ApiResult<Handle> {
    const world = this.overworld();
    if (!world) return [undefined, NO_OVERWORLD];
    if (world.map && world.map.id !== mapId) return [undefined, "map is not active"];
    for (const npc of world.npcs || []) {
      if (npc == null) break; // ipairs
      const def = npc.def;
      if (def && (def.index === indexOrName || def.name === indexOrName)) {
        return [new Handle(world, npc, (def.index ?? 0) + 1)];
      }
    }
    return [undefined, "no such object: " + tostring(indexOrName)];
  }

  // Lua: WorldAPI.lua:621 -- rows run in order, each one resuming the next
  // from its own completion callback, so a battle or a text box blocks the
  // queue the way it blocks the Gen 1 runner's coroutine.  One queue at a
  // time, for the reason Handle:scriptMove refuses a second movement.
  queueScript(rows: unknown, extra?: { onDone?: (ok: boolean) => void }): ApiResult<true> {
    const world = this.overworld();
    if (!world) return [undefined, NO_OVERWORLD];
    if (rows == null || typeof rows !== "object") {
      return [undefined, "queueScript wants a row list"];
    }
    if (this.queue) return [undefined, "a script is already running"];
    const list = rows as any[];
    for (let i = 1; i <= list.length; i++) {
      const row = list[i - 1];
      if (row == null) break; // ipairs
      const name = row != null && typeof row === "object" ? row[0] : undefined;
      if (!(name != null && Object.prototype.hasOwnProperty.call(VERBS, name))) {
        return [undefined, format("unsupported script command in Gen 2: %s (row %d)",
          tostring(name), i)];
      }
    }
    this.queue = true;
    let pc = 0;
    const finish = (err: string | undefined): void => {
      this.queue = undefined;
      if (err != null) {
        Logger.warn("[%s] queueScript stopped: %s", tostring(this.modId), err);
      }
      if (extra && extra.onDone) extra.onDone(err == null);
    };
    const step = (): void => {
      pc = pc + 1;
      const row = list[pc - 1];
      if (!row) return finish(undefined);
      const [ok, err] = VERBS[row[0]]!(this, row, () => step());
      if (!ok) finish(err || "row failed");
    };
    step();
    return [true];
  }

  // Lua: WorldAPI.lua:658 -- Gold's maps come from one table loaded at
  // World:load, so there is no per-map cache to drop.  Reloading the active
  // map is the part that carries meaning, and reloadMapBadWarp is the cart's
  // own "load this map again where you stand" (MAPSETUP_BADWARP).
  invalidateMap(mapId: string): ApiResult<true> {
    const world = this.overworld();
    if (!world) return [undefined, NO_OVERWORLD];
    if (!(world.map && world.map.id === mapId)) return [true];
    try {
      world.reloadMapBadWarp();
    } catch (e) {
      const err = e instanceof Error ? e.message : tostring(e);
      Logger.warn("[%s] invalidateMap %s failed: %s", tostring(this.modId),
        tostring(mapId), err);
      return [undefined, err];
    }
    Runtime.emit("map.reloaded", { mapId, reason: "invalidate" });
    return [true];
  }
}

export default WorldAPI;
