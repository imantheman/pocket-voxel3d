// Port tooling: tools/gen3/battle_pixels.ts on the device's own 2D-layer
// shots (g3shot_N.ppm, 240x160), the EXP bar check where the player's box
// stands at rest. Never shipped.
//   bun tools/gen3/battle_ppm_check.ts <g3shot.ppm ...> [--root DIR]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkBattlePixels } from "./battle_pixels.ts";

const i = process.argv.indexOf("--root");
const root = i >= 0 ? process.argv[i + 1]! : join(homedir(), "gen3ref/frfull");
const box = new Uint8Array(readFileSync(join(root, "data/generated/gba/pokemon/battle/healthbox_player.rgba")));
let bad = 0;
for (const f of process.argv.slice(2).filter((a, k, all) => !a.startsWith("--") && all[k - 1] !== "--root")) {
  const b = readFileSync(f);
  // P6 <w> <h> 255\n then RGB
  let pos = 0, fields: string[] = [];
  while (fields.length < 4) {
    while (b[pos] === 0x20 || b[pos] === 0x0a) pos++;
    let s = "";
    while (b[pos] !== 0x20 && b[pos] !== 0x0a) s += String.fromCharCode(b[pos++]!);
    fields.push(s);
  }
  pos++;
  const w = Number(fields[1]), h = Number(fields[2]);
  if (w !== 240 || h !== 160) { console.log(`${f}: ${w}x${h}, not a 2D-layer shot`); continue; }
  const px = new Uint8Array(w * h * 4);
  for (let k = 0; k < w * h; k++) { px[k * 4] = b[pos + k * 3]!; px[k * 4 + 1] = b[pos + k * 3 + 1]!; px[k * 4 + 2] = b[pos + k * 3 + 2]!; px[k * 4 + 3] = 255; }
  const r = checkBattlePixels(px, box);
  if (!r) { console.log(`${f}: no player box at rest`); continue; }
  if (r.problems.length) bad++;
  console.log(`${f}: ${r.problems.length ? "FAIL " + r.problems.join("; ") : "ok"} (${r.summary})`);
}
console.log(`${bad} shots failed`);
