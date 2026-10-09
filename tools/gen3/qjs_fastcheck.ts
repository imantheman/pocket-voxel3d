// Port tooling: the host's C MD5 and atlas bake (g3_fast.c, platform/fast.ts)
// against the runtime's own TypeScript, on every tileset pair the maps use,
// under the desktop QuickJS runner (bash .cc_ld_fastcheck.sh): the same
// digests and the same bytes, or a line saying where not. Never shipped.
import "./qjs_boot_host.ts";
import { Fast } from "../../voxelmon/game/gen3/platform/fast.ts";
import { Palette } from "../../voxelmon/game/gen3/core/palette.ts";
import { NativePack } from "../../voxelmon/import/gen3/native_pack.ts";
import { luaLoad } from "../../voxelmon/game/gen3/platform/luadata.ts";

declare const print: (s: string) => void;
declare const nowUs: () => number;
declare const readFile: (p: string) => string | undefined;
const readFile0 = readFile;

const md5 = Fast.md5, bake = Fast.bake;
if (!md5 || !bake) throw new Error("the runner has no nativeMd5 / nativeBake");
const layouts = new Set<string>();
// every pair the native manifest lists (native/manifest.lua's pairs)
{
  const [chunk] = luaLoad(readFile0("data/generated/gba/native/manifest.lua") ?? "", "@manifest.lua");
  const man: any = chunk && chunk();
  for (const k of Object.keys(man?.pairs ?? {})) layouts.add(k);
}
let pairs = 0, layers = 0, bad = 0, tJs = 0, tC = 0;
for (const pair of layouts) {
  const root = `data/generated/gba/native/${pair}`;
  const pals = readFile0(`${root}/palettes.bin`);
  if (!pals) continue;
  const [rgb, bgr] = Palette.load(pals);
  pairs++;
  for (const [file, transparent] of [["mids.idx", false], ["mids_over.idx", true], ["mids_mid.idx", true]] as [string, boolean][]) {
    const blob = readFile0(`${root}/${file}`);
    if (!blob) continue;
    const [idx] = NativePack.decodeIdx(blob);
    if (!idx) continue;
    layers++;
    // the hash: C, then the TS (Fast.md5 off)
    let t = nowUs();
    const hc = Palette.hash(bgr as any, blob);
    tC += nowUs() - t;
    Fast.md5 = undefined;
    t = nowUs();
    const hj = Palette.hash(bgr as any, blob);
    tJs += nowUs() - t;
    Fast.md5 = md5;
    if (hc !== hj) { bad++; print(`[fast] ${pair}/${file}: hash ${hc} != ${hj}`); }
    t = nowUs();
    const [rc] = NativePack.bakeRgba(idx, rgb!, { transparentZero: transparent });
    tC += nowUs() - t;
    Fast.bake = undefined;
    const [idx2] = NativePack.decodeIdx(blob);
    t = nowUs();
    const [rj] = NativePack.bakeRgba(idx2!, rgb!, { transparentZero: transparent });
    tJs += nowUs() - t;
    Fast.bake = bake;
    if (rc !== rj) {
      bad++;
      let at = -1;
      for (let i = 0; i < Math.min(rc!.length, rj!.length); i++) if (rc!.charCodeAt(i) !== rj!.charCodeAt(i)) { at = i; break; }
      print(`[fast] ${pair}/${file}: bake differs (lengths ${rc?.length} / ${rj?.length}, first at ${at})`);
    }
  }
}
// MD5 itself on edge lengths (padding into a second block)
for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode((i * 37 + 11) & 255);
  const c = Palette._md5hex(s);
  Fast.md5 = undefined;
  const j = Palette._md5hex(s);
  Fast.md5 = md5;
  if (c !== j) { bad++; print(`[fast] md5 of ${n} bytes: ${c} != ${j}`); }
}
print(`[fast] ${pairs} pairs, ${layers} layers: ${bad} differ; TS ${(tJs / 1000).toFixed(0)} ms, C ${(tC / 1000).toFixed(0)} ms`);
