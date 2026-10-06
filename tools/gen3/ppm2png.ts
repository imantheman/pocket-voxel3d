// PPM (P6) -> PNG: bun tools/gen3/ppm2png.ts a.ppm [b.ppm ...] (writes a.png beside each)
import { readFileSync, writeFileSync } from "node:fs";
import { encodePng } from "../../voxelmon/import/gen3/png.ts";

for (const f of process.argv.slice(2)) {
  const b = readFileSync(f);
  let pos = 0;
  const tok = (): string => {
    while (b[pos] === 0x20 || b[pos] === 0x0a || b[pos] === 0x0d || b[pos] === 0x09) pos++;
    if (b[pos] === 0x23) { while (b[pos] !== 0x0a) pos++; return tok(); }
    let s = "";
    while (pos < b.length && !(b[pos] === 0x20 || b[pos] === 0x0a || b[pos] === 0x0d || b[pos] === 0x09)) s += String.fromCharCode(b[pos++]!);
    return s;
  };
  if (tok() !== "P6") throw new Error(`${f}: not P6`);
  const w = Number(tok()), h = Number(tok());
  tok();
  pos++;
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = b[pos + i * 3]!; px[i * 4 + 1] = b[pos + i * 3 + 1]!; px[i * 4 + 2] = b[pos + i * 3 + 2]!; px[i * 4 + 3] = 255;
  }
  writeFileSync(f.replace(/\.ppm$/, ".png"), encodePng(w, h, px));
}
