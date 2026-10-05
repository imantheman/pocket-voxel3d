// Port tooling: the require graph of the gen1recomp modules the FireRed
// importer loads (from /tmp/frmods.tsv, written by tools/gen3/modtrace.lua).
//   bun tools/gen3/reqgraph.ts [/tmp/frmods.tsv]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const G = join(homedir(), "gen1recomp-latest");
const rows = readFileSync(process.argv[2] ?? "/tmp/frmods.tsv", "utf8").trim().split("\n").map((l) => l.split("\t"));
const mods = new Map(rows.map(([name, lines]) => [name!, Number(lines)]));
const deps = new Map<string, string[]>();
const users = new Map<string, string[]>();
for (const name of mods.keys()) {
  let src = "";
  try { src = readFileSync(join(G, name.replace(/\./g, "/") + ".lua"), "utf8"); } catch { continue; }
  const found = new Set<string>();
  for (const m of src.matchAll(/require\(\s*["']([\w.]+)["']\s*\)/g)) if (mods.has(m[1]!) && m[1] !== name) found.add(m[1]!);
  for (const m of src.matchAll(/moduleFor\(\s*["']([\w.]+)["']/g)) found.add("src.import.gba." + m[1]!);
  deps.set(name, [...found]);
  for (const d of found) users.set(d, [...(users.get(d) ?? []), name]);
}
const short = (n: string) => n.replace("src.import.gba.", "gba.").replace("src.core.game3.", "g3.").replace("src.", "");
console.log("== modules used by 3+ others (port first, shared)");
for (const [d, u] of [...users.entries()].sort((a, b) => b[1].length - a[1].length)) {
  if (u.length >= 3) console.log(`${String(u.length).padStart(3)} ${short(d)} (${mods.get(d)} lines)`);
}
console.log("== per module deps");
for (const [n, d] of [...deps.entries()].sort((a, b) => (mods.get(b[0])! - mods.get(a[0])!))) {
  console.log(`${short(n)} [${mods.get(n)}] -> ${d.map(short).join(", ")}`);
}
