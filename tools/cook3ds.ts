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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cook } from "../voxelmon/cook/cli.ts";
import { GEN_DIR, genMissingReason, loadGen, ROOT } from "../voxelmon/cook/data.ts";
import { activeVersion, type GameVersion, missingInputReason, resolveEnv } from "../voxelmon/import/env.ts";
import { runImport } from "../voxelmon/import/index.ts";

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

/**
 * What each game keeps for itself inside the shared paks folder. Red and
 * Blue cook to the SAME map paks, common.vxat and index.txt, so a player
 * with both games carries one set. Measured by cooking both ROMs and
 * comparing all 222 paks: the page layout is identical, and what differs is
 * five atlas pages (the title ribbon, Blue's Jigglypuff in place of Red's
 * Nidorino in the three intro frames, and the UI page, which carries the
 * slot machine's reel symbols), the palette table (Blue's logo and slot
 * palettes) and the sound programs. Each game adds its own dataset and an
 * overlay holding exactly those. Red keeps the name its dataset has always
 * had.
 */
export const VERSION_FILES: Record<GameVersion, { gamedata: string; overlay: string; threeDsx: string }> = {
  red: { gamedata: "gamedata.json", overlay: "version_red.vxat", threeDsx: "pocketvoxel-3ds.3dsx" },
  blue: { gamedata: "gamedata_blue.json", overlay: "version_blue.vxat", threeDsx: "pocketvoxel-3ds-blue.3dsx" },
};

const SHARED_BIT = 0x80000000;

/**
 * The maps whose sound stays in the pak: the host boots on REDS_HOUSE_2F
 * (PALLET_TOWN if that will not load) and takes the sound from it only when
 * no overlay carries any.
 */
const BOOT_MAPS = ["REDS_HOUSE_2F", "PALLET_TOWN"];

/**
 * Cut out of every shipped pak what the 3DS never reads -- 45% of the set.
 *
 *  - GAME: a full copy of the dataset in every pak (the PSP build's single
 *    pak boots from it). The 3DS reads the dataset from gamedata*.json and
 *    skips this section when it loads a pak (main.rs map_pak/prefetch):
 *    ~1.2 MB x 222 maps.
 *  - AUDI: the sound programs, the same bytes in every pak. The host takes
 *    them once, at boot, from the game's own overlay (which writeOverlay
 *    has already copied out of a pak), falling back to the boot map's.
 *    Every pak but the boot maps drops them.
 *
 * pak.rs allows both sections to be empty. The payloads after them are
 * re-laid 16-aligned in their original order, the section table and the
 * header's total length follow, and nothing else in the file changes.
 * Returns bytes before and after.
 */
export function stripUnread(paksDir: string): { before: number; after: number } {
  let before = 0;
  let after = 0;
  const names = readdirSync(paksDir).filter((f) => f.endsWith(".vxpak"));
  for (const f of names) {
    const path = join(paksDir, f);
    const d = readFileSync(path);
    before += d.length;
    const keepAudio = BOOT_MAPS.includes(f.replace(/\.vxpak$/, ""));
    const n = d.readUInt16LE(6);
    const secs = [];
    for (let s = 0; s < n; s++) {
      const e = 16 + s * 16;
      secs.push({ i: s, tag: d.toString("latin1", e, e + 4), off: d.readUInt32LE(e + 4), len: d.readUInt32LE(e + 8) });
    }
    const table = 16 + n * 16;
    const out = Buffer.from(d.subarray(0, table));
    const parts: Buffer[] = [out];
    let at = table;
    for (const s of [...secs].sort((a, b) => a.off - b.off)) {
      const cut = s.tag === "GAME" || (s.tag === "AUDI" && !keepAudio);
      const body = cut ? Buffer.alloc(0) : d.subarray(s.off, s.off + s.len);
      const pad = (16 - (at % 16)) % 16;
      if (pad) parts.push(Buffer.alloc(pad));
      at += pad;
      out.writeUInt32LE(at, 16 + s.i * 16 + 4);
      out.writeUInt32LE(body.length, 16 + s.i * 16 + 8);
      parts.push(body);
      at += body.length;
    }
    const pad = (16 - (at % 16)) % 16;
    if (pad) parts.push(Buffer.alloc(pad));
    at += pad;
    out.writeUInt32LE(at, 8); // header total_len
    const file = Buffer.concat(parts);
    writeFileSync(path, file);
    after += file.length;
  }
  return { before, after };
}

/** The atlas pages whose art differs between Red and Blue (measured, see
 * VERSION_FILES): the title ribbon, the intro's three fighter frames, and
 * the UI page with the slot reel symbols. */
export function versionPages(gd: unknown): number[] {
  const a = (gd as { atlas?: { picTitle?: Record<string, number>; picIntro?: Record<string, number>; uiPage?: number } })
    .atlas ?? {};
  return [a.uiPage, a.picTitle?.version, a.picIntro?.nido1, a.picIntro?.nido2, a.picIntro?.nido3]
    .filter((p): p is number => typeof p === "number" && p >= 0);
}

/**
 * The version overlay (paks/version_<v>.vxat): what this game has that the
 * other does not, which the console swaps in over the shared set
 * (crates/pocketvoxel-3ds main.rs apply_overlay): the listed atlas pages as
 * it reads each pak, the palette table likewise, and the sound at boot.
 *
 *   "VXVO" u16 format(2) u16 count  u32 vpalLen  u32 audiLen
 *   count x { u16 page, w, h, kind, frames, 0; u32 frameLen }
 *   then each page's texels (frameLen * frames), 16-aligned
 *   then the VPAL section verbatim (16-aligned), then AUDI verbatim
 *
 * Everything is copied byte for byte out of a cooked pak (resolving a
 * shared page against common.vxat, as pak.rs does), so the overlay is
 * exactly what this game's own cook of the set carries.
 */
export function writeOverlay(paksDir: string, pages: number[], out: string): number {
  const pakName = readFileSync(join(paksDir, "index.txt"), "utf8").split("\n")[0]!.split(" ")[1]!;
  const d = readFileSync(join(paksDir, `${pakName}.vxpak`));
  const common = existsSync(join(paksDir, "common.vxat")) ? readFileSync(join(paksDir, "common.vxat")) : null;
  const nsec = d.readUInt16LE(6);
  let atls = -1;
  const section: Record<string, Buffer> = {};
  for (let s = 0; s < nsec; s++) {
    const e = 16 + s * 16;
    const tag = d.toString("latin1", e, e + 4);
    const off = d.readUInt32LE(e + 4);
    section[tag] = d.subarray(off, off + d.readUInt32LE(e + 8));
    if (tag === "ATLS") atls = off;
  }
  const vpal = section.VPAL ?? Buffer.alloc(0);
  const audi = section.AUDI ?? Buffer.alloc(0);
  if (atls < 0) throw new Error(`no ATLS section in ${pakName}.vxpak`);
  const n = d.readUInt16LE(atls);
  const entries: Buffer[] = [];
  const blobs: Buffer[] = [];
  for (const page of pages) {
    if (page < 0 || page >= n) throw new Error(`overlay page ${page} is not in the atlas (${n} pages)`);
    const p = atls + 2 + page * 16;
    const [w, h, kind, frames] = [0, 2, 4, 6].map((o) => d.readUInt16LE(p + o)) as [number, number, number, number];
    const off = d.readUInt32LE(p + 8);
    const frameLen = d.readUInt32LE(p + 12);
    const total = frameLen * frames;
    const shared = (off & SHARED_BIT) !== 0;
    const at = off & ~SHARED_BIT & 0x7fffffff;
    const src = shared ? common : d.subarray(atls);
    if (!src) throw new Error(`page ${page} is shared but there is no common.vxat`);
    const e = Buffer.alloc(16);
    e.writeUInt16LE(page, 0);
    e.writeUInt16LE(w, 2);
    e.writeUInt16LE(h, 4);
    e.writeUInt16LE(kind, 6);
    e.writeUInt16LE(frames, 8);
    e.writeUInt32LE(frameLen, 12);
    entries.push(e);
    blobs.push(Buffer.from(src.subarray(at, at + total)));
  }
  const head = Buffer.alloc(16);
  head.write("VXVO", 0, "latin1");
  head.writeUInt16LE(2, 4);
  head.writeUInt16LE(pages.length, 6);
  head.writeUInt32LE(vpal.length, 8);
  head.writeUInt32LE(audi.length, 12);
  const parts: Buffer[] = [head, ...entries];
  let len = 16 + entries.length * 16;
  for (const b of [...blobs, vpal, audi]) {
    const pad = (16 - (len % 16)) % 16;
    parts.push(Buffer.alloc(pad), b);
    len += pad + b.length;
  }
  const file = Buffer.concat(parts);
  writeFileSync(out, file);
  return file.length;
}

interface GameData {
  cookedMaps?: string[];
  maps: Record<string, Record<string, unknown> & { index?: number }>;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function cook3ds(only?: string[]): Promise<number> {
  // The importer first, when its output is not there. The cooker app
  // (cooker/) runs this one command and nothing else, so it has to be able
  // to start from a bare ROM.
  if (genMissingReason()) {
    const env = resolveEnv();
    const why = missingInputReason(env);
    if (why) {
      console.error(`cook3ds: ${why}`);
      return 1;
    }
    console.log("cook3ds: importing the ROM into dist/voxelmon/gen/");
    await runImport(env);
  }
  const missing = genMissingReason();
  if (missing) {
    console.error(`cook3ds: ${missing}`);
    return 1;
  }
  const gen = loadGen(GEN_DIR);
  const version = activeVersion();
  const files = VERSION_FILES[version];
  console.log(`cook3ds: ${version === "blue" ? "Blue" : "Red"} (${GEN_DIR})`);
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
  // The other game's own files survive this cook: the shared set is the
  // same whichever ROM made it, so what the other game cooked still fits.
  const keep = new Map<string, Buffer>();
  for (const [v, f] of Object.entries(VERSION_FILES)) {
    if (v === version) continue;
    for (const name of [f.gamedata, f.overlay]) {
      if (existsSync(join(PAKS, name))) keep.set(name, readFileSync(join(PAKS, name)));
    }
  }
  rmSync(PAKS, { recursive: true, force: true });
  mkdirSync(PAKS, { recursive: true });
  for (const [name, bytes] of keep) writeFileSync(join(PAKS, name), bytes);
  console.log("cook3ds: hoisting the pages every map shares");
  // VOXELMON_PYTHON names the interpreter when "python3" is not the one on
  // PATH -- on Windows it is "python", and the cooker app has its own.
  const python = process.env.VOXELMON_PYTHON ?? "python3";
  const share = Bun.spawnSync(
    [python, "tools/pak_share_atlas.py", ORIG, PAKS, "--verify"],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (share.exitCode !== 0) {
    console.error(
      `cook3ds: the atlas hoist failed. It needs ${python} to run — that is the` +
        " only thing in this pipeline that needs Python (set VOXELMON_PYTHON).",
    );
    return share.exitCode ?? 1;
  }

  // --- 3. the dataset and the index they share ---------------------------
  merged.cookedMaps = names;
  for (const [name, record] of Object.entries(perMap)) merged.maps[name] = record;
  writeFileSync(join(PAKS, files.gamedata), JSON.stringify(merged));

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
  console.log(`  ${files.gamedata} + index.txt for ${names.length} maps`);

  // This game's own pages, palettes and sound, which the other game's
  // cook of the shared set would get wrong.
  const own = versionPages(merged);
  const n = writeOverlay(PAKS, own, join(PAKS, files.overlay));
  console.log(`  ${files.overlay}: pages ${own.join(", ")} + palettes + sound (${n} bytes)`);

  // After the overlay has its copy of the sound: what the 3DS never reads.
  const cut = stripUnread(PAKS);
  console.log(`  cut what the 3DS never reads: ${mb(cut.before)} -> ${mb(cut.after)}`);

  // --- 4. the card ---------------------------------------------------------
  rmSync(CARD, { recursive: true, force: true });
  mkdirSync(CARD_PAKS, { recursive: true });
  cpSync(PAKS, CARD_PAKS, { recursive: true });
  // make_cia.sh's copy carries the game's own name and icon; cargo-3ds's
  // (Red only) is the fallback.
  const dsx = [join(DIST, files.threeDsx), ...(version === "red" ? [THREE_DSX] : [])].find((p) => existsSync(p));
  if (dsx) cpSync(dsx, join(CARD, "3ds", files.threeDsx));
  console.log(`cook3ds: card image ready at dist/voxelmon/sdcard/3ds/`);
  console.log(`  copy \`voxelmon\`${dsx ? ` and \`${files.threeDsx}\`` : ""} into your SD card's own 3ds folder`);
  return 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--only");
  const only = at >= 0 && args[at + 1] ? args[at + 1]!.split(",").filter(Boolean) : undefined;
  process.exit(await cook3ds(only));
}
