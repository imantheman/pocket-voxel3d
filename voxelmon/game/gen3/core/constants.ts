// Port of gen1recomp src/core/game3/constants.lua (GPLv3 + additional terms; see LICENSE.md).
// Per-game pret constant tables (byName / byId per kind). The Lua loads each
// kind lazily with require("src.core.game3.constants.<game>.<kind>"); here
// FireRed's converted tables are imported statically (LeafGreen shares them).
// NOT FAITHFUL: Emerald's tables are not converted (out of scope); reading a
// kind of the "emerald" set throws, where the Lua would load it.

import { GameVersion } from "../../../import/gen3/game_version.ts";
import { Profile } from "./profile.ts";
import abilities from "./constants/firered/abilities.ts";
import battle from "./constants/firered/battle.ts";
import battle_string_ids from "./constants/firered/battle_string_ids.ts";
import decorations from "./constants/firered/decorations.ts";
import easy_chat from "./constants/firered/easy_chat.ts";
import field_effects from "./constants/firered/field_effects.ts";
import flags from "./constants/firered/flags.ts";
import items from "./constants/firered/items.ts";
import map_groups from "./constants/firered/map_groups.ts";
import metatile_behaviors from "./constants/firered/metatile_behaviors.ts";
import moves from "./constants/firered/moves.ts";
import movement from "./constants/firered/movement.ts";
import script_cmds from "./constants/firered/script_cmds.ts";
import songs from "./constants/firered/songs.ts";
import specials from "./constants/firered/specials.ts";
import species from "./constants/firered/species.ts";
import trainer_classes from "./constants/firered/trainer_classes.ts";
import trainers from "./constants/firered/trainers.ts";
import vars from "./constants/firered/vars.ts";
import weather from "./constants/firered/weather.ts";
import event_objects from "./constants/firered/event_objects.ts";
import metatile_labels from "./constants/firered/metatile_labels.ts";
import region_map_sections from "./constants/firered/region_map_sections.ts";
import heal_locations from "./constants/firered/heal_locations.ts";

/** One kind's converted table (byName, byId, and any extra fields). */
export type ConstKind = Record<string, any>;

// The converted per-game tables (the Lua's constants/<game>/<kind>.lua modules).
const TABLES: Record<string, Record<string, ConstKind>> = {
  firered: {
    abilities, battle, battle_string_ids, decorations, easy_chat, field_effects,
    flags, items, map_groups, metatile_behaviors, moves, movement, script_cmds,
    songs, specials, species, trainer_classes, trainers, vars, weather,
    event_objects, metatile_labels, region_map_sections, heal_locations,
  } as Record<string, ConstKind>,
};

const GAMES: Record<string, string> = {
  firered: "firered",
  leafgreen: "firered",
  emerald: "emerald",
};

const KINDS = [
  "abilities", "battle", "battle_string_ids", "decorations", "easy_chat", "field_effects",
  "flags", "items", "map_groups", "metatile_behaviors", "moves", "movement", "script_cmds",
  "songs", "specials", "species", "trainer_classes", "trainers", "vars", "weather",
  "event_objects", "metatile_labels", "region_map_sections", "heal_locations",
];

const KIND_SET: Record<string, boolean> = {};
for (const k of KINDS) KIND_SET[k] = true;

/** A game's constant set: Methods plus one property per kind (the Lua's SetMT). */
export interface ConstantSet {
  game: string;
  raw(kind: string): ConstKind | undefined;
  id(kind: string, name: string): any;
  require(kind: string, name: string): any;
  name(kind: string, id: any, prefix?: string): any;
  special(name: string): any;
  specialName(id: any): any;
  opcode(op: any): any;
  flag(name: string): any;
  var(name: string): any;
  song(name: string): any;
  map(name: string): any;
  [kind: string]: any;
}

// Lua: constants.lua:31-93 (Methods; `self` is the set)
const Methods: Record<string, (this: ConstantSet, ...args: any[]) => any> = {
  // Lua: constants.lua:33
  raw(kind: string) {
    return this[kind];
  },
  // Lua: constants.lua:37
  id(kind: string, name: string) {
    return this[kind].byName[name];
  },
  // Lua: constants.lua:41
  require(kind: string, name: string) {
    const v = this.id(kind, name);
    if (v === undefined || v === null) {
      throw new Error(`game3 constants: ${this.game} has no ${kind} ${String(name)}`);
    }
    return v;
  },
  // Lua: constants.lua:49
  name(kind: string, id: any, prefix?: string) {
    const t = this[kind];
    if (kind === "specials") return t.byId[id];
    if (kind === "script_cmds") {
      const e = t.byId[id];
      return e ? e.name : undefined;
    }
    const rev = t.byId;
    if (!rev) return undefined;
    if (prefix !== undefined && prefix !== null) {
      return rev[prefix] ? rev[prefix][id] : undefined;
    }
    // NOT FAITHFUL (order): Lua pairs() order over the prefix groups; here
    // insertion order. Only matters when two groups share an id.
    for (const k of Object.keys(rev)) {
      const sub = rev[k];
      if (typeof sub === "object" && sub !== null && sub[id] !== undefined && sub[id] !== null) return sub[id];
    }
    return undefined;
  },
  // Lua: constants.lua:67
  special(name: string) {
    return this.specials.byName[name];
  },
  // Lua: constants.lua:71
  specialName(id: any) {
    return this.specials.byId[id];
  },
  // Lua: constants.lua:75
  opcode(op: any) {
    return this.script_cmds.byId[op];
  },
  // Lua: constants.lua:79
  flag(name: string) {
    return this.flags.byName[name];
  },
  // Lua: constants.lua:83
  var(name: string) {
    return this.vars.byName[name];
  },
  // Lua: constants.lua:87
  song(name: string) {
    return this.songs.byName[name];
  },
  // Lua: constants.lua:91
  map(name: string) {
    return this.map_groups.byName[name];
  },
};

const sets: Record<string, ConstantSet> = {};

// Lua: constants.lua:95 SetMT.__index
function newSet(game: string): ConstantSet {
  const own: Record<string, any> = { game };
  const proxy: ConstantSet = new Proxy(own, {
    get(target, k) {
      if (typeof k !== "string") return undefined;
      if (k in target) return target[k];
      const m = Methods[k];
      if (m) return m;
      if (!KIND_SET[k]) return undefined;
      const tables = TABLES[target.game as string];
      if (!tables) throw new Error(`game3 constants: tables for ${String(target.game)} are not ported`);
      const t = tables[k];
      target[k] = t;
      return t;
    },
  }) as ConstantSet;
  return proxy;
}

export const Constants = {
  GAMES,
  KINDS,

  // Lua: constants.lua:23
  gameKey(id: string | undefined): string {
    const key = id !== undefined ? GAMES[id] : undefined;
    if (!key) throw new Error("game3 constants: no tables for game " + String(id));
    return key;
  },

  // Lua: constants.lua:106
  of(gameOrVersion: string | undefined): ConstantSet {
    const key = Constants.gameKey(gameOrVersion);
    let s = sets[key];
    if (!s) {
      s = newSet(key);
      sets[key] = s;
    }
    return s;
  },

  // Lua: constants.lua:116
  versionOf(session?: any): string {
    if (session !== null && typeof session === "object" && typeof session.version === "string") {
      return session.version;
    }
    return Profile.resolveId(GameVersion.get());
  },

  // Lua: constants.lua:123
  active(session?: any): ConstantSet {
    return Constants.of(Constants.versionOf(session));
  },
};

export default Constants;
