// Port support for gen1recomp's FireRed importer (GPLv3 + additional terms;
// see LICENSE.md). The Gen 3 importer from the command line:
//
//   bun voxelmon/import/gen3/cli.ts <rom.gba> <outDir> [--verbose]
//
// Accepts FireRed / LeafGreen 1.0 and 1.1 (a 1.1 ROM is rebuilt in its 1.0
// layout first, revision_view.ts). Prints each plan stage and its time.

import { existsSync, readFileSync } from "node:fs";
import { GameVersion } from "./game_version.ts";
import { gen3VersionForSha1, runImportGen3, sha1Hex } from "./index.ts";

function usage(): never {
  console.error("usage: bun voxelmon/import/gen3/cli.ts <rom.gba> <outDir> [--verbose]");
  process.exit(2);
}

const args = process.argv.slice(2);
const verbose = args.includes("--verbose") || args.includes("-v");
const [romPath, outDir] = args.filter((a) => !a.startsWith("-"));
if (!romPath || !outDir) usage();
if (!existsSync(romPath)) {
  console.error(`no such ROM: ${romPath}`);
  process.exit(1);
}

const rom = new Uint8Array(readFileSync(romPath));
const sha1 = sha1Hex(rom);
const version = gen3VersionForSha1(sha1);
if (!version) {
  console.error(`not a FireRed/LeafGreen ROM gen1recomp knows: SHA-1 ${sha1} (${romPath})`);
  process.exit(1);
}
const label = GameVersion.revisionLabel(version, sha1) ?? GameVersion.info(version)?.label ?? version;
console.log(`gen3 import: ${label} (${sha1}) -> ${outDir}`);

// labels are byte strings (UTF-8 bytes one per char); show them as text
const text = (s: string): string => Buffer.from(s, "latin1").toString("utf8");
let lastLabel = "";
let index = 0;
const res = runImportGen3({
  rom,
  outDir,
  onProgress: verbose
    ? (permille, _total, stageName) => {
      const l = text(stageName).replace(/ \(\d+\/\d+\)$/, "");
      if (l !== lastLabel) {
        lastLabel = l;
        console.log(`        ${(permille / 10).toFixed(1).padStart(5)}%  ${l}`);
      }
    }
    : undefined,
  onStage: (name, phase, ms) => {
    if (phase === "begin") index++;
    else console.log(`gen3 import [${index}/5] ${name.padEnd(12)} ${ms.toFixed(0).padStart(7)} ms`);
  },
});
console.log(`gen3 import done in ${(res.ms / 1000).toFixed(1)} s: extract ${res.extractOk}, pokemon ${res.pokemonOk}, aux ${res.auxOk}`);
