// Port of gen1recomp src/import/gba/revision_view.lua (GPLv3 + additional terms; see LICENSE.md).
// A 1.1 ROM, rebuilt in its edition's 1.0 layout: segments shifted back and
// every ROM pointer at the recorded sites rewritten, so one set of 1.0
// offsets serves both revisions.

import { Base64 } from "./base64.ts";
import fireRed11 from "./data/revision_firered_1_1.ts";
import leafGreen11 from "./data/revision_leafgreen_1_1.ts";

const ROM_BASE = 0x08000000;
const ROM_END = 0x09000000;

export interface Revision {
  base: string;
  sha1: string;
  segments: [number, number][];
  sites: string;
  siteCount: number;
}

const MODULES: Record<string, Revision> = {
  "7862c67bdecbe21d1d69ce082ce34327e1c6ed5e": leafGreen11 as unknown as Revision,
  "dd5945db9b930750cb39d00c84da8571feebf417": fireRed11 as unknown as Revision,
};

const byImports = new WeakMap<object, Uint8Array>();

function toBase(segments: [number, number][], revOffset: number): number {
  let delta = 0;
  for (const seg of segments) {
    if (seg[0] + seg[1] > revOffset) break;
    delta = seg[1];
  }
  return revOffset - delta;
}

function siteOffsets(rev: Revision): number[] {
  const [blob] = Base64.decode(rev.sites);
  if (blob === undefined) throw new Error("revision site table is damaged");
  const out: number[] = [];
  let pos = 0, value = 0, shift = 1;
  for (let i = 0; i < blob.length; i++) {
    const b = blob.charCodeAt(i);
    if (b >= 0x80) {
      value += (b - 0x80) * shift;
      shift *= 128;
    } else {
      pos += value + b * shift;
      out.push(pos);
      value = 0;
      shift = 1;
    }
  }
  if (out.length !== rev.siteCount) throw new Error("revision site table is damaged");
  return out;
}

export const RevisionView = {
  // Lua: revision_view.lua:15
  forSha1(sha1: unknown): Revision | undefined {
    if (typeof sha1 !== "string") return undefined;
    return MODULES[sha1.toLowerCase()];
  },

  // Lua: revision_view.lua:54
  build(romData: Uint8Array, rev: Revision): Uint8Array {
    const segments = rev.segments;
    const size = romData.length;
    const layout = new Uint8Array(size);
    let at = 0;
    for (let i = 0; i < segments.length; i++) {
      const [start, delta] = segments[i]!;
      const stop = segments[i + 1] ? segments[i + 1]![0] : size;
      const part = romData.subarray(start + delta, stop + delta);
      layout.set(part, at);
      at += part.length;
    }
    if (at !== size) throw new Error("revision layout does not cover the ROM");
    for (const site of siteOffsets(rev)) {
      const ptr = layout[site]! + layout[site + 1]! * 256 + layout[site + 2]! * 65536 + layout[site + 3]! * 16777216;
      if (ptr >= ROM_BASE && ptr < ROM_END) {
        const fixed = toBase(segments, ptr - ROM_BASE);
        layout[site] = fixed % 256;
        layout[site + 1] = Math.floor(fixed / 256) % 256;
        layout[site + 2] = Math.floor(fixed / 65536) % 256;
        layout[site + 3] = 0x08;
      }
    }
    return layout;
  },

  // Lua: revision_view.lua:85
  apply(romData: Uint8Array, sha1: string): Uint8Array {
    const rev = RevisionView.forSha1(sha1);
    if (!rev) return romData;
    return RevisionView.build(romData, rev);
  },

  // Lua: revision_view.lua:91
  forImports(imports: Imports, importId: string, info: ImportInfo): Uint8Array | undefined {
    const rev = RevisionView.forSha1(info.md5);
    if (!rev) return undefined;
    const cached = byImports.get(imports);
    if (cached) return cached;
    const view = RevisionView.build(imports.bytes(importId), rev);
    byImports.set(imports, view);
    return view;
  },
};

/** The `imports` handle extractors read the ROM through (mod.imports in the Lua). */
export interface ImportInfo { id: string; size: number; md5: string; file: string }
export interface Imports {
  info(id: string): ImportInfo | undefined;
  read(id: string, offset: number, length: number): string | undefined;
  /** The whole ROM, unrevised (the Lua reads it back in chunks). */
  bytes(id: string): Uint8Array;
}

export default RevisionView;
