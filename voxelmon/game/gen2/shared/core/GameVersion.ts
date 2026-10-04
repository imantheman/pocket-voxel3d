// The active game version: a port of gen1recomp src/core/GameVersion.lua
// (bdfac727) reduced to the versions this engine boots: Gold, Silver and
// Crystal. The Gen 1 rows are left out; the API is the Lua's.

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
  /** Accepted ROM revisions (GameVersion.lua:98). */
  revisions?: { sha1: string; label: string }[];
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
  // GameVersion.lua:87
  crystal: {
    id: "crystal",
    label: "Crystal",
    displayName: "Pokemon Crystal",
    sha1: "f4cd194bdee0d04ca4eac29e09b8e4e9d818c133",
    cachePrefix: "crystal/",
    saveSuffix: "_crystal",
    generation: 2,
    engine: "crystal",
    revisions: [
      { sha1: "f4cd194bdee0d04ca4eac29e09b8e4e9d818c133", label: "1.0" },
      { sha1: "f2f52230b536214ef7c9924f483392993e226cfb", label: "1.1" },
    ],
    fixes: {
      // pokegold/docs/bugs_and_glitches.md:61
      luckyNumberBoxes: true,
      // pokegold/docs/bugs_and_glitches.md:88
      surfOntoNpc: true,
      // pokecrystal/engine/battle/effect_commands.asm:2614
      reflectOverflow: true,
      // pokecrystal/home/map.asm:1638
      sideWallArms: true,
    },
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
  isCrystal: (): boolean => GameVersion.current === "crystal",
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
  // GameVersion.lua:203-229
  revisions(id?: string): { sha1: string; label?: string }[] {
    const info = GameVersion.info(id);
    return info.revisions ?? [{ sha1: info.sha1 }];
  },
  acceptsSha1(id: string, sha1: string): boolean {
    return GameVersion.revisions(id).some((r) => r.sha1 === sha1);
  },
  forSha1(sha1: string): string | undefined {
    return Object.keys(VERSIONS).find((id) => GameVersion.acceptsSha1(id, sha1));
  },
};

export default GameVersion;
