// Pokémon Yellow's own Game Boy Color colours (the ROM's CGBBasePalettes,
// which the importer stores as palettes.json `cgbBase`, in the SuperPalettes
// order).
//
// On a GBC, Yellow colours the field one palette per map -- the SGB
// scheme, SetPal_Overworld, with CGB colours -- sprites included, and each
// battle picture by its species' MonsterPalettes entry. The cook already
// packs one palette per SGB name and the guest already picks one per map
// (gamedata mapPalette -> the `palette` op); for Yellow those palettes are
// the GBC colours, and every battle-pic page names its species' palette
// through VCOL, which resolve_pal honours ahead of the map's.
//
// Red and Blue have no cgbBase and never take this path. VOXELMON_COLOUR=sgb
// cooks Yellow with its Super Game Boy colours instead.

import { ATLAS_KIND, COLOR_PAL_NONE } from "../../contracts/spec/voxel-spec.ts";
import type { GenData } from "./data.ts";
import type { ColourPlan, PageOwner } from "./redpp.ts";

type Palettes = GenData["palettes"] & { cgbBase?: Record<string, [number, number, number][]> };

/** Cook this dataset with its GBC colours? */
export function useGbc(gen: GenData): boolean {
  const pal = gen.palettes as Palettes;
  return !!pal.cgbBase && process.env.VOXELMON_COLOUR !== "sgb";
}

/** The colours packed for SGB name `name`: its GBC set when cooking GBC. */
export function paletteColours(gen: GenData, name: string): [number, number, number][] | undefined {
  const pal = gen.palettes as Palettes;
  if (useGbc(gen) && pal.cgbBase?.[name]) return pal.cgbBase[name];
  return pal.palettes[name];
}

/**
 * The VCOL records a GBC cook writes: no per-map world palettes (the map's
 * `palette` selection colours the terrain and the sprites) and, per battle
 * picture page, its species' palette -- an absolute VPAL index into the
 * packed name set, which starts after the four kind defaults.
 */
export function planGbc(gen: GenData, pages: PageOwner[], mapIds: number[]): ColourPlan {
  const base = Object.keys(ATLAS_KIND).length;
  const order = gen.palettes.order;
  const byName = new Map(order.map((n, i) => [n, base + i] as const));
  const monPal = (gen.palettes as { pokemon?: Record<string, string> }).pokemon ?? {};
  let pics = 0;
  const pagePal = pages.map((o) => {
    if (o.palette) return byName.get(o.palette) ?? COLOR_PAL_NONE;
    if (!o.species) return COLOR_PAL_NONE;
    const idx = byName.get(monPal[o.species] ?? "");
    if (idx === undefined) return COLOR_PAL_NONE;
    pics++;
    return idx;
  });
  return {
    palettes: [],
    // one record per cooked map, naming nothing: the map's palette op rules
    maps: mapIds.map((mapId) => ({ mapId, worldPal: COLOR_PAL_NONE, terrainPage: COLOR_PAL_NONE })),
    pagePal,
    flags: 0,
    stats: { world: 0, obj: 0, pic: 0, sprites: 0, pics },
  };
}
