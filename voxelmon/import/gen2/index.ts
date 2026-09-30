// The Gen 2 (Gold) importer: a port of gen1recomp RomExtractorGen2.lua
// (bdfac727, the last MIT commit) onto the voxelmon/import conventions,
// in Brian's run() order (RomExtractorGen2.lua:7482). extractMobileGfx
// (:7274) is Crystal-only (it returns nil on Gold) and is not ported.
// index.ts calls this after the SHA-1 gate.
//
// Each stage returns the tables it writes keyed by file name (Brian's
// `self:write(name, ...)` -> gen/<name>.json); a `*.bin` key is a binary
// blob written as is.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { check } from "../ctx.ts";
import { VERSIONS, type VoxelEnv } from "../env.ts";
import { GfxBin } from "../gfx.ts";
import { Rom } from "../rom.ts";
import { writeJson } from "../writer.ts";
import { extractAudio } from "./audio.ts";
import { extractBattleAnims } from "./battleanims.ts";
import { extractConstants } from "./constants.ts";
import { Gen2Ctx } from "./ctx.ts";
import { extractEncounters } from "./encounters.ts";
import { extractFont } from "./font.ts";
import { extractIcons, extractMonSprites } from "./icons.ts";
import { extractIntro } from "./intro.ts";
import { extractItems, extractMarts, extractMoves } from "./items.ts";
import { loadGen2Manifest } from "./manifest.ts";
import { extractMaps } from "./maps.ts";
import { extractMenuGfx } from "./menugfx.ts";
import { extractCredits, extractDiploma, extractStubs, extractTrade } from "./movies.ts";
import { extractOakSpeech } from "./oakspeech.ts";
import { extractPalettes } from "./palettes.ts";
import { extractLandmarks, extractPokedex } from "./pokedex.ts";
import { extractPokemon } from "./pokemon.ts";
import { extractScriptsAndText, extractStdScripts, extractText } from "./scripts.ts";
import { extractSprites } from "./sprites.ts";
import { extractRoofs, extractTilesets } from "./tilesets.ts";
import { extractTitle } from "./title.ts";
import { extractTrainers } from "./trainers.ts";

type Files = Record<string, unknown>;

export async function runImportGen2(env: VoxelEnv, romData: Uint8Array): Promise<void> {
  const want = VERSIONS[env.version];
  const manifest = await loadGen2Manifest(env.manifestPath);
  check(
    manifest.romSha1 === want.sha1,
    `manifest is not for ${want.label} (romSha1 ${manifest.romSha1}): ${env.manifestPath}`,
  );

  const ctx = new Gen2Ctx(new Rom(romData), manifest, new GfxBin(), want.sha1);
  const genDir = env.genDir;
  const emit = (files: Files): void => {
    for (const [name, value] of Object.entries(files)) {
      if (value === undefined) continue;
      if (value instanceof Uint8Array) {
        // programs.bin, and menu_gfx's two raw tilemaps
        // ("slots/gold_slots.tilemap", "card_flip/card_flip.tilemap").
        const path = join(genDir, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, value);
      } else {
        writeJson(genDir, name, value);
      }
    }
  };

  // Results later stages read (Brian's `results.*`).
  let maps: Record<string, any> = {};
  let stdScripts: ReturnType<typeof extractStdScripts> | undefined;
  let pokemon: Record<string, any> | undefined;

  const stages: [string, () => Files][] = [
    ["version", () => ({ version: { version: env.version } })],
    ["constants", () => ({ constants: extractConstants(ctx) })],
    ["font", () => ({ font: extractFont(ctx) })],
    ["palettes", () => ({ palettes: extractPalettes(ctx) })],
    ["tilesets", () => ({ tilesets: extractTilesets(ctx) })],
    [
      "maps",
      () => {
        // :1482 — extractMaps writes roofs.lua too. maps.json is written
        // again by the scripts stage, which annotates the events.
        maps = extractMaps(ctx) as Record<string, any>;
        return { roofs: extractRoofs(ctx), maps };
      },
    ],
    // :1498 — extractSprites appends extractMonSprites' SPRITE_POKEMON rows.
    ["sprites", () => ({ sprites: extractMonSprites(ctx, extractSprites(ctx) as Files) })],
    [
      "std_scripts",
      () => {
        stdScripts = extractStdScripts(ctx);
        return { std_scripts: stdScripts };
      },
    ],
    [
      "scripts",
      () => {
        const r = extractScriptsAndText(ctx, maps, stdScripts);
        // :4067 — Brian rewrites maps.lua with the scriptKey annotations.
        return { maps, scripts: r.scripts, text: r.text, events: r.events, initial_events: r.initialEvents };
      },
    ],
    ["rom_text", () => ({ rom_text: extractText(ctx) })],
    [
      "pokemon",
      () => {
        const files = extractPokemon(ctx);
        pokemon = files.pokemon as Record<string, any>;
        return files;
      },
    ],
    ["moves", () => extractMoves(ctx)],
    ["items", () => ({ items: extractItems(ctx) })],
    ["marts", () => ({ marts: extractMarts(ctx) })],
    ["encounters", () => extractEncounters(ctx)],
    ["trainers", () => extractTrainers(ctx)],
    ["pokedex", () => extractPokedex(ctx)],
    ["landmarks", () => extractLandmarks(ctx)],
    ["icons", () => extractIcons(ctx)],
    ["intro", () => extractIntro(ctx)],
    ["menu_gfx", () => extractMenuGfx(ctx)],
    // extractMobileGfx (:7274): Crystal only.
    ["oak_speech", () => ({ oak_speech: extractOakSpeech(ctx, pokemon) })],
    ["title", () => extractTitle(ctx)],
    ["credits", () => extractCredits(ctx)],
    ["diploma", () => extractDiploma(ctx)],
    ["trade", () => extractTrade(ctx)],
    ["audio", () => extractAudio(ctx, maps)],
    ["battle_anims", () => extractBattleAnims(ctx)],
    ["stubs", () => extractStubs(ctx)],
    [
      "gfx",
      () => {
        writeFileSync(join(genDir, "gfx.bin"), ctx.gfx.bytes());
        return { gfx: ctx.gfx.directory };
      },
    ],
  ];

  for (let i = 0; i < stages.length; i++) {
    const [name, run] = stages[i]!;
    const started = performance.now();
    emit(run());
    const ms = (performance.now() - started).toFixed(0);
    console.log(
      `voxel import [${String(i + 1).padStart(2)}/${stages.length}] ${name.padEnd(12)} ${ms.padStart(5)} ms`,
    );
  }
  const entries = Object.keys(ctx.gfx.directory).length;
  console.log(`voxel import done -> ${genDir} (${entries} gfx entries)`);
}
