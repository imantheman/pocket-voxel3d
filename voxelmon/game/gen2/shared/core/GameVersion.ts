// The active game version: a port of gen1recomp src/core/GameVersion.lua
// (bdfac727) reduced to the versions this build can boot. The Gold engine
// only ever runs Gold (Silver shares the engine and would slot in beside it),
// so the Gen 1 rows are left out; the API is the Lua's.

export interface VersionInfo {
  id: string;
  label: string;
  displayName: string;
  sha1: string;
  saveSuffix: string;
  cachePrefix: string;
  generation: number;
  engine: string;
  /** Cart bugs this version fixed, by fix name (GameVersion.lua:180). */
  fixes?: Record<string, boolean>;
}

const NO_FIXES: Record<string, boolean> = Object.freeze({}) as Record<string, boolean>;

const VERSIONS: Record<string, VersionInfo> = {
  // GameVersion.lua:60
  gold: {
    id: "gold",
    label: "Gold",
    displayName: "Pokemon Gold",
    sha1: "d8b8a3600a465308c9953dfa04f0081c05bdcb94",
    cachePrefix: "gold/",
    saveSuffix: "_gold",
    generation: 2,
    engine: "gs",
  },
  // GameVersion.lua:75
  silver: {
    id: "silver",
    label: "Silver",
    displayName: "Pokemon Silver",
    sha1: "49b163f7e57702bc939d642a18f591de55d92dae",
    cachePrefix: "silver/",
    saveSuffix: "_silver",
    generation: 2,
    engine: "gs",
  },
};

export const GameVersion = {
  VERSIONS,
  current: "gold",

  set(id: string): string {
    GameVersion.current = VERSIONS[id] ? id : "gold";
    return GameVersion.current;
  },
  get(): string {
    return GameVersion.current;
  },
  isBlue: (): boolean => false,
  isYellow: (): boolean => false,
  isGold: (): boolean => GameVersion.current === "gold",
  isSilver: (): boolean => GameVersion.current === "silver",
  info(id?: string): VersionInfo {
    return VERSIONS[id ?? GameVersion.current] ?? VERSIONS.gold!;
  },
  generation(id?: string): number {
    return GameVersion.info(id).generation;
  },
  engine(id?: string): string {
    return GameVersion.info(id).engine;
  },
  fixes(id?: string): Record<string, boolean> {
    return GameVersion.info(id).fixes ?? NO_FIXES;
  },
  saveSuffix(id?: string): string {
    return GameVersion.info(id).saveSuffix;
  },
  cachePrefix(id?: string): string {
    return GameVersion.info(id).cachePrefix;
  },
};

export default GameVersion;
