// Port tooling: the 3DS host's PNG decoder (g3PngDecode; the desktop runner's
// pngDecode) against the guest's own (platform/pngdecode.ts), on every PNG
// the list names -- every pixel must match wherever the host takes the PNG.
//   find <root>/data -name '*.png' -printf '%P\n' > <root>/pnglist.txt
//   bash cc_g3_qjsbench.sh tools/gen3/qjs_pngcheck.ts <root>
// Never shipped.
import { decodePngBytes } from "../../voxelmon/game/gen3/platform/pngdecode.ts";
import { toBytes } from "../../voxelmon/import/gen3/lua.ts";

declare const print: (s: string) => void;
declare const readFile: (p: string) => string | undefined;
declare const pngDecode: (s: string) => [number, number, Uint8Array] | undefined;

const list = (readFile("pnglist.txt") ?? "").split("\n").filter(Boolean);
let taken = 0, left = 0, bad = 0;
for (const rel of list) {
  const s = readFile("data/" + rel);
  if (!s) continue;
  const nat = pngDecode(s);
  if (!nat) { left++; continue; }
  taken++;
  let js: { w: number; h: number; rgba: Uint8Array };
  try { js = decodePngBytes(toBytes(s)); } catch (e) { bad++; print(`MISMATCH ${rel}: the guest refuses it (${String(e)})`); continue; }
  let same = js.w === nat[0] && js.h === nat[1] && js.rgba.length === nat[2].length;
  for (let i = 0; same && i < js.rgba.length; i++) if (js.rgba[i] !== nat[2][i]) same = false;
  if (!same) { bad++; if (bad <= 20) print(`MISMATCH ${rel}`); }
}
print(`pngcheck: ${list.length} listed, ${taken} decoded by the host (all compared), ${left} left to the guest, ${bad} mismatches`);
