// Port tooling: the cost of one cache file's parse under the desktop QuickJS
// (cc_g3_qjsbench.sh tools/gen3/qjs_parsebench.ts [cache root]): time, peak
// and retained heap for both readers (luaLoad, readLuaLiteral) on the Lua
// source and on each cooked form. Never shipped.
import { evalData } from "../../voxelmon/game/gen3/platform/luadata.ts";
import { readLuaLiteral } from "../../voxelmon/import/gen3/asset_pack.ts";
import { COOKED_LIT_TAG, COOKED_TAG } from "../../voxelmon/import/gen3/cooked_data.ts";

declare const print: (s: string) => void;
declare const readFile: (p: string) => string | undefined;
declare const nowUs: () => number;
declare const memUsage: () => [number, number];
declare const memPeakReset: () => void;
declare const gc: () => void;

const MB = (n: number): string => (n / 1048576).toFixed(1);
const FILES = [
  "data/generated/gba/scripts/scripts.lua",
  "data/generated/gba/scripts/text.lua",
  "data/generated/gba/scripts/events.lua",
  "data/generated/gba/audio/index.lua",
  "data/generated/gba/objects/pack.lua",
  "data/generated/gba/trainers.lua",
  "data/generated/gba/encounters.lua",
];
let keep: unknown;
function measure(label: string, f: () => unknown): void {
  gc();
  const [u0] = memUsage();
  memPeakReset();
  const t = nowUs();
  try { keep = f(); } catch (e) { print(`  ${label}: throws ${(e as Error).message}`); return; }
  const ms = (nowUs() - t) / 1000;
  const [, peak] = memUsage();
  gc();
  const [u1] = memUsage();
  print(`  ${label.padEnd(22)} ${ms.toFixed(0).padStart(6)} ms  peak +${MB(peak - u0).padStart(6)} MB  retained ${MB(u1 - u0).padStart(6)} MB`);
  keep = undefined;
}
for (const p of FILES) {
  const src = readFile(p);
  if (!src) { print(`${p}: missing`); continue; }
  print(`${p} (${MB(src.length)} MB${src.startsWith("\x00PVJ") ? ", cooked " + JSON.stringify(src.slice(0, 6)) : ""})`);
  if (!src.startsWith("\x00PVJ")) {
    measure("luaLoad(lua)", () => evalData(src, p));
    const c1 = COOKED_TAG + JSON.stringify(evalData(src, p));
    measure("luaLoad(PVJ1)", () => evalData(c1, p));
    measure("readLuaLiteral(PVJ1)", () => readLuaLiteral(c1));
    let lit: unknown;
    try { lit = readLuaLiteral(src); } catch { continue; }
    const c3 = COOKED_LIT_TAG + JSON.stringify(lit);
    measure("luaLoad(PVJ3)", () => evalData(c3, p));
    measure("readLuaLiteral(PVJ3)", () => readLuaLiteral(c3));
  } else {
    measure("luaLoad", () => evalData(src, p));
    measure("readLuaLiteral", () => readLuaLiteral(src));
  }
}
