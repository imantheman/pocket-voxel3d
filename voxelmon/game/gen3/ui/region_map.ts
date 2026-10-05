// Port of gen1recomp src/ui/game3/region_map.lua (GPLv3 + additional terms; see LICENSE.md).
// The FRLG Town Map and Fly map (pokefirered src/region_map.c): the open /
// close animations, the switch-map menu, the dungeon preview, cursor and icon
// sprites, and the task / CB2 state machine, drawn through region_map_gpu's
// window and blend compositor.
//
// The importer's LAYOUTS / GEOMETRY tables keep the importer's shape:
// LAYOUTS[region][layer][y][x] (all keyed from 0, objects), so Brian's
// indexing reads them unchanged.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Stack } from "./stack.ts";
import { FrlgFont } from "./frlg_font.ts";
import { PokedexChrome } from "./pokedex_chrome.ts";
import { BagMenu } from "./bag_menu.ts";
import { PartyMenu } from "./party_menu.ts";
import { MapPreviewScreen } from "./map_preview_screen.ts";
import { RegionMapExtract as RegionExtract } from "../../../import/gen3/region_map_extract.ts";
import { MapSectionsExtract } from "../../../import/gen3/map_sections_extract.ts";
import { RomText } from "../core/rom_text.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Gpu, type GpuRegs, type Layer } from "./region_map_gpu.ts";
import { Position } from "./region_map_position.ts";
import { SE } from "../core/se_ids.ts";
import { Audio } from "../core/audio.ts";
import { Flags } from "../core/scripting/flags.ts";
import { Space } from "../core/scripting/space.ts";
import { Runtime } from "../core/runtime.ts";
import { Renderer } from "../shared/render/Renderer.ts";
import { NotPortedError } from "../notported.ts";
import { G } from "../platform/graphics.ts";
import { ipairs, len, pairs, seq, unpack, type LuaTable } from "../platform/lt.ts";
import { tonumber, tostring } from "../../../import/gen3/lua.ts";

// ------------------------------------------------------------ state types

interface FadeState {
  active: boolean; y: number; bgY: number; objY: number; shownBg: number; shownObj: number;
  toggle: number; pending: boolean;
  deltaY?: number; delay?: number; delayCounter?: number; target?: number; yDec?: boolean;
  finishing?: boolean; finishCounter?: number;
}

interface CursorState {
  exists: boolean; visible: boolean; spriteX: number; spriteY: number; horizontalMove: number; verticalMove: number;
  moveCounter: number; snapId: number; handler: string; animStart: number;
}

interface Icon { region: number; x: number; y: number; mapsec: number; visible: boolean; px?: number; py?: number; frame?: number }

interface Edge { name: string; x: number; y: number; visible: boolean }

interface AnimState { openState: number; loadGfxState: number; moveState: number; closeState: number; blendY: number; exitTask: string }

interface SwitchState {
  alpha: number; blendY: number; mainState: number; cursorLoadState: number; exitTask: string;
  maxSelection: number; image: string; yOffset: number; currentSelection: number; chosenRegion: number;
  highlight: LuaTable; cursors?: boolean; cursorAnimStart?: number;
}

interface PreviewState {
  artSec: number; mainState: number; drawState: number; loadState: number; updateCounter: number; timer: number;
  blendY: number; exitTask: string; dungeon: number;
  left?: number; top?: number; right?: number; bottom?: number;
  leftIncrement?: number; topIncrement?: number; rightIncrement?: number; bottomIncrement?: number;
  red?: number; green?: number; blue?: number;
  text?: { name: string; desc: string };
}

export interface RMState {
  type: string;
  perms: Record<string, boolean>;
  selectedRegion: number;
  playersRegion: number;
  mainTask: string;
  cb2: string;
  openState: number;
  loadGfxState: number;
  mainState: number;
  frame: number;
  gpu: GpuRegs;
  fade: FadeState;
  vblank: boolean;
  bgShown: boolean[];
  objOn: boolean;
  backdropBlue: boolean;
  palTinted: boolean;
  cursor: CursorState;
  player: { exists: boolean; visible: boolean };
  icons: { fly: LuaTable; dungeon: LuaTable; flyAnimStart?: number; state?: number; exitTask?: string; [k: string]: any };
  text: { map?: string; dungeon?: string; dungeonType?: number };
  topBar: { shown: boolean; left?: string; right?: string };
  repeatCounter: number;
  fromField?: boolean;
  input?: any;
  startRepeat?: boolean;
  task?: string;
  finish?: { picked: boolean; mapsec?: number };
  edges?: LuaTable;
  anim?: AnimState;
  switch?: SwitchState;
  preview?: PreviewState;
  bg0?: { region: number; switchButton: boolean; navelPatch: boolean; birthPatch: boolean };
  bg1?: string;
  bg2?: { image?: string; preview?: number; tone?: LuaTable };
  savedRegs?: Record<string, any>;
  selectedDestination?: boolean;
}

export interface ShowOpts {
  session?: any;
  onClose?: (picked: unknown) => void;
  onPick?: (sym: string | undefined, mapsec: number) => void;
  mode?: string;
}

export interface RegionMapModule {
  isMenu: boolean;
  open: boolean;
  cursorX: number;
  cursorY: number;
  playerX: number;
  playerY: number;
  previewDungeon: string | undefined;
  _images: Record<string, any>;
  _session: any;
  _onClose: ((picked: unknown) => void) | undefined;
  _onPick: ((sym: string | undefined, mapsec: number) => void) | undefined;
  mode: string;
  MAPSECTYPE: { NONE: number; ROUTE: number; VISITED: number; NOT_VISITED: number; UNKNOWN: number };
  _updateFade(): void;
  isFlagSet(flagName: string | number): boolean;
  permission(name: string): boolean;
  hasFlyDestinations(): boolean;
  hasSwitchButton(): boolean;
  hasMapPreview(): boolean;
  isFlyMode(): boolean;
  mapsecType(mapsec: unknown): number;
  dungeonMapsecType(mapsec: unknown): number;
  currentMapSec(): string | undefined;
  selectedMapsecType(): number;
  selectedDungeonMapsecType(): number;
  dungeonSecAt(x: number, y: number): string | undefined;
  currentDungeonSec(): string | undefined;
  canFlyToCursor(): boolean;
  canGuideCursor(): boolean;
  currentLocationName(): string | undefined;
  currentDungeonName(): string | undefined;
  dungeonIconFrame(dSec: unknown): number;
  dungeonIconOffset(x: number, y: number, region?: number): number;
  dungeonIconVisitedImage(): any;
  flyIconFrame(): number;
  flyTargets(): LuaTable;
  dungeonIcons(): LuaTable;
  flyBlockedByMapType(): boolean;
  topBarText(): [string | undefined, string | undefined];
  show(opts?: ShowOpts): void;
  close(picked?: boolean): void;
  isOpen(): boolean;
  inputReady(): boolean;
  state(): RMState | undefined;
  handleInput(input: any): void;
  draw(): void;
}

// The src.render.Renderer probe: the module is always present here (inert on
// the 3DS). Read at call time: no top-level reads of imports (module cycle).
function renderer(): Record<string, any> {
  return Renderer as unknown as Record<string, any>;
}

export const RegionMap = { isMenu: true } as RegionMapModule;

RegionMap.open = false;
RegionMap.cursorX = 0;
RegionMap.cursorY = 0;
RegionMap.playerX = 0;
RegionMap.playerY = 0;
RegionMap.previewDungeon = undefined;
// RegionMap._images = Gpu.images: a getter, so region_map_gpu is not read at load
Object.defineProperty(RegionMap, "_images", { get: () => Gpu.images, enumerable: true, configurable: true });
RegionMap._session = undefined;
RegionMap._onClose = undefined;
RegionMap._onPick = undefined;
RegionMap.mode = "normal";

// src/region_map.c:20-27
const MAP_WIDTH = 22, MAP_HEIGHT = 15;
const CANCEL_BUTTON_X = 21, CANCEL_BUTTON_Y = 13;
const SWITCH_BUTTON_X = 21, SWITCH_BUTTON_Y = 11;

// src/region_map.c:29-35
const REGION_IMAGES: Record<number, string> = { 0: "kanto_map", 1: "sevii123_map", 2: "sevii45_map", 3: "sevii67_map" };

// src/region_map.c:37-43
RegionMap.MAPSECTYPE = {
  NONE: 0,
  ROUTE: 1,
  VISITED: 2,
  NOT_VISITED: 3,
  UNKNOWN: 4,
};
const SECTYPE = RegionMap.MAPSECTYPE;

// src/region_map.c:61-69
const INPUT = { NONE: 0, MOVE_START: 1, MOVE_CONT: 2, MOVE_END: 3, A_BUTTON: 4, SWITCH: 5, CANCEL: 6 };

// src/region_map.c:595-617
const PERMISSIONS: Record<string, Record<string, boolean>> = {
  normal: { switchButton: true, mapPreview: true, openAnim: true, flyDestinations: false },
  wall: { switchButton: false, mapPreview: false, openAnim: false, flyDestinations: false },
  fly: { switchButton: false, mapPreview: false, openAnim: false, flyDestinations: true },
};

// src/region_map.c:619-623
const NAME_BOX: Record<string, LuaTable> = {
  map: seq(24, 16, 144, 32),
  dungeon: seq(24, 32, 144, 48),
  clear: seq(0, 0, 0, 0),
};

// src/region_map.c:734
const MAP_WINDOW = seq(24, 16, 216, 160);

// src/region_map.c:2952
const MAP_LAYER_FLAGS: Record<string, string> = {
  MAPSEC_PALLET_TOWN: "FLAG_WORLD_MAP_PALLET_TOWN",
  MAPSEC_VIRIDIAN_CITY: "FLAG_WORLD_MAP_VIRIDIAN_CITY",
  MAPSEC_PEWTER_CITY: "FLAG_WORLD_MAP_PEWTER_CITY",
  MAPSEC_CERULEAN_CITY: "FLAG_WORLD_MAP_CERULEAN_CITY",
  MAPSEC_LAVENDER_TOWN: "FLAG_WORLD_MAP_LAVENDER_TOWN",
  MAPSEC_VERMILION_CITY: "FLAG_WORLD_MAP_VERMILION_CITY",
  MAPSEC_CELADON_CITY: "FLAG_WORLD_MAP_CELADON_CITY",
  MAPSEC_FUCHSIA_CITY: "FLAG_WORLD_MAP_FUCHSIA_CITY",
  MAPSEC_CINNABAR_ISLAND: "FLAG_WORLD_MAP_CINNABAR_ISLAND",
  MAPSEC_INDIGO_PLATEAU: "FLAG_WORLD_MAP_INDIGO_PLATEAU_EXTERIOR",
  MAPSEC_SAFFRON_CITY: "FLAG_WORLD_MAP_SAFFRON_CITY",
  MAPSEC_ONE_ISLAND: "FLAG_WORLD_MAP_ONE_ISLAND",
  MAPSEC_TWO_ISLAND: "FLAG_WORLD_MAP_TWO_ISLAND",
  MAPSEC_THREE_ISLAND: "FLAG_WORLD_MAP_THREE_ISLAND",
  MAPSEC_FOUR_ISLAND: "FLAG_WORLD_MAP_FOUR_ISLAND",
  MAPSEC_FIVE_ISLAND: "FLAG_WORLD_MAP_FIVE_ISLAND",
  MAPSEC_SEVEN_ISLAND: "FLAG_WORLD_MAP_SEVEN_ISLAND",
  MAPSEC_SIX_ISLAND: "FLAG_WORLD_MAP_SIX_ISLAND",
  MAPSEC_ROUTE_4_POKECENTER: "FLAG_WORLD_MAP_ROUTE4_POKEMON_CENTER_1F",
  MAPSEC_ROUTE_10_POKECENTER: "FLAG_WORLD_MAP_ROUTE10_POKEMON_CENTER_1F",
};

// src/region_map.c:3005
const DUNGEON_LAYER_FLAGS: Record<string, string> = {
  MAPSEC_VIRIDIAN_FOREST: "FLAG_WORLD_MAP_VIRIDIAN_FOREST",
  MAPSEC_MT_MOON: "FLAG_WORLD_MAP_MT_MOON_1F",
  MAPSEC_S_S_ANNE: "FLAG_WORLD_MAP_SSANNE_EXTERIOR",
  MAPSEC_UNDERGROUND_PATH: "FLAG_WORLD_MAP_UNDERGROUND_PATH_NORTH_SOUTH_TUNNEL",
  MAPSEC_UNDERGROUND_PATH_2: "FLAG_WORLD_MAP_UNDERGROUND_PATH_EAST_WEST_TUNNEL",
  MAPSEC_DIGLETTS_CAVE: "FLAG_WORLD_MAP_DIGLETTS_CAVE_B1F",
  MAPSEC_KANTO_VICTORY_ROAD: "FLAG_WORLD_MAP_VICTORY_ROAD_1F",
  MAPSEC_ROCKET_HIDEOUT: "FLAG_WORLD_MAP_ROCKET_HIDEOUT_B1F",
  MAPSEC_SILPH_CO: "FLAG_WORLD_MAP_SILPH_CO_1F",
  MAPSEC_POKEMON_MANSION: "FLAG_WORLD_MAP_POKEMON_MANSION_1F",
  MAPSEC_KANTO_SAFARI_ZONE: "FLAG_WORLD_MAP_SAFARI_ZONE_CENTER",
  MAPSEC_POKEMON_LEAGUE: "FLAG_WORLD_MAP_POKEMON_LEAGUE_LORELEIS_ROOM",
  MAPSEC_ROCK_TUNNEL: "FLAG_WORLD_MAP_ROCK_TUNNEL_1F",
  MAPSEC_SEAFOAM_ISLANDS: "FLAG_WORLD_MAP_SEAFOAM_ISLANDS_1F",
  MAPSEC_POKEMON_TOWER: "FLAG_WORLD_MAP_POKEMON_TOWER_1F",
  MAPSEC_CERULEAN_CAVE: "FLAG_WORLD_MAP_CERULEAN_CAVE_1F",
  MAPSEC_POWER_PLANT: "FLAG_WORLD_MAP_POWER_PLANT",
  MAPSEC_NAVEL_ROCK: "FLAG_WORLD_MAP_NAVEL_ROCK_EXTERIOR",
  MAPSEC_MT_EMBER: "FLAG_WORLD_MAP_MT_EMBER_EXTERIOR",
  MAPSEC_BERRY_FOREST: "FLAG_WORLD_MAP_THREE_ISLAND_BERRY_FOREST",
  MAPSEC_ICEFALL_CAVE: "FLAG_WORLD_MAP_FOUR_ISLAND_ICEFALL_CAVE_ENTRANCE",
  MAPSEC_ROCKET_WAREHOUSE: "FLAG_WORLD_MAP_FIVE_ISLAND_ROCKET_WAREHOUSE",
  MAPSEC_TRAINER_TOWER_2: "FLAG_WORLD_MAP_TRAINER_TOWER_LOBBY",
  MAPSEC_DOTTED_HOLE: "FLAG_WORLD_MAP_SIX_ISLAND_DOTTED_HOLE_1F",
  MAPSEC_LOST_CAVE: "FLAG_WORLD_MAP_FIVE_ISLAND_LOST_CAVE_ENTRANCE",
  MAPSEC_PATTERN_BUSH: "FLAG_WORLD_MAP_SIX_ISLAND_PATTERN_BUSH",
  MAPSEC_ALTERING_CAVE: "FLAG_WORLD_MAP_SIX_ISLAND_ALTERING_CAVE",
  MAPSEC_TANOBY_CHAMBERS: "FLAG_WORLD_MAP_SEVEN_ISLAND_TANOBY_RUINS_MONEAN_CHAMBER",
  MAPSEC_THREE_ISLE_PATH: "FLAG_WORLD_MAP_THREE_ISLAND_DUNSPARCE_TUNNEL",
  MAPSEC_TANOBY_KEY: "FLAG_WORLD_MAP_SEVEN_ISLAND_SEVAULT_CANYON_TANOBY_KEY",
  MAPSEC_BIRTH_ISLAND: "FLAG_WORLD_MAP_BIRTH_ISLAND_EXTERIOR",
};

// include/constants/songs.h:5,46,105,106,204,230,245,249,250,251 (SE = core/se_ids.ts)

// src/main.c:286-287
const KEY_REPEAT_START = 40, KEY_REPEAT_CONTINUE = 5;

// include/constants/map_types.h:8,12
const MAP_TYPE_UNDERGROUND = 4, MAP_TYPE_INDOOR = 8;

// Brian's `S` is nil while the map is closed; it is typed as the open state
// and tested with `!S` where he tests `not S`.
const CLOSED = null as unknown as RMState;
let S: RMState = CLOSED;

/** `unpack` of a window rectangle into setWindowDims' four arguments. */
function rect4(t: LuaTable): [number, number, number, number] {
  return unpack(t) as [number, number, number, number];
}

// Lua: region_map.lua:133
function se(id: number): void {
  Audio.playSe(id);
}

// Lua: region_map.lua:137
function sec(id: string): number {
  const v = MapSectionsExtract.ID_TO_SECTION[id];
  if (v == null) throw new Error(id);
  return v;
}

// Lua: region_map.lua:141
function symOf(mapsec: number | undefined): string | undefined {
  const info = mapsec == null ? undefined : MapSectionsExtract.SECTIONS[mapsec];
  return info ? info.id : undefined;
}

// Lua: region_map.lua:146
function numOf(mapsec: unknown): number {
  if (mapsec == null) return RegionExtract.MAPSEC_NONE;
  if (typeof mapsec === "number") return mapsec;
  return sec(mapsec as string);
}

// Lua: region_map.lua:152
function mapDef(mapId: string): any {
  const game = Runtime._game;
  const maps = game && game.data && game.data.maps;
  const def = maps ? maps[mapId] : undefined;
  if (def == null) throw new Error("no map header for " + tostring(mapId));
  return def;
}

// pokefirered/src/palette.c:151 BeginNormalPaletteFade
// Lua: region_map.lua:160
function beginFade(startY: number, targetY: number): boolean {
  const f = S.fade;
  if (f.active) return false;
  [f.deltaY, f.delay, f.delayCounter] = [2, 0, 0];
  [f.y, f.target] = [startY, targetY];
  f.yDec = startY >= targetY;
  f.active = true;
  [f.finishing, f.finishCounter] = [false, 0];
  RegionMap._updateFade();
  f.pending = false;
  [f.shownBg, f.shownObj] = [f.bgY, f.objY];
  return true;
}

// Lua: region_map.lua:174
function stepFade(f: FadeState): void {
  if (!f.active) return;
  if (f.finishing) {
    if (f.finishCounter === 4) {
      [f.active, f.finishing, f.finishCounter] = [false, false, 0];
    } else {
      f.finishCounter = f.finishCounter! + 1;
    }
    return;
  }
  if (f.toggle === 0) {
    if (f.delayCounter! < f.delay!) {
      f.delayCounter = f.delayCounter! + 1;
      return;
    }
    f.delayCounter = 0;
    f.bgY = f.y;
  } else {
    f.objY = f.y;
  }
  f.toggle = 1 - f.toggle;
  if (f.toggle === 0) {
    if (f.y === f.target) {
      f.finishing = true;
    } else if (f.yDec) {
      f.y = Math.max(f.y - f.deltaY!, f.target!);
    } else {
      f.y = Math.min(f.y + f.deltaY!, f.target!);
    }
  }
}

// pokefirered/src/palette.c:113 UpdatePaletteFade, :393 UpdateNormalPaletteFade
// Lua: region_map.lua:207
RegionMap._updateFade = function (): void {
  const f = S.fade;
  if (f.pending) return;
  stepFade(f);
  f.pending = f.active && !f.finishing;
};

// pokefirered/src/palette.c:100 TransferPlttBuffer
// Lua: region_map.lua:215
function vblank(): void {
  if (!S.vblank) return;
  const f = S.fade;
  [f.shownBg, f.shownObj] = [f.bgY, f.objY];
  f.pending = false;
}

// pokefirered/src/palette.c:779 BlendPalettes
// Lua: region_map.lua:223
function blendPalettes(y: number): void {
  [S.fade.bgY, S.fade.objY] = [y, y];
}

// Lua: region_map.lua:227
RegionMap.isFlagSet = function (flagName: string | number): boolean {
  const id = tonumber(flagName) ?? Flags.IDS[flagName as string];
  if (id == null) return false;
  // package.loaded["src.core.game3.scripting.space"]: always loaded here
  const store = Space ? Space.store : undefined;
  if (store && Flags.getFlag(store, null, id) === true) return true;
  let session = RegionMap._session;
  if (!session) {
    // package.loaded["src.core.game3.runtime"]
    session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
  }
  if (session && session.flags) {
    if (session.flags[id] || session.flags[flagName]) return true;
  }
  return false;
};

// src/region_map.c:1024-1029
// Lua: region_map.lua:246
function perm(name: string): boolean {
  if (S) return S.perms[name] === true;
  const p = PERMISSIONS[RegionMap.mode]!;
  if (name === "switchButton" && !RegionMap.isFlagSet("FLAG_SYS_SEVII_MAP_123")) return false;
  return p[name] === true;
}

// Lua: region_map.lua:253
RegionMap.permission = function (name: string): boolean {
  return perm(name);
};

// Lua: region_map.lua:257
RegionMap.hasFlyDestinations = function (): boolean {
  return perm("flyDestinations");
};

// Lua: region_map.lua:261
RegionMap.hasSwitchButton = function (): boolean {
  return perm("switchButton");
};

// Lua: region_map.lua:265
RegionMap.hasMapPreview = function (): boolean {
  return perm("mapPreview");
};

// Lua: region_map.lua:269
RegionMap.isFlyMode = function (): boolean {
  return RegionMap.mode === "fly";
};

// Lua: region_map.lua:273
function selectedRegion(): number {
  return S ? S.selectedRegion : 0;
}

// src/region_map.c:3354 GetSelectedMapSection
// Lua: region_map.lua:278
function mapsecAt(region: number, layer: string, y: number, x: number): number {
  RegionExtract.ensureGenerated();
  const grid = RegionExtract.LAYOUTS[region];
  if (!grid || y < 0 || y >= MAP_HEIGHT || x < 0 || x >= MAP_WIDTH) return RegionExtract.MAPSEC_NONE;
  return grid[layer][y][x];
}

// src/region_map.c:2952 GetMapsecType
// Lua: region_map.lua:286
function mapsecType(mapsec: number): number {
  if (mapsec === RegionExtract.MAPSEC_NONE) return SECTYPE.NONE;
  const id = symOf(mapsec);
  if (id === "MAPSEC_ROUTE_4_POKECENTER" && !perm("flyDestinations")) return SECTYPE.NONE;
  const flag = id == null ? undefined : MAP_LAYER_FLAGS[id];
  if (flag) return RegionMap.isFlagSet(flag) ? SECTYPE.VISITED : SECTYPE.NOT_VISITED;
  return SECTYPE.ROUTE;
}

// src/region_map.c:3005 GetDungeonMapsecType
// Lua: region_map.lua:296
function dungeonMapsecType(mapsec: number): number {
  if (mapsec === RegionExtract.MAPSEC_NONE) return SECTYPE.NONE;
  const id = symOf(mapsec);
  const flag = id == null ? undefined : DUNGEON_LAYER_FLAGS[id];
  if (flag) return RegionMap.isFlagSet(flag) ? SECTYPE.VISITED : SECTYPE.NOT_VISITED;
  return SECTYPE.ROUTE;
}

// Lua: region_map.lua:303
RegionMap.mapsecType = function (mapsec: unknown): number {
  return mapsecType(numOf(mapsec));
};

// Lua: region_map.lua:307
RegionMap.dungeonMapsecType = function (mapsec: unknown): number {
  return dungeonMapsecType(numOf(mapsec));
};

// src/region_map.c:2922 GetMapsecUnderCursor
// Lua: region_map.lua:312
function mapsecUnderCursor(): number {
  const mapsec = mapsecAt(selectedRegion(), "map", RegionMap.cursorY, RegionMap.cursorX);
  if ((mapsec === sec("MAPSEC_NAVEL_ROCK") || mapsec === sec("MAPSEC_BIRTH_ISLAND"))
    && !RegionMap.isFlagSet("FLAG_WORLD_MAP_NAVEL_ROCK_EXTERIOR")) {
    return RegionExtract.MAPSEC_NONE;
  }
  return mapsec;
}

// src/region_map.c:2937 GetDungeonMapsecUnderCursor
// Lua: region_map.lua:322
function dungeonUnderCursor(): number {
  const mapsec = mapsecAt(selectedRegion(), "dungeon", RegionMap.cursorY, RegionMap.cursorX);
  if (mapsec === sec("MAPSEC_CERULEAN_CAVE") && !RegionMap.isFlagSet("FLAG_SYS_CAN_LINK_WITH_RS")) {
    return RegionExtract.MAPSEC_NONE;
  }
  return mapsec;
}

// src/region_map.c:3078 GetSelectedMapsecType
// Lua: region_map.lua:331
function selectedType(layer: string): number {
  const mapsec = mapsecAt(selectedRegion(), layer, RegionMap.cursorY, RegionMap.cursorX);
  if (layer === "map") return mapsecType(mapsec);
  return dungeonMapsecType(mapsec);
}

// Lua: region_map.lua:337
RegionMap.currentMapSec = function (): string | undefined {
  return symOf(mapsecAt(selectedRegion(), "map", RegionMap.cursorY, RegionMap.cursorX));
};

// Lua: region_map.lua:341
RegionMap.selectedMapsecType = function (): number {
  return selectedType("map");
};

// Lua: region_map.lua:345
RegionMap.selectedDungeonMapsecType = function (): number {
  return selectedType("dungeon");
};

// Lua: region_map.lua:349
RegionMap.dungeonSecAt = function (x: number, y: number): string | undefined {
  const [saveX, saveY] = [RegionMap.cursorX, RegionMap.cursorY];
  [RegionMap.cursorX, RegionMap.cursorY] = [x, y];
  const mapsec = dungeonUnderCursor();
  [RegionMap.cursorX, RegionMap.cursorY] = [saveX, saveY];
  return symOf(mapsec);
};

// Lua: region_map.lua:357
RegionMap.currentDungeonSec = function (): string | undefined {
  return symOf(dungeonUnderCursor());
};

// src/region_map.c:3956
// Lua: region_map.lua:362
RegionMap.canFlyToCursor = function (): boolean {
  if (!perm("flyDestinations")) return false;
  const t = selectedType("map");
  return t === SECTYPE.VISITED || t === SECTYPE.UNKNOWN;
};

// src/region_map.c:1266
// Lua: region_map.lua:369
RegionMap.canGuideCursor = function (): boolean {
  return perm("mapPreview") && selectedType("dungeon") === SECTYPE.VISITED;
};

// Lua: region_map.lua:373
function mapName(mapsec: number): string {
  RegionExtract.ensureGenerated();
  const sym = symOf(mapsec);
  const name = sym == null ? undefined : RegionExtract.SECTION_NAMES[sym];
  if (name == null) throw new Error("no sMapNames entry for " + tostring(mapsec));
  return Strings(name);
}

// Lua: region_map.lua:378
RegionMap.currentLocationName = function (): string | undefined {
  const mapsec = mapsecUnderCursor();
  if (mapsec === RegionExtract.MAPSEC_NONE) return undefined;
  return mapName(mapsec);
};

// Lua: region_map.lua:384
RegionMap.currentDungeonName = function (): string | undefined {
  const mapsec = dungeonUnderCursor();
  if (mapsec === RegionExtract.MAPSEC_NONE) return undefined;
  return mapName(mapsec);
};

// src/region_map.c:1930 GetDungeonName, :1919 GetDungeonFlavorText
// Lua: region_map.lua:391
function dungeonInfo(mapsec: number): [string, string] {
  RegionExtract.ensureGenerated();
  const id = symOf(mapsec);
  const desc = id ? RegionExtract.DUNGEON_DESCRIPTIONS[id] : undefined;
  if (desc) return [Strings(RegionExtract.SECTION_NAMES[id!]!), Strings(desc)];
  const noData = RomText.plain("gText_RegionMap_NoData");
  return [noData, noData];
}

// Lua: region_map.lua:400
RegionMap.dungeonIconFrame = function (dSec: unknown): number {
  return RegionMap.dungeonMapsecType(dSec) === SECTYPE.VISITED ? 1 : 0;
};

// src/region_map.c:3546-3550
// Lua: region_map.lua:405
RegionMap.dungeonIconOffset = function (x: number, y: number, region?: number): number {
  const mapsec = mapsecAt(region ?? selectedRegion(), "map", y, x);
  const t = mapsecType(mapsec);
  if ((t === SECTYPE.VISITED || t === SECTYPE.NOT_VISITED) && mapsec !== sec("MAPSEC_ROUTE_10_POKECENTER")) {
    return 2;
  }
  return 0;
};

// Lua: region_map.lua:414
RegionMap.dungeonIconVisitedImage = function (): any {
  return Gpu.image("dungeon_icon_visited");
};

// src/region_map.c:784-787 sAnim_FlyIcon
// Lua: region_map.lua:419
RegionMap.flyIconFrame = function (): number {
  if (!(S && S.icons.flyAnimStart != null)) return 0;
  return ((S.frame - S.icons.flyAnimStart) % 90) < 30 ? 0 : 1;
};

// src/region_map.c:747-751 sAnim_MapCursor
// Lua: region_map.lua:425
function cursorFrame(): number {
  return Math.floor((S.frame - S.cursor.animStart) / 20) % 2;
}

// src/region_map.c:630-634 sAnim_SwitchMapCursor
// Lua: region_map.lua:430
function switchCursorFrame(): number {
  return Math.floor((S.frame - S.switch!.cursorAnimStart!) / 20) % 2;
}

// src/region_map.c:3558 CreateFlyIcons
// Lua: region_map.lua:435
function createFlyIcons(): void {
  const list: LuaTable = seq();
  if (perm("flyDestinations")) {
    for (let region = 0; region <= 3; region++) {
      for (let y = 0; y <= MAP_HEIGHT - 1; y++) {
        for (let x = 0; x <= MAP_WIDTH - 1; x++) {
          const mapsec = mapsecAt(region, "map", y, x);
          if (mapsecType(mapsec) === SECTYPE.VISITED) {
            list[len(list) + 1] = { region, x, y, mapsec, visible: false } as Icon;
          }
        }
      }
    }
  }
  S.icons.fly = list;
  S.icons.flyAnimStart = S.frame;
}

// src/region_map.c:3581 CreateDungeonIcons
// Lua: region_map.lua:454
function createDungeonIcons(): void {
  const list: LuaTable = seq();
  for (let region = 0; region <= 3; region++) {
    for (let y = 0; y <= MAP_HEIGHT - 1; y++) {
      for (let x = 0; x <= MAP_WIDTH - 1; x++) {
        const mapsec = mapsecAt(region, "dungeon", y, x);
        if (mapsec !== RegionExtract.MAPSEC_NONE
          && !(mapsec === sec("MAPSEC_CERULEAN_CAVE") && !RegionMap.isFlagSet("FLAG_SYS_CAN_LINK_WITH_RS"))) {
          const offset = RegionMap.dungeonIconOffset(x, y, region);
          list[len(list) + 1] = {
            region, x, y, mapsec, visible: false,
            px: 8 * x + 32 + offset, py: 8 * y + 32 + offset,
            frame: dungeonMapsecType(mapsec) === SECTYPE.VISITED ? 1 : 0,
          } as Icon;
        }
      }
    }
  }
  S.icons.dungeon = list;
}

// src/region_map.c:3608 SetFlyIconInvisibility, :3627 SetDungeonIconInvisibility
// Lua: region_map.lua:476
function setIconsInvisible(kind: string, region: number, invisible: boolean): void {
  for (const [, icon] of ipairs<Icon>(S.icons[kind])) {
    if (region === 0xFF || icon.region === region) icon.visible = !invisible;
  }
}

// Lua: region_map.lua:482
RegionMap.flyTargets = function (): LuaTable {
  const out: LuaTable = seq();
  if (!S) return out;
  for (const [, icon] of ipairs<Icon>(S.icons.fly)) {
    if (icon.region === S.selectedRegion) {
      out[len(out) + 1] = { x: icon.x, y: icon.y, sec: symOf(icon.mapsec) };
    }
  }
  return out;
};

// Lua: region_map.lua:493
RegionMap.dungeonIcons = function (): LuaTable {
  const out: LuaTable = seq();
  if (!S) return out;
  for (const [, icon] of ipairs<Icon>(S.icons.dungeon)) {
    if (icon.region === S.selectedRegion) out[len(out) + 1] = icon;
  }
  return out;
};

// src/region_map.c:3958-3963
// Lua: region_map.lua:503
RegionMap.flyBlockedByMapType = function (): boolean {
  const t = tonumber(mapDef(RegionMap._session.map).mapType);
  return t === MAP_TYPE_UNDERGROUND || t === MAP_TYPE_INDOOR;
};

// src/region_map.c:3839 PrintTopBarTextLeft
// Lua: region_map.lua:509
function topBarLeft(key: string): void {
  S.topBar.left = key;
}

// src/region_map.c:3849 PrintTopBarTextRight
// Lua: region_map.lua:514
function topBarRight(key: string): void {
  S.topBar.right = key;
}

// Lua: region_map.lua:518
RegionMap.topBarText = function (): [string | undefined, string | undefined] {
  if (!S) return [undefined, undefined];
  return [S.topBar.left, S.topBar.right];
};

// src/region_map.c:1422 UpdateMapsecNameBox
// Lua: region_map.lua:524
function updateMapsecNameBox(): void {
  const g = S.gpu;
  Gpu.reset(g);
  Gpu.setBldCnt(g, 0, Gpu.BG0 + Gpu.OBJ, Gpu.DARKEN);
  Gpu.setBldY(g, 6);
  const inside = Gpu.BG0 + Gpu.BG3 + Gpu.OBJ + Gpu.CLR;
  Gpu.setWinIn(g, inside, inside);
  Gpu.setWinOut(g, Gpu.BG0 + Gpu.BG1 + Gpu.BG3 + Gpu.OBJ);
  Gpu.setWindowDims(g, 0, ...rect4(NAME_BOX.map));
  Gpu.setWindowDims(g, 1, ...rect4(NAME_BOX.dungeon));
  Gpu.setDispCnt(g, 0, false);
  if (dungeonUnderCursor() !== RegionExtract.MAPSEC_NONE) Gpu.setDispCnt(g, 1, false);
}

// src/region_map.c:1438 DisplayCurrentMapName
// Lua: region_map.lua:539
function displayCurrentMapName(): void {
  S.text.map = undefined;
  const mapsec = mapsecUnderCursor();
  if (mapsec === RegionExtract.MAPSEC_NONE) {
    Gpu.setWindowDims(S.gpu, 0, ...rect4(NAME_BOX.clear));
  } else {
    S.text.map = mapName(mapsec);
    Gpu.setWindowDims(S.gpu, 0, ...rect4(NAME_BOX.map));
  }
}

// src/region_map.c:1456 DrawDungeonNameBox
// Lua: region_map.lua:551
function drawDungeonNameBox(): void {
  Gpu.setWindowDims(S.gpu, 1, ...rect4(NAME_BOX.dungeon));
}

// src/region_map.c:1461 DisplayCurrentDungeonName
// Lua: region_map.lua:556
function displayCurrentDungeonName(): void {
  Gpu.setDispCnt(S.gpu, 1, true);
  S.text.dungeon = undefined;
  const mapsec = dungeonUnderCursor();
  if (mapsec !== RegionExtract.MAPSEC_NONE) {
    Gpu.setDispCnt(S.gpu, 1, false);
    S.text.dungeon = mapName(mapsec);
    S.text.dungeonType = selectedType("dungeon");
  }
}

// src/region_map.c:1487 ClearMapsecNameText
// Lua: region_map.lua:568
function clearMapsecNameText(): void {
  [S.text.map, S.text.dungeon] = [undefined, undefined];
}

// src/region_map.c:1495 BufferRegionMapBg
// Lua: region_map.lua:573
function bufferRegionMapBg(region: number): void {
  const whichMap = S.switch ? S.switch.currentSelection : S.selectedRegion;
  S.bg0 = {
    region,
    switchButton: S.perms.switchButton === true,
    navelPatch: whichMap === 2 && !RegionMap.isFlagSet("FLAG_WORLD_MAP_NAVEL_ROCK_EXTERIOR"),
    birthPatch: whichMap === 3 && !RegionMap.isFlagSet("FLAG_WORLD_MAP_BIRTH_ISLAND_EXTERIOR"),
  };
}

// Lua: region_map.lua:583
function saveGpuRegs(): boolean {
  if (S.savedRegs) return false;
  S.savedRegs = Gpu.save(S.gpu);
  return true;
}

// Lua: region_map.lua:589
function restoreGpuRegs(): boolean {
  if (!S.savedRegs) return false;
  Gpu.restore(S.gpu, S.savedRegs);
  S.savedRegs = undefined;
  return true;
}

// Lua: region_map.lua:596
function setTask(name: string): void {
  S.task = name;
}

// src/region_map.c:2674 SpriteCB_MapCursor
// Lua: region_map.lua:601
function spriteCbMapCursor(): void {
  const c = S.cursor;
  if (c.moveCounter !== 0) {
    c.spriteX = c.spriteX + c.horizontalMove;
    c.spriteY = c.spriteY + c.verticalMove;
    c.moveCounter = c.moveCounter - 1;
  } else {
    c.spriteX = 8 * RegionMap.cursorX + 36;
    c.spriteY = 8 * RegionMap.cursorY + 36;
  }
}

// src/region_map.c:2689 CreateMapCursor
// Lua: region_map.lua:614
function createMapCursor(): void {
  const session = RegionMap._session;
  const [x, y] = Position.playerCell({
    map: session.map, x: session.x, y: session.y,
    escapeWarp: session.escapeWarp, dynamicWarp: session.dynamicWarp, def: mapDef,
  }, RegionExtract.GEOMETRY);
  [RegionMap.cursorX, RegionMap.cursorY] = [x, y];
  const c = S.cursor;
  c.exists = true;
  [c.spriteX, c.spriteY] = [8 * x + 36, 8 * y + 36];
  c.handler = "input";
  c.animStart = S.frame;
  c.visible = false;
}

// src/region_map.c:3371 CreatePlayerIcon
// Lua: region_map.lua:630
function createPlayerIcon(): void {
  [RegionMap.playerX, RegionMap.playerY] = [RegionMap.cursorX, RegionMap.cursorY];
  S.player.exists = true;
  S.player.visible = false;
}

// Lua: region_map.lua:636
function joyNew(k: string): boolean { return S.input ? !!S.input.wasPressed(k) : false; }
// Lua: region_map.lua:637
function joyHeld(k: string): boolean { return S.input && S.input.isDown ? !!S.input.isDown(k) : false; }

// src/region_map.c:2862 SnapToIconOrButton
// Lua: region_map.lua:640
function snapToIconOrButton(): void {
  const c = S.cursor;
  if (perm("switchButton")) {
    c.snapId = (c.snapId + 1) % 3;
    if (c.snapId === 0 && S.selectedRegion !== S.playersRegion) c.snapId = c.snapId + 1;
    if (c.snapId === 1) {
      [RegionMap.cursorX, RegionMap.cursorY] = [SWITCH_BUTTON_X, SWITCH_BUTTON_Y];
    } else if (c.snapId === 2) {
      [RegionMap.cursorX, RegionMap.cursorY] = [CANCEL_BUTTON_X, CANCEL_BUTTON_Y];
    } else {
      [RegionMap.cursorX, RegionMap.cursorY] = [RegionMap.playerX, RegionMap.playerY];
    }
  } else {
    c.snapId = (c.snapId + 1) % 2;
    if (c.snapId === 1) {
      [RegionMap.cursorX, RegionMap.cursorY] = [CANCEL_BUTTON_X, CANCEL_BUTTON_Y];
    } else {
      [RegionMap.cursorX, RegionMap.cursorY] = [RegionMap.playerX, RegionMap.playerY];
    }
  }
  [c.spriteX, c.spriteY] = [8 * RegionMap.cursorX + 36, 8 * RegionMap.cursorY + 36];
}

// src/region_map.c:2754 HandleRegionMapInput
// Lua: region_map.lua:664
function handleRegionMapInput(): number {
  const c = S.cursor;
  let input = INPUT.NONE;
  [c.horizontalMove, c.verticalMove] = [0, 0];
  if (joyHeld("up") && RegionMap.cursorY > 0) {
    c.verticalMove = -2;
    input = INPUT.MOVE_START;
  }
  if (joyHeld("down") && RegionMap.cursorY < MAP_HEIGHT - 1) {
    c.verticalMove = 2;
    input = INPUT.MOVE_START;
  }
  if (joyHeld("right") && RegionMap.cursorX < MAP_WIDTH - 1) {
    c.horizontalMove = 2;
    input = INPUT.MOVE_START;
  }
  if (joyHeld("left") && RegionMap.cursorX > 0) {
    c.horizontalMove = -2;
    input = INPUT.MOVE_START;
  }
  if (joyNew("a")) {
    input = INPUT.A_BUTTON;
    if (RegionMap.cursorX === CANCEL_BUTTON_X && RegionMap.cursorY === CANCEL_BUTTON_Y) {
      se(SE.SE_M_HYPER_BEAM2);
      input = INPUT.CANCEL;
    }
    if (RegionMap.cursorX === SWITCH_BUTTON_X && RegionMap.cursorY === SWITCH_BUTTON_Y && perm("switchButton")) {
      se(SE.SE_M_HYPER_BEAM2);
      input = INPUT.SWITCH;
    }
  } else if (!joyNew("b")) {
    if (S.startRepeat) {
      snapToIconOrButton();
      return INPUT.MOVE_END;
    } else if (joyNew("select") && S.fromField) {
      input = INPUT.CANCEL;
    }
  } else {
    input = INPUT.CANCEL;
  }
  if (input === INPUT.MOVE_START) {
    c.moveCounter = 4;
    c.handler = "move";
  }
  return input;
}

// src/region_map.c:2836 MoveMapCursor
// Lua: region_map.lua:712
function moveMapCursor(): number {
  const c = S.cursor;
  if (c.moveCounter !== 0) return INPUT.MOVE_CONT;
  if (c.horizontalMove > 0) RegionMap.cursorX = RegionMap.cursorX + 1;
  if (c.horizontalMove < 0) RegionMap.cursorX = RegionMap.cursorX - 1;
  if (c.verticalMove > 0) RegionMap.cursorY = RegionMap.cursorY + 1;
  if (c.verticalMove < 0) RegionMap.cursorY = RegionMap.cursorY - 1;
  c.handler = "input";
  return INPUT.MOVE_END;
}

// src/region_map.c:2855 GetRegionMapInput
// Lua: region_map.lua:724
function getRegionMapInput(): number {
  if (S.cursor.handler === "move") return moveMapCursor();
  return handleRegionMapInput();
}

// src/region_map.c:1168 PlaySEForSelectedMapsec
// Lua: region_map.lua:730
function playSEForSelectedMapsec(): void {
  if (mapsecAt(S.selectedRegion, "map", RegionMap.cursorY, RegionMap.cursorX) === sec("MAPSEC_ROUTE_4_POKECENTER")) {
    return;
  }
  const [t, d] = [selectedType("map"), selectedType("dungeon")];
  if ((t !== SECTYPE.ROUTE && t !== SECTYPE.NONE) || (d !== SECTYPE.ROUTE && d !== SECTYPE.NONE)) {
    se(SE.SE_DEX_SCROLL);
  }
  if (RegionMap.cursorX === SWITCH_BUTTON_X && RegionMap.cursorY === SWITCH_BUTTON_Y && perm("switchButton")) {
    se(SE.SE_M_SPIT_UP);
  } else if (RegionMap.cursorX === CANCEL_BUTTON_X && RegionMap.cursorY === CANCEL_BUTTON_Y) {
    se(SE.SE_M_SPIT_UP);
  }
}

const Tasks: Record<string, () => void> = {};

// src/region_map.c:3443 InitMapIcons
// Lua: region_map.lua:748
function initMapIcons(exitTask: string): void {
  S.icons.state = 0;
  S.icons.exitTask = exitTask;
  setTask("loadMapIcons");
}

// src/region_map.c:3453 LoadMapIcons
// Lua: region_map.lua:755
Tasks.loadMapIcons = function (): void {
  const st = S.icons.state;
  if (st === 0) {
    S.vblank = false;
    S.icons.state = 1;
  } else if (st === 1) {
    createDungeonIcons();
    S.icons.state = 2;
  } else if (st === 2) {
    createFlyIcons();
    S.icons.state = 3;
  } else if (st === 3) {
    blendPalettes(16);
    beginFade(16, 0);
    S.icons.state = 4;
  } else if (st === 4) {
    S.vblank = true;
    S.icons.state = 5;
  } else {
    S.objOn = true;
    setTask(S.icons.exitTask!);
  }
};

// src/region_map.c:2296 InitScreenForMapOpenAnim
// Lua: region_map.lua:780
function initScreenForMapOpenAnim(): void {
  const g = S.gpu;
  Gpu.setBldCnt(g, 0, Gpu.BG1, Gpu.NONE);
  Gpu.setWinIn(g, Gpu.BG1 + Gpu.OBJ, 0);
  Gpu.setWinOut(g, Gpu.OBJ);
  Gpu.setWindowDims(g, 0, S.edges![1].x + 8, 16, S.edges![4].x - 8, 160);
  Gpu.setDispCnt(g, 0, false);
}

// src/region_map.c:2518 SetGpuWindowDimsToMapEdges
// Lua: region_map.lua:790
function setGpuWindowDimsToMapEdges(): void {
  Gpu.setWindowDims(S.gpu, 0, S.edges![1].x, 16, S.edges![4].x, 160);
}

// src/region_map.c:2310 SetGpuRegsToFadeMapToWhite
// Lua: region_map.lua:795
function setGpuRegsToFadeMapToWhite(): void {
  const g = S.gpu;
  Gpu.reset(g);
  Gpu.setBldCnt(g, Gpu.BG1, Gpu.BG0 + Gpu.BG3 + Gpu.BD, Gpu.LIGHTEN);
  Gpu.setBldY(g, S.anim!.blendY);
  Gpu.setWinIn(g, Gpu.ALL - Gpu.BG3, 0);
  Gpu.setWinOut(g, Gpu.BG1 + Gpu.OBJ);
  Gpu.setWindowDims(g, 0, ...rect4(MAP_WINDOW));
  Gpu.setDispCnt(g, 0, false);
}

const EDGE_NAMES = seq("edge_top_left", "edge_mid_left", "edge_bottom_left", "edge_top_right", "edge_mid_right", "edge_bottom_right");

// src/region_map.c:2217 InitMapOpenAnim
// Lua: region_map.lua:809
function initMapOpenAnim(exitTask: string): void {
  S.edges = seq();
  for (let i = 0; i <= 5; i++) {
    S.edges[i + 1] = { name: EDGE_NAMES[i + 1]!, x: 32 * Math.floor(i / 3) + 104, y: 64 * (i % 3) + 40, visible: false } as Edge;
  }
  S.anim = { openState: 0, loadGfxState: 0, moveState: 0, closeState: 0, blendY: 0, exitTask };
  saveGpuRegs();
  Gpu.reset(S.gpu);
  initScreenForMapOpenAnim();
  [S.bgShown[0], S.bgShown[3]] = [false, false];
  setTask("mapOpenAnim");
}

// Lua: region_map.lua:822
function setEdgesVisible(visible: boolean): void {
  for (const [, e] of ipairs<Edge>(S.edges)) e.visible = visible;
}

// src/region_map.c:2462 MoveMapEdgesOutward, :2618 MoveMapEdgesInward
// Lua: region_map.lua:827
function moveMapEdges(outward: boolean): boolean {
  setGpuWindowDimsToMapEdges();
  const goal = outward ? 0 : 104;
  if (S.edges![1].x === goal) return true;
  const ms = S.anim!.moveState;
  let step: number;
  if (ms > 17) step = 1; else if (ms > 14) step = 2; else if (ms > 10) step = 3; else if (ms > 6) step = 5; else step = 8;
  if (!outward) step = -step;
  for (let i = 1; i <= 3; i++) S.edges![i].x = S.edges![i].x - step;
  for (let i = 4; i <= 6; i++) S.edges![i].x = S.edges![i].x + step;
  S.anim!.moveState = ms + 1;
  return false;
}

// src/region_map.c:2354 Task_MapOpenAnim
// Lua: region_map.lua:842
Tasks.mapOpenAnim = function (): void {
  const a = S.anim!;
  const st = a.openState;
  if (st === 0) {
    S.vblank = false;
    a.openState = 1;
  } else if (st === 1) {
    if (a.loadGfxState >= 9) {
      a.openState = 2;
    } else {
      a.loadGfxState = a.loadGfxState + 1;
    }
  } else if (st === 2) {
    S.bg1 = "frame_normal";
    a.openState = 3;
  } else if (st === 3) {
    blendPalettes(16);
    beginFade(16, 0);
    S.vblank = true;
    a.openState = 4;
  } else if (st === 4) {
    [S.bgShown[0], S.bgShown[3], S.bgShown[1]] = [true, true, true];
    setEdgesVisible(true);
    setGpuWindowDimsToMapEdges();
    a.openState = 5;
  } else if (st === 5) {
    if (!S.fade.active) {
      a.openState = 6;
      se(SE.SE_CARD_OPEN);
    }
  } else if (st === 6) {
    if (moveMapEdges(true)) a.openState = 7;
  } else if (st === 7) {
    S.player.visible = true;
    S.cursor.visible = true;
    a.openState = 8;
  } else if (st === 8) {
    a.blendY = 15;
    setGpuRegsToFadeMapToWhite();
    [S.bgShown[0], S.bgShown[3]] = [true, true];
    setIconsInvisible("fly", S.selectedRegion, false);
    setIconsInvisible("dungeon", S.selectedRegion, false);
    a.openState = 9;
  } else if (st === 9) {
    topBarLeft("gText_RegionMap_DPadMove");
    if (selectedType("dungeon") !== SECTYPE.VISITED) {
      topBarRight("gText_RegionMap_Space");
    } else {
      topBarRight("gText_RegionMap_AButtonGuide");
    }
    S.topBar.shown = true;
    a.openState = 10;
  } else if (st === 10) {
    S.backdropBlue = true;
    a.openState = 11;
  } else if (st === 11) {
    Audio.stopSe(SE.SE_CARD_OPEN);
    se(SE.SE_ROTATING_GATE);
    a.openState = 12;
  } else if (st === 12) {
    if (a.blendY === 2) {
      setEdgesVisible(false);
      a.openState = 13;
      Gpu.setBldY(S.gpu, 0);
    } else {
      a.blendY = a.blendY - 1;
      Gpu.setBldY(S.gpu, a.blendY);
    }
  } else if (st === 13) {
    restoreGpuRegs();
    displayCurrentDungeonName();
    a.openState = 14;
  } else {
    setTask(a.exitTask);
  }
};

// src/region_map.c:2528 InitScreenForMapCloseAnim
// Lua: region_map.lua:920
function initScreenForMapCloseAnim(): void {
  const g = S.gpu;
  Gpu.setBldCnt(g, 0, Gpu.BG1, Gpu.NONE);
  Gpu.setWinIn(g, Gpu.BG1 + Gpu.OBJ, 0);
  Gpu.setWinOut(g, Gpu.OBJ);
  Gpu.setWindowDims(g, 0, S.edges![1].x + 16, 16, S.edges![4].x - 16, 160);
  Gpu.setDispCnt(g, 0, false);
}

// src/region_map.c:2557 Task_MapCloseAnim
// Lua: region_map.lua:930
Tasks.mapCloseAnim = function (): void {
  const a = S.anim!;
  const st = a.closeState;
  if (st === 0) {
    S.topBar.shown = false;
    a.closeState = 1;
  } else if (st === 1) {
    a.closeState = 2;
  } else if (st === 2) {
    S.backdropBlue = false;
    // src/region_map.c:2572
    S.palTinted = false;
    a.closeState = 3;
  } else if (st === 3) {
    setEdgesVisible(true);
    S.player.visible = false;
    S.cursor.visible = false;
    setIconsInvisible("dungeon", 0xFF, true);
    setIconsInvisible("fly", 0xFF, true);
    a.moveState = 0;
    a.blendY = 0;
    a.closeState = 4;
  } else if (st === 4) {
    setGpuRegsToFadeMapToWhite();
    a.closeState = 5;
  } else if (st === 5) {
    if (a.blendY === 15) {
      Gpu.setBldY(S.gpu, a.blendY);
      a.closeState = 6;
    } else {
      a.blendY = a.blendY + 1;
      Gpu.setBldY(S.gpu, a.blendY);
    }
  } else if (st === 6) {
    initScreenForMapCloseAnim();
    setGpuWindowDimsToMapEdges();
    se(SE.SE_CARD_FLIPPING);
    a.closeState = 7;
  } else if (st === 7) {
    if (moveMapEdges(false)) a.closeState = 8;
  } else {
    setTask(a.exitTask);
  }
};

// src/region_map.c:1553 InitSwitchMapMenu
// Lua: region_map.lua:976
function initSwitchMapMenu(whichMap: number, exitTask: string): void {
  const sw = { alpha: 0, blendY: 0, mainState: 0, cursorLoadState: 0, exitTask } as SwitchState;
  if (RegionMap.isFlagSet("FLAG_SYS_SEVII_MAP_4567")) {
    sw.maxSelection = 3;
  } else if (RegionMap.isFlagSet("FLAG_SYS_SEVII_MAP_123")) {
    sw.maxSelection = 1;
  } else {
    sw.maxSelection = 0;
  }
  if (sw.maxSelection === 1) {
    [sw.image, sw.yOffset] = ["switch_menu_123", 6];
  } else {
    [sw.image, sw.yOffset] = ["switch_menu_all", 3];
  }
  sw.currentSelection = whichMap;
  sw.chosenRegion = S.playersRegion;
  sw.highlight = seq(0, 0, 0, 0);
  S.switch = sw;
  saveGpuRegs();
  topBarRight("gText_RegionMap_AButtonOK");
  setTask("switchMapMenu");
}

// src/region_map.c:1591 ResetGpuRegsForSwitchMapMenu
// Lua: region_map.lua:1000
function resetGpuRegsForSwitchMapMenu(): void {
  const g = S.gpu;
  Gpu.reset(g);
  Gpu.setBldCnt(g, Gpu.BG0 + Gpu.BG1 + Gpu.BG3 + Gpu.OBJ, Gpu.BG2, Gpu.BLEND);
  Gpu.setBldAlpha(g, 16 - S.switch!.alpha, S.switch!.alpha);
}

// Lua: region_map.lua:1007
function highlightRect(): LuaTable {
  const sw = S.switch!;
  const top = 8 * (sw.yOffset + 4 * sw.currentSelection);
  sw.highlight = seq(72, top, 168, top + 32);
  return sw.highlight;
}

// src/region_map.c:1757 SetGpuRegsToDimScreen
// Lua: region_map.lua:1015
function setGpuRegsToDimScreen(): void {
  const g = S.gpu;
  const h = highlightRect();
  Gpu.reset(g);
  Gpu.setBldCnt(g, 0, Gpu.BG0 + Gpu.BG2 + Gpu.OBJ, Gpu.DARKEN);
  Gpu.setWinIn(g, Gpu.BG_ALL + Gpu.OBJ, Gpu.BG0 + Gpu.BG2 + Gpu.OBJ);
  Gpu.setWinOut(g, Gpu.ALL);
  Gpu.setDispCnt(g, 1, false);
  Gpu.setWindowDims(g, 1, ...rect4(h));
}

// Lua: region_map.lua:1026
function redrawForSelection(): void {
  bufferRegionMapBg(S.switch!.currentSelection);
  setIconsInvisible("fly", 0xFF, true);
  setIconsInvisible("dungeon", 0xFF, true);
}

// src/region_map.c:1786 HandleSwitchMapInput
// Lua: region_map.lua:1033
function handleSwitchMapInput(): boolean {
  const sw = S.switch!;
  let changed = false;
  const h = highlightRect();
  if (joyNew("up") && sw.currentSelection !== 0) {
    se(SE.SE_BAG_CURSOR);
    sw.currentSelection = sw.currentSelection - 1;
    changed = true;
  }
  if (joyNew("down") && sw.currentSelection < sw.maxSelection) {
    se(SE.SE_BAG_CURSOR);
    sw.currentSelection = sw.currentSelection + 1;
    changed = true;
  }
  if (joyNew("a") && sw.blendY === 6) {
    se(SE.SE_M_SWIFT);
    sw.chosenRegion = sw.currentSelection;
    return true;
  }
  if (joyNew("b")) {
    sw.currentSelection = sw.chosenRegion;
    redrawForSelection();
    return true;
  }
  if (changed) {
    redrawForSelection();
    topBarRight("gText_RegionMap_AButtonOK");
    setIconsInvisible("fly", sw.currentSelection, false);
    setIconsInvisible("dungeon", sw.currentSelection, false);
  }
  S.player.visible = sw.currentSelection === S.playersRegion;
  Gpu.setWindowDims(S.gpu, 1, ...rect4(h));
  return false;
}

// src/region_map.c:1626 Task_SwitchMapMenu
// Lua: region_map.lua:1069
Tasks.switchMapMenu = function (): void {
  const sw = S.switch!;
  const st = sw.mainState;
  if (st === 0) {
    S.vblank = false;
    topBarLeft("gText_RegionMap_UpDownPick");
    sw.mainState = 1;
  } else if (st === 1) {
    sw.mainState = 2;
  } else if (st === 2) {
    S.bg2 = { image: sw.image };
    sw.mainState = 3;
  } else if (st === 3) {
    clearMapsecNameText();
    sw.mainState = 4;
  } else if (st === 4) {
    resetGpuRegsForSwitchMapMenu();
    S.bgShown[2] = true;
    sw.mainState = 5;
  } else if (st === 5) {
    S.vblank = true;
    sw.mainState = 6;
  } else if (st === 6) {
    if (sw.alpha < 16) {
      Gpu.setBldAlpha(S.gpu, 16 - sw.alpha, sw.alpha);
      sw.alpha = sw.alpha + 2;
    } else {
      setGpuRegsToDimScreen();
      sw.mainState = 7;
    }
  } else if (st === 7) {
    if (sw.blendY < 6) {
      sw.blendY = sw.blendY + 1;
      Gpu.setBldY(S.gpu, sw.blendY);
    } else {
      sw.mainState = 8;
    }
  } else if (st === 8) {
    if (sw.cursorLoadState >= 3) {
      sw.mainState = 9;
    } else {
      if (sw.cursorLoadState === 2) {
        sw.cursors = true;
        sw.cursorAnimStart = S.frame;
      }
      sw.cursorLoadState = sw.cursorLoadState + 1;
    }
  } else if (st === 9) {
    if (handleSwitchMapInput()) {
      S.selectedRegion = sw.currentSelection;
      if (S.playersRegion === sw.currentSelection) {
        S.player.visible = true;
        setIconsInvisible("fly", sw.currentSelection, false);
        setIconsInvisible("dungeon", sw.currentSelection, false);
      }
      sw.mainState = 10;
    }
  } else if (st === 10) {
    if (sw.blendY !== 0) {
      sw.blendY = sw.blendY - 1;
      Gpu.setBldY(S.gpu, sw.blendY);
    } else {
      Gpu.setBldY(S.gpu, 0);
      sw.cursors = false;
      resetGpuRegsForSwitchMapMenu();
      sw.mainState = 11;
    }
  } else if (st === 11) {
    if (sw.alpha >= 2) {
      sw.alpha = sw.alpha - 2;
      Gpu.setBldAlpha(S.gpu, 16 - sw.alpha, sw.alpha);
    } else {
      sw.mainState = 12;
    }
  } else if (st === 12) {
    S.cursor.visible = true;
    sw.mainState = 13;
  } else {
    setTask(sw.exitTask);
    S.bgShown[2] = false;
    S.bg2 = undefined;
    topBarLeft("gText_RegionMap_DPadMove");
    topBarRight("gText_RegionMap_AButtonSwitch");
    S.switch = undefined;
    updateMapsecNameBox();
    drawDungeonNameBox();
    Gpu.setWindowDims(S.gpu, 0, ...rect4(NAME_BOX.clear));
  }
};

// src/region_map.c:1941 InitDungeonMapPreview
// Lua: region_map.lua:1160
function initDungeonMapPreview(exitTask: string): void {
  let mapsec = dungeonUnderCursor();
  if (mapsec === sec("MAPSEC_TANOBY_CHAMBERS")) mapsec = sec("MAPSEC_MONEAN_CHAMBER");
  if (!MapPreviewScreen.entryFor(mapsec)) mapsec = sec("MAPSEC_ROCK_TUNNEL");
  S.preview = {
    artSec: mapsec, mainState: 0, drawState: 0, loadState: 0, updateCounter: 0, timer: 0,
    blendY: 0, exitTask, dungeon: dungeonUnderCursor(),
  };
  RegionMap.previewDungeon = symOf(S.preview.dungeon) ?? "MAPSEC_NONE";
  saveGpuRegs();
  Gpu.reset(S.gpu);
  clearMapsecNameText();
  setTask("dungeonMapPreview");
}

// src/region_map.c:2113 InitScreenForDungeonMapPreview
// Lua: region_map.lua:1177
function initScreenForDungeonMapPreview(): void {
  const [g, p] = [S.gpu, S.preview!];
  Gpu.reset(g);
  Gpu.setBldCnt(g, 0, Gpu.BG0 + Gpu.OBJ, Gpu.DARKEN);
  Gpu.setBldY(g, p.blendY);
  Gpu.setWinIn(g, 0, Gpu.BG0 + Gpu.BG2 + Gpu.BG3);
  Gpu.setWinOut(g, Gpu.BG0 + Gpu.BG1 + Gpu.BG3 + Gpu.OBJ + Gpu.CLR);
  Gpu.setDispCnt(g, 1, false);
  p.left = 8 * RegionMap.cursorX + 32;
  p.top = 8 * RegionMap.cursorY + 24;
  p.right = p.left + 8;
  p.bottom = p.top + 8;
  const inc = (v: number): number => (v >= 0 ? Math.floor(v / 8) : -Math.floor(-v / 8));
  p.leftIncrement = inc(16 - p.left);
  p.topIncrement = inc(32 - p.top);
  p.rightIncrement = inc(224 - p.right);
  p.bottomIncrement = inc(136 - p.bottom);
}

// src/region_map.c:2135 UpdateDungeonMapPreview
// Lua: region_map.lua:1197
function updateDungeonMapPreview(closing: boolean): boolean {
  const p = S.preview!;
  if (!closing) {
    if (p.updateCounter < 8) {
      p.left = p.left! + p.leftIncrement!;
      p.top = p.top! + p.topIncrement!;
      p.right = p.right! + p.rightIncrement!;
      p.bottom = p.bottom! + p.bottomIncrement!;
      p.updateCounter = p.updateCounter + 1;
      if (p.blendY < 6) p.blendY = p.blendY + 1;
    } else {
      return true;
    }
  } else {
    if (p.updateCounter === 0) return true;
    p.left = p.left! - p.leftIncrement!;
    p.top = p.top! - p.topIncrement!;
    p.right = p.right! - p.rightIncrement!;
    p.bottom = p.bottom! - p.bottomIncrement!;
    p.updateCounter = p.updateCounter - 1;
    if (p.blendY > 0) p.blendY = p.blendY - 1;
  }
  Gpu.setWindowDims(S.gpu, 1, p.left!, p.top!, p.right!, p.bottom!);
  Gpu.setBldY(S.gpu, p.blendY);
  return false;
}

// src/region_map.c:2095 FreeDungeonMapPreview
// Lua: region_map.lua:1225
function freeDungeonMapPreview(): void {
  setTask(S.preview!.exitTask);
  S.bgShown[2] = false;
  S.bg2 = undefined;
  restoreGpuRegs();
  displayCurrentMapName();
  displayCurrentDungeonName();
  updateMapsecNameBox();
  drawDungeonNameBox();
  topBarRight("gText_RegionMap_AButtonGuide");
  S.preview = undefined;
  RegionMap.previewDungeon = undefined;
}

// src/region_map.c:1984 Task_DungeonMapPreview
// Lua: region_map.lua:1240
Tasks.dungeonMapPreview = function (): void {
  const p = S.preview!;
  const st = p.mainState;
  if (st === 0) {
    S.vblank = false;
    p.mainState = 1;
  } else if (st === 1) {
    if (p.loadState >= 4) {
      p.mainState = 2;
    } else {
      p.loadState = p.loadState + 1;
    }
  } else if (st === 2) {
    initScreenForDungeonMapPreview();
    topBarRight("gText_RegionMap_AButtonCancel2");
    p.mainState = 3;
  } else if (st === 3) {
    S.bg2 = { preview: p.artSec };
    p.mainState = 4;
  } else if (st === 4) {
    S.bgShown[2] = true;
    p.mainState = 5;
  } else if (st === 5) {
    S.vblank = true;
    p.mainState = 6;
  } else if (st === 6) {
    if (updateDungeonMapPreview(false)) p.mainState = 7;
  } else if (st === 7) {
    setTask("dungeonMapPreviewFlavorText");
  } else if (st === 8) {
    if (updateDungeonMapPreview(true)) p.mainState = 9;
  } else if (st === 9) {
    freeDungeonMapPreview();
  }
};

// src/region_map.c:2035 Task_DrawDungeonMapPreviewFlavorText
// Lua: region_map.lua:1277
Tasks.dungeonMapPreviewFlavorText = function (): void {
  const p = S.preview!;
  const st = p.drawState;
  if (st === 0) {
    [p.red, p.green, p.blue] = [0x0133, 0x0100, 0x00F0];
    p.drawState = 1;
  } else if (st === 1) {
    const t = p.timer;
    p.timer = t + 1;
    if (t > 40) {
      p.timer = 0;
      p.drawState = 2;
    }
  } else if (st === 2) {
    p.text = undefined;
    p.drawState = 3;
  } else if (st === 3) {
    if (p.timer > 25) {
      const [name, desc] = dungeonInfo(dungeonUnderCursor());
      p.text = { name, desc };
      p.drawState = 4;
    } else if (p.timer > 20) {
      [p.red, p.green, p.blue] = [p.red! - 6, p.green! - 5, p.blue! - 5];
      S.bg2!.tone = seq(p.red, p.green, p.blue);
    }
    p.timer = p.timer + 1;
  } else if (st === 4) {
    if (joyNew("b") || joyNew("a")) {
      p.text = undefined;
      p.mainState = p.mainState + 1;
      p.drawState = 5;
    }
  } else {
    setTask("dungeonMapPreview");
  }
};

// src/region_map.c:1182 Task_RegionMap
// Lua: region_map.lua:1315
Tasks.regionMap = function (): void {
  const st = S.mainState;
  if (st === 0) {
    initMapIcons("regionMap");
    createMapCursor();
    createPlayerIcon();
    S.mainState = 1;
  } else if (st === 1) {
    if (S.perms.openAnim) {
      initMapOpenAnim("regionMap");
    } else {
      [S.bgShown[0], S.bgShown[3], S.bgShown[1]] = [true, true, true];
      topBarLeft("gText_RegionMap_DPadMove");
      topBarRight("gText_RegionMap_Space");
      S.topBar.shown = true;
      S.player.visible = true;
      S.cursor.visible = true;
      setIconsInvisible("fly", S.selectedRegion, false);
      setIconsInvisible("dungeon", S.selectedRegion, false);
    }
    S.mainState = 2;
  } else if (st === 2) {
    if (!S.fade.active) {
      displayCurrentMapName();
      displayCurrentDungeonName();
      S.mainState = 3;
    }
  } else if (st === 3) {
    const input = getRegionMapInput();
    if (input === INPUT.MOVE_START) {
      S.cursor.snapId = 0;
    } else if (input === INPUT.MOVE_END) {
      displayCurrentMapName();
      displayCurrentDungeonName();
      drawDungeonNameBox();
      playSEForSelectedMapsec();
      if (dungeonUnderCursor() !== RegionExtract.MAPSEC_NONE) {
        if (perm("mapPreview")) {
          if (selectedType("dungeon") === SECTYPE.VISITED) {
            topBarRight("gText_RegionMap_AButtonGuide");
          } else {
            topBarRight("gText_RegionMap_Space");
          }
        }
      } else if (RegionMap.cursorX === SWITCH_BUTTON_X && RegionMap.cursorY === SWITCH_BUTTON_Y && perm("switchButton")) {
        topBarRight("gText_RegionMap_AButtonSwitch");
      } else if (RegionMap.cursorX === CANCEL_BUTTON_X && RegionMap.cursorY === CANCEL_BUTTON_Y) {
        topBarRight("gText_RegionMap_AButtonCancel");
      } else {
        topBarRight("gText_RegionMap_Space");
      }
    } else if (input === INPUT.A_BUTTON) {
      if (selectedType("dungeon") === SECTYPE.VISITED && S.perms.mapPreview) {
        initDungeonMapPreview("saveMainMapTask");
      }
    } else if (input === INPUT.SWITCH) {
      initSwitchMapMenu(S.selectedRegion, "saveMainMapTask");
    } else if (input === INPUT.CANCEL) {
      S.mainState = 4;
    }
  } else if (st === 4) {
    if (perm("openAnim")) {
      [S.anim!.closeState, S.anim!.exitTask] = [0, "regionMap"];
      setTask("mapCloseAnim");
    }
    S.mainState = 5;
  } else if (st === 5) {
    beginFade(0, 16);
    S.mainState = 6;
  } else {
    if (!S.fade.active) S.finish = { picked: false };
  }
};

// src/region_map.c:1315 SaveMainMapTask
// Lua: region_map.lua:1390
Tasks.saveMainMapTask = function (): void {
  setTask(S.mainTask);
};

// src/region_map.c:3879 Task_FlyMap
// Lua: region_map.lua:1395
Tasks.flyMap = function (): void {
  const st = S.mainState;
  if (st === 0) {
    beginFade(16, 0);
    initMapIcons("flyMap");
    createMapCursor();
    createPlayerIcon();
    S.cursor.visible = true;
    S.player.visible = true;
    S.mainState = 1;
  } else if (st === 1) {
    [S.bgShown[0], S.bgShown[3], S.bgShown[1]] = [true, true, true];
    topBarLeft("gText_RegionMap_DPadMove");
    setIconsInvisible("fly", S.selectedRegion, false);
    setIconsInvisible("dungeon", S.selectedRegion, false);
    S.mainState = 2;
  } else if (st === 2) {
    topBarRight("gText_RegionMap_AButtonOK");
    S.topBar.shown = true;
    S.mainState = 3;
  } else if (st === 3) {
    if (!S.fade.active) {
      displayCurrentMapName();
      displayCurrentDungeonName();
      S.mainState = 4;
    }
  } else if (st === 4) {
    const input = getRegionMapInput();
    if (input === INPUT.CANCEL) {
      S.mainState = 6;
    } else if (input === INPUT.MOVE_END) {
      if (selectedType("map") === SECTYPE.VISITED) {
        se(SE.SE_DEX_PAGE);
      } else {
        playSEForSelectedMapsec();
      }
      S.cursor.snapId = 0;
      displayCurrentMapName();
      displayCurrentDungeonName();
      drawDungeonNameBox();
      const t = selectedType("map");
      if (RegionMap.cursorX === CANCEL_BUTTON_X && RegionMap.cursorY === CANCEL_BUTTON_Y) {
        se(SE.SE_M_SPIT_UP);
        topBarRight("gText_RegionMap_AButtonCancel");
      } else if (t === SECTYPE.VISITED || t === SECTYPE.UNKNOWN) {
        topBarRight("gText_RegionMap_AButtonOK");
      } else {
        topBarRight("gText_RegionMap_Space");
      }
    } else if (input === INPUT.A_BUTTON) {
      const t = selectedType("map");
      if ((t === SECTYPE.VISITED || t === SECTYPE.UNKNOWN) && perm("flyDestinations")) {
        if (RegionMap.flyBlockedByMapType()) {
          S.selectedDestination = false;
        } else {
          se(SE.SE_USE_ITEM);
          S.selectedDestination = true;
        }
        S.mainState = 5;
      }
    } else if (input === INPUT.SWITCH) {
      initSwitchMapMenu(S.selectedRegion, "saveMainMapTask");
    }
  } else if (st === 5) {
    S.mainState = 6;
  } else if (st === 6) {
    beginFade(0, 16);
    S.mainState = 7;
  } else {
    if (!S.fade.active) {
      S.finish = { picked: S.selectedDestination === true, mapsec: S.selectedDestination ? mapsecUnderCursor() : undefined };
    }
  }
};

// src/region_map.c:1052 CB2_OpenRegionMap
// Lua: region_map.lua:1471
function cb2OpenRegionMap(): void {
  const st = S.openState;
  if (st === 1) {
    updateMapsecNameBox();
  } else if (st === 3) {
    if (S.loadGfxState < 9) {
      S.loadGfxState = S.loadGfxState + 1;
      return;
    }
  } else if (st === 4) {
    S.bg1 = undefined;
  } else if (st === 5) {
    bufferRegionMapBg(S.selectedRegion);
    if (S.type !== "normal") S.bg1 = "frame_fly";
  } else if (st === 6) {
    displayCurrentMapName();
  } else if (st === 7) {
    displayCurrentDungeonName();
  } else if (st === 8) {
    if (S.perms.openAnim) [S.bgShown[0], S.bgShown[3]] = [false, false];
  } else if (st >= 9) {
    beginFade(16, 0);
    S.cb2 = "main";
    setTask(S.mainTask);
    S.vblank = true;
  }
  S.openState = st + 1;
}

// Lua: region_map.lua:1500
function newState(mode: string, session: any): RMState {
  const perms: Record<string, boolean> = {};
  for (const [k, v] of pairs<boolean>(PERMISSIONS[mode])) perms[k as string] = v;
  // src/region_map.c:1028
  if (!RegionMap.isFlagSet("FLAG_SYS_SEVII_MAP_123")) perms.switchButton = false;
  const region = Position.regionFor(mapDef(session.map).regionMapSectionId, RegionExtract.LAYOUTS);
  return {
    type: mode,
    perms,
    selectedRegion: region,
    playersRegion: region,
    mainTask: mode === "fly" ? "flyMap" : "regionMap",
    cb2: "open",
    openState: 0,
    loadGfxState: 0,
    mainState: 0,
    frame: 0,
    gpu: Gpu.new(),
    fade: { active: false, y: 16, bgY: 16, objY: 16, shownBg: 16, shownObj: 16, toggle: 0, pending: false },
    vblank: false,
    bgShown: [false, false, false, false],
    objOn: false,
    backdropBlue: mode !== "normal",
    // src/region_map.c:1112
    palTinted: true,
    cursor: { exists: false, visible: false, spriteX: 0, spriteY: 0, horizontalMove: 0, verticalMove: 0,
      moveCounter: 0, snapId: 0, handler: "input", animStart: 0 },
    player: { exists: false, visible: false },
    icons: { fly: seq(), dungeon: seq() },
    text: {},
    topBar: { shown: false },
    repeatCounter: KEY_REPEAT_START,
  };
}

// Lua: region_map.lua:1535
function bagIsOpen(): boolean {
  // package.loaded["src.ui.game3.bag_menu"]: while bag_menu is still a stub
  // it cannot be open (its isOpen throws NotPortedError), so that reads false.
  try {
    return BagMenu && BagMenu.isOpen && BagMenu.isOpen() ? true : false;
  } catch (e) {
    if (e instanceof NotPortedError) return false;
    throw e;
  }
}

// Lua: region_map.lua:1540
RegionMap.show = function (optsIn?: ShowOpts): void {
  const opts = optsIn ?? {};
  RegionExtract.ensureGenerated();
  if (S) Stack.pop("region_map");
  if (!opts.session) throw new Error("RegionMap.show needs the session");
  RegionMap._session = opts.session;
  RegionMap._onClose = opts.onClose;
  RegionMap._onPick = opts.onPick;
  // src/item_use.c:666, :675, src/field_specials.c:185, src/region_map.c:3873
  RegionMap.mode = opts.mode != null && PERMISSIONS[opts.mode] ? opts.mode : "normal";
  RegionMap.previewDungeon = undefined;
  [RegionMap.cursorX, RegionMap.cursorY] = [0, 0];
  S = newState(RegionMap.mode, RegionMap._session);
  // src/region_map.c:2819
  S.fromField = RegionMap.mode === "normal" && !bagIsOpen();
  RegionMap.open = true;
  PokedexChrome.install();
  Stack.push("region_map", RegionMap, { hideBelow: true, fullscreen: true });
};

// src/region_map.c:1320 FreeRegionMap, :4005 FreeFlyMap
// Lua: region_map.lua:1560
RegionMap.close = function (picked?: boolean): void {
  const wasFly = RegionMap.mode === "fly";
  RegionMap.open = false;
  RegionMap.previewDungeon = undefined;
  RegionMap.mode = "normal";
  S = CLOSED;
  Stack.pop("region_map");
  const cb = RegionMap._onClose;
  RegionMap._onClose = undefined;
  RegionMap._onPick = undefined;
  if (cb && !picked) cb(undefined);
  if (wasFly && !picked) {
    // package.loaded["src.ui.game3.party_menu"]: always loaded here
    if (PartyMenu && PartyMenu.returnFromFlyMap) PartyMenu.returnFromFlyMap();
  }
};

// Lua: region_map.lua:1577
RegionMap.isOpen = function (): boolean {
  return RegionMap.open;
};

// Lua: region_map.lua:1581
RegionMap.inputReady = function (): boolean {
  if (!S || S.cb2 !== "main" || S.task !== S.mainTask) return false;
  const st = S.mainState;
  return (S.mainTask === "regionMap" && st === 3) || (S.mainTask === "flyMap" && st === 4);
};

// Lua: region_map.lua:1587
RegionMap.state = function (): RMState | undefined {
  return S ? S : undefined;
};

// src/region_map.c:4023 SetFlyWarpDestination
// Lua: region_map.lua:1592
function finishFly(mapsec: number): void {
  const [onPick, onClose] = [RegionMap._onPick, RegionMap._onClose];
  RegionMap.close(true);
  if (onPick) {
    onPick(symOf(mapsec), mapsec);
  } else if (onClose) {
    onClose(undefined);
  }
}

// src/region_map.c:1342 CB2_RegionMap
// Lua: region_map.lua:1603
RegionMap.handleInput = function (input: any): void {
  if (!S) return;
  S.input = input;
  S.frame = S.frame + 1;
  // src/main.c:296 ReadKeys
  if (input.wasPressed("start")) {
    S.startRepeat = true;
    S.repeatCounter = KEY_REPEAT_START;
  } else if (input.isDown && input.isDown("start")) {
    S.repeatCounter = S.repeatCounter - 1;
    S.startRepeat = S.repeatCounter === 0;
    if (S.startRepeat) S.repeatCounter = KEY_REPEAT_CONTINUE;
  } else {
    S.startRepeat = false;
    S.repeatCounter = KEY_REPEAT_START;
  }
  if (S.cb2 === "open") {
    cb2OpenRegionMap();
    vblank();
    return;
  }
  Tasks[S.task!]!();
  if (!S) return;
  if (S.finish) {
    const f = S.finish;
    if (f.picked) finishFly(f.mapsec!); else RegionMap.close();
    return;
  }
  if (S.cursor.exists) spriteCbMapCursor();
  RegionMap._updateFade();
  vblank();
};

// Lua: region_map.lua:1636
function drawSprite(name: string, frame: number, w: number, h: number, cx: number, cy: number): void {
  G.draw(Gpu.image(name), Gpu.frameQuad(name, frame, w, h), cx - w / 2, cy - h / 2);
}

// Lua: region_map.lua:1640
function drawObjPrio2(): void {
  for (const [, icon] of ipairs<Icon>(S.icons.dungeon)) {
    if (icon.visible) {
      G.draw(Gpu.image(icon.frame === 1 ? "dungeon_icon_visited" : "dungeon_icon"), icon.px, icon.py);
    }
  }
  if (S.player.exists && S.player.visible) {
    const female = (RegionMap._session.gender === 1 || RegionMap._session.gender === "female"
      || RegionMap._session.playerGender === 1);
    G.draw(Gpu.image(female ? "player_leaf" : "player_red"), 8 * RegionMap.playerX + 28, 8 * RegionMap.playerY + 28);
  }
  const flyFrame = RegionMap.flyIconFrame();
  for (const [, icon] of ipairs<Icon>(S.icons.fly)) {
    if (icon.visible) drawSprite("fly_icon", flyFrame, 16, 16, 8 * icon.x + 36, 8 * icon.y + 36);
  }
  if (S.cursor.exists && S.cursor.visible) {
    drawSprite("cursor", cursorFrame(), 16, 16, S.cursor.spriteX, S.cursor.spriteY);
  }
}

// Lua: region_map.lua:1660
function drawObjPrio0(): void {
  if (S.edges) {
    for (const [, e] of ipairs<Edge>(S.edges)) {
      if (e.visible) G.draw(Gpu.image(e.name), e.x - 16, e.y - 32);
    }
  }
  if (S.switch && S.switch.cursors) {
    const top = S.switch.highlight[2];
    const frame = switchCursorFrame();
    drawSprite("switch_cursor_left", frame, 32, 32, 88, top + 16);
    drawSprite("switch_cursor_right", frame, 32, 32, 152, top + 16);
  }
}

// Lua: region_map.lua:1674
function bg1Image(): any {
  if (!S.palTinted && S.bg1 === "frame_normal") return Gpu.image("frame_normal_untinted");
  return Gpu.image(S.bg1!);
}

// Lua: region_map.lua:1679
function drawBg0(): void {
  const b = S.bg0;
  if (!b) return;
  G.draw(Gpu.image(REGION_IMAGES[b.region]!), 0, 0);
  if (b.switchButton) G.draw(Gpu.image("switch_button"), 192, 112);
  if (b.navelPatch) G.draw(Gpu.image("navel_rock_patch"), 104, 88);
  if (b.birthPatch) G.draw(Gpu.image("birth_island_patch"), 168, 128);
}

// Lua: region_map.lua:1688
function drawBg2(_alpha: number): void {
  const b = S.bg2!;
  if (b.image) {
    G.draw(Gpu.image(b.image), 0, 0);
  } else {
    G.draw(MapPreviewScreen.image(b.preview)!, 0, 0);
  }
}

// Lua: region_map.lua:1697
function textColors(fgIndex: number): { fg: LuaTable; shadow: LuaTable; bg: LuaTable } {
  return { fg: Gpu.topBarColor(fgIndex), shadow: Gpu.topBarColor(2), bg: seq(0, 0, 0, 0) };
}

// Lua: region_map.lua:1701
function drawBg3(): void {
  const t = S.text;
  // src/region_map.c:1449
  if (t.map) FrlgFont.draw(t.map, 26, 18, { colors: textColors(1) });
  // src/region_map.c:1481, :518-525
  if (t.dungeon) {
    FrlgFont.draw(t.dungeon, 36, 34, { colors: textColors(t.dungeonType === SECTYPE.VISITED ? 7 : 10) });
  }
  const p = S.preview;
  if (p && p.text) {
    // src/region_map.c:2063-2064
    FrlgFont.draw(p.text.name, 28, 48, { colors: textColors(7) });
    FrlgFont.draw(p.text.desc, 26, 62, { colors: textColors(1), linePitch: 14 });
  }
  if (S.topBar.shown) {
    if (S.type !== "normal") {
      const c = Gpu.topBarColor(15);
      G.setColor(c[1], c[2], c[3], 1);
      G.rectangle("fill", 144, 0, 40, 16);
      G.rectangle("fill", 192, 0, 40, 16);
      G.setColor(1, 1, 1, 1);
    }
    if (S.topBar.left) PokedexChrome.drawControlInfoLeft(RomText.plain(S.topBar.left), 144, 0);
    if (S.topBar.right) PokedexChrome.drawControlInfoLeft(RomText.plain(S.topBar.right), 192, 0);
  }
}

// Lua: region_map.lua:1728
RegionMap.draw = function (): void {
  if (!S) return;
  // package.loaded["src.render.Renderer"]
  const R = renderer();
  if (R) {
    R.worldFadeAlpha = 1;
    R.worldFadeColor = seq(0, 0, 0);
  }
  const manifest = Gpu.manifest();
  const backdrop = S.backdropBlue ? Gpu.rgb(manifest.backdrop) : seq(0, 0, 0, 1);
  if (S.palTinted && S.anim && S.anim.closeState > 0) Gpu.image("frame_normal_untinted");
  const layers: LuaTable = seq();
  if (S.bgShown[1] && S.bg1) {
    layers[len(layers) + 1] = { bit: Gpu.BG1, draw: () => { G.draw(bg1Image(), 0, 0); } } as Layer;
  }
  if (S.bgShown[0]) layers[len(layers) + 1] = { bit: Gpu.BG0, draw: drawBg0 } as Layer;
  if (S.objOn) layers[len(layers) + 1] = { bit: Gpu.OBJ, obj: true, draw: drawObjPrio2 } as Layer;
  if (S.bgShown[2] && S.bg2) layers[len(layers) + 1] = { bit: Gpu.BG2, tone: S.bg2.tone, draw: drawBg2 } as Layer;
  if (S.bgShown[3]) layers[len(layers) + 1] = { bit: Gpu.BG3, draw: drawBg3 } as Layer;
  if (S.objOn) layers[len(layers) + 1] = { bit: Gpu.OBJ, obj: true, draw: drawObjPrio0 } as Layer;
  G.push("all");
  Gpu.compose(S.gpu, { bgFade: S.fade.shownBg, objFade: S.fade.shownObj, backdrop }, layers);
  G.pop();
};

export default RegionMap;
