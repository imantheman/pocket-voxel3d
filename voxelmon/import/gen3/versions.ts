// Port of gen1recomp src/import/gba/versions.lua + versions_game.lua (GPLv3 +
// additional terms; see LICENSE.md). The active Gen 3 version table: a
// proxy onto the selected game's module (FireRed and LeafGreen share
// versions_frlg; Emerald is not ported).

import { GameVersion } from "./game_version.ts";
import { VersionsFrlg } from "./versions_frlg.ts";

// Lua: versions_game.lua:5
const GAMES: Record<string, Record<string, any>> = { firered: VersionsFrlg, leafgreen: VersionsFrlg };
const FALLBACK = "firered";

export const VersionsGame = {
  GAMES,
  FALLBACK,
  // Lua: versions_game.lua:27
  game(id?: string): Record<string, any> {
    if (typeof id !== "string" || id === "") {
      const active = GameVersion.get();
      id = GameVersion.generation(active) === 3 ? active : FALLBACK;
    }
    const mod = GAMES[id];
    if (!mod) throw new Error(`versions_game: no version table registered for '${id}'`);
    return mod;
  },
};
VersionsFrlg.game = VersionsGame.game;

const DEFAULT = "firered";
let active = DEFAULT;
let bound: Record<string, any> = VersionsFrlg;

function isGame3(id: string): boolean {
  const info = GameVersion.VERSIONS[id];
  return info !== undefined && info.generation === 3;
}

// Lua: versions.lua:16
function resolve(identity: unknown): string {
  if (typeof identity !== "string" || identity === "") {
    throw new Error(`versions: select needs a gen 3 version id or ROM sha1, got ${String(identity)}`);
  }
  if (isGame3(identity)) return identity;
  const key = identity.toLowerCase().replace(/\s+/g, "");
  let id = GameVersion.forSha1(key);
  if (!id) {
    const frlg = VersionsGame.game(DEFAULT);
    const sha = frlg.identitySha1 && frlg.identitySha1(key);
    id = sha ? GameVersion.forSha1(sha) : undefined;
  }
  if (!id || !isGame3(id)) throw new Error(`versions: unknown gen 3 identity ${identity}`);
  return id;
}

/**
 * The active version table. Property reads go to the selected game's module
 * (the Lua's __index), writes too (__newindex).
 */
export const Versions: Record<string, any> = new Proxy({} as Record<string, any>, {
  get(_t, k: string) {
    if (k === "select") return select;
    if (k === "forGame" || k === "for") return forGame;
    if (k === "active") return () => active;
    if (k === "module") return () => bound;
    return bound[k];
  },
  set(_t, k: string, v) {
    bound[k] = v;
    return true;
  },
  has(_t, k: string) {
    return k in bound;
  },
});

// Lua: versions.lua:42
function select(identity: string): string {
  const id = resolve(identity);
  bound = VersionsGame.game(id);
  active = id;
  if (typeof bound.select === "function") bound.select(isGame3(identity) ? id : identity);
  return id;
}

// Lua: versions.lua:51
function forGame(id: string): Record<string, any> {
  if (!isGame3(id)) throw new Error(`versions: not a gen 3 version id: ${id}`);
  return VersionsGame.game(id);
}

export default Versions;
