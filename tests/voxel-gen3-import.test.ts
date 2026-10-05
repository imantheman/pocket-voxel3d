// The gen3 (FireRed) importer against gen1recomp's own importer run under
// LuaJIT. ROM-gated: needs a verified FireRed ROM (VOXELMON_FIRERED_ROM, else
// ~/roms/firered.gba) and, for the byte compares, the reference cache made by
// tools/gen3/full_extract.lua (GEN3_REF, else /tmp/frfull).
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { RevisionView } from "../voxelmon/import/gen3/revision_view.ts";
import { Lz77 } from "../voxelmon/import/gen3/lz77.ts";
import { Base64 } from "../voxelmon/import/gen3/base64.ts";
import { LuaWriter } from "../voxelmon/import/gen3/lua_writer.ts";
import { CanonicalJson } from "../voxelmon/import/gen3/json.ts";
import { Versions } from "../voxelmon/import/gen3/versions.ts";

const ROM = process.env.VOXELMON_FIRERED_ROM ?? join(homedir(), "roms/firered.gba");
const FR10 = "41cb23d8dccc8ebd7c649cd8fbb58eeace6e2fdc";
const FR11 = "dd5945db9b930750cb39d00c84da8571feebf417";
const sha1 = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");
const rom = existsSync(ROM) ? new Uint8Array(readFileSync(ROM)) : undefined;
const romSha = rom ? sha1(rom) : "";
const haveRom = romSha === FR10 || romSha === FR11;
if (!haveRom) console.log(`voxel-gen3-import: skipping the FireRed ROM checks — no verified ROM at ${ROM}`);

describe("gen3 import foundation (no ROM)", () => {
  test("lz77 round trip through compressStore", () => {
    const payload = new Uint8Array(300).map((_, i) => (i * 7) & 255);
    const packed = new Uint8Array(Lz77.compressStore(payload));
    const [out, consumed] = Lz77.decompress(packed, 0);
    expect(Array.from(out)).toEqual(Array.from(payload));
    expect(consumed).toBe(packed.length);
  });

  test("base64 both ways", () => {
    for (const s of ["", "a", "ab", "abc", "\x00\xff\x10binary"]) {
      expect(Base64.decode(Base64.encode(s))[0]).toBe(s);
    }
  });

  test("LuaWriter and canonical JSON shapes", () => {
    expect(LuaWriter.encode({ b: 1, a: [1, 2], 3: "x", end: true })).toBe(
      'return {\n  [3] = "x",\n  a = {\n    1,\n    2,\n  },\n  b = 1,\n  ["end"] = true,\n}\n');
    expect(CanonicalJson.encode({ z: 0.5, a: [], m: {} })).toBe('{"a":[],"m":[],"z":0.5}');
  });

  test("versions: FireRed offsets, LeafGreen remap and back", () => {
    Versions.select(FR10);
    const fr = Versions.OW_GFX_POINTERS;
    expect(fr).toBe(0x39fdb0);
    Versions.select("574fa542ffebb14be69902d1d36f1ec0a4afd71e");
    const lg = Versions.OW_GFX_POINTERS;
    expect(typeof lg).toBe("number");
    Versions.select(FR11);
    expect(Versions.OW_GFX_POINTERS).toBe(fr);
  });
});

describe.skipIf(!haveRom)("gen3 import against the FireRed ROM", () => {
  test("a 1.1 ROM rebuilds into the same 1.0 layout as gen1recomp's RevisionView", () => {
    if (romSha !== FR11) return;
    const ours = RevisionView.apply(rom!, romSha);
    const out = "/tmp/gen3_revview.bin";
    execFileSync("luajit", [join(import.meta.dir, "../tools/gen3/revview_dump.lua"), ROM, romSha, out],
      { cwd: join(homedir(), "gen1recomp-latest") });
    expect(sha1(ours)).toBe(sha1(new Uint8Array(readFileSync(out))));
  }, 60000);
});
