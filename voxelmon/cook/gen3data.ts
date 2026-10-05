// pocket-voxel cook for the gen3 (FireRed) port (GPLv3 + additional terms;
// see voxelmon/game/gen3/LICENSE.md: it runs the gen3 platform's luaLoad and
// the importer port's readLuaLiteral).
//
// FireRed's cache for the 3DS card: the importer's tree
// (<cache>/data/generated/...) made into what the console loads fast.
//
//   bun voxelmon/cook/gen3data.ts [--cache DIR] [--out DIR] [--game firered|leafgreen] [--no-zip] [--loose]
//
// - **Lua literals are cooked** (import/gen3/cooked_data.ts): each `.lua`
//   becomes COOKED_TAG + JSON of its table in luaLoad's shape, which both
//   readers on the console take (luaLoad as is, readLuaLiteral converted).
//   (COOKED_STEPS_TAG where readLuaLiteral refuses the Lua, so it still
//   does). A file is cooked only when both readers give, from the cooked
//   text, exactly what they give from the Lua (checked here, file by file);
//   anything else stays Lua. JSON.parse reads them ~80x faster than the Lua
//   reader, into ~4x less heap.
// - **Big files are deflated** (unless --no-zip): ZIP_TAG + the raw length
//   (u32 LE) + a raw deflate stream, which the hosts inflate in their file
//   read (crates/pocketvoxel-3ds/src/gen3/g3_files.c, platform/desktop.ts).
//   PNGs are already deflated and stay as they are.
// - **One file** (unless --loose): the whole tree goes into <game>/data.pvpk
//   (import/gen3/card_pack.ts), because the console opens files slowly and
//   the card is filled over FTP, where 8000 small files cost far more than
//   their bytes.
// - **The sound is pre-built**: audio.m4ap, the host's M4AP blob
//   (cook/gen3audio_blob.ts, the Rust builder's twin), with a card key the
//   host takes as is (src/gen3/audio.rs), so the console never builds it.
//   The files only that builder reads (songs/*.bin, samples.bin,
//   samples.lua, voicegroups.lua) stay off the card.
//
// Output: <out>/<game>/data.pvpk + <out>/<game>/audio.m4ap(.key), <out>
// being the card's 3ds/voxelmon folder.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { evalData } from "../game/gen3/platform/luadata.ts";
import { readLuaLiteral } from "../import/gen3/asset_pack.ts";
import { COOKED_LIT_TAG, COOKED_STEPS_TAG, COOKED_TAG, luaShape, ZIP_TAG } from "../import/gen3/cooked_data.ts";
import { buildPack, PACK_NAME } from "../import/gen3/card_pack.ts";
import { buildBlob } from "./gen3audio_blob.ts";

function attempt(f: () => unknown): { ok: true; v: unknown } | { ok: false } {
  try { return { ok: true, v: f() }; } catch { return { ok: false }; }
}

/** Structural equality: -0 and NaN as Object.is, object keys in the same order (pairs order). */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const x = a as unknown[], y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!same(x[i] ?? null, y[i] ?? null)) return false;
    return true;
  }
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (!same((a as any)[ka[i]!], (b as any)[ka[i]!])) return false;
  }
  return true;
}

/**
 * A cache file's card form: the cooked text for a Lua literal both readers
 * agree on, else the source unchanged. `src` is a byte string.
 */
export function cookFile(path: string, src: string): string {
  if (!path.endsWith(".lua")) return src;
  const l = attempt(() => evalData(src, path));
  if (!l.ok) return src;
  const r = attempt(() => readLuaLiteral(src));
  // a chunk readLuaLiteral refuses keeps refusing (COOKED_STEPS_TAG); one
  // the importer's reader reads goes in its shape where luaLoad's comes back
  // exactly from it (COOKED_LIT_TAG)
  const lit = r.ok && LITERAL_READ.test(path) && same(luaShape(JSON.parse(JSON.stringify(r.v))), l.v);
  const out = lit ? COOKED_LIT_TAG + JSON.stringify(r.v)
    : (r.ok ? COOKED_TAG : COOKED_STEPS_TAG) + JSON.stringify(l.v);
  const l2 = attempt(() => evalData(out, path));
  if (!l2.ok || !same(l2.v, l.v)) return src;
  const r2 = attempt(() => readLuaLiteral(out));
  if (r.ok !== r2.ok) return src;
  if (r.ok && r2.ok && !same(r2.v, r.v)) return src;
  return out;
}

/**
 * The files readLuaLiteral reads at boot (encounters.ts, marts.ts), cooked
 * in its shape. (The script bundle is read with luaLoad: core/scripting/space.ts.)
 */
const LITERAL_READ = /(^|\/)data\/generated\/gba\/(scripts\/marts\.lua|encounters\.lua)$/;

/**
 * audio/index.lua for the card: without `samples`, `voicegroups` and `cries`
 * (1 MB of its 1.2), which only the host's blob builder reads (audio.m4ap is
 * built from the full file); the guest's core/audio.ts loadPack drops those
 * three keys straight after loading.
 */
export function cookAudioIndex(src: string): string {
  const v = evalData(src, "audio/index.lua") as Record<string, unknown>;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return src;
  const slim: Record<string, unknown> = {};
  for (const k of Object.keys(v)) if (k !== "samples" && k !== "voicegroups" && k !== "cries") slim[k] = v[k];
  return COOKED_TAG + JSON.stringify(slim);
}

/** Deflate when it pays: ZIP_TAG form, or undefined. */
export function zipFile(bytes: Uint8Array): Buffer | undefined {
  if (bytes.length < 2048) return undefined;
  const z = deflateRawSync(bytes, { level: 9 });
  if (z.length + 9 > bytes.length * 0.85) return undefined;
  const head = Buffer.alloc(9);
  head.write(ZIP_TAG, 0, "latin1");
  head.writeUInt32LE(bytes.length, 5);
  return Buffer.concat([head, z]);
}

/** Cache files only the host's blob builder reads (relative to data/generated/gba/audio). */
const HOST_AUDIO_ONLY = /^(songs\/.*|samples\.bin|samples\.lua|voicegroups\.lua)$/;
const AUDIO = "data/generated/gba/audio/";

/** The key audio.rs takes for a blob the card cook made (it does not look at the cache). */
export const CARD_AUDIO_KEY = "M4AP1 card\n";

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** The M4AP blob from the cache's audio folder (the host's build_blob). */
export function audioBlob(audioDir: string): Uint8Array {
  const rd = (n: string): Uint8Array | undefined => (existsSync(join(audioDir, n)) ? readFileSync(join(audioDir, n)) : undefined);
  const index = rd("index.lua");
  if (!index) throw new Error(`gen3data: no ${join(audioDir, "index.lua")}`);
  const songs: [number, Uint8Array][] = [];
  if (existsSync(join(audioDir, "songs"))) {
    for (const n of readdirSync(join(audioDir, "songs"))) {
      const m = /^(\d+)\.bin$/.exec(n);
      if (m) songs.push([Number(m[1]), readFileSync(join(audioDir, "songs", n))]);
    }
  }
  songs.sort((a, b) => a[0] - b[0]);
  return buildBlob(index, rd("samples.lua"), rd("voicegroups.lua"), rd("samples.bin") ?? new Uint8Array(0), songs);
}

export interface CardStats { files: number; cooked: number; kept: number; zipped: number; skipped: number; bytesIn: number; bytesOut: number }

/**
 * Cook the cache at `cache` (the folder holding data/) into `out`/<game>
 * (`out` = the card's 3ds/voxelmon folder).
 */
export function cookCard(cache: string, out: string, opts: { game?: string; zip?: boolean; loose?: boolean; log?: (s: string) => void } = {}): CardStats {
  const log = opts.log ?? console.log;
  const zip = opts.zip ?? true;
  const game = opts.game ?? "firered";
  const srcData = join(cache, "data");
  if (!existsSync(join(srcData, "generated/gba/native/manifest.lua"))) throw new Error(`gen3data: no gen3 cache at ${cache}`);
  const dir = join(out, game);
  mkdirSync(dir, { recursive: true });
  rmSync(join(dir, "data"), { recursive: true, force: true });
  rmSync(join(dir, PACK_NAME), { force: true });
  const st: CardStats = { files: 0, cooked: 0, kept: 0, zipped: 0, skipped: 0, bytesIn: 0, bytesOut: 0 };
  const t0 = performance.now();
  const files: { name: string; data: Uint8Array }[] = [];
  for (const p of walk(srcData)) {
    const rel = relative(cache, p).replace(/\\/g, "/");
    let bytes: Uint8Array = readFileSync(p);
    st.bytesIn += bytes.length;
    if (rel.startsWith(AUDIO) && HOST_AUDIO_ONLY.test(rel.slice(AUDIO.length))) { st.skipped++; continue; }
    st.files++;
    if (rel.endsWith(".lua")) {
      const src = Buffer.from(bytes).toString("latin1");
      const cooked = rel === AUDIO + "index.lua" ? cookAudioIndex(src) : cookFile(rel, src);
      if (cooked !== src) { st.cooked++; bytes = Buffer.from(cooked, "latin1"); }
      else { st.kept++; log(`gen3data: kept as Lua: ${rel}`); }
    }
    if (zip && !rel.endsWith(".png")) {
      const z = zipFile(bytes);
      if (z) { bytes = z; st.zipped++; }
    }
    st.bytesOut += bytes.length;
    // the runtime's byte-string path: the file name's UTF-8 bytes, one char each
    const name = Buffer.from(rel, "utf8").toString("latin1");
    if (opts.loose) {
      const dst = join(dir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, bytes);
    } else files.push({ name, data: bytes });
  }
  if (!opts.loose) {
    const parts = buildPack(files);
    const fd = openSync(join(dir, PACK_NAME), "w");
    try { for (const b of parts) writeSync(fd, b); } finally { closeSync(fd); }
    st.bytesOut += parts[0]!.length;
  }
  log(`gen3data: ${st.files} files (${st.cooked} Lua cooked, ${st.kept} kept, ${st.zipped} deflated, ${st.skipped} host-only left off) ` +
    `${(st.bytesIn / 1e6).toFixed(1)} MB -> ${(st.bytesOut / 1e6).toFixed(1)} MB${opts.loose ? " loose" : " in " + PACK_NAME}, ${((performance.now() - t0) / 1000).toFixed(1)} s`);

  const t1 = performance.now();
  const blob = audioBlob(join(srcData, "generated/gba/audio"));
  writeFileSync(join(dir, "audio.m4ap"), blob);
  writeFileSync(join(dir, "audio.m4ap.key"), CARD_AUDIO_KEY + readFileSync(join(srcData, "generated/gba/audio/meta.json"), "utf8"));
  st.bytesOut += blob.length;
  log(`gen3data: audio.m4ap ${(blob.length / 1024).toFixed(0)} KB in ${((performance.now() - t1) / 1000).toFixed(1)} s`);
  return st;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const cache = opt("--cache") ?? join(homedir(), "gen3ref/frfull");
  const out = opt("--out") ?? join(import.meta.dir, "../../dist/voxelmon/card_firered/3ds/voxelmon");
  const st = cookCard(cache, out, { game: opt("--game"), zip: !args.includes("--no-zip"), loose: args.includes("--loose") });
  console.log(`gen3data: ${out} (${(st.bytesOut / 1e6).toFixed(1)} MB)`);
}
