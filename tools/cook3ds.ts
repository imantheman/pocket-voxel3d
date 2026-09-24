// tools/cook3ds.ts — build the whole 3DS card image in one go.
//
//   bun tools/cook3ds.ts [--only A,B]   (--only is for debugging one map)
//
// The 3DS streams ONE PAK PER MAP off the SD card instead of holding a
// single 31 MB pak in RAM the way the PSP does, so its content build is not
// `cook` — it is `cook` two hundred and twenty two times, plus three steps
// that only make sense once all of them exist:
//
//   1. cook every map to its own pak (dist/voxelmon/paks_orig/)
//   2. hoist the pages they all share into one common.vxat, so the console
//      re-reads 7 MB once instead of 1 MB on every single map change
//      (tools/pak_share_atlas.py — 937 MB becomes 620 MB + 7 MB)
//   3. write the dataset and the map index they share, then lay the result
//      out under dist/voxelmon/sdcard/ exactly as the console wants it
//
// Step 3 is the one that bites. A single-map cook writes a gamedata.json
// pinned to that one map, so the dataset the game boots from has to be
// MERGED out of all of them: `cookedMaps` is every pak on disk, and the
// per-map fields a map only earns by being meshed (its cut-tree cells) come
// from that map's own cook. Ship one map's gamedata with everyone's paks
// and the game boots to a world with one map in it.
//
// The atlas page indices are positional, so gamedata.json, common.vxat and
// all 222 paks are ONE artifact. Never copy a subset across.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cook } from "../voxelmon/cook/cli.ts";
import { GEN_DIR, genMissingReason, loadGen, ROOT } from "../voxelmon/cook/data.ts";

const DIST = join(ROOT, "dist/voxelmon");
/** One pak per map, atlas not yet shared: the input to the hoist. */
const ORIG = join(DIST, "paks_orig");
/** The shared set — this is what actually ships. */
const PAKS = join(DIST, "paks");
/** The folder tree to drag onto the card. */
const CARD = join(DIST, "sdcard");
const CARD_PAKS = join(CARD, "3ds/voxelmon/paks");
const THREE_DSX = join(
  ROOT,
  "crates/pocketvoxel-3ds/target/armv6k-nintendo-3ds/release/pocketvoxel-3ds.3dsx",
);

interface GameData {
  cookedMaps?: string[];
  maps: Record<string, Record<string, unknown> & { index?: number }>;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function cook3ds(only?: string[]): Promise<number> {
  const missing = genMissingReason();
  if (missing) {
    console.error(`cook3ds: ${missing}`);
    return 1;
  }
  const gen = loadGen(GEN_DIR);
  const names = (only ?? Object.keys(gen.maps)).sort();
  if (names.length === 0) {
    console.error("cook3ds: no maps in the imported dataset");
    return 1;
  }

  // --- 1. one pak per map -------------------------------------------------
  mkdirSync(ORIG, { recursive: true });
  console.log(`cook3ds: cooking ${names.length} maps, one pak each`);
  // Every cook rewrites gamedata.json beside the pak, pinned to the map it
  // just cooked. Harvest that map's own record before the next one lands on
  // it; everything else in the file is global and the last writer is right.
  let merged: GameData | null = null;
  const perMap: Record<string, Record<string, unknown>> = {};
  let bytes = 0;
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    const out = join(ORIG, `${name}.vxpak`);
    const result = cook([name], out);
    bytes += result.pakBytes;
    const gd = JSON.parse(readFileSync(join(ORIG, "gamedata.json"), "utf8")) as GameData;
    if (gd.maps[name]) perMap[name] = gd.maps[name]!;
    merged = gd;
    if (i % 25 === 0 || i === names.length - 1) {
      console.log(`  [${i + 1}/${names.length}] ${name}`);
    }
  }
  if (!merged) {
    console.error("cook3ds: no gamedata came out of the cooks");
    return 1;
  }
  console.log(`  ${names.length} paks, ${mb(bytes)} before sharing`);
  if (only) {
    // Everything past here is inherently about the WHOLE set -- the hoist
    // reads every pak in the directory, and the dataset and the index are
    // lists of all of them. Run them off a subset and the card image comes
    // out claiming the game has two maps in it, which boots and is wrong.
    console.log("cook3ds: --only, so stopping after the cooks (no card image)");
    return 0;
  }

  // --- 2. hoist the shared pages -----------------------------------------
  // Deliberately the existing, tested byte transform rather than a second
  // implementation here: it rewrites already-cooked paks and checks itself
  // page for page against its input.
  rmSync(PAKS, { recursive: true, force: true });
  mkdirSync(PAKS, { recursive: true });
  console.log("cook3ds: hoisting the pages every map shares");
  const share = Bun.spawnSync(
    ["python3", "tools/pak_share_atlas.py", ORIG, PAKS, "--verify"],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (share.exitCode !== 0) {
    console.error(
      "cook3ds: the atlas hoist failed. It needs python3 on PATH — that is the" +
        " only thing in this pipeline that does.",
    );
    return share.exitCode ?? 1;
  }

  // --- 3. the dataset and the index they share ---------------------------
  merged.cookedMaps = names;
  for (const [name, record] of Object.entries(perMap)) merged.maps[name] = record;
  writeFileSync(join(PAKS, "gamedata.json"), JSON.stringify(merged));

  // index.txt is the console's map list: "<map id> <name>", and the id is
  // the ROM's own map index, NOT the line number -- the map browser loads by
  // it, so a list numbered any other way opens the wrong pak.
  const index = names
    .map((name) => {
      const id = merged!.maps[name]?.index;
      if (id === undefined) throw new Error(`no map index for ${name} in gamedata`);
      return `${id} ${name}`;
    })
    .join("\n");
  writeFileSync(join(PAKS, "index.txt"), `${index}\n`);
  console.log(`  gamedata.json + index.txt for ${names.length} maps`);

  // --- 4. the card ---------------------------------------------------------
  rmSync(CARD, { recursive: true, force: true });
  mkdirSync(CARD_PAKS, { recursive: true });
  cpSync(PAKS, CARD_PAKS, { recursive: true });
  if (existsSync(THREE_DSX)) {
    cpSync(THREE_DSX, join(CARD, "3ds/pocketvoxel-3ds.3dsx"));
  } else {
    console.log("  (no 3dsx built yet — `bun tools/voxel.ts 3ds` builds one)");
  }
  console.log(`cook3ds: card image ready at dist/voxelmon/sdcard/`);
  console.log("  copy the `3ds` folder inside it onto the ROOT of your SD card");
  return 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--only");
  const only = at >= 0 && args[at + 1] ? args[at + 1]!.split(",").filter(Boolean) : undefined;
  process.exit(await cook3ds(only));
}
