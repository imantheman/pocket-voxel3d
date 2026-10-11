// Adds the cartridge-save facts (voxelmon/import/stages/vcsave.ts) to a
// gamedata.json that was cooked before they existed, straight from the ROM,
// without a full re-import and cook:
//
//   bun tools/vc_gamedata.ts <rom.gb> <gamedata.json in> [gamedata.json out]
//   bun tools/vc_gamedata.ts <rom.gb> --json <vcsave.json out>
//
// Red, Blue and Yellow (US) only; the ROM's SHA-1 says which. The manifest
// comes from the gen1recomp checkout the importer uses (VOXELMON_G1R,
// default ~/gen1recomp or ~/code/gen1recomp).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ctx } from "../voxelmon/import/ctx.ts";
import { VERSIONS, versionOfRom } from "../voxelmon/import/env.ts";
import { GfxBin } from "../voxelmon/import/gfx.ts";
import { loadManifest } from "../voxelmon/import/manifest.ts";
import { Rom } from "../voxelmon/import/rom.ts";
import { extractVcSave } from "../voxelmon/import/stages/vcsave.ts";

const [romPath, second, third] = process.argv.slice(2);
if (!romPath || !second) {
  console.error("usage: bun tools/vc_gamedata.ts <rom> <gamedata.json> [out] | <rom> --json <out>");
  process.exit(2);
}
const version = versionOfRom(romPath);
if (version !== "red" && version !== "blue" && version !== "yellow") {
  console.error(`vc_gamedata: ${romPath} is not US Red, Blue or Yellow`);
  process.exit(1);
}
const g1r = [process.env.VOXELMON_G1R, join(homedir(), "gen1recomp"), join(homedir(), "code/gen1recomp")]
  .find((d) => d && existsSync(join(d, VERSIONS[version].manifest)));
if (!g1r) {
  console.error("vc_gamedata: no gen1recomp checkout with the manifest (set VOXELMON_G1R)");
  process.exit(1);
}
const manifest = await loadManifest(join(g1r, VERSIONS[version].manifest));
const ctx = new Ctx(new Rom(new Uint8Array(readFileSync(romPath))), manifest, new GfxBin());
const vc = extractVcSave(ctx);
console.log(
  `vc_gamedata: ${version}: ${Object.keys(vc.maps).length} maps, ${Object.keys(vc.tilesets).length} tilesets, ` +
    `${vc.toggles.length} toggles, ${vc.hiddenItems.length} hidden items, ${vc.hiddenCoins.length} hidden coins`,
);
if (second === "--json") {
  writeFileSync(third!, JSON.stringify(vc));
  console.log(`vc_gamedata: wrote ${third}`);
} else {
  const gd = JSON.parse(readFileSync(second, "utf8"));
  if (gd.version && gd.version !== version) {
    console.error(`vc_gamedata: ${second} is ${gd.version}, the ROM is ${version}`);
    process.exit(1);
  }
  gd.vcsave = vc;
  const out = third ?? second;
  writeFileSync(out, JSON.stringify(gd));
  console.log(`vc_gamedata: wrote ${out}`);
}
