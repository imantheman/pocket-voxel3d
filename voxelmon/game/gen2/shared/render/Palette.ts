// gen1recomp src/render/Palette.lua (bdfac727): the custom colour ramps the
// COLOR option offers -- the mono tints and the palette packs.
//
// The packs come from `data.gb_palettes`, a desktop-only table the Gold
// dataset does not carry, so `packs()` is empty here (the Lua's pcall
// failing) and only the mono ramps resolve.

type Rgb = [number, number, number];
type Ramp = Rgb[];
interface PackEntry {
  name: string;
  pack: string;
  id: string;
}

// Palette.lua:15
const MONO_STEPS = [1.0, 0.72, 0.38, 0.12];

let pack: any[] | false | null = null;

// Palette.lua:38
function monoRamp(r: number, g: number, b: number): Ramp {
  const out: Ramp = [];
  for (let i = 0; i < 4; i++) {
    const f = MONO_STEPS[i]!;
    out[i] = [Math.floor(r * f + 0.5), Math.floor(g * f + 0.5), Math.floor(b * f + 0.5)];
  }
  return out;
}

function hex2(s: string): number | null {
  return /^[0-9a-fA-F]{2}$/.test(s) ? parseInt(s, 16) : null;
}

// Palette.lua:60
function unhex(text: unknown): Ramp | null {
  if (typeof text !== "string" || text.length !== 24) return null;
  const out: Ramp = [];
  for (let i = 0; i < 4; i++) {
    const at = i * 6;
    const r = hex2(text.slice(at, at + 2));
    const g = hex2(text.slice(at + 2, at + 4));
    const b = hex2(text.slice(at + 4, at + 6));
    if (r == null || g == null || b == null) return null;
    out[i] = [r, g, b];
  }
  return out;
}

const RAMP_INDEX = 1; // Palette.lua:76 (the Lua's 2, 1-based)
const GREY_CHROMA = 12;
const HUE_ARC = 50;

// Palette.lua:84
function hueChroma(c: readonly number[]): [number, number] {
  const r = c[0] ?? 0;
  const g = c[1] ?? 0;
  const b = c[2] ?? 0;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const chroma = mx - mn;
  if (chroma <= 0) return [0, 0];
  let h: number;
  if (mx === r) h = ((((g - b) / chroma) % 6) + 6) % 6;
  else if (mx === g) h = (b - r) / chroma + 2;
  else h = (r - g) / chroma + 4;
  return [h * 60, chroma];
}

// Palette.lua:99
function hueArc(hues: number[]): number {
  let best = 360;
  for (let i = 0; i < hues.length; i++) {
    let widest = 0;
    for (let j = 0; j < hues.length; j++) {
      const d = (((hues[j]! - hues[i]!) % 360) + 360) % 360;
      if (d > widest) widest = d;
    }
    if (widest < best) best = widest;
  }
  return best;
}

let byId: Record<string, any[]> | null = null;
let buckets: Record<string, PackEntry[]> | null = null;

// Palette.lua:133
function buildIndex(): void {
  byId = {};
  buckets = {};
  for (const category of Palette.CATEGORIES) buckets[category.key] = [];
  for (const p of Palette.packs()) {
    for (const entry of p.palettes ?? []) {
      const name = entry[0];
      if (typeof name === "string") {
        const id = Palette.packId(p.name, name);
        byId[id] = entry;
        const raw = unhex(entry[RAMP_INDEX] ?? entry[1]);
        const bucket = raw ? buckets[Palette.categoryOf(raw) ?? ""] : undefined;
        if (bucket) bucket.push({ name, pack: p.name, id });
      }
    }
  }
}

function ensureIndex(): void {
  if (!byId) buildIndex();
}

// Palette.lua:188
function findPack(group: string, name: string): any[] | undefined {
  ensureIndex();
  return byId![Palette.packId(group, name)];
}

let cacheId: string | null = null;
let cacheRamp: Ramp | null = null;

export const Palette = {
  /** Palette.lua:17 */
  MONO_COLOURS: [
    ["GREEN", 0x9b, 0xbc, 0x0f],
    ["LIME", 0xa8, 0xd8, 0x38],
    ["OLIVE", 0xa6, 0xac, 0x84],
    ["AMBER", 0xff, 0xb0, 0x00],
    ["ORANGE", 0xff, 0x80, 0x30],
    ["RED", 0xff, 0x50, 0x50],
    ["ROSE", 0xff, 0x90, 0xb0],
    ["MAGENTA", 0xf0, 0x60, 0xd0],
    ["PURPLE", 0xb0, 0x70, 0xf0],
    ["INDIGO", 0x80, 0x80, 0xf0],
    ["BLUE", 0x50, 0xa0, 0xff],
    ["CYAN", 0x40, 0xe0, 0xe0],
    ["TEAL", 0x40, 0xc0, 0xa0],
    ["MINT", 0x90, 0xe0, 0xb0],
    ["SAND", 0xe0, 0xc8, 0x90],
    ["BROWN", 0xc0, 0x90, 0x50],
    ["WHITE", 0xff, 0xff, 0xff],
    ["SILVER", 0xd0, 0xd8, 0xe0],
  ] as [string, number, number, number][],
  monoRamp,
  unhex,
  GREY_CHROMA,
  HUE_ARC,
  hueChroma,
  hueArc,
  /** Palette.lua:125 */
  CATEGORIES: [
    { key: "full", label: "FULL COLOUR" },
    { key: "single", label: "SINGLE COLOUR" },
    { key: "grey", label: "GREYSCALE" },
  ],
  findPack,

  /** Palette.lua:6 -- data.gb_palettes is not in the Gold dataset. */
  packs(): any[] {
    if (pack === null) pack = false;
    return pack || [];
  },

  /** Palette.lua:52 */
  packId(group: string, name: string): string {
    return "p:" + group + "/" + name;
  },

  /** Palette.lua:56 */
  monoId(r: number, g: number, b: number): string {
    const h = (n: number): string => n.toString(16).padStart(2, "0");
    return "m:" + h(r) + h(g) + h(b);
  },

  /** Palette.lua:114 */
  categoryOf(ramp: unknown): string | undefined {
    if (!Array.isArray(ramp) || !ramp[3]) return undefined;
    const hues: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [h, chroma] = hueChroma(ramp[i]);
      if (chroma > GREY_CHROMA) hues.push(h);
    }
    if (hues.length === 0) return "grey";
    return hueArc(hues) <= HUE_ARC ? "single" : "full";
  },

  /** Palette.lua:156 */
  categories(): { key: string; name: string; palettes: PackEntry[] }[] {
    ensureIndex();
    return Palette.CATEGORIES.map((c) => ({ key: c.key, name: c.label, palettes: buckets![c.key] ?? [] }));
  },

  /** Palette.lua:166 */
  category(key: string): { key: string; name: string; palettes: PackEntry[] } | undefined {
    ensureIndex();
    if (!buckets![key]) return undefined;
    for (const c of Palette.CATEGORIES) if (c.key === key) return { key, name: c.label, palettes: buckets![key]! };
    return undefined;
  },

  /** Palette.lua:177 -- the Lua's two returns: [categoryKey, 1-based index]. */
  locate(id: unknown): [string, number] | undefined {
    if (typeof id !== "string" || id === "") return undefined;
    ensureIndex();
    for (const c of Palette.CATEGORIES) {
      const list = buckets![c.key] ?? [];
      for (let i = 0; i < list.length; i++) if (list[i]!.id === id) return [c.key, i + 1];
    }
    return undefined;
  },

  /** Palette.lua:195 */
  label(id: unknown): string | undefined {
    if (typeof id !== "string" || id === "") return undefined;
    const hex = /^m:([0-9a-fA-F]+)$/.exec(id)?.[1];
    if (hex) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      for (const c of Palette.MONO_COLOURS) if (c[1] === r && c[2] === g && c[3] === b) return c[0];
      return "MONO";
    }
    const name = /^p:.*\/([^/]+)$/.exec(id)?.[1];
    return name ?? id;
  },

  /** Palette.lua:213 -- lightest first. */
  ramp(id: unknown): Ramp | null {
    if (typeof id !== "string" || id === "") return null;
    if (id === cacheId) return cacheRamp;
    let out: Ramp | null = null;
    const hex = /^m:([0-9a-fA-F]+)$/.exec(id)?.[1];
    if (hex && hex.length === 6) {
      out = monoRamp(parseInt(hex.slice(0, 2), 16) || 0, parseInt(hex.slice(2, 4), 16) || 0, parseInt(hex.slice(4, 6), 16) || 0);
    } else {
      const m = /^p:(.*)\/([^/]+)$/.exec(id);
      if (m) {
        const entry = findPack(m[1]!, m[2]!);
        const ramp = entry ? unhex(entry[RAMP_INDEX] ?? entry[1]) : null;
        if (ramp) out = [ramp[3]!, ramp[2]!, ramp[1]!, ramp[0]!];
      }
    }
    cacheId = id;
    cacheRamp = out;
    return out;
  },

  /** Palette.lua:238 */
  invalidate(): void {
    cacheId = null;
    cacheRamp = null;
    byId = null;
    buckets = null;
  },

  /** Palette.lua:243 */
  swatch(id: unknown): Ramp | null {
    const ramp = Palette.ramp(id);
    if (!ramp) return null;
    return [ramp[3]!, ramp[2]!, ramp[1]!, ramp[0]!];
  },
};

export default Palette;
