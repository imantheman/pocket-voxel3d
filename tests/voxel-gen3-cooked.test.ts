// The 3DS card's cooked cache (voxelmon/cook/gen3data.ts):
// - for every Lua-literal file in the reference cache, both readers -- the
//   runtime's luaLoad and the importer's readLuaLiteral -- give the same
//   value from the cooked text as from the Lua source;
// - the card pack reads back as the loose tree (desktop host);
// - the TypeScript sound-blob builder matches the Rust one byte for byte
//   (where cargo is at hand).
// The cache tests are gated on the reference cache.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { evalData } from "../voxelmon/game/gen3/platform/luadata.ts";
import { readLuaLiteral } from "../voxelmon/import/gen3/asset_pack.ts";
import { audioBlob, cookFile, zipFile } from "../voxelmon/cook/gen3data.ts";
import { buildPack } from "../voxelmon/import/gen3/card_pack.ts";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { Json } from "../voxelmon/game/gen3/shared/link/Json.ts";

const ROOT = join(homedir(), "gen3ref/frfull/data/generated/gba");
const REPO = join(import.meta.dir, "..");

function filesOf(dir: string, ext: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) filesOf(p, ext, out);
    else if (n.endsWith(ext)) out.push(p);
  }
  return out;
}
const luaFiles = (dir: string): string[] => filesOf(dir, ".lua");

function attempt(f: () => unknown): { ok: true; v: unknown } | { ok: false } {
  try { return { ok: true, v: f() }; } catch { return { ok: false }; }
}

describe.skipIf(!existsSync(ROOT))("gen3 cooked cache files", () => {
  test("cookFile keeps both readers' values for every .lua in the cache", () => {
    const files = luaFiles(ROOT);
    expect(files.length).toBeGreaterThan(100);
    let cooked = 0;
    for (const p of files) {
      const src = readFileSync(p).toString("latin1");
      const out = cookFile(p, src);
      if (out === src) continue; // kept as Lua
      cooked++;
      const name = p.slice(ROOT.length + 1);
      const a = attempt(() => evalData(src, name)), b = attempt(() => evalData(out, name));
      expect(b.ok).toBe(a.ok);
      if (a.ok && b.ok) expect([name, b.v]).toStrictEqual([name, a.v]);
      const c = attempt(() => readLuaLiteral(src)), d = attempt(() => readLuaLiteral(out));
      expect([name, d.ok]).toStrictEqual([name, c.ok]);
      if (c.ok && d.ok) expect([name, d.v]).toStrictEqual([name, c.v]);
    }
    expect(cooked).toBeGreaterThan(100);
  }, 120_000);
});

describe.skipIf(!existsSync(ROOT))("gen3 Json.decode fast path", () => {
  test("JSON.parse-backed decode equals the port's for every .json in the cache", () => {
    const files = filesOf(ROOT, ".json");
    expect(files.length).toBeGreaterThan(400);
    for (const p of files) {
      const s = readFileSync(p).toString("latin1");
      // trailing text: JSON.parse refuses it, so the port reads this one (and ignores the tail)
      expect([p, Json.decode(s)]).toStrictEqual([p, Json.decode(s + " x")]);
    }
  });
  test("the port's quirks survive: nulls skipped in arrays, dropped in objects", () => {
    expect(Json.decode('[1,null,2]')).toStrictEqual([[null, 1, 2]]);
    expect(Json.decode('{"a":null,"b":[]}')).toStrictEqual([{ b: [null] }]);
    expect(Json.decode('null')).toStrictEqual([undefined]);
    expect(Json.decode('"\\u00e9"')).toStrictEqual(["\xC3\xA9"]);
  });
});

describe("gen3 card pack", () => {
  test("the desktop host reads a pack as the loose tree: files, directories, deflated files, byte-string names", () => {
    const dir = mkdtempSync(join(tmpdir(), "pvpk-"));
    try {
      const big = Buffer.alloc(10000, 7);
      // a byte-string path, as the runtime holds a UTF-8 file name
      const name = Buffer.from("data/generated/gba/pokemon/nidoran♂.rgba", "utf8").toString("latin1");
      const parts = buildPack([
        { name: "data/generated/gba/a.lua", data: Buffer.from("return {1}") },
        { name, data: zipFile(big)! },
        { name: "data/generated/intro.lua", data: Buffer.from("x") },
      ]);
      writeFileSync(join(dir, "data.pvpk"), Buffer.concat(parts));
      const h = new DesktopHost(dir);
      expect(h.read("data/generated/gba/a.lua")).toBe("return {1}");
      expect(h.read(name)).toBe(big.toString("latin1"));
      expect(h.read("data/generated/gba/b.lua")).toBeUndefined();
      expect(h.exists("data/generated/gba")).toBe(true);
      expect(h.exists("data/generated/gba/pokemon")).toBe(true);
      expect(h.exists("data/generated/gb")).toBe(false);
      expect(h.exists("data/generated/intro.lua")).toBe(true);
      h.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const CARGO = Bun.which("cargo");
describe.skipIf(!existsSync(join(ROOT, "audio/index.lua")) || !CARGO)("gen3 card sound blob", () => {
  test("gen3audio_blob.ts builds the Rust builder's blob byte for byte", () => {
    const dir = mkdtempSync(join(tmpdir(), "m4ap-"));
    try {
      const out = join(dir, "rust.m4ap");
      execFileSync(CARGO!, ["run", "--quiet", "--release", "--features", "gen3", "--example", "g3_m4ap", "--", join(ROOT, "audio"), out],
        { cwd: join(REPO, "crates/pocketvoxel-core"), stdio: "ignore" });
      const rust = readFileSync(out);
      const ts = audioBlob(join(ROOT, "audio"));
      expect(ts.length).toBe(rust.length);
      expect(Buffer.compare(Buffer.from(ts), rust)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
