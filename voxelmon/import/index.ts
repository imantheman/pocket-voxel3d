// The importer entry: SHA-1 gate, then the extraction stages in the
// gen1recomp RomExtractor.lua run() order (minus battle_anims/icons, still
// deferred), writing dist/voxelmon/gen/*.json + gfx.bin/gfx.json +
// programs.bin per voxelmon/SCHEMA.md.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ctx, check } from "./ctx.ts";
import { VERSIONS, type VoxelEnv } from "./env.ts";
import { GfxBin } from "./gfx.ts";
import { loadManifest } from "./manifest.ts";
import { Rom } from "./rom.ts";
import { writeJson } from "./writer.ts";
import { extractAudio } from "./stages/audio.ts";
import { extractPikaCries } from "./stages/pikacries.ts";
import { extractEncounters } from "./stages/encounters.ts";
import { extractField } from "./stages/field.ts";
import { extractFont } from "./stages/font.ts";
import { extractItems } from "./stages/items.ts";
import { extractMaps } from "./stages/maps.ts";
import { extractBattleAnims } from "./stages/battle-anims.ts";
import { extractMoves } from "./stages/moves.ts";
import { extractPalettes } from "./stages/palettes.ts";
import { extractPokemon } from "./stages/pokemon.ts";
import { extractSprites } from "./stages/sprites.ts";
import { extractText } from "./stages/text.ts";
import { extractTitle } from "./stages/title.ts";
import { extractIntro } from "./stages/intro.ts";
import { extractTrainerCard } from "./stages/trainercard.ts";
import { extractTownMap } from "./stages/townmap.ts";
import { extractSlots } from "./stages/slots.ts";
import { extractTilesets } from "./stages/tilesets.ts";
import { extractTrainers } from "./stages/trainers.ts";
import { extractTypeChart } from "./stages/type-chart.ts";

function sha1Hex(data: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(data);
  return hasher.digest("hex");
}

export async function runImport(env: VoxelEnv): Promise<void> {
  const romData = new Uint8Array(await Bun.file(env.romPath).arrayBuffer());
  // The content boundary (docs/VOXEL.md §1): verify SHA-1 BEFORE decoding
  // one byte.
  const digest = sha1Hex(romData);
  const want = VERSIONS[env.version];
  check(
    digest === want.sha1,
    `ROM SHA-1 mismatch: got ${digest}, need ${want.label} ${want.sha1} (${env.romPath})`,
  );
  const manifest = await loadManifest(env.manifestPath);
  check(
    manifest.romSha1 === want.sha1,
    `manifest is not for ${want.label} (romSha1 ${manifest.romSha1}): ${env.manifestPath}`,
  );

  const ctx = new Ctx(new Rom(romData), manifest, new GfxBin());
  const genDir = env.genDir;

  const stages: [string, () => void][] = [
    // Which game this dataset is. The cook carries it into gamedata.json,
    // and the guest reads it for the few things that differ by version.
    ["version", () => writeJson(genDir, "version", { version: env.version })],
    ["constants", () => writeJson(genDir, "constants", manifest.constants)],
    ["tilesets", () => writeJson(genDir, "tilesets", extractTilesets(ctx))],
    ["maps", () => writeJson(genDir, "maps", extractMaps(ctx))],
    ["font", () => writeJson(genDir, "font", extractFont(ctx))],
    ["sprites", () => writeJson(genDir, "sprites", extractSprites(ctx))],
    ["moves", () => writeJson(genDir, "moves", extractMoves(ctx))],
    ["battle_anims", () => writeJson(genDir, "battle_anims", extractBattleAnims(ctx))],
    ["items", () => writeJson(genDir, "items", extractItems(ctx))],
    ["type_chart", () => writeJson(genDir, "type_chart", extractTypeChart(ctx))],
    ["palettes", () => writeJson(genDir, "palettes", extractPalettes(ctx))],
    ["pokemon", () => writeJson(genDir, "pokemon", extractPokemon(ctx))],
    ["trainers", () => writeJson(genDir, "trainers", extractTrainers(ctx))],
    ["encounters", () => writeJson(genDir, "encounters", extractEncounters(ctx))],
    [
      "text",
      () => {
        const { texts, pointers, trainerHeaders } = extractText(ctx);
        writeJson(genDir, "text", texts);
        writeJson(genDir, "text_pointers", pointers);
        writeJson(genDir, "trainer_headers", trainerHeaders);
      },
    ],
    ["field", () => writeJson(genDir, "field", extractField(ctx))],
    ["title", () => writeJson(genDir, "title", extractTitle(ctx))],
    ["intro", () => writeJson(genDir, "intro", extractIntro(ctx))],
    ["trainercard", () => writeJson(genDir, "trainercard", extractTrainerCard(ctx))],
    ["townmap", () => writeJson(genDir, "townmap", extractTownMap(ctx))],
    ["slots", () => writeJson(genDir, "slots", extractSlots(ctx))],
    [
      "audio",
      () => {
        const { json, programs } = extractAudio(ctx);
        // Yellow's voiced Pikachu clips, beside the programs; the manifest
        // says how many, which is how the guest knows it can ask for one.
        const pika = extractPikaCries(ctx);
        const pikaPath = join(genDir, "pika_cries.bin");
        if (pika) {
          writeFileSync(pikaPath, pika);
          (json as { pikaCries?: number }).pikaCries = pika[0]! | (pika[1]! << 8);
        } else if (existsSync(pikaPath)) {
          rmSync(pikaPath);
        }
        writeJson(genDir, "audio", json);
        writeFileSync(join(genDir, "programs.bin"), programs);
      },
    ],
    [
      "gfx",
      () => {
        writeFileSync(join(genDir, "gfx.bin"), ctx.gfx.bytes());
        writeJson(genDir, "gfx", ctx.gfx.directory);
      },
    ],
  ];

  for (let i = 0; i < stages.length; i++) {
    const [name, run] = stages[i];
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
