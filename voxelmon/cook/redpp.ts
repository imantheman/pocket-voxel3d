// voxelmon/cook/redpp.ts — RED++ / pokered-gbc per-tile color.
//
// The reference is gen1recomp's ADVANCED colorization (`redpp` in
// src/render/PaletteFX.lua). It assigns one of 8 four-color BG palettes to
// every tile GRAPHIC id of a tileset (by tile id, NOT by map position) and
// swaps only the ROOF slot per town/route; sprites take one of 8 OBJ
// palettes by ROM picture id; battle pics take the species' named palette.
// The extracted data is `$VOXELMON_G1R/data/palettes_gbc.lua` — pokered-gbc
// -derived, MIT, NOT ROM-derived (Red ships no CGB code at all), resolved at
// cook time exactly like the VoxelMod tables (docs/VOXEL.md §1).
//
// Our model (docs/VOXEL.md §5, step 4): bake the GROUP into the terrain
// texel index and select the map's palette at BIND time.
//
//     texel = group * 4 + shade      // 0..31
//     0xff  = transparent            // unchanged
//
// 8 groups x 4 shades = 32 << 256, so a tileset's whole RED++ color set
// (measured union: 18-20 distinct colors) fits inside one CLUT8 page. Zero
// delta in page dimensions, texel count, texture format, fill rate, vertex
// count, draw calls or guest ops; the runtime cost is a few extra 1 KB
// pool-staged CLUTs per frame.
//
// INDEX BASES AFTER lua-dump (the #1 silent-miscolor risk — pinned by
// tests/voxel-cook.test.ts "the dumped pack keeps its index bases"):
// dense 1..n Lua tables become JSON ARRAYS (every index shifts down by one),
// 0-keyed tables become OBJECTS with string keys. So `groupColors[TS]` is an
// 8-element array indexed DIRECTLY by group 0..7 (Lua's `base[ROOF+1]` is
// our `base[ROOF]`), while `tileGroups[TS]`, `spritePalettes`,
// `spriteAssignment` and `roofByMapIndex` are string-keyed objects.

import { COLOR_PAL_NONE, VXPK_COLOR_FLAG_WORLD } from "../../contracts/spec/voxel-spec.ts";
import { type GenData, PX_CLEAR } from "./data.ts";

export type Rgb = [number, number, number];

/** `$VOXELMON_G1R/data/palettes_gbc.lua`, after the lua-dump normalization. */
export interface RedppPack {
  /** Palette names in the pack's own order (239). */
  order: string[];
  /** name -> 4 colors, lightest first. */
  palettes: Record<string, Rgb[]>;
  /** species -> palette name (151; identical to the ROM's own name map). */
  pokemon: Record<string, string>;
  source?: string;
  world: {
    /** tileset -> { "<tileId 0..95>": group 0..7 }. */
    tileGroups: Record<string, Record<string, number>>;
    /** tileset -> [group 0..7][shade 0..3] = rgb. */
    groupColors: Record<string, Rgb[][]>;
    /** tileset -> the town-swappable group (OVERWORLD/PLATEAU = 6). */
    roofGroup: Record<string, number>;
    /** "<map.index>" -> the town's 2 roof shades. */
    roofByMapIndex: Record<string, [Rgb, Rgb]>;
    /** "0".."7" -> 4 OBJ colors. */
    spritePalettes: Record<string, Rgb[]>;
    /** "<ROM picture id 0..71>" -> OBJ palette 0..3, or "random". */
    spriteAssignment: Record<string, number | "random">;
  };
}

// ---------------------------------------------------------------------------
// the reference's control flow (PaletteFX.lua:558-603) — data lives in the
// pack, these three tables do NOT: pokered-gbc carries them as code, so the
// extractor leaves them out and PaletteFX transcribes them next to the code
// that consumes the pack. We do the same.
// ---------------------------------------------------------------------------

/** LoadTilesetPalette's hardcoded per-map fixes (PaletteFX.lua:558-567). */
export const TILE_GROUP_EXCEPTIONS: Record<string, { tiles: number[]; group: number }> = {
  // tile ids $4b-$4f -> BLUE (outside sky, seen through the mart's roof)
  CELADON_MART_ROOF: { tiles: [0x4b, 0x4c, 0x4d, 0x4e, 0x4f], group: 3 },
  // tile $37 -> BROWN (counter miscoloration fix)
  CELADON_MART_3F: { tiles: [0x37], group: 5 },
  // tiles $07/$08/$17/$18 -> YELLOW (bench, blue by default)
  CELADON_MART_1F: { tiles: [0x07, 0x08, 0x17, 0x18], group: 4 },
};

/** Per-tileset fixes, consulted after the per-map table (PaletteFX.lua:571-576). */
export const TILESET_GROUP_EXCEPTIONS: Record<string, { tiles: number[]; group: number }> = {
  // tile $22 (the hollow-square grave marker) -> GRAY
  CEMETERY: { tiles: [0x22], group: 0 },
};

/** The town-swappable slot (PaletteFX.lua:601). */
export const ROOF_GROUP = 6;
/** Tile ids past a tileset's 96 fall to TEXT (PaletteFX.lua:628). */
export const DEFAULT_GROUP = 7;
/** Groups per tileset, shades per group: the 32 texel indices we bake into. */
export const GROUPS = 8;
export const SHADES = 4;

function abgr(c: Rgb): number {
  return ((0xff000000 | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0);
}

/** An empty 256-entry CLUT in the gbPalette shape: black, PX_CLEAR clear. */
function clut(): Uint32Array {
  const pal = new Uint32Array(256).fill(0xff000000);
  pal[PX_CLEAR] = 0x00000000;
  return pal;
}

/**
 * The reference's `"random"` resolver (PaletteFX.lua:685-690):
 * `h = (h*31 + byte) mod 2^32` over a stable seed string, `pal = h mod 4`.
 * Ported verbatim; only the SEED differs (see [`Redpp.objGroupOf`]).
 */
export function randomPal(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) >>> 0;
  return h % 4;
}

/** The resolution layer over one loaded pack. Pure; no I/O. */
export class Redpp {
  constructor(readonly pack: RedppPack) {}

  /** Does the pack carry real per-tile data for this tileset? (`:610-615`) */
  hasTileset(tileset: string): boolean {
    return this.pack.world.tileGroups[tileset] !== undefined;
  }

  /**
   * `PaletteFX.worldGroupAt` (`:618-628`): per-map exceptions, then
   * per-tileset exceptions, then the pack, else TEXT. `mapId` is null when
   * the caller has no single map (our terrain page is shared across maps —
   * see [`mapExceptions`]).
   */
  groupOf(tileset: string, mapId: string | null, tileId: number): number | null {
    const groups = this.pack.world.tileGroups[tileset];
    if (!groups) return null;
    if (mapId) {
      const perMap = TILE_GROUP_EXCEPTIONS[mapId];
      if (perMap && perMap.tiles.includes(tileId)) return perMap.group;
    }
    const perTileset = TILESET_GROUP_EXCEPTIONS[tileset];
    if (perTileset && perTileset.tiles.includes(tileId)) return perTileset.group;
    return groups[String(tileId)] ?? DEFAULT_GROUP;
  }

  /** Cook-time identity of a tileset's 96-entry group vector (page split key). */
  groupVectorKey(tileset: string): string {
    const groups = this.pack.world.tileGroups[tileset] ?? {};
    const perTileset = TILESET_GROUP_EXCEPTIONS[tileset];
    const out: number[] = [];
    for (let t = 0; t < 96; t++) {
      out.push(
        perTileset && perTileset.tiles.includes(t)
          ? perTileset.group
          : (groups[String(t)] ?? DEFAULT_GROUP),
      );
    }
    return out.join(",");
  }

  /** Maps whose tile-id exceptions this cook cannot honour (one shared page). */
  static mapExceptions(mapIds: string[]): string[] {
    return mapIds.filter((id) => TILE_GROUP_EXCEPTIONS[id] !== undefined);
  }

  /**
   * `PaletteFX.worldGroupColors` (`:634-658`) baked into a 256-entry CLUT:
   * `[g*4+s]` = the group's shade color, `[0xff]` transparent, rest black.
   * The roof swap replaces ONLY colors 1 and 2 of the ROOF group — color 0
   * (sky through the gaps) and color 3 (outline black) keep the tileset's
   * own OUTDOOR_ROOF/INDOOR_ROOF base, exactly as LoadTownPalette does.
   * `mapIndex` null (or a map with no roof entry) keeps the base throughout.
   */
  worldPalette(tileset: string, mapIndex: number | null): Uint32Array | null {
    const w = this.pack.world;
    const base = w.groupColors[tileset];
    if (!base) return null;
    const groups: Rgb[][] = base.map((g) => g.slice());
    const roof = mapIndex === null ? undefined : w.roofByMapIndex[String(mapIndex)];
    if (w.roofGroup[tileset] !== undefined && roof) {
      const b = base[ROOF_GROUP];
      groups[ROOF_GROUP] = [b[0], roof[0], roof[1], b[3]];
    }
    const pal = clut();
    for (let g = 0; g < GROUPS; g++) {
      const shades = groups[g];
      if (!shades) continue;
      for (let s = 0; s < SHADES; s++) pal[g * SHADES + s] = abgr(shades[s]);
    }
    return pal;
  }

  /**
   * One OBJ palette as a CLUT (`SpriteRenderer.getObpImage`, `:41-60`):
   * GBC OBJ color 0 is transparent unconditionally, shades 1/2/3 take OBJ
   * colors 1/2/3. Our sprite sheets already decode shade 0 to PX_CLEAR
   * (import/gfx.ts `transparent = true`), so entry 0 is defensive.
   */
  objPalette(group: number): Uint32Array | null {
    const colors = this.pack.world.spritePalettes[String(group)];
    if (!colors) return null;
    const pal = clut();
    pal[0] = 0x00000000;
    for (let s = 1; s < SHADES; s++) pal[s] = abgr(colors[s]);
    return pal;
  }

  /**
   * `PaletteFX.spriteObp` (`:670-692`): the OBJ palette group of a sprite
   * whose importer `source` carries the ROM crosswalk
   * (`"ROM:SpriteSheetPointerTable[N]"`). `RedBikeSprite` loads outside the
   * table and wears the player's palette (`:678-682`).
   *
   * `"random"` is a v1 DEVIATION, stated in docs/VOXEL.md §6: the reference
   * resolves it per NPC instance from a stable per-instance seed; we resolve
   * it ONCE per sheet at cook time (the page, not the entity, carries the
   * CLUT), seeding [`randomPal`] with the sheet key so every constant
   * sharing a sheet agrees by construction.
   */
  objGroupOf(source: string, sheetSeed: string): number | null {
    const w = this.pack.world;
    const m = /\[(\d+)\]/.exec(source);
    let index: number | null = m ? Number(m[1]) : null;
    if (index === null && /RedBikeSprite|SurfingPikachuSprite/.test(source)) index = 0;
    if (index === null) return null;
    const assigned = w.spriteAssignment[String(index)];
    if (assigned === undefined) return null;
    return assigned === "random" ? randomPal(sheetSeed) : assigned;
  }

  /** A species' battle-pic CLUT: species -> pack name -> the pack's colors. */
  picPaletteName(species: string): string | null {
    return this.pack.pokemon[species] ?? null;
  }

  /** A named SuperPalette as a CLUT over GB shades 0..3. */
  namedPalette(name: string): Uint32Array | null {
    const colors = this.pack.palettes[name];
    if (!colors) return null;
    const pal = clut();
    for (let s = 0; s < SHADES; s++) pal[s] = abgr(colors[s]);
    return pal;
  }
}

// ---------------------------------------------------------------------------
// the VCOL plan — every binding the pak carries, resolved at cook time
// ---------------------------------------------------------------------------

/** What a page draws, so the planner can pick its CLUT. */
export interface PageOwner {
  kind: number;
  /** gfx key of a sprite page ("sprites/red"). */
  spriteKey?: string;
  /** species id of a battle-pic page. */
  species?: string;
  /** An SGB palette name the page is drawn in (Yellow's intro pictures). */
  palette?: string;
}

/** One cooked map, as the planner needs it. */
export interface ColourMapInput {
  id: string;
  mapId: number;
  tileset: string;
  /** `map.index` — the roof lookup key. */
  index: number;
  /** gfx key of the map's tileset sheet. */
  sheetKey: string;
}

export interface ColourPlan {
  /** The VPAL tail: appended after the 4 kind defaults + the SGB set. */
  palettes: Uint32Array[];
  /** VCOL map records, in the cook's map order. */
  maps: { mapId: number; worldPal: number; terrainPage: number }[];
  /** VCOL page records: absolute VPAL index, or COLOR_PAL_NONE. */
  pagePal: number[];
  flags: number;
  stats: { world: number; obj: number; pic: number; sprites: number; pics: number };
}

/**
 * Resolve every RED++ binding this pak needs: one world CLUT per (tileset,
 * roof) in use, one OBJ CLUT per sprite sheet, one pic CLUT per species
 * palette name — all dedup'd into a single VPAL tail starting at `base`.
 *
 * Terrain gets no `page_pal`: its CLUT is the shown MAP's world palette, so
 * two maps with different roofs share one page and differ only in the CLUT
 * (which is exactly what makes the combined page survive).
 */
/**
 * Red's SpriteSheetPointerTable by sprite constant, the order the community
 * pack's `spriteAssignment` is keyed by (pokered constants/sprite_constants.asm,
 * SPRITE_RED = index 0). Yellow's table shares the names, not the order.
 */
const RED_SPRITE_INDEX = [
  "SPRITE_RED", "SPRITE_BLUE", "SPRITE_OAK", "SPRITE_YOUNGSTER", "SPRITE_MONSTER", "SPRITE_COOLTRAINER_F",
  "SPRITE_COOLTRAINER_M", "SPRITE_LITTLE_GIRL", "SPRITE_BIRD", "SPRITE_MIDDLE_AGED_MAN", "SPRITE_GAMBLER",
  "SPRITE_SUPER_NERD", "SPRITE_GIRL", "SPRITE_HIKER", "SPRITE_BEAUTY", "SPRITE_GENTLEMAN", "SPRITE_DAISY",
  "SPRITE_BIKER", "SPRITE_SAILOR", "SPRITE_COOK", "SPRITE_BIKE_SHOP_CLERK", "SPRITE_MR_FUJI", "SPRITE_GIOVANNI",
  "SPRITE_ROCKET", "SPRITE_CHANNELER", "SPRITE_WAITER", "SPRITE_SILPH_WORKER_F", "SPRITE_MIDDLE_AGED_WOMAN",
  "SPRITE_BRUNETTE_GIRL", "SPRITE_LANCE", "SPRITE_UNUSED_SCIENTIST", "SPRITE_SCIENTIST", "SPRITE_ROCKER",
  "SPRITE_SWIMMER", "SPRITE_SAFARI_ZONE_WORKER", "SPRITE_GYM_GUIDE", "SPRITE_GRAMPS", "SPRITE_CLERK",
  "SPRITE_FISHING_GURU", "SPRITE_GRANNY", "SPRITE_NURSE", "SPRITE_LINK_RECEPTIONIST", "SPRITE_SILPH_PRESIDENT",
  "SPRITE_SILPH_WORKER_M", "SPRITE_WARDEN", "SPRITE_CAPTAIN", "SPRITE_FISHER", "SPRITE_KOGA", "SPRITE_GUARD",
  "SPRITE_UNUSED_GUARD", "SPRITE_MOM", "SPRITE_BALDING_GUY", "SPRITE_LITTLE_BOY", "SPRITE_UNUSED_GAMEBOY_KID",
  "SPRITE_GAMEBOY_KID", "SPRITE_FAIRY", "SPRITE_AGATHA", "SPRITE_BRUNO", "SPRITE_LORELEI", "SPRITE_SEEL",
  "SPRITE_POKE_BALL", "SPRITE_FOSSIL", "SPRITE_BOULDER", "SPRITE_PAPER", "SPRITE_POKEDEX", "SPRITE_CLIPBOARD",
  "SPRITE_SNORLAX", "SPRITE_UNUSED_OLD_AMBER", "SPRITE_OLD_AMBER", "SPRITE_UNUSED_GAMBLER_ASLEEP_1",
  "SPRITE_UNUSED_GAMBLER_ASLEEP_2", "SPRITE_GAMBLER_ASLEEP",
];

/**
 * Yellow's sprites Red never had, and the pack's OBJ palette each wears
 * (0 red, 1 blue, 2 green, 3 brown, 4 pink, 7 gold): a choice made here, the
 * pack having none for them. Yellow's three UNUSED_RED copies stay unbound.
 */
const YELLOW_ONLY_OBJ: Record<string, number> = {
  SPRITE_PIKACHU: 7,
  SPRITE_OFFICER_JENNY: 1,
  SPRITE_SANDSHREW: 3,
  SPRITE_ODDISH: 2,
  SPRITE_BULBASAUR: 2,
  SPRITE_JIGGLYPUFF: 4,
  SPRITE_CLEFAIRY: 4,
  SPRITE_CHANSEY: 4,
  SPRITE_JESSIE: 0,
  SPRITE_JAMES: 1,
};

export function planColour(
  gen: GenData,
  redpp: Redpp,
  input: {
    base: number;
    maps: ColourMapInput[];
    bakedSheets: Set<string>;
    terrainPage: number;
    pages: PageOwner[];
  },
): ColourPlan {
  const palettes: Uint32Array[] = [];
  const byKey = new Map<string, number>();
  const intern = (pal: Uint32Array): number => {
    const key = pal.join(",");
    const hit = byKey.get(key);
    if (hit !== undefined) return hit;
    const index = input.base + palettes.length;
    palettes.push(pal);
    byKey.set(key, index);
    return index;
  };

  // --- world palettes, one per (tileset, roof) actually shown -------------
  let world = 0;
  const maps = input.maps.map((m) => {
    let worldPal = COLOR_PAL_NONE;
    if (input.bakedSheets.has(m.sheetKey)) {
      const pal = redpp.worldPalette(m.tileset, m.index);
      if (!pal) {
        throw new Error(
          `RED++ color: sheet ${m.sheetKey} is group-baked but tileset ` +
            `${m.tileset} (map ${m.id}) has no groupColors`,
        );
      }
      const before = palettes.length;
      worldPal = intern(pal);
      if (palettes.length !== before) world++;
    }
    return { mapId: m.mapId, worldPal, terrainPage: input.terrainPage };
  });

  // --- OBJ palettes, one per sprite sheet ---------------------------------
  // Several sprite CONSTANTS can share one sheet (import/stages/sprites.ts:41
  // dedups by gfx key) and the page is per SHEET, so the constants must
  // agree. They do in the ROM's own data: the only shared sheets are unused
  // duplicates. An explicit assignment beats the "random" sentinel (which is
  // an approximation either way — see Redpp.objGroupOf); two DIFFERENT
  // explicit assignments on one sheet are a cook error.
  const objBySheet = new Map<string, { group: number; from: string; explicit: boolean }>();
  // Yellow (cooked with the community pack only when asked): its sprite
  // table is Red's reordered and extended, and the pack is keyed by Red's
  // table, so a Yellow sprite takes the palette of Red's sprite of the same
  // name; the sprites Red never had take one picked for them.
  const yellow = !!(gen.palettes as { cgbBase?: unknown }).cgbBase;
  for (const sprite of Object.values(gen.sprites)) {
    const key = sprite.image.replace(/^assets\/generated\//, "").replace(/\.png$/, "");
    const raw = /\[(\d+)\]/.exec(sprite.source);
    let romIndex: number | null = raw
      ? Number(raw[1])
      : /RedBikeSprite|SurfingPikachuSprite/.test(sprite.source)
        ? 0
        : null;
    let source = sprite.source;
    let explicit: boolean;
    let group: number | null;
    if (yellow && YELLOW_ONLY_OBJ[sprite.id] !== undefined) {
      group = YELLOW_ONLY_OBJ[sprite.id]!;
      explicit = true;
    } else {
      if (yellow && raw) {
        const red = RED_SPRITE_INDEX.indexOf(sprite.id);
        romIndex = red >= 0 ? red : null;
        source = red >= 0 ? `ROM:SpriteSheetPointerTable[${red}]` : "";
      }
      explicit =
        romIndex !== null && redpp.pack.world.spriteAssignment[String(romIndex)] !== "random";
      group = romIndex === null && yellow ? null : redpp.objGroupOf(source, key);
    }
    if (group === null) continue;
    const seen = objBySheet.get(key);
    if (!seen) {
      objBySheet.set(key, { group, from: sprite.id, explicit });
      continue;
    }
    if (seen.explicit && explicit && seen.group !== group) {
      throw new Error(
        `RED++ color: sprites ${seen.from} and ${sprite.id} share sheet ${key} ` +
          `but take OBJ palettes ${seen.group} and ${group}`,
      );
    }
    if (explicit && !seen.explicit) objBySheet.set(key, { group, from: sprite.id, explicit });
  }

  // --- per page -----------------------------------------------------------
  let obj = 0;
  let pic = 0;
  let sprites = 0;
  let pics = 0;
  const pagePal = input.pages.map((owner) => {
    if (owner.spriteKey !== undefined) {
      const hit = objBySheet.get(owner.spriteKey);
      if (!hit) return COLOR_PAL_NONE;
      const pal = redpp.objPalette(hit.group);
      if (!pal) return COLOR_PAL_NONE;
      const before = palettes.length;
      const index = intern(pal);
      if (palettes.length !== before) obj++;
      sprites++;
      return index;
    }
    if (owner.species !== undefined) {
      const name = redpp.picPaletteName(owner.species);
      if (!name) return COLOR_PAL_NONE;
      const pal = redpp.namedPalette(name);
      if (!pal) return COLOR_PAL_NONE;
      const before = palettes.length;
      const index = intern(pal);
      if (palettes.length !== before) pic++;
      pics++;
      return index;
    }
    return COLOR_PAL_NONE;
  });

  return {
    palettes,
    maps,
    pagePal,
    flags: input.bakedSheets.size > 0 ? VXPK_COLOR_FLAG_WORLD : 0,
    stats: { world, obj, pic, sprites, pics },
  };
}
