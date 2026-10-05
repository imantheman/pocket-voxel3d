// Port of gen1recomp src/core/game3/song_fields.lua (GPLv3 + additional terms; see LICENSE.md).
// Gives a table read-through access to the song ids: t.MUS_X / t.SE_X /
// t.PH_X fall back to Song.MUS_X when t has no such field.
//
// Lua sets (or chains onto) t's metatable __index, in place (callers ignore
// the return: `require("src.core.game3.song_fields")(SlotMachineUi)`). The
// JS analogue of __index is the prototype chain: t's prototype becomes a
// Proxy over its previous prototype (the "prev" __index) whose reads of a
// song-name key go to Song. Own fields of t win, as in Lua.

import { Song } from "./song_ids.ts";
import { find } from "../platform/lpattern.ts";

// Lua: song_fields.lua:3
function isSongName(k: unknown): boolean {
  return typeof k === "string" && (find(k, "^MUS_") || find(k, "^SE_") || find(k, "^PH_")) !== undefined;
}

// Lua: song_fields.lua:7
function lookup(k: string): unknown {
  if (isSongName(k)) return Song[k];
  return undefined;
}

// Lua: song_fields.lua:12
export function song_fields<T extends object>(t: T): T {
  const prev = Object.getPrototypeOf(t) ?? Object.prototype;
  Object.setPrototypeOf(t, new Proxy(prev, {
    get(target, k, recv) {
      const v = Reflect.get(target, k, recv);
      if (v !== undefined || typeof k !== "string") return v;
      return lookup(k);
    },
  }));
  return t;
}

export default song_fields;
