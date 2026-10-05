// The whole gen3 (FireRed) import end to end: runImportGen3 (gen1recomp's
// RomExtractorGen3 plan, voxelmon/import/gen3/index.ts) imports the ROM into
// a temp directory, and EVERY file there is compared with gen1recomp's own
// run under LuaJIT (~/gen3ref/frfull, tools/gen3/full_extract.lua): bytes,
// PNGs by decoded pixels. Every reference file must be written, and nothing
// the reference lacks. ROM-gated.
//
// Allowed differences (ALLOW below):
// - not ported (minigames): berry_crush/, dodrio_berry_picking/ and
//   pokemon_jump/ -- berry_crush_extract, dodrio_extract and
//   pokemon_jump_extract are not ported (64 reference files).
// - No timestamps: gen1recomp's run writes none (meta.json and the five
//   extract_status.json files hold no time), so nothing is normalised.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng, REF_ROOT, ROM_PATH, skipReason } from "./gen3-import-harness.ts";
import { runImportGen3, sha1Hex, gen3VersionForSha1 } from "../voxelmon/import/gen3/index.ts";
import { diskPath } from "../voxelmon/import/gen3/fsio.ts";

const haveRom = existsSync(ROM_PATH) && existsSync(REF_ROOT);
const rom = haveRom ? new Uint8Array(readFileSync(ROM_PATH)) : undefined;
const ready = !!rom && gen3VersionForSha1(sha1Hex(rom)) !== undefined;
if (!ready) console.log(`voxel-gen3-import-full: skipping -- ${skipReason()}`);

const GBA = "data/generated/gba/";
/** Reference files the port does not write, and why. */
const ALLOW: [RegExp, string][] = [
  [new RegExp("^" + GBA + "(berry_crush|dodrio_berry_picking|pokemon_jump)/"), "not ported (minigames)"],
];
const allowed = (p: string): string | undefined => ALLOW.find(([re]) => re.test(p))?.[1];

/** Every file under root, as cache-relative byte-string paths (find, read as latin1). */
function listFiles(root: string): string[] {
  const out = execFileSync("find", [root, "-type", "f"], { encoding: "latin1", maxBuffer: 1 << 28 });
  return out.split("\n").filter(Boolean).map((p) => p.slice(root.length + 1)).sort();
}

function firstDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

describe.skipIf(!ready)("gen3 import end to end against the reference", () => {
  test("runImportGen3 writes every reference file, identical", () => {
    const out = mkdtempSync(join(tmpdir(), "gen3-full-"));
    try {
      const res = runImportGen3({ rom: rom!, outDir: out });
      console.log(`voxel-gen3-import-full: import ${(res.ms / 1000).toFixed(1)} s (`
        + res.stages.map((s) => `${s.name} ${(s.ms / 1000).toFixed(1)} s`).join(", ") + ")");
      expect(res.extractOk && res.pokemonOk && res.auxOk).toBe(true);

      const ref = listFiles(REF_ROOT);
      const ours = new Set(listFiles(out));
      const bad: string[] = [];
      const allowedHits: Record<string, number> = {};
      let compared = 0, pngs = 0;
      for (const p of ref) {
        if (!ours.has(p)) {
          const why = allowed(p);
          if (why) allowedHits[why] = (allowedHits[why] ?? 0) + 1;
          else bad.push(`${p}: not written`);
          continue;
        }
        ours.delete(p);
        const a = new Uint8Array(readFileSync(diskPath(out, p)));
        const b = new Uint8Array(readFileSync(diskPath(REF_ROOT, p)));
        compared++;
        if (p.endsWith(".png")) {
          pngs++;
          try {
            const x = decodePng(a), y = decodePng(b);
            if (x.w !== y.w || x.h !== y.h) bad.push(`${p}: png ${x.w}x${x.h} != ${y.w}x${y.h}`);
            else if (firstDiff(x.rgba, y.rgba) >= 0) bad.push(`${p}: png pixel ${Math.floor(firstDiff(x.rgba, y.rgba) / 4)} differs`);
          } catch (e) { bad.push(`${p}: png decode: ${(e as Error).message}`); }
          continue;
        }
        const d = firstDiff(a, b);
        if (d >= 0) {
          const ctx = (u: Uint8Array): string => JSON.stringify(Buffer.from(u.subarray(Math.max(0, d - 40), d + 40)).toString("latin1"));
          bad.push(`${p}: bytes differ at ${d} (ours ${a.length}, ref ${b.length})\n  ours ${ctx(a)}\n  ref  ${ctx(b)}`);
        }
      }
      for (const p of ours) bad.push(`${p}: not in the reference`);
      if (bad.length) console.log(`${bad.length} differences:\n` + bad.slice(0, 30).join("\n"));
      console.log(`voxel-gen3-import-full: ${ref.length} reference files; ${compared} compared (${pngs} PNGs by pixels), `
        + `identical; allowed: ${JSON.stringify(allowedHits)}`);
      expect(bad).toEqual([]);
      expect(compared + Object.values(allowedHits).reduce((s, n) => s + n, 0)).toBe(ref.length);
      expect(allowedHits["not ported (minigames)"]).toBe(64);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 600_000);
});
