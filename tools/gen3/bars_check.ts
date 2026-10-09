// Port tooling: the battle health box's bars drawn alone by the desktop
// rasteriser -- the HP bar at full, half, a fifth and a sliver (green,
// yellow, red), the EXP bar at 0, a half and full -- each checked for its
// colours, and a PNG to look at (/tmp/bars.png, 4x). Never shipped.
//   bun tools/gen3/bars_check.ts [--root DIR]
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { setHost } from "../../voxelmon/game/gen3/platform/host.ts";
import { DesktopHost } from "../../voxelmon/game/gen3/platform/desktop.ts";
import { encodePng } from "../../voxelmon/import/gen3/png.ts";

const i = process.argv.indexOf("--root");
const host = new DesktopHost(i >= 0 ? process.argv[i + 1]! : join(homedir(), "gen3ref/frfull"));
setHost(host);
const { G } = await import("../../voxelmon/game/gen3/platform/graphics.ts");
const { BattleChrome } = await import("../../voxelmon/game/gen3/ui/battle_chrome.ts") as any;
BattleChrome.install();

// pret's thresholds in 48ths (battle_interface.c GetHPBarLevel): green over
// 24, yellow over 9, red under (26/50 is 24/48: yellow)
const HP: [number, number, string][] = [[50, 50, "green"], [27, 50, "green"], [26, 50, "yellow"], [11, 50, "yellow"], [10, 50, "red"], [1, 50, "red"]];
const EXP = [0, 0.5, 1];
G.beginFrame();
G.clear(1, 1, 1, 1);
HP.forEach(([hp, max], k) => BattleChrome.drawHpBar(8, 8 + k * 12, hp, max));
EXP.forEach((r, k) => BattleChrome.drawExpBar(120, 8 + k * 12, r));
G.endFrame();
const px = host.pixels();
const at = (x: number, y: number): string => {
  const o = (y * 240 + x) * 4;
  return ((px[o]! << 16) | (px[o + 1]! << 8) | px[o + 2]!).toString(16).padStart(6, "0");
};
let bad = 0;
// the fill's colour: the bar's row 3, at its first fill pixel (x + 16)
const fills: Record<string, string> = {};
HP.forEach(([hp, max, want], k) => {
  const c = at(8 + 16, 8 + k * 12 + 3);
  fills[want] ??= c;
  const ok = fills[want] === c;
  console.log(`HP ${hp}/${max} (${want}): fill ${c}`);
  if (!ok) bad++;
});
if (new Set(Object.values(fills)).size !== 3) { bad++; console.log(`HP: the three colours are not three different ones: ${JSON.stringify(fills)}`); }
EXP.forEach((r, k) => {
  const y = 8 + k * 12;
  let blue = 0;
  for (let x = 0; x < 64; x++) if (at(120 + x, y + 3) === "42ceff") blue++;
  const want = Math.floor(64 * r);
  console.log(`EXP ${r}: ${blue} of 64 px blue (want ${want}); top line ${at(120, y + 1)}`);
  if (blue !== want || at(120, y + 1) !== "213a00") bad++;
});
// 4x, to look at
const S = 4, big = new Uint8Array(240 * S * 160 * S * 4);
for (let y = 0; y < 160 * S; y++) for (let x = 0; x < 240 * S; x++) {
  const o = ((y >> 2) * 240 + (x >> 2)) * 4, p = (y * 240 * S + x) * 4;
  big[p] = px[o]!; big[p + 1] = px[o + 1]!; big[p + 2] = px[o + 2]!; big[p + 3] = 255;
}
writeFileSync("/tmp/bars.png", encodePng(240 * S, 160 * S, big));
console.log(`${bad} checks failed; /tmp/bars.png`);
process.exit(bad ? 1 : 0);
