// Port of gen1recomp src/core/GameVersion.lua (GPLv3 + additional terms; see LICENSE.md),
// the Gen 3 rows only: the FireRed engine never needs the Gen 1/2 rows, and
// those games keep their own GameVersion (voxelmon/game/gen2/shared/core).

export interface VersionInfo {
  id: string;
  label: string;
  displayName: string;
  sha1: string;
  revisions: { sha1: string; label: string }[];
  manifest: string;
  cachePrefix: string;
  saveSuffix: string;
  generation: number;
  engine: string;
  layout: string;
  gameCode: number;
}

// Lua: GameVersion.lua:113-160
const VERSIONS: Record<string, VersionInfo> = {
  firered: {
    id: "firered", label: "FireRed", displayName: "Pokemon FireRed",
    sha1: "41cb23d8dccc8ebd7c649cd8fbb58eeace6e2fdc",
    revisions: [
      { sha1: "41cb23d8dccc8ebd7c649cd8fbb58eeace6e2fdc", label: "1.0" },
      { sha1: "dd5945db9b930750cb39d00c84da8571feebf417", label: "1.1" },
    ],
    manifest: "tools/rom_manifest_firered.json", cachePrefix: "firered/", saveSuffix: "_firered",
    generation: 3, engine: "game3", layout: "frlg", gameCode: 4,
  },
  leafgreen: {
    id: "leafgreen", label: "LeafGreen", displayName: "Pokemon LeafGreen",
    sha1: "574fa542ffebb14be69902d1d36f1ec0a4afd71e",
    revisions: [
      { sha1: "574fa542ffebb14be69902d1d36f1ec0a4afd71e", label: "1.0" },
      { sha1: "7862c67bdecbe21d1d69ce082ce34327e1c6ed5e", label: "1.1" },
    ],
    manifest: "tools/rom_manifest_leafgreen.json", cachePrefix: "leafgreen/", saveSuffix: "_leafgreen",
    generation: 3, engine: "game3", layout: "frlg", gameCode: 5,
  },
};

export const GameVersion = {
  VERSIONS,
  ORDER: ["red", "blue", "yellow", "gold", "silver", "crystal", "firered", "leafgreen", "emerald"],
  current: "firered",

  set(id: string): string {
    GameVersion.current = VERSIONS[id] ? id : "firered";
    return GameVersion.current;
  },
  get(): string { return GameVersion.current; },
  info(id?: string): VersionInfo | undefined { return VERSIONS[id ?? GameVersion.current]; },
  generation(id?: string): number { return GameVersion.info(id)?.generation ?? 1; },
  engine(id?: string): string { return GameVersion.info(id)?.engine ?? "gen1"; },
  layout(id?: string): string | undefined { return GameVersion.info(id)?.layout; },
  gameCode(id?: string): number | undefined { return GameVersion.info(id)?.gameCode; },
  saveSuffix(id?: string): string | undefined { return GameVersion.info(id)?.saveSuffix; },
  cachePrefix(id?: string): string | undefined { return GameVersion.info(id)?.cachePrefix; },
  revisions(id?: string): { sha1: string; label?: string }[] {
    const info = GameVersion.info(id);
    return info ? info.revisions : [];
  },
  acceptsSha1(id: string, sha1: string): boolean {
    return GameVersion.revisions(id).some((r) => r.sha1 === sha1);
  },
  revisionLabel(id: string, sha1: string): string | undefined {
    return GameVersion.revisions(id).find((r) => r.sha1 === sha1)?.label;
  },
  forSha1(sha1: string): string | undefined {
    for (const id of Object.keys(VERSIONS)) if (GameVersion.acceptsSha1(id, sha1)) return id;
    return undefined;
  },
};

export default GameVersion;
