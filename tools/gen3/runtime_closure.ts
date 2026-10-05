// Port tooling: the static require closure of gen1recomp's FRLG runtime, from
// src/core/Game3.lua, skipping Emerald/RSE-only modules and the launcher.
//   bun tools/gen3/runtime_closure.ts [--list] [--dynamic]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const G = join(homedir(), "gen1recomp-latest");
const SKIP = /(^|[._])(rse|emerald)([._]|$)|_rse$|_emerald$|\.rse\.|Launcher|OnlinePanel|CartLabel|CartShape|LauncherMods|minigames/i;
const pathOf = (m: string) => join(G, m.replace(/\./g, "/") + ".lua");
const seen = new Map<string, number>();
const skipped = new Set<string>();
const dynamic: string[] = [];
const deps = new Map<string, string[]>();
const queue = ["src.core.Game3"];
while (queue.length) {
  const m = queue.shift()!;
  if (seen.has(m)) continue;
  const p = pathOf(m);
  if (!existsSync(p)) { skipped.add(m + " (missing)"); continue; }
  const src = readFileSync(p, "latin1");
  seen.set(m, src.split("\n").length);
  const ds: string[] = [];
  for (const r of src.matchAll(/require\s*\(?\s*["']([\w.]+)["']/g)) {
    const d = r[1]!;
    if (SKIP.test(d)) { skipped.add(d); continue; }
    ds.push(d);
    if (!seen.has(d)) queue.push(d);
  }
  deps.set(m, ds);
  for (const r of src.matchAll(/require\s*\(\s*([^"'\s)][^)]*)\)/g)) dynamic.push(`${m}: require(${r[1]})`);
}
const byDir = new Map<string, [number, number]>();
for (const [m, n] of seen) {
  const dir = m.split(".").slice(0, -1).join(".");
  const v = byDir.get(dir) ?? [0, 0];
  byDir.set(dir, [v[0] + 1, v[1] + n]);
}
let total = 0;
for (const n of seen.values()) total += n;
console.log(`${seen.size} modules, ${total} lines`);
for (const [d, [c, n]] of [...byDir.entries()].sort((a, b) => b[1][1] - a[1][1])) console.log(`${String(n).padStart(7)} ${String(c).padStart(4)}  ${d}`);
if (process.argv.includes("--dynamic")) { console.log("== dynamic requires"); for (const d of dynamic) console.log(d); }
writeFileSync("/tmp/g3runtime.tsv", [...seen.entries()].map(([m, n]) => `${m}\t${n}\t${(deps.get(m) ?? []).join(",")}`).join("\n") + "\n");
console.log(`(${skipped.size} skipped names; list in /tmp/g3runtime.tsv)`);
