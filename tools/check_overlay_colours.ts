// Check: does a version overlay recolour the maps? For every pak of a set,
// the palette its map's terrain draws (VCOL world_pal) before and after the
// overlay is laid over -- by the old rule (the whole table, when the lengths
// match) and by pak::overlay_palettes (only below the pak's own tail).
//   bun tools/check_overlay_colours.ts [paks dir] [overlay file]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "dist/voxelmon/paks";
const overlayPath = process.argv[3] ?? join(dir, "version_red.vxat");

function sections(d: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  const n = d.readUInt16LE(6);
  for (let s = 0; s < n; s++) {
    const e = 16 + s * 16;
    const off = d.readUInt32LE(e + 4);
    out[d.toString("latin1", e, e + 4)] = d.subarray(off, off + d.readUInt32LE(e + 8));
  }
  return out;
}

function palettes(v: Buffer): Buffer[] {
  const n = v.readUInt16LE(0);
  return Array.from({ length: n }, (_, k) => v.subarray(2 + k * 1024, 2 + (k + 1) * 1024));
}

function overlayPalettes(d: Buffer): Buffer[] {
  if (d.toString("latin1", 0, 4) !== "VXVO" || d.readUInt16LE(4) < 2) return [];
  const count = d.readUInt16LE(6);
  const vpalLen = d.readUInt32LE(8);
  let at = 16 + count * 16;
  for (let i = 0; i < count; i++) {
    const e = 16 + i * 16;
    const frames = Math.max(1, d.readUInt16LE(e + 8));
    at += (16 - (at % 16)) % 16;
    at += d.readUInt32LE(e + 12) * frames;
  }
  at += (16 - (at % 16)) % 16;
  return vpalLen >= 2 ? palettes(d.subarray(at, at + vpalLen)) : [];
}

const over = overlayPalettes(readFileSync(overlayPath));
console.log(`${overlayPath}: ${over.length} palettes`);
let oldBad = 0;
let newBad = 0;
let checked = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".vxpak")).sort()) {
  const s = sections(readFileSync(join(dir, f)));
  if (!s.VPAL || !s.VCOL) continue;
  const own = palettes(s.VPAL);
  const vcol = s.VCOL;
  const maps = vcol.readUInt16LE(2);
  const pages = vcol.readUInt16LE(4);
  const idx: number[] = [];
  for (let m = 0; m < maps; m++) idx.push(vcol.readUInt16LE(16 + m * 8 + 4));
  for (let p = 0; p < pages; p++) idx.push(vcol.readUInt16LE(16 + maps * 8 + p * 2));
  const named = idx.filter((i) => i !== 0xffff);
  const tail = named.length ? Math.min(...named) : own.length;
  const world = vcol.readUInt16LE(16 + 4);
  if (world === 0xffff) continue;
  checked++;
  const oldTable = over.length === own.length ? over : own;
  const n = over.length && over.length <= own.length ? Math.min(over.length, tail) : 0;
  const newTable = own.map((p, i) => (i < n ? over[i]! : p));
  if (!oldTable[world]!.equals(own[world]!)) oldBad++;
  if (!newTable[world]!.equals(own[world]!)) newBad++;
}
console.log(`${checked} paks with a world palette: old rule recolours ${oldBad}, new rule ${newBad}`);
