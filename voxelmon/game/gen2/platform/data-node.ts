// Bun-only: point the Gen 2 engine at the importer's output on disk
// (dist/voxelmon/gold/gen). Never imported by the device entry.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setGen2Source } from "./data.ts";
import { setClockSource } from "./clock.ts";
import { seed } from "./rng.ts";
import { memorySaveIo, setSaveIo } from "./saveio.ts";
import { Input } from "../shared/core/Input.ts";
import { StateStack } from "../shared/core/StateStack.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Music } from "../shared/core/Music.ts";
import { Sound } from "../shared/core/Sound.ts";

export const GOLD_GEN_DIR = join(import.meta.dir, "..", "..", "..", "..", "dist", "voxelmon", "gold", "gen");

/** True when the Gold import has been run on this machine. */
export function haveGoldGen(dir = GOLD_GEN_DIR): boolean {
  return existsSync(join(dir, "scripts.json")) && existsSync(join(dir, "pokemon.json"));
}

/**
 * Put back everything one Gold run leaves behind in the engine's
 * process-wide state -- the save store (options live there too), the clock,
 * the pad, the screen stack, the palette state and the dice -- so one test
 * file cannot set up the next. Bun runs every file in one process.
 */
export function resetGen2Session(): void {
  setSaveIo(memorySaveIo());
  setClockSource(undefined);
  Input.reset();
  StateStack.init();
  GbcPalette.clear();
  GbcPalette.setBgp(null);
  GbcPalette.setMode("gbc");
  seed(17);
  // the sound clock and its handles, so a jingle from the last file is not
  // still "playing" when this one waits for its own
  (Sound as unknown as { _resetForTest?: () => void })._resetForTest?.();
  (Music as unknown as { _resetForTest?: () => void })._resetForTest?.();
}

/** Load every JSON table of the import lazily (parsed on first ask), from a clean session. */
export function useGoldGen(dir = GOLD_GEN_DIR): void {
  resetGen2Session();
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
  // the raw tilemaps beside the tables, as the cook ships them: byte arrays
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(dir, d.name))) {
      if (!f.endsWith(".tilemap")) continue;
      const path = join(dir, d.name, f);
      Object.defineProperty(src, f, { enumerable: true, get: () => [...readFileSync(path)] });
    }
  }
  setGen2Source(src);
}
