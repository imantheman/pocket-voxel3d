// tools/cook3ds_gen3.ts — FireRed / LeafGreen's 3DS card from a ROM, in one go
// (GPLv3 + additional terms: it runs the gen3 importer and cook; see
// voxelmon/game/gen3/LICENSE.md).
//
//   bun tools/cook3ds_gen3.ts <rom.gba> <outdir> [--game firered|leafgreen]
//                             [--skip-world] [--keep-work] [--cache DIR] [--no-zip]
//
// Writes the card tree under <outdir>, to copy onto the SD card's root as is:
//
//   <outdir>/3ds/voxelmon/paks_firered/   the voxel world (one pak per map,
//                                          common.vxat, index.txt, world.json);
//                                          FireRed and LeafGreen share it
//   <outdir>/3ds/voxelmon/<game>/data.pvpk       the game's data, cooked
//   <outdir>/3ds/voxelmon/<game>/audio.m4ap(.key) its sound, pre-built
//
// <game> is the ROM's (firered or leafgreen; --game only checks it). Steps:
//   1. import the ROM (voxelmon/import/gen3) into <outdir>/.pv_gen3_work/cache
//      (or use an existing cache with --cache DIR, the folder holding data/)
//   2. cook the world (voxelmon/cook/gen3cook.ts) into paks_firered, unless
//      --skip-world (LeafGreen after FireRed: the set is the same)
//   3. cook the data and the sound (voxelmon/cook/gen3data.ts)
// The work folder is removed at the end unless --keep-work.
//
// Bun only, except the world cook's atlas share, which runs
// tools/pak_share_atlas.py with VOXELMON_PYTHON (default "python3"), as
// tools/cook3ds.ts does for the other games.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { gen3VersionForSha1, runImportGen3, sha1Hex } from "../voxelmon/import/gen3/index.ts";
import { cookCard } from "../voxelmon/cook/gen3data.ts";

function usage(msg?: string): never {
  if (msg) console.error(`cook3ds_gen3: ${msg}`);
  console.error("usage: bun tools/cook3ds_gen3.ts <rom.gba> <outdir> [--game firered|leafgreen] [--skip-world] [--keep-work] [--cache DIR] [--no-zip]");
  process.exit(2);
}

const args = process.argv.slice(2);
const valueOf = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) usage(`${name} needs a value`);
  args.splice(i, 2);
  return v;
};
const flag = (name: string): boolean => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const want = valueOf("--game");
const cacheArg = valueOf("--cache");
const skipWorld = flag("--skip-world");
const keepWork = flag("--keep-work");
const noZip = flag("--no-zip");
const unknown = args.filter((a) => a.startsWith("--"));
if (unknown.length) usage(`unknown option ${unknown.join(" ")}`);
const [romPath, outArg] = args;
if (!romPath || !outArg) usage();
if (want && want !== "firered" && want !== "leafgreen") usage(`--game is firered or leafgreen, not ${want}`);
if (!existsSync(romPath)) usage(`no such ROM: ${romPath}`);

const out = resolve(outArg);
const card = join(out, "3ds/voxelmon");
const work = join(out, ".pv_gen3_work");
const t0 = performance.now();
const secs = (t: number): string => ((performance.now() - t) / 1000).toFixed(1);

// 1. the ROM -> the importer's cache
const rom = new Uint8Array(readFileSync(romPath));
const version = gen3VersionForSha1(sha1Hex(rom));
if (!version) usage(`not a FireRed/LeafGreen ROM (1.0 or 1.1): ${romPath}`);
if (want && want !== version) usage(`the ROM is ${version}, not ${want}`);
let cache: string;
if (cacheArg) {
  cache = resolve(cacheArg);
  console.log(`cook3ds_gen3: ${version}, using the cache at ${cache}`);
} else {
  cache = join(work, "cache");
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  console.log(`cook3ds_gen3: importing ${version} into ${cache}`);
  const t = performance.now();
  const res = runImportGen3({
    rom,
    outDir: cache,
    onStage: (name, phase, ms) => { if (phase === "end") console.log(`  import ${name.padEnd(12)} ${(ms / 1000).toFixed(1)} s`); },
  });
  console.log(`  import done in ${secs(t)} s (extract ${res.extractOk}, pokemon ${res.pokemonOk}, aux ${res.auxOk})`);
}
if (!existsSync(join(cache, "data/generated/gba/native/manifest.lua"))) usage(`the import left no cache at ${cache}`);

// 2. the world (shared by both games)
if (!skipWorld) {
  process.env.VOXELMON_FR_CACHE = join(cache, "data/generated/gba");
  const { cookFireRed } = await import("../voxelmon/cook/gen3cook.ts");
  const t = performance.now();
  const paks = join(card, "paks_firered");
  const rc = cookFireRed(undefined, { orig: join(work, "paks_orig_firered"), paks });
  if (rc !== 0) { console.error("cook3ds_gen3: the world cook failed"); process.exit(rc); }
  console.log(`  world cooked in ${secs(t)} s -> ${paks}`);
} else if (!existsSync(join(card, "paks_firered/world.json"))) {
  console.warn(`cook3ds_gen3: --skip-world, and ${join(card, "paks_firered")} has no world yet`);
}

// 3. the data and the sound
{
  const t = performance.now();
  const st = cookCard(cache, card, { game: version, zip: !noZip });
  console.log(`  data cooked in ${secs(t)} s -> ${join(card, version)} (${(st.bytesOut / 1e6).toFixed(1)} MB)`);
}

if (!keepWork) rmSync(work, { recursive: true, force: true });
console.log(`cook3ds_gen3: card tree at ${out} (copy its 3ds folder onto the SD card) in ${secs(t0)} s`);
