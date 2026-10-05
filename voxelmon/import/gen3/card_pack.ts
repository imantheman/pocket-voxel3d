// pocket-voxel addition to the gen3 importer port (GPLv3 + additional terms;
// see LICENSE.md). FireRed's cache in one file on the 3DS card,
// <game>/data.pvpk (voxelmon/cook/gen3data.ts writes it; the console reads it
// in crates/pocketvoxel-3ds/src/gen3/g3_files.c, the desktop in
// game/gen3/platform/desktop.ts). One file because the console opens files
// slowly and the card is filled over FTP, where eight thousand small files
// cost far more than their bytes.
//
//   0   "PVPK"  u32 version (1)  u32 count  u32 names_size      (LE)
//   16  count x { u32 name_off, u32 name_len, u32 data_off, u32 data_len }
//       sorted by name (bytes: memcmp, then length)
//   ..  the names block, then the data (data_off from the start of the file)
//
// Names are the cache paths ("data/generated/gba/...") as byte strings, one
// char per byte, as the runtime holds them. While a pack is there it answers
// every path (one it does not hold does not exist). Node-free.

export const PACK_NAME = "data.pvpk";

const le32 = (b: Uint8Array, at: number): number => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
function put32(b: Uint8Array, at: number, v: number): void {
  b[at] = v & 0xff; b[at + 1] = (v >>> 8) & 0xff; b[at + 2] = (v >>> 16) & 0xff; b[at + 3] = (v >>> 24) & 0xff;
}
const bytesOf = (s: string): Uint8Array => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };
const strOf = (b: Uint8Array): string => { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!); return s; };

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** The pack's head (header + index + names) and its data parts, in file order. */
export function buildPack(files: { name: string; data: Uint8Array }[]): Uint8Array[] {
  const ents = files.map((f) => ({ key: bytesOf(f.name), data: f.data })).sort((a, b) => cmpBytes(a.key, b.key));
  for (let i = 1; i < ents.length; i++) if (cmpBytes(ents[i - 1]!.key, ents[i]!.key) === 0) throw new Error(`pack: ${strOf(ents[i]!.key)} twice`);
  const namesSize = ents.reduce((n, e) => n + e.key.length, 0);
  const headLen = 16 + ents.length * 16 + namesSize;
  const head = new Uint8Array(headLen);
  head.set([0x50, 0x56, 0x50, 0x4b], 0); // "PVPK"
  put32(head, 4, 1); put32(head, 8, ents.length); put32(head, 12, namesSize);
  let nameAt = 0, dataAt = headLen;
  ents.forEach((e, i) => {
    const r = 16 + i * 16;
    put32(head, r, nameAt); put32(head, r + 4, e.key.length); put32(head, r + 8, dataAt); put32(head, r + 12, e.data.length);
    head.set(e.key, 16 + ents.length * 16 + nameAt);
    nameAt += e.key.length;
    dataAt += e.data.length;
  });
  if (dataAt > 0xffffffff) throw new Error("pack: over 4 GB");
  return [head, ...ents.map((e) => e.data)];
}

export interface PackIndex {
  /** name -> [data_off, data_len] */
  files: Map<string, [number, number]>;
  /** every directory some file lies under ("data", "data/generated", ...) */
  dirs: Set<string>;
}

/** The header's sizes: how many bytes of the file the index needs. */
export function packHeadLen(first16: Uint8Array): number {
  if (first16.length < 16 || strOf(first16.subarray(0, 4)) !== "PVPK" || le32(first16, 4) !== 1) throw new Error("not a PVPK pack");
  return 16 + le32(first16, 8) * 16 + le32(first16, 12);
}

/** Read the index from the head bytes (at least packHeadLen of them). */
export function readPackIndex(head: Uint8Array): PackIndex {
  const n = le32(head, 8);
  const namesAt = 16 + n * 16;
  const files = new Map<string, [number, number]>();
  const dirs = new Set<string>();
  for (let i = 0; i < n; i++) {
    const r = 16 + i * 16;
    const no = le32(head, r), nl = le32(head, r + 4);
    const name = strOf(head.subarray(namesAt + no, namesAt + no + nl));
    files.set(name, [le32(head, r + 8), le32(head, r + 12)]);
    for (let j = name.indexOf("/"); j >= 0; j = name.indexOf("/", j + 1)) dirs.add(name.slice(0, j));
  }
  return { files, dirs };
}

export const CardPack = { PACK_NAME, buildPack, packHeadLen, readPackIndex };
export default CardPack;
