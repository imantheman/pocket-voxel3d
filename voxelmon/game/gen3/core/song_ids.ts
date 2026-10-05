// Port of gen1recomp src/core/game3/song_ids.lua (GPLv3 + additional terms; see LICENSE.md).
// Song ids by name (MUS_*, SE_*, PH_*), copied onto the module from the
// active version's constants (Song.select), plus name/number resolution.

import { Constants } from "./constants.ts";
import { find, gsub } from "../platform/lpattern.ts";
import { tonumber, tostring } from "../../../import/gen3/lua.ts";
import { pairs } from "../platform/lt.ts";

const byGame: Record<string, Record<string, number>> = {};

// Lua: song_ids.lua:7
function isSongName(k: unknown): boolean {
  return typeof k === "string" && (find(k, "^MUS_") || find(k, "^SE_") || find(k, "^PH_")) !== undefined;
}

export interface SongModule {
  [name: string]: any;
  byName: SongModule;
  current?: string;
  forVersion(id: string): Record<string, number>;
  select(id: string): SongModule;
  resolve(id: unknown): number | undefined;
  nameOf(id: number, game?: string): string | undefined;
}

export const Song: SongModule = {
  byName: undefined as unknown as SongModule,

  // Lua: song_ids.lua:11
  forVersion(id: string): Record<string, number> {
    const game = Constants.gameKey(id);
    let t = byGame[game];
    if (!t) {
      t = {};
      for (const [k, v] of pairs(Constants.of(game).songs.byName)) {
        if (isSongName(k)) t[k as string] = v as number;
      }
      byGame[game] = t;
    }
    return t;
  },

  // Lua: song_ids.lua:24
  select(id: string): SongModule {
    const t = Song.forVersion(id);
    for (const [k] of pairs(Song)) {
      if (isSongName(k) && t[k as string] == null) delete Song[k as string];
    }
    for (const [k, v] of pairs(t)) Song[k as string] = v;
    Song.current = Constants.gameKey(id);
    return Song;
  },

  // Lua: song_ids.lua:34
  resolve(id: unknown): number | undefined {
    if (id == null) return undefined;
    if (typeof id === "number") return id;
    const s = gsub(gsub(tostring(id), "^%s+", "")[0], "%s+$", "")[0];
    const n = tonumber(s);
    if (n !== undefined) return n;
    const hit = Song[s] ?? Song[s.toUpperCase()];
    return typeof hit === "number" ? hit : undefined;
  },

  // Lua: song_ids.lua:43
  nameOf(id: number, game?: string): string | undefined {
    const rev = Constants.of(game ?? Song.current).songs.byId;
    return (rev.MUS_ && rev.MUS_[id]) || (rev.SE_ && rev.SE_[id]) || (rev.PH_ && rev.PH_[id]) || undefined;
  },
};

// Lua: song_ids.lua:48
Song.byName = Song;
Song.select("firered");

export default Song;
