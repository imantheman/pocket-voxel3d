// Input resolution for the voxelmon pipeline (voxelmon/SCHEMA.md):
// everything ROM-adjacent comes from env vars with local-developer defaults;
// anything missing must SKIP with a printed reason, never fail CI.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** SHA-1 of the canonical US Red ROM (docs/VOXEL.md §1 — gate before decode). */
export const RED_SHA1 = "ea9bcae617fdf159b045185467ae58b2e4a48b9a";
/** SHA-1 of the canonical US Blue ROM (gen1recomp GameVersion.VERSIONS.blue). */
export const BLUE_SHA1 = "d7037c83e1ae5b39bde3c30787637ba1d4c48ce2";
/** SHA-1 of the canonical US Yellow ROM (gen1recomp GameVersion.VERSIONS.yellow). */
export const YELLOW_SHA1 = "cc7d03262ebfaf2f06772c1a480c7d9d5f4a38e1";

/** SHA-1 of Pokemon Gold (USA, Europe) (gen1recomp GameVersion.VERSIONS.gold). */
export const GOLD_SHA1 = "d8b8a3600a465308c9953dfa04f0081c05bdcb94";
/** SHA-1 of Pokemon Silver (USA, Europe) (gen1recomp GameVersion.VERSIONS.silver). */
export const SILVER_SHA1 = "49b163f7e57702bc939d642a18f591de55d92dae";

export type GameVersion = "red" | "blue" | "yellow" | "gold" | "silver";

/**
 * The games this pipeline can cook (gen1recomp src/core/GameVersion.lua).
 * The two share every map and every graphic but one -- the title's version
 * ribbon -- so they cook to ONE shared pak set; what differs is each game's
 * own dataset (encounters, text, credits, default names) and that ribbon.
 */
export const VERSIONS: Record<GameVersion, { sha1: string; manifest: string; label: string; generation: 1 | 2 }> = {
  red: { sha1: RED_SHA1, manifest: "tools/rom_manifest.json", label: "Red", generation: 1 },
  blue: { sha1: BLUE_SHA1, manifest: "tools/rom_manifest_blue.json", label: "Blue", generation: 1 },
  yellow: { sha1: YELLOW_SHA1, manifest: "tools/rom_manifest_yellow.json", label: "Yellow", generation: 1 },
  // Gen 2 comes from gen1recomp's last MIT commit, bdfac727 (docs/gold-plan.md)
  gold: { sha1: GOLD_SHA1, manifest: "tools/rom_manifest_gold.json", label: "Gold", generation: 2 },
  // Silver's manifest is upstream's too, at the same pin (998cb03d, an
  // ancestor of bdfac727): the same 2062 symbols at Silver's addresses
  silver: { sha1: SILVER_SHA1, manifest: "tools/rom_manifest_silver.json", label: "Silver", generation: 2 },
};

/**
 * Where a generation's gen1recomp checkout is. Gen 1 ports from the MIT pin
 * 943ba5dc (VOXELMON_G1R); Gen 2 only exists later, and is ported from the
 * last MIT commit, bdfac727 (VOXELMON_G1R_GEN2) -- never from anything after
 * the relicence (661d75ef).
 */
function g1rDirFor(generation: 1 | 2): string {
  if (generation === 2) return process.env.VOXELMON_G1R_GEN2 ?? join(homedir(), "gen1recomp-mit-gen2");
  return process.env.VOXELMON_G1R ?? join(homedir(), "code/gen1recomp");
}

/**
 * Where a version's imported dataset lives. Red keeps the path it has always
 * had, so every existing script, test and golden is untouched.
 */
export function genDirFor(version: GameVersion): string {
  return version === "red"
    ? join(ROOT, "dist/voxelmon/gen")
    : join(ROOT, `dist/voxelmon/${version}/gen`);
}

/** Which game a ROM file is, by its SHA-1; null for anything else. */
export function versionOfRom(path: string): GameVersion | null {
  if (!existsSync(path)) return null;
  const digest = createHash("sha1").update(readFileSync(path)).digest("hex");
  for (const [v, info] of Object.entries(VERSIONS)) if (info.sha1 === digest) return v as GameVersion;
  return null;
}

/**
 * The game this run is about. VOXELMON_VERSION says so outright; failing
 * that, the ROM in VOXELMON_ROM does; failing that, Red. So a Blue ROM on
 * its own is enough -- nobody has to say "blue" anywhere.
 */
export function activeVersion(): GameVersion {
  const named = process.env.VOXELMON_VERSION?.toLowerCase();
  if (named === "red" || named === "blue" || named === "yellow" || named === "gold" || named === "silver") return named;
  const rom = process.env.VOXELMON_ROM;
  return (rom && versionOfRom(rom)) || "red";
}

// SCHEMA.md: no default ROM path is committed to docs; this is the local
// developer default for this machine.
const DEFAULT_ROM =
  "/Users/evan/Library/Mobile Documents/com~apple~CloudDocs/Documents/project-assets/pokemon/PokemonRed.gb";

export interface VoxelEnv {
  version: GameVersion;
  romPath: string;
  g1rDir: string;
  voxelmodDir: string;
  manifestPath: string;
  refGeneratedDir: string;
  genDir: string;
}

export function resolveEnv(): VoxelEnv {
  const version = activeVersion();
  const g1rDir = g1rDirFor(VERSIONS[version].generation);
  return {
    version,
    romPath: process.env.VOXELMON_ROM ?? DEFAULT_ROM,
    g1rDir,
    voxelmodDir: process.env.VOXELMON_VOXELMOD ?? join(homedir(), "code/DramaticShapeVoxelMod"),
    manifestPath: join(g1rDir, VERSIONS[version].manifest),
    // gen1recomp's own extraction of the same ROM, for `voxel parity`: Red's
    // at data/generated, the others under <version>/ (its cachePrefix).
    refGeneratedDir: process.env.VOXELMON_REF_GENERATED ??
      join(g1rDir, version === "red" ? "data/generated" : `${version}/data/generated`),
    genDir: genDirFor(version),
  };
}

/** Returns a printable reason the pipeline cannot run, or null when it can. */
export function missingInputReason(env: VoxelEnv): string | null {
  if (!existsSync(env.romPath)) return `ROM not found: ${env.romPath} (set VOXELMON_ROM)`;
  if (!existsSync(env.manifestPath)) {
    return `gen1recomp manifest not found: ${env.manifestPath} (set VOXELMON_G1R)`;
  }
  return null;
}
