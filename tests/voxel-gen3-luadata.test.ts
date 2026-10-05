// The gen3 runtime's data-chunk loader and Lua table helpers.
// Against luajit: every .lua file in the reference cache evaluates to the
// same table luajit builds (canonical form), and the cooked form round-trips.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cookData, evalData, luaLoad } from "../voxelmon/game/gen3/platform/luadata.ts";
import { concat, insert, ipairs, len, pairs, remove, seq, sort } from "../voxelmon/game/gen3/platform/lt.ts";

const ROOT = join(homedir(), "gen3ref/frfull");
const haveRef = existsSync(ROOT);

function fmt17(n: number): string {
  if (n !== n) return '"nan"';
  if (n === Infinity) return '"inf"';
  if (n === -Infinity) return '"-inf"';
  if (Number.isInteger(n) && Math.abs(n) < 2 ** 53) return String(n);
  // %.17g
  let s = n.toPrecision(17);
  if (s.includes("e")) {
    const [m, e] = s.split("e");
    let mm = m!.includes(".") ? m!.replace(/0+$/, "").replace(/\.$/, "") : m!;
    const ee = Number(e);
    s = `${mm}e${ee < 0 ? "-" : "+"}${String(Math.abs(ee)).padStart(2, "0")}`;
  } else if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}
function canon(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "number") return fmt17(v);
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") {
    return '"' + v.replace(/[\x00-\x1f"\\\x7f-\xff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) + '"';
  }
  const entries: [string, unknown][] = [];
  for (const [k, x] of pairs(v)) entries.push([typeof k === "number" ? fmt17(k) : k, x]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return "{" + entries.map(([k, x]) => canon(k) + ":" + canon(x)).join(",") + "}";
}
function luaFiles(d: string, out: string[] = []): string[] {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) luaFiles(p, out);
    else if (n.endsWith(".lua")) out.push(p);
  }
  return out;
}

describe("gen3 lua tables (lt.ts)", () => {
  test("sequences keep Lua indices", () => {
    const t = seq("a", "b", "c");
    expect(t[1]).toBe("a");
    expect(len(t)).toBe(3);
    insert(t, "d");
    insert(t, 1, "z");
    expect(concat(t, ",")).toBe("z,a,b,c,d");
    expect(remove<string>(t, 2)).toBe("a");
    expect(remove<string>(t)).toBe("d");
    expect(concat(t, ",")).toBe("z,b,c");
    sort(t);
    expect(concat(t, ",")).toBe("b,c,z");
    expect([...ipairs(t)].map(([i]) => i)).toEqual([1, 2, 3]);
    const o: Record<string, unknown> = { 1: "x", 2: "y", name: "n" };
    expect(len(o)).toBe(2);
    expect([...pairs(o)].map(([k]) => k)).toEqual([1, 2, "name"]);
    expect(len([])).toBe(0);
  });
  test("data chunks: steps, nil holes, shared refs, errors", () => {
    const v = evalData(`local M = { machines = {}, x = {nil, 2, nil, 4} }\nM.machines[0] = 264\nM.machines[1] = 337\nlocal w = {a = "\\65\\xff"}\nreturn { m = M, w1 = w, w2 = w, s = [[long\nstr]], n = -0x10 + 1.5e1 }`) as any;
    expect(v.m.machines[0]).toBe(264);
    expect(len(v.m.machines)).toBe(1);
    expect(v.m.x[2]).toBe(2);
    expect(v.m.x[1]).toBe(null);
    expect(v.w1).toBe(v.w2);
    expect(v.w1.a).toBe("A\xff");
    expect(v.s).toBe("long\nstr");
    expect(v.n).toBe(-1);
    expect(luaLoad("return function() end")[0]).toBeUndefined();
    expect(luaLoad("x = 1")[1]).toContain("unknown name");
  });
});

describe.skipIf(!haveRef)("gen3 data chunks vs luajit (reference cache)", () => {
  test("every cache .lua file evaluates as luajit does; cooked forms round-trip", () => {
    const files = luaFiles(ROOT);
    expect(files.length).toBeGreaterThan(100);
    const lines = execFileSync("luajit", ["tools/gen3/luadata_oracle.lua", ...files], { maxBuffer: 1 << 30 }).toString("latin1").split("\n");
    const bad: string[] = [];
    files.forEach((f, i) => {
      const src = readFileSync(f).toString("latin1");
      let ours: string;
      try { ours = canon(evalData(src, f)); } catch (e) { ours = `THROW ${e}`; }
      if (ours !== lines[i]) bad.push(`${f.slice(ROOT.length)}: ${ours.slice(0, 120)} | lua ${lines[i]!.slice(0, 120)}`);
      else if (canon(evalData(cookData(src, f))) !== ours) bad.push(`${f.slice(ROOT.length)}: cooked form differs`);
    });
    expect(bad).toEqual([]);
  }, 120000);
});
