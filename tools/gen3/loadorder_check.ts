// Port tooling: import every gen3 runtime module FIRST, each in a fresh
// process, and list the ones whose load throws (a top-level read of an
// import inside the cycle: "Cannot access 'X' before initialization", a
// missing default export, ...).
//   bun tools/gen3/loadorder_check.ts [path-filter]
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dir, "../../voxelmon/game/gen3");
const filter = process.argv[2];
const files: string[] = [];
(function walk(d: string): void {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith(".ts") && (!filter || p.includes(filter))) files.push(p);
  }
})(ROOT);
files.sort();
const bad: string[] = [];
for (const f of files) {
  const r = spawnSync(process.execPath, ["-e", `await import(${JSON.stringify(f)})`], { encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout).split("\n").find((l) => /Error|error:/.test(l)) ?? "exit " + r.status;
    const at = (r.stderr || "").split("\n").find((l) => l.includes("voxelmon/game/gen3/") && l.includes(" at ")) ?? "";
    bad.push(`${relative(ROOT, f)}: ${msg.trim()}${at ? "  [" + at.trim().replace(/^at\s+/, "") + "]" : ""}`);
  }
}
console.log(`${files.length} modules, ${bad.length} fail to load first:`);
for (const b of bad) console.log("  " + b);
process.exit(bad.length ? 1 : 0);
