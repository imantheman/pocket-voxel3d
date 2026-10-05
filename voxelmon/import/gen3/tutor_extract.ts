// Port of gen1recomp src/import/gba/tutor_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/data/pokemon/tutor_learnsets.h:1 sTutorMoves, :22 sTutorLearnsets

import { Versions } from "./versions.ts";
import { Layouts } from "./layouts.ts";
import { Plans } from "./plans.ts";
import { format } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

// Lua: tutor_extract.lua:13 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

export const TutorExtract = {
  CACHE_SUB: "pokemon",
  CACHE_FILE: "tutor.lua",
  FORMAT_VERSION: 1,
  REQUIRED: ["pokemon/tutor.lua"],

  // Lua: tutor_extract.lua:21 -- [moves, learnsets], both keyed from 0
  read(rom: Rom): [Record<number, number>, Record<number, number>] {
    const moves: Record<number, number> = {}, learnsets: Record<number, number> = {};
    for (let i = 0; i <= Versions.TUTOR_MOVE_COUNT - 1; i++) moves[i] = rom.u16(Versions.TUTOR_MOVES + i * 2);
    const width = Layouts.active().tutorLearnsetBytes;
    for (let species = 0; species <= Versions.NUM_SPECIES - 1; species++) {
      const off = Versions.TUTOR_LEARNSETS + species * width;
      learnsets[species] = width === 4 ? rom.u32(off) : rom.u16(off);
    }
    return [moves, learnsets];
  },

  // Lua: tutor_extract.lua:34
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): { rel: string; species: number } {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const rel = cacheRoot + "/" + TutorExtract.CACHE_SUB + "/" + TutorExtract.CACHE_FILE;
    const [moves, learnsets] = TutorExtract.read(rom);

    const lines = [
      "-- Auto-generated FRLG sTutorMoves / sTutorLearnsets.",
      "return {",
      format("  format_version = %d,", TutorExtract.FORMAT_VERSION),
      "  moves = {",
    ];
    for (let i = 0; i <= Versions.TUTOR_MOVE_COUNT - 1; i++) lines.push(format("    [%d] = %d,", i, moves[i]));
    lines.push("  },");
    lines.push("  learnsets = {");
    for (let species = 0; species <= Versions.NUM_SPECIES - 1; species++) {
      if (learnsets[species] !== 0) lines.push(format("    [%d] = %d,", species, learnsets[species]));
    }
    lines.push("  },");
    lines.push("}");
    lines.push("");
    cache.write(rel, lines.join("\n"));

    let rows = 0;
    for (const k of Object.keys(learnsets)) if (learnsets[Number(k)] !== 0) rows++;
    console.log(format("[tutor_extract] %d tutor moves, %d species with a tutor bit -> %s",
      Versions.TUTOR_MOVE_COUNT, rows, rel));
    return { rel, species: rows };
  },

  // Lua: tutor_extract.lua:70
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const rel = (cacheRoot ?? default_cache_root()) + "/" + TutorExtract.CACHE_SUB + "/" + TutorExtract.CACHE_FILE;
    if (!(cache && cache.exists)) return false;
    return cache.exists(rel);
  },
};

Plans.register("tutor_extract", TutorExtract as unknown as Record<string, unknown>);

export default TutorExtract;
