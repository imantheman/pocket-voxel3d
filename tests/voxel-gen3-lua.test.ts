// import/gen3/lua.ts against LuaJIT's own answers (tests/gen3-luafmt.jsonl,
// printed by tools/gen3/luafmt_cases.lua): the gen3 importer's cache files are
// byte-compared with LuaJIT's, so its formatting must agree exactly.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { format, numberToString, sub, byte, char, sortedKeys } from "../voxelmon/import/gen3/lua.ts";

// JSON strings decode to UTF-16; the cases are byte strings (all chars < 256)
const cases = readFileSync(join(import.meta.dir, "gen3-luafmt.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l) as [string, number | string, string | null]);

describe("gen3 lua.ts matches LuaJIT", () => {
  test(`string.format: ${cases.filter((c) => c[0] !== "tostring").length} cases`, () => {
    const bad: string[] = [];
    for (const [fmt, arg, want] of cases) {
      if (fmt === "tostring" || want === null) continue;
      let got: string;
      try { got = format(fmt, arg); } catch (e) { got = `THREW ${(e as Error).message}`; }
      if (got !== want) bad.push(`${JSON.stringify(fmt)} ${JSON.stringify(arg)}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
    }
    expect(bad).toEqual([]);
  });

  test("tostring(number)", () => {
    const bad: string[] = [];
    for (const [fmt, arg, want] of cases) {
      if (fmt !== "tostring") continue;
      const n = arg === "inf" ? Infinity : arg === "-inf" ? -Infinity : (arg as number);
      const got = numberToString(n);
      if (got !== want) bad.push(`${arg}: ${got} != ${want}`);
    }
    expect(bad).toEqual([]);
  });

  test("byte-string helpers", () => {
    expect(sub("hello", 2, 3)).toBe("el");
    expect(sub("hello", -3)).toBe("llo");
    expect(sub("hello", 0)).toBe("hello");
    expect(byte("A\xff", 2)).toBe(255);
    expect(byte("A", 5)).toBeUndefined();
    expect(char(72, 105, 0x1ff)).toBe("Hi\xff");
    expect(sortedKeys({ b: 1, 10: 1, 2: 1, a: 1 })).toEqual(["2", "10", "a", "b"]);
  });
});
