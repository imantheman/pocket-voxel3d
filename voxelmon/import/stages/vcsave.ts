// The ROM facts a cartridge save needs and the rest of the dataset leaves
// out (voxelmon/game/vc/cartsave.ts writes and reads that save).
//
// A Game Boy save is not just progress: continuing one never re-reads the
// current map's header from the ROM. The save carries the engine's copy of
// it -- the 10-byte map header, the four connection records, the warp,
// sign and object tables, the tileset header and the map's music -- and the
// game runs on whatever the save says. A save built from a Lua save has to
// write those bytes itself, for whichever map the player stands on, and they
// can only come from the ROM. So the importer copies them out here, on the
// player's machine, from the player's ROM; nothing of it is committed.
//
// Three tables are found by shape rather than by symbol (the manifest names
// none of them), and each find is checked against what the rest of the
// importer already knows:
//
//   - the toggleable-object states: three bytes an entry (map id, object
//     number, shown/hidden byte), in map-id order, $FF-terminated. An
//     entry's position is its bit in the save's toggle array.
//   - the hidden-item and hidden-coin coordinate lists: three bytes an entry
//     (map id, y, x), $FF-terminated. An entry's position is its bit in the
//     save's hidden-item (or hidden-coin) flags. field.json keeps these per
//     map, which loses the order the save's bits follow.
//
// Everything is written as hex strings to keep gamedata.json small.

import { check } from "../ctx.ts";
import type { Ctx } from "../ctx.ts";

const hex = (bytes: number[]): string => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

export interface VcSaveData {
  /** Per map: h the header (10 bytes), c the connection records (11 each,
   * present ones only, N/S/W/E), o the object data as the ROM has it, m
   * the map's music [sound id, audio bank]. */
  maps: Record<string, { h: string; c: string; o: string; m?: [number, number] }>;
  /** Per tileset: its 12-byte header (bank, blocks, gfx, collision, three
   * talking-over tiles, grass tile, animation mode). */
  tilesets: Record<string, string>;
  /** Toggle bit order: [map id, object number (1-based), hidden at start]. */
  toggles: [string, number, number][];
  /** Hidden-item flag order: [map id, x, y]. */
  hiddenItems: [string, number, number][];
  /** Hidden-coin flag order: [map id, x, y]. */
  hiddenCoins: [string, number, number][];
}

/** Bytes of a map's object data, walked as the engine's LoadMapHeader does. */
function objectBytes(ctx: Ctx, bank: number, start: number): number[] {
  const { rom } = ctx;
  let p = start;
  p += 1; // border block
  const warps = rom.byte(bank, p);
  p += 1 + warps * 4;
  const signs = rom.byte(bank, p);
  p += 1 + signs * 3;
  const objects = rom.byte(bank, p);
  p += 1;
  for (let i = 0; i < objects; i++) {
    const textId = rom.byte(bank, p + 5);
    p += 6;
    if (textId & 0x40) p += 2; // trainer or static mon: class/species, set/level
    else if (textId & 0x80) p += 1; // item ball: the item
  }
  return rom.bytes(bank, start, p - start);
}

export function extractVcSave(ctx: Ctx): VcSaveData {
  const { rom, manifest } = ctx;
  const mapOrder = manifest.constants.mapOrder;
  const mapIndex = new Map(mapOrder.map((id, i) => [id, i] as [string, number]));
  const out: VcSaveData = { maps: {}, tilesets: {}, toggles: [], hiddenItems: [], hiddenCoins: [] };

  // --- map headers, connections, objects, music
  const songs = manifest.audio.mapSongs ?? {};
  const headers = manifest.audio.musicHeaders ?? {};
  for (const mapId of Object.keys(manifest.maps).sort()) {
    const spec = manifest.maps[mapId];
    const sym = ctx.symbol(`${spec.label}_h`);
    const h = rom.bytes(sym.bank, sym.address, 10);
    const flags = h[9]!;
    let p = sym.address + 10;
    const c: number[] = [];
    for (const bit of [0x08, 0x04, 0x02, 0x01]) {
      if (flags & bit) {
        c.push(...rom.bytes(sym.bank, p, 11));
        p += 11;
      }
    }
    const objPtr = rom.word(sym.bank, p);
    const o = objectBytes(ctx, sym.bank, objPtr);
    const entry: VcSaveData["maps"][string] = { h: hex(h), c: hex(c), o: hex(o) };
    // The song ids are the header's address in its audio bank: each table
    // starts at $4000 and holds 3-byte entries, which is how the music
    // constants themselves are numbered.
    const song = songs[mapId] ? headers[songs[mapId]!] : undefined;
    if (song && (song.address - 0x4000) % 3 === 0) {
      entry.m = [(song.address - 0x4000) / 3, song.bank];
    }
    out.maps[mapId] = entry;
  }

  // --- tileset headers (12 bytes each, in tileset-id order)
  const ts = ctx.symbol("Tilesets");
  manifest.constants.tilesetOrder.forEach((id, i) => {
    out.tilesets[id] = hex(rom.bytes(ts.bank, ts.address + i * 12, 12));
  });

  // --- the toggleable-object states
  const data = rom.data;
  // The first entry is the map-0 object hidden at the start of every game
  // (the professor in the first town); search from there for the longest
  // run of plausible entries.
  // (Mostly map-id order, but not strictly: a few blocks sit out of turn.)
  let best = { off: -1, n: 0, states: [0, 0] };
  for (let off = 0; off + 3 < data.length; off++) {
    if (data[off] !== 0x00 || data[off + 1] !== 0x01) continue;
    let n = 0;
    const states = new Set<number>();
    for (let o = off; o + 2 < data.length; o += 3) {
      const m = data[o]!;
      if (m === 0xff) break;
      const obj = data[o + 1]!;
      const st = data[o + 2]!;
      // object numbers run 1-16; the ROM's own table names one or two
      // objects its maps do not have (an unused map, a twelfth object on an
      // eleven-object floor), so the map's count is not a bound
      if (m >= mapOrder.length || obj < 1 || obj > 16) { n = -1; break; }
      states.add(st);
      if (states.size > 2) { n = -1; break; }
      n += 1;
    }
    if (n > best.n && data[off + n * 3] === 0xff) best = { off, n, states: [...states] };
  }
  check(best.n >= 150, `toggleable object table not found (best run ${best.n})`);
  // Which state byte is "hidden": the first entry's (the professor starts hidden).
  const hiddenByte = data[best.off + 2]!;
  for (let i = 0; i < best.n; i++) {
    const o = best.off + i * 3;
    out.toggles.push([mapOrder[data[o]!]!, data[o + 1]!, data[o + 2] === hiddenByte ? 1 : 0]);
  }

  // --- hidden item / coin coordinate lists
  const coordTable = (perMap: Record<string, { x: number; y: number }[]> | undefined, what: string): [string, number, number][] => {
    const want = new Set<string>();
    for (const [mapId, list] of Object.entries(perMap ?? {})) {
      const m = mapIndex.get(mapId);
      if (m === undefined) continue;
      for (const e of list) want.add(`${m},${e.y},${e.x}`);
    }
    const n = want.size;
    if (n === 0) return [];
    // The ROM's list is the authority; the port's per-map metadata is
    // shared between versions and can be an entry off (Yellow's list has
    // one the metadata does not), so the run only has to be mostly known.
    let best = { off: -1, len: 0, known: 0 };
    for (let off = 0; off + 3 < data.length; off++) {
      if (!want.has(`${data[off]},${data[off + 1]},${data[off + 2]}`)) continue;
      const seen = new Set<string>();
      let len = 0;
      let known = 0;
      let ok = true;
      for (let o = off; len <= n + 16; o += 3, len++) {
        if (data[o] === 0xff) break;
        const k = `${data[o]},${data[o + 1]},${data[o + 2]}`;
        if (data[o]! >= mapOrder.length || seen.has(k)) { ok = false; break; }
        seen.add(k);
        if (want.has(k)) known++;
      }
      if (!ok || data[off + len * 3] !== 0xff) continue;
      if (known >= n * 0.8 && len >= n * 0.8 && known > best.known) best = { off, len, known };
    }
    check(best.off >= 0, `${what} coordinate table not found`);
    const list: [string, number, number][] = [];
    for (let i = 0; i < best.len; i++) {
      const o = best.off + i * 3;
      list.push([mapOrder[data[o]!]!, data[o + 2]!, data[o + 1]!]);
    }
    return list;
  };
  const field = (manifest as unknown as { field?: Record<string, unknown> }).field ?? {};
  out.hiddenItems = coordTable(field.hiddenItems as never, "hidden item");
  out.hiddenCoins = coordTable(field.hiddenCoins as never, "hidden coin");
  return out;
}
