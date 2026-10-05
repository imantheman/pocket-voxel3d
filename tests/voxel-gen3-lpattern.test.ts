// The gen3 runtime's Lua pattern engine (platform/lpattern.ts) against
// luajit: every literal pattern in gen1recomp's FRLG runtime (core/game3,
// ui/game3), each run as find / match / gmatch / gsub on sample subjects.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { find, gmatch, gsub, match } from "../voxelmon/game/gen3/platform/lpattern.ts";

const SRC = join(homedir(), "gen1recomp-latest/src");
let haveLua = existsSync(SRC);
try { execFileSync("luajit", ["-v"]); } catch { haveLua = false; }

function luaFiles(d: string, out: string[] = []): string[] {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) luaFiles(p, out);
    else if (n.endsWith(".lua")) out.push(p);
  }
  return out;
}
/** Decode a Lua short string literal's body (the escapes patterns use). */
function luaStr(body: string): string {
  return body.replace(/\\(\d{1,3}|x[0-9a-fA-F]{2}|.)/g, (_m, e: string) => {
    if (/^\d/.test(e)) return String.fromCharCode(Number(e));
    if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
    return ({ n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'" } as Record<string, string>)[e] ?? e;
  });
}
const enc = (s: string) => s.replace(/[\x00-\x1f\\\x7f-\xff]/g, (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"));
const esc = (v: unknown) => (typeof v === "string" ? "s" + enc(v) : v === undefined ? "nnil" : (typeof v)[0] + String(v));

const SUBJECTS = [
  "", "FR_PALLET_TOWN", "data/generated/gba/maps/FR_ROUTE_1.lua", "  hello world 123  ", "{1,2,3}",
  "POK\xc3\xa9MON Lv50", "a=b;c=d,e = f", "0x1F 0X2a -12 3.5e2", "key:value\nnext line\r\n",
  "[tag](x) %d %%", "SEVII_ONE_ISLAND_POKECENTER", "gfx/obj/7.png", "OBJ_EVENT_GFX_RED_NORMAL",
];

describe.skipIf(!haveLua)("gen3 Lua patterns vs luajit", () => {
  test("every literal pattern in the FRLG runtime, on sample subjects", () => {
    const pats = new Set<string>();
    for (const f of [...luaFiles(join(SRC, "core/game3")), ...luaFiles(join(SRC, "ui/game3"))]) {
      const t = readFileSync(f).toString("latin1");
      for (const m of t.matchAll(/:(?:find|match|gmatch|gsub)\(\s*"((?:[^"\\\n]|\\.)*)"/g)) pats.add(luaStr(m[1]!));
      for (const m of t.matchAll(/:(?:find|match|gmatch|gsub)\(\s*'((?:[^'\\\n]|\\.)*)'/g)) pats.add(luaStr(m[1]!));
    }
    expect(pats.size).toBeGreaterThan(100);
    const cases: [string, string, string, string][] = [];
    for (const p of pats) {
      for (const s of SUBJECTS) {
        cases.push(["find", p, s, "1"], ["find", p, s, "-5"], ["match", p, s, ""], ["gmatch", p, s, ""], ["gsub", p, s, "<%1%0>"]);
      }
    }
    const input = cases.map(([fn, p, s, x]) => [fn, enc(p), enc(s), enc(x)].join("\t")).join("\n") + "\n";
    const lua = execFileSync("luajit", ["tools/gen3/lpattern_oracle.lua"], { input, maxBuffer: 1 << 28 }).toString("latin1").split("\n");
    const bad: string[] = [];
    cases.forEach(([fn, p, s, x], i) => {
      let ours: string;
      try {
        if (fn === "find") ours = (find(s, p, Number(x)) ?? [undefined]).map(esc).join(",");
        else if (fn === "match") {
          const r = match(s, p);
          ours = r === undefined ? "nnil" : esc(r);
          // Lua returns every capture; compare the first only via matchAll below
          const all = lua[i]!.split(",");
          if (ours === all[0]) ours = lua[i]!;
        } else if (fn === "gmatch") ours = esc([...gmatch(s, p)].map((c) => `${esc(c[0])}|${esc(c[1])}|${esc(c[2])}`).join(";"));
        else ours = gsub(s, p, x).map(esc).join(",");
      } catch { ours = "ERR"; }
      if (ours !== lua[i]) bad.push(`${fn} ${JSON.stringify(p)} on ${JSON.stringify(s)}: ours ${ours} lua ${lua[i]}`);
    });
    expect(bad.slice(0, 20)).toEqual([]);
    expect(bad.length).toBe(0);
  }, 120000);
});
