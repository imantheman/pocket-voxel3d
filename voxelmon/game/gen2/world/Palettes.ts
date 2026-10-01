// gen1recomp src/world/gen2/Palettes.lua at bdfac727 (MIT).
//
// Gen 2 GBC palette resolution: which four colors each tile, sprite and pic
// draws with right now.  Pure table math over palettes.json -- no drawing --
// so tests and tools can ask the same questions the renderer does.
// shared/render/GbcPalette.ts turns the answers into draw calls.
//
// Ported from engine/gfx/color.asm LoadMapPals and
// engine/tilesets/timeofday_pals.asm ReplaceTimeOfDayPals:
//
//   real clock hour  -> wTimeOfDay        (GetTimeOfDay, engine/rtc/rtc.asm)
//   + map header     -> wMapTimeOfDay     (PALETTE_* override)
//   = wTimeOfDayPal  -> the daytime whose colors actually load
//
// and then, for that daytime:
//
//   EnvironmentColorsPointers[environment][daytime] -> 8 TilesetBGPalette ids
//   RoofPals[mapGroup]                              -> PAL_BG_ROOF colors 1-2
//   MapObjectPals[daytime]                          -> the 8 OBJ palettes
//
// A tile's slot within that 8-palette set comes from its tileset's PalMap
// (tilesets.json `tilePalettes`, 1-based values); a sprite's comes from
// sprites.json `paletteId` (PAL_OW_*, 0-based).
//
// Indexing here: every returned set is a 0-based JS array of 8 palettes, each
// a 0-based array of four [r, g, b]; so Lua `set[slot]` is `set[slot - 1]`.
// The palettes.json `environments` rows hold 1-based indices into the `bg`
// pool (Lua `data.bg[i]` is `data.bg[i - 1]`).

import { osDate } from "../platform/clock.ts";
import { mod, tonumber, tostring } from "../platform/lua.ts";

export type Rgb3 = number[];
export type Colors4 = Rgb3[];
export type PaletteSet = Colors4[];
export type Daytime = "MORN" | "DAY" | "NITE" | "DARK";

/** The palettes.json table (Lua data/generated/palettes.lua). */
export interface PaletteData {
  bg?: (number[][] | undefined)[];
  environments?: Record<string, Record<string, number[] | undefined> | undefined>;
  specialTilesets?: Record<string, (number[][] | undefined)[] | undefined>;
  roofSlot?: number;
  roofs?: Record<string, { mornDay?: number[][]; nite?: number[][] } | undefined>;
  objects?: Record<string, PaletteSet | undefined>;
  pokemon?: Record<string, { normal?: number[][]; shiny?: number[][] } | undefined>;
  trainers?: Record<string, number[][] | undefined>;
  [k: string]: any;
}

// Lua: Palettes.lua:34 -- engine/rtc/rtc.asm TimesOfDay: 0400-0959 morn,
// 1000-1759 day, 1800-0359 nite.  The table is a run of "hour < N -> this
// daytime" rows, so the last row wrapping back to NITE is what makes
// midnight-to-4am night.
const MORN_HOUR = 4;
const DAY_HOUR = 10;
const NITE_HOUR = 18;

// Lua: Palettes.lua:48 -- roofs are only recolored outdoors; LoadMapPals
// returns early for anything that is not TOWN or ROUTE, so an indoor map
// keeps the pool's roof palette.
const ROOF_ENVIRONMENTS: Record<string, boolean> = { TOWN: true, ROUTE: true };

// Lua: Palettes.lua:52 -- ReplaceTimeOfDayPals.BrightnessLevels, read out as
// a plain lookup: the map's PALETTE_* either follows the clock (AUTO, absent
// here as in the Lua's `= nil`) or pins one daytime.
const FORCED_DAYTIME: Record<string, Daytime> = {
  PALETTE_DAY: "DAY",
  PALETTE_NITE: "NITE",
  PALETTE_MORN: "MORN",
  PALETTE_DARK: "DARK",
};

// Lua: Palettes.lua:62 -- white and black bracket the two colors a
// mon/trainer pic actually ships (data/pokemon/palettes.asm: "only the middle
// two colors are included").
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

function copy3(c: readonly number[]): Rgb3 {
  return [c[0]!, c[1]!, c[2]!];
}

export const Palettes = {
  // Lua: Palettes.lua:28 -- wTimeOfDay order (the GetTimePalette jumptable):
  // MORN_F, DAY_F, NITE_F, DARKNESS_F.  bg_tiles.pal, npc_sprites.pal and
  // every environment_colors row are laid out in this same order.
  DAYTIMES: ["MORN", "DAY", "NITE", "DARK"] as Daytime[],
  DAYTIME_ID: { MORN: 1, DAY: 2, NITE: 3, DARK: 4 } as Record<string, number>,

  // Lua: Palettes.lua:37 -- PAL_OW_* (constants/sprite_data_constants.asm),
  // 1-based as in the Lua.
  OW_PALETTE_ID: {
    PAL_OW_RED: 1, PAL_OW_BLUE: 2, PAL_OW_GREEN: 3, PAL_OW_BROWN: 4,
    PAL_OW_PINK: 5, PAL_OW_EMOTE: 6, PAL_OW_TREE: 7, PAL_OW_ROCK: 8,
  } as Record<string, number>,

  // Lua: Palettes.lua:42
  BLACKOUT: [
    [255, 255, 255], [58, 58, 58], [16, 25, 25], [0, 0, 0],
  ] as Colors4,

  // Lua: Palettes.lua:119 -- 1-based slot, PAL_BG_YELLOW is $04 (so the JS
  // array slot is PAL_BG_YELLOW - 1).
  //
  // There is no vision mask in Gen 2.  A dark map is dark because the `dark`
  // rows of bg_tiles.pal are colors 1-3 black on a color 0 of RGB 01,01,02.
  // The one light is FlickeringCaveEntrancePalette
  // (engine/tilesets/tileset_anims.asm): every VBlank while wTimeOfDayPalset
  // is DARKNESS_PALSET it rewrites PAL_BG_YELLOW color 0 from its own color 0
  // or its color 1, picked by bit 1 of hVBlankCounter -- the cave entrance
  // blinks yellow-black-yellow on a four-frame cycle.
  PAL_BG_YELLOW: 5,
  // Lua: Palettes.lua:121 -- `and %10`: two frames on, two frames off.
  FLICKER_PERIOD: 4,

  // Lua: Palettes.lua:73 -- the daytime the game clock is in, ignoring any
  // map override.  `hour` is hHours (World:hour, or the World.clockHour pin).
  // The no-argument fallback is the raw host clock, which is the cart's RTC
  // WITHOUT the save's wStartHour base.
  clockDaytime(hour?: number | null): Daytime {
    if (hour == null) {
      hour = tonumber(osDate("%H")) ?? 12;
    }
    hour = mod(Math.floor(hour), 24);
    if (hour < MORN_HOUR) return "NITE";
    if (hour < DAY_HOUR) return "MORN";
    if (hour < NITE_HOUR) return "DAY";
    return "NITE";
  },

  // Lua: Palettes.lua:87 -- the daytime whose colors load on this map: the
  // clock, unless the map header pins one.  PALETTE_DARK maps are pitch black
  // until FLASH is used, at which point they read as night
  // (ReplaceTimeOfDayPals.UsedFlash).
  daytimeFor(mapDef: any, hour?: number | null, flashUsed?: unknown): Daytime {
    const clock = Palettes.clockDaytime(hour);
    const forced = mapDef ? FORCED_DAYTIME[mapDef.palette] : undefined;
    if (forced === "DARK") {
      return flashUsed != null && flashUsed !== false ? "NITE" : "DARK";
    }
    return forced ?? clock;
  },

  // Lua: Palettes.lua:101 -- true when this map is lit by DARKNESS_PALSET
  // right now: the exact condition FlashFunction.CheckUseFlash tests, so
  // FLASH is allowed here and refused everywhere else -- including inside a
  // cave that is merely PALETTE_NITE, like Union Cave.
  isDarkness(mapDef: any, hour?: number | null, flashUsed?: unknown): boolean {
    return Palettes.daytimeFor(mapDef, hour, flashUsed) === "DARK";
  },

  // Lua: Palettes.lua:125 -- which of PAL_BG_YELLOW's own colors is copied
  // into its color 0 this frame.  1 is "leave color 0 alone", 2 is "use
  // color 1", both 1-based.
  caveFlickerSource(frame?: number | null): number {
    return mod(Math.floor((frame ?? 0) / 2), 2) === 1 ? 2 : 1;
  },

  // Lua: Palettes.lua:132 -- a copy of `set` with that copy already made.
  // `sourceIndex` is 1 or 2 (caveFlickerSource).  Only the yellow slot is
  // rebuilt, so the other seven palettes stay shared with the caller's set.
  withCaveFlicker<S extends PaletteSet | null | undefined>(set: S, sourceIndex?: number): S {
    if (!set) return set;
    const slot = set[Palettes.PAL_BG_YELLOW - 1];
    if (!slot) return set;
    const source = slot[sourceIndex === 2 ? 1 : 0];
    if (!source) return set;
    const out: PaletteSet = [];
    for (let i = 0; i < 8; i++) out[i] = set[i]!;
    const yellow: Colors4 = [];
    for (let i = 0; i < 4; i++) {
      const c = slot[i];
      if (c) yellow[i] = copy3(c);
    }
    yellow[0] = copy3(source);
    out[Palettes.PAL_BG_YELLOW - 1] = yellow;
    return out as S;
  },

  // Lua: Palettes.lua:151 -- LoadSpecialMapPalette
  // (engine/tilesets/tileset_palettes.asm:1)
  specialSet(data: PaletteData | null | undefined, mapDef: any): PaletteSet | undefined {
    const sets = data ? data.specialTilesets : undefined;
    const tileset = mapDef ? mapDef.tileset : undefined;
    const set = sets && tileset != null ? sets[tileset] : undefined;
    if (!set) return undefined;
    if (tileset === "TILESET_ICE_PATH" && mapDef.environment === "INDOOR") {
      return undefined;
    }
    const out: PaletteSet = [];
    for (let slot = 0; slot < 8; slot++) {
      const source = set[slot];
      const colors: Colors4 = [];
      for (let i = 0; i < 4; i++) {
        const c = (source && source[i]) || BLACK;
        colors[i] = copy3(c);
      }
      out[slot] = colors;
    }
    return out;
  },

  // Lua: Palettes.lua:174 -- the eight BG palettes loaded for this map, each
  // four [r,g,b], with the roof override already folded in.  Index with a
  // tileset's tilePalettes value minus one.  Returns PaletteSet | undefined;
  // declared `any` because World's callers guard it with truthy(), which
  // does not narrow.
  bgSet(data: PaletteData | null | undefined, mapDef: any, daytime?: string): any {
    if (!(data && data.bg && data.environments)) return undefined;
    const env: string | undefined = mapDef ? mapDef.environment : undefined;
    // LoadSpecialMapPalette wins over the pool -- engine/gfx/color.asm:1198
    let set = Palettes.specialSet(data, mapDef);
    if (!set) {
      let row = env != null ? data.environments[env] : undefined;
      row = row || data.environments.TOWN;
      if (!row) return undefined;
      const indices = (daytime != null ? row[daytime] : undefined) || row.DAY;
      if (!indices) return undefined;

      set = [];
      for (let slot = 0; slot < 8; slot++) {
        const idx = indices[slot];
        const pool = idx != null ? data.bg[idx - 1] : undefined;
        const colors: Colors4 = [];
        for (let i = 0; i < 4; i++) {
          const c = (pool && pool[i]) || BLACK;
          colors[i] = copy3(c);
        }
        set[slot] = colors;
      }
    }

    const roofSlot = data.roofSlot ?? 7;
    if (mapDef && env != null && ROOF_ENVIRONMENTS[env] && data.roofs) {
      const roof = data.roofs[mapDef.group];
      if (roof) {
        // Colors 1 and 2 only; the pool keeps the roof palette's 0 and 3.
        const pair = ((daytime === "MORN" || daytime === "DAY") && roof.mornDay) || roof.nite;
        if (pair && pair[0] && pair[1]) {
          set[roofSlot - 1]![1] = copy3(pair[0]);
          set[roofSlot - 1]![2] = copy3(pair[1]);
        }
      }
    }
    return set;
  },

  // Lua: Palettes.lua:215 -- the eight OBJ palettes for OW sprites at this
  // time of day.
  objectSet(data: PaletteData | null | undefined, daytime?: string): PaletteSet | undefined {
    if (!(data && data.objects)) return undefined;
    return (daytime != null ? data.objects[daytime] : undefined) || data.objects.DAY;
  },

  // Lua: Palettes.lua:232 -- the object_event palette byte's own OBJ palette
  // slot (0-based), or undefined for "use the sprite's default".
  // AddMapObject's tail (engine/overworld/player_object.asm:187-194): a
  // NON-ZERO field wins over whatever GetSpritePalette answered, and only its
  // low three bits reach OAM.  PAL_NPC_* is `const_def 1 << 3` over the same
  // eight names as PAL_OW_*, so bit 3 is only the "not the default" marker.
  objectPaletteId(objDef: any): number | undefined {
    const p = objDef ? objDef.palette : undefined;
    if (p == null || p === false || p === 0) return undefined;
    return mod(p, 8);
  },

  // Lua: Palettes.lua:245 -- a sprite definition's OBJ palette (sprites.json
  // stores both the PAL_OW_* name and the raw id), unless the object_event
  // standing on the map overrode it (objectPaletteId).  The override is what
  // makes BurnedTowerB1F's Raikou, Entei and Suicune -- all SPRITE_GROWLITHE,
  // PAL_OW_RED -- three different animals (maps/BurnedTowerB1F.asm:152-154).
  spritePalette(data: PaletteData | null | undefined, daytime: string | undefined, spriteDef: any, objDef?: any): Colors4 | undefined {
    const set = Palettes.objectSet(data, daytime);
    if (!set) return undefined;
    let id: number | undefined = Palettes.objectPaletteId(objDef);
    if (id == null) {
      id = spriteDef ? spriteDef.paletteId : undefined;
      if (id == null) {
        const name = spriteDef ? spriteDef.palette : undefined;
        let ow: number | undefined = name != null
          ? (Palettes.OW_PALETTE_ID[name] ?? Palettes.OW_PALETTE_ID["PAL_OW_" + tostring(name)])
          : undefined;
        ow = ow != null ? ow - 1 : 0;
        id = ow;
      }
    }
    return set[id ?? 0] || set[0];
  },

  // Lua: Palettes.lua:262 -- a battle pic's four colors: white, the two
  // shipped middle colors, black.
  monColors(data: PaletteData | null | undefined, speciesId: string | undefined, shiny?: unknown): Colors4 | undefined {
    const entry = data && data.pokemon && speciesId != null ? data.pokemon[speciesId] : undefined;
    if (!entry) return undefined;
    const pair = (shiny != null && shiny !== false && entry.shiny) || entry.normal;
    if (!(pair && pair[0] && pair[1])) return undefined;
    return [copy3(WHITE), copy3(pair[0]), copy3(pair[1]), copy3(BLACK)];
  },

  // Lua: Palettes.lua:276 -- trainer pics work the same way; row 0 is PLAYER
  // (Chris shares Cal's colors).
  trainerColors(data: PaletteData | null | undefined, className?: string): Colors4 | undefined {
    const pair = data && data.trainers ? data.trainers[className ?? "PLAYER"] : undefined;
    if (!(pair && pair[0] && pair[1])) return undefined;
    return [copy3(WHITE), copy3(pair[0]), copy3(pair[1]), copy3(BLACK)];
  },

  // Lua: Palettes.lua:289 -- PAL_BG_TEXT is white/white/white/black in every
  // set, which is what makes text boxes readable at night; menus and the
  // naming screen draw with it.
  textColors(data: PaletteData | null | undefined): Colors4 | undefined {
    if (!(data && data.bg)) return undefined;
    const pool = data.bg[7]; // $07 (Lua data.bg[8]), the morn "text" row
    if (!pool) return undefined;
    return [copy3(pool[0]!), copy3(pool[1]!), copy3(pool[2]!), copy3(pool[3]!)];
  },
};

export default Palettes;
