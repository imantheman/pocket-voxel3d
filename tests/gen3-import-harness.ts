// Shared harness for the gen3 (FireRed) importer tests and tools/gen3/stagecmp.ts:
// open the verified ROM, bind a recording cache, run a ported stage, and
// compare every file it wrote with gen1recomp's own output under LuaJIT
// (the reference cache, tools/gen3/full_extract.lua -> ~/gen3ref/frfull).
// PNGs compare by decoded pixels; everything else byte for byte.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { diskPath } from "../voxelmon/import/gen3/fsio.ts";
import { inflateSync } from "node:zlib";
import { memoryCache, CacheFs, type Cache } from "../voxelmon/import/gen3/cache.ts";
import { makeImports } from "../voxelmon/import/gen3/fsio.ts";
import { Rom } from "../voxelmon/import/gen3/rom.ts";
import { GameVersion } from "../voxelmon/import/gen3/game_version.ts";
import type { Imports } from "../voxelmon/import/gen3/revision_view.ts";

export const ROM_PATH = process.env.VOXELMON_FIRERED_ROM ?? join(homedir(), "roms/firered.gba");
export const REF_ROOT = process.env.GEN3_REF ?? join(homedir(), "gen3ref/frfull");
export const GBA_ROOT = "data/generated/gba";

export interface StageCtx {
  romBytes: Uint8Array;
  sha1: string;
  version: string;
  imports: Imports;
  rom: Rom;
  cache: Cache & { files: Map<string, string | Uint8Array> };
}

let romBytes: Uint8Array | undefined;
let romSha = "";

/** The ROM context, or undefined (and a reason) when there is no verified ROM or reference. */
export function stageCtx(): StageCtx | undefined {
  if (!existsSync(ROM_PATH) || !existsSync(REF_ROOT)) return undefined;
  if (!romBytes) {
    romBytes = new Uint8Array(readFileSync(ROM_PATH));
    romSha = createHash("sha1").update(romBytes).digest("hex");
  }
  const version = GameVersion.forSha1(romSha);
  if (!version) return undefined;
  GameVersion.set(version);
  const imports = makeImports(romBytes, romSha, version);
  const [rom, err] = Rom.open(imports, version);
  if (!rom) throw new Error(`rom open failed: ${err}`);
  const cache = memoryCache();
  CacheFs.bind(cache);
  return { romBytes, sha1: romSha, version, imports, rom, cache };
}

export const skipReason = (): string => `no verified FireRed ROM at ${ROM_PATH} or no reference cache at ${REF_ROOT}`;

function asBytes(v: string | Uint8Array): Uint8Array {
  return typeof v === "string" ? Uint8Array.from(Buffer.from(v, "latin1")) : v;
}

/** PNG -> {w, h, rgba} (8-bit RGBA / RGB / palette / gray, non-interlaced). */
export function decodePng(png: Uint8Array): { w: number; h: number; rgba: Uint8Array } {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let pos = 8, w = 0, h = 0, depth = 8, ctype = 6;
  const idat: Uint8Array[] = [];
  let plte: Uint8Array | undefined, trns: Uint8Array | undefined;
  while (pos < png.length) {
    const len = dv.getUint32(pos);
    const kind = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (kind === "IHDR") { w = dv.getUint32(pos + 8); h = dv.getUint32(pos + 12); depth = data[8]!; ctype = data[9]!; }
    else if (kind === "PLTE") plte = data;
    else if (kind === "tRNS") trns = data;
    else if (kind === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error(`decodePng: bit depth ${depth} not supported`);
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = ctype === 6 ? 4 : ctype === 2 ? 3 : ctype === 4 ? 2 : 1;
  const stride = w * bpp;
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= bpp ? px[y * stride + x - bpp]! : 0;
      const b = y > 0 ? px[(y - 1) * stride + x]! : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp]! : 0;
      let p: number;
      if (f === 0) p = v; else if (f === 1) p = v + a; else if (f === 2) p = v + b; else if (f === 3) p = v + ((a + b) >> 1);
      else { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      px[y * stride + x] = p & 255;
    }
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (ctype === 6) rgba.set(px.subarray(i * 4, i * 4 + 4), i * 4);
    else if (ctype === 2) { rgba.set(px.subarray(i * 3, i * 3 + 3), i * 4); rgba[i * 4 + 3] = 255; }
    else if (ctype === 3) { const k = px[i]!; rgba[i * 4] = plte![k * 3]!; rgba[i * 4 + 1] = plte![k * 3 + 1]!; rgba[i * 4 + 2] = plte![k * 3 + 2]!; rgba[i * 4 + 3] = trns && k < trns.length ? trns[k]! : 255; }
    else if (ctype === 0) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[i]!; rgba[i * 4 + 3] = 255; }
    else { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = px[i * 2]!; rgba[i * 4 + 3] = px[i * 2 + 1]!; }
  }
  return { w, h, rgba };
}

export interface Mismatch { path: string; why: string }

function firstDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function context(bytes: Uint8Array, at: number): string {
  const s = Buffer.from(bytes.subarray(Math.max(0, at - 60), at + 60)).toString("latin1");
  return JSON.stringify(s);
}

/** Compare every file the stage wrote (cache.files) with the reference. */
export function compareWrites(files: Map<string, string | Uint8Array>, only?: (path: string) => boolean): Mismatch[] {
  const bad: Mismatch[] = [];
  for (const [path, body] of files) {
    if (only && !only(path)) continue;
    const refPath = diskPath(REF_ROOT, path);
    if (!existsSync(refPath)) { bad.push({ path, why: "not in the reference (gen1recomp did not write it)" }); continue; }
    const ours = asBytes(body);
    const ref = new Uint8Array(readFileSync(refPath));
    if (path.endsWith(".png")) {
      try {
        const a = decodePng(ours), b = decodePng(ref);
        if (a.w !== b.w || a.h !== b.h) bad.push({ path, why: `png size ${a.w}x${a.h} != ${b.w}x${b.h}` });
        else {
          const d = firstDiff(a.rgba, b.rgba);
          if (d >= 0) bad.push({ path, why: `png pixel differs at px ${Math.floor(d / 4)} (x ${Math.floor(d / 4) % a.w}, y ${Math.floor(Math.floor(d / 4) / a.w)})` });
        }
      } catch (e) { bad.push({ path, why: `png decode: ${(e as Error).message}` }); }
      continue;
    }
    const d = firstDiff(ours, ref);
    if (d >= 0) bad.push({ path, why: `bytes differ at ${d} (ours ${ours.length}, ref ${ref.length})\n  ours ${context(ours, d)}\n  ref  ${context(ref, d)}` });
  }
  return bad;
}

/** Reference files under a cache-relative prefix (to see what a stage should write). */
export function referenceFiles(prefix: string): string[] {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  // paths are byte strings: read find's output as latin1, one char per byte
  const out = execFileSync("find", [join(REF_ROOT, prefix), "-type", "f"], { encoding: "latin1" });
  return out.split("\n").filter(Boolean).map((p) => p.slice(REF_ROOT.length + 1)).sort();
}

/** Seed the recording cache with reference files (inputs a stage reads that another stage writes). */
export function seedFromReference(cache: Cache, paths: string[]): void {
  for (const p of paths) {
    const full = diskPath(REF_ROOT, p);
    if (existsSync(full)) cache.write(p, readFileSync(full).toString("latin1"));
  }
}
