// Port of gen1recomp src/core/game3/save_sections.lua (GPLv3 + additional terms; see LICENSE.md).
// Registered save sections: each copies a set of session fields into the
// save table and back, plus an optional New Game initialiser. A game's
// profile row lists the sections it uses (FireRed's list is empty; the
// built-in ones below are Emerald's).

import { ipairs, len, type LuaTable } from "../platform/lt.ts";
import { tostring } from "../../../import/gen3/lua.ts";
import { Profile } from "./profile.ts";
import { Rtc } from "./rtc.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Session = Record<string, any>;

export interface SaveSectionDef {
  fields?: LuaTable | (() => LuaTable);
  newGame?: (session: Session) => void;
  export?: (session: Session, out: Session) => void;
  restore?: (save: Session, session: Session) => void;
  [k: string]: unknown;
}

const defs: Record<string, SaveSectionDef | undefined> = {};

// Lua: save_sections.lua:5
function copy(v: any): any {
  if (v == null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    const out: any[] = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] == null ? null : copy(v[i]);
    return out;
  }
  const out: Record<string, any> = {};
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (x != null) out[k] = copy(x);
  }
  return out;
}

// Lua: save_sections.lua:42
function resolve(entry: string | { name: string; module?: string }): [string, SaveSectionDef] {
  let name: string = entry as string;
  let module: string | undefined;
  if (entry != null && typeof entry === "object") {
    name = entry.name;
    module = entry.module;
  }
  if (!defs[name] && module) {
    // NOT FAITHFUL: no dynamic require; a section's module must be imported
    // (and so registered) by its port. FireRed's profile lists no sections.
    throw new Error("save section '" + tostring(name) + "' module " + module + " is not loaded (Emerald only)");
  }
  const def = defs[name];
  if (!def) throw new Error("save section '" + tostring(name) + "' is not registered");
  return [name, def];
}

export const SaveSections = {
  // Lua: save_sections.lua:12
  register(name: string, def: SaveSectionDef): SaveSectionDef {
    if (!(typeof name === "string" && name !== "")) throw new Error("save section needs a name");
    if (!(def != null && typeof def === "object")) throw new Error("save section " + name + " needs a definition");
    defs[name] = def;
    return def;
  },

  // Lua: save_sections.lua:19
  unregister(name: string): void {
    delete defs[name];
  },

  // Lua: save_sections.lua:23
  fields(list: LuaTable | (() => LuaTable), newGame?: (session: Session) => void): SaveSectionDef {
    return {
      fields: list,
      newGame,
      export: (session: Session, out: Session): void => {
        const names = typeof list === "function" ? list() : list;
        for (const [, f] of ipairs<string>(names)) {
          if (session[f] != null) out[f] = copy(session[f]);
        }
      },
      restore: (save: Session, session: Session): void => {
        const names = typeof list === "function" ? list() : list;
        for (const [, f] of ipairs<string>(names)) {
          if (save[f] != null) session[f] = copy(save[f]);
        }
      },
    };
  },

  // Lua: save_sections.lua:51
  of(version?: string): LuaTable {
    const save = Profile.of(version).save;
    const out: LuaTable = [null];
    for (const [, entry] of ipairs(save && save.sections || {})) {
      const [name, def] = resolve(entry);
      out[len(out) + 1] = { name, def };
    }
    return out;
  },

  // Lua: save_sections.lua:62
  newGame(session: Session, version?: string): void {
    for (const [, s] of ipairs<{ name: string; def: SaveSectionDef }>(SaveSections.of(version))) {
      if (s.def.newGame) s.def.newGame(session);
    }
  },

  // Lua: save_sections.lua:68
  export(session: Session, out: Session, version?: string): Session {
    for (const [, s] of ipairs<{ name: string; def: SaveSectionDef }>(SaveSections.of(version))) {
      if (s.def.export) s.def.export(session, out);
    }
    return out;
  },

  // Lua: save_sections.lua:75
  restore(save: Session, session: Session, version?: string): Session {
    for (const [, s] of ipairs<{ name: string; def: SaveSectionDef }>(SaveSections.of(version))) {
      if (s.def.restore) s.def.restore(save, session);
    }
    return session;
  },
};

// Lua: save_sections.lua:83
// pokeemerald/src/new_game.c:152
SaveSections.register("rtc", SaveSections.fields(() => {
  return Rtc.SAVE_FIELDS;
}, (session: Session) => {
  session.localTimeOffset = Rtc.newTime(0, 0, 0, 0);
  session.lastBerryTreeUpdate = Rtc.newTime(0, 0, 0, 0);
  session.rtcSkew = 0;
}));

// Lua: save_sections.lua:93
// pokeemerald/src/new_game.c:155
SaveSections.register("encryptionKey", SaveSections.fields([null, "encryptionKey"], (session: Session) => {
  session.encryptionKey = 0;
}));

// Lua: save_sections.lua:98
// pokeemerald/include/global.h:1023
SaveSections.register("berryTrees", SaveSections.fields([null, "berryTrees"]));

// Lua: save_sections.lua:101
// pokeemerald/include/global.h:1025
SaveSections.register("decorations", SaveSections.fields([null, "playerRoomDecorations", "decorationInventory"]));

export default SaveSections;
