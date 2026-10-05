// Port of gen1recomp src/core/game3/m4a_player.lua (GPLv3 + additional terms;
// see voxelmon/game/gen3/LICENSE.md), by way of its Rust port
// crates/pocketvoxel-core/src/gen3/pack.rs `build_blob`: FireRed's `M4AP`
// sound blob from the importer's audio cache, made on the PC by the card cook
// (voxelmon/cook/gen3data.ts) so the console never builds it. Byte for byte
// the Rust builder's output (the layout is documented in
// crates/pocketvoxel-core/src/gen3/mod.rs); tests/voxel-gen3-cooked.test.ts
// compares the two where cargo is at hand.
//
// The cache's Lua tables arrive in luaLoad's shape (platform/luadata.ts): an
// integer-keyed table is an array (or, sparse, an object with integer-string
// keys); a table with string keys is an object.

import { evalData } from "../game/gen3/platform/luadata.ts";

type T = unknown[] | Record<string, unknown>;

function isTbl(v: unknown): v is T {
  return v !== null && typeof v === "object";
}
/** t[name] for a string key (Key::Str). */
function getStr(t: T, name: string): unknown {
  return Array.isArray(t) ? undefined : (t as Record<string, unknown>)[name];
}
/** t[n] for a number key (Key::Num). */
function getNum(t: T, n: number): unknown {
  return Array.isArray(t) ? t[n] : (t as Record<string, unknown>)[String(n)];
}
function tblStr(t: T, name: string): T | undefined {
  const v = getStr(t, name);
  return isTbl(v) ? v : undefined;
}
function tblNum(t: T, n: number): T | undefined {
  const v = getNum(t, n);
  return isTbl(v) ? v : undefined;
}
const canonInt = (k: string): boolean => /^(0|[1-9][0-9]*)$/.test(k);

/** pack.rs int_keys: the table's non-negative integer keys, ascending. */
function intKeys(t: T): number[] {
  const ks: number[] = [];
  if (Array.isArray(t)) { for (let i = 0; i < t.length; i++) if (t[i] != null) ks.push(i); }
  else for (const k of Object.keys(t)) if (canonInt(k) && t[k] != null) ks.push(Number(k));
  return ks.sort((a, b) => a - b);
}

/** pack.rs int_field */
function intField(t: T, name: string, what: string): number | undefined {
  const v = getStr(t, name);
  if (v == null) return undefined;
  if (typeof v !== "number") throw new Error(`${what}: ${name} is not a number`);
  if (!Number.isInteger(v) || v < -2147483648 || v > 4294967295) throw new Error(`${what}: ${name} = ${v} is not a 32-bit integer`);
  return v;
}

/** Lua's # (a border) of an integer-keyed table. */
function border(t: T): number {
  let n = 0;
  while (getNum(t, n + 1) != null) n++;
  return n;
}

class Out {
  buf = new Uint8Array(1 << 20);
  len = 0;
  private grow(n: number): void {
    if (n <= this.buf.length) return;
    let c = this.buf.length;
    while (c < n) c *= 2;
    const b = new Uint8Array(c);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  resize(n: number): void { this.grow(n); if (n > this.len) this.buf.fill(0, this.len, n); this.len = n; }
  push(b: number): void { this.grow(this.len + 1); this.buf[this.len++] = b & 0xff; }
  bytes(src: Uint8Array): void { this.grow(this.len + src.length); this.buf.set(src, this.len); this.len += src.length; }
  u32(v: number): void { this.resize(this.len + 4); this.put(this.len - 4, v); }
  put(at: number, v: number): void {
    v = v >>> 0;
    this.buf[at] = v & 0xff; this.buf[at + 1] = (v >>> 8) & 0xff; this.buf[at + 2] = (v >>> 16) & 0xff; this.buf[at + 3] = v >>> 24;
  }
  get(at: number): number { return (this.buf[at]! | (this.buf[at + 1]! << 8) | (this.buf[at + 2]! << 16) | (this.buf[at + 3]! << 24)) >>> 0; }
  align4(): void { while (this.len % 4 !== 0) this.push(0); }
}

const TONE_FIELDS = ["type", "key", "length", "pan", "sampleId", "attack", "decay", "sustain", "release", "wavParam", "subVgId"];

const bstr = (b: Uint8Array): string => Buffer.from(b).toString("latin1");

/**
 * pack.rs build_blob: `index` is index.lua's bytes; samples.lua /
 * voicegroups.lua are read only when the index lacks them; `songBins` lists
 * every songs/<id>.bin present.
 */
export function buildBlob(index: Uint8Array, samplesLua: Uint8Array | undefined, vgsLua: Uint8Array | undefined,
  samplesBin: Uint8Array, songBins: [number, Uint8Array][]): Uint8Array {
  const idx = evalData(bstr(index), "index.lua");
  if (!isTbl(idx)) throw new Error("index.lua: not a table");
  const empty: T = {};
  const side = (src: Uint8Array | undefined, name: string): T => {
    if (!src) return empty;
    const v = evalData(bstr(src), name);
    return isTbl(v) ? v : empty;
  };
  const samples = tblStr(idx, "samples") ?? side(samplesLua, "samples.lua");
  const vgs = tblStr(idx, "voicegroups") ?? side(vgsLua, "voicegroups.lua");
  const songs = tblStr(idx, "songs") ?? empty;
  const fanfares = tblStr(idx, "fanfares") ?? empty;
  const cries = tblStr(idx, "cries") ?? empty;
  const cryIds = tblStr(idx, "cryIds") ?? empty;

  const out = new Out();
  out.resize(64);
  out.buf.set([0x4d, 0x34, 0x41, 0x50], 0); // "M4AP"
  out.put(4, 1);

  // Songs.
  const songKeys = intKeys(songs);
  const maxBin = songBins.reduce((m, [id]) => Math.max(m, id), -1);
  const songN = Math.max(songKeys.length ? songKeys[songKeys.length - 1]! : -1, maxBin) + 1;
  const songsOff = out.len;
  out.resize(songsOff + songN * 40);
  for (let id = 0; id < songN; id++) {
    const r = songsOff + id * 40;
    let flags = 0;
    const t = tblNum(songs, id);
    if (t) {
      flags |= 1;
      const what = `songs[${id}]`;
      for (const [bit, name, at] of [[1, "voicegroupId", 4], [2, "reverb", 8], [3, "sampleId", 12], [4, "player", 16]] as const) {
        const v = intField(t, name, what);
        if (v !== undefined) { flags |= 1 << bit; out.put(r + at, v); }
      }
      const hg = getStr(t, "hasGoto");
      if (typeof hg === "boolean") { flags |= 1 << 5; if (hg) flags |= 1 << 6; }
      else if (hg != null) throw new Error(`${what}: hasGoto is not a boolean`);
      const ff = tblNum(fanfares, id);
      if (ff) {
        const fr = intField(ff, "frames", `fanfares[${id}]`);
        if (fr !== undefined) { flags |= 1 << 7; out.put(r + 20, fr); }
      }
    }
    out.put(r, flags);
  }

  // Samples.
  const sampleKeys = intKeys(samples);
  const sampleN = (sampleKeys.length ? sampleKeys[sampleKeys.length - 1]! : -1) + 1;
  const samplesOff = out.len;
  out.resize(samplesOff + sampleN * 24);
  for (const id of sampleKeys) {
    const t = tblNum(samples, id);
    if (!t) continue;
    const r = samplesOff + id * 24;
    out.put(r, 1);
    const what = `samples[${id}]`;
    for (const [name, at] of [["offset", 4], ["size", 8], ["freq", 12], ["loopStart", 16], ["status", 20]] as const) {
      const v = intField(t, name, what) ?? 0;
      if (v < 0) throw new Error(`${what}: ${name} is negative`);
      out.put(r + at, v);
    }
  }

  // Voicegroups: offset table, then the tone blocks and their pools.
  const vgKeys = intKeys(vgs);
  const vgN = (vgKeys.length ? vgKeys[vgKeys.length - 1]! : -1) + 1;
  if (vgN > 65536) throw new Error("voicegroup ids out of range");
  const vgOff = out.len;
  out.resize(vgOff + vgN * 4);
  for (const vgId of vgKeys) {
    const vg = tblNum(vgs, vgId);
    if (!vg) continue;
    out.align4();
    const block = out.len;
    out.put(vgOff + vgId * 4, block);
    out.resize(block + 128 * 56);
    for (let ti = 0; ti < 128; ti++) {
      const tone = tblNum(vg, ti);
      if (!tone) continue;
      const r = block + ti * 56;
      const what = `voicegroups[${vgId}][${ti}]`;
      let flags = 1;
      TONE_FIELDS.forEach((name, fi) => {
        const v = intField(tone, name, what);
        if (v !== undefined) { flags |= 1 << (fi + 1); out.put(r + 4 + fi * 4, v | 0); }
      });
      const ks = tblStr(tone, "keySplit");
      if (ks) {
        const bytes = new Uint8Array(128);
        const entries: [string, unknown][] = Array.isArray(ks) ? ks.map((v, i) => [String(i), v] as [string, unknown]) : Object.entries(ks);
        for (const [k, v] of entries) {
          if (v == null || typeof v !== "number") continue;
          const kn = Number(k);
          if (!canonInt(k) && Number.isNaN(kn)) continue; // a string key (Key::Str)
          if (kn >= 0 && kn < 128 && Number.isInteger(kn)) {
            if (v < 0 || v > 255 || !Number.isInteger(v)) throw new Error(`${what}: keySplit value ${v} not a byte`);
            bytes[kn] = v;
          } else throw new Error(`${what}: keySplit key ${kn} out of 0..127`);
        }
        out.align4();
        const o = out.len;
        out.bytes(bytes);
        flags |= 1 << 12;
        out.put(r + 48, o);
      }
      const w = tblStr(tone, "wave");
      if (w) {
        const n = border(w);
        if (n > 255) throw new Error(`${what}: wave longer than 255`);
        out.align4();
        const o = out.len;
        out.push(n);
        for (let i = 1; i <= n; i++) {
          const v = getNum(w, i);
          const x = typeof v === "number" ? v : 0;
          if (x < 0 || x > 255 || !Number.isInteger(x)) throw new Error(`${what}: wave value ${x} not a byte`);
          out.push(x);
        }
        flags |= 1 << 13;
        out.put(r + 52, o);
      }
      out.put(r, flags);
    }
  }

  // Cries and cryIds.
  out.align4();
  const cryKeys = intKeys(cries);
  const cryN = (cryKeys.length ? cryKeys[cryKeys.length - 1]! : -1) + 1;
  const criesOff = out.len;
  for (let i = 0; i < cryN; i++) {
    const t = tblNum(cries, i);
    const sid = t ? intField(t, "sampleId", `cries[${i}]`) : undefined;
    out.u32(sid === undefined ? -1 : sid | 0);
  }
  const cidKeys = intKeys(cryIds);
  const cidN = (cidKeys.length ? cidKeys[cidKeys.length - 1]! : -1) + 1;
  const cidsOff = out.len;
  for (let i = 0; i < cidN; i++) {
    const n = getNum(cryIds, i);
    let v = -1;
    if (typeof n === "number") {
      if (n >= 0 && n === (n | 0)) v = n;
      else throw new Error(`cryIds[${i}] = ${n} unsupported`);
    }
    out.u32(v);
  }

  // PCM, then song bins.
  out.align4();
  const pcmOff = out.len;
  out.bytes(samplesBin);
  for (const [id, bin] of songBins) {
    out.align4();
    const o = out.len;
    out.bytes(bin);
    const r = songsOff + id * 40;
    out.put(r, out.get(r) | (1 << 8));
    out.put(r + 24, o);
    out.put(r + 28, bin.length);
  }

  out.put(8, songN); out.put(12, songsOff);
  out.put(16, sampleN); out.put(20, samplesOff);
  out.put(24, vgN); out.put(28, vgOff);
  out.put(32, cryN); out.put(36, criesOff);
  out.put(40, cidN); out.put(44, cidsOff);
  out.put(48, pcmOff); out.put(52, samplesBin.length);
  return out.buf.slice(0, out.len);
}
