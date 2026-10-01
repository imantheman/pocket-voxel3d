// gen1recomp src/world/gen2/MapNameSign.lua at bdfac727 (MIT).
//
// ../pokecrystal/engine/events/map_name_sign.asm:3, :99, :197 -- the Crystal
// map name sign: which landmark gets one, its timer (World calls
// MapNameSign.tick every frame, Game2 calls MapNameSign.frame on its fixed
// step), and the box it draws.  The box is Gold-screen 2D UI, so its draw
// stays in the screen API's terms (Assets, Font, GbcPalette, and `G`, the
// love.graphics stand-in).  Under Gold/Silver `GameVersion.engine()` is not
// "crystal", so init and draw return at once, exactly as in the Lua.

import { Assets } from "../shared/render/Assets.ts";
import { Font } from "../shared/render/Font.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Palettes, type Colors4 } from "./Palettes.ts";
import { Save } from "../core/Save.ts";
import G, { type LcdImage, type Quad } from "../platform/screen.ts";

/** world.mapSign while a sign is up. */
export interface MapSign {
  timer: number;
  frames: number;
  shown: boolean;
  name: string;
}

// Lua: MapNameSign.lua:23-25 -- map_name_sign.asm:134-140, :114
const COLS = 20;
const ROWS = 4;
const TOP = 112;

// Lua: MapNameSign.lua:28 -- map_name_sign.asm:69-87
const NO_SIGN: Record<string, boolean> = {
  LANDMARK_SPECIAL: true,
  LANDMARK_RADIO_TOWER: true,
  LANDMARK_LAV_RADIO_TOWER: true,
  LANDMARK_UNDERGROUND_PATH: true,
  LANDMARK_INDIGO_PLATEAU: true,
  LANDMARK_POWER_PLANT: true,
};

// Lua: MapNameSign.lua:38 -- map_name_sign.asm:89-97
const PARK_GATES: Record<string, boolean> = {
  ROUTE_35_NATIONAL_PARK_GATE: true,
  ROUTE_36_NATIONAL_PARK_GATE: true,
};

// Lua: MapNameSign.lua:45 -- data/maps/setup_scripts.asm:177,
// engine/menus/intro_menu.asm:467-468
const SUPPRESSED_VIA: Record<string, boolean> = { boot: true, continue: true };

// undefined: not tried yet; false: tried and missing (the Lua's nil/false)
let sheet: LcdImage | false | undefined;
let quads: Record<number, Quad> | undefined;

// Lua: MapNameSign.lua:49
Assets.register(() => {
  sheet = undefined;
  quads = undefined;
});

// Lua: MapNameSign.lua:51
function loadSheet(world: any): LcdImage | undefined {
  if (sheet !== undefined) return sheet || undefined;
  const data = world && world.game ? world.game.data : undefined;
  const path: string = (data && data.font && data.font.imageMapSign) || MapNameSign.SHEET;
  if (!Assets.exists(Assets.resolve(path))) {
    sheet = false;
    return undefined;
  }
  let img: LcdImage | undefined;
  try {
    img = Assets.image(path);
  } catch {
    img = undefined;
  }
  if (!img) {
    sheet = false;
    return undefined;
  }
  const [iw, ih] = img.getDimensions();
  quads = {};
  for (let i = 0; i <= MapNameSign.TILES - 1; i++) {
    quads[i] = G.newQuad(i * 8, 0, 8, 8, iw, ih);
  }
  sheet = img;
  return sheet;
}

// Lua: MapNameSign.lua:122 -- map_name_sign.asm:99-125
function place(world: any, s: MapSign): void {
  if (s.timer <= 0) {
    delete world.mapSign;
    return;
  }
  s.timer = s.timer - 1;
  if (s.timer <= MapNameSign.DURATION - 2) s.shown = true;
}

export const MapNameSign = {
  // Lua: MapNameSign.lua:14 -- map_name_sign.asm:1
  TILES: 14,
  // Lua: MapNameSign.lua:16 -- map_name_sign.asm:42-44
  DURATION: 60,
  // Lua: MapNameSign.lua:18 -- engine/overworld/events.asm:177-191
  FRAMES_PER_TICK: 2,
  SHEET: "assets/generated/fonts/map_entry_sign.png",

  // Lua: MapNameSign.lua:74 -- the persisted "previous landmark" record.
  state(world: any): Record<string, any> {
    const save = world && world.game ? world.game.save : undefined;
    if (save) {
      const crystal = Save.crystalState(save);
      crystal.mapSign = crystal.mapSign || {};
      return crystal.mapSign;
    }
    world.mapSignState = world.mapSignState || {};
    return world.mapSignState;
  },

  // Lua: MapNameSign.lua:86 -- map_name_sign.asm:11-56
  init(world: any, via?: string): void {
    if (GameVersion.engine() !== "crystal") return;
    delete world.mapSign;
    const st = MapNameSign.state(world);
    const def = world.map ? world.map.def : undefined;
    let id: any = (def && world.currentLandmarkId()) || false;
    if (!def || def.environment === "GATE" || PARK_GATES[world.map ? world.map.id : undefined]) {
      id = false;
    }
    if (via != null && SUPPRESSED_VIA[via]) {
      st.prev = id;
      return;
    }
    let prev = st.prev;
    if (prev == null) prev = false;
    st.prev = id;
    // map_name_sign.asm:60-67
    if (id === prev || prev === "LANDMARK_SPECIAL") return;
    if (id === false || NO_SIGN[id]) return;
    const sign: MapSign = {
      timer: MapNameSign.DURATION,
      frames: 0,
      shown: false,
      // map_name_sign.asm:143-145, constants/charmap.asm:9
      name: String(world.landmarkName() || "").replace(/\n/g, " "),
    };
    world.mapSign = sign;
  },

  // Lua: MapNameSign.lua:117 -- engine/overworld/events.asm:284-285
  cancel(world: any): void {
    if (world) delete world.mapSign;
  },

  // Lua: MapNameSign.lua:132 -- engine/overworld/events.asm:177-191
  frame(world: any): void {
    const s: MapSign | undefined = world ? world.mapSign : undefined;
    if (!s || world.mapSetup || world.textbox) return;
    s.frames = (s.frames ?? 0) + 1;
    if (s.frames < MapNameSign.FRAMES_PER_TICK) return;
    s.frames = 0;
    place(world, s);
  },

  // Lua: MapNameSign.lua:142 -- home/window.asm:42
  tick(world: any): void {
    if (world.mapSign && world.textbox) MapNameSign.cancel(world);
  },

  // Lua: MapNameSign.lua:148 -- map_name_sign.asm:197-233, :235.  Rows and
  // columns are 0-based, as the Lua's [0]-keyed tables.
  tiles(): number[][] {
    const rows: number[][] = [];
    for (let row = 0; row <= ROWS - 1; row++) rows[row] = [];
    rows[0]![0] = 1; rows[0]![COLS - 1] = 4;
    rows[1]![0] = 5; rows[1]![COLS - 1] = 11;
    rows[2]![0] = 6; rows[2]![COLS - 1] = 12;
    rows[3]![0] = 7; rows[3]![COLS - 1] = 10;
    for (let i = 0; i <= COLS - 3; i++) {
      const edge = i % 4 < 2 ? 1 : 0;
      rows[0]![i + 1] = 2 + edge;
      rows[1]![i + 1] = 13;
      rows[2]![i + 1] = 13;
      rows[3]![i + 1] = 8 + edge;
    }
    return rows;
  },

  // Lua: MapNameSign.lua:168 -- map_name_sign.asm:142-156
  textX(name: string): number {
    if (Font.ttfActive()) {
      return Math.floor((COLS * 8 - Font.width(name)) / 2);
    }
    return Math.floor((COLS - Font.encode(name).length) / 2) * 8;
  },

  // Lua: MapNameSign.lua:176 -- gfx/tilesets/bg_tiles.pal:9
  colors(world: any): Colors4 | undefined {
    return Palettes.textColors(world ? world.palettes : undefined);
  },

  // Lua: MapNameSign.lua:180 -- Gold-screen UI, kept in the screen API's
  // terms.  w/h are the panel size the Lua centres in; the Gold screen IS the
  // 160x144 panel, and world:fitScale() is 1 here (Zoom is inert).
  draw(world: any, w = 160, h = 144, posLift?: number): void {
    const s: MapSign | undefined = world.mapSign;
    if (!s || !s.shown || GameVersion.engine() !== "crystal") return;
    if (world.textbox) return;
    const img = loadSheet(world);
    if (!img) return;
    const scale = 1; // Lua: world:fitScale()
    G.push();
    G.translate(Math.floor((w - 160 * scale) / 2),
      Math.floor((h - 144 * scale) / 2) - (posLift ?? 0));
    G.scale(scale, scale);
    G.setColor(1, 1, 1, 1);
    const blit = (): void => {
      for (let row = 0; row <= ROWS - 1; row++) {
        for (let col = 0; col <= COLS - 1; col++) {
          const quad = quads ? quads[LAYOUT[row]![col]!] : undefined;
          if (quad) G.draw(img, quad, col * 8, TOP + row * 8);
        }
      }
      Font.draw(s.name, MapNameSign.textX(s.name), TOP + 2 * 8);
    };
    // map_name_sign.asm:181
    const colors = MapNameSign.colors(world);
    if (colors && GbcPalette.available()) {
      GbcPalette.with(colors, blit);
    } else {
      blit();
    }
    G.pop();
    G.setColor(1, 1, 1, 1);
  },
};

// Lua: MapNameSign.lua:165
const LAYOUT = MapNameSign.tiles();

export default MapNameSign;
