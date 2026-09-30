// Bun-only: point the Gen 2 engine at the importer's output on disk
// (dist/voxelmon/gold/gen). Never imported by the device entry.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setGen2Source } from "./data.ts";

export const GOLD_GEN_DIR = join(import.meta.dir, "..", "..", "..", "..", "dist", "voxelmon", "gold", "gen");

/** True when the Gold import has been run on this machine. */
export function haveGoldGen(dir = GOLD_GEN_DIR): boolean {
  return existsSync(join(dir, "scripts.json")) && existsSync(join(dir, "pokemon.json"));
}

/** Load every JSON table of the import lazily (parsed on first ask). */
export function useGoldGen(dir = GOLD_GEN_DIR): void {
  const src: Record<string, unknown> = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const path = join(dir, f);
    let cached: string | undefined;
    Object.defineProperty(src, f.slice(0, -5), {
      enumerable: true,
      get: () => (cached ??= readFileSync(path, "utf8")),
    });
  }
  setGen2Source(src);
}
