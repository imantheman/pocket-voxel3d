// The Gen 2 cartridge facts the VC save converter is written against, read
// straight out of a ROM, to check the tables in voxelmon/game/gen2/vc/layout.ts
// (tests/voxel-gen2-vcsave.test.ts runs this when the ROMs are on the
// machine) and to print them:
//
//   bun tools/vc2/romfacts.ts <rom.gbc> <gold|silver|crystal> [maps.json]
//
// Found by shape, not by address:
//   - the save blocks: SaveGameData's `ld hl,wram / ld de,sram / ld bc,len /
//     call CopyBytes` runs into banks 0-1 of battery RAM;
//   - the map scene table: 4-byte rows (map group, map number, WRAM address)
//     whose addresses fall in the saved player block, ending in $FF;
//   - the engine flag table: 3-byte rows (WRAM address, bit mask) starting
//     with five masks 1,2,4,8,16 on one address (the gear's cards).
import { readFileSync } from "node:fs";

export interface RomFacts {
  blocks: { sram: number; wram: number; len: number }[];
  backup: { sram: number; wram: number; len: number }[];
  scenes: { group: number; map: number; wram: number }[];
  engineFlags: { wram: number; mask: number }[];
}

const w16 = (rom: Uint8Array, i: number): number => rom[i]! | (rom[i + 1]! << 8);

export function romFacts(rom: Uint8Array): RomFacts {
  const copies: { at: number; wram: number; sram: number; len: number; toSram: boolean }[] = [];
  for (let i = 0; i < rom.length - 12; i++) {
    if (rom[i] !== 0x21 || rom[i + 3] !== 0x11 || rom[i + 6] !== 0x01 || rom[i + 9] !== 0xcd) continue;
    const hl = w16(rom, i + 1), de = w16(rom, i + 4), bc = w16(rom, i + 7);
    const isS = (a: number): boolean => a >= 0xa000 && a < 0xc000;
    const isW = (a: number): boolean => a >= 0xc000 && a < 0xe000;
    if (isS(de) && isW(hl)) copies.push({ at: i, wram: hl, sram: de, len: bc, toSram: true });
  }
  // the main save: the run of copies into bank 1 starting at $A009 (sGameData)
  const start = copies.findIndex((c) => c.sram === 0xa009 && c.len > 0x400);
  if (start < 0) throw new Error("romfacts: no SaveGameData copy to $A009");
  const blocks: RomFacts["blocks"] = [];
  let next = 0xa009;
  for (let k = start; k < copies.length && blocks.length < 3; k++) {
    const c = copies[k]!;
    if (c.sram !== next) continue;
    blocks.push({ sram: c.sram - 0xa000 + 0x2000, wram: c.wram, len: c.len });
    next = c.sram + c.len;
  }
  // the backup copy: the next copies of the same WRAM blocks to other places
  const backup: RomFacts["backup"] = [];
  const first = blocks[0]!.wram, last = blocks[2]!.wram + blocks[2]!.len;
  for (let k = start + 3; k < copies.length && backup.length < 6; k++) {
    const c = copies[k]!;
    if (c.at - copies[start]!.at > 0x200) break;
    if (c.wram >= first && c.wram < last && c.sram !== 0xa009) backup.push({ sram: c.sram - 0xa000, wram: c.wram, len: c.len });
  }
  const player = blocks[0]!;
  const inPlayer = (a: number): boolean => a >= player.wram && a < player.wram + player.len;

  // map scenes: longest run of (group, map, addr) rows with consecutive-ish addresses
  let scenes: RomFacts["scenes"] = [];
  for (let i = 0; i < rom.length - 8; i++) {
    const rows: RomFacts["scenes"] = [];
    let j = i;
    while (j + 4 <= rom.length && rom[j]! >= 1 && rom[j]! <= 26 && rom[j + 1]! >= 1 && rom[j + 1]! <= 0x80 && inPlayer(w16(rom, j + 2))) {
      const a = w16(rom, j + 2);
      if (rows.length && (a < rows[rows.length - 1]!.wram || a > rows[rows.length - 1]!.wram + 2)) break;
      rows.push({ group: rom[j]!, map: rom[j + 1]!, wram: a });
      j += 4;
    }
    if (rows.length > scenes.length && rom[j] === 0xff) scenes = rows;
    if (rows.length > 4) i = j;
  }

  // engine flags
  let engineFlags: RomFacts["engineFlags"] = [];
  for (let i = 0; i < rom.length - 15; i++) {
    const a = w16(rom, i);
    if (!(a >= 0xc000 && a < 0xe000)) continue;
    let ok = true;
    for (let k = 0; k < 5 && ok; k++) ok = w16(rom, i + k * 3) === a && rom[i + k * 3 + 2] === 1 << k;
    if (!ok) continue;
    const rows: RomFacts["engineFlags"] = [];
    let j = i;
    while (j + 3 <= rom.length) {
      const addr = w16(rom, j), mask = rom[j + 2]!;
      if (!(addr >= 0xc000 && addr < 0xe000) || !mask || (mask & (mask - 1)) !== 0) break;
      rows.push({ wram: addr, mask });
      j += 3;
    }
    if (rows.length > engineFlags.length) engineFlags = rows;
  }
  return { blocks, backup, scenes, engineFlags };
}

if (import.meta.main) {
  const rom = new Uint8Array(readFileSync(process.argv[2]!));
  const f = romFacts(rom);
  const hex = (n: number): string => `0x${n.toString(16)}`;
  console.log("blocks", f.blocks.map((b) => `${hex(b.sram)}<-${hex(b.wram)}+${hex(b.len)}`).join(" "));
  console.log("backup", f.backup.map((b) => `${hex(b.sram)}<-${hex(b.wram)}+${hex(b.len)}`).join(" "));
  const maps = process.argv[4] ? JSON.parse(readFileSync(process.argv[4], "utf8")) : {};
  const byGm = new Map<string, string>();
  for (const [id, m] of Object.entries<any>(maps)) if (m && m.group) byGm.set(`${m.group}:${m.map}`, id);
  const p = f.blocks[0]!;
  console.log("scenes", f.scenes.length);
  for (const s of f.scenes) console.log(`  ${byGm.get(`${s.group}:${s.map}`) ?? `${s.group}:${s.map}`} ${hex(s.wram)} sram ${hex(s.wram - p.wram + p.sram)}`);
  console.log("engineFlags", f.engineFlags.length);
  console.log(f.engineFlags.map((e, i) => `${i}:${hex(e.wram)}/${e.mask}`).join(" "));
}
