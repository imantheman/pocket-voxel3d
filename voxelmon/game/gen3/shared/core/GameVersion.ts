// Port of gen1recomp src/core/GameVersion.lua (GPLv3 + additional terms; see LICENSE.md).
// Which game this process is running, and everything that differs by
// version (accepted ROM hash, cache prefix, save suffix, generation...).
//
// One process-global, shared with the importer: `current` reads and writes
// voxelmon/import/gen3/game_version.ts's `current`, so the runtime and the
// importer modules it calls (Versions, Profile, Constants) always agree.
// NOT FAITHFUL: Brian's process default is "red" (set to the launcher's
// column at boot); this build only ever runs FireRed/LeafGreen, so the
// default is the importer's "firered".

import { GameVersion as ImportGameVersion } from "../../../../import/gen3/game_version.ts";
import { ipairs, pairs } from "../../platform/lt.ts";

export interface Revision { sha1: string; label?: string }
export interface VersionRow {
  id: string;
  label: string;
  displayName: string;
  launcherName: string;
  beta?: boolean;
  sha1: string;
  manifest: string;
  cachePrefix: string;
  saveSuffix: string;
  generation?: number;
  engine?: string;
  layout?: string;
  gameCode?: number;
  cartShape?: string;
  cartShell?: string;
  cartLabel?: string;
  revisions?: (Revision | null)[];
  fixes?: Record<string, boolean>;
}

// Lua: GameVersion.lua:22
const VERSIONS: Record<string, VersionRow> = {
  red: {
    id: "red",
    label: "Red",
    displayName: "Pokemon Red",
    launcherName: "Red",
    sha1: "ea9bcae617fdf159b045185467ae58b2e4a48b9a",
    manifest: "tools/rom_manifest.json",
    cachePrefix: "red/",
    saveSuffix: "",
    engine: "gen1",
  },
  blue: {
    id: "blue",
    label: "Blue",
    displayName: "Pokemon Blue",
    launcherName: "Blue",
    sha1: "d7037c83e1ae5b39bde3c30787637ba1d4c48ce2",
    manifest: "tools/rom_manifest_blue.json",
    cachePrefix: "blue/",
    saveSuffix: "_blue",
    engine: "gen1",
  },
  yellow: {
    id: "yellow",
    label: "Yellow",
    displayName: "Pokemon Yellow",
    launcherName: "Yellow",
    sha1: "cc7d03262ebfaf2f06772c1a480c7d9d5f4a38e1",
    manifest: "tools/rom_manifest_yellow.json",
    cachePrefix: "yellow/",
    saveSuffix: "_yellow",
    engine: "gen1",
  },
  gold: {
    id: "gold",
    label: "Gold",
    displayName: "Pokemon Gold",
    launcherName: "Gold",
    sha1: "d8b8a3600a465308c9953dfa04f0081c05bdcb94",
    manifest: "tools/rom_manifest_gold.json",
    cachePrefix: "gold/",
    saveSuffix: "_gold",
    generation: 2,
    engine: "gs",
  },
  silver: {
    id: "silver",
    label: "Silver",
    displayName: "Pokemon Silver",
    launcherName: "Silver",
    sha1: "49b163f7e57702bc939d642a18f591de55d92dae",
    manifest: "tools/rom_manifest_silver.json",
    cachePrefix: "silver/",
    saveSuffix: "_silver",
    generation: 2,
    engine: "gs",
  },
  crystal: {
    id: "crystal",
    label: "Crystal",
    displayName: "Pokemon Crystal",
    launcherName: "Crystal",
    sha1: "f4cd194bdee0d04ca4eac29e09b8e4e9d818c133",
    manifest: "tools/rom_manifest_crystal.json",
    cachePrefix: "crystal/",
    saveSuffix: "_crystal",
    generation: 2,
    engine: "crystal",
    revisions: [null,
      { sha1: "f4cd194bdee0d04ca4eac29e09b8e4e9d818c133", label: "1.0" },
      { sha1: "f2f52230b536214ef7c9924f483392993e226cfb", label: "1.1" },
    ],
    fixes: {
      luckyNumberBoxes: true,
      surfOntoNpc: true,
      reflectOverflow: true,
      sideWallArms: true,
    },
  },
  firered: {
    id: "firered",
    label: "FireRed",
    displayName: "Pokemon FireRed",
    launcherName: "Fire Red",
    beta: true,
    sha1: "41cb23d8dccc8ebd7c649cd8fbb58eeace6e2fdc",
    revisions: [null,
      { sha1: "41cb23d8dccc8ebd7c649cd8fbb58eeace6e2fdc", label: "1.0" },
      { sha1: "dd5945db9b930750cb39d00c84da8571feebf417", label: "1.1" },
    ],
    manifest: "tools/rom_manifest_firered.json",
    cachePrefix: "firered/",
    saveSuffix: "_firered",
    generation: 3,
    engine: "game3",
    layout: "frlg",
    gameCode: 4,
    cartShape: "gba",
    cartShell: "#e64110",
    cartLabel: "assets/labels/firered.png",
  },
  leafgreen: {
    id: "leafgreen", label: "LeafGreen", displayName: "Pokemon LeafGreen",
    launcherName: "Leaf Green", beta: true,
    sha1: "574fa542ffebb14be69902d1d36f1ec0a4afd71e",
    revisions: [null,
      { sha1: "574fa542ffebb14be69902d1d36f1ec0a4afd71e", label: "1.0" },
      { sha1: "7862c67bdecbe21d1d69ce082ce34327e1c6ed5e", label: "1.1" },
    ],
    manifest: "tools/rom_manifest_leafgreen.json",
    cachePrefix: "leafgreen/", saveSuffix: "_leafgreen",
    generation: 3, engine: "game3", layout: "frlg", gameCode: 5,
    cartShape: "gba", cartShell: "#26a24e",
    cartLabel: "assets/labels/leafgreen.png",
  },
  emerald: {
    id: "emerald", label: "Emerald", displayName: "Pokemon Emerald",
    launcherName: "Emerald", beta: true,
    sha1: "f3ae088181bf583e55daf962a92bb46f4f1d07b7",
    revisions: [null,
      { sha1: "f3ae088181bf583e55daf962a92bb46f4f1d07b7", label: "1.0" },
    ],
    manifest: "tools/rom_manifest_emerald.json",
    cachePrefix: "emerald/", saveSuffix: "_emerald",
    generation: 3, engine: "game3", layout: "rse", gameCode: 3,
    cartShape: "gba", cartShell: "#1f9e6e",
    cartLabel: "assets/labels/emerald.png",
  },
};

const NO_FIXES: Record<string, boolean> = {};

export const GameVersion = {
  VERSIONS,
  // Lua: GameVersion.lua:169
  ORDER: [null, "red", "blue", "yellow", "gold", "silver", "crystal", "firered", "leafgreen", "emerald"] as (string | null)[],

  /** The active version id (shared with the importer's GameVersion). */
  get current(): string { return ImportGameVersion.current; },
  set current(id: string) { ImportGameVersion.current = id; },

  // Lua: GameVersion.lua:173
  set(id: string): string {
    GameVersion.current = VERSIONS[id] ? id : "red";
    return GameVersion.current;
  },

  // Lua: GameVersion.lua:178
  get(): string {
    return GameVersion.current;
  },

  // Lua: GameVersion.lua:182
  isBlue(): boolean { return GameVersion.current === "blue"; },
  // Lua: GameVersion.lua:186
  isYellow(): boolean { return GameVersion.current === "yellow"; },
  // Lua: GameVersion.lua:190
  isGold(): boolean { return GameVersion.current === "gold"; },

  // Lua: GameVersion.lua:200
  generation(id?: string): number {
    return GameVersion.info(id)!.generation ?? 1;
  },

  // Lua: GameVersion.lua:205
  engine(id?: string): string {
    return GameVersion.info(id)!.engine ?? "gen1";
  },

  // Lua: GameVersion.lua:209
  layout(id?: string): string | undefined {
    const info = GameVersion.info(id);
    return info ? info.layout : undefined;
  },

  // Lua: GameVersion.lua:214
  gameCode(id?: string): number | undefined {
    const info = GameVersion.info(id);
    return info ? info.gameCode : undefined;
  },

  // Lua: GameVersion.lua:220
  cartShape(id?: string): string {
    const info = GameVersion.info(id);
    return info && info.cartShape === "gba" ? "gba" : "gb";
  },

  // Lua: GameVersion.lua:226
  fixes(id?: string): Record<string, boolean> {
    const info = GameVersion.info(id);
    return (info && info.fixes) || NO_FIXES;
  },

  // Lua: GameVersion.lua:232
  info(id?: string | null): VersionRow | undefined {
    return VERSIONS[id || GameVersion.current];
  },

  // Lua: GameVersion.lua:236
  saveSuffix(id?: string): string {
    return GameVersion.info(id)!.saveSuffix;
  },

  // Lua: GameVersion.lua:240
  cachePrefix(id?: string): string {
    return GameVersion.info(id)!.cachePrefix;
  },

  // Lua: GameVersion.lua:244
  revisions(id?: string): (Revision | null)[] {
    const info = GameVersion.info(id)!;
    return info.revisions || [null, { sha1: info.sha1 }];
  },

  // Lua: GameVersion.lua:249
  acceptsSha1(id: string, sha1: string): boolean {
    for (const [, revision] of ipairs<Revision>(GameVersion.revisions(id))) {
      if (revision.sha1 === sha1) return true;
    }
    return false;
  },

  // Lua: GameVersion.lua:256
  revisionLabel(id: string, sha1: string): string | undefined {
    for (const [, revision] of ipairs<Revision>(GameVersion.revisions(id))) {
      if (revision.sha1 === sha1) return revision.label;
    }
    return undefined;
  },

  // Lua: GameVersion.lua:264
  forSha1(sha1: string): string | undefined {
    for (const [id] of pairs(VERSIONS)) {
      if (GameVersion.acceptsSha1(id as string, sha1)) return id as string;
    }
    return undefined;
  },
};

export default GameVersion;
