// The cook's Gen 2 (Gold) side: the imported dataset (import/gen2, Brian's
// shapes) seen the way the rest of the cook reads a map, and Gold's own GBC
// colours laid onto the RED++ machinery.
//
// Colour. A Gold tileset names, per tile, which of the eight BG palette
// slots it draws with (tilePalettes); a map's environment (TOWN, ROUTE,
// INDOOR, ...) names which eight palettes fill those slots at each time of
// day, and outdoors the ROOF slot's two middle colours come from the map
// group (LoadMapPals). That is exactly RED++'s model -- a texel is
// group*4 + shade, and each map shows the pages through its own world CLUT
// -- so the terrain bakes `slot*4 + shade` and each map gets a world palette.
// Daytime is DAY for now; morning and night are the next step.

import { COLOR_PAL_NONE, VXPK_COLOR_FLAG_DAYTIME, VXPK_COLOR_FLAG_WORLD } from "../../contracts/spec/voxel-spec.ts";
import type { GenData, MapDef, TilesetDef } from "./data.ts";
import type { ColourPlan, PageOwner } from "./redpp.ts";

type Rgb = [number, number, number];

interface Gen2Palettes {
  generation: 2;
  bg: Rgb[][];
  environments: Record<string, Record<string, number[]>>;
  objects: Record<string, Rgb[][]>;
  roofs: Record<string, { mornDay: Rgb[]; nite: Rgb[] }>;
  roofSlot: number;
}

interface Gen2Map extends MapDef {
  generation: 2;
  group: number;
  map: number;
  environment: string;
  bgEvents?: unknown[];
  connections?: Record<string, { map: string; offset: number; mapId?: string }>;
}

interface Gen2Tileset extends TilesetDef {
  tilePalettes?: number[];
}

export function isGen2(gen: { version?: string; palettes?: unknown }): boolean {
  return gen.version === "gold" || (gen.palettes as { generation?: number } | undefined)?.generation === 2;
}

/** A Gold map's number in the paks and index.txt: its (group, map) pair. */
export function gen2MapIndex(group: number, map: number): number {
  return (group << 8) | map;
}

/** Environments shown under the sky (the voxel cook's outdoor rules). */
const OUTDOOR_ENVIRONMENTS = new Set(["TOWN", "ROUTE"]);

/**
 * Give Brian's map and tileset records the fields the cook reads: an index,
 * outdoor-ness, connections named by `map`, signs, and an (unused) walkable
 * list -- a Gen 2 cell is judged by its collision byte (data.ts GameMap).
 */
export function normalizeGen2(gen: GenData): void {
  for (const def of Object.values(gen.maps) as Gen2Map[]) {
    def.index = gen2MapIndex(def.group, def.map);
    def.outdoor = OUTDOOR_ENVIRONMENTS.has(def.environment);
    def.signs ??= def.bgEvents ?? [];
    for (const c of Object.values(def.connections ?? {})) c.map = c.mapId ?? c.map;
  }
  for (const [id, ts] of Object.entries(gen.tilesets)) {
    if (typeof ts !== "object" || ts === null || !("blocks" in ts)) {
      delete (gen.tilesets as Record<string, unknown>)[id]; // waterFrames and friends
      continue;
    }
    ts.walkable ??= [];
  }
}

const SHADES = 4;

/** A 256-entry CLUT: `slot*4 + shade` for eight slots, PX_CLEAR transparent. */
function worldClut(slots: Rgb[][]): Uint32Array {
  const pal = new Uint32Array(256).fill(0xff000000);
  slots.forEach((colours, s) => {
    for (let i = 0; i < SHADES; i++) {
      const [r, g, b] = colours[i] ?? [0, 0, 0];
      pal[s * SHADES + i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    }
  });
  pal[0xff] = 0;
  return pal;
}

function spriteClut(colours: Rgb[]): Uint32Array {
  return worldClut([colours]);
}

/**
 * What bakeGroups (atlas.ts) asks of a colour pack, answered from Gold's
 * palette maps: every tileset is known, and a tile's group is its slot.
 */
export class Gen2Colour {
  constructor(readonly gen: GenData) {}

  private get pal(): Gen2Palettes {
    return this.gen.palettes as unknown as Gen2Palettes;
  }

  hasTileset(id: string): boolean {
    return Array.isArray((this.gen.tilesets[id] as Gen2Tileset | undefined)?.tilePalettes);
  }

  groupVectorKey(id: string): string {
    return ((this.gen.tilesets[id] as Gen2Tileset).tilePalettes ?? []).join(",");
  }

  /** The tile's BG slot, 0-based (tilePalettes is 1-based). */
  groupOf(tilesetId: string, _map: string | null, tileId: number): number | null {
    const slot = (this.gen.tilesets[tilesetId] as Gen2Tileset | undefined)?.tilePalettes?.[tileId];
    return slot === undefined ? null : slot - 1;
  }

  /** A map's world CLUT at `daytime`: its environment's eight BG palettes,
   * the roof slot's middle two colours from its map group outdoors. */
  worldPalette(def: Gen2Map, daytime = "DAY"): Uint32Array | null {
    const env = this.pal.environments[def.environment]?.[daytime];
    if (!env) return null;
    const slots = env.map((i) => [...(this.pal.bg[i - 1] ?? [])] as Rgb[]);
    const roof = this.pal.roofs[String(def.group)];
    const rs = this.pal.roofSlot - 1;
    if (roof && def.outdoor && slots[rs]) {
      const two = daytime === "NITE" || daytime === "DARK" ? roof.nite : roof.mornDay;
      slots[rs] = [slots[rs]![0]!, two[0]!, two[1]!, slots[rs]![3]!];
    }
    return worldClut(slots);
  }

  /** An overworld sprite sheet's OBJ CLUT (MapObjectPals at `daytime`). */
  spritePalette(paletteId: number, daytime = "DAY"): Uint32Array | null {
    const set = this.pal.objects[daytime]?.[paletteId];
    return set ? spriteClut(set) : null;
  }
}

/** Gold's times of day, in the order the `daytime` op counts them. */
export const GEN2_DAYTIMES = ["MORN", "DAY", "NITE", "DARK"] as const;

/**
 * The VCOL plan for a Gold cook: for every map, its world palette at each
 * time of day (MORN, DAY, NITE, DARK) as four consecutive VPAL entries, and
 * the same four for every sprite sheet's OBJ palette (MapObjectPals), dedup'd
 * as whole fours into the VPAL tail from `base`. VXPK_COLOR_FLAG_DAYTIME
 * tells the core that each binding names the first of four, and the guest's
 * `daytime` op picks the one drawn -- Gold's own day and night, which
 * pokegold applies by reloading exactly these palettes.
 */
export function planGen2(
  gen: GenData,
  colour: Gen2Colour,
  input: { base: number; maps: MapDef[]; terrainPage: number; pages: PageOwner[] },
): ColourPlan {
  const palettes: Uint32Array[] = [];
  const byKey = new Map<string, number>();
  // a whole four, interned together so a binding's +0..+3 stay its own
  const intern4 = (four: Uint32Array[]): number => {
    const key = four.map((p) => p.join(",")).join("|");
    const hit = byKey.get(key);
    if (hit !== undefined) return hit;
    const at = input.base + palettes.length;
    palettes.push(...four);
    byKey.set(key, at);
    return at;
  };
  const fourOf = (one: (daytime: string) => Uint32Array | null): Uint32Array[] | null => {
    const day = one("DAY");
    if (!day) return null;
    return GEN2_DAYTIMES.map((t) => one(t) ?? day);
  };
  let world = 0;
  const maps = input.maps.map((def) => {
    const four = fourOf((t) => colour.worldPalette(def as Gen2Map, t));
    const before = palettes.length;
    const worldPal = four ? intern4(four) : COLOR_PAL_NONE;
    if (palettes.length !== before) world++;
    return { mapId: def.index, worldPal, terrainPage: input.terrainPage };
  });
  const byKeySprite = new Map<string, number>();
  for (const s of Object.values(gen.sprites) as { image: string; paletteId?: number }[]) {
    if (typeof s.paletteId === "number") byKeySprite.set(s.image, s.paletteId);
  }
  let obj = 0;
  let sprites = 0;
  const pagePal = input.pages.map((owner) => {
    if (owner.spriteKey === undefined) return COLOR_PAL_NONE;
    const id = byKeySprite.get(owner.spriteKey);
    const four = id === undefined ? null : fourOf((t) => colour.spritePalette(id, t));
    if (!four) return COLOR_PAL_NONE;
    const before = palettes.length;
    const index = intern4(four);
    if (palettes.length !== before) obj++;
    sprites++;
    return index;
  });
  return {
    palettes,
    maps,
    pagePal,
    flags: VXPK_COLOR_FLAG_WORLD | VXPK_COLOR_FLAG_DAYTIME,
    stats: { world, obj, pic: 0, sprites, pics: 0 },
  };
}
