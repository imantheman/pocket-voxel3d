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

function asPalette(colors: Colors | null | undefined): Palette4 {
  const c = colors ?? DMG_SHADES;
  const at = (i: number): Rgb => {
    const e = c[i] ?? c[c.length - 1] ?? [0, 0, 0];
    return [e[0] ?? 0, e[1] ?? 0, e[2] ?? 0];
  };
  return [at(0), at(1), at(2), at(3)];
}

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
    const shades = GbcPalette.bgpShades(byte);
    return shades.map((s) => colors[s] ?? colors[3]!);
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
