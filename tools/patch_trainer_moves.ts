// Write Yellow's SpecialTrainerMoves (read from the player's own ROM by the
// importer's findSpecialTrainerMoves) into datasets that were imported
// before the import read it: a gen trainers.json and cooked gamedata.json
// files. Only trainers' `specialMoves` changes; no page, map or index moves,
// so no recook is needed.
//   VOXELMON_ROM=<yellow.gbc> bun tools/patch_trainer_moves.ts <json>...
import { readFileSync, writeFileSync } from "node:fs";
import { Ctx } from "../voxelmon/import/ctx.ts";
import { resolveEnv } from "../voxelmon/import/env.ts";
import { GfxBin } from "../voxelmon/import/gfx.ts";
import { loadManifest } from "../voxelmon/import/manifest.ts";
import { Rom } from "../voxelmon/import/rom.ts";
import { findSpecialTrainerMoves } from "../voxelmon/import/stages/trainers.ts";

const env = resolveEnv();
const manifest = await loadManifest(env.manifestPath);
const ctx = new Ctx(new Rom(new Uint8Array(readFileSync(env.romPath))), manifest, new GfxBin());
const pointers = ctx.symbol("TrainerDataPointers");
const order: string[] = manifest.trainers;
const found = findSpecialTrainerMoves(ctx, pointers.bank, order.length);
if (!found) {
  console.log("no SpecialTrainerMoves table in this ROM (Red/Blue use LoneMoves/TeamMoves)");
  process.exit(0);
}
let records = 0;
for (const parties of found.values()) records += parties.size;
console.log(`${env.version}: ${records} party records over ${found.size} classes`);

for (const path of process.argv.slice(2)) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const trainers = doc.trainers ?? doc;
  let n = 0;
  for (const [cls, parties] of found) {
    const id = `OPP_${order[cls - 1]}`;
    const t = trainers[id];
    if (!t) continue;
    t.specialMoves = Object.fromEntries([...parties].map(([p, rows]) => [String(p), rows]));
    n++;
  }
  writeFileSync(path, JSON.stringify(doc));
  console.log(`${path}: ${n} trainers patched`);
}
