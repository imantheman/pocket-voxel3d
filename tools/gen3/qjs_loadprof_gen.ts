// Port tooling: writes /tmp/qjsd/loadprof_all.ts, a profiling entry that
// imports EVERY gen3 runtime module and wraps every function of everything
// they export with a timer (self time, children taken off), then runs
// Game3.load (and FRAMES frames). Run it with cc_g3_qjsbench.sh:
//   bun tools/gen3/qjs_loadprof_gen.ts && bash cc_g3_qjsbench.sh /tmp/qjsd/loadprof_all.ts <root>
// Never shipped.
import { readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(import.meta.dir, "../..");
const roots = ["voxelmon/game/gen3/core", "voxelmon/game/gen3/ui", "voxelmon/game/gen3/shared", "voxelmon/game/gen3/platform", "voxelmon/import/gen3"];
const skip = /(desktop|rasterize|qjs_host|qjs_world|fsio|index|cli|quantize_lab|savefs)\.ts$/;
const files: string[] = [];
const walk = (d: string): void => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith(".ts") && !n.endsWith(".d.ts") && !skip.test(n)) files.push(p);
  }
};
for (const r of roots) walk(join(REPO, r));
// --device: a 3DS entry instead (the real host and main.ts's loop), whose
// perf lines call globalThis.__g3ProfDump (tools/gen3/qjs_loadprof_gen.ts)
const DEVICE = process.argv.includes("--device");
const lines: string[] = [
  DEVICE ? `import "${join(REPO, "voxelmon/game/gen3/platform/qjs_host.ts")}";` : `import "${join(REPO, "tools/gen3/qjs_boot_host.ts")}";`,
];
files.forEach((f, i) => lines.push(`import * as M${i} from "${f}";`));
lines.push(`
declare const print: (s: string) => void;
const DEVICE_BUILD = ${DEVICE};
const nowUs = (): number => (globalThis as any).voxel?.now ? (globalThis as any).voxel.now() : (globalThis as any).nowUs();
const self = new Map<string, [number, number]>();
const stack: number[] = [];
const seen = new Set<unknown>();
function wrapObj(name: string, o: any, depth: number): void {
  if (!o || (typeof o !== "object" && typeof o !== "function") || seen.has(o) || depth > 1) return;
  seen.add(o);
  for (const k of Object.getOwnPropertyNames(o)) {
    let d: PropertyDescriptor | undefined;
    try { d = Object.getOwnPropertyDescriptor(o, k); } catch { continue; }
    if (!d || !("value" in d)) continue;
    const f = d.value;
    if (typeof f === "function" && d.writable && k !== "constructor" && !/^[A-Z]/.test(k)) {
      const label = name + "." + k;
      o[k] = function (this: unknown, ...a: unknown[]) {
        const t = nowUs();
        stack.push(0);
        try { return f.apply(this, a); } finally {
          const inner = stack.pop()!;
          const dt = nowUs() - t;
          if (stack.length) stack[stack.length - 1] += dt;
          const e = self.get(label) ?? [0, 0];
          e[0] += dt - inner; e[1]++;
          self.set(label, e);
        }
      };
      if (f.prototype && Object.getOwnPropertyNames(f.prototype).length > 1) wrapObj(label + "#", f.prototype, depth + 1);
    } else if (f && typeof f === "object" && !Array.isArray(f) && depth < 1) {
      wrapObj(name + "." + k, f, depth + 1);
    }
  }
}
const mods: [string, any][] = [${files.map((f, i) => `["${relative(REPO, f).replace(/^voxelmon\//, "").replace(/\.ts$/, "")}", M${i}]`).join(", ")}];
for (const [n, m] of mods) for (const k of Object.keys(m)) { try { wrapObj(n.split("/").pop() + ":" + k, m[k], 0); } catch {} }
(globalThis as any).__g3ProfDump = (): void => {
  const rows = [...self].sort((a, b) => b[1][0] - a[1][0]).slice(0, 12);
  for (const [k, [us, n]] of rows) console.log("[pv] prof " + (us / 1000).toFixed(0).padStart(6) + " ms " + String(n).padStart(7) + "x  " + k);
  self.clear();
};
if (DEVICE_BUILD) { /* main.ts runs the game (prof_device.ts imports it after this module) */ } else {
const G = (mods.find(([n]) => n.endsWith("core/Game3"))![1] as any).Game3;
const t0 = nowUs();
const game: any = G.new();
game.load({});
print("load " + ((nowUs() - t0) / 1000).toFixed(0) + " ms");
const rows = [...self].sort((a, b) => b[1][0] - a[1][0]).slice(0, 50);
for (const [k, [us, n]] of rows) print((us / 1000).toFixed(1).padStart(8) + " ms " + String(n).padStart(7) + "x  " + k);
}
`);
mkdirSync("/tmp/qjsd", { recursive: true });
writeFileSync(DEVICE ? "/tmp/qjsd/prof_wrap.ts" : "/tmp/qjsd/loadprof_all.ts", lines.join("\n"));
if (DEVICE) writeFileSync("/tmp/qjsd/prof_device.ts", `import "./prof_wrap.ts";\nimport "${join(REPO, "voxelmon/game/gen3/main.ts")}";\n`);
console.log(`${DEVICE ? "prof_device.ts" : "loadprof_all.ts"}: ${files.length} modules`);
