// Port support for gen1recomp's FireRed importer (GPLv3 + additional terms;
// see LICENSE.md). The Gen 3 (FireRed / LeafGreen) importer entry: SHA-1
// gate, then gen1recomp's RomExtractorGen3 plan (rom_extractor_gen3.ts) run
// into a cache directory on disk -- the same tree gen1recomp writes
// (data/generated/gba/..., data/generated/{maps,intro,audio}.lua).
// The Node side (file cache, SHA-1); the stages themselves are Node-free.

import { createHash } from "node:crypto";
import { CacheFs } from "./cache.ts";
import { makeCache } from "./fsio.ts";
import { GameVersion } from "./game_version.ts";
import { CachePaths } from "../../game/gen3/core/cache_paths.ts";
import { RomExtractorGen3, type ProgressFn, type RunResult } from "./rom_extractor_gen3.ts";

export interface ImportGen3Options {
  /** The ROM file's bytes (FireRed or LeafGreen, 1.0 or 1.1). */
  rom: Uint8Array;
  /** The cache directory to write into (created if missing). */
  outDir: string;
  /** gen1recomp's progress callback: (permille, 1000, label, current, total). */
  onProgress?: ProgressFn;
  /** Called around each plan stage ("markers", "gba", "pokemon", "aux", "intro_audio"). */
  onStage?: (name: string, phase: "begin" | "end", ms: number) => void;
}

export interface ImportGen3Result extends RunResult {
  version: string;
  ms: number;
  stages: { name: string; ms: number }[];
}

/** The gen 3 version id for a ROM's SHA-1, or undefined. */
export function gen3VersionForSha1(sha1: string): string | undefined {
  const id = GameVersion.forSha1(sha1);
  return id && GameVersion.generation(id) === 3 ? id : undefined;
}

export function sha1Hex(data: Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

/** Run the whole Gen 3 import into outDir. Throws on an unknown ROM or a failed stage. */
export function runImportGen3(opts: ImportGen3Options): ImportGen3Result {
  const started = performance.now();
  const sha1 = sha1Hex(opts.rom);
  const version = gen3VersionForSha1(sha1);
  if (!version) {
    throw new Error(`not a FireRed/LeafGreen ROM gen1recomp knows (SHA-1 ${sha1})`);
  }
  // The app has the game selected when it imports (GameVersion.current).
  const prevVersion = GameVersion.get();
  GameVersion.set(version);
  CachePaths.reset();
  CacheFs.prefix = "";
  CacheFs.bind(makeCache(opts.outDir));

  const stages: { name: string; ms: number }[] = [];
  const t0: Record<string, number> = {};
  try {
    const ex = RomExtractorGen3.new(opts.rom, undefined, opts.onProgress, sha1);
    ex.onStage = (name, phase) => {
      if (phase === "begin") {
        t0[name] = performance.now();
        opts.onStage?.(name, phase, 0);
      } else {
        const ms = performance.now() - (t0[name] ?? performance.now());
        stages.push({ name, ms });
        opts.onStage?.(name, phase, ms);
      }
    };
    const res = ex.run();
    return { ...res, version, ms: performance.now() - started, stages };
  } finally {
    CacheFs.bind(undefined);
    GameVersion.set(prevVersion);
  }
}

export default runImportGen3;
