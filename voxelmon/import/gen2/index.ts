// The Gen 2 (Gold) importer: a port of gen1recomp RomExtractorGen2.lua
// (bdfac727, the last MIT commit) onto the voxelmon/import conventions.
// Phase 1 is what drawing and walking Johto needs: constants, palettes,
// tilesets (+roofs), maps and overworld sprites, in Brian's run() order
// (RomExtractorGen2.lua:7482; font, which sits between constants and
// palettes there, is a later stage). index.ts calls this after the SHA-1
// gate.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "../ctx.ts";
import { VERSIONS, type VoxelEnv } from "../env.ts";
import { GfxBin } from "../gfx.ts";
import { Rom } from "../rom.ts";
import { writeJson } from "../writer.ts";
import { extractConstants } from "./constants.ts";
import { Gen2Ctx } from "./ctx.ts";
import { loadGen2Manifest } from "./manifest.ts";
import { extractMaps } from "./maps.ts";
import { extractPalettes } from "./palettes.ts";
import { extractSprites } from "./sprites.ts";
import { extractRoofs, extractTilesets } from "./tilesets.ts";

export async function runImportGen2(env: VoxelEnv, romData: Uint8Array): Promise<void> {
  const want = VERSIONS[env.version];
  const manifest = await loadGen2Manifest(env.manifestPath);
  check(
    manifest.romSha1 === want.sha1,
    `manifest is not for ${want.label} (romSha1 ${manifest.romSha1}): ${env.manifestPath}`,
  );

  const ctx = new Gen2Ctx(new Rom(romData), manifest, new GfxBin(), want.sha1);
  const genDir = env.genDir;

  const stages: [string, () => void][] = [
    ["version", () => writeJson(genDir, "version", { version: env.version })],
    ["constants", () => writeJson(genDir, "constants", extractConstants(ctx))],
    ["palettes", () => writeJson(genDir, "palettes", extractPalettes(ctx))],
    ["tilesets", () => writeJson(genDir, "tilesets", extractTilesets(ctx))],
    [
      "maps",
      () => {
        // RomExtractorGen2.lua:1482 — extractMaps writes roofs.lua too.
        const maps = extractMaps(ctx);
        writeJson(genDir, "roofs", extractRoofs(ctx));
        writeJson(genDir, "maps", maps);
      },
    ],
    ["sprites", () => writeJson(genDir, "sprites", extractSprites(ctx))],
    [
      "gfx",
      () => {
        writeFileSync(join(genDir, "gfx.bin"), ctx.gfx.bytes());
        writeJson(genDir, "gfx", ctx.gfx.directory);
      },
    ],
  ];

  for (let i = 0; i < stages.length; i++) {
    const [name, run] = stages[i]!;
    const started = performance.now();
    run();
    const ms = (performance.now() - started).toFixed(0);
    console.log(
      `voxel import [${String(i + 1).padStart(2)}/${stages.length}] ${name.padEnd(10)} ${ms.padStart(5)} ms`,
    );
  }
  const entries = Object.keys(ctx.gfx.directory).length;
  console.log(`voxel import done -> ${genDir} (${entries} gfx entries)`);
}
