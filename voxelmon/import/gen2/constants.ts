// Port of gen1recomp RomExtractorGen2.lua:337 extractConstants (bdfac727):
// the manifest's constants block verbatim, tagged generation 2.

import type { Gen2Ctx } from "./ctx.ts";

export function extractConstants(ctx: Gen2Ctx): Record<string, unknown> {
  // RomExtractorGen2.lua:339 copy() — a deep copy, so the tag never lands
  // in the manifest object the other stages read.
  const data = structuredClone(ctx.manifest.constants) as Record<string, unknown>;
  data.generation = 2;
  return data;
}
