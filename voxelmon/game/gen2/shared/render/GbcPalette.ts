// gen1recomp src/render/GbcPalette.lua (bdfac727): draw a four-shade Game
// Boy graphic through a GBC palette.
//
// In LÖVE this was a shader recovering the shade from the pixel and
// substituting the palette entry. On the Gold screen every tile already IS
// shade indices and every cell and object names a palette, so "use this
// palette" just sets the palette the next draws go through (platform/
// screen.ts `G.palette`). The COLOR modes (GEN 2 / DMG / CLASSIC), the rBGP
// permutation (CopyPals) and `resolve` are the Lua's, unchanged.
//
// Palettes are four [r, g, b] entries, lightest first, 0-based arrays.
// `color(colors, index)` keeps the Lua's 1-based index.

import type { Palette4, Rgb } from "../../platform/lcd.ts";
import G, { DMG_SHADES } from "../../platform/screen.ts";

type Colors = readonly (readonly number[])[];

// GbcPalette.lua:40
const CLASSIC_SHADES: Palette4 = [
  [155, 188, 15],
  [139, 172, 15],
  [48, 98, 48],
  [15, 56, 15],
];

// One Palette4 per colour table, made once: a menu swaps palettes a few
// dozen times a frame, and building four fresh arrays each time cost more
// than the drawing. The same object back each time also lets lcd.palette
// answer from its last-palette check rather than matching colours again.
// Nothing writes into a palette once made.
//
// And one per colour CONTENT behind that: plenty of screens build their four
// colours afresh each frame (the HP bar, every tile of it), and those should
// land on the same palette object too. Keyed by the four colours packed two
// to a number (48 bits, exact); cleared if a long fade fills it.
const asPaletteCache = new WeakMap<object, Palette4>();
const byContent = new Map<number, Map<number, Palette4>>();
let byContentCount = 0;
const BY_CONTENT_MAX = 4096;
function entryOf(c: Colors, i: number): readonly number[] {
  return c[i] ?? c[c.length - 1] ?? [0, 0, 0];
}
function asPalette(colors: Colors | null | undefined): Palette4 {
  const c = colors ?? DMG_SHADES;
  const cached = asPaletteCache.get(c);
  if (cached) return cached;
  const e0 = entryOf(c, 0);
  const e1 = entryOf(c, 1);
  const e2 = entryOf(c, 2);
  const e3 = entryOf(c, 3);
  const r0 = e0[0] ?? 0, g0 = e0[1] ?? 0, b0 = e0[2] ?? 0;
  const r1 = e1[0] ?? 0, g1 = e1[1] ?? 0, b1 = e1[2] ?? 0;
  const r2 = e2[0] ?? 0, g2 = e2[1] ?? 0, b2 = e2[2] ?? 0;
  const r3 = e3[0] ?? 0, g3 = e3[1] ?? 0, b3 = e3[2] ?? 0;
  const k1 = (((r0 & 255) << 16) | ((g0 & 255) << 8) | (b0 & 255)) * 16777216
    + (((r1 & 255) << 16) | ((g1 & 255) << 8) | (b1 & 255));
  const k2 = (((r2 & 255) << 16) | ((g2 & 255) << 8) | (b2 & 255)) * 16777216
    + (((r3 & 255) << 16) | ((g3 & 255) << 8) | (b3 & 255));
  let inner = byContent.get(k1);
  if (!inner) {
    if (byContentCount >= BY_CONTENT_MAX) {
      byContent.clear();
      byContentCount = 0;
    }
    inner = new Map();
    byContent.set(k1, inner);
  }
  let p = inner.get(k2);
  if (!p) {
    p = [[r0, g0, b0], [r1, g1, b1], [r2, g2, b2], [r3, g3, b3]];
    inner.set(k2, p);
    byContentCount++;
  }
  asPaletteCache.set(c, p);
  return p;
}

// remap's reorderings, per table and byte: the same object back for the same
// pair, so asPalette's cache holds across a fade's frames too.
const remapCache = new WeakMap<object, Map<number, Colors>>();

export const GbcPalette = {
  MODES: ["gbc", "dmg", "classic"],
  MODE_LABELS: { gbc: "GEN 2", dmg: "DMG", classic: "CLASSIC", custom: "GBC" } as Record<string, string>,
  mode: "gbc",
  CUSTOM_MODE: "custom",
  DMG_SHADES,
  BGP_IDENTITY: 0xe4,
  REMAP_MAX: 64,
  customRamp: null as Colors | null,
  /** The active rBGP byte, or null for the identity (GbcPalette.lua:208). */
  bgp: null as number | null,

  /** Always: the Gold screen colours every draw. */
  available(): boolean {
    return true;
  },
  shader(): null {
    return null;
  },

  setCustomRamp(ramp: Colors | null): void {
    GbcPalette.customRamp = ramp;
  },

  /** GbcPalette.lua:179 -- what a palette draws as under the COLOR mode. */
  resolve(colors: Colors): Colors {
    if (GbcPalette.customRamp) return GbcPalette.customRamp;
    if (GbcPalette.mode === "gbc") return colors;
    return DMG_SHADES;
  },

  /** GbcPalette.lua:188 -- the byte's four fields, colour 0 first (0-based here). */
  bgpShades(byte?: number | null): number[] {
    const b = byte ?? GbcPalette.BGP_IDENTITY;
    const shades: number[] = [];
    for (let i = 0; i < 4; i++) shades.push((b >> (i * 2)) & 3);
    return shades;
  },

  /** GbcPalette.lua:197 -- CopyPals: reorder a palette by an rBGP byte. */
  remap(colors: Colors | null | undefined, byte?: number | null): Colors | null {
    if (!colors) return null;
    if (byte == null || byte === GbcPalette.BGP_IDENTITY) return colors;
    let byByte = remapCache.get(colors);
    if (!byByte) {
      byByte = new Map();
      remapCache.set(colors, byByte);
    }
    let out = byByte.get(byte);
    if (!out) {
      const shades = GbcPalette.bgpShades(byte);
      out = shades.map((s) => colors[s] ?? colors[3]!);
      byByte.set(byte, out);
    }
    return out;
  },

  /** GbcPalette.lua:210 -- returns the previous byte. */
  setBgp(byte: number | null | undefined): number | null {
    const previous = GbcPalette.bgp;
    GbcPalette.bgp = byte == null || byte === GbcPalette.BGP_IDENTITY ? null : byte;
    return previous;
  },

  /** GbcPalette.lua:217 -- entry `index` (1-based) as it draws now. */
  color(colors: Colors | null | undefined, index: number): readonly number[] {
    const resolved = colors ? GbcPalette.remap(GbcPalette.resolve(colors), GbcPalette.bgp) : null;
    if (resolved && resolved[index - 1]) return resolved[index - 1]!;
    return GbcPalette.remap(DMG_SHADES, GbcPalette.bgp)![index - 1]!;
  },

  presentColors(): Palette4 | null {
    return GbcPalette.mode === "classic" ? CLASSIC_SHADES : null;
  },

  setMode(mode: string): string {
    if (mode === GbcPalette.CUSTOM_MODE || GbcPalette.MODES.includes(mode)) GbcPalette.mode = mode;
    else GbcPalette.mode = "gbc";
    return GbcPalette.mode;
  },
  modeLabel(mode?: string): string {
    return GbcPalette.MODE_LABELS[mode ?? GbcPalette.mode] ?? "GEN 2";
  },
  cycle(delta = 1): string {
    let at = Math.max(0, GbcPalette.MODES.indexOf(GbcPalette.mode));
    const n = GbcPalette.MODES.length;
    at = (((at + delta) % n) + n) % n;
    GbcPalette.mode = GbcPalette.MODES[at]!;
    GbcPalette.setCustomRamp(null);
    return GbcPalette.mode;
  },
  applyOptions(opts?: { color?: string }): void {
    GbcPalette.setMode(opts?.color ?? "gbc");
  },

  /** GbcPalette.lua:271 -- draw through `colors` (rBGP folded in). */
  use(colors: Colors | null | undefined): boolean {
    G.palette = asPalette(GbcPalette.remap(GbcPalette.resolve(colors ?? DMG_SHADES), GbcPalette.bgp));
    G.keyed = false;
    return true;
  },
  /** GbcPalette.lua:276 -- without the rBGP byte. */
  useRaw(colors: Colors | null | undefined): boolean {
    G.palette = asPalette(colors);
    G.keyed = false;
    return true;
  },
  /** GbcPalette.lua:287 -- BG over OBJ with priority: colour 0 lets objects through. */
  useKeyed(colors: Colors | null | undefined): boolean {
    GbcPalette.use(colors);
    G.keyed = true;
    return true;
  },
  clear(): void {
    G.palette = DMG_SHADES;
    G.keyed = false;
  },

  // The backwards pass (a remap of an already drawn canvas) only served
  // World's baked map canvas, which the voxel world replaces.
  remapTable(): [never[], never[], number, number] {
    return [[], [], 0, 0];
  },
  useRemap(): boolean {
    return false;
  },
  remapUniforms(): null {
    return null;
  },
  useRemapUniforms(): boolean {
    return false;
  },

  /** GbcPalette.lua:395 -- `body` drawn through `colors`, then restored. */
  with<T>(colors: Colors | null | undefined, body: () => T): boolean {
    const pal = G.palette;
    const keyed = G.keyed;
    const applied = GbcPalette.use(colors);
    try {
      body();
    } finally {
      G.palette = pal;
      G.keyed = keyed;
    }
    return applied;
  },
  keyedWith<T>(colors: Colors | null | undefined, body: () => T): boolean {
    const pal = G.palette;
    const keyed = G.keyed;
    const applied = GbcPalette.useKeyed(colors);
    try {
      body();
    } finally {
      G.palette = pal;
      G.keyed = keyed;
    }
    return applied;
  },
  withRaw<T>(colors: Colors | null | undefined, body: () => T): boolean {
    const pal = G.palette;
    const keyed = G.keyed;
    const applied = GbcPalette.useRaw(colors);
    try {
      body();
    } finally {
      G.palette = pal;
      G.keyed = keyed;
    }
    return applied;
  },
};

export default GbcPalette;
